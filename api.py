"""Field Shift FastAPI server — serves the pipeline JSON and the MapLibre dashboard from one origin.

    uvicorn api:app --reload --port 8000
    → http://localhost:8000/          dashboard
    → http://localhost:8000/docs      interactive API docs

Only the four dashboard files are exposed as static content. Mounting the repo root with
StaticFiles would also publish .git/, CLAUDE.md and the pipeline source.
"""
from __future__ import annotations

import json
from enum import Enum
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "mock-data.json"
OUTLOOK_PATH = ROOT / "data" / "soil_outlook.json"
DASHBOARD_FILES = {"index.html", "app.js", "style.css", "mock-data.json", "outlook.js", "outlook.css"}

app = FastAPI(title="Field Shift API", version="1.1.0",
              description="SAR root-zone hydrology and drowning-risk data for the Camarines Sur pilot.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

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
