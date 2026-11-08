import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { memStorage } from '../stores/testStorage';
import {
  busHarness, envelope, noopMapControl, noopPanelControl, recordingRelay,
  type BusHarness,
} from './testExtensionBus';
import type { SkRelay } from './sk-relay';

/**
 * A widget frame can be replaced under a live host connection — the supervisor
 * reloads stalled frames, and an extension page may navigate itself. Nobody
 * can unsubscribe the departed document's Signal K paths on its behalf, so the
 * host has to notice the replacement and do it, or the relay fans every value
 * out once per dead document forever.
 */

let bus: BusHarness;

async function connect(relay: SkRelay, onReady?: () => void) {
  const { createHostConnection } = await import('./plotterext-host');
  return createHostConnection(
    bus.peer as unknown as Window,
    'ext-a',
    { kind: 'widget', id: 'w', instanceId: 'i1' },
    relay,
    noopMapControl,
    noopPanelControl,
    onReady ? { onReady } : {},
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memStorage());
  vi.stubGlobal('window', { location: new URL('http://localhost:5173/') });
  bus = busHarness();
});

afterEach(() => {
  bus.restore();
  vi.unstubAllGlobals();
});

describe('extension host connection', () => {
  it('answers every bus.ready with a handshake', async () => {
    const { relay } = recordingRelay();
    await connect(relay);

    // The client re-announces until it is answered, and cannot tell a lost
    // handshake from one still in flight. A host that replied only to the
    // first announcement would strand it for good.
    for (let i = 0; i < 3; i++) bus.deliver(envelope({ method: 'bus.ready' }));

    const handshakes = bus.posted.filter(
      (p) => (p as { msg?: { method?: string } }).msg?.method === 'bus.handshake',
    );
    expect(handshakes).toHaveLength(3);
  });

  it('releases the previous document subscriptions when a new one announces itself', async () => {
    const { relay, subscribed, unsubscribed } = recordingRelay();
    await connect(relay);

    bus.deliver(envelope({ method: 'bus.ready' }));
    bus.deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x', 'nav.y'] } }));
    await Promise.resolve();
    expect(subscribed).toEqual(['r1:nav.x', 'r2:nav.y']);
    expect(unsubscribed).toEqual([]);

    // The frame was reloaded; the fresh document announces itself.
    bus.deliver(envelope({ method: 'bus.ready' }));

    expect(unsubscribed).toEqual(['r1', 'r2']);
  });

  it('leaves a retrying document alone — repeated announcements are not a new frame', async () => {
    const { relay, unsubscribed } = recordingRelay();
    const readies: number[] = [];
    await connect(relay, () => readies.push(1));

    // connectExtension re-announces every 250 ms until it is answered.
    bus.deliver(envelope({ method: 'bus.ready' }));
    bus.deliver(envelope({ method: 'bus.ready' }));
    bus.deliver(envelope({ method: 'bus.ready' }));

    expect(readies).toHaveLength(3);
    expect(unsubscribed).toEqual([]);
  });

  it('releases subscriptions when the connection is closed', async () => {
    const { relay, unsubscribed } = recordingRelay();
    const host = await connect(relay);

    bus.deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x'] } }));
    await Promise.resolve();

    host.close();

    expect(unsubscribed).toEqual(['r1']);
  });

  it('honours an explicit signalk.unsubscribe without double-releasing later', async () => {
    const { relay, unsubscribed } = recordingRelay();
    const host = await connect(relay);

    bus.deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x'] } }));
    await Promise.resolve();
    bus.deliver(envelope({ id: '2', method: 'signalk.unsubscribe', params: { subscriptionId: 'sk-sub-1' } }));
    await Promise.resolve();
    expect(unsubscribed).toEqual(['r1']);

    // Nothing is registered any more, so neither a new document nor close
    // may unsubscribe it a second time.
    bus.deliver(envelope({ method: 'bus.ready' }));
    host.close();

    expect(unsubscribed).toEqual(['r1']);
  });

  it('rejects instance-scoped calls from a context with no instance', async () => {
    const { createHostConnection } = await import('./plotterext-host');
    const { relay } = recordingRelay();
    createHostConnection(
      bus.peer as unknown as Window,
      'ext-a',
      { kind: 'panel', id: 'p', instanceId: null },
      relay, noopMapControl, noopPanelControl,
    );

    bus.deliver(envelope({ id: '1', method: 'ui.openConfigPanel' }));
    await Promise.resolve();

    const reply = bus.posted.find(
      (p) => (p as { msg?: { id?: string } }).msg?.id === '1',
    ) as { msg: { error?: { message: string } } } | undefined;
    expect(reply?.msg.error?.message).toContain('No widget instance');
  });

  // A side panel opened via ui.openPanel/togglePanel has no widget instance.
  // Scope-less state calls must fall back to the extension scope (as the
  // Plotter Extensions spec and Freeboard-SK do), not fail with no_instance.
  it('defaults state.get/state.set to extension scope in a context with no instance', async () => {
    const { createHostConnection } = await import('./plotterext-host');
    const { plotterExtensions } = await import('../stores/plotterExtensions.svelte');
    const { relay } = recordingRelay();
    createHostConnection(
      bus.peer as unknown as Window,
      'ext-a',
      { kind: 'panel', id: 'p', instanceId: null },
      relay, noopMapControl, noopPanelControl,
    );
    plotterExtensions.setExtState('ext-a', { x: 1 });

    bus.deliver(envelope({ id: '1', method: 'state.get', params: { keys: ['x'] } }));
    bus.deliver(envelope({ id: '2', method: 'state.set', params: { values: { y: 2 } } }));
    await Promise.resolve();

    const reply = (id: string) => bus.posted.find(
      (p) => (p as { msg?: { id?: string } }).msg?.id === id,
    ) as { msg: { result?: unknown; error?: { message: string } } } | undefined;
    expect(reply('1')?.msg.error).toBeUndefined();
    expect(reply('1')?.msg.result).toEqual({ values: { x: 1 } });
    expect(reply('2')?.msg.error).toBeUndefined();
    expect(plotterExtensions.getExtState('ext-a', ['y'])).toEqual({ y: 2 });
  });
});

