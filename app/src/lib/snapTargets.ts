import { AIS_HOT_STRIDE, AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG, AIS_F_ROT, AIS_F_AGE } from '../stores/ais.svelte';
import { extrapolatePos } from './deadReckoning';

/** A live position a ruler endpoint can snap to (own vessel, AIS target, or its dead-reckoned ghost). */
export interface SnapTarget { id: string; position: { longitude: number; latitude: number } }

/**
 * Builds the ruler snap-target list from an AIS hot-data batch.
 *
 * For each moving AIS vessel two targets exist: last-known (`id`) and
 * dead-reckoned ghost (`id + ':ghost'`); stationary vessels (no COG/SOG) get
 * one; own vessel is always appended when a position exists.
 *
 * `capMs` bounds the dead-reckoning interval — matching every other DR
 * consumer (CPA ring, DR anchor) — so a vessel whose data went stale cannot
 * produce a ghost target arbitrarily far from its true position.
 */
export function buildSnapTargets(
  hd: Float64Array | null,
  ids: readonly string[],
  uploadTs: number,
  ownPos: { longitude: number; latitude: number } | null | undefined,
  nowMs: number,
  capMs: number,
): SnapTarget[] {
  const snapPts: SnapTarget[] = [];
  const S = AIS_HOT_STRIDE;
  if (hd && ids.length > 0 && uploadTs) {
    // Defensive: never index past the hot-data buffer if a batch ever ships
    // fewer rows than ids (undefined reads would emit invalid coordinates).
    const vesselCount = Math.min(ids.length, Math.floor(hd.length / S));
    for (let i = 0; i < vesselCount; i++) {
      const lon = hd[i * S + AIS_F_LON]!;
      const lat = hd[i * S + AIS_F_LAT]!;
      snapPts.push({ id: ids[i]!, position: { longitude: lon, latitude: lat } });
      const cog = hd[i * S + AIS_F_COG]!;
      const sog = hd[i * S + AIS_F_SOG]!;
      if (!isNaN(cog) && !isNaN(sog)) {
        const rot = hd[i * S + AIS_F_ROT]!;
        const lastPosMs = uploadTs - hd[i * S + AIS_F_AGE]! * 1000;
        const cappedNowMs = Math.min(nowMs, lastPosMs + capMs);
        const [gLon, gLat] = extrapolatePos(lon, lat, cog, sog, isNaN(rot) ? 0 : rot, lastPosMs, cappedNowMs);
        snapPts.push({ id: `${String(ids[i])}:ghost`, position: { longitude: gLon, latitude: gLat } });
      }
    }
  }
  if (ownPos) {
    snapPts.push({ id: 'own-vessel', position: { longitude: ownPos.longitude, latitude: ownPos.latitude } });
  }
  return snapPts;
}
