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
  soilnow: { name: "Soil wetness now", sub: "NASA POWER root zone on the latest available day: dry, moist, wet, waterlogged (0.97+)", unit: "", min: 0.55, max: 1,
    stops: [[0.55, [214, 130, 50, 185]], [0.68, [236, 190, 90, 175]], [0.78, [120, 190, 110, 175]], [0.9, [52, 160, 200, 195]], [0.97, [27, 95, 168, 220]], [1, [16, 50, 120, 230]]], ticks: ["dry", "moist", "wet", "full"] },
  ready: { name: "Storm readiness", sub: "Days roots would stay waterlogged if a Kristine-size storm hit now (soil forecast from today's soil)", unit: "days", min: 0, max: 7,
    stops: [[0, [124, 198, 154, 120]], [1, [255, 236, 170, 150]], [3, [238, 159, 39, 180]], [5, [226, 83, 60, 205]], [7, [140, 20, 20, 225]]], ticks: [0, 2, 4, 7] },
  lstm: { name: "Forecast waterlogged days", sub: "Days out of the next 7 with the root zone at 0.97+ (soil forecast)", unit: "days", min: 0, max: 7,
    stops: [[0, [255, 255, 255, 0]], [0.5, [255, 236, 170, 120]], [2, [238, 159, 39, 170]], [4, [226, 83, 60, 200]], [7, [140, 20, 20, 225]]], ticks: [0, 2, 4, 7] },
};

const S = {
  tl: null, munis: null, summary: null, overlay: null,
  t: 23, playing: false, speed: 1, last: 0, dayShown: -1,
  field: "soilnow", fieldOpacity: 0.8, basemap: "sat", gibs: "none", view3d: true,
  layers: { hotspots: true, flood: true, towns: true, storm: true, terrain: true, hillshade: true, pilot: true, sarchange: false, runoff: true, streams: true, brisk: true },
  pilot: null, plot: "PL-02", priority: "water", story: 0, mode: "now", pgrid: null, pgLayer: "cls",
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
// The day axis is Philippine time (UTC+8): NASA POWER days and farmers' calendars are local; EONET fixes are UTC.
const t0 = () => Date.parse(S.tl.days[0] + "T00:00:00+08:00");
const tAt = (iso) => (Date.parse(iso.length > 10 ? iso : iso + "T00:00:00+08:00") - t0()) / 86400000;
const phDay = (utc) => new Date(Date.parse(utc) + 8 * 3600000).toISOString().slice(0, 10);
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
function closestPass(st, P) {
  const k = Math.cos((P.lat * Math.PI) / 180) * 111.32, kl = 110.57;
  let best = { km: Infinity };
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1], b = st[i];
    const ax = (a.lon - P.lon) * k, ay = (a.lat - P.lat) * kl, bx = (b.lon - P.lon) * k, by = (b.lat - P.lat) * kl;
    const dx = bx - ax, dy = by - ay, f = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    const lon = a.lon + (b.lon - a.lon) * f, lat = a.lat + (b.lat - a.lat) * f, d = km({ lon, lat }, P);
    if (d < best.km) best = { km: d, lon, lat, wind: Math.round(a.wind_kts + (b.wind_kts - a.wind_kts) * f), t: new Date(Date.parse(a.t) + (Date.parse(b.t) - Date.parse(a.t)) * f).toISOString() };
  }
  return best;
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
  if ($("splash")) $("brand-logo").style.opacity = 0;
  const [tl, munis, summary, overlay, pilot, streams] = await Promise.all([
    fetchJSON("data/region/bicol_timeline.json"), fetchJSON("data/region/bicol_municipalities.geojson"),
    fetchJSON("data/region/bicol_summary.json"), fetchJSON("data/region/bicol_flood.json"), fetchJSON("mock-data.json"),
    fetchJSON("data/region/bicol_streams.geojson"),
  ]);
  if (!tl || !munis) { toast("Could not load the Bicol data files. Run the API from the project folder."); return; }
  Object.assign(S, { tl, munis, summary, overlay, streamsGJ: streams });
  S.pilot = pilot && pilot.plots ? pilot : null;
  // secondary layers load in the background, after the core data exist
  fetchJSON("data/region/pilot_grids.json").then((g) => { S.pgrid = g; renderPilotGrid(); });
  fetchJSON("data/region/bicol_runoff.json").then((r) => { S.runoff = r; loadRunoff(); renderData(); });
  fetchJSON("data/region/bicol_flowdir.json").then((f) => f && loadFlow(f));
  fetchJSON("data/region/bicol_risk.json").then((r) => { if (r) { S.brisk = r; loadBicolRisk(); } });
  fetchJSON("data/region/benchmarks.json").then((b) => { S.bench = b; renderData(); renderAI(); });
  S.t = Math.max(0, tl.days.indexOf("2024-11-02")) + 0.5;
  S.townCenters = munis.features.map((f) => {
    let x = 0, y = 0, n = 0;
    const walk = (k) => { if (typeof k[0] === "number") { x += k[0]; y += k[1]; n++; } else k.forEach(walk); };
    walk(f.geometry.coordinates);
    return { name: f.properties.name, province: f.properties.province, lon: x / n, lat: y / n };
  });
  prepareGrid();
  S.closest = closestPass(tl.storm, NAGA);
  introPlay();
  if (window.Chart) { Chart.defaults.font.family = "Geist, system-ui, sans-serif"; Chart.defaults.color = "#5f7468"; }
  buildEvents();
  bindChrome();
  renderLayers();
  renderTowns();
  renderAI();
  renderFields();
  renderData();
  bindStory();
  bindDraw();
  bindModes();
  buildWindows();
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
    if (field === "soilnow") { const c = tl.lstm_kristine_again?.cells?.[i]; return c?.today ?? NaN; }
    if (field === "ready") { const c = tl.lstm_kristine_again?.cells?.[i]; return c ? c.days_waterlogged : NaN; }
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
    R.hot = feats;
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
      glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
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
    ...(location.hash.includes("view=") ? {} : { center: [124.6, 12.6], zoom: 4.3, pitch: 0, bearing: 0 }),
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-right");
  map.once("style.load", () => { map.setPadding(chromePadding()); addLayers(); S.ready = true; applyLayers(); setTime(S.t, true); renderPilotGrid(); finishIntro(); });
  setTimeout(finishIntro, 5000); // never keep the intro up if tiles are slow
  loadFloodPixels();
  // when our browser-made tiles arrive, the 3D terrain must re-drape them (it caches each tile's layers)
  let rttQueued = false;
  map.on("sourcedata", (e) => {
    if ((e.sourceId === "field" || e.sourceId === "flood" || e.sourceId === "pgrid" || e.sourceId === "runoff" || e.sourceId === "brisk" || e.sourceId === "base" || String(e.sourceId).startsWith("gibs-")) && e.tile && !rttQueued) {
      rttQueued = true;
      requestAnimationFrame(() => { rttQueued = false; map.terrain?.sourceCache?.freeRtt?.(); map.triggerRepaint(); });
    }
  });
  map.on("dblclick", (e) => { if (S.draw?.on) { e.preventDefault(); drawFinish(); } });
  map.on("mousemove", onHover);
  map.on("mouseout", () => { $("readout").innerHTML = "Move over the map to read values"; hoverPopup?.remove(); });
  map.on("click", (e) => {
    if (S.draw?.on) { drawAdd(e.lngLat); return; }
    const hit = S.ready && map.getLayer("plots-fill") && S.layers.pilot ? map.queryRenderedFeatures(e.point, { layers: ["plots-fill"] }) : [];
    if (hit.length) { selectPlot(hit[0].properties.plot_id, true); return; }
    inspect(e.lngLat.lng, e.lngLat.lat);
  });
}

