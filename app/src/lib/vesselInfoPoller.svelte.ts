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
 */
export function pollVesselInfo<T>(deps: VesselInfoPollerDeps<T>): void {
  let lastHttpUrl = '';
  let timer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const url = deps.httpUrl();
    if (url === lastHttpUrl) return;
    lastHttpUrl = url;
    if (timer !== null) clearInterval(timer);
    const refresh = (): void => {
      void deps.fetchInfo(url)
        .then((info) => { deps.apply(info); })
        .catch((e: unknown) => { console.warn('[vesselInfo] fetch error:', e); });
    };
    refresh();
    timer = setInterval(refresh, VESSEL_INFO_INTERVAL_MS);
    return () => { if (timer !== null) clearInterval(timer); };
  });
}
