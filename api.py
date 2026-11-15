"""SakaSAR FastAPI server — serves the pipeline JSON and the MapLibre dashboard from one origin.

    uvicorn api:app --reload --port 8000
    → http://localhost:8000/          dashboard
    → http://localhost:8000/docs      interactive API docs

Only the four dashboard files are exposed as static content. Mounting the repo root with
StaticFiles would also publish .git/, .env and the pipeline source.
"""
from __future__ import annotations

import json
import os
import urllib.request
from enum import Enum
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "mock-data.json"
OUTLOOK_PATH = ROOT / "data" / "soil_outlook.json"
DASHBOARD_FILES = {"index.html", "app.js", "style.css", "mock-data.json", "favicon.ico", "robots.txt", "sitemap.xml", "site.webmanifest"}

app = FastAPI(title="SakaSAR API", version="1.1.0",
              description="SAR root-zone hydrology and drowning-risk data for the Camarines Sur pilot.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "HEAD", "POST", "OPTIONS"], allow_headers=["*"])

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


@app.get("/api/recommendations", tags=["data"], summary="Farmer recommendation timeline per plot")
def get_recommendations(plot_id: str | None = None) -> dict:
    recs = {f["properties"]["plot_id"]: f["properties"].get("recommendations", [])
            for f in load_data()["plots"]["features"]}
    if plot_id is None:
        return recs
    if plot_id not in recs:
        raise HTTPException(404, f"unknown plot_id {plot_id}")
    return {plot_id: recs[plot_id]}


def get_groq_api_key() -> str | None:
    key = os.environ.get("GROQ_API_KEY") or os.environ.get("groq_api_key")
    if key:
        return key.strip()
    env_file = ROOT / ".env"
    if env_file.is_file():
        try:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.upper().startswith("GROQ_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass
    return None


class AIQuestionRequest(BaseModel):
    question: str
    context: dict | None = None


@app.post("/api/ai/ask", tags=["ai"], summary="Ask SakaSAR AI grounded in NASA and project data via Groq")
def ask_ai(req: AIQuestionRequest) -> dict:
    groq_key = get_groq_api_key()
    if not groq_key:
        raise HTTPException(503, "GROQ_API_KEY not configured")

    sys_prompt = (
        "You are SakaSAR AI, an expert agricultural decision-support assistant for farmers and municipal agriculturists in the Bicol Region, Philippines. "
        "Your project was built for the 2026 NASA Space Apps Challenge (Field Shift: Adapting Farms with NASA Data).\n"
        "Ground facts:\n"
        "- Severe Tropical Storm Kristine (Trami, Oct 2024) flooded 3,137 ha of Bicol farmland across 9 of 114 municipalities (Camarines Sur carried most).\n"
        "- In our pilot Minalabac strip (Brgy. Bagongbong, Taban, Catanusan), 35.1 ha of farmland flooded; 2 of 5 rice plots (PL-01 and PL-02) are rated high drowning risk.\n"
        "- Field Drowning Risk (0-100) = 45% Sentinel-1 SAR surface wetness change (ΔVV) + 35% NASADEM terrain wetness index (TWI) + 20% GPM IMERG rainfall.\n"
        "- We forecast root-zone saturation using a PyTorch LSTM trained on 25 years (2001-2026) of NASA POWER weather & GWETROOT soil records.\n"
        "- Adaptation crop rotations: restorative legumes (mungbean/cowpea), deep-rooting cover crops (radish/sorghum), and short-cycle crops (pechay/mustard).\n"
        "- C-band radar measures surface wetness rather than direct root-zone moisture; thresholds require local validation with municipal agriculturists.\n"
        "Guidelines:\n"
        "- Be concise, direct, helpful, and scientifically accurate.\n"
        "- Format output using clean HTML (<p>, <ul>, <li>, <b>). Do NOT wrap in markdown code blocks like ```html.\n"
        "- Keep answers practical for a farmer or disaster officer in Bicol."
    )

    user_text = req.question
    if req.context:
        ctx_notes = []
        if req.context.get("town"):
            t = req.context["town"]
            ctx_notes.append(f"Selected municipality: {t.get('name')}, {t.get('province')} ({t.get('flooded_farmland_ha', 0)} ha flooded farmland, rank #{t.get('rank', 'N/A')})")
        if req.context.get("plot"):
            p = req.context["plot"]
            ctx_notes.append(f"Selected plot: {p.get('plot_id')} in {p.get('barangay')} (Risk Score: {p.get('risk_score')}/100, Class: {p.get('risk_class')})")
        if req.context.get("iso"):
            ctx_notes.append(f"Simulation date: {req.context.get('iso')}")
        if ctx_notes:
            user_text = f"[Current Map Context: {'; '.join(ctx_notes)}]\nUser Question: {req.question}"

    payload = {
        "model": "qwen/qwen3.8-27b",
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_text}
        ],
        "temperature": 0.2,
        "max_tokens": 400
    }

    groq_req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {groq_key}",
            "Content-Type": "application/json",
            "User-Agent": "SakaSAR-AI"
        }
    )

    try:
        with urllib.request.urlopen(groq_req, timeout=12) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            content = body["choices"][0]["message"]["content"].strip()
            if content.startswith("```html"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()
            if not content.startswith("<"):
                content = f"<p>{content}</p>"
            return {
                "who": "bot",
                "src": ["SakaSAR AI (Groq)", "Sentinel-1", "NASA NASADEM", "NASA POWER"],
                "html": content
            }
    except Exception as e:
        raise HTTPException(502, f"Groq request failed: {e}")


REGION_DIR = ROOT / "data" / "region"


@app.get("/data/region/{name}", tags=["data"], summary="Bicol Region flood screening files (GeoJSON, JSON, PNG overlay)")
def get_region_file(name: str) -> FileResponse:
    target = (REGION_DIR / name).resolve()
    if target.parent != REGION_DIR.resolve() or not target.is_file() or target.suffix.lower() not in {".geojson", ".json", ".png"}:
        raise HTTPException(404)
    return FileResponse(target)


@app.get("/data/soil_outlook.json", include_in_schema=False)
def get_soil_outlook_file() -> FileResponse:
    return FileResponse(OUTLOOK_PATH)


@app.get("/api/region", tags=["data"], summary="Bicol Region summary: flooded farmland by province and top towns")
def get_region_summary() -> dict:
    try:
        return json.loads((REGION_DIR / "bicol_summary.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(503, "bicol_summary.json not found — run `python -m pipeline.bicol_region`")


DATASETS_DIR = ROOT / "data" / "datasets"


@app.get("/data/datasets/{name}", tags=["data"], summary="Download one of SakaSAR's CSV datasets")
def get_dataset(name: str) -> FileResponse:
    target = (DATASETS_DIR / name).resolve()
    if target.parent != DATASETS_DIR.resolve() or not target.is_file() or target.suffix.lower() not in {".csv", ".md"}:
        raise HTTPException(404)
    return FileResponse(target, filename=name)


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def dashboard():
    index_file = ROOT / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"service": "SakaSAR API", "status": "ok", "docs": "/docs"}


ASSETS_DIR = ROOT / "assets"


@app.api_route("/assets/{name}", methods=["GET", "HEAD"], include_in_schema=False)
def dashboard_static_asset(name: str) -> FileResponse:
    """Images used by the dashboard (logo). Only plain filenames inside assets/ are served."""
    target = (ASSETS_DIR / name).resolve()
    if target.parent != ASSETS_DIR.resolve() or not target.is_file() or target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico"}:
        raise HTTPException(404)
    return FileResponse(target)


@app.api_route("/{filename}", methods=["GET", "HEAD"], include_in_schema=False)
def dashboard_asset(filename: str) -> FileResponse:
    target = ROOT / filename
    if filename not in DASHBOARD_FILES or not target.exists():
        raise HTTPException(404)
    return FileResponse(target)
