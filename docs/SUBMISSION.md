# SakaSAR — NASA Space Apps 2026 submission draft

Copy-ready text for every field of the Project Submission form. Fields marked **TO DO** need a team
member's input. Check the field list against the 2026 guide on the team page before submitting.
Deadline: **Sunday 15 November 2026, 11:59 PM** local time.

---

## Project name

**SakaSAR** (Field Shift challenge)

## High-level project summary

SakaSAR shows smallholder farmers and local governments which fields will drown after a typhoon, and
what to plant next. During storms, clouds blind optical satellites, but Sentinel-1 radar sees through
them. We combine the radar's before/after signal with NASA elevation (NASADEM), rainfall (GPM IMERG)
and soil-moisture (SMAP) data on one 30 m grid to score each field's drowning risk. We then check that
map against the flooding the satellite actually observed. For Typhoon Kristine (Oct 2024) in
Minalabac, Camarines Sur, it flagged 2 of 5 sample rice plots as high risk and found 35 ha of flooded
farmland. It ranks barangays for field visits, writes a plain-language action and an SMS alert of 160
characters or fewer per plot, and rates three next-season crop rotations against each plot's soil and
current crop. A small LSTM trained on 25 years of NASA POWER data forecasts how long roots stay
waterlogged. Everything runs on free, open data (₱0).

## Link to project demo

**TO DO (Marqus):** public link to a ≤30-second video with English subtitles, or ≤7 slides including
the title slide. Suggested storyboard: storm hits → clouds block optical → radar sees water (SAR
toggle) → farmer gets the SMS and action → LGU barangay list → next-season rotation → LSTM outlook.
Screenshots are in `assets/screenshots/`.

## Link to final project

- Repository: https://github.com/venstqs/SakaSAR---NASA-Space-Apps-Challenge
- Live dashboard: https://sakasar.earth (mirrors: https://sakasar.vercel.app ·
  https://venstqs.github.io/SakaSAR---NASA-Space-Apps-Challenge/). Test in a private window before submitting.

## Detailed project description

**What it does**
- **Field Drowning Risk map** (high / watch / low) for every 30 m cell and farm plot, with a plain-language
  action and a ≤160-character SMS alert per plot.
- **Validation** against Sentinel-1's observed flood map. The headline hit rate (31%) uses a model that
  never saw the radar (terrain + rain only), so it is an independent test.
- **LGU view:** barangays ranked by high-risk farmland (Taban → Bagongbong → Catanusan) for Municipal
  Agriculture Office visits and MDRRMO.
- **Rotation engine:** three strategies (legume, deep-rooting cover crop, short-cycle) ranked by farmer
  priority (water, nitrogen, cash) and rated against each plot's SoilGrids texture, drowning risk and current crop.
- **LSTM soil-saturation outlook:** root-zone saturation 1–7 days ahead. On unseen 2022–2026 data it has
  60% lower error than persistence and 25% lower than linear regression; it called Kristine's 7/7
  waterlogged days correctly.

**How it works**
1. Sentinel-1 RTC (VV/VH): Lee speckle filter, 30 m grid, change = 2 Nov 2024 minus the median of 4
   calm Aug–Sep passes. Flood = dark water (Otsu threshold) ∧ ≥2 dB drop ∧ flat ∧ not permanent water.
   The storm-day pass (21 Oct) was rejected because typhoon wind roughened water so it no longer looked dark.
2. NASADEM: depression filling, D8 flow accumulation, Topographic Wetness Index.
3. GPM IMERG event + 7-day rainfall (NASA POWER cross-check), SMAP anomaly as context.
4. Risk = 0.45·SAR + 0.35·terrain wetness + 0.20·rain (0–100); classes high ≥70, watch 40–69, low <40.
5. FastAPI serves the JSON/GeoJSON; a MapLibre + Three.js dashboard draws the real flood mask in 3D.

**Benefits:** farmers know which plots need a drainage trench or early harvest. Extension officers know
which barangays to visit first. LGUs screen farmland at ₱0 data cost, and the analysis is reproducible
in the public repo.

