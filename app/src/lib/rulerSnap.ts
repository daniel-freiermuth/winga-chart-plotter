import { get } from 'svelte/store';
import { ais, AIS_HOT_STRIDE, AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG, AIS_F_ROT, AIS_F_AGE } from '../stores/ais.svelte';
import { rulers } from '../stores/rulers.svelte';
import { vesselState } from '../stores/vessel';
import { extrapolatePos } from './deadReckoning';

/** A live position a ruler endpoint can snap to (own vessel, AIS target, or its dead-reckoned ghost). */
export interface SnapTarget { id: string; position: { longitude: number; latitude: number } }

let targets: SnapTarget[] = [];

/**
 * Latest live snap targets, recomputed each frame by the app-level driver
 * below. Panes read this for drag-snap hit-testing; they never compute or
 * write snap state themselves.
 */
export function currentSnapTargets(): SnapTarget[] { return targets; }

/** Poll interval while no rulers exist — just watching for one to appear. */
const IDLE_POLL_MS = 250;

/**
 * App-level frame driver for ruler snapping.
 *
 * Rulers are shared world data; endpoints snapped to a vessel must follow its
 * live (dead-reckoned) position no matter how many panes render them, so the
 * app — not a pane — owns the per-frame sync. For each moving AIS vessel two
 * targets exist: last-known (`id`) and dead-reckoned ghost (`id + ':ghost'`);
 * stationary vessels get one; own vessel is always included.
 *
 * Scheduling: per display frame (rAF) only while rulers exist; while none do,
 * a slow setTimeout poll watches for one appearing instead of burning a rAF
 * per frame for the app's whole lifetime. Returns a stop function.
 */
export function startRulerSnapSync(): () => void {
  let rafId: number | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    rafId = undefined;
    timerId = undefined;
    if (rulers.rulers.length === 0) {
      if (targets.length > 0) targets = [];
      timerId = setTimeout(tick, IDLE_POLL_MS);
      return;
    }

    const nowMs = Date.now();
    const snapPts: SnapTarget[] = [];
    const hd = ais.hotData;
    const ids = ais.ids;
    const uploadTs = ais.uploadTimestamp;
    const S = AIS_HOT_STRIDE;
    if (hd && ids.length > 0 && uploadTs) {
      for (let i = 0; i < ids.length; i++) {
        const lon = hd[i * S + AIS_F_LON]!;
        const lat = hd[i * S + AIS_F_LAT]!;
        snapPts.push({ id: ids[i]!, position: { longitude: lon, latitude: lat } });
        const cog = hd[i * S + AIS_F_COG]!;
        const sog = hd[i * S + AIS_F_SOG]!;
        if (!isNaN(cog) && !isNaN(sog)) {
          const rot = hd[i * S + AIS_F_ROT]!;
          const lastPosMs = uploadTs - hd[i * S + AIS_F_AGE]! * 1000;
          const [gLon, gLat] = extrapolatePos(lon, lat, cog, sog, isNaN(rot) ? 0 : rot, lastPosMs, nowMs);
          snapPts.push({ id: `${String(ids[i])}:ghost`, position: { longitude: gLon, latitude: gLat } });
        }
      }
    }
    const ownPos = get(vesselState).position;
    if (ownPos) {
      snapPts.push({ id: 'own-vessel', position: { longitude: ownPos.longitude, latitude: ownPos.latitude } });
    }
    targets = snapPts;
    rulers.syncSnapped(targets);
    rafId = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    clearTimeout(timerId);
  };
}
