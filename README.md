# Winga Chart Plotter

A fast and reliable sea chart plotting application for [Signal K](https://signalk.org/).

![Screenshot](docs/Screenshot_2026-05-24_09-33-15.png)

## Why another chart plotter for SignalK
Winga Chart Plotter is an experiment playing with WebGL technologies with the intention of building a snappy and solid chart plotter. I owe much inspiration to [Freeboard-sk](https://github.com/SignalK/freeboard-sk).

Unfortunately, my sailing tablet gets laggy as soon as Freeboard has more than 30 AIS target, chart layers, waypoints or routes to show. Thus, Winga Chart Plotter is written with speed in mind, uses WASM for heavy computation and WebGL for rendering. It is projection-agnostic. Currently, there are two projection modes: mercator and globe and as soon as support for more projections lands in MapLibre, those will be integrated here as well. Eventually, I'd like Winga Chart Plotter not only to be a SignalK webapp, but also a mobile app with native speed.

## Getting started
Install via SignalK's app store.
Installable as PWA.

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
make install
make dev
```

Open `http://localhost:5173`.

### Run Rust tests

```sh
cargo test
```

## Design
Do one job, do it good. This means that some features might be left to other layers. E.g. notification and alarm management as well as instrument might be left to KIP. Being a tool for marine navigation, Winga Chart Plotter will prioritize correctness and stability over features.


## Known limitation

Chrome on Android doesn't seem to like the shaders by deck.gl. After closing the warnings, the map works, but no AIS targets are drawn.

## Additional features compared to Freeboard
- Globe projection
- WebGL rendering
- WMTS layer discovery
- AIS: targets to scale, dead reckoning (honoring rate-of-turn and at 60fps, whoever needs this)
- Great-circle lines for measurements, tracks and routes
- Highly customizable appearance
- 3D mode
- Lookahead by move and lock
- Process SignalK deltas as they arrive
- Multiple, permanent and sticky rulers

## Missing features compared to Freeboard
- Alarm management
- Anchor
- Radar
- Many many more

## Roadmap

- [ ] Tauri packaging (Android)
- [ ] Wind particle overlay
- [ ] Maybe Grib support
