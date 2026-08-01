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

**TypeScript role:** UI shell only — event handling, DOM, settings panels. Some geo math (GC line densification, bearing, haversine distance) lives in `app/src/lib/geoMath.ts` for rendering convenience; no navigation decisions or Signal K parsing in TS.

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
| Chart rendering | MapLibre GL JS | WebGL, vector + raster, globe + mercator |
| AIS / overlays | deck.gl | GPU layers on top of MapLibre |
| Business logic | Rust → WASM | Signal K parsing, AIS management, coordinate math |
| UI shell | Svelte 5 + TypeScript | Minimal; geo math helpers in `lib/geoMath.ts` |
| Native shell | Tauri 2 | Android + Windows packaging (not yet wired) |
| Data protocol | Signal K | WebSocket delta stream + REST resources API |
| Offline charts | Service Worker tile cache | PWA; Rust/Tauri disk cache planned |
| Projections | MapLibre Globe + Mercator | Globe for correctness; Rust proj crate ready for future EPSG support |

---

### ADR-008: Position source selection — no formal abstraction (yet)

**Current architecture:**

```
SK WebSocket worker ──▶ App.svelte (message handler) ──▶ stores (vesselState, route, …) ──▶ Map.svelte
Browser GPS effect  ──▶ App.svelte                   ──▶ stores
```

The stores (`vesselState`, `route`, `ais`, `track`) are the informal boundary between data sources and visualization. There is no explicit source-selection layer; `App.svelte`'s message handler and `$effect` blocks decide what to write into each store.

**Current source rules (inline in App.svelte):**
- In geo mode: vessel position/COG/SOG from browser GPS; route/course from SK is suppressed (`undefined`)
- In SK mode: all data from SK WebSocket
- AIS and track always come from SK regardless of geo mode

**Known limitation:**  
Policy is scattered across `App.svelte`. Adding a second source (NMEA USB dongle, second SK server, GRIB wind) requires touching the message handler inline.

**Future direction:**  
If sources multiply, extract a source-selector/merger layer that receives all source streams and publishes a single resolved state into the stores. Rules (which source wins per field) would be explicit and testable.


### ADR-009: SignalK data-layer replacement — Phase 0 codegen spike results

**Context:** The `signalk` crate (v0.7.0, github.com/balp/signalk) has a confirmed dispatch bug (recursive first-segment path matching lets a `.accuracy` sibling silently clobber its parent leaf, e.g. `navigation.courseOverGroundTrue.accuracy` overwriting `navigation.courseOverGroundTrue`) plus permanent gaps (discards `$source`/`timestamp`/`pgn`/`sentence` metadata, private types forcing JSON round-trips, single-maintainer/14-months-stale). Decision: replace it with a purpose-built `skdata` module. Separately, the app's v2 REST surface (`app/src/lib/signalk-api.ts`) and great-circle math (`app/src/lib/geoMath.ts`) are candidates to move into Rust/WASM. Before committing to hand-written vs. generated types, a feasibility spike tested whether `typify` (JSON Schema → Rust) and `progenitor` (OpenAPI → Rust client) could do this safely. Full spike evidence: `history://TypifySpike`, `history://ProgenitorSpike`.

**Spike 0a — typify against SignalK's real `definitions.json`/`navigation.json`: NO-GO.**
- Fails its own bar outright: generated `NumberValue`/`StringValue` fail `cargo clippy --all-targets --all-features -- -D warnings` with 5 unavoidable `clippy::derivable_impls` errors — no `TypeSpaceSettings` flag suppresses this; only a hand-edit or a blanket `#[allow]` does (even Oxide's own `cargo-typify` example output ships with blanket allows, confirming this is not avoidable by configuration).
- Two more independent disqualifiers: the unmodified `definitions.json` doesn't generate at all (hard `Err` on an unrelated GeoJSON tuple-array construct — needed manual schema pruning just to get any output), and cross-file `$ref` (`navigation.json` → `../definitions.json`, the normal shape of SignalK's per-subsystem schema split) **panics** typify outright (`external references are not supported`) with no workaround in the builder API.
- The premise that leaf values are `anyOf`-polymorphic (bare number OR object-with-metadata) doesn't hold for these two files — no such `anyOf` exists there. `allOf` merging does work cleanly (one struct per leaf), but duplicates the six common fields (`$source`/`timestamp`/`pgn`/`sentence`/`meta`/`_attr`) across every leaf struct instead of flattening — a known, documented typify limitation.

