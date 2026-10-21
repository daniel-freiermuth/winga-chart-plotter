/** Format a lat/lon pair as degrees and decimal minutes (marine standard). */
export function formatDm(lat: number, lon: number): string {
  const dm = (deg: number, isLat: boolean): string => {
    const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = (abs - d) * 60;
    return `${String(d)}°\u202f${m.toFixed(3)}'\u202f${dir}`;
  };
  return `${dm(lat, true)}&emsp;${dm(lon, false)}`;
}
