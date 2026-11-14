"""Rotation engine — soil profile, bare-field check and per-plot fit of the three rotations.

Inputs
  * SoilGrids 250 m v2.0 (ISRIC REST point query at each plot centre): sand / silt / clay / SOC,
    thickness-weighted over 0–30 cm (5·[0-5] + 10·[5-15] + 15·[15-30]) / 30, as in terrain_rain.
  * MODIS MOD13Q1 250 m NDVI over cropland (Guian's GEE export, 2020–2026) — used to *check* the
    bare-field window. At 250 m one pixel mixes many paddies planted on different dates, so the
    median cropland pixel never drops into the bare range (0.10–0.25). bare_field_days_per_year is
    therefore left as a flagged placeholder instead of reporting a misleading ~0–5 d/yr.
  * Plot risk class (risk engine) and current crop (baseline).

Ranking = farmer priority rank (frozen contract) + a documented site-fit rule per plot:
  legume (mungbean/cowpea) : caution on high drowning risk — legumes are intolerant of waterlogging
  biotillage (deep roots)  : good where clay ≥ 30 % or risk is high/watch — macropores help drainage
  shortcycle (millet/sesame): caution on high risk — needs drained soil; good on low-risk plots
These are agronomic rules of thumb for discussion with the Municipal Agriculture Office, not yields.
"""
from __future__ import annotations

import csv
import json
from collections import Counter

import requests
from shapely.geometry import shape

from . import common as C

SOILGRIDS_URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
SOIL_CACHE = C.CACHE_DIR / "soilgrids_plots.json"
NDVI_CSV = C.ROOT / "data" / "raw" / "bicol_kristine_2024" / "ndvi" / "modis_ndvi_cropland_cloudmasked.csv"
DEPTH_WEIGHTS = {"0-5cm": 5, "5-15cm": 10, "15-30cm": 15}
BARE_RANGE = (0.10, 0.25)
COMPOSITE_DAYS = 16


# ----------------------------------------------------------------------------- soil

def _texture(sand: float, clay: float) -> str:
    """Simplified USDA texture class from % sand / % clay."""
    if clay >= 40:
        return "clay"
    if clay >= 27:
        return "clay loam" if sand <= 45 else "sandy clay loam"
    if sand >= 52:
        return "sandy loam"
    return "loam"


def _query_soilgrids(lon: float, lat: float) -> dict:
    r = requests.get(SOILGRIDS_URL, params={
        "lon": lon, "lat": lat, "property": ["sand", "silt", "clay", "soc"],
        "depth": list(DEPTH_WEIGHTS), "value": "mean"}, headers=C.HTTP_HEADERS, timeout=60)
    r.raise_for_status()
    out = {}
    for layer in r.json()["properties"]["layers"]:
        vals = {d["label"]: d["values"]["mean"] for d in layer["depths"]}
        if any(vals.get(k) is None for k in DEPTH_WEIGHTS):
            raise ValueError(f"SoilGrids has no {layer['name']} value here")
        out[layer["name"]] = sum(vals[k] * w for k, w in DEPTH_WEIGHTS.items()) / 30.0
    # mapped units: sand/silt/clay g/kg, soc dg/kg
    sand, silt, clay = out["sand"] / 10, out["silt"] / 10, out["clay"] / 10
    return {"sand_pct": round(sand, 1), "silt_pct": round(silt, 1), "clay_pct": round(clay, 1),
            "soc_g_per_kg": round(out["soc"] / 10, 1), "texture": _texture(sand, clay)}


