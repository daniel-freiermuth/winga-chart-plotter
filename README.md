# signalk-chart-rs

A professional sea chart plotting application for sailing, built on [Signal K](https://signalk.org/).

> **Status: Early PoC** — the core pipeline is proven end-to-end. Active development.

---

## What works today

### Rust/WASM core (`crates/core`)
- **`Projection` trait** — abstraction over geographic projections; no business logic hardcodes a CRS
- **`WebMercator` implementation** — EPSG:3857 forward/inverse transforms with sub-microdegree accuracy (tested)
- **Signal K delta parser** — parses Signal K v1 delta JSON, extracts:
  - `navigation.position` → longitude/latitude
  - `navigation.courseOverGroundTrue` → COG (radians)
  - `navigation.speedOverGround` → SOG (m/s)
  - `navigation.headingMagnetic` → heading (radians)
- **Typed `VesselState`** — immutable-style state accumulation from delta stream
- **WASM bindings** via `wasm-bindgen` — full JS/TS interop
- **5 unit tests** — projection round-trips, delta parsing, error handling

### Frontend (`app/`)
- **MapLibre GL JS** map with WebGL rendering
- **OpenStreetMap** base tile layer
- **OpenSeaMap** seamark overlay
- **Own vessel marker** — blue dot on the chart, updated from live Signal K data
- **Signal K WebSocket** connection (`/signalk/v1/stream?subscribe=self`)
- **WASM integration** — delta messages parsed in Rust, position fed to map
- **Status overlay** — live WASM and Signal K connection indicators
- **Svelte 5** UI shell (runes syntax)

### Architecture
- Full pipeline proven: **Signal K WebSocket → Rust/WASM → Svelte store → MapLibre GL**
- Browser-first: runs in Firefox with no native shell required
- Tauri-ready: no browser APIs that would block native packaging

---

## Getting started

### Prerequisites
- [Rust](https://rustup.rs/) + `wasm32-unknown-unknown` target
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- Node.js 18+
- A running [Signal K server](https://signalk.org/)

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

### Run

```sh
# 1. Build the Rust/WASM core
cd app && npm run build:wasm

# 2. Install frontend dependencies (first time only)
npm install

# 3. Start the dev server
npm run dev
```

Open `http://localhost:5173` in Firefox. Edit `src/App.svelte` to point `SIGNALK_WS` at your Signal K server.

### Run Rust tests

```sh
cargo test
```

---

## Project structure

```
signalk-chart-rs/
├── crates/
│   └── core/               # Rust/WASM core library
│       └── src/
│           ├── projection.rs   # Projection trait + WebMercator
│           └── signalk.rs      # Signal K types + delta parser
└── app/                    # Svelte + MapLibre frontend
    └── src/
        ├── App.svelte          # WebSocket → WASM → store wiring
        ├── stores/vessel.ts    # Typed vessel state store
        └── components/Map.svelte  # MapLibre map + vessel marker
```

---

## Design

See [`KNOWLEDGE_BASE.md`](./KNOWLEDGE_BASE.md) for full architecture decisions, user stories, and open questions.

**Key principles:**
- All navigation math lives in Rust — never in TypeScript
- Projection abstraction from day one — no hardcoded EPSG:3857 in business logic
- Browser-first — Tauri is packaging, not a dependency
- TDD — tests before implementation
- Zero panics in library code

---

## Roadmap

- [ ] Vessel heading/COG indicator (rotate marker)
- [ ] Breadcrumb track (accumulate positions → GeoJSON line)
- [ ] AIS targets (other vessels from Signal K)
- [ ] Globe projection mode
- [ ] Wind particle overlay
- [ ] Service Worker tile cache (offline support)
- [ ] Tauri packaging (Android + Windows)
- [ ] S-57 vector chart support
