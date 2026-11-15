"""Field Drowning Risk for every farmland cell in Bicol (100 m), after Typhoon Kristine.

Same formula as the 30 m pilot (docs/METHODS.md), on the regional grid of pipeline.bicol_region:

    S_SAR  = clip(−ΔVV / 4 dB, 0, 1)   ΔVV = VV(after) − median VV(3 pre-storm passes); orbit 134 (after 2 Nov) where it
                                       covers, orbit 61 (after 28 Oct) elsewhere
    S_TWI  = clip((TWI − 5) / 10, 0, 1)   NASADEM 100 m, priority-flood filled, D8
    S_Rain = clip(R / 300 mm, 0, 1)      NASA POWER daily rain 14–26 Oct 2024 (event + prior week), bilinear
    score  = round(100 × (0.45·S_SAR + 0.35·S_TWI + 0.20·S_Rain)); high ≥ 70, watch 40–69, low < 40

Scored on ESA WorldCover cropland only (farmland). Built-up and permanent water are excluded; cells without a valid
radar pair are flagged as missing. The radar is in both the score and the flood map, so the independent check uses the
terrain + rain part only (the same rule as the pilot).

Outputs (data/region/): bicol_risk.png (display), bicol_risk_values.png (R score, G class+2, A scored), bicol_risk.json
Run: python -m pipeline.bicol_risk     (needs the caches of pipeline.bicol_region)
"""
from __future__ import annotations

import json
import math
import time

import numpy as np
from PIL import Image
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from scipy import ndimage
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

from . import bicol_region as BR
from . import common as C
from .terrain_rain import d8_receivers, flow_accumulation, priority_flood

