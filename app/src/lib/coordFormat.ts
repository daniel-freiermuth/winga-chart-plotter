/**
 * Format a lat/lon pair as degrees and decimal minutes (marine standard).
 *
 * Plain text (no HTML entities): it is also the default waypoint name that is
 * persisted to the Signal K server and shown verbatim by other clients.
 *
 * `lon` may be unwrapped (MapLibre click lngLat across the antimeridian, e.g.
 * 180.5). It is labelled by its canonical value so the name matches the
 * coordinates the server stores — a display-only mirror of
 * `geo::canonical_lon` (crates/core/src/geo.rs): in-range values pass through
 * untouched, others wrap to [-180, 180).
 */
export function formatDm(lat: number, lon: number): string {
  const canonicalLon = lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
  const dm = (deg: number, isLat: boolean): string => {
    const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    const abs = Math.abs(deg);
    // Round total minutes first so 59.9999995' carries into the degrees
    // instead of rendering as 60.000'.
    const totalMilliMin = Math.round(abs * 60_000);
    const d = Math.floor(totalMilliMin / 60_000);
    const m = (totalMilliMin - d * 60_000) / 1000;
    return `${String(d)}°\u202f${m.toFixed(3)}'\u202f${dir}`;
  };
  return `${dm(lat, true)}\u2003${dm(canonicalLon, false)}`;
}

/** Formats a true bearing in [0, 360) as a whole-degree label, e.g. "045° T". */
export function formatBearingTrue(bearing: number): string {
  return bearing.toFixed(0).padStart(3, '0') + '° T';
}
