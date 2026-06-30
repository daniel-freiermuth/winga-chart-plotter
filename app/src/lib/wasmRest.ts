/**
 * Signal K v2 REST client — thin main-thread wrapper around the WASM
 * `skrest` module (crates/core/src/skrest/). Per ADR-009 Phase 2, this is a
 * 1:1 replacement for the former `signalk-api.ts`'s hand-written `fetch()`
 * surface: same endpoints, same request/response shapes, same call-site
 * signatures — only the implementation moved to Rust/WASM.
 *
 * Unlike `wasmGeo.ts`'s synchronous geo helpers (which must degrade to a
 * safe placeholder before WASM finishes loading, since render code can't
 * await), every function here is itself async and can just await WASM
 * readiness first — there is no "not ready yet" case visible to callers.
 *
 * Auth-header construction stays on the TS side (token lifecycle is a
 * UI/session-state concern, not Signal K parsing) — callers keep passing a
 * plain `Record<string, string>` across the WASM boundary unchanged.
 */
import {
  activateRoute as wasmActivateRoute,
  buildTileUrl as wasmBuildTileUrl,
  clearCourse as wasmClearCourse,
  deleteRoute as wasmDeleteRoute,
  deleteWaypoint as wasmDeleteWaypoint,
  fetchAisVesselTrack as wasmFetchAisVesselTrack,
  fetchAllRoutes as wasmFetchAllRoutes,
  fetchAllWaypoints as wasmFetchAllWaypoints,
  fetchCharts as wasmFetchCharts,
  fetchTrack as wasmFetchTrack,
  fetchVesselInfo as wasmFetchVesselInfo,
  navigateToPoint as wasmNavigateToPoint,
  raiseMob as wasmRaiseMob,
  saveRoute as wasmSaveRoute,
  saveWaypoint as wasmSaveWaypoint,
  setActiveRoutePointIndex as wasmSetActiveRoutePointIndex,
  updateRoute as wasmUpdateRoute,
  updateWaypoint as wasmUpdateWaypoint,
} from '../wasm/signalk_chart_core.js';
import { ready as readyPromise } from './wasmInit';

const ready: Promise<unknown> = readyPromise;

/** Chart entry as returned by `GET /signalk/v2/api/resources/charts`. */
export interface Chart {
  identifier: string;
  name: string;
  description?: string;
  /** Base URL for WMS/WMTS, or XYZ tile template for tilelayer. */
  url?: string;
  format: string; // "png" | "jpg" | "pbf" etc.
  type: string; // "tilelayer" | "WMS" | "WMTS" | "mapstyleJSON"
  minzoom?: number;
  maxzoom?: number;
  scale?: number;
  bounds?: [number, number, number, number];
  layers?: string[];
  /** WMS version override, e.g. "1.1.1" or "1.3.0" (default: "1.3.0"). */
  wmsVersion?: string;
  /**
   * URL to a MapLibre style JSON (set via "Vector Map style" in the SK charts plugin).
   * When present the style URL is used as the full map base style via setStyle() —
   * no individual source/layer management needed for this chart.
   */
  style?: string;
}
export type ChartRecord = Record<string, Chart>;

export interface SkRouteEntry {
  name: string;
  description?: string;
  feature?: {
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: number[][] };
    properties?: Record<string, unknown>;
  };
}

export interface SkWaypointEntry {
  name?: string;
  description?: string;
  feature?: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties?: Record<string, unknown>;
  };
}

export interface VesselInfo {
  name?: string;
  callsign?: string;
  callsignHf?: string;
  skipperName?: string;
  port?: string;
  flag?: string;
  shipType?: string;
  navState?: string;
  lengthM?: number;
  beamM?: number;
  draftM?: number;
  airHeightM?: number;
}

/**
 * Build a MapLibre-compatible raster tile URL for a chart.
 * Synchronous — `chart` is a plain JS object matching the `Chart` shape.
 */
export function buildTileUrl(chart: Chart, serverBase: string): string | null {
  return wasmBuildTileUrl(chart, serverBase) ?? null;
}

/** `GET /signalk/v2/api/resources/charts` */
export async function fetchCharts(serverBase: string): Promise<ChartRecord> {
  await ready;
  return (await wasmFetchCharts(serverBase)) as ChartRecord;
}

/** Fetch all routes stored on the Signal K server. */
export async function fetchAllRoutes(serverBase: string): Promise<Record<string, SkRouteEntry>> {
  await ready;
  return (await wasmFetchAllRoutes(serverBase)) as Record<string, SkRouteEntry>;
}

/** Fetch all waypoints stored on the Signal K server. */
export async function fetchAllWaypoints(serverBase: string): Promise<Record<string, SkWaypointEntry>> {
  await ready;
  return (await wasmFetchAllWaypoints(serverBase)) as Record<string, SkWaypointEntry>;
}

/** Fetch a map of vessel URN → rich vessel info from the REST API. */
export async function fetchVesselInfo(serverBase: string): Promise<Map<string, VesselInfo>> {
  await ready;
  return (await wasmFetchVesselInfo(serverBase)) as Map<string, VesselInfo>;
}

