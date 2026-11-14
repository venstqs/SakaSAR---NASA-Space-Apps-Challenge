// SakaSAR — 3D replay of Typhoon Kristine over the Bicol Region.
// Map = the interface. Windows float on top and can be dragged, minimised, closed and reopened from the dock.
"use strict";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WATER = "#2f9fd3";
const GREEN = "#1f8a4c";
const HIGH = "#e2533c";
const BICOL_CENTER = [123.45, 13.2];
const GIBS = {
  modis: { name: "MODIS true colour", sub: "Terra, daily (clouds hide the ground in the storm)", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg", max: 9 },
  viirs: { name: "VIIRS true colour", sub: "Suomi NPP, daily", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg", max: 9 },
  imerg: { name: "GPM IMERG rain rate", sub: "satellite rainfall, by date", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/{date}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png", max: 6 },
  smap: { name: "SMAP soil moisture", sub: "L-band radiometer, by date", url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/SMAP_L3_Passive_Day_Soil_Moisture/default/{date}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png", max: 6 },
};

const S = {
  tl: null, munis: null, summary: null, overlay: null,
  t: 23, playing: false, speed: 1, last: 0, dayShown: -1,
  layers: { storm: true, rain: true, soil: false, lstm: false, flood: true, towns: true, terrain: true, hillshade: true, modis: false, viirs: false, imerg: false, smap: false },
  aiMode: "hind", cell: null, town: null, charts: {}, events: [], townCenters: [],
};
let map, stormMarker;

// ---------------- helpers ----------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (typeof n === "number" ? Math.round(n).toLocaleString("en-PH") : "n/a");
const pct = (x) => (typeof x === "number" ? `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%` : "n/a");
const dayISO = (i) => S.tl.days[Math.max(0, Math.min(S.tl.days.length - 1, Math.floor(i)))];
const label = (iso) => { const d = new Date(iso + "T00:00:00"); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const short = (iso) => { const d = new Date(iso + "T00:00:00"); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const t0 = () => Date.parse(S.tl.days[0] + "T00:00:00Z");
const tAtISO = (iso) => (Date.parse(iso.length > 10 ? iso : iso + "T00:00:00Z") - t0()) / 86400000;
const km = (a, b) => { const R = 6371, r = Math.PI / 180; const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
async function fetchJSON(u) { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch (_) { return null; } }
let toastT;
function toast(m) { const el = $("toast"); el.textContent = m; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3200); }
const icons = () => window.lucide && window.lucide.createIcons();
function nearestTown(lon, lat) {
  let best = null, bd = Infinity;
  for (const c of S.townCenters) { const d = (c.lon - lon) ** 2 + (c.lat - lat) ** 2; if (d < bd) { bd = d; best = c; } }
  return best;
}
const rampRain = ["interpolate", ["linear"], ["get", "rain"], 0, "#d9efe1", 20, "#9fd8b4", 60, "#4fb37a", 120, "#2f9fd3", 200, "#1b5fa8"];
const rampSoil = ["interpolate", ["linear"], ["get", "soil"], 0.6, "#f3e3b5", 0.85, "#9fd8b4", 0.95, "#4fb3d9", 0.97, "#1b5fa8", 1.0, "#123f80"];
const rampLstm = ["interpolate", ["linear"], ["get", "lstm"], 0, "rgba(255,255,255,0.05)", 1, "#9fd8b4", 3, "#ee9f27", 5, "#e2533c", 7, "#9e1b10"];

// ---------------- boot ----------------
async function init() {
  const [tl, munis, summary, overlay] = await Promise.all([
    fetchJSON("data/region/bicol_timeline.json"), fetchJSON("data/region/bicol_municipalities.geojson"),
    fetchJSON("data/region/bicol_summary.json"), fetchJSON("data/region/bicol_flood.json"),
  ]);
  Object.assign(S, { tl, munis, summary, overlay });
  S.t = Math.max(0, tl.days.indexOf("2024-11-02"));
  S.townCenters = (munis?.features || []).map((f) => {
    let x = 0, y = 0, n = 0;
    const walk = (k) => { if (typeof k[0] === "number") { x += k[0]; y += k[1]; n++; } else k.forEach(walk); };
    walk(f.geometry.coordinates);
    return { name: f.properties.name, province: f.properties.province, lon: x / n, lat: y / n };
  });
  if (window.Chart) { Chart.defaults.font.family = "Outfit, system-ui, sans-serif"; Chart.defaults.color = "#64786c"; }
  buildEvents();
  initWindows();
  renderLayersPanel();
  renderSituation();
  initSimChart();
  renderAI();
  bindSim();
  placeWindows();
  initMap();
  icons();
  setTime(S.t, true);
  requestAnimationFrame(placeWindows);
}

// ---------------- windows ----------------
function initWindows() {
  const dock = $("dock");
  document.querySelectorAll(".win").forEach((w) => {
    const ctl = w.querySelector(".win-ctl");
    ctl.innerHTML = `<button type="button" class="min-btn" aria-label="Minimise"><i data-lucide="minus"></i></button>
      <button type="button" class="close-btn" aria-label="Close"><i data-lucide="x"></i></button>`;
    ctl.querySelector(".min-btn").addEventListener("click", (e) => { e.stopPropagation(); w.classList.toggle("min"); clampWin(w); });
    ctl.querySelector(".close-btn").addEventListener("click", (e) => { e.stopPropagation(); closeWin(w); });
    if (w.dataset.start === "min") w.classList.add("min");
    if (w.id !== "win-town") {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.win = w.id;
      b.innerHTML = `<i data-lucide="${w.dataset.icon}"></i><span>${w.dataset.title}</span>`;
      b.addEventListener("click", () => (w.hidden || w.classList.contains("min") || window.innerWidth <= 760 && !w.classList.contains("focused") ? openWin(w) : closeWin(w)));
      dock.appendChild(b);
    }
    makeDraggable(w);
    w.addEventListener("pointerdown", () => focusWin(w));
  });
  window.addEventListener("resize", () => { placeWindows(); document.querySelectorAll(".win").forEach(clampWin); Object.values(S.charts).forEach((c) => c?.resize()); });
  syncDock();
  if (window.innerWidth <= 760) focusWin($("win-sim"));
}
function placeWindows() {
  if (window.innerWidth <= 760) return;
  const vw = window.innerWidth, vh = window.innerHeight, top = 76, gap = 12, pad = 16;
  const put = (id, x, y, maxH) => { const w = $(id); w.style.left = `${Math.max(8, x)}px`; w.style.top = `${Math.max(8, y)}px`; if (maxH) w.style.maxHeight = `${Math.max(120, maxH)}px`; };
  const sim = $("win-sim"), lay = $("win-layers"), log = $("win-log"), ai = $("win-ai");
  const aiH = ai.classList.contains("min") ? 46 : Math.min(ai.offsetHeight, vh * 0.55);
  put("win-situation", pad, top, vh - top - aiH - gap - pad);
  put("win-ai", pad, vh - aiH - pad);
  const right = vh - top - pad - gap;
  put("win-layers", vw - lay.offsetWidth - pad, top, right * 0.5);
  put("win-log", vw - log.offsetWidth - pad, top + lay.offsetHeight + gap, vh - (top + lay.offsetHeight + gap) - pad);
  put("win-sim", (vw - sim.offsetWidth) / 2, vh - sim.offsetHeight - pad);
  put("win-town", pad + $("win-situation").offsetWidth + gap, top, vh - top - sim.offsetHeight - pad - 2 * gap);
}
function clampWin(w) {
  if (window.innerWidth <= 760) return;
  const r = w.getBoundingClientRect();
  w.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - Math.min(r.width, 120))}px`;
  w.style.top = `${Math.min(Math.max(8, r.top), window.innerHeight - 48)}px`;
}
function focusWin(w) {
  document.querySelectorAll(".win.focused").forEach((x) => x !== w && x.classList.remove("focused"));
  w.classList.add("focused");
  syncDock();
}
function openWin(w) { w.hidden = false; w.classList.remove("min"); focusWin(w); clampWin(w); Object.values(S.charts).forEach((c) => c?.resize()); }
function closeWin(w) { w.hidden = true; w.classList.remove("focused"); syncDock(); }
function syncDock() {
  document.querySelectorAll("#dock button").forEach((b) => {
    const w = $(b.dataset.win);
    b.setAttribute("aria-pressed", String(!w.hidden && !w.classList.contains("min") && (window.innerWidth > 760 || w.classList.contains("focused"))));
  });
}
function makeDraggable(w) {
  const head = w.querySelector(".win-head");
  let sx, sy, ox, oy, on = false;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || window.innerWidth <= 760) return;
    on = true; w.classList.add("dragging"); head.setPointerCapture(e.pointerId);
    const r = w.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
  });
  head.addEventListener("pointermove", (e) => {
    if (!on) return;
    w.style.left = `${Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - 80)}px`;
    w.style.top = `${Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - 40)}px`;
  });
  const end = () => { on = false; w.classList.remove("dragging"); };
  head.addEventListener("pointerup", end); head.addEventListener("pointercancel", end);
  head.addEventListener("dblclick", () => { w.classList.toggle("min"); clampWin(w); });
}

// ---------------- map ----------------
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        sat: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          attribution: "Imagery Esri · NASA EONET, POWER, GIBS · Copernicus Sentinel-1 · ESA WorldCover · AWS Terrain Tiles · NAMRIA/PSA" },
        dem: { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 13 },
        demshade: { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 13 },
      },
      layers: [
        { id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.15 } },
        { id: "hillshade", type: "hillshade", source: "demshade", paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#0d2a1d" } },
      ],
      terrain: { source: "dem", exaggeration: 2.2 },
      sky: { "sky-color": "#bfe0f2", "horizon-color": "#eaf4ee", "fog-color": "#eaf4ee", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.3 },
    },
    center: BICOL_CENTER, zoom: 7.4, pitch: 58, bearing: -18, maxPitch: 80, attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  // style.load fires as soon as the style is parsed; "load" would wait for every terrain tile
  map.once("style.load", () => {
    addLayers();
    S.ready = true;
    applyLayers();
    setTime(S.t, true);
  });
}

function cellPolys(h = 0.25) {
  return {
    type: "FeatureCollection",
    features: S.tl.cells.map((c, i) => ({ type: "Feature", id: i, properties: { i, rain: 0, soil: 0, lstm: 0 },
      geometry: { type: "Polygon", coordinates: [[[c.lon - h, c.lat - h], [c.lon + h, c.lat - h], [c.lon + h, c.lat + h], [c.lon - h, c.lat + h], [c.lon - h, c.lat - h]]] } })),
  };
}

function addLayers() {
  Object.entries(GIBS).forEach(([k, g]) => {
    map.addSource(`gibs-${k}`, { type: "raster", tileSize: 256, maxzoom: g.max, tiles: [g.url.replace("{date}", dayISO(S.t))] });
    map.addLayer({ id: `gibs-${k}`, type: "raster", source: `gibs-${k}`, paint: { "raster-opacity": k === "imerg" || k === "smap" ? 0.75 : 1 }, layout: { visibility: "none" } });
  });
  if (S.overlay) {
    map.addSource("flood", { type: "image", url: S.overlay.image, coordinates: S.overlay.coordinates });
    map.addLayer({ id: "flood", type: "raster", source: "flood", paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "nearest" } });
  }
  if (S.munis) {
    map.addSource("munis", { type: "geojson", data: S.munis });
    map.addLayer({ id: "towns-fill", type: "fill", source: "munis", paint: { "fill-color": ["interpolate", ["linear"], ["get", "flooded_share"], 0, "rgba(47,159,211,0)", 0.02, "rgba(47,159,211,0.2)", 0.1, "rgba(47,159,211,0.42)", 0.25, "rgba(27,95,168,0.6)"] } });
    map.addLayer({ id: "towns-line", type: "line", source: "munis", paint: { "line-color": "rgba(255,255,255,0.7)", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 11, 1.4] } });
    map.addLayer({ id: "towns-active", type: "line", source: "munis", filter: ["==", ["get", "name"], ""], paint: { "line-color": "#ffd166", "line-width": 3.5 } });
    map.on("click", "towns-fill", (e) => openTown(e.features[0].properties.name, e.features[0].properties.province));
    map.on("mouseenter", "towns-fill", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "towns-fill", () => (map.getCanvas().style.cursor = ""));
  }
  map.addSource("cells", { type: "geojson", data: cellPolys() });
  map.addLayer({ id: "soil", type: "fill", source: "cells", paint: { "fill-color": rampSoil, "fill-opacity": 0.55 } });
  map.addLayer({ id: "lstm", type: "fill", source: "cells", paint: { "fill-color": rampLstm, "fill-opacity": 0.6 } });
  map.addSource("cols", { type: "geojson", data: cellPolys(0.07) });
  map.addLayer({ id: "rain", type: "fill-extrusion", source: "cols", maxzoom: 9.6,
    paint: { "fill-extrusion-color": rampRain, "fill-extrusion-height": ["*", ["get", "rain"], 160], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.85, "fill-extrusion-vertical-gradient": true } });
  map.on("click", "rain", (e) => selectCell(e.features[0].properties.i));
  map.on("click", "soil", (e) => selectCell(e.features[0].properties.i));
  map.on("click", "lstm", (e) => selectCell(e.features[0].properties.i));

  const track = S.tl.storm.map((p) => [p.lon, p.lat]);
  map.addSource("track-all", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: track } } });
  map.addSource("track-done", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: track.slice(0, 1) } } });
  map.addSource("track-pts", { type: "geojson", data: { type: "FeatureCollection", features: S.tl.storm.map((p) => ({ type: "Feature", properties: { w: p.wind_kts }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) } });
  map.addLayer({ id: "track-all", type: "line", source: "track-all", paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.8 } });
  map.addLayer({ id: "track-done", type: "line", source: "track-done", paint: { "line-color": HIGH, "line-width": 4 } });
  map.addLayer({ id: "track-pts", type: "circle", source: "track-pts", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "w"], 30, 3, 90, 7], "circle-color": "#fff", "circle-stroke-color": HIGH, "circle-stroke-width": 1.5 } });

  const el = document.createElement("div");
  el.className = "storm-marker";
  el.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0"/><path d="M12 4c-4 0-7 2-8 5"/><path d="M12 20c4 0 7-2 8-5"/><path d="M4 12c0 4 2 7 5 8"/><path d="M20 12c0-4-2-7-5-8"/></svg><span class="storm-tag" id="storm-tag"></span>`;
  stormMarker = new maplibregl.Marker({ element: el }).setLngLat(track[0]).addTo(map);
}

function vis(id, on) { if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
function applyLayers() {
  if (!S.ready) return;
  const L = S.layers, afterPass = dayISO(S.t) >= "2024-11-02";
  vis("flood", L.flood && afterPass);
  vis("towns-fill", L.towns && afterPass);
  vis("towns-line", L.towns);
  vis("towns-active", L.towns);
  vis("rain", L.rain); vis("soil", L.soil); vis("lstm", L.lstm);
  ["track-all", "track-done", "track-pts"].forEach((id) => vis(id, L.storm));
  vis("hillshade", L.hillshade);
  Object.keys(GIBS).forEach((k) => vis(`gibs-${k}`, L[k]));
  map.setTerrain(L.terrain ? { source: "dem", exaggeration: Number($("exag")?.value || 2.2) } : null);
  if (stormMarker) stormMarker.getElement().style.display = L.storm ? "" : "none";
}

// ---------------- simulation ----------------
function setTime(t, force) {
  if (!S.tl) return;
  S.t = Math.max(0, Math.min(S.tl.days.length - 1, t));
  const di = Math.floor(S.t), iso = dayISO(S.t);
  $("sim-slider").value = S.t;
  $("sim-date").textContent = label(iso);
  $("sim-phase").textContent = iso < "2024-10-21" ? "Before the storm" : iso <= "2024-10-26" ? "Kristine over Bicol" : iso < "2024-11-02" ? "Floodwater spreading; no clear radar pass yet" : "Sentinel-1 flood map available";
  updateStorm();
  if (di !== S.dayShown || force) {
    S.dayShown = di;
    updateCells(di);
    updateGibs(iso);
    renderStats(di);
    renderLog();
    renderSituationState();
    highlightSimChart(di);
    applyLayers();
  }
}

function updateStorm() {
  if (!map || !stormMarker) return;
  const st = S.tl.storm;
  const nowMs = t0() + S.t * 86400000;
  const times = st.map((p) => Date.parse(p.t));
  const tag = $("storm-tag");
  if (nowMs < times[0] || nowMs > times[times.length - 1]) {
    stormMarker.getElement().style.opacity = nowMs < times[0] ? 0 : 0.35;
    if (tag) tag.textContent = nowMs < times[0] ? "" : "Kristine has left";
    map.getSource("track-done")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: nowMs < times[0] ? [] : st.map((p) => [p.lon, p.lat]) } });
    if (nowMs > times[times.length - 1]) stormMarker.setLngLat([st[st.length - 1].lon, st[st.length - 1].lat]);
    return;
  }
  let k = times.findIndex((x) => x > nowMs); if (k <= 0) k = 1;
  const a = st[k - 1], b = st[k], f = (nowMs - times[k - 1]) / (times[k] - times[k - 1]);
  const pos = [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
  const wind = Math.round(a.wind_kts + ((b.wind_kts || a.wind_kts) - a.wind_kts) * f);
  stormMarker.getElement().style.opacity = 1;
  stormMarker.setLngLat(pos);
  if (tag) tag.textContent = `Kristine ${wind} kt`;
  map.getSource("track-done")?.setData({ type: "Feature", geometry: { type: "LineString", coordinates: [...st.slice(0, k).map((p) => [p.lon, p.lat]), pos] } });
  S.storm = { pos, wind };
}

function lstmValue(i) {
  if (S.aiMode === "hind") { const c = S.tl.lstm_hindcast?.cells?.[i]; return c ? c.days_pred : 0; }
  const c = S.tl.lstm_kristine_again?.cells?.[i]; return c ? c.days_waterlogged : 0;
}
function updateCells(di) {
  if (!map?.getSource("cells")) return;
  [["cells", 0.25], ["cols", 0.07]].forEach(([id, h]) => {
    const fc = cellPolys(h);
    fc.features.forEach((f, i) => { f.properties.rain = S.tl.rain_mm[i][di] ?? 0; f.properties.soil = S.tl.rootzone[i][di] ?? 0; f.properties.lstm = lstmValue(i); });
    map.getSource(id).setData(fc);
  });
}
function updateGibs(iso) {
  if (!map) return;
  Object.entries(GIBS).forEach(([k, g]) => { const s = map.getSource(`gibs-${k}`); if (s && S.layers[k] && s._sakDate !== iso) { s.setTiles([g.url.replace("{date}", iso)]); s._sakDate = iso; } });
}

function regionDaily() {
  const n = S.tl.cells.length;
  return S.tl.days.map((_, d) => {
    const v = S.tl.rain_mm.map((r) => r[d] ?? 0);
    return { mean: v.reduce((a, b) => a + b, 0) / n, max: Math.max(...v), imax: v.indexOf(Math.max(...v)) };
  });
}
function renderStats(di) {
  const rd = regionDaily(), today = rd[di];
  const cum = rd.slice(0, di + 1).reduce((a, b) => a + b.mean, 0);
  const sat = S.tl.rootzone.filter((r) => (r[di] ?? 0) >= 0.97).length;
  const st = S.storm && dayISO(di) <= "2024-10-28" && dayISO(di) >= "2024-10-21" ? `${S.storm.wind} kt` : "none";
  $("sim-stats").innerHTML = [
    [`${fmt(today.mean)} mm`, `rain today, region average (max ${fmt(today.max)} mm)`],
    [`${fmt(cum)} mm`, `rain since ${short(S.tl.days[0])}, region average`],
    [`${sat} of ${S.tl.cells.length}`, "grid cells with soil full of water"],
    [st, "storm wind (NASA EONET)"],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("");
}

function initSimChart() {
  const rd = regionDaily();
  S.charts.sim = new Chart($("ch-sim"), {
    type: "bar",
    data: { labels: S.tl.days.map(short), datasets: [{ data: rd.map((d) => d.mean), backgroundColor: rd.map(() => "#bfe3cc"), borderRadius: 3 }] },
    options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y.toFixed(0)} mm region average` } } },
      onClick: (_, els) => { if (els[0]) { pause(); setTime(els[0].index + 0.5, true); } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 10 } } }, y: { display: false, beginAtZero: true } } },
  });
}
function highlightSimChart(di) {
  const c = S.charts.sim; if (!c) return;
  const pass = new Set(S.tl.passes.filter((p) => p.used).map((p) => p.date));
  c.data.datasets[0].backgroundColor = S.tl.days.map((d, i) => (i === di ? GREEN : pass.has(d) ? WATER : d >= "2024-10-21" && d <= "2024-10-26" ? "#7cc69a" : "#d4ecdc"));
  c.update("none");
}

function bindSim() {
  $("sim-slider").addEventListener("input", (e) => { pause(); setTime(Number(e.target.value)); });
  $("btn-play").addEventListener("click", () => (S.playing ? pause() : play()));
  document.querySelectorAll(".speed button").forEach((b) => b.addEventListener("click", () => {
    S.speed = Number(b.dataset.speed); document.querySelectorAll(".speed button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    if (e.code === "Space") { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.key === "ArrowRight") setTime(Math.floor(S.t) + 1.0001, true);
    if (e.key === "ArrowLeft") setTime(Math.floor(S.t) - 0.9999, true);
  });
}
function play() {
  if (S.t >= S.tl.days.length - 1.01) setTime(0, true);
  S.playing = true; S.last = performance.now();
  $("btn-play").innerHTML = `<i data-lucide="pause"></i>`; icons();
  const step = (now) => {
    if (!S.playing) return;
    const dt = (now - S.last) / 1000; S.last = now;
    const before = dayISO(S.t);
    setTime(S.t + dt * 0.9 * S.speed);
    const after = dayISO(S.t);
    if (before !== after) { const ev = S.tl.passes.find((p) => p.date === after); if (ev) toast(ev.label); }
    if (S.t >= S.tl.days.length - 1) { pause(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function pause() { S.playing = false; $("btn-play").innerHTML = `<i data-lucide="play"></i>`; icons(); }

// ---------------- event log (GIS tracking) ----------------
function buildEvents() {
  const ev = [], st = S.tl.storm;
  const naga = [123.19, 13.62];
  if (st.length) {
    ev.push({ t: tAtISO(st[0].t), c: HIGH, text: `NASA EONET starts tracking Tropical Storm Kristine (Trami) at ${st[0].lat.toFixed(1)}°N ${st[0].lon.toFixed(1)}°E, wind ${st[0].wind_kts} kt.` });
    let ci = 0; st.forEach((p, i) => { if (km([p.lon, p.lat], naga) < km([st[ci].lon, st[ci].lat], naga)) ci = i; });
    ev.push({ t: tAtISO(st[ci].t), c: HIGH, text: `Closest approach: storm centre about ${fmt(km([st[ci].lon, st[ci].lat], naga))} km from Naga City, wind ${st[ci].wind_kts} kt.` });
    const mi = st.reduce((m, p, i) => ((p.wind_kts || 0) > (st[m].wind_kts || 0) ? i : m), 0);
    if (mi !== ci) ev.push({ t: tAtISO(st[mi].t), c: HIGH, text: `Peak wind in the track: ${st[mi].wind_kts} kt at ${st[mi].lat.toFixed(1)}°N ${st[mi].lon.toFixed(1)}°E.` });
    ev.push({ t: tAtISO(st[st.length - 1].t), c: "#888", text: `Last EONET position at ${st[st.length - 1].lat.toFixed(1)}°N ${st[st.length - 1].lon.toFixed(1)}°E: the storm has left the Philippines.` });
  }
  const rd = regionDaily();
  rd.forEach((d, i) => {
    if (d.max >= 120) {
      const c = S.tl.cells[d.imax], town = nearestTown(c.lon, c.lat);
      ev.push({ t: i + 0.6, c: WATER, text: `${fmt(d.max)} mm of rain in one day near ${town ? `${town.name}, ${town.province}` : "the region"} (NASA POWER). Region average ${fmt(d.mean)} mm.` });
    }
  });
  const half = S.tl.cells.length / 2;
  const satDay = S.tl.days.findIndex((_, d) => S.tl.rootzone.filter((r) => (r[d] ?? 0) >= 0.97).length >= half);
  if (satDay >= 0) ev.push({ t: satDay + 0.7, c: "#1b5fa8", text: `Soil is full of water in more than half of Bicol's grid cells: roots start to drown.` });
  S.tl.passes.forEach((p) => ev.push({ t: tAtISO(p.date) + 0.9, c: p.used ? GREEN : "#999", text: p.label + "." }));
  if (S.summary) {
    const top = S.summary.top_municipalities.slice(0, 3).map((x) => `${x.name} (${fmt(x.flooded_farmland_ha)} ha)`).join(", ");
    ev.push({ t: tAtISO("2024-11-02") + 0.95, c: GREEN, text: `Flood map: ${fmt(S.summary.flooded_farmland_ha)} ha of Bicol farmland still under water. Worst: ${top}.` });
  }
  const h = S.tl.lstm_hindcast;
  if (h) {
    const v = h.cells.filter(Boolean), ok = v.filter((c) => Math.abs(c.days_pred - c.days_actual) <= 1).length;
    ev.push({ t: tAtISO(h.issued) + 0.5, c: "#7a4cc2", text: `LSTM forecast for the next 7 days in every grid cell: waterlogged days right within 1 day in ${ok} of ${v.length} cells.` });
  }
  S.events = ev.sort((a, b) => a.t - b.t);
}
function renderLog() {
  const now = S.t;
  const shown = S.events.filter((e) => e.t <= now + 0.999).reverse();
  $("log").innerHTML = shown.length ? shown.map((e) => `<li class="${now - e.t < 1.2 ? "new" : ""}" style="--c:${e.c}"><div><time>${short(dayISO(e.t))}</time><p>${esc(e.text)}</p></div></li>`).join("")
    : `<li style="--c:#ccc"><div><time>${short(dayISO(now))}</time><p>Quiet weather. Press play to replay the storm.</p></div></li>`;
}

// ---------------- situation ----------------
function renderSituation() {
  const towns = (S.munis?.features || []).map((f) => f.properties);
  const max = Math.max(...towns.map((t) => t.flooded_farmland_ha), 1);
  const list = (q) => {
    const query = (q || "").trim().toLowerCase();
    const rows = towns.filter((t) => !query || t.name.toLowerCase().includes(query) || t.province.toLowerCase().includes(query)).slice(0, query ? 50 : 25);
    $("towns").innerHTML = rows.map((t) => `<li><button type="button" class="town" data-n="${esc(t.name)}" data-p="${esc(t.province)}">
      <span class="town-rank">${t.rank}</span><span><b>${esc(t.name)}</b><small>${esc(t.province)}</small></span>
      <span class="town-val"><b>${fmt(t.flooded_farmland_ha)} ha</b><br><small>${pct(t.flooded_share)}</small></span>
      <span class="town-bar"><i style="width:${(100 * t.flooded_farmland_ha) / max}%"></i></span></button></li>`).join("") || `<li class="hint">No town matches.</li>`;
    $("towns").querySelectorAll(".town").forEach((b) => b.addEventListener("click", () => openTown(b.dataset.n, b.dataset.p)));
  };
  list("");
  $("town-search").addEventListener("input", (e) => list(e.target.value));
}
function renderSituationState() {
  const s = S.summary, after = dayISO(S.t) >= "2024-11-02";
  const towns = (S.munis?.features || []).map((f) => f.properties);
  const affected = towns.filter((t) => t.flooded_farmland_ha >= 1).length;
  const rd = regionDaily(), peak = rd.reduce((m, d, i) => (d.max > rd[m].max ? i : m), 0);
  $("kpis").innerHTML = (after && s
    ? `<div class="kpi hero"><b>${fmt(s.flooded_farmland_ha)} ha</b><span>farmland under water on 2 Nov (Sentinel-1, 100 m)</span></div>
       <div class="kpi"><b>${affected}/${towns.length}</b><span>towns with flooded farmland</span></div>
       <div class="kpi"><b>${esc(towns[0].name)}</b><span>hardest hit, ${fmt(towns[0].flooded_farmland_ha)} ha</span></div>`
    : `<div class="kpi hero"><b>Waiting for radar</b><span>The flood map comes with the calm 2 Nov Sentinel-1 pass. Press play.</span></div>
       <div class="kpi"><b>${fmt(rd[peak].max)} mm</b><span>wettest day in one cell, ${short(S.tl.days[peak])}</span></div>
       <div class="kpi"><b>${s ? s.municipalities : "—"}</b><span>towns watched</span></div>`);
  $("towns-hint").textContent = after ? "Ranked by farmland the radar saw under water." : "Ranking from the 2 Nov flood map (shown ahead of time).";
}

// ---------------- town window ----------------
function openTown(name, province) {
  const f = (S.munis?.features || []).find((x) => x.properties.name === name && x.properties.province === province);
  if (!f) return;
  const p = f.properties, c = S.townCenters.find((x) => x.name === name && x.province === province);
  document.querySelectorAll(".town").forEach((b) => b.classList.toggle("active", b.dataset.n === name && b.dataset.p === province));
  if (S.ready) map.setFilter("towns-active", ["all", ["==", ["get", "name"], name], ["==", ["get", "province"], province]]);
  if (c && map) map.flyTo({ center: [c.lon, c.lat], zoom: 10.6, pitch: 60, bearing: -15, duration: 1600 });
  let ci = 0, best = Infinity;
  S.tl.cells.forEach((cell, i) => { const d = (cell.lon - c.lon) ** 2 + (cell.lat - c.lat) ** 2; if (d < best) { best = d; ci = i; } });
  const evRain = S.tl.days.reduce((a, d, i) => (d >= "2024-10-14" && d <= "2024-10-26" ? a + (S.tl.rain_mm[ci][i] || 0) : a), 0);
  const h = S.tl.lstm_hindcast?.cells?.[ci];
  const share = p.flooded_share;
  const acts = share >= 0.15
    ? ["Send Municipal Agriculture Office teams here first: a large share of farmland stayed under water.", "Ask barangay captains to open main drains and canals now.", "Prepare a damage report from this map instead of waiting for a full field survey.", "Tell farmers to harvest mature rice early and hold off fertiliser."]
    : share >= 0.03
      ? ["Check low-lying barangays near rivers and lakes first.", "Advise farmers to open field outlets and dig drainage trenches.", "Re-check after the next Sentinel-1 pass in 12 days."]
      : ["Little flooded farmland seen by radar. Keep routine monitoring.", "Check fields under tall crops: radar can miss water under the canopy."];
  $("town-title").textContent = `${p.name}, ${p.province}`;
  $("town-body").innerHTML = `
    <p class="town-big">${fmt(p.flooded_farmland_ha)} ha</p>
    <p class="hint">of ${fmt(p.farmland_ha)} ha farmland under water on the radar (${pct(share)}). Rank ${p.rank} of ${S.munis.features.length} towns.</p>
    <dl class="facts">
      <div><dt>Storm rain, 14–26 Oct</dt><dd>${fmt(evRain)} mm</dd></div>
      <div><dt>LSTM, roots waterlogged after 2 Nov</dt><dd>${h ? `${h.days_pred} of 7 days` : "n/a"}</dd></div>
      <div><dt>What happened</dt><dd>${h ? `${h.days_actual} of 7 days` : "n/a"}</dd></div>
      <div><dt>Radar</dt><dd>${esc(p.sentinel1)}</dd></div>
    </dl>
    <h3 class="sub">What to do</h3>
    <ul class="actions">${acts.map((a, i) => `<li class="${i === 0 && share >= 0.15 ? "warn" : ""}">${esc(a)}</li>`).join("")}</ul>
    <p class="hint" style="margin-top:10px">Rain and LSTM values come from the nearest NASA POWER grid cell (about 50 km).</p>`;
  openWin($("win-town"));
  selectCell(ci, false);
  icons();
}

// ---------------- LSTM window ----------------
function selectCell(i, open = true) {
  S.cell = i;
  renderAI();
  if (open) openWin($("win-ai"));
}
function renderAI() {
  const tl = S.tl; if (!tl) return;
  const hind = tl.lstm_hindcast, again = tl.lstm_kristine_again;
  document.querySelectorAll("#ai-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ai === S.aiMode)));
  const i = S.cell;
  const cell = i != null ? tl.cells[i] : null;
  const town = cell ? nearestTown(cell.lon, cell.lat) : null;
  const where = cell ? `the grid cell near ${town ? town.name : `${cell.lat}°N ${cell.lon}°E`}` : "the whole region";
  let labels = [], ds = [];
  if (S.aiMode === "hind" && hind) {
    const v = hind.cells.filter(Boolean), ok = v.filter((c) => Math.abs(c.days_pred - c.days_actual) <= 1).length;
    const pick = i != null && hind.cells[i] ? [hind.cells[i]] : v;
    const avg = (k) => Array.from({ length: 7 }, (_, d) => pick.reduce((a, c) => a + (c[k][d] ?? 0), 0) / pick.length);
    const start = new Date(hind.issued + "T00:00:00");
    labels = Array.from({ length: 7 }, (_, d) => { const x = new Date(start); x.setDate(x.getDate() + d); return `${x.getDate()} ${MONTHS[x.getMonth()]}`; });
    ds = [{ label: "LSTM forecast", data: avg("pred"), borderColor: GREEN, backgroundColor: GREEN, tension: 0.3, borderWidth: 3 },
      { label: "What happened", data: avg("actual"), borderColor: WATER, backgroundColor: WATER, borderDash: [5, 4], tension: 0.3, borderWidth: 2 }];
    $("ai-lead").innerHTML = `Forecast issued <strong>3 Nov 2024</strong> for ${esc(where)}. Across Bicol, the waterlogged days were right within 1 day in <strong>${ok} of ${v.length}</strong> grid cells.`;
    $("ai-hint").textContent = "Root zone: 1 = full of water; 0.97 or more = waterlogged. Click a rain column or grid cell on the map to see its forecast.";
  } else if (again) {
    const v = again.cells.filter(Boolean), wet = v.filter((c) => c.days_waterlogged > 0).length;
    const pick = i != null && again.cells[i] ? [again.cells[i]] : v;
    labels = Array.from({ length: 7 }, (_, d) => `day ${d + 1}`);
    ds = [{ label: "Root zone if Kristine's rain came again", data: Array.from({ length: 7 }, (_, d) => pick.reduce((a, c) => a + c.pred[d], 0) / pick.length), borderColor: HIGH, backgroundColor: "rgba(226,83,60,0.12)", fill: true, tension: 0.3, borderWidth: 3 }];
    $("ai-lead").innerHTML = `If Kristine's rain fell again on today's soil (NASA POWER, ${esc(again.soil_as_of)}), roots would be waterlogged in <strong>${wet} of ${v.length}</strong> grid cells. Soil is drier now than in October 2024.`;
    $("ai-hint").textContent = `Showing ${where}. Each cell gets its own Kristine-week rain.`;
  }
  const data = { labels, datasets: [...ds, { label: "Waterlogged", data: labels.map(() => 0.97), borderColor: "#e2533c", borderWidth: 1, pointRadius: 0, borderDash: [3, 3] }] };
  if (S.charts.ai) { S.charts.ai.data = data; S.charts.ai.update(); }
  else if (window.Chart) S.charts.ai = new Chart($("ch-ai"), { type: "line", data, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { suggestedMin: 0.7, max: 1.0, grid: { color: "#eef3f0" } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } } });
  if (S.ready) updateCells(Math.floor(S.t));
}

// ---------------- layers window ----------------
function renderLayersPanel() {
  const row = (k, name, sub) => `<label class="layer"><span><b>${name}</b><small>${sub}</small></span><input type="checkbox" data-layer="${k}" ${S.layers[k] ? "checked" : ""} /><span class="switch" aria-hidden="true"></span></label>`;
  $("layers").innerHTML = `
    <p class="layer-group">Storm replay</p>
    ${row("storm", "Kristine's track", "NASA EONET, 6-hourly")}
    ${row("rain", "Daily rain columns", "NASA POWER, height = mm")}
    <div class="legend-row">0<span class="ramp" style="background:linear-gradient(90deg,#d9efe1,#4fb37a,#2f9fd3,#1b5fa8)"></span>200+ mm</div>
    ${row("soil", "Root-zone soil wetness", "NASA POWER, 1 = full of water")}
    ${row("lstm", "LSTM waterlogged days", "per grid cell, see the LSTM window")}
    <p class="layer-group">Flood (Sentinel-1 radar)</p>
    ${row("flood", "Flooded farmland, 100 m", "from the 2 Nov pass")}
    ${row("towns", "Towns", "shaded by share of farmland flooded")}
    <p class="layer-group">NASA satellite imagery for the day (GIBS)</p>
    ${Object.entries(GIBS).map(([k, g]) => row(k, g.name, g.sub)).join("")}
    <p class="layer-group">Terrain</p>
    ${row("terrain", "3D terrain", "elevation tiles, exaggerated")}
    <div class="exag"><span>Height</span><input type="range" id="exag" min="1" max="4" step="0.1" value="2.2" aria-label="Terrain exaggeration" /></div>
    ${row("hillshade", "Hillshade", "shaded relief")}`;
  $("layers").querySelectorAll("input[data-layer]").forEach((inp) => inp.addEventListener("change", () => {
    S.layers[inp.dataset.layer] = inp.checked;
    if (GIBS[inp.dataset.layer] && inp.checked) { updateGibs(dayISO(S.t)); if (inp.dataset.layer === "imerg" || inp.dataset.layer === "smap") map.easeTo({ zoom: Math.min(map.getZoom(), 6.8) }); }
    applyLayers();
  }));
  $("exag").addEventListener("input", applyLayers);
  document.querySelectorAll("#ai-seg button").forEach((b) => b.addEventListener("click", () => { S.aiMode = b.dataset.ai; renderAI(); }));
}

init();
