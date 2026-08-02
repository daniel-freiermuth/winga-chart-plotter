import { get } from 'svelte/store';
import { ais } from '../stores/ais.svelte';
import { rulers } from '../stores/rulers.svelte';
import { vesselState } from '../stores/vessel';
import { settings } from '../stores/settings.svelte';
import { buildSnapTargets, type SnapTarget } from './snapTargets';

export type { SnapTarget };

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
 * app — not a pane — owns the per-frame sync.
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
    // Same dead-reckoning cap as the CPA ring and DR anchor in Map.svelte.
    const capMs = settings.appearance.ais.cog.lengthMinutes * 60 * 1000;
    targets = buildSnapTargets(ais.hotData, ais.ids, ais.uploadTimestamp, get(vesselState).position, Date.now(), capMs);
    rulers.syncSnapped(targets);
    rafId = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    clearTimeout(timerId);
  };
}
