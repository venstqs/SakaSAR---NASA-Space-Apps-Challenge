"""Bicol-wide runoff and ponding risk (terrain + rain) and the NASADEM drainage network.

Applies the radar-free part of SakaSAR's Field Drowning Risk score to every land cell in Bicol:

    score = round(100 × (0.35·S_TWI + 0.20·S_Rain) / 0.55)      (same S_TWI, S_Rain as docs/METHODS.md)

  * NASADEM (cached by pipeline.bicol_region, 100 m) aggregated to 200 m, depressions filled (priority flood),
    D8 flow accumulation, slope and Topographic Wetness Index.
  * Rain R = NASA POWER daily rain, 14–26 Oct 2024 (Kristine 21–26 Oct + the 7 days before), bilinear on the
    0.5° grid from data/region/bicol_timeline.json.
  * Land = Bicol municipal polygons. Sea cells act as outlets.

It never sees the radar, so we check it against the Sentinel-1 flood map (data/region/bicol_flood.png): the share of
radar-flooded farmland pixels that this model rates watch or high.

Outputs (data/region/):
  bicol_runoff.png + .json    display raster (Web Mercator) and bounds, validation, per-town summary
  bicol_runoff_values.png     R = score 0–100, G = TWI×10, A = land (for exact values in the browser)
  bicol_streams.geojson       drainage lines with ≥ 10 km² upstream, property up_km2

Run: python -m pipeline.bicol_runoff        (needs data/cache_region/nasadem.npy from pipeline.bicol_region)
"""
from __future__ import annotations

import json
import math
import time

import numpy as np
from affine import Affine
from PIL import Image
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

from . import bicol_region as BR
from . import common as C
from .terrain_rain import d8_receivers, flow_accumulation, priority_flood, OFFSETS

