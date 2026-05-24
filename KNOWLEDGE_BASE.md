# signalk-chart-rs — Living Knowledge Base

> This document is a living record of decisions, requirements, design thinking, and open questions.
> Update it as the project evolves. Treat it as the authoritative "why" behind the code.

---

## Vision

A professional, high-quality sea chart plotting application for sailing — designed for the future of the Signal K ecosystem, not as a fork or patch of what exists today.

**Guiding principle:** Build the chartplotter that Freeboard-SK would be if started today.

**Ecosystem intent:** This is not a silo. The architecture is designed so components (especially the Rust/WASM core) can be reused by other Signal K clients. Raising the ecosystem's floor, not fragmenting it.

---

## User Stories

### Core navigation
- As a sailor, I can view nautical charts (vector and raster) on my device
- As a sailor, I can see my vessel's position in real time on the chart
- As a sailor, I can pan, zoom, and rotate the chart intuitively via touch
- As a sailor, I can view my current track (breadcrumb trail)
- As a sailor, I can plan and display a route with waypoints
- As a sailor, I can follow a course to a waypoint with bearing and XTE indicators

### AIS / other vessels
- As a sailor, I can see nearby AIS targets (vessels) on the chart
- As a sailor, I can see AIS targets update in real time without chart redraw lag
- As a sailor, I can tap an AIS target to see its details (name, MMSI, COG, SOG, CPA)
- As a sailor, I can see vessel tracks for AIS targets
- As a sailor, the app handles hundreds of simultaneous AIS targets smoothly

### Wind / weather
- As a sailor, I can see an animated wind particle overlay on the chart
- As a sailor, I can see wind data sourced from Signal K (local instruments or GRIB)

### Chart sources
- As a sailor, I can use vector charts (S-57 ENC format)
- As a sailor, I can use raster charts (BSB/KAP or XYZ tile services)
- As a sailor, I can add online tile sources (OpenSeaMap, NOAA, commercial)
- As a sailor, downloaded chart tiles are cached for offline use at sea

### Offline / connectivity
- As a sailor, previously viewed chart areas work offline automatically (tile cache)
- As a sailor, I can later download chart regions explicitly for offline use
- As a sailor, I can connect to a local chart tile server when on the boat's network

### Platform
- As a sailor, the app runs on my Android tablet at the helm
- As a sailor, the app runs on my Windows navigation PC below deck
- As a sailor, I can also access the app from any browser on the boat network
- As a developer, I can develop and test the app in Firefox without any build step for the native shell

### Radar (future)
- As a sailor, I can see a radar overlay on the chart (georeferenced sweep image)
- As a sailor, I can optionally view a dedicated full-screen radar PPI display

---

## Architecture Decisions

### ADR-001: Web renderer — MapLibre GL JS

**Decision:** Use MapLibre GL JS as the primary chart rendering engine.

**Rationale:**
- Fully WebGL-native: tiles, vector features, symbols — all GPU-accelerated
- Proven in production (Felt, AWS, every major map product)
- Native support for raster tiles, vector tiles (MVT), PMTiles, WMS
- Globe projection mode — geometrically correct at all latitudes, great-circle routes render correctly
- Active open-source community, not controlled by a single vendor
- deck.gl integrates cleanly on top for AIS/particle layers — first-class support
- Wind particle animation possible via deck.gl (no equivalent in any alternative)

**Projection limitation (known, accepted):**
- MapLibre 5 supports only two projections: Mercator and Globe
- No EPSG/PROJ arbitrary projection support yet (roadmap item in the community)
- Globe mode covers 99% of sailing use cases correctly
- Our Rust `Projection` trait abstracts all coordinate math — ready to leverage MapLibre projection improvements when they arrive
- Polar stereographic (Arctic sailing) is a real gap; acceptable for current scope

**Rejected alternatives:**

- **OpenLayers 10**: tile and point rendering are now WebGL-accelerated (`WebGLTileLayer`, `WebGLVectorLayer`), but vector features (routes, tracks, chart overlays) still default to Canvas 2D `VectorLayer`. No deck.gl integration. No wind particle animation equivalent. Projection flexibility (any EPSG via proj4js, on-the-fly tile reprojection) is a genuine advantage over MapLibre, but not enough to offset the rendering and ecosystem gaps.