function addLayers() {
  Object.entries(GIBS).forEach(([k, g]) => {
    map.addSource(`gibs-${k}`, { type: "raster", tileSize: 256, maxzoom: g.max, tiles: [g.url.replace("{date}", dayISO(S.t))], attribution: "NASA GIBS" });
    map.addLayer({ id: `gibs-${k}`, type: "raster", source: `gibs-${k}`, paint: { "raster-opacity": k === "imerg" || k === "smap" ? 0.8 : 1 }, layout: { visibility: "none" } });
  });

  map.addSource("munis", { type: "geojson", data: S.munis, promoteId: "rank" });
  map.addLayer({ id: "towns-fill", type: "fill", source: "munis",
    paint: { "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 1, 10, 0], "fill-color": ["interpolate", ["linear"], ["get", "flooded_share"], 0, "rgba(47,159,211,0)", 0.01, "rgba(47,159,211,0.12)", 0.05, "rgba(47,159,211,0.3)", 0.15, "rgba(27,95,168,0.45)", 0.3, "rgba(16,50,120,0.6)"] } });
  map.addLayer({ id: "towns-line", type: "line", source: "munis", paint: { "line-color": "rgba(255,255,255,0.75)", "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.3, 9, 0.6, 11, 0.9], "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 11, 1.4] } });
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
    map.addLayer({ id: "flood", type: "raster", source: "flood", minzoom: 8.5, maxzoom: 12.2, paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 0, 9.5, 1], "raster-fade-duration": 0, "raster-resampling": "nearest" } });
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
  const cp = S.closest;
  map.addSource("closest", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [[NAGA.lon, NAGA.lat], [cp.lon, cp.lat]] } } });
  map.addLayer({ id: "closest", type: "line", source: "closest", paint: { "line-color": "#fff", "line-width": 1.5, "line-dasharray": [3, 2] } });

  S.trackLabels = st.filter((p) => p.t.endsWith("T00:00:00Z")).map((p) => {
    const el = document.createElement("div"); el.className = "track-label";
    el.innerHTML = `<b>${short(phDay(p.t))}</b> ${p.wind_kts} kt`;
    return new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat([p.lon, p.lat]).addTo(map);
  });
  const mid = { lon: (NAGA.lon + cp.lon) / 2, lat: (NAGA.lat + cp.lat) / 2 };
  const ref = document.createElement("div"); ref.className = "ref-label";
  ref.textContent = `Closest pass ${fmt(cp.km)} km from Naga, ${short(phDay(cp.t))}`;
  S.refLabel = new maplibregl.Marker({ element: ref }).setLngLat([mid.lon, mid.lat]).addTo(map);
  const naga = document.createElement("div"); naga.className = "ref-dot"; naga.title = "Naga City";
  S.nagaLabel = new maplibregl.Marker({ element: naga }).setLngLat([NAGA.lon, NAGA.lat]).addTo(map);

  const el = document.createElement("div");
  el.className = "storm-marker";
  el.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="2.5"/><path d="M12 4c-4 0-7 2-8 5"/><path d="M12 20c4 0 7-2 8-5"/><path d="M4 12c0 4 2 7 5 8"/><path d="M20 12c0-4-2-7-5-8"/></svg><span class="storm-tag" id="storm-tag"></span>`;
  stormMarker = new maplibregl.Marker({ element: el }).setLngLat([st[0].lon, st[0].lat]).addTo(map);

  addPilotLayers();
  addLabels();

  let hovered = null;
  map.on("mousemove", "towns-fill", (e) => {
    const f = e.features[0];
    if (hovered !== null) map.setFeatureState({ source: "munis", id: hovered }, { hover: false });
    hovered = f.id; map.setFeatureState({ source: "munis", id: hovered }, { hover: true });
    map.getCanvas().style.cursor = "crosshair";
  });
  hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "town-pop" });
  map.on("mousemove", "towns-fill", (e) => {
    const p = e.features[0].properties;
    if (dayISO(S.t) < "2024-11-02") { hoverPopup.remove(); return; }
    hoverPopup.setLngLat(e.lngLat).setHTML(`<b>${esc(p.name)}</b>, ${esc(p.province)}<br>${fmt(p.flooded_farmland_ha)} ha flooded farmland (${pct(p.flooded_share)})<br><small>Sentinel-1 ${esc(p.sentinel1)}</small>`).addTo(map);
  });
  map.on("mouseleave", "towns-fill", () => hoverPopup.remove());
  map.on("movestart", () => hoverPopup.remove()); // never leave a stale card behind while the camera flies
  map.on("mouseleave", "towns-fill", () => { if (hovered !== null) map.setFeatureState({ source: "munis", id: hovered }, { hover: false }); hovered = null; map.getCanvas().style.cursor = ""; });
}

// heatmaps are ~50 km data: fade them as you zoom into fields so the satellite and radar layers show
const fieldOp = () => ["interpolate", ["linear"], ["zoom"], 8.5, S.fieldOpacity, 11, S.fieldOpacity * 0.2];
function addLabels() {
  const provs = {};
  S.townCenters.forEach((c) => { const q = (provs[c.province] = provs[c.province] || { x: 0, y: 0, n: 0 }); q.x += c.lon; q.y += c.lat; q.n++; });
  map.addSource("prov-labels", { type: "geojson", data: { type: "FeatureCollection", features: Object.entries(provs).map(([name, q]) => ({ type: "Feature", properties: { name }, geometry: { type: "Point", coordinates: [q.x / q.n, q.y / q.n] } })) } });
  map.addSource("town-labels", { type: "geojson", data: { type: "FeatureCollection", features: S.munis.features.map((f) => { const c = S.townCenters.find((x) => x.name === f.properties.name && x.province === f.properties.province);
    return { type: "Feature", properties: { name: f.properties.name.replace(/^City of /, ""), rank: f.properties.rank, ha: f.properties.flooded_farmland_ha }, geometry: { type: "Point", coordinates: [c.lon, c.lat] } }; }) } });
  const halo = { "text-color": "#ffffff", "text-halo-color": "rgba(8, 28, 22, 0.85)", "text-halo-width": 1.4, "text-halo-blur": 0.4 };
  map.addLayer({ id: "prov-labels", type: "symbol", source: "prov-labels", maxzoom: 9,
    layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 8.5, 15], "text-letter-spacing": 0.08, "text-max-width": 7 },
    paint: { ...halo, "text-opacity": ["interpolate", ["linear"], ["zoom"], 8.2, 0.95, 9, 0] } });
  map.addLayer({ id: "town-labels", type: "symbol", source: "town-labels", minzoom: 7.8,
    filter: ["any", [">=", ["zoom"], 8.8], ["<=", ["get", "rank"], 6]],
    layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10.5, 11, 13], "symbol-sort-key": ["get", "rank"], "text-padding": 6, "text-max-width": 7, "text-variable-anchor": ["center", "top", "bottom"], "text-radial-offset": 0.3 },
    paint: halo });
}
function vis(id, on) { if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
function applyLayers() {
  if (!S.ready) return;
  const L = S.layers, replay = S.mode === "replay", after = replay && dayISO(S.t) >= "2024-11-02";
  vis("hotspots", L.hotspots && after);
  vis("flood", L.flood && after);
  vis("towns-fill", L.towns && after);
  ["towns-line", "towns-hover", "towns-active", "prov-labels", "town-labels"].forEach((id) => vis(id, L.towns));
  ["track-casing", "track", "track-done", "track-pts", "closest"].forEach((id) => vis(id, L.storm && replay));
  [stormMarker, S.refLabel, S.nagaLabel, ...(S.trackLabels || [])].forEach((m) => m && (m.getElement().style.visibility = L.storm && replay ? "" : "hidden"));
  vis("hillshade", L.hillshade);
  Object.keys(GIBS).forEach((k) => vis(`gibs-${k}`, S.gibs === k));
  map.setTerrain(L.terrain && S.view3d ? { source: "dem", exaggeration: Number($("exag")?.value || 1.8) } : null);
  applyPilotLayers();
  vis("brisk", S.layers.brisk);
  vis("runoff", S.layers.runoff); ["streams", "streams-casing"].forEach((id) => vis(id, S.layers.streams));
  renderLegend();
}
function setBasemap(k) {
  S.basemap = k; $("app").dataset.basemap = k;
  const src = map.getSource("base"); if (!src) return;
  src.setTiles(BASEMAPS[k].tiles);
  map.setPaintProperty("towns-line", "line-color", k === "sat" ? "rgba(255,255,255,0.75)" : "rgba(19,38,28,0.35)");
  ["prov-labels", "town-labels"].forEach((id) => { if (!map.getLayer(id)) return; map.setPaintProperty(id, "text-color", k === "sat" ? "#ffffff" : "#13261c"); map.setPaintProperty(id, "text-halo-color", k === "sat" ? "rgba(8,28,22,0.85)" : "rgba(255,255,255,0.9)"); });
}

// ---------------- hover readout + inspector ----------------
// ground elevation from the 3D terrain (AWS Terrain Tiles), with the visual exaggeration removed
function elevAt(lng, lat) {
  if (!map?.getTerrain?.()) return null;
  const v = map.queryTerrainElevation([lng, lat]);
  const ex = map.getTerrain()?.exaggeration || 1;
  return v == null || !isFinite(v) ? null : Math.max(0, v / ex);
}
function onHover(e) {
  if (!S.tl) return;
  const { lng, lat } = e.lngLat, t = townAt(lng, lat), f = FIELDS[S.field];
  let val = "";
  if (S.field !== "none") {
    const v = sample(cellValues(S.field, Math.floor(S.t)), lng, lat);
    val = ` <span>|</span> ${f.name}: <b>${S.field === "soil" ? fmt(v, 2) : fmt(v, S.field === "lstm" ? 1 : 0)}${f.unit ? " " + f.unit : ""}</b>`;
  }
  const el = elevAt(lng, lat);
  $("readout").innerHTML = `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E${el != null ? ` <span>|</span> ${fmt(el)} m` : ""}${t ? ` <span>|</span> <b>${esc(t.name)}</b>, ${esc(t.province)}` : ""}${val}${(() => { const r = runoffAt(lng, lat); return r && S.layers.runoff ? ` <span>|</span> runoff <b>${r.score}</b>` : ""; })()}${pgReadout(lng, lat)}`;
}
function inspect(lon, lat) {
  S.inspect = { lon, lat };
  const tl = S.tl, di = Math.floor(S.t), iso = dayISO(di), t = townAt(lon, lat), ci = nearestCell(lon, lat);
  if (!pinMarker) { const el = document.createElement("div"); el.className = "pin"; pinMarker = new maplibregl.Marker({ element: el }); }
  pinMarker.setLngLat([lon, lat]).addTo(map);
  if (t) map.setFilter("towns-active", ["all", ["==", ["get", "name"], t.name], ["==", ["get", "province"], t.province]]);
  const rainDay = sample(cellValues("rain", di), lon, lat), rainSum = sample(cellValues("rainsum", di), lon, lat);
  const evVals = tl.cells.map((_, i) => tl.days.reduce((a, d, k) => (d >= "2024-10-21" && d <= "2024-10-26" ? a + (tl.rain_mm[i][k] || 0) : a), 0));
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
  $("insp-body").innerHTML = `${farmerCard(farmerAt(lon, lat, t))}
    <p class="coord">${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E${elevAt(lon, lat) != null ? `, about ${fmt(elevAt(lon, lat))} m above sea level` : ""}</p>
    <dl class="kv">
      <dt>Radar flood map (this pixel)</dt><dd>${flPill}</dd>
      ${t ? `<div class="sec">Town</div>
      <dt>Flooded farmland</dt><dd>${fmt(t.flooded_farmland_ha)} ha (${pct(share)})</dd>
      <dt>Farmland</dt><dd>${fmt(t.farmland_ha)} ha</dd>
      <dt>Rank in Bicol</dt><dd>${t.rank} of ${S.munis.features.length}</dd>` : ""}
      ${(() => { const r = runoffAt(lon, lat), tr = t && S.runoff?.towns?.[`${t.name}|${t.province}`]; return r || tr ? `<div class="sec">Runoff & ponding risk (terrain + rain, 200 m)</div>
      ${r ? `<dt>This spot</dt><dd>${r.score}/100, ${runoffClass(r.score)}</dd><dt>Terrain wetness index</dt><dd>${r.twi.toFixed(1)}</dd>` : ""}
      ${tr ? `<dt>Town land rated high</dt><dd>${pct(tr.high_share)}</dd>` : ""}` : ""; })()}
      ${S.mode === "now" && tl.lstm_kristine_again ? `<div class="sec">Now (NASA POWER, ${short(tl.lstm_kristine_again.soil_as_of)} ${tl.lstm_kristine_again.soil_as_of.slice(0, 4)})</div>
      <dt>Root-zone wetness</dt><dd>${fmt(sample(cellValues("soilnow", 0), lon, lat), 2)}</dd>
      <dt>If a Kristine-size storm hit now</dt><dd>${fmt(sample(cellValues("ready", 0), lon, lat), 0)} of 7 days waterlogged</dd>` : ""}
      <div class="sec">Weather here, ${short(iso)} (NASA POWER)</div>
      <dt>Rain that day</dt><dd>${fmt(rainDay)} mm</dd>
      <dt>Rain since 10 Oct</dt><dd>${fmt(rainSum)} mm</dd>
      <dt>Kristine, 21–26 Oct</dt><dd>${fmt(rainEvent)} mm</dd>
      <dt>Root-zone wetness</dt><dd>${fmt(soil, 2)}${soil >= 0.97 ? " (waterlogged)" : ""}</dd>
      ${sd != null ? `<dt>Distance to storm centre</dt><dd>${fmt(sd)} km</dd>` : ""}
      <div class="sec">Soil forecast, nearest grid cell</div>
      <dt>Forecast after 2 Nov</dt><dd>${h ? `${h.days_pred} of 7 days waterlogged` : "n/a"}</dd>
      <dt>What happened</dt><dd>${h ? `${h.days_actual} of 7 days` : "n/a"}</dd>
      <dt>If Kristine came again</dt><dd>${g ? `${g.days_waterlogged} of 7 days` : "n/a"}</dd>
      ${(() => { const b = briskAt(lon, lat); return b && b.cls >= 0 ? `<div class="sec">Field Drowning Risk, 100 m (after Kristine)</div><dt>This farmland cell</dt><dd>${b.score}/100, ${["low", "watch", "high"][b.cls]}</dd>` : ""; })()}
      ${pgInspectHTML(lon, lat)}
    </dl>
    ${h ? `<div class="insp-chart"><canvas id="ch-insp"></canvas></div>` : ""}
    <div class="insp-actions">${S.flow ? `<button type="button" class="btn water-btn" data-water="${lon},${lat}"><i data-lucide="waves"></i>Where does the water go?</button>` : ""}
    ${t ? `<button type="button" class="btn report-btn" data-report="${esc(t.name)}|${esc(t.province)}"><i data-lucide="file-text"></i>Town flood report</button>` : ""}</div>
    ${acts.length ? `<div class="kv"><div class="sec">What to do</div></div><ul class="actions">${acts.map((a, i) => `<li class="${i === 0 && share >= 0.15 ? "warn" : ""}">${esc(a)}</li>`).join("")}</ul>` : ""}`;
  const box = $("inspector");
  box.style.zIndex = String(++WM.z); // above any open window
  if (box.hidden && box.classList.contains("folded")) { box.classList.remove("folded"); $("insp-min").innerHTML = `<i data-lucide="minus"></i>`; } // a fresh open unfolds; date changes keep the fold
  if (!box._front) { box._front = true; box.addEventListener("pointerdown", () => (box.style.zIndex = String(++WM.z))); }
  if (box.hidden) {
    const pt = map.project([lon, lat]), r = box.parentElement.getBoundingClientRect();
    box.hidden = false;
    const br = box.getBoundingClientRect();
    box.style.setProperty("--ox", `${Math.max(0, Math.min(100, ((pt.x + r.left - br.left) / br.width) * 100))}%`);
    box.style.setProperty("--oy", `${Math.max(0, Math.min(100, ((pt.y + r.top - br.top) / br.height) * 100))}%`);
    box.classList.remove("pop"); void box.offsetWidth; box.classList.add("pop");
  }
  $("insp-body").querySelector("[data-water]")?.addEventListener("click", (e) => { const [a, b] = e.currentTarget.dataset.water.split(",").map(Number); traceWater(a, b); });
  $("insp-body").querySelector("[data-report]")?.addEventListener("click", (e) => { const [n, p] = e.currentTarget.dataset.report.split("|"); townReport(n, p); });
  aiOnInspect();
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
  if (WM.ws && !(WM.ws === "ai")) backToMap();
  const c = S.townCenters.find((x) => x.name === name && x.province === province); if (!c) return;
  document.querySelectorAll(".town").forEach((b) => b.classList.toggle("active", b.dataset.n === name && b.dataset.p === province));
  map.flyTo({ center: [c.lon, c.lat], zoom: 10.8, pitch: S.view3d ? 50 : 0, duration: 1500 });
  inspect(c.lon, c.lat);
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
  if (s && s._date !== iso) {
    s.setTiles([GIBS[S.gibs].url.replace("{date}", iso)]); s._date = iso;
    // 3D terrain keeps the old date's draped tiles until told otherwise
    const refresh = () => { map.terrain?.sourceCache?.freeRtt?.(); map.triggerRepaint(); };
    refresh(); map.once("idle", refresh);
  }
}
// sample points on Bicol land (the town-polygon mask), ~0.5 km apart
function landPoints() {
  if (R.lp) return R.lp;
  const pts = [], st = 6;
  for (let y = 0; y < R.H; y += st) for (let x = 0; x < R.W; x += st) if (R.mask[y * R.W + x] > 128) pts.push([R.lonAt[x], R.latAt[y]]);
  return (R.lp = pts);
}
// Bicol land average and land maximum of the interpolated NASA POWER rain, per day
function regionDaily() {
  if (S._rd) return S._rd;
  const pts = landPoints();
  return (S._rd = S.tl.days.map((_, d) => {
    const vals = cellValues("rain", d);
    let sum = 0, n = 0, mx = -1, at = null;
    for (const [lo, la] of pts) { const v = sample(vals, lo, la); if (isFinite(v)) { sum += v; n++; if (v > mx) { mx = v; at = { lon: lo, lat: la }; } } }
    return { mean: n ? sum / n : 0, max: mx, at, imax: at ? nearestCell(at.lon, at.lat) : 0 };
  }));
}
// share of Bicol land with root zone at 0.97+ (waterlogged)
function landWet(d) {
  S._wet = S._wet || {};
  if (S._wet[d] != null) return S._wet[d];
  const pts = landPoints(), vals = cellValues("soil", d);
  let wet = 0, n = 0;
  for (const [lo, la] of pts) { const v = sample(vals, lo, la); if (isFinite(v)) { n++; if (v >= 0.97) wet++; } }
  return (S._wet[d] = n ? wet / n : 0);
}
function renderStats(di) {
  const rd = regionDaily(), cum = rd.slice(0, di + 1).reduce((a, b) => a + b.mean, 0);
    if (!$("st-0")) $("sim-stats").innerHTML = [0, 1, 2, 3].map((i) => `<div><b id="st-${i}">0</b><span id="sl-${i}"></span></div>`).join("");
  countTo($("st-0"), rd[di].mean, 0, " mm"); $("sl-0").textContent = `rain over Bicol land, peak ${fmt(rd[di].max)}`;
  countTo($("st-1"), cum, 0, " mm"); $("sl-1").textContent = "Bicol rain since 10 Oct";
  countTo($("st-2"), Math.round(landWet(di) * 100), 0, "%"); $("sl-2").textContent = "of Bicol land waterlogged";
  if (S.storm?.active) countTo($("st-3"), S.storm.wind, 0, " kt"); else { cancelAnimationFrame($("st-3")._raf); $("st-3").textContent = "None"; delete $("st-3").dataset.v; }
  $("sl-3").textContent = "Kristine wind (EONET)";
}
function buildTimeline() {
  const rd = regionDaily(), max = Math.max(...rd.map((d) => d.mean)), passes = new Set(S.tl.passes.filter((p) => p.used).map((p) => p.date));
  $("bars").innerHTML = S.tl.days.map((d, i) => `<i class="${d >= "2024-10-21" && d <= "2024-10-26" ? "storm" : ""}${passes.has(d) ? " pass" : ""}" style="height:${Math.max(4, (rd[i].mean / max) * 100)}%;--i:${i}" title="${short(d)}: ${fmt(rd[i].mean)} mm over Bicol land (peak ${fmt(rd[i].max)})"></i>`).join("");
  $("bars").classList.add("intro"); setTimeout(() => $("bars").classList.remove("intro"), 1400);
  $("days").innerHTML = S.tl.days.map((d, i) => (i % 7 === 0 ? `<span style="left:${((i + 0.5) / N()) * 100}%">${short(d)}</span>` : "")).join("");
  $("ticks").innerHTML = S.events.map((e) => `<i style="left:${(e.t / N()) * 100}%;--c:${e.c}" title="${esc(short(dayISO(e.t)) + ": " + e.text)}"></i>`).join("");
  const sp = document.createElement("button"); sp.type = "button"; sp.className = "tl-speed"; sp.textContent = "1×"; sp.setAttribute("aria-label", "Playback speed");
  sp.addEventListener("click", () => { S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1; sp.textContent = `${S.speed}×`; });
  document.querySelector(".timeline").appendChild(sp);
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
    const cp = S.closest;
    ev.push({ t: tAt(cp.t), c: STORM, at: cp, text: `Closest pass: the storm centre is ${fmt(cp.km)} km north-east of Naga City, about ${cp.wind} kt. Bicol's rain comes from the storm's southern bands.` });
    const land = st.findIndex((p) => p.lon < 122.3 && p.lat > 16.5);
    if (land > 0) ev.push({ t: tAt(st[land].t), c: STORM, at: st[land], text: `Kristine crosses northern Luzon (Isabela), ${st[land].wind_kts} kt.` });
    const mi = st.reduce((m, p, i) => (p.wind_kts > st[m].wind_kts ? i : m), 0);
    ev.push({ t: tAt(st[mi].t), c: STORM, at: st[mi], text: `Peak wind in the track: ${st[mi].wind_kts} kt (${cat(st[mi].wind_kts).name}) over the West Philippine Sea.` });
  }
  rd.forEach((d, i) => {
    if (d.max >= 120) {
      const town = nearestTown(d.at.lon, d.at.lat);
      ev.push({ t: i + 0.5, c: WATER, at: town || d.at, text: `Up to ${fmt(d.max)} mm of rain in one day around ${town ? `${town.name}, ${town.province}` : "Bicol"} (NASA POWER, ~50 km grid). Bicol land average ${fmt(d.mean)} mm.` });
    }
  });
  let wasSat = false;
  S.tl.days.forEach((_, d) => {
    const sat = landWet(d) >= 0.5;
    if (sat && !wasSat) ev.push({ t: d + 0.6, c: WATER_DARK, text: `Root-zone soil is waterlogged on ${Math.round(landWet(d) * 100)}% of Bicol's land.` });
    if (!sat && wasSat) ev.push({ t: d + 0.6, c: GREEN, text: `Soil starts to drain: ${Math.round(landWet(d) * 100)}% of Bicol's land still waterlogged.` });
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
    ev.push({ t: tAt(h.issued) + 0.5, c: "#7a4cc2", text: `7-day soil forecast for every grid cell: waterlogged days right within 1 day in ${ok} of ${v.length} cells.` });
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
function initSegs(root = document) {
  root.querySelectorAll(".seg").forEach((seg) => {
    if (seg.querySelector(".seg-pill")) return;
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
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    setView3d(b.dataset.view === "3d");
    applyLayers();
  }));
  $("btn-fit-bicol").addEventListener("click", () => flyBicol(30));
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
  $("insp-min").addEventListener("click", () => { const box = $("inspector"); box.classList.toggle("folded");
    $("insp-min").innerHTML = `<i data-lucide="${box.classList.contains("folded") ? "plus" : "minus"}"></i>`; icons(); });
  $("tl-fold").addEventListener("click", () => { const tl = document.querySelector(".timeline"); tl.classList.toggle("folded");
    $("tl-fold").innerHTML = `<i data-lucide="${tl.classList.contains("folded") ? "chevron-up" : "chevron-down"}"></i>`; icons(); });
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
  return window.innerWidth <= 760 ? { top: 60, bottom: 150, left: 10, right: 10 } : { top: 70, bottom: 130, left: 80, right: 60 };
}
// Frame Bicol: zoom from the flat fit, then tilt. fitBounds with a pitch backs the camera off far too much.
function flyBicol(pitch, bearing = 0, duration = 1400) {
  const cam = map.cameraForBounds([[R.w, R.s], [R.e, R.n]], { padding: 12 }); // the map's own padding already reserves the chrome
  map.flyTo({ center: cam.center, zoom: cam.zoom + (S.view3d ? 0.1 : 0), pitch: tilt(pitch), bearing: S.view3d ? bearing : 0, duration: reduceMotion ? 0 : duration, essential: true });
}
// 2D = flat, north-up, no tilt or rotation; 3D = terrain on, tilt and rotate allowed.
// Terrain must change before the camera moves: switching terrain mid-animation cancels the ease.
const tilt = (deg) => (S.view3d ? deg : 0);
function setView3d(on) {
  S.view3d = on;
  document.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", String((x.dataset.view === "3d") === on)));
  map.stop();
  applyLayers();
  if (on) {
    map.setMaxPitch(75); map.dragRotate.enable(); map.touchPitch.enable(); map.touchZoomRotate.enableRotation();
    map.easeTo({ pitch: 45, duration: 800 });
  } else {
    map.dragRotate.disable(); map.touchPitch.disable(); map.touchZoomRotate.disableRotation();
    map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    map.once("moveend", () => { if (!S.view3d) map.setMaxPitch(0); });
  }
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
  const closest = S.closest?.km ?? 0;
  const gibsNote = () => (S.gibs === "none" ? "From NASA GIBS, for the date on the timeline." : GIBS[S.gibs].sub);
  $("tab-layers").innerHTML = `
    <p class="h">Heatmap</p>
    <div class="fields" role="radiogroup" aria-label="Heatmap">
      ${Object.entries(FIELDS).map(([k, f]) => `<button type="button" class="field-opt" role="radio" data-field="${k}" aria-checked="${k === S.field}">
        <span class="sw ${k === "none" ? "none" : ""}" style="${k === "none" ? "" : `background:${rampCSS(k)}`}"></span>
        <span><b>${f.name}</b><small>${f.sub || "Show the map without a heatmap"}</small></span></button>`).join("")}
    </div>
    ${slider("field-op", "Opacity", 0.2, 1, 0.05, S.fieldOpacity, `${Math.round(S.fieldOpacity * 100)}%`)}
    <p class="h">Flood, Sentinel-1 radar (28 Oct + 2 Nov passes)</p>
    ${toggle("hotspots", "Flood hotspots", "Density of flooded farmland; fades as you zoom in")}
    ${toggle("flood", "Flooded farmland, 100 m", "Water on farmland, from zoom 9")}
    ${toggle("towns", "Towns", "Boundaries, shaded by share of farmland flooded")}
    <p class="h">Runoff, all of Bicol (terrain + rain, 200 m)</p>
    ${toggle("runoff", "Runoff & ponding risk", "Where Kristine's rain collects: NASADEM wetness index + NASA POWER rain. Modelled, not observed")}
    ${toggle("streams", "Drainage network", "NASADEM flow paths draining 10 km² or more; thicker = bigger catchment")}
    <div class="whatif">
      <div class="whatif-head"><b>What if more rain fell?</b><button type="button" class="link-btn" id="wi-reset">Kristine</button></div>
      <input type="range" id="wi-rain" min="0" max="400" step="10" value="0" aria-label="Storm rain for the what-if, mm" />
      <div class="whatif-out" id="wi-out">Drag to test a uniform storm rain over Bicol (event + the week before). 0 = Kristine's real rain.</div>
    </div>
    <p class="h">Field Drowning Risk, all of Bicol farmland (100 m)</p>
    ${toggle("brisk", "Field Drowning Risk, 100 m", "Radar + terrain + rain after Kristine, same formula as the 30 m pilot. Every farmland cell, from zoom 8")}
    <p class="h">Field Drowning Risk, 30 m (sample fields)</p>
    ${toggle("pilot", "Risk zones and fields", "High, watch and low cells; field outlines, flood edge and drainage channel. From zoom 11")}
    ${toggle("sarchange", "Radar wetness change", "Cells where Sentinel-1 VV dropped by 1 dB or more after the storm")}
    <p class="note chip-note" style="margin:8px 6px 6px">30 m detail layer (exact cell values on hover)</p>
    <div class="chips" role="group" aria-label="30 m detail layer">
      <button type="button" class="chip" data-pg="cls" aria-pressed="${S.pgLayer === "cls"}">Risk classes</button>
      ${Object.entries(PG_STYLE).filter(([k]) => k !== "cls").map(([k, v]) => `<button type="button" class="chip" data-pg="${k}" aria-pressed="${S.pgLayer === k}">${v.name}</button>`).join("")}
    </div>
    <p class="h">Storm</p>
    ${toggle("storm", "Kristine's track", "NASA EONET every 6 hours, PAGASA colours")}
    <p class="callout"><i data-lucide="info"></i><span>Kristine's centre crossed northern Luzon and came no closer than ${fmt(closest)} km to Naga. Bicol flooded from the storm's southern rain bands: pick <b>Rain that day</b> and press play.</span></p>
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
  tab.querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => {
    S.pgLayer = b.dataset.pg; tab.querySelectorAll("[data-pg]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderPilotGrid(); if (S.ready && map.getZoom() < 11) flyToPilot();
  }));
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
  $("wi-rain").addEventListener("input", (e) => { fillRange(e.target); whatIf(Number(e.target.value)); });
  $("wi-reset").addEventListener("click", () => { $("wi-rain").value = 0; fillRange($("wi-rain")); whatIf(0); });
  $("exag").addEventListener("input", (e) => { fillRange(e.target); $("exag-v").textContent = `${Number(e.target.value).toFixed(1)}×`; applyLayers(); });
}
function setField(k) {
  S.field = k; document.querySelectorAll(".field-opt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.field === k)));
  renderField(); renderLegend();
}

function renderLegend() {
  const parts = [], z = S.ready ? map.getZoom() : 7;
  if (S.field !== "none" && z < 10.5) {
    const f = FIELDS[S.field], L = lut(S.field);
    const grad = Array.from({ length: 9 }, (_, k) => { const j = Math.round((k / 8) * 255) * 4; return `rgba(${L[j]},${L[j + 1]},${L[j + 2]},${Math.max(0.15, L[j + 3] / 255)}) ${(k / 8) * 100}%`; }).join(",");
    const extra = ["soilnow", "ready"].includes(S.field) ? `NASA POWER, latest day ${short(S.tl.lstm_kristine_again?.soil_as_of || "")} ${(S.tl.lstm_kristine_again?.soil_as_of || "").slice(0, 4)}` : S.field === "lstm" ? (S.aiMode === "hind" ? "Forecast issued 3 Nov 2024" : "Kristine's rain on today's soil") : `${short(dayISO(S.t))}`;
    parts.push(`<div><b>${f.name}${f.unit ? ` (${f.unit})` : ""}</b><small>${extra}</small><div class="ramp" style="background:linear-gradient(90deg,${grad})"></div><div class="ticks-row">${f.ticks.map((t) => `<span>${t}</span>`).join("")}</div></div>`);
  }
  const after = dayISO(S.t) >= "2024-11-02";
  if (after && S.mode === "replay" && z < 12 && (S.layers.flood || S.layers.hotspots || S.layers.towns)) {
    parts.push(`<div><b>Flood, Sentinel-1 (28 Oct + 2 Nov)</b><div class="sw">${S.layers.hotspots ? `<span><i style="background:linear-gradient(90deg,#ffe882,#ffb000,#ff5a1f,#be0028)"></i>Hotspot density</span>` : ""}${S.layers.flood ? `<span><i style="background:#4ec4de"></i>Flooded farmland</span><span><i style="background:#e9e4c9"></i>Farmland</span>` : ""}${S.layers.towns ? `<span><i style="background:rgba(27,95,168,0.5)"></i>Town share flooded</span>` : ""}</div></div>`);
  }
  if (!["none", "cls"].includes(S.pgLayer) && S.pgrid && S.layers.pilot && z >= 10.5) {
    const st = PG_STYLE[S.pgLayer], a = st.stops[0][0], b = st.stops[st.stops.length - 1][0];
    parts.unshift(`<div><b>${st.name}, 30 m</b><small>risk engine grid, ${S.pgrid.width}×${S.pgrid.height} cells</small><div class="ramp" style="background:linear-gradient(90deg,${st.stops.map((q) => `rgba(${q[1][0]},${q[1][1]},${q[1][2]},${Math.max(0.2, q[1][3] / 255)}) ${((q[0] - a) / (b - a)) * 100}%`).join(",")})"></div><div class="ticks-row"><span>${st.fmt(a)}</span><span>${st.fmt(b)}</span></div></div>`);
  }
  if (S.pilot && (S.layers.pilot || S.layers.brisk) && S.ready && map.getZoom() >= (S.layers.brisk ? 8 : 10.5)) parts.unshift(`<div><b>Field Drowning Risk</b><small>${map.getZoom() >= 11.2 ? "30 m pilot grid" : "100 m, all Bicol farmland, after Kristine"}</small><div class="sw">${["high", "watch", "low"].map((k) => `<span><i style="background:${RISK_C[k]}"></i>${RISK_W[k]}</span>`).join("")}<span><i style="background:none;box-shadow:inset 0 0 0 2px #4ec4de"></i>Radar flood edge</span><span><i style="background:#7fe0ff"></i>Drainage channel</span></div></div>`);
  if (S.runoff && (S.layers.runoff || S.layers.streams) && z < 12) parts.push(`<div><b>Runoff & ponding risk, 200 m</b><small>terrain + rain, never saw the radar</small>${S.layers.runoff ? `<div class="ramp" style="background:linear-gradient(90deg,rgba(150,205,235,.5),#2f9fd3 40%,#1b5fa8 70%,#281e78)"></div><div class="ticks-row"><span>60</span><span>High 70</span><span>100</span></div>` : ""}${S.layers.streams ? `<div class="sw"><span><i style="background:#4ec4de;height:3px;border-radius:2px"></i>Drainage, ≥10 km² upstream</span></div>` : ""}</div>`);
  if (S.layers.storm && S.mode === "replay" && z < 10) parts.push(`<div><b>Kristine (EONET winds, PAGASA classes)</b><div class="sw">${CATS.map((c) => `<span><i style="background:${c.c}"></i>${c.short}</span>`).join("")}</div></div>`);
  $("legend").innerHTML = parts.length ? `<button type="button" class="legend-toggle" aria-expanded="${!S.legendFolded}">Legend<i data-lucide="${S.legendFolded ? "chevron-up" : "chevron-down"}"></i></button>${S.legendFolded ? "" : parts.join("")}` : "";
  $("legend").querySelector(".legend-toggle")?.addEventListener("click", () => { S.legendFolded = !S.legendFolded; renderLegend(); });
  icons();
}

// ---------------- towns ----------------
function renderTowns() {
  const s = S.summary, towns = S.munis.features.map((f) => f.properties).sort((a, b) => a.rank - b.rank);
  const affected = towns.filter((t) => t.flooded_farmland_ha >= 1).length;
  $("summary").innerHTML = s ? `
    <div class="big"><b><i id="sum-ha" style="font-style:normal">0</i><small>ha</small></b><span>farmland under water after Kristine: Sentinel-1 at 100 m, 2 Nov pass where it covers, 28 Oct pass elsewhere</span></div>
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
// shade the waterlogged zone (root zone ≥ 0.97) behind the forecast lines
const WATERLOG_BAND = { id: "waterlog", beforeDatasetsDraw(c) {
  const y = c.scales.y, a = c.chartArea; if (!y || !a) return;
  const top = y.getPixelForValue(1), bot = y.getPixelForValue(0.97), g = c.ctx;
  g.save(); g.fillStyle = "rgba(226, 83, 60, 0.07)"; g.fillRect(a.left, top, a.right - a.left, bot - top);
  g.fillStyle = "rgba(160, 50, 31, 0.7)"; g.font = "600 10px Inter, sans-serif"; g.fillText("waterlogged", a.left + 6, top + 12); g.restore();
} };
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
    $("ai-key").innerHTML = `<span><i style="background:${GREEN}"></i>Forecast, Bicol average</span><span><i style="background:${WATER}"></i>What happened</span><span><i style="background:${STORM}"></i>Waterlogged (0.97)</span>`;
    $("ai-hint").textContent = "Click anywhere on the map to see the forecast for that spot.";
    if (S.bench) renderForecastKpis();
  } else if (again) {
    const v = again.cells.filter(Boolean), wet = v.filter((c) => c.days_waterlogged > 0).length;
    labels = Array.from({ length: 7 }, (_, d) => `Day ${d + 1}`);
    ds = [{ data: Array.from({ length: 7 }, (_, d) => v.reduce((a, c) => a + c.pred[d], 0) / v.length), borderColor: STORM, backgroundColor: "rgba(226,83,60,0.12)", fill: true, tension: 0.3, borderWidth: 3 }];
    $("ai-lead").innerHTML = `If Kristine's week of rain fell again on today's soil (NASA POWER, ${esc(again.soil_as_of)}), roots would be waterlogged in <strong>${wet} of ${v.length}</strong> grid cells. Soil is drier now than in October 2024.`;
    $("ai-key").innerHTML = `<span><i style="background:${STORM}"></i>Root zone, Bicol average</span><span><i style="background:${STORM};opacity:.5"></i>Waterlogged (0.97)</span>`;
    $("ai-hint").textContent = "Each grid cell gets its own Kristine-week rain from October 2024.";
  }
  const data = { labels, datasets: [...ds, { data: labels.map(() => 0.97), borderColor: STORM, borderWidth: 1, pointRadius: 0, borderDash: [3, 3] }] };
  const lo = Math.min(...ds.flatMap((d) => d.data).filter(Number.isFinite));
  const yMin = Math.max(0.5, Math.floor((Math.min(lo, 0.96) - 0.02) * 50) / 50);
  if (S.charts.ai) { S.charts.ai.data = data; S.charts.ai.options.scales.y.min = yMin; S.charts.ai.update(); }
  else if (window.Chart) S.charts.ai = new Chart($("ch-ai"), { type: "line", data, plugins: [WATERLOG_BAND], options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
    elements: { point: { radius: 3, hoverRadius: 5 } }, interaction: { mode: "index", intersect: false },
    scales: { y: { min: yMin, max: 1, grid: { color: "#eef3f0" }, ticks: { font: { size: 10 }, callback: (v) => v.toFixed(2) } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });
  if (!renderAI.bound) {
    renderAI.bound = true;
    document.querySelectorAll("#ai-seg button").forEach((b) => b.addEventListener("click", () => { S.aiMode = b.dataset.ai; renderAI(); if (S.field === "lstm") { renderField(); renderLegend(); } }));
    $("btn-ai-map").addEventListener("click", () => setField("lstm"));
  }
}


// ================= Field Drowning Risk: the 30 m check on sample fields =================
// Data: mock-data.json (the risk engine's output contract). Plot sizes, households, crops and bare-field days are
// placeholders until LGU parcel data exist (provenance.pending_inputs), so they are tagged in the UI.
const RISK_C = { high: "#e2533c", watch: "#ee9f27", low: "#7cc69a", missing: "#9aa59f", excluded: "#c9cfcb" };
const RISK_W = { high: "High", watch: "Watch", low: "Low", missing: "No radar data", excluded: "Not farmland" };
const PRIORITIES = { water: "Water", nitrogen: "Soil nitrogen", cash: "Cash income" };
const pending = (k) => (S.pilot?.provenance?.pending_inputs || []).includes(k) ? `<span class="tag" title="Placeholder until LGU parcel and census data">sample</span>` : "";
function plotFeat(id) { return S.pilot.plots.features.find((f) => f.properties.plot_id === id); }
function plotCenter(f) {
  let x = 0, y = 0, n = 0; f.geometry.coordinates[0].forEach(([a, b]) => { x += a; y += b; n++; }); return [x / n, y / n];
}
function pilotBounds() {
  let w = 180, e = -180, s = 90, n = -90;
  S.pilot.plots.features.forEach((f) => f.geometry.coordinates[0].forEach(([a, b]) => { w = Math.min(w, a); e = Math.max(e, a); s = Math.min(s, b); n = Math.max(n, b); }));
  return [[w, s], [e, n]];
}
function flyToPilot() {
  if (!S.pilot) return;
  map.fitBounds(pilotBounds(), { padding: chromePadding(), pitch: S.view3d ? 45 : 0, bearing: 0, duration: 1600, maxZoom: 15 });
}

function addPilotLayers() {
  const P = S.pilot; if (!P) return;
  map.addSource("risk-zones", { type: "geojson", data: P.risk_zones });
  map.addLayer({ id: "risk-zones", type: "fill", source: "risk-zones", minzoom: 10.5,
    paint: { "fill-color": ["match", ["get", "risk_class"], "high", RISK_C.high, "watch", RISK_C.watch, "low", RISK_C.low, "excluded", RISK_C.excluded, RISK_C.missing],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 0.5] } });
  map.addSource("sar-change", { type: "geojson", data: P.sar_backscatter_comparison.after_event });
  map.addLayer({ id: "sar-change", type: "fill", source: "sar-change", minzoom: 10.5, layout: { visibility: "none" }, paint: { "fill-color": "#1b5fa8", "fill-opacity": 0.45, "fill-outline-color": "#ffffff" } });
  map.addSource("obs-flood", { type: "geojson", data: P.observed_flood_extent });
  map.addLayer({ id: "obs-flood", type: "line", source: "obs-flood", minzoom: 10.5, paint: { "line-color": "#4ec4de", "line-width": 2, "line-dasharray": [2, 1] } });
  map.addSource("drain", { type: "geojson", data: P.drainage_corridor });
  map.addLayer({ id: "drain", type: "line", source: "drain", minzoom: 10.5, paint: { "line-color": "#7fe0ff", "line-width": 3, "line-blur": 0.5 }, layout: { "line-cap": "round" } });
  map.addSource("plots", { type: "geojson", data: P.plots });
  map.addLayer({ id: "plots-fill", type: "fill", source: "plots", minzoom: 10.5, paint: { "fill-color": "#ffffff", "fill-opacity": 0.01 } });
  map.addLayer({ id: "plots-line", type: "line", source: "plots", minzoom: 10.5,
    paint: { "line-color": ["match", ["get", "risk_class"], "high", RISK_C.high, "watch", RISK_C.watch, RISK_C.low], "line-width": ["case", ["==", ["get", "plot_id"], S.plot], 4, 2.2] } });
  S.plotLabels = P.plots.features.map((f) => {
    const el = document.createElement("button"); el.type = "button"; el.className = "plot-label";
    el.style.setProperty("--rc", RISK_C[f.properties.risk_class]);
    el.innerHTML = `<b>${f.properties.plot_id}</b><span>${f.properties.risk_score}</span>`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); selectPlot(f.properties.plot_id, true); });
    const top = f.geometry.coordinates[0].reduce((m, [x, y]) => (y > m[1] ? [x, y] : m), [0, -90]);
    return new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -4] }).setLngLat([plotCenter(f)[0], top[1]]).addTo(map);
  });
  const sync = () => { const on = S.layers.pilot && map.getZoom() >= 11.2; S.plotLabels.forEach((m) => (m.getElement().style.display = on ? "" : "none")); };
  map.on("zoom", sync); sync();
  map.on("mouseenter", "plots-fill", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "plots-fill", () => (map.getCanvas().style.cursor = ""));
  map.on("zoomend", renderLegend);
}
function applyPilotLayers() {
  if (!S.ready || !S.pilot) return;
  ["plots-fill", "plots-line", "obs-flood", "drain"].forEach((id) => vis(id, S.layers.pilot));
  vis("risk-zones", false); vis("pgrid", S.layers.pilot && S.pgLayer !== "none");
  vis("sar-change", S.layers.pilot && S.layers.sarchange);
  (S.plotLabels || []).forEach((m) => (m.getElement().style.display = S.layers.pilot && map.getZoom() >= 11.2 ? "" : "none"));
}

