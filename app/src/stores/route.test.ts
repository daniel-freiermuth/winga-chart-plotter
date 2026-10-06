import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { route } from './route.svelte';
import type { CourseState } from './vessel';

/**
 * route.update() is called from App.svelte on every worker 'state' message and
 * starts a REST fetch whenever the active route href changes. Fetches are
 * mocked with manually-settled promises so each test controls resolution
 * order — the stale-response tests depend on settling a superseded request
 * AFTER the active route has already changed.
 */
interface PendingFetch {
  url: string;
  resolve: (body: unknown) => void;
  fail: (status: number, statusText: string) => void;
  reject: (e: Error) => void;
}

let pending: PendingFetch[] = [];

function mockFetch(url: string): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    pending.push({
      url,
      resolve: (body) => { resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) } as Response); },
      fail: (status, statusText) => { resolve({ ok: false, status, statusText, json: () => Promise.resolve({}) } as Response); },
      reject,
    });
  });
}

/**
 * Let the fetch → json → then chain inside route.update() run to completion.
 * update() is fire-and-forget (returns void), so there is no promise to await;
 * draining the microtask queue via the fake clock is the repo's convention.
 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function line(name: string) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'LineString' as const, coordinates: [[0, 0], [1, 1]] },
    properties: { name },
  };
}

function course(href: string, extra: Partial<NonNullable<CourseState['activeRoute']>> = {}): CourseState {
  return { activeRoute: { href, pointIndex: 0, reverse: false, ...extra } };
}

const SERVER = 'http://sk';

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  vi.stubGlobal('fetch', vi.fn(mockFetch));
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  route.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('route.update — href normalisation', () => {
  it.each([
    ['/resources/routes/a',                 'http://sk/signalk/v2/api/resources/routes/a'],
    ['/v1/api/resources/routes/a',          'http://sk/signalk/v2/api/resources/routes/a'],
    ['/signalk/v1/api/resources/routes/a',  'http://sk/signalk/v2/api/resources/routes/a'],
    ['/signalk/v2/api/resources/routes/a',  'http://sk/signalk/v2/api/resources/routes/a'],
    ['http://other/signalk/v2/api/resources/routes/a', 'http://other/signalk/v2/api/resources/routes/a'],
  ])('%s → %s', (href, expected) => {
    route.update(SERVER, course(href));
    expect(pending.map(p => p.url)).toEqual([expected]);
    expect(route.loading).toBe(true);
  });
});

describe('route.update — response shapes', () => {
  const lineA = line('a');
  const lineB = line('b');
  it.each<[string, unknown, unknown]>([
    ['SK envelope { feature }', { name: 'r', feature: lineA }, lineA],
    ['bare Feature', lineA, lineA],
    ['FeatureCollection with a LineString', { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      lineB,
    ] }, lineB],
    ['FeatureCollection with a null-geometry member before the LineString', { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: null, properties: {} },
      lineB,
    ] }, lineB],
    ['FeatureCollection without a LineString', { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
    ] }, null],
    ['Feature with non-LineString geometry', { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }, null],
    ['unrecognised object', { foo: 1 }, null],
  ])('%s', async (_label, body, expected) => {
    route.update(SERVER, course('/resources/routes/a'));
    pending[0]!.resolve(body);
    await flush();
    expect(route.geometry).toEqual(expected);
    expect(route.error).toBeNull();
    expect(route.loading).toBe(false);
  });

  it('a non-ok HTTP response sets error and clears loading', async () => {
    route.update(SERVER, course('/resources/routes/a'));
    pending[0]!.fail(404, 'Not Found');
    await flush();
    expect(route.geometry).toBeNull();
    expect(route.error).toContain('404');
    expect(route.loading).toBe(false);
  });
});

describe('route.update — stale responses', () => {
  it('does not refetch when the href is unchanged', () => {
    route.update(SERVER, course('/resources/routes/a'));
    route.update(SERVER, course('/resources/routes/a', { pointIndex: 1 }));
    expect(pending).toHaveLength(1);
    expect(route.pointIndex).toBe(1);
  });

  it('ignores a response for a superseded href that resolves after the current one', async () => {
    route.update(SERVER, course('/resources/routes/a'));
    route.update(SERVER, course('/resources/routes/b'));

    pending[1]!.resolve(line('b'));
    await flush();
    expect(route.geometry).toEqual(line('b'));

    pending[0]!.resolve(line('a'));
    await flush();
    expect(route.activeHref).toBe('/resources/routes/b');
    expect(route.geometry).toEqual(line('b'));
    expect(route.loading).toBe(false);
  });

  it('a superseded response resolving first neither commits nor clears loading for the current href', async () => {
    route.update(SERVER, course('/resources/routes/a'));
    route.update(SERVER, course('/resources/routes/b'));

    pending[0]!.resolve(line('a'));
    await flush();
    expect(route.geometry).toBeNull();
    expect(route.loading).toBe(true);

    pending[1]!.resolve(line('b'));
    await flush();
    expect(route.geometry).toEqual(line('b'));
    expect(route.loading).toBe(false);
  });

  it('a course update without an active route invalidates the in-flight fetch', async () => {
    route.update(SERVER, course('/resources/routes/a'));
    route.update(SERVER, {});
    expect(route.loading).toBe(false);

    pending[0]!.resolve(line('a'));
    await flush();
    expect(route.activeHref).toBeNull();
    expect(route.geometry).toBeNull();
    expect(route.loading).toBe(false);
  });

  it('an undefined course (geolocation mode) invalidates the in-flight fetch', async () => {
    route.update(SERVER, course('/resources/routes/a'));
    route.update(SERVER, undefined);

    pending[0]!.resolve(line('a'));
    await flush();
    expect(route.geometry).toBeNull();
    expect(route.loading).toBe(false);
  });

  it('a rejected stale fetch does not set error for the current href', async () => {
    route.update(SERVER, course('/resources/routes/a'));
    route.update(SERVER, course('/resources/routes/b'));

    pending[0]!.reject(new Error('network down'));
    await flush();
    expect(route.error).toBeNull();
    expect(route.loading).toBe(true);

    pending[1]!.resolve(line('b'));
    await flush();
    expect(route.error).toBeNull();
    expect(route.geometry).toEqual(line('b'));
  });

  it('clear() invalidates the in-flight fetch', async () => {
    route.update(SERVER, course('/resources/routes/a'));
    route.clear();

    pending[0]!.resolve(line('a'));
    await flush();
    expect(route.geometry).toBeNull();
    expect(route.loading).toBe(false);
  });
});

describe('route.update — metadata', () => {
  it('copies name, pointIndex and reverse from the active route', () => {
    route.update(SERVER, course('/resources/routes/a', { name: 'Home', pointIndex: 3, reverse: true }));
    expect(route.routeName).toBe('Home');
    expect(route.pointIndex).toBe(3);
    expect(route.reverse).toBe(true);
    expect(route.activeUuid).toBe('a');
  });

  it('a course without an active route resets the route metadata', () => {
    route.update(SERVER, course('/resources/routes/a', { name: 'Home', pointIndex: 3, reverse: true }));
    route.update(SERVER, { nextPoint: { longitude: 1, latitude: 2 } });
    expect(route.routeName).toBeNull();
    expect(route.pointIndex).toBe(0);
    expect(route.reverse).toBe(false);
    expect(route.nextPoint).toEqual({ longitude: 1, latitude: 2 });
  });

  it('an undefined course leaves the route metadata untouched but clears the points', () => {
    route.update(SERVER, {
      ...course('/resources/routes/a', { name: 'Home', pointIndex: 3, reverse: true }),
      nextPoint: { longitude: 1, latitude: 2 },
    });
    route.update(SERVER, undefined);
    expect(route.routeName).toBe('Home');
    expect(route.pointIndex).toBe(3);
    expect(route.reverse).toBe(true);
    expect(route.nextPoint).toBeNull();
    expect(route.activeHref).toBeNull();
  });
});