OUT = C.ROOT / "data" / "region"
CLASS_RGBA = {2: (226, 83, 60, 200), 1: (238, 159, 39, 185), 0: (124, 198, 154, 170), -1: (154, 165, 159, 120)}


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def main():
    t0 = time.perf_counter()
    G = BR.GRID; H, W = G.shape; cell = BR.CELL
    lc = BR.worldcover(False); z = BR.dem(False)
    tan_b, slope = C.slope_deg(np.where(np.isfinite(z), z, 0.0), cell=cell, smooth=1)
    perm_water, built, crop = lc == C.WC_WATER, lc == 50, lc == C.WC_CROP

    # ---- radar wetness change, orbit 134 where valid, else orbit 61 ----
    dvv = np.full((H, W), np.nan, "float32"); valid = np.zeros((H, W), bool); flood = np.zeros((H, W), bool)
    for orbit in (134, 61):
        cfg = BR.ORBITS[orbit]
        with np.errstate(all="ignore"):
            base = np.nanmedian(np.stack([C.to_db(BR.mosaic_date(orbit, d, False)) for d in cfg["baseline"]]), axis=0)
        after = C.to_db(BR.mosaic_date(orbit, cfg["after"], False))
        ok = np.isfinite(base) & np.isfinite(after) & ~valid
        d = after - base
        tau = BR.flood_for_orbit(orbit, slope, perm_water, False)["tau"]
        dvv[ok] = d[ok]; flood[ok] = ((after < tau) & (d < -2.0) & (slope < 5.0) & ~perm_water)[ok]; valid |= ok
    s_sar = np.clip(-dvv / 4.0, 0, 1)
    log(f"radar: {valid.mean() * 100:.0f}% of grid valid")

    # ---- terrain wetness at 100 m (land mask closes river gaps between town polygons) ----
    to_utm = Transformer.from_crs("EPSG:4326", BR.CRS, always_xy=True).transform
    munis = json.loads((OUT / "bicol_municipalities.geojson").read_text(encoding="utf-8"))
    geoms = [shp_transform(to_utm, shape(f["geometry"])) for f in munis["features"]]
    land = rasterize(((g, 1) for g in geoms), out_shape=(H, W), transform=G.transform, fill=0, dtype="uint8", all_touched=True).astype(bool)
    land = ndimage.binary_fill_holes(ndimage.binary_closing(land, structure=np.ones((3, 3)), iterations=2))
    town_id = rasterize(((g, i + 1) for i, g in enumerate(geoms)), out_shape=(H, W), transform=G.transform, fill=0, dtype="int32")
    log("priority flood + D8 at 100 m")
    filled = priority_flood(np.where(land, np.nan_to_num(z, nan=0.0), -50.0))
    acc = flow_accumulation(filled, d8_receivers(filled))
    twi = np.log((acc + 1.0) * cell / tan_b)
    s_twi = np.clip((twi - 5.0) / 10.0, 0, 1)

    # ---- rain, NASA POWER 14–26 Oct, bilinear ----
    tl = json.loads((OUT / "bicol_timeline.json").read_text(encoding="utf-8"))
    win = [i for i, d in enumerate(tl["days"]) if "2024-10-14" <= d <= "2024-10-26"]
    lons = sorted({c["lon"] for c in tl["cells"]}); lats = sorted({c["lat"] for c in tl["cells"]})
    gr = np.full((len(lats), len(lons)), np.nan)
    for i, c in enumerate(tl["cells"]):
        gr[lats.index(c["lat"]), lons.index(c["lon"])] = sum((tl["rain_mm"][i][k] or 0.0) for k in win)
    cols, rows = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    lon, lat = Transformer.from_crs(BR.CRS, "EPSG:4326", always_xy=True).transform(*(G.transform * (cols, rows)))
    fx = np.clip((lon - lons[0]) / (lons[-1] - lons[0]) * (len(lons) - 1), 0, len(lons) - 1.0001)
    fy = np.clip((lat - lats[0]) / (lats[-1] - lats[0]) * (len(lats) - 1), 0, len(lats) - 1.0001)
    x0, y0 = fx.astype(int), fy.astype(int); dx, dy = fx - x0, fy - y0
    rain = gr[y0, x0] * (1 - dx) * (1 - dy) + gr[y0, x0 + 1] * dx * (1 - dy) + gr[y0 + 1, x0] * (1 - dx) * dy + gr[y0 + 1, x0 + 1] * dx * dy
    s_rain = np.clip(rain / 300.0, 0, 1)

    # ---- score and classes on farmland ----
    farm = crop & land & ~built & ~perm_water
    score = np.round(100 * (0.45 * np.nan_to_num(s_sar) + 0.35 * s_twi + 0.20 * s_rain))
    cls = np.full((H, W), -9, "int8")
    cls[farm & valid] = np.where(score[farm & valid] >= 70, 2, np.where(score[farm & valid] >= 40, 1, 0))
    cls[farm & ~valid] = -1
    scored = farm & valid
    ha = cell * cell / 10_000
    log(f"farmland cells {farm.sum():,}; scored {scored.sum():,}; high {(cls == 2).sum() * ha:,.0f} ha, watch {(cls == 1).sum() * ha:,.0f} ha")

    # independent check: the terrain + rain part (renormalised) never sees the radar
    tr = np.round(100 * (0.35 * s_twi + 0.20 * s_rain) / 0.55)
    fl_farm = flood & scored
    validation = {
        "flooded_farmland_cells": int(fl_farm.sum()),
        "share_rated_high_full": round(float((cls[fl_farm] == 2).mean()), 3) if fl_farm.any() else None,
        "share_rated_high_terrain_rain": round(float((tr[fl_farm] >= 70).mean()), 3) if fl_farm.any() else None,
        "farmland_share_high_terrain_rain": round(float((tr[scored] >= 70).mean()), 3),
        "note": "The full score includes ΔVV, which also defines the flood map, so share_rated_high_full is circular. "
                "share_rated_high_terrain_rain is the independent test; compare it with farmland_share_high_terrain_rain.",
    }
    log(f"validation: {validation}")

    towns = {}
    for i, f in enumerate(munis["features"]):
        m = (town_id == i + 1) & scored
        if m.any():
            towns[f"{f['properties']['name']}|{f['properties']['province']}"] = {
                "high_ha": round(float((cls[m] == 2).sum() * ha)), "watch_ha": round(float((cls[m] == 1).sum() * ha)),
                "high_share": round(float((cls[m] == 2).mean()), 3), "median_score": int(np.median(score[m]))}

    # ---- rasters in Web Mercator (nearest: classes must stay exact) ----
    merc = "EPSG:3857"
    bw, bs, be, bn = transform_bounds(BR.CRS, merc, *G.bounds)
    px = cell; MW, MH = int((be - bw) / px), int((bn - bs) / px); mt = from_origin(bw, bn, px, px)
    def warp(a, fill):
        dst = np.full((MH, MW), fill, "float32")
        reproject(a.astype("float32"), dst, src_transform=G.transform, src_crs=BR.CRS, dst_transform=mt, dst_crs=merc,
                  src_nodata=fill, dst_nodata=fill, resampling=Resampling.nearest)
        return dst
    mcls = warp(cls, -9); msc = warp(np.where(farm, score, -1), -1)
    disp = np.zeros((MH, MW, 4), "uint8")
    for k, rgba in CLASS_RGBA.items():
        disp[mcls == k] = rgba
    Image.fromarray(disp, "RGBA").save(OUT / "bicol_risk.png", optimize=True)
    vals = np.zeros((MH, MW, 4), "uint8")
    on = mcls > -9
    vals[..., 0] = np.where(on, np.clip(msc, 0, 100), 0); vals[..., 1] = np.where(on, mcls + 2, 0); vals[..., 3] = np.where(on, 255, 0)
    Image.fromarray(vals, "RGBA").save(OUT / "bicol_risk_values.png", optimize=True)
    to_ll = Transformer.from_crs(merc, "EPSG:4326", always_xy=True)
    (lw, ln), (le, ls) = to_ll.transform(bw, bn), to_ll.transform(be, bs)
    doc = {
        "image": "data/region/bicol_risk.png", "values": "data/region/bicol_risk_values.png",
        "coordinates": [[round(lw, 5), round(ln, 5)], [round(le, 5), round(ln, 5)], [round(le, 5), round(ls, 5)], [round(lw, 5), round(ls, 5)]],
        "cell_m": cell, "formula": "round(100 × (0.45·S_SAR + 0.35·S_TWI + 0.20·S_Rain)), as the 30 m pilot",
        "radar": {"134": BR.ORBITS[134], "61": BR.ORBITS[61]}, "scored_on": "ESA WorldCover cropland",
        "area_ha": {"high": round(float((cls == 2).sum() * ha)), "watch": round(float((cls == 1).sum() * ha)),
                    "low": round(float((cls == 0).sum() * ha)), "missing": round(float((cls == -1).sum() * ha))},
        "validation": validation, "towns": towns, "processing_time_sec": round(time.perf_counter() - t0, 1),
    }
    (OUT / "bicol_risk.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"done in {doc['processing_time_sec']} s: {doc['area_ha']}")


if __name__ == "__main__":
    main()
