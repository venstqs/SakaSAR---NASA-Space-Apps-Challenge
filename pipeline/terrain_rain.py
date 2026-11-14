"""Terrain hydrology (NASADEM) and storm rainfall (NASA POWER) — CLAUDE.md §3B and §3C.

  slope β → priority-flood depression filling → D8 flow direction → flow accumulation
  → specific catchment area a = (N_up + 1)·Δx → TWI = ln(a / tan β) → S_TWI
  NASA POWER daily PRECTOTCORR → antecedent 7-day + event rainfall R → S_Rain

Notes on deviations from the original spec, all deliberate:
  * Depressions are filled (Barnes priority-flood + ε) before D8. Without this, every 1 m pit
    in the integer NASADEM becomes a sink and flow accumulation collapses.
  * The drainage corridor is traced from the computed flow network (main stem through the
    highest-accumulation cell in the display bbox), not between hard-coded endpoints.
  * The DEM grid is padded 2 km beyond the display bbox so upslope area is counted.

Run:  python -m pipeline.terrain_rain [--refresh]
Out:  data/terrain_rain_output.json
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
import time

import numpy as np
import requests
from shapely.geometry import LineString, shape

from . import common as C

POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
POWER_PARAMS = "PRECTOTCORR,T2M_MAX,T2M_MIN,ALLSKY_SFC_SW_DWN"
POWER_START, POWER_END = "20241001", "20241031"
EVENT_START, EVENT_END = "20241021", "20241026"   # STS Kristine (Trami) over Bicol
ANTECEDENT_DAYS = 7
RAIN_SATURATION_MM = 300.0
FALLBACK_RAIN_MM = 300.0
POWER_CACHE = C.CACHE_DIR / "nasa_power_202410.json"
OUTPUT = C.DATA_DIR / "terrain_rain_output.json"

# D8 neighbour offsets (row, col) and distances in cell units
OFFSETS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
DIST = np.array([math.sqrt(2) if dr and dc else 1.0 for dr, dc in OFFSETS])


# ----------------------------------------------------------------------------- hydrology

def priority_flood(dem: np.ndarray, eps: float = 1e-3) -> np.ndarray:
    """Fill depressions so every cell drains to the grid edge (Barnes et al. 2014, +ε variant)."""
    h, w = dem.shape
    filled = dem.astype("float64").copy()
    seen = np.zeros(dem.shape, bool)
    heap: list = []
    for r in range(h):
        for c in (0, w - 1):
            heapq.heappush(heap, (filled[r, c], r, c)); seen[r, c] = True
    for c in range(1, w - 1):
        for r in (0, h - 1):
            heapq.heappush(heap, (filled[r, c], r, c)); seen[r, c] = True
    while heap:
        z, r, c = heapq.heappop(heap)
        for dr, dc in OFFSETS:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and not seen[rr, cc]:
                seen[rr, cc] = True
                if filled[rr, cc] <= z:
                    filled[rr, cc] = z + eps
                heapq.heappush(heap, (filled[rr, cc], rr, cc))
    return filled


def d8_receivers(filled: np.ndarray) -> np.ndarray:
    """Index (0-7) of the steepest-descent neighbour, or -1 for outlets (edge cells draining off-grid)."""
    h, w = filled.shape
    zp = np.pad(filled, 1, constant_values=np.nan)
    drops = np.full((8, h, w), -np.inf)
    for k, (dr, dc) in enumerate(OFFSETS):
        nb = zp[1 + dr:1 + dr + h, 1 + dc:1 + dc + w]
        drops[k] = np.where(np.isnan(nb), -np.inf, (filled - nb) / DIST[k])
    rec = np.argmax(drops, axis=0)
    rec[np.max(drops, axis=0) <= 0] = -1
    return rec


def flow_accumulation(filled: np.ndarray, rec: np.ndarray) -> np.ndarray:
    """N_up: number of upslope cells draining through each cell."""
    h, w = filled.shape
    acc = np.zeros(h * w)
    order = np.argsort(filled, axis=None)[::-1]
    flat_rec = rec.ravel()
    for idx in order:
        k = flat_rec[idx]
        if k < 0:
            continue
        r, c = divmod(int(idx), w)
        dr, dc = OFFSETS[k]
        acc[(r + dr) * w + (c + dc)] += acc[idx] + 1
    return acc.reshape(h, w)


def twi(acc: np.ndarray, tan_b: np.ndarray) -> np.ndarray:
    a = (acc + 1.0) * C.CELL
    return np.log(a / tan_b)


def s_twi(twi_value: float) -> float:
    """CLAUDE.md §3B.3: S_TWI = clip((TWI − 5) / 10, 0, 1)."""
    return float(np.clip((twi_value - 5.0) / 10.0, 0.0, 1.0))


def main_stem(acc: np.ndarray, rec: np.ndarray, region: np.ndarray, min_acc: float = 20) -> list[tuple[int, int]]:
    """Main drainage path through `region`: start at its highest-accumulation cell, walk upstream
    along the largest donor while still inside the region, then downstream to where it leaves."""
    h, w = acc.shape
    masked = np.where(region, acc, -1)
    r0, c0 = np.unravel_index(np.argmax(masked), acc.shape)

    upstream = [(r0, c0)]
    r, c = r0, c0
    while True:
        best, best_acc = None, min_acc
        for k, (dr, dc) in enumerate(OFFSETS):
            rr, cc = r - dr, c - dc  # neighbour that would drain INTO (r, c) via offset k
            if 0 <= rr < h and 0 <= cc < w and rec[rr, cc] == k and acc[rr, cc] > best_acc:
                best, best_acc = (rr, cc), acc[rr, cc]
        if best is None or not region[best]:
            if best is not None:
                upstream.append(best)
            break
        upstream.append(best)
        r, c = best

    downstream = []
    r, c = r0, c0
    while rec[r, c] >= 0:
        dr, dc = OFFSETS[rec[r, c]]
        r, c = r + dr, c + dc
        downstream.append((r, c))
        if not region[r, c]:
            break
    return upstream[::-1] + downstream


# ----------------------------------------------------------------------------- rainfall

def load_power(refresh: bool = False) -> tuple[dict, str]:
    if POWER_CACHE.exists() and not refresh:
        return json.loads(POWER_CACHE.read_text(encoding="utf-8")), "cache"
    r = requests.get(POWER_URL, params={
        "parameters": POWER_PARAMS, "community": "AG", "longitude": C.CENTER[0],
        "latitude": C.CENTER[1], "start": POWER_START, "end": POWER_END, "format": "JSON",
    }, headers=C.HTTP_HEADERS, timeout=90)
    r.raise_for_status()
    params = r.json()["properties"]["parameter"]
    C.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    POWER_CACHE.write_text(json.dumps(params, indent=1), encoding="utf-8")
    return params, "live"


def rainfall_summary(refresh: bool = False) -> dict:
    try:
        params, mode = load_power(refresh)
    except Exception as exc:
        return {"data_mode": "synthetic_fallback", "reason": f"{type(exc).__name__}: {exc}",
                "r_total_mm": FALLBACK_RAIN_MM, "s_rain": s_rain(FALLBACK_RAIN_MM)}
    rain = {d: v for d, v in params["PRECTOTCORR"].items() if v is not None and v >= 0}
    days = sorted(rain)
    ev0 = days.index(EVENT_START)
    antecedent = days[max(0, ev0 - ANTECEDENT_DAYS):ev0]
    event = [d for d in days if EVENT_START <= d <= EVENT_END]
    r_ant = sum(rain[d] for d in antecedent)
    r_evt = sum(rain[d] for d in event)
    peak_day = max(event, key=lambda d: rain[d])
    total = r_ant + r_evt
    return {
        "data_mode": "live" if mode == "live" else "cached_live",
        "source": "NASA POWER daily PRECTOTCORR (point query at map centre)",
        "antecedent_window": [antecedent[0], antecedent[-1]],
        "event_window": [EVENT_START, EVENT_END],
        "r_antecedent_mm": round(r_ant, 1),
        "r_event_mm": round(r_evt, 1),
        "r_total_mm": round(total, 1),
        "peak_day": peak_day,
        "peak_day_mm": round(rain[peak_day], 1),
        "s_rain": round(s_rain(total), 3),
        "daily_mm": {d: round(rain[d], 2) for d in days},
    }


def s_rain(total_mm: float) -> float:
    """CLAUDE.md §3C.2: S_Rain = clip(R / 300, 0, 1)."""
    return float(np.clip(total_mm / RAIN_SATURATION_MM, 0.0, 1.0))


# ----------------------------------------------------------------------------- run

def run(refresh: bool = False, write: bool = True) -> dict:
    t0 = time.perf_counter()
    dem, dem_meta = C.load_dem(refresh)
    tan_b, beta = C.slope_deg(dem)
    filled = priority_flood(dem)
    rec = d8_receivers(filled)
    acc = flow_accumulation(filled, rec)
    twi_grid = twi(acc, tan_b)

    bbox_mask = C.plot_mask(C.bbox_polygon_wgs())
    path = main_stem(acc, rec, bbox_mask)
    line_utm = LineString([C.GRID.xy(r, c) for r, c in path]).simplify(C.CELL / 2)
    line = C.to_wgs(line_utm)
    drainage_corridor = C.feature_collection([line], {
        "name": "NASADEM Flow Accumulation Channel",
        "max_upslope_cells": int(max(acc[r, c] for r, c in path)),
        "length_m": round(line_utm.length),
    })

    plots = []
    for f in C.load_plots():
        m = C.plot_mask(shape(f["geometry"]))
        t = float(np.mean(twi_grid[m]))
        plots.append({
            "plot_id": f["properties"]["plot_id"],
            "twi_value": round(t, 1),
            "twi_p90": round(float(np.percentile(twi_grid[m], 90)), 1),
            "s_twi": round(s_twi(t), 3),
            "mean_slope_deg": round(float(np.mean(beta[m])), 2),
            "mean_elevation_m": round(float(np.mean(dem[m])), 1),
            "max_upslope_cells": int(acc[m].max()),
        })

    output = {
        "provenance": {
            "dem": {k: v for k, v in dem_meta.items() if k != "grid"},
            "grid": {"crs": C.UTM_CRS, "cell_m": C.CELL, "shape": list(C.GRID.shape), "pad_m": C.PAD_M},
            "bbox_twi_range": [round(float(np.percentile(twi_grid[bbox_mask], p)), 1) for p in (5, 50, 95)],
            "processing_time_sec": round(time.perf_counter() - t0, 2),
        },
        "rainfall": rainfall_summary(refresh),
        "plots": plots,
        "drainage_corridor": drainage_corridor,
    }
    if write:
        C.write_json(OUTPUT, output)
    output["_grids"] = {"twi": twi_grid, "slope_deg": beta}  # for the risk engine; not written
    return output


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="ignore data/cache and re-download")
    out = run(refresh=ap.parse_args().refresh)
    rain = out["rainfall"]
    print(f"DEM: {out['provenance']['dem']['data_mode']}  bbox TWI p5/p50/p95={out['provenance']['bbox_twi_range']}  "
          f"t={out['provenance']['processing_time_sec']}s")
    print(f"Rain ({rain['data_mode']}): R={rain['r_total_mm']} mm  S_Rain={rain['s_rain']}  "
          f"peak {rain.get('peak_day')}={rain.get('peak_day_mm')} mm")
    for p in out["plots"]:
        print(f"  {p['plot_id']}: TWI={p['twi_value']} (p90 {p['twi_p90']})  S_TWI={p['s_twi']}  "
              f"slope={p['mean_slope_deg']}°  z={p['mean_elevation_m']} m  maxNup={p['max_upslope_cells']}")
    corr = out["drainage_corridor"]["features"][0]
    print(f"Corridor: {len(corr['geometry']['coordinates'])} vertices, {corr['properties']['length_m']} m, "
          f"max N_up={corr['properties']['max_upslope_cells']}")
    print(f"wrote {OUTPUT.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
