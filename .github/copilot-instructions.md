# signalk-chart-rs — Copilot Instructions

See `KNOWLEDGE_BASE.md` for full architecture decisions, user stories, and open questions.

## Project

A professional sea chart plotting application for sailing, built on Signal K.
**Not a fork of Freeboard-SK** — a quality step forward for the ecosystem.

## Architecture

- **Rust/WASM core** — all navigation math, Signal K data model, AIS processing, coordinate transforms, routing. No navigation logic in TypeScript.
- **MapLibre GL JS** — chart rendering (WebGL). Globe projection by default.
- **deck.gl** — AIS vessel layers, vessel tracks, wind particle overlays (on top of MapLibre).
- **Svelte + TypeScript** — UI shell only (menus, panels, settings). Minimal, no map math.
- **Tauri 2** — native packaging for Android and Windows. The web app must work standalone in Firefox at all times; Tauri is packaging, not a dependency.

## Key conventions

- All coordinate math goes through the `Projection` trait in Rust — never raw lon/lat arithmetic.
- No hardcoded `EPSG:3857` in business logic.
- Tile sources always use the `{z}/{x}/{y}` URL interface regardless of backend (remote, cached, local server).
- TypeScript calls into WASM for any computation involving geo data, Signal K values, or routing.

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

- Do not put navigation math, coordinate transforms, or Signal K parsing in TypeScript/Svelte.
- Do not hardcode Web Mercator — use the projection abstraction.
- Do not design for Freeboard-SK compatibility — that would inherit its architectural constraints.
- Do not make Tauri a hard dependency — the app must run in a plain browser.
