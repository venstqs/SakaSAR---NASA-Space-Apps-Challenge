#!/usr/bin/env python3
from pathlib import Path
import sys
import numpy as np
import rasterio
from rasterio.enums import Resampling
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from terrain_rain.grid import get_inner_grid
from terrain_rain.io import reproject_to_grid, write_layer
from terrain_rain.provenance import update_provenance


def main() -> None:
    with open(ROOT / "config" / "pilot.yaml", "r", encoding="utf-8") as f:
        pilot = yaml.safe_load(f)
    with open(ROOT / "config" / "layers.yaml", "r", encoding="utf-8") as f:
        layers_cfg = yaml.safe_load(f)["layers"]

    raw_dir = (ROOT / pilot["raw_data_dir"]).resolve()
    out_dir = (ROOT / pilot["output_dir"]).resolve()
    out_rasters = out_dir / "rasters"
    template_path = (ROOT / pilot["shared_template_path"]).resolve()

    inner_grid = get_inner_grid(
        inner_bbox_wgs84=pilot["inner_bbox_wgs84"],
        target_crs=pilot["crs"],
        res=float(pilot["resolution_m"]),
        template_path=template_path,
    )

    imerg_path = raw_dir / "rain" / "imerg_buffered_mm.tif"
    with rasterio.open(imerg_path) as src:
        b1_raw = src.read(1).astype(np.float32)
        b2_raw = src.read(2).astype(np.float32)

    mean_event_raw = float(np.nanmean(b1_raw))
    mean_prior_raw = float(np.nanmean(b2_raw))
    assert mean_event_raw > mean_prior_raw, (
        f"Expected event rainfall ({mean_event_raw:.2f} mm) > "
        f"prior 7d rainfall ({mean_prior_raw:.2f} mm)"
    )

    # Reproject both bands to inner 30m grid using nearest-neighbor
    event_meta = layers_cfg["rain_event_mm_30m"]
    prior_meta = layers_cfg["rain_prior7d_mm_30m"]

    rain_event_30m = reproject_to_grid(
        src_path=imerg_path,
        dst_grid=inner_grid,
        band=1,
        resampling=Resampling.nearest,
        ignore_src_nodata=False,
        dst_nodata=float(event_meta["nodata"]),
    )
    rain_prior7d_30m = reproject_to_grid(
        src_path=imerg_path,
        dst_grid=inner_grid,
        band=2,
        resampling=Resampling.nearest,
        ignore_src_nodata=False,
        dst_nodata=float(prior_meta["nodata"]),
    )

    valid_event = rain_event_30m[rain_event_30m != float(event_meta["nodata"])]
    valid_prior = rain_prior7d_30m[rain_prior7d_30m != float(prior_meta["nodata"])]
    assert float(np.mean(valid_event)) > float(np.mean(valid_prior)), (
        "Inner-grid event rainfall mean must exceed prior 7-day rainfall mean."
    )

    write_layer(
        path=out_rasters / event_meta["filename"],
        array=rain_event_30m,
        grid=inner_grid,
        dtype=event_meta["dtype"],
        nodata=event_meta["nodata"],
        band_name=event_meta["band_name"],
        units=event_meta["units"],
    )
    write_layer(
        path=out_rasters / prior_meta["filename"],
        array=rain_prior7d_30m,
        grid=inner_grid,
        dtype=prior_meta["dtype"],
        nodata=prior_meta["nodata"],
        band_name=prior_meta["band_name"],
        units=prior_meta["units"],
    )

    rain_stats = {
        "rain_event_mm_min": round(float(np.min(valid_event)), 2),
        "rain_event_mm_max": round(float(np.max(valid_event)), 2),
        "rain_event_mm_mean": round(float(np.mean(valid_event)), 2),
        "rain_prior7d_mm_min": round(float(np.min(valid_prior)), 2),
        "rain_prior7d_mm_max": round(float(np.max(valid_prior)), 2),
        "rain_prior7d_mm_mean": round(float(np.mean(valid_prior)), 2),
    }
    update_provenance(
        provenance_path=out_dir / "provenance.json",
        pilot_cfg=pilot,
        layers_cfg=layers_cfg,
        metric_key="rainfall_summary",
        metric_value=rain_stats,
    )

    print(f"[02_build_rainfall] Wrote {event_meta['filename']} and {prior_meta['filename']}")
    print(f"[02_build_rainfall] Stats: {rain_stats}")


if __name__ == "__main__":
    main()
