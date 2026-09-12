import { fetchAllWaypoints } from '../lib/wasmRest';
import { createStaleGuardedResource } from './staleGuardedResource.svelte';

export interface ServerWaypoint {
  uuid: string;
  name: string;
  description?: string | undefined;
  lon: number;
  lat: number;
}

export const waypoints = createStaleGuardedResource<ServerWaypoint>(
  async (serverBase) => {
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
    return parsed;
  },
  'waypoints',
);
