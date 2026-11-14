"""Field Shift FastAPI server — serves the pipeline JSON and the MapLibre dashboard from one origin.

    uvicorn api:app --reload --port 8000
    → http://localhost:8000/          dashboard
    → http://localhost:8000/docs      interactive API docs

Only the four dashboard files are exposed as static content. Mounting the repo root with
StaticFiles would also publish .git/, CLAUDE.md and the pipeline source.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict, deque
from enum import Enum
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import advisor

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "mock-data.json"
OUTLOOK_PATH = ROOT / "data" / "soil_outlook.json"
DASHBOARD_FILES = {"index.html", "app.js", "style.css", "mock-data.json", "advisor.js", "advisor.css"}
CHAT_LIMIT_PER_MIN = 15  # per client IP; protects the Groq quota on a public deployment

app = FastAPI(title="Field Shift API", version="1.1.0",
              description="SAR root-zone hydrology and drowning-risk data for the Camarines Sur pilot.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "DELETE"],
                   allow_headers=["*"])
_hits: dict[str, deque] = defaultdict(deque)

_cache: dict = {"mtime": None, "data": None}


def load_data() -> dict:
    """Read mock-data.json, re-reading only when the pipeline has rewritten it."""
    try:
        mtime = DATA_PATH.stat().st_mtime
    except FileNotFoundError:
        raise HTTPException(503, "mock-data.json not found — run `python -m pipeline.risk_engine`")
    if _cache["mtime"] != mtime:
        _cache["data"] = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        _cache["mtime"] = mtime
    return _cache["data"]


class Priority(str, Enum):
    nitrogen = "nitrogen"
    water = "water"
    cash = "cash"


@app.get("/api/data", tags=["data"], summary="Full dashboard JSON contract")
def get_data() -> dict:
    return load_data()


@app.get("/api/plots", tags=["data"], summary="Farm plots with risk scores (GeoJSON)")
def get_plots() -> dict:
    return load_data()["plots"]


@app.get("/api/risk-map", tags=["data"], summary="All map layers")
def get_risk_map() -> dict:
    d = load_data()
    return {k: d[k] for k in ("plots", "observed_flood_extent", "sar_backscatter_comparison", "drainage_corridor")}


@app.get("/api/rotations", tags=["data"], summary="Crop rotation strategies, optionally ranked by priority")
def get_rotations(priority: Priority | None = None) -> list:
    rotations = load_data()["rotation_strategies"]
    if priority is None:
        return rotations
    return sorted(rotations, key=lambda s: s["priorities"][priority.value])


@app.get("/api/provenance", tags=["data"], summary="Data sources, scenes and validation metrics")
def get_provenance() -> dict:
    return load_data()["provenance"]


@app.get("/api/soil-outlook", tags=["data"], summary="LSTM root-zone saturation outlook, hindcasts and accuracy")
def get_soil_outlook() -> dict:
    try:
        return json.loads(OUTLOOK_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(503, "soil_outlook.json not found — run `python -m pipeline.soil_lstm`")


# ----------------------------------------------------------------------------- AI advisor

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=1000)
    plot_id: str | None = Field(None, pattern=r"^PL-\d{2}$")
    session_id: str = Field("default", max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class NoteRequest(BaseModel):
    note: str = Field(..., min_length=3, max_length=300)


def _rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    q = _hits[ip]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= CHAT_LIMIT_PER_MIN:
        raise HTTPException(429, "Too many advisor requests — wait a minute.")
    q.append(now)


@app.post("/api/advisor/chat", tags=["advisor"], summary="Ask the crop advisor (Groq LLM, rule-based fallback)")
def advisor_chat(body: ChatRequest, request: Request) -> dict:
    _rate_limit(request)
    return advisor.chat(body.message, body.plot_id, body.session_id)


@app.get("/api/advisor/memory/{plot_id}", tags=["advisor"], summary="Long-term field notes for a plot")
def advisor_memory(plot_id: str) -> list:
    return advisor.plot_notes(plot_id)


@app.post("/api/advisor/memory/{plot_id}", tags=["advisor"], summary="Save a field note for a plot")
def advisor_add_note(plot_id: str, body: NoteRequest, request: Request) -> dict:
    _rate_limit(request)
    return advisor.remember(plot_id, body.note)


@app.delete("/api/advisor/memory/{plot_id}", tags=["advisor"], summary="Clear a plot's field notes")
def advisor_forget(plot_id: str) -> dict:
    advisor.forget(plot_id)
    return {"cleared": plot_id}


@app.get("/", include_in_schema=False)
def dashboard():
    index_file = ROOT / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"service": "Field Shift API", "status": "ok", "docs": "/docs"}


@app.get("/{filename}", include_in_schema=False)
def dashboard_asset(filename: str) -> FileResponse:
    target = ROOT / filename
    if filename not in DASHBOARD_FILES or not target.exists():
        raise HTTPException(404)
    return FileResponse(target)
