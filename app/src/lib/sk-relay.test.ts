import { describe, expect, it, vi } from 'vitest';
import { createSkRelay } from './sk-relay';

/**
 * The relay fans Signal K deltas out to every extension widget. It is shared
 * state across widgets, so the properties that matter are isolation (one
 * broken widget cannot starve the others) and correct re-announcement after a
 * reconnect.
 */

function delta(path: string, value: unknown) {
  return JSON.stringify({
    context: 'vessels.self',
    updates: [{ timestamp: '2026-01-01T00:00:00.000Z', values: [{ path, value }] }],
  });
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

    relay.unsubscribe(relay.subscribe('nav.x', () => { /* noop */ }));
    relay.subscribe('nav.x', () => { /* noop */ });

    expect(sent).toHaveLength(1);
  });

  it('subscribes a released path again once it is taken on a new connection', () => {
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));
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
    relay.subscribe('a.b', () => { /* noop */ });
    relay.subscribe('c.d', () => { /* noop */ });
    sent.length = 0;

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

  it('ignores malformed or irrelevant payloads', () => {
    const relay = createSkRelay(() => { /* noop */ });
    const seen: unknown[] = [];
    relay.subscribe('nav.x', (_p, v) => seen.push(v));

    relay.feed('not json');
    relay.feed(JSON.stringify({ updates: null }));
    relay.feed(JSON.stringify({ updates: [{ timestamp: 't' }] }));
    relay.feed(delta('other.path', 1));

    expect(seen).toEqual([]);
  });
});
