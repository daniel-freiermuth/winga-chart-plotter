/**
 * Spherical line geometry primitives (rhumb and great-circle).
 * Pure functions — no external dependencies.
 */

/** Rhumb line destination. Returns unwrapped longitude so antimeridian crossings render correctly. */
export function destPoint(lon: number, lat: number, bearingRad: number, distM: number): [number, number] {
  const R = 6371000;
  const δ = distM / R;
  // Guard: clamp latitude away from the Mercator singularity at ±90°.
  const POLE_GUARD = Math.PI / 2 - 1e-6;
  const φ1 = Math.max(-POLE_GUARD, Math.min(POLE_GUARD, (lat * Math.PI) / 180));
  const φ2 = Math.max(-POLE_GUARD, Math.min(POLE_GUARD, φ1 + δ * Math.cos(bearingRad)));
  const Δψ = Math.log(Math.tan(φ2 / 2 + Math.PI / 4) / Math.tan(φ1 / 2 + Math.PI / 4));
  const q = Math.abs(Δψ) > 1e-10 ? (φ2 - φ1) / Δψ : Math.cos(φ1);
  const λ2 = (lon * Math.PI) / 180 + (δ * Math.sin(bearingRad)) / q;
  return [(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI];
}

/**
 * Generate densified rhumb line coords with progressive unwrapping.
 * Unwrapped longitude keeps antimeridian crossings continuous for both Mercator and Globe.
 */
export function rhumbCoords(lon: number, lat: number, bearingRad: number, distM: number): [number, number][] {
  const R = 6371000;
  const φ1 = (lat * Math.PI) / 180;
  const cosB = Math.cos(bearingRad);
  if (Math.abs(cosB) > 1e-10) {
    const capφ = cosB > 0 ? (85.0 * Math.PI) / 180 : -(85.0 * Math.PI) / 180;
    const distToCap = ((capφ - φ1) / cosB) * R;
    if (distToCap < distM) distM = Math.max(0, distToCap);
  }
  const SEGMENTS = 256;
  const coords: [number, number][] = [];
  let prevλ = (lon * Math.PI) / 180;
  for (let i = 0; i <= SEGMENTS; i++) {
    const [rawLon, rawLat] = destPoint(lon, lat, bearingRad, (i / SEGMENTS) * distM);
    const rawλ = (rawLon * Math.PI) / 180;
    const diff = rawλ - prevλ;
    const λ = prevλ + diff - Math.round(diff / (2 * Math.PI)) * 2 * Math.PI;
    prevλ = λ;
    coords.push([(λ * 180) / Math.PI, rawLat]);
  }
  return coords;
}

/** Great-circle line from a position, heading, and distance. Unwraps longitude continuously. */
export function gcCoords(lon: number, lat: number, bearingRad: number, distM: number): [number, number][] {
  const R = 6371000;
  const SEGMENTS = 256;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const coords: [number, number][] = [];
  let prevλ = λ1;

  for (let i = 0; i <= SEGMENTS; i++) {
    const d = (i / SEGMENTS) * distM / R;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(bearingRad));
    const λ2raw = λ1 + Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
    // Unwrap: keep longitude continuous across the antimeridian
    const diff = λ2raw - prevλ;
    const λ2 = prevλ + diff - Math.round(diff / (2 * Math.PI)) * 2 * Math.PI;
    prevλ = λ2;
    coords.push([(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI]);
  }
  return coords;
}
