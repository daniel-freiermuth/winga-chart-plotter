import { describe, expect, it, vi } from 'vitest';
import { processRouteCoords, processTrack } from './trackProcessing';

// Keep WASM readiness permanently pending so the `!ready` fallback branch is
// deterministic. Without this, CI now builds the wasm artifact before vitest
// (see ci.yml) — `wasmInit.ts`'s `__wbg_init()` promise could settle before
// these synchronous assertions run, silently switching them onto the
// real-WASM code path and making the fallback untested depending on timing.
vi.mock('./wasmInit', () => ({ ready: new Promise<never>(() => undefined) }));

/**
 * Antimeridian-splitting and GC-densification correctness is tested Rust-side
 * (`crates/core/src/geo.rs`, `mod tests` — `split_at_antimeridian_*`,
 * `process_track_*`, `process_route_coords_*`), matching the convention for every
 * other WASM-backed math module in this codebase (`wasmGeo.ts`, `wasmRest.ts`).
 *
 * These tests cover only the pure-TS contract that runs before any WASM call:
 * the short-input early-return guards, exercised identically whether or not WASM
 * has finished loading.
 */
describe('processTrack', () => {
  it('returns raw coords and no overflow for empty input', () => {
    expect(processTrack([])).toEqual({ coords: [], overflowSegments: [], fadeStop: 0 });
  });

  it('returns raw coords and no overflow for single-point input', () => {
    const raw: [number, number][] = [[0, 10]];
    expect(processTrack(raw)).toEqual({ coords: raw, overflowSegments: [], fadeStop: 0 });
  });

  it('returns raw coords undensified while WASM is not ready (2-point input, distinct guard branch)', () => {
    // `wasmInit.ready` is mocked above to never resolve — this exercises the
    // `!ready` fallback deterministically, distinct from the `raw.length < 2`
    // guard above (2 points takes a different branch).
    const raw: [number, number][] = [[170, 10], [-170, 10]];
    expect(processTrack(raw)).toEqual({ coords: raw, overflowSegments: [], fadeStop: 0 });
  });
});

describe('processRouteCoords', () => {
  it('returns no segments for empty input', () => {
    expect(processRouteCoords([])).toEqual([]);
  });

  it('returns no segments for single-point input', () => {
    expect(processRouteCoords([[0, 10]])).toEqual([]);
  });

  it('returns raw coords as one unsplit segment while WASM is not ready (2-point input)', () => {
    const raw: [number, number][] = [[170, 10], [-170, 10]];
    expect(processRouteCoords(raw)).toEqual([raw]);
  });
});