function selectPlot(id, openTab) {
  S.plot = id;
  if (S.ready && map.getLayer("plots-line")) map.setPaintProperty("plots-line", "line-width", ["case", ["==", ["get", "plot_id"], id], 4, 2.2]);
  renderFields();
  if (openTab) showTab("fields");
}
function showTab(name) {
  openApp(name);
}

function rankRotations(p) {
  const fit = p.rotation_fit || {}, order = { good: 0, caution: 1, poor: 2 };
  return S.pilot.rotation_strategies.map((r) => ({ ...r, fit: fit[r.id] || null }))
    .sort((a, b) => (order[a.fit?.fit] ?? 1) - (order[b.fit?.fit] ?? 1) || (a.priorities[S.priority] ?? 9) - (b.priorities[S.priority] ?? 9));
}

function renderFields() {
  const P = S.pilot, box = $("tab-fields");
  if (!P) { box.innerHTML = `<p class="note">The field-level risk file (mock-data.json) did not load. Run <b>python -m pipeline.risk_engine</b>.</p>`; return; }
  const pv = P.provenance, feats = P.plots.features, p = plotFeat(S.plot).properties, rc = RISK_C[p.risk_class];
  const rain = pv.rainfall?.r_total_mm;
  const parts = [
    { k: "Radar wetness change", v: `${p.sar_wetness_change_db} dB`, w: 45 * p.s_sar, c: "#1b5fa8" },
    { k: "Terrain wetness index", v: `${p.twi_value}`, w: 35 * p.s_twi, c: "#2f9fd3" },
    { k: "Storm rain", v: rain ? `${fmt(rain)} mm` : "", w: 20 * p.s_rain, c: "#7fc8e8" },
  ];
  const soil = p.soil_0_30cm;
  const rots = rankRotations(p);
  box.innerHTML = `
    <div class="pilot-head">
      <div><h2>Field Drowning Risk, 30 m</h2><p>Every 30 m cell scored from Sentinel-1 radar, NASADEM terrain and GPM rain. Shown here for five sample fields in Minalabac, Camarines Sur, in the worst-hit part of Bicol.</p></div>
      <span style="display:grid;gap:6px"><button type="button" class="btn ghost" id="btn-fly-pilot"><i data-lucide="locate-fixed"></i>Go</button><button type="button" class="btn ghost" onclick="drawStart()"><i data-lucide="pen-tool"></i>Trace</button></span>
    </div>
    <div class="metrics">
      <div><b>${fmt(pv.total_high_risk_ha, 1)} ha</b><span>of the sample fields rated high risk${pending("hectares")}</span></div>
      <div><b>${pv.high_risk_plots} of ${feats.length}</b><span>fields rated high</span></div>
      <div><b class="hit">${esc(pv.sar_hit_rate)}</b><span>of radar-seen flooded farmland the terrain + rain model had already rated high</span></div>
      <div><b>${fmt(pv.flooded_farmland_ha, 1)} ha</b><span>flooded farmland in the 30 m area on 2 Nov</span></div>
    </div>
    <h2 class="h">Barangays to reach first</h2>
    <ol class="brgys">${(pv.barangay_ranking || []).map((b) => `<li><span class="n">${b.rank}</span><span>${esc(b.barangay)}<small>${b.plots} field${b.plots > 1 ? "s" : ""}, highest score ${b.max_risk_score}</small></span><span class="v">${fmt(b.high_risk_ha, 1)} ha high<small>${b.high_risk_households} households${pending("households")}</small></span></li>`).join("")}</ol>
    <h2 class="h">Fields</h2>
    <div class="plot-chips" role="group" aria-label="Sample fields">${feats.map((f) => `<button type="button" class="plot-chip" data-plot="${f.properties.plot_id}" aria-pressed="${f.properties.plot_id === S.plot}" style="--rc:${RISK_C[f.properties.risk_class]}"><i></i>${f.properties.plot_id}</button>`).join("")}</div>
    <article class="plot-card" style="--rc:${rc}">
      <h3>${esc(p.name)}</h3>
      <p class="sub2">${esc(p.barangay)}, ${fmt(p.hectares, 1)} ha${pending("hectares")}, ${esc(p.current_crop)}${pending("current_crop")}</p>
      <div class="score"><div class="num">${p.risk_score}<small>/100</small></div>
        <div><span class="cls">${RISK_W[p.risk_class]} drowning risk</span><div class="scale"><i style="left:${p.risk_score}%"></i></div><div class="scale-l"><span>0</span><span>Watch 40</span><span>High 70</span><span>100</span></div></div></div>
      ${p.risk_zone_shares ? `<div class="why"><b style="font-size:12px;color:var(--muted)">How much of this field is at risk (30 m cells)</b>
        <div class="why-bar">${["high", "watch", "low"].map((k) => `<i style="width:${(p.risk_zone_shares[`${k}_share`] || 0) * 100}%;background:${RISK_C[k]}"></i>`).join("")}</div>
        <div class="why-rows">${["high", "watch", "low"].map((k) => `<div><i style="background:${RISK_C[k]}"></i><span>${RISK_W[k]}</span><span>${pct(p.risk_zone_shares[`${k}_share`] || 0)}, ${fmt(p.risk_zone_shares[`${k}_ha`] || 0, 1)} ha</span></div>`).join("")}</div>
        <p class="note" style="margin-top:6px">The field score is the median of its 30 m cells. Outlines are samples; trace your real field with <b>Check my field</b>.</p></div>` : ""}
      <div class="why"><b style="font-size:12px;color:var(--muted)">What drives the score</b>
        <div class="why-bar">${parts.map((x) => `<i style="width:${x.w}%;background:${x.c}"></i>`).join("")}</div>
        <div class="why-rows">${parts.map((x) => `<div><i style="background:${x.c}"></i><span>${x.k} <b>${x.v}</b></span><span>+${Math.round(x.w)}</span></div>`).join("")}</div></div>
      <dl class="kv">
        <dt>Field under water on 2 Nov</dt><dd>${pct(p.flooded_pixel_fraction)}</dd>
        <dt>Radar VV before → after</dt><dd>${p.vv_before_db} → ${p.vv_after_db} dB</dd>
        <dt>Mean slope</dt><dd>${fmt(p.mean_slope_deg, 1)}°</dd>
        <dt>Bare field each year</dt><dd>${p.bare_field_days_per_year} days${pending("bare_field_days_per_year")}</dd>
      </dl>
      ${soil ? `<b style="font-size:12px;color:var(--muted)">Topsoil 0–30 cm (SoilGrids): ${esc(soil.texture)}, organic carbon ${soil.soc_g_per_kg} g/kg</b>
      <div class="soilbar"><span style="width:${soil.sand_pct}%;background:#c9a66b">Sand ${Math.round(soil.sand_pct)}%</span><span style="width:${soil.silt_pct}%;background:#9c8b6e">Silt ${Math.round(soil.silt_pct)}%</span><span style="width:${soil.clay_pct}%;background:#6e5a44">Clay ${Math.round(soil.clay_pct)}%</span></div>
      <p class="note" style="margin-top:8px"><b style="color:var(--ink)">Soil health check:</b> organic carbon is ${soil.soc_g_per_kg >= 20 ? "high" : soil.soc_g_per_kg >= 12 ? "moderate" : "low"} (${soil.soc_g_per_kg} g/kg); ${soil.clay_pct >= 30 ? `${Math.round(soil.clay_pct)}% clay holds nutrients well but drains slowly, so standing water lingers` : "the texture drains fairly freely"}. Rule of thumb from SoilGrids 250 m (low under 12, high from 20 g/kg); confirm with a soil test.</p>` : ""}
    </article>
    <h2 class="h">What to do</h2>
    <ol class="steps">${(p.recommendations || []).map((r) => `<li><span><b>${esc(r.when)}</b><p>${esc(r.action)}</p><small>${esc(r.why)}</small>${(r.sources || []).map((x) => `<span class="src">${esc(x)}</span>`).join("")}</span></li>`).join("")}</ol>
    <h2 class="h">SMS alert for this field</h2>
    <div class="sms">${esc(p.sms_alert)}</div>
    <div class="sms-meta"><span>${p.sms_alert.length} of 160 characters, readable on any phone</span><button type="button" class="link-btn" id="btn-sms"><i data-lucide="copy"></i>Copy</button></div>
    <h2 class="h">Next season: three rotations against the current crop</h2>
    <div class="seg prio" role="group" aria-label="Farmer priority" id="prio-seg">${Object.entries(PRIORITIES).map(([k, v]) => `<button type="button" data-prio="${k}" aria-pressed="${k === S.priority}">${v}</button>`).join("")}</div>
    <div class="rot-now"><span>Now: <b>${esc(p.baseline_crop || p.current_crop)}</b>${pending("current_crop")}</span><span>${p.bare_field_days_per_year} bare days/yr</span></div>
    <div class="rots">${rots.map((r, i) => `<div class="rot ${i === 0 ? "first" : ""}"><span class="rk">${i + 1}</span><div>
      <h4>${esc(r.name)}</h4><div class="crops">${esc(r.crops)}</div>
      ${r.fit ? `<span class="fit ${r.fit.fit}">${r.fit.fit === "good" ? "Good fit" : r.fit.fit === "caution" ? "Use with caution" : "Poor fit"} for this field</span><p>${esc(r.fit.why)}</p>` : ""}
      <p><b>Benefits:</b> ${esc(r.benefits)}</p><p><b>Check locally:</b> ${esc(r.risks_and_gaps)}</p></div></div>`).join("")}</div>
    <p class="note" style="margin-top:10px">Ranked by fit to this field's risk and soil, then by your priority. Rules of thumb to confirm with the Municipal Agriculture Office.</p>`;
  box.querySelectorAll("[data-plot]").forEach((b) => b.addEventListener("click", () => {
    selectPlot(b.dataset.plot);
    if (S.ready && map.getZoom() >= 11) map.easeTo({ center: plotCenter(plotFeat(b.dataset.plot)), duration: 700 });
  }));
  $("btn-fly-pilot").addEventListener("click", () => { if (WM.ws) backToMap(); flyToPilot(); });
  $("btn-sms").addEventListener("click", async () => { try { await navigator.clipboard.writeText(p.sms_alert); toast("SMS text copied."); } catch (_) { toast("Select the SMS text to copy it."); } });
  box.querySelectorAll("[data-prio]").forEach((b) => b.addEventListener("click", () => { S.priority = b.dataset.prio; const y = box.scrollTop; renderFields(); box.scrollTop = y; }));
  initSegs(box);
  icons();
}

