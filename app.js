// SakaSAR — GIS replay of Typhoon Kristine over the Bicol Region.
// Layout: top bar, side panel (layers, towns, forecast, events), full map, timeline.
// Heatmaps are rasters rendered in the browser: NASA POWER grid values, bilinear-interpolated in Web Mercator
// and masked to Bicol's town boundaries. Flood hotspots are a density of the Sentinel-1 flooded pixels.
"use strict";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GREEN = "#1f8a4c", WATER = "#2f9fd3", WATER_DARK = "#1b5fa8", STORM = "#e2533c";
const NAGA = { lon: 123.1948, lat: 13.6218, name: "Naga City" };
const BASEMAPS = {
  sat: { name: "Satellite", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], attr: "Imagery © Esri" },
  map: { name: "Map", tiles: ["https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png", "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png"], attr: "© OpenStreetMap © CARTO" },
};
const GIBS = {
  modis: { name: "MODIS true colour", sub: "Terra, that day. Clouds hide the ground during the storm.", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg", max: 9 },
  viirs: { name: "VIIRS true colour", sub: "Suomi NPP, that day", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg", max: 9 },
  imerg: { name: "GPM IMERG rain rate", sub: "Satellite rainfall, that day", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/{date}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png", max: 6 },
  smap: { name: "SMAP soil moisture", sub: "L-band radiometer, that day (gaps between passes)", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/SMAP_L3_Passive_Day_Soil_Moisture/default/{date}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png", max: 6 },
};
// PAGASA categories (10-minute winds, knots)
const CATS = [
  { max: 33, name: "tropical depression", short: "TD", c: "#7fb4c9" },
  { max: 47, name: "tropical storm", short: "TS", c: "#ee9f27" },
  { max: 63, name: "severe tropical storm", short: "STS", c: "#e2533c" },
  { max: 999, name: "typhoon", short: "TY", c: "#9e1b10" },
];
const cat = (kt) => CATS.find((c) => (kt ?? 0) <= c.max);

// Heatmap fields: colour stops are [value, [r,g,b,a]]
const FIELDS = {
  none: { name: "None" },
  rain: { name: "Rain that day", sub: "NASA POWER daily rain (PRECTOTCORR), about 50 km grid", unit: "mm", min: 0, max: 250,
    stops: [[0, [170, 215, 235, 0]], [3, [150, 210, 235, 80]], [15, [100, 195, 215, 150]], [40, [60, 175, 215, 190]], [80, [33, 120, 190, 205]], [140, [30, 70, 150, 215]], [250, [100, 40, 150, 225]]], ticks: [0, 60, 125, 190, "250+"] },
  rainsum: { name: "Rain since 10 Oct", sub: "Running total of NASA POWER daily rain", unit: "mm", min: 0, max: 700,
    stops: [[0, [170, 215, 235, 0]], [40, [150, 210, 235, 100]], [150, [100, 195, 215, 165]], [300, [47, 159, 211, 200]], [500, [27, 95, 168, 215]], [700, [88, 40, 150, 225]]], ticks: [0, 200, 400, "700+"] },
  soil: { name: "Root-zone soil wetness", sub: "NASA POWER GWETROOT. 1 = pores full of water; 0.97+ waterlogged", unit: "", min: 0.6, max: 1,
    stops: [[0.6, [201, 166, 107, 150]], [0.8, [233, 226, 184, 150]], [0.9, [143, 211, 176, 170]], [0.95, [47, 159, 211, 190]], [0.97, [27, 95, 168, 215]], [1, [16, 50, 120, 230]]], ticks: [0.6, 0.8, 0.9, 1] },
  lstm: { name: "LSTM waterlogged days", sub: "Days out of the next 7 with root zone at 0.97+", unit: "days", min: 0, max: 7,
    stops: [[0, [255, 255, 255, 0]], [0.5, [255, 236, 170, 120]], [2, [238, 159, 39, 170]], [4, [226, 83, 60, 200]], [7, [140, 20, 20, 225]]], ticks: [0, 2, 4, 7] },
};

const S = {
  tl: null, munis: null, summary: null, overlay: null,
  t: 23, playing: false, speed: 1, last: 0, dayShown: -1,
  field: "rainsum", fieldOpacity: 0.8, basemap: "sat", gibs: "none", view3d: true,
  layers: { hotspots: true, flood: true, towns: true, storm: true, terrain: true, hillshade: true },
  aiMode: "hind", events: [], townCenters: [], charts: {}, ready: false, inspect: null,
};
let map, stormMarker, pinMarker, hoverPopup;
const R = {}; // raster state

// ---------------- helpers ----------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => (typeof n === "number" && isFinite(n) ? n.toLocaleString("en-PH", { maximumFractionDigits: d, minimumFractionDigits: d }) : "n/a");
const pct = (x) => (typeof x === "number" ? `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%` : "n/a");
const N = () => S.tl.days.length;
const dayISO = (i) => S.tl.days[Math.max(0, Math.min(N() - 1, Math.floor(i)))];
const label = (iso) => { const d = new Date(iso + "T00:00:00"); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const short = (iso) => { const d = new Date(iso + "T00:00:00"); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const t0 = () => Date.parse(S.tl.days[0] + "T00:00:00Z");
const tAt = (iso) => (Date.parse(iso.length > 10 ? iso : iso + "T00:00:00Z") - t0()) / 86400000;
const km = (a, b) => { const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latFromMercY = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
async function fetchJSON(u) { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch (_) { return null; } }
let toastT;
function toast(m) { const el = $("toast"); el.textContent = m; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3000); }
const icons = () => window.lucide && window.lucide.createIcons();
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function townAt(lon, lat) {
  for (const f of S.munis?.features || []) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) if (pointInRing(lon, lat, p[0]) && !p.slice(1).some((h) => pointInRing(lon, lat, h))) return f.properties;
  }
  return null;
}
function nearestTown(lon, lat) {
  let best = null, bd = Infinity;
  for (const c of S.townCenters) { const d = (c.lon - lon) ** 2 + (c.lat - lat) ** 2; if (d < bd) { bd = d; best = c; } }
  return best;
}
function nearestCell(lon, lat) {
  let ci = 0, bd = Infinity;
  S.tl.cells.forEach((c, i) => { const d = (c.lon - lon) ** 2 + (c.lat - lat) ** 2; if (d < bd) { bd = d; ci = i; } });
  return ci;
}

// ---------------- boot ----------------
async function init() {
  const [tl, munis, summary, overlay] = await Promise.all([
    fetchJSON("data/region/bicol_timeline.json"), fetchJSON("data/region/bicol_municipalities.geojson"),
    fetchJSON("data/region/bicol_summary.json"), fetchJSON("data/region/bicol_flood.json"),
  ]);
  if (!tl || !munis) { toast("Could not load the Bicol data files. Run the API from the project folder."); return; }
  Object.assign(S, { tl, munis, summary, overlay });
  S.t = Math.max(0, tl.days.indexOf("2024-11-02")) + 0.5;
  S.townCenters = munis.features.map((f) => {
    let x = 0, y = 0, n = 0;
    const walk = (k) => { if (typeof k[0] === "number") { x += k[0]; y += k[1]; n++; } else k.forEach(walk); };
    walk(f.geometry.coordinates);
    return { name: f.properties.name, province: f.properties.province, lon: x / n, lat: y / n };
  });
  prepareGrid();
  if (window.Chart) { Chart.defaults.font.family = "Geist, system-ui, sans-serif"; Chart.defaults.color = "#5f7468"; }
  if (window.innerWidth <= 760) togglePanel(false);
  buildEvents();
  bindChrome();
  renderLayers();
  renderTowns();
  renderAI();
  buildTimeline();
  initMap();
  icons();
  setTime(S.t, true);
}

// ---------------- grid + raster ----------------
function prepareGrid() {
  const tl = S.tl;
  R.lons = [...new Set(tl.cells.map((c) => c.lon))].sort((a, b) => a - b);
  R.lats = [...new Set(tl.cells.map((c) => c.lat))].sort((a, b) => a - b);
  R.idx = R.lats.map((la) => R.lons.map((lo) => tl.cells.findIndex((c) => c.lon === lo && c.lat === la)));
  R.cum = tl.rain_mm.map((row) => { let s = 0; return row.map((v) => (s += v || 0)); });
  // raster extent = Bicol towns + margin
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  const walk = (k) => { if (typeof k[0] === "number") { w = Math.min(w, k[0]); e = Math.max(e, k[0]); s = Math.min(s, k[1]); n = Math.max(n, k[1]); } else k.forEach(walk); };
  S.munis.features.forEach((f) => walk(f.geometry.coordinates));
  Object.assign(R, { w: w - 0.03, e: e + 0.03, s: s - 0.03, n: n + 0.03 });
  R.yN = mercY(R.n); R.yS = mercY(R.s);
  R.W = 720; R.H = Math.round((R.W * (R.yN - R.yS)) / (((R.e - R.w) * Math.PI) / 180));
  R.canvas = document.createElement("canvas"); R.canvas.width = R.W; R.canvas.height = R.H;
  R.ctx = R.canvas.getContext("2d");
  R.px = (lon) => ((lon - R.w) / (R.e - R.w)) * R.W;
  R.py = (lat) => ((R.yN - mercY(lat)) / (R.yN - R.yS)) * R.H;
  R.lonAt = new Float64Array(R.W).map((_, x) => R.w + ((x + 0.5) / R.W) * (R.e - R.w));
  R.latAt = new Float64Array(R.H).map((_, y) => latFromMercY(R.yN - ((y + 0.5) / R.H) * (R.yN - R.yS)));
  // land mask from the town polygons
  const m = R.ctx;
  m.clearRect(0, 0, R.W, R.H); m.fillStyle = "#000"; m.beginPath();
  S.munis.features.forEach((f) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    polys.forEach((p) => p.forEach((ring) => ring.forEach(([lo, la], i) => (i ? m.lineTo(R.px(lo), R.py(la)) : m.moveTo(R.px(lo), R.py(la))))));
  });
  m.fill("evenodd");
  const md = m.getImageData(0, 0, R.W, R.H).data;
  R.mask = new Uint8Array(R.W * R.H);
  for (let i = 0; i < R.mask.length; i++) R.mask[i] = md[i * 4 + 3];
  R.coords = [[R.w, R.n], [R.e, R.n], [R.e, R.s], [R.w, R.s]];
}
function cellValues(field, di) {
  const tl = S.tl;
  return tl.cells.map((_, i) => {
    if (field === "rain") return tl.rain_mm[i][di] ?? 0;
    if (field === "rainsum") return R.cum[i][di];
    if (field === "soil") return tl.rootzone[i][di] ?? NaN;
    if (field === "lstm") return lstmValue(i);
    return NaN;
  });
}
// bilinear interpolation on the regular POWER grid; edges clamp; missing corners drop out of the weights
function sample(vals, lon, lat) {
  const nx = R.lons.length - 1, ny = R.lats.length - 1;
  const fx = Math.max(0, Math.min(nx, ((lon - R.lons[0]) / (R.lons[nx] - R.lons[0])) * nx));
  const fy = Math.max(0, Math.min(ny, ((lat - R.lats[0]) / (R.lats[ny] - R.lats[0])) * ny));
  const x0 = Math.min(nx - 1, Math.floor(fx)), y0 = Math.min(ny - 1, Math.floor(fy)), dx = fx - x0, dy = fy - y0;
  let s = 0, w = 0;
  [[x0, y0, (1 - dx) * (1 - dy)], [x0 + 1, y0, dx * (1 - dy)], [x0, y0 + 1, (1 - dx) * dy], [x0 + 1, y0 + 1, dx * dy]].forEach(([x, y, k]) => {
    const i = R.idx[y][x], v = i >= 0 ? vals[i] : NaN;
    if (isFinite(v) && k > 0) { s += v * k; w += k; }
  });
  return w > 0 ? s / w : NaN;
}
function lut(field) {
  const f = FIELDS[field]; if (f._lut) return f._lut;
  const L = new Uint8ClampedArray(256 * 4);
  for (let k = 0; k < 256; k++) {
    const v = f.min + (k / 255) * (f.max - f.min);
    let j = f.stops.findIndex((s) => s[0] >= v); if (j <= 0) j = j === 0 ? 0 : f.stops.length - 1;
    const a = f.stops[Math.max(0, j - 1)], b = f.stops[j], q = b[0] === a[0] ? 1 : (v - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 4; c++) L[k * 4 + c] = a[1][c] + (b[1][c] - a[1][c]) * Math.max(0, Math.min(1, q));
  }
  return (f._lut = L);
}
function renderField() {
  if (!S.ready) return;
  const src = map.getSource("field");
  if (S.field === "none") { vis("field", false); return; }
  const f = FIELDS[S.field], vals = cellValues(S.field, Math.floor(S.t)), L = lut(S.field);
  const img = R.ctx.createImageData(R.W, R.H), d = img.data;
  // sample on a coarse lattice then fill (fast and smooth: the source grid is ~50 km)
  const step = 4, gw = Math.ceil(R.W / step) + 1, gh = Math.ceil(R.H / step) + 1, G = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = Math.min(R.W - 1, gx * step), y = Math.min(R.H - 1, gy * step);
    G[gy * gw + gx] = sample(vals, R.lonAt[x], R.latAt[y]);
  }
  for (let y = 0; y < R.H; y++) {
    const gy = y / step, y0 = Math.floor(gy), ty = gy - y0;
    for (let x = 0; x < R.W; x++) {
      const p = y * R.W + x; if (!R.mask[p]) continue;
      const gx = x / step, x0 = Math.floor(gx), tx = gx - x0;
      const a = G[y0 * gw + x0], b = G[y0 * gw + x0 + 1], c = G[(y0 + 1) * gw + x0], e = G[(y0 + 1) * gw + x0 + 1];
      const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
      if (!isFinite(v)) continue;
      const k = Math.max(0, Math.min(255, Math.round(((v - f.min) / (f.max - f.min)) * 255))) * 4;
      d[p * 4] = L[k]; d[p * 4 + 1] = L[k + 1]; d[p * 4 + 2] = L[k + 2]; d[p * 4 + 3] = (L[k + 3] * R.mask[p]) / 255;
    }
  }
  R.ctx.putImageData(img, 0, 0);
  const snap = document.createElement("canvas"); snap.width = R.W; snap.height = R.H; snap.getContext("2d").drawImage(R.canvas, 0, 0);
  const key = `${S.field}-${S.aiMode}-${Math.floor(S.t)}`;
  registerRaster("field", snap, R.w, R.e, R.n, R.s, true);
  if (!src) {
    map.addSource("field", { type: "raster", tiles: [`saka://field/${key}/{z}/{x}/{y}`], tileSize: 256, minzoom: 4, maxzoom: 11, bounds: [R.w, R.s, R.e, R.n] });
    map.addLayer({ id: "field", type: "raster", source: "field", paint: { "raster-opacity": fieldOp(), "raster-fade-duration": 0, "raster-resampling": "linear" } }, map.getLayer("towns-fill") ? "towns-fill" : undefined);
    map.getSource("field")._key = key;
  } else if (src._key !== key) { src._key = key; src.setTiles([`saka://field/${key}/{z}/{x}/{y}`]); }
  map.setPaintProperty("field", "raster-opacity", fieldOp());
  vis("field", true);
}

// flood hotspots: density of Sentinel-1 flooded pixels, binned to ~1 km
function loadFloodPixels() {
  if (!S.overlay) return;
  const img = new Image(); img.crossOrigin = "anonymous";
  img.onload = () => {
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const [[w, n], [e], , [, s]] = S.overlay.coordinates, yN = mercY(n), yS = mercY(s);
    Object.assign(R, { flood: d, fw: c.width, fh: c.height, fW: w, fE: e, fyN: yN, fyS: yS });
    const B = 7, bins = new Map();
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] < 200) continue;
      const k = `${Math.floor(x / B)},${Math.floor(y / B)}`; bins.set(k, (bins.get(k) || 0) + 1);
    }
    const max = Math.max(1, ...bins.values());
    const feats = [...bins].map(([k, v]) => {
      const [bx, by] = k.split(",").map(Number);
      const lon = w + (((bx + 0.5) * B) / c.width) * (e - w), lat = latFromMercY(yN - (((by + 0.5) * B) / c.height) * (yN - yS));
      return { type: "Feature", properties: { w: v / max }, geometry: { type: "Point", coordinates: [lon, lat] } };
    });
    registerRaster("flood", c, w, e, n, s, false);
    const go = () => { map.getSource("hotspots").setData({ type: "FeatureCollection", features: feats }); map.getSource("flood")?.setTiles(["saka://flood/ready/{z}/{x}/{y}"]); };
    S.ready ? go() : map.once("style.load", go);
  };
  img.src = S.overlay.image;
}
function floodAt(lon, lat) {
  if (!R.flood) return null;
  const x = Math.floor(((lon - R.fW) / (R.fE - R.fW)) * R.fw), y = Math.floor(((R.fyN - mercY(lat)) / (R.fyN - R.fyS)) * R.fh);
  if (x < 0 || y < 0 || x >= R.fw || y >= R.fh) return "outside";
  const a = R.flood[(y * R.fw + x) * 4 + 3];
  return a >= 200 ? "flooded" : a > 0 ? "farmland" : "other";
}

