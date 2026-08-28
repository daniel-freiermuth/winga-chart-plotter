import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from './testStorage';
import type { ExtensionManifest, WidgetPlacement } from './plotterExtensions.svelte';

/**
 * Manifest loading is the single point of failure for widgets: an empty
 * `extensions` map means every placed widget disappears. These cover the
 * server states that used to produce exactly that, silently and permanently —
 * server down at boot, server restarting, resource provider registering late.
 *
 * The store is a module singleton, so every test re-imports it fresh.
 */

const BASE = 'http://sk.local';

function manifest(over: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    name: 'Demo', version: '1.0.0', apiVersion: '1', requires: ['widgets'],
    widgets: [{ id: 'w', title: 'W', type: 'iframe', url: '/w.html', size: '1x1' }],
    ...over,
  };
}

function placement(extensionId: string): WidgetPlacement {
  return { instanceId: 'i1', extensionId, widgetId: 'w', x: 10, y: 10 };
}

/** Queue of fetch outcomes, consumed one per call; the last one repeats. */
function stubFetch(outcomes: (Record<string, unknown> | Error | number)[]) {
  const calls = { n: 0 };
  vi.stubGlobal('fetch', vi.fn(() => {
    const outcome = outcomes[Math.min(calls.n++, outcomes.length - 1)];
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (typeof outcome === 'number') {
      return Promise.resolve({ ok: false, status: outcome, statusText: 'nope' } as Response);
    }
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      json: () => Promise.resolve(outcome),
    } as unknown as Response);
  }));
  return calls;
}

