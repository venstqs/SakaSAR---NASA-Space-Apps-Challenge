const DATA_SOURCE_URL = "mock-data.json";
// Fallback only — the real centre comes from provenance.map_center (Minalabac pilot strip).
const DEFAULT_CENTER = [123.2057, 13.5416];
let mapCenter = DEFAULT_CENTER;
let pilotBounds = null; // [minLng, minLat, maxLng, maxLat] from the plots + SAR flood mask
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let appData = null;
let map = null;
let is3D = true;
let playInterval = null;
let timelineStage = 2; // Starts on Post-Storm SAR
let sarMode = "post";
let selectedPlotId = "PL-01";
let mapAnimFrame = null;
let sarSweepProgress = 0;

let threeOrigin = null;
let threeScale = 1;
const threeState = {
  ready: false,
  scene: null,
  camera: null,
  renderer: null,
  sunLight: null,
  hemiLight: null,
  parcelGroup: null,
  canalGroup: null,
  sarGroup: null,
  waterMesh: null,
  canalWaterMesh: null,
  waterUniforms: null,
  canalWaterUniforms: null,
  sarUniforms: null,
  cropUniforms: { uTime: { value: 0 }, uWind: { value: 1.0 } },
  selectionMeshes: {},
  showParcels: true,
  showFlood: true,
  showCorridor: true,
  currentWaterLevel: 1.0,
  targetWaterLevel: 1.0
};

function seededRand(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function lngLatToLocalMeters(lngLat) {
  const mc = maplibregl.MercatorCoordinate.fromLngLat(lngLat, 0);
  return {
    x: (mc.x - threeOrigin.x) / threeScale,
    z: (mc.y - threeOrigin.y) / threeScale
  };
}

function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function createSoilTextures() {
  const size = 256;
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = size;
  diffCanvas.height = size;
  const dCtx = diffCanvas.getContext("2d");

  const bumpCanvas = document.createElement("canvas");
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext("2d");

  dCtx.fillStyle = "#8b7355";
  dCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = "#808080";
  bCtx.fillRect(0, 0, size, size);

  for (let i = 0; i < 3200; i++) {
    const x = seededRand(i * 3 + 1) * size;
    const y = seededRand(i * 3 + 2) * size;
    const r = 1 + seededRand(i * 3 + 3) * 3.5;
    const isGrass = seededRand(i * 7 + 5) > 0.52;
    dCtx.fillStyle = isGrass
      ? `rgba(${78 + Math.floor(seededRand(i) * 32)}, ${118 + Math.floor(seededRand(i + 1) * 36)}, 56, 0.52)`
      : `rgba(${122 + Math.floor(seededRand(i) * 30)}, ${96 + Math.floor(seededRand(i + 2) * 24)}, 68, 0.55)`;
    dCtx.beginPath();
    dCtx.arc(x, y, r, 0, Math.PI * 2);
    dCtx.fill();

    const lum = Math.floor(95 + seededRand(i * 11) * 110);
    bCtx.fillStyle = `rgb(${lum},${lum},${lum})`;
    bCtx.beginPath();
    bCtx.arc(x, y, r * 0.9, 0, Math.PI * 2);
    bCtx.fill();
  }

  const mapTex = new THREE.CanvasTexture(diffCanvas);
  mapTex.wrapS = mapTex.wrapT = THREE.RepeatWrapping;
  mapTex.repeat.set(6, 2);

  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
  bumpTex.wrapS = bumpTex.wrapT = THREE.RepeatWrapping;
  bumpTex.repeat.set(6, 2);

  return { mapTex, bumpTex };
}

function createFurrowTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const ridge = Math.sin((y / size) * Math.PI * 24) * 0.5 + 0.5;
    for (let x = 0; x < size; x++) {
      const grain = (seededRand(x * 13 + y * 37) - 0.5) * 0.22;
      const v = Math.max(0, Math.min(255, Math.floor((ridge * 0.78 + 0.12 + grain) * 255)));
      const idx = (y * size + x) * 4;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 5);
  return tex;
}

