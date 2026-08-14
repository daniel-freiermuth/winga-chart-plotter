import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from '../stores/testStorage';
import type { SkRelay } from './sk-relay';
import type { MapControl, PanelControl } from './plotterext-host';
import type { FrameState } from './extensionFrame';

/**
 * The controller is where connect/retry/teardown ordering lives, so these
 * cover the decisions components no longer make: connect before the document
 * runs, retry a frame that never announced itself, leave a live one alone on
 * reconnect, and release everything on detach.
 */

const BUS = 'plotterExt/1';

function envelope(msg: Record<string, unknown>): unknown {
  return { bus: BUS, msg: { jsonrpc: '2.0', ...msg } };
}

/** Message pump `windowPort` listens on, plus a peer window standing in for
 *  the frame's browsing context. */
function harness() {
  const listeners: ((ev: unknown) => void)[] = [];
  vi.stubGlobal('addEventListener', (type: string, fn: (ev: unknown) => void) => {
    if (type === 'message') listeners.push(fn);
  });
  vi.stubGlobal('removeEventListener', (_type: string, fn: (ev: unknown) => void) => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  });

  const replace = vi.fn();
  const peer = { postMessage: vi.fn(), location: { replace } };
  const deliver = (data: unknown): void => {
    for (const fn of [...listeners]) fn({ source: peer, origin: 'http://ext.local', data });
  };
  return { peer, replace, deliver };
}

function fakeFrame(contentWindow: unknown) {
  const handlers = new Map<string, Set<() => void>>();
  return {
    contentWindow,
    isConnected: true,
    src: 'http://ext.local/w.html',
    addEventListener(type: string, fn: () => void) {
      let set = handlers.get(type);
      if (!set) { set = new Set(); handlers.set(type, set); }
      set.add(fn);
    },
    removeEventListener(type: string, fn: () => void) { handlers.get(type)?.delete(fn); },
    fire(type: string) { for (const fn of [...(handlers.get(type) ?? [])]) fn(); },
    listenerCount(type: string) { return handlers.get(type)?.size ?? 0; },
  };
}

function recordingRelay() {
  const unsubscribed: string[] = [];
  let seq = 0;
  const relay: SkRelay = {
    feed: () => { /* unused */ },
    subscribe: () => `r${String(++seq)}`,
    unsubscribe: (id) => { unsubscribed.push(id); },
    resubscribe: () => { /* unused */ },
  };
  return { relay, unsubscribed };
}

const noopMap: MapControl = {
  getView: () => ({ center: [0, 0], zoom: 0, bounds: [0, 0, 0, 0] }),
  flyTo: () => { /* noop */ }, fitBounds: () => { /* noop */ },
};
const noopPanels: PanelControl = {
  openPanel: () => { /* noop */ }, togglePanel: () => { /* noop */ },
  closePanel: () => { /* noop */ }, openConfigPanel: () => { /* noop */ },
  toggleConfigPanel: () => { /* noop */ },
};

async function attach(
  frame: ReturnType<typeof fakeFrame>,
  relay: SkRelay,
  onState?: (s: FrameState) => void,
) {
  const { attachExtensionFrame } = await import('./extensionFrameHost');
  return attachExtensionFrame({
    frame: frame as unknown as HTMLIFrameElement,
    url: 'http://ext.local/w.html',
    extensionId: 'ext-a',
    context: { kind: 'widget', id: 'w', instanceId: 'i1' },
    relay,
    mapControl: noopMap,
    panelControl: noopPanels,
    watchInstanceState: true,
    ...(onState ? { onState } : {}),
    supervision: { handshakeTimeoutMs: 1000, retryBaseMs: 100, maxAutoAttempts: 2 },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubGlobal('localStorage', memStorage());
  vi.stubGlobal('window', { location: new URL('http://localhost:5173/') });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('extension frame attachment', () => {
  it('is listening before the document announces itself', async () => {
    const { peer, deliver } = harness();
    const { relay } = recordingRelay();
    const frame = fakeFrame(peer);
    const states: FrameState[] = [];
    const handle = await attach(frame, relay, (s) => states.push(s));

    // No `load` event yet — the document is still fetching its subresources,
    // but it has already started announcing.
    deliver(envelope({ method: 'bus.ready' }));

    expect(handle?.state.phase).toBe('live');
    expect(states.at(-1)?.phase).toBe('live');
  });

  it('reloads a frame that never announces itself', async () => {
    const { peer, replace } = harness();
    const { relay } = recordingRelay();
    const frame = fakeFrame(peer);
    const handle = await attach(frame, relay);

    vi.advanceTimersByTime(1000 + 100);

    expect(replace).toHaveBeenCalledWith('http://ext.local/w.html');
    expect(handle?.state.attempt).toBe(1);
  });

  it('grants a fresh grace period when a slow document finally loads', async () => {
    const { peer, replace } = harness();
    const { relay } = recordingRelay();
    const frame = fakeFrame(peer);
    await attach(frame, relay);

    vi.advanceTimersByTime(900);
    frame.fire('load');
    vi.advanceTimersByTime(900);

    expect(replace).not.toHaveBeenCalled();
  });

  it('retries a stalled frame on reconnect but leaves a live one alone', async () => {
    const { peer, replace, deliver } = harness();
    const { relay } = recordingRelay();
    const frame = fakeFrame(peer);
    const handle = await attach(frame, relay);

    // Exhaust the automatic attempts.
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(1000 + 200);
    expect(handle?.state.phase).toBe('stalled');
    const reloadsWhileStalled = replace.mock.calls.length;

    handle?.noteReconnect();
    expect(replace.mock.calls.length).toBe(reloadsWhileStalled + 1);

    deliver(envelope({ method: 'bus.ready' }));
    expect(handle?.state.phase).toBe('live');

    handle?.noteReconnect();
    expect(replace.mock.calls.length).toBe(reloadsWhileStalled + 1); // untouched
  });

  it('releases the frame, its listener and its subscriptions on detach', async () => {
    const { peer, replace, deliver } = harness();
    const { relay, unsubscribed } = recordingRelay();
    const frame = fakeFrame(peer);
    const handle = await attach(frame, relay);

    deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x'] } }));
    await Promise.resolve();

    handle?.detach();

    expect(unsubscribed).toEqual(['r1']);
    expect(frame.listenerCount('load')).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(replace).not.toHaveBeenCalled();  // no supervisor timers survive
  });

  it('declines a frame with no browsing context', async () => {
    harness();
    const { relay } = recordingRelay();

    expect(await attach(fakeFrame(null), relay)).toBeNull();
  });
});
