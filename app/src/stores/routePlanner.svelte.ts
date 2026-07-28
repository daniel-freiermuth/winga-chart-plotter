import { gcDistanceNm } from '../lib/wasmGeo';

export interface PlannerWaypoint {
  lon: number;
  lat: number;
}

function createRoutePlannerStore() {
  let active           = $state(false);
  let waypoints        = $state<PlannerWaypoint[]>([]);
  let editingRouteUuid = $state<string | null>(null);
  let name             = $state('');
  let anchorPoint      = $state<PlannerWaypoint | null>(null);

  const totalDistanceNm = $derived.by(() => {
    let total = 0;
    for (let i = 1; i < waypoints.length; i++) {
      total += gcDistanceNm(waypoints[i - 1]!.lon, waypoints[i - 1]!.lat, waypoints[i]!.lon, waypoints[i]!.lat);
    }
    return total;
  });

  function reset() {
    active = false;
    waypoints = [];
    editingRouteUuid = null;
    name = '';
    anchorPoint = null;
  }

  return {
    get active(): boolean              { return active; },
    get waypoints(): PlannerWaypoint[] { return waypoints; },
    get totalDistanceNm(): number      { return totalDistanceNm; },
    get editingRouteUuid(): string | null { return editingRouteUuid; },
    get anchorPoint(): PlannerWaypoint | null { return anchorPoint; },
    get name(): string                 { return name; },
    set name(v: string)                { name = v; },

    enter(): void  { active = true; name = ''; },
    enterAt(lon: number, lat: number): void { active = true; name = ''; waypoints = [{ lon, lat }]; },
    exit(): void   { reset(); },

    /** Enter planner pre-loaded with an existing route's waypoints for editing.
     *  `anchor` is the coordinates of the waypoint currently being navigated to,
     *  used after save to restore navigation to the nearest equivalent point. */
    loadRoute(uuid: string, routeName: string, wpts: PlannerWaypoint[], anchor: PlannerWaypoint | null = null): void {
      waypoints = [...wpts];
      editingRouteUuid = uuid;
      name = routeName;
      anchorPoint = anchor;
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
