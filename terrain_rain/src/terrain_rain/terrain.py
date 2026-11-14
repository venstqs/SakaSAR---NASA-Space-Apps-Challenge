import heapq
from pathlib import Path
from typing import Dict, Optional, Tuple
import numpy as np
import rasterio
from rasterio.enums import Resampling
from scipy import ndimage
import whitebox
from whitebox import WhiteboxTools
from .grid import GridSpec
from .io import reproject_to_grid, write_layer


def _wbt_binary_exists() -> bool:
    """Checks whether the WhiteboxTools binary is already present in whitebox/WBT."""
    wbt_dir = Path(whitebox.__file__).resolve().parent / "WBT"
    for exe_name in ("whitebox_tools.exe", "whitebox_tools"):
        exe_path = wbt_dir / exe_name
        if exe_path.exists() and exe_path.stat().st_size > 100_000:
            return True
    return False


def _get_wbt(work_dir: Path, max_retries: int = 2) -> Optional[WhiteboxTools]:
    """
    Returns an initialized WhiteboxTools instance if the binary exists or downloads cleanly
    within max_retries; otherwise returns None so the caller can fall back to the offline
    NumPy/SciPy terrain engine.
    """
    attempts = 1 if _wbt_binary_exists() else max_retries
    for _ in range(attempts):
        try:
            if not _wbt_binary_exists():
                wbt = WhiteboxTools()
            else:
                wbt = WhiteboxTools()
            wbt.set_working_dir(str(work_dir.resolve()))
            wbt.set_verbose_mode(False)
            ver = wbt.version()
            if ver:
                return wbt
        except Exception:
            continue
    return None


def _fill_depressions_numpy_scipy(dem: np.ndarray, eps: float = 0.0) -> np.ndarray:
    """
    Hydrological depression filling (Priority-Flood / morphological grey reconstruction)
    using pure NumPy + SciPy/heapq so closed pits are filled to their spill elevation.
    When eps > 0, applies a slight gradient across flats toward the spill outlet.
    """
    rows, cols = dem.shape
    filled = np.empty_like(dem, dtype=np.float64)
    visited = np.zeros((rows, cols), dtype=bool)
    heap: list[Tuple[float, int, int]] = []

    # Seed boundary cells
    for r in range(rows):
        for c in (0, cols - 1):
            if not visited[r, c]:
                visited[r, c] = True
                val = float(dem[r, c])
                filled[r, c] = val
                heapq.heappush(heap, (val, r, c))
    for c in range(1, cols - 1):
        for r in (0, rows - 1):
            if not visited[r, c]:
                visited[r, c] = True
                val = float(dem[r, c])
                filled[r, c] = val
                heapq.heappush(heap, (val, r, c))

    neighbors = (
        (-1, -1), (-1, 0), (-1, 1),
        (0, -1),           (0, 1),
        (1, -1),  (1, 0),  (1, 1),
    )

    while heap:
        elev, r, c = heapq.heappop(heap)
        for dr, dc in neighbors:
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and not visited[nr, nc]:
                visited[nr, nc] = True
                nelev = float(dem[nr, nc])
                if nelev <= elev:
                    nelev = elev + eps
                filled[nr, nc] = nelev
                heapq.heappush(heap, (nelev, nr, nc))

    # Optional morphological grey reconstruction check via scipy.ndimage if available
    if hasattr(ndimage, "grey_reconstruction") and eps == 0.0:
        try:
            seed = np.full_like(dem, np.max(dem), dtype=np.float64)
            seed[0, :] = dem[0, :]
            seed[-1, :] = dem[-1, :]
            seed[:, 0] = dem[:, 0]
            seed[:, -1] = dem[:, -1]
            filled = ndimage.grey_reconstruction(seed, dem)
        except Exception:
            pass

    return filled.astype(np.float32)


