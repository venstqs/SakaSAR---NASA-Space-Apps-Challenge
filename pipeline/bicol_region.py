"""Bicol Region flood screening — flooded farmland per municipality after Typhoon Kristine.

Region-wide companion to the 30 m Minalabac pilot. Same method, coarser grid (100 m) so all six
provinces (Albay, Camarines Norte, Camarines Sur, Catanduanes, Masbate, Sorsogon) fit on a laptop:

  Sentinel-1 RTC VV, read from COG overviews onto a 100 m UTM 51N grid
    orbit 134 desc (west & centre): baseline = median(15 Sep, 27 Sep, 9 Oct 2024), after = 2 Nov 2024
    orbit 61  desc (east, fills gaps, e.g. Catanduanes): baseline = median(10 Sep, 4 Oct, 16 Oct), after = 28 Oct
  flood    = VV_after < τ (Otsu, bounded −20…−12 dB) ∧ ΔVV < −2 dB ∧ slope < 5° ∧ not permanent water
  farmland = ESA WorldCover 2021 cropland (class 40)
  per municipality (NAMRIA/PSA boundaries via geoBoundaries, CC BY 3.0 IGO):
    farmland ha, flooded farmland ha and %, radar coverage %, source orbit/date

Outputs (committed, small):
  data/region/bicol_municipalities.geojson   simplified polygons + statistics
  data/region/bicol_flood.png (+ .json)      flooded-farmland overlay for the map (Web Mercator)
  data/region/bicol_summary.json             region totals, provinces, top municipalities, method
Large intermediate rasters are cached in data/cache_region/ (git-ignored).

Run:  python -m pipeline.bicol_region [--refresh]
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer
from rasterio import features
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from shapely.geometry import mapping, shape
from shapely.ops import transform as shp_transform

from . import common as C

BICOL_BBOX = (122.30, 11.80, 124.45, 14.60)
CELL = 100.0
CRS = "EPSG:32651"
CACHE = C.ROOT / "data" / "cache_region"
OUT = C.ROOT / "data" / "region"
BICOL_PROVINCES = {"Albay", "Camarines Norte", "Camarines Sur", "Catanduanes", "Masbate", "Sorsogon"}
GB_API = "https://www.geoboundaries.org/api/current/gbOpen/PHL/{lvl}/"

ORBITS = {
    134: {"baseline": ["2024-09-15", "2024-09-27", "2024-10-09"], "after": "2024-11-02"},
    61: {"baseline": ["2024-09-10", "2024-10-04", "2024-10-16"], "after": "2024-10-28"},
}
TO_UTM = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
TO_WGS = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)


def build_grid():
    xs, ys = TO_UTM.transform([BICOL_BBOX[0], BICOL_BBOX[2], BICOL_BBOX[0], BICOL_BBOX[2]],
                              [BICOL_BBOX[1], BICOL_BBOX[1], BICOL_BBOX[3], BICOL_BBOX[3]])
    x0, y0 = math.floor(min(xs) / CELL) * CELL, math.floor(min(ys) / CELL) * CELL
    x1, y1 = math.ceil(max(xs) / CELL) * CELL, math.ceil(max(ys) / CELL) * CELL
    w, h = int((x1 - x0) / CELL), int((y1 - y0) / CELL)
    return RegionGrid(from_origin(x0, y1, CELL, CELL), w, h, CRS)


class RegionGrid(C.Grid):
    """common.Grid assumes the pilot's 30 m cell in .bounds; this grid uses 100 m cells."""

    @property
    def bounds(self):
        x0, y1 = self.transform.c, self.transform.f
        return (x0, y1 - self.height * CELL, x0 + self.width * CELL, y1)