// ---------------- browser-made map tiles ----------------
// MapLibre 4 drapes an image/canvas source only onto the terrain tiles it assigns to it, so a raster that straddles
// tile boundaries gets cut in 3D. Serving our rasters as ordinary {z}/{x}/{y} tiles avoids that everywhere.
const TILE_SRC = {}; // name -> { canvas, w, e, n, s, smooth }
function registerRaster(name, canvas, w, e, n, s, smooth) {
  const yN = mercY(n), yS = mercY(s);
  TILE_SRC[name] = { canvas, smooth, mx0: (w + 180) / 360, mx1: (e + 180) / 360, my0: (1 - yN / Math.PI) / 2, my1: (1 - yS / Math.PI) / 2 };
}
maplibregl.addProtocol("saka", async (params) => {
  const m = params.url.match(/^saka:\/\/([^/]+)\/[^/]+\/(\d+)\/(\d+)\/(\d+)/);
  const src = m && TILE_SRC[m[1]];
  const out = document.createElement("canvas"); out.width = out.height = 256;
  if (src) {
    const z = Number(m[2]), x = Number(m[3]), y = Number(m[4]), n = 2 ** z, c = src.canvas;
    const sx = ((x / n - src.mx0) / (src.mx1 - src.mx0)) * c.width, sw = (1 / n / (src.mx1 - src.mx0)) * c.width;
    const sy = ((y / n - src.my0) / (src.my1 - src.my0)) * c.height, sh = (1 / n / (src.my1 - src.my0)) * c.height;
    // clip the source rect to the canvas and scale the destination to match
    const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy), cx1 = Math.min(c.width, sx + sw), cy1 = Math.min(c.height, sy + sh);
    if (cx1 > cx0 && cy1 > cy0) {
      const ctx = out.getContext("2d"); ctx.imageSmoothingEnabled = src.smooth;
      ctx.drawImage(c, cx0, cy0, cx1 - cx0, cy1 - cy0, ((cx0 - sx) / sw) * 256, ((cy0 - sy) / sh) * 256, ((cx1 - cx0) / sw) * 256, ((cy1 - cy0) / sh) * 256);
    }
  }
  // synchronous encode: toBlob callbacks can stall while the map is busy, leaving tiles stuck in "loading"
  const bin = atob(out.toDataURL("image/png").split(",")[1]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { data: bytes.buffer };
});

