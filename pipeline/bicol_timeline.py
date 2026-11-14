"""Bicol Region event timeline — the data behind the dashboard's day-by-day simulation.

Builds data/region/bicol_timeline.json from NASA services (no login needed):
  * NASA EONET          Typhoon Kristine (Trami) track: 6-hourly position and wind
  * NASA POWER regional daily rain (PRECTOTCORR) and root-zone soil wetness (GWETROOT) on the
                        ~0.5° grid over Bicol, 10 Oct – 8 Nov 2024
  * SakaSAR LSTM        run on every grid cell:
                          - hindcast issued 3 Nov 2024 (day after the radar pass) vs what happened
                          - "Kristine again": each cell's own Kristine-week rain applied to today's soil
The dashboard also streams NASA GIBS imagery (MODIS/VIIRS true colour, IMERG rain rate, SMAP) by date.

Run:  python -m pipeline.bicol_timeline        (needs torch only for the LSTM part)
"""
from __future__ import annotations

import json
import time
from datetime import date, timedelta

import numpy as np
import requests

from . import common as C

OUT = C.ROOT / "data" / "region" / "bicol_timeline.json"
BBOX = {"latitude-min": 11.5, "latitude-max": 14.5, "longitude-min": 122.0, "longitude-max": 125.0}
EVENT_START, EVENT_END = date(2024, 10, 10), date(2024, 11, 8)
POWER_REGIONAL = "https://power.larc.nasa.gov/api/temporal/daily/regional"
LSTM_PARAMS = ["PRECTOTCORR", "T2M_MAX", "T2M_MIN", "RH2M", "ALLSKY_SFC_SW_DWN", "GWETROOT", "GWETTOP"]
H = {"User-Agent": "sakasar-pipeline/0.1"}
WATERLOGGED = 0.97


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def power_regional(param: str, start: date, end: date) -> dict:
    """{(lon, lat): {iso_date: value}} for one parameter."""
    r = requests.get(POWER_REGIONAL, params={**BBOX, "parameters": param, "community": "AG",
                     "start": start.strftime("%Y%m%d"), "end": end.strftime("%Y%m%d"), "format": "JSON"},
                     headers=H, timeout=300)
    r.raise_for_status()
    out = {}
    for f in r.json()["features"]:
        lon, lat = f["geometry"]["coordinates"][:2]
        vals = f["properties"]["parameter"][param]
        out[(round(lon, 3), round(lat, 3))] = {f"{k[:4]}-{k[4:6]}-{k[6:]}": (None if v is None or v <= -998 else v) for k, v in vals.items()}
    return out


