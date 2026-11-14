from pathlib import Path
from typing import Dict
import numpy as np
import rasterio
from rasterio.enums import Resampling
from whitebox import WhiteboxTools
from .grid import GridSpec
from .io import reproject_to_grid, write_layer


def _get_wbt(work_dir: Path) -> WhiteboxTools:
    wbt = WhiteboxTools()
    wbt.set_working_dir(str(work_dir.resolve()))
    wbt.set_verbose_mode(False)
    return wbt


def condition_dem(
    dem_tif: Path, out_conditioned_tif: Path, method: str = "breach_depressions_fill_pits"
) -> Path:
    """
    Hydrologically conditions a DEM using WhiteboxTools BreachDepressions (with fill_pits=True)
    or falls back to FillDepressions.
    """
    wbt = _get_wbt(out_conditioned_tif.parent)
    src_str = str(dem_tif.resolve())
    dst_str = str(out_conditioned_tif.resolve())

    if method == "breach_depressions_fill_pits":
        ret = wbt.breach_depressions(dem=src_str, output=dst_str, fill_pits=True)
        if ret != 0 or not out_conditioned_tif.exists():
            wbt.fill_depressions(dem=src_str, output=dst_str)
    else:
        wbt.fill_depressions(dem=src_str, output=dst_str)

    return out_conditioned_tif


def run_terrain_pipeline(
    raw_dem_path: Path,
    buffered_grid: GridSpec,
    work_dir: Path,
    slope_floor_deg: float = 0.1,
    conditioning_method: str = "breach_depressions_fill_pits",
) -> Dict[str, np.ndarray]:
    """
    Runs the full WhiteboxTools + NumPy terrain pipeline on the buffered 30m UTM lattice:
      1. Reproject band 1 of NASADEM with bilinear resampling (no nodata masking of <= 0m cells).
      2. Condition DEM with BreachDepressions (--fill_pits).
      3. Run D8FlowAccumulation twice: 'cells' and 'specific contributing area'.
      4. Compute upslope area in m2 = cells * 900.
      5. Run Slope in degrees on the conditioned DEM.
      6. Compute TWI in numpy: ln(SCA / tan(max(slope, slope_floor_deg))).
      7. Run FillDepressions on original DEM and compute depression_depth = filled - original.
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    wbt = _get_wbt(work_dir)

    # 1. Reproject NASADEM band 1 to buffered 30m UTM lattice (ignore -inf nodata tag)
    dem_buf = reproject_to_grid(
        src_path=raw_dem_path,
        dst_grid=buffered_grid,
        band=1,
        resampling=Resampling.bilinear,
        ignore_src_nodata=True,
    )
    orig_dem_tif = work_dir / "dem_buffered_30m.tif"
    write_layer(orig_dem_tif, dem_buf, buffered_grid, "float32", -9999.0, "elevation", "m")

    # 2. Condition DEM (BreachDepressions --fill_pits)
    cond_dem_tif = work_dir / "dem_conditioned_30m.tif"
    condition_dem(orig_dem_tif, cond_dem_tif, method=conditioning_method)

    # 3. D8FlowAccumulation: once as 'cells', once as 'specific contributing area'
    fa_cells_tif = work_dir / "fa_cells_30m.tif"
    fa_sca_tif = work_dir / "fa_sca_30m.tif"
    wbt.d8_flow_accumulation(
        i=str(cond_dem_tif.resolve()), output=str(fa_cells_tif.resolve()), out_type="cells"
    )
    wbt.d8_flow_accumulation(
        i=str(cond_dem_tif.resolve()),
        output=str(fa_sca_tif.resolve()),
        out_type="specific contributing area",
    )

    # 4. Slope in degrees on conditioned DEM
    slope_tif = work_dir / "slope_deg_buffered_30m.tif"
    wbt.slope(dem=str(cond_dem_tif.resolve()), output=str(slope_tif.resolve()), units="degrees")

    # 5. FillDepressions on original DEM for depression depth (filled - original)
    filled_dem_tif = work_dir / "dem_filled_30m.tif"
    wbt.fill_depressions(dem=str(orig_dem_tif.resolve()), output=str(filled_dem_tif.resolve()))

    # Read back buffered arrays
    with rasterio.open(fa_cells_tif) as src:
        fa_cells = src.read(1).astype(np.float32)
    with rasterio.open(fa_sca_tif) as src:
        sca = src.read(1).astype(np.float32)
    with rasterio.open(slope_tif) as src:
        slope_deg = src.read(1).astype(np.float32)
    with rasterio.open(filled_dem_tif) as src:
        dem_filled = src.read(1).astype(np.float32)

    # Clean any edge artifacts from WhiteboxTools
    slope_deg = np.clip(np.nan_to_num(slope_deg, nan=0.0), 0.0, 89.9)
    sca = np.maximum(np.nan_to_num(sca, nan=buffered_grid.res), buffered_grid.res)
    fa_cells = np.maximum(np.nan_to_num(fa_cells, nan=1.0), 1.0)

    # Upslope area in m2 = cells * (30m * 30m)
    cell_area_m2 = buffered_grid.res * buffered_grid.res
    flow_acc_m2 = (fa_cells * cell_area_m2).astype(np.float32)

    # 6. Compute TWI in numpy: ln(SCA / tan(slope_rad)) with slope floored at slope_floor_deg
    slope_clamped_deg = np.maximum(slope_deg, slope_floor_deg)
    slope_rad = np.deg2rad(slope_clamped_deg)
    twi = np.log(sca / np.tan(slope_rad)).astype(np.float32)

    # 7. Depression depth = filled - original
    depression_depth = np.maximum(0.0, dem_filled - dem_buf).astype(np.float32)

    return {
        "dem": dem_buf,
        "slope_deg": slope_deg,
        "flow_acc_m2": flow_acc_m2,
        "twi": twi,
        "depression_depth": depression_depth,
    }
