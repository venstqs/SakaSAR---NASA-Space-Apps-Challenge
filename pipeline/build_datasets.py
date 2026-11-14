"""Build SakaSAR's own reusable datasets in data/datasets/ (see data/datasets/README.md).

  daily_weather_soil_2001_2026.csv  NASA POWER daily weather + root-zone/surface soil wetness at the
                                    pilot centre: the LSTM training set (one row per day)
  plot_features.csv                 one row per sample plot: radar, terrain, rain, soil, risk, rotation fit
  pixels_30m_pilot.csv              one row per 30 m cell in the pilot strip: radar change, terrain,
                                    land cover, observed-flood label and risk; a labelled table for
                                    training or testing future flood models
  plot_recommendations.csv          the farmer recommendation timeline, one row per plot × step

Run after the pipeline:  python -m pipeline.build_datasets
"""
from __future__ import annotations

import csv
import json

import numpy as np

from . import common as C
from . import risk_engine as R
from . import sar_moisture as S
from . import soil_lstm as L
from . import terrain_rain as T

OUT_DIR = C.DATA_DIR / "datasets"


def _write(name: str, header: list[str], rows: list[list]) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / name, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return len(rows)


def daily_weather_soil() -> int:
    days, data = L.load_power()
    cols = ["PRECTOTCORR", "T2M_MAX", "T2M_MIN", "RH2M", "ALLSKY_SFC_SW_DWN", "GWETROOT", "GWETTOP"]
    rows = [[d.isoformat()] + [round(float(data[c][i]), 3) for c in cols] for i, d in enumerate(days)]
    return _write("daily_weather_soil_2001_2026.csv",
                  ["date", "rain_mm", "tmax_c", "tmin_c", "rh_pct", "solar_mj_m2", "gwetroot", "gwettop"], rows)


def plot_tables(mock: dict) -> tuple[int, int]:
    feats, recs = [], []
    for f in mock["plots"]["features"]:
        p = f["properties"]
        soil = p.get("soil_0_30cm") or {}
        fit = p.get("rotation_fit") or {}
        feats.append([
            p["plot_id"], p["barangay"], p["current_crop"], p["hectares"], p["households"],
            p["sar_wetness_change_db"], p.get("pre_event_change_db"), p.get("vh_wetness_change_db"),
            p.get("flooded_pixel_fraction"), p["twi_value"], p.get("mean_slope_deg"), p.get("mean_elevation_m"),
            p.get("cropland_fraction"), soil.get("sand_pct"), soil.get("silt_pct"), soil.get("clay_pct"),
            soil.get("soc_g_per_kg"), soil.get("texture"), p["s_sar"], p["s_twi"], p["s_rain"],
            p["risk_score"], p["risk_class"],
            fit.get("legume", {}).get("fit"), fit.get("biotillage", {}).get("fit"), fit.get("shortcycle", {}).get("fit"),
        ])
        for i, r in enumerate(p.get("recommendations", []), 1):
            recs.append([p["plot_id"], i, r["when"], r["action"], r["why"], "; ".join(r["sources"])])
    n1 = _write("plot_features.csv", [
        "plot_id", "barangay", "current_crop", "hectares_placeholder", "households_placeholder",
        "dvv_db_2nov", "dvv_db_9oct", "dvh_db_2nov", "flooded_fraction", "twi", "slope_deg", "elevation_m",
        "cropland_fraction", "sand_pct", "silt_pct", "clay_pct", "soc_g_per_kg", "texture",
        "s_sar", "s_twi", "s_rain", "risk_score", "risk_class", "fit_legume", "fit_biotillage", "fit_shortcycle"],
        feats)
    n2 = _write("plot_recommendations.csv", ["plot_id", "step", "when", "action", "why", "sources"], recs)
    return n1, n2


def pixel_table(rain_s: float) -> int:
    sar = S.run(write=False)
    terr = T.run(write=False)
    g_sar, g_ter = sar["_grids"], terr["_grids"]
    dem, _ = C.load_dem()
    grids = R.risk_grids(g_sar["d_vv_db"], g_ter["twi"], rain_s)
    lc = g_sar["landcover"]
    cls = R.exclude_non_farmland(grids["class"], lc)
    tcls = R.exclude_non_farmland(grids["terrain_class"], lc)
    names = {v: k for k, v in R.CLASS_CODES.items()}
    bbox = C.plot_mask(C.bbox_polygon_wgs())
    rows = []
    for r, c in zip(*np.where(bbox)):
        x, y = C.GRID.xy(int(r), int(c))
        lon, lat = C.TO_WGS.transform(x, y)
        dvv = g_sar["d_vv_db"][r, c]
        rows.append([
            round(lon, 6), round(lat, 6), round(x, 1), round(y, 1),
            None if not np.isfinite(dvv) else round(float(dvv), 2),
            round(float(g_ter["twi"][r, c]), 2), round(float(g_ter["slope_deg"][r, c]), 2), round(float(dem[r, c]), 1),
            int(lc[r, c]) if lc is not None else None,
            C.WC_NAMES.get(int(lc[r, c]), "") if lc is not None else "",
            int(g_sar["flood"][r, c]),
            None if not np.isfinite(grids["score"][r, c]) else round(float(grids["score"][r, c]), 1),
            names[int(cls[r, c])], round(float(grids["terrain_score"][r, c]), 1), names[int(tcls[r, c])],
        ])
    return _write("pixels_30m_pilot.csv", [
        "lon", "lat", "x_utm51n", "y_utm51n", "dvv_db", "twi", "slope_deg", "elevation_m",
        "worldcover_code", "worldcover_class", "observed_flood", "risk_score", "risk_class",
        "terrain_only_score", "terrain_only_class"], rows)


def main() -> None:
    mock = json.loads((C.ROOT / "mock-data.json").read_text(encoding="utf-8"))
    n_daily = daily_weather_soil()
    n_plots, n_recs = plot_tables(mock)
    n_pix = pixel_table(mock["provenance"]["rainfall"]["s_rain"])
    print(f"daily_weather_soil_2001_2026.csv: {n_daily} rows")
    print(f"plot_features.csv: {n_plots} rows · plot_recommendations.csv: {n_recs} rows")
    print(f"pixels_30m_pilot.csv: {n_pix} rows")
    print(f"wrote {OUT_DIR.relative_to(C.ROOT)}/")


if __name__ == "__main__":
    main()
