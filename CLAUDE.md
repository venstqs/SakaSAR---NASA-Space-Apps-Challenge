# CLAUDE.md — SakaSAR project guide for AI coding assistants

**SakaSAR** is a SAR-based field-drowning-risk and crop-rotation decision tool built for the
2026 NASA Space Apps challenge *Field Shift: Adapting Farms with NASA Data*.
This file describes what is **actually built on `main`**. If it disagrees with older notes,
plans or chat history, this file and the code win. Keep it updated when the build changes.

Team: Adrian Xavier Moral (main developer, integration lead: SAR, risk engine, API, LSTM) · Guian Emmanuel Beriso
(`terrain_rain/` package, rotation inputs) · Marqus Szymon Pelagio (dashboard, demo & submission) ·
Engr. John Roy V. Galvez (mentor). Submission closes **Sun 15 Nov 2026, 11:59 PM**.

---

## 1. Pilot area and event (do not revert)

- **Pilot:** rice paddies in **Brgy. Bagongbong, Taban and Catanusan, Minalabac, Camarines Sur**
  (Bicol River basin), about 9 km south of Naga City.
- **Bbox:** `[123.1963, 13.5384, 123.2151, 13.5448]` · **centre** `[123.2057, 13.5416]`
  (`pipeline/common.py: BBOX, CENTER`). Grid: 30 m, EPSG:32651, padded 2 km for hydrology.
- **Why not Naga City:** the original plots sat on residential subdivisions. C-band radar cannot see
  standing water between buildings (double bounce), so they showed no flood signal. A 35 × 33 km scan
  chose this strip (>60% cropland, <10% built-up, a visible flood edge). The 5 plots are placed
  evenly west → east, not cherry-picked. Plot shapes, hectares, households and crops are
  **illustrative placeholders** until there is LGU parcel/census data (`pipeline/plots.geojson`).
- **Event:** STS Kristine (Trami), 21–26 Oct 2024.
- **Sentinel-1 RTC, orbit 134 descending:** baseline = median of 10 Aug, 22 Aug, 15 Sep and 27 Sep 2024 ·
  just-before = 9 Oct · **after = 2 Nov 2024**.
  **Rejected: the 21 Oct pass** (storm peak). Wind-roughened water brightened by a median of +5.3 dB
  regionally, so open water is invisible in it.

## 2. Data actually used

