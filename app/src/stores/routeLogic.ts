/** Pure active-route index logic — no Svelte runes, testable in Node. */

import type { PlannerWaypoint } from './routePlanner.svelte';

/**
 * Convert between Signal K's direction-relative `activeRoute.pointIndex` and
 * an index into the route geometry's (forward) coordinate array.
 *
 * With `reverse: true` the server counts from the end of the route:
 * signalk-server `getRoutePoint` resolves `coordinates[length - (index + 1)]`.
 * The mirror mapping is its own inverse, so the same call converts
 * pointIndex → geometry index (highlight, edit anchor) and geometry index →
 * pointIndex (`PUT .../activeRoute/pointIndex`).
 */
export function mirrorRouteIndex(index: number, length: number, reverse: boolean): number {
  return reverse ? length - 1 - index : index;
}

/**
 * Pick the next point after re-activating an edited active route: the
 * waypoint closest to `anchor` (ties go to the earlier geometry index).
 *
 * Returns the direction-relative `pointIndex` to PUT, or `null` when the
 * closest waypoint is already pointIndex 0 — re-activation starts there, so
 * no PUT is needed — or the route is empty.
 */
export function reanchorPointIndex(
  waypoints: readonly PlannerWaypoint[],
  anchor: PlannerWaypoint,
  reverse: boolean,
  distanceNm: (lonA: number, latA: number, lonB: number, latB: number) => number,
): number | null {
  let closestIdx  = -1;
  let closestDist = Infinity;
  for (const [i, wpt] of waypoints.entries()) {
    const d = distanceNm(anchor.lon, anchor.lat, wpt.lon, wpt.lat);
    if (d < closestDist) { closestDist = d; closestIdx = i; }
  }
  if (closestIdx < 0) return null;
  const pointIndex = mirrorRouteIndex(closestIdx, waypoints.length, reverse);
  return pointIndex > 0 ? pointIndex : null;
}
