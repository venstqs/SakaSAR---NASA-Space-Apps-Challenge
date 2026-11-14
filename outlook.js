// Field Shift — LSTM soil-saturation outlook panel (reads /api/soil-outlook or data/soil_outlook.json).
(function () {
  const SVG = "http://www.w3.org/2000/svg";
  const WATERLOGGED = 0.97;

  const root = document.createElement("div");
  root.className = "fs-outlook";
  root.innerHTML = `
    <button class="fs-outlook-fab" type="button" aria-expanded="false" aria-controls="fs-outlook-panel">
      <span aria-hidden="true">💧</span> Soil Outlook · LSTM
    </button>
    <section class="fs-outlook-panel floating-card" id="fs-outlook-panel" hidden aria-label="LSTM soil saturation outlook">
      <header class="fs-outlook-head">
        <div><strong>Root-zone saturation</strong><span>LSTM trained on NASA POWER 2001–2026</span></div>
        <button class="fs-outlook-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="fs-outlook-body"><p class="fs-outlook-muted">Loading…</p></div>
    </section>`;
  document.body.appendChild(root);

  const fab = root.querySelector(".fs-outlook-fab");
  const panel = root.querySelector(".fs-outlook-panel");
  const body = root.querySelector(".fs-outlook-body");
  const toggle = (open) => { panel.hidden = !open; fab.setAttribute("aria-expanded", String(open)); };
  fab.addEventListener("click", () => toggle(panel.hidden));
  root.querySelector(".fs-outlook-close").addEventListener("click", () => toggle(false));
  if (location.hash === "#outlook") toggle(true); // deep link for demos

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = (tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  };

  function chart(days) {
    const W = 330, H = 140, L = 34, R = 20, T = 10, B = 24;
    const vals = days.flatMap((d) => [d.gwetroot_pred, d.gwetroot_actual]);
    const lo = Math.min(0.9, Math.floor(Math.min(...vals) * 50) / 50), hi = 1.0;
    const x = (i) => L + (i * (W - L - R)) / (days.length - 1);
    const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
    const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "fs-outlook-chart", role: "img",
      "aria-label": "Predicted versus actual root-zone saturation" });
    [lo, (lo + hi) / 2, hi].forEach((v) => {
      s.appendChild(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }));
      const t = svg("text", { x: L - 4, y: y(v) + 3, "text-anchor": "end", class: "axis" });
      t.textContent = v.toFixed(2);
      s.appendChild(t);
    });
    s.appendChild(svg("line", { x1: L, x2: W - R, y1: y(WATERLOGGED), y2: y(WATERLOGGED), class: "threshold" }));
    const tl = svg("text", { x: L + 4, y: y(WATERLOGGED) + 11, "text-anchor": "start", class: "threshold-label" });
    tl.textContent = "waterlogged ≥ 0.97";
    s.appendChild(tl);
    const path = (key) => days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join("");
    s.appendChild(svg("path", { d: path("gwetroot_actual"), class: "actual" }));
    s.appendChild(svg("path", { d: path("gwetroot_pred"), class: "pred" }));
    days.forEach((d, i) => {
      s.appendChild(svg("circle", { cx: x(i), cy: y(d.gwetroot_pred), r: 2.6, class: "pred-dot" }));
      const t = svg("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "axis" });
      t.textContent = d.date.slice(5);
      s.appendChild(t);
    });
    return s;
  }

  function render(o) {
    body.innerHTML = "";
    const hs = o.hindcasts;
    let current = hs.length - 1;

    const tabs = el("div", "fs-outlook-tabs");
    const view = el("div");
    hs.forEach((h, i) => {
      const b = el("button", i === current ? "active" : "", i === 0 ? "Storm week" : "After 2 Nov pass");
      b.type = "button";
      b.addEventListener("click", () => {
        current = i;
        tabs.querySelectorAll("button").forEach((x, j) => x.classList.toggle("active", j === i));
        draw();
      });
      tabs.appendChild(b);
    });

    function draw() {
      const h = hs[current];
      view.innerHTML = "";
      view.appendChild(el("p", "fs-outlook-label", h.label));
      const stats = el("div", "fs-outlook-stats");
      [["Root zone at issue", h.root_zone_today.toFixed(2)],
       ["Waterlogged days (pred)", `${h.days_waterlogged_pred} / 7`],
       ["Actual", `${h.days_waterlogged_actual} / 7`]].forEach(([k, v]) => {
        const c = el("div");
        c.appendChild(el("b", null, v));
        c.appendChild(el("span", null, k));
        stats.appendChild(c);
      });
      view.appendChild(stats);
      view.appendChild(chart(h.days));
      const legend = el("div", "fs-outlook-legend");
      legend.appendChild(el("span", "pred", "LSTM forecast"));
      legend.appendChild(el("span", "actual", "NASA POWER actual"));
      view.appendChild(legend);
    }

    body.appendChild(tabs);
    body.appendChild(view);
    draw();

    const so = o.scenario_outlook;
    body.appendChild(el("h4", null, `Next 7 days from ${so.issued_after} · root zone ${so.root_zone_today.toFixed(2)} (${so.root_zone_class_today})`));
    const list = el("ul", "fs-outlook-scen");
    so.cases.forEach((c) => {
      const li = el("li");
      li.appendChild(el("span", null, c.scenario.replace(/\s*\(.*\)/, "")));
      li.appendChild(el("span", null, `${Math.round(c.rain_total_mm)} mm`));
      li.appendChild(el("b", `cls-${c.end_of_week_class}`, `${c.days_waterlogged} waterlogged d · ends ${c.end_of_week_class}`));
      list.appendChild(li);
    });
    body.appendChild(list);

    const m = o.metrics.GWETROOT;
    body.appendChild(el("p", "fs-outlook-muted",
      `Tested on unseen ${o.metrics.split.test}: ${m.skill_vs_persistence_pct}% lower error than “same as today”, ` +
      `${m.skill_vs_ridge_pct}% lower than linear regression. Regional (~50 km) NASA model output, not a paddy sensor.`));
  }

  async function load() {
    for (const url of ["/api/soil-outlook", "data/soil_outlook.json"]) {
      try {
        const r = await fetch(url);
        if (r.ok) return render(await r.json());
      } catch (_) {}
    }
    body.innerHTML = "";
    body.appendChild(el("p", "fs-outlook-muted", "Soil outlook unavailable — run python -m pipeline.soil_lstm."));
  }
  load();
})();
