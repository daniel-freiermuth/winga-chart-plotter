/**
 * Track and route coordinate processing utilities.
 *
 * All functions are pure — no side effects, no MapLibre/deck.gl imports.
 */

/** Shortest-path longitude delta from `prev` to `lon`, result in (-180, 180]. */
export function unwrapLon(lon: number, prev: number): number {
  const d = ((lon - prev + 180) % 360 + 360) % 360 - 180;
  return prev + d;
}

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
 * Densify a GC segment between two already-unwrapped [lon, lat] positions.
 * Returns intermediate points (excluding start) plus the exact endpoint.
 * Inserts one intermediate point per ~50 km of arc; for short segments (< 50 km)
 * this is a cheap no-op that just returns [[lon2, lat2]].
 * Longitude continuity is maintained via progressive unwrapping from lon1.
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

// Recursively split unwrapped+anchored coordinates into segments that each fit within
// MapLibre's ±540° rendering range. Overflow points are shifted by ∓720° (two world
// copies) so they appear in an adjacent but renderable world copy.
// Returns segments ordered oldest-first; each is guaranteed to lie within ±540°.
// Handles both western overflow (pts[0] < −540, from eastward accumulation) and
// eastern overflow (pts[0] > +540, from westward accumulation).
export function splitToFit(pts: [number, number][]): [number, number][][] {
  if (pts.length === 0) return [];
  if (pts[0]![0] < -540) {
    let si = 0;
    while (si < pts.length - 1 && pts[si]![0] < -540) si++;
    const recent = pts.slice(si);
    const overflow = pts.slice(0, si + 1).map(pt => [pt[0] + 720, pt[1]] as [number, number]);
    return [...splitToFit(overflow), recent];
  }
  if (pts[0]![0] > 540) {
    let si = 0;
    while (si < pts.length - 1 && pts[si]![0] > 540) si++;
    const recent = pts.slice(si);
    const overflow = pts.slice(0, si + 1).map(pt => [pt[0] - 720, pt[1]] as [number, number]);
    return [...splitToFit(overflow), recent];
  }
  return [pts];
}

/**
 * Bidirectional split for routes (and any arbitrary line that may circle the globe).
 * Handles both western overflow (< −540°) and eastern overflow (> +540°) by recursively
 * shifting overflow segments by ∓720° into the nearest renderable world copy.
 * Returns an array of segments all within ±540° longitude.
 */
export function splitRouteSegments(pts: [number, number][]): [number, number][][] {
  if (pts.length === 0) return [];
  if (pts[0]![0] < -540) {
    let si = 0;
    while (si < pts.length - 1 && pts[si]![0] < -540) si++;
    const west = pts.slice(0, si + 1).map(p => [p[0] + 720, p[1]] as [number, number]);
    return [...splitRouteSegments(west), ...splitRouteSegments(pts.slice(si))];
  }
  if (pts[pts.length - 1]![0] > 540) {
    let si = pts.length - 1;
    while (si > 0 && pts[si]![0] > 540) si--;
    const east = pts.slice(si).map(p => [p[0] - 720, p[1]] as [number, number]);
    return [...splitRouteSegments(pts.slice(0, si + 1)), ...splitRouteSegments(east)];
  }
  return [pts];
}

/**
 * Unwrap raw [-180, 180] track coordinates into a continuous longitude sequence,
 * densify each segment along a GC path, and compute the fade stop fraction.
 *
 * Storing raw coords in the track store and unwrapping here avoids unbounded
 * accumulation of out-of-range longitudes (e.g. 208°, 388°…) that would break
 * MapLibre's line-metrics computation across multiple antimeridian crossings.
 *
 * Fade distance = min(0.5 nm, 10 % of total track length).
 */
export function processTrack(raw: [number, number][]): { coords: [number, number][]; overflowSegments: [number, number][][]; fadeStop: number } {
  if (raw.length < 2) return { coords: raw, overflowSegments: [], fadeStop: 0 };
  const out: [number, number][] = [[raw[0]![0], raw[0]![1]]];
  for (let i = 1; i < raw.length; i++) {
    const prev = out[out.length - 1]!;
    const lon = unwrapLon(raw[i]![0], prev[0]);
    // Densify along the great-circle path. For short segments (< 50 km, the common
    // case for live tracks) gcDensifySegment is a cheap no-op returning just the endpoint.
    for (const pt of gcDensifySegment(prev[0], prev[1], lon, raw[i]![1])) out.push(pt);
  }
  // Anchor the most-recent point to [-180, 180]. Without this, multiple antimeridian
  // crossings accumulate unbounded longitude values which MapLibre cannot render.
  const shift = Math.round(out[out.length - 1]![0] / 360) * 360;
  if (shift !== 0) for (const pt of out) pt[0] -= shift;
  // Split into segments each within ±540°; the last segment is the most recent.
  const segments = splitToFit(out);
  const coords = segments[segments.length - 1] ?? out;
  const overflowSegments = segments.slice(0, -1);
  // Fade stop is computed over the most-recent segment only (where the gradient applies).
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1]!, coords[i]!);
  const fadeStop = total > 0 ? Math.min(Math.min(0.5 * 1852, total * 0.1) / total, 1) : 0;
  return { coords, overflowSegments, fadeStop };
}

/**
 * Unwraps longitudes, GC-densifies, and anchors a route or two-point line for
 * antimeridian-safe rendering. Anchors by the midpoint of first and last point so
 * both ends of the route stay near [-180, 180].
 */
export function processRouteCoords(raw: [number, number][]): [number, number][] {
  if (raw.length < 2) return raw;
  const out: [number, number][] = [[raw[0]![0], raw[0]![1]]];
  for (let i = 1; i < raw.length; i++) {
    const prev = out[out.length - 1]!;
    const lon = unwrapLon(raw[i]![0], prev[0]);
    for (const pt of gcDensifySegment(prev[0], prev[1], lon, raw[i]![1])) out.push(pt);
  }
  const mid = (out[0]![0] + out[out.length - 1]![0]) / 2;
  const shift = Math.round(mid / 360) * 360;
  if (shift !== 0) for (const pt of out) pt[0] -= shift;
  return out;
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