function buildFurrowedParcelGeometry(cornersLocal, cropType) {
  const segs = 24;
  const positions = [];
  const uvs = [];
  const indices = [];

  const [c0, c1, c2, c3] = cornersLocal;
  const furrowFreq = cropType.includes("Corn") ? 14.0 : 20.0;
  const furrowAmp = cropType.includes("Corn") ? 0.85 : 0.55;

  for (let j = 0; j <= segs; j++) {
    const v = j / segs;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const x =
        (1 - u) * (1 - v) * c0.x +
        u * (1 - v) * c1.x +
        u * v * c2.x +
        (1 - u) * v * c3.x;
      const z =
        (1 - u) * (1 - v) * c0.z +
        u * (1 - v) * c1.z +
        u * v * c2.z +
        (1 - u) * v * c3.z;
      const edgeFade = Math.sin(u * Math.PI) * Math.sin(v * Math.PI);
      const y = 0.45 + (Math.sin(v * Math.PI * furrowFreq) * 0.5 + 0.5) * furrowAmp * Math.min(1, edgeFade * 2.2);
      positions.push(x, y, z);
      uvs.push(u, v);
    }
  }

  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      const b = a + 1;
      const c = (j + 1) * (segs + 1) + i;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildEarthenBundGeometry(cornersLocal, bundHeight) {
  const positions = [];
  const uvs = [];
  const indices = [];

  const cx = (cornersLocal[0].x + cornersLocal[1].x + cornersLocal[2].x + cornersLocal[3].x) * 0.25;
  const cz = (cornersLocal[0].z + cornersLocal[1].z + cornersLocal[2].z + cornersLocal[3].z) * 0.25;

  const outerHalf = 3.2;
  const crownHalf = 1.4;
  let vertOffset = 0;

  for (let e = 0; e < 4; e++) {
    const pA = cornersLocal[e];
    const pB = cornersLocal[(e + 1) % 4];
    const dx = pB.x - pA.x;
    const dz = pB.z - pA.z;
    const len = Math.hypot(dx, dz) || 1;
    let nx = -dz / len;
    let nz = dx / len;
    // Ensure normal points outward from parcel center
    const midX = (pA.x + pB.x) * 0.5;
    const midZ = (pA.z + pB.z) * 0.5;
    if (nx * (midX - cx) + nz * (midZ - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }

    const profileOffsets = [
      { n: -outerHalf, y: 0.0 },
      { n: -crownHalf, y: bundHeight },
      { n: crownHalf, y: bundHeight },
      { n: outerHalf, y: 0.0 }
    ];

    for (let k = 0; k < 4; k++) {
      const prof = profileOffsets[k];
      positions.push(pA.x + nx * prof.n, prof.y, pA.z + nz * prof.n);
      uvs.push(0, k / 3);
      positions.push(pB.x + nx * prof.n, prof.y, pB.z + nz * prof.n);
      uvs.push(len / 24, k / 3);
    }

    for (let k = 0; k < 3; k++) {
      const i0 = vertOffset + k * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      indices.push(i0, i1, i3, i0, i3, i2);
    }
    vertOffset += 8;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildInnerBevelRibbonGeometry(cornersLocal, insetMeters, yPos, widthMeters) {
  const positions = [];
  const indices = [];
  const cx = (cornersLocal[0].x + cornersLocal[1].x + cornersLocal[2].x + cornersLocal[3].x) * 0.25;
  const cz = (cornersLocal[0].z + cornersLocal[1].z + cornersLocal[2].z + cornersLocal[3].z) * 0.25;
  let offset = 0;

  for (let e = 0; e < 4; e++) {
    const pA = cornersLocal[e];
    const pB = cornersLocal[(e + 1) % 4];
    const dx = pB.x - pA.x;
    const dz = pB.z - pA.z;
    const len = Math.hypot(dx, dz) || 1;
    let inX = -dz / len;
    let inZ = dx / len;
    const midX = (pA.x + pB.x) * 0.5;
    const midZ = (pA.z + pB.z) * 0.5;
    if (inX * (cx - midX) + inZ * (cz - midZ) < 0) {
      inX = -inX;
      inZ = -inZ;
    }

    const innerDist = insetMeters + widthMeters;
    positions.push(
      pA.x + inX * insetMeters, yPos, pA.z + inZ * insetMeters,
      pB.x + inX * insetMeters, yPos, pB.z + inZ * insetMeters,
      pA.x + inX * innerDist, yPos - 0.15, pA.z + inZ * innerDist,
      pB.x + inX * innerDist, yPos - 0.15, pB.z + inZ * innerDist
    );
    indices.push(offset, offset + 1, offset + 3, offset, offset + 3, offset + 2);
    offset += 4;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildDrainageCanalMeshes(corridorCoords, soilMat, waterMat) {
  const group = new THREE.Group();
  const pts = corridorCoords.map((c) => lngLatToLocalMeters(c));
  const subPts = [];
  const subPerSeg = 12;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let s = 0; s < (i === pts.length - 2 ? subPerSeg + 1 : subPerSeg); s++) {
      const t = s / subPerSeg;
      subPts.push({
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        z: pts[i].z + (pts[i + 1].z - pts[i].z) * t
      });
    }
  }

  // Carved earthen canal banks (left & right slopes + bed)
  const bankPos = [];
  const bankUv = [];
  const bankIdx = [];
  const waterPos = [];
  const waterUv = [];
  const waterIdx = [];

  for (let i = 0; i < subPts.length; i++) {
    const prev = subPts[Math.max(0, i - 1)];
    const next = subPts[Math.min(subPts.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const u = i / (subPts.length - 1);
    const widthScale = 0.72 + u * 0.95; // Graduated flow-accumulation width (upland -> lowland)

    // 6-point cross-section: outer left, crown left, bed left, bed right, crown right, outer right
    const profile = [
      { n: -10.5 * widthScale, y: 0.0 },
      { n: -6.5 * widthScale, y: 2.2 },
      { n: -3.5 * widthScale, y: 0.2 },
      { n: 3.5 * widthScale, y: 0.2 },
      { n: 6.5 * widthScale, y: 2.2 },
      { n: 10.5 * widthScale, y: 0.0 }
    ];
    for (let k = 0; k < 6; k++) {
      bankPos.push(subPts[i].x + nx * profile[k].n, profile[k].y, subPts[i].z + nz * profile[k].n);
      bankUv.push(u * 16, k / 5);
    }

    // Water surface ribbon inside canal
    const waterHalf = 4.6 * widthScale;
    waterPos.push(subPts[i].x - nx * waterHalf, 1.45, subPts[i].z - nz * waterHalf);
    waterPos.push(subPts[i].x + nx * waterHalf, 1.45, subPts[i].z + nz * waterHalf);
    waterUv.push(u * 10, 0, u * 10, 1);
  }

  for (let i = 0; i < subPts.length - 1; i++) {
    for (let k = 0; k < 5; k++) {
      const a = i * 6 + k;
      const b = a + 1;
      const c = (i + 1) * 6 + k;
      const d = c + 1;
      bankIdx.push(a, b, d, a, d, c);
    }
    const wa = i * 2;
    const wb = wa + 1;
    const wc = (i + 1) * 2;
    const wd = wc + 1;
    waterIdx.push(wa, wb, wd, wa, wd, wc);
  }

  const bankGeom = new THREE.BufferGeometry();
  bankGeom.setAttribute("position", new THREE.Float32BufferAttribute(bankPos, 3));
  bankGeom.setAttribute("uv", new THREE.Float32BufferAttribute(bankUv, 2));
  bankGeom.setIndex(bankIdx);
  bankGeom.computeVertexNormals();
  const bankMesh = new THREE.Mesh(bankGeom, soilMat);
  group.add(bankMesh);

  const waterGeom = new THREE.BufferGeometry();
  waterGeom.setAttribute("position", new THREE.Float32BufferAttribute(waterPos, 3));
  waterGeom.setAttribute("uv", new THREE.Float32BufferAttribute(waterUv, 2));
  waterGeom.setIndex(waterIdx);
  waterGeom.computeVertexNormals();
  const canalWater = new THREE.Mesh(waterGeom, waterMat);
  group.add(canalWater);

  // Dendritic Tributary Feeder Channels branching into the main runoff corridor
  const tribSpecs = [
    { idx: 8, side: -1, len: 135, angle: 0.55 },
    { idx: 15, side: 1, len: 145, angle: -0.5 },
    { idx: 22, side: -1, len: 160, angle: 0.6 },
    { idx: 29, side: 1, len: 155, angle: -0.58 },
    { idx: 36, side: -1, len: 175, angle: 0.52 },
    { idx: 42, side: 1, len: 165, angle: -0.48 }
  ];
  tribSpecs.forEach((spec) => {
    const base = subPts[Math.min(subPts.length - 1, spec.idx)];
    const prev = subPts[Math.max(0, spec.idx - 1)];
    const dirX = base.x - prev.x;
    const dirZ = base.z - prev.z;
    const dLen = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / dLen;
    const uz = dirZ / dLen;
    const nx = -uz * spec.side;
    const nz = ux * spec.side;
    const startX = base.x + nx * spec.len - ux * 55;
    const startZ = base.z + nz * spec.len - uz * 55;
    const midX = (startX + base.x) * 0.5 + nx * 18;
    const midZ = (startZ + base.z) * 0.5 + nz * 18;

    const tPts = [
      { x: startX, z: startZ },
      { x: midX, z: midZ },
      { x: base.x, z: base.z }
    ];
    const tPos = [];
    const tUv = [];
    const tIdx = [];
    for (let j = 0; j < tPts.length; j++) {
      const p0 = tPts[Math.max(0, j - 1)];
      const p1 = tPts[Math.min(tPts.length - 1, j + 1)];
      const tx = p1.x - p0.x;
      const tz = p1.z - p0.z;
      const tl = Math.hypot(tx, tz) || 1;
      const tnx = -tz / tl;
      const tnz = tx / tl;
      const halfW = 1.6 + (j / 2) * 1.4;
      const uVal = (spec.idx / subPts.length) * 10 * 0.7;
      tPos.push(tPts[j].x - tnx * halfW, 1.35, tPts[j].z - tnz * halfW);
      tPos.push(tPts[j].x + tnx * halfW, 1.35, tPts[j].z + tnz * halfW);
      tUv.push(uVal + j * 1.1, 0, uVal + j * 1.1, 1);
    }
    for (let j = 0; j < tPts.length - 1; j++) {
      const a = j * 2, b = a + 1, c = a + 2, d = a + 3;
      tIdx.push(a, b, d, a, d, c);
    }
    const tGeom = new THREE.BufferGeometry();
    tGeom.setAttribute("position", new THREE.Float32BufferAttribute(tPos, 3));
    tGeom.setAttribute("uv", new THREE.Float32BufferAttribute(tUv, 2));
    tGeom.setIndex(tIdx);
    tGeom.computeVertexNormals();
    group.add(new THREE.Mesh(tGeom, waterMat));
  });

  return { group, canalWater };
}

function createRiskGridTexture(riskClass) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const palette =
    riskClass === "high"
      ? ["#dc2626", "#ef4444", "#b91c1c"]
      : riskClass === "watch"
        ? ["#d97706", "#f59e0b", "#b45309"]
        : ["#059669", "#10b981", "#047857"];

  const cells = 6;
  const cellSize = size / cells;
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const idx = Math.floor(seededRand(gx * 19 + gy * 37 + riskClass.length * 7) * 3);
      ctx.fillStyle = palette[idx];
      ctx.fillRect(gx * cellSize, gy * cellSize, cellSize, cellSize);
    }
  }

  // Crisp 30m grid matrix lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    const p = i * cellSize;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

function createPhysicalWaterMaterial(isCanal = false, fromMask = false) {
  const uniforms = {
    uTime: { value: 0 },
    uWaterLevel: { value: 1.0 },
    uSunDir: { value: new THREE.Vector3(0.52, 0.76, 0.39).normalize() },
    uCamPos: { value: new THREE.Vector3(0, 450, 450) },
    uIsCanal: { value: isCanal ? 1.0 : 0.0 },
    uFromMask: { value: fromMask ? 1.0 : 0.0 }
  };

  const vertexShader = `
    uniform float uTime;
    uniform float uWaterLevel;
    uniform float uIsCanal;
    uniform float uFromMask;
    varying vec3 vWorldPos;
    varying vec2 vUv;
    varying float vDepth;

    void main() {
      vUv = uv;
      vec3 pos = position;

      if (uIsCanal < 0.5 && uFromMask > 0.5) {
        // Real Sentinel-1 flood mask: SAR shows WHERE water stands, not how deep,
        // so the whole mask gets one water tone that rises/falls with the timeline.
        vDepth = 0.24 * uWaterLevel;
        float swell = (sin(pos.x * 0.08 + uTime * 2.1) + cos(pos.z * 0.09 - uTime * 1.7)) * 0.06 * uWaterLevel;
        pos.y = mix(0.2, 1.4, uWaterLevel) + swell;
      } else if (uIsCanal < 0.5) {
        // Organic basin depth field concentrated in PL-01, PL-02, and lower PL-03
        vec2 basinUv = uv * 2.0 - 1.0;
        float westBias = smoothstep(1.0, -0.85, basinUv.x);
        float radial = 1.0 - length(vec2((basinUv.x + 0.18) * 0.92, basinUv.y * 1.15));
        float organic = 0.09 * sin(pos.x * 0.025 + 1.2) * cos(pos.z * 0.032) + 0.05 * sin(pos.x * 0.07 - pos.z * 0.05);
        vDepth = clamp((radial * 0.85 + westBias * 0.32 + organic) * uWaterLevel, 0.0, 1.0);
        float swell = (sin(pos.x * 0.08 + uTime * 2.1) + cos(pos.z * 0.09 - uTime * 1.7)) * 0.1 * uWaterLevel;
        pos.y = mix(0.2, 1.75, uWaterLevel) + swell * smoothstep(0.05, 0.4, vDepth);
      } else {
        vDepth = clamp(0.65 * (0.35 + 0.65 * uWaterLevel), 0.25, 0.95);
        pos.y += sin(uv.x * 12.0 - uTime * 4.5) * 0.05;
      }

      vec4 worldPosition = modelMatrix * vec4(pos, 1.0);
      vWorldPos = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `;

  const fragmentShader = `
    precision highp float;
    uniform float uTime;
    uniform float uWaterLevel;
    uniform vec3 uSunDir;
    uniform vec3 uCamPos;
    uniform float uIsCanal;
    varying vec3 vWorldPos;
    varying vec2 vUv;
    varying float vDepth;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float waveOctave(vec2 p, vec2 dir, float freq, float speed) {
      return sin(dot(p, dir) * freq + uTime * speed);
    }

    vec3 computeRippleNormal(vec2 p) {
      float flowShift = uIsCanal > 0.5 ? uTime * 1.8 : 0.0;
      vec2 sp = p + vec2(-flowShift, 0.0);
      float eps = 0.35;

      float h0 =
        waveOctave(sp, normalize(vec2(1.0, 0.35)), 0.42, 2.2) * 0.35 +
        waveOctave(sp, normalize(vec2(-0.6, 0.8)), 0.78, 2.9) * 0.25 +
        waveOctave(sp, normalize(vec2(0.3, -0.95)), 1.35, 3.6) * 0.16 +
        waveOctave(sp, normalize(vec2(-0.85, -0.5)), 2.15, 4.4) * 0.10;

      float hx =
        waveOctave(sp + vec2(eps, 0.0), normalize(vec2(1.0, 0.35)), 0.42, 2.2) * 0.35 +
        waveOctave(sp + vec2(eps, 0.0), normalize(vec2(-0.6, 0.8)), 0.78, 2.9) * 0.25 +
        waveOctave(sp + vec2(eps, 0.0), normalize(vec2(0.3, -0.95)), 1.35, 3.6) * 0.16 +
        waveOctave(sp + vec2(eps, 0.0), normalize(vec2(-0.85, -0.5)), 2.15, 4.4) * 0.10;

      float hz =
        waveOctave(sp + vec2(0.0, eps), normalize(vec2(1.0, 0.35)), 0.42, 2.2) * 0.35 +
        waveOctave(sp + vec2(0.0, eps), normalize(vec2(-0.6, 0.8)), 0.78, 2.9) * 0.25 +
        waveOctave(sp + vec2(0.0, eps), normalize(vec2(0.3, -0.95)), 1.35, 3.6) * 0.16 +
        waveOctave(sp + vec2(0.0, eps), normalize(vec2(-0.85, -0.5)), 2.15, 4.4) * 0.10;

      float chop = 0.16 + 0.18 * uWaterLevel;
      return normalize(vec3((h0 - hx) * chop / eps, 1.0, (h0 - hz) * chop / eps));
    }

    vec3 floodDepthRamp(float d) {
      // Scientific WD (0m -> 2m) ramp: royal blue -> cyan -> emerald -> amber -> crimson core
      vec3 c0 = vec3(0.114, 0.306, 0.847); // #1d4ed8
      vec3 c1 = vec3(0.024, 0.714, 0.831); // #06b6d4
      vec3 c2 = vec3(0.133, 0.773, 0.369); // #22c55e
      vec3 c3 = vec3(0.980, 0.800, 0.082); // #facc15
      vec3 c4 = vec3(0.863, 0.149, 0.149); // #dc2626
      if (d < 0.28) return mix(c0, c1, d / 0.28);
      if (d < 0.55) return mix(c1, c2, (d - 0.28) / 0.27);
      if (d < 0.78) return mix(c2, c3, (d - 0.55) / 0.23);
      return mix(c3, c4, clamp((d - 0.78) / 0.22, 0.0, 1.0));
    }

    void main() {
      if (vDepth <= 0.025) discard;

      // SAR pixel-speckle fringe at shallow inundation boundary (only while water is rising/receding)
      if (uIsCanal < 0.5 && vDepth < 0.2) {
        vec2 cell = floor(vWorldPos.xz / 9.0);
        float n = hash21(cell);
        if (n > vDepth * 4.8) discard;
      }

      vec3 N = computeRippleNormal(vWorldPos.xz);
      vec3 V = normalize(uCamPos - vWorldPos);
      vec3 H = normalize(uSunDir + V);

      // Schlick Fresnel & sun specular glint
      float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
      float spec = pow(max(dot(N, H), 0.0), 160.0) * (1.2 + 0.4 * uWaterLevel);

      vec3 waterCol;
      if (uIsCanal < 0.5) {
        waterCol = floodDepthRamp(vDepth);
        vec3 skyColor = vec3(0.73, 0.90, 0.99);
        waterCol = mix(waterCol, skyColor, clamp(fresnel * 0.42, 0.0, 0.45));
      } else {
        // Graduated hydrological runoff tiers along corridor (upland cyan -> downstream royal blue)
        float flowT = clamp(vUv.x / 10.0, 0.0, 1.0);
        vec3 upland = vec3(0.49, 0.83, 0.99);    // #7dd3fc (<25 L/s/km2)
        vec3 midstream = vec3(0.055, 0.647, 0.914); // #0ea5e9 (25-100)
        vec3 downstream = vec3(0.114, 0.306, 0.847); // #1d4ed8 (>100)
        waterCol = flowT < 0.5
          ? mix(upland, midstream, flowT * 2.0)
          : mix(midstream, downstream, (flowT - 0.5) * 2.0);
        // Animated downstream flow pulse bands
        float pulse = sin(vUv.x * 3.5 - uTime * 5.2) * 0.5 + 0.5;
        waterCol += vec3(0.45, 0.75, 0.95) * smoothstep(0.65, 1.0, pulse) * 0.42;
      }

      waterCol += vec3(1.0, 0.98, 0.92) * spec;

      float shoreMask = smoothstep(0.18, 0.03, vDepth);
      float foamWave = sin(vWorldPos.x * 0.35 + vWorldPos.z * 0.28 - uTime * 3.0) * 0.5 + 0.5;
      float foam = shoreMask * smoothstep(0.45, 0.95, foamWave) * 0.5;
      waterCol = mix(waterCol, vec3(0.92, 0.98, 1.0), foam);

      float alpha = uIsCanal > 0.5 ? 0.88 : mix(0.55, 0.86, vDepth);
      gl_FragColor = vec4(waterCol, clamp(alpha + foam * 0.2, 0.0, 0.94));
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  return { mat, uniforms };
}

function buildThreeScene(mapInstance, gl) {
  threeOrigin = maplibregl.MercatorCoordinate.fromLngLat(mapCenter, 0);
  threeScale = threeOrigin.meterInMercatorCoordinateUnits();

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;

  const renderer = new THREE.WebGLRenderer({
    canvas: mapInstance.getCanvas(),
    context: gl,
    antialias: true
  });
  renderer.autoClear = false;
  if ("SRGBColorSpace" in THREE) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  } else if ("sRGBEncoding" in THREE) {
    renderer.outputEncoding = THREE.sRGBEncoding;
  }

  // Outdoor Studio Lighting Rig
  const hemiLight = new THREE.HemisphereLight(0xbae6fd, 0x3f3f46, 0.95);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.85);
  sunLight.position.set(180, 260, 140);
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
  rimLight.position.set(-150, 120, -140);
  scene.add(rimLight);

  const { mapTex: soilTex, bumpTex: soilBump } = createSoilTextures();
  const furrowBump = createFurrowTexture();

  const soilMat = new THREE.MeshStandardMaterial({
    map: soilTex,
    bumpMap: soilBump,
    bumpScale: 0.45,
    roughness: 0.85,
    metalness: 0.04,
    side: THREE.DoubleSide
  });

  // 1. Sculpted 3D Farm Parcels + Crop Rows + Instanced Crop Tufts
  const parcelGroup = new THREE.Group();
  const cropTuftPositions = [];

  appData.plots.features.forEach((feat, idx) => {
    const p = feat.properties;
    const ring = feat.geometry.coordinates[0];
    const corners = [ring[0], ring[1], ring[2], ring[3]].map((c) => lngLatToLocalMeters(c));

    // 3D 30m Risk Grid Cover + Plowed Furrow Relief
    const cropGeom = buildFurrowedParcelGeometry(corners, p.current_crop);
    const riskGridTex = createRiskGridTexture(p.risk_class);
    const cropMat = new THREE.MeshStandardMaterial({
      map: riskGridTex,
      bumpMap: furrowBump,
      bumpScale: 0.35,
      roughness: 0.72,
      metalness: 0.04,
      transparent: true,
      opacity: 0.76,
      side: THREE.DoubleSide
    });
    const cropMesh = new THREE.Mesh(cropGeom, cropMat);
    parcelGroup.add(cropMesh);

    // Sculpted 3D Earthen Bunds
    const bundH = p.risk_class === "high" ? 2.6 : p.risk_class === "watch" ? 2.2 : 1.9;
    const bundGeom = buildEarthenBundGeometry(corners, bundH);
    const bundMesh = new THREE.Mesh(bundGeom, soilMat);
    parcelGroup.add(bundMesh);

    // Subtle Risk-Status Inner Bevel Illumination (elevated 1.2m to avoid z-fighting)
    const statusHex =
      p.risk_class === "high" ? 0xef4444 : p.risk_class === "watch" ? 0xf59e0b : 0x10b981;
    const bevelGeom = buildInnerBevelRibbonGeometry(corners, 1.2, 1.2, 2.2);
    const bevelMat = new THREE.MeshStandardMaterial({
      color: statusHex,
      emissive: statusHex,
      emissiveIntensity: 0.55,
      roughness: 0.45,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide
    });
    parcelGroup.add(new THREE.Mesh(bevelGeom, bevelMat));

    // Selection Halo Ring
    const selGeom = buildInnerBevelRibbonGeometry(corners, -1.8, bundH + 0.15, 2.4);
    const selMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: p.plot_id === selectedPlotId ? 0.92 : 0.0,
      side: THREE.DoubleSide
    });
    const selMesh = new THREE.Mesh(selGeom, selMat);
    parcelGroup.add(selMesh);
    threeState.selectionMeshes[p.plot_id] = selMesh;

    // Collect InstancedMesh crop tuft positions along furrow ridges
    const rows = 12;
    const cols = 12;
    for (let r = 1; r < rows; r++) {
      const v = r / rows;
      for (let c = 1; c < cols; c++) {
        const u = c / cols;
        const jU = u + (seededRand(idx * 500 + r * 20 + c) - 0.5) * 0.04;
        const jV = v + (seededRand(idx * 500 + r * 20 + c + 9) - 0.5) * 0.03;
        const x =
          (1 - jU) * (1 - jV) * corners[0].x +
          jU * (1 - jV) * corners[1].x +
          jU * jV * corners[2].x +
          (1 - jU) * jV * corners[3].x;
        const z =
          (1 - jU) * (1 - jV) * corners[0].z +
          jU * (1 - jV) * corners[1].z +
          jU * jV * corners[2].z +
          (1 - jU) * jV * corners[3].z;
        cropTuftPositions.push({
          x,
          y: 0.35,
          z,
          scale: 0.8 + seededRand(idx * 300 + r * 17 + c) * 0.65,
          rotY: seededRand(r * 31 + c) * Math.PI * 2,
          color: p.current_crop.includes("Corn") ? 0x65a30d : 0x4d7c0f
        });
      }
    }
  });

  // InstancedMesh for 3D Crop Clusters swaying in storm wind
  const tuftGeom = new THREE.ConeGeometry(1.5, 4.2, 5);
  tuftGeom.translate(0, 2.1, 0);
  const tuftMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0.02
  });
  tuftMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = threeState.cropUniforms.uTime;
    shader.uniforms.uWind = threeState.cropUniforms.uWind;
    shader.vertexShader =
      `uniform float uTime;\nuniform float uWind;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `
      #include <begin_vertex>
      float swayFactor = clamp(position.y / 4.2, 0.0, 1.0);
      float phase = instanceMatrix[3][0] * 0.08 + instanceMatrix[3][2] * 0.08;
      transformed.x += sin(uTime * 2.8 + phase) * 0.55 * swayFactor * uWind;
      transformed.z += cos(uTime * 2.2 + phase * 1.3) * 0.3 * swayFactor * uWind;
      `
    );
  };

  const instancedCrops = new THREE.InstancedMesh(tuftGeom, tuftMat, cropTuftPositions.length);
  const dummy = new THREE.Object3D();
  const cObj = new THREE.Color();
  cropTuftPositions.forEach((pt, i) => {
    dummy.position.set(pt.x, pt.y, pt.z);
    dummy.rotation.set(0, pt.rotY, 0);
    dummy.scale.set(pt.scale, pt.scale, pt.scale);
    dummy.updateMatrix();
    instancedCrops.setMatrixAt(i, dummy.matrix);
    cObj.setHex(pt.color);
    instancedCrops.setColorAt(i, cObj);
  });
  instancedCrops.instanceMatrix.needsUpdate = true;
  if (instancedCrops.instanceColor) instancedCrops.instanceColor.needsUpdate = true;
  parcelGroup.add(instancedCrops);
  scene.add(parcelGroup);

  // 2. Sculpted 3D Carved Drainage Canal + Animated Water
  const { mat: canalWaterMat, uniforms: canalWaterUniforms } = createPhysicalWaterMaterial(true);
  const corridorCoords = appData.drainage_corridor.features[0].geometry.coordinates;
  const { group: canalGroup, canalWater } = buildDrainageCanalMeshes(corridorCoords, soilMat, canalWaterMat);
  scene.add(canalGroup);

  // 3. Floodwater surface built from the REAL Sentinel-1 observed_flood_extent polygons
  //    (pipeline output), so the animated water only appears where the radar saw standing water.
  const { mat: waterMat, uniforms: waterUniforms } = createPhysicalWaterMaterial(false, true);
  const waterMesh = new THREE.Group();
  const toShapePoints = (ring) =>
    ring.map(([lng, lat]) => {
      const p = lngLatToLocalMeters([lng, lat]);
      return new THREE.Vector2(p.x, -p.z); // rotateX(-90°) maps shape y -> world -z
    });
  (appData.observed_flood_extent?.features || []).forEach((f) => {
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    polys.forEach((rings) => {
      const shape = new THREE.Shape(toShapePoints(rings[0]));
      rings.slice(1).forEach((hole) => shape.holes.push(new THREE.Path(toShapePoints(hole))));
      const geom = new THREE.ShapeGeometry(shape);
      geom.rotateX(-Math.PI / 2);
      waterMesh.add(new THREE.Mesh(geom, waterMat));
    });
  });
  scene.add(waterMesh);

  // 4. SAR before/after is drawn from real pipeline polygons as MapLibre layers
  //    ("sar-pre-fill" / "sar-post-fill", see initApp). The group is kept so existing toggles work.
  const sarGroup = new THREE.Group();
  const sarUniforms = { uTime: { value: 0 }, uMode: { value: sarMode === "pre" ? 0.0 : 1.0 } };
  scene.add(sarGroup);

  scene.traverse((obj) => {
    obj.frustumCulled = false;
  });

  threeState.ready = true;
  threeState.scene = scene;
  threeState.camera = camera;
  threeState.renderer = renderer;
  threeState.sunLight = sunLight;
  threeState.hemiLight = hemiLight;
  threeState.parcelGroup = parcelGroup;
  threeState.canalGroup = canalGroup;
  threeState.sarGroup = sarGroup;
  threeState.waterMesh = waterMesh;
  threeState.canalWaterMesh = canalWater;
  threeState.waterUniforms = waterUniforms;
  threeState.canalWaterUniforms = canalWaterUniforms;
  threeState.sarUniforms = sarUniforms;
}

function updateThreeSelectedPlot(plotId) {
  Object.entries(threeState.selectionMeshes).forEach(([id, mesh]) => {
    if (mesh && mesh.material) {
      mesh.material.opacity = id === plotId ? 0.92 : 0.0;
    }
  });
}

async function initApp() {
  const res = await fetch(DATA_SOURCE_URL);
  appData = await res.json();
  mapCenter = (appData.provenance && appData.provenance.map_center) || DEFAULT_CENTER;
  pilotBounds = computePilotBounds(appData);
  const coordEl = document.getElementById("coord-readout");
  if (coordEl) coordEl.textContent = `${mapCenter[1].toFixed(4)}, ${mapCenter[0].toFixed(4)}`;

  // Initialize MapLibre with Satellite Imagery + Hybrid Reference Labels
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        satellite: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          ],
          tileSize: 256,
          attribution: "Esri, NASA, Copernicus Sentinel-1"
        },
        osm_labels: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256
        }
      },
      layers: [
        {
          id: "satellite-base",
          type: "raster",
          source: "satellite",
          paint: { "raster-saturation": -0.1, "raster-contrast": 0.1 }
        },
        {
          id: "road-overlay",
          type: "raster",
          source: "osm_labels",
          paint: { "raster-opacity": 0.0 }
        }
      ]
    },
    center: mapCenter,
    zoom: 15.0,
    pitch: 30,
    bearing: -12,
    attributionControl: { compact: true }
  });

  map.on("mousemove", (e) => {
    document.getElementById("coord-readout").textContent =
      `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`;
  });

  map.on("load", () => {
    const threeCustomLayer = {
      id: "fieldshift-3d-world",
      type: "custom",
      renderingMode: "3d",
      onAdd: function (mapInstance, gl) {
        console.log("SakaSAR 3D WebGL layer initialized. THREE.REVISION:", THREE.REVISION);
        buildThreeScene(mapInstance, gl);
      },
      render: function (gl, matrix) {
        if (!threeState.ready) return;

        const nowSec = performance.now() * 0.001;
        threeState.currentWaterLevel +=
          (threeState.targetWaterLevel - threeState.currentWaterLevel) * 0.06;

        threeState.waterUniforms.uTime.value = nowSec;
        threeState.waterUniforms.uWaterLevel.value = threeState.currentWaterLevel;
        threeState.canalWaterUniforms.uTime.value = nowSec;
        threeState.canalWaterUniforms.uWaterLevel.value = Math.max(0.18, threeState.currentWaterLevel);
        threeState.cropUniforms.uTime.value = nowSec;
        threeState.sarUniforms.uTime.value = nowSec;

        const camCenter = map.getCenter();
        const camCenterLocal = lngLatToLocalMeters([camCenter.lng, camCenter.lat]);
        const pitchRad = (map.getPitch() * Math.PI) / 180;
        const bearingRad = (map.getBearing() * Math.PI) / 180;
        const camDist = 600 * Math.pow(2, 15 - map.getZoom());
        const camLocal = new THREE.Vector3(
          camCenterLocal.x - Math.sin(bearingRad) * Math.sin(pitchRad) * camDist,
          Math.max(40, Math.cos(pitchRad) * camDist),
          camCenterLocal.z + Math.cos(bearingRad) * Math.sin(pitchRad) * camDist
        );
        threeState.waterUniforms.uCamPos.value.copy(camLocal);
        threeState.canalWaterUniforms.uCamPos.value.copy(camLocal);

        const m = new THREE.Matrix4().fromArray(matrix);
        const l = new THREE.Matrix4()
          .makeTranslation(threeOrigin.x, threeOrigin.y, threeOrigin.z)
          .scale(new THREE.Vector3(threeScale, -threeScale, threeScale))
          .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

        threeState.camera.projectionMatrix = m.multiply(l);
        threeState.camera.projectionMatrixInverse
          .copy(threeState.camera.projectionMatrix)
          .invert();
        threeState.renderer.resetState();
        threeState.renderer.render(threeState.scene, threeState.camera);
        map.triggerRepaint();
      }
    };

    // Real Sentinel-1 before/after layers from the pipeline (toggled by the SAR Scene buttons)
    const sarCmp = appData.sar_backscatter_comparison || {};
    map.addSource("sar-pre-source", { type: "geojson", data: sarCmp.before_event || { type: "FeatureCollection", features: [] } });
    map.addSource("sar-post-source", { type: "geojson", data: sarCmp.after_event || { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "sar-pre-fill", type: "fill", source: "sar-pre-source",
      layout: { visibility: sarMode === "pre" ? "visible" : "none" },
      paint: { "fill-color": "#64748b", "fill-opacity": 0.45, "fill-outline-color": "#cbd5e1" }
    });
    map.addLayer({
      id: "sar-post-fill", type: "fill", source: "sar-post-source",
      layout: { visibility: sarMode === "post" ? "visible" : "none" },
      paint: { "fill-color": "#06b6d4", "fill-opacity": 0.28, "fill-outline-color": "#67e8f9" }
    });

    map.addSource("plots-source", {
      type: "geojson",
      data: appData.plots
    });

    map.addLayer({
      id: "plots-hit-target",
      type: "fill",
      source: "plots-source",
      paint: {
        "fill-color": "#000000",
        "fill-opacity": 0.01
      }
    });

    map.addLayer(threeCustomLayer);

    // Add Floating Pill Markers Above Each Parcel
    appData.plots.features.forEach((feat) => {
      const coords = getPolygonCenter(feat.geometry.coordinates[0]);
      const p = feat.properties;
      const dotColor =
        p.risk_class === "high" ? "#dc2626" : p.risk_class === "watch" ? "#d97706" : "#059669";

      const el = document.createElement("button");
      el.type = "button";
      el.className = "plot-pill-marker";
      el.dataset.plotId = p.plot_id;
      el.setAttribute("aria-label", `Inspect ${p.plot_id} in ${p.barangay}, risk score ${p.risk_score}`);
      el.innerHTML = `<span class="marker-dot" style="background:${dotColor}" aria-hidden="true"></span><span>${p.plot_id} · ${p.risk_score}</span>`;
      el.addEventListener("click", () => selectPlot(feat));

      new maplibregl.Marker({ element: el }).setLngLat(coords).addTo(map);
    });

    map.on("click", "plots-hit-target", (e) => {
      if (e.features && e.features[0]) {
        const clickedId = e.features[0].properties.plot_id;
        const fullFeat = appData.plots.features.find((f) => f.properties.plot_id === clickedId);
        if (fullFeat) selectPlot(fullFeat);
      }
    });

    map.on("mouseenter", "plots-hit-target", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "plots-hit-target", () => {
      map.getCanvas().style.cursor = "";
    });

    startMapAnimations();
    fitPilot(false);
  });

  populateLeftPanel();
  renderRotations("nitrogen");
  selectPlot(appData.plots.features[0], false);
  bindUIEvents();
  // On phones, start with the map visible; the plot card opens when a plot is tapped.
  if (window.matchMedia("(max-width: 640px)").matches) {
    document.getElementById("inspect-card")?.classList.add("hidden");
  }
}

