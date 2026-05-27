# Winga Chart Plotter

A fast and reliable sea chart plotting application for [Signal K](https://signalk.org/).

![Screenshot](docs/Screenshot_2026-05-24_09-33-15.png)

## Why another chart plotter for SignalK
Winga Chart Plotter is an experiment playing with WebGL technologies with the intention of building a snappy and solid chart plotter. I owe much inspiration to [Freeboard-sk](https://github.com/SignalK/freeboard-sk).

Unfortunately, my sailing tablet gets laggy as soon as Freeboard has more than 30 AIS target, chart layers, waypoints or routes to show. Thus, Winga Chart Plotter is written with speed in mind, uses WASM for heavy computation and WebGL for rendering. It is projection-agnostic. Currently, there are two projection modes: mercator and globe and as soon as support for more projections lands in MapLibre, those will be integrated here as well. I'd like Winga Chart Plotter not only to be a SignalK webapp, but also a mobile app with native speed.

## Getting started
Install via SignalK's app store.

## Building
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

Open `http://localhost:5173`. Edit `src/App.svelte` to point `SIGNALK_WS` at your Signal K server.

### Deploy

Build a production-optimised bundle into `app/dist/`:

```sh
make build
# or manually:
cd app && npm run build:wasm && npm run build
```

`app/dist/` is a self-contained static site — serve it with any HTTP server.

**Option A — standalone static server**

Any `serve`-compatible tool works:
```sh
npx serve app/dist
# or nginx, caddy, etc.
```

**Option B — install as PWA**

With the dev server or any of the above servers running, open the app in Chrome/Edge/Firefox and use "Add to Home Screen" / "Install app".

### Run Rust tests

```sh
cargo test
```

## Design
Do one task, do it good. This means that some features might be left to other layers. E.g. notification and alarm management as well as instrument might be left to KIP. Being a tool for marine navigation, Winga Chart Plotter will prioritize correctness and stability over features.


See [`KNOWLEDGE_BASE.md`](./KNOWLEDGE_BASE.md) for full architecture decisions, user stories, and open questions.

## Additional features compared to Freeboard
- Globe projection
- WebGL rendering
- WMTS layer discovery
- AIS target to scale
- Great-circle lines for measurements, tracks and routes
- Highly customizable appearance
- 3D mode
- Process SignalK deltas as they arrive
- Multiple, permanent and sticky rulers
- AIS dead reckoning (honoring rate-of-turn and at 30fps, whoever this needs)

## Missing features compared to Freeboard
- S57 support (planned)
- Alarm management
- Anchor (planned)
- Many many more

## Roadmap

- [ ] Tracks
- [ ] Tauri packaging (Android)
- [ ] Wind particle overlay
- [ ] Maybe Grib support
- [ ] S-57 vector chart support