def soil_profiles(refresh: bool = False) -> tuple[dict, dict]:
    """{plot_id: soil dict} and source metadata. Cached; never fails the pipeline."""
    cache = {} if refresh or not SOIL_CACHE.exists() else json.loads(SOIL_CACHE.read_text(encoding="utf-8"))
    mode = "cached_live" if cache else "live"
    for f in C.load_plots():
        pid = f["properties"]["plot_id"]
        if pid in cache:
            continue
        c = shape(f["geometry"]).centroid
        try:
            cache[pid] = _query_soilgrids(round(c.x, 5), round(c.y, 5))
        except Exception as exc:  # offline: leave this plot without soil data
            cache[pid] = None
            mode = f"partial ({type(exc).__name__})"
    if any(v is not None for v in cache.values()):
        C.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        SOIL_CACHE.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    meta = {"source": "ISRIC SoilGrids 250 m v2.0 (REST point query at plot centres), 0–30 cm weighted",
            "data_mode": mode}
    return cache, meta


# ----------------------------------------------------------------------------- bare-field check

def modis_bare_field_check() -> dict:
    """What MODIS 250 m cropland NDVI says about bare-field windows (reported, not used as a value)."""
    if not NDVI_CSV.exists():
        return {"status": "unavailable", "reason": "MODIS NDVI export not found"}
    rows = list(csv.DictReader(open(NDVI_CSV, encoding="utf-8")))
    full_years = sorted({r["date"][:4] for r in rows if sum(1 for x in rows if x["date"][:4] == r["date"][:4]) >= 23})
    out = {"source": "MODIS MOD13Q1 250 m NDVI, cropland mask, cloud-masked (GEE export)",
           "period": f"{rows[0]['date']}..{rows[-1]['date']}", "bare_ndvi_range": list(BARE_RANGE)}
    for col in ("ndvi_p50", "ndvi_p10"):
        bare = Counter(r["date"][:4] for r in rows if r[col] and BARE_RANGE[0] < float(r[col]) < BARE_RANGE[1])
        days = [bare.get(y, 0) * COMPOSITE_DAYS for y in full_years]
        out[f"{col}_bare_days_per_year"] = round(sum(days) / len(days), 1) if days else None
        out[f"{col}_min"] = round(min(float(r[col]) for r in rows if r[col]), 2)
    out["status"] = "not_used"
    out["why"] = ("At 250 m each pixel mixes many paddies planted on different dates, so the median cropland "
                  "pixel never looks bare. Field-level bare windows need 30 m Landsat/Sentinel-2 NDVI or the "
                  "MAO cropping calendar; bare_field_days_per_year stays a placeholder until then.")
    return out


# ----------------------------------------------------------------------------- per-plot fit

def plot_fit(risk_class: str, soil: dict | None) -> dict:
    clay = soil["clay_pct"] if soil else None
    fit = {}
    if risk_class == "high":
        fit["legume"] = {"fit": "caution", "why": "high drowning risk — mungbean/cowpea do not tolerate waterlogging; "
                                                  "plant only after drainage or on raised beds"}
    else:
        fit["legume"] = {"fit": "good", "why": "drainage risk is manageable for a post-harvest legume"}
    if (clay is not None and clay >= 30) or risk_class in ("high", "watch"):
        why = []
        if clay is not None and clay >= 30:
            why.append(f"{clay:.0f}% clay drains slowly")
        if risk_class in ("high", "watch"):
            why.append(f"{risk_class} drowning risk")
        fit["biotillage"] = {"fit": "good", "why": " and ".join(why) + " — deep roots open drainage pores"}
    else:
        fit["biotillage"] = {"fit": "neutral", "why": "soil already drains reasonably"}
    if risk_class == "high":
        fit["shortcycle"] = {"fit": "caution", "why": "millet/sesame need drained soil; fix drainage first"}
    elif risk_class == "low":
        fit["shortcycle"] = {"fit": "good", "why": "well-drained plot suits low-water short-cycle crops"}
    else:
        fit["shortcycle"] = {"fit": "neutral", "why": "workable once furrows are kept clear"}
    return fit


RULES_TEXT = ("Per-plot fit: legume = caution on high drowning risk (waterlogging-intolerant); biotillage = good "
              "where clay ≥ 30% or risk high/watch; shortcycle = caution on high risk, good on low risk. "
              "Ranking within a priority stays as in rotation_strategies.priorities. Rules of thumb to verify "
              "with the Municipal Agriculture Office.")
