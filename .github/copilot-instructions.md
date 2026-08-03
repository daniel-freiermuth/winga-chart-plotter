# signalk-chart-rs — Copilot Instructions

See `KNOWLEDGE_BASE.md` for full architecture decisions, user stories, and open questions.

## Project

A professional sea chart plotting application for sailing, built on Signal K.
**Not a fork of Freeboard-SK** — a quality step forward for the ecosystem.

## Architecture

- **Rust/WASM core** — all navigation math, Signal K data model, AIS processing, coordinate transforms, routing. No navigation decisions in TypeScript (compute placement: ADR-011 in `KNOWLEDGE_BASE.md`).
- **MapLibre GL JS** — chart rendering (WebGL). Globe projection by default.
- **deck.gl** — AIS vessel layers, vessel tracks, wind particle overlays (on top of MapLibre).
- **Svelte + TypeScript** — UI shell only (menus, panels, settings). Minimal, no map math.
- **Tauri 2** — native packaging for Android and Windows (iOS feasible later). The web app must work standalone in Firefox at all times; Tauri is packaging, not a dependency.

## Key conventions

- All coordinate math goes through the `Projection` trait in Rust — never raw lon/lat arithmetic.
- No hardcoded `EPSG:3857` in business logic.
- Tile sources always use the `{z}/{x}/{y}` URL interface regardless of backend (remote, cached, local server).
- Compute placement (ADR-011): per-frame × per-entity math lives in shaders (e.g. `VesselMorphLayer` dead reckoning); TS may hold small CPU mirrors of shader math and per-frame scalar glue; everything batchable or event-frequency (Signal K parsing, GC math, CPA, routing) goes through WASM.
- Cross the JS↔WASM boundary in batches at data-change frequency — never per-item inside per-frame loops.
- Make sure that all the checkers and linters are green

## Code style

- Rust: standard `rustfmt`, `clippy` clean, no `unwrap()` in library code.
- TypeScript: strict mode, no `any`.
- Svelte: components are UI only — data flow via stores, no fetch/compute inside components.
- This codebase is entirely written by you. You have full agency and ownership of the code.
- Follow Rust idioms and clippy recommendations
- Use `profiling::scope!()` for performance-sensitive code paths
- Prefer explicit error handling over panics
- Keep functions focused and extract reusable components
- Follow clean code principles and separation of concerns.
- Values: correctness, maintainablity, boringness and defensiveness
- => fail-fast with graceful recovery
- => defensive resilience
- Performance optimizations are important should be justified with profiling data. Ask the user to help with profiling
- Think long-term
- Zero-panic
- TDD, tests first
- Unit tests, integration tests, and end-to-end tests

- PoC-first approach: prove pipeline works end-to-end, then build incrementally

## What NOT to do

- Do not put navigation math, coordinate transforms, or Signal K parsing in TypeScript/Svelte (sole exception: the small per-frame CPU mirrors defined by ADR-011).
- Do not hardcode Web Mercator — use the projection abstraction.
- Do not design for Freeboard-SK compatibility — that would inherit its architectural constraints.
- Do not make Tauri a hard dependency — the app must run in a plain browser.
