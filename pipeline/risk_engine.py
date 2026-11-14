"""Task 2 — Field Drowning Risk fusion and dashboard export (feature/risk-engine).

Runs the SAR (§3A) and terrain/rain (§3B–C) stages, then CLAUDE.md §3D:
  RiskScore = round(100 × (0.45·S_SAR + 0.35·S_TWI + 0.20·S_Rain))
  high ≥ 70 · watch 40–69 · low < 40
  SAR hit rate = area(flood ∩ ⋃ high plots) / area(flood)

Writes mock-data.json (frozen frontend contract — keys are only ever added, never renamed or
removed) and data/processed_field_shift.json (same payload).

Run:  python -m pipeline.risk_engine [--refresh]
"""
from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict

import numpy as np
from shapely.geometry import shape
from shapely.ops import unary_union

from . import common as C
from . import sar_moisture as S
from . import terrain_rain as T

W_SAR, W_TWI, W_RAIN = 0.45, 0.35, 0.20
MOCK_PATH = C.ROOT / "mock-data.json"
PROCESSED_PATH = C.DATA_DIR / "processed_field_shift.json"
ROTATIONS_PATH = C.ROOT / "pipeline" / "rotation_strategies.json"
SMS_MAX = 160


def risk_score(s_sar: float, s_twi: float, s_rain: float) -> int:
    return int(round(100 * (W_SAR * s_sar + W_TWI * s_twi + W_RAIN * s_rain)))


def risk_class(score: int) -> str:
    return "high" if score >= 70 else "watch" if score >= 40 else "low"


CLASS_CODES = {"missing": -1, "low": 0, "watch": 1, "high": 2}


def classify_grid(score: np.ndarray) -> np.ndarray:
    """Per-pixel class codes: 2 high, 1 watch, 0 low, -1 missing data (NaN score)."""
    out = np.where(score >= 69.5, 2, np.where(score >= 39.5, 1, 0))  # matches round() then threshold
    return np.where(np.isfinite(score), out, -1).astype(np.int8)


def risk_grids(d_vv_db: np.ndarray, twi_grid: np.ndarray, s_rain_value: float) -> dict:
    """Full model and a terrain+rain-only model (no SAR) on the shared 30 m grid.

    The terrain-only model is what makes the hit rate a real test: it predicts flooding
    without looking at the radar, so comparing it with the SAR flood mask is not circular.
    """
    s_sar_px = np.clip(-d_vv_db / 4.0, 0.0, 1.0)  # NaN where SAR is missing
    s_twi_px = np.clip((twi_grid - 5.0) / 10.0, 0.0, 1.0)
    full = 100 * (W_SAR * s_sar_px + W_TWI * s_twi_px + W_RAIN * s_rain_value)
    terrain_only = 100 * (W_TWI * s_twi_px + W_RAIN * s_rain_value) / (W_TWI + W_RAIN)
    return {"score": full, "class": classify_grid(full),
            "terrain_score": terrain_only, "terrain_class": classify_grid(terrain_only)}


def pixel_hit_rate(flood: np.ndarray, cls: np.ndarray, region: np.ndarray) -> float | None:
    """Share (%) of SAR-flooded cells in `region` that the risk map rated high."""
    flooded = flood & region
    n = int(flooded.sum())
    if n == 0:
        return None
    return 100.0 * int((flooded & (cls == 2)).sum()) / n


def class_shares(cls: np.ndarray, mask: np.ndarray) -> dict:
    cell_ha = C.CELL * C.CELL / 10_000
    n = int(mask.sum())
    out = {}
    for name, code in CLASS_CODES.items():
        k = int((cls[mask] == code).sum())
        out[f"{name}_ha"] = round(k * cell_ha, 2)
        out[f"{name}_share"] = round(k / n, 3) if n else 0.0
    return out


def hit_rate(flood_geoms_wgs: list, high_plot_geoms_wgs: list) -> tuple[float | None, float]:
    """(hit rate in %, flood area in ha). None when the SAR mask is empty (rate undefined)."""
    if not flood_geoms_wgs:
        return None, 0.0
    flood = unary_union([C.to_utm(g) for g in flood_geoms_wgs])
    if flood.area == 0:
        return None, 0.0
    high = unary_union([C.to_utm(g) for g in high_plot_geoms_wgs]) if high_plot_geoms_wgs else None
    hit = flood.intersection(high).area if high is not None else 0.0
    return 100.0 * hit / flood.area, flood.area / 10_000


# ----------------------------------------------------------------------------- farmer-facing text