OUT = C.ROOT / "data" / "region"
CELL = 200.0
STREAM_KM2 = 10.0
W_TWI, W_RAIN = 0.35, 0.20


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def main():
    t0 = time.perf_counter()
    dem100 = np.load(BR.CACHE / "nasadem.npy")
    g = BR.build_grid()
    h, w = (dem100.shape[0] // 2) * 2, (dem100.shape[1] // 2) * 2
    dem = dem100[:h, :w].reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    H, W = dem.shape
    t = g.transform * Affine.scale(2)
    log(f"DEM {W}x{H} at {CELL:.0f} m")

    # land mask from the 114 municipal polygons (UTM)
    to_utm = Transformer.from_crs("EPSG:4326", BR.CRS, always_xy=True).transform
    munis = json.loads((OUT / "bicol_municipalities.geojson").read_text(encoding="utf-8"))
    geoms = [shp_transform(to_utm, shape(f["geometry"])) for f in munis["features"]]
    land = rasterize(((gm, 1) for gm in geoms), out_shape=(H, W), transform=t, fill=0, dtype="uint8").astype(bool)
    town_id = rasterize(((gm, i + 1) for i, gm in enumerate(geoms)), out_shape=(H, W), transform=t, fill=0, dtype="int32")

    work = np.where(land, np.nan_to_num(dem, nan=0.0), -50.0)  # sea is a low outlet
    log("priority flood")
    filled = priority_flood(work)
    log("D8 receivers + flow accumulation")
    rec = d8_receivers(filled)
    acc = flow_accumulation(filled, rec)
    tan_b, _ = C.slope_deg(np.where(land, dem, 0.0), cell=CELL, smooth=1)
    twi = np.log((acc + 1.0) * CELL / tan_b)
    s_twi = np.clip((twi - 5.0) / 10.0, 0, 1)

    # NASA POWER rain 14–26 Oct, bilinear on the regular 0.5° grid
    tl = json.loads((OUT / "bicol_timeline.json").read_text(encoding="utf-8"))
    days = tl["days"]
    win = [i for i, d in enumerate(days) if "2024-10-14" <= d <= "2024-10-26"]
    lons = sorted({c["lon"] for c in tl["cells"]}); lats = sorted({c["lat"] for c in tl["cells"]})
    grid_r = np.full((len(lats), len(lons)), np.nan)
    for i, c in enumerate(tl["cells"]):
        grid_r[lats.index(c["lat"]), lons.index(c["lon"])] = sum((tl["rain_mm"][i][k] or 0.0) for k in win)
    cols, rows = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    xs, ys = t * (cols, rows)
    lon, lat = Transformer.from_crs(BR.CRS, "EPSG:4326", always_xy=True).transform(xs, ys)
    fx = np.clip((lon - lons[0]) / (lons[-1] - lons[0]) * (len(lons) - 1), 0, len(lons) - 1.0001)
    fy = np.clip((lat - lats[0]) / (lats[-1] - lats[0]) * (len(lats) - 1), 0, len(lats) - 1.0001)
    x0, y0 = fx.astype(int), fy.astype(int); dx, dy = fx - x0, fy - y0
    rain = (grid_r[y0, x0] * (1 - dx) * (1 - dy) + grid_r[y0, x0 + 1] * dx * (1 - dy)
            + grid_r[y0 + 1, x0] * (1 - dx) * dy + grid_r[y0 + 1, x0 + 1] * dx * dy)
    s_rain = np.clip(rain / 300.0, 0, 1)
    score = np.round(100 * (W_TWI * s_twi + W_RAIN * s_rain) / (W_TWI + W_RAIN))
    score[~land] = np.nan
    ls_ = score[land]
    log(f"score: land mean {np.nanmean(ls_):.0f}, high (>=70) {np.mean(ls_ >= 70) * 100:.1f}% of land")

    # ---------- drainage network: chains of stream cells, split at junctions ----------
    up_km2 = (acc + 1) * (CELL / 1000) ** 2
    stream = (up_km2 >= STREAM_KM2) & land
    n_in = np.zeros(H * W, int)
    sidx = np.flatnonzero(stream.ravel())
    recf = rec.ravel()
    def down(i):
        k = recf[i]
        if k < 0: return -1
        r, c = divmod(int(i), W); dr, dc = OFFSETS[k]; rr, cc = r + dr, c + dc
        return rr * W + cc if 0 <= rr < H and 0 <= cc < W else -1
    nxt = {int(i): down(i) for i in sidx}
    for i, j in nxt.items():
        if j >= 0 and stream.flat[j]: n_in[j] += 1
    to_ll = Transformer.from_crs(BR.CRS, "EPSG:4326", always_xy=True).transform
    def ll(i):
        r, c = divmod(int(i), W); x, y = t * (c + 0.5, r + 0.5); a, b = to_ll(x, y); return [round(a, 4), round(b, 4)]
    feats = []
    starts = [i for i in nxt if n_in[i] != 1]  # heads (0 in) and junctions (2+ in)
    for s0 in starts:
        line = [s0]; j = nxt[s0]
        while j >= 0 and stream.flat[j]:
            line.append(j)
            if n_in[j] != 1: break
            j = nxt.get(j, -1)
        if len(line) >= 2:
            feats.append({"type": "Feature", "properties": {"up_km2": round(float(up_km2.flat[line[-1]]), 1)},
                          "geometry": {"type": "LineString", "coordinates": [ll(i) for i in line]}})
    (OUT / "bicol_streams.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")), encoding="utf-8")
    log(f"streams: {len(feats)} lines")

    # ---------- rasters in Web Mercator ----------
    merc = "EPSG:3857"
    bw, bs, be, bn = transform_bounds(BR.CRS, merc, *(t * (0, H)), *(t * (W, 0)))
    px = CELL
    MW, MH = int((be - bw) / px), int((bn - bs) / px)
    mt = from_origin(bw, bn, px, px)
    def warp(a, rs=Resampling.nearest):
        dst = np.full((MH, MW), np.nan, "float32")
        reproject(a.astype("float32"), dst, src_transform=t, src_crs=BR.CRS, dst_transform=mt, dst_crs=merc,
                  src_nodata=np.nan, dst_nodata=np.nan, resampling=rs)
        return dst
    ms, mtw = warp(score), warp(np.where(land, twi, np.nan))
    ok = np.isfinite(ms)
    vals = np.zeros((MH, MW, 4), "uint8")
    vals[..., 0] = np.where(ok, ms, 0).astype("uint8")
    vals[..., 1] = np.where(ok, np.clip(mtw * 10, 0, 255), 0).astype("uint8")
    vals[..., 3] = np.where(ok, 255, 0)
    Image.fromarray(vals, "RGBA").save(OUT / "bicol_runoff_values.png", optimize=True)
    # display: transparent below 40, amber at watch, deep blue-violet at high (water collecting)
    # Kristine's rain saturates S_Rain almost everywhere, so the terrain term separates places: start the colours at 60
    stops = [(60, (190, 225, 240, 0)), (66, (150, 205, 235, 110)), (70, (47, 159, 211, 170)), (82, (27, 95, 170, 200)), (100, (40, 30, 120, 225))]
    disp = np.zeros((MH, MW, 4), "uint8")
    v = np.where(ok, ms, 0)
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        m = ok & (v >= a) & (v <= b); f = ((v - a) / (b - a))[m][:, None]
        disp[m] = (np.array(ca) * (1 - f) + np.array(cb) * f).astype("uint8")
    Image.fromarray(disp, "RGBA").save(OUT / "bicol_runoff.png", optimize=True)
    to_ll_m = Transformer.from_crs(merc, "EPSG:4326", always_xy=True)
    (lw, ln), (le, ls) = to_ll_m.transform(bw, bn), to_ll_m.transform(be, bs)

    # ---------- independent check against the radar flood map ----------
    fl = Image.open(OUT / "bicol_flood.png").convert("RGBA"); fa = np.asarray(fl)[..., 3]
    fmeta = json.loads((OUT / "bicol_flood.json").read_text())
    (fw, fn), _, (fe, fs) = fmeta["coordinates"][0], None, fmeta["coordinates"][2]
    def score_at(mask):
        fy_, fx_ = np.nonzero(mask)
        return fy_, fx_
    fy_, fx_ = np.nonzero(fa >= 200)
    ymerc = lambda la: math.log(math.tan(math.pi / 4 + math.radians(la) / 2))
    yN, yS = ymerc(fn), ymerc(fs)
    plon = fw + (fx_ + 0.5) / fa.shape[1] * (fe - fw)
    plat = np.degrees(2 * np.arctan(np.exp(yN - (fy_ + 0.5) / fa.shape[0] * (yN - yS))) - np.pi / 2)
    ux, uy = Transformer.from_crs("EPSG:4326", BR.CRS, always_xy=True).transform(plon, plat)
    cc, rr = ~t * (ux, uy)
    cc, rr = cc.astype(int), rr.astype(int)
    inb = (rr >= 0) & (rr < H) & (cc >= 0) & (cc < W)
    sv = score[rr[inb], cc[inb]]; sv = sv[np.isfinite(sv)]
    # baseline: all farmland pixels (flooded or not) in the same map
    gy, gx = np.nonzero(fa > 0)
    glon = fw + (gx + 0.5) / fa.shape[1] * (fe - fw)
    glat = np.degrees(2 * np.arctan(np.exp(yN - (gy + 0.5) / fa.shape[0] * (yN - yS))) - np.pi / 2)
    gux, guy = Transformer.from_crs("EPSG:4326", BR.CRS, always_xy=True).transform(glon, glat)
    gc, gr = ~t * (gux, guy); gc, gr = gc.astype(int), gr.astype(int)
    gin = (gr >= 0) & (gr < H) & (gc >= 0) & (gc < W)
    fv = score[gr[gin], gc[gin]]; fv = fv[np.isfinite(fv)]
    land_s = score[land & np.isfinite(score)]
    validation = {
        "flooded_pixels_checked": int(sv.size),
        "share_rated_high": round(float(np.mean(sv >= 70)), 3) if sv.size else None,
        "share_rated_watch_or_high": round(float(np.mean(sv >= 40)), 3) if sv.size else None,
        "land_share_high": round(float(np.mean(land_s >= 70)), 3),
        "farmland_share_high": round(float(np.mean(fv >= 70)), 3) if fv.size else None,
        "land_share_watch_or_high": round(float(np.mean(land_s >= 40)), 3),
        "note": "Radar-flooded farmland pixels (Sentinel-1, 28 Oct + 2 Nov) vs this terrain + rain score, which never saw the radar. Baselines: all Bicol land and all farmland.",
    }
    log(f"validation: {validation}")

    towns = {}
    for i, f in enumerate(munis["features"]):
        m = (town_id == i + 1) & np.isfinite(score)
        if m.any():
            sc = score[m]
            towns[f"{f['properties']['name']}|{f['properties']['province']}"] = {"mean": int(round(float(sc.mean()))), "high_share": round(float(np.mean(sc >= 70)), 3)}
    doc = {
        "image": "data/region/bicol_runoff.png", "values": "data/region/bicol_runoff_values.png",
        "coordinates": [[round(lw, 5), round(ln, 5)], [round(le, 5), round(ln, 5)], [round(le, 5), round(ls, 5)], [round(lw, 5), round(ls, 5)]],
        "cell_m": CELL, "formula": "round(100 × (0.35·S_TWI + 0.20·S_Rain) / 0.55); S_TWI = clip((TWI−5)/10), S_Rain = clip(R/300), R = NASA POWER 14–26 Oct 2024",
        "rain_window": ["2024-10-14", "2024-10-26"], "stream_threshold_km2": STREAM_KM2, "streams": len(feats),
        "validation": validation, "towns": towns,
        "sources": ["NASADEM (via Microsoft Planetary Computer, 100 m → 200 m)", "NASA POWER regional daily rain", "Bicol municipal boundaries"],
    }
    (OUT / "bicol_runoff.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"done in {time.perf_counter() - t0:.0f} s")


if __name__ == "__main__":
    main()
