#!/usr/bin/env python3
from pathlib import Path
import sys
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from terrain_rain.grid import get_inner_grid, extend_grid_to_cover, crop_to_inner
from terrain_rain.io import write_layer
from terrain_rain.terrain import run_terrain_pipeline
from terrain_rain.pooling import compute_pooling_and_lowground


def main() -> None:
    with open(ROOT / "config" / "pilot.yaml", "r", encoding="utf-8") as f:
        pilot = yaml.safe_load(f)
    with open(ROOT / "config" / "layers.yaml", "r", encoding="utf-8") as f:
        layers_cfg = yaml.safe_load(f)["layers"]

    raw_dir = (ROOT / pilot["raw_data_dir"]).resolve()
    interim_dir = (ROOT / pilot["interim_dir"]).resolve()
    out_rasters = (ROOT / pilot["output_dir"] / "rasters").resolve()
    template_path = (ROOT / pilot["shared_template_path"]).resolve()
    water_mask_path = (ROOT / pilot["shared_water_mask_path"]).resolve()

    inner_grid = get_inner_grid(
        inner_bbox_wgs84=pilot["inner_bbox_wgs84"],
        target_crs=pilot["crs"],
        res=float(pilot["resolution_m"]),
        template_path=template_path,
    )
    buffered_grid, inner_slices = extend_grid_to_cover(
        inner_grid, pilot["buffered_bbox_wgs84"]
    )

    raw_dem_path = raw_dir / "dem" / "nasadem_buffered_with_swb.tif"
    t_params = pilot["terrain_params"]
    buffered_results = run_terrain_pipeline(
        raw_dem_path=raw_dem_path,
        buffered_grid=buffered_grid,
        work_dir=interim_dir / "wbt_work",
        slope_floor_deg=float(t_params["slope_floor_deg"]),
        conditioning_method=t_params["conditioning_method"],
    )

    # Crop all buffered terrain arrays back to exact inner grid
    dem_inner = crop_to_inner(buffered_results["dem"], inner_slices)
    slope_inner = crop_to_inner(buffered_results["slope_deg"], inner_slices)
    flow_acc_inner = crop_to_inner(buffered_results["flow_acc_m2"], inner_slices)
    twi_inner = crop_to_inner(buffered_results["twi"], inner_slices)
    dep_depth_inner = crop_to_inner(buffered_results["depression_depth"], inner_slices)

    p_params = pilot["pooling_params"]
    pooling_inner, lowground_inner, stats = compute_pooling_and_lowground(
        dem_inner=dem_inner,
        twi_inner=twi_inner,
        depression_depth_inner=dep_depth_inner,
        inner_grid=inner_grid,
        twi_percentile_min=float(p_params["twi_percentile_min"]),
        elev_quartile_max=float(p_params["elev_quartile_max"]),
        lowground_elev_max_m=float(p_params["lowground_elev_max_m"]),
        depression_depth_min_m=float(p_params["depression_depth_min_m"]),
        water_mask_path=water_mask_path,
    )

    outputs = {
        "dem_30m": dem_inner,
        "slope_deg_30m": slope_inner,
        "flow_acc_m2_30m": flow_acc_inner,
        "twi_30m": twi_inner,
        "pooling_zones_30m": pooling_inner,
        "lowground_mask_30m": lowground_inner,
    }

    for key, arr in outputs.items():
        meta = layers_cfg[key]
        write_layer(
            path=out_rasters / meta["filename"],
            array=arr,
            grid=inner_grid,
            dtype=meta["dtype"],
            nodata=meta["nodata"],
            band_name=meta["band_name"],
            units=meta["units"],
        )

    print(f"[01_build_terrain] Inner grid shape: {inner_grid.shape}, CRS: {inner_grid.crs}")
    print(f"[01_build_terrain] Stats: {stats}")


if __name__ == "__main__":
    main()
