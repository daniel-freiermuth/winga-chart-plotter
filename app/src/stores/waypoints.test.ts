import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for the same stale-response race fixed in routes.svelte.ts
 * (see that file's test for the full bug writeup) — waypoints.load() shares
 * the identical request-sequence guard, so it needs the identical coverage.
 */
let pending: { resolve: (v: Record<string, unknown>) => void; reject: (e: unknown) => void }[] = [];
vi.mock('../lib/wasmRest', () => ({
  fetchAllWaypoints: vi.fn(() => new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.push({ resolve, reject });
  })),
}));

import { waypoints } from './waypoints.svelte';

function entry(name: string) {
  return {
    name,
    feature: { geometry: { coordinates: [1, 2] } },
  };
}

beforeEach(() => {
  pending = [];
});

describe('waypoints.load', () => {
  it('applies a single response normally', async () => {
    const load = waypoints.load('http://sk');
    pending[0]!.resolve({ a: entry('alpha') });
    await load;
    expect(waypoints.entries.map(w => w.name)).toEqual(['alpha']);
  });

  it('ignores a stale response that resolves after a newer load() has started', async () => {
    const first = waypoints.load('http://sk');
    const second = waypoints.load('http://sk');

    pending[1]!.resolve({ b: entry('second') });
    await second;
    expect(waypoints.entries.map(w => w.name)).toEqual(['second']);

    pending[0]!.resolve({ a: entry('first') });
    await first;
    expect(waypoints.entries.map(w => w.name)).toEqual(['second']);
  });

  it('a stale rejection does not set error or clear loading for the newer request', async () => {
    const first = waypoints.load('http://sk');
    const second = waypoints.load('http://sk');

    // The newer request is still pending when the older one rejects — its
    // failure must not surface as the current error, nor flip loading off
    // while the newer request is still in flight.
    pending[0]!.reject(new Error('stale network failure'));
    await Promise.resolve();
    expect(waypoints.error).toBeNull();
    expect(waypoints.loading).toBe(true);

    pending[1]!.resolve({ b: entry('second') });
    await second;
    await first.catch(() => { /* the stale rejection still settles `first` itself */ });
    expect(waypoints.entries.map(w => w.name)).toEqual(['second']);
    expect(waypoints.error).toBeNull();
    expect(waypoints.loading).toBe(false);
  });

  it('an empty serverBase still invalidates an earlier in-flight request and clears loading', async () => {
    const before = waypoints.entries;
    const first = waypoints.load('http://sk');
    await waypoints.load('');
    expect(waypoints.loading).toBe(false);

    pending[0]!.resolve({ a: entry('first') });
    await first;
    expect(waypoints.entries).toBe(before);
    expect(waypoints.loading).toBe(false);
  });
});