function renderData() {
  const P = S.pilot, pv = P?.provenance || {}, sm = S.summary;
  const split = (d) => { const i = d.indexOf(" ("); return i > 0 ? [d.slice(0, i), d.slice(i + 2, -1)] : [d, ""]; };
  const regional = [
    ["NASA EONET", "Kristine's storm track, every 6 hours"],
    ["NASA POWER regional daily", "rain and root-zone wetness for every 0.5° cell in Bicol (heatmaps, runoff score, soil forecast inputs)"],
    ["NASADEM, all of Bicol", "200 m flow accumulation, wetness index and drainage network for the runoff layer"],
    ["NASA GIBS", "MODIS, VIIRS, IMERG and SMAP imagery for each day of the replay"],
    ["Sentinel-1 RTC, both orbits", "Bicol flood screening at 100 m (2 Nov and 28 Oct passes)"],
  ];
  $("tab-data").innerHTML = `
    <p class="h">How the Field Drowning Risk score works</p>
    <div class="formula">Score = 100 × (<b>0.45</b> radar + <b>0.35</b> terrain + <b>0.20</b> rain)
      <div class="w"><i style="width:45%;background:#1b5fa8"></i><i style="width:35%;background:#2f9fd3"></i><i style="width:20%;background:#7fc8e8"></i></div>
      <div class="wl"><span>Radar: −ΔVV / 4 dB</span><span>Terrain: (TWI − 5) / 10</span><span>Rain: mm / 300</span></div>
      <div style="margin-top:8px">High 70+ · Watch 40–69 · Low under 40. Built-up and permanent water are not scored.</div></div>
    <p class="h">Does it work? The independent check</p>
    <div class="hitbox"><b>${esc(pv.sar_hit_rate || "n/a")}</b><p>Of the farmland the radar saw flooded on 2 Nov, this share had already been rated high by the terrain + rain part of the model, which never saw the radar. The full model scores ${esc(pv.sar_hit_rate_full_model || "")}, but that number is circular because radar is in both the score and the flood map, so we do not headline it.</p></div>
    ${S.runoff ? `<p class="h">The same check across all of Bicol</p>
    <div class="hitbox"><b>${pct(S.runoff.validation.share_rated_high)}</b><p>of the farmland the radar saw flooded (28 Oct + 2 Nov) was rated high by the terrain + rain model at 200 m, against ${pct(S.runoff.validation.farmland_share_high)} of all farmland and ${pct(S.runoff.validation.land_share_high)} of all land. A real signal, but farmland is low-lying by nature, so the gap over farmland is the fair measure.</p></div>` : ""}
    ${S.bench ? benchHTML(S.bench) : ""}
    <p class="h">NASA and partner data used</p>
    <ul class="ds">${regional.map(([a, b]) => `<li><span><b>${a}</b><small>${b}</small></span></li>`).join("")}
      ${(pv.datasets_used || []).map((d) => { const [a, b] = split(d); return `<li><span><b>${esc(a)}</b><small>${esc(b)}</small></span></li>`; }).join("")}</ul>
    <p class="h">Future work (not used yet)</p>
    <ul class="ds future">${(pv.future_work_datasets || []).map((d) => `<li><span><b>${esc(d)}</b></span></li>`).join("")}</ul>
    <p class="h">Cost and speed</p>
    <div class="facts2">
      <div><b>₱0</b><span>data licensing: open NASA and Copernicus data</span></div>
      <div><b>${esc(pv.processing_time || "n/a")}</b><span>to rebuild the 30 m risk map from cache</span></div>
      ${sm ? `<div><b>${fmt(sm.processing_time_sec / 60, 0)} min</b><span>to screen all ${sm.municipalities} Bicol towns at 100 m</span></div>
      <div><b>${pct(sm.radar_coverage)}</b><span>of Bicol farmland covered by radar</span></div>` : ""}
    </div>
    <p class="h">Limits, stated plainly</p>
    <ul class="limits">
      <li>${esc(pv.scientific_limit || "C-band radar measures surface wetness, not root-zone moisture.")}</li>
      <li>NASA POWER and the soil forecast work on about 50 km cells: regional soil, not a paddy sensor.</li>
      <li>Field sizes, households, crops and bare-field days are sample values until the LGU shares parcel and census data.</li>
      <li>Not claimed: L-band dielectric inversion, "7 days early" detection, or a 35–50% water saving. None is built or tested.</li>
    </ul>
    <p class="h">Source code</p>
    <p class="note"><a href="https://github.com/venstqs/SakaSAR---NASA-Space-Apps-Challenge" target="_blank" rel="noopener noreferrer" style="color:var(--water-dark);text-decoration:underline;font-weight:600">github.com/venstqs/SakaSAR---NASA-Space-Apps-Challenge</a></p>`;
}

// ================= Story mode: the 30-second demo path =================
const STORY = [
  { title: "Kristine soaks Bicol", text: () => { const rd = regionDaily(), pk = rd.reduce((m, d, i) => (d.max > rd[m].max ? i : m), 0); return `21–26 Oct 2024. The storm's centre stays ${fmt(S.closest?.km)} km from Naga at its closest, yet its rain bands drop up to ${fmt(rd[pk].max)} mm in a day on Bicol land (${short(S.tl.days[pk])}). The heatmap is NASA POWER daily rain.`; },
    go: () => { setField("rain"); setGibs("none"); setTime(tAt("2024-10-22") + 0.5, true); flyBicol(30); } },
  { title: "Clouds blind optical satellites", text: () => "NASA MODIS on 23 Oct sees only cloud over Bicol. Optical images cannot show where the water is during a typhoon.",
    go: () => { setField("none"); setGibs("modis"); setTime(tAt("2024-10-23") + 0.5, true); } },
  { title: "Radar sees through the cloud", text: () => `Sentinel-1 radar (28 Oct and 2 Nov passes): ${fmt(S.summary?.flooded_farmland_ha)} ha of Bicol farmland still under water, worst in Bula, Baao and Nabua. Orange marks the flood hotspots.`,
    go: () => { setGibs("none"); setField("rainsum"); setTime(tAt("2024-11-02") + 0.5, true); map.flyTo({ center: [123.3, 13.5], zoom: 9.4, pitch: tilt(40), bearing: 0, duration: 1800 }); } },
  { title: "Each field gets a drowning risk", text: () => { const p = plotFeat("PL-02")?.properties; return p ? `At 30 m, radar, terrain and rain give each field a score. ${p.plot_id} scores ${p.risk_score}/100 (high). The farmer gets an SMS: open outlets, trench the lowest bund, harvest early.` : ""; },
    go: () => { S.layers.pilot = true; selectPlot("PL-02", true); flyToPilot(); applyLayers(); } },
  { title: "What to plant next season", text: () => "SakaSAR ranks three rotations against the current rice crop using the field's soil and risk, so the farmer and the Municipal Agriculture Office can choose together.",
    go: () => { showTab("fields"); setTimeout(() => { const el = document.querySelector(".rots"); el?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 350); } },
];
function setGibs(k) { S.gibs = k; document.querySelectorAll("[data-gibs]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.gibs === k))); if (k !== "none" && S.ready) { map.getSource(`gibs-${k}`)._date = null; updateGibs(dayISO(S.t)); } applyLayers(); }
function storyGo(i) {
  if (S.mode !== "replay") setMode("replay", true);
  if (!S.pilot && i === 3) i = 4;
  S.story = Math.max(0, Math.min(STORY.length - 1, i));
  const st = STORY[S.story];
  pause();
  $("story").hidden = false;
  $("story-steps").innerHTML = STORY.map((_, k) => `<i class="${k <= S.story ? "on" : ""}"></i>`).join("");
  $("story-title").textContent = `${S.story + 1}. ${st.title}`;
  $("story-text").textContent = st.text();
  $("story-prev").disabled = S.story === 0;
  $("story-next").innerHTML = S.story === STORY.length - 1 ? `Finish<i data-lucide="check"></i>` : `Next<i data-lucide="arrow-right"></i>`;
  icons();
  st.go();
}
function bindStory() {
  $("btn-story").addEventListener("click", () => storyGo(0));
  $("story-next").addEventListener("click", () => (S.story >= STORY.length - 1 ? ($("story").hidden = true) : storyGo(S.story + 1)));
  $("story-prev").addEventListener("click", () => storyGo(S.story - 1));
  $("story-close").addEventListener("click", () => ($("story").hidden = true));
  document.addEventListener("keydown", (e) => { if ($("story").hidden || e.target.closest("input, textarea")) return; if (e.key === "Escape") $("story").hidden = true; });
}


// ================= Windows, launcher rail and workspace =================
// Home is the 3D map. Each panel is a window: drag by the header, resize from the corner, minimise to the rail,
// close, or maximise to "teleport" it into the full-screen workspace.
const APPS = [
  { id: "ai", title: "SakaSAR AI", icon: "message-square-text", ai: true, sub: "Ask about the place and day on the map. Every answer is built from SakaSAR's datasets." },
  { id: "layers", title: "Layers", icon: "layers", sub: "Choose what the 3D map shows: NASA heatmaps, radar flood, storm track, satellite images and terrain." },
  { id: "towns", title: "Towns", icon: "map-pin", sub: "Bicol towns ranked by farmland the Sentinel-1 radar saw under water after Kristine (28 Oct and 2 Nov 2024 passes)." },
  { id: "fields", title: "Field risk", icon: "sprout", sub: "30 m Field Drowning Risk for sample fields: score, what to do, the SMS alert and next-season rotations." },
  { id: "forecast", title: "Forecast", icon: "cloud-rain-wind", sub: "How wet the root zone stays over the next 7 days, predicted from NASA POWER weather, and whether fields will drain." },
  { id: "events", title: "Events", icon: "list", sub: "What happened, day by day, generated from the data. Click one to jump there on the map." },
  { id: "data", title: "Data & method", icon: "database", sub: "How the score works, the independent check, the datasets used and the limits." },
];
const WM = { z: 30, ws: null, wsFromWin: false, state: {} };
const phone = () => window.innerWidth <= 760;
const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function buildWindows() {
  if (!$("tab-ai")) { const s = document.createElement("section"); s.className = "tab-body"; s.id = "tab-ai"; $("sections").prepend(s); }
  const dock = $("dock");
  dock.innerHTML = "";
  APPS.forEach((a, i) => {
    const sec = $(`tab-${a.id}`); sec.hidden = false;
    const w = document.createElement("section");
    w.className = "win"; w.id = `win-${a.id}`; w.hidden = true; w.setAttribute("role", "dialog"); w.setAttribute("aria-label", a.title);
    w.innerHTML = `<header class="win-head"><span class="win-title"><i data-lucide="${a.icon}"></i>${a.title}</span><span class="win-ctl">
      <button type="button" class="wbtn" data-act="min" aria-label="Minimise ${a.title}" data-tip="Minimise"><i data-lucide="minus"></i></button>
      <button type="button" class="wbtn" data-act="max" aria-label="Open ${a.title} full screen" data-tip="Full screen"><i data-lucide="maximize-2"></i></button>
      <button type="button" class="wbtn" data-act="close" aria-label="Close ${a.title}" data-tip="Close"><i data-lucide="x"></i></button></span></header><div class="win-body"></div>`;
    const intro = document.createElement("p"); intro.className = "win-intro"; intro.textContent = a.sub || "";
    w.querySelector(".win-body").append(intro, sec);
    $("app").appendChild(w);
    w.style.left = `${76 + i * 24}px`; w.style.top = `${74 + i * 18}px`;
    if (a.id === "ai") { w.style.width = "400px"; }
    w.querySelector('[data-act="min"]').addEventListener("click", () => minimiseWin(a.id));
    w.querySelector('[data-act="max"]').addEventListener("click", () => teleport(a.id, w.getBoundingClientRect(), true));
    w.querySelector('[data-act="close"]').addEventListener("click", () => closeWin(a.id));
    w.addEventListener("pointerdown", () => focusWin(a.id));
    w.querySelector(".win-body").addEventListener("scroll", (e) => w.classList.toggle("scrolled", e.target.scrollTop > 4));
    dragWin(w, a.id);
    const b = document.createElement("button");
    b.type = "button"; b.className = `dock-btn${a.ai ? " ai" : ""}`; b.dataset.app = a.id; b.dataset.tip = a.title; b.setAttribute("aria-label", a.title);
    b.innerHTML = `<i data-lucide="${a.icon}"></i><span class="dot"></span>`;
    b.addEventListener("click", () => dockClick(a.id));
    dock.appendChild(b);
    if (a.ai) { const sep = document.createElement("span"); sep.className = "dock-sep"; dock.appendChild(sep); }
    WM.state[a.id] = "closed";
  });
  const sep = document.createElement("span"); sep.className = "dock-sep"; dock.appendChild(sep);
  const mn = document.createElement("button");
  mn.type = "button"; mn.className = "dock-btn"; mn.dataset.tip = "Minimise all windows"; mn.setAttribute("aria-label", "Minimise all windows");
  mn.innerHTML = `<i data-lucide="minimize-2"></i>`;
  mn.addEventListener("click", () => { let n = 0; APPS.forEach((a) => { if (WM.state[a.id] === "open") { minimiseWin(a.id); n++; } }); if (!n) toast("No open windows."); });
  dock.appendChild(mn);
  const ws = document.createElement("button");
  ws.type = "button"; ws.className = "dock-btn"; ws.dataset.tip = "Open the full workspace"; ws.setAttribute("aria-label", "Open the full workspace");
  ws.innerHTML = `<i data-lucide="layout-dashboard"></i>`;
  ws.addEventListener("click", () => teleport(WM.lastApp || "towns", ws.getBoundingClientRect(), false));
  dock.appendChild(ws);
  $("ws-back").addEventListener("click", backToMap);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && WM.ws && !e.target.closest("input")) backToMap(); });
  icons();
}
function dockBtn(id) { return document.querySelector(`.dock-btn[data-app="${id}"]`); }
function syncDock() {
  APPS.forEach((a) => { const b = dockBtn(a.id); if (!b) return; b.classList.toggle("open", WM.state[a.id] === "open"); b.classList.toggle("min", WM.state[a.id] === "min"); });
}
function dockClick(id) {
  const w = $(`win-${id}`);
  if (WM.state[id] === "open" && w.classList.contains("focused")) minimiseWin(id);
  else openApp(id);
}
function openApp(id) {
  WM.lastApp = id;
  if (WM.ws) { wsShow(id); return; }
  if (phone()) { teleport(id, dockBtn(id)?.getBoundingClientRect(), false); return; }
  const w = $(`win-${id}`), was = WM.state[id];
  if (was === "open") { focusWin(id); w.animate([{ transform: "scale(1)" }, { transform: "scale(1.015)" }, { transform: "scale(1)" }], { duration: 260, easing: ease }); return; }
  w.hidden = false;
  if (!w.dataset.placed) placeWin(w);
  clampWin(w); focusWin(id);
  const from = dockBtn(id).getBoundingClientRect(), r = w.getBoundingClientRect();
  const dx = from.left + from.width / 2 - (r.left + r.width / 2), dy = from.top + from.height / 2 - (r.top + r.height / 2);
  w.animate([{ transform: `translate(${dx}px, ${dy}px) scale(0.12)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, easing: ease });
  WM.state[id] = "open"; syncDock();
  refreshCharts();
  if (id === "ai") aiWelcome();
}
// open new windows in the first free slot (left, middle, right) so they never bury each other
function placeWin(w) {
  w.dataset.placed = "1";
  const W = window.innerWidth, ww = w.offsetWidth, top = 74;
  const slots = [W - ww - 84, W - ww - 84 - 392, 260, Math.max(16, (W - ww) / 2)];
  const open = [...document.querySelectorAll(".win:not([hidden])")].filter((x) => x !== w).map((x) => x.getBoundingClientRect());
  const free = slots.find((x) => !open.some((r) => x < r.right - 40 && x + ww > r.left + 40)) ?? slots[0] + open.length * 26;
  w.style.left = `${Math.min(free, W - ww - 12)}px`; w.style.top = `${top + (free === slots[0] + open.length * 26 ? open.length * 22 : 0)}px`;
}
function minimiseWin(id) {
  const w = $(`win-${id}`), to = dockBtn(id).getBoundingClientRect(), r = w.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (r.left + r.width / 2), dy = to.top + to.height / 2 - (r.top + r.height / 2);
  w.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.1)`, opacity: 0 }], { duration: 300, easing: "cubic-bezier(0.5, 0, 0.75, 0)" }).onfinish = () => { w.hidden = true; };
  WM.state[id] = "min"; w.classList.remove("focused"); syncDock();
}
function closeWin(id) {
  const w = $(`win-${id}`);
  w.animate([{ transform: "none", opacity: 1 }, { transform: "scale(0.96)", opacity: 0 }], { duration: 180, easing: "ease-in" }).onfinish = () => { w.hidden = true; };
  WM.state[id] = "closed"; w.classList.remove("focused"); syncDock();
}
function focusWin(id) {
  document.querySelectorAll(".win.focused").forEach((x) => x.classList.remove("focused"));
  const w = $(`win-${id}`); w.classList.add("focused"); w.style.zIndex = String(++WM.z);
}
function clampWin(w) {
  const r = w.getBoundingClientRect();
  w.style.left = `${Math.max(8, Math.min(window.innerWidth - Math.min(r.width, 160) - 70, r.left))}px`;
  w.style.top = `${Math.max(8, Math.min(window.innerHeight - 60, r.top))}px`;
}
function dragWin(w, id) {
  const head = w.querySelector(".win-head");
  let sx, sy, ox, oy, on = false;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    on = true; w.classList.add("dragging"); head.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY; ox = w.offsetLeft; oy = w.offsetTop;
  });
  head.addEventListener("pointermove", (e) => {
    if (!on) return;
    w.style.left = `${Math.max(-w.offsetWidth + 120, Math.min(window.innerWidth - 120, ox + e.clientX - sx))}px`;
    w.style.top = `${Math.max(0, Math.min(window.innerHeight - 44, oy + e.clientY - sy))}px`;
  });
  const end = () => { on = false; w.classList.remove("dragging"); };
  head.addEventListener("pointerup", end); head.addEventListener("pointercancel", end);
  head.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) teleport(id, w.getBoundingClientRect(), true); });
}
function refreshCharts() { requestAnimationFrame(() => Object.values(S.charts).forEach((c) => c?.resize?.())); }

