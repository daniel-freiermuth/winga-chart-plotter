/** Great-circle bearing from A to B, in degrees [0, 360). */
export function gcBearingDeg(
  lonA: number, latA: number,
  lonB: number, latB: number,
): number {
  const φ1 = (latA * Math.PI) / 180;
  const φ2 = (latB * Math.PI) / 180;
  const Δλ = ((lonB - lonA) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Great-circle distance between two points, in nautical miles. */
export function gcDistanceNm(
  lonA: number, latA: number,
  lonB: number, latB: number,
): number {
  const R_NM = 3440.065;
  const φ1 = (latA * Math.PI) / 180;
  const φ2 = (latB * Math.PI) / 180;
  const Δφ = ((latB - latA) * Math.PI) / 180;
  const Δλ = ((lonB - lonA) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * R_NM;
}

/**
 * Densified great-circle line between two points.
 * Returns an array of [lon, lat] coordinates with continuous longitude
 * (unwrapped across the antimeridian).
 */
export function gcLine(
  lonA: number, latA: number,
  lonB: number, latB: number,
  segments = 64,
): [number, number][] {
  const φ1 = (latA * Math.PI) / 180;
  const λ1 = (lonA * Math.PI) / 180;
  const φ2 = (latB * Math.PI) / 180;
  const λ2 = (lonB * Math.PI) / 180;

  // Total angular distance
  const Δσ = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
  ));

  if (Δσ < 1e-10) return [[lonA, latA], [lonB, latB]];

  const coords: [number, number][] = [];
  let prevλ = λ1;

  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * Δσ) / Math.sin(Δσ);
    const B = Math.sin(f * Δσ) / Math.sin(Δσ);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λraw = Math.atan2(y, x);
    // Unwrap longitude
    const diff = λraw - prevλ;
    const λ = prevλ + diff - Math.round(diff / (2 * Math.PI)) * 2 * Math.PI;
    prevλ = λ;
    coords.push([(λ * 180) / Math.PI, (φ * 180) / Math.PI]);
  }
  return coords;
}
