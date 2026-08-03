import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for a real bug: routes.load() had no protection against
 * out-of-order responses. App.svelte polls routes.load() on a timer AND
 * calls it explicitly right after saving a route; if the poll's request was
 * already in flight when a save triggered a fresh load, and the poll's
 * (stale) response happened to resolve after the fresh one, it would
 * silently overwrite `_routes` back to the pre-save list — a just-saved
 * route would render, then vanish moments later.
 *
 * `fetchAllRoutes` is mocked with manually-resolved promises so each test
 * controls the resolution order precisely, rather than depending on real
 * network timing (which the bug itself depended on to reproduce). vi.mock
 * is hoisted above the imports below by vitest's transform, so `routes`
 * (which transitively imports fetchAllRoutes) sees the mock.
 */
let pending: { resolve: (v: Record<string, unknown>) => void }[] = [];
vi.mock('../lib/wasmRest', () => ({
  fetchAllRoutes: vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
    pending.push({ resolve });
  })),
}));

import { routes } from './routes.svelte';

function entry(name: string) {
  return {
    name,
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      properties: {},
    },
  };
}

beforeEach(() => {
  pending = [];
});

describe('routes.load', () => {
  it('applies a single response normally', async () => {
    const load = routes.load('http://sk');
    pending[0]!.resolve({ a: entry('alpha') });
    await load;
    expect(routes.entries.map(r => r.name)).toEqual(['alpha']);
  });

  it('ignores a stale response that resolves after a newer load() has started', async () => {
    const first = routes.load('http://sk');
    const second = routes.load('http://sk');

    // Resolve OUT OF ORDER: the newer request settles first, the stale one after —
    // exactly the race that made a just-saved route disappear.
    pending[1]!.resolve({ b: entry('second') });
    await second;
    expect(routes.entries.map(r => r.name)).toEqual(['second']);

    pending[0]!.resolve({ a: entry('first') });
    await first;
    expect(routes.entries.map(r => r.name)).toEqual(['second']);
  });

  it('applies a later load() that resolves after an earlier, still-pending one', async () => {
    const first = routes.load('http://sk');
    const second = routes.load('http://sk');

    // In-order this time: still correct — the newest response always wins.
    pending[0]!.resolve({ a: entry('first') });
    await first;
    pending[1]!.resolve({ b: entry('second') });
    await second;

    expect(routes.entries.map(r => r.name)).toEqual(['second']);
  });

  it('an empty serverBase still invalidates an earlier in-flight request and clears loading', async () => {
    // Simulates the user clearing the connection settings while a request
    // from the old server is still in flight — that stale response must
    // not be able to commit once a no-op load('') has superseded it, and
    // the loading indicator must not stay stuck on: the invalidated
    // request's own `finally` no longer fires (its seq is now stale), so
    // load('') must clear `loading` itself.
    const before = routes.entries;
    const first = routes.load('http://sk');
    await routes.load('');
    expect(routes.loading).toBe(false);

    pending[0]!.resolve({ a: entry('first') });
    await first;
    expect(routes.entries).toBe(before);
    expect(routes.loading).toBe(false);
  });
});
