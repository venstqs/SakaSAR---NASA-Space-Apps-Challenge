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
// Demo storyboard: baseline → pre-storm → Kristine hits → radar sees water → farmer acts → next season
const STAGE = { BASELINE: 0, PRE: 1, STORM: 2, POST: 3, ACTION: 4, NEXT: 5 };
let timelineStage = STAGE.POST; // starts on the 2 Nov post-storm radar view
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

// =====================================================================================
// SakaSAR dashboard: region → town → field, driven by the storm ribbon
// =====================================================================================
const REGION_BBOX = [[122.3, 11.8], [124.45, 14.6]];
const RISK_COLOR = { high: "#d9482a", watch: "#c98a12", low: "#3e9a66" };
const RISK_WORD = { high: "High risk of drowning", watch: "Watch this field", low: "Low risk" };
const FIT_COLOR = { good: "#3e9a66", neutral: "#8aa39a", caution: "#c98a12" };
const FIT_LABEL = { good: "Good fit", neutral: "Possible", caution: "Caution" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const $ = (id) => document.getElementById(id);

let scope = "region";
let mapMode = "post";
let region = { summary: null, munis: null, overlay: null };
let outlook = null;
let currentPriority = "nitrogen";
let selectedMuni = null;
let muniPopup = null;

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmt = (n) => (typeof n === "number" ? Math.round(n).toLocaleString("en-PH") : "n/a");
const pct = (x) => (typeof x === "number" ? `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%` : "n/a");

function sceneDate(id, withYear = true) {
  const m = /_(\d{4})(\d{2})(\d{2})T/.exec(id || "");
  if (!m) return null;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${withYear ? ` ${m[1]}` : ""}`;
}
const isoLabel = (iso) => { const d = new Date(iso + "T00:00:00"); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
function signedDb(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

let toastTimer = null;
function showToast(message, ms = 3400) {
  const t = $("toast");
  t.textContent = message;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

async function fetchJSON(urls) {
  for (const u of [].concat(urls)) {
    try {
      const r = await fetch(u);
      if (r.ok) return await r.json();
    } catch (_) { /* try the next source */ }
  }
  return null;
}

function geomBounds(geom) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [[minX, minY], [maxX, maxY]];
}

function getPolygonCenter(ring) {
  let lng = 0, lat = 0;
  const len = ring.length - 1;
  for (let i = 0; i < len; i++) { lng += ring[i][0]; lat += ring[i][1]; }
  return [lng / len, lat / len];
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
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

const phone = () => window.matchMedia("(max-width: 760px)").matches;

function fitRegion(animate = true) {
  if (!map) return;
  map.fitBounds(REGION_BBOX, {
    padding: phone() ? { top: 50, bottom: 90, left: 10, right: 10 } : { top: 60, bottom: 130, left: 30, right: 30 },
    pitch: 0, bearing: 0, duration: animate ? 900 : 0,
  });
}

function fitPilot(animate = true) {
  if (!map || !appData) return;
  const pts = appData.plots.features.flatMap((f) => f.geometry.coordinates[0]);
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], {
    padding: phone() ? { top: 40, bottom: 90, left: 20, right: 20 } : { top: 70, bottom: 140, left: 50, right: 70 },
    pitch: is3D ? 45 : 0, bearing: -12, duration: animate ? 1200 : 0, maxZoom: 17,
  });
}

// ---------- boot ----------
async function initApp() {
  const [data, summary, munis, overlay, soil] = await Promise.all([
    fetchJSON(DATA_SOURCE_URL),
    fetchJSON("data/region/bicol_summary.json"),
    fetchJSON("data/region/bicol_municipalities.geojson"),
    fetchJSON("data/region/bicol_flood.json"),
    fetchJSON(["data/soil_outlook.json", "/api/soil-outlook"]),
  ]);
  appData = data;
  region = { summary, munis, overlay };
  outlook = soil;
  mapCenter = (appData.provenance && appData.provenance.map_center) || DEFAULT_CENTER;
  pilotBounds = computePilotBounds(appData);

  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        satellite: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          attribution: "Imagery Esri · Radar Copernicus Sentinel-1 · NASA NASADEM · ESA WorldCover · Boundaries NAMRIA/PSA",
        },
      },
      layers: [{ id: "satellite-base", type: "raster", source: "satellite", paint: { "raster-saturation": -0.15 } }],
    },
    center: [123.35, 13.2],
    zoom: 7.3,
    attributionControl: { compact: true },
  });

  map.on("load", () => {
    addRegionLayers();
    addPilotLayers();
    startMapAnimations();
    (scope === "pilot" ? fitPilot : fitRegion)(false);
    updateZoomClass();
    applyLayers();
    buildRibbon(); // layout is final now
  });
  map.on("zoom", updateZoomClass);

  renderRegion();
  renderPilotStatic();
  selectPlot(appData.plots.features[0], false);
  renderLegend();
  bindUI();
  requestAnimationFrame(buildRibbon);
  setMapMode("post", false);
  renderAbout();
  if (["#outlook", "#field", "#minalabac"].includes(location.hash)) setScope("pilot");
}

function updateZoomClass() {
  $("map-wrap").classList.toggle("zoomed-out", map.getZoom() < 12);
}

// ---------- map layers ----------
function addRegionLayers() {
  if (region.overlay) {
    map.addSource("bicol-flood", { type: "image", url: region.overlay.image, coordinates: region.overlay.coordinates });
    map.addLayer({ id: "bicol-flood", type: "raster", source: "bicol-flood", maxzoom: 12.5,
      paint: { "raster-opacity": 0.95, "raster-fade-duration": 0, "raster-resampling": "nearest" } });
  }
  if (region.munis) {
    map.addSource("munis", { type: "geojson", data: region.munis });
    map.addLayer({ id: "munis-fill", type: "fill", source: "munis", maxzoom: 12.5,
      paint: { "fill-color": ["interpolate", ["linear"], ["get", "flooded_share"],
        0, "rgba(78,196,222,0)", 0.01, "rgba(78,196,222,0.10)", 0.05, "rgba(78,196,222,0.28)", 0.15, "rgba(78,196,222,0.5)"] } });
    map.addLayer({ id: "munis-line", type: "line", source: "munis",
      paint: { "line-color": "rgba(231,239,234,0.45)", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 11, 1.2] } });
    map.addLayer({ id: "munis-active", type: "line", source: "munis", filter: ["==", ["get", "name"], ""],
      paint: { "line-color": "#4ec4de", "line-width": 3 } });
    map.on("click", "munis-fill", (e) => {
      if (map.getZoom() > 13) return; // in the field view, clicks go to plots
      const p = e.features[0].properties;
      selectMuni(p.name, p.province, e.lngLat);
    });
    map.on("mouseenter", "munis-fill", () => { if (map.getZoom() <= 13) map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "munis-fill", () => { map.getCanvas().style.cursor = ""; });
  }
  // "Open the field view" marker at the pilot, visible when zoomed out
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "pilot-marker";
  pin.textContent = "Minalabac: 30 m field view";
  pin.addEventListener("click", () => setScope("pilot"));
  new maplibregl.Marker({ element: pin }).setLngLat(mapCenter).addTo(map);
}

function addPilotLayers() {
  const threeCustomLayer = {
    id: "fieldshift-3d-world",
    type: "custom",
    renderingMode: "3d",
    onAdd: (mapInstance, gl) => buildThreeScene(mapInstance, gl),
    render: (gl, matrix) => {
      if (!threeState.ready) return;
      const nowSec = performance.now() * 0.001;
      threeState.currentWaterLevel += (threeState.targetWaterLevel - threeState.currentWaterLevel) * 0.06;
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
      threeState.camera.projectionMatrixInverse.copy(threeState.camera.projectionMatrix).invert();
      threeState.renderer.resetState();
      threeState.renderer.render(threeState.scene, threeState.camera);
      map.triggerRepaint();
    },
  };

  const sarCmp = appData.sar_backscatter_comparison || {};
  const empty = { type: "FeatureCollection", features: [] };
  map.addSource("sar-pre-source", { type: "geojson", data: sarCmp.before_event || empty });
  map.addSource("sar-post-source", { type: "geojson", data: sarCmp.after_event || empty });
  map.addLayer({ id: "sar-pre-fill", type: "fill", source: "sar-pre-source",
    paint: { "fill-color": "#9fb8ae", "fill-opacity": 0.45 } });
  map.addLayer({ id: "sar-post-fill", type: "fill", source: "sar-post-source",
    paint: { "fill-color": "#4ec4de", "fill-opacity": 0.22 } });

  if (appData.risk_zones) {
    map.addSource("risk-zones-source", { type: "geojson", data: appData.risk_zones });
    map.addLayer({ id: "risk-zones-fill", type: "fill", source: "risk-zones-source",
      paint: { "fill-color": ["match", ["get", "risk_class"], "high", RISK_COLOR.high, "watch", RISK_COLOR.watch, "#9fb8ae"], "fill-opacity": 0.3 } });
    map.addLayer({ id: "risk-zones-line", type: "line", source: "risk-zones-source",
      paint: { "line-color": ["match", ["get", "risk_class"], "high", RISK_COLOR.high, "watch", RISK_COLOR.watch, "#9fb8ae"], "line-width": 0.8, "line-opacity": 0.8 } });
  }

  map.addSource("plots-source", { type: "geojson", data: appData.plots });
  map.addLayer({ id: "plots-hit-target", type: "fill", source: "plots-source", paint: { "fill-color": "#000", "fill-opacity": 0.01 } });
  map.addLayer(threeCustomLayer);

  appData.plots.features.forEach((feat) => {
    const p = feat.properties;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "plot-pill-marker";
    el.dataset.plotId = p.plot_id;
    el.setAttribute("aria-label", `${p.plot_id} in ${p.barangay}, risk ${p.risk_score} of 100`);
    el.innerHTML = `<span class="marker-dot" style="background:${RISK_COLOR[p.risk_class]}" aria-hidden="true"></span><span>${p.plot_id} ${p.risk_score}</span>`;
    el.addEventListener("click", () => { setScope("pilot", false); selectPlot(feat, true); });
    new maplibregl.Marker({ element: el }).setLngLat(getPolygonCenter(feat.geometry.coordinates[0])).addTo(map);
  });

  map.on("click", "plots-hit-target", (e) => {
    const id = e.features?.[0]?.properties?.plot_id;
    const feat = appData.plots.features.find((f) => f.properties.plot_id === id);
    if (feat) { setScope("pilot", false); selectPlot(feat, true); }
  });
}

function setVis(id, on) {
  if (map && map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

function applyLayers() {
  const flood = $("lyr-flood").checked && mapMode === "post";
  const towns = $("lyr-towns").checked;
  const risk = $("lyr-risk").checked;
  const canal = $("lyr-canal").checked;
  setVis("bicol-flood", flood);
  setVis("sar-post-fill", flood);
  setVis("sar-pre-fill", mapMode === "pre");
  ["munis-fill", "munis-line", "munis-active"].forEach((id) => setVis(id, towns));
  setVis("munis-fill", towns && mapMode === "post");
  ["risk-zones-fill", "risk-zones-line"].forEach((id) => setVis(id, risk && mapMode === "post"));
  if (threeState.waterMesh) threeState.waterMesh.visible = flood;
  if (threeState.parcelGroup) threeState.parcelGroup.visible = risk;
  if (threeState.canalGroup) threeState.canalGroup.visible = canal;
}

function renderLegend() {
  const el = $("legend");
  if (scope === "region") {
    el.innerHTML = `
      <b>Bicol after Kristine</b>
      <span class="lg"><i style="--c:#4ec4de"></i>Flooded farmland, radar 2 Nov</span>
      <span class="lg"><i style="--c:rgba(233,228,201,0.5)"></i>Other farmland</span>
      <span>Town shading: share of its farmland flooded</span>
      <span class="lg-ramp" aria-hidden="true"></span>
      <span class="lg-ends"><span>none</span><span>15% or more</span></span>`;
  } else {
    el.innerHTML = `
      <b>Field drowning risk, 30 m</b>
      <span class="lg"><i style="--c:${RISK_COLOR.high}"></i>High: trench or harvest now</span>
      <span class="lg"><i style="--c:${RISK_COLOR.watch}"></i>Watch: clear furrows</span>
      <span class="lg"><i style="--c:${RISK_COLOR.low}"></i>Low: normal drainage</span>
      <span class="lg"><i style="--c:#4ec4de"></i>Standing water seen by radar</span>`;
  }
}

// ---------- scope ----------
function setScope(next, move = true) {
  scope = next;
  const pilot = next === "pilot";
  $("tab-region").setAttribute("aria-selected", String(!pilot));
  $("tab-pilot").setAttribute("aria-selected", String(pilot));
  $("scope-region").hidden = pilot;
  $("scope-pilot").hidden = !pilot;
  $("sb-scroll").scrollTop = 0;
  if (muniPopup) { muniPopup.remove(); muniPopup = null; }
  renderLegend();
  if (move) (pilot ? fitPilot : fitRegion)(true);
}

// ---------- region ----------
function renderRegion() {
  const s = region.summary;
  if (!s) {
    $("region-lede").textContent = "The Bicol-wide flood layer has not been built yet. Run python -m pipeline.bicol_region.";
    return;
  }
  const cov = s.radar_coverage < 0.97 ? ` Radar covered ${pct(s.radar_coverage)} of the region.` : "";
  $("region-lede").innerHTML =
    `Radar saw <strong>${fmt(s.flooded_farmland_ha)} ha</strong> of flooded farmland across Bicol after Kristine, ` +
    `out of ${fmt(s.farmland_ha)} ha of farmland mapped.${cov}`;
  const max = Math.max(...s.provinces.map((p) => p.flooded_farmland_ha), 1);
  $("province-bars").innerHTML = s.provinces.map((p) => `
    <div class="prov" title="${escapeHtml(p.province)}: ${pct(p.flooded_share)} of farmland flooded">
      <span class="prov-name">${escapeHtml(p.province)}</span>
      <span class="prov-track"><span class="prov-fill" style="width:${(100 * p.flooded_farmland_ha) / max}%"></span></span>
      <span class="prov-val">${fmt(p.flooded_farmland_ha)} ha</span>
    </div>`).join("");
  renderMuniList("");
}

function muniRows() {
  return (region.munis?.features || []).map((f) => f.properties);
}

function renderMuniList(q) {
  const query = q.trim().toLowerCase();
  const rows = muniRows().filter((p) => !query || p.name.toLowerCase().includes(query) || p.province.toLowerCase().includes(query));
  const shown = query ? rows : rows.slice(0, 40);
  $("muni-empty").classList.toggle("hidden", rows.length > 0);
  $("muni-list").innerHTML = shown.map((p) => `
    <li><button type="button" class="rank-row${p.name === "Minalabac" ? " pilot" : ""}${selectedMuni === p.name ? " active" : ""}"
        data-name="${escapeHtml(p.name)}" data-prov="${escapeHtml(p.province)}">
      <span class="rank-n">${p.rank}</span>
      <span><span class="rank-name">${escapeHtml(p.name)}</span><span class="rank-sub">${escapeHtml(p.province)}</span></span>
      <span class="rank-val"><b>${fmt(p.flooded_farmland_ha)} ha</b><small>${pct(p.flooded_share)} of farmland</small></span>
    </button></li>`).join("") +
    (!query && rows.length > shown.length ? `<li class="empty">Showing the top 40 of ${rows.length} towns. Search to find any town.</li>` : "");
  $("muni-list").querySelectorAll(".rank-row").forEach((b) =>
    b.addEventListener("click", () => selectMuni(b.dataset.name, b.dataset.prov)));
}

function selectMuni(name, province, at) {
  const f = (region.munis?.features || []).find((x) => x.properties.name === name && x.properties.province === province);
  if (!f || !map) return;
  selectedMuni = name;
  const p = f.properties;
  map.setFilter("munis-active", ["all", ["==", ["get", "name"], name], ["==", ["get", "province"], province]]);
  map.fitBounds(geomBounds(f.geometry), { padding: phone() ? 30 : { top: 80, bottom: 150, left: 60, right: 60 }, pitch: 0, bearing: 0, duration: 900, maxZoom: 12 });
  if (muniPopup) muniPopup.remove();
  const pilotBtn = name === "Minalabac" ? `<br><button type="button" class="btn" id="popup-pilot" style="margin-top:8px">Open the 30 m field view</button>` : "";
  const center = at || [(geomBounds(f.geometry)[0][0] + geomBounds(f.geometry)[1][0]) / 2, (geomBounds(f.geometry)[0][1] + geomBounds(f.geometry)[1][1]) / 2];
  muniPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px", offset: 8 })
    .setLngLat(center)
    .setHTML(`<b>${escapeHtml(p.name)}, ${escapeHtml(p.province)}</b><br>
      ${fmt(p.flooded_farmland_ha)} ha of ${fmt(p.farmland_ha)} ha farmland flooded (${pct(p.flooded_share)}).<br>
      Rank ${p.rank} of ${muniRows().length} towns in Bicol.<br>
      <span style="color:#5c716a">Sentinel-1 ${escapeHtml(p.sentinel1)}; radar covered ${pct(p.radar_coverage)} of the town.</span>${pilotBtn}`)
    .addTo(map);
  $("popup-pilot")?.addEventListener("click", () => setScope("pilot"));
  renderMuniList($("muni-search").value);
}

// ---------- field view ----------
function renderPilotStatic() {
  const pv = appData.provenance;
  const n = pv.high_risk_plots;
  $("pilot-lede").innerHTML =
    `Five sample rice plots in <strong>Minalabac</strong>, Camarines Sur, checked at 30 m. ` +
    `${n === 0 ? "None are" : `<strong>${n}</strong> ${n === 1 ? "is" : "are"}`} at high risk of drowning.`;
  $("plot-list").innerHTML = appData.plots.features.map((f) => {
    const p = f.properties;
    return `<li><button type="button" class="plot-chip" data-id="${p.plot_id}" aria-pressed="false" style="--c:${RISK_COLOR[p.risk_class]}"
      aria-label="${p.plot_id}, ${p.risk_class} risk">
      <b>${p.plot_id}</b><span>${p.risk_score}/100</span></button></li>`;
  }).join("");
  $("plot-list").querySelectorAll(".plot-chip").forEach((b) => b.addEventListener("click", () => {
    const f = appData.plots.features.find((x) => x.properties.plot_id === b.dataset.id);
    if (f) selectPlot(f, true);
  }));
  const ranking = pv.barangay_ranking || [];
  $("brgy-list").innerHTML = ranking.map((r) => `
    <li><button type="button" class="rank-row" data-brgy="${escapeHtml(r.barangay)}">
      <span class="rank-n">${r.rank}</span>
      <span><span class="rank-name">${escapeHtml(r.barangay)}</span>
        <span class="rank-sub">${r.high_risk_ha} ha high, ${r.watch_ha} ha watch</span></span>
      <span class="rank-val"><b>${r.max_risk_score}</b><small>top score</small></span>
    </button></li>`).join("");
  $("brgy-list").querySelectorAll(".rank-row").forEach((b) => b.addEventListener("click", () => {
    const plots = appData.plots.features.filter((f) => f.properties.barangay === b.dataset.brgy);
    const top = plots.sort((a, c) => c.properties.risk_score - a.properties.risk_score)[0];
    if (top) selectPlot(top, true);
  }));
}

function selectPlot(feat, fly = true) {
  const p = feat.properties;
  selectedPlotId = p.plot_id;
  updateThreeSelectedPlot(p.plot_id);
  document.querySelectorAll(".plot-chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.id === p.plot_id)));
  document.querySelectorAll(".plot-pill-marker").forEach((m) => m.classList.toggle("active", m.dataset.plotId === p.plot_id));

  const brgy = p.barangay.replace(/^Brgy\.\s*/, "");
  $("pd-title").textContent = `${p.plot_id} in ${brgy}`;
  $("pd-meta").textContent = `${p.current_crop}, ${p.hectares} ha (sample plot)`;
  $("pd-risk").innerHTML = `
    <span class="risk-word" style="--c:${RISK_COLOR[p.risk_class]}">${RISK_WORD[p.risk_class]}</span>
    <span class="hint"> ${p.risk_score} out of 100</span>
    <div class="risk-track" role="img" aria-label="Risk ${p.risk_score} of 100"><span class="risk-pin" style="left:${p.risk_score}%"></span></div>
    <div class="risk-scale"><span>Low, under 40</span><span>Watch, 40 to 69</span><span>High, 70+</span></div>`;
  const soil = p.soil_0_30cm;
  const facts = [
    ["Radar change after the storm", `${signedDb(p.sar_wetness_change_db)}`, "Darker is wetter"],
    ["Radar change on 9 Oct, before the storm", signedDb(p.pre_event_change_db), "Compared with the Aug–Sep average"],
    ["Plot under standing water", pct(p.flooded_pixel_fraction), ""],
    ["Water-collecting terrain (TWI)", String(p.twi_value), "Higher collects more runoff"],
    ["Storm rain, GPM IMERG", `${fmt(appData.provenance.rainfall?.r_total_mm)} mm`, "21–26 Oct plus 7 days before"],
    ["Soil", soil ? `${soil.texture}, ${soil.clay_pct}% clay` : "n/a", "SoilGrids"],
  ];
  $("pd-facts").innerHTML = facts.map(([k, v, h]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd>${h ? `<dt>${h}</dt>` : ""}</div>`).join("");

  const recs = (p.recommendations || []).filter((r) => r.when !== "This week");
  $("pd-steps").innerHTML = recs.map((r, i) => `
    <li class="step" style="${i === 0 ? `--c:${RISK_COLOR[p.risk_class]}` : ""}">
      <span class="step-when">${escapeHtml(r.when)}</span>
      <p class="step-do">${escapeHtml(r.action)}</p>
      <p class="step-why">${escapeHtml(r.why)}</p>
    </li>`).join("");
  renderDrain(p);
  renderRotations(currentPriority);

  $("pd-sms").textContent = p.sms_alert;
  $("pd-sms-count").textContent = `${p.sms_alert.length} of 160 characters`;

  if (fly && map) {
    map.flyTo({ center: getPolygonCenter(feat.geometry.coordinates[0]), zoom: 16, pitch: is3D ? 50 : 0, bearing: -12, duration: 1000 });
  }
}

