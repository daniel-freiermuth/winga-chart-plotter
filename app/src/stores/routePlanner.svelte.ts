import { gcDistanceNm } from '../lib/geoMath';

export interface PlannerWaypoint {
  lon: number;
  lat: number;
}

function createRoutePlannerStore() {
  let active    = $state(false);
  let waypoints = $state<PlannerWaypoint[]>([]);

  const totalDistanceNm = $derived.by(() => {
    let total = 0;
    for (let i = 1; i < waypoints.length; i++) {
      total += gcDistanceNm(waypoints[i - 1].lon, waypoints[i - 1].lat, waypoints[i].lon, waypoints[i].lat);
    }
    return total;
  });

  return {
    get active(): boolean             { return active; },
    get waypoints(): PlannerWaypoint[] { return waypoints; },
    get totalDistanceNm(): number     { return totalDistanceNm; },

    enter(): void  { active = true; },
    exit(): void   { active = false; waypoints = []; },
    toggle(): void { if (active) { active = false; waypoints = []; } else { active = true; } },

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
