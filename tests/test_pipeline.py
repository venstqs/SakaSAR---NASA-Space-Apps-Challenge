import numpy as np
from shapely.geometry import box

from pipeline import common as C
from pipeline import risk_engine as R
from pipeline import sar_moisture as S
from pipeline import terrain_rain as T


def test_score_normalisations_match_spec():
    approx = lambda a, b: abs(a - b) < 1e-9  # noqa: E731
    assert approx(S.s_sar(-3.6), 0.9) and S.s_sar(1.0) == 0.0 and S.s_sar(-6) == 1.0
    assert approx(T.s_twi(14.2), 0.92) and T.s_twi(3) == 0.0 and T.s_twi(20) == 1.0
    assert approx(T.s_rain(150), 0.5) and T.s_rain(900) == 1.0


def test_risk_score_and_classes():
    assert R.risk_score(0.9, 0.92, 1.0) == 93
    assert R.risk_score(0, 0, 0) == 0 and R.risk_score(1, 1, 1) == 100
    assert [R.risk_class(s) for s in (70, 69, 40, 39)] == ["high", "watch", "watch", "low"]


def test_hit_rate_geometry():
    flood = [box(123.192, 13.616, 123.194, 13.618)]
    half = [box(123.192, 13.616, 123.193, 13.618)]
    rate, ha = R.hit_rate(flood, half)
    assert abs(rate - 50) < 0.5 and ha > 0
    assert R.hit_rate(flood, [])[0] == 0
    assert R.hit_rate([], half) == (None, 0.0)


def test_lee_filter_reduces_speckle_and_keeps_mean():
    rng = np.random.default_rng(0)
    img = rng.gamma(4, 0.25, (80, 80))
    out = C.lee_filter(img, 5, 4)
    assert out.std() < img.std() * 0.7
    assert abs(out.mean() - img.mean()) < 0.02


def test_d8_accumulation_on_tilted_plane():
    # Plane draining toward column 0: every row is a chain, so the leftmost interior cell collects the rest.
    dem = np.tile(np.arange(10, dtype=float), (5, 1))
    filled = T.priority_flood(dem)
    rec = T.d8_receivers(filled)
    acc = T.flow_accumulation(filled, rec)
    assert acc[2, 0] >= 9
    assert acc[2, 9] == 0


def test_priority_flood_removes_pit():
    dem = np.full((5, 5), 10.0)
    dem[2, 2] = 1.0
    dem[0, :] = 5.0
    filled = T.priority_flood(dem)
    rec = T.d8_receivers(filled)
    assert rec[2, 2] >= 0  # pit now drains


def test_pipeline_outputs_real_data_from_cache():
    out = R.run()
    pv = out["provenance"]
    assert pv["data_mode"] == "real"
    assert len(out["plots"]["features"]) == 5


def test_pixel_classes_hit_rate_and_shares():
    score = np.array([[80.0, 69.6, 50.0], [39.4, np.nan, 10.0]])
    cls = R.classify_grid(score)
    assert cls.tolist() == [[2, 2, 1], [0, -1, 0]]
    flood = np.array([[True, False, True], [True, True, False]])
    region = np.ones_like(flood)
    assert abs(R.pixel_hit_rate(flood, cls, region) - 25.0) < 1e-9  # 1 of 4 flooded cells is high
    assert R.pixel_hit_rate(np.zeros_like(flood), cls, region) is None
    sh = R.class_shares(cls, region)
    assert sh["high_ha"] == round(2 * 0.09, 2) and sh["missing_share"] == round(1 / 6, 3)


def test_terrain_only_model_ignores_sar():
    twi = np.full((2, 2), 12.0)
    g1 = R.risk_grids(np.full((2, 2), -4.0), twi, 1.0)
    g2 = R.risk_grids(np.full((2, 2), +2.0), twi, 1.0)
    assert np.allclose(g1["terrain_score"], g2["terrain_score"])
    assert (g1["score"] > g2["score"]).all()


def test_non_farmland_excluded_from_scoring():
    cls = np.array([[2, 1], [0, 2]], dtype=np.int8)
    lc = np.array([[C.WC_CROP, C.WC_BUILT], [C.WC_WATER, C.WC_CROP]], dtype=np.uint8)
    out = R.exclude_non_farmland(cls, lc)
    assert out.tolist() == [[2, -2], [-2, 2]]
    assert R.exclude_non_farmland(cls, None) is cls


