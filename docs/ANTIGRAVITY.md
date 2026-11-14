# SakaSAR — brief for Antigravity agents (Gemini)

Read this first, then `CLAUDE.md` (the source of truth for data, method and honesty rules). This file tells you
how the app is put together today and what is safe to work on. If the two disagree, `CLAUDE.md` and the code win.

Deadline: **Sun 15 Nov 2026, 11:59 PM** (NASA Space Apps 2026, Field Shift challenge).
Live: https://venstqs.github.io/SakaSAR---NASA-Space-Apps-Challenge/ (GitHub Pages from `main`) · Vercel mirror.

## 1. What the app is

A 3D GIS replay of Typhoon Kristine (Oct 2024) over the Bicol Region, Philippines, for farmers, Municipal
Agriculture Offices and MDRRMOs. Home is the 3D map. Panels open as windows; any window can be maximised into a
full-screen workspace.

```
index.html   page shell: brand chip, toolbar, launcher rail (#dock), #sections (panel content),
             timeline, story card, inspector, workspace, splash intro
app.js       everything in the browser (one file, no build step)
style.css    all styles (tokens at the top of the file)
api.py       FastAPI: serves the dashboard files and /api/* JSON (python -m uvicorn api:app --port 8000)
pipeline/    Python that builds every data file the page reads (never hand-edit outputs)
```

Run locally: `pip install -r requirements.txt` then `python -m uvicorn api:app --port 8000` and open
http://localhost:8000. Tests: `python -m pytest -q` (27 must pass before any commit).

## 2. Data the page reads (all generated)

| File | Built by | Used for |
|---|---|---|
| `data/region/bicol_timeline.json` | `python -m pipeline.bicol_timeline` | days, 35 NASA POWER cells (rain, root-zone wetness), EONET storm track, radar passes, LSTM hindcast + "Kristine again" |
| `data/region/bicol_municipalities.geojson` | `python -m pipeline.bicol_region` | 114 towns: farmland_ha, flooded_farmland_ha, flooded_share, rank |
| `data/region/bicol_summary.json` | same | Bicol totals, provinces, top towns, processing time |
| `data/region/bicol_flood.png` + `.json` | same | Sentinel-1 flooded farmland, 100 m, Web Mercator |
| `data/region/pilot_grids.json` | `python -m pipeline.web_layers` | 30 m pilot grids (score, class, TWI, ΔVV, slope, flood, land cover), EPSG:3857, scaled ints |
| `mock-data.json` (= `/api/data`) | `python -m pipeline.risk_engine` | 30 m Field Drowning Risk for 5 sample fields, rotations, SMS, provenance, hit rates. **Frozen contract** (CLAUDE.md §5) |

## 3. How app.js is organised (search for these names)

- **State**: `S` (time `S.t`, layers, heatmap field, selected plot, priority…). Raster helpers in `R`.
- **Heatmaps**: `prepareGrid`, `sample` (bilinear on the POWER grid), `renderField`. Rasters are served as tiles
  through `maplibregl.addProtocol("saka", …)` + `registerRaster(name, canvas, w, e, n, s)`.
  **Do not** switch back to image/canvas sources: with 3D terrain MapLibre 4 drapes them on only some tiles.
  After our tiles load we call `map.terrain.sourceCache.freeRtt()`; keep that.
- **Map**: `initMap`, `addLayers` (GIBS, heatmap, towns, hotspots, flood, storm track), `applyLayers`.
- **Timeline**: `setTime`, `buildTimeline`, `play/pause`, `updateStorm`, `renderStats`.
- **Inspector** (click on map): `inspect(lon, lat)`; hover readout `onHover`; 30 m values `pgValue`, `pgInspectHTML`.
- **Windows**: `APPS`, `buildWindows`, `openApp`, `minimiseWin`, `closeWin`, `placeWin`, `dragWin`.
  **Workspace**: `teleport`, `wsShow`, `backToMap`. Panel content lives in `<section id="tab-…">`; it is *moved*
  between its window and the workspace (listeners survive). Add a panel = add to `APPS` + a `tab-<id>` section.
- **Panels**: `renderLayers`, `renderTowns`, `renderFields` (30 m risk, SMS, rotations), `renderAI` (LSTM chart),
  `renderEvents`, `renderData` (sources & limits).
- **SakaSAR AI**: `aiAnswer(q, ctx)`: rule-based, every sentence built from a dataset value. `aiContext()` uses
  the clicked place, the timeline day and the selected field. It is NOT a chat model; keep the note that says so.
  To add a topic: add a `has("keyword")` branch that reads real fields and returns `{ html, src: [sources] }`.
- **Story**: `STORY` steps + `storyGo`. **Intro**: `finishIntro` (logo flies into the brand chip, camera flies in).
- **Motion helpers**: `initSegs` (sliding pill), `countTo` (count-up). Respect `reduceMotion`.

## 4. Design rules

- Brand from the logo (`assets/sakasar-logo.png`: satellite, gold radar arcs, green field rings).
  Tokens: `--night #0c2620`, `--gold #e9b234`, `--lime #8fd16b`, controls green `--green #1f8a4c`,
  water `#2f9fd3`/`#1b5fa8`, storm `#e2533c`. Light glass panels. Fonts: Bricolage Grotesque (wordmark, numbers),
  Geist (UI). Brand = logo + "SakaSAR" only, no subtitle.
- Home stays clean: map, brand chip, toolbar, rail, timeline, legend. Detail goes in windows or the workspace.
- Test in a real browser at 1534×728 and 390×844 (phone: rail becomes a bottom bar, panels open in the workspace).

## 5. Honesty rules (do not break)

- Headline hit rate is the independent **31%**; the 100% full-model figure is circular and only shown as such.
- No invented numbers in the UI. Placeholders (hectares, households, crop, bare-field days) keep the "sample" tag.
- C-band radar = surface wetness, not root-zone moisture. Do not claim L-band dielectric inversion, "7 days early"
  detection or "35–50% water saving".
- Kristine's centre passed ~263 km north of Naga; Bicol flooded from the rain bands. Never imply a direct hit.
- No Claude or AI co-author lines in commits.

## 6. Safe tasks for agents

1. README: refresh `assets/screenshots/` from the new UI (home, a window, the workspace, the story steps).
2. `docs/SUBMISSION.md`: demo video/slides link and a published source for the reported Kristine flooding.
3. 30-second demo: press **Story** and screen-record the five steps (storm rain → MODIS clouds → radar flood →
   field risk + SMS → rotations).
4. SakaSAR AI: more intents (e.g. "which barangay", "rain tomorrow" → explain no live forecast), Filipino/Bikol
   phrasing for the SMS and tips (keep facts identical).
5. Accessibility pass: focus order through windows, `aria-live` for AI answers, contrast on the legend.

Ask before: renaming JSON keys, changing the risk formula or thresholds, touching `pipeline/` outputs by hand,
force-pushing, or adding new datasets to the submission list.
