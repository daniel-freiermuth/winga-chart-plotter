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
  it('subscribes upstream once per path and unsubscribes on the last listener', () => {
    const sent: string[] = [];
    const relay = createSkRelay((m) => sent.push(m));

    const a = relay.subscribe('navigation.speedOverGround', () => { /* noop */ });
    const b = relay.subscribe('navigation.speedOverGround', () => { /* noop */ });
    expect(sent).toHaveLength(1);

    relay.unsubscribe(a);
    expect(sent).toHaveLength(1);   // b still listening
    relay.unsubscribe(b);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('unsubscribe');
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
