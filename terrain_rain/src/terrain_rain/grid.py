from dataclasses import dataclass
from pathlib import Path
import math
from typing import Tuple, Optional
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine, from_bounds
from rasterio.warp import transform_bounds


@dataclass(frozen=True)
class GridSpec:
    crs: CRS
    transform: Affine
    width: int
    height: int
    res: float = 30.0

    @property
    def shape(self) -> Tuple[int, int]:
        return (self.height, self.width)

    @property
    def bounds(self) -> Tuple[float, float, float, float]:
        """Returns (xmin, ymin, xmax, ymax) in grid CRS."""
        xmin = self.transform.c
        ymax = self.transform.f
        xmax = xmin + self.width * self.transform.a
        ymin = ymax + self.height * self.transform.e
        return (xmin, ymin, xmax, ymax)

    def profile(self, dtype: str, nodata: float | int, count: int = 1) -> dict:
        return {
            "driver": "GTiff",
            "crs": self.crs,
            "transform": self.transform,
            "width": self.width,
            "height": self.height,
            "count": count,
            "dtype": dtype,
            "nodata": nodata,
            "compress": "lzw",
        }


def get_inner_grid(
    inner_bbox_wgs84: list[float],
    target_crs: str = "EPSG:32651",
    res: float = 30.0,
    template_path: Optional[Path] = None,
) -> GridSpec:
    """
    Loads grid from Adrian's shared/grid_template.tif if present;
    otherwise derives a 30m UTM 51N lattice snapped outward to multiples of 30m.
    """
    if template_path is not None and Path(template_path).exists():
        with rasterio.open(template_path) as src:
            return GridSpec(
                crs=src.crs,
                transform=src.transform,
                width=src.width,
                height=src.height,
                res=abs(src.transform.a),
            )

    dst_crs = CRS.from_string(target_crs)
    xmin, ymin, xmax, ymax = transform_bounds(
        CRS.from_epsg(4326), dst_crs, *inner_bbox_wgs84, densify_pts=21
    )

    # Snap outward to exact multiples of res (30 m)
    xmin_snap = math.floor(xmin / res) * res
    ymin_snap = math.floor(ymin / res) * res
    xmax_snap = math.ceil(xmax / res) * res
    ymax_snap = math.ceil(ymax / res) * res

    width = int(round((xmax_snap - xmin_snap) / res))
    height = int(round((ymax_snap - ymin_snap) / res))
    transform = Affine(res, 0.0, xmin_snap, 0.0, -res, ymax_snap)

    return GridSpec(crs=dst_crs, transform=transform, width=width, height=height, res=res)


def extend_grid_to_cover(
    inner_grid: GridSpec, buffered_bbox_wgs84: list[float]
) -> Tuple[GridSpec, Tuple[slice, slice]]:
    """
    Extends inner_grid outward by whole 30m cells to cover buffered_bbox_wgs84.
    Returns (buffered_grid, (row_slice, col_slice)) so cropping back to inner_grid is exact.
    """
    b_xmin, b_ymin, b_xmax, b_ymax = transform_bounds(
        CRS.from_epsg(4326), inner_grid.crs, *buffered_bbox_wgs84, densify_pts=21
    )
    i_xmin, i_ymin, i_xmax, i_ymax = inner_grid.bounds
    res = inner_grid.res

    pad_left = max(0, int(math.ceil((i_xmin - b_xmin) / res)))
    pad_right = max(0, int(math.ceil((b_xmax - i_xmax) / res)))
    pad_top = max(0, int(math.ceil((b_ymax - i_ymax) / res)))
    pad_bottom = max(0, int(math.ceil((i_ymin - b_ymin) / res)))

    new_xmin = i_xmin - pad_left * res
    new_ymax = i_ymax + pad_top * res
    new_width = inner_grid.width + pad_left + pad_right
    new_height = inner_grid.height + pad_top + pad_bottom

    buffered_transform = Affine(res, 0.0, new_xmin, 0.0, -res, new_ymax)
    buffered_grid = GridSpec(
        crs=inner_grid.crs,
        transform=buffered_transform,
        width=new_width,
        height=new_height,
        res=res,
    )

    row_slice = slice(pad_top, pad_top + inner_grid.height)
    col_slice = slice(pad_left, pad_left + inner_grid.width)
    return buffered_grid, (row_slice, col_slice)


def crop_to_inner(array: np.ndarray, slices: Tuple[slice, slice]) -> np.ndarray:
    row_slice, col_slice = slices
    return array[row_slice, col_slice]
