/**
 * AquaSentinel — Module 3: Search & Damage Dashboard
 * ====================================================
 * React 18 Single-File Architecture
 *
 * Features:
 *   • Autocomplete search bar (hotspots from /api/hotspots)
 *   • Leaflet map loaded via CDN in useEffect; auto-flies to site
 *   • Side-by-side Wipe slider (baseline T1 vs current T2 tile layers)
 *   • Live Damage Statistics panel with animated metric cards
 *   • Slate-950 industrial dark aesthetic with amber/red accents
 */

import { useState, useEffect, useRef, useCallback } from 'react'

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'

// Tile URL templates (ESRI satellite for both layers — date controlled by opacity wipe)
const TILE_SATELLITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const TILE_TOPO      = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

const SEVERITY_COLOR = (score) => {
  if (score < 25) return { bg: 'bg-emerald-500/20', text: 'text-emerald-400', ring: 'ring-emerald-500', dot: '#10b981', label: 'LOW' }
  if (score < 50) return { bg: 'bg-yellow-500/20',  text: 'text-yellow-400',  ring: 'ring-yellow-500',  dot: '#eab308', label: 'MODERATE' }
  if (score < 75) return { bg: 'bg-orange-500/20',  text: 'text-orange-400',  ring: 'ring-orange-500',  dot: '#f97316', label: 'HIGH' }
  return              { bg: 'bg-red-500/20',     text: 'text-red-400',     ring: 'ring-red-500',     dot: '#ef4444', label: 'CRITICAL' }
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api'

// ──────────────────────────────────────────────────────────────────────────────
// Utility: load external script/link once
// ──────────────────────────────────────────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return }
    const s = document.createElement('script')
    s.src = src; s.async = true
    s.onload = resolve; s.onerror = reject
    document.head.appendChild(s)
  })
}

