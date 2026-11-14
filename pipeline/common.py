"""Shared grid, data access, caching and vector helpers for the Field Shift pipeline.

All raster math happens on one 30 m grid in EPSG:32651 (UTM 51N). Vector outputs are
exported as EPSG:4326 GeoJSON for the MapLibre dashboard.

Data access order for every raster input:
  1. local cache in data/cache/*.npz (committed, so the pipeline runs offline on real data)
  2. live download from Microsoft Planetary Computer (STAC + signed COG windowed reads)
  3. deterministic synthetic fallback (clearly flagged as data_mode="synthetic_fallback")
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer
from rasterio import features
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import from_bounds
from shapely.geometry import box, mapping, shape
from shapely.ops import transform as shp_transform
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
PLOTS_PATH = Path(__file__).resolve().parent / "plots.geojson"

BBOX = (123.1912, 13.6152, 123.2102, 13.6215)  # min_lon, min_lat, max_lon, max_lat
CENTER = (123.2005, 13.6182)
UTM_CRS = "EPSG:32651"
CELL = 30.0
# Pad the analysis grid so D8 flow accumulation sees upslope area outside the display bbox.
PAD_M = 2000.0

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
SAS_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token"
HTTP_HEADERS = {"User-Agent": "fieldshift-pipeline/0.1"}
HTTP_TIMEOUT = 45

TO_UTM = Transformer.from_crs("EPSG:4326", UTM_CRS, always_xy=True)
TO_WGS = Transformer.from_crs(UTM_CRS, "EPSG:4326", always_xy=True)


@dataclass(frozen=True)
class Grid:
    transform: object
    width: int
    height: int
    crs: str = UTM_CRS

    @property
    def shape(self) -> tuple[int, int]:
        return (self.height, self.width)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        x0, y1 = self.transform.c, self.transform.f
        return (x0, y1 - self.height * CELL, x0 + self.width * CELL, y1)

    def xy(self, row: int, col: int) -> tuple[float, float]:
        """UTM coordinate of a cell centre."""
        x = self.transform.c + (col + 0.5) * CELL
        y = self.transform.f - (row + 0.5) * CELL
        return x, y

    def rowcol(self, x: float, y: float) -> tuple[int, int]:
        return int((self.transform.f - y) // CELL), int((x - self.transform.c) // CELL)


def build_grid(pad_m: float = PAD_M) -> Grid:
    minx, miny = TO_UTM.transform(BBOX[0], BBOX[1])
    maxx, maxy = TO_UTM.transform(BBOX[2], BBOX[3])
    minx = math.floor((minx - pad_m) / CELL) * CELL
    miny = math.floor((miny - pad_m) / CELL) * CELL
    maxx = math.ceil((maxx + pad_m) / CELL) * CELL
    maxy = math.ceil((maxy + pad_m) / CELL) * CELL
    width = int(round((maxx - minx) / CELL))
    height = int(round((maxy - miny) / CELL))
    return Grid(from_origin(minx, maxy, CELL, CELL), width, height)


GRID = build_grid()


# ----------------------------------------------------------------------------- geometry

def to_utm(geom):
    return shp_transform(TO_UTM.transform, geom)


def to_wgs(geom):
    return shp_transform(TO_WGS.transform, geom)


def bbox_polygon_wgs():
    return box(*BBOX)


def load_plots() -> list[dict]:
    with open(PLOTS_PATH, encoding="utf-8") as f:
        return json.load(f)["features"]


def plot_mask(geom_wgs, grid: Grid = GRID) -> np.ndarray:
    """Boolean mask of grid cells whose centres fall inside a WGS84 polygon."""
    return features.geometry_mask(
        [mapping(to_utm(geom_wgs))], out_shape=grid.shape, transform=grid.transform, invert=True
    )


def round_coords(geom_json: dict, nd: int = 6) -> dict:
    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]

    return {"type": geom_json["type"], "coordinates": r(geom_json["coordinates"])}


def vectorize(mask: np.ndarray, grid: Grid = GRID, min_area_m2: float = 2 * CELL * CELL,
              clip_to_bbox: bool = True, simplify_m: float = 5.0) -> list:
    """Vectorize a boolean raster into WGS84 shapely polygons (clipped to the display bbox)."""
    if not mask.any():
        return []
    polys = [
        shape(g)
        for g, v in features.shapes(mask.astype(np.uint8), mask=mask, transform=grid.transform)
        if v == 1
    ]
    merged = unary_union(polys)
    if clip_to_bbox:
        merged = merged.intersection(to_utm(bbox_polygon_wgs()))
    parts = getattr(merged, "geoms", [merged])
    out = []
    for p in parts:
        if p.geom_type != "Polygon" or p.area < min_area_m2:
            continue
        out.append(to_wgs(p.simplify(simplify_m, preserve_topology=True)))
    return out


def feature_collection(geoms: list, props: list[dict] | dict | None = None) -> dict:
    feats = []
    for i, g in enumerate(geoms):
        p = props[i] if isinstance(props, list) else (props or {})
        feats.append({"type": "Feature", "properties": p, "geometry": round_coords(mapping(g))})
    return {"type": "FeatureCollection", "features": feats}


# ----------------------------------------------------------------------------- raster math

def to_db(linear: np.ndarray) -> np.ndarray:
    return 10.0 * np.log10(np.maximum(linear, 1e-6))


def lee_filter(intensity: np.ndarray, size: int = 5, looks: float = 18.0) -> np.ndarray:
    """Lee speckle filter on linear intensity (CLAUDE.md §3A.2). NaNs are preserved."""
    from scipy.ndimage import uniform_filter

    nan = ~np.isfinite(intensity)
    img = np.where(nan, np.nanmean(intensity), intensity)
    mean = uniform_filter(img, size)
    mean_sq = uniform_filter(img * img, size)
    var = np.maximum(mean_sq - mean * mean, 1e-12)
    sigma_v2 = 1.0 / looks
    w = np.clip((var - mean * mean * sigma_v2) / var, 0.0, 1.0)
    out = mean + w * (img - mean)
    out[nan] = np.nan
    return out


def slope_deg(dem: np.ndarray, cell: float = CELL, smooth: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """Central-difference slope (CLAUDE.md §3B.1). Returns (tan_beta floored at 0.001, beta_deg).

    NASADEM heights are integer metres, so a light 3x3 mean is applied first to stop the
    1 m quantisation steps from producing a noisy 0 / 1.9 degree checkerboard on flat ground.
    """
    from scipy.ndimage import uniform_filter

    z = uniform_filter(dem.astype(float), smooth) if smooth > 1 else dem.astype(float)
    zp = np.pad(z, 1, mode="edge")
    dzdx = (zp[1:-1, 2:] - zp[1:-1, :-2]) / (2 * cell)
    dzdy = (zp[:-2, 1:-1] - zp[2:, 1:-1]) / (2 * cell)
    tan_b = np.maximum(np.hypot(dzdx, dzdy), 0.001)
    return tan_b, np.degrees(np.arctan(tan_b))


def otsu_threshold(values: np.ndarray, bins: int = 256) -> float:
    v = values[np.isfinite(values)]
    hist, edges = np.histogram(v, bins=bins)
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * centers) / np.maximum(w0, 1)
    m1 = (np.sum(hist * centers) - np.cumsum(hist * centers)) / np.maximum(w1, 1)
    between = w0 * w1 * (m0 - m1) ** 2
    return float(centers[np.argmax(between)])


# ----------------------------------------------------------------------------- Planetary Computer

def stac_search(collection: str, datetime: str | None = None, limit: int = 50) -> list[dict]:
    body = {"collections": [collection], "bbox": list(BBOX), "limit": limit}
    if datetime:
        body["datetime"] = datetime
    r = requests.post(f"{STAC_URL}/search", json=body, headers=HTTP_HEADERS, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json()["features"]


def stac_item(collection: str, item_id: str) -> dict:
    r = requests.get(f"{STAC_URL}/collections/{collection}/items/{item_id}",
                     headers=HTTP_HEADERS, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json()


_TOKENS: dict[str, str] = {}


def signed_href(collection: str, href: str) -> str:
    if collection not in _TOKENS:
        r = requests.get(f"{SAS_URL}/{collection}", headers=HTTP_HEADERS, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        _TOKENS[collection] = r.json()["token"]
    return f"{href}?{_TOKENS[collection]}"


def read_to_grid(href: str, resampling: Resampling, grid: Grid = GRID, attempts: int = 4) -> np.ndarray:
    """Windowed read of a remote COG, reprojected onto the shared 30 m grid (NaN = nodata).
    Retries on truncated HTTP tile reads, which Planetary Computer occasionally returns."""
    import time as _time

    from rasterio.errors import RasterioIOError

    for i in range(attempts):
        try:
            return _read_to_grid_once(href, resampling, grid)
        except RasterioIOError:
            if i == attempts - 1:
                raise
            _time.sleep(2 * (i + 1))


def _read_to_grid_once(href: str, resampling: Resampling, grid: Grid) -> np.ndarray:
    import rasterio

    with rasterio.Env(GDAL_HTTP_TIMEOUT=str(HTTP_TIMEOUT), GDAL_HTTP_MAX_RETRY="3",
                      GDAL_HTTP_RETRY_DELAY="2", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(href) as src:
            b = transform_bounds(grid.crs, src.crs, *grid.bounds, densify_pts=21)
            px = abs(src.res[0]) * 4
            win = from_bounds(b[0] - px, b[1] - px, b[2] + px, b[3] + px, src.transform)
            win = win.round_offsets().round_lengths()
            arr = src.read(1, window=win, boundless=True, fill_value=src.nodata).astype("float32")
            nodata = src.nodata
            if nodata is not None:
                arr[arr == nodata] = np.nan
            dst = np.full(grid.shape, np.nan, dtype="float32")
            reproject(arr, dst, src_transform=src.window_transform(win), src_crs=src.crs,
                      src_nodata=np.nan, dst_transform=grid.transform, dst_crs=grid.crs,
                      dst_nodata=np.nan, resampling=resampling)
    return dst


# ----------------------------------------------------------------------------- cache

def cache_path(name: str) -> Path:
    return CACHE_DIR / f"{name}.npz"


def save_cache(name: str, meta: dict, **arrays) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path(name), _meta=json.dumps(meta), **arrays)


def load_cache(name: str):
    p = cache_path(name)
    if not p.exists():
        return None
    z = np.load(p, allow_pickle=False)
    meta = json.loads(str(z["_meta"]))
    if meta.get("grid") != grid_signature():
        return None  # grid definition changed; cached arrays no longer line up
    return meta, {k: z[k] for k in z.files if k != "_meta"}


def grid_signature(grid: Grid = GRID) -> list:
    return [round(grid.transform.c, 3), round(grid.transform.f, 3), grid.width, grid.height, CELL]


# ----------------------------------------------------------------------------- DEM (shared by SAR flood mask and terrain hydrology)

NASADEM_ITEM = "NASADEM_HGT_n13e123"


def synthetic_dem(grid: Grid = GRID) -> np.ndarray:
    """Deterministic fallback DEM: lowland basin to the west rising to an eastern terrace,
    with a shallow drainage swale. Only used when no cache and no network."""
    rows, cols = np.mgrid[0:grid.height, 0:grid.width]
    x = cols / grid.width
    y = rows / grid.height
    rng = np.random.default_rng(20241022)
    z = 3.0 + 14.0 * x ** 1.6 + 2.0 * np.abs(y - 0.5) - 1.5 * np.exp(-((y - 0.5 - 0.1 * (x - 0.5)) / 0.06) ** 2)
    return (z + rng.normal(0, 0.3, z.shape)).astype("float32")


def load_dem(refresh: bool = False) -> tuple[np.ndarray, dict]:
    cached = None if refresh else load_cache("nasadem")
    if cached:
        meta, arrs = cached
        return arrs["dem"], meta
    try:
        item = stac_item("nasadem", NASADEM_ITEM)
        dem = read_to_grid(signed_href("nasadem", item["assets"]["elevation"]["href"]), Resampling.bilinear)
        if np.isnan(dem).mean() > 0.05:
            raise RuntimeError("NASADEM read returned mostly nodata")
        dem = np.where(np.isnan(dem), np.nanmin(dem), dem).astype("float32")
        meta = {"data_mode": "live", "source": "Microsoft Planetary Computer / nasadem",
                "item_id": NASADEM_ITEM, "grid": grid_signature()}
        save_cache("nasadem", meta, dem=dem)
        return dem, meta
    except Exception as exc:  # network down, token failure, etc.
        meta = {"data_mode": "synthetic_fallback", "reason": f"{type(exc).__name__}: {exc}",
                "grid": grid_signature()}
        return synthetic_dem(), meta


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