def _crop_short(crop: str) -> str:
    c = crop.lower()
    return "rice" if "rice" in c else "corn" if "corn" in c else crop.lower()


def _driver(p: dict, rain_mm: float) -> str:
    parts = {
        "sar": W_SAR * p["s_sar"],
        "twi": W_TWI * p["s_twi"],
        "rain": W_RAIN * p["s_rain"],
    }
    top = max(parts, key=parts.get)
    return {
        "sar": f"a {p['sar_wetness_change_db']:+.1f} dB Sentinel-1 wetness drop",
        "twi": f"low-lying runoff convergence (TWI {p['twi_value']})",
        "rain": f"the {rain_mm:.0f} mm storm rainfall total",
    }[top]


def farmer_text(p: dict, rain_mm: float) -> tuple[str, str]:
    """(plain_language_action, sms_alert ≤ 160 chars) generated from the computed values."""
    pid, ha, cls, score = p["plot_id"], p["hectares"], p["risk_class"], p["risk_score"]
    brgy = p["barangay"].replace("Brgy. ", "")
    crop = _crop_short(p["current_crop"])
    driver = _driver(p, rain_mm)

    if cls == "high":
        action = (f"High drowning risk driven by {driver} on ground that collects runoff "
                  f"(TWI {p['twi_value']}). Open field outlets and cut a 30 cm drainage trench along the lowest bund "
                  f"within 48 h; harvest mature {crop} early if water stands more than 2 days.")
        sms = f"FIELD SHIFT ALERT: {pid} ({ha}ha, {brgy}) HIGH drowning risk ({score}/100). Open outlets, trench lowest bund in 48h; harvest mature {crop} early."
    elif cls == "watch":
        action = (f"Moderate drowning risk, mainly from {driver}. Clear perimeter furrows and field outlets before "
                  f"the next rain band and re-check after the next Sentinel-1 pass (12-day repeat).")
        sms = f"FIELD SHIFT WATCH: {pid} ({ha}ha, {brgy}) moderate risk ({score}/100). Clear furrows and outlets before next rain; recheck in 12 days."
    else:
        sar_note = ("no ponding signal in Sentinel-1 (VV backscatter "
                    f"{'rose' if p['sar_wetness_change_db'] >= 0 else 'fell'} {abs(p['sar_wetness_change_db']):.1f} dB)")
        action = (f"Low drowning risk: {sar_note} and moderate terrain wetness (TWI {p['twi_value']}). "
                  f"Normal drainage is adequate; good candidate for a post-harvest legume rotation.")
        sms = f"FIELD SHIFT CLEAR: {pid} ({ha}ha, {brgy}) LOW risk ({score}/100). No ponding seen by satellite; keep outlets clear, plan legume rotation."
    if len(sms) > SMS_MAX:
        sms = sms[: SMS_MAX - 1] + "…"
    return action, sms


# ----------------------------------------------------------------------------- run

