<div align="center">

# 🌾 Field Shift: Agro-Hydrological Decision Support
### *Sub-Surface Dielectric & Micro-Topographic SAR Analytics for Root-Zone Hydrology and Adaptive Crop Rotation under Extreme Weather Regimes*

[![NASA Space Apps Challenge 2026](https://img.shields.io/badge/NASA%20Space%20Apps-2026-0B3D91?style=for-the-badge&logo=nasa&logoColor=white)](https://www.spaceappschallenge.org/)
[![Challenge: Field Shift](https://img.shields.io/badge/Challenge-Field%20Shift%3A%20Adapting%20Farms-2E7D32?style=for-the-badge)](https://www.spaceappschallenge.org/)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![MapLibre GL JS](https://img.shields.io/badge/MapLibre%20GL-396CB2?style=for-the-badge&logo=maplibre&logoColor=white)](https://maplibre.org/)

</div>

---

## 🌍 Overview

**Field Shift** is a cloud-penetrating agro-hydrological decision-support platform built for the **2026 NASA Space Apps Challenge** (*Field Shift: Adapting Farms with NASA Data*).

Optical satellite sensors (Landsat, MODIS) are blinded by cloud cover during typhoons and monsoon events—precisely when smallholder farmers need actionable flood and waterlogging intelligence. **Field Shift** fuses **C-band Synthetic Aperture Radar (Sentinel-1 SAR)** backscatter shifts with **NASADEM 30 m micro-topography** and **NASA precipitation & agro-meteorology (NASA POWER / GPM IMERG)** on a shared 30 m grid to:

1. **Map Field Drowning Risk (`High` / `Watch` / `Low`)** across farm parcels and identify low-lying runoff channels where water pools.
2. **Validate Risk Against Observed SAR Flooding** by computing the independent spatial hit rate against post-storm standing-water masks.
3. **Rank Next-Season Crop Rotations** against the farmer's current baseline crop using bare-field windows, soil texture, and farmer priorities (*Water Conservation*, *Soil Nitrogen*, *Cash Income*).
4. **Deliver Plain-Language Advisories & $\le 160$-Character SMS Alerts** for smallholder farmers, cooperatives, agricultural extension officers, and Municipal DRRM Offices (MDRRMOs).

---

## 🌿 Branch Architecture & Team Roster

Per our 12-hour engineering checklist, three developers work across **six isolated feature branches** (two each) and merge into `main` only at the verified hour gates:

| Branch | Owner | Deliverables |
| :--- | :--- | :--- |
| `feature/risk-engine` | **Adrian** *(Main Developer / Integration Lead)* | Shared 30 m grid, rule-based Field Drowning Risk score (`0–100`), per-plot & barangay statistics, independent SAR flood hit-rate validation, and FastAPI endpoints (`api.py`). |
| `feature/sar-moisture` | **Adrian** | Sentinel-1 VV/VH before & after storm passes, Lee speckle filter, 30 m grid alignment, $\Delta\sigma^0$ wetness-change layer, observed post-storm flood extent mask, and scene provenance. |
| `feature/terrain-rain` | **Guian** | NASADEM 30 m slope, priority-flood depression filling, D8 flow accumulation, Topographic Wetness Index ($\text{TWI}$), drainage corridor extraction, GPM IMERG / NASA POWER rainfall totals, and SMAP anomaly. |
| `feature/rotation-engine` | **Guian** | Multi-year NDVI series (bare-field windows & days/year), SoilGrids texture profile, and 3 rule-ranked crop rotation strategies with local verification notes. |
| `feature/dashboard` | **Marqus** | MapLibre GL JS floating GIS dashboard (`index.html`, `app.js`, `style.css`), 3-class risk symbology, before/after SAR toggle, plot action cards, and SMS alert preview. |
| `feature/demo-submission` | **Marqus** | Pilot event record, demo storyboard & deck/video, project page text, and final judging package. |
| *Hour-Gate Review* | **Engr. John Roy V. Galvez** | Monitors Hour 1, Hour 4, Hour 7, Hour 9 (Feature Freeze), and Hour 12 gates. |

---

## 🛰️ Datasets & Sensor Fusion Grid

### Datasets Used in the Build
| Dataset | Source / Agency | Resolution | Role in Field Shift |
| :--- | :--- | :--- | :--- |
| **Sentinel-1 RTC (VV / VH)** | ESA / Copernicus (via Planetary Computer) | $10\text{ m} \to 30\text{ m}$ / 12-day | Cloud-piercing C-band ($5.405\text{ GHz}$) backscatter change ($\Delta\sigma^0_{\text{VV}}$) for surface wetness shift and post-storm standing-water flood extent. |
| **NASADEM** | NASA / JPL | $30\text{ m}$ Spatial | Micro-topographic Slope ($\beta$), D8 Flow Accumulation ($a$), drainage corridor routing, and Topographic Wetness Index ($\text{TWI} = \ln(a/\tan\beta)$). |
| **NASA POWER** | NASA LaRC | $0.5^\circ$ / Daily | Corrected daily precipitation (`PRECTOTCORR`), temperature extremes (`T2M_MAX`, `T2M_MIN`), and solar irradiance (`ALLSKY_SFC_SW_DWN`). |
| **GPM IMERG** | NASA / JAXA | $0.1^\circ$ ($\sim 10\text{ km}$) | Storm-event and 7-day antecedent rainfall accumulation totals. |
| **SMAP** | NASA | $9\text{–}36\text{ km}$ / 2–3 days | Regional coarse soil-moisture anomaly context. |
| **Landsat 8-9 / MODIS** | NASA / USGS | $30\text{ m} \text{–} 250\text{ m}$ | Multi-year NDVI time series to quantify post-harvest bare-field exposure windows (`bare_field_days_per_year`). |
| **SoilGrids 2.0 / WorldCover** | ISRIC / ESA | $250\text{ m}$ / $10\text{ m}$ | Topsoil clay/sand/silt fractions, organic carbon, and cropland masking. |

### Future Work Datasets (Roadmap)
- **NISAR (NASA-ISRO L-Band $1.25\text{ GHz}$ SAR):** Deeper canopy and sub-surface root-zone penetration ($10\text{–}30\text{ m}$).
- **ECOSTRESS (NASA JPL ISS):** $70\text{ m}$ thermal infrared Evapotranspiration ($\text{ET}$) and Evaporative Stress Index ($\text{ESI}$).
- **GRACE / GRACE-FO (NASA):** Monthly regional deep-aquifer and groundwater storage trends.

---

## 📐 Core Analytics & Frozen JSON Contract

### 1. Field Drowning Risk Formulation (`30 m` Shared Grid, `EPSG:32651` / `EPSG:4326`)
Each $30\text{ m}$ cell and farm parcel $p$ combines normalized C-band SAR wetness shift ($S_{\text{SAR}}$), Topographic Wetness Index ($S_{\text{TWI}}$), and storm rainfall ($S_{\text{Rain}}$):

$$\text{RiskScore}_p = \text{round}\Big(100 \times \big(0.45 \cdot S_{\text{SAR},p} + 0.35 \cdot S_{\text{TWI},p} + 0.20 \cdot S_{\text{Rain},p}\big)\Big)$$

- **`high` ($\ge 70$):** Immediate micro-drainage trenching / early salvage harvest.
- **`watch` ($40\text{–}69$):** Clear perimeter furrows and monitor after rain bands.
- **`low` ($< 40$):** Normal drainage; schedule post-harvest cover or legume rotation.

### 2. Frozen Frontend JSON Schema (`mock-data.json` / `GET /api/data`)
All branches read and write against the frozen contract:
- `provenance`: Pilot area, storm event reference, scene IDs, `sar_hit_rate`, `total_high_risk_ha`, `high_risk_plots`, `households_affected`, `avg_bare_field_days`, `processing_time`, `datasets_used`, `future_work_datasets`, and `scientific_limit`.
- `plots`: GeoJSON `FeatureCollection` (`PL-01` to `PL-05`) with `risk_class`, `risk_score`, `sar_wetness_change_db`, `twi_value`, `current_crop`, `bare_field_days_per_year`, `plain_language_action`, and `sms_alert` ($\le 160$ chars).
- `observed_flood_extent`: Post-storm Sentinel-1 SAR standing-water GeoJSON polygons.
- `sar_backscatter_comparison`: `before_event` and `after_event` GeoJSON layers.
- `drainage_corridor`: NASADEM flow-accumulation channel `LineString`.
- `rotation_strategies`: Three ranked rotation options (`legume`, `biotillage`, `shortcycle`) with `priorities`, `mechanics`, `benefits`, and `risks_and_gaps`.

---

## 🚀 Quick Start & Setup

### 1. Install Python Dependencies (`feature/sar-moisture` & `feature/risk-engine`)
```bash
pip install -r requirements.txt
```

### 2. Run the Data & Risk Pipelines
```bash
# Step 1: Sentinel-1 SAR calibration, Lee filter, Δσ⁰ wetness change & flood mask
python -m pipeline.sar_moisture

# Step 2: NASADEM slope, D8 flow accumulation, TWI & NASA POWER rainfall
python -m pipeline.terrain_rain

# Step 3: Fuse layers on the 30m grid, compute risk scores & hit rate, export mock-data.json
python -m pipeline.risk_engine
```

### 3. Launch the FastAPI Server & Dashboard
```bash
uvicorn api:app --reload --port 8000
```
- **Interactive Dashboard:** `http://localhost:8000/` (when merged with `feature/dashboard`)
- **OpenAPI / Swagger Docs:** `http://localhost:8000/docs`
- **Run Test Suite:** `pytest`

---

## ⚠️ Scientific Limitations & AI-Use Disclosure

1. **C-Band Surface Wetness vs. Direct Root-Zone Measurement:**
   Surface wetness and ponding layers are derived from C-band ($5.6\text{ cm}$ wavelength) Sentinel-1 SAR backscatter and NASADEM micro-topographic pooling ($\text{TWI}$), not direct in-situ sub-surface soil moisture probes. Dense canopy volume scattering and specular water reflection are accounted for separately.
2. **Decision-Support Scope:**
   Drowning risk scores and crop rotation rankings are rule-based decision aids. Farmers, cooperatives, and municipal agriculturists must verify local drainage feasibility, seed availability, soil pH, labor, and market demand before planting.
3. **Use of AI Disclosure (NASA Space Apps Compliance):**
   AI coding assistants (Claude Code and Google Gemini / Antigravity) were used for software scaffolding, geospatial pipeline structuring, documentation, and test generation. All satellite datasets, hydrological formulas, and validation metrics are computed deterministically from open NASA and ESA/Copernicus data. No NASA logos or branding were used in any AI-generated media.

---

## 📜 License
Released under the **MIT License** for the 2026 NASA Space Apps Challenge.
