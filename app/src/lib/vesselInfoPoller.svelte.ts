import { untrack } from 'svelte';

/**
 * AIS static data (name, ship type, nav state, dimensions) is broadcast by vessels
 * roughly every 6 minutes, so Signal K may not know it at startup — re-fetch periodically.
 */
export const VESSEL_INFO_INTERVAL_MS = 3 * 60 * 1000;

export interface VesselInfoPollerDeps<T> {
  /** Reactive read of the Signal K HTTP base URL. */
  httpUrl: () => string;
  fetchInfo: (httpUrl: string) => Promise<T>;
  apply: (info: T) => void;
}

/**
 * Fetches vessel info now and every {@link VESSEL_INFO_INTERVAL_MS} for the current
 * server; restarts on a server change and stops when the owning effect scope is
 * destroyed. Must be called during component init or inside `$effect.root`.
 *
 * The effect depends on the URL alone: `$derived` drops writes of an equal string and
 * the body runs untracked, so nothing read by `fetchInfo`/`apply` can re-run the effect
 * — a re-run would run the cleanup and clear a timer that is still wanted.
 */
export function pollVesselInfo<T>(deps: VesselInfoPollerDeps<T>): void {
  const httpUrl = $derived(deps.httpUrl());
  $effect(() => {
    const url = httpUrl;
    return untrack(() => {
      const refresh = (): void => {
        void deps.fetchInfo(url)
          .then((info) => { deps.apply(info); })
          .catch((e: unknown) => { console.warn('[vesselInfo] fetch error:', e); });
      };
      refresh();
      const timer = setInterval(refresh, VESSEL_INFO_INTERVAL_MS);
      return () => { clearInterval(timer); };
    });
  });
}