- **CesiumJS**: True ECEF 3D globe with double-precision WGS84 math — geometrically correct at poles. Apache 2.0, fully open. But the fundamental problem is it's the wrong tool: designed for aerospace/digital-twin 3D visualization, not 2D nautical chart work. Bundle: ~6–8 MB minified (vs MapLibre ~2.3 MB); mobile WebGL contexts under real memory pressure. 2D mode (Columbus View) is a projection of the 3D scene — awkward for traditional plan-view chart navigation. No native vector tile (MVT) support. No deck.gl integration (deck.gl explicitly integrates with MapLibre and Google Maps, not Cesium). No S-57/ENC support. Wind particles and AIS layers would need fully custom Cesium API shaders. Verdict: outstanding for its intended purpose (aerospace, smart cities, 3D tiles) — wrong choice for a sailing chartplotter.

- **Mapbox GL JS v3**: Technically closest to MapLibre (MapLibre was forked from Mapbox GL v1). Globe mode, Standard Style, deck.gl integration works. But: proprietary license — non-commercial use is free, commercial use is paid and terms can change. Vendor lock-in is fundamentally incompatible with an open ecosystem project. MapLibre was created precisely to solve this problem.

- **deck.gl standalone** (no base map): deck.gl has a `GlobeView` but it is explicitly labeled experimental with hard limitations: no `HeatmapLayer`, no `TerrainLayer`, no `MaskExtension`, tile/MVT layers experimental, high-precision only up to zoom ~12 (insufficient for harbor-scale charts). Missing the entire tile rendering pipeline that MapLibre provides. The right architecture is deck.gl *on top of* MapLibre, which is first-class supported via `MapboxOverlay`.

- **Leaflet**: Canvas/SVG, no WebGL. Excellent for lightweight embedded maps but entirely unsuitable for GPU-accelerated AIS layers, wind particles, or smooth rendering of large tile datasets. Not a serious contender for our use case.

- **Bevy**: Game engine, zero geo/cartography infrastructure, months of reinvention required.

- **egui + wgpu**: Blank slate for geo, better suited for instrument panels than chart rendering.

---

### ADR-002: Rust/WASM core

**Decision:** Implement all business logic in Rust, compiled to WebAssembly.

**Rationale:**
- Type safety and correctness for safety-critical navigation data
- Performance for AIS processing, route computation, coordinate math
- Runs in browser (WASM) and native (Tauri backend) from same codebase
- Enables sharing of the core as a library for the Signal K ecosystem

**Scope of Rust core:**
- Signal K data model (typed structs)
- AIS target management and filtering
- Coordinate transforms and projection abstraction
- Route/course computation (XTE, bearing, hull speed, laylines)
- Chart tile cache management
- S-57 parsing (future)

**TypeScript role:** UI shell only — event handling, DOM, settings panels. No navigation math in TS.

---

### ADR-003: Native shell — Tauri 2

**Decision:** Use Tauri 2 to package the web app as native Android APK and Windows EXE.

**Rationale:**
- Tauri 2.0 supports Android and Windows from one codebase
- Rust backend can access hardware: serial ports (NMEA), Bluetooth, file system
- Tile cache lives on device storage (not browser quota)
- Feels like a native app (no browser chrome)
- Development workflow: build/test in Firefox, wrap in Tauri for distribution — no code changes

**Development progression:**
1. Firefox (dev) → Service Worker tile cache
2. Tauri (production) → Rust-managed disk cache, hardware access
3. Android APK + Windows EXE from same source

---

### ADR-004: UI framework — Svelte (not Angular)

**Decision:** Use Svelte for the UI shell.

**Rationale:**
- Compiles away at build time — near-zero runtime overhead
- The map owns 95% of the CPU; the UI framework should be invisible
- Angular is appropriate for large form-heavy apps; a chartplotter is not that
- Freeboard-SK uses Angular for historical reasons (started ~2015), not architectural ones

---

### ADR-005: Projection strategy

**Decision:** Start with MapLibre Globe projection; abstract all coordinate math behind a Rust trait.

**Rationale:**
- Globe projection is geometrically correct at all latitudes including polar
- No hardcoded EPSG:3857 in business logic
- Projection trait in Rust allows future swap to polar stereographic (EPSG:3995/3031) or any PROJ-supported CRS

**Implementation:**
```rust
pub trait Projection {
    fn forward(&self, lon: f64, lat: f64) -> (f64, f64);
    fn inverse(&self, x: f64, y: f64) -> (f64, f64);
}
```

- `proj` crate provides access to 6000+ EPSG codes when needed
- All geo math goes through this interface — never raw lon/lat arithmetic

---

### ADR-006: Chart format support

**Decision:** Support both vector (S-57/MVT) and raster (XYZ/WMS/PMTiles) tile sources.

**Vector pipeline:**
```
S-57 (.000) → Rust parser → GeoJSON/MVT → MapLibre
```
- S-52 symbology (buoys, depth contours, lights) is complex — prior art in OpenCPN
- NOAA publishes free S-57 ENCs
- PMTiles as preferred offline packaging format (serverless, single file)