**Tools & languages:** Python (NumPy, SciPy, rasterio, shapely, pyproj, FastAPI, PyTorch), JavaScript
(MapLibre GL JS, Three.js), Microsoft Planetary Computer STAC, Google Earth Engine (Guian's exports),
pytest, Playwright (UI checks).

**Limits (stated honestly):** C-band radar measures surface wetness, not root-zone moisture. Water under
tall rice canopy can be missed. Plot outlines, hectares and households are illustrative until there is LGU
data. Bare-field days are placeholders, because MODIS 250 m is too coarse for paddies. Risk weights are
expert-set, not fitted.

## NASA data

- **NASADEM** (30 m): slope, flow accumulation, Topographic Wetness Index, drainage corridor.
- **GPM IMERG V07**: event (469 mm) and 7-day prior (28 mm) rainfall → rainfall score.
- **SMAP L4 root-zone soil moisture**: event anomaly +2.2σ vs the 30-day baseline (context at native ~11 km).
- **NASA POWER**: daily rainfall cross-check (510 mm); 2001–2026 weather and GWETROOT to train the LSTM.
- *(Checked, not used for values: MODIS NDVI 250 m, too coarse for bare-field windows in paddies.)*

## Space agency partner & other data

- **Sentinel-1 RTC** (ESA / Copernicus, via Microsoft Planetary Computer): before/after radar, flood mask.
- **ESA WorldCover 2021**: cropland / built-up / water mask.
- **SoilGrids 250 m** (ISRIC): per-plot soil texture and organic carbon.
- **Reported flooding source:** **TO DO.** Cite an official report on Kristine flooding in Camarines Sur
  (e.g. an NDRRMC or PAGASA situational report) with its link.

Future work, not used: NISAR, ECOSTRESS, GRACE/GRACE-FO.

## Use of AI

- **Anthropic Claude Code** and **Google Gemini (Antigravity)**: code scaffolding, geospatial pipeline
  code, debugging, documentation and tests. All outputs were reviewed and run by the team.
- **Our own model:** a small PyTorch LSTM trained on public NASA POWER data (`pipeline/soil_lstm.py`),
  evaluated on held-out years.
- No AI-generated images or video. No NASA logos in AI-generated content.

## References

**Data**
- Sentinel-1 RTC: https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc
- NASADEM: https://planetarycomputer.microsoft.com/dataset/nasadem
- GPM IMERG: https://gpm.nasa.gov/data/imerg
- SMAP L4 (SPL4SMGP): https://nsidc.org/data/spl4smgp
- NASA POWER: https://power.larc.nasa.gov
- ESA WorldCover: https://esa-worldcover.org
- SoilGrids: https://soilgrids.org
- MODIS MOD13Q1: https://lpdaac.usgs.gov/products/mod13q1v061/

**Methods**
- Lee, J.-S. (1980). Digital image enhancement and noise filtering by use of local statistics. *IEEE TPAMI*.
- Otsu, N. (1979). A threshold selection method from gray-level histograms. *IEEE Trans. SMC*.
- Beven, K. J. & Kirkby, M. J. (1979). A physically based, variable contributing area model of basin hydrology. *Hydrological Sciences Bulletin*.
- Barnes, R., Lehman, C. & Mulla, D. (2014). Priority-flood: an optimal depression-filling and watershed-labeling algorithm. *Computers & Geosciences*.
- Kratzert, F. et al. (2018). Rainfall–runoff modelling using Long Short-Term Memory (LSTM) networks. *Hydrology and Earth System Sciences*.

**Software:** NumPy, SciPy, rasterio/GDAL, shapely, pyproj, FastAPI, PyTorch, MapLibre GL JS, Three.js,
Lucide icons, WhiteboxTools (optional).

## Final checks

- [ ] Terms and Conditions box checked, originality confirmed
- [ ] Demo link and repo/dashboard links opened in a private browser window
- [ ] "Submit for Judging" clicked and the submitted state confirmed on the team page