// "Will this field drain this week?" — the LSTM answer in plain words
function renderDrain(p) {
  const el = $("pd-drain");
  const h = outlook?.hindcasts?.find((x) => /2 Nov/.test(x.label)) || outlook?.hindcasts?.slice(-1)[0];
  if (!h) { el.innerHTML = `<p class="drain-note">The soil forecast is not available in this build.</p>`; return; }
  const n = h.days_waterlogged_pred;
  const answer = n >= 5
    ? `<strong>Not yet.</strong> The root zone stays waterlogged on ${n} of the next 7 days, so roots stay short of air.`
    : n >= 2
      ? `<strong>Slowly.</strong> Waterlogged on ${n} of the next 7 days, then it starts to drain.`
      : `<strong>Yes.</strong> The root zone drains within a day or two.`;
  const days = h.days.map((d) => {
    const v = d.gwetroot_pred;
    const hpx = Math.max(6, Math.min(100, ((v - 0.85) / 0.15) * 100));
    return `<span class="dday" title="${isoLabel(d.date)}: ${v.toFixed(2)} of saturation (actual ${d.gwetroot_actual.toFixed(2)})">
      <i style="--h:${hpx}%;--o:${v >= 0.97 ? 0.95 : 0.5}"></i>${isoLabel(d.date)}</span>`;
  }).join("");
  const so = outlook.scenario_outlook || {};
  const k = (so.cases || []).find((c) => /Kristine/.test(c.scenario));
  const urgency = p.risk_class === "high" ? "This plot is high risk, so treat it as urgent."
    : p.risk_class === "watch" ? "This plot is on watch, so check it after each rain."
    : "This plot drains well, so it recovers first.";
  el.innerHTML = `
    <p class="drain-answer">${answer}</p>
    <div class="drain-days" aria-label="Forecast root-zone saturation for the 7 days after the radar pass">${days}</div>
    <p class="drain-note">Our LSTM model forecast this from 25 years of NASA POWER weather, the day after the 2 Nov radar pass.
      What actually happened: waterlogged on ${h.days_waterlogged_actual} of 7 days. It describes the whole area (about 50 km), not one paddy. ${urgency}</p>
    ${k ? `<p class="drain-scn">If another Kristine-sized week of rain (${fmt(k.rain_total_mm)} mm) arrived on today's soil
      (${escapeHtml(so.root_zone_class_today)}, as of ${isoLabel(so.issued_after)}), the root zone would end the week ${escapeHtml(k.end_of_week_class)}.</p>` : ""}`;
}

