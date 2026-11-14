import json
from pathlib import Path

from fastapi.testclient import TestClient

from api import app

client = TestClient(app)
ROOT = Path(__file__).resolve().parent.parent

TOP_KEYS = {"provenance", "plots", "observed_flood_extent", "sar_backscatter_comparison",
            "drainage_corridor", "rotation_strategies"}
PROVENANCE_KEYS = {"pilot_area", "event_reference", "grid_resolution", "licensing_cost", "processing_time",
                   "sar_hit_rate", "total_high_risk_ha", "high_risk_plots", "households_affected",
                   "avg_bare_field_days", "datasets_used", "future_work_datasets", "scientific_limit"}
PLOT_KEYS = {"plot_id", "name", "barangay", "hectares", "households", "risk_class", "risk_score",
             "sar_wetness_change_db", "twi_value", "current_crop", "bare_field_days_per_year",
             "plain_language_action", "sms_alert"}


def test_data_matches_frozen_contract():
    d = client.get("/api/data").json()
    assert TOP_KEYS <= d.keys()
    assert PROVENANCE_KEYS <= d["provenance"].keys()
    assert [f["properties"]["plot_id"] for f in d["plots"]["features"]] == [f"PL-0{i}" for i in range(1, 6)]
    for f in d["plots"]["features"]:
        p = f["properties"]
        assert PLOT_KEYS <= p.keys()
        assert p["risk_class"] in {"high", "watch", "low"}
        assert 0 <= p["risk_score"] <= 100
        assert len(p["sms_alert"]) <= 160
        assert f["geometry"]["type"] == "Polygon"
    assert {"before_event", "after_event"} <= d["sar_backscatter_comparison"].keys()
    assert d["drainage_corridor"]["features"][0]["geometry"]["type"] == "LineString"


def test_endpoints_return_slices_of_data():
    d = client.get("/api/data").json()
    assert client.get("/api/plots").json() == d["plots"]
    assert client.get("/api/provenance").json() == d["provenance"]
    rm = client.get("/api/risk-map").json()
    assert set(rm) == {"plots", "observed_flood_extent", "sar_backscatter_comparison", "drainage_corridor"}


def test_rotations_ranked_by_priority():
    assert len(client.get("/api/rotations").json()) == 3
    for prio, first in [("nitrogen", "legume"), ("water", "shortcycle"), ("cash", "shortcycle")]:
        r = client.get("/api/rotations", params={"priority": prio}).json()
        assert r[0]["id"] == first
        ranks = [s["priorities"][prio] for s in r]
        assert ranks == sorted(ranks)
    assert client.get("/api/rotations", params={"priority": "bogus"}).status_code == 422


def test_dashboard_served_and_repo_not_exposed():
    assert client.get("/").status_code == 200
    assert client.get("/mock-data.json").json() == json.loads((ROOT / "mock-data.json").read_text(encoding="utf-8"))
    for f in ("CLAUDE.md", "api.py", ".git/config", "requirements.txt"):
        assert client.get(f"/{f}").status_code == 404


def test_soil_outlook_endpoint_and_panel_served():
    o = client.get("/api/soil-outlook").json()
    assert o["model"]["type"].startswith("LSTM")
    assert len(o["hindcasts"]) == 2 and len(o["scenario_outlook"]["cases"]) == 3
    for f in ("outlook.js", "outlook.css"):
        assert client.get(f"/{f}").status_code == 200
    assert client.post("/api/advisor/chat", json={"message": "hi"}).status_code in (404, 405)


def test_logo_served_and_assets_locked_down():
    assert client.get("/assets/sakasar-logo.png").status_code == 200
    for bad in ("/assets/..%2Fapi.py", "/assets/../CLAUDE.md", "/assets/missing.png"):
        assert client.get(bad).status_code == 404


def test_recommendations_and_datasets_endpoints():
    r = client.get("/api/recommendations", params={"plot_id": "PL-01"})
    assert r.status_code == 200 and len(r.json()["PL-01"]) == 4
    assert client.get("/api/recommendations", params={"plot_id": "PL-99"}).status_code == 404
    csv_resp = client.get("/data/datasets/pixels_30m_pilot.csv")
    assert csv_resp.status_code == 200 and csv_resp.text.startswith("lon,lat")
    for bad in ("/data/datasets/..%2F..%2Fapi.py", "/data/datasets/missing.csv"):
        assert client.get(bad).status_code == 404