def on_grid(series: dict, cells: list) -> dict:
    """Re-key a {(lon, lat): ...} dict onto `cells` by nearest point (POWER variables use different grids)."""
    keys = list(series)
    out = {}
    for c in cells:
        k = min(keys, key=lambda q: (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2)
        out[c] = series[k]
    return out


def storm_track() -> list[dict]:
    r = requests.get("https://eonet.gsfc.nasa.gov/api/v3/events", headers=H, timeout=90,
                     params={"category": "severeStorms", "start": "2024-10-15", "end": "2024-11-05", "status": "all"})
    r.raise_for_status()
    ev = next((e for e in r.json()["events"] if "trami" in e["title"].lower()), None)
    if not ev:
        return []
    return [{"t": g["date"], "lon": g["coordinates"][0], "lat": g["coordinates"][1],
             "wind_kts": g.get("magnitudeValue")} for g in ev["geometry"]]


def run_lstm(cells, series_by_param, issue: date, future_rain=None):
    """Run the trained LSTM for every cell. series_by_param[param][cell][iso] covers issue-30 … issue+6."""
    import torch

    from . import soil_lstm as L

    ck = torch.load(L.MODEL_PATH, weights_only=False)
    model = L.make_model(ck["n_features"])
    model.load_state_dict(ck["state_dict"])
    model.eval()
    norm = (ck["fmu"], ck["fsd"], ck["smu"], ck["ssd"])
    days = [issue + timedelta(days=i) for i in range(-L.PAST, L.AHEAD)]
    out = {}
    for cell in cells:
        data = {}
        ok = True
        for p in LSTM_PARAMS:
            vals = [series_by_param[p][cell].get(d.isoformat()) for d in days]
            if p in ("GWETROOT", "GWETTOP"):
                vals = vals[:L.PAST] + [0.0] * L.AHEAD  # future soil is hidden from the model
            if any(v is None for v in vals):
                ok = False
                break
            data[p] = np.array(vals, dtype="float64")
        if not ok:
            continue
        if future_rain is not None:
            data["PRECTOTCORR"][L.PAST:] = future_rain[cell]
        forc = L.forcing_matrix(days, data)
        soil = np.stack([data[t] for t in L.TARGETS], axis=1)
        pred = L.predict(model, forc, soil, L.PAST, norm)[:, 0]
        out[cell] = [round(float(v), 3) for v in pred]
    return out


def main():
    t0 = time.perf_counter()
    log("EONET storm track")
    track = storm_track()
    log(f"  {len(track)} positions")

    log("POWER regional rain + soil wetness for the event")
    rain = power_regional("PRECTOTCORR", EVENT_START, EVENT_END)
    gwet = power_regional("GWETROOT", EVENT_START, EVENT_END)
    cells = sorted(rain)
    gwet = on_grid(gwet, cells)
    days = [(EVENT_START + timedelta(days=i)).isoformat() for i in range((EVENT_END - EVENT_START).days + 1)]

    result = {
        "built": time.strftime("%Y-%m-%d"),
        "days": days,
        "cells": [{"lon": c[0], "lat": c[1]} for c in cells],
        "rain_mm": [[rain[c].get(d) for d in days] for c in cells],
        "rootzone": [[gwet[c].get(d) for d in days] for c in cells],
        "storm": track,
        "passes": [
            {"date": "2024-10-09", "label": "Sentinel-1 pass before the storm", "used": True},
            {"date": "2024-10-21", "label": "Sentinel-1 pass during the storm: skipped, wind hides floodwater", "used": False},
            {"date": "2024-10-28", "label": "Sentinel-1 pass, east of the region (orbit 61)", "used": True},
            {"date": "2024-11-02", "label": "Sentinel-1 pass after the storm: flood map", "used": True},
        ],
        "sources": ["NASA EONET (storm track)", "NASA POWER regional daily (PRECTOTCORR, GWETROOT)",
                    "SakaSAR LSTM (trained on NASA POWER 2001–2018)", "NASA GIBS imagery (MODIS, VIIRS, IMERG, SMAP)"],
    }

    try:
        issue = date(2024, 11, 3)
        log("POWER regional inputs for the LSTM hindcast (issued 3 Nov 2024)")
        ser = {p: on_grid(power_regional(p, issue - timedelta(days=30), issue + timedelta(days=6)), cells) for p in LSTM_PARAMS}
        pred = run_lstm(cells, ser, issue)
        hind = []
        for c in cells:
            if c not in pred:
                hind.append(None)
                continue
            actual = [ser["GWETROOT"][c].get((issue + timedelta(days=i)).isoformat()) for i in range(7)]
            hind.append({"pred": pred[c], "actual": actual,
                         "days_pred": sum(v >= WATERLOGGED for v in pred[c]),
                         "days_actual": sum((v or 0) >= WATERLOGGED for v in actual)})
        result["lstm_hindcast"] = {"issued": issue.isoformat(), "cells": hind}

        # today's soil + each cell's own Kristine week of rain
        end = date.today() - timedelta(days=2)
        log(f"POWER regional inputs for 'Kristine again' (last 45 days to {end})")
        cur = {p: on_grid(power_regional(p, end - timedelta(days=45), end), cells) for p in LSTM_PARAMS}
        latest = end
        while latest > end - timedelta(days=14):  # newest day complete for every variable and cell
            if all(cur[p][c].get(latest.isoformat()) is not None for p in LSTM_PARAMS for c in cells):
                break
            latest -= timedelta(days=1)
        log(f"  soil as of {latest}")
        issue2 = latest + timedelta(days=1)
        for p in LSTM_PARAMS:  # pad the future week with climatology-free placeholders (weather other than rain = last value)
            for c in cells:
                last = cur[p][c].get(latest.isoformat())
                for i in range(7):
                    cur[p][c][(issue2 + timedelta(days=i)).isoformat()] = last
        k_rain = {c: np.array([rain[c].get((date(2024, 10, 21) + timedelta(days=i)).isoformat()) or 0.0 for i in range(7)]) for c in cells}
        pred2 = run_lstm(cells, cur, issue2, future_rain=k_rain)
        result["lstm_kristine_again"] = {
            "soil_as_of": latest.isoformat(),
            "cells": [None if c not in pred2 else {
                "today": cur["GWETROOT"][c].get(latest.isoformat()), "pred": pred2[c],
                "rain_mm": round(float(k_rain[c].sum()), 1), "days_waterlogged": sum(v >= WATERLOGGED for v in pred2[c])}
                for c in cells],
        }
    except Exception as exc:  # torch missing or API hiccup: the timeline still works
        log(f"  LSTM step skipped: {type(exc).__name__}: {exc}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    log(f"wrote {OUT.relative_to(C.ROOT)} ({OUT.stat().st_size // 1024} KB) in {time.perf_counter() - t0:.0f} s")


if __name__ == "__main__":
    main()
