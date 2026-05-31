/** Chart entry as returned by GET /signalk/v2/api/resources/charts */
export interface Chart {
  identifier: string;
  name: string;
  description?: string;
  /** Base URL for WMS/WMTS, or XYZ tile template for tilelayer */
  url?: string;
  format: string;           // "png" | "jpg" | "pbf" etc.
  type: string;             // "tilelayer" | "WMS" | "WMTS" | "mapstyleJSON"
  minzoom?: number;
  maxzoom?: number;
  scale?: number;
  bounds?: [number, number, number, number];
  layers?: string[];
  /** WMS version override, e.g. "1.1.1" or "1.3.0" (default: "1.3.0") */
  wmsVersion?: string;
  /**
   * URL to a MapLibre style JSON (set via "Vector Map style" in the SK charts plugin).
   * When present the style URL is used as the full map base style via setStyle() —
   * no individual source/layer management needed for this chart.
   */
  style?: string;
}

export type ChartRecord = Record<string, Chart>;

/**
 * Build a MapLibre-compatible raster tile URL for a chart.
 *
 * - tilelayer / pbf → resolve relative URL, return as-is (already an XYZ template)
 * - WMS            → build a GetMap URL with {bbox-epsg-3857}
 * - WMTS KVP       → build a GetTile URL with {z}/{x}/{y} tokens
 * - WMTS REST      → treat as XYZ (the URL already contains tile path tokens)
 */
