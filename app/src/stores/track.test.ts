import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

// History fetch is out of scope (historyHours = 0 below); the mock keeps the
// WASM module from initialising at import time. Hoisted above the imports.
vi.mock('../lib/wasmRest', () => ({ fetchTrack: vi.fn() }));

import { track } from './track.svelte';
import { vessel, type VesselState } from './vessel.svelte';

function fixAt(longitude: number, latitude: number): VesselState {
  return { position: { longitude, latitude }, cog: null, sog: null, heading: null };
}

afterEach(() => {
  track.destroy();
  track.clear();
  vessel.set({ position: null, cog: null, sog: null, heading: null });
  flushSync();
});

describe('track', () => {
  it('records own-vessel fixes from init() until destroy()', async () => {
    vessel.set(fixAt(10, 59));
    await track.init('', 0); // no history fetch
    flushSync();

    vessel.setHeading(1);
    flushSync();
    vessel.set(fixAt(10.01, 59));
    flushSync();
    expect(track.coordinates).toEqual([[10, 59], [10.01, 59]]);

    track.destroy();
    vessel.set(fixAt(10.02, 59));
    flushSync();
    expect(track.coordinates).toEqual([[10, 59], [10.01, 59]]);
  });
});
