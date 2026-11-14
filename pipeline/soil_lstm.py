"""LSTM soil-saturation model — how long will the root zone stay waterlogged?

Learns how NASA POWER root-zone and surface soil wetness (GWETROOT, GWETTOP; MERRA-2 land model,
0 = dry, 1 = saturated) respond to rain and weather at the pilot site, from 2001–2026 daily data.

Sequence per sample (37 days):
  days −30 … −1  weather + observed soil wetness   (what the soil has been through)
  days  +1 … +7  weather only (rain forecast or scenario), soil wetness hidden
  → predicts GWETROOT and GWETTOP for days +1 … +7

Feeding the next week's rain is the standard rainfall–response LSTM setup in hydrology: the model
does not have to guess the weather, it learns the soil's memory of it. At inference the rain comes
from observations (hindcasts) or a scenario (dry / typical / Kristine-like).

Honest limits: the target is a NASA reanalysis product on a ~50 km cell, not a field sensor, so this
describes the regional root zone, not one paddy. Persistence ("same as today") is a strong baseline
here because the soil is near-saturated most of the year; metrics against it are reported.

Split by time (no leakage): train issue dates 2001–2018, validate 2019–2021, test 2022+
(test includes STS Kristine, Oct 2024 — never seen in training).

Run:  python -m pipeline.soil_lstm [--refresh]   (CPU, ~1–2 min)
Out:  models/soil_lstm.pt, data/soil_outlook.json
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import date, datetime, timedelta

import numpy as np
import requests

from . import common as C

POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
PARAMS = ["PRECTOTCORR", "T2M_MAX", "T2M_MIN", "RH2M", "ALLSKY_SFC_SW_DWN", "GWETROOT", "GWETTOP"]
TARGETS = ["GWETROOT", "GWETTOP"]
START = "20010101"
PAST, AHEAD = 30, 7
TRAIN_END, VAL_END = date(2018, 12, 31), date(2021, 12, 31)
SEED = 20241022
CACHE = C.CACHE_DIR / f"nasa_power_daily_2001_{C.CENTER[0]:.4f}_{C.CENTER[1]:.4f}.json"
MODEL_PATH = C.ROOT / "models" / "soil_lstm.pt"
OUTPUT = C.DATA_DIR / "soil_outlook.json"

# Root-zone saturation classes (fraction of saturation). Site context: 2001–2018 GWETROOT
# p5 ≈ 0.62, median ≈ 0.94 — the Bicol root zone is wet most of the year, so "waterlogged"
# means effectively full.
SATURATION_CLASSES = [
    (0.97, "waterlogged", "root zone effectively full; roots short of oxygen"),
    (0.90, "wet", "near field capacity; little room for more rain"),
    (0.70, "moist", "normal growing conditions"),
    (0.00, "dry", "below typical; watch for water stress"),
]


def saturation_class(v: float) -> str:
    for lo, name, _ in SATURATION_CLASSES:
        if v >= lo:
            return name
    return "dry"


# ----------------------------------------------------------------------------- data

def load_power(refresh: bool = False) -> tuple[list[date], dict[str, np.ndarray]]:
    if refresh or not CACHE.exists():
        end = (date.today() - timedelta(days=1)).strftime("%Y%m%d")
        r = requests.get(POWER_URL, params={
            "parameters": ",".join(PARAMS), "community": "AG", "longitude": C.CENTER[0],
            "latitude": C.CENTER[1], "start": START, "end": end, "format": "JSON",
        }, headers=C.HTTP_HEADERS, timeout=300)
        r.raise_for_status()
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(r.json()["properties"]["parameter"]), encoding="utf-8")
    raw = json.loads(CACHE.read_text(encoding="utf-8"))
    keys = sorted(raw[PARAMS[0]])
    data = {}
    for p in PARAMS:
        a = np.array([raw[p].get(k, -999) for k in keys], dtype="float64")
        a[a <= -998] = np.nan
        data[p] = a
    # trim trailing days still missing (POWER latency), then fill isolated gaps
    ok = np.all([np.isfinite(data[p]) for p in PARAMS], axis=0)
    last = int(np.where(ok)[0][-1]) + 1
    days = [datetime.strptime(k, "%Y%m%d").date() for k in keys[:last]]
    for p in PARAMS:
        a = data[p][:last]
        idx = np.arange(len(a))
        bad = ~np.isfinite(a)
        if bad.any():
            a[bad] = np.interp(idx[bad], idx[~bad], a[~bad])
        data[p] = a
    return days, data


def forcing_matrix(days: list[date], data: dict) -> np.ndarray:
    """Weather features per day: log rain, temps, humidity, solar, season (sin/cos)."""
    doy = np.array([d.timetuple().tm_yday for d in days])
    return np.stack([
        np.log1p(data["PRECTOTCORR"]), data["T2M_MAX"], data["T2M_MIN"], data["RH2M"],
        data["ALLSKY_SFC_SW_DWN"], np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25),
    ], axis=1)


def build_sequence(forc: np.ndarray, soil: np.ndarray, t: int, fmu, fsd, smu, ssd) -> np.ndarray:
    """37 x F input for an issue at index t (t = first forecast day). Soil is hidden for future days."""
    f = (forc[t - PAST:t + AHEAD] - fmu) / fsd
    s = np.zeros((PAST + AHEAD, soil.shape[1]))
    s[:PAST] = (soil[t - PAST:t] - smu) / ssd
    mask = np.zeros((PAST + AHEAD, 1))
    mask[:PAST] = 1.0
    return np.concatenate([f, s, mask], axis=1).astype("float32")


# ----------------------------------------------------------------------------- model

def make_model(n_features: int, hidden: int = 64):
    import torch.nn as nn

    class SoilLSTM(nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = nn.LSTM(n_features, hidden, batch_first=True)
            self.head = nn.Linear(hidden, len(TARGETS))

        def forward(self, x):
            h, _ = self.lstm(x)
            return self.head(h[:, PAST:, :])  # predictions for the 7 future days

    return SoilLSTM()


def train(refresh: bool = False) -> dict:
    import torch

    torch.manual_seed(SEED)
    np.random.seed(SEED)
    days, data = load_power(refresh)
    forc = forcing_matrix(days, data)
    soil = np.stack([data[t] for t in TARGETS], axis=1)
    idx = np.arange(PAST, len(days) - AHEAD + 1)
    issue = np.array([days[i] for i in idx])
    tr, va, te = idx[issue <= TRAIN_END], idx[(issue > TRAIN_END) & (issue <= VAL_END)], idx[issue > VAL_END]

    fmu, fsd = forc[:tr[-1]].mean(0), forc[:tr[-1]].std(0) + 1e-6
    smu, ssd = soil[:tr[-1]].mean(0), soil[:tr[-1]].std(0) + 1e-6

    def batch(ix):
        X = np.stack([build_sequence(forc, soil, t, fmu, fsd, smu, ssd) for t in ix])
        Y = np.stack([(soil[t:t + AHEAD] - smu) / ssd for t in ix]).astype("float32")
        return torch.from_numpy(X), torch.from_numpy(Y)

    Xtr, Ytr = batch(tr)
    Xva, Yva = batch(va)
    model = make_model(Xtr.shape[2])
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = torch.nn.MSELoss()
    best, best_state, patience, epochs_run = float("inf"), None, 0, 0
    for epoch in range(80):
        model.train()
        perm = torch.randperm(len(Xtr))
        for i in range(0, len(perm), 256):
            b = perm[i:i + 256]
            opt.zero_grad()
            loss = loss_fn(model(Xtr[b]), Ytr[b])
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            v = loss_fn(model(Xva), Yva).item()
        epochs_run = epoch + 1
        if v < best - 1e-5:
            best, patience = v, 0
            best_state = {k: t.clone() for k, t in model.state_dict().items()}
        else:
            patience += 1
            if patience >= 8:
                break
    model.load_state_dict(best_state)

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": best_state, "n_features": Xtr.shape[2], "fmu": fmu, "fsd": fsd,
                "smu": smu, "ssd": ssd, "targets": TARGETS, "past": PAST, "ahead": AHEAD}, MODEL_PATH)

    # Fair baseline: ridge regression on exactly the same inputs (flattened 37-day window)
    Xr = Xtr.reshape(len(Xtr), -1).numpy().astype("float64")
    Yr = Ytr.reshape(len(Ytr), -1).numpy().astype("float64")
    Xr1 = np.hstack([Xr, np.ones((len(Xr), 1))])
    ridge_w = np.linalg.solve(Xr1.T @ Xr1 + 1.0 * np.eye(Xr1.shape[1]), Xr1.T @ Yr)

    metrics = evaluate(model, forc, soil, data, te, fmu, fsd, smu, ssd, ridge_w)
    metrics.update({"train_samples": len(tr), "val_samples": len(va), "test_samples": len(te),
                    "epochs": epochs_run, "best_val_mse_normalised": round(best, 5),
                    "split": {"train": f"{days[tr[0]]}..{TRAIN_END}", "val": f"..{VAL_END}",
                              "test": f"{days[te[0]]}..{days[te[-1]]}"}})
    return {"days": days, "data": data, "forc": forc, "soil": soil, "model": model,
            "norm": (fmu, fsd, smu, ssd), "metrics": metrics}


def predict(model, forc, soil, t, norm) -> np.ndarray:
    import torch

    x = torch.from_numpy(build_sequence(forc, soil, t, *norm)[None])
    with torch.no_grad():
        y = model(x)[0].numpy()
    return np.clip(y * norm[3] + norm[2], 0.0, 1.0)  # (7, 2) in [0, 1]


def evaluate(model, forc, soil, data, te, fmu, fsd, smu, ssd, ridge_w) -> dict:
    import torch

    Xn = np.stack([build_sequence(forc, soil, t, fmu, fsd, smu, ssd) for t in te])
    with torch.no_grad():
        pred = np.clip(model(torch.from_numpy(Xn)).numpy() * ssd + smu, 0, 1)
    Xf = np.hstack([Xn.reshape(len(Xn), -1).astype("float64"), np.ones((len(Xn), 1))])
    ridge = np.clip((Xf @ ridge_w).reshape(len(te), AHEAD, len(TARGETS)) * ssd + smu, 0, 1)
    truth = np.stack([soil[t:t + AHEAD] for t in te])
    persist = np.repeat(np.stack([soil[t - 1] for t in te])[:, None, :], AHEAD, axis=1)
    rain7 = np.array([data["PRECTOTCORR"][t:t + AHEAD].sum() for t in te])
    wet = rain7 >= 100  # weeks with ≥100 mm coming — when a forecast matters

    def rmse(a, b, m=None):
        d = (a - b) if m is None else (a[m] - b[m])
        return np.sqrt((d ** 2).mean(axis=0))  # per horizon, per target

    out = {}
    for j, name in enumerate(TARGETS):
        l_all, p_all = rmse(pred, truth)[:, j], rmse(persist, truth)[:, j]
        l_wet, p_wet = rmse(pred, truth, wet)[:, j], rmse(persist, truth, wet)[:, j]
        r_all, r_wet = rmse(ridge, truth)[:, j], rmse(ridge, truth, wet)[:, j]
        out[name] = {
            "rmse_lstm_by_day": [round(float(v), 4) for v in l_all],
            "rmse_persistence_by_day": [round(float(v), 4) for v in p_all],
            "rmse_ridge_same_inputs_by_day": [round(float(v), 4) for v in r_all],
            "skill_vs_persistence_pct": round(float(100 * (1 - l_all.mean() / p_all.mean())), 1),
            "skill_vs_ridge_pct": round(float(100 * (1 - l_all.mean() / r_all.mean())), 1),
            "skill_vs_ridge_wet_weeks_pct": round(float(100 * (1 - l_wet.mean() / r_wet.mean())), 1),
            "wet_weeks": int(wet.sum()),
            "rmse_lstm_wet_weeks": round(float(l_wet.mean()), 4),
            "rmse_persistence_wet_weeks": round(float(p_wet.mean()), 4),
            "skill_vs_persistence_wet_weeks_pct": round(float(100 * (1 - l_wet.mean() / p_wet.mean())), 1),
        }
    return out


# ----------------------------------------------------------------------------- outlooks

def _days_waterlogged(series) -> int:
    return int(sum(v >= SATURATION_CLASSES[0][0] for v in series))


def hindcast(res: dict, issue: date, label: str) -> dict:
    """Forecast issued the morning of `issue` using the rain that actually fell next — checkable."""
    days, forc, soil, model, norm = res["days"], res["forc"], res["soil"], res["model"], res["norm"]
    t = days.index(issue)
    p = predict(model, forc, soil, t, norm)
    rows = [{"date": str(days[t + k]), "rain_mm": round(float(res["data"]["PRECTOTCORR"][t + k]), 1),
             "gwetroot_pred": round(float(p[k, 0]), 3), "gwetroot_actual": round(float(soil[t + k, 0]), 3),
             "gwettop_pred": round(float(p[k, 1]), 3), "gwettop_actual": round(float(soil[t + k, 1]), 3),
             "class_pred": saturation_class(p[k, 0])} for k in range(AHEAD)]
    return {"label": label, "issued": str(issue), "root_zone_today": round(float(soil[t - 1, 0]), 3),
            "days_waterlogged_pred": _days_waterlogged(p[:, 0]),
            "days_waterlogged_actual": _days_waterlogged(soil[t:t + AHEAD, 0]),
            "mean_abs_error_root": round(float(np.abs(p[:, 0] - soil[t:t + AHEAD, 0]).mean()), 3),
            "days": rows}


def scenarios(res: dict) -> dict:
    """Outlook from the latest available day under three rain scenarios for the coming week."""
    days, data, model, norm = res["days"], res["data"], res["model"], res["norm"]
    n = len(days)
    last = days[-1]
    fut = [last + timedelta(days=k + 1) for k in range(AHEAD)]
    # climatological weather for the coming week (same calendar days, 2001–2018)
    clim = {}
    for p in PARAMS[:5]:
        clim[p] = np.array([np.median([data[p][i] for i, d in enumerate(days)
                                       if d.year <= 2018 and (d.month, d.day) == (f.month, f.day)])
                            for f in fut])
    k0 = days.index(date(2024, 10, 21))
    rain_cases = {
        "dry week (0 mm)": np.zeros(AHEAD),
        "typical week (climatology)": clim["PRECTOTCORR"],
        "Kristine-like week (Oct 21–27 2024 rain)": data["PRECTOTCORR"][k0:k0 + AHEAD],
    }
    out = {"issued_after": str(last), "root_zone_today": round(float(data["GWETROOT"][-1]), 3),
           "root_zone_class_today": saturation_class(data["GWETROOT"][-1]), "cases": []}
    for name, rain in rain_cases.items():
        ext = {p: np.concatenate([data[p], clim[p]]) for p in PARAMS[:5]}
        ext["PRECTOTCORR"] = np.concatenate([data["PRECTOTCORR"], rain])
        forc = forcing_matrix(days + fut, ext)
        soil = np.concatenate([res["soil"], np.zeros((AHEAD, len(TARGETS)))])
        p = predict(model, forc, soil, n, norm)
        out["cases"].append({
            "scenario": name, "rain_total_mm": round(float(rain.sum()), 1),
            "days_waterlogged": _days_waterlogged(p[:, 0]),
            "gwetroot_by_day": [round(float(v), 3) for v in p[:, 0]],
            "end_of_week_class": saturation_class(p[-1, 0]),
        })
    return out


def run(refresh: bool = False) -> dict:
    t0 = time.perf_counter()
    res = train(refresh)
    out = {
        "model": {
            "type": "LSTM (1 layer, 64 hidden), PyTorch",
            "target": "NASA POWER GWETROOT (root zone) and GWETTOP (surface) soil wetness, MERRA-2 land model",
            "inputs": "30 days of rain, max/min temperature, humidity, solar radiation, season and soil wetness, "
                      "plus the next 7 days of rain/weather",
            "site": {"lon": C.CENTER[0], "lat": C.CENTER[1], "cell": "NASA POWER ~0.5° x 0.625°"},
            "limits": ("Learns NASA's regional soil-moisture model, not a field sensor; one value for the whole "
                       "pilot strip. Rain for the coming week must be supplied (observed, forecast or scenario)."),
            "saturation_classes": [{"min": lo, "class": n, "meaning": m} for lo, n, m in SATURATION_CLASSES],
        },
        "metrics": res["metrics"],
        "hindcasts": [
            hindcast(res, date(2024, 10, 21), "Storm week: issued 21 Oct 2024 with Kristine's observed rain"),
            hindcast(res, date(2024, 11, 3), "After the 2 Nov Sentinel-1 pass: how long do roots stay waterlogged?"),
        ],
        "scenario_outlook": scenarios(res),
        "training_time_sec": round(time.perf_counter() - t0, 1),
    }
    C.write_json(OUTPUT, out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="re-download NASA POWER history")
    out = run(ap.parse_args().refresh)
    m = out["metrics"]
    print(f"trained {m['epochs']} epochs on {m['train_samples']} samples; test {m['test_samples']} ({m['split']['test']})  "
          f"t={out['training_time_sec']}s")
    for name in TARGETS:
        s = m[name]
        print(f"  {name}: RMSE day1..7 LSTM {s['rmse_lstm_by_day']}  persistence {s['rmse_persistence_by_day']}")
        print(f"     ridge (same inputs) {s['rmse_ridge_same_inputs_by_day']}")
        print(f"     skill vs persistence: all weeks {s['skill_vs_persistence_pct']}%, "
              f"wet weeks (n={s['wet_weeks']}) {s['skill_vs_persistence_wet_weeks_pct']}%  |  "
              f"vs ridge: all {s['skill_vs_ridge_pct']}%, wet {s['skill_vs_ridge_wet_weeks_pct']}%")
    for h in out["hindcasts"]:
        print(f"  {h['label']}: waterlogged days pred {h['days_waterlogged_pred']} / actual {h['days_waterlogged_actual']}, "
              f"MAE {h['mean_abs_error_root']}")
        print("     pred  ", [d["gwetroot_pred"] for d in h["days"]])
        print("     actual", [d["gwetroot_actual"] for d in h["days"]])
    so = out["scenario_outlook"]
    print(f"  Outlook after {so['issued_after']} (root zone {so['root_zone_today']}, {so['root_zone_class_today']}):")
    for c in so["cases"]:
        print(f"     {c['scenario']:42s} {c['rain_total_mm']:6.1f} mm -> {c['days_waterlogged']} waterlogged days, "
              f"ends {c['end_of_week_class']}")
    print(f"wrote {OUTPUT.relative_to(C.ROOT)} and {MODEL_PATH.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
