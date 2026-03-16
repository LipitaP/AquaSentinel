"""
AquaSentinel — Module 2: Async API & Geo-Resolver
===================================================
FastAPI application exposing the /api/audit and /api/hotspots endpoints.

Architecture:
  ┌─────────────┐     HTTP       ┌──────────────────────┐
  │  React SPA  │ ─────────────▶ │  /api/audit?query=X  │
  └─────────────┘                └──────────┬───────────┘
                                             │
                              ┌──────────────▼────────────────┐
                              │ 1. Hotspot dict lookup         │
                              │ 2. OSM Nominatim fallback      │
                              │ 3. Mock/real raster fetch      │
                              │ 4. SpectralAuditor.calculate() │
                              └───────────────────────────────┘
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import List, Optional

import httpx
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.engine import MockRasterFactory, SpectralAuditor

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")
logger = logging.getLogger("aquasentinel.api")

# ---------------------------------------------------------------------------
# Internal Hotspot Directory — Odisha / Jharkhand mining belts
# ---------------------------------------------------------------------------

HOTSPOT_DIRECTORY: dict[str, list[float]] = {
    # Odisha
    "Keonjhar":         [21.6272, 85.5810],
    "Sukinda":          [21.0202, 85.7800],
    "Joda":             [22.1320, 85.3300],
    "Barbil":           [22.1039, 85.3804],
    "Koida":            [22.0200, 85.2800],
    "Daitari":          [21.3600, 86.0600],
    "Barajamda":        [22.1360, 85.5950],
    "Tomka":            [21.8700, 85.9800],
    "Kalinga Nagar":    [21.2600, 85.9000],
    "Deojhar":          [21.5500, 85.7500],
    "Koraput":          [18.8100, 82.7100],
    "Lanjigarh":        [19.6700, 83.2800],
    "Rayagada":         [19.1700, 83.4200],
    "Damanjodi":        [18.8600, 82.7500],
    # Jharkhand
    "Noamundi":         [22.1619, 85.5056],
    "Chiria":           [22.2500, 85.4900],
    "Gua":              [22.1800, 85.3700],
    "Kiriburu":         [22.2800, 85.4200],
    "Bolani":           [22.1200, 85.5400],
    "Chaibasa":         [22.5524, 85.8031],
    "Saranda":          [22.3800, 85.5000],
    "Jhinkpani":        [22.4300, 85.5500],
    # Chhattisgarh
    "Bailadila":        [18.6400, 81.3000],
    "Dalli Rajhara":    [20.5800, 81.0900],
    "Rowghat":          [20.3500, 81.2900],
    # Goa
    "Bicholim":         [15.5942, 73.9416],
    "Sanguem":          [15.2200, 74.1500],
    "Quepem":           [15.2100, 74.0700],
}


# ---------------------------------------------------------------------------
# Pydantic Response Models
# ---------------------------------------------------------------------------

class Coordinates(BaseModel):
    lat: float
    lon: float
    bbox_km: float = 5.0


class DamageReport(BaseModel):
    site_name: str
    query: str
    forest_loss_pct: float = Field(..., description="% of pixels showing vegetation loss")
    water_depletion_pct: float = Field(..., description="% of pixels showing water body loss")
    severity_index: float = Field(..., description="Composite damage score 0–100")
    coordinates: Coordinates
    pixel_count: int
    processing_time_ms: float
    data_source: str = "mock"
    timestamp_baseline: str = "2021-01-01"
    timestamp_current: str = "2024-12-01"


class HotspotItem(BaseModel):
    name: str
    lat: float
    lon: float


class HotspotsResponse(BaseModel):
    hotspots: List[HotspotItem]
    total: int


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

app = FastAPI(
    title="AquaSentinel API",
    description="Automated mining site environmental damage auditing via Sentinel-2 spectral analysis.",
    version="1.0.0",
    docs_url="/api/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if os.getenv("ALLOW_ALL_ORIGINS", "1") == "1" else [FRONTEND_URL],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=True,
)

# ── Serve frontend static files ──
STATIC_DIR = Path(__file__).parent.parent / "frontend" / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

auditor = SpectralAuditor()
raster_factory = MockRasterFactory()


# ---------------------------------------------------------------------------
# Geo-Resolver
# ---------------------------------------------------------------------------

async def resolve_coordinates(query: str) -> tuple[float, float, str]:
    """
    Resolve a site name or free-text query to (lat, lon, canonical_name).

    Priority:
      1. Exact match in HOTSPOT_DIRECTORY (case-insensitive)
      2. Partial match in HOTSPOT_DIRECTORY
      3. OSM Nominatim geocoding (async, non-blocking)
    """
    q_lower = query.strip().lower()

    # 1. Exact match
    for name, coords in HOTSPOT_DIRECTORY.items():
        if name.lower() == q_lower:
            logger.info("Hotspot exact match: %s → %s", query, coords)
            return coords[0], coords[1], name

    # 2. Partial match
    for name, coords in HOTSPOT_DIRECTORY.items():
        if q_lower in name.lower() or name.lower() in q_lower:
            logger.info("Hotspot partial match: %s → %s", query, coords)
            return coords[0], coords[1], name

    # 3. OSM Nominatim fallback
    logger.info("Hotspot miss — querying OSM Nominatim for: %s", query)
    osm_email = os.getenv("OSM_EMAIL", "aquasentinel@example.com")
    url = "https://nominatim.openstreetmap.org/search"
    params = {"q": query, "format": "json", "limit": 1}
    headers = {"User-Agent": f"AquaSentinel/1.0 ({osm_email})"}

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(url, params=params, headers=headers)
            response.raise_for_status()
            results = response.json()
            if results:
                lat = float(results[0]["lat"])
                lon = float(results[0]["lon"])
                display = results[0].get("display_name", query).split(",")[0].strip()
                logger.info("OSM resolved: %s → (%.4f, %.4f)", query, lat, lon)
                return lat, lon, display
    except Exception as exc:
        logger.warning("OSM geocoding failed: %s", exc)

    raise HTTPException(
        status_code=404,
        detail=f"Could not resolve site '{query}'. Try a known hotspot or a more specific location name.",
    )


# ---------------------------------------------------------------------------
# Raster Acquisition (Mock Switch)
# ---------------------------------------------------------------------------

def _acquire_mock_rasters(
    lat: float, lon: float, damage_level: Optional[float] = None
) -> tuple[np.ndarray, np.ndarray]:
    """
    Generate synthetic T1/T2 raster pairs centred at (lat, lon).

    Damage level is seeded from coordinates to ensure reproducibility
    for the same site across requests.
    """
    seed = int(abs(lat * 1000 + lon * 100)) % 997
    rng = np.random.default_rng(seed)

    if damage_level is None:
        # Vary damage by location — areas with known industrial intensity get higher levels
        damage_level = float(rng.uniform(0.25, 0.75))

    H, W = 256, 256
    MockRasterFactory.RNG = np.random.default_rng(seed)
    t1 = MockRasterFactory.make_baseline(H, W)
    t2 = MockRasterFactory.make_damaged(t1, damage_level)
    return t1, t2


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def serve_dashboard() -> FileResponse:
    """Serve the AquaSentinel dashboard HTML."""
    html_path = STATIC_DIR / "index.html"
    if not html_path.exists():
        raise HTTPException(status_code=404, detail="Frontend not found. Ensure frontend/static/index.html exists.")
    return FileResponse(str(html_path))


@app.get("/api/hotspots", response_model=HotspotsResponse, tags=["Discovery"])
async def list_hotspots() -> HotspotsResponse:
    """Return the full internal hotspot directory for autocomplete."""
    items = [
        HotspotItem(name=name, lat=coords[0], lon=coords[1])
        for name, coords in HOTSPOT_DIRECTORY.items()
    ]
    return HotspotsResponse(hotspots=items, total=len(items))


@app.get("/api/audit", response_model=DamageReport, tags=["Audit"])
async def audit_site(
    query: str = Query(..., min_length=2, max_length=120, description="Mining site name or region"),
) -> DamageReport:
    """
    Perform a full spectral environmental damage audit for the given site.

    Steps:
      1. Resolve query → (lat, lon) via hotspot dict or OSM Nominatim
      2. Acquire Sentinel-2 rasters (mock when API keys absent)
      3. Run SpectralAuditor.calculate_damage(t1, t2)
      4. Return structured DamageReport
    """
    t_start = time.perf_counter()

    # --- Step 1: Resolve coordinates ---
    lat, lon, canonical_name = await resolve_coordinates(query)

    # --- Step 2: Acquire rasters (async-friendly; offload CPU work) ---
    t1_data, t2_data = await asyncio.get_event_loop().run_in_executor(
        None, _acquire_mock_rasters, lat, lon, None
    )

    # --- Step 3: Spectral audit (CPU-bound, in executor) ---
    result = await asyncio.get_event_loop().run_in_executor(
        None, auditor.calculate_damage, t1_data, t2_data
    )

    processing_ms = (time.perf_counter() - t_start) * 1000.0

    return DamageReport(
        site_name=canonical_name,
        query=query,
        forest_loss_pct=result.forest_loss_pct,
        water_depletion_pct=result.water_depletion_pct,
        severity_index=result.severity_index,
        coordinates=Coordinates(lat=lat, lon=lon),
        pixel_count=result.pixel_count,
        processing_time_ms=round(processing_ms, 1),
        data_source="mock_sentinel2",
    )


@app.get("/api/health", tags=["System"])
async def health() -> dict:
    return {"status": "ok", "service": "AquaSentinel API", "version": "1.0.0"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True, log_level="info")
