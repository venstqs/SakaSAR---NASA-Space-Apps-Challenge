from pathlib import Path
from typing import Optional, Tuple, Dict
import numpy as np
from rasterio.enums import Resampling
from .grid import GridSpec
from .io import reproject_to_grid


def compute_pooling_and_lowground(
    dem_inner: np.ndarray,
    twi_inner: np.ndarray,
    depression_depth_inner: np.ndarray,
    inner_grid: GridSpec,
    twi_percentile_min: float = 80.0,
    elev_quartile_max: float = 25.0,
    lowground_elev_max_m: float = 0.0,
    depression_depth_min_m: float = 0.25,
    water_mask_path: Optional[Path] = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, float]]:
    """
    Computes binary pooling_zones_30m (uint8) and lowground_mask_30m (uint8) on the inner grid.
    Rule:
      pooling = (TWI >= P80) AND (
          elev <= P25_inner OR elev <= 0.0m OR depression_depth >= 0.25m
      )
      If shared/water_mask.tif exists, river/water cells (>0) are excluded from pooling.
    """
    lowground_mask = (dem_inner <= lowground_elev_max_m).astype(np.uint8)

    twi_thresh = float(np.nanpercentile(twi_inner, twi_percentile_min))
    elev_q25_thresh = float(np.nanpercentile(dem_inner, elev_quartile_max))

    cond_twi = twi_inner >= twi_thresh
    cond_low_q = dem_inner <= elev_q25_thresh
    cond_zero = dem_inner <= lowground_elev_max_m
    cond_dep = depression_depth_inner >= depression_depth_min_m

    pooling = cond_twi & (cond_low_q | cond_zero | cond_dep)

    water_excluded_count = 0
    if water_mask_path is not None and Path(water_mask_path).exists():
        water_arr = reproject_to_grid(
            src_path=water_mask_path,
            dst_grid=inner_grid,
            band=1,
            resampling=Resampling.nearest,
            ignore_src_nodata=True,
            dst_nodata=0.0,
        )
        is_water = water_arr > 0
        water_excluded_count = int(np.sum(pooling & is_water))
        pooling = pooling & (~is_water)

    pooling_uint8 = pooling.astype(np.uint8)
    stats = {
        "twi_p80_threshold": round(twi_thresh, 4),
        "elev_q25_threshold_m": round(elev_q25_thresh, 4),
        "pooling_fraction": round(float(np.mean(pooling_uint8 == 1)), 4),
        "lowground_le_0m_fraction": round(float(np.mean(lowground_mask == 1)), 4),
        "water_excluded_cells": water_excluded_count,
    }
    return pooling_uint8, lowground_mask, stats
