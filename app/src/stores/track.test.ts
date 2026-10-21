import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

// The mock also keeps the WASM module from initialising at import time.
// Hoisted above the imports.
vi.mock('../lib/wasmRest', () => ({ fetchTrack: vi.fn() }));

import { fetchTrack } from '../lib/wasmRest';
import { track } from './track.svelte';
import { vessel, type VesselState } from './vessel.svelte';

type Coords = [number, number][];

function fixAt(longitude: number, latitude: number): VesselState {
  return { position: { longitude, latitude }, cog: null, sog: null, heading: null };
}

/** Queues a fetchTrack result that the test resolves explicitly, to control completion order. */
function deferredFetch(): (coords: Coords) => Promise<void> {
  const { promise, resolve } = Promise.withResolvers<Coords>();
  vi.mocked(fetchTrack).mockReturnValueOnce(promise);
  return async (coords) => {
    resolve(coords);
    await promise;
  };
}

afterEach(() => {
  track.destroy();
  track.clear();
  vessel.set({ position: null, cog: null, sog: null, heading: null });
  flushSync();
  vi.mocked(fetchTrack).mockReset();
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

  it('keeps the latest init() when an earlier history fetch resolves last', async () => {
    const resolveA = deferredFetch();
    const resolveB = deferredFetch();
    const initA = track.init('http://old', 24);
    const initB = track.init('http://new', 6);

    await resolveB([[1, 1]]);
    await initB;
    flushSync();
    await resolveA([[50, 50]]);
    await initA;
    flushSync();
    expect(track.coordinates).toEqual([[1, 1]]);

    vessel.set(fixAt(1.01, 1));
    flushSync();
    expect(track.coordinates).toEqual([[1, 1], [1.01, 1]]);

    // Exactly one recorder is left, and destroy() stops it.
    track.destroy();
    vessel.set(fixAt(1.02, 1));
    flushSync();
    expect(track.coordinates).toEqual([[1, 1], [1.01, 1]]);
  });

  it('does not start recording when destroy() runs during the history fetch', async () => {
    const resolve = deferredFetch();
    const init = track.init('http://srv', 24);
    track.destroy();

    await resolve([[1, 1]]);
    await init;
    vessel.set(fixAt(1.01, 1));
    flushSync();
    expect(track.coordinates).toEqual([]);
  });
});