function loadLink(href) {
  if (document.querySelector(`link[href="${href}"]`)) return
  const l = document.createElement('link')
  l.rel = 'stylesheet'; l.href = href
  document.head.appendChild(l)
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────

/** Animated percentage counter */
function CountUp({ value, decimals = 1, duration = 1200 }) {
  const [display, setDisplay] = useState(0)
  const raf = useRef(null)
  useEffect(() => {
    const start = performance.now()
    const end = parseFloat(value) || 0
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(+(eased * end).toFixed(decimals))
      if (t < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [value, decimals, duration])
  return <>{display.toFixed(decimals)}</>
}

/** Single metric card */
function MetricCard({ icon, label, value, unit, color, sublabel }) {
  return (
    <div className={`relative overflow-hidden rounded-xl p-5 border border-slate-700/50 bg-slate-800/60 backdrop-blur-sm transition-all duration-300 hover:border-slate-600 hover:bg-slate-800/80 fade-in`}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-xl">{icon}</span>
        {sublabel && (
          <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${color.bg} ${color.text} ring-1 ${color.ring}/30`}>
            {sublabel}
          </span>
        )}
      </div>
      <div className={`text-3xl font-bold ${color.text} font-mono`}>
        <CountUp value={value} decimals={1} />
        <span className="text-sm font-normal ml-1 text-slate-400">{unit}</span>
      </div>
      <p className="text-xs text-slate-500 mt-1 uppercase tracking-wider">{label}</p>

      {/* Background glow */}
      <div className={`absolute -right-4 -bottom-4 w-24 h-24 rounded-full blur-2xl opacity-10 ${color.bg}`} />
    </div>
  )
}

/** Loading skeleton card */
function SkeletonCard() {
  return (
    <div className="rounded-xl p-5 border border-slate-700/50 bg-slate-800/60 space-y-3">
      <div className="skeleton h-4 w-8" />
      <div className="skeleton h-8 w-24" />
      <div className="skeleton h-3 w-32" />
    </div>
  )
}

/** Wipe slider control */
function WipeSlider({ value, onChange }) {
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs text-slate-500 mb-1 px-1">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
          Baseline (T1)
        </span>
        <span className="flex items-center gap-1">
          Current (T2)
          <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
        </span>
      </div>
      <input
        id="wipe-slider"
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="wipe-slider w-full h-1"
        aria-label="Satellite imagery wipe slider"
      />
      <p className="text-center text-xs text-slate-600 mt-1">Drag to compare satellite layers</p>
    </div>
  )
}

/** Search autocomplete */
function SearchBar({ hotspots, onSelect, loading }) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleInput = (e) => {
    const val = e.target.value
    setQuery(val)
    if (val.length < 1) { setSuggestions([]); setOpen(false); return }
    const filtered = hotspots.filter(h =>
      h.name.toLowerCase().includes(val.toLowerCase())
    ).slice(0, 8)
    setSuggestions(filtered)
    setOpen(true)
  }

  const handleSelect = (hotspot) => {
    setQuery(hotspot.name)
    setOpen(false)
    setSuggestions([])
    onSelect(hotspot.name)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (query.trim()) { setOpen(false); onSelect(query.trim()) }
  }

  return (
    <div ref={ref} className="relative w-full max-w-2xl">
      <form onSubmit={handleSubmit} className="relative">
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <input
          id="site-search"
          type="text"
          value={query}
          onChange={handleInput}
          onFocus={() => query && setOpen(true)}
          placeholder="Search mining site — e.g. Keonjhar, Sukinda, Noamundi..."
          autoComplete="off"
          className="w-full pl-12 pr-36 py-4 bg-slate-800/80 border border-slate-600/60 rounded-2xl text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 backdrop-blur-sm transition-all duration-200"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="absolute right-2 top-2 bottom-2 px-5 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-600 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm rounded-xl transition-all duration-200 flex items-center gap-2"
        >
          {loading
            ? <><span className="w-4 h-4 border-2 border-slate-950/30 border-t-slate-950 rounded-full animate-spin" /> Auditing…</>
            : <>Audit Site</>
          }
        </button>
      </form>

      {/* Dropdown */}
      {open && suggestions.length > 0 && (
        <div className="absolute top-full mt-2 w-full bg-slate-800/95 border border-slate-700/60 rounded-2xl overflow-hidden shadow-2xl z-50 backdrop-blur-md fade-in">
          {suggestions.map((h, i) => (
            <button
              key={h.name}
              onClick={() => handleSelect(h)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-700/60 transition-colors duration-150 border-b border-slate-700/30 last:border-0"
            >
              <span className="text-amber-400 text-sm">📍</span>
              <div>
                <p className="text-slate-200 text-sm font-medium">{h.name}</p>
                <p className="text-slate-500 text-xs font-mono">{h.lat.toFixed(4)}°N, {h.lon.toFixed(4)}°E</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Main App Component
// ──────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [hotspots, setHotspots]       = useState([])
  const [report, setReport]           = useState(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState(null)
  const [wipe, setWipe]               = useState(50)
  const [leafletReady, setLeafletReady] = useState(false)

  const mapRef     = useRef(null)    // DOM element
  const leafletMap = useRef(null)    // L.Map instance
  const t1Layer    = useRef(null)    // Baseline tile layer
  const t2Layer    = useRef(null)    // Current tile layer
  const markerRef  = useRef(null)

  // ── Load Leaflet via CDN once ──
  useEffect(() => {
    loadLink(LEAFLET_CSS)
    loadScript(LEAFLET_JS).then(() => setLeafletReady(true))
  }, [])

  // ── Initialise Leaflet map after CDN is ready ──
  useEffect(() => {
    if (!leafletReady || !mapRef.current || leafletMap.current) return
    const L = window.L

    leafletMap.current = L.map(mapRef.current, {
      center: [21.0, 84.5],
      zoom: 6,
      zoomControl: false,
    })

    // Zoom controls (top-right)
    L.control.zoom({ position: 'topright' }).addTo(leafletMap.current)

    // Dark basemap
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 18,
    }).addTo(leafletMap.current)

    // T1 layer — satellite (baseline, full opacity)
    t1Layer.current = L.tileLayer(TILE_SATELLITE, {
      attribution: 'ESRI World Imagery',
      maxZoom: 18,
      opacity: 1,
    }).addTo(leafletMap.current)

    // T2 layer — topo overlay (current, starts hidden)
    t2Layer.current = L.tileLayer(TILE_TOPO, {
      attribution: '© OpenStreetMap',
      maxZoom: 18,
      opacity: 0,
    }).addTo(leafletMap.current)

    // Layer control legend
    L.control.layers(
      { 'Dark Basemap': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png') },
      { 'Baseline (T1) Satellite': t1Layer.current, 'Current (T2) Overlay': t2Layer.current },
      { position: 'bottomright', collapsed: true }
    ).addTo(leafletMap.current)

  }, [leafletReady])

  // ── Wipe slider → update layer opacities ──
  useEffect(() => {
    if (!t1Layer.current || !t2Layer.current) return
    // wipe=0: full T1; wipe=100: full T2
    const t2Opacity = wipe / 100
    const t1Opacity = 1 - t2Opacity * 0.7  // keep slight baseline always visible
    t1Layer.current.setOpacity(t1Opacity)
    t2Layer.current.setOpacity(t2Opacity)
  }, [wipe])

  // ── Fetch hotspots on mount ──
  useEffect(() => {
    fetch(`${API_BASE}/hotspots`)
      .then(r => r.json())
      .then(d => setHotspots(d.hotspots || []))
      .catch(() => setHotspots([]))
  }, [])

  // ── Audit handler ──
  const handleAudit = useCallback(async (query) => {
    setLoading(true)
    setError(null)
    setReport(null)

    try {
      const res = await fetch(`${API_BASE}/audit?query=${encodeURIComponent(query)}`)
      if (!res.ok) {
        const text = await res.text()
        let detail = 'Audit failed'
        try { detail = JSON.parse(text)?.detail || text } catch { detail = text }
        throw new Error(detail || 'Audit failed')
      }
      const data = await res.json()
      setReport(data)

      // Fly map to resolved coordinates
      if (leafletMap.current && data.coordinates) {
        const { lat, lon } = data.coordinates
        const L = window.L

        leafletMap.current.flyTo([lat, lon], 13, { duration: 2.0, easeLinearity: 0.3 })

        // Remove old marker
        if (markerRef.current) leafletMap.current.removeLayer(markerRef.current)

        // Custom amber marker
        const icon = L.divIcon({
          className: '',
          html: `
            <div style="position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:36px;">
              <div style="position:absolute;width:36px;height:36px;border-radius:50%;background:#f59e0b22;border:2px solid #f59e0b;animation:pulse-ring 1.8s infinite;"></div>
              <div style="width:16px;height:16px;border-radius:50%;background:#f59e0b;border:2px solid #fef08a;box-shadow:0 0 12px #f59e0b;"></div>
            </div>`,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        })

        markerRef.current = L.marker([lat, lon], { icon })
          .addTo(leafletMap.current)
          .bindPopup(`
            <div style="font-family:Inter,sans-serif;color:#cbd5e1;min-width:160px;">
              <strong style="color:#f59e0b;font-size:14px;">${data.site_name}</strong><br/>
              <span style="font-size:12px;font-family:monospace;">${lat.toFixed(4)}°N ${lon.toFixed(4)}°E</span><br/>
              <hr style="border-color:#334155;margin:6px 0;"/>
              <span style="font-size:12px;">🌿 Biomass Loss: <strong style="color:#f97316;">${data.forest_loss_pct}%</strong></span><br/>
              <span style="font-size:12px;">💧 Water Loss: <strong style="color:#38bdf8;">${data.water_depletion_pct}%</strong></span>
            </div>
          `, { className: '' })
          .openPopup()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const sev = report ? SEVERITY_COLOR(report.severity_index) : null

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* ──── Header ──── */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/20">
            <span className="text-xl">🛰️</span>
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-100 tracking-tight leading-none">AquaSentinel</h1>
            <p className="text-xs text-slate-500 mt-0.5">Environmental Damage Auditor · Sentinel-2 Spectral Analysis</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>API Live</span>
          </div>
          <div className="text-xs font-mono text-slate-600 hidden lg:block">
            Bands: B3 · B4 · B8 · NDVI · NDWI
          </div>
        </div>
      </header>

      {/* ──── Search Bar ──── */}
      <div className="relative z-10 px-6 py-5 bg-gradient-to-b from-slate-900/90 to-transparent">
        <div className="max-w-5xl mx-auto flex flex-col items-center gap-3">
          <SearchBar hotspots={hotspots} onSelect={handleAudit} loading={loading} />
          {hotspots.length > 0 && !report && (
            <p className="text-xs text-slate-600">
              {hotspots.length} known mining hotspots indexed · Odia belt, Jharkhand, Chhattisgarh, Goa
            </p>
          )}
        </div>
      </div>

      {/* ──── Error Banner ──── */}
      {error && (
        <div className="mx-6 mb-4 px-5 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-3 fade-in">
          <span>⚠️</span>
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-300">✕</button>
        </div>
      )}

      {/* ──── Main Content: Map + Panel ──── */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 px-6 pb-6 gap-4 max-w-[1600px] w-full mx-auto">

        {/* MAP SECTION */}
        <div className="relative flex-1 min-h-[400px] lg:min-h-0 rounded-2xl overflow-hidden border border-slate-700/50 shadow-2xl">
          <div ref={mapRef} className="w-full h-full" />

          {/* Map overlay: Wipe Slider */}
          <div className="absolute bottom-4 left-4 right-4 z-[1000]">
            <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700/60 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Layer Wipe</span>
                <span className="text-xs text-slate-500 font-mono ml-auto">{wipe}%</span>
              </div>
              <WipeSlider value={wipe} onChange={setWipe} />
            </div>
          </div>

          {/* Map overlay: No-data state */}
          {!report && !loading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center bg-slate-900/70 backdrop-blur-sm rounded-2xl px-8 py-6 border border-slate-700/40">
                <div className="text-4xl mb-3">🗺️</div>
                <p className="text-slate-400 font-medium">Search a site to begin the audit</p>
                <p className="text-slate-600 text-sm mt-1">Keonjhar · Sukinda · Noamundi · Bailadila…</p>
              </div>
            </div>
          )}

          {/* Map loading indicator */}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/50 backdrop-blur-sm z-[999]">
              <div className="text-center">
                <div className="w-12 h-12 border-3 border-slate-700 border-t-amber-400 rounded-full animate-spin mx-auto mb-3" style={{ borderWidth: '3px' }} />
                <p className="text-amber-400 text-sm font-medium">Running spectral audit…</p>
                <p className="text-slate-500 text-xs mt-1">Computing NDVI · NDWI · Damage Matrix</p>
              </div>
            </div>
          )}
        </div>

        {/* SIDE PANEL */}
        <div className="lg:w-80 xl:w-96 flex flex-col gap-4 overflow-y-auto">

          {/* Site Header */}
          {report && (
            <div className="rounded-2xl border border-slate-700/50 bg-slate-800/60 backdrop-blur-sm p-5 fade-in">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-100">{report.site_name}</h2>
                  <p className="text-xs text-slate-500 font-mono mt-1">
                    {report.coordinates.lat.toFixed(4)}°N, {report.coordinates.lon.toFixed(4)}°E
                  </p>
                </div>
                <div className={`relative flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center severity-pulse`}
                  style={{ background: sev.dot + '33', border: `2px solid ${sev.dot}` }}>
                  <div className="w-3 h-3 rounded-full" style={{ background: sev.dot }} />
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-700/50 grid grid-cols-2 gap-2 text-xs text-slate-500">
                <span>Baseline: <span className="text-slate-400 font-mono">{report.timestamp_baseline}</span></span>
                <span>Current: <span className="text-slate-400 font-mono">{report.timestamp_current}</span></span>
                <span>Pixels: <span className="text-slate-400 font-mono">{report.pixel_count.toLocaleString()}</span></span>
                <span>Time: <span className="text-slate-400 font-mono">{report.processing_time_ms}ms</span></span>
              </div>
            </div>
          )}

          {/* Damage Metrics */}
          <div>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Damage Statistics</h3>

            {loading && [1,2,3].map(i => <div key={i} className="mb-3"><SkeletonCard /></div>)}

            {report && sev && (
              <div className="flex flex-col gap-3 fade-in">
                <MetricCard
                  icon="🌿"
                  label="Biomass Lost"
                  value={report.forest_loss_pct}
                  unit="%"
                  color={SEVERITY_COLOR(report.forest_loss_pct * 1.2)}
                  sublabel="NDVI↓"
                />
                <MetricCard
                  icon="💧"
                  label="Water Shrinkage"
                  value={report.water_depletion_pct}
                  unit="%"
                  color={SEVERITY_COLOR(report.water_depletion_pct * 1.2)}
                  sublabel="NDWI↓"
                />
                <MetricCard
                  icon="⚠️"
                  label="Anomaly Severity"
                  value={report.severity_index}
                  unit="/ 100"
                  color={sev}
                  sublabel={sev.label}
                />
              </div>
            )}

            {!report && !loading && (
              <div className="rounded-xl border border-slate-700/40 bg-slate-800/30 p-6 text-center">
                <p className="text-slate-600 text-sm">Awaiting audit…</p>
                <p className="text-slate-700 text-xs mt-1">Metrics will populate after site selection</p>
              </div>
            )}
          </div>

          {/* Spectral Index Legend */}
          {report && (
            <div className="rounded-2xl border border-slate-700/50 bg-slate-800/60 p-4 fade-in">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Spectral Indices</h3>
              <div className="space-y-2 text-xs">
                {[
                  { label: 'NDVI Formula', formula: '(B8 − B4) / (B8 + B4 + ε)', color: 'text-emerald-400' },
                  { label: 'NDWI Formula', formula: '(B3 − B8) / (B3 + B8 + ε)', color: 'text-sky-400' },
                ].map(({ label, formula, color }) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <span className={`font-semibold ${color}`}>{label}</span>
                    <code className="text-slate-500 font-mono bg-slate-900/60 px-2 py-1 rounded text-[11px] block">{formula}</code>
                  </div>
                ))}
              </div>
              <p className="text-slate-600 text-[10px] mt-3 leading-relaxed">
                Bands B3 (Green), B4 (Red), B8 (NIR) · Sentinel-2 MSI · 10m resolution · NumPy vectorized
              </p>
            </div>
          )}

          {/* Quick hotspot buttons */}
          {!report && !loading && hotspots.length > 0 && (
            <div className="fade-in">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Quick Access — Hotspots</h3>
              <div className="flex flex-wrap gap-2">
                {hotspots.slice(0, 10).map(h => (
                  <button
                    key={h.name}
                    onClick={() => handleAudit(h.name)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-400 hover:text-amber-400 hover:border-amber-500/40 hover:bg-slate-800 transition-all duration-150"
                  >
                    {h.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Data source note */}
          <div className="rounded-xl border border-slate-700/30 bg-slate-900/40 p-3 text-[11px] text-slate-600 leading-relaxed">
            <span className="text-amber-500/70 font-semibold">⚙ Data Source: </span>
            Mock Sentinel-2 rasters generated via <code>MockRasterFactory</code> with seeded spatial noise. Connect a live
            Copernicus STAC API to replace with true multispectral tiles.
          </div>
        </div>
      </div>

      {/* ──── Footer ──── */}
      <footer className="px-6 py-3 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-700">
        <span>AquaSentinel v1.0 · Sentinel-2 Spectral Auditor</span>
        <span className="font-mono">NumPy · FastAPI · Leaflet.js · React 18</span>
      </footer>
    </div>
  )
}
