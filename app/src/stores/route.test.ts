import { describe, expect, it } from 'vitest';
import { mirrorRouteIndex, reanchorPointIndex } from './routeLogic';

/**
 * Signal K's `activeRoute.pointIndex` is relative to the direction of travel:
 * with `reverse: true`, pointIndex 0 is the LAST coordinate of the route
 * geometry (signalk-server `getRoutePoint`: `coordinates[length - (index + 1)]`).
 * Every consumer that indexes the route geometry (next-waypoint highlight,
 * edit anchor, "Set as next waypoint", re-anchor after edit) must convert
 * between that frame and the forward geometry index.
 */
describe('mirrorRouteIndex', () => {
  it('is the identity when following the route forward', () => {
    expect(mirrorRouteIndex(0, 5, false)).toBe(0);
    expect(mirrorRouteIndex(3, 5, false)).toBe(3);
    expect(mirrorRouteIndex(4, 5, false)).toBe(4);
  });

  it('counts from the end of the geometry when following the route in reverse', () => {
    // pointIndex 0 in reverse targets the last geometry coordinate (next-waypoint
    // highlight, edit anchor); forward feature idx 0 is the final pointIndex
    // ("Set as next waypoint" PUT).
    expect(mirrorRouteIndex(0, 5, true)).toBe(4);
    expect(mirrorRouteIndex(1, 5, true)).toBe(3);
    expect(mirrorRouteIndex(4, 5, true)).toBe(0);
  });

  it('is its own inverse, so both conversion directions agree', () => {
    for (const reverse of [false, true]) {
      for (let i = 0; i < 6; i++) {
        expect(mirrorRouteIndex(mirrorRouteIndex(i, 6, reverse), 6, reverse)).toBe(i);
      }
    }
  });
});

/**
 * Re-anchoring after editing the active route (App.svelte handleSaveRoute):
 * the route is re-activated (pointIndex resets to 0 in the current direction),
 * then the waypoint closest to the pre-edit anchor becomes the next point.
 * The returned index is what gets PUT to `.../activeRoute/pointIndex`, so it
 * must be direction-relative; `null` means "already at pointIndex 0, no PUT".
 */
describe('reanchorPointIndex', () => {
  // Planar distance keeps the test independent of the WASM geodesic module;
  // only the ordering of distances matters to the closest-waypoint search.
  const planar = (lonA: number, latA: number, lonB: number, latB: number): number =>
    Math.hypot(lonA - lonB, latA - latB);
  const wpts = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 2, lat: 0 },
    { lon: 3, lat: 0 },
  ];

  it('returns the forward index of the closest waypoint when following forward', () => {
    expect(reanchorPointIndex(wpts, { lon: 2.1, lat: 0 }, false, planar)).toBe(2);
  });

  it('returns a direction-relative index when following in reverse', () => {
    // Closest is geometry index 2 → pointIndex 1 counted from the end.
    expect(reanchorPointIndex(wpts, { lon: 2.1, lat: 0 }, true, planar)).toBe(1);
  });

  it('returns null when the closest waypoint is the first one in the travel direction', () => {
    // Forward: geometry index 0 is pointIndex 0.
    expect(reanchorPointIndex(wpts, { lon: -0.4, lat: 0 }, false, planar)).toBeNull();
    // Reverse: the last geometry coordinate is pointIndex 0.
    expect(reanchorPointIndex(wpts, { lon: 3.4, lat: 0 }, true, planar)).toBeNull();
  });

  it('returns the final pointIndex when the closest waypoint is the last one in the travel direction', () => {
    expect(reanchorPointIndex(wpts, { lon: 3.4, lat: 0 }, false, planar)).toBe(3);
    expect(reanchorPointIndex(wpts, { lon: -0.4, lat: 0 }, true, planar)).toBe(3);
  });

  it('breaks distance ties toward the earlier geometry index', () => {
    // Equidistant from geometry indices 1 and 2.
    expect(reanchorPointIndex(wpts, { lon: 1.5, lat: 0 }, false, planar)).toBe(1);
    expect(reanchorPointIndex(wpts, { lon: 1.5, lat: 0 }, true, planar)).toBe(2);
  });

  it('returns null for an empty route', () => {
    expect(reanchorPointIndex([], { lon: 0, lat: 0 }, false, planar)).toBeNull();
    expect(reanchorPointIndex([], { lon: 0, lat: 0 }, true, planar)).toBeNull();
  });
});