async function freshStore() {
  vi.resetModules();
  const mod = await import('./plotterExtensions.svelte');
  return mod.plotterExtensions;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', memStorage());
  vi.stubGlobal('window', { location: new URL('http://localhost:5173/') });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('extension manifest loading', () => {
  it('loads and capability-filters manifests', async () => {
    stubFetch([{
      ok: manifest(),
      wrongApi: manifest({ apiVersion: '2' }),
      unsupported: manifest({ requires: ['telepathy'] }),
      notAnObject: 'nope',
    }]);
    const store = await freshStore();

    await store.load(BASE);

    expect([...store.extensions.keys()]).toEqual(['ok']);
    expect(store.status).toBe('ready');
    expect(store.error).toBeNull();
  });

  it('retries with backoff when the server is unreachable', async () => {
    const calls = stubFetch([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), { ok: manifest() }]);
    const store = await freshStore();

    await store.load(BASE);
    expect(store.status).toBe('error');
    expect(store.error).toContain('ECONNREFUSED');
    expect(calls.n).toBe(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls.n).toBe(1);                       // backoff not elapsed
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.n).toBe(2);

    await vi.advanceTimersByTimeAsync(4000);       // doubled
    expect(calls.n).toBe(3);
    expect(store.status).toBe('ready');
    expect([...store.extensions.keys()]).toEqual(['ok']);
  });

  it('treats a non-OK response as a failure and keeps retrying', async () => {
    const calls = stubFetch([503, { ok: manifest() }]);
    const store = await freshStore();

    await store.load(BASE);
    expect(store.status).toBe('error');
    expect(store.error).toContain('503');

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.n).toBe(2);
    expect(store.status).toBe('ready');
  });

  it('keeps already-loaded extensions when the server goes away', async () => {
    stubFetch([{ ok: manifest() }, new Error('server restarting')]);
    const store = await freshStore();
    await store.load(BASE);
    expect(store.extensions.has('ok')).toBe(true);

    store.reload();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.status).toBe('error');
    // The widget on screen must ride out the restart.
    expect(store.extensions.has('ok')).toBe(true);
  });

  it('does not drop an extension that is absent from a single load', async () => {
    stubFetch([{ ok: manifest() }, {}]);
    const store = await freshStore();
    await store.load(BASE);

    store.reload();
    await vi.advanceTimersByTimeAsync(0);

    // A server that has just restarted serves an empty list for a while.
    expect(store.extensions.has('ok')).toBe(true);
  });

  it('drops an extension that stays absent across two loads', async () => {
    stubFetch([{ ok: manifest() }, {}, {}]);
    const store = await freshStore();
    await store.load(BASE);

    store.reload();
    await vi.advanceTimersByTimeAsync(0);
    store.reload();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.extensions.has('ok')).toBe(false);
  });

  it('re-checks when a placed widget still has no manifest', async () => {
    localStorage.setItem('plotterext:layout', JSON.stringify([placement('late')]));
    const calls = stubFetch([{}, {}, { late: manifest() }]);
    const store = await freshStore();

    await store.load(BASE);
    expect(store.status).toBe('ready');
    expect(calls.n).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.n).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.n).toBe(3);

    expect(store.extensions.has('late')).toBe(true);
    // Layout satisfied — the re-check chain stops.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.n).toBe(3);
  });

  it('bounds the re-check chain when the extension never appears', async () => {
    localStorage.setItem('plotterext:layout', JSON.stringify([placement('never')]));
    const calls = stubFetch([{}]);
    const store = await freshStore();

    await store.load(BASE);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(calls.n).toBe(6);   // initial + MAX_INCOMPLETE_RECHECKS
  });

  it('shares one request between concurrent callers', async () => {
    const calls = stubFetch([{ ok: manifest() }]);
    const store = await freshStore();

    await Promise.all([store.load(BASE), store.load(BASE), store.load(BASE)]);

    expect(calls.n).toBe(1);
  });

  it('ignores a stale response after the server URL changed', async () => {
    let resolveFirst: (v: unknown) => void = () => { /* set below */ };
    const first = new Promise((r) => { resolveFirst = r; });
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith(BASE)) {
        return first.then(() => ({
          ok: true, status: 200, statusText: 'OK',
          json: () => Promise.resolve({ stale: manifest() }),
        }) as unknown as Response);
      }
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK',
        json: () => Promise.resolve({ fresh: manifest() }),
      } as unknown as Response);
    }));
    const store = await freshStore();

    const pending = store.load(BASE);
    await store.load('http://other.local');
    resolveFirst(null);
    await pending;

    expect([...store.extensions.keys()]).toEqual(['fresh']);
  });

  it('discards the previous server manifests when the server changes', async () => {
    localStorage.setItem('plotterext:layout', JSON.stringify([placement('old')]));
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      json: () => Promise.resolve(url.startsWith(BASE) ? { old: manifest() } : {}),
    } as unknown as Response)));
    const store = await freshStore();
    await store.load(BASE);
    expect(store.extensions.has('old')).toBe(true);

    // The absent-streak grace period is for a restart of the same server: it
    // must not keep another server's manifest alive, or the widget renders
    // with the old manifest's URL resolved against the new host.
    await store.load('http://other.local');

    expect(store.extensions.has('old')).toBe(false);
  });

  it('reports loading rather than ready while the new server is being fetched', async () => {
    let release = (): void => { /* replaced below */ };
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith(BASE)) {
        return Promise.resolve({
          ok: true, status: 200, statusText: 'OK',
          json: () => Promise.resolve({ old: manifest() }),
        } as unknown as Response);
      }
      return held.then(() => ({
        ok: true, status: 200, statusText: 'OK',
        json: () => Promise.resolve({}),
      }) as unknown as Response);
    }));
    const store = await freshStore();
    await store.load(BASE);
    expect(store.status).toBe('ready');

    const pending = store.load('http://other.local');
    expect(store.status).toBe('loading');

    release();
    await pending;
    expect(store.status).toBe('ready');
  });

  it('only rewrites map entries whose manifest actually changed', async () => {
    stubFetch([{ ok: manifest() }, { ok: manifest() }]);
    const store = await freshStore();
    await store.load(BASE);
    const before = store.extensions.get('ok');

    store.reload();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.extensions.get('ok')).toBe(before);
  });

  it('times the request out instead of hanging the retry chain', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('TimeoutError')); });
      })));
    const store = await freshStore();

    const load = store.load(BASE);
    expect(store.status).toBe('loading');
    // AbortSignal.timeout is not driven by fake timers — abort it directly to
    // assert the store reacts to the abort rather than waiting forever.
    const controller = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[1];
    expect(controller?.signal).toBeDefined();
    controller?.signal?.dispatchEvent(new Event('abort'));
    await load;

    expect(store.status).toBe('error');
  });
});