// Frame all plots between the floating panels (left command panel, right plot card).
function fitPilot(animate = true) {
  if (!map || !appData) return;
  const pts = appData.plots.features.flatMap((f) => f.geometry.coordinates[0]);
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const phone = window.matchMedia("(max-width: 640px)").matches;
  const tablet = window.matchMedia("(max-width: 1024px)").matches;
  const padding = phone
    ? { top: Math.round(window.innerHeight * 0.52), bottom: 70, left: 24, right: 24 }
    : tablet
      ? { top: 90, bottom: 90, left: 380, right: 40 }
      : { top: 110, bottom: 90, left: 390, right: 480 };
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding, pitch: is3D ? 45 : 0, bearing: -12, duration: animate ? 900 : 0, maxZoom: 17 }
  );
}

function computePilotBounds(data) {
  const pts = [];
  const collect = (geom) => {
    if (!geom) return;
    const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
    polys.forEach((rings) => rings[0].forEach((c) => pts.push(c)));
  };
  (data.plots?.features || []).forEach((f) => collect(f.geometry));
  (data.observed_flood_extent?.features || []).forEach((f) => collect(f.geometry));
  if (!pts.length) return null;
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

function getPolygonCenter(ring) {
  let lng = 0, lat = 0;
  const len = ring.length - 1;
  for (let i = 0; i < len; i++) {
    lng += ring[i][0];
    lat += ring[i][1];
  }
  return [lng / len, lat / len];
}

// ---- small helpers ----------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Sentinel-1 item ids embed the acquisition date: S1A_IW_GRDH_1SDV_20241102T213901_...
function sceneDate(id, withYear = true) {
  const m = /_(\d{4})(\d{2})(\d{2})T/.exec(id || "");
  if (!m) return null;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${withYear ? ` ${m[1]}` : ""}`;
}

function sarScenes() {
  return (appData && appData.provenance && appData.provenance.sar_scenes) || {};
}

function signedDb(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function showToast(message, ms = 3200) {
  const toast = document.getElementById("sms-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), ms);
}

function closeOutlook() {
  const panel = document.getElementById("fs-outlook-panel");
  if (panel && !panel.hidden) {
    panel.hidden = true;
    document.querySelector(".fs-outlook-fab")?.setAttribute("aria-expanded", "false");
  }
}

// ---- Farmer / LGU view ------------------------------------------------------
let viewRole = "farmer";
function setRole(role) {
  viewRole = role;
  const isLgu = role === "lgu";
  const label = document.getElementById("role-label");
  if (label) label.textContent = isLgu ? "View: LGU / MDRRMO" : "View: Farmer";
  document.getElementById("btn-role-switch")?.setAttribute("aria-pressed", String(isLgu));
  document.getElementById("lgu-card")?.classList.toggle("hidden", !isLgu);
  document.getElementById("inspect-card")?.classList.toggle("hidden", isLgu);
  closeOutlook();
}

function renderBarangayRanking() {
  const list = document.getElementById("lgu-list");
  if (!list) return;
  const ranking = (appData.provenance && appData.provenance.barangay_ranking) || [];
  list.innerHTML = ranking
    .map((r) => {
      const cls = r.high_risk_ha > 0 ? "high" : r.watch_ha > 0 ? "watch" : "low";
      const hh = r.high_risk_households ? ` · ${r.high_risk_households} households` : "";
      return `
        <li><button type="button" class="lgu-row" data-brgy="${escapeHtml(r.barangay)}"
            aria-label="Rank ${r.rank}: ${escapeHtml(r.barangay)}, ${r.high_risk_ha} hectares high risk">
          <span class="lgu-rank ${cls}">${r.rank}</span>
          <span><strong>${escapeHtml(r.barangay)}</strong>
            <small>${r.high_risk_ha} ha high · ${r.watch_ha} ha watch${hh}</small></span>
          <span class="lgu-score">max ${r.max_risk_score}/100</span>
        </button></li>`;
    })
    .join("");
  list.querySelectorAll(".lgu-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      // jump to the highest-risk plot in that barangay
      const plots = appData.plots.features.filter((f) => f.properties.barangay === btn.dataset.brgy);
      const top = plots.sort((a, b) => b.properties.risk_score - a.properties.risk_score)[0];
      if (top) selectPlot(top, true);
    });
  });
  const note = document.getElementById("lgu-note");
  if (note) {
    note.textContent =
      "Ranked by hectares rated high on the 30 m risk grid inside the sample plots. " +
      "Household counts are placeholders until LGU parcel and census data are added.";
  }
}

function populateLeftPanel() {
  const prov = appData.provenance;
  const nHigh = prov.high_risk_plots;
  document.getElementById("headline-status").textContent =
    nHigh === 0 ? "No plots at high drowning risk" : `${nHigh} plot${nHigh === 1 ? "" : "s"} at high drowning risk`;
  const afterDate = sceneDate(sarScenes().after);
  document.getElementById("headline-sub").textContent =
    `${afterDate ? `Sentinel-1 pass ${afterDate}` : "Post-storm Sentinel-1 pass"} · C-band surface wetness`;
  renderBarangayRanking();
  document.getElementById("kpi-ha").textContent = `${prov.total_high_risk_ha} ha`;
  document.getElementById("kpi-households").textContent = prov.households_affected;
  document.getElementById("kpi-hitrate").textContent = prov.sar_hit_rate;
  document.getElementById("kpi-baredays").textContent = `${prov.avg_bare_field_days} d/yr`;
  if ((prov.pending_inputs || []).includes("bare_field_days_per_year")) {
    // honest label: MODIS 250 m could not resolve field bare windows (see provenance.bare_field_check)
    const tile = document.getElementById("kpi-baredays").closest(".kpi-item");
    const label = tile && tile.querySelector(".kpi-label");
    if (label && !/placeholder/i.test(label.textContent)) label.textContent += " (placeholder)";
  }

  // Populate 5-node Corridor Stepper
  const stepper = document.getElementById("plot-stepper");
  stepper.innerHTML = appData.plots.features
    .map((f) => {
      const p = f.properties;
      const iconName =
        p.risk_class === "high" ? "alert-triangle" : p.risk_class === "watch" ? "clock" : "check";
      return `
        <button class="step-node" type="button" data-id="${p.plot_id}" aria-label="Select ${p.plot_id}, ${p.risk_class} risk">
          <div class="step-circle ${p.risk_class}" aria-hidden="true">
            <i data-lucide="${iconName}" width="13" height="13" stroke-width="2.4"></i>
          </div>
          <span class="step-id">${p.plot_id}</span>
          <span class="step-state">${p.risk_class}</span>
        </button>
      `;
    })
    .join("");

  if (window.lucide) {
    window.lucide.createIcons({ nodes: [stepper] });
  }

  stepper.querySelectorAll(".step-node").forEach((btn) => {
    btn.addEventListener("click", () => {
      const feat = appData.plots.features.find((f) => f.properties.plot_id === btn.dataset.id);
      if (feat) selectPlot(feat, true);
    });
  });

  // Provenance List
  document.getElementById("provenance-list").innerHTML = prov.datasets_used
    .map((d) => `<li>${d}</li>`)
    .join("");
  document.getElementById("future-work-text").textContent =
    `Future work (cut from 12h build): ${prov.future_work_datasets.join(", ")}.`;
}

function closeRiskPopover() {
  const riskBtn = document.getElementById("btn-risk-popover");
  const riskPopover = document.getElementById("risk-symbology-popover");
  if (riskPopover && !riskPopover.classList.contains("hidden")) {
    riskPopover.classList.add("hidden");
  }
  if (riskBtn) {
    riskBtn.setAttribute("aria-expanded", "false");
  }
}

// Only measured values: change vs the Aug–Sep baseline median on each real Sentinel-1 pass.
function formatDeltaSarLabel(p) {
  const normalizedMode = sarMode === "before" ? "pre" : sarMode === "after" ? "post" : sarMode;
  const sc = sarScenes();
  const pre = sceneDate(sc.just_before, false) || "pre-storm";
  const post = sceneDate(sc.after, false) || "post-storm";
  if (normalizedMode === "pre") {
    return `ΔSAR ${signedDb(p.pre_event_change_db)} dB (${pre} pass)`;
  }
  if (normalizedMode === "post") {
    return `ΔSAR ${signedDb(p.sar_wetness_change_db)} dB (${post} pass)`;
  }
  if (timelineStage === 0) {
    return "ΔSAR 0.0 dB (baseline reference)";
  }
  return `ΔSAR ${signedDb(p.sar_wetness_change_db)} dB (last pass, ${post})`;
}

function updateInspectSarReadout() {
  if (!appData || !appData.plots) return;
  const feat = appData.plots.features.find((f) => f.properties.plot_id === selectedPlotId);
  if (!feat) return;
  const p = feat.properties;
  const metaEl = document.getElementById("inspect-meta");
  if (metaEl) {
    metaEl.innerHTML = `
      <span>${p.hectares} ha</span>
      <span class="meta-dot" aria-hidden="true">·</span>
      <span>${p.current_crop}</span>
      <span class="meta-dot" aria-hidden="true">·</span>
      <span>${formatDeltaSarLabel(p)}</span>
    `;
  }
}

function selectPlot(feat, fly = true) {
  const p = feat.properties;
  selectedPlotId = p.plot_id;
  closeRiskPopover();
  if (fly) {
    // a user picked a plot: show its card, close the other right-side panels
    if (viewRole === "lgu") setRole("farmer");
    closeOutlook();
  }

  updateThreeSelectedPlot(selectedPlotId);

  const inspect = document.getElementById("inspect-card");
  inspect.classList.remove("hidden");

  document.getElementById("inspect-title").textContent = `${p.plot_id} · ${p.barangay}`;
  updateInspectSarReadout();

  const badge = document.getElementById("inspect-risk-badge");
  badge.className = `risk-tag ${p.risk_class}`;
  badge.innerHTML = `<span class="risk-dot" aria-hidden="true"></span><span>${p.risk_class.toUpperCase()} DROWNING RISK · ${p.risk_score}/100</span>`;

  document.getElementById("inspect-twi").textContent = `TWI: ${p.twi_value}`;
  if (appData.rotation_strategies) renderRotations(); // rotation fit follows the selected plot
  document.getElementById("inspect-action").textContent = p.plain_language_action;

  const sms = p.sms_alert.slice(0, 160);
  document.getElementById("inspect-sms-text").textContent = sms;
  document.getElementById("sms-counter").textContent = `${sms.length}/160 CHARS`;

  document.querySelectorAll(".step-node").forEach((node) => {
    const isSelected = node.dataset.id === p.plot_id;
    node.classList.toggle("active", isSelected);
    node.setAttribute("aria-pressed", String(isSelected));
  });

  document.querySelectorAll(".plot-pill-marker").forEach((marker) => {
    const isSelected = marker.dataset.plotId === p.plot_id;
    marker.classList.toggle("active", isSelected);
    marker.setAttribute("aria-pressed", String(isSelected));
  });

  if (fly && map) {
    const center = getPolygonCenter(feat.geometry.coordinates[0]);
    map.flyTo({ center, zoom: 15.6, pitch: is3D ? 55 : 0, duration: 900 });
  }
}

let currentPriority = "nitrogen";
const FIT_LABEL = { good: "Good fit", neutral: "Possible", caution: "Caution" };

function renderRotations(priorityKey = currentPriority) {
  currentPriority = priorityKey;
  const sorted = [...appData.rotation_strategies].sort(
    (a, b) => a.priorities[priorityKey] - b.priorities[priorityKey]
  );
  const plotFeat = appData.plots.features.find((f) => f.properties.plot_id === selectedPlotId);
  const plot = plotFeat ? plotFeat.properties : null;
  const fit = (plot && plot.rotation_fit) || {};
  const soil = plot && plot.soil_0_30cm;

  const container = document.getElementById("rotation-cards-container");
  const baseline = plot
    ? `<div class="rot-baseline">For <strong>${escapeHtml(plot.plot_id)}</strong> · now growing
         <strong>${escapeHtml(plot.baseline_crop || plot.current_crop)}</strong>${
           soil ? ` · ${escapeHtml(soil.texture)}, ${soil.clay_pct}% clay` : ""
         } · ${escapeHtml(plot.risk_class)} drowning risk</div>`
    : "";
  container.innerHTML = baseline + sorted
    .map(
      (s, idx) => `
      <div class="rot-card">
        <h4>#${idx + 1} ${s.name}</h4>
        ${fit[s.id] ? `<div class="rot-fit fit-${fit[s.id].fit}"><strong>${FIT_LABEL[fit[s.id].fit] || fit[s.id].fit}:</strong> ${escapeHtml(fit[s.id].why)}</div>` : ""}
        <div class="rot-crops"><strong>Crops:</strong> ${s.crops}</div>
        <div class="rot-benefit"><strong>Benefits:</strong> ${s.benefits}</div>
        <div class="rot-gap" style="display:flex;align-items:flex-start;gap:6px;">
          <i data-lucide="alert-triangle" width="13" height="13" stroke-width="2" style="margin-top:2px;flex-shrink:0;" aria-hidden="true"></i>
          <span><strong>Risks &amp; Gaps · Verify Locally:</strong> ${s.risks_and_gaps}</span>
        </div>
      </div>
    `
    )
    .join("");

  if (window.lucide) {
    window.lucide.createIcons({ nodes: [container] });
  }
}


function bindUIEvents() {
  // Drawer Tab Switcher
  document.querySelectorAll(".tab-pill").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab-pill").forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      const target = tab.dataset.drawer;
      ["layers", "rotations", "data"].forEach((id) => {
        document.getElementById(`drawer-${id}`).classList.toggle("hidden", id !== target);
      });
    });
  });

  // Quick Buttons
  document.getElementById("btn-open-rotation").addEventListener("click", () => {
    document.querySelector('[data-drawer="rotations"]').click();
  });

  document.getElementById("btn-open-sms").addEventListener("click", () => {
    closeRiskPopover();
    setRole("farmer"); // shows the plot card with the SMS preview
    const counter = document.getElementById("sms-counter")?.textContent || "160/160 CHARS";
    showToast(`Simulated SMS alert queued for ${selectedPlotId} (${counter.toLowerCase()}) — no external gateway`);
  });

  document.getElementById("btn-bell").addEventListener("click", (e) => {
    e.stopPropagation();
    const inspect = document.getElementById("inspect-card");
    if (inspect.classList.contains("hidden")) {
      closeRiskPopover();
      setRole("farmer");
    } else {
      inspect.classList.add("hidden");
    }
  });

  document.getElementById("btn-close-inspect").addEventListener("click", () => {
    document.getElementById("inspect-card").classList.add("hidden");
  });

  // Farmer <-> LGU view (barangay priority list for MAO / MDRRMO)
  document.getElementById("btn-role-switch").addEventListener("click", () => {
    setRole(viewRole === "lgu" ? "farmer" : "lgu");
  });
  document.getElementById("btn-close-lgu")?.addEventListener("click", () => setRole("farmer"));

  // Escape closes whichever right-side card is open
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.getElementById("inspect-card")?.classList.add("hidden");
    document.getElementById("lgu-card")?.classList.add("hidden");
    closeOutlook();
  });

  document.getElementById("btn-reset-bounds").addEventListener("click", () => fitPilot(true));

  // Collapse Left Panel (smooth accordion shrink)
  const leftPanel = document.getElementById("left-panel");
  const chevronBtn = document.getElementById("btn-chevron-left");
  if (leftPanel && chevronBtn) {
    chevronBtn.addEventListener("click", () => {
      const isCollapsed = leftPanel.classList.toggle("collapsed");
      chevronBtn.setAttribute("aria-expanded", String(!isCollapsed));
    });
  }

  // Search Filter
  document.getElementById("plot-search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    const match = appData.plots.features.find(
      (f) =>
        f.properties.plot_id.toLowerCase().includes(q) ||
        f.properties.barangay.toLowerCase().includes(q) ||
        f.properties.current_crop.toLowerCase().includes(q)
    );
    if (match && q.length >= 2) selectPlot(match, true);
  });

  // Priority Selector for Rotation Engine
  document.getElementById("priority-select").addEventListener("change", (e) => {
    renderRotations(e.target.value);
  });

  // Layer Checkboxes
  document.getElementById("chk-risk").addEventListener("change", (e) => {
    threeState.showParcels = e.target.checked;
    if (threeState.parcelGroup) {
      threeState.parcelGroup.visible = e.target.checked;
    }
  });

  document.getElementById("chk-flood").addEventListener("change", (e) => {
    const checked = e.target.checked;
    threeState.showFlood = checked;
    if (threeState.waterMesh) {
      threeState.waterMesh.visible = checked;
    }
    const dockFlood = document.getElementById("dock-flood");
    if (dockFlood) {
      dockFlood.classList.toggle("active", checked);
      dockFlood.setAttribute("aria-pressed", String(checked));
    }
    if (!checked && sarMode !== "off") {
      setSarMode("off", false);
    } else if (checked && sarMode !== "post") {
      setSarMode("post", false); // the flood mask is a post-storm product
    }
  });

  document.getElementById("chk-flow").addEventListener("change", (e) => {
    threeState.showCorridor = e.target.checked;
    if (threeState.canalGroup) {
      threeState.canalGroup.visible = e.target.checked;
    }
  });

  // SAR Before/After Mini Switcher
  document.querySelectorAll(".mini-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mini-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setSarMode(btn.dataset.sar);
    });
  });

  // Timeline Scrubber
  const slider = document.getElementById("time-slider");
  // Stage labels use the real Sentinel-1 acquisition dates from the pipeline.
  const sc = sarScenes();
  const base = sc.baseline || [];
  const stages = [
    {
      clock: base.length ? `${sceneDate(base[0], false)} – ${sceneDate(base[base.length - 1], false)} baseline` : "Baseline",
      sub: base.length ? `Median of ${base.length} calm Sentinel-1 passes` : "Pre-storm reference",
      sar: "off"
    },
    { clock: `${sceneDate(sc.just_before) || "Pre-storm"} · pre-storm`, sub: "Last calm pass before Kristine", sar: "pre" },
    { clock: `${sceneDate(sc.after) || "Post-storm"} · post-storm`, sub: "Sentinel-1 sees standing water", sar: "post" },
    { clock: "Field action", sub: "Trench & early harvest (advice)", sar: "off" },
    { clock: "Next season", sub: "Legume / bio-tillage rotation", sar: "off" }
  ];
  const initialStage = stages[Number(slider.value)] || stages[2];
  document.getElementById("stage-clock").textContent = initialStage.clock;
  document.getElementById("stage-sub").textContent = initialStage.sub;

  slider.addEventListener("input", (e) => {
    const idx = Number(e.target.value);
    timelineStage = idx;
    document.querySelectorAll(".scrubber-labels span").forEach((el, i) => {
      el.classList.toggle("active", i === idx);
    });
    document.getElementById("stage-clock").textContent = stages[idx].clock;
    document.getElementById("stage-sub").textContent = stages[idx].sub;
    setSarMode(stages[idx].sar);

    if (idx === 4) document.querySelector('[data-drawer="rotations"]').click();
  });

  document.getElementById("btn-play-timeline").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (playInterval) {
      clearInterval(playInterval);
      playInterval = null;
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = '<i data-lucide="play" width="16" height="16" stroke-width="2.2"></i>';
    } else {
      btn.setAttribute("aria-pressed", "true");
      btn.innerHTML = '<i data-lucide="pause" width="16" height="16" stroke-width="2.2"></i>';
      playInterval = setInterval(() => {
        slider.value = (Number(slider.value) + 1) % 5;
        slider.dispatchEvent(new Event("input"));
      }, 2200);
    }
    if (window.lucide) {
      window.lucide.createIcons({ nodes: [btn] });
    }
  });

  // Right Tool Dock
  document.getElementById("dock-zoom-in").addEventListener("click", () => map.zoomIn());
  document.getElementById("dock-zoom-out").addEventListener("click", () => map.zoomOut());
  document.getElementById("dock-compass").addEventListener("click", () => map.resetNorth());
  document.getElementById("dock-pitch").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    is3D = !is3D;
    btn.textContent = is3D ? "3D" : "2D";
    btn.classList.toggle("active", is3D);
    btn.setAttribute("aria-pressed", String(is3D));
    map.easeTo({ pitch: is3D ? 52 : 0 });
  });
  document.getElementById("dock-sar").addEventListener("click", (e) => {
    const active = e.currentTarget.classList.toggle("active");
    e.currentTarget.setAttribute("aria-pressed", String(active));
    setSarMode(active ? "post" : "off");
  });
  document.getElementById("dock-flood").addEventListener("click", () => {
    const chk = document.getElementById("chk-flood");
    chk.checked = !chk.checked;
    chk.dispatchEvent(new Event("change"));
  });
  document.getElementById("dock-center").addEventListener("click", () => {
    document.getElementById("btn-reset-bounds").click();
  });

  // Field Drowning Risk Symbology Popover (mutually exclusive with #inspect-card)
  const riskBtn = document.getElementById("btn-risk-popover");
  const riskPopover = document.getElementById("risk-symbology-popover");
  if (riskBtn && riskPopover) {
    riskBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = riskPopover.classList.contains("hidden");
      if (willOpen) {
        document.getElementById("inspect-card").classList.add("hidden");
      }
      riskPopover.classList.toggle("hidden", !willOpen);
      riskBtn.setAttribute("aria-expanded", String(willOpen));
    });

    riskPopover.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("click", (e) => {
      if (!riskPopover.classList.contains("hidden") && !riskBtn.contains(e.target)) {
        closeRiskPopover();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !riskPopover.classList.contains("hidden")) {
        closeRiskPopover();
        riskBtn.focus();
      }
    });
  }
}

function setSarMode(mode, syncFloodCheckbox = true) {
  const normalized = mode === "before" ? "pre" : mode === "after" ? "post" : mode;
  sarMode = normalized;

  document.querySelectorAll(".mini-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.sar === normalized);
  });

  const dockSar = document.getElementById("dock-sar");
  if (dockSar) {
    const isActive = normalized !== "off";
    dockSar.classList.toggle("active", isActive);
    dockSar.setAttribute("aria-pressed", String(isActive));
  }

  if (syncFloodCheckbox) {
    // The observed flood mask comes from the post-storm pass, so it only shows in "post".
    const showWater = normalized === "post";
    const chkFlood = document.getElementById("chk-flood");
    if (chkFlood) {
      chkFlood.checked = showWater;
    }
    threeState.showFlood = showWater;
    if (threeState.waterMesh) {
      threeState.waterMesh.visible = showWater;
    }
    const dockFlood = document.getElementById("dock-flood");
    if (dockFlood) {
      dockFlood.classList.toggle("active", showWater);
      dockFlood.setAttribute("aria-pressed", String(showWater));
    }
  }

  // Explain an empty pre-storm layer instead of leaving the user guessing
  if (normalized === "pre" && appData) {
    const before = appData.sar_backscatter_comparison?.before_event?.features || [];
    if (!before.length) {
      const d = sceneDate(sarScenes().just_before) || "Pre-storm pass";
      showToast(`${d}: no standing water detected before the storm — fields were normal`);
    }
  }

  if (map && map.getLayer("sar-pre-fill")) {
    map.setLayoutProperty("sar-pre-fill", "visibility", normalized === "pre" ? "visible" : "none");
    map.setLayoutProperty("sar-post-fill", "visibility", normalized === "post" ? "visible" : "none");
  }

  if (threeState.sarGroup) {
    if (normalized === "off") {
      threeState.sarGroup.visible = false;
      sarSweepProgress = 0;
    } else {
      threeState.sarGroup.visible = true;
      if (threeState.sarUniforms) {
        threeState.sarUniforms.uMode.value = normalized === "pre" ? 0.0 : 1.0;
      }
      sarSweepProgress = normalized === "post" ? 0.01 : 0;
    }
  }

  updateInspectSarReadout();
}

function startMapAnimations() {
  if (mapAnimFrame) {
    cancelAnimationFrame(mapAnimFrame);
    mapAnimFrame = null;
  }

  const canvas = document.getElementById("fx-overlay");
  const ctx = canvas ? canvas.getContext("2d") : null;
  let cssWidth = 0;
  let cssHeight = 0;

  const resizeCanvas = () => {
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = canvas.clientWidth || window.innerWidth;
    cssHeight = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  if (canvas && ctx) {
    resizeCanvas();
    if (!canvas.dataset.resizeBound) {
      window.addEventListener("resize", resizeCanvas);
      canvas.dataset.resizeBound = "true";
    }
  }

  const rainDrops = Array.from({ length: 90 }, () => ({
    x: Math.random(),
    y: Math.random(),
    len: 10 + Math.random() * 14,
    speed: 0.008 + Math.random() * 0.009
  }));

  let lastAppliedStage = -1;

  const tick = () => {
    if (lastAppliedStage !== timelineStage) {
      lastAppliedStage = timelineStage;
      if (timelineStage === 0 || timelineStage === 4) {
        threeState.targetWaterLevel = 0.0;
        threeState.cropUniforms.uWind.value = 0.22;
        if (threeState.sunLight) {
          threeState.sunLight.intensity = 2.1;
          threeState.sunLight.color.setHex(0xfff4e0);
        }
        if (threeState.hemiLight) threeState.hemiLight.intensity = 1.0;
      } else if (timelineStage === 1) {
        threeState.targetWaterLevel = 0.25;
        threeState.cropUniforms.uWind.value = 0.65;
        if (threeState.sunLight) {
          threeState.sunLight.intensity = 1.05;
          threeState.sunLight.color.setHex(0xcbd5e1);
        }
        if (threeState.hemiLight) threeState.hemiLight.intensity = 1.15;
      } else if (timelineStage === 2) {
        threeState.targetWaterLevel = 1.0;
        threeState.cropUniforms.uWind.value = 1.0;
        if (threeState.sunLight) {
          threeState.sunLight.intensity = 1.45;
          threeState.sunLight.color.setHex(0xe2e8f0);
        }
        if (threeState.hemiLight) threeState.hemiLight.intensity = 0.95;
        if (sarSweepProgress === 0) sarSweepProgress = 0.01;
      } else if (timelineStage === 3) {
        threeState.targetWaterLevel = 0.45;
        threeState.cropUniforms.uWind.value = 0.35;
        if (threeState.sunLight) {
          threeState.sunLight.intensity = 1.75;
          threeState.sunLight.color.setHex(0xfef3c7);
        }
        if (threeState.hemiLight) threeState.hemiLight.intensity = 1.0;
      }
    }

    // Render Orbital SAR Scan Sweep & Storm Rain Canvas (#fx-overlay)
    if (ctx && cssWidth > 0 && cssHeight > 0) {
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      // Rain streaks only on Post-Storm SAR (timelineStage === 2); skipped for reduced-motion users
      if (timelineStage === 2 && !prefersReducedMotion) {
        ctx.strokeStyle = "rgba(224, 242, 254, 0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < rainDrops.length; i++) {
          const drop = rainDrops[i];
          drop.y += drop.speed * 1.15;
          drop.x -= drop.speed * 0.24;
          if (drop.y > 1.05) {
            drop.y = -0.05;
            drop.x = Math.random() * 1.15;
          }
          if (drop.x < -0.05) {
            drop.x = 1.05;
          }
          const px = drop.x * cssWidth;
          const py = drop.y * cssHeight;
          ctx.moveTo(px, py);
          ctx.lineTo(px - drop.len * 0.24, py + drop.len);
        }
        ctx.stroke();
      }

      // Soft feathered SAR radar beam confined to pilot bounding box
      if (sarSweepProgress > 0 && map && pilotBounds && !prefersReducedMotion) {
        const pNW = map.project([pilotBounds[0], pilotBounds[3]]);
        const pSE = map.project([pilotBounds[2], pilotBounds[1]]);
        const minX = Math.max(0, Math.min(pNW.x, pSE.x) - 24);
        const maxX = Math.min(cssWidth, Math.max(pNW.x, pSE.x) + 24);
        const minY = Math.min(pNW.y, pSE.y) - 20;
        const maxY = Math.max(pNW.y, pSE.y) + 20;
        const boxW = Math.max(0, maxX - minX);
        const boxH = Math.max(0, maxY - minY);

        if (boxW > 10 && boxH > 10) {
          const sweepY = minY + sarSweepProgress * boxH;
          const beam = ctx.createLinearGradient(0, sweepY - 22, 0, sweepY + 22);
          beam.addColorStop(0, "rgba(56, 189, 248, 0)");
          beam.addColorStop(0.5, "rgba(56, 189, 248, 0.14)");
          beam.addColorStop(1, "rgba(56, 189, 248, 0)");
          ctx.fillStyle = beam;
          ctx.fillRect(minX, sweepY - 22, boxW, 44);

          ctx.strokeStyle = "rgba(125, 211, 252, 0.45)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(minX, sweepY);
          ctx.lineTo(maxX, sweepY);
          ctx.stroke();
        }

        sarSweepProgress += 0.011;
        if (sarSweepProgress > 1.05) {
          sarSweepProgress = 0;
        }
      }
    }

    mapAnimFrame = requestAnimationFrame(tick);
  };

  mapAnimFrame = requestAnimationFrame(tick);
}

initApp();
