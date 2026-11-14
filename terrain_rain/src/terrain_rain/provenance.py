from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, Optional


DEFAULT_LAYER_PROVENANCE: Dict[str, Dict[str, Any]] = {
    "dem_30m": {
        "source": "GEE NASA/NASADEM_HGT/001",
        "dataset_version": "NASADEM_HGT v001",
        "dates": "2000-02 (SRTM Shuttle Radar Topography Mission)",
        "native_resolution": "30 m (1 arc-second)",
        "resampling_method": "bilinear",
        "known_limitations": (
            "Vertical datum is EGM96 geoid; cells <= 0 m represent low-lying estuarine/river "
            "channel terrain and are preserved as valid data (flagged in lowground_mask_30m). "
            "Source band 2 (swb) is all zeros in this clip and unused."
        ),
    },
    "slope_deg_30m": {
        "source": "Derived from conditioned NASADEM_HGT/001 via WhiteboxTools Slope",
        "dataset_version": "NASADEM_HGT v001 / WhiteboxTools",
        "dates": "2000-02 (static baseline terrain)",
        "native_resolution": "30 m",
        "resampling_method": "derived_on_30m_grid (from bilinear-reprojected buffered DEM)",
        "known_limitations": (
            "Computed on hydrologically conditioned (BreachDepressions --fill_pits) 30 m DEM "
            "before cropping from buffered bbox to inner bbox."
        ),
    },
    "flow_acc_m2_30m": {
        "source": "Derived from conditioned NASADEM_HGT/001 via WhiteboxTools D8FlowAccumulation",
        "dataset_version": "NASADEM_HGT v001 / WhiteboxTools",
        "dates": "2000-02 (static baseline terrain)",
        "native_resolution": "30 m",
        "resampling_method": "derived_on_30m_grid (D8 cells * 900 m2)",
        "known_limitations": (
            "Local D8 upslope contributing area is bounded by the buffered DEM extent "
            "([123.1430, 13.5441, 123.2670, 13.6659]); does not include full upstream "
            "Bicol River Basin catchment outside the buffered clip."
        ),
    },
    "twi_30m": {
        "source": "Derived from NASADEM_HGT/001 SCA and slope on buffered 30 m grid",
        "dataset_version": "NASADEM_HGT v001 / WhiteboxTools + NumPy",
        "dates": "2000-02 (static baseline terrain)",
        "native_resolution": "30 m",
        "resampling_method": "derived_on_30m_grid",
        "known_limitations": (
            "TWI = ln(SCA / tan(max(slope_deg, 0.1 deg))). Bounded by buffered DEM drainage "
            "contributing area; flat floodplain cells rely on the 0.1 deg slope floor."
        ),
    },
    "pooling_zones_30m": {
        "source": "Derived susceptibility mask from TWI, DEM elevation, and depression depth",
        "dataset_version": "v1.0 pilot rule",
        "dates": "Static topographic susceptibility prior",
        "native_resolution": "30 m",
        "resampling_method": "derived_on_30m_grid",
        "known_limitations": (
            "Binary topographic pooling susceptibility (TWI >= P80 AND (DEM <= P25 OR DEM <= 0m "
            "OR depression_depth >= 0.25m)); static terrain prior, not a hydrodynamic flood simulation."
        ),
    },
    "lowground_mask_30m": {
        "source": "Derived from NASADEM_HGT/001 on inner 30 m grid (DEM <= 0.0 m)",
        "dataset_version": "v1.0 pilot rule",
        "dates": "2000-02 (static baseline terrain)",
        "native_resolution": "30 m",
        "resampling_method": "derived_on_30m_grid",
        "known_limitations": (
            "Flags very low elevation / tidal-riverine cells (<= 0 m EGM96) where DEM vertical "
            "uncertainty and permanent/seasonal water overlap are highest."
        ),
    },
    "rain_event_mm_30m": {
        "source": "GEE NASA/GPM_L3/IMERG_V07",
        "dataset_version": "IMERG V07B Final Run (status: permanent)",
        "dates": "2024-10-21T00:00:00Z to 2024-10-26T00:00:00Z (240 half-hour images)",
        "native_resolution": "0.1 deg (~11 km)",
        "resampling_method": "nearest",
        "known_limitations": (
            "Coarse 0.1 deg (~11 km) satellite-gauge precipitation reprojected to 30 m grid via "
            "nearest-neighbor to preserve native pixel values without artificial sub-grid smoothing."
        ),
    },
    "rain_prior7d_mm_30m": {
        "source": "GEE NASA/GPM_L3/IMERG_V07",
        "dataset_version": "IMERG V07B Final Run (status: permanent)",
        "dates": "2024-10-14T00:00:00Z to 2024-10-21T00:00:00Z (336 half-hour images)",
        "native_resolution": "0.1 deg (~11 km)",
        "resampling_method": "nearest",
        "known_limitations": (
            "Coarse 0.1 deg (~11 km) pre-event 7-day accumulation reprojected to 30 m grid via "
            "nearest-neighbor."
        ),
    },
    "smap_anomaly_zscore_30m": {
        "source": "GEE NASA/SMAP/SPL4SMGP/008 (SMAP L4 Global 3-hourly 9 km / 11 km Root-Zone Soil Moisture)",
        "dataset_version": "SPL4SMGP v008",
        "dates": "Event: 2024-10-21 to 2024-10-26 vs Baseline: Oct 2021-2023 (excludes Oct 2024)",
        "native_resolution": "11000 m (~9-11 km)",
        "resampling_method": "nearest",
        "known_limitations": (
            "Coarse ~11 km model-assimilated root-zone (0-100 cm) soil moisture; 3-year October "
            "climatology baseline (2021-2023) is short due to SPL4SMGP v008 availability. "
            "30-day pre-event baseline z-score is also logged in provenance metrics."
        ),
    },
}


