/**
 * Great-circle navigation math, backed by the WASM `geo` module
 * (crates/core/src/geo.rs). Thin wrapper for main-thread call sites
 * (Map.svelte, route planner, rulers) — the worker thread initializes its
 * own copy independently (see signalk.worker.ts); a WASM instance is
 * per-JS-realm, not shared across the Worker boundary.
 *
 * Per project convention: no raw lon/lat arithmetic in TypeScript — this
 * module only forwards to WASM exports and degrades to a safe placeholder
 * until the module finishes loading (fire-and-forget init at import time;
 * by the time a user interacts with rulers/routes, it is essentially
 * always ready).
 */
import __wbg_init, {
  gcBearingDeg as wasmGcBearingDeg,
  gcDistanceNm as wasmGcDistanceNm,
  gcLine as wasmGcLine,
} from '../wasm/signalk_chart_core.js';

let ready = false;
void __wbg_init()
  .then(() => {
    ready = true;
  })
  .catch((err: unknown) => {
    console.error('Failed to initialize WASM geo module:', err);
  });

/** Great-circle bearing from A to B, in degrees [0, 360). */
export function gcBearingDeg(lonA: number, latA: number, lonB: number, latB: number): number {
  if (!ready) return 0;
  return wasmGcBearingDeg(lonA, latA, lonB, latB);
}

/** Great-circle distance between two points, in nautical miles. */
export function gcDistanceNm(lonA: number, latA: number, lonB: number, latB: number): number {
  if (!ready) return 0;
  return wasmGcDistanceNm(lonA, latA, lonB, latB);
}

/**
 * Densified great-circle line between two points.
 * Returns [lon, lat] coordinate pairs with continuous longitude
 * (unwrapped across the antimeridian).
 */
export function gcLine(
  lonA: number, latA: number,
  lonB: number, latB: number,
  segments = 64,
): [number, number][] {
  if (!ready) return [[lonA, latA], [lonB, latB]];
  return wasmGcLine(lonA, latA, lonB, latB, segments) as [number, number][];
}
