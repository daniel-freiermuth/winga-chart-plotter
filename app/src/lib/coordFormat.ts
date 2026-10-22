/**
 * Format a lat/lon pair as degrees and decimal minutes (marine standard).
 *
 * Plain text (no HTML entities): it is also the default waypoint name that is
 * persisted to the Signal K server and shown verbatim by other clients.
 */
export function formatDm(lat: number, lon: number): string {
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
  return `${dm(lat, true)}\u2003${dm(lon, false)}`;
}
