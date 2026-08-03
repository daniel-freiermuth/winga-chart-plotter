import type { Feature, LineString } from 'geojson';
import { fetchAllRoutes } from '../lib/wasmRest';

export interface ServerRoute {
  uuid: string;
  name: string;
  description?: string;
  geometry: Feature<LineString>;
}

let _routes: ServerRoute[] = $state([]);
let _loading: boolean = $state(false);
let _error: string | null = $state(null);
// Bumped on every load() call; a response is only committed if no newer
// load() has started since it was issued. Without this, an in-flight poll
// request (App.svelte's setInterval) racing a just-triggered reload (e.g.
// right after saving a route) can resolve out of order — the poll's STALE
// response would land after the fresh one and silently revert `_routes`,
// making a just-saved route appear to "vanish" moments after it showed up.
let _requestSeq = 0;

function createRoutes() {
  return {
    get entries() { return _routes; },
    get loading()  { return _loading; },
    get error()    { return _error; },

    async load(serverBase: string): Promise<void> {
      // Bump the sequence even for an empty serverBase — an earlier in-flight
      // request (e.g. issued before the user cleared the connection settings)
      // must not be able to commit after this call, even though this call
      // itself does nothing further.
      const seq = ++_requestSeq;
      if (!serverBase) { _loading = false; return; }
      _loading = true;
      _error = null;
      try {
        const data = await fetchAllRoutes(serverBase);
        const parsed: ServerRoute[] = [];
        for (const [uuid, entry] of Object.entries(data)) {
          const feature = entry.feature;
          if (!feature) continue;
          parsed.push({
            uuid,
            name: entry.name,
            ...(entry.description !== undefined ? { description: entry.description } : {}),
            geometry: feature as Feature<LineString>,
          });
        }
        // A newer load() started while this one was in flight — its response
        // (still pending or already applied) is authoritative, not this one.
        if (seq !== _requestSeq) return;
        _routes = parsed;
      } catch (e) {
        if (seq !== _requestSeq) return;
        _error = String(e);
        console.warn('[routes] fetch error:', e);
      } finally {
        if (seq === _requestSeq) _loading = false;
      }
    },
  };
}

export const routes = createRoutes();
