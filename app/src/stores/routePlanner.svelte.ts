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
  // Bumped whenever a planner session starts or ends, so async work begun in
  // one session can tell that it no longer owns the planner. Not reactive.
  let session = 0;

  const totalDistanceNm = $derived.by(() => {
    let total = 0;
    for (let i = 1; i < waypoints.length; i++) {
      total += gcDistanceNm(waypoints[i - 1]!.lon, waypoints[i - 1]!.lat, waypoints[i]!.lon, waypoints[i]!.lat);
    }
    return total;
  });

  function reset() {
    session++;
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
    /** The next point navigation was on before a save of this session sent the
     *  re-activation of the edited active route — which may have restarted it at
     *  point 0 — and has yet to re-anchor it there; `null` otherwise. Set by that
     *  save (undone if the server refuses the re-activation); reset by loadRoute/exit. */
    get anchorPoint(): PlannerWaypoint | null { return anchorPoint; },
    set anchorPoint(v: PlannerWaypoint | null) { anchorPoint = v; },
    get name(): string                 { return name; },
    set name(v: string)                { name = v; },
    /** Identifies the current planner session; changes on enter/enterAt/loadRoute/exit. */
    get session(): number              { return session; },

    enter(): void  { session++; active = true; name = ''; },
    enterAt(lon: number, lat: number): void { session++; active = true; name = ''; waypoints = [{ lon, lat }]; },
    exit(): void   { reset(); },

    /** Enter planner pre-loaded with an existing route's waypoints for editing. */
    loadRoute(uuid: string, routeName: string, wpts: PlannerWaypoint[]): void {
      session++;
      waypoints = [...wpts];
      editingRouteUuid = uuid;
      name = routeName;
      anchorPoint = null;
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
