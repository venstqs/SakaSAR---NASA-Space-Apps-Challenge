# Field Shift — Methods

How the Field Drowning Risk map is computed. Everything runs on one 30 m grid
(EPSG:32651, UTM 51N) covering the pilot strip plus a 2 km margin, and is reproducible with:

```bash
pip install -r requirements.txt
python -m pipeline.risk_engine            # uses data/cache (offline, ~1 s)
python -m pipeline.risk_engine --refresh  # re-downloads everything (~2–5 min)
uvicorn api:app --port 8000               # dashboard + API at http://localhost:8000
```

## Pilot area and event

- **Area:** rice paddies in Brgy. Bagongbong, Taban and Catanusan, Minalabac, Camarines Sur
  (Bicol River basin). Bbox `[123.1963, 13.5384, 123.2151, 13.5448]`.
- **Event:** Severe Tropical Storm Kristine (Trami), 21–26 Oct 2024.
- **Why here:** the first pilot box (Naga City) sat on residential subdivisions, where C-band radar
  cannot see standing water. A 35 × 33 km scan of the floodplain picked this strip for >60% cropland,
  <10% built-up land and a visible flood edge. The five sample plots were then placed evenly west → east,
  not on chosen flooded spots. All five are 94–100% cropland in ESA WorldCover.
- **Placeholders:** plot outlines, hectares, households, crops and bare-field days are illustrative
  until replaced with LGU parcel and census data.

## Data

| Dataset | Use |
|---|---|
| Sentinel-1 RTC γ⁰ VV/VH (ESA/Copernicus via Microsoft Planetary Computer), orbit 134 desc. | Baseline = median of 10 Aug, 22 Aug, 15 Sep, 27 Sep 2024; just-before = 9 Oct; after = 2 Nov |
| NASADEM 30 m (NASA) | Slope, flow accumulation, Topographic Wetness Index, drainage corridor |
| NASA POWER daily `PRECTOTCORR` (NASA LaRC) | Antecedent 7-day + event rainfall |
| ESA WorldCover 2021 10 m | Cropland / built-up / permanent-water mask |

**Rejected scene:** 21 Oct 2024 (05:39 PHT 22 Oct, storm peak). Wind and rain roughened water
surfaces, so permanent water brightened by a median of +5.3 dB across the region and only 30% of it
still read as water. Dark-water flood mapping fails in that scene.

## Steps

1. **SAR:** 10 m γ⁰ averaged to 30 m in linear units → Lee filter (5×5, ENL 18) → dB.
   Baseline = per-pixel median of the four Aug–Sep passes.
   **ΔVV = VV(2 Nov) − VV(baseline).** Pre-event check: VV(9 Oct) − baseline ≈ +0.3 dB (normal).
2. **Observed flood:** VV_after < τ (Otsu, bounded to −20…−12 dB, else −15 dB) **and** ΔVV < −2 dB
   **and** slope < 5° **and** not permanent water.
3. **Terrain:** slope (central differences on a 3×3-smoothed DEM, tan β ≥ 0.001) → priority-flood
   depression filling → D8 flow → upslope cells N → a = (N+1)·30 m → **TWI = ln(a / tan β)**.
4. **Rain:** R = 7 days before the event + event total (14–26 Oct 2024).

## Risk score (documented rule)

```
S_SAR  = clip(−ΔVV / 4 dB, 0, 1)
S_TWI  = clip((TWI − 5) / 10, 0, 1)
S_Rain = clip(R / 300 mm, 0, 1)

RiskScore = round(100 × (0.45·S_SAR + 0.35·S_TWI + 0.20·S_Rain))
```

| Class | Rule |
|---|---|
| high | score ≥ 70 |
| watch | 40 ≤ score < 70 |
| low | score < 40 |
| missing | no valid SAR pixel (flagged, not scored) |
| excluded | built-up or permanent water (not farmland) |

Per plot, the score uses the plot's mean ΔVV and mean TWI. Per pixel, the same rule gives the risk map,
from which per-plot and per-barangay hectares and shares in each class are computed.

## Validation (hit rate)

Share of SAR-flooded farmland cells that the map rated **high**.

- **`sar_hit_rate_terrain_only`: the independent test.** It uses the same rule without the SAR term
  (terrain + rain only), so it predicts flooding without looking at the radar.
- `sar_hit_rate` (full model): a consistency check only, because ΔVV is in both the score and the flood mask.
- `sar_hit_rate_plots`: the plot-polygon version from the original spec.

## Limits

- C-band measures **surface wetness**, not root-zone soil moisture.
- Standing water under a tall rice canopy can *brighten* VV (double bounce) and is missed by the
  dark-water rule.
- The 2 Nov after-scene is 9 days after landfall, so it shows floodwater that persisted, not the peak.
- The weights (0.45 / 0.35 / 0.20) and thresholds are expert-set, not fitted. Calibrating them against
  LGU damage reports is pilot work.
- NASA POWER is a 0.5° grid cell, so rainfall is uniform across the 2 km strip.
