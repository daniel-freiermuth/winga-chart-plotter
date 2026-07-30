/**
 * Track and route coordinate processing utilities.
 *
 * All functions are pure — no side effects, no MapLibre/deck.gl imports.
 *
 * Pipeline (tracks and routes):
 *   SK raw coords [-180, 180]
 *   → splitAtAntimeridian  — split at crossings, insert handover points
 *   → densifySegment       — GC-densify each segment independently
 *
 * No unwrapping or re-wrapping step. Coordinates stay in [-360, 360] throughout,
 * within MapLibre's ±540° rendering range.
 */

/** Haversine distance in metres between two [lon, lat] points. */
export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const dLat = (b[1] - a[1]) * (Math.PI / 180);
  const dLon = (b[0] - a[0]) * (Math.PI / 180);
  const lat1 = a[1] * (Math.PI / 180);
  const lat2 = b[1] * (Math.PI / 180);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * Densify a GC segment between two [lon, lat] positions.
 * Returns intermediate points (excluding start) plus the exact endpoint.
 * Inserts one intermediate point per ~50 km of arc; for short segments (< 50 km)
 * this is a cheap no-op that just returns [[lon2, lat2]].
 * Longitude continuity is maintained via progressive unwrapping from lon1.
 *
 * Accepts longitude values outside [-180, 180] provided |lon2 - lon1| ≤ 180°
 * (i.e. the two endpoints are on the same side of any antimeridian crossing).
 *
 * Uses spherical SLERP so intermediate points are exactly on the GC.
 * The exact endpoint is pushed last to prevent floating-point drift accumulation.
 */
export function gcDensifySegment(
  lon1: number, lat1: number,
  lon2: number, lat2: number,
): [number, number][] {
  const R = 6_371_000;
  const DEG = Math.PI / 180;
  const φ1 = lat1 * DEG, λ1 = lon1 * DEG;
  const φ2 = lat2 * DEG, λ2 = lon2 * DEG;
  const cosD = Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  const d = Math.acos(Math.min(1, Math.max(-1, cosD)));
  const nSegs = Math.max(1, Math.ceil(d * R / 50_000));
  if (nSegs === 1 || d < 1e-9) return [[lon2, lat2]];
  const sinD = Math.sin(d);
  const out: [number, number][] = [];
  let prevλ = λ1;
  for (let i = 1; i < nSegs; i++) {
    const f = i / nSegs;
    const A = Math.sin((1 - f) * d) / sinD;
    const B = Math.sin(f * d) / sinD;
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1)                 + B * Math.sin(φ2);
    const φi = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λiRaw = Math.atan2(y, x);
    // Unwrap relative to previous intermediate point so longitude stays continuous.
    const diff = λiRaw - prevλ;
    const λi = prevλ + diff - Math.round(diff / (2 * Math.PI)) * 2 * Math.PI;
    prevλ = λi;
    out.push([λi / DEG, φi / DEG]);
  }
  out.push([lon2, lat2]);  // exact endpoint — avoids floating-point drift accumulation
  return out;
}

/**
 * Split raw [-180, 180] coordinates at antimeridian crossings.
 *
 * A crossing is detected when |lon[i] - lon[i-1]| > 180°. At each crossing the
 * pre-crossing point is duplicated into the new segment, shifted ±360° to place it
 * on the far side of the antimeridian. This handover keeps adjacent segments visually
 * connected at the crossing.
 *
 * Precondition: input coordinates are in [-180, 180] (as Signal K provides them).
 * Postcondition: all output coordinates lie within [-360, 360]. Consecutive points
 * within each segment differ by ≤ 180°, so gcDensifySegment follows the correct
 * short great-circle path without crossing the antimeridian.
 *
 * Returns segments ordered oldest-first.
 */
export function splitAtAntimeridian(pts: [number, number][]): [number, number][][] {
  if (pts.length === 0) return [];
  const segs: [number, number][][] = [];
  let seg: [number, number][] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const [prevLon, prevLat] = seg[seg.length - 1]!;
    const [lon, lat] = pts[i]!;
    if (Math.abs(lon - prevLon) > 180) {
      // Antimeridian crossing: close the current segment and open a new one.
      // The handover is prevLon shifted to the far side, giving the new segment
      // a starting point geographically adjacent to the first point after the crossing.
      segs.push(seg);
      seg = [[prevLon + (lon < prevLon ? -360 : 360), prevLat]];
    }
    seg.push([lon, lat]);
  }
  segs.push(seg);
  // Drop segments with fewer than 2 points — they occur when a crossing happens
  // at the very first pair and leave behind a single pre-crossing point that
  // cannot form a valid LineString.
  return segs.filter(s => s.length >= 2);
}

/** GC-densify a segment whose consecutive pairs have |Δlon| ≤ 180°. */
function densifySegment(pts: [number, number][]): [number, number][] {
  if (pts.length < 2) return pts;
  const out: [number, number][] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1]!;
    for (const pt of gcDensifySegment(prev[0], prev[1], pts[i]![0], pts[i]![1])) {
      out.push(pt);
    }
  }
  return out;
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
export function processTrack(raw: [number, number][]): { coords: [number, number][]; overflowSegments: [number, number][][]; fadeStop: number } {
  if (raw.length < 2) return { coords: raw, overflowSegments: [], fadeStop: 0 };
  const segs = splitAtAntimeridian(raw).map(densifySegment);
  const coords = segs[segs.length - 1] ?? raw;
  const overflowSegments = segs.slice(0, -1);
  // Fade stop is computed over the most-recent segment only (where the gradient applies).
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1]!, coords[i]!);
  const fadeStop = total > 0 ? Math.min(Math.min(0.5 * 1852, total * 0.1) / total, 1) : 0;
  return { coords, overflowSegments, fadeStop };
}

/**
 * Split raw route or two-point line at antimeridian crossings and GC-densify each
 * segment. Returns one densified segment per antimeridian-bounded piece, all within
 * [-360, 360].
 */
export function processRouteCoords(raw: [number, number][]): [number, number][][] {
  if (raw.length < 2) return [raw];
  return splitAtAntimeridian(raw).map(densifySegment);
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