function renderRotations(priority = currentPriority) {
  currentPriority = priority;
  const feat = appData.plots.features.find((f) => f.properties.plot_id === selectedPlotId);
  const fit = feat?.properties.rotation_fit || {};
  const sorted = [...appData.rotation_strategies].sort((a, b) => a.priorities[priority] - b.priorities[priority]);
  $("pd-rotations").innerHTML = sorted.map((s) => {
    const f = fit[s.id] || {};
    return `<li class="rot" style="--c:${FIT_COLOR[f.fit] || "#9fb8ae"}">
      <div class="rot-top"><span class="rot-name">${escapeHtml(s.name)}</span>
        <span class="rot-fit">${escapeHtml(FIT_LABEL[f.fit] || "")}</span></div>
      <p class="rot-crops">${escapeHtml(s.crops)}</p>
      ${f.why ? `<p class="rot-why">${escapeHtml(f.why.charAt(0).toUpperCase() + f.why.slice(1))}.</p>` : ""}
      <p class="rot-check">Check first: ${escapeHtml(s.risks_and_gaps)}</p>
    </li>`;
  }).join("");
}

// ---------- the storm ribbon ----------
const PASSES = [
  { mode: "pre", date: "2024-10-09", label: "9 Oct", caption: "<b>9 Oct 2024</b>: last calm radar pass before Kristine. The fields were dry." },
  { mode: "storm", date: "2024-10-21", label: "21 Oct", rejected: true,
    caption: "<b>21–26 Oct</b>: Kristine. Clouds hide the ground from optical satellites, and wind roughens the water, so the 21 Oct radar pass cannot see floods." },
  { mode: "post", date: "2024-11-02", label: "2 Nov", caption: "" },
];

