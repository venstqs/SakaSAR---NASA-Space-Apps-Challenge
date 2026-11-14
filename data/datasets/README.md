# SakaSAR datasets

Reusable tables built by `python -m pipeline.build_datasets` from the pipeline's real inputs
(Typhoon Kristine, Oct 2024 · Minalabac, Camarines Sur pilot). Plain CSV, UTF-8, one header row.

| File | Rows | One row is | Use it for |
| :--- | ---: | :--- | :--- |
| `daily_weather_soil_2001_2026.csv` | 9,444 | a day at the pilot centre | training and testing soil-moisture models; this is the LSTM's training set |
| `pixels_30m_pilot.csv` | 1,541 | a 30 m cell in the pilot strip | labelled flood / risk modelling (each cell carries the radar-observed flood label) |
| `plot_features.csv` | 5 | a sample plot | per-plot analysis: radar, terrain, rain, soil, risk, rotation fit |
| `plot_recommendations.csv` | 20 | a plot × recommendation step | the farmer timeline shown in the dashboard |

## Columns

**daily_weather_soil_2001_2026.csv** — NASA POWER daily point data at (123.2057 E, 13.5416 N):
`rain_mm` (PRECTOTCORR) · `tmax_c`, `tmin_c` (T2M_MAX/MIN) · `rh_pct` (RH2M) · `solar_mj_m2` (ALLSKY_SFC_SW_DWN) ·
`gwetroot` / `gwettop` (root-zone / surface soil wetness, 0 = dry, 1 = saturated; MERRA-2 land model).

**pixels_30m_pilot.csv** — EPSG:32651 30 m grid:
`dvv_db` (Sentinel-1 VV change, 2 Nov 2024 minus Aug–Sep median; negative = darker, wetter) · `twi` (topographic wetness
index) · `slope_deg` · `elevation_m` (NASADEM) · `worldcover_code/_class` (ESA WorldCover 2021) ·
`observed_flood` (1 = radar flood mask) · `risk_score` / `risk_class` (full model) ·
`terrain_only_score` / `terrain_only_class` (model without radar: the independent hit-rate test).

**plot_features.csv** — `dvv_db_2nov`, `dvv_db_9oct` (pre-storm check), `dvh_db_2nov`, `flooded_fraction`, `twi`,
`slope_deg`, `elevation_m`, `cropland_fraction`, SoilGrids `sand_pct`/`silt_pct`/`clay_pct`/`soc_g_per_kg`/`texture`,
score components `s_sar`/`s_twi`/`s_rain`, `risk_score`, `risk_class`, rotation fits.
`hectares_placeholder` and `households_placeholder` are **illustrative**, not census data.

## Limits

- One event and one 2 km pilot strip: good for demos and method testing, too small on its own to train a
  general flood model.
- The `observed_flood` label comes from C-band radar 9 days after landfall; water under tall rice canopy can be missed.
- Soil wetness in the daily file is a reanalysis product for a ~50 km cell, not a field sensor.

## Sources and licences

Derived from open data; credit the sources when reusing: Sentinel-1 (Copernicus, free and open) · NASADEM, NASA POWER,
GPM IMERG, SMAP (NASA, open) · ESA WorldCover (CC BY 4.0) · SoilGrids (ISRIC, CC BY 4.0).
SakaSAR code: MIT.
