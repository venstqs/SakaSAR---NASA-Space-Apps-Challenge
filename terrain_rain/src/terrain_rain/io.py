from pathlib import Path
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject
from .grid import GridSpec


def write_layer(
    path: Path | str,
    array: np.ndarray,
    grid: GridSpec,
    dtype: str,
    nodata: float | int,
    band_name: str,
    units: str,
) -> Path:
    """Writes a single-band GeoTIFF with LZW compression, band description, and units tag."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    arr = np.asarray(array, dtype=dtype)
    if arr.shape != grid.shape:
        raise ValueError(f"Array shape {arr.shape} does not match grid shape {grid.shape}")

    profile = grid.profile(dtype=dtype, nodata=nodata, count=1)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr, 1)
        dst.set_band_description(1, band_name)
        dst.update_tags(1, units=units, band_name=band_name)
        dst.update_tags(units=units)

    return path


def reproject_to_grid(
    src_path: Path | str,
    dst_grid: GridSpec,
    band: int = 1,
    resampling: Resampling = Resampling.bilinear,
    ignore_src_nodata: bool = False,
    dst_nodata: float = -9999.0,
) -> np.ndarray:
    """Reprojects a source raster band onto dst_grid."""
    with rasterio.open(src_path) as src:
        src_arr = src.read(band).astype(np.float32)
        src_nodata = None if ignore_src_nodata else src.nodata

        # Replace non-finite values (-inf/inf/nan) if ignoring corrupted nodata tag
        if ignore_src_nodata:
            bad_mask = ~np.isfinite(src_arr)
            if np.any(bad_mask):
                src_arr[bad_mask] = 0.0

        dst_arr = np.full(dst_grid.shape, dst_nodata, dtype=np.float32)
        reproject(
            source=src_arr,
            destination=dst_arr,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src_nodata,
            dst_transform=dst_grid.transform,
            dst_crs=dst_grid.crs,
            dst_nodata=dst_nodata,
            resampling=resampling,
        )
    return dst_arr
