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
import {
  gcBearingDeg as wasmGcBearingDeg,
  gcDistanceNm as wasmGcDistanceNm,
  gcLine as wasmGcLine,
  gcComputeCpa as wasmGcComputeCpa,
  unionViewBounds as wasmUnionViewBounds,
  chartBoundsContain as wasmChartBoundsContain,
  chartBoundsCenter as wasmChartBoundsCenter,
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

/** CPA result: plain JS object copied out of the WASM struct (no free() needed after this). */
export interface CpaResult {
  /** CPA distance in nautical miles. */
  cpa_nm: number;
  /**
   * Minutes to CPA.
   * Negative  = opening (vessels already diverging; show range only, no ghost).
   * ≥ 120.0   = capped at 2 h; ghost positions are at the 2 h projected mark.
   */
  tcpa_min: number;
  /** Own vessel's projected longitude at TCPA (or 2 h, or current if opening). */
  own_lon: number;
  /** Own vessel's projected latitude at TCPA. */
  own_lat: number;
  /** Target's projected longitude at TCPA. */
  tgt_lon: number;
  /** Target's projected latitude at TCPA. */
  tgt_lat: number;
  /** True when vessels are already diverging (TCPA < 0). */
  isOpening: boolean;
  /** True when TCPA > 2 h (ghost at 2 h mark, not true CPA). */
  isCapped: boolean;
}

/**
 * Compute CPA between own vessel (linear track) and a target (arc track via RoT).
 * All angles in radians; SOG in m/s; RoT in rad/s (pass NaN if unknown).
 * Returns null when WASM is not ready or inputs are invalid (own/target pos/COG/SOG NaN).
 */
export function computeCpa(
  ownLon: number, ownLat: number, ownCog: number, ownSog: number,
  tgtLon: number, tgtLat: number, tgtCog: number, tgtSog: number, tgtRot: number,
): CpaResult | null {
  if (!ready) return null;
  const r = wasmGcComputeCpa(ownLon, ownLat, ownCog, ownSog, tgtLon, tgtLat, tgtCog, tgtSog, tgtRot);
  const cpa_nm = r.cpa_nm;
  if (isNaN(cpa_nm)) { r.free(); return null; }
  const result: CpaResult = {
    cpa_nm,
    tcpa_min: r.tcpa_min,
    own_lon:  r.own_lon,
    own_lat:  r.own_lat,
    tgt_lon:  r.tgt_lon,
    tgt_lat:  r.tgt_lat,
    isOpening: r.tcpa_min < 0,
    isCapped:  r.tcpa_min >= 120.0,
  };
  r.free();
  return result;
}

/** Dateline-aware union of two pane viewports, from the WASM geo module. */
export interface UnionedView {
  /**
   * [west, south, east, north], expressed AROUND the canonical center:
   * west = center − span/2, east = center + span/2 (span ≤ 360°), so either
   * edge may lie outside ±180 (unwrapped) — the same shape a single MapLibre
   * viewport reports.
   */
  bounds: [number, number, number, number];
  /**
   * [lon, lat]; lon is canonical, normalized to [-180, 180) — it decides on
   * which side of the wrap the union is represented, and always satisfies
   * west ≤ lon ≤ east.
   */
  center: [number, number];
}

/**
 * Union of two viewport bounds treated as arcs on the circle: merges across
 * the antimeridian when that gap is smaller, where a naive min/max union
 * would span the globe through Greenwich with a center on the wrong side of
 * the planet. Returns null when WASM is not ready.
 */
export function unionViewBounds(
  b0: [number, number, number, number],
  b1: [number, number, number, number],
): UnionedView | null {
  if (!ready) return null;
  const r = wasmUnionViewBounds(b0[0], b0[1], b0[2], b0[3], b1[0], b1[1], b1[2], b1[3]);
  return {
    bounds: [r[0]!, r[1]!, r[2]!, r[3]!],
    center: [r[4]!, r[5]!],
  };
}

/**
 * Dateline-aware chart-bounds containment. Bounds are `[west, south, east,
 * north]`; `west > east` reads as an arc crossing the antimeridian (e.g.
 * `[170, -170]` is the 20° Pacific strip, which a naive interval test can
 * never satisfy). Returns null when WASM is not ready.
 */
export function chartBoundsContain(
  b: [number, number, number, number],
  lon: number,
  lat: number,
): boolean | null {
  if (!ready) return null;
  return wasmChartBoundsContain(b[0], b[1], b[2], b[3], lon, lat);
}

/**
 * Center of chart bounds — same convention as {@link chartBoundsContain};
 * lon is canonical, normalized to [-180, 180). Returns null when WASM is
 * not ready.
 */
export function chartBoundsCenter(
  b: [number, number, number, number],
): [number, number] | null {
  if (!ready) return null;
  const r = wasmChartBoundsCenter(b[0], b[1], b[2], b[3]);
  return [r[0]!, r[1]!];
}
