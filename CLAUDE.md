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

## 6. Dashboard (windowed 3D app, 15 Nov 2026) — agent brief: docs/ANTIGRAVITY.md

- **Home = the 3D map** with a green brand chip: the original logo (`assets/sakasar-logo.png`, never redraw or recolour it) + white wordmark in Inter 800, toolbar (2D/3D, Story, Bicol, Storm track, save, link),
  a launcher **rail** on the left, the timeline and the legend. The intro shows the original logo, reveals the
  wordmark, then a Sentinel-1 style swath wipes to the map while the camera flies onto Bicol (click skips).
- Accuracy: Bicol figures are Bicol-land averages/peaks of the interpolated POWER grid (sea cells excluded); the day axis
  is Philippine time (UTC+8); the closest pass is measured to the EONET track line (≈259 km, 23 Oct 04:49 PHT).
- Timeline is a short centred bar: play, date, rain bars + event ticks, rain over land, storm wind, speed button.
- Layout (final): brand chip top-left (white, green wordmark), toolbar top-right, **rail on the right**, legend + readout
  bottom-left, short timeline bottom-centre, map controls + scale + attribution bottom-right. Intro on white.
  Workspace = left sidebar + titled page + one card. Details and next tasks: docs/ANTIGRAVITY.md §0.
- **Windows** (rail buttons): SakaSAR AI, Layers, Towns, Field risk, LSTM forecast, Events, Data & method. Drag by the
  header, resize from the corner, minimise to the rail, close, or maximise/double-click to **teleport** into the
  full-screen **workspace** (section switcher, "Back to 3D map", Esc). Phones open panels straight in the workspace.
- **SakaSAR AI**: rule-based assistant that answers from the datasets for the clicked place, timeline day and selected
  field (flooding, rain, soil/LSTM, storm, field risk, rotations, accuracy). Labelled "not a chat model". When open,
  it posts a tip for each place you click.
- **30 m detail layers** (`data/region/pilot_grids.json`, `python -m pipeline.web_layers`): risk score, TWI, ΔVV,
  slope drawn from the risk engine GeoTIFFs; hover readout and inspector show exact cell values.
- Heatmaps: NASA POWER grid, bilinear in Web Mercator, masked to town polygons; fade above zoom 9.
- Flood: Sentinel-1 hotspot heatmap + 100 m raster (hidden above zoom 12.2) + town shading, from 2 Nov.
- Storm: EONET track in PAGASA colours, daily labels, live marker, measured closest pass to Naga (≈263 km). Never imply a
  direct hit.
- Rasters (heatmap, flood) are served as `saka://` tiles from a `maplibregl.addProtocol` handler that crops the
  in-browser canvas. Do NOT go back to image/canvas sources: with 3D terrain MapLibre 4 drapes them only on some
  tiles (Sorsogon, Masbate, Catanduanes went blank). After our tiles load we call `terrain.sourceCache.freeRtt()`.
- UI: full-bleed map with floating glass sheets (brand chip, toolbar, panel, legend, timeline, inspector). Fonts: Geist (UI),
  Bricolage Grotesque (date, figures). Motion is vanilla JS (count-up numbers, sliding tab/segment pills, inspector opens
  from the click point, timeline bars rise once on load); React is not used. Respect prefers-reduced-motion.
- Tokens: logo green `#1f8a4c` (controls), water `#2f9fd3`/`#1b5fa8`, storm `#e2533c`, ink `#0f1f17`. Only measured values.

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

## 9. Handoff — read this first if you are continuing the work

State on 15 Nov 2026 (main): dashboard rebuilt (section 6); pipeline, LSTM, recommendations and datasets done.

Rules that keep the project consistent:
1. Run `python -m pytest -q` before every commit (27+ tests). Do not push if anything fails.
2. Never put back: the Naga City plots, the 21 Oct radar pass as the "after" scene, the 100% hit rate as the headline,
   invented numbers in the UI, or Claude co-author lines in commits.
3. Pipeline outputs are generated: change the Python in `pipeline/`, then re-run it. Do not hand-edit `mock-data.json`.
4. Test the dashboard in a real browser (local: `uvicorn api:app --port 8000`) at a 1534×728 window and a 390×844 phone.

Still to do:
- Bicol regional layer: run `python -m pipeline.bicol_region` (≈25 min, downloads cached in git-ignored `data/cache_region/`),
  check that `data/region/bicol_summary.json` has radar_coverage near 1.0 and plausible flooded hectares, then commit `data/region/`.
- README: add the Bicol region results and refresh `assets/screenshots/` from the new dashboard.
- Submission (`docs/SUBMISSION.md`): demo video/slides link and a source for the reported Kristine flooding.

