import { beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { vessel, type VesselState } from './vessel.svelte';

const NO_FIX: VesselState = { position: null, cog: null, sog: null, heading: null };

function fixAt(longitude: number, latitude: number): VesselState {
  return { position: { longitude, latitude }, cog: 1, sog: 2, heading: 0.5 };
}

/** Runs `read` in an effect and returns how often it has run so far, plus a stop function. */
function countRuns(read: () => unknown): { runs: () => number; stop: () => void } {
  let n = 0;
  const stop = $effect.root(() => {
    $effect(() => { read(); n++; });
  });
  flushSync();
  return { runs: () => n, stop };
}

beforeEach(() => {
  vessel.set(NO_FIX);
  flushSync();
});

/**
 * The compass pushes heading at display rate (~60 Hz). Route, camera-follow and
 * track readers only care about position; if a heading write invalidated them
 * they would rerun every frame. This used to hold only because the old store's
 * update() spread kept `position`'s reference; it is now per-field tracking.
 */
describe('vessel store', () => {
  it('heading-only updates do not re-run position readers', () => {
    const pos = countRuns(() => vessel.position);
    try {
      expect(pos.runs()).toBe(1);

      vessel.set(fixAt(10, 59));
      flushSync();
      expect(pos.runs()).toBe(2);

      for (let i = 1; i <= 30; i++) {
        vessel.setHeading(i / 10);
        flushSync();
      }
      expect(pos.runs()).toBe(2);
      expect(vessel.heading).toBe(3);
      expect(vessel.position).toEqual({ longitude: 10, latitude: 59 });
    } finally {
      pos.stop();
    }
  });

  /**
   * Signal K emits a full state on every own-vessel change, heading-only deltas
   * included, and App builds a fresh position object each time. Position readers
   * (COG-follow easeTo, track, route) must not re-run when the coordinates are equal.
   */
  it('a fix with unchanged coordinates does not re-run position readers', () => {
    vessel.set(fixAt(10, 59));
    flushSync();
    const pos = countRuns(() => vessel.position);
    try {
      vessel.set({ ...fixAt(10, 59), heading: 0.9 });
      flushSync();
      expect(pos.runs()).toBe(1);
      expect(vessel.heading).toBe(0.9);

      vessel.set(fixAt(10, 59.0001));
      flushSync();
      expect(pos.runs()).toBe(2);

      vessel.set(NO_FIX);
      flushSync();
      expect(pos.runs()).toBe(3);
    } finally {
      pos.stop();
    }
  });

  it('set() replaces every field, including clearing ones absent from the new fix', () => {
    vessel.set(fixAt(10, 59));
    vessel.set({ position: { longitude: 11, latitude: 60 }, cog: null, sog: null, heading: null });
    expect(vessel.snapshot()).toEqual({
      position: { longitude: 11, latitude: 60 }, cog: null, sog: null, heading: null,
    });
  });

  it('snapshot() is a plain copy that does not follow later writes', () => {
    vessel.set(fixAt(10, 59));
    const snap = vessel.snapshot();
    vessel.setHeading(2);
    vessel.set(fixAt(12, 61));
    expect(snap).toEqual(fixAt(10, 59));
  });
});
