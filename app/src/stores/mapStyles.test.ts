import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAndResolveStyle = vi.hoisted(() => vi.fn());
vi.mock('../lib/resolveStyle', () => ({ fetchAndResolveStyle }));

import { createMapStylesStore, STYLE_RETRY_DELAY_MS, STYLE_RETRY_MAX_DELAY_MS } from './mapStyles.svelte';

// deferred promise so tests control when the "fetch" settles
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchAndResolveStyle.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => { /* keep test output clean */ });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createMapStylesStore', () => {
  it('deduplicates concurrent requests for the same URL', () => {
    const d = deferred<object>();
    fetchAndResolveStyle.mockReturnValue(d.promise);
    const store = createMapStylesStore();

    expect(store.resolve('https://x/style.json').status).toBe('loading');
    expect(store.resolve('https://x/style.json').status).toBe('loading');
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(1);
  });

  it('exposes the resolved style and keeps serving it from cache', async () => {
    const styleJson = { version: 8, sources: {}, layers: [] };
    fetchAndResolveStyle.mockResolvedValue(styleJson);
    const store = createMapStylesStore();

    store.resolve('https://x/style.json');
    await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('resolved'); });

    const res = store.resolve('https://x/style.json');
    expect(res.status === 'resolved' && res.style).toBe(styleJson);
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(1); // still cached
  });

  it('caches per URL independently', () => {
    fetchAndResolveStyle.mockReturnValue(deferred<object>().promise);
    const store = createMapStylesStore();
    store.resolve('https://x/a.json');
    store.resolve('https://x/b.json');
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(2);
  });

  it('reports an error and does not refetch before the retry delay', async () => {
    fetchAndResolveStyle.mockRejectedValue(new Error('boom'));
    const store = createMapStylesStore();

    store.resolve('https://x/style.json');
    await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('error'); });

    expect(store.resolve('https://x/style.json').status).toBe('error');
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(1); // paced: no tight retry loop
  });

  it('re-admits a failed URL for fetching after the retry delay', async () => {
    fetchAndResolveStyle.mockRejectedValueOnce(new Error('boom'));
    fetchAndResolveStyle.mockResolvedValueOnce({ version: 8, sources: {}, layers: [] });
    const store = createMapStylesStore();

    store.resolve('https://x/style.json');
    await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('error'); });

    vi.advanceTimersByTime(STYLE_RETRY_DELAY_MS);
    expect(store.resolve('https://x/style.json').status).toBe('loading'); // fresh fetch started
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('resolved'); });
  });

  it('doubles the retry delay on consecutive failures', async () => {
    fetchAndResolveStyle.mockRejectedValue(new Error('boom'));
    const store = createMapStylesStore();

    store.resolve('https://x/style.json');
    await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('error'); });

    // First retry after the base delay…
    vi.advanceTimersByTime(STYLE_RETRY_DELAY_MS);
    store.resolve('https://x/style.json');
    await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('error'); });
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(2);

    // …but the second retry backs off: the base delay is no longer enough.
    vi.advanceTimersByTime(STYLE_RETRY_DELAY_MS);
    expect(store.resolve('https://x/style.json').status).toBe('error');
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(STYLE_RETRY_DELAY_MS); // total 2× base since 2nd failure
    expect(store.resolve('https://x/style.json').status).toBe('loading');
    expect(fetchAndResolveStyle).toHaveBeenCalledTimes(3);
  });

  it('caps the retry delay at STYLE_RETRY_MAX_DELAY_MS', async () => {
    fetchAndResolveStyle.mockRejectedValue(new Error('boom'));
    const store = createMapStylesStore();

    // Drive enough consecutive failures for the doubling to exceed the cap
    // (base 5 s doubling passes 5 min after the 7th failure).
    store.resolve('https://x/style.json');
    await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('error'); });
    for (let attempt = 2; attempt <= 8; attempt++) {
      vi.advanceTimersByTime(STYLE_RETRY_MAX_DELAY_MS); // ≥ any single backoff step
      store.resolve('https://x/style.json');
      await vi.waitFor(() => { expect(store.resolve('https://x/style.json').status).toBe('error'); });
    }

    // Uncapped doubling would now demand 5 s · 2⁷ = 640 s; the cap re-admits
    // after exactly STYLE_RETRY_MAX_DELAY_MS — and not a second earlier.
    vi.advanceTimersByTime(STYLE_RETRY_MAX_DELAY_MS - 1000);
    expect(store.resolve('https://x/style.json').status).toBe('error');
    vi.advanceTimersByTime(1000);
    expect(store.resolve('https://x/style.json').status).toBe('loading');
  });
});
