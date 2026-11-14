"""Task 1 — Sentinel-1 C-band wetness change and observed flood extent (feature/sar-moisture).

Implements CLAUDE.md §3A:
  σ⁰ (dB) → Lee speckle filter → Δσ⁰_VV = after − baseline → S_SAR, observed flood mask.

Scenes (all Sentinel-1A, relative orbit 134 descending, so viewing geometry is identical):
  baseline:     median of 2024-08-10, 08-22, 09-15, 09-27 — a multi-date pre-storm reference, so one
                unusual day (fresh irrigation, wind on a pond, speckle) cannot distort the change map
  just before:  2024-10-09 — last calm pass before STS Kristine (Trami); used to show the
                pre-storm state was normal (Oct 9 − baseline ≈ 0 dB)
  after:        2024-11-02 — calm-weather pass; Bicol River basin floodwater still standing

Why not the storm-day pass (2024-10-21 21:39 UTC = 05:39 PHT 22 Oct): typhoon wind and rain
roughened every water surface. Across a 35 x 33 km regional scan, permanent water brightened by
+5.3 dB median and only 30% of it still read as water (< −15 dB), so dark-water flood mapping
fails everywhere in that scene. It stays in provenance as the storm-day example.

Land cover (ESA WorldCover 2021) removes permanent rivers/ponds from the flood mask, so the
flood area counts newly flooded ground only.

Input product: Sentinel-1 RTC (radiometrically terrain-corrected γ⁰, linear power) from
Microsoft Planetary Computer, averaged from 10 m to the shared 30 m grid in linear units.

Run:  python -m pipeline.sar_moisture [--refresh]
Out:  data/sar_moisture_output.json
"""
from __future__ import annotations

import argparse
import time

import numpy as np
from rasterio.warp import Resampling
from shapely.geometry import shape

from . import common as C

COLLECTION = "sentinel-1-rtc"
BASELINE_IDS = [
    "S1A_IW_GRDH_1SDV_20240810T213859_20240810T213928_055156_06B8D0_rtc",
    "S1A_IW_GRDH_1SDV_20240822T213859_20240822T213928_055331_06BF3E_rtc",
    "S1A_IW_GRDH_1SDV_20240915T213900_20240915T213929_055681_06CCB0_rtc",
    "S1A_IW_GRDH_1SDV_20240927T213900_20240927T213929_055856_06D39E_rtc",
]
JUST_BEFORE_ID = "S1A_IW_GRDH_1SDV_20241009T213901_20241009T213930_056031_06DA7E_rtc"
AFTER_ID = "S1A_IW_GRDH_1SDV_20241102T213901_20241102T213930_056381_06E85F_rtc"

# Other passes over the pilot area in the event window, recorded for the provenance panel.
OTHER_SCENES = [
    {"item_id": "S1A_IW_GRDH_1SSV_20241017T095829_20241017T095859_056141_06DED7_rtc",
     "datetime": "2024-10-17T09:58:44Z", "orbit": "ascending 69", "polarisations": "VV only",
     "why_not_used": "different orbit geometry and no VH; not directly comparable with the orbit-134 stack"},
    {"item_id": "S1A_IW_GRDH_1SDV_20241021T213901_20241021T213930_056206_06E170_rtc",
     "datetime": "2024-10-21T21:39:15Z", "orbit": "descending 134", "polarisations": "VV+VH",
     "why_not_used": ("taken at the storm peak (05:39 PHT 22 Oct): wind-roughened water brightened +5.3 dB "
                      "regionally, so open water is not detectable in this scene")},
]

LEE_SIZE = 5
# RTC GRD-IW has ENL ≈ 4.4; 3x3 averaging of correlated 10 m pixels roughly quadruples it.
LEE_LOOKS = 18.0
FLOOD_DELTA_DB = -2.0
FLOOD_MAX_SLOPE_DEG = 5.0
TAU_DEFAULT_DB = -15.0
TAU_BOUNDS_DB = (-20.0, -12.0)
WETNESS_SHIFT_DB = -1.0
OUTPUT = C.DATA_DIR / "sar_moisture_output.json"


def _scene_cache_name(item_id: str) -> str:
    return "s1_" + item_id.split("_")[4][:8]


def load_scene(item_id: str, refresh: bool = False) -> tuple[dict, dict]:
    """Return ({'vv','vh'} linear γ⁰ arrays on the 30 m grid, scene metadata)."""
    name = _scene_cache_name(item_id)
    cached = None if refresh else C.load_cache(name)
    if cached:
        meta, arrs = cached
        return arrs, meta
    item = C.stac_item(COLLECTION, item_id)
    arrs = {}
    for pol in ("vv", "vh"):
        if pol in item["assets"]:
            href = C.signed_href(COLLECTION, item["assets"][pol]["href"])
            arrs[pol] = C.read_to_grid(href, Resampling.average)
    if np.isnan(arrs["vv"]).mean() > 0.05:
        raise RuntimeError(f"{item_id}: scene does not cover the analysis grid")
    p = item["properties"]
    meta = {
        "data_mode": "live",
        "item_id": item_id,
        "datetime": p["datetime"],
        "platform": p.get("platform"),
        "orbit_state": p.get("sat:orbit_state"),
        "relative_orbit": p.get("sat:relative_orbit"),
        "product": "Sentinel-1 RTC gamma0 (Microsoft Planetary Computer)",
        "grid": C.grid_signature(),
    }
    C.save_cache(name, meta, **arrs)
    return arrs, meta


