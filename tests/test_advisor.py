import pytest
from fastapi.testclient import TestClient

import advisor
import api


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(advisor, "MEMORY_PATH", tmp_path / "memory.json")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    advisor._sessions.clear()
    api._hits.clear()


class FakeResp:
    def __init__(self, content):
        self._c = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"choices": [{"message": {"content": self._c}}]}


def test_rule_based_fallback_without_key():
    out = advisor.chat("What should I do now?", "PL-02", "t1")
    assert out["mode"] == "rules"
    assert "PL-02" in out["reply"] and "HIGH" in out["reply"]
    assert "Rule-based" in out["reply"]


def test_rule_based_rotation_by_priority():
    out = advisor.chat("What should I plant to save water?", "PL-05", "t2")
    assert "Water-Conserving" in out["reply"]


def test_groq_reply_grounded_and_memory_saved(monkeypatch):
    seen = {}

    def fake_post(url, headers, json, timeout):
        seen["messages"] = json["messages"]
        return FakeResp("Open the outlet now.\nREMEMBER: PL-01 east outlet blocked by silt")

    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setattr(advisor.requests, "post", fake_post)
    out = advisor.chat("The east outlet is blocked with silt", "PL-01", "t3")
    assert out["mode"] == "groq"
    assert "REMEMBER" not in out["reply"]
    assert out["remembered"][0]["note"].startswith("PL-01 east outlet")
    system = seen["messages"][0]["content"]
    assert '"plot_id": "PL-01"' in system and "soil_saturation_lstm" in system

    # long-term memory reaches a new session; short-term history stays per session
    advisor.chat("Any update?", "PL-01", "t4")
    system2 = seen["messages"][0]["content"]
    assert "east outlet blocked" in system2
    assert len(seen["messages"]) == 2  # system + new user message only (fresh session)


def test_short_term_memory_keeps_history(monkeypatch):
    calls = []
    monkeypatch.setenv("GROQ_API_KEY", "k")
    monkeypatch.setattr(advisor.requests, "post",
                        lambda url, headers, json, timeout: calls.append(json["messages"]) or FakeResp("ok"))
    advisor.chat("first", "PL-03", "same")
    advisor.chat("second", "PL-03", "same")
    roles = [m["role"] for m in calls[-1]]
    assert roles == ["system", "user", "assistant", "user"]


def test_groq_failure_falls_back(monkeypatch):
    def boom(*a, **k):
        raise advisor.requests.ConnectionError("down")

    monkeypatch.setenv("GROQ_API_KEY", "k")
    monkeypatch.setattr(advisor.requests, "post", boom)
    assert advisor.chat("hello", "PL-04")["mode"] == "rules"


def test_api_endpoints_validation_and_rate_limit():
    c = TestClient(api.app)
    r = c.post("/api/advisor/chat", json={"message": "status?", "plot_id": "PL-01"})
    assert r.status_code == 200 and r.json()["mode"] == "rules"
    assert c.post("/api/advisor/chat", json={"message": "x", "plot_id": "../etc"}).status_code == 422
    assert c.post("/api/advisor/chat", json={"message": ""}).status_code == 422
    assert c.post("/api/advisor/memory/PL-02", json={"note": "planted 1 Nov"}).status_code == 200
    assert c.get("/api/advisor/memory/PL-02").json()[0]["note"] == "planted 1 Nov"
    assert c.delete("/api/advisor/memory/PL-02").status_code == 200
    assert c.get("/api/advisor/memory/PL-02").json() == []
    assert c.get("/api/soil-outlook").json()["model"]["type"].startswith("LSTM")
    for f in ("advisor.js", "advisor.css"):
        assert c.get(f"/{f}").status_code == 200
    codes = [c.post("/api/advisor/chat", json={"message": "hi"}).status_code for _ in range(api.CHAT_LIMIT_PER_MIN)]
    assert 429 in codes


def test_waterlogged_does_not_trigger_water_saving_rotation():
    out = advisor.chat("How long will the roots stay waterlogged?", "PL-01", "t5")
    assert "Best rotation" not in out["reply"]
