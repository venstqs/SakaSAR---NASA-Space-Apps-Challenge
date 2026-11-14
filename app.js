const DATA_SOURCE_URL = "mock-data.json";

let appData = null;
let map = null;
let is3D = true;
let playInterval = null;

async function initApp() {
  const res = await fetch(DATA_SOURCE_URL);
  appData = await res.json();

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
          paint: { "raster-opacity": 0.22 }
        }
      ]
    },
    center: [123.2005, 13.6182],
    zoom: 14.8,
    pitch: 52,
    bearing: -12
  });

  map.on("mousemove", (e) => {
    document.getElementById("coord-readout").textContent =
      `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}, 30m SAR`;
  });

  map.on("load", () => {
    // 1. SAR Backscatter Comparison Source
    map.addSource("sar-source", {
      type: "geojson",
      data: appData.sar_backscatter_comparison.after_event
    });

    map.addLayer({
      id: "sar-layer",
      type: "fill",
      source: "sar-source",
      layout: { visibility: "none" },
      paint: {
        "fill-color": "#06b6d4",
        "fill-opacity": 0.38
      }
    });

    // 2. NASADEM Runoff Corridor Line
    map.addSource("corridor-source", {
      type: "geojson",
      data: appData.drainage_corridor
    });

    map.addLayer({
      id: "corridor-line",
      type: "line",
      source: "corridor-source",
      paint: {
        "line-color": "#38bdf8",
        "line-width": 4,
        "line-opacity": 0.85
      }
    });

    // 3. Farm Plots Risk Layer
    map.addSource("plots-source", {
      type: "geojson",
      data: appData.plots
    });

    map.addLayer({
      id: "plots-fill",
      type: "fill",
      source: "plots-source",
      paint: {
        "fill-color": [
          "match",
          ["get", "risk_class"],
          "high", "#ef4444",
          "watch", "#f59e0b",
          "low", "#10b981",
          "#64748b"
        ],
        "fill-opacity": 0.52
      }
    });

    map.addLayer({
      id: "plots-outline",
      type: "line",
      source: "plots-source",
      paint: {
        "line-color": "#ffffff",
        "line-width": 2
      }
    });

    // 4. Observed SAR Flood Extent Mask
    map.addSource("flood-source", {
      type: "geojson",
      data: appData.observed_flood_extent
    });

    map.addLayer({
      id: "flood-fill",
      type: "fill",
      source: "flood-source",
      paint: {
        "fill-color": "#3b82f6",
        "fill-opacity": 0.42
      }
    });

    map.addLayer({
      id: "flood-outline",
      type: "line",
      source: "flood-source",
      paint: {
        "line-color": "#93c5fd",
        "line-width": 2.5,
        "line-dasharray": [2, 2]
      }
    });

    // Add Floating Pill Markers Above Each Parcel (Bulos 3D Style)
    appData.plots.features.forEach((feat) => {
      const coords = getPolygonCenter(feat.geometry.coordinates[0]);
      const p = feat.properties;
      const dotColor =
        p.risk_class === "high" ? "#ef4444" : p.risk_class === "watch" ? "#f59e0b" : "#10b981";

      const el = document.createElement("div");
      el.className = "plot-pill-marker";
      el.innerHTML = `<span class="marker-dot" style="background:${dotColor}"></span><span>${p.plot_id} · ${p.risk_score}</span>`;
      el.addEventListener("click", () => selectPlot(feat));

      new maplibregl.Marker({ element: el }).setLngLat(coords).addTo(map);
    });

    map.on("click", "plots-fill", (e) => {
      if (e.features && e.features[0]) {
        const clickedId = e.features[0].properties.plot_id;
        const fullFeat = appData.plots.features.find((f) => f.properties.plot_id === clickedId);
        if (fullFeat) selectPlot(fullFeat);
      }
    });
  });

  populateLeftPanel();
  renderRotations("nitrogen");
  selectPlot(appData.plots.features[0], false);
  bindUIEvents();
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