def synthetic_scenes(dem: np.ndarray) -> tuple[list[dict], dict, dict, dict]:
    """Deterministic, physically plausible fallback when no cache and no network.

    Baseline/just-before: vegetated/moist-soil reference around −9 dB VV with gamma speckle.
    After: low-lying cells lose up to 4.5 dB (specular reflection off ponded water).
    """
    rng = np.random.default_rng(20241021)
    lo, hi = np.percentile(dem, [5, 80])
    lowness = np.clip((hi - dem) / max(hi - lo, 1e-3), 0, 1)

    def speckled(db):
        return (10 ** (db / 10) * rng.gamma(18, 1 / 18, db.shape)).astype("float32")

    base_vv = -9.0 + rng.normal(0, 0.8, dem.shape)
    after_vv = base_vv - 4.5 * lowness ** 2
    baseline = [{"vv": speckled(base_vv), "vh": speckled(base_vv - 6.5)} for _ in range(3)]
    before = {"vv": speckled(base_vv), "vh": speckled(base_vv - 6.5)}
    after = {"vv": speckled(after_vv), "vh": speckled(after_vv - 6.0)}
    return baseline, before, after, {"data_mode": "synthetic_fallback", "item_id": None, "datetime": None}


def _filtered_db(img: np.ndarray) -> np.ndarray:
    return C.to_db(C.lee_filter(img, LEE_SIZE, LEE_LOOKS))


def process(baseline: list[dict], just_before: dict, after: dict, slope: np.ndarray,
            permanent_water: np.ndarray | None = None) -> dict:
    out = {}
    for pol in ("vv", "vh"):
        if all(pol in s for s in baseline) and pol in just_before and pol in after:
            stack = np.stack([_filtered_db(s[pol]) for s in baseline])
            out[f"{pol}_before_db"] = np.nanmedian(stack, axis=0)        # multi-date baseline
            out[f"{pol}_just_before_db"] = _filtered_db(just_before[pol])
            out[f"{pol}_after_db"] = _filtered_db(after[pol])
            out[f"d_{pol}_db"] = out[f"{pol}_after_db"] - out[f"{pol}_before_db"]
            out[f"d_pre_{pol}_db"] = out[f"{pol}_just_before_db"] - out[f"{pol}_before_db"]
            if pol == "vv":
                out["baseline_spread_db"] = np.nanstd(stack, axis=0)

    otsu = C.otsu_threshold(out["vv_after_db"])
    tau = otsu if TAU_BOUNDS_DB[0] <= otsu <= TAU_BOUNDS_DB[1] else TAU_DEFAULT_DB
    out["tau_db"], out["otsu_raw_db"] = tau, otsu
    not_perm = ~permanent_water if permanent_water is not None else np.ones(slope.shape, bool)
    out["flood"] = (
        (out["vv_after_db"] < tau) & (out["d_vv_db"] < FLOOD_DELTA_DB)
        & (slope < FLOOD_MAX_SLOPE_DEG) & not_perm
    )
    out["water_before"] = out["vv_before_db"] < tau
    out["wetness_shift"] = (out["d_vv_db"] <= WETNESS_SHIFT_DB) & not_perm
    return out


def s_sar(delta_vv_db: float) -> float:
    """CLAUDE.md §3A.4: S_SAR = clip(−Δσ⁰_VV / 4, 0, 1)."""
    return float(np.clip(-delta_vv_db / 4.0, 0.0, 1.0))


def plot_stats(res: dict) -> list[dict]:
    stats = []
    for f in C.load_plots():
        m = C.plot_mask(shape(f["geometry"]))
        d_vv = float(np.nanmean(res["d_vv_db"][m]))
        row = {
            "plot_id": f["properties"]["plot_id"],
            "pixels_30m": int(m.sum()),
            "vv_before_db": round(float(np.nanmean(res["vv_before_db"][m])), 2),
            "vv_just_before_db": round(float(np.nanmean(res["vv_just_before_db"][m])), 2),
            "vv_after_db": round(float(np.nanmean(res["vv_after_db"][m])), 2),
            "sar_wetness_change_db": round(d_vv, 2),
            "pre_event_change_db": round(float(np.nanmean(res["d_pre_vv_db"][m])), 2),
            "baseline_spread_db": round(float(np.nanmean(res["baseline_spread_db"][m])), 2),
            "s_sar": round(s_sar(d_vv), 3),
            "flooded_pixel_fraction": round(float(res["flood"][m].mean()), 3),
        }
        if "d_vh_db" in res:
            row["vh_wetness_change_db"] = round(float(np.nanmean(res["d_vh_db"][m])), 2)
        stats.append(row)
    return stats


def _scene_meta(meta: dict) -> dict:
    return {k: v for k, v in meta.items() if k != "grid"}


