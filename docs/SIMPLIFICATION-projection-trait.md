# RFC: Is the Rust `Projection` trait still a requirement?

Status: question for the owner. No code has been changed.
Measured against commit `7aa92bb`.

## What exists

`crates/core/src/projection.rs` (61 lines):

- `pub trait Projection: Send + Sync` with `forward(lon, lat) -> (x, y)`,
  `inverse(x, y) -> (lon, lat)` and `epsg_code() -> u32` (lines 1–7).
- `pub struct WebMercator` and its `impl Projection` — spherical Mercator on
  radius 6 378 137 m, EPSG 3857 (lines 9–31).
- Two unit tests, `round_trip_origin` and `round_trip_oslo` (lines 33–61).

`crates/core/src/lib.rs` exposes it with `pub mod projection;` (line 3) and
`pub use projection::{Projection, WebMercator};` (line 11).

## Why it was built

Added in `c7aa4d1` (2026-05-22, "feat: first full pipeline"); the only later
change is `ee0f199` (2026-10-01, lint policy). It implements ADR-005
(`KNOWLEDGE_BASE.md:170-188`): "abstract all coordinate math behind a Rust
trait … allows future swap to polar stereographic (EPSG:3995/3031) or any
PROJ-supported CRS". The same intent is in `KNOWLEDGE_BASE.md:81` ("Our Rust
`Projection` trait abstracts all coordinate math"), `KNOWLEDGE_BASE.md:236`
("Rust proj crate ready for future EPSG support") and the Key Conventions in
`.github/copilot-instructions.md:20` ("CRS/map transforms (screen ↔ world) go
through the `Projection` trait in Rust").

## Who uses it today

Nobody outside its own tests. Searched the whole repository, including
gitignored files, for `Projection|WebMercator|epsg_code|projection::`:

- Rust: the workspace has one member (`crates/core`); the only hits are
  `projection.rs` itself and the two `lib.rs` lines above. No glob imports of
  the crate root exist. The type is not `#[wasm_bindgen]`-exported, so no
  TypeScript caller is possible.
- TypeScript/Svelte: every `Projection` hit in `app/src` is MapLibre's
  projection mode (`ProjectionId = 'globe' | 'mercator'` in
  `stores/mapView.svelte.ts:3`, `setProjection` in `components/Map.svelte:281`,
  the picker toggle in `components/ChartPicker.svelte`). Every `WebMercator`
  hit is the WMTS tile-matrix-set identifier in `lib/wmts.ts` and its tests.
- No `proj` crate dependency exists in `crates/core/Cargo.toml`, despite
  `KNOWLEDGE_BASE.md:187,236`.

Screen ↔ world transforms are done by MapLibre: `map.project` / `map.unproject`
in `components/Map.svelte` (lines 149, 384–385, 774, 789, 792, 800, 810, 923,
1027–1028, 1124–1125), and by deck.gl in its shaders. Geodesic math in
`geo.rs` deliberately works on WGS84 `[lon, lat]` pairs and does not use the
trait (`KNOWLEDGE_BASE.md:188`). The one piece of Web Mercator math outside
MapLibre is a meters-per-pixel scale in TypeScript
(`app/src/lib/vesselLayers.ts:35-36`), which does not go through the trait
either.

So the convention "CRS transforms go through `Projection`" describes no code:
the transforms that exist go through MapLibre, and the trait has never been on
any path that renders, parses or navigates.

## The simpler design

CRS / screen ↔ world transforms are owned by MapLibre (and deck.gl); the Rust
core does no CRS transforms. If a non-Mercator CRS is ever needed, it has to
come from MapLibre anyway (`KNOWLEDGE_BASE.md:77-82`: MapLibre 5 renders only
Mercator and Globe), and a Rust seam can be introduced then, shaped by its
first real consumer.

## What would be deleted

Production code (tests and docs excluded):

| Item | Lines |
|---|---|
| `projection.rs` trait, struct, impl, doc comments (1–31) | 31 |
| `lib.rs` `pub mod projection;` and `pub use projection::{…}` | 2 |
| **Total** | **33 removed, 0 added** |

Concepts removed: 1 trait (`Projection`), 1 type (`WebMercator`), 1 public
module.

Tests that would go with it: `round_trip_origin`, `round_trip_oslo` (they test
only the deleted code). No other test references it.

Docs that would be reworded (not trimmed): ADR-005 (`KNOWLEDGE_BASE.md:170-188`)
to say CRS transforms are MapLibre's and the Rust core holds none; the bullet at
`KNOWLEDGE_BASE.md:81`; the "Rust proj crate ready" note at
`KNOWLEDGE_BASE.md:236`; the first Key Convention in
`.github/copilot-instructions.md:20`. "No hardcoded `EPSG:3857` in business
logic" (`copilot-instructions.md:21`) would stay.

## What breaks, and for whom

Nothing at runtime: no build target, wasm export or TypeScript module reaches
the trait. The only consumer of the crate in this repository is the app, through
its wasm build (`app/package.json:17`, `wasm-pack build ../crates/core`), which
cannot see non-exported Rust items. The `rlib` crate type would only matter to an
out-of-repo Rust user of `signalk-chart-core`; none is known.

What is given up is the documented extension point: a future polar
stereographic or PROJ-backed CRS in Rust would have to add a trait again.

## The question for the owner

Is a Rust-side CRS seam (ADR-005) still a requirement, given that MapLibre owns
every screen ↔ world transform and nothing has routed through `Projection`
since it was added on 2026-05-22?

- **No** → delete `projection.rs` and the two `lib.rs` lines, drop the two
  tests, and reword ADR-005, `KNOWLEDGE_BASE.md:81,236` and
  `copilot-instructions.md:20` as above.
- **Yes** → keep it, but name its first real consumer in ADR-005 and the
  copilot convention (e.g. which Rust computation needs projected
  coordinates), so the seam is exercised instead of documented only.
