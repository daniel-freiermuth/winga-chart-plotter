import { SvelteMap } from 'svelte/reactivity';
import type maplibregl from 'maplibre-gl';
import { fetchAndResolveStyle } from '../lib/resolveStyle';

/** Resolution state of one MapLibre style URL. */
export type StyleResolution =
  | { status: 'loading' }
  | { status: 'resolved'; style: maplibregl.StyleSpecification }
  | { status: 'error'; error: unknown };

/** Base delay before a failed style URL may be fetched again (doubles per consecutive failure). */
export const STYLE_RETRY_DELAY_MS = 5000;
/** Ceiling for the retry backoff — a broken URL degrades to one request per this interval. */
export const STYLE_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * App-level resolution of MapLibre style JSON URLs.
 *
 * Components never fetch styles themselves (repo rule: no fetching inside
 * components) — they ask this store and consume the reactive result. Requests
 * are cached per URL, so two panes showing the same style-based chart (and
 * every picker thumbnail of it) resolve the style exactly once.
 */
export interface MapStylesStore {
  /**
   * Reactive resolution state for a style URL. The first request starts the
   * fetch; concurrent and later requests share the cached result. After a
   * failure the URL is re-admitted after an exponential backoff delay
   * (starting at STYLE_RETRY_DELAY_MS, capped at STYLE_RETRY_MAX_DELAY_MS),
   * which reactively re-triggers consumers — retries stay paced with no
   * consumer bookkeeping.
   *
   * The resolved style object is SHARED — clone before mutating it (MapLibre
   * mutates styles it is handed, and panes inject their own chart sources).
   *
   * Call from an effect or event handler, not from a $derived: a cache miss
   * writes reactive state.
   */
  resolve(url: string): StyleResolution;
}

export function createMapStylesStore(): MapStylesStore {
  const entries = new SvelteMap<string, StyleResolution>();
  // Consecutive failures per URL — drives the retry backoff.
  // Intentionally a plain Map (not SvelteMap): pure bookkeeping read inside
  // async callbacks, never rendered — reactivity would be wasted overhead.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const failures = new Map<string, number>();

  return {
    resolve(url: string): StyleResolution {
      const existing = entries.get(url);
      if (existing) return existing;

      const loading: StyleResolution = { status: 'loading' };
      entries.set(url, loading);
      fetchAndResolveStyle(url)
        .then(style => {
          if (entries.get(url) !== loading) return; // defensive: entry superseded
          failures.delete(url);
          entries.set(url, { status: 'resolved', style: style as maplibregl.StyleSpecification });
        })
        .catch((error: unknown) => {
          if (entries.get(url) !== loading) return;
          console.error('[style] Failed to resolve style', url, error);
          const failed: StyleResolution = { status: 'error', error };
          entries.set(url, failed);
          const attempt = (failures.get(url) ?? 0) + 1;
          failures.set(url, attempt);
          // Re-admit the URL after a delay: deleting the entry notifies
          // consumers reactively, and their next resolve() starts a fresh
          // fetch. Exponential backoff, capped — retries never stop entirely
          // (flaky connectivity at sea must be able to recover hours later),
          // but a permanently broken URL degrades to one request per cap
          // interval instead of an endless fixed-rate loop.
          const delay = Math.min(STYLE_RETRY_DELAY_MS * 2 ** (attempt - 1), STYLE_RETRY_MAX_DELAY_MS);
          setTimeout(() => {
            if (entries.get(url) === failed) entries.delete(url);
          }, delay);
        });
      return loading;
    },
  };
}

export const mapStyles: MapStylesStore = createMapStylesStore();