def run(refresh: bool = False, write: bool = True) -> dict:
    t0 = time.perf_counter()
    dem, dem_meta = C.load_dem(refresh)
    _, slope = C.slope_deg(dem)
    landcover, lc_meta = C.load_worldcover(refresh)
    permanent_water = (landcover == C.WC_WATER) if landcover is not None else None

    try:
        loaded = [load_scene(i, refresh) for i in BASELINE_IDS]
        baseline = [a for a, _ in loaded]
        base_meta = [_scene_meta(m) for _, m in loaded]
        just_before, jb_meta = load_scene(JUST_BEFORE_ID, refresh)
        after, a_meta = load_scene(AFTER_ID, refresh)
        jb_meta, a_meta = _scene_meta(jb_meta), _scene_meta(a_meta)
        data_mode = "live"
    except Exception as exc:
        baseline, just_before, after, fb = synthetic_scenes(dem)
        fb["reason"] = f"{type(exc).__name__}: {exc}"
        base_meta, jb_meta, a_meta = [fb], fb, fb
        data_mode = "synthetic_fallback"

    res = process(baseline, just_before, after, slope, permanent_water)

    observed_flood_extent = C.feature_collection(
        C.vectorize(res["flood"]),
        {"label": "Observed Post-Storm Sentinel-1 SAR Flood Mask",
         "rule": (f"VV_after < {res['tau_db']:.1f} dB AND ΔVV < {FLOOD_DELTA_DB} dB AND slope < "
                  f"{FLOOD_MAX_SLOPE_DEG}° AND not permanent water (WorldCover)")},
    )
    before_fc = C.feature_collection(
        C.vectorize(res["water_before"]),
        {"mode": "Pre-Storm Dry Baseline (C-Band VV)",
         "description": f"Open water in the Aug–Sep baseline median (VV < {res['tau_db']:.1f} dB)"},
    )
    after_fc = C.feature_collection(
        C.vectorize(res["wetness_shift"]),
        {"mode": "Post-Storm Surface Wetness Shift (ΔdB)",
         "description": f"Cells where VV backscatter dropped by ≥ {abs(WETNESS_SHIFT_DB)} dB vs baseline"},
    )

    bbox_mask = C.plot_mask(C.bbox_polygon_wgs())
    output = {
        "provenance": {
            "data_mode": data_mode,
            "collection": COLLECTION,
            "baseline_scenes": base_meta,
            "just_before_scene": jb_meta,
            "after_scene": a_meta,
            "other_scenes_considered": OTHER_SCENES,
            "dem": _scene_meta(dem_meta),
            "landcover": _scene_meta(lc_meta),
            "grid": {"crs": C.UTM_CRS, "cell_m": C.CELL, "shape": list(C.GRID.shape)},
            "lee_filter": {"window": LEE_SIZE, "looks": LEE_LOOKS},
            "flood_threshold_db": round(res["tau_db"], 2),
            "otsu_raw_db": round(res["otsu_raw_db"], 2),
            "bbox_mean_delta_vv_db": round(float(np.nanmean(res["d_vv_db"][bbox_mask])), 2),
            "bbox_mean_pre_event_change_db": round(float(np.nanmean(res["d_pre_vv_db"][bbox_mask])), 2),
            "bbox_flooded_fraction": round(float(res["flood"][bbox_mask].mean()), 4),
            "label": "Surface wetness from C-band backscatter change — not measured root-zone soil moisture",
            "processing_time_sec": round(time.perf_counter() - t0, 2),
        },
        "plots": plot_stats(res),
        "observed_flood_extent": observed_flood_extent,
        "sar_backscatter_comparison": {"before_event": before_fc, "after_event": after_fc},
    }
    if write:
        C.write_json(OUTPUT, output)
    # Raster layers for the risk engine (not written to JSON)
    output["_grids"] = {"d_vv_db": res["d_vv_db"], "flood": res["flood"],
                        "sar_valid": np.isfinite(res["d_vv_db"]), "landcover": landcover}
    return output


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="ignore data/cache and re-download")
    args = ap.parse_args()
    out = run(refresh=args.refresh)
    prov = out["provenance"]
    print(f"data_mode={prov['data_mode']}  tau={prov['flood_threshold_db']} dB (otsu {prov['otsu_raw_db']})  "
          f"bbox ΔVV={prov['bbox_mean_delta_vv_db']} dB  pre-event Δ={prov['bbox_mean_pre_event_change_db']} dB  "
          f"flooded={prov['bbox_flooded_fraction']:.1%}  flood polygons={len(out['observed_flood_extent']['features'])}  "
          f"t={prov['processing_time_sec']}s")
    for p in out["plots"]:
        print(f"  {p['plot_id']}: ΔVV={p['sar_wetness_change_db']:+.2f} dB  pre={p['pre_event_change_db']:+.2f}  "
              f"spread={p['baseline_spread_db']:.2f}  baseline={p['vv_before_db']} after={p['vv_after_db']}  "
              f"S_SAR={p['s_sar']}  flooded={p['flooded_pixel_fraction']:.0%}")
    print(f"wrote {OUTPUT.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
