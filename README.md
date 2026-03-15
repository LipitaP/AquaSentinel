# 🛰️ AquaSentinel

**Automated Mining Site Environmental Damage Auditor**  
Powered by Sentinel-2 multispectral analysis · FastAPI · React 18 · Leaflet.js

---

## Overview

AquaSentinel quantifies environmental damage at mining sites by computing temporal NDVI and NDWI spectral indices across two acquisition dates (Baseline T1 vs. Current T2). Results are displayed on an interactive map with a side-by-side wipe slider and animated metric cards.

---

## Project Structure

```
AquaSentinel/
├── backend/
│   ├── engine.py          # SpectralAuditor — vectorized NDVI/NDWI + damage calc
│   ├── main.py            # FastAPI server — Geo-resolver + /api/audit endpoint
│   └── requirements.txt
├── frontend/
│   ├── index.html         # HTML entry point (Leaflet CDN, Tailwind CDN)
│   ├── src/
│   │   ├── main.jsx       # React 18 root
│   │   └── App.jsx        # Full dashboard component
│   ├── package.json
│   └── vite.config.js
└── .env.example
```

---

## Quick Start

### 1 · Backend

```powershell
cd backend

# Install dependencies
pip install -r requirements.txt

# (Optional) Set your OSM email
copy .env.example .env
# Edit .env → OSM_EMAIL=your@email.com

# Start the API server
python main.py
# → http://localhost:8000
# → Docs: http://localhost:8000/api/docs
```

### 2 · Frontend

```powershell
cd frontend

npm install
npm run dev
# → http://localhost:5173
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/audit?query=Keonjhar` | Run full spectral audit for a site |
| `GET` | `/api/hotspots` | List all 28 known mining hotspots |
| `GET` | `/api/health` | Service health check |
| `GET` | `/api/docs` | Interactive Swagger UI |

### Example Response — `/api/audit?query=Keonjhar`

```json
{
  "site_name": "Keonjhar",
  "query": "Keonjhar",
  "forest_loss_pct": 41.2,
  "water_depletion_pct": 28.7,
  "severity_index": 63.5,
  "coordinates": { "lat": 21.6272, "lon": 85.581, "bbox_km": 5.0 },
  "pixel_count": 65536,
  "processing_time_ms": 45.2,
  "data_source": "mock_sentinel2"
}
```

---

## Spectral Indices

| Index | Formula | Interpretation |
|-------|---------|----------------|
| **NDVI** | `(B8 − B4) / (B8 + B4 + ε)` | Vegetation density; decline = biomass loss |
| **NDWI** | `(B3 − B8) / (B3 + B8 + ε)` | Surface water; decline = water table depletion |

`ε = 1e-10` for numerical stability. All operations are NumPy-vectorized — no Python-level pixel loops.

---

## Known Mining Hotspots (Built-in Directory)

**Odisha:** Keonjhar, Sukinda, Joda, Barbil, Koida, Daitari, Barajamda, Tomka, Kalinga Nagar, Deojhar, Koraput, Lanjigarh, Rayagada, Damanjodi  
**Jharkhand:** Noamundi, Chiria, Gua, Kiriburu, Bolani, Chaibasa, Saranda, Jhinkpani  
**Chhattisgarh:** Bailadila, Dalli Rajhara, Rowghat  
**Goa:** Bicholim, Sanguem, Quepem

Sites not in the directory are resolved via OSM Nominatim geocoding.

---

## Connecting Live Data

To replace mock rasters with real Sentinel-2 data:

1. Register at [Copernicus Data Space](https://dataspace.copernicus.eu/)
2. Add your credentials to `.env`
3. In `main.py`, replace `_acquire_mock_rasters()` with a STAC API call using `pystac-client`:
   ```python
   from pystac_client import Client
   catalog = Client.open("https://catalogue.dataspace.copernicus.eu/stac")
   ```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Analytics | Python 3.10+, NumPy (vectorized), Rasterio |
| API | FastAPI (async), Uvicorn, Pydantic v2 |
| Geocoding | Internal hotspot dict + OSM Nominatim |
| Frontend | React 18, Vite 5 |
| Map | Leaflet.js 1.9 (CDN), ESRI/Carto tile layers |
| Styling | Tailwind CSS (Play CDN), custom Slate-950 theme |