// --- workspace: the teleport target ---
function renderWsNav() {
  $("ws-nav").innerHTML = APPS.map((a) => `<button type="button" data-ws="${a.id}" aria-current="${a.id === WM.ws ? "page" : "false"}"><i data-lucide="${a.icon}"></i><span>${a.title}</span></button>`).join("");
  $("ws-nav").querySelectorAll("[data-ws]").forEach((b) => b.addEventListener("click", () => wsShow(b.dataset.ws)));
  icons();
}
// Sections are MOVED between their window and the workspace, never recreated, so listeners survive.
// Never clear #ws-body with innerHTML: that destroys the section (the old "blank page" bug).
function wsReturn(id) {
  const sec = $(`tab-${id}`); if (!sec) return;
  unpanelize(sec);
  $(`win-${id}`).querySelector(".win-body").appendChild(sec);
}
function wsShow(id) {
  const body = $("ws-body"), sec = $(`tab-${id}`);
  if (!sec) return;
  if (WM.ws && WM.ws !== id) wsReturn(WM.ws);
  WM.ws = id; WM.lastApp = id;
  if (sec.parentElement !== body) body.appendChild(sec);
  panelize(sec);
  $("ws-main").scrollTop = 0;
  renderWsKpis(id);
  const app = APPS.find((a) => a.id === id); $("ws-h1").textContent = app.title; $("ws-sub").textContent = app.sub || "";
  body.classList.remove("ws-enter"); void body.offsetWidth; body.classList.add("ws-enter");
  $("ws-nav").querySelectorAll("[data-ws]").forEach((b) => b.setAttribute("aria-current", b.dataset.ws === id ? "page" : "false"));
  refreshCharts();
  if (id === "ai") aiWelcome();
}
function teleport(id, from, fromWin) {
  const ws = $("workspace"), first = !WM.ws;
  if (first) { ws.hidden = false; renderWsNav(); }
  wsShow(id);
  WM.wsFromWin = fromWin ? id : null;
  if (fromWin) { $(`win-${id}`).hidden = true; }
  if (first && from) {
    const W = window.innerWidth, H = window.innerHeight;
    ws.animate([{ clipPath: `inset(${from.top}px ${W - from.right}px ${H - from.bottom}px ${from.left}px round 18px)` }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 520, easing: ease });
  }
  pause();
}
function backToMap() {
  const ws = $("workspace"), id = WM.ws; if (!id) return;
  const target = WM.wsFromWin && !phone() ? null : dockBtn(id)?.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const done = () => {
    ws.hidden = true;
    wsReturn(id);
    if (WM.wsFromWin && !phone()) { const w = $(`win-${id}`); w.hidden = false; WM.state[id] = "open"; focusWin(id); w.animate([{ transform: "scale(1.04)", opacity: 0.4 }, { transform: "none", opacity: 1 }], { duration: 300, easing: ease }); }
    WM.ws = null; syncDock(); refreshCharts(); map?.resize();
  };
  if (target) ws.animate([{ clipPath: "inset(0px 0px 0px 0px round 0px)" }, { clipPath: `inset(${target.top}px ${W - target.right}px ${H - target.bottom}px ${target.left}px round 14px)` }], { duration: 420, easing: ease }).onfinish = done;
  else ws.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260 }).onfinish = done;
}