function postCaption() {
  const s = region.summary;
  const ha = scope === "region" && s ? `${fmt(s.flooded_farmland_ha)} ha of Bicol farmland` : "standing water on the Minalabac plots";
  return `<b>2 Nov 2024</b>: calm radar pass. It shows ${ha}.`;
}

function buildRibbon() {
  const svg = $("ribbon-svg");
  const tl = appData.provenance.rain_timeline || [];
  const W = svg.clientWidth || 800, H = svg.clientHeight || 60;
  if (!tl.length) { svg.innerHTML = ""; return; }
  const top = 16, axis = 12, plotH = H - top - axis;
  const n = tl.length, bw = W / n;
  const maxMm = Math.max(...tl.map((d) => d.mm), 1);
  const idx = (iso) => tl.findIndex((d) => d.date === iso);
  const x = (i) => i * bw;
  const s0 = idx("2024-10-21"), s1 = idx("2024-10-26");
  let out = "";
  if (s0 >= 0 && s1 >= 0) out += `<rect class="rb-storm" x="${x(s0)}" y="${top - 4}" width="${x(s1 + 1) - x(s0)}" height="${plotH + 4}" rx="3"/>`;
  tl.forEach((d, i) => {
    const h = Math.max(1, (d.mm / maxMm) * plotH);
    const storm = d.date >= "2024-10-21" && d.date <= "2024-10-26";
    out += `<rect class="rb-bar${storm ? " storm" : ""}" x="${x(i) + bw * 0.18}" y="${top + plotH - h}" width="${bw * 0.64}" height="${h}"><title>${isoLabel(d.date)}: ${d.mm} mm</title></rect>`;
    const dd = new Date(d.date + "T00:00:00");
    if (dd.getDate() === 1 || i === 0) out += `<text class="rb-axis" x="${x(i)}" y="${H - 1}">${dd.getDate() === 1 ? MONTHS[dd.getMonth()] : isoLabel(d.date)}</text>`;
  });
  PASSES.forEach((p) => {
    const i = idx(p.date);
    if (i < 0) return;
    const cx = x(i) + bw / 2;
    out += `<g class="rb-pass${p.rejected ? " rejected" : ""}${mapMode === p.mode ? " active" : ""}" data-mode="${p.mode}" tabindex="0" role="button"
      aria-label="Show ${p.label} ${p.rejected ? "(storm, radar unusable)" : "radar pass"}">
      <line x1="${cx}" x2="${cx}" y1="${top - 2}" y2="${top + plotH}"/>
      <circle cx="${cx}" cy="${top - 6}" r="6"/>
      <text x="${cx + 10}" y="${top - 2}">${p.label}${p.rejected ? " (wind)" : ""}</text></g>`;
  });
  if (W > 520) out += `<text class="rb-axis" x="0" y="${top - 6}">Daily rain, NASA POWER (peak ${fmt(maxMm)} mm)</text>`;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMid meet");
  svg.innerHTML = out;
  svg.querySelectorAll(".rb-pass").forEach((g) => {
    g.addEventListener("click", () => setMapMode(g.dataset.mode));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMapMode(g.dataset.mode); } });
  });
}

