import { describe, expect, it, vi } from 'vitest';
import { createSkRelay, type SkSelfValue } from './sk-relay';

/**
 * The relay fans Signal K deltas out to every extension widget. It is shared
 * state across widgets, so the properties that matter are isolation (one
 * broken widget cannot starve the others) and correct re-announcement after a
 * reconnect.
 */

/** One delta's own-vessel entries, as the WASM client posts them. */
function delta(path: string, value: unknown): SkSelfValue[] {
  return [{ path, value, timestamp: '2026-01-01T00:00:00.000Z' }];
}

describe('sk relay', () => {
  // Signal K servers accept only unsubscribe-all
  // (`{"context":"*","unsubscribe":[{"path":"*"}]}`) and close the stream on
  // any other unsubscribe; unsubscribe-all would also cancel the app's own
  // navigation/AIS subscriptions, which share the socket. Releasing a path
  // therefore must not send anything upstream.
  it('subscribes upstream once per path and sends no unsubscribe when the last listener leaves', () => {
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));
    relay.resubscribe();            // connected

    const a = relay.subscribe('navigation.speedOverGround', () => { /* noop */ });
    const b = relay.subscribe('navigation.speedOverGround', () => { /* noop */ });
    relay.unsubscribe(a);
    relay.unsubscribe(b);

    expect(sent.map((m) => JSON.parse(m) as unknown)).toEqual([
      { context: 'vessels.self', subscribe: [{ path: 'navigation.speedOverGround', period: 1000 }] },
    ]);
  });

  it('does not stack a second server subscription when a released path is taken again', () => {
    // The server is still streaming the released path; a repeated subscribe
    // on the same socket would make it deliver every value twice.
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));
    relay.resubscribe();            // connected

    relay.unsubscribe(relay.subscribe('nav.x', () => { /* noop */ }));
    relay.subscribe('nav.x', () => { /* noop */ });

    expect(sent).toHaveLength(1);
  });

  it('subscribes a released path again once it is taken on a new connection', () => {
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));
    relay.resubscribe();            // connected
    relay.unsubscribe(relay.subscribe('nav.x', () => { /* noop */ }));
    sent.length = 0;

    relay.resubscribe();            // reconnected: the new socket streams nothing yet
    relay.subscribe('nav.x', () => { /* noop */ });

    expect(sent.map((m) => JSON.parse(m) as unknown)).toEqual([
      { context: 'vessels.self', subscribe: [{ path: 'nav.x', period: 1000 }] },
    ]);
  });

  it('re-announces every live path after a reconnect', () => {
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));
    relay.resubscribe();            // connected
    relay.subscribe('a.b', () => { /* noop */ });
    relay.subscribe('c.d', () => { /* noop */ });
    sent.length = 0;
    relay.disconnected();

    relay.resubscribe();

    expect(sent).toHaveLength(2);
    expect(sent.join()).toContain('"path":"a.b"');
    expect(sent.join()).toContain('"path":"c.d"');
  });

  it('sends a path taken before the connection is announced open exactly once', () => {
    // The worker reports Connected from the socket's onopen; a subscribe the
    // main thread handles before that status arrives already reaches the open
    // socket, and the resubscribe() the status triggers must not stack a copy.
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));

    relay.subscribe('nav.x', () => { /* noop */ });   // Connected still in flight
    relay.resubscribe();                                // Connected handled

    expect(sent.map((m) => JSON.parse(m) as unknown)).toEqual([
      { context: 'vessels.self', subscribe: [{ path: 'nav.x', period: 1000 }] },
    ]);
  });

  it('holds a path taken while disconnected for the next connection', () => {
    // The worker may already have opened the replacement socket while its
    // Connected status is still in flight to the main thread.
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));
    relay.resubscribe();            // connected
    relay.disconnected();           // dropped

    relay.subscribe('nav.x', () => { /* noop */ });
    relay.resubscribe();            // next socket's Connected handled

    expect(sent.map((m) => JSON.parse(m) as unknown)).toEqual([
      { context: 'vessels.self', subscribe: [{ path: 'nav.x', period: 1000 }] },
    ]);
  });

  it('keeps delivering to other subscribers when one throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const relay = createSkRelay(() => { /* noop */ });
    const seen: unknown[] = [];
    // A widget being torn down: posting into its dead frame throws.
    relay.subscribe('nav.x', () => { throw new Error('frame is gone'); });
    relay.subscribe('nav.x', (_p, v) => seen.push(v));

    relay.feed(delta('nav.x', 42));

    expect(seen).toEqual([42]);
  });

  it('survives a subscriber unsubscribing during fan-out', () => {
    const relay = createSkRelay(() => { /* noop */ });
    const seen: unknown[] = [];
    let first = '';
    first = relay.subscribe('nav.x', () => { relay.unsubscribe(first); });
    relay.subscribe('nav.x', (_p, v) => seen.push(v));

    relay.feed(delta('nav.x', 7));

    expect(seen).toEqual([7]);
  });

  it('does not deliver the in-flight delta to a subscriber added during fan-out', () => {
    const relay = createSkRelay(() => { /* noop */ });
    const seen: unknown[] = [];
    let added = false;
    relay.subscribe('nav.x', () => {
      if (added) return;
      added = true;
      relay.subscribe('nav.x', (_p, v) => seen.push(v));
    });

    relay.feed(delta('nav.x', 7));
    expect(seen).toEqual([]);      // the snapshot is what gets delivered

    relay.feed(delta('nav.x', 8));
    expect(seen).toEqual([8]);
  });

  it('delivers each subscribed entry of a batch with its own timestamp, skipping others', () => {
    const relay = createSkRelay(() => { /* noop */ });
    const seen: unknown[][] = [];
    relay.subscribe('nav.x', (p, v, ts) => seen.push([p, v, ts]));

    relay.feed([
      { path: 'other.path', value: 1, timestamp: 'a' },
      { path: 'nav.x', value: 2, timestamp: null },
      { path: 'nav.x', value: 3, timestamp: 'b' },
    ]);

    expect(seen).toEqual([['nav.x', 2, null], ['nav.x', 3, 'b']]);
  });
});