// ================= Intro: the logo's radar pulses, then flies into the brand chip =================
const intro = { t0: performance.now(), done: false, hadView: location.hash.includes("view=") };
function finishIntro(now) {
  if (intro.done) return; intro.done = true;
  if (!now && !intro.played) { intro.done = false; setTimeout(() => finishIntro(), 120); return; }
  const wait = now ? 0 : 700; // hold the finished frame a moment
  setTimeout(() => {
    const sp = $("splash"), scan = $("intro-scan"), brand = $("brand-logo");
    if (!sp) return;
    const dur = reduceMotion ? 1 : 950, W = window.innerWidth;
    brand.style.opacity = 1;
    sp.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }], { duration: dur, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" }).onfinish = () => { sp.remove(); scan.remove(); };
    scan.animate([{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${W}px)`, opacity: 1 }], { duration: dur, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" });
    if (!intro.hadView && map) flyBicol(38, -6, 2600);
  }, wait);
}
document.addEventListener("click", (e) => { if (e.target.closest("#splash")) finishIntro(true); });

// ================= 30 m detail layers from the pilot GeoTIFFs =================
const PG_STYLE = {
  // class per 30 m cell: 0 low, 1 watch, 2 high, -1 no radar data (built-up/water, -2, is left clear)
  cls: { name: "Risk classes", stops: [[-1, [154, 165, 159, 110]], [-0.01, [154, 165, 159, 110]], [0, [124, 198, 154, 150]], [0.99, [124, 198, 154, 150]], [1, [238, 159, 39, 160]], [1.99, [238, 159, 39, 160]], [2, [226, 83, 60, 165]]], fmt: (v) => ["low", "watch", "high"][v] || "" },
  score: { name: "Risk score", stops: [[23, [124, 198, 154, 150]], [40, [238, 159, 39, 170]], [70, [226, 83, 60, 190]], [100, [150, 25, 20, 210]]], fmt: (v) => `${Math.round(v)}/100` },
  twi: { name: "Terrain wetness (TWI)", stops: [[5, [240, 248, 250, 40]], [8, [150, 210, 235, 150]], [11, [47, 159, 211, 190]], [15, [20, 60, 140, 215]]], fmt: (v) => v.toFixed(1) },
  dvv: { name: "Radar change ΔVV", stops: [[-8, [16, 60, 150, 220]], [-4, [47, 159, 211, 190]], [-1, [200, 230, 245, 90]], [0, [255, 255, 255, 30]], [3, [201, 166, 107, 170]], [6, [140, 100, 50, 210]]], fmt: (v) => `${v.toFixed(1)} dB` },
  slope: { name: "Slope", stops: [[0, [255, 255, 255, 20]], [2, [210, 200, 235, 120]], [5, [140, 110, 200, 180]], [8, [80, 40, 150, 215]]], fmt: (v) => `${v.toFixed(1)}°` },
};
function pgValue(layer, lon, lat) {
  const G = S.pgrid; if (!G) return null;
  const [w, s, e, n] = G.bounds;
  if (lon < w || lon > e || lat < s || lat > n) return null;
  const x = Math.floor(((lon - w) / (e - w)) * G.width), y = Math.floor(((mercY(n) - mercY(lat)) / (mercY(n) - mercY(s))) * G.height);
  const L = G.layers[layer]; const v = L.values[y * G.width + x];
  return v === G.missing ? null : v / L.scale;
}
function renderPilotGrid() {
  const G = S.pgrid; if (!G || !S.ready) return;
  const k = S.pgLayer;
  if (k === "none") { vis("pgrid", false); return; }
  const st = PG_STYLE[k], vals = G.layers[k].values, sc = G.layers[k].scale, cls = G.layers.cls.values;
  const c = document.createElement("canvas"); c.width = G.width; c.height = G.height;
  const ctx = c.getContext("2d"), img = ctx.createImageData(G.width, G.height), d = img.data;
  const col = (v) => {
    const sp = st.stops; if (v <= sp[0][0]) return sp[0][1]; if (v >= sp[sp.length - 1][0]) return sp[sp.length - 1][1];
    const j = sp.findIndex((q) => q[0] >= v), a = sp[j - 1], b = sp[j], t = (v - a[0]) / (b[0] - a[0]);
    return a[1].map((x, i) => x + (b[1][i] - x) * t);
  };
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === G.missing || cls[i] === -2) continue; // not farmland: leave clear
    const q = col(vals[i] / sc); d[i * 4] = q[0]; d[i * 4 + 1] = q[1]; d[i * 4 + 2] = q[2]; d[i * 4 + 3] = q[3];
  }
  ctx.putImageData(img, 0, 0);
  const [w, s, e, n] = G.bounds;
  registerRaster("pgrid", c, w, e, n, s, false);
  const src = map.getSource("pgrid"), key = `${k}-${Date.now()}`;
  if (!src) {
    map.addSource("pgrid", { type: "raster", tiles: [`saka://pgrid/${key}/{z}/{x}/{y}`], tileSize: 256, minzoom: 10, maxzoom: 17, bounds: [w, s, e, n] });
    map.addLayer({ id: "pgrid", type: "raster", source: "pgrid", minzoom: 11.2, paint: { "raster-opacity": 0.85, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, map.getLayer("plots-fill") ? "plots-fill" : undefined);
  } else src.setTiles([`saka://pgrid/${key}/{z}/{x}/{y}`]);
  vis("pgrid", S.layers.pilot);
  vis("risk-zones", false); // overlapping vector zones doubled their colour; the grid raster replaces them
  renderLegend();
}
function pgReadout(lon, lat) {
  if (!S.pgrid || !S.layers.pilot) return "";
  const sc = pgValue("score", lon, lat); if (sc == null) return "";
  const parts = [`score <b>${Math.round(sc)}</b>`, `TWI <b>${pgValue("twi", lon, lat)?.toFixed(1)}</b>`, `ΔVV <b>${pgValue("dvv", lon, lat)?.toFixed(1)} dB</b>`, `slope <b>${pgValue("slope", lon, lat)?.toFixed(1)}°</b>`];
  return ` <span>|</span> 30 m cell: ${parts.join(", ")}`;
}
function pgInspectHTML(lon, lat) {
  if (!S.pgrid) return "";
  const sc = pgValue("score", lon, lat); if (sc == null) return "";
  const cls = pgValue("cls", lon, lat), lc = pgValue("lc", lon, lat), fl = pgValue("flood", lon, lat);
  const clsName = { 2: "High", 1: "Watch", 0: "Low", "-1": "No radar data", "-2": "Not farmland" }[cls] ?? "n/a";
  return `<div class="sec">30 m cell (risk engine grid)</div>
    <dt>Field Drowning Risk</dt><dd>${Math.round(sc)}/100, ${clsName}</dd>
    <dt>Radar change ΔVV</dt><dd>${pgValue("dvv", lon, lat)?.toFixed(1)} dB</dd>
    <dt>Terrain wetness index</dt><dd>${pgValue("twi", lon, lat)?.toFixed(1)}</dd>
    <dt>Slope</dt><dd>${pgValue("slope", lon, lat)?.toFixed(1)}°</dd>
    <dt>Radar flood mask, 2 Nov</dt><dd>${fl === 1 ? "Water" : "Dry"}</dd>
    <dt>Land cover (WorldCover)</dt><dd>${esc(S.pgrid.worldcover[String(lc)] || "n/a")}</dd>`;
}

// ================= SakaSAR AI: answers grounded in this project's data =================
// Rule-based on purpose: every sentence is built from a dataset value, so nothing is invented.
const AI = { msgs: [], greeted: false, town: null };
function aiContext() {
  const iso = dayISO(S.t), ctx = { iso, day: Math.floor(S.t) };
  if (S.inspect) { ctx.lon = S.inspect.lon; ctx.lat = S.inspect.lat; ctx.town = townAt(ctx.lon, ctx.lat); }
  if (AI.town) ctx.town = AI.town;
  if (!ctx.town && S.inspect) { const n = nearestTown(ctx.lon, ctx.lat); ctx.town = n && S.munis.features.find((f) => f.properties.name === n.name)?.properties; }
  if (ctx.town && ctx.lon == null) { const c = S.townCenters.find((x) => x.name === ctx.town.name && x.province === ctx.town.province); if (c) { ctx.lon = c.lon; ctx.lat = c.lat; } }
  if (ctx.lon != null) ctx.cell = nearestCell(ctx.lon, ctx.lat);
  ctx.plot = S.pilot ? plotFeat(S.plot)?.properties : null;
  return ctx;
}
function renderAIPane() {
  const c = aiContext();
  $("tab-ai").innerHTML = `
    <div class="ai-ctx">
      <span><i data-lucide="calendar"></i>${S.mode === "now" ? `Latest data, ${short(S.tl.lstm_kristine_again?.soil_as_of || c.iso)}` : `Kristine replay, ${short(c.iso)}`}</span>
      <span><i data-lucide="map-pin"></i>${c.town ? esc(c.town.name) : "All of Bicol"}</span>
      ${S.storm?.active ? `<span><i data-lucide="tornado"></i>Kristine ${S.storm.wind} kt</span>` : ""}
    </div>
    <div class="chat" id="chat">${AI.msgs.map(msgHTML).join("")}</div>
    <div class="suggest" id="suggest">${aiSuggestions(c).map((q) => `<button type="button">${esc(q)}</button>`).join("")}</div>
    <form class="ask" id="ask"><input id="ask-in" placeholder="Ask about a town, a field, rain, soil or what to do" autocomplete="off" aria-label="Ask SakaSAR AI" /><button class="btn" aria-label="Send"><i data-lucide="send"></i></button></form>
    <p class="ai-note">SakaSAR AI builds every answer from this project's data (Sentinel-1, NASA POWER, EONET, NASADEM, the soil forecast and the risk engine) with fixed rules. It is not a chat model.</p>`;
  $("suggest").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => aiAsk(b.textContent)));
  $("ask").addEventListener("submit", (e) => { e.preventDefault(); const v = $("ask-in").value.trim(); if (v) { $("ask-in").value = ""; aiAsk(v); } });
  icons();
  const body = $("tab-ai").parentElement; body.scrollTop = body.scrollHeight;
}
function msgHTML(m) {
  if (m.who === "user") return `<div class="msg user">${esc(m.text)}</div>`;
  if (m.typing) return `<div class="msg bot typing"><i></i><i></i><i></i></div>`;
  return `<div class="msg bot"><div class="who"><img src="assets/sakasar-logo.png" alt="" />SakaSAR AI</div>${m.html}${m.src ? `<div class="srcs">${m.src.map((x) => `<span class="src">${esc(x)}</span>`).join("")}</div>` : ""}</div>`;
}
function aiSuggestions(c) {
  const t = c.town ? c.town.name : null;
  return [
    t ? `What should farmers in ${t} do?` : "Which towns need help first?",
    t ? `How bad is the flooding in ${t}?` : "How much farmland flooded?",
    "Will the soil drain this week?",
    t ? `Where does runoff collect in ${t}?` : "What if 150 mm fell?",
    c.lon != null ? "Where does the water go from here?" : "Where does runoff collect?",
    S.pilot ? `Explain the risk for ${S.plot}` : "Where was the storm?",
    t ? `Make a flood report for ${t}` : "What should farmers plant next season?",
    "How accurate is this?",
  ];
}
function aiWelcome() {
  if (!AI.greeted) {
    AI.greeted = true;
    AI.msgs.push({ who: "bot", html: `<p>Click a place on the map or move the timeline, then ask about it: flooding, rain, soil, the storm, a field's risk or what to plant next.</p>` });
  }
  renderAIPane();
}
function aiAsk(q) {
  AI.msgs.push({ who: "user", text: q });
  const tn = S.munis.features.map((f) => f.properties).find((t) => q.toLowerCase().includes(t.name.toLowerCase()));
  if (tn) AI.town = tn;
  const pm = q.match(/PL-0?(\d)/i); if (pm && S.pilot) S.plot = `PL-0${pm[1]}`;
  renderAIPane();
  AI.msgs.push(aiAnswer(q, aiContext())); renderAIPane(); if (tn && !WM.ws) openTown(tn.name, tn.province);
}
function aiAnswer(q, c) {
  const s = q.toLowerCase(), tl = S.tl, sm = S.summary;
  const has = (...w) => w.some((x) => s.includes(x));
  const rainAt = (field) => (c.lon != null ? sample(cellValues(field, c.day), c.lon, c.lat) : null);
  if (has("accura", "hit rate", "trust", "how does", "method", "source", "data")) {
    const pv = S.pilot?.provenance;
    return { who: "bot", src: ["Risk engine", "Sentinel-1", "Soil forecast"], html: `<p>Two honest checks:</p><ul>
      ${pv ? `<li>Of the farmland the radar saw flooded on 2 Nov, <b>${esc(pv.sar_hit_rate)}</b> had already been rated high by the terrain + rain model, which never saw the radar.</li>` : ""}
      ${tl.lstm_hindcast ? `<li>The 7-day soil forecast issued 3 Nov was right within 1 day in <b>${tl.lstm_hindcast.cells.filter((x) => x && Math.abs(x.days_pred - x.days_actual) <= 1).length} of ${tl.lstm_hindcast.cells.filter(Boolean).length}</b> Bicol grid cells.</li>` : ""}
      <li>Limits: C-band radar sees surface water, not root-zone moisture; NASA POWER cells are about 50 km.</li></ul>` };
  }
  if (has("water go", "where does the water", "catchment", "watershed", "upstream", "downstream", "flow path")) {
    if (c.lon == null) return { who: "bot", html: "<p>Click a place on the map first, then ask where its water goes.</p>" };
    const w = traceWater(c.lon, c.lat, true);
    if (!w) return { who: "bot", html: "<p>That spot is outside Bicol's land, so there is no flow path to trace.</p>" };
    return { who: "bot", src: ["NASADEM 200 m"], html: `<p>Water at this spot comes from <b>${fmt(w.areaKm2, 1)} km²</b> of land upstream${w.upTowns.length ? `, across ${w.upTowns.slice(0, 4).map(esc).join(", ")}${w.upTowns.length > 4 ? " and more" : ""}` : ""}. It then flows <b>${fmt(w.lengthKm, 1)} km</b> ${w.endsAtSea ? "to the sea" : "to a low point"}${w.downTowns.length ? `, through ${w.downTowns.map(esc).join(", ")}` : ""}.</p><p>I drew both on the map. Small ditches and canals are not in the 200 m elevation model.</p>` };
  }
  if (has("what if", "more rain", "if it rains")) {
    const m = s.match(/(\d{2,3})\s*mm/); if (!m || !S.runoffVals) return { who: "bot", html: "<p>Tell me an amount, for example \"what if 150 mm fell?\". The slider in Layers does the same.</p>" };
    const r = whatIf(Number(m[1]));
    return { who: "bot", src: ["NASADEM", "Runoff model"], html: `<p>With ${m[1]} mm everywhere, <b>${pct(r.high)}</b> of Bicol's land would be rated high for runoff and ponding (Kristine: ${pct(S.runoff.validation.land_share_high)}). The map now shows that scenario; press Kristine in Layers to reset.</p>` };
  }
  if (has("report", "print", "damage report", "summary for")) {
    const t = c.town; if (!t) return { who: "bot", html: "<p>Click a town on the map first, then ask for its report.</p>" };
    setTimeout(() => townReport(t.name, t.province), 50);
    return { who: "bot", src: ["Sentinel-1", "NASA POWER", "NASADEM", "Soil forecast"], html: `<p>Opening the one-page flood report for <b>${esc(t.name)}</b>. Print it or save it as PDF from the new tab.</p>` };
  }
  if (has("runoff", "ponding", "drainage", "river", "collect", "low-lying", "lowland")) {
    const ro = S.runoff; if (!ro) return { who: "bot", html: "<p>The runoff layer has not loaded yet.</p>" };
    const v = ro.validation, t = c.town, tr = t && ro.towns[`${t.name}|${t.province}`], r = c.lon != null ? runoffAt(c.lon, c.lat) : null;
    return { who: "bot", src: ["NASADEM", "NASA POWER"], html: `<p>${t && tr ? `In <b>${esc(t.name)}</b>, ${pct(tr.high_share)} of the land is rated high for runoff and ponding${r ? `; the spot you clicked scores ${r.score}/100` : ""}.` : `Across Bicol, ${pct(v.land_share_high)} of the land is rated high for runoff and ponding.`}</p>
      <p>The score is SakaSAR's terrain + rain model at 200 m: where NASADEM says water collects, weighted by Kristine's rain. It never saw the radar, yet it rated <b>${pct(v.share_rated_high)}</b> of the farmland the radar saw flooded as high, against ${pct(v.farmland_share_high)} of all farmland.</p>` };
  }
  if (has("storm", "kristine", "typhoon", "wind", "track")) {
    const cp = S.closest;
    return { who: "bot", src: ["NASA EONET"], html: `<p>${S.storm?.active ? `On ${short(c.iso)} Kristine is at ${S.storm.lat.toFixed(1)}°N ${S.storm.lon.toFixed(1)}°E with ${S.storm.wind} kt winds (${S.storm.cat.name}).` : `On ${short(c.iso)} Kristine is not over the region.`} Its closest pass was ${fmt(cp.km)} km from Naga on ${short(phDay(cp.t))} (Philippine time). The centre crossed northern Luzon, so Bicol's flooding came from the storm's southern rain bands, not a direct hit.</p>` };
  }
  if (has("plant", "rotation", "crop", "next season", "legume", "season")) {
    const p = c.plot; if (!p) return { who: "bot", html: "<p>Rotation advice needs a field's soil data; it is available for the sample fields in the Field risk window.</p>" };
    const r = rankRotations(p);
    return { who: "bot", src: ["SoilGrids", "Risk engine"], html: `<p>For ${p.plot_id} (${esc(p.soil_0_30cm?.texture || "")}, risk ${p.risk_score}/100), ranked for <b>${PRIORITIES[S.priority].toLowerCase()}</b>:</p><ul>${r.map((x) => `<li><b>${esc(x.crops)}</b>: ${x.fit ? esc(x.fit.why) : esc(x.benefits)}</li>`).join("")}</ul><p>Confirm seed supply and labour with the Municipal Agriculture Office.</p>` };
  }
  if (has("risk", "score", "pl-", "field")) {
    const p = c.plot; if (!p) return { who: "bot", html: "<p>The field risk file did not load.</p>" };
    return { who: "bot", src: ["Sentinel-1", "NASADEM", "GPM IMERG"], html: `<p><b>${p.plot_id}</b> (${esc(p.barangay)}) scores <b>${p.risk_score}/100, ${RISK_W[p.risk_class].toLowerCase()}</b>.</p><ul>
      <li>Radar: VV dropped ${Math.abs(p.sar_wetness_change_db)} dB after the storm, so the surface got much wetter (+${Math.round(45 * p.s_sar)} points).</li>
      <li>Terrain: wetness index ${p.twi_value}, ground where runoff collects (+${Math.round(35 * p.s_twi)}).</li>
      <li>Rain: ${fmt(S.pilot.provenance.rainfall?.r_total_mm)} mm in the storm window (+${Math.round(20 * p.s_rain)}).</li></ul><p>${esc(p.plain_language_action)}</p>` };
  }
  if (has("soil", "drain", "waterlog", "forecast", "lstm", "week")) {
    const ci = c.cell ?? null, h = ci != null ? tl.lstm_hindcast?.cells?.[ci] : null, g = ci != null ? tl.lstm_kristine_again?.cells?.[ci] : null;
    const where = c.town ? `near ${esc(c.town.name)}` : "across Bicol";
    if (!h) { const v = tl.lstm_hindcast.cells.filter(Boolean), wet = v.filter((x) => x.days_pred >= 5).length; return { who: "bot", src: ["Soil forecast (NASA POWER)"], html: `<p>After the 2 Nov radar pass the soil forecast had roots waterlogged on 5+ of the next 7 days in <b>${wet} of ${v.length}</b> grid cells. Click a place on the map for its own forecast.</p>` }; }
    return { who: "bot", src: ["Soil forecast (NASA POWER)"], html: `<p>Soil ${where}: from 3 Nov the forecast <b>${h.days_pred} of 7 days</b> waterlogged; ${h.days_actual} of 7 actually were. ${h.days_pred >= 5 ? "Keep outlets open all week and hold fertiliser." : h.days_pred >= 2 ? "The root zone should start draining mid-week; reopen outlets after each rain." : "The soil drains this week; field work can resume."}</p>${g ? `<p>If Kristine's rain came again on today's soil (${esc(tl.lstm_kristine_again.soil_as_of)}): ${g.days_waterlogged} of 7 days waterlogged.</p>` : ""}` };
  }
  if (has("rain", "rainfall", "mm")) {
    const today = rainAt("rain"), tot = rainAt("rainsum");
    const rd = regionDaily(), peak = rd.reduce((m, d, i) => (d.max > rd[m].max ? i : m), 0);
    return { who: "bot", src: ["NASA POWER"], html: `<p>${c.lon != null ? `${c.town ? esc(c.town.name) : "Here"} on ${short(c.iso)}: <b>${fmt(today)} mm</b> that day, ${fmt(tot)} mm since 10 Oct.` : `Bicol averaged ${fmt(rd[c.day].mean)} mm on ${short(c.iso)}.`} The wettest day was ${short(tl.days[peak])}, peaking at ${fmt(rd[peak].max)} mm over Bicol land (NASA POWER, ~50 km grid).</p>` };
  }
  if (has("flood", "water", "bad", "damage", "how much")) {
    const t = c.town;
    if (t) return { who: "bot", src: [`Sentinel-1, ${t.sentinel1}`], html: `<p><b>${esc(t.name)}, ${esc(t.province)}</b>: ${fmt(t.flooded_farmland_ha)} ha of ${fmt(t.farmland_ha)} ha farmland under water (radar ${esc(t.sentinel1)}) (${pct(t.flooded_share)}), rank ${t.rank} of ${S.munis.features.length} towns.</p>` };
    return { who: "bot", src: ["Sentinel-1, 28 Oct + 2 Nov"], html: `<p>${fmt(sm.flooded_farmland_ha)} ha of Bicol farmland was still under water after Kristine (radar passes of 28 Oct and 2 Nov), ${pct(sm.flooded_farmland_ha / sm.farmland_ha)} of all farmland. Camarines Sur carried most of it.</p>` };
  }
  if (has("first", "priority", "help", "where", "worst", "which town")) {
    const top = sm.top_municipalities.slice(0, 5);
    return { who: "bot", src: ["Sentinel-1, 28 Oct + 2 Nov"], html: `<p>Send teams first to the towns with the most flooded farmland:</p><ul>${top.map((t) => `<li><b>${esc(t.name)}</b>: ${fmt(t.flooded_farmland_ha)} ha</li>`).join("")}</ul>` };
  }
  if (has("do", "tip", "advice", "should", "help")) {
    const t = c.town, share = t?.flooded_share ?? 0, ci = c.cell, h = ci != null ? tl.lstm_hindcast?.cells?.[ci] : null;
    const tips = !t ? ["Open field outlets and drains after each heavy rain.", "Check the Towns window for where the radar saw water."]
      : share >= 0.15 ? ["Open main drains and canals now; clear debris at bridges.", "Harvest mature rice early instead of risking root rot.", "Hold off fertiliser while water stands.", "Report damage from the radar map instead of waiting for a field survey."]
        : share >= 0.03 ? ["Check low fields near rivers first.", "Open field outlets and dig a shallow trench along the lowest bund.", "Re-check after the next Sentinel-1 pass in 12 days."]
          : ["Little flooding was seen by radar here. Keep routine checks.", "Radar can miss water under tall crops; confirm with barangay reports."];
    return { who: "bot", src: ["Sentinel-1", "Soil forecast", "NASA POWER"], html: `<p>${t ? `For <b>${esc(t.name)}</b> (${pct(share)} of farmland flooded${h ? `, soil forecast waterlogged ${h.days_pred} of 7 days` : ""}):` : "For Bicol farms right now:"}</p><ul>${tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` };
  }
  if (has("hi", "hello", "hey")) return { who: "bot", html: "<p>Hello. Pick a place on the map and ask me about it.</p>" };
  return { who: "bot", html: `<p>I answer from SakaSAR's data, so try one of the questions below, or name a Bicol town (for example "flooding in Bula").</p>` };
}
// proactive tip when a place is clicked while the AI window is open
function aiOnInspect() {
  if (WM.state.ai !== "open" && WM.ws !== "ai") return;
  AI.town = null;
  const c = aiContext();
  if (!c.town) return;
  AI.msgs.push(aiAnswer(`what should farmers do in ${c.town.name}`, c));
  renderAIPane();
}

// ================= Bicol-wide runoff & ponding risk (terrain + rain) and drainage network =================
// Built by pipeline/bicol_runoff.py from NASADEM (200 m) and NASA POWER rain 14–26 Oct; never sees the radar.
function loadImageCanvas(url) {
  return new Promise((res) => { const img = new Image(); img.onload = () => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; c.getContext("2d").drawImage(img, 0, 0); res(c); }; img.onerror = () => res(null); img.src = url; });
}
async function loadRunoff() {
  const ro = S.runoff; if (!ro) return;
  const [disp, vals] = await Promise.all([loadImageCanvas(ro.image), loadImageCanvas(ro.values)]);
  if (!disp || !vals) return;
  const [[w, n], [e], , [, s]] = ro.coordinates;
  registerRaster("runoff", disp, w, e, n, s, false);
  S.runoffVals = { d: vals.getContext("2d").getImageData(0, 0, vals.width, vals.height).data, W: vals.width, H: vals.height, w, e, yN: mercY(n), yS: mercY(s) };
  const go = () => {
    if (!map.getSource("runoff")) {
      map.addSource("runoff", { type: "raster", tiles: ["saka://runoff/v1/{z}/{x}/{y}"], tileSize: 256, minzoom: 5, maxzoom: 13, bounds: [w, s, e, n] });
      map.addLayer({ id: "runoff", type: "raster", source: "runoff", paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.85, 11, 0.45, 13, 0.2], "raster-resampling": "linear", "raster-fade-duration": 0 } }, map.getLayer("field") ? "field" : map.getLayer("towns-fill") ? "towns-fill" : undefined);
      map.addSource("streams", { type: "geojson", data: S.streamsGJ || "data/region/bicol_streams.geojson" });
      map.addLayer({ id: "streams-casing", type: "line", source: "streams", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, ["case", [">=", ["get", "up_km2"], 120], 1, 0], 8.4, ["case", [">=", ["get", "up_km2"], 35], 1, 0], 9.4, 1, 10.5, 1, 11.8, 0], "line-color": "rgba(8,40,70,0.55)", "line-width": ["interpolate", ["linear"], ["get", "up_km2"], 10, 1.4, 100, 2.4, 1000, 3.8, 5000, 5.6] } }, map.getLayer("towns-line") ? "towns-line" : undefined);
      map.addLayer({ id: "streams", type: "line", source: "streams", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, ["case", [">=", ["get", "up_km2"], 120], 1, 0], 8.4, ["case", [">=", ["get", "up_km2"], 35], 1, 0], 9.4, 1, 10.5, 1, 11.8, 0], "line-color": ["interpolate", ["linear"], ["get", "up_km2"], 10, "#9fe3ff", 300, "#4ec4de", 3000, "#2f9fd3"], "line-width": ["interpolate", ["linear"], ["get", "up_km2"], 10, 0.6, 100, 1.2, 1000, 2.4, 5000, 3.8] } }, map.getLayer("towns-line") ? "towns-line" : undefined);
    }
    applyLayers();
  };
  S.ready ? go() : map.once("style.load", go);
}
function runoffAt(lon, lat) {
  const V = S.runoffVals; if (!V || lon < V.w || lon > V.e) return null;
  const x = Math.floor(((lon - V.w) / (V.e - V.w)) * V.W), y = Math.floor(((V.yN - mercY(lat)) / (V.yN - V.yS)) * V.H);
  if (y < 0 || y >= V.H) return null;
  const i = (y * V.W + x) * 4; if (!V.d[i + 3]) return null;
  return { score: V.d[i], twi: V.d[i + 1] / 10 };
}
function runoffClass(v) { return v >= 70 ? "high" : v >= 40 ? "watch" : "low"; }

// ================= Benchmarks (pipeline/benchmarks.py → data/region/benchmarks.json, docs/BENCHMARKS.md) =================
function benchHTML(B) {
  const fr = B.forecast_regional, fo = B.forecast.root_zone, ri = B.rain_interpolation, ru = B.runoff, sp = B.speed;
  const row = (k, v, n) => `<tr><td>${k}</td><td><b>${v}</b></td><td>${n}</td></tr>`;
  return `<p class="h">Benchmarks</p>
    <table class="bench"><thead><tr><th>Algorithm</th><th>Result</th><th>Compared with</th></tr></thead><tbody>
      ${row("Field Drowning Risk, terrain + rain", B.field_risk.independent_hit_rate, "radar-flooded farmland, 30 m pilot")}
      ${row("Runoff &amp; ponding, all of Bicol", pct(ru.share_rated_high), `${pct(ru.farmland_share_high)} of all farmland (×${ru.lift_over_farmland})`)}
      ${row("Soil forecast, 7 days", `${fo.skill_vs_persistence_pct}% lower error`, `persistence; ${fo.skill_vs_ridge_pct}% vs ridge regression`)}
      ${row("Soil forecast, wet weeks", `${fo.skill_vs_persistence_wet_weeks_pct}% lower error`, `persistence, ${fo.wet_weeks} wet weeks`)}
      ${row("Forecast, all Bicol cells", `${fr.within_1_day} of ${fr.cells}`, "waterlogged days right within 1 day")}
      ${row("Rain interpolation (bilinear)", `${ri.mae_bilinear_mm} mm`, `${ri.mae_nearest_mm} mm nearest neighbour (leave-one-out)`)}
      ${row("Closest pass to Naga", `${B.storm_geometry.track_line_km} km`, `${B.storm_geometry.nearest_fix_km} km to the nearest fix`)}
      ${row("Hydrology, 1.8 M cells", `${(sp.priority_flood_sec + sp.d8_sec + sp.flow_accumulation_sec).toFixed(1)} s`, "fill + D8 + accumulation")}
      ${sp.forecast_inference_35_cells_ms ? row("Forecast inference", `${sp.forecast_inference_35_cells_ms} ms`, `35 cells, ${sp.forecast_parameters.toLocaleString()} parameters`) : ""}
    </tbody></table>
    <p class="note">The soil forecast is an LSTM neural network trained on NASA POWER (2001–2018), validated 2019–2021 and tested 2022–2026. Full tables: docs/BENCHMARKS.md, rebuilt with <b>python -m pipeline.benchmarks</b>.</p>`;
}
function renderForecastKpis() {
  const B = S.bench; if (!B || $("fc-kpis")) return;
  const fo = B.forecast.root_zone, fr = B.forecast_regional;
  $("ai-seg").insertAdjacentHTML("afterend", `<div class="fc-kpis" id="fc-kpis">
    <div><b>${fo.skill_vs_persistence_pct}%</b><span>lower error than assuming no change (test years 2022–2026)</span></div>
    <div><b>${fr.within_1_day} of ${fr.cells}</b><span>Bicol cells right within 1 day after Kristine</span></div></div>`);
}