function setMapMode(mode, announce = true) {
  mapMode = mode;
  sarMode = mode === "storm" ? "off" : mode;
  timelineStage = mode === "pre" ? STAGE.PRE : mode === "storm" ? STAGE.STORM : STAGE.POST;
  if (mode === "post" && sarSweepProgress === 0) sarSweepProgress = 0.01;
  document.querySelectorAll(".rb-pass").forEach((g) => g.classList.toggle("active", g.dataset.mode === mode));
  const pass = PASSES.find((p) => p.mode === mode);
  $("ribbon-caption").innerHTML = mode === "post" ? postCaption() : pass.caption;
  if (map && map.isStyleLoaded()) applyLayers();
  if (announce && mode === "pre") showToast("Before the storm: no flooding to show. Pick 2 Nov to see the flood.");
}

let playTimer = null;
function togglePlay() {
  const btn = $("btn-play");
  if (playTimer) { clearInterval(playTimer); playTimer = null; btn.textContent = "▶"; btn.setAttribute("aria-label", "Play the storm story"); return; }
  const order = ["pre", "storm", "post"];
  let i = 0;
  setMapMode(order[i], false);
  btn.textContent = "❚❚";
  btn.setAttribute("aria-label", "Pause");
  playTimer = setInterval(() => {
    i += 1;
    if (i >= order.length) { togglePlay(); return; }
    setMapMode(order[i], false);
  }, 2800);
}

