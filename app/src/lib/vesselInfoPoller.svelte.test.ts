import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { pollVesselInfo, VESSEL_INFO_INTERVAL_MS } from './vesselInfoPoller.svelte';

type Info = Map<string, string>;

/** Reactive inputs standing in for settings and for stores the app reads while polling. */
function harness(initialUrl: string) {
  const state = $state({ url: initialUrl, unrelated: 0 });
  const fetchInfo = vi.fn((url: string): Promise<Info> => Promise.resolve(new Map([['url', url]])));
  const apply = vi.fn((_info: Info): void => undefined);
  const stop = $effect.root(() => {
    pollVesselInfo({ httpUrl: () => state.url, fetchInfo, apply });
    // Mirrors App.svelte: a sibling effect that reads and writes other reactive state
    // in the same flush must not disturb the poller.
    $effect(() => { void state.unrelated; });
  });
  flushSync();
  return { state, fetchInfo, apply, stop };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('pollVesselInfo', () => {
  it('fetches immediately and then once per interval', async () => {
    const h = harness('http://a:3000');
    try {
      expect(h.fetchInfo).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2 * VESSEL_INFO_INTERVAL_MS);
      expect(h.fetchInfo).toHaveBeenCalledTimes(3);
      expect(h.fetchInfo.mock.calls.every(([u]) => u === 'http://a:3000')).toBe(true);
      expect(h.apply).toHaveBeenCalledTimes(3);
    } finally {
      h.stop();
    }
  });

  it('keeps polling when the fetch callback reads and writes reactive state', async () => {
    // plotterExtensions.load() writes then reads $state before its first await; when such a
    // call ran inside the old App effect the effect re-ran and its cleanup killed the timer.
    const status = $state({ value: 'idle' });
    const fetchInfo = vi.fn((url: string): Promise<Info> => {
      status.value = 'loading';
      void status.value;
      return Promise.resolve(new Map([['url', url]]));
    });
    const stop = $effect.root(() => {
      pollVesselInfo({ httpUrl: () => 'http://a:3000', fetchInfo, apply: () => undefined });
    });
    try {
      flushSync();
      status.value = 'ready';
      flushSync();
      await vi.advanceTimersByTimeAsync(2 * VESSEL_INFO_INTERVAL_MS);
      expect(fetchInfo).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it('a server switch replaces the timer and never fetches the old URL again', async () => {
    const h = harness('http://a:3000');
    try {
      await vi.advanceTimersByTimeAsync(VESSEL_INFO_INTERVAL_MS / 2);
      h.state.url = 'http://b:3000';
      flushSync();
      expect(h.fetchInfo).toHaveBeenCalledTimes(2);
      expect(h.fetchInfo).toHaveBeenLastCalledWith('http://b:3000');

      h.fetchInfo.mockClear();
      await vi.advanceTimersByTimeAsync(2 * VESSEL_INFO_INTERVAL_MS);
      // Exactly one interval left (two ticks, not four), all against the new server.
      expect(h.fetchInfo.mock.calls).toEqual([['http://b:3000'], ['http://b:3000']]);
    } finally {
      h.stop();
    }
  });

  it('an unrelated change, or a write of the same URL, neither refetches nor stops the timer', async () => {
    const h = harness('http://a:3000');
    try {
      h.state.unrelated++;
      h.state.url = 'http://a:3000';
      flushSync();
      expect(h.fetchInfo).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(VESSEL_INFO_INTERVAL_MS);
      expect(h.fetchInfo).toHaveBeenCalledTimes(2);
    } finally {
      h.stop();
    }
  });

  it('logs fetch failures and keeps polling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchInfo = vi.fn((): Promise<Info> => Promise.reject(new Error('down')));
    const stop = $effect.root(() => {
      pollVesselInfo({ httpUrl: () => 'http://a:3000', fetchInfo, apply: () => undefined });
    });
    try {
      flushSync();
      await vi.advanceTimersByTimeAsync(VESSEL_INFO_INTERVAL_MS);
      expect(fetchInfo).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it('teardown stops the timer', async () => {
    const h = harness('http://a:3000');
    h.stop();
    await vi.advanceTimersByTimeAsync(2 * VESSEL_INFO_INTERVAL_MS);
    expect(h.fetchInfo).toHaveBeenCalledTimes(1);
  });
});