export function buildTileUrl(chart: Chart, serverBase: string): string | null {
  if (!chart.url) return null;
  const base = chart.url.startsWith('/') ? `${serverBase}${chart.url}` : chart.url;

  if (chart.type === 'WMS') {
    const layers = chart.layers?.join(',') ?? '';
    const fmt = mimeType(chart.format);
    const ver = chart.wmsVersion ?? '1.3.0';
    // CRS parameter name differs between WMS 1.1.x (SRS) and 1.3.0 (CRS)
    const crsParam = ver.startsWith('1.1') ? 'SRS' : 'CRS';
    const sep = base.includes('?') ? '&' : '?';
    return (
      `${base}${sep}SERVICE=WMS&VERSION=${ver}&REQUEST=GetMap` +
      `&${crsParam}=EPSG:3857&BBOX={bbox-epsg-3857}` +
      `&WIDTH=256&HEIGHT=256` +
      `&LAYERS=${encodeURIComponent(layers)}` +
      `&STYLES=` +
      `&FORMAT=${encodeURIComponent(fmt)}` +
      `&TRANSPARENT=TRUE`
    );
  }

  if (chart.type === 'WMTS') {
    // Detect KVP-style by presence of "?" or absence of "{z}" in URL
    if (!base.includes('{z}')) {
      const layers = chart.layers?.[0] ?? '';
      const fmt = mimeType(chart.format);
      const sep = base.includes('?') ? '&' : '?';
      return (
        `${base}${sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
        `&LAYER=${encodeURIComponent(layers)}` +
        `&TILEMATRIXSET=EPSG:3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}` +
        `&FORMAT=${encodeURIComponent(fmt)}`
      );
    }
    // REST-style WMTS already has {z}/{x}/{y} tokens — use as-is
    return base;
  }

  // tilelayer / pbf: already an XYZ template
  return base;
}

function mimeType(format: string): string {
  switch (format.toLowerCase()) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'pbf':  return 'application/vnd.mapbox-vector-tile';
    case 'webp': return 'image/webp';
    default:     return `image/${format}`;
  }
}

export interface SkRouteEntry {
  name: string;
  description?: string;
  feature?: {
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: number[][] };
    properties?: Record<string, unknown>;
  };
}

/** Fetch all routes stored on the Signal K server. */
export async function fetchAllRoutes(serverBase: string): Promise<Record<string, SkRouteEntry>> {
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/routes`);
  if (!res.ok) throw new Error(`Routes API error: ${String(res.status)} ${res.statusText}`);
  return res.json() as Promise<Record<string, SkRouteEntry>>;
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

/** Fetch all waypoints stored on the Signal K server. */
export async function fetchAllWaypoints(serverBase: string): Promise<Record<string, SkWaypointEntry>> {
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/waypoints`);
  if (!res.ok) throw new Error(`Waypoints API error: ${String(res.status)} ${res.statusText}`);
  return res.json() as Promise<Record<string, SkWaypointEntry>>;
}

export async function fetchCharts(serverBase: string): Promise<ChartRecord> {
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/charts`);
  if (!res.ok) throw new Error(`Charts API error: ${String(res.status)} ${res.statusText}`);
  return res.json() as Promise<ChartRecord>;
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

/** Fetch a map of vessel URN → rich vessel info from the REST API. */
export async function fetchVesselInfo(serverBase: string): Promise<Map<string, VesselInfo>> {
  const res = await fetch(`${serverBase}/signalk/v1/api/vessels`);
  if (!res.ok) return new Map();
  const data = await res.json() as Record<string, {
    name?: string;
    port?: string;
    flag?: string;
    communication?: { callsignVhf?: string; callsignHf?: string; skipperName?: string };
    navigation?: { state?: { value?: string } };
    design?: {
      aisShipType?: { value?: { name?: string } };
      length?:      { value?: { overall?: number } };
      beam?:        { value?: number };
      draft?:       { value?: { maximum?: number; current?: number } };
      airHeight?:   { value?: number };
    };
  }>;
  const map = new Map<string, VesselInfo>();
  for (const [urn, v] of Object.entries(data)) {
    const des = v.design;
    const info: VesselInfo = {};
    if (v.name)                                      info.name       = v.name;
    if (v.port)                                      info.port       = v.port;
    if (v.flag)                                      info.flag       = v.flag;
    if (v.communication?.callsignVhf)                info.callsign    = v.communication.callsignVhf;
    if (v.communication?.callsignHf)                 info.callsignHf  = v.communication.callsignHf;
    if (v.communication?.skipperName)                info.skipperName = v.communication.skipperName;
    if (v.navigation?.state?.value)                  info.navState    = v.navigation.state.value;
    if (des?.aisShipType?.value?.name)               info.shipType   = des.aisShipType.value.name;
    if (des?.length?.value?.overall !== undefined)   info.lengthM    = des.length.value.overall;
    if (typeof des?.beam?.value === 'number')        info.beamM      = des.beam.value;
    const draft = des?.draft?.value?.current ?? des?.draft?.value?.maximum;
    if (draft !== undefined)                         info.draftM     = draft;
    if (typeof des?.airHeight?.value === 'number')   info.airHeightM = des.airHeight.value;
    map.set(urn, info);
  }
  return map;
}



interface GeoJsonLike { type?: string; coordinates?: unknown; features?: unknown[]; geometry?: unknown }

function extractTrackCoords(geojson: unknown): [number, number][] {
  if (!geojson || typeof geojson !== 'object') return [];
  const g = geojson as GeoJsonLike;

  switch (g.type) {
    case 'FeatureCollection':
      return Array.isArray(g.features) ? g.features.flatMap(f => extractTrackCoords(f)) : [];
    case 'Feature':
      return extractTrackCoords(g.geometry);
    case 'LineString': {
      if (!Array.isArray(g.coordinates)) return [];
      return (g.coordinates as unknown[])
        .filter((c): c is number[] => Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number')
        .map(c => [c[0], c[1]] as [number, number]);
    }
    case 'MultiLineString': {
      if (!Array.isArray(g.coordinates)) return [];
      return (g.coordinates as unknown[][]).flatMap(line =>
        (Array.isArray(line) ? line : [] as unknown[])
          .filter((c): c is number[] => Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number')
          .map(c => [c[0], c[1]] as [number, number])
      );
    }
    default:
      return [];
  }
}

// ~5 metres in degrees² — fast planar deduplication approximation
const TRACK_DEDUP_SQ_DEG = (5 / 111_320) ** 2;

/**
 * Deduplicate a coordinate array by dropping points within ~5 m of the previous kept point.
 * Used when merging track sources that may have overlapping coverage.
 */
function dedupCoords(coords: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let prevLon = NaN;
  let prevLat = NaN;
  for (const [lon, lat] of coords) {
    const dLon = lon - prevLon;
    const dLat = lat - prevLat;
    if (out.length === 0 || dLon * dLon + dLat * dLat >= TRACK_DEDUP_SQ_DEG) {
      out.push([lon, lat]);
      prevLon = lon;
      prevLat = lat;
    }
  }
  return out;
}

/**
 * Fetch the own-vessel track from Signal K.
 *
 * Queries both sources in parallel and merges results:
 *  - v2 History API (`/signalk/v2/api/history/values?paths=navigation.position`)
 *    — backed by a persistent plugin (signalk-parquet, signalk-to-influxdb2, etc.).
 *    Survives server restarts. May not be installed on all servers.
 *  - v1 in-memory track (`/signalk/v1/api/vessels/self/track`)
 *    — always available, but lost on restart. May contain very recent points not
 *    yet flushed to the persistent store.
 *
 * The two sources are concatenated (v2 first, v1 second) and deduplicated by
 * proximity so overlapping points are collapsed into one.
 *
 * Returns a flat array of [lon, lat] pairs in chronological order.
 * @param startTime ISO 8601 timestamp for the start of the history window (optional)
 */
export async function fetchTrack(serverBase: string, startTime?: string): Promise<[number, number][]> {
  const v2Params = new URLSearchParams({ paths: 'navigation.position' });
  if (startTime) {
    v2Params.set('from', startTime);
  } else {
    v2Params.set('duration', 'PT24H');
  }
  const v1Params = startTime ? `?startTime=${encodeURIComponent(startTime)}` : '';

  const [v2Result, v1Result] = await Promise.allSettled([
    fetch(`${serverBase}/signalk/v2/api/history/values?${v2Params.toString()}`).then(async res => {
      if (!res.ok) return [] as [number, number][];
      const body = await res.json() as {
        data?: [string, { longitude?: number; latitude?: number } | null][];
      };
      const coords: [number, number][] = [];
      for (const [, pos] of body.data ?? []) {
        if (pos && typeof pos.longitude === 'number' && typeof pos.latitude === 'number') {
          coords.push([pos.longitude, pos.latitude]);
        }
      }
      return coords;
    }),
    fetch(`${serverBase}/signalk/v1/api/vessels/self/track${v1Params}`).then(async res => {
      if (!res.ok) return [] as [number, number][];
      return extractTrackCoords(await res.json() as unknown);
    }),
  ]);

  const v2Coords = v2Result.status === 'fulfilled' ? v2Result.value : [];
  const v1Coords = v1Result.status === 'fulfilled' ? v1Result.value : [];

  if (v2Coords.length === 0) return v1Coords;
  if (v1Coords.length === 0) return v2Coords;

  // Merge: v2 provides the historical base; v1 may add very recent points
  // not yet flushed to the persistent store. Deduplicate overlapping points.
  return dedupCoords([...v2Coords, ...v1Coords]);
}

/**
 * Fetch position history for an AIS vessel.
 *
 * Queries both sources in parallel (same strategy as fetchTrack for own vessel):
 *  - v2 History API with `context=vessels.{vesselId}`
 *  - v1 in-memory track `/vessels/{vesselId}/track`
 *
 * Returns a flat array of [lon, lat] pairs in chronological order.
 * Returns [] if neither source has data or the vessel ID is unknown.
 * @param vesselId Signal K vessel key, e.g. `urn:mrn:imo:mmsi:123456789`
 * @param startTime ISO 8601 start of history window (optional, defaults to 24 h)
 */
export async function fetchAisVesselTrack(
  serverBase: string,
  vesselId: string,
  startTime?: string,
): Promise<[number, number][]> {
  const encodedId = encodeURIComponent(vesselId);
  const context   = `vessels.${vesselId}`;
  const v2Params  = new URLSearchParams({ context, paths: 'navigation.position' });
  if (startTime) {
    v2Params.set('from', startTime);
  } else {
    v2Params.set('duration', 'PT24H');
  }
  const v1Params = startTime ? `?startTime=${encodeURIComponent(startTime)}` : '';

  const [v2Result, v1Result] = await Promise.allSettled([
    fetch(`${serverBase}/signalk/v2/api/history/values?${v2Params.toString()}`).then(async res => {
      if (!res.ok) return [] as [number, number][];
      const body = await res.json() as {
        data?: [string, { longitude?: number; latitude?: number } | null][];
      };
      const coords: [number, number][] = [];
      for (const [, pos] of body.data ?? []) {
        if (pos && typeof pos.longitude === 'number' && typeof pos.latitude === 'number') {
          coords.push([pos.longitude, pos.latitude]);
        }
      }
      return coords;
    }),
    fetch(`${serverBase}/signalk/v1/api/vessels/${encodedId}/track${v1Params}`).then(async res => {
      if (!res.ok) return [] as [number, number][];
      return extractTrackCoords(await res.json() as unknown);
    }),
  ]);

  const v2Coords = v2Result.status === 'fulfilled' ? v2Result.value : [];
  const v1Coords = v1Result.status === 'fulfilled' ? v1Result.value : [];
  if (v2Coords.length === 0) return v1Coords;
  if (v1Coords.length === 0) return v2Coords;
  return dedupCoords([...v2Coords, ...v1Coords]);
}

/**
 * Set the active course destination to a single point.
 * Replaces any existing course (active route or previous waypoint).
 *
 * Uses the Signal K v2 course API:
 *   PUT /signalk/v2/api/vessels/self/navigation/course
 *   { nextPoint: { position: { latitude, longitude } } }
 */
export async function navigateToPoint(
  serverBase: string,
  latitude: number,
  longitude: number,
  authHeaders: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${serverBase}/signalk/v2/api/vessels/self/navigation/course/destination`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ position: { latitude, longitude } }),
  });
  if (!res.ok) throw new Error(`Navigate to point failed: ${String(res.status)} ${res.statusText}`);
}

/**
 * Clear the active course (destination point or active route).
 *
 *   DELETE /signalk/v2/api/vessels/self/navigation/course
 */
export async function clearCourse(
  serverBase: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${serverBase}/signalk/v2/api/vessels/self/navigation/course`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  if (!res.ok) throw new Error(`Clear course failed: ${String(res.status)} ${res.statusText}`);
}

/**
 * Activate a route as the active course.
 *
 *   PUT /signalk/v2/api/vessels/self/navigation/course/activeRoute
 *   { "href": "/resources/routes/<uuid>" }
 */
export async function activateRoute(
  serverBase: string,
  routeUuid: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${serverBase}/signalk/v2/api/vessels/self/navigation/course/activeRoute`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ href: `/resources/routes/${routeUuid}` }),
  });
  if (!res.ok) throw new Error(`Activate route failed: ${String(res.status)} ${res.statusText}`);
}

function buildRouteBody(name: string, waypoints: { lon: number; lat: number }[]) {
  let distanceM = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const R_M = 1852 * 3440.065;
    const φ1 = (waypoints[i - 1]!.lat * Math.PI) / 180;
    const φ2 = (waypoints[i]!.lat * Math.PI) / 180;
    const Δφ = ((waypoints[i]!.lat - waypoints[i - 1]!.lat) * Math.PI) / 180;
    const Δλ = ((waypoints[i]!.lon - waypoints[i - 1]!.lon) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    distanceM += 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * R_M;
  }
  return {
    name,
    description: '',
    distance: Math.round(distanceM),
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: waypoints.map(w => [w.lon, w.lat]),
      },
      properties: {},
    },
  };
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
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(buildRouteBody(name, waypoints)),
  });
  if (!res.ok) throw new Error(`Save route failed: ${String(res.status)} ${res.statusText}`);
  const data = await res.json() as { id?: string; uuid?: string } | string;
  if (typeof data === 'string') return data;
  return (data.id ?? data.uuid ?? '');
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
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/routes/${uuid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(buildRouteBody(name, waypoints)),
  });
  if (!res.ok) throw new Error(`Update route failed: ${String(res.status)} ${res.statusText}`);
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
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/routes/${uuid}`, {
    method: 'DELETE',
    headers: { ...authHeaders },
  });
  if (!res.ok) throw new Error(`Delete route failed: ${String(res.status)} ${res.statusText}`);
}

/**
 * POST /signalk/v2/api/resources/waypoints
 *
 * Creates a new named waypoint on the Signal K server.
 * Returns the UUID of the newly created waypoint.
 */
export async function saveWaypoint(
  serverBase: string,
  name: string,
  lat: number,
  lon: number,
  authHeaders: Record<string, string>,
): Promise<string> {
  const body = {
    name,
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name },
    },
  };
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/waypoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Save waypoint failed: ${String(res.status)} ${res.statusText}`);
  const data = await res.json() as { id?: string } | string;
  return typeof data === 'string' ? data : (data.id ?? '');
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
  const body = {
    name,
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name },
    },
  };
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/waypoints/${uuid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Update waypoint failed: ${String(res.status)} ${res.statusText}`);
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
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/waypoints/${uuid}`, {
    method: 'DELETE',
    headers: { ...authHeaders },
  });
  if (!res.ok) throw new Error(`Delete waypoint failed: ${String(res.status)} ${res.statusText}`);
}

/**
 * Raise a Man Overboard alarm.
 *   PUT /signalk/v2/api/vessels/self/notifications/mob
 */
export async function raiseMob(
  serverBase: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${serverBase}/signalk/v2/api/vessels/self/notifications/mob`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      method: ['visual', 'sound'],
      state: 'emergency',
      message: 'Man Overboard!',
    }),
  });
  if (!res.ok) throw new Error(`MOB raise failed: ${String(res.status)} ${res.statusText}`);
}

/**
 * Clear the Man Overboard alarm.
 *   DELETE /signalk/v2/api/vessels/self/notifications/mob
 */
export async function clearMob(
  serverBase: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${serverBase}/signalk/v2/api/vessels/self/notifications/mob`, {
    method: 'DELETE',
    headers: { ...authHeaders },
  });
  if (!res.ok) throw new Error(`MOB clear failed: ${String(res.status)} ${res.statusText}`);
}
