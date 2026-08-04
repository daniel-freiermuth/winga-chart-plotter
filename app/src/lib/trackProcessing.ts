/**
 * Track and route coordinate processing utilities.
 *
 * Antimeridian splitting and great-circle densification are delegated to the Rust
 * `geo` module in one batched call per invocation (ADR-011 in `KNOWLEDGE_BASE.md`:
 * cross the WASM boundary in batches at data-change frequency, never per-item per
 * frame). `processTrack`/`processRouteCoords` are called when track/route data
 * changes (SK REST fetch, live append) — never inside a per-frame loop.
 *
 * Geometry correctness is tested Rust-side (`crates/core/src/geo.rs`, `mod tests`),
 * matching the convention for every other WASM-backed math module in this codebase
 * (`wasmGeo.ts`, `wasmRest.ts` — neither has TS-side math tests either). Only the
 * pure-TS guard/assert behavior below is covered by `trackProcessing.test.ts`.
 *
 * `buildTrackGradient` stays pure TS: it builds a MapLibre style expression, not
 * geo math.
 */
import {
  processTrack as wasmProcessTrack,
  processRouteCoords as wasmProcessRouteCoords,
} from '../wasm/signalk_chart_core.js';
import { ready as wasmReady } from './wasmInit';

let ready = false;
void wasmReady
  .then(() => {
    ready = true;
  })
  .catch(() => {
    // Already logged by wasmInit.ts.
  });

/**
 * Throws if called before `main.ts`'s boot gate resolved `wasmInit.ready` —
 * see `wasmGeo.ts` for the invariant this enforces.
 */
function assertReady(): void {
  if (!ready) {
    throw new Error(
      'trackProcessing: called before WASM finished loading — main.ts must await wasmInit.ready before mounting App',
    );
  }
}

export interface ProcessedTrack {
  coords: [number, number][];
  overflowSegments: [number, number][][];
  fadeStop: number;
}

/** Flatten `[lon, lat][]` into a `Float64Array` of `[lon0, lat0, lon1, lat1, …]`. */
function toFlat(pts: [number, number][]): Float64Array {
  const flat = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = pts[i]![0];
    flat[i * 2 + 1] = pts[i]![1];
  }
  return flat;
}

/**
 * Split raw track at antimeridian crossings, GC-densify each segment, and compute
 * the fade stop fraction.
 *
 * `coords` — most recent segment, carries the line-gradient.
 * `overflowSegments` — older segments, rendered as solid lines.
 *
 * Fade distance = min(0.5 nm, 10 % of total track length).
 */
export function processTrack(raw: [number, number][]): ProcessedTrack {
  if (raw.length < 2) return { coords: raw, overflowSegments: [], fadeStop: 0 };
  assertReady();
  return wasmProcessTrack(toFlat(raw)) as ProcessedTrack;
}

/**
 * Split raw route or two-point line at antimeridian crossings and GC-densify each
 * segment. Returns one densified segment per antimeridian-bounded piece, all within
 * [-360, 360].
 */
export function processRouteCoords(raw: [number, number][]): [number, number][][] {
  if (raw.length < 2) return [];
  assertReady();
  return wasmProcessRouteCoords(toFlat(raw)) as [number, number][][];
}

/**
 * Builds a MapLibre `line-gradient` expression that fades from transparent at the
 * track start (oldest point) to fully opaque at `fadeStop`, then stays opaque.
 * Used for solid-style tracks; non-solid styles use plain `line-color`.
 */
export function buildTrackGradient(color: string, fadeStop: number): unknown[] {
  const hex = color.replace('#', '');
  const r = parseInt(hex.length === 3 ? hex.charAt(0) + hex.charAt(0) : hex.slice(0, 2), 16);
  const g = parseInt(hex.length === 3 ? hex.charAt(1) + hex.charAt(1) : hex.slice(2, 4), 16);
  const b = parseInt(hex.length === 3 ? hex.charAt(2) + hex.charAt(2) : hex.slice(4, 6), 16);
  const transparent = `rgba(${String(r)},${String(g)},${String(b)},0)`;
  if (fadeStop < 0.001) {
    return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
  }
  return ['interpolate', ['linear'], ['line-progress'], 0, transparent, fadeStop, color, 1, color];
}