def run(refresh: bool = False) -> dict:
    t0 = time.perf_counter()
    sar = S.run(refresh=refresh)
    terr = T.run(refresh=refresh)
    rain = terr["rainfall"]
    sar_by_id = {p["plot_id"]: p for p in sar["plots"]}
    terr_by_id = {p["plot_id"]: p for p in terr["plots"]}
    g_sar, g_ter = sar.pop("_grids"), terr.pop("_grids")
    grids = risk_grids(g_sar["d_vv_db"], g_ter["twi"], rain["s_rain"])
    bbox_mask = C.plot_mask(C.bbox_polygon_wgs())

    features, high_geoms = [], []
    for f in C.load_plots():
        meta = f["properties"]
        pid = meta["plot_id"]
        s, t = sar_by_id[pid], terr_by_id[pid]
        geom = shape(f["geometry"])
        p = dict(meta)
        p.update({
            "sar_wetness_change_db": s["sar_wetness_change_db"],
            "twi_value": t["twi_value"],
            "s_sar": s["s_sar"],
            "s_twi": t["s_twi"],
            "s_rain": rain["s_rain"],
        })
        p["risk_score"] = risk_score(p["s_sar"], p["s_twi"], p["s_rain"])
        p["risk_class"] = risk_class(p["risk_score"])
        p["plain_language_action"], p["sms_alert"] = farmer_text(p, rain["r_total_mm"])
        # Extra diagnostics (additive keys; the dashboard ignores them)
        p.update({
            "vh_wetness_change_db": s.get("vh_wetness_change_db"),
            "vv_before_db": s["vv_before_db"],
            "vv_after_db": s["vv_after_db"],
            "flooded_pixel_fraction": s["flooded_pixel_fraction"],
            "mean_slope_deg": t["mean_slope_deg"],
            "mean_elevation_m": t["mean_elevation_m"],
            "polygon_area_ha": round(C.to_utm(geom).area / 10_000, 2),
        })
        pmask = C.plot_mask(geom)
        shares = class_shares(grids["class"], pmask)
        p["risk_zone_shares"] = shares
        p["missing_data_fraction"] = shares["missing_share"]
        ordered = {k: p[k] for k in ("plot_id", "name", "barangay", "hectares", "households", "risk_class",
                                     "risk_score", "sar_wetness_change_db", "twi_value", "current_crop",
                                     "bare_field_days_per_year", "plain_language_action", "sms_alert")}
        ordered.update({k: v for k, v in p.items() if k not in ordered})
        features.append({"type": "Feature", "properties": ordered, "geometry": f["geometry"]})
        if p["risk_class"] == "high":
            high_geoms.append(geom)

    flood_geoms = [shape(ft["geometry"]) for ft in sar["observed_flood_extent"]["features"]]
    plot_rate, flood_ha = hit_rate(flood_geoms, high_geoms)
    rate = pixel_hit_rate(g_sar["flood"], grids["class"], bbox_mask)
    rate_terrain = pixel_hit_rate(g_sar["flood"], grids["terrain_class"], bbox_mask)
    fmt = lambda r: f"{r:.0f}%" if r is not None else "n/a"  # noqa: E731

    by_brgy: dict = defaultdict(lambda: {"plots": 0, "high_risk_ha": 0.0, "watch_ha": 0.0,
                                         "high_risk_households": 0, "scores": []})
    for ft in features:
        p = ft["properties"]
        b = by_brgy[p["barangay"]]
        b["plots"] += 1
        b["high_risk_ha"] += p["risk_zone_shares"]["high_ha"]
        b["watch_ha"] += p["risk_zone_shares"]["watch_ha"]
        b["high_risk_households"] += p["households"] if p["risk_class"] == "high" else 0
        b["scores"].append(p["risk_score"])
    barangay_ranking = sorted(
        ({"barangay": k, "plots": v["plots"], "high_risk_ha": round(v["high_risk_ha"], 2),
          "watch_ha": round(v["watch_ha"], 2), "high_risk_households": v["high_risk_households"],
          "max_risk_score": max(v["scores"])} for k, v in by_brgy.items()),
        key=lambda r: (-r["high_risk_ha"], -r["watch_ha"], -r["max_risk_score"]))
    for i, r in enumerate(barangay_ranking, 1):
        r["rank"] = i

    zone_geoms, zone_props = [], []
    for name in ("high", "watch"):
        for g in C.vectorize(grids["class"] == CLASS_CODES[name]):
            zone_geoms.append(g)
            zone_props.append({"risk_class": name})
    risk_zones = C.feature_collection(zone_geoms, zone_props)
    bbox_shares = class_shares(grids["class"], bbox_mask)
    high = [ft["properties"] for ft in features if ft["properties"]["risk_class"] == "high"]
    sp = sar["provenance"]
    data_modes = {sp["data_mode"], sp["dem"]["data_mode"], rain["data_mode"]}
    synthetic = any("synthetic" in m for m in data_modes)
    bdate, adate = (sp["before_scene"].get("datetime") or "")[:10], (sp["after_scene"].get("datetime") or "")[:10]

    provenance = {
        "pilot_area": "Camarines Sur Pilot Farming Cluster (Bicol River Basin)",
        "event_reference": f"STS Kristine (Trami) — Oct 21-26, 2024 (Sentinel-1 Pass {adate or 'n/a'})",
        "grid_resolution": "30m Shared Grid",
        "licensing_cost": "₱0 (Open NASA & Copernicus Data)",
        "processing_time": f"{time.perf_counter() - t0:.1f} sec",
        "sar_hit_rate": fmt(rate),
        "total_high_risk_ha": round(sum(p["hectares"] for p in high), 1),
        "high_risk_plots": len(high),
        "households_affected": sum(p["households"] for p in high),
        "avg_bare_field_days": round(sum(ft["properties"]["bare_field_days_per_year"] for ft in features) / len(features)),
        "datasets_used": [
            f"Sentinel-1 (ESA/Copernicus C-Band SAR VV/VH) — RTC, orbit 134, {bdate} vs {adate}",
            "NASADEM (30m Slope, Flow Accumulation & TWI)",
            f"NASA POWER (Daily PRECTOTCORR Rainfall — {rain['r_total_mm']:.0f} mm antecedent + event)",
            "GPM IMERG — pending (feature/terrain-rain)",
            "SMAP Soil-Moisture Anomaly — pending (feature/terrain-rain)",
            "Landsat 8-9 / MODIS NDVI — pending (feature/rotation-engine; bare-field days are placeholders)",
            "SoilGrids Soil Texture — pending (feature/rotation-engine)",
        ],
        "future_work_datasets": ["NISAR (L-Band)", "ECOSTRESS", "GRACE / GRACE-FO"],
        "scientific_limit": ("Surface wetness layers are derived from C-band Sentinel-1 SAR backscatter, not direct "
                             "root-zone soil moisture measurements. C-band cannot see standing water between buildings "
                             "(double-bounce brightens instead of darkening), so built-up cells show no flood signal."),
        # ---- additive pipeline metadata
        "data_mode": "synthetic_fallback" if synthetic else "real",
        "risk_formula": "round(100 × (0.45·S_SAR + 0.35·S_TWI + 0.20·S_Rain)); high ≥ 70, watch ≥ 40",
        "sar_scenes": {"before": sp["before_scene"].get("item_id"), "after": sp["after_scene"].get("item_id")},
        "sar_flood_threshold_db": sp["flood_threshold_db"],
        "observed_flood_area_ha": round(flood_ha, 2),
        "sar_hit_rate_plots": fmt(plot_rate),
        "sar_hit_rate_terrain_only": fmt(rate_terrain),
        "sar_hit_rate_note": ("sar_hit_rate = share of SAR-flooded 30 m cells in the pilot bbox that the full risk map "
                              "rated high. It shares ΔVV with the flood mask, so it is a consistency check. "
                              "sar_hit_rate_terrain_only uses a model without SAR (terrain + rain) and is the "
                              "independent test. sar_hit_rate_plots uses whole-plot classes (CLAUDE.md §3D.3). "
                              "All are n/a when the SAR flood mask is empty."),
        "risk_class_thresholds": {"high": ">= 70", "watch": "40-69", "low": "< 40",
                                  "missing": "no valid SAR pixel (flagged, not scored)"},
        "pilot_area_class_shares": bbox_shares,
        "barangay_ranking": barangay_ranking,
        "rainfall": {k: v for k, v in rain.items() if k != "daily_mm"},
        "pending_inputs": ["bare_field_days_per_year", "households", "hectares", "current_crop"],
    }

    payload = {
        "provenance": provenance,
        "plots": {"type": "FeatureCollection", "features": features},
        "observed_flood_extent": sar["observed_flood_extent"],
        "sar_backscatter_comparison": sar["sar_backscatter_comparison"],
        "drainage_corridor": terr["drainage_corridor"],
        "rotation_strategies": json.loads(ROTATIONS_PATH.read_text(encoding="utf-8")),
        "risk_zones": risk_zones,
    }
    C.write_json(MOCK_PATH, payload)
    C.write_json(PROCESSED_PATH, payload)
    return payload


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="ignore data/cache and re-download")
    out = run(refresh=ap.parse_args().refresh)
    pv = out["provenance"]
    print(f"data_mode={pv['data_mode']}  hit_rate={pv['sar_hit_rate']} (terrain-only {pv['sar_hit_rate_terrain_only']}, "
          f"plots {pv['sar_hit_rate_plots']})  flood={pv['observed_flood_area_ha']} ha  "
          f"high={pv['high_risk_plots']} plots / {pv['total_high_risk_ha']} ha / {pv['households_affected']} households  "
          f"t={pv['processing_time']}")
    for ft in out["plots"]["features"]:
        p = ft["properties"]
        print(f"  {p['plot_id']}: {p['risk_score']:>3} {p['risk_class']:<5}  S_SAR={p['s_sar']:.2f} S_TWI={p['s_twi']:.2f} "
              f"S_Rain={p['s_rain']:.2f}  ΔVV={p['sar_wetness_change_db']:+.2f} dB  TWI={p['twi_value']}  sms={len(p['sms_alert'])}c")
    print("Pilot area:", {k: v for k, v in pv["pilot_area_class_shares"].items() if k.endswith("_ha")})
    for r in pv["barangay_ranking"]:
        print(f"  #{r['rank']} {r['barangay']}: high {r['high_risk_ha']} ha, watch {r['watch_ha']} ha, "
              f"{r['high_risk_households']} households")
    print(f"wrote {MOCK_PATH.name} and {PROCESSED_PATH.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
