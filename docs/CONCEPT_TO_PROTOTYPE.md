# From project concept to prototype

How each part of the SakaSAR project concept ("Sub-Surface Dielectric & Micro-Topographic SAR Analytics for
Root-Zone Hydrology and Adaptive Crop Rotation") maps to what the prototype does today. Status words mean:
**Built** (working and tested), **Partly** (a working, narrower version), **Future** (not built; named so nobody
mistakes it for a result). Numbers and methods are in [METHODS.md](METHODS.md) and [BENCHMARKS.md](BENCHMARKS.md).

## Core idea

| Concept | Prototype | Status |
|---|---|---|
| See floods through cloud with radar | Sentinel-1 C-band flood mapping: 30 m in the pilot (Minalabac), 100 m for all 114 Bicol towns (3,137 ha of flooded farmland after Typhoon Kristine). The Story shows MODIS seeing only cloud on 23 Oct, then the radar map | Built |
| L-band dielectric inversion to volumetric soil water | Not done. C-band measures **surface wetness change** (ΔVV), and the interface says so. NISAR L-band is future work | Future |
| "Up to 7 days before visible distress" | Not claimed. Instead: a 7-day root-zone wetness forecast, tested against held-out years (60% lower error than persistence) | Partly (different, tested claim) |
| Micro-topography (slope, flow accumulation, TWI) | NASADEM at 30 m in the pilot and 200 m for all of Bicol: wetness index, drainage network, watershed tracing | Built |
| One shared grid for all layers | 30 m EPSG:32651 grid for the pilot; regional layers on 100 m / 200 m grids | Built |
| Bare-field and vulnerability detection from NDVI | Checked MODIS 250 m: too coarse for paddies. Bare-field days stay labelled as sample values until Landsat/Sentinel-2 NDVI or the cropping calendar is added | Future |

## How the prototype is framed

SakaSAR opens in **This week** mode: soil wetness across Bicol from the latest NASA POWER day, and a storm-readiness map
(how many days roots would stay waterlogged if a Kristine-size storm hit now, from the soil forecast). Terrain, runoff,
drainage, Check my field and watershed tracing work for any day. **Kristine 2024** is a replay feature: a real typhoon
we use to show the full chain and to test the models against what the radar saw. It is the evidence, not the limit.

## Farmer-facing features

| Concept | Prototype | Status |
|---|---|---|
| Field Drowning Risk, plain language | Score 0–100 with high / watch / low, what drives it (radar, terrain, rain), and a traffic-light farmer card on every click | Built |
| Plot-scale alert, low bandwidth | SMS text of 160 characters or fewer for every field and every clicked spot, with a copy button. No SMS gateway yet | Partly |
| Where to dig drainage | 30 m drainage channel in the pilot; "Where does the water go?" traces the upstream catchment and the downstream path for any spot in Bicol | Built (screening at 200 m) |
| Check a farmer's own parcel | "Check my field": trace the field on the map and get statistics from exactly the cells inside it | Built |
| Three rotation strategies vs the current crop, ranked by farmer priority | Legume, deep-rooting cover crop and short-cycle options ranked by field fit (risk, SoilGrids texture) and by water / nitrogen / cash priority, each with benefits and what to verify locally | Built (rule-based) |
| Soil Health Score | A soil health check from SoilGrids (organic carbon class, texture, drainage), stated as a rule of thumb. Not a validated score | Partly |
| Market-price optimizer, yield model (XGBoost) | Not built | Future |
| Heat and water stress alerts (ECOSTRESS) | Not built | Future |

## LGU-facing features

| Concept | Prototype | Status |
|---|---|---|
| Which barangays and towns to reach first | Barangay ranking in the pilot; all 114 Bicol towns ranked by flooded farmland, with CSV export | Built |
| Damage report within hours instead of weeks | Town flood report: one printable page per town (flooded hectares, radar pass, rain, runoff exposure, soil forecast, actions). Area only; no yield-loss estimate | Partly |
| Early salvage trigger 48–72 h ahead | This week mode (soil now + storm readiness), soil forecast for the coming week, plus a rain what-if ("what if 150 mm fell?") on the runoff map. No live rain-forecast feed, so no automatic trigger | Partly |
| Land-use and zoning support | Bicol-wide runoff and ponding map with an honest check (95% of radar-flooded farmland rated high vs 66% of all farmland) | Partly |
| Insurance and subsidy verification | Not built. "Check my field" already returns radar evidence for a traced parcel, which is the basis for it | Future |
| Aquifer and drought forecaster (GRACE) | Not built | Future |
| Cooperative harvest scheduler | Not built | Future |

## Data named in the concept

| Dataset | Used for | Status |
|---|---|---|
| Sentinel-1 (ESA Copernicus) | Flood mask, wetness change | Used |
| NASADEM | Slope, flow, wetness index, drainage, watersheds | Used |
| GPM IMERG | Storm rain for the risk score; daily imagery in the replay | Used |
| SMAP | Event soil-moisture anomaly (context, ~11 km); daily imagery | Used |
| NASA POWER | Rain and soil wetness grids, forecast training and inputs | Used |
| SoilGrids | Soil texture and organic carbon per field | Used |
| NASA EONET, NASA GIBS, ESA WorldCover | Storm track, daily satellite imagery, cropland mask (added during the build) | Used |
| MODIS NDVI | Checked, too coarse for paddy bare-field windows | Checked, not used |
| NISAR, ECOSTRESS, GRACE / GRACE-FO, Landsat NDVI | | Future |

## Tech stack named in the concept

Used: MapLibre GL JS (3D terrain), FastAPI, PyTorch (soil forecast), rasterio / NumPy / SciPy / shapely, Microsoft
Planetary Computer STAC, Google Earth Engine (exports), pytest. Not used: CesiumJS, Deck.gl, Three.js, PostGIS,
GeoServer, Docker / Kubernetes, XGBoost, MintPy, ONNX. The prototype serves precomputed files, so it runs on free
static hosting.

## What we deliberately do not claim

- Root-zone moisture from radar, or dielectric inversion. C-band shows surface wetness.
- Detection "7 days early" or a "35–50% water saving". Neither is built or tested.
- A direct hit by Kristine: its centre passed about 259 km from Naga; Bicol flooded from the rain bands.
- Field sizes, households, crops and bare-field days for the sample fields: they are sample values until the LGU
  shares parcel and census data.
