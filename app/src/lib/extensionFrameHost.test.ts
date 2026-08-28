import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from '../stores/testStorage';
import {
  busHarness, envelope, noopMapControl, noopPanelControl, recordingRelay,
  type BusHarness,
} from './testExtensionBus';
import type { SkRelay } from './sk-relay';
import type { FrameState } from './extensionFrame';

/**
 * The controller is where connect/retry/teardown ordering lives, so these
 * cover the decisions components no longer make: connect before the document
 * runs, retry a frame that never announced itself, leave a live one alone on
 * reconnect, and release everything on detach.
 */

const FRAME_URL = 'http://ext.local/w.html';

let bus: BusHarness;

function fakeFrame(contentWindow: unknown) {
  const handlers = new Map<string, Set<() => void>>();
  return {
    contentWindow,
    isConnected: true,
    src: FRAME_URL,
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

async function attach(
  frame: ReturnType<typeof fakeFrame>,
  relay: SkRelay,
  onState?: (s: FrameState) => void,
) {
  const { attachExtensionFrame } = await import('./extensionFrameHost');
  return attachExtensionFrame({
    frame: frame as unknown as HTMLIFrameElement,
    url: FRAME_URL,
    extensionId: 'ext-a',
    context: { kind: 'widget', id: 'w', instanceId: 'i1' },
    relay,
    mapControl: noopMapControl,
    panelControl: noopPanelControl,
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
  bus = busHarness();
});

afterEach(() => {
  bus.restore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('extension frame attachment', () => {
  it('is listening before the document announces itself', async () => {
    const { relay } = recordingRelay();
    const frame = fakeFrame(bus.peer);
    const states: FrameState[] = [];
    const handle = await attach(frame, relay, (s) => states.push(s));

    // No `load` event yet — the document is still fetching its subresources,
    // but it has already started announcing.
    bus.deliver(envelope({ method: 'bus.ready' }));

    expect(handle?.state.phase).toBe('live');
    expect(states.at(-1)?.phase).toBe('live');
  });

  it('reloads a frame that never announces itself', async () => {
    const { relay } = recordingRelay();
    const frame = fakeFrame(bus.peer);
    const handle = await attach(frame, relay);

    vi.advanceTimersByTime(1000 + 100);

    expect(bus.reloads).toEqual([FRAME_URL]);
    expect(handle?.state.attempt).toBe(1);
  });

  it('grants a fresh grace period when a slow document finally loads', async () => {
    const { relay } = recordingRelay();
    const frame = fakeFrame(bus.peer);
    await attach(frame, relay);

    vi.advanceTimersByTime(900);
    frame.fire('load');
    vi.advanceTimersByTime(900);

    expect(bus.reloads).toEqual([]);
  });

  it('retries a stalled frame on reconnect but leaves a live one alone', async () => {
    const { relay } = recordingRelay();
    const frame = fakeFrame(bus.peer);
    const handle = await attach(frame, relay);

    // Exhaust the automatic attempts.
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(1000 + 200);
    expect(handle?.state.phase).toBe('stalled');
    const whileStalled = bus.reloads.length;

    handle?.noteReconnect();
    expect(bus.reloads.length).toBe(whileStalled + 1);

    bus.deliver(envelope({ method: 'bus.ready' }));
    expect(handle?.state.phase).toBe('live');

    handle?.noteReconnect();
    expect(bus.reloads.length).toBe(whileStalled + 1); // untouched
  });

  it('republishes instance state written elsewhere, and stops on detach', async () => {
    const { plotterExtensions } = await import('../stores/plotterExtensions.svelte');
    // Wrap the real registration so the disposer itself is observable: once
    // the endpoint is closed, publishing is a no-op either way, so the leak
    // this guards against is the *store* listener outliving the frame.
    const realWatch = plotterExtensions.onInstanceStateChanged.bind(plotterExtensions);
    const disposed = vi.fn();
    vi.spyOn(plotterExtensions, 'onInstanceStateChanged').mockImplementation((ext, inst, handler) => {
      const dispose = realWatch(ext, inst, handler);
      return () => { disposed(); dispose(); };
    });

    const { relay } = recordingRelay();
    const frame = fakeFrame(bus.peer);
    const handle = await attach(frame, relay);

    // A config panel's write only reaches the widget if it asked for the event.
    bus.deliver(envelope({ id: '1', method: 'events.subscribe', params: { patterns: ['state.changed'] } }));
    await Promise.resolve();

    plotterExtensions.setInstanceState('ext-a', 'i1', { units: 'kn' });
    const changed = () => bus.posted.filter(
      (p) => (p as { msg?: { method?: string } }).msg?.method === 'state.changed',
    ).length;
    expect(changed()).toBe(1);

    handle?.detach();
    expect(disposed).toHaveBeenCalledTimes(1);

    plotterExtensions.setInstanceState('ext-a', 'i1', { units: 'm/s' });
    expect(changed()).toBe(1); // nothing published into the dead frame
  });

  it('releases the frame, its listener and its subscriptions on detach', async () => {
    const { relay, unsubscribed } = recordingRelay();
    const frame = fakeFrame(bus.peer);
    const handle = await attach(frame, relay);

    bus.deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x'] } }));
    await Promise.resolve();

    handle?.detach();

    expect(unsubscribed).toEqual(['r1']);
    expect(frame.listenerCount('load')).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(bus.reloads).toEqual([]);  // no supervisor timers survive
  });

  it('declines a frame with no browsing context', async () => {
    const { relay } = recordingRelay();

    expect(await attach(fakeFrame(null), relay)).toBeNull();
  });
});
