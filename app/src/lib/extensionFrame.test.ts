import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameSupervisor } from './extensionFrame';

/**
 * The supervisor is the recovery path for extension frames that never come up
 * — the case that leaves a widget blank (or showing the extension's own
 * handshake-timeout error) when the Signal K server is down or restarting.
 */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

interface Harness {
  reloads: number;
  states: { phase: string; attempt: number }[];
}

function harness(overrides: Record<string, number> = {}) {
  const h: Harness = { reloads: 0, states: [] };
  const sup = createFrameSupervisor({
    reload: () => { h.reloads++; },
    onChange: (s) => { h.states.push({ ...s }); },
    handshakeTimeoutMs: 1000,
    retryBaseMs: 100,
    retryMaxMs: 400,
    maxAutoAttempts: 3,
    ...overrides,
  });
  return { h, sup };
}

describe('frame supervisor', () => {
  it('goes live on the frame announcing itself and never reloads', () => {
    const { h, sup } = harness();
    sup.start();
    sup.noteReady();
    vi.advanceTimersByTime(60_000);
    expect(sup.phase).toBe('live');
    expect(h.reloads).toBe(0);
  });

  it('reloads with exponential backoff when no bus.ready arrives', () => {
    const { h, sup } = harness();
    sup.start();

    vi.advanceTimersByTime(1000);          // watchdog trips
    expect(sup.attempt).toBe(1);
    expect(h.reloads).toBe(0);             // still waiting out the backoff
    vi.advanceTimersByTime(100);           // retryBaseMs
    expect(h.reloads).toBe(1);

    vi.advanceTimersByTime(1000 + 200);    // watchdog + 2×base
    expect(h.reloads).toBe(2);

    vi.advanceTimersByTime(1000 + 400);    // watchdog + 4×base
    expect(h.reloads).toBe(3);
    expect(sup.phase).toBe('connecting');
  });

  it('caps the backoff at retryMaxMs', () => {
    const { h, sup } = harness({ maxAutoAttempts: 5, retryMaxMs: 200 });
    sup.start();
    vi.advanceTimersByTime(1000 + 100);    // attempt 1 → base
    vi.advanceTimersByTime(1000 + 200);    // attempt 2 → capped
    expect(h.reloads).toBe(2);
    vi.advanceTimersByTime(1000 + 200);    // attempt 3 → still capped
    expect(h.reloads).toBe(3);
  });

  it('parks in stalled once the automatic attempts are exhausted', () => {
    const { h, sup } = harness();
    sup.start();
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(1000 + 400);
    expect(h.reloads).toBe(3);

    vi.advanceTimersByTime(1000);
    expect(sup.phase).toBe('stalled');

    vi.advanceTimersByTime(60_000);
    expect(h.reloads).toBe(3);             // no unbounded retry storm
  });

  it('recovers from stalled on retryNow and resets the attempt budget', () => {
    const { h, sup } = harness();
    sup.start();
    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(1000 + 400);
    expect(sup.phase).toBe('stalled');

    sup.retryNow();
    expect(h.reloads).toBe(4);
    expect(sup.attempt).toBe(0);
    expect(sup.phase).toBe('connecting');

    sup.noteReady();
    expect(sup.phase).toBe('live');
  });

  it('restarts the grace period when a slow document finally loads', () => {
    const { h, sup } = harness();
    sup.start();
    vi.advanceTimersByTime(900);
    sup.noteLoad();                        // document up just before the trip
    vi.advanceTimersByTime(900);
    expect(sup.attempt).toBe(0);           // fresh full window granted
    vi.advanceTimersByTime(200);
    expect(sup.attempt).toBe(1);
    expect(h.states.at(-1)).toEqual({ phase: 'connecting', attempt: 1 });
  });

  it('ignores a load that arrives while a reload is already pending', () => {
    const { h, sup } = harness();
    sup.start();
    vi.advanceTimersByTime(1000);          // trips; reload scheduled in 100ms
    sup.noteLoad();                        // stale load event from the old doc
    vi.advanceTimersByTime(100);
    expect(h.reloads).toBe(1);             // the pending reload still happened
  });

  it('stops cleanly: no timers survive teardown', () => {
    const { h, sup } = harness();
    sup.start();
    vi.advanceTimersByTime(1000);          // reload scheduled
    sup.stop();
    vi.advanceTimersByTime(60_000);
    expect(h.reloads).toBe(0);
    sup.retryNow();                        // inert after stop
    expect(h.reloads).toBe(0);
  });

  it('emits only on real state changes', () => {
    const { h, sup } = harness();
    sup.start();
    sup.noteReady();
    sup.noteReady();
    expect(h.states).toEqual([{ phase: 'live', attempt: 0 }]);
  });
});