/**
 * `signalk.put` writes to the Signal K server with the user's credentials on an
 * extension's behalf. The host is the only thing scoping those writes to
 * own-vessel paths, and the only thing turning server/network failures into an
 * error the extension can act on before the bus gives up on the call.
 */
describe('signalk.put', () => {
  const SK_BASE = 'http://sk.local:3000';

  interface PutReply { result?: unknown; error?: { code: number; message: string; data?: { reason?: string } } }

  function replyTo(id: string): PutReply | undefined {
    for (const p of bus.posted) {
      if (typeof p !== 'object' || p === null || !('msg' in p)) continue;
      const { msg } = p;
      if (typeof msg === 'object' && msg !== null && 'id' in msg && msg.id === id) {
        const reply = msg as PutReply; // wire shape of a JSON-RPC response
        return reply;
      }
    }
    return undefined;
  }

  /** Drain the promise chain behind an async handler (fetch → reply post). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  async function put(id: string, params: unknown): Promise<PutReply | undefined> {
    bus.deliver(envelope({ id, method: 'signalk.put', params }));
    await settle();
    return replyTo(id);
  }

  let fetchMock: Mock<typeof fetch>;

  beforeEach(async () => {
    localStorage.setItem('signalk-chart-settings', JSON.stringify({
      signalkProtocol: 'ws', signalkHost: 'sk.local', signalkPort: 3000,
    }));
    localStorage.setItem('sk-auth', JSON.stringify({
      serverBase: SK_BASE, token: 'tok-123', username: 'skipper',
    }));
    // auth.init probes the server; an unreachable one keeps the stored token.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.reject(new Error('offline'))));
    // Imported after the storage seeding above (modules are reset per test), so
    // the fresh store instance reads it — a static import would not.
    const { auth } = await import('../stores/auth.svelte');
    await auth.init(SK_BASE);

    fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await connect(recordingRelay().relay);
  });

  it('PUTs the value to the own-vessel path with the user credentials', async () => {
    const reply = await put('1', { path: 'navigation.anchor.position', value: { latitude: 1, longitude: 2 } });

    expect(reply?.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${SK_BASE}/signalk/v1/api/vessels/self/navigation/anchor/position`);
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer tok-123' });
    expect(init?.body).toBe(JSON.stringify({ value: { latitude: 1, longitude: 2 } }));
  });

  it.each([
    ['percent-encoded dot segments', '%2e%2e.%2e%2e.%2e%2e.%2e%2e.%2e%2e.plugins.foo.config'],
    ['a slash', 'navigation/../../plugins'],
    ['a query', 'navigation.anchor?x=1'],
    ['a fragment', 'navigation.anchor#x'],
    ['an empty segment', 'navigation..anchor'],
    ['a leading dot', '.navigation'],
    ['a trailing dot', 'navigation.'],
  ])('rejects a path with %s without touching the server', async (_label, path) => {
    const reply = await put('1', { path, value: 1 });

    expect(reply?.error?.data?.reason).toBe('invalid_path');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['empty', { path: '' }],
    ['not a string', { path: 42 }],
    ['absent with no params', undefined],
  ])('answers an invalid-params error when the path is %s', async (_label, params) => {
    const reply = await put('1', params);

    expect(reply?.error?.code).toBe(-32602);
    expect(reply?.error?.data?.reason).toBe('invalid_path');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'put_failed'],
    [500, 'put_failed'],
  ])('maps HTTP %i to reason %s', async (status, reason) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));

    const reply = await put('1', { path: 'steering.autopilot.state', value: 'auto' });

    expect(reply?.error?.code).toBe(-32000);
    expect(reply?.error?.data?.reason).toBe(reason);
    expect(reply?.error?.message).toContain(String(status));
  });

  it('reports a network failure as put_unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const reply = await put('1', { path: 'steering.autopilot.state', value: 'auto' });

    expect(reply?.error?.data?.reason).toBe('put_unreachable');
    expect(reply?.error?.message).toContain('Failed to fetch');
  });

  it('fails a wedged server within 8 s — before the bus gives up on the call at 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Route AbortSignal.timeout through the faked clock so the budget can be
      // observed without waiting on Node's internal timers.
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const ctl = new AbortController();
        setTimeout(() => { ctl.abort(new DOMException('The operation timed out.', 'TimeoutError')); }, ms);
        return ctl.signal;
      });
      fetchMock.mockImplementationOnce((_url, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        const signal = init?.signal;
        signal?.addEventListener('abort', () => { reject(signal.reason); });
        return promise;
      });

      bus.deliver(envelope({ id: '1', method: 'signalk.put', params: { path: 'steering.autopilot.state', value: 'auto' } }));
      await vi.advanceTimersByTimeAsync(7_999);
      await settle();
      expect(replyTo('1')).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(replyTo('1')?.error?.data?.reason).toBe('put_unreachable');
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
