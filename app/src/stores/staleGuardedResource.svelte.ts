/**
 * Generic factory for a fetchable resource list protected against
 * stale-response races.
 *
 * The guard bumps a sequence counter on every load() call.  A response is
 * only committed if no newer load() has started since it was issued.
 * Without this, an in-flight poll request (App.svelte's setInterval) racing
 * a just-triggered reload (e.g. right after saving a route) can resolve out
 * of order — the poll's STALE response would land after the fresh one and
 * silently revert the list.
 *
 * See the original routes.svelte.ts commit history for the full bug context.
 */

export interface StaleGuardedResource<T> {
  readonly entries: T[];
  readonly loading: boolean;
  readonly error: string | null;
  load(serverBase: string): Promise<void>;
}

/**
 * Create a reactive resource store with stale-response-guard semantics.
 *
 * @param fetchAndParse  Fetches data from `serverBase` and returns parsed
 *                       entries.  Throwing is fine — it is caught and
 *                       surfaced via `.error`.
 * @param logLabel       Short tag for console warnings (e.g. `'routes'`).
 */
export function createStaleGuardedResource<T>(
  fetchAndParse: (serverBase: string) => Promise<T[]>,
  logLabel: string,
): StaleGuardedResource<T> {
  let _entries: T[] = $state([]);
  let _loading: boolean = $state(false);
  let _error: string | null = $state(null);
  // Bumped on every load() call; a response is only committed if no newer
  // load() has started since it was issued.
  let _requestSeq = 0;

  return {
    get entries() { return _entries; },
    get loading()  { return _loading; },
    get error()    { return _error; },

    async load(serverBase: string): Promise<void> {
      // Bump the sequence even for an empty serverBase — an earlier
      // in-flight request must not be able to commit after this call.
      const seq = ++_requestSeq;
      if (!serverBase) { _loading = false; return; }
      _loading = true;
      _error = null;
      try {
        const parsed = await fetchAndParse(serverBase);
        // A newer load() started while this one was in flight — its
        // response is authoritative, not this one.
        if (seq !== _requestSeq) return;
        _entries = parsed;
      } catch (e) {
        if (seq !== _requestSeq) return;
        _error = String(e);
        console.warn(`[${logLabel}] fetch error:`, e);
      } finally {
        if (seq === _requestSeq) _loading = false;
      }
    },
  };
}
