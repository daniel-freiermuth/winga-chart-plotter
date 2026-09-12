import type { Feature, LineString } from 'geojson';
import { fetchAllRoutes } from '../lib/wasmRest';
import { createStaleGuardedResource } from './staleGuardedResource.svelte';

export interface ServerRoute {
  uuid: string;
  name: string;
  description?: string;
  geometry: Feature<LineString>;
}

export const routes = createStaleGuardedResource<ServerRoute>(
  async (serverBase) => {
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
    return parsed;
  },
  'routes',
);
