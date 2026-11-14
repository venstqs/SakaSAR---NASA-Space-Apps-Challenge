from pathlib import Path
import sys
import numpy as np
import rasterio
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from terrain_rain.grid import get_inner_grid
from terrain_rain.io import write_layer


def test_layers_yaml_contract() -> None:
    with open(ROOT / "config" / "layers.yaml", "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)

    conventions = doc["nodata_conventions"]
    assert float(conventions["float32"]) == -9999.0
    assert int(conventions["uint8"]) == 255

    layers = doc["layers"]
    expected = {
        "dem_30m",
        "slope_deg_30m",
        "flow_acc_m2_30m",
        "twi_30m",
        "pooling_zones_30m",
        "lowground_mask_30m",
        "rain_event_mm_30m",
        "rain_prior7d_mm_30m",
        "smap_anomaly_zscore_30m",
    }
    assert set(layers.keys()) == expected

    for key, meta in layers.items():
        dtype = meta["dtype"]
        assert dtype in ("float32", "uint8"), f"Unexpected dtype for {key}: {dtype}"
        if dtype == "float32":
            assert float(meta["nodata"]) == -9999.0
        else:
            assert int(meta["nodata"]) == 255


def test_write_layer_roundtrip(tmp_path: Path) -> None:
    grid = get_inner_grid([123.18, 13.58, 123.23, 13.63], target_crs="EPSG:32651", res=30.0)
    arr = np.ones(grid.shape, dtype=np.float32) * 42.5
    out_tif = tmp_path / "test_layer.tif"

    write_layer(
        path=out_tif,
        array=arr,
        grid=grid,
        dtype="float32",
        nodata=-9999.0,
        band_name="test_band",
        units="mm",
    )

    assert out_tif.exists()
    with rasterio.open(out_tif) as src:
        assert src.crs.to_epsg() == 32651
        assert (src.height, src.width) == grid.shape
        assert src.dtypes[0] == "float32"
        assert float(src.nodata) == -9999.0
        assert src.descriptions[0] == "test_band"
        assert src.tags(1).get("units") == "mm"
        data = src.read(1)
        assert np.allclose(data, 42.5)
