"""Farmer recommendations — one timeline per plot, built from measured data and the LSTM.

Each plot gets up to four steps. Every step names the evidence it uses, so a farmer or
extension officer can see why:

  Next 48 hours        ← plot risk class from Sentinel-1 ΔVV + NASADEM TWI + GPM IMERG (risk engine)
  This week            ← LSTM root-zone forecast after the 2 Nov 2024 pass (days waterlogged of 7)
  Before the next storm← LSTM scenario from the latest NASA POWER day: a Kristine-like week of rain
  Next season          ← rotation fit (SoilGrids texture + drowning risk) ranked for the farmer's priority

The LSTM describes the regional root zone (~50 km NASA POWER cell). Recommendations combine
that regional outlook with each plot's own measured risk; they are decision support to check
with the Municipal Agriculture Office, not prescriptions.
"""
from __future__ import annotations

import json

from . import common as C

OUTLOOK_PATH = C.DATA_DIR / "soil_outlook.json"
WATERLOGGED = 0.97
PRIORITY_LABEL = {"nitrogen": "soil nitrogen", "water": "water saving", "cash": "cash income"}


def load_outlook() -> dict | None:
    if not OUTLOOK_PATH.exists():
        return None
    return json.loads(OUTLOOK_PATH.read_text(encoding="utf-8"))


def _after_pass_hindcast(outlook: dict) -> dict | None:
    hs = outlook.get("hindcasts") or []
    return next((h for h in hs if "2 Nov" in h.get("label", "")), hs[-1] if hs else None)


def _kristine_case(outlook: dict) -> dict | None:
    cases = (outlook.get("scenario_outlook") or {}).get("cases") or []
    return next((c for c in cases if "Kristine" in c["scenario"]), None)


def _best_rotation(rotations: list, fit: dict, priority: str) -> dict:
    """Highest-ranked strategy for the priority, skipping 'caution' fits when a better one exists."""
    order = {"good": 0, "neutral": 1, "caution": 2}
    ranked = sorted(rotations, key=lambda s: (order.get(fit.get(s["id"], {}).get("fit"), 1),
                                               s["priorities"][priority]))
    return ranked[0]


def plot_recommendations(p: dict, outlook: dict | None, rotations: list, rain_mm: float) -> list[dict]:
    pid, cls, crop = p["plot_id"], p["risk_class"], p.get("baseline_crop") or p["current_crop"]
    crop_word = "rice" if "rice" in crop.lower() else "corn" if "corn" in crop.lower() else crop.lower()
    recs: list[dict] = []

    # 1. Next 48 hours — measured risk
    if cls == "high":
        act = (f"Open field outlets and cut a 30 cm drainage trench along the lowest bund. If the {crop_word} "
               f"is near maturity, harvest early rather than risk root rot.")
    elif cls == "watch":
        act = "Clear perimeter furrows and outlets, and walk the low corners after each rain band."
    else:
        act = "No emergency action. Keep outlets clear."
    recs.append({"when": "Next 48 hours", "action": act,
                 "why": (f"Risk {p['risk_score']}/100 ({cls}): radar change {p['sar_wetness_change_db']:+.1f} dB, "
                         f"terrain wetness index {p['twi_value']}, {rain_mm:.0f} mm storm rain."),
                 "sources": ["Sentinel-1", "NASADEM", "GPM IMERG"]})

    # 2. This week — LSTM after the post-storm pass
    h = _after_pass_hindcast(outlook) if outlook else None
    if h:
        days = h["days_waterlogged_pred"]
        if days >= 5 and cls in ("high", "watch"):
            act = ("Keep outlets open all week and do not replant or apply fertiliser yet: the root zone is "
                   "forecast to stay waterlogged.")
        elif days >= 5:
            act = "Soil stays very wet this week; avoid heavy machinery on the field so it does not compact."
        else:
            act = "The root zone is forecast to drain this week; resume normal field work as it dries."
        recs.append({"when": "This week", "action": act,
                     "why": (f"LSTM forecast issued {h['issued']} (day after the 2 Nov radar pass): root zone "
                             f"{h['root_zone_today']:.2f} of saturation, waterlogged on {days} of the next 7 days."),
                     "sources": ["LSTM (NASA POWER)"]})

    # 3. Before the next storm — LSTM scenario from today's soil
    k = _kristine_case(outlook) if outlook else None
    so = (outlook or {}).get("scenario_outlook") or {}
    if k:
        if cls == "high":
            act = ("Before the next typhoon warning: desilt the tertiary canal and pre-cut the drainage trench; "
                   "this plot floods first.")
        elif cls == "watch":
            act = "Before the next typhoon warning: clear furrows and check that outlets drain to the canal."
        else:
            act = "Before the next typhoon warning: routine outlet check is enough for this plot."
        recs.append({"when": "Before the next storm", "action": act,
                     "why": (f"LSTM scenario from {so.get('issued_after')}: root zone now "
                             f"{so.get('root_zone_today', 0):.2f} ({so.get('root_zone_class_today')}); a Kristine-like week "
                             f"({k['rain_total_mm']:.0f} mm) would leave it '{k['end_of_week_class']}'."),
                     "sources": ["LSTM (NASA POWER)"]})

    # 4. Next season — rotation fit
    fit = p.get("rotation_fit") or {}
    if rotations and fit:
        best = _best_rotation(rotations, fit, "nitrogen")
        bf = fit.get(best["id"], {})
        soil = p.get("soil_0_30cm") or {}
        recs.append({"when": "Next season", "action": f"Consider {best['name']} ({best['crops']}) after the {crop_word} harvest.",
                     "why": (f"{bf.get('why', '').capitalize()}. Soil: {soil.get('texture', 'n/a')}, "
                             f"{soil.get('clay_pct', 'n/a')}% clay. Check seed supply and soil pH with the MAO."),
                     "sources": ["SoilGrids", "Risk engine"]})
    return recs


METHOD = ("Per-plot timeline: next 48 h from the measured risk class; this week from the LSTM root-zone forecast "
          "after the 2 Nov 2024 pass; before the next storm from the LSTM Kristine-like scenario run on the latest "
          "NASA POWER day; next season from the rotation fit. The LSTM is regional (~50 km); plot specifics come "
          "from the radar, terrain and soil.")
