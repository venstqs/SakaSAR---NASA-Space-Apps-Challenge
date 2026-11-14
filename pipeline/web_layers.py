"""Export the 30 m pilot grids (data/layers/*.tif) for the dashboard.

Each GeoTIFF (EPSG:32651) is reprojected onto one Web Mercator grid at ~30 m, so the browser can draw it as map
tiles and read the exact cell value under the cursor. Values are stored as scaled integers to keep the file small.

Output: data/region/pilot_grids.json
Run:    python -m pipeline.web_layers
"""
from __future__ import annotations

import json
import math

import numpy as np
import rasterio
from rasterio.warp import Resampling, calculate_default_transform, reproject

from . import common as C

SRC = C.DATA_DIR / "layers"
OUT = C.ROOT / "data" / "region" / "pilot_grids.json"
# name: (file, scale, resampling, unit, description)
LAYERS = {
    "twi": ("twi.tif", 10, Resampling.bilinear, "", "Topographic Wetness Index from NASADEM (higher = water collects)"),
    "slope": ("slope_deg.tif", 10, Resampling.bilinear, "°", "Slope from NASADEM"),
    "dvv": ("wetness_change_vv_db.tif", 10, Resampling.bilinear, "dB", "Sentinel-1 VV change, 2 Nov minus dry baseline (negative = wetter)"),
    "score": ("risk_score.tif", 1, Resampling.nearest, "/100", "Field Drowning Risk score"),
    "cls": ("risk_class.tif", 1, Resampling.nearest, "", "Risk class: 0 low, 1 watch, 2 high, -1 no radar, -2 not farmland"),
    "flood": ("observed_flood.tif", 1, Resampling.nearest, "", "Sentinel-1 flood mask on 2 Nov (1 = water)"),
    "lc": ("landcover.tif", 1, Resampling.nearest, "", "ESA WorldCover 2021 class"),
}
MISSING = -32768


def main():
    with rasterio.open(SRC / "twi.tif") as ref:
        transform, width, height = calculate_default_transform(ref.crs, "EPSG:3857", ref.width, ref.height, *ref.bounds, resolution=30)
        src_crs = ref.crs
    out = {}
    for name, (fname, scale, rs, unit, desc) in LAYERS.items():
        with rasterio.open(SRC / fname) as r:
            src = r.read(1).astype("float64")
            if r.nodata is not None and not (isinstance(r.nodata, float) and math.isnan(r.nodata)):
                src[src == r.nodata] = np.nan
            dst = np.full((height, width), np.nan)
            reproject(src, dst, src_transform=r.transform, src_crs=src_crs, dst_transform=transform, dst_crs="EPSG:3857",
                      resampling=rs, src_nodata=np.nan, dst_nodata=np.nan)
        vals = np.where(np.isfinite(dst), np.round(dst * scale), MISSING).astype(int)
        out[name] = {"scale": scale, "unit": unit, "description": desc, "values": vals.ravel().tolist()}
    # bounds in lon/lat from the Mercator transform
    x0, y0 = transform.c, transform.f
    x1, y1 = x0 + transform.a * width, y0 + transform.e * height
    R = 6378137.0
    lon = lambda x: math.degrees(x / R)
    lat = lambda y: math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    doc = {
        "built": "from data/layers/*.tif (risk_engine.export_layers)",
        "crs": "EPSG:3857 grid, ~30 m cells, row 0 = north",
        "width": width, "height": height,
        "bounds": [round(lon(x0), 6), round(lat(y1), 6), round(lon(x1), 6), round(lat(y0), 6)],
        "missing": MISSING,
        "worldcover": {"10": "Tree cover", "20": "Shrubland", "30": "Grassland", "40": "Cropland", "50": "Built-up",
                       "60": "Bare", "80": "Permanent water", "90": "Herbaceous wetland"},
        "layers": out,
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(C.ROOT)}: {width}x{height}, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