def test_rotation_fit_rules():
    from pipeline import rotation_engine as RO
    clay = {"clay_pct": 36.0, "sand_pct": 32.0, "silt_pct": 32.0, "soc_g_per_kg": 45.0, "texture": "clay loam"}
    hi = RO.plot_fit("high", clay)
    assert hi["legume"]["fit"] == "caution" and hi["biotillage"]["fit"] == "good" and hi["shortcycle"]["fit"] == "caution"
    lo = RO.plot_fit("low", {**clay, "clay_pct": 20.0})
    assert lo["legume"]["fit"] == "good" and lo["biotillage"]["fit"] == "neutral" and lo["shortcycle"]["fit"] == "good"
    assert RO._texture(32, 36) == "clay loam" and RO._texture(20, 45) == "clay"


def test_integrated_outputs_present():
    out = R.run()
    pv = out["provenance"]
    assert pv["rainfall"]["imerg"]["event_mm"] > 400            # GPM IMERG drives S_Rain
    assert abs(pv["rainfall"]["r_total_mm"] - pv["rainfall"]["power_check"]["r_total_mm"]) < 60
    assert pv["smap_rootzone_anomaly"]["z_vs_30day_baseline"] > 1
    assert pv["bare_field_check"]["status"] == "not_used"
    for f in out["plots"]["features"]:
        assert set(f["properties"]["rotation_fit"]) == {"legume", "biotillage", "shortcycle"}


def test_recommendations_timeline_per_plot():
    import json
    m = json.loads((C.ROOT / "mock-data.json").read_text(encoding="utf-8"))
    for f in m["plots"]["features"]:
        recs = f["properties"]["recommendations"]
        assert [r["when"] for r in recs] == ["Next 48 hours", "This week", "Before the next storm", "Next season"]
        assert all(r["action"] and r["why"] and r["sources"] for r in recs)
    high = next(f["properties"] for f in m["plots"]["features"] if f["properties"]["risk_class"] == "high")
    assert "trench" in high["recommendations"][0]["action"]
    assert "LSTM" in high["recommendations"][1]["sources"][0]


def test_best_rotation_skips_caution():
    from pipeline import recommend as REC
    rots = [{"id": "legume", "priorities": {"nitrogen": 1}}, {"id": "biotillage", "priorities": {"nitrogen": 2}},
            {"id": "shortcycle", "priorities": {"nitrogen": 3}}]
    fit = {"legume": {"fit": "caution"}, "biotillage": {"fit": "good"}, "shortcycle": {"fit": "caution"}}
    assert REC._best_rotation(rots, fit, "nitrogen")["id"] == "biotillage"


def test_bicol_runoff_outputs():
    """Bicol-wide runoff layer: score bounds, honest validation fields, and a non-empty drainage network."""
    import json
    from pathlib import Path
    region = Path(__file__).resolve().parent.parent / "data" / "region"
    doc = json.loads((region / "bicol_runoff.json").read_text(encoding="utf-8"))
    v = doc["validation"]
    for k in ("share_rated_high", "farmland_share_high", "land_share_high"):
        assert 0.0 <= v[k] <= 1.0
    assert v["flooded_pixels_checked"] > 0
    assert doc["rain_window"] == ["2024-10-14", "2024-10-26"]
    streams = json.loads((region / "bicol_streams.geojson").read_text(encoding="utf-8"))
    assert len(streams["features"]) > 100
    assert all(f["properties"]["up_km2"] >= doc["stream_threshold_km2"] for f in streams["features"])


def test_benchmarks_file():
    """docs/BENCHMARKS.md is generated from data/region/benchmarks.json; key metrics must be present and sane."""
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    b = json.loads((root / "data" / "region" / "benchmarks.json").read_text(encoding="utf-8"))
    assert b["field_risk"]["independent_hit_rate"].endswith("%")
    assert 0 < b["forecast"]["root_zone"]["skill_vs_persistence_pct"] < 100
    assert b["forecast_regional"]["within_1_day"] <= b["forecast_regional"]["cells"]
    assert b["rain_interpolation"]["cell_days"] > 0
    assert (root / "docs" / "BENCHMARKS.md").read_text(encoding="utf-8").startswith("# SakaSAR benchmarks")