GRID = build_grid()


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def read_coarse(href: str, resampling: Resampling, grid=GRID, attempts: int = 4) -> np.ndarray:
    """Read a remote COG at ~grid resolution (uses overviews) and reproject onto the grid."""
    import rasterio

    for i in range(attempts):
        try:
            with rasterio.Env(GDAL_HTTP_TIMEOUT="60", GDAL_HTTP_MAX_RETRY="3", GDAL_HTTP_RETRY_DELAY="2",
                              GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
                with rasterio.open(href) as src:
                    bb = transform_bounds(grid.crs, src.crs, *grid.bounds, densify_pts=21)
                    sb = src.bounds
                    bb = (max(bb[0], sb.left), max(bb[1], sb.bottom), min(bb[2], sb.right), min(bb[3], sb.top))
                    if bb[0] >= bb[2] or bb[1] >= bb[3]:
                        return np.full(grid.shape, np.nan, "float32")
                    from rasterio.windows import from_bounds
                    win = from_bounds(*bb, src.transform).round_offsets().round_lengths()
                    res = abs(src.res[0]) if src.crs.is_projected else abs(src.res[0]) * 111_000
                    fac = max(1, int(CELL / res))  # read at ~the target cell (uses a coarse COG overview)
                    shp = (max(1, int(win.height // fac)), max(1, int(win.width // fac)))
                    arr = src.read(1, window=win, out_shape=shp, resampling=resampling).astype("float32")
                    if src.nodata is not None:
                        arr[arr == src.nodata] = np.nan
                    wt = src.window_transform(win) * src.window_transform(win).scale(win.width / shp[1], win.height / shp[0])
                    dst = np.full(grid.shape, np.nan, "float32")
                    reproject(arr, dst, src_transform=wt, src_crs=src.crs, src_nodata=np.nan,
                              dst_transform=grid.transform, dst_crs=grid.crs, dst_nodata=np.nan, resampling=resampling)
                    return dst
        except Exception as exc:
            if i == attempts - 1:
                raise
            log(f"  retry {i + 1} ({type(exc).__name__})")
            time.sleep(3 * (i + 1))


def cached(name: str, fn, refresh: bool):
    path = CACHE / f"{name}.npy"
    if path.exists() and not refresh:
        return np.load(path)
    arr = fn()
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(path, arr)
    return arr


def stac(collection: str, datetime: str | None = None, bbox=BICOL_BBOX) -> list[dict]:
    body = {"collections": [collection], "bbox": list(bbox), "limit": 200}
    if datetime:
        body["datetime"] = datetime
    r = requests.post(f"{C.STAC_URL}/search", json=body, headers=C.HTTP_HEADERS, timeout=90)
    r.raise_for_status()
    return r.json()["features"]


def mosaic_date(orbit: int, date: str, refresh: bool) -> np.ndarray:
    """All frames of one orbit/date merged onto the grid (linear γ0)."""
    def build():
        items = [f for f in stac("sentinel-1-rtc", f"{date}T00:00:00Z/{date}T23:59:59Z")
                 if f["properties"].get("sat:relative_orbit") == orbit]
        out = np.full(GRID.shape, np.nan, "float32")
        for it in items:
            log(f"  S1 orbit {orbit} {date} {it['id'][17:40]}")
            arr = read_coarse(C.signed_href("sentinel-1-rtc", it["assets"]["vv"]["href"]), Resampling.average)
            fill = np.isnan(out) & np.isfinite(arr)
            out[fill] = arr[fill]
        return out
    return cached(f"s1_o{orbit}_{date}", build, refresh)


def worldcover(refresh: bool) -> np.ndarray:
    def build():
        out = np.zeros(GRID.shape, "float32")
        for it in stac("esa-worldcover"):
            if "2021" not in it["id"]:
                continue
            log(f"  WorldCover {it['id']}")
            arr = read_coarse(C.signed_href("esa-worldcover", it["assets"]["map"]["href"]), Resampling.mode)
            fill = (out == 0) & np.isfinite(arr) & (arr > 0)
            out[fill] = arr[fill]
        return out
    return cached("worldcover", build, refresh)


def dem(refresh: bool) -> np.ndarray:
    def build():
        out = np.full(GRID.shape, np.nan, "float32")
        for it in stac("nasadem"):
            log(f"  NASADEM {it['id']}")
            arr = read_coarse(C.signed_href("nasadem", it["assets"]["elevation"]["href"]), Resampling.bilinear)
            fill = np.isnan(out) & np.isfinite(arr)
            out[fill] = arr[fill]
        return out
    return cached("nasadem", build, refresh)


def flood_for_orbit(orbit: int, slope: np.ndarray, perm_water: np.ndarray, refresh: bool) -> dict:
    cfg = ORBITS[orbit]
    base_stack = [C.to_db(mosaic_date(orbit, d, refresh)) for d in cfg["baseline"]]
    with np.errstate(all="ignore"):
        base = np.nanmedian(np.stack(base_stack), axis=0)
    after = C.to_db(mosaic_date(orbit, cfg["after"], refresh))
    valid = np.isfinite(base) & np.isfinite(after)
    d = after - base
    otsu = C.otsu_threshold(after[valid]) if valid.any() else -15.0
    tau = otsu if -20 <= otsu <= -12 else -15.0
    flood = valid & (after < tau) & (d < -2.0) & (slope < 5.0) & ~perm_water
    return {"valid": valid, "flood": flood, "tau": round(float(tau), 2), "otsu": round(float(otsu), 2),
            "after": cfg["after"], "baseline": cfg["baseline"]}


def boundaries() -> list[dict]:
    """Bicol municipalities with their province, from geoBoundaries (NAMRIA/PSA)."""
    path = CACHE / "bicol_adm3.geojson"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))["features"]
    fetch = lambda lvl: requests.get(requests.get(GB_API.format(lvl=lvl), headers=C.HTTP_HEADERS, timeout=60)  # noqa: E731
                                     .json()["simplifiedGeometryGeoJSON"], headers=C.HTTP_HEADERS, timeout=180).json()
    provs = [(f["properties"]["shapeName"], shape(f["geometry"])) for f in fetch("ADM2")["features"]
             if f["properties"]["shapeName"] in BICOL_PROVINCES]
    out = []
    for f in fetch("ADM3")["features"]:
        g = shape(f["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        pt = g.representative_point()
        prov = next((n for n, pg in provs if pg.contains(pt)), None)
        if prov:
            out.append({"type": "Feature", "properties": {"name": f["properties"]["shapeName"], "province": prov},
                        "geometry": mapping(g)})
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": out}), encoding="utf-8")
    return out


def flood_png(flood_farm: np.ndarray, farmland: np.ndarray) -> dict:
    """Web-Mercator PNG overlay: flooded farmland in water blue, other farmland faintly."""
    from PIL import Image

    merc = "EPSG:3857"
    w, s, e, n = transform_bounds(CRS, merc, *GRID.bounds)
    px = 150.0
    W, H = int((e - w) / px), int((n - s) / px)
    t = from_origin(w, n, px, px)
    def warp(a):
        dst = np.zeros((H, W), "float32")
        reproject(a.astype("float32"), dst, src_transform=GRID.transform, src_crs=CRS,
                  dst_transform=t, dst_crs=merc, resampling=Resampling.max)
        return dst
    fl, fa = warp(flood_farm), warp(farmland)
    rgba = np.zeros((H, W, 4), "uint8")
    rgba[fa > 0] = (233, 228, 201, 46)          # farmland: faint straw tint
    rgba[fl > 0] = (78, 196, 222, 235)          # flooded farmland: floodwater blue
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(OUT / "bicol_flood.png", optimize=True)
    to_ll = Transformer.from_crs(merc, "EPSG:4326", always_xy=True)
    (lw, ln), (le, ls) = to_ll.transform(w, n), to_ll.transform(e, s)
    coords = [[lw, ln], [le, ln], [le, ls], [lw, ls]]
    meta = {"image": "data/region/bicol_flood.png", "coordinates": [[round(a, 5), round(b, 5)] for a, b in coords]}
    (OUT / "bicol_flood.json").write_text(json.dumps(meta), encoding="utf-8")
    return meta


def run(refresh: bool = False) -> dict:
    t0 = time.perf_counter()
    log(f"grid {GRID.shape} at {CELL:.0f} m")
    lc = worldcover(refresh)
    z = dem(refresh)
    _, slope = C.slope_deg(np.where(np.isfinite(z), z, 0.0), cell=CELL, smooth=1)
    perm_water = lc == C.WC_WATER
    farmland = lc == C.WC_CROP
    res = {o: flood_for_orbit(o, slope, perm_water, refresh) for o in ORBITS}
    use134 = res[134]["valid"]
    use61 = ~use134 & res[61]["valid"]
    flood = np.where(use134, res[134]["flood"], res[61]["flood"])
    valid = use134 | use61
    flood_farm = flood & farmland
    cell_ha = CELL * CELL / 10_000

    rows = []
    feats = boundaries()
    for f in feats:
        g = shape(f["geometry"])
        g_utm = shp_transform(TO_UTM.transform, g)
        m = features.geometry_mask([mapping(g_utm)], out_shape=GRID.shape, transform=GRID.transform, invert=True)
        if not m.any():
            continue
        farm = farmland & m
        farm_ha = float(farm.sum()) * cell_ha
        fl_ha = float((flood_farm & m).sum()) * cell_ha
        cov = float((valid & m).sum()) / float(m.sum())
        o134 = float((use134 & m).sum()) >= float((use61 & m).sum())
        props = {
            "name": f["properties"]["name"], "province": f["properties"]["province"],
            "farmland_ha": round(farm_ha), "flooded_farmland_ha": round(fl_ha),
            "flooded_share": round(fl_ha / farm_ha, 4) if farm_ha > 0 else 0.0,
            "radar_coverage": round(cov, 3),
            "sentinel1": f"orbit {'134' if o134 else '61'}, after {res[134 if o134 else 61]['after']}",
        }
        gs = g.simplify(0.003, preserve_topology=True)
        rows.append({"type": "Feature", "properties": props, "geometry": C.round_coords(mapping(gs), 4)})
    rows.sort(key=lambda r: -r["properties"]["flooded_farmland_ha"])
    for i, r in enumerate(rows, 1):
        r["properties"]["rank"] = i
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "bicol_municipalities.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": rows}, ensure_ascii=False), encoding="utf-8")

    png = flood_png(flood_farm, farmland)
    provinces = {}
    for r in rows:
        p = r["properties"]
        d = provinces.setdefault(p["province"], {"province": p["province"], "farmland_ha": 0, "flooded_farmland_ha": 0, "municipalities": 0})
        d["farmland_ha"] += p["farmland_ha"]
        d["flooded_farmland_ha"] += p["flooded_farmland_ha"]
        d["municipalities"] += 1
    for d in provinces.values():
        d["flooded_share"] = round(d["flooded_farmland_ha"] / d["farmland_ha"], 4) if d["farmland_ha"] else 0
    summary = {
        "region": "Bicol Region (Region V)",
        "event": "Severe Tropical Storm Kristine (Trami), 21–26 Oct 2024",
        "grid": f"{CELL:.0f} m, EPSG:32651",
        "farmland_ha": round(sum(d["farmland_ha"] for d in provinces.values())),
        "flooded_farmland_ha": round(sum(d["flooded_farmland_ha"] for d in provinces.values())),
        "municipalities": len(rows),
        "radar_coverage": round(float(valid.mean()), 3),
        "provinces": sorted(provinces.values(), key=lambda d: -d["flooded_farmland_ha"]),
        "top_municipalities": [r["properties"] for r in rows[:15]],
        "orbits": {str(o): {k: v for k, v in res[o].items() if k in ("after", "baseline", "tau", "otsu")} for o in ORBITS},
        "overlay": png,
        "method": ("Sentinel-1 RTC VV at 100 m: flood = dark (Otsu-bounded threshold), ≥2 dB drop vs a 3-pass "
                   "pre-storm median, slope < 5°, not permanent water; counted on ESA WorldCover cropland. "
                   "Orbit 134 (after 2 Nov) where available, orbit 61 (after 28 Oct) elsewhere. Water under tall "
                   "canopy and in built-up areas is missed; 100 m cells undercount small flooded paddies."),
        "sources": ["Sentinel-1 RTC (ESA/Copernicus, Microsoft Planetary Computer)", "NASADEM (NASA)",
                    "ESA WorldCover 2021 (CC BY 4.0)",
                    "Municipal boundaries: NAMRIA/PSA via geoBoundaries (CC BY 3.0 IGO)"],
        "processing_time_sec": round(time.perf_counter() - t0, 1),
    }
    (OUT / "bicol_summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    log(f"done: {summary['flooded_farmland_ha']:,} ha flooded farmland of {summary['farmland_ha']:,} ha "
        f"across {len(rows)} municipalities (coverage {summary['radar_coverage']:.0%})")
    for d in summary["provinces"]:
        log(f"  {d['province']}: {d['flooded_farmland_ha']:,} ha ({d['flooded_share']:.1%})")
    for p in summary["top_municipalities"][:8]:
        log(f"  #{p['rank']} {p['name']}, {p['province']}: {p['flooded_farmland_ha']:,} ha ({p['flooded_share']:.1%})")
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true")
    run(ap.parse_args().refresh)