def build_provenance_dict(
    pilot_cfg: Dict[str, Any],
    layers_cfg: Dict[str, Any],
    extra_metrics: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Builds the structured provenance dictionary for all configured output layers."""
    layers_out: Dict[str, Any] = {}
    for layer_key, meta in layers_cfg.items():
        defaults = DEFAULT_LAYER_PROVENANCE.get(layer_key, {})
        layers_out[layer_key] = {
            "filename": meta["filename"],
            "band_name": meta["band_name"],
            "dtype": meta["dtype"],
            "nodata": meta["nodata"],
            "units": meta["units"],
            "description": meta["description"],
            "target_crs": pilot_cfg.get("crs", "EPSG:32651"),
            "target_resolution_m": float(pilot_cfg.get("resolution_m", 30.0)),
            "source": defaults.get("source", "Unknown"),
            "dataset_version": defaults.get("dataset_version", "Unknown"),
            "dates": defaults.get("dates", ""),
            "native_resolution": defaults.get("native_resolution", ""),
            "resampling_method": defaults.get("resampling_method", ""),
            "known_limitations": defaults.get("known_limitations", ""),
        }

    doc: Dict[str, Any] = {
        "pilot_name": pilot_cfg.get("pilot_name", "bicol_kristine_2024"),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "crs": pilot_cfg.get("crs", "EPSG:32651"),
        "resolution_m": float(pilot_cfg.get("resolution_m", 30.0)),
        "inner_bbox_wgs84": pilot_cfg.get("inner_bbox_wgs84"),
        "buffered_bbox_wgs84": pilot_cfg.get("buffered_bbox_wgs84"),
        "event_window": pilot_cfg.get("event_window", {}),
        "layers": layers_out,
        "metrics": extra_metrics or {},
    }
    return doc


def update_provenance(
    provenance_path: Path | str,
    pilot_cfg: Dict[str, Any],
    layers_cfg: Dict[str, Any],
    metric_key: Optional[str] = None,
    metric_value: Optional[Any] = None,
    layer_updates: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Path:
    """
    Creates or updates outputs/provenance.json, preserving previously logged metrics
    and layer details across pipeline steps.
    """
    provenance_path = Path(provenance_path)
    provenance_path.parent.mkdir(parents=True, exist_ok=True)

    existing_metrics: Dict[str, Any] = {}
    existing_layers: Dict[str, Any] = {}
    if provenance_path.exists():
        try:
            with open(provenance_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
                existing_metrics = existing.get("metrics", {})
                existing_layers = existing.get("layers", {})
        except Exception:
            pass

    if metric_key is not None:
        existing_metrics[metric_key] = metric_value

    doc = build_provenance_dict(pilot_cfg, layers_cfg, extra_metrics=existing_metrics)

    # Preserve any custom fields added to layers in earlier steps
    for k, v in existing_layers.items():
        if k in doc["layers"] and isinstance(v, dict):
            for sub_k, sub_v in v.items():
                if sub_k not in doc["layers"][k] or not doc["layers"][k][sub_k]:
                    doc["layers"][k][sub_k] = sub_v

    if layer_updates:
        for k, upd in layer_updates.items():
            if k in doc["layers"]:
                doc["layers"][k].update(upd)

    with open(provenance_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)

    return provenance_path