/**
 * Fetch the own-vessel track from Signal K (v2 history + v1 in-memory
 * buffer + `@signalk/tracks` plugin, queried in parallel and merged).
 */
export async function fetchTrack(serverBase: string, historyHours = 24): Promise<[number, number][]> {
  await ready;
  return (await wasmFetchTrack(serverBase, historyHours)) as [number, number][];
}

/**
 * Fetch position history for an AIS vessel (v2 history + v1 in-memory
 * track, queried in parallel; `[]` if neither source has data).
 *   `vesselId` e.g. `urn:mrn:imo:mmsi:123456789`.
 */
export async function fetchAisVesselTrack(
  serverBase: string,
  vesselId: string,
  historyHours = 24,
): Promise<[number, number][]> {
  await ready;
  return (await wasmFetchAisVesselTrack(serverBase, vesselId, historyHours)) as [number, number][];
}

/**
 * Set the active course destination to a single point. Replaces any
 * existing course (active route or previous waypoint).
 *   PUT /signalk/v2/api/vessels/self/navigation/course/destination
 */
export async function navigateToPoint(
  serverBase: string,
  latitude: number,
  longitude: number,
  authHeaders: Record<string, string>,
): Promise<void> {
  await ready;
  await wasmNavigateToPoint(serverBase, latitude, longitude, authHeaders);
}

/**
 * Clear the active course (destination point or active route).
 *   DELETE /signalk/v2/api/vessels/self/navigation/course
 */
export async function clearCourse(serverBase: string, authHeaders: Record<string, string>): Promise<void> {
  await ready;
  await wasmClearCourse(serverBase, authHeaders);
}

/**
 * Activate a route as the active course.
 *   PUT /signalk/v2/api/vessels/self/navigation/course/activeRoute
 */
export async function activateRoute(
  serverBase: string,
  routeUuid: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  await ready;
  await wasmActivateRoute(serverBase, routeUuid, authHeaders);
}

/**
 * Set the active route's current destination to a specific point along it.
 *   PUT /signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex
 */
export async function setActiveRoutePointIndex(
  serverBase: string,
  index: number,
  authHeaders: Record<string, string>,
): Promise<void> {
  await ready;
  await wasmSetActiveRoutePointIndex(serverBase, index, authHeaders);
}

/**
 * POST /signalk/v2/api/resources/routes
 *
 * Returns the UUID of the newly created route.
 */
export async function saveRoute(
  serverBase: string,
  name: string,
  waypoints: { lon: number; lat: number }[],
  authHeaders: Record<string, string>,
): Promise<string> {
  await ready;
  return wasmSaveRoute(serverBase, name, waypoints, authHeaders);
}

/**
 * PUT /signalk/v2/api/resources/routes/:uuid
 *
 * Updates an existing route in-place.
 */
export async function updateRoute(
  serverBase: string,
  uuid: string,
  name: string,
  waypoints: { lon: number; lat: number }[],
  authHeaders: Record<string, string>,
): Promise<void> {
  await ready;
  await wasmUpdateRoute(serverBase, uuid, name, waypoints, authHeaders);
}

/**
 * DELETE /signalk/v2/api/resources/routes/:uuid
 *
 * Permanently removes a route from the Signal K server.
 */
export async function deleteRoute(
  serverBase: string,
  uuid: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  await ready;
  await wasmDeleteRoute(serverBase, uuid, authHeaders);
}

/**
 * POST /signalk/v2/api/resources/waypoints
 *
 * Returns the UUID of the newly created waypoint.
 */
export async function saveWaypoint(
  serverBase: string,
  name: string,
  lat: number,
  lon: number,
  authHeaders: Record<string, string>,
): Promise<string> {
  await ready;
  return wasmSaveWaypoint(serverBase, name, lat, lon, authHeaders);
}

/**
 * PUT /signalk/v2/api/resources/waypoints/:uuid
 *
 * Renames a waypoint (position unchanged).
 */
export async function updateWaypoint(
  serverBase: string,
  uuid: string,
  name: string,
  lat: number,
  lon: number,
  authHeaders: Record<string, string>,
): Promise<void> {
  await ready;
  await wasmUpdateWaypoint(serverBase, uuid, name, lat, lon, authHeaders);
}

/**
 * DELETE /signalk/v2/api/resources/waypoints/:uuid
 *
 * Permanently removes a waypoint from the Signal K server.
 */
export async function deleteWaypoint(
  serverBase: string,
  uuid: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  await ready;
  await wasmDeleteWaypoint(serverBase, uuid, authHeaders);
}

/**
 * Raise a Man Overboard alarm.
 *   POST /signalk/v2/api/notifications/mob
 */
export async function raiseMob(serverBase: string, authHeaders: Record<string, string>): Promise<void> {
  await ready;
  await wasmRaiseMob(serverBase, authHeaders);
}