**Spike 0b — progenitor against the v2 Resources/Course/Notifications/History OpenAPI specs: qualified GO, high real-world risk.**
- All 4 specs eventually generate and pass `cargo build --target wasm32-unknown-unknown` cleanly (plain `async fn`s over reqwest's wasm `fetch()` backend — confirmed via `cargo tree`: no tokio/hyper/native-tls in the dependency graph).
- But **zero of the 4 specs work unmodified.** Every one required spec-JSON preprocessing (never generated-code edits) to route around 3 distinct upstream progenitor/typify bugs hit on essentially every operation: a panic on the universal "200 success + differently-typed `default` error" OpenAPI idiom, a `todo!()` panic on JSON-Schema `type: "null"` (which TypeBox — signalk-server's schema-export tool — emits, but is invalid in a doc declared `openapi: 3.0.0`), and a `typify::InvalidValue` panic on `anyOf`-of-enum-literals with a `default`. Fixing the first two costs **typed error decoding on 47 of 60 total operations** (downgraded to `Error<()>`). One fix (Notifications) needed a non-obvious reserved-method-name collision workaround that fails silently — only surfaces via an actual `cargo build`, not "codegen succeeded."
- **Bigger problem than the bugs:** none of the 4 v2 APIs ship a static, checked-in OpenAPI JSON file anymore (the brief's premise that Resources had one is stale — it's TS-sourced now too). The spec is reachable only via a live v2-enabled signalk-server's `/signalk/v2/api/openapi/:api` endpoint (demo.signalk.org doesn't expose v2 at all) or by shallow-cloning signalk-server and running an `npm install` + `tsc` build of a workspace package just to evaluate a TS module. **There is no stable, versioned artifact to pin a Rust build against** — every spec/dependency bump on signalk-server's side risks silently breaking or needing hand re-patching the extraction+preprocessing pipeline, with no compile-time signal until someone runs it again.

**Decision: hand-rolled for both Phase 1 (v1 data layer) and Phase 2 (v2 REST), not codegen.**
- Phase 1: typify is a clean, unconditional NO-GO — no alternative.
- Phase 2: progenitor is technically GO, but the cost (a bespoke multi-step extraction pipeline with hardcoded workarounds for 3 upstream bugs, no pinned artifact, lost typed errors on most endpoints, re-validate-by-hand on every signalk-server version bump) is worse than the problem it solves. The v2 surface being ported is ~600 LOC of straightforward `fetch()` + hand-typed interfaces — hand-writing it once in Rust, the same way `skdata` is hand-written, is more boring, more maintainable, and removes a fragile non-reproducible build dependency. Use the official OpenAPI specs (re-extracted ad hoc, same method as the spike) as a **reference to write against**, not as a codegen input.
- Fallback design from the original plan now applies to both phases unconditionally: hand-written `#[derive(Deserialize)]` types for exactly the leaves/endpoints consumed, dispatched via an exact full-leaf-path `phf::Map` (kills the accuracy-sibling bug class structurally — a `.accuracy` suffix is simply not in the map) instead of the crate's recursive segment-matching.

**Phase 1 — implemented and cut over (2026-06-28).**
- `crates/core/src/skdata.rs`: hand-rolled replacement for `crates/core/src/signalk.rs`. Exact full-leaf-path dispatch via a `phf::Map<&str, LeafKind>` (11 leaves: `mmsi`, `name`, `navigation.{position,courseOverGroundTrue,speedOverGround,headingTrue,rateOfTurn,speedThroughWater,datetime,course.{nextPoint,previousPoint,activeRoute}}`) — structurally kills the accuracy-sibling bug class; a `.accuracy` (or any other) suffix is simply absent from the map, no recursive matching left to mis-route it.
- Public surface (`Position`, `VesselState`, `CourseState`/`CoursePoint`/`ActiveRoute`, `AisTarget`, `AisColdData`, `AIS_HOT_STRIDE`, `apply_message`, `extract_vessel_state`, `extract_ais_targets`, `extract_ais_binary`, `prune_stale_vessels`) kept byte-identical in shape to the old module — `client.rs`/the generated wasm-bindgen TS surface needed only an import-path + `Storage::default()` constructor swap, zero TS-side changes (confirmed: `app/src/wasm/signalk_chart_core.d.ts` is identical modulo doc comments).
- Also fixed in the rewrite (both real, both found while building the fixture corpus, neither in the original bug report): (1) vessel-id truncation — the old crate's `V1FullFormat::apply_delta` splits the whole context on `.` and keeps only the segment right after `"vessels"`, silently truncating any id with a dotted suffix (e.g. an AIS-relay id ending `...XX`); `skdata` strips only the literal `"vessels."` prefix and keeps the rest of the id intact. (2) the old crate's `V1CourseApiActiveRouteModel` deserializes `activeRoute` as one strict, all-or-nothing struct (a missing field like `pointTotal` — which the app never reads — silently drops the *entire* active route); `skdata` extracts each `activeRoute` field independently with explicit defaults, so an incomplete/non-canonical payload degrades gracefully instead of vanishing.
- `$source` is now captured per navigation leaf internally (`Navigation::{position,cog,sog,heading}_source` in `skdata.rs`) — fixing the structural unavailability noted above — but deliberately **not** surfaced on the public `VesselState`/`AisTarget` yet: no UI/diagnostics consumer asks for it. Surface it when one does, not speculatively.
- Verification: `crates/core/tests/fixtures/` holds 6 captured/spec-verified real wire-delta fixtures (provenance in `fixtures/README.md`) used as a dual-run parity harness against the old `signalk`-crate path during development (now-deleted `tests/parity.rs`; all fixtures matched except the one designed to diverge — the accuracy-sibling bug itself, where only the fix is correct). Repurposed post-cutover as `crates/core/tests/fixtures_test.rs`, a permanent regression suite pinning `skdata` against real wire bytes. 32 Rust tests total (26 unit + 6 fixture), `cargo clippy --all-targets --all-features` clean on both host and `wasm32-unknown-unknown`, full `just check-all` green, runtime-smoke-tested in a real browser (wasm module loads, `SignalKClient`/`Position`/`VesselState` construct correctly, geo functions unaffected).
- Phase 2 (v2 REST client in Rust) and Phase 3 (`geoMath.ts` → Rust `geo` module) are separate, not started by this pass; see the plan artifact this ADR's decision was drawn from (`agent://SignalKDataLayerPlan`) for scope.

---

### ADR-010: Split/dual-pane view — app vs. pane state boundary

**Decision:** The screen can split along the longer viewport edge into two
independent chart panes (Settings toggle, draggable divider). The split forced
an explicit state boundary, now load-bearing across the whole frontend:

**Litmus test:** *data about the world* (has lon/lat) is app-level and shared;
*a way of looking at the world* (camera params, screen px) is pane-level and
replicated.

- **App (singletons):** Signal K connection/worker, AIS, own vessel, routes,
  waypoints, tracks, rulers (geographic data — rendered in both panes), MOB,
  settings, widgets, extensions, fullscreen, chart *catalog* (incl. WMTS
  resolution).
- **Pane (×2, `stores/pane.svelte.ts` → `PaneState`):** camera + projection
  (`view`), chart *selection* (`chartSel`), base layers, layer visibility,
  rotation mode, vessel follow/pinning. Created by store factories taking an
  `lsSuffix`; pane 0 keeps the legacy un-suffixed localStorage keys (zero
  migration), pane 1 uses `:1`-suffixed keys. Both panes exist eagerly; pane 1
  is only rendered while split is enabled, and is seeded from pane 0's live
  camera on its very first enable.

**No active-pane concept.** Pane-scoped controls (compass, follow, chart
picker button) are doubled *inside* each pane — the buttons carry per-pane
state, and touch location implicitly targets a pane. App-level actions never
need to ask "which pane": MOB is a fire-and-forget server POST whose marker
comes back through the shared AIS data path; the extension host API cannot
steer the camera (`map.flyTo`/`map.fitBounds` are warning no-ops — navigation
intent comes from the user); `map.getView` returns the union bbox of both
panes when split.

**Single-writer rule for per-frame shared side effects:** ruler snap-following
(dead-reckoned snap targets → `rulers.syncSnapped`) runs in ONE app-level rAF
driver (`lib/rulerSnap.ts`), never in a pane's render loop; panes only read
`currentSnapTargets()` for drag-snap hit-testing. Exception: FPS measurement
stays in Map.svelte gated on `pane.isPrimary`, because the metric deliberately
measures the throttled map tick rate (`targetFps`), which only exists inside a
map's render loop.

**Svelte 5 pitfall (cost a debugging session):** an object that needs
reference identity — like a `PaneState` compared against `panes[i]` — must be
held in `$state.raw`, never `$state`. The deep proxy breaks `===` silently and
an effect comparing/resetting it re-fires every flush, starving all app
reactivity with no error anywhere.

**Known cost:** split view runs two MapLibre + two deck.gl WebGL contexts
(~2× GPU load). Adaptive-quality work is deliberately deferred until real
on-device profiling data exists.

---

## Implemented Features (as of 2026-05)

### Navigation display
- Own-vessel position, COG vector, heading line — all with configurable appearance
- Dead-reckoning animation for AIS targets between updates
- Vessel track (breadcrumb trail) — fetched from SK REST history + live append
  - Fade-out at track start (oldest point) over min(0.5 nm, 10% of track length)
  - Antimeridian-safe, great-circle densified segments
- Active route display — fetched from SK REST on route change
  - Bearing line (vessel → next waypoint), active leg, remaining waypoints
  - Great-circle densified, antimeridian-safe (multi-crossing)
- Scale bar in nautical miles

### AIS
- Real-time AIS targets via SK WebSocket — hull polygon + icon + COG vector
- Dead-reckoning animation between position updates
- Vessel name labels
- Tap-to-popup: name, MMSI, COG, SOG, type, links to vessel tracking platforms
- AIS vessel tracks — GC densified, antimeridian-safe
- Configurable appearance: color, size, COG length, track visibility

### Chart sources
- Signal K chart list via REST API (`/signalk/v1/api/resources/charts`)
- Raster tile sources (XYZ/TMS)
- Vector tile sources (MVT/S-57 via style URL)
- WMS via WMTS/GetMap URL template
- Chart picker UI with layer ordering
- Sticky chart layer selection (remembered across sessions)

### Map interaction
- Globe and Mercator projections (toggle)
- Pan, pinch-zoom, rotate — full touch support
- Rulers: tap-to-measure great-circle distances with popup label
- Disambiguation popup for overlapping features
- Follow-vessel mode (centering)
- Map rotation modes: N-up, COG-up, HDG-up, BRG-up (bearing to active waypoint)
  - BRG mode only available when a next waypoint exists; auto-falls back to COG when route cleared
  - Manual mode when user rotates by gesture; button click resumes auto mode

### Settings
- Signal K server connection (protocol, host, port)
- Browser GPS mode: uses device GPS instead of SK position
  - Live accuracy indicator (GPS / WiFi / cell tower) with colour-coded badge
  - Approximate-permission warning (Android 12+)
  - `maximumAge: 0` — never uses cached position
  - Route/course data suppressed when in browser GPS mode
- Device compass (DeviceOrientation API) for heading when in GPS mode
- Appearance: vessel color/size, line styles for heading/COG/GC vectors
- AIS appearance: vessel color/size, COG length, track style
- Route appearance: bearing/segment/remaining line styles
- Track appearance: color, width, style, history duration (log scale)
- FPS target (performance tuning)
- Deep-link support to open specific settings tab

### Platform
- PWA (Progressive Web App) — installable, works offline
- Screen Wake Lock — prevents display dimming during navigation
- Service Worker tile cache

---

## Open Questions
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

*Last updated: 2026-08-01 — added ADR-010: split/dual-pane view, the app-vs-pane state boundary (`PaneState`), no-active-pane design, single-writer frame driver, extension camera-API removal*