// ---------- about ----------
function renderAbout() {
  const pv = appData.provenance;
  const s = region.summary;
  const m = outlook?.metrics?.GWETROOT;
  const ds = [...(pv.datasets_used || []), ...((s && s.sources) || []).filter((x) => /NAMRIA/.test(x))];
  $("about-body").innerHTML = `
    <h3>How the maps are made</h3>
    <p>Sentinel-1 radar sees through clouds. Calm floodwater reflects the radar away like a mirror, so flooded ground turns dark
      when we compare the 2 Nov 2024 pass with a pre-storm average. We count that dark water on farmland only (ESA WorldCover).</p>
    <ul>
      <li><b>Bicol Region</b>: 100 m cells, ${s ? `${fmt(s.municipalities)} towns, ` : ""}two radar orbits (west and centre after 2 Nov, Catanduanes and the east after 28 Oct).</li>
      <li><b>Minalabac fields</b>: 30 m cells. Risk = radar change (45%) + water-collecting terrain from NASADEM (35%) + storm rain from GPM IMERG (20%).</li>
    </ul>
    <h3>How good it is</h3>
    <ul>
      <li>Hit rate <b>${escapeHtml(pv.sar_hit_rate)}</b>: share of the radar-flooded farmland that the terrain-and-rain map had already rated high, without seeing the radar.
        The full model scores ${escapeHtml(pv.sar_hit_rate_full_model || "n/a")}, but that is circular because the radar is on both sides.</li>
      ${m ? `<li>Drainage forecast (LSTM): ${m.skill_vs_persistence_pct}% less error than "same as today" on unseen 2022–2026 data; it called all 7 waterlogged days after Kristine.</li>` : ""}
    </ul>
    <h3>What it cannot tell you</h3>
    <ul>
      <li>C-band radar sees surface water, not moisture at the roots. Water under tall rice or between houses can be missed.</li>
      <li>The 100 m regional map undercounts small flooded paddies; use it to rank towns, not to measure single farms.</li>
      <li>Plot outlines, hectares and households in Minalabac are samples until LGU parcel data is added.</li>
    </ul>
    <h3>Data used</h3>
    <ul>${ds.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>
    <h3>Download our data</h3>
    <ul>
      <li><a href="data/region/bicol_municipalities.geojson" download>Bicol towns: flooded farmland (GeoJSON)</a></li>
      <li><a href="data/datasets/plot_features.csv" download>Minalabac plot features (CSV)</a></li>
      <li><a href="data/datasets/pixels_30m_pilot.csv" download>30 m cells with flood labels (CSV)</a></li>
      <li><a href="data/datasets/daily_weather_soil_2001_2026.csv" download>Daily weather and soil, 2001–2026 (CSV)</a></li>
    </ul>
    <p class="hint">Processing time for the field view: ${escapeHtml(pv.processing_time || "n/a")}. Data licensing cost: ₱0.</p>`;
}

