from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from terrain_rain.grid import crop_to_inner, extend_grid_to_cover, get_inner_grid


def test_inner_grid_snapping_and_res() -> None:
    bbox = [123.18, 13.58, 123.23, 13.63]
    grid = get_inner_grid(bbox, target_crs="EPSG:32651", res=30.0, template_path=None)

    assert grid.crs.to_epsg() == 32651
    assert grid.res == 30.0
    assert grid.width > 0 and grid.height > 0

    xmin, ymin, xmax, ymax = grid.bounds
    assert xmin % 30.0 == 0.0
    assert ymin % 30.0 == 0.0
    assert xmax % 30.0 == 0.0
    assert ymax % 30.0 == 0.0


def test_extend_and_crop_roundtrip() -> None:
    inner_bbox = [123.18, 13.58, 123.23, 13.63]
    buffered_bbox = [123.1430, 13.5441, 123.2670, 13.6659]

    inner_grid = get_inner_grid(inner_bbox, target_crs="EPSG:32651", res=30.0)
    buffered_grid, slices = extend_grid_to_cover(inner_grid, buffered_bbox)

    assert buffered_grid.width > inner_grid.width
    assert buffered_grid.height > inner_grid.height

    dummy = np.arange(buffered_grid.height * buffered_grid.width, dtype=np.float32).reshape(
        buffered_grid.shape
    )
    cropped = crop_to_inner(dummy, slices)
    assert cropped.shape == inner_grid.shape

    # Verify pixel origin of cropped slice aligns exactly with inner_grid origin
    row_slice, col_slice = slices
    crop_xmin = buffered_grid.transform.c + col_slice.start * buffered_grid.res
    crop_ymax = buffered_grid.transform.f - row_slice.start * buffered_grid.res
    assert abs(crop_xmin - inner_grid.transform.c) < 1e-6
    assert abs(crop_ymax - inner_grid.transform.f) < 1e-6
