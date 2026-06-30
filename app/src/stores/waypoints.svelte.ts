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

function createWaypoints() {
  return {
    get entries() { return _waypoints; },
    get loading()  { return _loading; },
    get error()    { return _error; },

    async load(serverBase: string): Promise<void> {
      if (!serverBase) return;
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
        _waypoints = parsed;
      } catch (e) {
        _error = String(e);
        console.warn('[waypoints] fetch error:', e);
      } finally {
        _loading = false;
      }
    },
  };
}

export const waypoints = createWaypoints();
