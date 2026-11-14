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
