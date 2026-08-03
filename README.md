# Winga Chart Plotter

A fast and reliable sea chart plotting application for [Signal K](https://signalk.org/).

![Screenshot](docs/Screenshot_2026-05-24_09-33-15.png)

![3D Screenshot](docs/Screenshot%202026-06-14%20at%2019-25-35%20Winga%20Chart%20Plotter.png)

## Why another chart plotter for SignalK
Winga Chart Plotter is an experiment playing with WebGL technologies with the intention of building a snappy and solid chart plotter. I owe much inspiration to [Freeboard-sk](https://github.com/SignalK/freeboard-sk).

Unfortunately, my sailing tablet gets laggy as soon as Freeboard has more than 30 AIS targets, chart layers, waypoints or routes to show. Thus, Winga Chart Plotter is written with speed in mind, uses WASM for heavy computation and WebGL for rendering. It is projection-agnostic. Currently, there are two projection modes: mercator and globe and as soon as support for more projections lands in MapLibre, those will be integrated here as well. Eventually, I'd like Winga Chart Plotter not only to be a SignalK webapp, but also a mobile app with native speed.

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
E.g. notification and alarm management are currently not planned.
Being a tool for marine navigation, Winga Chart Plotter will prioritize correctness and stability over features.
WingaCP supports the very young [plotter-extensions](https://github.com/SignalK/signalk-server/pull/2773) for widgets, e.g. instruments.


## Tips

Most controls are labelled, but a few interactions are not obvious.

### Context menu
**Long-press** (touch, hold ~½ s) or **right-click** (desktop) on empty water opens a menu to navigate to that position, drop a waypoint, or start a route from there. Measurements/route-drawing always start from this menu.

### Compass button (bottom-left)
- **Tap** — cycles the chart rotation mode: North-up → COG-up → Heading-up → BRG-up (bearing to next waypoint). Modes that lack data are skipped. Tapping while in free mode returns to the last active auto mode.
- **Long-press** — toggles free-rotation mode (ring turns amber). In free mode, two-finger twist or right-click-drag rotates the chart in any direction.

### Tilting (pitch / 3D)
Drag **two fingers together up or down** (without spreading or rotating) to tilt the chart. On desktop, **right-click drag** vertically does the same.

### Follow-vessel mode (pin button)
Clicking the pin button **locks the vessel to its current position on screen** — it does not have to be in the centre. If the vessel is already visible when you click, it stays exactly where it is. Clicking the button again releases the lock.

While locked:
- **Panning the chart slides the vessel's pinned position** to wherever it ends up and follow mode stays active.
- **Panning the vessel off the edge of the screen exits follow mode**
- **Pinch-to-zoom and the zoom slider keep the vessel at its pinned position.** On desktop, the scroll wheel does the same.
- **The pinned position survives a page reload.**

If the vessel is off-screen when you click the pin, it flies back to the centre first.

### Rulers
Start with the Ruler toolbar button.
Ruler endpoints **snap to the own vessel or AIS targets**.
A snapped ruler continously updated.
Multiple rulers can coexist.
**Tap the distance/bearing label** in the middle of a ruler to get the option to remove it.

### Route planner
The route planner also doubles as a measurement tool: start a route, read off the distance, then discard it. While drawing, **tap any existing segment** to insert a new waypoint at that point. **Tap a waypoint handle** to get the option to remove it; on desktop, right-click removes it directly.

### AIS vessels
- **First tap** — highlights the vessel, loads its track history, and shows the Closest Point of Approach (CPA) calculation.
- **Second tap on the same vessel** — opens the detail popup.

### Widgets
Widgets are instrument panels (speed, depth, wind, …) powered by [plotter-extensions](https://github.com/SignalK/signalk-server/pull/2773) and installed via the Signal K app store — [winga-instrument-widgets](https://github.com/daniel-freiermuth/winga-instrument-widgets/) is a ready-made collection. Once installed, add them in the Settings menu.

Each widget has a small **⠿ badge** in its top-right corner. Clicking it enters arrange mode (the widget pulses). In arrange mode you can drag the widget anywhere on screen and resize it from the corner handle. Tap anywhere outside the widget, or wait 8 seconds, to exit.

## Known limitation

Chrome on Android doesn't seem to like the shaders of deck.gl. After closing the warnings, the map works, but no AIS targets are drawn.

## Additional features compared to Freeboard
### Game changers
- Highly customizable appearance
- WebGL rendering
- Pin vessel position on screen (now also adapted by Freeboard)
- Multiple, permanent and sticky rulers. Like the one in Navionics, but multiples.
- Split screen

### Quality of life
- 3D mode
- WMTS layer discovery
- AIS: targets to scale, dead reckoning (honoring rate-of-turn and at 60fps, whoever needs this)
- Great-circle lines for measurements, tracks, predictors and routes
- Globe projection
- Process SignalK deltas as they arrive

## Missing features compared to Freeboard
- Alarm management
- Anchor
- Radar
- Many many more

## Roadmap

- Tauri packaging
