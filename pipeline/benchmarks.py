"""Benchmarks for every algorithm in SakaSAR: accuracy/skill and speed, from the project's own outputs.

Writes data/region/benchmarks.json (shown in the dashboard's Data & method frame) and docs/BENCHMARKS.md.
Browser timings are merged from data/region/benchmarks_browser.json when present (tools/bench_browser.py).

Run: python -m pipeline.benchmarks
"""
from __future__ import annotations

import json
import math
import platform
import time

import numpy as np

from . import common as C

R = C.ROOT / "data" / "region"


def load(p):
    return json.loads(p.read_text(encoding="utf-8"))


def km(a, b):
    r = math.pi / 180
    h = math.sin((b[1] - a[1]) * r / 2) ** 2 + math.cos(a[1] * r) * math.cos(b[1] * r) * math.sin((b[0] - a[0]) * r / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def timed(fn, *a, repeat=1):
    best = float("inf")
    out = None
    for _ in range(repeat):
        t = time.perf_counter(); out = fn(*a); best = min(best, time.perf_counter() - t)
    return out, best


def main():
    mock, tl, summ, ro, so = load(C.ROOT / "mock-data.json"), load(R / "bicol_timeline.json"), load(R / "bicol_summary.json"), load(R / "bicol_runoff.json"), load(C.DATA_DIR / "soil_outlook.json")
    pv = mock["provenance"]
    B = {"built": time.strftime("%Y-%m-%d %H:%M"), "machine": f"{platform.system()} {platform.release()}, Python {platform.python_version()}, {platform.processor() or 'CPU'}"}

    # 1. Field Drowning Risk, 30 m pilot
    B["field_risk"] = {
        "independent_hit_rate": pv.get("sar_hit_rate_terrain_only"),
        "plot_level_hit_rate": pv.get("sar_hit_rate_plots"),
        "full_model_hit_rate_circular": pv.get("sar_hit_rate_full_model"),
        "observed_flood_ha": pv.get("observed_flood_area_ha"), "flooded_farmland_ha": pv.get("flooded_farmland_ha"),
        "class_shares": {k: pv["pilot_area_class_shares"][k] for k in ("high_share", "watch_share", "low_share")},
        "flood_threshold_db": pv.get("sar_flood_threshold_db"), "pre_event_change_db": pv.get("pre_event_change_db"),
    }

    # 2. Bicol runoff & ponding (terrain + rain, 200 m)
    v = ro["validation"]
    B["runoff"] = {**{k: v[k] for k in ("flooded_pixels_checked", "share_rated_high", "farmland_share_high", "land_share_high")},
                   "lift_over_farmland": round(v["share_rated_high"] / v["farmland_share_high"], 2),
                   "lift_over_land": round(v["share_rated_high"] / v["land_share_high"], 2), "streams": ro["streams"],
                   "largest_catchment_km2": ro.get("largest_catchment_km2"), "bicol_river_basin_published_km2": ro.get("bicol_river_basin_published_km2")}

    # 3. Soil forecast (LSTM) at the pilot cell
    m = so["metrics"]
    B["forecast"] = {
        "model": so["model"]["type"], "split": m["split"], "samples": {k: m[f"{k}_samples"] for k in ("train", "val", "test")},
        "epochs": m["epochs"], "training_time_sec": so["training_time_sec"],
        "root_zone": {k: m["GWETROOT"][k] for k in m["GWETROOT"]},
        "surface": {k: m["GWETTOP"][k] for k in m["GWETTOP"]},
        "kristine_hindcasts": [{"label": h["label"], "issued": h["issued"], "days_pred": h["days_waterlogged_pred"], "days_actual": h["days_waterlogged_actual"], "mae_root": h["mean_abs_error_root"]} for h in so["hindcasts"]],
    }

    # 4. Regional forecast hindcast, every NASA POWER cell in Bicol (issued 3 Nov 2024)
    cells = [c for c in tl["lstm_hindcast"]["cells"] if c]
    err = [abs(c["days_pred"] - c["days_actual"]) for c in cells]
    mae_val = [abs(p - a) for c in cells for p, a in zip(c["pred"], c["actual"]) if a is not None]
    B["forecast_regional"] = {"cells": len(cells), "within_1_day": sum(e <= 1 for e in err), "exact": sum(e == 0 for e in err),
                              "mae_waterlogged_days": round(float(np.mean(err)), 2), "mae_root_zone": round(float(np.mean(mae_val)), 4)}

    # 5. Rain interpolation: leave-one-out on the 0.5° NASA POWER grid, 14–26 Oct daily rain
    lons = sorted({c["lon"] for c in tl["cells"]}); lats = sorted({c["lat"] for c in tl["cells"]})
    idx = {(c["lon"], c["lat"]): i for i, c in enumerate(tl["cells"])}
    days = [i for i, d in enumerate(tl["days"]) if "2024-10-14" <= d <= "2024-10-26"]
    e_bil, e_nn, n = [], [], 0
    for yi in range(1, len(lats) - 1):
        for xi in range(1, len(lons) - 1):
            me = idx[(lons[xi], lats[yi])]
            nb = {k: idx[(lons[xi + dx], lats[yi + dy])] for k, (dx, dy) in {"w": (-1, 0), "e": (1, 0), "s": (0, -1), "n": (0, 1)}.items()}
            for d in days:
                val = tl["rain_mm"][me][d]
                ns = {k: tl["rain_mm"][j][d] for k, j in nb.items()}
                if val is None or any(x is None for x in ns.values()):
                    continue
                bil = 0.5 * ((ns["w"] + ns["e"]) / 2) + 0.5 * ((ns["s"] + ns["n"]) / 2)  # bilinear at the hidden centre
                nn = (ns["s"] + ns["n"]) / 2  # nearest neighbours: 0.5° in latitude vs 0.625° in longitude
                e_bil.append(abs(bil - val)); e_nn.append(abs(nn - val)); n += 1
    B["rain_interpolation"] = {"hidden_cells": (len(lats) - 2) * (len(lons) - 2), "cell_days": n,
                               "mae_bilinear_mm": round(float(np.mean(e_bil)), 1), "mae_nearest_mm": round(float(np.mean(e_nn)), 1),
                               "mean_daily_rain_mm": round(float(np.mean([tl["rain_mm"][i][d] or 0 for i in range(len(tl["cells"])) for d in days])), 1)}

    # 6. Flood mapping (Sentinel-1, Bicol 100 m)
    B["flood_mapping"] = {"orbits": summ["orbits"], "radar_coverage": summ["radar_coverage"], "flooded_farmland_ha": summ["flooded_farmland_ha"],
                          "farmland_ha": summ["farmland_ha"], "municipalities": summ["municipalities"], "processing_time_sec": summ.get("processing_time_sec")}

    # 7. Storm geometry: closest pass to Naga, nearest 6-hourly fix vs the track line
    naga = (123.1948, 13.6218); st = tl["storm"]
    fix = min(km((p["lon"], p["lat"]), naga) for p in st)
    best = float("inf")
    k = math.cos(math.radians(naga[1])) * 111.32
    for a, b in zip(st, st[1:]):
        ax, ay, bx, by = (a["lon"] - naga[0]) * k, (a["lat"] - naga[1]) * 110.57, (b["lon"] - naga[0]) * k, (b["lat"] - naga[1]) * 110.57
        dx, dy = bx - ax, by - ay; f = max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, km((a["lon"] + (b["lon"] - a["lon"]) * f, a["lat"] + (b["lat"] - a["lat"]) * f), naga))
    B["storm_geometry"] = {"nearest_fix_km": round(fix, 1), "track_line_km": round(best, 1), "fixes": len(st)}

    # 8. Speed: hydrology at Bicol scale, risk engine from cache, forecast inference
    from .terrain_rain import d8_receivers, flow_accumulation, priority_flood
    dem = np.load(C.ROOT / "data" / "cache_region" / "nasadem.npy")
    h, w = (dem.shape[0] // 2) * 2, (dem.shape[1] // 2) * 2
    d2 = dem[:h, :w].reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    filled, t_pf = timed(priority_flood, np.nan_to_num(d2, nan=0.0))
    rec, t_d8 = timed(d8_receivers, filled)
    _, t_acc = timed(flow_accumulation, filled, rec)
    speed = {"hydrology_cells": int(d2.size), "priority_flood_sec": round(t_pf, 2), "d8_sec": round(t_d8, 2), "flow_accumulation_sec": round(t_acc, 2),
             "risk_engine_rebuild": pv.get("processing_time"), "bicol_flood_screening_sec": summ.get("processing_time_sec")}
    try:
        import torch
        from . import soil_lstm as L
        ck = torch.load(L.MODEL_PATH, weights_only=False)
        model = L.make_model(ck["n_features"]); model.load_state_dict(ck["state_dict"]); model.eval()
        x = torch.randn(35, L.PAST + L.AHEAD, ck["n_features"])
        with torch.no_grad():
            model(x); _, t_inf = timed(lambda: model(x), repeat=20)
        speed["forecast_inference_35_cells_ms"] = round(t_inf * 1000, 2)
        speed["forecast_parameters"] = int(sum(p.numel() for p in model.parameters()))
    except Exception as exc:  # torch optional
        speed["forecast_inference_note"] = f"skipped: {type(exc).__name__}"
    B["speed"] = speed
    bp = R / "benchmarks_browser.json"
    if bp.exists():
        B["browser"] = load(bp)

    (R / "benchmarks.json").write_text(json.dumps(B, ensure_ascii=False, indent=1), encoding="utf-8")
    write_md(B)
    print(json.dumps({k: B[k] for k in ("field_risk", "runoff", "forecast_regional", "rain_interpolation", "storm_geometry", "speed")}, ensure_ascii=False))


def pct(x):
    return f"{x * 100:.0f}%" if isinstance(x, (int, float)) else str(x)


def write_md(B):
    f, fo, fr, ri, ru = B["field_risk"], B["forecast"], B["forecast_regional"], B["rain_interpolation"], B["runoff"]
    root, top = fo["root_zone"], fo["surface"]
    days_tbl = "\n".join(f"| +{i + 1} | {a:.4f} | {b:.4f} | {c:.4f} |" for i, (a, b, c) in enumerate(zip(root["rmse_lstm_by_day"], root["rmse_persistence_by_day"], root["rmse_ridge_same_inputs_by_day"])))
    hind = "\n".join(f"| {h['label']} | {h['days_pred']} of 7 | {h['days_actual']} of 7 | {h['mae_root']} |" for h in fo["kristine_hindcasts"])
    sp = B["speed"]
    br = B.get("browser")
    md = f"""# SakaSAR benchmarks

Generated by `python -m pipeline.benchmarks` on {B['built']} ({B['machine']}). Every number below is computed from the
project's own outputs; rerun the command after changing a pipeline. Honest reading notes are given with each table.

## 1. Field Drowning Risk (30 m pilot, Minalabac, Sentinel-1 2 Nov 2024)

| Check | Result | How to read it |
|---|---|---|
| Independent hit rate (terrain + rain only) | **{f['independent_hit_rate']}** | Share of radar-flooded farmland cells the model had already rated high without seeing the radar. This is the headline. |
| Plot-level hit rate | {f['plot_level_hit_rate']} | Same test with whole-plot classes (coarser). |
| Full-model hit rate | {f['full_model_hit_rate_circular']} | **Circular**: ΔVV is in both the score and the flood mask. Consistency check only, never a headline. |
| Observed flood / flooded farmland | {f['observed_flood_ha']} ha / {f['flooded_farmland_ha']} ha | Sentinel-1 flood mask, Otsu-bounded threshold {f['flood_threshold_db']} dB. |
| Pre-event change (dry-season noise) | {f['pre_event_change_db']} dB | ΔVV between baseline and 9 Oct; small means the 2 Nov change is the storm, not noise. |
| Area by class | high {pct(f['class_shares']['high_share'])}, watch {pct(f['class_shares']['watch_share'])}, low {pct(f['class_shares']['low_share'])} | Pilot grid. |

## 2. Runoff & ponding risk, all of Bicol (terrain + rain, 200 m)

| Check | Result |
|---|---|
| Radar-flooded farmland pixels checked | {ru['flooded_pixels_checked']:,} |
| Share of them rated high | **{pct(ru['share_rated_high'])}** |
| Baseline: all farmland rated high | {pct(ru['farmland_share_high'])} (lift ×{ru['lift_over_farmland']}) |
| Baseline: all land rated high | {pct(ru['land_share_high'])} (lift ×{ru['lift_over_land']}) |
| Drainage lines (≥ 10 km² upstream) | {ru['streams']} |
| Largest catchment in the 200 m DEM | {ru.get('largest_catchment_km2')} km² vs about {ru.get('bicol_river_basin_published_km2')} km² published for the Bicol River basin |

Reading: the model never sees the radar. The fair comparison is against all farmland, because farmland is low-lying by
nature; a ×{ru['lift_over_farmland']} lift is a real but modest signal. The drainage network recovers about
{round(100 * ru['largest_catchment_km2'] / ru['bicol_river_basin_published_km2']) if ru.get('largest_catchment_km2') else 'n/a'}% of the Bicol River basin: at 200 m, flat floodplains and lake surfaces (Bato, Baao, Buhi)
send part of the upper basin elsewhere, so watershed tracing is a screening tool, not a basin map.

## 3. Soil forecast (root-zone wetness, 7 days ahead, pilot cell)

Model: {fo['model']}. Split by issue date: train {fo['split']['train']}, validation {fo['split']['val']}, test {fo['split']['test']}
({fo['samples']['train']:,} / {fo['samples']['val']:,} / {fo['samples']['test']:,} samples). {fo['epochs']} epochs, {fo['training_time_sec']} s training.

| Lead day | RMSE model | RMSE persistence | RMSE ridge (same inputs) |
|---|---|---|---|
{days_tbl}

| Skill (test years) | Root zone | Surface |
|---|---|---|
| vs persistence, all weeks | **{root['skill_vs_persistence_pct']}%** | {top['skill_vs_persistence_pct']}% |
| vs ridge regression, all weeks | {root['skill_vs_ridge_pct']}% | {top['skill_vs_ridge_pct']}% |
| vs persistence, wet weeks ({root['wet_weeks']}) | {root['skill_vs_persistence_wet_weeks_pct']}% | {top['skill_vs_persistence_wet_weeks_pct']}% |
| vs ridge, wet weeks | {root['skill_vs_ridge_wet_weeks_pct']}% | {top['skill_vs_ridge_wet_weeks_pct']}% |

Reading: ridge regression is slightly better on day +1 (persistence of the starting value dominates); the model wins from
day +2 and by a wide margin in wet weeks, which are the weeks that matter for drowning risk.

Kristine hindcasts (pilot cell):

| Run | Forecast waterlogged | Actual | MAE root zone |
|---|---|---|---|
{hind}

## 4. Soil forecast, every NASA POWER cell in Bicol (issued 3 Nov 2024)

| Check | Result |
|---|---|
| Cells | {fr['cells']} |
| Waterlogged days right within 1 day | **{fr['within_1_day']} of {fr['cells']}** |
| Exactly right | {fr['exact']} of {fr['cells']} |
| MAE, waterlogged days | {fr['mae_waterlogged_days']} days |
| MAE, root-zone wetness | {fr['mae_root_zone']} |

## 5. Rain interpolation (bilinear on the 0.5° NASA POWER grid)

Leave-one-out: each interior cell is hidden and estimated from its neighbours, for every day 14–26 Oct 2024
({ri['hidden_cells']} cells, {ri['cell_days']} cell-days, mean daily rain {ri['mean_daily_rain_mm']} mm).

| Method | MAE |
|---|---|
| Bilinear (used) | **{ri['mae_bilinear_mm']} mm** |
| Nearest neighbours | {ri['mae_nearest_mm']} mm |

Reading: storm rain varies a lot over 50 km, so any interpolation of this grid is approximate; the dashboard labels the
heatmaps "about 50 km grid".

## 6. Flood mapping, all of Bicol (Sentinel-1 RTC, 100 m)

Radar coverage of farmland {pct(B['flood_mapping']['radar_coverage'])}; {B['flood_mapping']['flooded_farmland_ha']:,} ha flooded of
{B['flood_mapping']['farmland_ha']:,} ha farmland in {B['flood_mapping']['municipalities']} municipalities. Thresholds per orbit:
{"; ".join(f"orbit {k}: τ {o['tau']} dB (Otsu {o['otsu']} dB), after {o['after']}" for k, o in B['flood_mapping']['orbits'].items())}.
No field survey exists for Kristine in Bicol, so this map has no independent accuracy score; it is the reference the
terrain + rain models are checked against.

## 7. Storm geometry

Closest pass of Kristine to Naga City: {B['storm_geometry']['nearest_fix_km']} km to the nearest 6-hourly EONET fix,
**{B['storm_geometry']['track_line_km']} km** to the track line between fixes (used). {B['storm_geometry']['fixes']} fixes.

## 8. Speed

| Step | Time |
|---|---|
| Priority-flood depression filling, {sp['hydrology_cells']:,} cells (Bicol, 200 m) | {sp['priority_flood_sec']} s |
| D8 flow directions | {sp['d8_sec']} s |
| Flow accumulation | {sp['flow_accumulation_sec']} s |
| Risk engine rebuild from cache (30 m pilot) | {sp['risk_engine_rebuild']} |
| Bicol flood screening, 114 towns, from downloads | {round(sp['bicol_flood_screening_sec'] / 60) if sp.get('bicol_flood_screening_sec') else 'n/a'} min |
| Forecast inference, 35 cells | {sp.get('forecast_inference_35_cells_ms', 'n/a')} ms ({sp.get('forecast_parameters', 'n/a'):,} parameters) |
"""
    if br:
        md += "\n## 9. In the browser\n\n| Step | Time |\n|---|---|\n" + "\n".join(f"| {k} | {v} |" for k, v in br.items() if k != "machine") + f"\n\nMeasured with {br.get('machine', 'Playwright')}.\n"
    md += "\n## Algorithms covered\n\nFlood mask (Otsu-bounded threshold + ΔVV + slope + WorldCover), Lee speckle filter, priority-flood filling, D8 flow, flow accumulation, Topographic Wetness Index, Field Drowning Risk score, runoff & ponding score, bilinear interpolation, soil-wetness forecast (LSTM), closest-pass geometry, rotation rules (rule-based, no accuracy score; to verify with the Municipal Agriculture Office), SakaSAR AI (rule-based answers from the datasets; no generative model).\n"
    (C.ROOT / "docs" / "BENCHMARKS.md").write_text(md, encoding="utf-8")


if __name__ == "__main__":
    main()
