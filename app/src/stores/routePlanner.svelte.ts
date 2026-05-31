import { gcDistanceNm } from '../lib/geoMath';

export interface PlannerWaypoint {
  lon: number;
  lat: number;
}

function createRoutePlannerStore() {
  let active           = $state(false);
  let waypoints        = $state<PlannerWaypoint[]>([]);
  let editingRouteUuid = $state<string | null>(null);
  let name             = $state('');

  const totalDistanceNm = $derived.by(() => {
    let total = 0;
    for (let i = 1; i < waypoints.length; i++) {
      total += gcDistanceNm(waypoints[i - 1].lon, waypoints[i - 1].lat, waypoints[i].lon, waypoints[i].lat);
    }
    return total;
  });

  function reset() {
    active = false;
    waypoints = [];
    editingRouteUuid = null;
    name = '';
  }

  return {
    get active(): boolean              { return active; },
    get waypoints(): PlannerWaypoint[] { return waypoints; },
    get totalDistanceNm(): number      { return totalDistanceNm; },
    get editingRouteUuid(): string | null { return editingRouteUuid; },
    get name(): string                 { return name; },
    set name(v: string)                { name = v; },

    enter(): void  { active = true; name = ''; },
    exit(): void   { reset(); },

    /** Enter planner pre-loaded with an existing route's waypoints for editing. */
    loadRoute(uuid: string, routeName: string, wpts: PlannerWaypoint[]): void {
      waypoints = [...wpts];
      editingRouteUuid = uuid;
      name = routeName;
      active = true;
    },

    insertWaypoint(beforeIdx: number, lon: number, lat: number): void {
      const next = [...waypoints];
      next.splice(beforeIdx, 0, { lon, lat });
      waypoints = next;
    },

    addWaypoint(lon: number, lat: number): void {
      waypoints = [...waypoints, { lon, lat }];
    },

    moveWaypoint(idx: number, lon: number, lat: number): void {
      waypoints = waypoints.map((w, i) => i === idx ? { lon, lat } : w);
    },

    removeWaypoint(idx: number): void {
      waypoints = waypoints.filter((_, i) => i !== idx);
    },

    removeLastWaypoint(): void {
      if (waypoints.length > 0) waypoints = waypoints.slice(0, -1);
    },

    clear(): void { waypoints = []; },
  };
}

export const routePlanner = createRoutePlannerStore();
