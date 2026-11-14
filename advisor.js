// Field Shift crop advisor widget — floating chat beside the map.
// Talks to POST /api/advisor/chat; follows the plot selected on the map.
(function () {
  const API = "/api/advisor";
  let plotId = null;
  let sessionId = null;
  try {
    sessionId = localStorage.getItem("fs-advisor-session");
  } catch (_) {}
  if (!sessionId) {
    sessionId = "s" + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem("fs-advisor-session", sessionId); } catch (_) {}
  }

  const root = document.createElement("div");
  root.className = "fs-advisor";
  root.innerHTML = `
    <button class="fs-advisor-fab" type="button" aria-expanded="false" aria-controls="fs-advisor-panel">
      <span aria-hidden="true">🌾</span> Crop Advisor
    </button>
    <section class="fs-advisor-panel floating-card" id="fs-advisor-panel" hidden aria-label="AI crop advisor">
      <header class="fs-advisor-head">
        <div>
          <strong>Crop Advisor</strong>
          <span class="fs-advisor-plot">All plots</span>
        </div>
        <button class="fs-advisor-close" type="button" aria-label="Close advisor">×</button>
      </header>
      <div class="fs-advisor-log" role="log" aria-live="polite"></div>
      <div class="fs-advisor-chips"></div>
      <form class="fs-advisor-form">
        <input type="text" maxlength="1000" placeholder="Ask about this plot… (English, Filipino, Bikol)" aria-label="Message" />
        <button type="submit">Send</button>
      </form>
      <footer class="fs-advisor-foot">Uses Sentinel-1, NASADEM, NASA POWER &amp; LSTM soil outlook. Verify with your MAO.</footer>
    </section>`;
  document.body.appendChild(root);

  const fab = root.querySelector(".fs-advisor-fab");
  const panel = root.querySelector(".fs-advisor-panel");
  const log = root.querySelector(".fs-advisor-log");
  const chips = root.querySelector(".fs-advisor-chips");
  const form = root.querySelector(".fs-advisor-form");
  const input = form.querySelector("input");
  const plotLabel = root.querySelector(".fs-advisor-plot");

  const SUGGESTIONS = [
    "What should I do on this plot now?",
    "How long will the roots stay waterlogged?",
    "What should I plant after harvest?",
    "Which barangay needs a visit first?",
  ];
  SUGGESTIONS.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.addEventListener("click", () => send(s));
    chips.appendChild(b);
  });

  function toggle(open) {
    panel.hidden = !open;
    fab.setAttribute("aria-expanded", String(open));
    if (open) input.focus();
  }
  fab.addEventListener("click", () => toggle(panel.hidden));
  root.querySelector(".fs-advisor-close").addEventListener("click", () => toggle(false));

  function bubble(text, who, meta) {
    const div = document.createElement("div");
    div.className = `fs-msg fs-msg-${who}`;
    div.textContent = text; // plain text only: never render model output as HTML
    if (meta) {
      const m = document.createElement("small");
      m.textContent = meta;
      div.appendChild(m);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  async function send(text) {
    text = (text || "").trim();
    if (!text) return;
    toggle(true);
    bubble(text, "user");
    input.value = "";
    const pending = bubble("Thinking…", "bot");
    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, plot_id: plotId, session_id: sessionId }),
      });
      const data = await res.json();
      pending.remove();
      if (!res.ok) {
        bubble(data.detail ? String(data.detail.msg || data.detail) : "Advisor unavailable.", "bot");
        return;
      }
      let meta = data.mode === "groq" ? "AI · grounded in satellite data" : "Rule-based (AI offline)";
      if (data.remembered && data.remembered.length) meta += ` · saved ${data.remembered.length} field note`;
      bubble(data.reply, "bot", meta);
    } catch (e) {
      pending.remove();
      bubble("Cannot reach the advisor. Is the API server running?", "bot");
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });

  function setPlot(id, label) {
    plotId = id;
    plotLabel.textContent = label || id || "All plots";
  }

  // Follow the plot selected on the map (app.js defines a global selectPlot).
  function hook() {
    if (typeof window.selectPlot !== "function") return setTimeout(hook, 300);
    const original = window.selectPlot;
    window.selectPlot = function (feat, ...rest) {
      const r = original.call(this, feat, ...rest);
      if (feat && feat.properties) {
        const p = feat.properties;
        setPlot(p.plot_id, `${p.plot_id} · ${p.barangay} · ${String(p.risk_class).toUpperCase()}`);
      }
      return r;
    };
  }
  hook();

  bubble(
    "Hi! I explain what the satellites saw on your plot and what to do next. Select a plot on the map, then ask me anything.",
    "bot"
  );
})();
