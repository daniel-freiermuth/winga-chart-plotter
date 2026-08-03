import { fetchAllWaypoints } from '../lib/wasmRest';

export interface ServerWaypoint {
  uuid: string;
  name: string;
  description?: string | undefined;
  lon: number;
  lat: number;
}

let _waypoints: ServerWaypoint[] = $state([]);
let _loading: boolean = $state(false);
let _error: string | null = $state(null);
// See routes.svelte.ts for why this guard exists (out-of-order poll vs.
// explicit reload responses).
let _requestSeq = 0;

function createWaypoints() {
  return {
    get entries() { return _waypoints; },
    get loading()  { return _loading; },
    get error()    { return _error; },

    async load(serverBase: string): Promise<void> {
      // See routes.svelte.ts — bump the sequence even for an empty serverBase
      // so an earlier in-flight request can't commit after this call.
      const seq = ++_requestSeq;
      if (!serverBase) { _loading = false; return; }
      _loading = true;
      _error = null;
      try {
        const data = await fetchAllWaypoints(serverBase);
        const parsed: ServerWaypoint[] = [];
        for (const [uuid, entry] of Object.entries(data)) {
          const coords = entry.feature?.geometry.coordinates;
          if (!coords) continue;
          parsed.push({
            uuid,
            name: entry.name ?? uuid,
            description: entry.description,
            lon: coords[0],
            lat: coords[1],
          });
        }
        if (seq !== _requestSeq) return;
        _waypoints = parsed;
      } catch (e) {
        if (seq !== _requestSeq) return;
        _error = String(e);
        console.warn('[waypoints] fetch error:', e);
      } finally {
        if (seq === _requestSeq) _loading = false;
      }
    },
  };
}

export const waypoints = createWaypoints();