// ---------------- map ----------------
function initMap() {
  map = new maplibregl.Map({
    container: "map", hash: "view", preserveDrawingBuffer: true, maxPitch: 75, attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        base: { type: "raster", tiles: BASEMAPS.sat.tiles, tileSize: 256, maxzoom: 19, attribution: BASEMAPS.sat.attr },
        dem: { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 13, attribution: "Terrain: AWS Terrain Tiles" },
        shade: { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 13 },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#1c3a4a" } }, // sea-coloured, so tiles still loading never flash white
        { id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 200 } },
        { id: "hillshade", type: "hillshade", source: "shade", paint: { "hillshade-exaggeration": 0.3, "hillshade-shadow-color": "#10261a" } },
      ],
      terrain: { source: "dem", exaggeration: 1.8 },
      sky: { "sky-color": "#bcdcf0", "horizon-color": "#eef3f0", "fog-color": "#eef3f0", "sky-horizon-blend": 0.5, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.2 },
    },
    bounds: [[R.w, R.s], [R.e, R.n]], fitBoundsOptions: { padding: chromePadding() }, pitch: 30,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-right");
  map.once("style.load", () => { map.setPadding(chromePadding()); addLayers(); S.ready = true; applyLayers(); setTime(S.t, true); });
  loadFloodPixels();
  // when our browser-made tiles arrive, the 3D terrain must re-drape them (it caches each tile's layers)
  let rttQueued = false;
  map.on("sourcedata", (e) => {
    if ((e.sourceId === "field" || e.sourceId === "flood") && e.tile && !rttQueued) {
      rttQueued = true;
      requestAnimationFrame(() => { rttQueued = false; map.terrain?.sourceCache?.freeRtt?.(); map.triggerRepaint(); });
    }
  });
  map.on("mousemove", onHover);
  map.on("mouseout", () => { $("readout").innerHTML = "Move over the map to read values"; hoverPopup?.remove(); });
  map.on("click", (e) => inspect(e.lngLat.lng, e.lngLat.lat));
}