// ---------- events ----------
function bindUI() {
  $("tab-region").addEventListener("click", () => setScope("region"));
  $("tab-pilot").addEventListener("click", () => setScope("pilot"));
  $("muni-search").addEventListener("input", (e) => renderMuniList(e.target.value));
  $("priority-select").addEventListener("change", (e) => renderRotations(e.target.value));
  $("btn-copy-sms").addEventListener("click", async () => {
    const text = $("pd-sms").textContent;
    try { await navigator.clipboard.writeText(text); showToast("Message copied. Paste it into your SMS app."); }
    catch (_) { showToast("Copy is blocked in this browser. Select the message and copy it by hand."); }
  });
  $("btn-about").addEventListener("click", () => $("about-dialog").showModal());
  $("btn-play").addEventListener("click", togglePlay);
  $("btn-layers").addEventListener("click", () => {
    const panel = $("layers-panel");
    panel.hidden = !panel.hidden;
    $("btn-layers").setAttribute("aria-expanded", String(!panel.hidden));
  });
  ["lyr-flood", "lyr-towns", "lyr-risk", "lyr-canal"].forEach((id) => $(id).addEventListener("change", applyLayers));
  $("btn-3d").setAttribute("aria-pressed", String(is3D));
  $("btn-3d").addEventListener("click", () => {
    is3D = !is3D;
    $("btn-3d").setAttribute("aria-pressed", String(is3D));
    map.easeTo({ pitch: is3D ? (map.getZoom() > 12 ? 50 : 35) : 0, duration: 600 });
  });
  $("btn-zoom-in").addEventListener("click", () => map.zoomIn());
  $("btn-zoom-out").addEventListener("click", () => map.zoomOut());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("layers-panel").hidden = true; $("btn-layers").setAttribute("aria-expanded", "false"); }
  });
  let rt = null;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(buildRibbon, 150); });
  window.addEventListener("hashchange", () => { if (["#outlook", "#field", "#minalabac"].includes(location.hash)) setScope("pilot"); });
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
      const light = (intensity, hex, hemi) => {
        if (threeState.sunLight) {
          threeState.sunLight.intensity = intensity;
          threeState.sunLight.color.setHex(hex);
        }
        if (threeState.hemiLight) threeState.hemiLight.intensity = hemi;
      };
      if (timelineStage === STAGE.STORM) {
        // Kristine: wind and rain, dim light; water starts to rise
        threeState.targetWaterLevel = 0.25;
        threeState.cropUniforms.uWind.value = 1.0;
        light(1.0, 0xcbd5e1, 1.15);
      } else if (timelineStage === STAGE.POST) {
        // 2 Nov radar pass: calm, standing water, radar sweep
        threeState.targetWaterLevel = 1.0;
        threeState.cropUniforms.uWind.value = 0.3;
        light(1.5, 0xe2e8f0, 0.95);
        if (sarSweepProgress === 0) sarSweepProgress = 0.01;
      } else if (timelineStage === STAGE.ACTION) {
        threeState.targetWaterLevel = 0.45;
        threeState.cropUniforms.uWind.value = 0.35;
        light(1.75, 0xfef3c7, 1.0);
      } else {
        // baseline, pre-storm and next season: dry, sunny
        threeState.targetWaterLevel = 0.0;
        threeState.cropUniforms.uWind.value = 0.22;
        light(2.1, 0xfff4e0, 1.0);
      }
    }

    // Render Orbital SAR Scan Sweep & Storm Rain Canvas (#fx-overlay)
    if (ctx && cssWidth > 0 && cssHeight > 0) {
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      // Rain streaks only while Kristine is over the area (not on the calm 2 Nov pass); skipped for reduced motion
      if (timelineStage === STAGE.STORM && !prefersReducedMotion) {
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