**Raster pipeline:**
- XYZ/TMS tiles: direct MapLibre raster source
- BSB/KAP: pre-convert to tiles via GDAL, then serve as XYZ
- WMS: MapLibre raster source with GetMap URL template

---

### ADR-007: Tile caching strategy

**Decision:** Layered caching — Service Worker in browser, Rust/Tauri on device.

| Phase | Cache mechanism | Scope |
|---|---|---|
| Browser dev | Service Worker | Session + explicit prefetch |
| Tauri/Android | Rust disk cache | Persistent, large capacity |
| Future | Local tile server | Pre-downloaded regions, MBTiles/PMTiles |

**Tile server interface:** All sources use the same `{z}/{x}/{y}` URL interface. Switching between remote, cached, and local server requires only a URL change — MapLibre is unaware.

---

## Technology Stack Summary

| Layer | Technology | Notes |
|---|---|---|
| Chart rendering | MapLibre GL JS | WebGL, vector + raster |
| AIS / overlays | deck.gl | GPU layers on top of MapLibre |
| Business logic | Rust → WASM | Projection, routing, AIS, Signal K |
| UI shell | Svelte + TypeScript | Minimal, no nav math |
| Native shell | Tauri 2 | Android + Windows packaging |
| Data protocol | Signal K | WebSocket + REST |
| Offline charts | PMTiles / MBTiles | Single-file chart regions |
| Projections | MapLibre Globe + Mercator | Globe for correctness; Rust proj crate ready for future EPSG support |

---

## Open Questions

- [ ] S-57 parsing: write our own Rust parser, or use/wrap an existing C++ parser (e.g. from GDAL via FFI)?
- [ ] S-52 symbology: implement IHO standard symbols, or start with simplified/custom nautical style?
- [ ] Signal K connection: direct WebSocket from browser, or proxied through Tauri Rust backend?
- [ ] AIS source: from Signal K only, or also direct UDP/TCP NMEA input?
- [ ] Wind data source: Signal K instruments only, or also GRIB file import?
- [ ] Radar: georeferenced overlay on MapLibre ImageSource, or separate canvas panel, or both?
- [ ] Tile cache eviction policy: LRU by age? By size? User-managed regions?
- [ ] Chart licensing: how to handle S-63 encrypted commercial ENCs?
- [ ] First target platform: Android tablet or Windows first?
- [ ] Autopilot integration: read-only (display heading/mode) or also command sending?

---

## Relationship to Freeboard-SK

Freeboard-SK is Signal K's existing chartplotter. This project does not fork it.

**What Freeboard-SK does well:**
- Signal K-native from day one
- Rich feature set (alarms, resources, autopilot, buddies, GPX, weather)
- Mature plugin ecosystem

**Why this project exists:**
- Freeboard-SK uses OpenLayers with Canvas 2D vector rendering — a performance ceiling for dense AIS, wind animation, and route/track overlays (OL's WebGL support covers tiles and points, but not general vector features)
- `fb-map.component.ts` is a 55KB monolith — OpenLayers is not behind an abstraction, it is the abstraction
- Angular is a heavy framework for a map-first application
- The project aims to demonstrate what the next level looks like

**Intended relationship:**
- Not a hostile fork — a quality step forward for the ecosystem
- Contribute learnings and ideas upstream where welcomed, but without designing *for* compatibility
- The Rust/WASM core is designed for this project's architecture first; reusability by others is a potential future benefit, not a design constraint
- Designing for Freeboard-SK compatibility would mean inheriting its data model assumptions and Angular service interfaces — exactly the baggage this project avoids

---

## Radar (Future Feature Notes)

- Signal K receives radar data via plugins (Navico, Garmin, etc.)
- Radar sweep = polar coordinate image, georeferenced to vessel position + heading
- Rendering approach: Rust converts polar sweep to georeferenced canvas image → MapLibre `ImageSource` overlay, updated each sweep rotation
- Alternative: dedicated full-screen PPI panel (separate route/view) for focused radar use
- Neither approach requires a game engine — WebGL shader or Canvas 2D sufficient for PPI

---

## Development Workflow

```
Firefox (dev, no build required for shell)
  ↓ iterate
Chromium (cross-browser validation)
  ↓ validate
Tauri dev mode (native shell testing)
  ↓ package
Android APK + Windows EXE
```

**Guiding principle:** The web app must work standalone in a browser at all times.
Tauri is packaging, not a dependency.

---

*Last updated: 2026-05-24 — refined ADR-001 after fair OL WebGL comparison*