// ================= Town flood report (one page, printable) =================
function townReport(name, province) {
  const f = S.munis.features.find((x) => x.properties.name === name && x.properties.province === province); if (!f) return;
  const t = f.properties, cen = S.townCenters.find((x) => x.name === name && x.province === province);
  const tl = S.tl, ci = nearestCell(cen.lon, cen.lat);
  const storm = tl.cells.length ? sample(tl.cells.map((_, i) => tl.days.reduce((a, d, k) => (d >= "2024-10-21" && d <= "2024-10-26" ? a + (tl.rain_mm[i][k] || 0) : a), 0)), cen.lon, cen.lat) : null;
  const h = tl.lstm_hindcast?.cells?.[ci], ro = S.runoff?.towns?.[`${name}|${province}`];
  const share = t.flooded_share;
  const acts = share >= 0.15 ? ["Send Municipal Agriculture Office teams here first.", "Open main drains and canals; clear debris at bridges.", "Harvest mature rice early; hold fertiliser while water stands.", "File the damage report from this radar evidence instead of waiting for a field survey."]
    : share >= 0.03 ? ["Check low fields near rivers and lakes first.", "Advise farmers to open outlets and dig drainage trenches.", "Re-check after the next Sentinel-1 pass (every 12 days)."]
      : ["Little flooded farmland seen by radar: routine monitoring.", "Confirm with barangay reports; radar can miss water under tall crops."];
  let snap = ""; try { snap = map.getCanvas().toDataURL("image/jpeg", 0.85); } catch (_) {}
  const w = window.open("", "_blank"); if (!w) { toast("Allow pop-ups to open the report."); return; }
  const today = new Date().toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" });
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SakaSAR flood report: ${esc(name)}</title>
  <style>body{font:14px/1.5 Inter,system-ui,sans-serif;color:#0f1f17;max-width:820px;margin:28px auto;padding:0 24px}
  header{display:flex;align-items:center;gap:12px;border-bottom:2px solid #17643a;padding-bottom:12px}header img{width:44px;height:44px}
  h1{font-size:24px;margin:0;letter-spacing:-.02em}h2{font-size:15px;margin:22px 0 8px;color:#17643a}.muted{color:#5f7468;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.k{border:1px solid #dfe8e2;border-radius:10px;padding:10px}.k b{display:block;font-size:22px}
  table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid #edf2ee}td:last-child{text-align:right;font-weight:600}
  img.map{width:100%;border-radius:10px;margin-top:6px}ol li{margin:4px 0}@media print{button{display:none}body{margin:0}}</style></head><body>
  <header><img src="${location.origin}${location.pathname.replace(/[^/]*$/, "")}assets/sakasar-logo.png" alt=""><div><h1>${esc(name)}, ${esc(province)}</h1>
  <div class="muted">SakaSAR flood report after Typhoon Kristine (21–26 Oct 2024). Generated ${today}.</div></div>
  <button onclick="print()" style="margin-left:auto;padding:8px 14px;border:0;border-radius:8px;background:#17643a;color:#fff;cursor:pointer">Print or save PDF</button></header>
  <h2>Flooded farmland (Sentinel-1 radar)</h2>
  <div class="grid"><div class="k"><b>${fmt(t.flooded_farmland_ha)} ha</b>flooded farmland</div><div class="k"><b>${pct(share)}</b>of ${fmt(t.farmland_ha)} ha farmland</div><div class="k"><b>${t.rank} of ${S.munis.features.length}</b>rank among Bicol towns</div></div>
  <p class="muted">Radar pass: ${esc(t.sentinel1)}. 100 m screening on ESA WorldCover cropland; water under tall canopy or between buildings can be missed.</p>
  <h2>Conditions</h2><table>
  <tr><td>Storm rain, 21–26 Oct (NASA POWER, ~50 km grid)</td><td>${fmt(storm)} mm</td></tr>
  ${ro ? `<tr><td>Land rated high for runoff and ponding (terrain + rain, 200 m)</td><td>${pct(ro.high_share)}</td></tr>` : ""}
  ${h ? `<tr><td>Soil forecast after 2 Nov: days waterlogged of the next 7</td><td>${h.days_pred} (actual ${h.days_actual})</td></tr>` : ""}
  <tr><td>Kristine's closest pass to Naga City (NASA EONET)</td><td>${fmt(S.closest?.km)} km</td></tr></table>
  <h2>Priority actions</h2><ol>${acts.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>
  ${snap ? `<h2>Map at the time of the report</h2><img class="map" src="${snap}" alt="Map snapshot">` : ""}
  <p class="muted" style="margin-top:20px">Sources: Copernicus Sentinel-1 (ESA), NASA POWER, NASA EONET, NASADEM, ESA WorldCover. Screening estimate to support, not replace, the Municipal Agriculture Office's verification. sakasar.earth</p>
  </body></html>`);
  w.document.close();
}

// ================= Farmer card: one traffic light, one sentence, three actions, one SMS =================
const FARM_ACTS = {
  high: ["Open field outlets and cut a 30 cm trench along the lowest bund within 48 hours.", "Harvest mature rice early instead of risking root rot.", "Hold fertiliser and seed until the water drains."],
  watch: ["Check the low corners after each heavy rain.", "Keep outlets clear; reopen the trench if it silts up.", "Delay fertiliser by a few days if puddles stay."],
  low: ["Normal field work; keep outlets clear.", "Plan the next crop (see next-season options).", "Re-check after the next storm warning."],
};
const FARM_SAY = { high: "Your field is likely to drown. Act in the next 48 hours.", watch: "Parts of your field may stay waterlogged. Check it after rain.", low: "Low drowning risk. Keep outlets clear." };
// best available evidence at a point: 30 m risk grid (pilot) → radar flood + 200 m runoff (all of Bicol)
function farmerAt(lon, lat, town) {
  const sc = pgValue("score", lon, lat);
  if (sc != null && pgValue("cls", lon, lat) !== -2) return { score: Math.round(sc), cls: runoffClass(sc), basis: "30 m Field Drowning Risk (radar + terrain + rain)", town, flooded: pgValue("flood", lon, lat) === 1 };
  const br = briskAt(lon, lat);
  if (br && br.cls >= 0) return { score: br.score, cls: ["low", "watch", "high"][br.cls], basis: "100 m Field Drowning Risk after Kristine (radar + terrain + rain)", town, flooded: floodAt(lon, lat) === "flooded" };
  const r = runoffAt(lon, lat), fl = floodAt(lon, lat);
  if (!r) return null;
  // evidence ladder: radar water (observed) > runoff model (modelled, capped at watch); never call non-farmland a field
  if (fl === "other") return { score: null, cls: "low", nonfarm: true, town, basis: "ESA WorldCover land cover via the radar map", say: "This spot is not farmland on the land-cover map. Click on a field, or trace one with Check my field." };
  if (fl === "flooded") return { score: null, seen: true, cls: "high", town, flooded: true, basis: "Radar saw water here after Kristine (Sentinel-1)", say: "The radar saw water on this farmland after Kristine. Act in the next 48 hours." };
  const cls = r.score >= 70 ? "watch" : runoffClass(r.score);
  return { score: r.score, cls, town, coarse: true, basis: "200 m runoff model (terrain + rain); radar saw no water here",
    say: cls === "watch" ? "Water tends to collect here (terrain + rain model, not observed). Check this field after heavy rain." : null };
}
function smsFor(f, areaHa) {
  const where = f.town ? f.town.name : "your area";
  const act = f.cls === "high" ? "Open outlets, trench lowest bund in 48h; harvest mature rice early." : f.cls === "watch" ? "Check low corners after rain; keep outlets clear." : "Normal work; keep outlets clear.";
  const s = `SAKASAR: Field${areaHa ? ` ${fmt(areaHa, 1)}ha` : ""} in ${where}: ${f.cls.toUpperCase()} drowning risk${f.score != null ? ` (${f.score}/100)` : f.seen ? " (radar saw water)" : ""}. ${act}`;
  return s.length <= 160 ? s : s.slice(0, 157) + "...";
}
function farmerCard(f, areaHa) {
  if (!f) return "";
  if (f.nonfarm) return `<div class="farmer na"><div class="farmer-top"><span class="light"></span><div><b>Not farmland</b><p>${esc(f.say)}</p></div></div></div>`;
  const sms = smsFor(f, areaHa);
  return `<div class="farmer ${f.cls}">
    <div class="farmer-top"><span class="light"></span><div><b>${RISK_W[f.cls]} drowning risk${f.score != null ? `, ${f.score}/100` : f.seen ? ": radar saw water" : ""}${f.coarse ? " (modelled)" : ""}</b><p>${esc(f.say || FARM_SAY[f.cls])}</p></div></div>
    <ol>${FARM_ACTS[f.cls].map((a) => `<li>${esc(a)}</li>`).join("")}</ol>
    <div class="sms small">${esc(sms)}</div>
    <div class="sms-meta"><span>${sms.length}/160, ${esc(f.basis)}</span><button type="button" class="link-btn" data-sms="${esc(sms)}"><i data-lucide="copy"></i>Copy</button></div>
  </div>`;
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sms]"); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.sms); toast("SMS text copied."); } catch (_) { toast("Select the text to copy it."); }
});

// ================= Check my field: trace a real field, score exactly the cells inside it =================
S.draw = { on: false, pts: [] };
function drawStart() {
  if (WM.ws) backToMap();
  S.draw = { on: true, pts: [] };
  $("drawbar").hidden = false; $("draw-finish").disabled = true;
  map.doubleClickZoom.disable(); map.getCanvas().style.cursor = "crosshair";
  if (map.getZoom() < 12) flyToPilot();
  drawRender(); icons();
}
function drawStop() {
  S.draw.on = false; $("drawbar").hidden = true; map.getCanvas().style.cursor = "";
  setTimeout(() => map.doubleClickZoom.enable(), 300);
}
function drawAdd(ll) {
  S.draw.pts.push([ll.lng, ll.lat]); drawRender();
  $("draw-finish").disabled = S.draw.pts.length < 3;
  if (S.draw.pts.length >= 3) $("draw-msg").textContent = `${S.draw.pts.length} corners, about ${fmt(polyHa(S.draw.pts), 2)} ha. Double-click or press Finish.`;
}
function drawRender() {
  const pts = S.draw.pts, ring = pts.length >= 3 ? [...pts, pts[0]] : pts;
  const fc = { type: "FeatureCollection", features: [
    ...(pts.length >= 3 ? [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} }] : []),
    ...(pts.length >= 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: {} }] : []),
    ...pts.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: {} })) ] };
  if (!map.getSource("myfield")) {
    map.addSource("myfield", { type: "geojson", data: fc });
    map.addLayer({ id: "myfield-fill", type: "fill", source: "myfield", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#ffd166", "fill-opacity": 0.12 } });
    map.addLayer({ id: "myfield-line", type: "line", source: "myfield", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#ffd166", "line-width": 3 } });
    map.addLayer({ id: "myfield-pts", type: "circle", source: "myfield", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#e0a800", "circle-stroke-width": 2 } });
  } else map.getSource("myfield").setData(fc);
}
function polyHa(pts) {
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length, kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * kx * y2 * ky - x2 * kx * y1 * ky; }
  return Math.abs(a) / 2 / 10000;
}
// statistics from exactly the cells whose centres fall inside the traced field
function fieldStats(pts) {
  const ring = [...pts, pts[0]], xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [mnx, mxx, mny, mxy] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const G = S.pgrid, out = { ha: polyHa(pts), lon: (mnx + mxx) / 2, lat: (mny + mxy) / 2 };
  out.town = townAt(out.lon, out.lat);
  if (G) {
    const [w, s, e, n] = G.bounds, yN = mercY(n), yS = mercY(s), sc = [], fl = [], dv = [], tw = [], lc = {};
    for (let y = 0; y < G.height; y++) {
      const la = latFromMercY(yN - ((y + 0.5) / G.height) * (yN - yS)); if (la < mny || la > mxy) continue;
      for (let x = 0; x < G.width; x++) {
        const lo = w + ((x + 0.5) / G.width) * (e - w); if (lo < mnx || lo > mxx || !pointInRing(lo, la, ring)) continue;
        const i = y * G.width + x, v = G.layers.score.values[i]; if (v === G.missing) continue;
        sc.push(v); fl.push(G.layers.flood.values[i]); dv.push(G.layers.dvv.values[i] / 10); tw.push(G.layers.twi.values[i] / 10);
        const k = G.worldcover[String(G.layers.lc.values[i])] || "Other"; lc[k] = (lc[k] || 0) + 1;
      }
    }
    if (sc.length) {
      const sorted = [...sc].sort((a, b) => a - b), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      Object.assign(out, { basis: "30m", cells: sc.length, score: sorted[Math.floor(sorted.length / 2)], high: sc.filter((v) => v >= 70).length / sc.length,
        watch: sc.filter((v) => v >= 40 && v < 70).length / sc.length, low: sc.filter((v) => v < 40).length / sc.length,
        flooded: mean(fl), dvv: mean(dv), twi: mean(tw), lc });
      return out;
    }
  }
  // outside the 30 m pilot: radar flood pixels + 200 m runoff cells inside the field
  const V = S.runoffVals, rs = []; let fpx = 0, fflood = 0;
  if (V) for (let y = 0; y < V.H; y++) {
    const la = latFromMercY(V.yN - ((y + 0.5) / V.H) * (V.yN - V.yS)); if (la < mny || la > mxy) continue;
    for (let x = 0; x < V.W; x++) { const lo = V.w + ((x + 0.5) / V.W) * (V.e - V.w); if (lo >= mnx && lo <= mxx && pointInRing(lo, la, ring) && V.d[(y * V.W + x) * 4 + 3]) rs.push(V.d[(y * V.W + x) * 4]); }
  }
  if (R.flood) for (let y = 0; y < R.fh; y++) {
    const la = latFromMercY(R.fyN - ((y + 0.5) / R.fh) * (R.fyN - R.fyS)); if (la < mny || la > mxy) continue;
    for (let x = 0; x < R.fw; x++) { const lo = R.fW + ((x + 0.5) / R.fw) * (R.fE - R.fW); if (lo < mnx || lo > mxx || !pointInRing(lo, la, ring)) continue;
      const a = R.flood[(y * R.fw + x) * 4 + 3]; if (a > 0) { fpx++; if (a >= 200) fflood++; } }
  }
  const B = S.briskVals, bs = [];
  if (B) for (let y = 0; y < B.H; y++) {
    const la = latFromMercY(B.yN - ((y + 0.5) / B.H) * (B.yN - B.yS)); if (la < mny || la > mxy) continue;
    for (let x = 0; x < B.W; x++) { const lo = B.w + ((x + 0.5) / B.W) * (B.e - B.w); const i = (y * B.W + x) * 4;
      if (lo >= mnx && lo <= mxx && B.d[i + 3] && B.d[i + 1] >= 2 && pointInRing(lo, la, ring)) bs.push(B.d[i]); }
  }
  if (bs.length) { bs.sort((a, b) => a - b); out.risk100 = { cells: bs.length, score: bs[Math.floor(bs.length / 2)], high: bs.filter((v) => v >= 70).length / bs.length }; }
  if (!rs.length) { const r = runoffAt(out.lon, out.lat); if (r) rs.push(r.score); }
  rs.sort((a, b) => a - b);
  Object.assign(out, { basis: "coarse", cells: rs.length, score: rs.length ? rs[Math.floor(rs.length / 2)] : null, farmPx: fpx, flooded: fpx ? fflood / fpx : null });
  return out;
}
function drawFinish() {
  if (S.draw.pts.length < 3) return;
  const pts = S.draw.pts.slice(); drawStop();
  const st = fieldStats(pts);
  const r100 = st.basis !== "30m" ? st.risk100 : null;
  const cls = st.basis === "30m" ? runoffClass(st.score) : r100 ? runoffClass(r100.score) : st.flooded > 0.2 ? "high" : Math.min(st.score ?? 0, 69) >= 40 ? "watch" : "low";
  const f = { score: r100 ? r100.score : st.score, cls, town: st.town, basis: st.basis === "30m" ? `${st.cells} cells of the 30 m risk grid` : r100 ? `${r100.cells} farmland cells of the 100 m Field Drowning Risk` : "radar flood map + 200 m runoff (coarser outside the 30 m pilot)" };
  const box = $("inspector");
  $("insp-title").textContent = `Your field${st.town ? `, ${st.town.name}` : ""}`;
  $("insp-body").innerHTML = `${farmerCard(f, st.ha)}
    <dl class="kv">
      <dt>Area traced</dt><dd>${fmt(st.ha, 2)} ha</dd>
      ${st.basis === "30m" ? `<div class="sec">Inside your field (30 m cells)</div>
      <dt>Field score (median)</dt><dd>${st.score}/100</dd>
      <dt>High / watch / low</dt><dd>${pct(st.high)} / ${pct(st.watch)} / ${pct(st.low)}</dd>
      <dt>Under water on 2 Nov (radar)</dt><dd>${pct(st.flooded)}</dd>
      <dt>Radar change ΔVV (mean)</dt><dd>${st.dvv.toFixed(1)} dB</dd>
      <dt>Terrain wetness index (mean)</dt><dd>${st.twi.toFixed(1)}</dd>
      <dt>Land cover</dt><dd>${Object.entries(st.lc).map(([k, v]) => `${esc(k)} ${Math.round((100 * v) / st.cells)}%`).join(", ")}</dd>`
      : `<div class="sec">Inside your field (outside the 30 m pilot)</div>
      ${r100 ? `<dt>Field Drowning Risk, 100 m (median of ${r100.cells} cells)</dt><dd>${r100.score}/100</dd><dt>Share rated high</dt><dd>${pct(r100.high)}</dd>` : ""}
      <dt>Runoff & ponding score (median of ${st.cells} cells)</dt><dd>${st.score ?? "n/a"}/100</dd>
      <dt>Farmland seen under water (radar)</dt><dd>${st.flooded != null ? pct(st.flooded) : "no farmland pixels"}</dd>
      <p class="note" style="grid-column:1/-1">Outside the pilot only coarser data exist (radar flood map ~150 m, runoff 200 m). Treat this as a screening; a 30 m run for your barangay needs the risk engine.</p>`}
    </dl>`;
  box.hidden = false; box.style.zIndex = String(++WM.z); box.classList.remove("pop"); void box.offsetWidth; box.classList.add("pop");
  icons();
}
function bindDraw() {
  $("btn-check").addEventListener("click", () => (S.draw.on ? drawStop() : drawStart()));
  $("draw-undo").addEventListener("click", () => { S.draw.pts.pop(); drawRender(); $("draw-finish").disabled = S.draw.pts.length < 3; });
  $("draw-cancel").addEventListener("click", () => { drawStop(); S.draw.pts = []; drawRender(); });
  $("draw-finish").addEventListener("click", drawFinish);
  document.addEventListener("keydown", (e) => { if (S.draw.on && e.key === "Escape") { drawStop(); S.draw.pts = []; drawRender(); } if (S.draw.on && e.key === "Enter") drawFinish(); });
}

// ================= Watershed tracing on NASADEM D8 (all of Bicol, 200 m) =================
// Upstream catchment = every cell whose flow path passes through the clicked cell (breadth-first over reversed D8);
// downstream path = follow receivers to the coast or a low point. Cell↔lon/lat via a fitted 2nd-order polynomial.
async function loadFlow(meta) {
  const c = await loadImageCanvas(meta.image); if (!c) return;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, code = new Uint8Array(meta.width * meta.height);
  for (let i = 0; i < code.length; i++) code[i] = d[i * 4];
  // flow accumulation (cells draining through each cell), topological order over D8 — used to snap clicks to channels
  const W = meta.width, H = meta.height, off = meta.offsets, recv = new Int32Array(W * H).fill(-1), indeg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const k = code[i]; if (k > 7) continue; const r = (i / W) | 0, nr = r + off[k][0], nc = i - r * W + off[k][1];
    if (nr >= 0 && nc >= 0 && nr < H && nc < W) { recv[i] = nr * W + nc; indeg[recv[i]]++; } }
  const acc = new Float32Array(W * H).fill(1), q = new Int32Array(W * H); let qh = 0, qt = 0;
  for (let i = 0; i < W * H; i++) if (!indeg[i] && code[i] <= 7) q[qt++] = i;
  while (qh < qt) { const i = q[qh++], j = recv[i]; if (j < 0) continue; acc[j] += acc[i]; if (--indeg[j] === 0 && code[j] <= 7) q[qt++] = j; }
  S.flow = { ...meta, code, acc };
}
const poly2 = (k, a, b) => k[0] + k[1] * a + k[2] * b + k[3] * a * a + k[4] * a * b + k[5] * b * b;
const cellLL = (c, r) => [poly2(S.flow.cell_to_lonlat.lon, c + 0.5, r + 0.5), poly2(S.flow.cell_to_lonlat.lat, c + 0.5, r + 0.5)];
function llCell(lon, lat) { const F = S.flow; return [Math.floor(poly2(F.lonlat_to_cell.col, lon, lat)), Math.floor(poly2(F.lonlat_to_cell.row, lon, lat))]; }
function traceWater(lon, lat, quiet) {
  const F = S.flow; if (!F) return null;
  let [c, r] = llCell(lon, lat); const W = F.width, H = F.height, code = F.code, off = F.offsets;
  if (c < 0 || r < 0 || c >= W || r >= H || code[r * W + c] === 254) { if (!quiet) toast("Outside Bicol's land: no flow path to trace."); return null; }
  // pour-point snapping: move the click to the biggest drainage line within ~1 km (5 cells), as GIS tools do
  let start = r * W + c, snappedM = 0;
  if (F.acc && F.acc[start] < 25) {
    let best = start;
    for (let dr = -5; dr <= 5; dr++) for (let dc = -5; dc <= 5; dc++) {
      const rr = r + dr, cc2 = c + dc; if (rr < 0 || cc2 < 0 || rr >= H || cc2 >= W) continue;
      const j = rr * W + cc2; if (code[j] <= 7 && F.acc[j] > F.acc[best]) best = j;
    }
    if (best !== start && F.acc[best] >= 25) { const br = (best / W) | 0; snappedM = Math.round(Math.hypot(br - r, best - br * W - c) * F.cell_m); start = best; r = br; c = best - br * W; }
  }
  // upstream: reversed D8, breadth-first
  const seen = new Uint8Array(W * H), q = new Int32Array(W * H); let qh = 0, qt = 0; q[qt++] = start; seen[start] = 1;
  let mnc = c, mxc = c, mnr = r, mxr = r;
  while (qh < qt) {
    const i = q[qh++], ir = (i / W) | 0, ic = i - ir * W;
    for (let k = 0; k < 8; k++) {
      const nr = ir - off[k][0], nc = ic - off[k][1]; // neighbour that would drain INTO i via direction k
      if (nr < 0 || nc < 0 || nr >= H || nc >= W) continue;
      const j = nr * W + nc; if (seen[j] || code[j] !== k) continue;
      seen[j] = 1; q[qt++] = j; if (nc < mnc) mnc = nc; if (nc > mxc) mxc = nc; if (nr < mnr) mnr = nr; if (nr > mxr) mxr = nr;
    }
  }
  const n = qt, areaKm2 = n * (F.cell_m / 1000) ** 2;
  // downstream path
  const path = [cellLL(c, r)]; let lengthM = 0, cur = start, endsAtSea = false;
  for (let step = 0; step < 6000; step++) {
    const k = code[cur]; if (k === 255) break; if (k === 254) { endsAtSea = true; break; }
    const cr = (cur / W) | 0, cc = cur - cr * W, nr = cr + off[k][0], ncl = cc + off[k][1];
    if (nr < 0 || ncl < 0 || nr >= H || ncl >= W) { endsAtSea = true; break; }
    lengthM += off[k][0] && off[k][1] ? F.cell_m * Math.SQRT2 : F.cell_m; cur = nr * W + ncl; path.push(cellLL(ncl, nr));
    if (code[cur] === 254) { endsAtSea = true; break; }
  }
  // towns along the way (sampled)
  const downTowns = [...new Set(path.filter((_, i) => i % 5 === 0).map((p) => townAt(p[0], p[1])?.name).filter(Boolean))];
  const upSet = new Set(); for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 400))) { const ir = (q[i] / W) | 0, [a, b] = cellLL(q[i] - ir * W, ir); const t = townAt(a, b); if (t) upSet.add(t.name); }
  // draw: catchment as a raster (cells → Web Mercator canvas), path as a line
  const [w0, n0] = cellLL(mnc, mnr), [e0, s0] = cellLL(mxc + 1, mxr + 1), pad = 0.003;
  const bw = Math.min(w0, cellLL(mnc, mxr + 1)[0]) - pad, be = Math.max(e0, cellLL(mxc + 1, mnr)[0]) + pad;
  const bn = Math.max(n0, cellLL(mxc + 1, mnr)[1]) + pad, bs = Math.min(s0, cellLL(mnc, mxr + 1)[1]) - pad;
  const PX = Math.min(1400, Math.max(64, (mxc - mnc + 3) * 2)), PY = Math.max(32, Math.round(PX * (mercY(bn) - mercY(bs)) / (((be - bw) * Math.PI) / 180)));
  const cv = document.createElement("canvas"); cv.width = PX; cv.height = PY; const g = cv.getContext("2d");
  g.fillStyle = "rgba(0, 170, 190, 0.42)";
  const cellPx = Math.max(1, Math.ceil((PX / (be - bw)) * (F.cell_m / 111320)) + 1);
  for (let i = 0; i < n; i++) { const ir = (q[i] / W) | 0, [a, b] = cellLL(q[i] - ir * W, ir); g.fillRect(((a - bw) / (be - bw)) * PX - cellPx / 2, ((mercY(bn) - mercY(b)) / (mercY(bn) - mercY(bs))) * PY - cellPx / 2, cellPx, cellPx); }
  registerRaster("catch", cv, bw, be, bn, bs, false);
  const key = Date.now();
  if (!map.getSource("catch")) {
    map.addSource("catch", { type: "raster", tiles: [`saka://catch/${key}/{z}/{x}/{y}`], tileSize: 256, maxzoom: 14 });
    map.addLayer({ id: "catch", type: "raster", source: "catch", paint: { "raster-opacity": 0.9, "raster-fade-duration": 0 } });
    map.addSource("flowpath", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: path } } });
    map.addLayer({ id: "flowpath-casing", type: "line", source: "flowpath", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#063b52", "line-width": 6 } });
    map.addLayer({ id: "flowpath", type: "line", source: "flowpath", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#7fe9ff", "line-width": 3, "line-dasharray": [2, 1.4] } });
  } else {
    map.getSource("catch").setTiles([`saka://catch/${key}/{z}/{x}/{y}`]);
    map.getSource("flowpath").setData({ type: "Feature", geometry: { type: "LineString", coordinates: path } });
  }
  ["catch", "flowpath-casing", "flowpath"].forEach((id) => vis(id, true));
  const res = { areaKm2, lengthKm: lengthM / 1000, endsAtSea, downTowns, upTowns: [...upSet], cells: n, snappedM };
  if (!quiet) {
    const box = $("inspector");
    $("insp-title").textContent = "Where the water goes";
    $("insp-body").innerHTML = `<div class="water-card">
      <div><b>${fmt(areaKm2, areaKm2 < 10 ? 2 : 0)} km²</b><span>of land drains to this spot (upstream catchment)</span></div>
      <div><b>${fmt(res.lengthKm, 1)} km</b><span>flow path ${endsAtSea ? "to the sea" : "to a low point"}</span></div></div>
      <dl class="kv">
        <dt>Upstream towns</dt><dd>${res.upTowns.length ? res.upTowns.slice(0, 6).map(esc).join(", ") + (res.upTowns.length > 6 ? ` +${res.upTowns.length - 6}` : "") : "this town only"}</dd>
        <dt>Downstream towns</dt><dd>${downTowns.length ? downTowns.map(esc).join(" → ") : "n/a"}</dd>
        <div class="sec">What it means</div>
      </dl>
      <ul class="actions">
        <li>${areaKm2 > 50 ? "A large area drains here: water keeps arriving for days after the rain stops. Clear the outlet channel before the next storm." : areaKm2 > 5 ? "A medium catchment drains here: expect runoff for a day or two after heavy rain." : "A small catchment: local rain matters most; field outlets and bunds are the main defence."}</li>
        <li>Coordinate drainage work with the upstream barangays listed above; their runoff reaches this spot.</li>
        <li>The dashed line shows where to keep channels open so water can leave.</li>
      </ul>
      ${snappedM ? `<p class="note">Snapped ${fmt(snappedM)} m to the nearest drainage line, where the water from your spot joins.</p>` : ""}
      <p class="note" style="margin-top:10px">NASADEM 200 m, depressions filled, D8 flow (${n.toLocaleString()} cells). Small ditches, canals and culverts are not in the elevation model.</p>
      <button type="button" class="btn ghost" id="water-clear" style="margin-top:10px"><i data-lucide="eraser"></i>Clear</button>`;
    box.hidden = false; box.style.zIndex = String(++WM.z); $("insp-body").scrollTop = 0; icons();
    $("water-clear").addEventListener("click", () => { ["catch", "flowpath-casing", "flowpath"].forEach((id) => vis(id, false)); box.hidden = true; });
    if (areaKm2 > 1) map.fitBounds([[bw, bs], [be, bn]].map((p, i) => p), { padding: chromePadding(), maxZoom: 13, duration: 1200, pitch: tilt(30) });
  }
  return res;
}

// ================= Rain what-if: recompute the Bicol runoff layer for a uniform storm rain =================
const WI_STOPS = [[60, [190, 225, 240, 0]], [66, [150, 205, 235, 110]], [70, [47, 159, 211, 170]], [82, [27, 95, 170, 200]], [100, [40, 30, 120, 225]]];
function whatIf(mm) {
  const V = S.runoffVals; if (!V) return null;
  const real = mm <= 0, c = document.createElement("canvas"); c.width = V.W; c.height = V.H;
  const g = c.getContext("2d"), img = g.createImageData(V.W, V.H), d = img.data, sRain = Math.min(1, mm / 300);
  let land = 0, high = 0;
  for (let i = 0; i < V.W * V.H; i++) {
    if (!V.d[i * 4 + 3]) continue;
    land++;
    const sc = real ? V.d[i * 4] : Math.round((100 * (0.35 * Math.min(1, Math.max(0, (V.d[i * 4 + 1] / 10 - 5) / 10)) + 0.2 * sRain)) / 0.55);
    if (sc >= 70) high++;
    if (sc < 60) continue;
    let j = WI_STOPS.findIndex((s) => s[0] >= sc); if (j <= 0) j = 1;
    const a = WI_STOPS[j - 1], b = WI_STOPS[j], f = Math.min(1, (sc - a[0]) / (b[0] - a[0]));
    for (let k = 0; k < 4; k++) d[i * 4 + k] = a[1][k] + (b[1][k] - a[1][k]) * f;
  }
  g.putImageData(img, 0, 0);
  const ro = S.runoff, [[w, n], [e], , [, s]] = ro.coordinates;
  registerRaster("runoff", c, w, e, n, s, false);
  map.getSource("runoff")?.setTiles([`saka://runoff/wi${mm}-${Date.now()}/{z}/{x}/{y}`]);
  if (!S.layers.runoff) { S.layers.runoff = true; const cb = document.querySelector('input[data-layer="runoff"]'); if (cb) cb.checked = true; applyLayers(); }
  const res = { high: land ? high / land : 0 };
  const out = $("wi-out");
  if (out) out.innerHTML = real ? `Kristine's real rain: <b>${pct(ro.validation.land_share_high)}</b> of Bicol land rated high.`
    : `<b>${mm} mm</b> everywhere: <b>${pct(res.high)}</b> of Bicol land rated high (Kristine: ${pct(ro.validation.land_share_high)}). ${mm >= 300 ? "Rain is capped at 300 mm in the score, as in the field risk formula." : ""}`;
  return res;
}

// ================= Modes: "This week" (default) and "Kristine 2024" (a replay of a real typhoon) =================
function setMode(m, quiet) {
  S.mode = m;
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("app").classList.toggle("mode-now", m === "now");
  if (m === "now") { pause(); if (["rain", "rainsum", "soil", "lstm"].includes(S.field)) setField("soilnow"); }
  else { if (["soilnow", "ready"].includes(S.field)) setField("none"); setTime(tAt("2024-11-02") + 0.5, true); }
  applyLayers(); renderLegend();
  if (!quiet) toast(m === "now" ? `This week: soil and storm readiness from NASA POWER, latest day ${short(S.tl.lstm_kristine_again?.soil_as_of || "")}.` : "Replay: Typhoon Kristine, October 2024. Press play.");
}
function bindModes() {
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("app").classList.add("mode-now");
}

// ================= Intro: Bicol traced, a radar swath finds the rivers and the flood, the numbers count in =================
// Simple intro: spring physics in CSS (logo drop + settle, one radar ping, letters bounce in). It only needs time.
function introPlay() {
  const done = () => { intro.played = true; };
  if (reduceMotion) { done(); return; }
  setTimeout(done, 1900);
}

// ---------- workspace cards: group a section's blocks under their headings ----------
const PANEL_BREAK = ".h, .h-row, .pilot-head, .summary, .metrics, .seg, #ai-seg, .ai-ctx, .formula";
let panelObs = null;
function panelize(sec) {
  if (sec.id === "tab-ai") return; // the chat stays one column
  panelObs?.disconnect();
  unpanelize(sec);
  let cur = null;
  [...sec.children].forEach((ch) => {
    const lead = ch.matches(".h, .h-row, .pilot-head, .summary");
    if (!cur || lead) { cur = document.createElement("div"); cur.className = "ws-panel"; sec.insertBefore(cur, ch); }
    cur.appendChild(ch);
  });
  sec.classList.add("ws-grid");
  // sections re-render themselves (innerHTML); re-group when that happens
  panelObs = new MutationObserver(() => { if (WM.ws && sec.querySelector(":scope > :not(.ws-panel)")) panelize(sec); });
  panelObs.observe(sec, { childList: true });
}
function unpanelize(sec) {
  if (!sec.classList.contains("ws-grid")) return;
  panelObs?.disconnect();
  sec.querySelectorAll(":scope > .ws-panel").forEach((pn) => { while (pn.firstChild) sec.insertBefore(pn.firstChild, pn); pn.remove(); });
  sec.classList.remove("ws-grid");
}
// a strip of live headline numbers under each page title
function renderWsKpis(id) {
  const box = $("ws-kpis"); if (!box) return;
  const sm = S.summary, pv = S.pilot?.provenance, B = S.bench, ro = S.runoff;
  const towns = S.munis?.features.map((f) => f.properties) || [];
  const k = {
    ai: [["Datasets it reads", "8"], ["Towns it knows", `${towns.length}`], ["Topics it answers", "13"], ["Place in focus", AI.town?.name || (S.inspect ? "Clicked spot" : "All of Bicol")]],
    layers: [["Heatmap", FIELDS[S.field]?.name || "None"], ["Mode", S.mode === "now" ? "This week" : "Kristine 2024"], ["View", S.view3d ? "3D terrain" : "2D"], ["Overlays on", `${Object.values(S.layers).filter(Boolean).length}`]],
    towns: sm ? [["Flooded farmland", `${fmt(sm.flooded_farmland_ha)} ha`], ["Towns affected", `${towns.filter((t) => t.flooded_farmland_ha >= 1).length} of ${towns.length}`], ["Hardest hit", `${towns.sort((a, b) => a.rank - b.rank)[0]?.name || ""}`], ["Radar coverage", pct(sm.radar_coverage)]] : [],
    fields: pv ? [["Rated high", `${fmt(pv.total_high_risk_ha, 1)} ha`], ["Independent hit rate", pv.sar_hit_rate], ["Flooded farmland", `${fmt(pv.flooded_farmland_ha, 1)} ha`], ["Grid", "30 m"]] : [],
    forecast: B ? [["Lower error than no-change", `${B.forecast.root_zone.skill_vs_persistence_pct}%`], ["In wet weeks", `${B.forecast.root_zone.skill_vs_persistence_wet_weeks_pct}%`], ["Bicol cells right ±1 day", `${B.forecast_regional.within_1_day} of ${B.forecast_regional.cells}`], ["Lead time", "7 days"]] : [],
    events: [["Events", `${S.events.length}`], ["From", short(S.tl.days[0])], ["To", short(S.tl.days[S.tl.days.length - 1])], ["Closest pass", `${fmt(S.closest?.km)} km`]],
    data: B ? [["Field risk, independent", B.field_risk.independent_hit_rate], ["Runoff check", `${pct(ro?.validation.share_rated_high)} vs ${pct(ro?.validation.farmland_share_high)}`], ["Data licensing", "₱0"], ["Algorithms benchmarked", "12"]] : [],
  }[id] || [];
  box.innerHTML = k.map(([l, v]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
  box.hidden = !k.length;
}

// ================= Field Drowning Risk for all of Bicol farmland (100 m, pipeline/bicol_risk.py) =================
async function loadBicolRisk() {
  const r = S.brisk, [disp, vals] = await Promise.all([loadImageCanvas(r.image), loadImageCanvas(r.values)]);
  if (!disp || !vals) return;
  const [[w, n], [e], , [, s]] = r.coordinates;
  registerRaster("brisk", disp, w, e, n, s, false);
  S.briskVals = { d: vals.getContext("2d").getImageData(0, 0, vals.width, vals.height).data, W: vals.width, H: vals.height, w, e, yN: mercY(n), yS: mercY(s) };
  const go = () => {
    if (map.getSource("brisk")) return;
    map.addSource("brisk", { type: "raster", tiles: ["saka://brisk/v1/{z}/{x}/{y}"], tileSize: 256, minzoom: 6, maxzoom: 14, bounds: [w, s, e, n] });
    map.addLayer({ id: "brisk", type: "raster", source: "brisk", minzoom: 7.6,
      paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 7.6, 0, 8.6, 0.85, 11, 0.85, 11.6, 0.25], "raster-resampling": "nearest", "raster-fade-duration": 0 } },
      map.getLayer("pgrid") ? "pgrid" : map.getLayer("towns-fill") ? "towns-fill" : undefined);
    applyLayers();
  };
  S.ready ? go() : map.once("style.load", go);
}
function briskAt(lon, lat) {
  const B = S.briskVals; if (!B || lon < B.w || lon > B.e) return null;
  const x = Math.floor(((lon - B.w) / (B.e - B.w)) * B.W), y = Math.floor(((B.yN - mercY(lat)) / (B.yN - B.yS)) * B.H);
  if (y < 0 || y >= B.H) return null;
  const i = (y * B.W + x) * 4; if (!B.d[i + 3]) return null;
  return { score: B.d[i], cls: B.d[i + 1] - 2 };
}

init();
