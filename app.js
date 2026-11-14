async function initDashboard() {
  const response = await fetch("mock-data.json");
  const data = await response.json();

  // Initialize MapLibre GL JS with a no-key OSM raster basemap
  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "&copy; OpenStreetMap contributors"
        }
      },
      layers: [
        {
          id: "osm-base",
          type: "raster",
          source: "osm",
          paint: { "raster-brightness-max": 0.45, "raster-saturation": -0.6 }
        }
      ]
    },
    center: [123.1845, 13.6230],
    zoom: 15
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", () => {
    // 1. SAR Backscatter Before/After Source
    map.addSource("sar-layer", {
      type: "geojson",
      data: data.sar_backscatter_comparison.after_event
    });

    map.addLayer({
      id: "sar-fill",
      type: "fill",
      source: "sar-layer",
      layout: { visibility: "none" },
      paint: {
        "fill-color": "#06b6d4",
        "fill-opacity": 0.35
      }
    });

    // 2. Field Drowning Risk Source & 3-Class Fill Layer
    map.addSource("plots", {
      type: "geojson",
      data: data.plots
    });

    map.addLayer({
      id: "plots-fill",
      type: "fill",
      source: "plots",
      paint: {
        "fill-color": [
          "match",
          ["get", "risk_class"],
          "high", "#ef4444",
          "watch", "#f59e0b",
          "low", "#10b981",
          "#64748b"
        ],
        "fill-opacity": 0.65
      }
    });

    map.addLayer({
      id: "plots-outline",
      type: "line",
      source: "plots",
      paint: {
        "line-color": "#f8fafc",
        "line-width": 2
      }
    });

    // 3. Observed Flood Extent Overlay
    map.addSource("observed-flood", {
      type: "geojson",
      data: data.observed_flood_extent
    });

    map.addLayer({
      id: "flood-fill",
      type: "fill",
      source: "observed-flood",
      paint: {
        "fill-color": "#3b82f6",
        "fill-opacity": 0.45
      }
    });

    map.addLayer({
      id: "flood-outline",
      type: "line",
      source: "observed-flood",
      paint: {
        "line-color": "#93c5fd",
        "line-width": 2,
        "line-dasharray": [2, 2]
      }
    });

    // Click handler to update Plot Card & SMS Alert
    map.on("click", "plots-fill", (e) => {
      if (e.features && e.features.length > 0) {
        renderPlotDetails(e.features[0].properties);
      }
    });

    map.on("mouseenter", "plots-fill", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "plots-fill", () => {
      map.getCanvas().style.cursor = "";
    });
  });

  // Layer Visibility Toggles
  document.getElementById("toggle-risk").addEventListener("change", (e) => {
    const vis = e.target.checked ? "visible" : "none";
    map.setLayoutProperty("plots-fill", "visibility", vis);
    map.setLayoutProperty("plots-outline", "visibility", vis);
  });

  document.getElementById("toggle-flood").addEventListener("change", (e) => {
    const vis = e.target.checked ? "visible" : "none";
    map.setLayoutProperty("flood-fill", "visibility", vis);
    map.setLayoutProperty("flood-outline", "visibility", vis);
  });

  // Before / After SAR Switcher
  document.querySelectorAll(".sar-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sar-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const mode = btn.dataset.sar;
      if (mode === "off") {
        map.setLayoutProperty("sar-fill", "visibility", "none");
      } else {
        const geojson =
          mode === "before"
            ? data.sar_backscatter_comparison.before_event
            : data.sar_backscatter_comparison.after_event;
        map.getSource("sar-layer").setData(geojson);
        map.setPaintProperty("sar-fill", "fill-color", mode === "before" ? "#64748b" : "#06b6d4");
        map.setLayoutProperty("sar-fill", "visibility", "visible");
      }
    });
  });

  // Populate initial high-risk plot, rotation options, and provenance limits
  renderPlotDetails(data.plots.features[0].properties);
  renderRotations(data.rotation_strategies);
  renderProvenance(data.provenance);
}

function renderPlotDetails(props) {
  document.getElementById("plot-id").textContent = props.plot_id;
  document.getElementById("plot-barangay").textContent = props.barangay;
  document.getElementById("plot-hectares").textContent = `${props.hectares} ha`;
  document.getElementById("plot-crop").textContent = props.current_crop;
  document.getElementById("plot-sar").textContent = `${props.sar_wetness_change_db} dB`;
  document.getElementById("plot-bare").textContent = `${props.bare_field_days_per_year} days/yr`;
  document.getElementById("plot-action").textContent = props.plain_language_action;

  const badge = document.getElementById("plot-risk-badge");
  badge.className = `risk-pill ${props.risk_class}`;
  badge.textContent = `${props.risk_class.toUpperCase()} RISK`;

  // Enforce <= 160 character display on SMS alert
  const sms = props.sms_alert.slice(0, 160);
  document.getElementById("sms-text").textContent = sms;
  document.getElementById("sms-char-count").textContent = `${sms.length} / 160 chars`;
}

function renderRotations(strategies) {
  const container = document.getElementById("rotation-list");
  container.innerHTML = strategies
    .map(
      (s) => `
      <div class="rotation-item">
        <h3>#${s.rank} ${s.name}</h3>
        <div class="crops">Recommended: ${s.crops}</div>
        <div><strong>Benefits:</strong> ${s.benefits}</div>
        <div class="risk-note"><strong>Risks &amp; Local Gaps:</strong> ${s.risks_and_gaps}</div>
      </div>
    `
    )
    .join("");
}

function renderProvenance(prov) {
  const list = document.getElementById("dataset-list");
  list.innerHTML = prov.datasets_used.map((d) => `<li>${d}</li>`).join("");
  document.getElementById("future-datasets").textContent =
    `Future work (not used in 12-hour build): ${prov.future_work_datasets.join(", ")}.`;
}

initDashboard();