function populateLeftPanel() {
  const prov = appData.provenance;
  document.getElementById("kpi-ha").textContent = `${prov.total_high_risk_ha} ha`;
  document.getElementById("kpi-households").textContent = prov.households_affected;
  document.getElementById("kpi-hitrate").textContent = prov.sar_hit_rate;
  document.getElementById("kpi-baredays").textContent = `${prov.avg_bare_field_days} d/yr`;

  // Populate 5-node Corridor Stepper
  const stepper = document.getElementById("plot-stepper");
  stepper.innerHTML = appData.plots.features
    .map((f) => {
      const p = f.properties;
      const icon = p.risk_class === "high" ? "!" : p.risk_class === "watch" ? "•" : "✓";
      return `
        <button class="step-node" data-id="${p.plot_id}">
          <div class="step-circle ${p.risk_class}">${icon}</div>
          <span class="step-id">${p.plot_id}</span>
          <span class="step-state">${p.risk_class}</span>
        </button>
      `;
    })
    .join("");

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

function selectPlot(feat, fly = true) {
  const p = feat.properties;
  const inspect = document.getElementById("inspect-card");
  inspect.classList.remove("hidden");

  document.getElementById("inspect-title").textContent = `${p.plot_id} · ${p.barangay}`;
  document.getElementById("inspect-meta").textContent =
    `${p.hectares} ha · ${p.current_crop} · ΔSAR ${p.sar_wetness_change_db} dB`;

  const badge = document.getElementById("inspect-risk-badge");
  badge.className = `risk-tag ${p.risk_class}`;
  badge.textContent = `${p.risk_class.toUpperCase()} DROWNING RISK (${p.risk_score}/100)`;

  document.getElementById("inspect-twi").textContent = `TWI: ${p.twi_value}`;
  document.getElementById("inspect-action").textContent = p.plain_language_action;

  const sms = p.sms_alert.slice(0, 160);
  document.getElementById("inspect-sms-text").textContent = sms;
  document.getElementById("sms-counter").textContent = `${sms.length} / 160 chars`;

  if (fly && map) {
    const center = getPolygonCenter(feat.geometry.coordinates[0]);
    map.flyTo({ center, zoom: 15.6, pitch: is3D ? 55 : 0, duration: 900 });
  }
}

function renderRotations(priorityKey) {
  const sorted = [...appData.rotation_strategies].sort(
    (a, b) => a.priorities[priorityKey] - b.priorities[priorityKey]
  );

  document.getElementById("rotation-cards-container").innerHTML = sorted
    .map(
      (s, idx) => `
      <div class="rot-card">
        <h4>#${idx + 1} ${s.name}</h4>
        <div><strong>Crops:</strong> ${s.crops}</div>
        <div>${s.benefits}</div>
        <div class="rot-gap">⚠️ <strong>Verify Locally:</strong> ${s.risks_and_gaps}</div>
      </div>
    `
    )
    .join("");
}

function bindUIEvents() {
  // Drawer Tab Switcher
  document.querySelectorAll(".tab-pill").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab-pill").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

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
    document.getElementById("inspect-card").classList.remove("hidden");
  });

  document.getElementById("btn-bell").addEventListener("click", () => {
    document.getElementById("inspect-card").classList.toggle("hidden");
  });

  document.getElementById("btn-close-inspect").addEventListener("click", () => {
    document.getElementById("inspect-card").classList.add("hidden");
  });

  document.getElementById("btn-reset-bounds").addEventListener("click", () => {
    map.flyTo({ center: [123.2005, 13.6182], zoom: 14.8, pitch: is3D ? 52 : 0, bearing: -12 });
  });

  // Collapse Left Panel
  document.getElementById("btn-chevron-left").addEventListener("click", () => {
    document.getElementById("left-panel-body").classList.toggle("hidden");
  });

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
    const v = e.target.checked ? "visible" : "none";
    map.setLayoutProperty("plots-fill", "visibility", v);
    map.setLayoutProperty("plots-outline", "visibility", v);
  });

  document.getElementById("chk-flood").addEventListener("change", (e) => {
    const v = e.target.checked ? "visible" : "none";
    map.setLayoutProperty("flood-fill", "visibility", v);
    map.setLayoutProperty("flood-outline", "visibility", v);
  });

  document.getElementById("chk-flow").addEventListener("change", (e) => {
    map.setLayoutProperty("corridor-line", "visibility", e.target.checked ? "visible" : "none");
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
  const stages = [
    { clock: "-7d Baseline", sub: "Dry C-Band SAR", sar: "before" },
    { clock: "Storm Hits", sub: "Optical Blocked by Clouds", sar: "before" },
    { clock: "Overpass +6h", sub: "Sentinel-1 Surface Wetness", sar: "after" },
    { clock: "+48h Salvage", sub: "Trench & Early Harvest", sar: "off" },
    { clock: "Next Season", sub: "Legume / Bio-Tillage Shift", sar: "off" }
  ];

  slider.addEventListener("input", (e) => {
    const idx = Number(e.target.value);
    document.querySelectorAll(".scrubber-labels span").forEach((el, i) => {
      el.classList.toggle("active", i === idx);
    });
    document.getElementById("stage-clock").textContent = stages[idx].clock;
    document.getElementById("stage-sub").textContent = stages[idx].sub;
    setSarMode(stages[idx].sar);
    if (idx === 4) document.querySelector('[data-drawer="rotations"]').click();
  });

  document.getElementById("btn-play-timeline").addEventListener("click", (e) => {
    if (playInterval) {
      clearInterval(playInterval);
      playInterval = null;
      e.target.textContent = "▶";
    } else {
      e.target.textContent = "⏸";
      playInterval = setInterval(() => {
        slider.value = (Number(slider.value) + 1) % 5;
        slider.dispatchEvent(new Event("input"));
      }, 2200);
    }
  });

  // Right Tool Dock
  document.getElementById("dock-zoom-in").addEventListener("click", () => map.zoomIn());
  document.getElementById("dock-zoom-out").addEventListener("click", () => map.zoomOut());
  document.getElementById("dock-compass").addEventListener("click", () => map.resetNorth());
  document.getElementById("dock-pitch").addEventListener("click", (e) => {
    is3D = !is3D;
    e.target.textContent = is3D ? "3D" : "2D";
    e.target.classList.toggle("active", is3D);
    map.easeTo({ pitch: is3D ? 52 : 0 });
  });
  document.getElementById("dock-sar").addEventListener("click", (e) => {
    const active = e.target.classList.toggle("active");
    setSarMode(active ? "after" : "off");
  });
  document.getElementById("dock-flood").addEventListener("click", (e) => {
    const chk = document.getElementById("chk-flood");
    chk.checked = !chk.checked;
    chk.dispatchEvent(new Event("change"));
    e.target.classList.toggle("active", chk.checked);
  });
  document.getElementById("dock-center").addEventListener("click", () => {
    document.getElementById("btn-reset-bounds").click();
  });
}

function setSarMode(mode) {
  if (!map || !map.getSource("sar-source")) return;
  if (mode === "off") {
    map.setLayoutProperty("sar-layer", "visibility", "none");
  } else {
    const data =
      mode === "before"
        ? appData.sar_backscatter_comparison.before_event
        : appData.sar_backscatter_comparison.after_event;
    map.getSource("sar-source").setData(data);
    map.setPaintProperty("sar-layer", "fill-color", mode === "before" ? "#94a3b8" : "#06b6d4");
    map.setLayoutProperty("sar-layer", "visibility", "visible");
  }
}

initApp();
