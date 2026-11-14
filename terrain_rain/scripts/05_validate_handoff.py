#!/usr/bin/env python3
import json
from pathlib import Path
import sys
from typing import List, Tuple
import numpy as np
import rasterio
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from terrain_rain.grid import get_inner_grid


def main() -> None:
    with open(ROOT / "config" / "pilot.yaml", "r", encoding="utf-8") as f:
        pilot = yaml.safe_load(f)
    with open(ROOT / "config" / "layers.yaml", "r", encoding="utf-8") as f:
        layers_doc = yaml.safe_load(f)
    layers_cfg = layers_doc["layers"]

    out_dir = (ROOT / pilot["output_dir"]).resolve()
    out_rasters = out_dir / "rasters"
    out_tables = out_dir / "tables"
    template_path = (ROOT / pilot["shared_template_path"]).resolve()

    inner_grid = get_inner_grid(
        inner_bbox_wgs84=pilot["inner_bbox_wgs84"],
        target_crs=pilot["crs"],
        res=float(pilot["resolution_m"]),
        template_path=template_path,
    )

    checks: List[Tuple[str, bool, str]] = []

    # Check 1: All 9 output rasters exist
    missing_rasters = [
        m["filename"] for m in layers_cfg.values() if not (out_rasters / m["filename"]).exists()
    ]
    checks.append(
        (
            "01_all_rasters_exist",
            len(missing_rasters) == 0,
            "All 9 GeoTIFFs present" if not missing_rasters else f"Missing: {missing_rasters}",
        )
    )

    if missing_rasters:
        _print_report_and_exit(checks)

    # Check 2: CRS, transform, and shape match inner_grid for all rasters
    grid_mismatches = []
    for key, meta in layers_cfg.items():
        with rasterio.open(out_rasters / meta["filename"]) as src:
            if src.crs != inner_grid.crs:
                grid_mismatches.append(f"{key}:crs={src.crs}")
            if (src.height, src.width) != inner_grid.shape:
                grid_mismatches.append(f"{key}:shape={(src.height, src.width)}")
            if not src.transform.almost_equals(inner_grid.transform, precision=1e-4):
                grid_mismatches.append(f"{key}:transform")
    checks.append(
        (
            "02_grid_alignment",
            len(grid_mismatches) == 0,
            f"CRS={inner_grid.crs}, shape={inner_grid.shape}"
            if not grid_mismatches
            else f"Mismatches: {grid_mismatches}",
        )
    )

    # Check 3: Dtype and nodata conventions (float32=-9999.0, uint8=255)
    contract_errors = []
    loaded = {}
    for key, meta in layers_cfg.items():
        with rasterio.open(out_rasters / meta["filename"]) as src:
            arr = src.read(1)
            loaded[key] = arr
            if src.dtypes[0] != meta["dtype"]:
                contract_errors.append(f"{key}:dtype={src.dtypes[0]}!={meta['dtype']}")
            if src.nodata is None or float(src.nodata) != float(meta["nodata"]):
                contract_errors.append(f"{key}:nodata={src.nodata}!={meta['nodata']}")
    checks.append(
        (
            "03_dtype_nodata_contract",
            len(contract_errors) == 0,
            "All dtypes and nodata tags match layers.yaml"
            if not contract_errors
            else f"Errors: {contract_errors}",
        )
    )

    # Check 4: rain_event_mm_30m range (~453.7 to 469.3 mm)
    rain_ev = loaded["rain_event_mm_30m"]
    rain_ev_valid = rain_ev[rain_ev != -9999.0]
    ev_min, ev_max = float(np.min(rain_ev_valid)), float(np.max(rain_ev_valid))
    ev_ok = (450.0 <= ev_min <= 456.0) and (466.0 <= ev_max <= 472.0)
    checks.append(
        (
            "04_rain_event_mm_range",
            ev_ok,
            f"min={ev_min:.2f} mm, max={ev_max:.2f} mm (expected ~453.7-469.3 mm)",
        )
    )

    # Check 5: rain_prior7d_mm_30m range (~27.5 to 35.0 mm) and event > prior7d
    rain_pr = loaded["rain_prior7d_mm_30m"]
    rain_pr_valid = rain_pr[rain_pr != -9999.0]
    pr_min, pr_max = float(np.min(rain_pr_valid)), float(np.max(rain_pr_valid))
    pr_ok = (
        (26.0 <= pr_min <= 29.5)
        and (33.0 <= pr_max <= 37.0)
        and (float(np.mean(rain_ev_valid)) > float(np.mean(rain_pr_valid)))
    )
    checks.append(
        (
            "05_rain_prior7d_mm_range",
            pr_ok,
            f"min={pr_min:.2f} mm, max={pr_max:.2f} mm (expected ~27.5-35.0 mm)",
        )
    )

    # Check 6: smap_anomaly_zscore_30m range (~1.5 to 1.6)
    smap_z = loaded["smap_anomaly_zscore_30m"]
    smap_valid = smap_z[smap_z != -9999.0]
    z_min, z_max, z_mean = (
        float(np.min(smap_valid)),
        float(np.max(smap_valid)),
        float(np.mean(smap_valid)),
    )
    smap_ok = 1.40 <= z_mean <= 1.70
    checks.append(
        (
            "06_smap_zscore_range",
            smap_ok,
            f"mean={z_mean:.3f}, min={z_min:.3f}, max={z_max:.3f} (expected ~1.5-1.6)",
        )
    )

    # Check 7: dem_30m elevation range (-8 to 32 m) and no unexpected nodata holes
    dem = loaded["dem_30m"]
    dem_valid = dem[dem != -9999.0]
    dem_min, dem_max = float(np.min(dem_valid)), float(np.max(dem_valid))
    dem_ok = (
        (dem_valid.size == dem.size)
        and (-10.0 <= dem_min <= -4.0)
        and (24.0 <= dem_max <= 38.0)
    )
    checks.append(
        (
            "07_dem_elevation_range",
            dem_ok,
            f"min={dem_min:.2f} m, max={dem_max:.2f} m, valid={dem_valid.size}/{dem.size}",
        )
    )

    # Check 8: lowground_mask_30m binary and 2% to 7% (~3-5%) <= 0m
    lg = loaded["lowground_mask_30m"]
    lg_vals = set(np.unique(lg).tolist())
    lg_frac = float(np.mean(lg == 1))
    lg_ok = lg_vals.issubset({0, 1}) and (0.02 <= lg_frac <= 0.07)
    checks.append(
        (
            "08_lowground_mask_share",
            lg_ok,
            f"values={sorted(lg_vals)}, share={lg_frac * 100:.2f}% (expected ~3-5%)",
        )
    )

    # Check 9: slope_deg_30m, flow_acc_m2_30m, and twi_30m physical sanity
    slope = loaded["slope_deg_30m"]
    fa = loaded["flow_acc_m2_30m"]
    twi = loaded["twi_30m"]
    terrain_ok = (
        bool(np.all(np.isfinite(slope)))
        and float(np.min(slope)) >= 0.0
        and float(np.max(slope)) < 90.0
        and bool(np.all(np.isfinite(fa)))
        and float(np.min(fa)) >= 900.0
        and bool(np.all(np.isfinite(twi)))
    )
    checks.append(
        (
            "09_terrain_derivatives_sanity",
            terrain_ok,
            f"slope=[{np.min(slope):.2f}, {np.max(slope):.2f}] deg, "
            f"twi=[{np.min(twi):.2f}, {np.max(twi):.2f}], "
            f"max_fa={np.max(fa):.0f} m2",
        )
    )

    # Check 10: pooling_zones_30m binary and share between 0% and 60%
    pool = loaded["pooling_zones_30m"]
    pool_vals = set(np.unique(pool).tolist())
    pool_share = float(np.mean(pool == 1))
    pool_ok = pool_vals.issubset({0, 1}) and (0.0 < pool_share < 0.60)
    checks.append(
        (
            "10_pooling_zones_share",
            pool_ok,
            f"values={sorted(pool_vals)}, share={pool_share * 100:.2f}% (expected 0% < share < 60%)",
        )
    )

    # Check 11: provenance.json + NASA POWER tables exist and cover all layers
    prov_path = out_dir / "provenance.json"
    power_daily_path = out_tables / "power_daily.csv"
    power_clim_path = out_tables / "power_monthly_climatology.csv"
    prov_ok = False
    prov_detail = "Missing provenance.json or power CSVs"
    if prov_path.exists() and power_daily_path.exists() and power_clim_path.exists():
        with open(prov_path, "r", encoding="utf-8") as f:
            prov_doc = json.load(f)
        prov_layers = set(prov_doc.get("layers", {}).keys())
        expected_layers = set(layers_cfg.keys())
        missing_prov = expected_layers - prov_layers
        prov_ok = len(missing_prov) == 0
        prov_detail = (
            f"All {len(expected_layers)} layers documented + POWER tables present"
            if prov_ok
            else f"Missing in provenance: {missing_prov}"
        )
    checks.append(("11_provenance_and_tables", prov_ok, prov_detail))

    _print_report_and_exit(checks)


def _print_report_and_exit(checks: List[Tuple[str, bool, str]]) -> None:
    print("\n" + "=" * 88)
    print(f"{'CHECK':32s} | {'STATUS':6s} | {'DETAILS'}")
    print("-" * 88)
    all_passed = True
    for name, passed, detail in checks:
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_passed = False
        print(f"{name:32s} | {status:6s} | {detail}")
    print("=" * 88)

    if not all_passed:
        print("[05_validate_handoff] VALIDATION FAILED.", file=sys.stderr)
        sys.exit(1)
    print("[05_validate_handoff] ALL 11 ACCEPTANCE CHECKS PASSED.")


if __name__ == "__main__":
    main()