def _compute_d8_flow_accumulation_numpy(dem_cond: np.ndarray, cell_size: float = 30.0) -> np.ndarray:
    """
    Pure NumPy D8 flow routing: each cell routes flow to the steepest downslope neighbor
    among its 8 neighbors, accumulated from highest to lowest elevation.
    """
    rows, cols = dem_cond.shape
    neighbors = [
        (-1, -1, np.hypot(cell_size, cell_size)),
        (-1,  0, cell_size),
        (-1,  1, np.hypot(cell_size, cell_size)),
        ( 0, -1, cell_size),
        ( 0,  1, cell_size),
        ( 1, -1, np.hypot(cell_size, cell_size)),
        ( 1,  0, cell_size),
        ( 1,  1, np.hypot(cell_size, cell_size)),
    ]

    best_drop = np.zeros((rows, cols), dtype=np.float32)
    target_r = np.full((rows, cols), -1, dtype=np.int32)
    target_c = np.full((rows, cols), -1, dtype=np.int32)

    for dr, dc, dist in neighbors:
        r_src = slice(max(0, -dr), rows - max(0, dr))
        c_src = slice(max(0, -dc), cols - max(0, dc))
        r_dst = slice(max(0, dr), rows - max(0, -dr))
        c_dst = slice(max(0, dc), cols - max(0, -dc))

        drop = (dem_cond[r_src, c_src] - dem_cond[r_dst, c_dst]) / float(dist)
        better = drop > best_drop[r_src, c_src]

        rr, cc = np.meshgrid(
            np.arange(r_dst.start, r_dst.stop, dtype=np.int32),
            np.arange(c_dst.start, c_dst.stop, dtype=np.int32),
            indexing="ij",
        )
        best_drop_view = best_drop[r_src, c_src]
        tr_view = target_r[r_src, c_src]
        tc_view = target_c[r_src, c_src]

        best_drop_view[better] = drop[better]
        tr_view[better] = rr[better]
        tc_view[better] = cc[better]

    # Sort cells from highest to lowest conditioned elevation
    flat_dem = dem_cond.ravel()
    order = np.argsort(flat_dem, kind="mergesort")[::-1]

    fa_cells = np.ones((rows, cols), dtype=np.float32)
    flat_tr = target_r.ravel()
    flat_tc = target_c.ravel()

    for idx in order:
        tr = int(flat_tr[idx])
        if tr >= 0:
            tc = int(flat_tc[idx])
            r = int(idx // cols)
            c = int(idx % cols)
            fa_cells[tr, tc] += fa_cells[r, c]

    return fa_cells


def _run_numpy_scipy_terrain_fallback(
    dem_buf: np.ndarray,
    cell_size: float = 30.0,
    slope_floor_deg: float = 0.1,
) -> Dict[str, np.ndarray]:
    """
    Offline pure NumPy/SciPy hydrological terrain pipeline.
    """
    # 1. Slope in degrees from 30m UTM DEM using np.gradient(dem_buf, 30.0, 30.0)
    dz_dy, dz_dx = np.gradient(dem_buf.astype(np.float64), float(cell_size), float(cell_size))
    slope_rad_raw = np.arctan(np.hypot(dz_dy, dz_dx))
    slope_deg = np.rad2deg(slope_rad_raw).astype(np.float32)
    slope_deg = np.clip(np.nan_to_num(slope_deg, nan=0.0), 0.0, 89.9)

    # 2. Depression filling (eps=0 for depression_depth, eps=1e-5 for D8 conditioning)
    dem_filled = _fill_depressions_numpy_scipy(dem_buf, eps=0.0)
    depression_depth = np.maximum(0.0, dem_filled - dem_buf).astype(np.float32)

    dem_cond = _fill_depressions_numpy_scipy(dem_buf, eps=1e-5)

    # 3. D8 flow routing in pure NumPy
    fa_cells = _compute_d8_flow_accumulation_numpy(dem_cond, cell_size=float(cell_size))
    fa_cells = np.maximum(np.nan_to_num(fa_cells, nan=1.0), 1.0)
    flow_acc_m2 = (fa_cells * float(cell_size * cell_size)).astype(np.float32)
    sca = (fa_cells * float(cell_size)).astype(np.float32)

    # 4. TWI = ln(sca / tan(deg2rad(max(slope_deg, slope_floor_deg))))
    twi = np.log(
        sca / np.tan(np.deg2rad(np.maximum(slope_deg, float(slope_floor_deg))))
    ).astype(np.float32)

    return {
        "dem": dem_buf.astype(np.float32),
        "slope_deg": slope_deg,
        "flow_acc_m2": flow_acc_m2,
        "twi": twi,
        "depression_depth": depression_depth,
    }


def condition_dem(
    dem_tif: Path, out_conditioned_tif: Path, method: str = "breach_depressions_fill_pits"
) -> Path:
    """
    Hydrologically conditions a DEM using WhiteboxTools BreachDepressions (with fill_pits=True)
    or falls back to FillDepressions / offline NumPy/SciPy conditioning.
    """
    wbt = _get_wbt(out_conditioned_tif.parent)
    if wbt is None:
        with rasterio.open(dem_tif) as src:
            dem_arr = src.read(1).astype(np.float32)
            profile = src.profile.copy()
        cond_arr = _fill_depressions_numpy_scipy(dem_arr, eps=1e-5)
        with rasterio.open(out_conditioned_tif, "w", **profile) as dst:
            dst.write(cond_arr, 1)
        return out_conditioned_tif

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
    Runs the WhiteboxTools + NumPy terrain pipeline on the buffered 30m UTM lattice,
    or falls back to the 100% offline NumPy/SciPy hydrological implementation if the
    WhiteboxTools binary is unavailable.
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

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

    wbt = _get_wbt(work_dir)
    if wbt is not None:
        try:
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
            wbt.slope(
                dem=str(cond_dem_tif.resolve()), output=str(slope_tif.resolve()), units="degrees"
            )

            # 5. FillDepressions on original DEM for depression depth (filled - original)
            filled_dem_tif = work_dir / "dem_filled_30m.tif"
            wbt.fill_depressions(
                dem=str(orig_dem_tif.resolve()), output=str(filled_dem_tif.resolve())
            )

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
        except Exception as exc:
            print(
                f"[terrain] WhiteboxTools execution failed ({exc}); "
                "falling back to offline NumPy/SciPy D8 terrain engine."
            )

    print("[terrain] Using offline NumPy/SciPy D8 terrain engine.")
    return _run_numpy_scipy_terrain_fallback(
        dem_buf=dem_buf,
        cell_size=float(buffered_grid.res),
        slope_floor_deg=float(slope_floor_deg),
    )
