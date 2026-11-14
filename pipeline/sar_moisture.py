"""Task 1 — Sentinel-1 C-band wetness change and observed flood extent (feature/sar-moisture).

Implements CLAUDE.md §3A:
  σ⁰ (dB) → Lee speckle filter → Δσ⁰_VV = after − before → S_SAR, observed flood mask.

Scene pair (same relative orbit 134, descending, so incidence geometry is identical):
  before: 2024-10-09 21:39 UTC  — 12 days before STS Kristine (Trami)
  after:  2024-10-21 21:39 UTC  — 05:39 PHT on 22 Oct, during the storm's peak rainfall day

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

from . import common as C

COLLECTION = "sentinel-1-rtc"
BEFORE_ID = "S1A_IW_GRDH_1SDV_20241009T213901_20241009T213930_056031_06DA7E_rtc"
AFTER_ID = "S1A_IW_GRDH_1SDV_20241021T213901_20241021T213930_056206_06E170_rtc"

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


def synthetic_pair(dem: np.ndarray) -> tuple[dict, dict, dict, dict]:
    """Deterministic, physically plausible fallback when no cache and no network.

    Before: vegetated/moist-soil baseline around −9 dB VV with gamma-distributed speckle.
    After: low-lying cells lose up to 4.5 dB (specular reflection off ponded water).
    """
    rng = np.random.default_rng(20241021)
    lo, hi = np.percentile(dem, [5, 80])
    lowness = np.clip((hi - dem) / max(hi - lo, 1e-3), 0, 1)

    def speckled(db):
        return (10 ** (db / 10) * rng.gamma(18, 1 / 18, db.shape)).astype("float32")

    base_vv = -9.0 + rng.normal(0, 0.8, dem.shape)
    after_vv = base_vv - 4.5 * lowness ** 2
    before = {"vv": speckled(base_vv), "vh": speckled(base_vv - 6.5)}
    after = {"vv": speckled(after_vv), "vh": speckled(after_vv - 6.0)}
    meta = {"data_mode": "synthetic_fallback", "item_id": None, "datetime": None}
    return before, dict(meta, role="before"), after, dict(meta, role="after")


def process(before: dict, after: dict, slope: np.ndarray) -> dict:
    out = {}
    for pol in ("vv", "vh"):
        if pol in before and pol in after:
            out[f"{pol}_before_db"] = C.to_db(C.lee_filter(before[pol], LEE_SIZE, LEE_LOOKS))
            out[f"{pol}_after_db"] = C.to_db(C.lee_filter(after[pol], LEE_SIZE, LEE_LOOKS))
            out[f"d_{pol}_db"] = out[f"{pol}_after_db"] - out[f"{pol}_before_db"]

    otsu = C.otsu_threshold(out["vv_after_db"])
    tau = otsu if TAU_BOUNDS_DB[0] <= otsu <= TAU_BOUNDS_DB[1] else TAU_DEFAULT_DB
    out["tau_db"], out["otsu_raw_db"] = tau, otsu
    out["flood"] = (
        (out["vv_after_db"] < tau) & (out["d_vv_db"] < FLOOD_DELTA_DB) & (slope < FLOOD_MAX_SLOPE_DEG)
    )
    out["water_before"] = out["vv_before_db"] < tau
    out["wetness_shift"] = out["d_vv_db"] <= WETNESS_SHIFT_DB
    return out


def s_sar(delta_vv_db: float) -> float:
    """CLAUDE.md §3A.4: S_SAR = clip(−Δσ⁰_VV / 4, 0, 1)."""
    return float(np.clip(-delta_vv_db / 4.0, 0.0, 1.0))


def plot_stats(res: dict) -> list[dict]:
    stats = []
    for f in C.load_plots():
        from shapely.geometry import shape

        m = C.plot_mask(shape(f["geometry"]))
        d_vv = float(np.nanmean(res["d_vv_db"][m]))
        row = {
            "plot_id": f["properties"]["plot_id"],
            "pixels_30m": int(m.sum()),
            "vv_before_db": round(float(np.nanmean(res["vv_before_db"][m])), 2),
            "vv_after_db": round(float(np.nanmean(res["vv_after_db"][m])), 2),
            "sar_wetness_change_db": round(d_vv, 2),
            "s_sar": round(s_sar(d_vv), 3),
            "flooded_pixel_fraction": round(float(res["flood"][m].mean()), 3),
        }
        if "d_vh_db" in res:
            row["vh_wetness_change_db"] = round(float(np.nanmean(res["d_vh_db"][m])), 2)
        stats.append(row)
    return stats


def run(refresh: bool = False, write: bool = True) -> dict:
    t0 = time.perf_counter()
    dem, dem_meta = C.load_dem(refresh)
    _, slope = C.slope_deg(dem)

    try:
        before, b_meta = load_scene(BEFORE_ID, refresh)
        after, a_meta = load_scene(AFTER_ID, refresh)
    except Exception as exc:
        before, b_meta, after, a_meta = synthetic_pair(dem)
        b_meta["reason"] = a_meta["reason"] = f"{type(exc).__name__}: {exc}"

    res = process(before, after, slope)

    flood_polys = C.vectorize(res["flood"])
    observed_flood_extent = C.feature_collection(
        flood_polys, {"label": "Observed Post-Storm Sentinel-1 SAR Flood Mask",
                      "rule": f"VV_after < {res['tau_db']:.1f} dB AND ΔVV < {FLOOD_DELTA_DB} dB AND slope < {FLOOD_MAX_SLOPE_DEG}°"}
    )
    before_fc = C.feature_collection(
        C.vectorize(res["water_before"]),
        {"mode": "Pre-Storm Dry Baseline (C-Band VV)",
         "description": f"Open water before the storm (VV < {res['tau_db']:.1f} dB)"},
    )
    after_fc = C.feature_collection(
        C.vectorize(res["wetness_shift"]),
        {"mode": "Post-Storm Surface Wetness Shift (ΔdB)",
         "description": f"Cells where VV backscatter dropped by ≥ {abs(WETNESS_SHIFT_DB)} dB"},
    )

    bbox_mask = C.plot_mask(C.bbox_polygon_wgs())
    data_mode = "live" if "synthetic_fallback" not in (b_meta["data_mode"], a_meta["data_mode"]) else "synthetic_fallback"
    output = {
        "provenance": {
            "data_mode": data_mode,
            "collection": COLLECTION,
            "before_scene": b_meta,
            "after_scene": a_meta,
            "dem": {k: v for k, v in dem_meta.items() if k != "grid"},
            "grid": {"crs": C.UTM_CRS, "cell_m": C.CELL, "shape": list(C.GRID.shape)},
            "lee_filter": {"window": LEE_SIZE, "looks": LEE_LOOKS},
            "flood_threshold_db": round(res["tau_db"], 2),
            "otsu_raw_db": round(res["otsu_raw_db"], 2),
            "bbox_mean_delta_vv_db": round(float(np.nanmean(res["d_vv_db"][bbox_mask])), 2),
            "bbox_flooded_fraction": round(float(res["flood"][bbox_mask].mean()), 4),
            "processing_time_sec": round(time.perf_counter() - t0, 2),
        },
        "plots": plot_stats(res),
        "observed_flood_extent": observed_flood_extent,
        "sar_backscatter_comparison": {"before_event": before_fc, "after_event": after_fc},
    }
    for k in ("before_scene", "after_scene"):
        output["provenance"][k].pop("grid", None)
    if write:
        C.write_json(OUTPUT, output)
    return output


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="ignore data/cache and re-download")
    args = ap.parse_args()
    out = run(refresh=args.refresh)
    prov = out["provenance"]
    print(f"data_mode={prov['data_mode']}  tau={prov['flood_threshold_db']} dB (otsu {prov['otsu_raw_db']})  "
          f"bbox ΔVV={prov['bbox_mean_delta_vv_db']} dB  flooded={prov['bbox_flooded_fraction']:.1%}  "
          f"flood polygons={len(out['observed_flood_extent']['features'])}  t={prov['processing_time_sec']}s")
    for p in out["plots"]:
        print(f"  {p['plot_id']}: ΔVV={p['sar_wetness_change_db']:+.2f} dB  ΔVH={p.get('vh_wetness_change_db', float('nan')):+.2f} dB  "
              f"before={p['vv_before_db']} after={p['vv_after_db']}  S_SAR={p['s_sar']}  flooded={p['flooded_pixel_fraction']:.0%}")
    print(f"wrote {OUTPUT.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
