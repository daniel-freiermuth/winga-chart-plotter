import type { Feature, LineString } from 'geojson';
import { fetchAllRoutes } from '../lib/signalk-api';

export interface ServerRoute {
  uuid: string;
  name: string;
  description?: string;
  geometry: Feature<LineString>;
}

let _routes: ServerRoute[] = $state([]);
let _loading: boolean = $state(false);
let _error: string | null = $state(null);

function createRoutes() {
  return {
    get entries() { return _routes; },
    get loading()  { return _loading; },
    get error()    { return _error; },

    async load(serverBase: string): Promise<void> {
      if (!serverBase) return;
      _loading = true;
      _error = null;
      try {
        const data = await fetchAllRoutes(serverBase);
        const parsed: ServerRoute[] = [];
        for (const [uuid, entry] of Object.entries(data)) {
          const feature = entry.feature;
          if (!feature || feature.geometry?.type !== 'LineString') continue;
          parsed.push({
            uuid,
            name: entry.name ?? uuid,
            description: entry.description,
            geometry: feature as Feature<LineString>,
          });
        }
        _routes = parsed;
      } catch (e) {
        _error = String(e);
        console.warn('[routes] fetch error:', e);
      } finally {
        _loading = false;
      }
    },
  };
}

export const routes = createRoutes();
