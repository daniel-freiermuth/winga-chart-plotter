# Winga Chart Plotter

A fast and reliable sea chart plotting application for [Signal K](https://signalk.org/).

![Screenshot](docs/Screenshot_2026-05-24_09-33-15.png)

![3D Screenshot](docs/Screenshot%202026-06-14%20at%2019-25-35%20Winga%20Chart%20Plotter.png)

## Why another chart plotter for SignalK
Winga Chart Plotter is an experiment playing with WebGL technologies with the intention of building a snappy and solid chart plotter. I owe much inspiration to [Freeboard-sk](https://github.com/SignalK/freeboard-sk).

Unfortunately, my sailing tablet gets laggy as soon as Freeboard has more than 30 AIS target, chart layers, waypoints or routes to show. Thus, Winga Chart Plotter is written with speed in mind, uses WASM for heavy computation and WebGL for rendering. It is projection-agnostic. Currently, there are two projection modes: mercator and globe and as soon as support for more projections lands in MapLibre, those will be integrated here as well. Eventually, I'd like Winga Chart Plotter not only to be a SignalK webapp, but also a mobile app with native speed.

## Getting started
Install via SignalK's app store.
The page is installable as PWA.

Widget can be added in the Settings menu.

Raster (XYZ, WTS, WMTS) and vector (MLT, MVT) chart tiles are supported.
Vector tiles need to bring a their styling via json.

S57-ish charts are supported after conversion into tiles (e.g. via [quilt-tiler](https://github.com/daniel-freiermuth/quilt-tiler), [s57-tiler](https://github.com/wdantuma/s57-tiler), [tippecanoe](https://github.com/felt/tippecanoe) or [versatiles](https://github.com/versatiles-org/versatiles-rs)).


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
Do one job, do it good.
This means that some features might be left to other layers.
E.g. notification and alarm management as well as instrument might be left to KIP.
Being a tool for marine navigation, Winga Chart Plotter will prioritize correctness and stability over features.
WingaCP supports the very young [plotter-extensions](https://github.com/SignalK/signalk-server/pull/2773) for widgets.


## Known limitation

Chrome on Android doesn't seem to like the shaders by deck.gl. After closing the warnings, the map works, but no AIS targets are drawn.

## Additional features compared to Freeboard
### Game changers
- Highly customizable appearance
- WebGL rendering
- Pin vessel position on screen
- Multiple, permanent and sticky rulers. Like the one in Navionics, but more.

### Quality of life
- 3D mode
- WMTS layer discovery
- AIS: targets to scale, dead reckoning (honoring rate-of-turn and at 60fps, whoever needs this)
- Great-circle lines for measurements, tracks and routes
- Globe projection
- Process SignalK deltas as they arrive

## Missing features compared to Freeboard
- Alarm management
- Anchor
- Radar
- Many many more

## Roadmap

- [ ] Tauri packaging (Android)
- [ ] Wind particle overlay
- [ ] Maybe Grib support
