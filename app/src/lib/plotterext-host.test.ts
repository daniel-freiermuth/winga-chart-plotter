import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
