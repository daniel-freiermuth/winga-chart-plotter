import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from '../stores/testStorage';
import type { SkRelay } from './sk-relay';
import type { MapControl, PanelControl } from './plotterext-host';

/**
 * A widget frame can be replaced under a live host connection — the supervisor
 * reloads stalled frames, and an extension page may navigate itself. Nobody
 * can unsubscribe the departed document's Signal K paths on its behalf, so the
 * host has to notice the replacement and do it, or the relay fans every value
 * out once per dead document forever.
 */

const BUS = 'plotterExt/1';

interface FakePeer { postMessage: (data: unknown, origin: string) => void }

function envelope(msg: Record<string, unknown>): unknown {
  return { bus: BUS, msg: { jsonrpc: '2.0', ...msg } };
}

function recordingRelay() {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let seq = 0;
  const relay: SkRelay = {
    feed: () => { /* unused */ },
    subscribe: (path) => { const id = `r${String(++seq)}`; subscribed.push(`${id}:${path}`); return id; },
    unsubscribe: (id) => { unsubscribed.push(id); },
    resubscribe: () => { /* unused */ },
  };
  return { relay, subscribed, unsubscribed };
}

/** Harness: a fake peer window plus the message pump `windowPort` listens on. */
function harness() {
  const listeners: ((ev: unknown) => void)[] = [];
  vi.stubGlobal('addEventListener', (type: string, fn: (ev: unknown) => void) => {
    if (type === 'message') listeners.push(fn);
  });
  vi.stubGlobal('removeEventListener', (_type: string, fn: (ev: unknown) => void) => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  });

  const posted: unknown[] = [];
  const peer: FakePeer = { postMessage: (data) => posted.push(data) };
  const deliver = (data: unknown): void => {
    for (const fn of [...listeners]) fn({ source: peer, origin: 'http://ext.local', data });
  };
  return { peer, posted, deliver };
}

const noopMap: MapControl = {
  getView: () => ({ center: [0, 0], zoom: 0, bounds: [0, 0, 0, 0] }),
  flyTo: () => { /* noop */ },
  fitBounds: () => { /* noop */ },
};
const noopPanels: PanelControl = {
  openPanel: () => { /* noop */ }, togglePanel: () => { /* noop */ },
  closePanel: () => { /* noop */ }, openConfigPanel: () => { /* noop */ },
  toggleConfigPanel: () => { /* noop */ },
};

async function connect(peer: FakePeer, relay: SkRelay, onReady?: () => void) {
  const { createHostConnection } = await import('./plotterext-host');
  return createHostConnection(
    peer as unknown as Window,
    'ext-a',
    { kind: 'widget', id: 'w', instanceId: 'i1' },
    relay,
    noopMap,
    noopPanels,
    onReady ? { onReady } : {},
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memStorage());
  vi.stubGlobal('window', { location: new URL('http://localhost:5173/') });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('extension host connection', () => {
  it('answers every bus.ready with a handshake', async () => {
    const { peer, posted, deliver } = harness();
    const { relay } = recordingRelay();
    await connect(peer, relay);

    deliver(envelope({ method: 'bus.ready' }));

    const handshakes = posted.filter(
      (p) => (p as { msg?: { method?: string } }).msg?.method === 'bus.handshake',
    );
    expect(handshakes).toHaveLength(1);
  });

  it('releases the previous document subscriptions when a new one announces itself', async () => {
    const { peer, deliver } = harness();
    const { relay, subscribed, unsubscribed } = recordingRelay();
    await connect(peer, relay);

    deliver(envelope({ method: 'bus.ready' }));
    deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x', 'nav.y'] } }));
    await Promise.resolve();
    expect(subscribed).toEqual(['r1:nav.x', 'r2:nav.y']);
    expect(unsubscribed).toEqual([]);

    // The frame was reloaded; the fresh document announces itself.
    deliver(envelope({ method: 'bus.ready' }));

    expect(unsubscribed).toEqual(['r1', 'r2']);
  });

  it('leaves a retrying document alone — repeated announcements are not a new frame', async () => {
    const { peer, deliver } = harness();
    const { relay, unsubscribed } = recordingRelay();
    const readies: number[] = [];
    await connect(peer, relay, () => readies.push(1));

    // connectExtension re-announces every 250 ms until it is answered.
    deliver(envelope({ method: 'bus.ready' }));
    deliver(envelope({ method: 'bus.ready' }));
    deliver(envelope({ method: 'bus.ready' }));

    expect(readies).toHaveLength(3);
    expect(unsubscribed).toEqual([]);
  });

  it('releases subscriptions when the connection is closed', async () => {
    const { peer, deliver } = harness();
    const { relay, unsubscribed } = recordingRelay();
    const host = await connect(peer, relay);

    deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x'] } }));
    await Promise.resolve();

    host.close();

    expect(unsubscribed).toEqual(['r1']);
  });

  it('honours an explicit signalk.unsubscribe without double-releasing later', async () => {
    const { peer, deliver } = harness();
    const { relay, unsubscribed } = recordingRelay();
    const host = await connect(peer, relay);

    deliver(envelope({ id: '1', method: 'signalk.subscribe', params: { paths: ['nav.x'] } }));
    await Promise.resolve();
    deliver(envelope({ id: '2', method: 'signalk.unsubscribe', params: { subscriptionId: 'sk-sub-1' } }));
    await Promise.resolve();
    expect(unsubscribed).toEqual(['r1']);

    // Nothing is registered any more, so neither a new document nor close
    // may unsubscribe it a second time.
    deliver(envelope({ method: 'bus.ready' }));
    host.close();

    expect(unsubscribed).toEqual(['r1']);
  });

  it('rejects instance-scoped calls from a context with no instance', async () => {
    const { createHostConnection } = await import('./plotterext-host');
    const { peer, posted, deliver } = harness();
    const { relay } = recordingRelay();
    createHostConnection(
      peer as unknown as Window,
      'ext-a',
      { kind: 'panel', id: 'p', instanceId: null },
      relay, noopMap, noopPanels,
    );

    deliver(envelope({ id: '1', method: 'ui.openConfigPanel' }));
    await Promise.resolve();

    const reply = posted.find(
      (p) => (p as { msg?: { id?: string } }).msg?.id === '1',
    ) as { msg: { error?: { message: string } } } | undefined;
    expect(reply?.msg.error?.message).toContain('No widget instance');
  });
});
