#!/usr/bin/env python3
from pathlib import Path
import sys
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from terrain_rain.grid import get_inner_grid
from terrain_rain.io import write_layer
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

    smap_path = raw_dir / "smap" / "smap_rootzone_buffered.tif"
    meta = layers_cfg["smap_anomaly_zscore_30m"]
    nodata_val = float(meta["nodata"])

    with rasterio.open(smap_path) as src:
        b1_event = src.read(1).astype(np.float32)       # smap_event_mean
        b2_base30_mean = src.read(2).astype(np.float32) # smap_base30d_mean
        b3_base30_std = src.read(3).astype(np.float32)  # smap_base30d_std
        b4_oct_mean = src.read(4).astype(np.float32)    # smap_oct_clim_mean
        b5_oct_std = src.read(5).astype(np.float32)     # smap_oct_clim_std

        valid_oct = (
            np.isfinite(b1_event)
            & np.isfinite(b4_oct_mean)
            & np.isfinite(b5_oct_std)
            & (b5_oct_std > 0.0)
        )
        z_oct_native = np.full(b1_event.shape, nodata_val, dtype=np.float32)
        z_oct_native[valid_oct] = (b1_event[valid_oct] - b4_oct_mean[valid_oct]) / b5_oct_std[valid_oct]

        valid_30d = (
            np.isfinite(b1_event)
            & np.isfinite(b2_base30_mean)
            & np.isfinite(b3_base30_std)
            & (b3_base30_std > 0.0)
        )
        z_30d_native = np.full(b1_event.shape, np.nan, dtype=np.float32)
        z_30d_native[valid_30d] = (
            b1_event[valid_30d] - b2_base30_mean[valid_30d]
        ) / b3_base30_std[valid_30d]

        # Reproject z_oct_native to inner 30m grid using nearest-neighbor
        smap_z_30m = np.full(inner_grid.shape, nodata_val, dtype=np.float32)
        reproject(
            source=z_oct_native,
            destination=smap_z_30m,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=nodata_val,
            dst_transform=inner_grid.transform,
            dst_crs=inner_grid.crs,
            dst_nodata=nodata_val,
            resampling=Resampling.nearest,
        )

    write_layer(
        path=out_rasters / meta["filename"],
        array=smap_z_30m,
        grid=inner_grid,
        dtype=meta["dtype"],
        nodata=nodata_val,
        band_name=meta["band_name"],
        units=meta["units"],
    )

    valid_z = smap_z_30m[smap_z_30m != nodata_val]
    smap_metrics = {
        "oct_clim_zscore_mean": round(float(np.mean(valid_z)), 4),
        "oct_clim_zscore_min": round(float(np.min(valid_z)), 4),
        "oct_clim_zscore_max": round(float(np.max(valid_z)), 4),
        "base30d_zscore_mean": round(float(np.nanmean(z_30d_native)), 4),
        "base30d_zscore_min": round(float(np.nanmin(z_30d_native)), 4),
        "base30d_zscore_max": round(float(np.nanmax(z_30d_native)), 4),
        "smap_event_mean_m3m3": round(float(np.nanmean(b1_event)), 4),
        "smap_base30d_mean_m3m3": round(float(np.nanmean(b2_base30_mean)), 4),
        "smap_oct_clim_mean_m3m3": round(float(np.nanmean(b4_oct_mean)), 4),
    }

    update_provenance(
        provenance_path=out_dir / "provenance.json",
        pilot_cfg=pilot,
        layers_cfg=layers_cfg,
        metric_key="smap_anomaly_summary",
        metric_value=smap_metrics,
        layer_updates={
            "smap_anomaly_zscore_30m": {
                "oct_clim_zscore_mean": smap_metrics["oct_clim_zscore_mean"],
                "base30d_zscore_mean": smap_metrics["base30d_zscore_mean"],
            }
        },
    )

    print(f"[03_build_smap_anomaly] Wrote {meta['filename']}")
    print(f"[03_build_smap_anomaly] Metrics: {smap_metrics}")


if __name__ == "__main__":
    main()