function addLayers() {
  Object.entries(GIBS).forEach(([k, g]) => {
    map.addSource(`gibs-${k}`, { type: "raster", tileSize: 256, maxzoom: g.max, tiles: [g.url.replace("{date}", dayISO(S.t))], attribution: "NASA GIBS" });
    map.addLayer({ id: `gibs-${k}`, type: "raster", source: `gibs-${k}`, paint: { "raster-opacity": k === "imerg" || k === "smap" ? 0.8 : 1 }, layout: { visibility: "none" } });
  });

  map.addSource("munis", { type: "geojson", data: S.munis, promoteId: "rank" });
  map.addLayer({ id: "towns-fill", type: "fill", source: "munis",
    paint: { "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 1, 10, 0], "fill-color": ["interpolate", ["linear"], ["get", "flooded_share"], 0, "rgba(47,159,211,0)", 0.01, "rgba(47,159,211,0.12)", 0.05, "rgba(47,159,211,0.3)", 0.15, "rgba(27,95,168,0.45)", 0.3, "rgba(16,50,120,0.6)"] } });
  map.addLayer({ id: "towns-line", type: "line", source: "munis", paint: { "line-color": "rgba(255,255,255,0.75)", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 11, 1.4] } });
  map.addLayer({ id: "towns-hover", type: "line", source: "munis", paint: { "line-color": "#fff", "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.5, 0] } });
  map.addLayer({ id: "towns-active", type: "line", source: "munis", filter: ["==", ["get", "name"], ""], paint: { "line-color": "#ffd166", "line-width": 3 } });

  map.addSource("hotspots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "hotspots", type: "heatmap", source: "hotspots", maxzoom: 12,
    paint: {
      "heatmap-weight": ["get", "w"], "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 7, 1.4, 11, 2.5],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 7, 12, 9, 22, 11, 36],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.12, "rgba(255,232,130,0.55)", 0.4, "rgba(255,176,0,0.85)", 0.7, "rgba(255,90,31,0.92)", 1, "rgba(190,0,40,0.95)"],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 1, 10.5, 0.22],
    } });
  if (S.overlay) {
    map.addSource("flood", { type: "raster", tiles: ["saka://flood/wait/{z}/{x}/{y}"], tileSize: 256, minzoom: 6, maxzoom: 13,
      bounds: [S.overlay.coordinates[0][0], S.overlay.coordinates[2][1], S.overlay.coordinates[1][0], S.overlay.coordinates[0][1]] });
    map.addLayer({ id: "flood", type: "raster", source: "flood", minzoom: 8.5, paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 0, 9.5, 1], "raster-fade-duration": 0, "raster-resampling": "nearest" } });
  }

  // storm: segments coloured by category, points, closest approach to Naga
  const st = S.tl.storm;
  const segs = st.slice(1).map((p, i) => ({ type: "Feature", properties: { c: cat(st[i].wind_kts).c }, geometry: { type: "LineString", coordinates: [[st[i].lon, st[i].lat], [p.lon, p.lat]] } }));
  map.addSource("track", { type: "geojson", data: { type: "FeatureCollection", features: segs } });
  map.addSource("track-pts", { type: "geojson", data: { type: "FeatureCollection", features: st.map((p) => ({ type: "Feature", properties: { c: cat(p.wind_kts).c }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) } });
  map.addSource("track-done", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "track-casing", type: "line", source: "track", paint: { "line-color": "rgba(0,0,0,0.35)", "line-width": 6 }, layout: { "line-cap": "round" } });
  map.addLayer({ id: "track", type: "line", source: "track", paint: { "line-color": ["get", "c"], "line-width": 3, "line-opacity": 0.45 }, layout: { "line-cap": "round" } });
  map.addLayer({ id: "track-done", type: "line", source: "track-done", paint: { "line-color": ["get", "c"], "line-width": 4 }, layout: { "line-cap": "round" } });
  map.addLayer({ id: "track-pts", type: "circle", source: "track-pts", paint: { "circle-radius": 3.5, "circle-color": ["get", "c"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } });
  const ci = st.reduce((m, p, i) => (km(p, NAGA) < km(st[m], NAGA) ? i : m), 0);
  S.closest = { i: ci, km: km(st[ci], NAGA) };
  map.addSource("closest", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [[NAGA.lon, NAGA.lat], [st[ci].lon, st[ci].lat]] } } });
  map.addLayer({ id: "closest", type: "line", source: "closest", paint: { "line-color": "#fff", "line-width": 1.5, "line-dasharray": [3, 2] } });

  S.trackLabels = st.filter((p) => p.t.endsWith("T00:00:00Z")).map((p) => {
    const el = document.createElement("div"); el.className = "track-label";
    el.innerHTML = `<b>${short(p.t.slice(0, 10))}</b> ${p.wind_kts} kt`;
    return new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat([p.lon, p.lat]).addTo(map);
  });
  const mid = { lon: (NAGA.lon + st[ci].lon) / 2, lat: (NAGA.lat + st[ci].lat) / 2 };
  const ref = document.createElement("div"); ref.className = "ref-label";
  ref.textContent = `Closest pass ${fmt(S.closest.km)} km from Naga, ${short(st[ci].t.slice(0, 10))}`;
  S.refLabel = new maplibregl.Marker({ element: ref }).setLngLat([mid.lon, mid.lat]).addTo(map);
  const naga = document.createElement("div"); naga.className = "ref-label"; naga.textContent = "Naga City";
  S.nagaLabel = new maplibregl.Marker({ element: naga, anchor: "top", offset: [0, 6] }).setLngLat([NAGA.lon, NAGA.lat]).addTo(map);

  const el = document.createElement("div");
  el.className = "storm-marker";
  el.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="2.5"/><path d="M12 4c-4 0-7 2-8 5"/><path d="M12 20c4 0 7-2 8-5"/><path d="M4 12c0 4 2 7 5 8"/><path d="M20 12c0-4-2-7-5-8"/></svg><span class="storm-tag" id="storm-tag"></span>`;
  stormMarker = new maplibregl.Marker({ element: el }).setLngLat([st[0].lon, st[0].lat]).addTo(map);

  let hovered = null;
  map.on("mousemove", "towns-fill", (e) => {
    const f = e.features[0];
    if (hovered !== null) map.setFeatureState({ source: "munis", id: hovered }, { hover: false });
    hovered = f.id; map.setFeatureState({ source: "munis", id: hovered }, { hover: true });
    map.getCanvas().style.cursor = "crosshair";
  });
  map.on("mouseleave", "towns-fill", () => { if (hovered !== null) map.setFeatureState({ source: "munis", id: hovered }, { hover: false }); hovered = null; map.getCanvas().style.cursor = ""; });
}

// heatmaps are ~50 km data: fade them as you zoom into fields so the satellite and radar layers show
const fieldOp = () => ["interpolate", ["linear"], ["zoom"], 8.5, S.fieldOpacity, 11, S.fieldOpacity * 0.2];
function vis(id, on) { if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
function applyLayers() {
  if (!S.ready) return;
  const L = S.layers, after = dayISO(S.t) >= "2024-11-02";
  vis("hotspots", L.hotspots && after);
  vis("flood", L.flood && after);
  vis("towns-fill", L.towns && after);
  ["towns-line", "towns-hover", "towns-active"].forEach((id) => vis(id, L.towns));
  ["track-casing", "track", "track-done", "track-pts", "closest"].forEach((id) => vis(id, L.storm));
  [stormMarker, S.refLabel, S.nagaLabel, ...(S.trackLabels || [])].forEach((m) => m && (m.getElement().style.visibility = L.storm ? "" : "hidden"));
  vis("hillshade", L.hillshade);
  Object.keys(GIBS).forEach((k) => vis(`gibs-${k}`, S.gibs === k));
  map.setTerrain(L.terrain && S.view3d ? { source: "dem", exaggeration: Number($("exag")?.value || 1.8) } : null);
  renderLegend();
}
function setBasemap(k) {
  S.basemap = k;
  const src = map.getSource("base"); if (!src) return;
  src.setTiles(BASEMAPS[k].tiles);
  map.setPaintProperty("towns-line", "line-color", k === "sat" ? "rgba(255,255,255,0.75)" : "rgba(19,38,28,0.35)");
}

// ---------------- hover readout + inspector ----------------
function onHover(e) {
  if (!S.tl) return;
  const { lng, lat } = e.lngLat, t = townAt(lng, lat), f = FIELDS[S.field];
  let val = "";
  if (S.field !== "none") {
    const v = sample(cellValues(S.field, Math.floor(S.t)), lng, lat);
    val = ` <span>|</span> ${f.name}: <b>${S.field === "soil" ? fmt(v, 2) : fmt(v, S.field === "lstm" ? 1 : 0)}${f.unit ? " " + f.unit : ""}</b>`;
  }
  $("readout").innerHTML = `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E${t ? ` <span>|</span> <b>${esc(t.name)}</b>, ${esc(t.province)}` : ""}${val}`;
}
function inspect(lon, lat) {
  S.inspect = { lon, lat };
  const tl = S.tl, di = Math.floor(S.t), iso = dayISO(di), t = townAt(lon, lat), ci = nearestCell(lon, lat);
  if (!pinMarker) { const el = document.createElement("div"); el.className = "pin"; pinMarker = new maplibregl.Marker({ element: el }); }
  pinMarker.setLngLat([lon, lat]).addTo(map);
  if (t) map.setFilter("towns-active", ["all", ["==", ["get", "name"], t.name], ["==", ["get", "province"], t.province]]);
  const rainDay = sample(cellValues("rain", di), lon, lat), rainSum = sample(cellValues("rainsum", di), lon, lat);
  const evVals = tl.cells.map((_, i) => tl.days.reduce((a, d, k) => (d >= "2024-10-20" && d <= "2024-10-26" ? a + (tl.rain_mm[i][k] || 0) : a), 0));
  const rainEvent = sample(evVals, lon, lat), soil = sample(cellValues("soil", di), lon, lat);
  const fl = floodAt(lon, lat);
  const flPill = fl === "flooded" ? `<span class="pill wet">Flooded farmland</span>` : fl === "farmland" ? `<span class="pill dry">Farmland, no flood seen</span>` : fl === "other" ? `<span class="pill na">Not farmland</span>` : `<span class="pill na">Outside radar map</span>`;
  const h = tl.lstm_hindcast?.cells?.[ci], g = tl.lstm_kristine_again?.cells?.[ci];
  const sd = S.storm && S.storm.active ? km({ lon, lat }, S.storm) : null;
  const share = t?.flooded_share ?? 0;
  const acts = !t ? [] : share >= 0.15
    ? ["Send Municipal Agriculture Office teams here first.", "Open main drains and canals; clear bridges of debris.", "Report damage from this map instead of waiting for a field survey.", "Harvest mature rice early; hold off fertiliser while water stands."]
    : share >= 0.03 ? ["Check low-lying barangays near rivers and lakes first.", "Advise farmers to open field outlets and dig drainage trenches.", "Re-check after the next Sentinel-1 pass (every 12 days)."]
      : ["Little flooded farmland seen by radar: routine monitoring.", "Radar can miss water under tall crops; confirm with barangay reports."];
  $("insp-title").textContent = t ? `${t.name}, ${t.province}` : "Point outside Bicol towns";
  $("insp-body").innerHTML = `
    <p class="coord">${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E</p>
    <dl class="kv">
      <dt>Sentinel-1, 2 Nov (this pixel)</dt><dd>${flPill}</dd>
      ${t ? `<div class="sec">Town</div>
      <dt>Flooded farmland</dt><dd>${fmt(t.flooded_farmland_ha)} ha (${pct(share)})</dd>
      <dt>Farmland</dt><dd>${fmt(t.farmland_ha)} ha</dd>
      <dt>Rank in Bicol</dt><dd>${t.rank} of ${S.munis.features.length}</dd>` : ""}
      <div class="sec">Weather here, ${short(iso)} (NASA POWER)</div>
      <dt>Rain that day</dt><dd>${fmt(rainDay)} mm</dd>
      <dt>Rain since 10 Oct</dt><dd>${fmt(rainSum)} mm</dd>
      <dt>Kristine week, 20–26 Oct</dt><dd>${fmt(rainEvent)} mm</dd>
      <dt>Root-zone wetness</dt><dd>${fmt(soil, 2)}${soil >= 0.97 ? " (waterlogged)" : ""}</dd>
      ${sd != null ? `<dt>Distance to storm centre</dt><dd>${fmt(sd)} km</dd>` : ""}
      <div class="sec">LSTM, nearest grid cell</div>
      <dt>Forecast after 2 Nov</dt><dd>${h ? `${h.days_pred} of 7 days waterlogged` : "n/a"}</dd>
      <dt>What happened</dt><dd>${h ? `${h.days_actual} of 7 days` : "n/a"}</dd>
      <dt>If Kristine came again</dt><dd>${g ? `${g.days_waterlogged} of 7 days` : "n/a"}</dd>
    </dl>
    ${h ? `<div class="insp-chart"><canvas id="ch-insp"></canvas></div>` : ""}
    ${acts.length ? `<div class="kv"><div class="sec">What to do</div></div><ul class="actions">${acts.map((a, i) => `<li class="${i === 0 && share >= 0.15 ? "warn" : ""}">${esc(a)}</li>`).join("")}</ul>` : ""}`;
  const box = $("inspector");
  if (box.hidden) {
    const pt = map.project([lon, lat]), r = box.parentElement.getBoundingClientRect();
    box.hidden = false;
    const br = box.getBoundingClientRect();
    box.style.setProperty("--ox", `${Math.max(0, Math.min(100, ((pt.x + r.left - br.left) / br.width) * 100))}%`);
    box.style.setProperty("--oy", `${Math.max(0, Math.min(100, ((pt.y + r.top - br.top) / br.height) * 100))}%`);
    box.classList.remove("pop"); void box.offsetWidth; box.classList.add("pop");
  }
  if (h && window.Chart) {
    S.charts.insp?.destroy();
    const start = new Date(tl.lstm_hindcast.issued + "T00:00:00");
    const labels = h.pred.map((_, d) => { const x = new Date(start); x.setDate(x.getDate() + d); return `${x.getDate()} ${MONTHS[x.getMonth()]}`; });
    S.charts.insp = new Chart($("ch-insp"), { type: "line", data: { labels, datasets: [
      { data: h.pred, borderColor: GREEN, backgroundColor: GREEN, borderWidth: 2.5, tension: 0.3, pointRadius: 2 },
      { data: h.actual, borderColor: WATER, backgroundColor: WATER, borderDash: [4, 3], borderWidth: 2, tension: 0.3, pointRadius: 2 },
      { data: labels.map(() => 0.97), borderColor: STORM, borderWidth: 1, borderDash: [2, 3], pointRadius: 0 }] },
      options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { y: { suggestedMin: 0.75, max: 1, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } }, grid: { display: false } } } } });
  }
  icons();
}
function openTown(name, province) {
  const c = S.townCenters.find((x) => x.name === name && x.province === province); if (!c) return;
  document.querySelectorAll(".town").forEach((b) => b.classList.toggle("active", b.dataset.n === name && b.dataset.p === province));
  map.flyTo({ center: [c.lon, c.lat], zoom: 10.8, pitch: S.view3d ? 50 : 0, duration: 1500 });
  inspect(c.lon, c.lat);
  if (window.innerWidth <= 760) togglePanel(false);
}

// ---------------- simulation clock ----------------
function setTime(t, force) {
  if (!S.tl) return;
  S.t = Math.max(0, Math.min(N() - 0.001, t));
  const di = Math.floor(S.t), iso = dayISO(di);
  $("playhead").style.left = `${(S.t / N()) * 100}%`;
  $("scrub").setAttribute("aria-valuenow", String(di)); $("scrub").setAttribute("aria-valuetext", label(iso));
  updateStorm();
  if (di !== S.dayShown || force) {
    S.dayShown = di;
    $("sim-date").textContent = label(iso);
    $("sim-phase").textContent = iso < "2024-10-20" ? "Before the storm" : iso < "2024-10-22" ? "Outer rain bands reach Bicol" : iso < "2024-10-24" ? "Heaviest rain as Kristine passes north of Bicol" : iso < "2024-10-26" ? "Kristine crosses northern Luzon" : iso < "2024-11-02" ? "Floodwater spreads; no usable radar pass yet" : "Sentinel-1 flood map available";
    document.querySelectorAll("#bars i").forEach((b, i) => b.classList.toggle("past", i <= di));
    renderStats(di);
    renderEvents();
    updateGibs(iso);
    renderField();
    applyLayers();
    if (S.inspect && !S.playing) inspect(S.inspect.lon, S.inspect.lat);
  }
}
function updateStorm() {
  if (!S.ready || !stormMarker) return;
  const st = S.tl.storm, now = t0() + S.t * 86400000, times = st.map((p) => Date.parse(p.t));
  const tag = $("storm-tag"), el = stormMarker.getElement();
  const done = (pts) => ({ type: "FeatureCollection", features: pts.slice(1).map((p, i) => ({ type: "Feature", properties: { c: cat(pts[i].w).c }, geometry: { type: "LineString", coordinates: [[pts[i].lon, pts[i].lat], [p.lon, p.lat]] } })) });
  if (now < times[0] || now > times[times.length - 1]) {
    const before = now < times[0];
    el.style.opacity = before ? 0 : 0.4;
    if (tag) tag.textContent = before ? "" : "Kristine has left";
    if (!before) stormMarker.setLngLat([st[st.length - 1].lon, st[st.length - 1].lat]);
    map.getSource("track-done").setData(done(before ? [] : st.map((p) => ({ lon: p.lon, lat: p.lat, w: p.wind_kts }))));
    S.storm = { active: false };
    return;
  }
  let k = times.findIndex((x) => x > now); if (k <= 0) k = 1;
  const a = st[k - 1], b = st[k], f = (now - times[k - 1]) / (times[k] - times[k - 1]);
  const lon = a.lon + (b.lon - a.lon) * f, lat = a.lat + (b.lat - a.lat) * f, wind = Math.round(a.wind_kts + (b.wind_kts - a.wind_kts) * f), c = cat(wind);
  el.style.opacity = 1; el.style.setProperty("--sc", c.c);
  stormMarker.setLngLat([lon, lat]);
  if (tag) tag.textContent = `Kristine, ${wind} kt ${c.short}`;
  map.getSource("track-done").setData(done([...st.slice(0, k).map((p) => ({ lon: p.lon, lat: p.lat, w: p.wind_kts })), { lon, lat, w: wind }]));
  S.storm = { active: true, lon, lat, wind, cat: c };
}
function updateGibs(iso) {
  if (!S.ready || S.gibs === "none") return;
  const s = map.getSource(`gibs-${S.gibs}`);
  if (s && s._date !== iso) { s.setTiles([GIBS[S.gibs].url.replace("{date}", iso)]); s._date = iso; }
}
function regionDaily() {
  if (S._rd) return S._rd;
  return (S._rd = S.tl.days.map((_, d) => {
    const v = S.tl.rain_mm.map((r) => r[d] ?? 0);
    const mx = Math.max(...v);
    return { mean: v.reduce((a, b) => a + b, 0) / v.length, max: mx, imax: v.indexOf(mx) };
  }));
}
function renderStats(di) {
  const rd = regionDaily(), cum = rd.slice(0, di + 1).reduce((a, b) => a + b.mean, 0);
  const sat = S.tl.rootzone.filter((r) => (r[di] ?? 0) >= 0.97).length;
    if (!$("st-0")) $("sim-stats").innerHTML = [0, 1, 2, 3].map((i) => `<div><b id="st-${i}">0</b><span id="sl-${i}"></span></div>`).join("");
  countTo($("st-0"), rd[di].mean, 0, " mm"); $("sl-0").textContent = `Bicol rain that day (max ${fmt(rd[di].max)})`;
  countTo($("st-1"), cum, 0, " mm"); $("sl-1").textContent = "Bicol rain since 10 Oct";
  countTo($("st-2"), sat, 0, ` of ${S.tl.cells.length}`); $("sl-2").textContent = "grid cells waterlogged";
  if (S.storm?.active) countTo($("st-3"), S.storm.wind, 0, " kt"); else { cancelAnimationFrame($("st-3")._raf); $("st-3").textContent = "None"; delete $("st-3").dataset.v; }
  $("sl-3").textContent = "storm wind (NASA EONET)";
}
function buildTimeline() {
  const rd = regionDaily(), max = Math.max(...rd.map((d) => d.mean)), passes = new Set(S.tl.passes.filter((p) => p.used).map((p) => p.date));
  $("bars").innerHTML = S.tl.days.map((d, i) => `<i class="${d >= "2024-10-20" && d <= "2024-10-26" ? "storm" : ""}${passes.has(d) ? " pass" : ""}" style="height:${Math.max(4, (rd[i].mean / max) * 100)}%;--i:${i}" title="${short(d)}: ${fmt(rd[i].mean)} mm Bicol average"></i>`).join("");
  $("bars").classList.add("intro"); setTimeout(() => $("bars").classList.remove("intro"), 1400);
  $("days").innerHTML = S.tl.days.map((d, i) => (i % 4 === 0 || d === "2024-11-02" ? `<span style="left:${((i + 0.5) / N()) * 100}%">${short(d)}</span>` : "")).join("");
  $("ticks").innerHTML = S.events.map((e) => `<i style="left:${(e.t / N()) * 100}%;--c:${e.c}" title="${esc(short(dayISO(e.t)) + ": " + e.text)}"></i>`).join("");
  const scrub = $("scrub");
  let drag = false;
  const at = (e) => { const r = scrub.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * N(); };
  scrub.addEventListener("pointerdown", (e) => { drag = true; scrub.setPointerCapture(e.pointerId); pause(); setTime(at(e)); });
  scrub.addEventListener("pointermove", (e) => drag && setTime(at(e)));
  scrub.addEventListener("pointerup", () => { drag = false; setTime(S.t, true); });
  scrub.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); setTime(Math.floor(S.t) + 1.5); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setTime(Math.floor(S.t) - 0.5); }
  });
  $("btn-play").addEventListener("click", () => (S.playing ? pause() : play()));
  document.querySelectorAll("#speed button").forEach((b) => b.addEventListener("click", () => {
    S.speed = Number(b.dataset.speed); document.querySelectorAll("#speed button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, .scrub")) return;
    if (e.code === "Space" && !e.target.closest("button")) { e.preventDefault(); S.playing ? pause() : play(); }
  });
}
function play() {
  if (S.t >= N() - 0.05) setTime(0, true);
  S.playing = true; S.last = performance.now();
  $("btn-play").innerHTML = `<i data-lucide="pause"></i>`; $("btn-play").setAttribute("aria-label", "Pause"); $("btn-play").classList.add("on"); icons();
  const step = (now) => {
    if (!S.playing) return;
    const dt = Math.min(0.1, (now - S.last) / 1000); S.last = now;
    const before = dayISO(S.t);
    setTime(S.t + dt * 0.8 * S.speed);
    const after = dayISO(S.t);
    if (before !== after) { const p = S.tl.passes.find((x) => x.date === after); if (p) toast(p.label); }
    if (S.t >= N() - 0.01) { pause(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function pause() {
  if (!S.playing && $("btn-play").getAttribute("aria-label") === "Play") return;
  S.playing = false; $("btn-play").classList.remove("on"); $("btn-play").innerHTML = `<i data-lucide="play"></i>`; $("btn-play").setAttribute("aria-label", "Play"); icons();
}

// ---------------- events ----------------
function buildEvents() {
  const ev = [], st = S.tl.storm, rd = regionDaily();
  if (st.length) {
    ev.push({ t: tAt(st[0].t), c: STORM, at: st[0], text: `NASA EONET starts tracking Kristine (Trami) east of Samar, ${st[0].wind_kts} kt.` });
    const ci = st.reduce((m, p, i) => (km(p, NAGA) < km(st[m], NAGA) ? i : m), 0);
    ev.push({ t: tAt(st[ci].t), c: STORM, at: st[ci], text: `Closest pass: the storm centre is ${fmt(km(st[ci], NAGA))} km north of Naga City, ${st[ci].wind_kts} kt. Bicol's rain comes from the storm's southern bands.` });
    const land = st.findIndex((p) => p.lon < 122.3 && p.lat > 16.5);
    if (land > 0) ev.push({ t: tAt(st[land].t), c: STORM, at: st[land], text: `Kristine crosses northern Luzon (Isabela), ${st[land].wind_kts} kt.` });
    const mi = st.reduce((m, p, i) => (p.wind_kts > st[m].wind_kts ? i : m), 0);
    ev.push({ t: tAt(st[mi].t), c: STORM, at: st[mi], text: `Peak wind in the track: ${st[mi].wind_kts} kt (${cat(st[mi].wind_kts).name}) over the West Philippine Sea.` });
  }
  rd.forEach((d, i) => {
    if (d.max >= 120) {
      const c = S.tl.cells[d.imax], town = nearestTown(c.lon, c.lat);
      ev.push({ t: i + 0.5, c: WATER, at: town || c, text: `${fmt(d.max)} mm of rain in one day near ${town ? `${town.name}, ${town.province}` : "Bicol"}. Bicol average ${fmt(d.mean)} mm.` });
    }
  });
  const half = S.tl.cells.length / 2;
  let wasSat = false;
  S.tl.days.forEach((_, d) => {
    const sat = S.tl.rootzone.filter((r) => (r[d] ?? 0) >= 0.97).length >= half;
    if (sat && !wasSat) ev.push({ t: d + 0.6, c: WATER_DARK, text: "Root-zone soil is waterlogged in more than half of the grid cells." });
    if (!sat && wasSat) ev.push({ t: d + 0.6, c: GREEN, text: "Soil starts to drain: fewer than half of the grid cells are waterlogged." });
    wasSat = sat;
  });
  S.tl.passes.forEach((p) => ev.push({ t: tAt(p.date) + 0.75, c: p.used ? GREEN : "#9aa59f", text: p.label + "." }));
  if (S.summary) {
    const top = S.summary.top_municipalities[0];
    ev.push({ t: tAt("2024-11-02") + 0.8, c: WATER_DARK, at: S.townCenters.find((x) => x.name === top.name),
      text: `Flood map: ${fmt(S.summary.flooded_farmland_ha)} ha of Bicol farmland under water. Worst: ${top.name} (${fmt(top.flooded_farmland_ha)} ha).` });
  }
  const h = S.tl.lstm_hindcast;
  if (h) {
    const v = h.cells.filter(Boolean), ok = v.filter((c) => Math.abs(c.days_pred - c.days_actual) <= 1).length;
    ev.push({ t: tAt(h.issued) + 0.5, c: "#7a4cc2", text: `LSTM 7-day forecast for every grid cell: waterlogged days right within 1 day in ${ok} of ${v.length} cells.` });
  }
  S.events = ev.sort((a, b) => a.t - b.t);
}
function renderEvents() {
  const now = S.t;
  $("events").innerHTML = S.events.map((e, i) => `<li class="${e.t > now + 0.001 ? "future" : now - e.t < 1 ? "now" : ""}"><button type="button" data-i="${i}" style="--c:${e.c}"><span><time>${short(dayISO(e.t))}</time><p>${esc(e.text)}</p></span></button></li>`).join("");
  $("events").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const e = S.events[Number(b.dataset.i)]; pause(); setTime(e.t + 0.001, true);
    if (e.at) map.flyTo({ center: [e.at.lon, e.at.lat], zoom: Math.min(map.getZoom(), e.c === STORM ? 5.6 : 8.5), duration: 1200 });
  }));
}

// ---------------- motion helpers ----------------
// sliding pill behind the pressed button of every segmented control
function initSegs() {
  document.querySelectorAll(".seg").forEach((seg) => {
    const pill = document.createElement("span"); pill.className = "seg-pill"; pill.setAttribute("aria-hidden", "true"); seg.prepend(pill);
    const place = () => { const b = seg.querySelector('button[aria-pressed="true"]'); if (!b || !b.offsetWidth) return; pill.style.width = `${b.offsetWidth}px`; pill.style.height = `${b.offsetHeight}px`; pill.style.top = `${b.offsetTop}px`; pill.style.transform = `translateX(${b.offsetLeft}px)`; };
    new MutationObserver(place).observe(seg, { attributes: true, subtree: true, attributeFilter: ["aria-pressed"] });
    requestAnimationFrame(place); window.addEventListener("resize", place); seg._place = place;
  });
}
// numbers ease to their new value (count-up)
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function countTo(el, to, decimals = 0, suffix = "") {
  if (!el) return;
  const from = Number(el.dataset.v ?? to); el.dataset.v = to;
  cancelAnimationFrame(el._raf);
  if (reduceMotion || from === to || !isFinite(from)) { el.textContent = fmt(to, decimals) + suffix; return; }
  const start = performance.now(), dur = 420;
  const tick = (now) => { const k = Math.min(1, (now - start) / dur), e = 1 - (1 - k) ** 3; el.textContent = fmt(from + (to - from) * e, decimals) + suffix; if (k < 1) el._raf = requestAnimationFrame(tick); };
  el._raf = requestAnimationFrame(tick);
}

// ---------------- side panel ----------------
function bindChrome() {
  initSegs();
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    const tabs = [...document.querySelectorAll(".tabs button")];
    tabs.forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    document.querySelector(".tab-ind").style.transform = `translateX(${tabs.indexOf(b) * 100}%)`;
    document.querySelectorAll(".tab-body").forEach((s) => { s.hidden = s.id !== `tab-${b.dataset.tab}`; s.classList.remove("enter"); });
    const body = $(`tab-${b.dataset.tab}`); void body.offsetWidth; body.classList.add("enter");
    document.querySelectorAll("#tab-forecast .seg").forEach((sg) => sg._place?.());
    if (window.innerWidth <= 760) togglePanel(true);
    S.charts.ai?.resize();
  }));
  $("btn-panel").addEventListener("click", () => togglePanel());
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    S.view3d = b.dataset.view === "3d";
    document.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    map.easeTo({ pitch: S.view3d ? 45 : 0, bearing: S.view3d ? map.getBearing() : 0, duration: 800 });
    applyLayers();
  }));
  $("btn-fit-bicol").addEventListener("click", () => map.fitBounds([[R.w, R.s], [R.e, R.n]], { padding: chromePadding(), pitch: S.view3d ? 30 : 0, bearing: 0, duration: 1200 }));
  $("btn-fit-storm").addEventListener("click", () => {
    const st = S.tl.storm, lons = [...st.map((p) => p.lon), R.w, R.e], lats = [...st.map((p) => p.lat), R.s, R.n];
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: chromePadding(), pitch: 0, bearing: 0, duration: 1400 });
  });
  $("btn-shot").addEventListener("click", () => {
    try {
      const a = document.createElement("a"); a.download = `sakasar-bicol-${dayISO(S.t)}.png`; a.href = map.getCanvas().toDataURL("image/png"); a.click();
      toast("Map image saved.");
    } catch (_) { toast("This browser blocked the image export."); }
  });
  $("btn-link").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link to this view copied."); } catch (_) { toast("Copy the address bar to share this view."); }
  });
  $("insp-close").addEventListener("click", () => { $("inspector").hidden = true; pinMarker?.remove(); S.inspect = null; map.setFilter("towns-active", ["==", ["get", "name"], ""]); });
  // drag the inspector by its header
  const box = $("inspector"), head = box.querySelector(".insp-head");
  let sx, sy, ox, oy, on = false;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || window.innerWidth <= 760) return;
    on = true; head.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = box.offsetLeft; oy = box.offsetTop;
  });
  head.addEventListener("pointermove", (e) => {
    if (!on) return;
    const p = box.parentElement;
    box.style.left = `${Math.max(0, Math.min(p.clientWidth - box.offsetWidth, ox + e.clientX - sx))}px`;
    box.style.top = `${Math.max(0, Math.min(p.clientHeight - 60, oy + e.clientY - sy))}px`; box.style.right = "auto";
  });
  head.addEventListener("pointerup", () => (on = false));
  window.addEventListener("resize", () => map?.resize());
}
function chromePadding() {
  const phone = window.innerWidth <= 760, open = !$("app").classList.contains("no-panel");
  return phone ? { top: 60, bottom: 100, left: 10, right: 10 } : { top: 70, bottom: 130, left: open ? 370 : 20, right: 60 };
}
function togglePanel(force) {
  const app = $("app"), show = force ?? app.classList.contains("no-panel");
  app.classList.toggle("no-panel", !show);
  $("btn-panel").setAttribute("aria-expanded", String(show));
  if (map && S.ready) map.easeTo({ padding: chromePadding(), duration: 380 });
}

function rampCSS(field) {
  const L = lut(field);
  return `linear-gradient(90deg,${Array.from({ length: 7 }, (_, k) => { const j = Math.round((k / 6) * 255) * 4; return `rgba(${L[j]},${L[j + 1]},${L[j + 2]},${Math.max(0.12, L[j + 3] / 255)}) ${(k / 6) * 100}%`; }).join(",")})`;
}
function renderLayers() {
  const tile = (tiles) => tiles[0].replace("{z}", "6").replace("{x}", "54").replace("{y}", "29");
  const toggle = (k, title, sub) => `<label class="toggle"><span><b>${title}</b><small>${sub}</small></span><input type="checkbox" data-layer="${k}" ${S.layers[k] ? "checked" : ""} /><span class="switch" aria-hidden="true"></span></label>`;
  const slider = (id, label, min, max, step, val, out) => `<div class="slider-row"><label for="${id}">${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" /><output id="${id}-v">${out}</output></div>`;
  const closest = Math.min(...S.tl.storm.map((p) => km(p, NAGA)));
  const gibsNote = () => (S.gibs === "none" ? "From NASA GIBS, for the date on the timeline." : GIBS[S.gibs].sub);
  $("tab-layers").innerHTML = `
    <p class="h">Heatmap</p>
    <div class="fields" role="radiogroup" aria-label="Heatmap">
      ${Object.entries(FIELDS).map(([k, f]) => `<button type="button" class="field-opt" role="radio" data-field="${k}" aria-checked="${k === S.field}">
        <span class="sw ${k === "none" ? "none" : ""}" style="${k === "none" ? "" : `background:${rampCSS(k)}`}"></span>
        <span><b>${f.name}</b><small>${f.sub || "Show the map without a heatmap"}</small></span></button>`).join("")}
    </div>
    ${slider("field-op", "Opacity", 0.2, 1, 0.05, S.fieldOpacity, `${Math.round(S.fieldOpacity * 100)}%`)}
    <p class="h">Flood, Sentinel-1 radar (from 2 Nov)</p>
    ${toggle("hotspots", "Flood hotspots", "Density of flooded farmland; fades as you zoom in")}
    ${toggle("flood", "Flooded farmland, 100 m", "Water on farmland, from zoom 9")}
    ${toggle("towns", "Towns", "Boundaries, shaded by share of farmland flooded")}
    <p class="h">Storm</p>
    ${toggle("storm", "Kristine's track", "NASA EONET every 6 hours, PAGASA colours")}
    <p class="callout"><i data-lucide="info"></i><span>Kristine's centre crossed northern Luzon, ${fmt(closest)} km north of Naga at its closest. Bicol flooded from the storm's southern rain bands: pick <b>Rain that day</b> and press play.</span></p>
    <p class="h">NASA satellite image of the day</p>
    <div class="chips" role="group" aria-label="NASA GIBS image">
      <button type="button" class="chip" data-gibs="none" aria-pressed="${S.gibs === "none"}">Off</button>
      ${Object.entries(GIBS).map(([k, g]) => `<button type="button" class="chip" data-gibs="${k}" aria-pressed="${S.gibs === k}">${g.name.replace(" true colour", "").replace(" rain rate", " rain").replace(" soil moisture", " soil")}</button>`).join("")}
    </div>
    <p class="note chip-note" id="gibs-note">${gibsNote()}</p>
    <p class="h">Base map</p>
    <div class="basemaps">${Object.entries(BASEMAPS).map(([k, b]) => `<button type="button" class="bm" data-bm="${k}" aria-pressed="${S.basemap === k}" style="background-image:url('${tile(b.tiles)}')"><span>${b.name}</span></button>`).join("")}</div>
    <p class="h">Terrain</p>
    ${toggle("terrain", "3D terrain", "Elevation from AWS Terrain Tiles, in 3D view")}
    ${slider("exag", "Height", 1, 4, 0.1, 1.8, "1.8×")}
    ${toggle("hillshade", "Hillshade", "Shaded relief")}`;
  const tab = $("tab-layers");
  tab.querySelectorAll(".field-opt").forEach((b) => b.addEventListener("click", () => setField(b.dataset.field)));
  tab.querySelectorAll("[data-gibs]").forEach((b) => b.addEventListener("click", () => {
    S.gibs = b.dataset.gibs;
    tab.querySelectorAll("[data-gibs]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("gibs-note").textContent = gibsNote();
    if (S.gibs !== "none" && S.ready) { map.getSource(`gibs-${S.gibs}`)._date = null; updateGibs(dayISO(S.t)); }
    applyLayers();
  }));
  tab.querySelectorAll("[data-bm]").forEach((b) => b.addEventListener("click", () => {
    tab.querySelectorAll("[data-bm]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    setBasemap(b.dataset.bm);
  }));
  tab.querySelectorAll("input[data-layer]").forEach((i) => i.addEventListener("change", () => { S.layers[i.dataset.layer] = i.checked; applyLayers(); }));
  const fillRange = (el) => el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
  tab.querySelectorAll('input[type="range"]').forEach(fillRange);
  $("field-op").addEventListener("input", (e) => { fillRange(e.target); S.fieldOpacity = Number(e.target.value); $("field-op-v").textContent = `${Math.round(S.fieldOpacity * 100)}%`; if (S.ready) map.setPaintProperty("field", "raster-opacity", fieldOp()); });
  $("exag").addEventListener("input", (e) => { fillRange(e.target); $("exag-v").textContent = `${Number(e.target.value).toFixed(1)}×`; applyLayers(); });
}
function setField(k) {
  S.field = k; document.querySelectorAll(".field-opt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.field === k)));
  renderField(); renderLegend();
}

function renderLegend() {
  const parts = [];
  if (S.field !== "none") {
    const f = FIELDS[S.field], L = lut(S.field);
    const grad = Array.from({ length: 9 }, (_, k) => { const j = Math.round((k / 8) * 255) * 4; return `rgba(${L[j]},${L[j + 1]},${L[j + 2]},${Math.max(0.15, L[j + 3] / 255)}) ${(k / 8) * 100}%`; }).join(",");
    const extra = S.field === "lstm" ? (S.aiMode === "hind" ? "Forecast issued 3 Nov 2024" : "Kristine's rain on today's soil") : `${short(dayISO(S.t))}`;
    parts.push(`<div><b>${f.name}${f.unit ? ` (${f.unit})` : ""}</b><small>${extra}</small><div class="ramp" style="background:linear-gradient(90deg,${grad})"></div><div class="ticks-row">${f.ticks.map((t) => `<span>${t}</span>`).join("")}</div></div>`);
  }
  const after = dayISO(S.t) >= "2024-11-02";
  if (after && (S.layers.flood || S.layers.hotspots || S.layers.towns)) {
    parts.push(`<div><b>Flood, Sentinel-1 2 Nov</b><div class="sw">${S.layers.hotspots ? `<span><i style="background:linear-gradient(90deg,#ffe882,#ffb000,#ff5a1f,#be0028)"></i>Hotspot density</span>` : ""}${S.layers.flood ? `<span><i style="background:#4ec4de"></i>Flooded farmland</span><span><i style="background:#e9e4c9"></i>Farmland</span>` : ""}${S.layers.towns ? `<span><i style="background:rgba(27,95,168,0.5)"></i>Town share flooded</span>` : ""}</div></div>`);
  }
  if (S.layers.storm) parts.push(`<div><b>Kristine, PAGASA category</b><div class="sw">${CATS.map((c) => `<span><i style="background:${c.c}"></i>${c.short}</span>`).join("")}</div></div>`);
  $("legend").innerHTML = parts.join("");
}

// ---------------- towns ----------------
function renderTowns() {
  const s = S.summary, towns = S.munis.features.map((f) => f.properties).sort((a, b) => a.rank - b.rank);
  const affected = towns.filter((t) => t.flooded_farmland_ha >= 1).length;
  $("summary").innerHTML = s ? `
    <div class="big"><b><i id="sum-ha" style="font-style:normal">0</i><small>ha</small></b><span>farmland under water on 2 Nov 2024 (Sentinel-1, 100 m, both orbits)</span></div>
    <div><b>${affected} of ${towns.length}</b><span>towns with flooded farmland</span></div>
    <div><b>${pct(s.flooded_farmland_ha / s.farmland_ha)}</b><span>of ${fmt(s.farmland_ha)} ha farmland</span></div>` : "";
  if (s) { $("sum-ha").dataset.v = 0; countTo($("sum-ha"), s.flooded_farmland_ha); }
  const pmax = Math.max(...(s?.provinces || []).map((p) => p.flooded_farmland_ha), 1);
  $("provinces").innerHTML = (s?.provinces || []).slice().sort((a, b) => b.flooded_farmland_ha - a.flooded_farmland_ha)
    .map((p) => `<li><span>${esc(p.province)}</span><span class="bar"><i style="width:${(100 * p.flooded_farmland_ha) / pmax}%"></i></span><span class="v">${fmt(p.flooded_farmland_ha)} ha</span></li>`).join("");
  const list = (q) => {
    const query = (q || "").trim().toLowerCase();
    const rows = towns.filter((t) => !query || t.name.toLowerCase().includes(query) || t.province.toLowerCase().includes(query)).slice(0, query ? 60 : 30);
    $("towns").innerHTML = rows.map((t) => `<li><button type="button" class="town" data-n="${esc(t.name)}" data-p="${esc(t.province)}">
      <span class="rk">${t.rank}</span><span><b>${esc(t.name)}</b><small>${esc(t.province)}</small></span>
      <span class="val">${fmt(t.flooded_farmland_ha)} ha<small>${pct(t.flooded_share)} of farmland</small></span></button></li>`).join("") || `<li class="note">No town matches “${esc(q)}”.</li>`;
    $("towns").querySelectorAll(".town").forEach((b) => b.addEventListener("click", () => openTown(b.dataset.n, b.dataset.p)));
  };
  list("");
  $("town-search").addEventListener("input", (e) => list(e.target.value));
  $("btn-csv").addEventListener("click", () => {
    const head = "rank,town,province,farmland_ha,flooded_farmland_ha,flooded_share,radar";
    const rows = towns.map((t) => [t.rank, t.name, t.province, t.farmland_ha, t.flooded_farmland_ha, t.flooded_share, t.sentinel1].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
    const a = document.createElement("a"); a.download = "sakasar-bicol-towns-flooded-farmland.csv";
    a.href = URL.createObjectURL(new Blob([head + "\n" + rows.join("\n")], { type: "text/csv" })); a.click();
  });
}

// ---------------- LSTM ----------------
function lstmValue(i) {
  if (S.aiMode === "hind") { const c = S.tl.lstm_hindcast?.cells?.[i]; return c ? c.days_pred : NaN; }
  const c = S.tl.lstm_kristine_again?.cells?.[i]; return c ? c.days_waterlogged : NaN;
}
function renderAI() {
  const tl = S.tl, hind = tl.lstm_hindcast, again = tl.lstm_kristine_again;
  document.querySelectorAll("#ai-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ai === S.aiMode)));
  let labels = [], ds = [];
  if (S.aiMode === "hind" && hind) {
    const v = hind.cells.filter(Boolean), ok = v.filter((c) => Math.abs(c.days_pred - c.days_actual) <= 1).length;
    const avg = (k) => Array.from({ length: 7 }, (_, d) => v.reduce((a, c) => a + (c[k][d] ?? 0), 0) / v.length);
    const start = new Date(hind.issued + "T00:00:00");
    labels = Array.from({ length: 7 }, (_, d) => { const x = new Date(start); x.setDate(x.getDate() + d); return `${x.getDate()} ${MONTHS[x.getMonth()]}`; });
    ds = [{ data: avg("pred"), borderColor: GREEN, backgroundColor: GREEN, tension: 0.3, borderWidth: 3 }, { data: avg("actual"), borderColor: WATER, backgroundColor: WATER, borderDash: [5, 4], tension: 0.3, borderWidth: 2 }];
    $("ai-lead").innerHTML = `Forecast issued <strong>3 Nov 2024</strong>, the day after the radar pass. Across Bicol the number of waterlogged days was right within 1 day in <strong>${ok} of ${v.length}</strong> grid cells.`;
    $("ai-key").innerHTML = `<span><i style="background:${GREEN}"></i>LSTM forecast, Bicol average</span><span><i style="background:${WATER}"></i>What happened</span><span><i style="background:${STORM}"></i>Waterlogged (0.97)</span>`;
    $("ai-hint").textContent = "Click anywhere on the map to see the forecast for that spot.";
  } else if (again) {
    const v = again.cells.filter(Boolean), wet = v.filter((c) => c.days_waterlogged > 0).length;
    labels = Array.from({ length: 7 }, (_, d) => `Day ${d + 1}`);
    ds = [{ data: Array.from({ length: 7 }, (_, d) => v.reduce((a, c) => a + c.pred[d], 0) / v.length), borderColor: STORM, backgroundColor: "rgba(226,83,60,0.12)", fill: true, tension: 0.3, borderWidth: 3 }];
    $("ai-lead").innerHTML = `If Kristine's week of rain fell again on today's soil (NASA POWER, ${esc(again.soil_as_of)}), roots would be waterlogged in <strong>${wet} of ${v.length}</strong> grid cells. Soil is drier now than in October 2024.`;
    $("ai-key").innerHTML = `<span><i style="background:${STORM}"></i>Root zone, Bicol average</span><span><i style="background:${STORM};opacity:.5"></i>Waterlogged (0.97)</span>`;
    $("ai-hint").textContent = "Each grid cell gets its own Kristine-week rain from October 2024.";
  }
  const data = { labels, datasets: [...ds, { data: labels.map(() => 0.97), borderColor: STORM, borderWidth: 1, pointRadius: 0, borderDash: [3, 3] }] };
  if (S.charts.ai) { S.charts.ai.data = data; S.charts.ai.update(); }
  else if (window.Chart) S.charts.ai = new Chart($("ch-ai"), { type: "line", data, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { suggestedMin: 0.75, max: 1, grid: { color: "#eef3f0" } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });
  if (!renderAI.bound) {
    renderAI.bound = true;
    document.querySelectorAll("#ai-seg button").forEach((b) => b.addEventListener("click", () => { S.aiMode = b.dataset.ai; renderAI(); if (S.field === "lstm") { renderField(); renderLegend(); } }));
    $("btn-ai-map").addEventListener("click", () => setField("lstm"));
  }
}

init();