| Dataset | Use |
|---|---|
| Sentinel-1 RTC VV/VH (ESA, Microsoft Planetary Computer) | ΔVV wetness change, observed flood mask |
| NASADEM 30 m (NASA) | slope, D8 flow, TWI, drainage corridor |
| GPM IMERG V07 (NASA, Guian's GEE export) | rainfall score: 469 mm event + 28 mm prior 7 days |
| NASA POWER daily | rainfall cross-check (510 mm); 2001–2026 weather for the LSTM |
| SMAP L4 root-zone (NASA, Guian's export) | event anomaly +2.2σ vs 30-day baseline (context, native ~11 km) |
| SoilGrids 250 m (ISRIC) | per-plot sand/silt/clay/SOC → rotation fit |
| ESA WorldCover 2021 | cropland / built-up / permanent-water mask |
| MODIS NDVI 250 m | **checked, not used**: too coarse for paddy bare-field windows |

Future work only (not used): NISAR, ECOSTRESS, GRACE/GRACE-FO, Landsat/Sentinel-2 30 m NDVI.
Raw files in `data/raw/bicol_kristine_2024/`; clipped real-data caches in `data/cache/` (offline runs).

## 3. How to run

```bash
pip install -r requirements.txt            # API + pipeline (no torch)
python -m pipeline.risk_engine             # rebuilds mock-data.json from cache (~1 s); --refresh re-downloads
python -m pipeline.soil_lstm               # retrain the LSTM (needs requirements-ml.txt / torch)
uvicorn api:app --port 8000                # dashboard + API at http://localhost:8000
python -m pytest -q                        # 26 tests (ours + terrain_rain)
python terrain_rain/scripts/run_all.py     # Guian's package; works without WhiteboxTools (offline fallback)
```

Layout: `pipeline/` (sar_moisture, terrain_rain, risk_engine, rotation_engine, soil_lstm, common) ·
`terrain_rain/` (Guian) · `api.py` · dashboard `index.html`, `app.js`, `style.css`, `outlook.js/.css` ·
`docs/METHODS.md` (full method write-up) · `data/layers/*.tif` (exported 30 m grids).

## 4. Method (keep consistent with docs/METHODS.md)

```
S_SAR  = clip(−ΔVV / 4 dB, 0, 1)        ΔVV = VV(2 Nov) − VV(baseline median), Lee-filtered, dB
S_TWI  = clip((TWI − 5) / 10, 0, 1)
S_Rain = clip(R / 300 mm, 0, 1)          R = IMERG event + prior 7 days
RiskScore = round(100 × (0.45·S_SAR + 0.35·S_TWI + 0.20·S_Rain))
high ≥ 70 · watch 40–69 · low < 40 · missing (no SAR) · excluded (built-up / permanent water)
Flood mask: VV_after < τ (Otsu, bounded −20…−12 dB) ∧ ΔVV < −2 dB ∧ slope < 5° ∧ not permanent water
```

- **Hit rate — always report it this way:** `sar_hit_rate` (headline, **31%**) uses the terrain + rain
  model that never saw the radar, so it is the independent test. `sar_hit_rate_full_model` (100%) is
  circular, because ΔVV is in both the score and the flood mask: **never headline it.**
- **LSTM** (`pipeline/soil_lstm.py`): forecasts NASA POWER GWETROOT/GWETTOP for days +1…+7 from 30 days
  of history plus the next week's rain. Test 2022–2026: 60% lower RMSE than persistence and 25% lower
  than ridge regression. Kristine hindcasts: 7/7 waterlogged days. It learns NASA's regional (~50 km)
  model, not a paddy sensor.
- **Rotation fit** (`pipeline/rotation_engine.py`): legume = caution on high drowning risk; biotillage =
  good on clay ≥ 30% or high/watch risk; shortcycle = caution on high, good on low. These are rules of
  thumb to verify with the Municipal Agriculture Office.
- **Recommendations** (`pipeline/recommend.py`): per-plot timeline: next 48 h (measured risk), this week (LSTM
  after the 2 Nov pass), before the next storm (LSTM Kristine scenario from the latest NASA POWER day), next season
  (rotation fit). Each step lists its sources. Datasets: `python -m pipeline.build_datasets` → `data/datasets/`.
- Current results: PL-01/02 high · PL-03/04 watch · PL-05 low · 35.1 ha flooded farmland ·
  barangay order Taban → Bagongbong → Catanusan.

## 5. JSON contract (`mock-data.json` = `/api/data`)

Frozen top-level keys (never rename or remove): `provenance`, `plots`, `observed_flood_extent`,
`sar_backscatter_comparison` (`before_event`, `after_event`), `drainage_corridor`, `rotation_strategies`.
Frozen plot properties: `plot_id, name, barangay, hectares, households, risk_class, risk_score,
sar_wetness_change_db, twi_value, current_crop, bare_field_days_per_year, plain_language_action,
sms_alert (≤160 chars)`. New fields may be **added** (e.g. `risk_zones`, `pre_event_change_db`,
`soil_0_30cm`, `rotation_fit`, `provenance.map_center`, `barangay_ranking`, `sar_scenes`).

API: `/api/data`, `/api/plots`, `/api/risk-map`, `/api/rotations?priority=water|nitrogen|cash`,
`/api/provenance`, `/api/soil-outlook`, plus whitelisted dashboard files and `/assets/<image>`.
Never mount the repo root as static files.

## 6. Dashboard (rebuilt 15 Nov 2026)

- Layout: one docked sidebar (Bicol Region → Minalabac fields) plus the map. No floating cards. The bottom
  **storm ribbon** shows daily NASA POWER rain (`provenance.rain_timeline`) and the three radar passes (9 Oct, 21 Oct rejected for wind,
  2 Nov). Clicking a pass sets the map mode (`pre` / `storm` / `post`).
- **Region view** reads `data/region/bicol_summary.json`, `bicol_municipalities.geojson` and the `bicol_flood.png` overlay
  (built by `python -m pipeline.bicol_region`, 100 m, both Sentinel-1 orbits). Towns are ranked by flooded farmland.
- **Field view**: plot chips, then risk, facts, "What to do" (from `recommendations`), "Will this field drain this week?"
  (LSTM hindcast in plain words, not a separate panel), next-season rotation fit, the SMS with a copy button, and the barangay list.
- Design tokens: river-silt panels `#0F2B2A`/`#17393A`, text `#E7EFEA`/`#9FB8AE`, floodwater blue `#4EC4DE` (the only accent;
  same blue as radar water), risk `#F25F3A` / `#EBB043` / `#7CC69A`. Fonts: Atkinson Hyperlegible (body), Archivo (headings, numbers).
- Show **only measured values**. The 3D water is built from `observed_flood_extent`; SAR shows where water is, not its depth.
- The map centre comes from `provenance.map_center`. No hard-coded coordinates in the UI.

## 7. Honesty rules for code, docs and pitch

- Placeholders stay labelled: `bare_field_days_per_year`, `households`, `hectares`, `current_crop`
  (see `provenance.pending_inputs`).
- C-band measures **surface wetness**, not root-zone moisture. Do not claim L-band dielectric inversion,
  "7 days early" detection or "35–50% water saving": none of them is built or tested.
- List only datasets that were actually used (section 2) on the submission form.

## 8. Open items (as of 14 Nov 2026)

1. Live dashboard (GitHub Pages, from `main`): https://venstqs.github.io/SakaSAR---NASA-Space-Apps-Challenge/
2. Bare-field days: need 30 m Landsat/Sentinel-2 NDVI or the MAO cropping calendar.
3. Submission: form text is drafted in `docs/SUBMISSION.md` (fill the TO DO fields); ≤30 s video or ≤7 slides,
   and a source for the reported Kristine flooding.
