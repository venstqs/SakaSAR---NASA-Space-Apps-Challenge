#!/usr/bin/env python3
import io
from pathlib import Path
import sys
import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from terrain_rain.provenance import update_provenance


def parse_nasa_power_csv(csv_path: Path, missing_flag: float = -999.0) -> pd.DataFrame:
    """
    Parses NASA POWER CSV after '-END HEADER-', normalizes Windows/Unix line endings,
    replaces -999 missing flags with NaN, and adds calendar date/month columns.
    """
    raw_text = csv_path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    lines = raw_text.split("\n")

    header_end_idx = -1
    for idx, line in enumerate(lines):
        if line.strip().upper().startswith("-END HEADER-"):
            header_end_idx = idx
            break

    data_lines = lines[header_end_idx + 1 :] if header_end_idx >= 0 else lines
    csv_body = "\n".join(line for line in data_lines if line.strip())

    df = pd.read_csv(io.StringIO(csv_body))
    df.columns = [c.strip() for c in df.columns]

    value_cols = ["T2M", "T2M_MAX", "T2M_MIN", "PRECTOTCORR", "RH2M", "ALLSKY_SFC_SW_DWN"]
    for col in value_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
            df.loc[df[col] <= missing_flag + 1e-6, col] = np.nan

    df["YEAR"] = df["YEAR"].astype(int)
    df["DOY"] = df["DOY"].astype(int)
    dates = pd.to_datetime(df["YEAR"].astype(str) + "-" + df["DOY"].astype(str), format="%Y-%j")
    df.insert(0, "date", dates.dt.strftime("%Y-%m-%d"))
    df.insert(3, "MONTH", dates.dt.month)

    return df


def compute_monthly_climatology(df: pd.DataFrame) -> pd.DataFrame:
    """
    Computes per-calendar-month climatology (1..12) for the crop rotation engine:
      - mean monthly total rainfall (sum PRECTOTCORR per year-month, then mean across years)
      - mean daily T2M, T2M_MAX, T2M_MIN, RH2M, ALLSKY_SFC_SW_DWN per calendar month
    """
    # Year-month totals for precipitation (only complete or near-complete months >= 25 valid days)
    ym_rain = (
        df.groupby(["YEAR", "MONTH"], as_index=False)
        .agg(
            monthly_rain_mm=("PRECTOTCORR", "sum"),
            valid_rain_days=("PRECTOTCORR", "count"),
        )
    )
    ym_rain = ym_rain[ym_rain["valid_rain_days"] >= 25]
    rain_clim = (
        ym_rain.groupby("MONTH", as_index=False)
        .agg(
            rain_monthly_mean_mm=("monthly_rain_mm", "mean"),
            rain_monthly_std_mm=("monthly_rain_mm", "std"),
        )
    )

    met_clim = (
        df.groupby("MONTH", as_index=False)
        .agg(
            t2m_mean_c=("T2M", "mean"),
            t2m_max_mean_c=("T2M_MAX", "mean"),
            t2m_min_mean_c=("T2M_MIN", "mean"),
            rh2m_mean_pct=("RH2M", "mean"),
            solar_sw_dwn_mean_mj_m2_day=("ALLSKY_SFC_SW_DWN", "mean"),
        )
    )

    clim = pd.merge(rain_clim, met_clim, on="MONTH", how="outer").sort_values("MONTH")
    return clim.round(3)


def main() -> None:
    with open(ROOT / "config" / "pilot.yaml", "r", encoding="utf-8") as f:
        pilot = yaml.safe_load(f)
    with open(ROOT / "config" / "layers.yaml", "r", encoding="utf-8") as f:
        layers_cfg = yaml.safe_load(f)["layers"]

    raw_dir = (ROOT / pilot["raw_data_dir"]).resolve()
    out_dir = (ROOT / pilot["output_dir"]).resolve()
    out_tables = out_dir / "tables"
    out_tables.mkdir(parents=True, exist_ok=True)

    power_csv_path = raw_dir / "power" / "nasa_power_daily_2000_2026.csv"
    df_daily = parse_nasa_power_csv(power_csv_path, missing_flag=-999.0)
    df_monthly = compute_monthly_climatology(df_daily)

    daily_out = out_tables / "power_daily.csv"
    monthly_out = out_tables / "power_monthly_climatology.csv"

    df_daily.to_csv(daily_out, index=False)
    df_monthly.to_csv(monthly_out, index=False)

    update_provenance(
        provenance_path=out_dir / "provenance.json",
        pilot_cfg=pilot,
        layers_cfg=layers_cfg,
        metric_key="nasa_power_summary",
        metric_value={
            "daily_rows": int(len(df_daily)),
            "date_min": str(df_daily["date"].min()),
            "date_max": str(df_daily["date"].max()),
            "monthly_climatology_rows": int(len(df_monthly)),
        },
    )

    print(f"[04_build_power] Wrote {daily_out.name} ({len(df_daily)} rows)")
    print(f"[04_build_power] Wrote {monthly_out.name} ({len(df_monthly)} months)")


if __name__ == "__main__":
    main()
