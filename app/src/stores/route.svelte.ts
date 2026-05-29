/**
 * Route store — tracks the active Signal K route/course.
 *
 * The course metadata (nextPoint, previousPoint, activeRoute.href) arrives via
 * the WebSocket delta stream and is written here from App.svelte.
 * When the activeRoute href changes, the full route geometry is fetched from
 * the Signal K REST API and stored for rendering in Map.svelte.
 */

import type { Feature, LineString } from 'geojson';
import type { CourseState } from './vessel';

export interface RouteState {
  nextPoint:     { longitude: number; latitude: number } | null;
  previousPoint: { longitude: number; latitude: number } | null;
  activeHref:    string | null;
  routeName:     string | null;
  pointIndex:    number;
  reverse:       boolean;
  geometry:      Feature<LineString> | null;
  loading:       boolean;
  error:         string | null;
}

let _nextPoint:     RouteState['nextPoint']     = $state(null);
let _previousPoint: RouteState['previousPoint'] = $state(null);
let _activeHref:    string | null               = $state(null);
let _routeName:     string | null               = $state(null);
let _pointIndex:    number                      = $state(0);
let _reverse:       boolean                     = $state(false);
let _geometry:      Feature<LineString> | null  = $state(null);
let _loading:       boolean                     = $state(false);
let _error:         string | null               = $state(null);

/**
 * Fetch a route GeoJSON from the Signal K REST API.
 * Handles the SK resource envelope (`.feature`) as well as bare GeoJSON.
 */
async function fetchRouteGeometry(serverBase: string, href: string): Promise<Feature<LineString> | null> {
  // SK servers may emit href as either:
  //   /signalk/v1/api/resources/routes/{uuid}   (fully qualified SK path)
  //   /v1/api/resources/routes/{uuid}           (partial)
  //   /resources/routes/{uuid}                  (bare resource path, most common)
  // Normalise: strip any known prefix and re-root at /signalk/v1/api.
  let normHref: string;
  if (href.startsWith('http')) {
    normHref = href;
  } else {
    const bare = href.startsWith('/signalk/v2/api') ? href.slice('/signalk/v2/api'.length)
               : href.startsWith('/signalk/v1/api') ? href.slice('/signalk/v1/api'.length)
               : href.startsWith('/v1/api')          ? href.slice('/v1/api'.length)
               : href;
    normHref = `${serverBase}/signalk/v2/api${bare}`;
  }
  console.debug('[route] fetching geometry from', normHref);
  const res = await fetch(normHref);
  if (!res.ok) throw new Error(`Route fetch failed: ${res.status} ${res.statusText}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as any;
  console.debug('[route] REST response keys:', Object.keys(data ?? {}), 'type:', data?.type, 'featureType:', data?.feature?.type);

  // SK resource envelope: { feature: { type: "Feature", geometry: { type: "LineString" } } }
  if (data?.feature?.geometry?.type === 'LineString') return data.feature as Feature<LineString>;
  // Bare GeoJSON Feature
  if (data?.type === 'Feature' && data?.geometry?.type === 'LineString') return data as Feature<LineString>;
  // FeatureCollection (some plugins wrap it)
  if (data?.type === 'FeatureCollection') {
    const f = (data.features as unknown[]).find((f: unknown) =>
      (f as Feature).geometry?.type === 'LineString'
    );
    if (f) return f as Feature<LineString>;
  }
  // Log the unrecognised structure so we can add support for it
  console.warn('[route] unrecognised route REST response format:', JSON.stringify(data).slice(0, 300));
  return null;
}

function createRoute() {
  return {
    get nextPoint()     { return _nextPoint; },
    get previousPoint() { return _previousPoint; },
    get activeHref()    { return _activeHref; },
    get routeName()     { return _routeName; },
    get pointIndex()    { return _pointIndex; },
    get reverse()       { return _reverse; },
    get geometry()      { return _geometry; },
    get loading()       { return _loading; },
    get error()         { return _error; },

    /**
     * Called from App.svelte whenever the vessel state includes course data.
     * Fetches the route geometry from REST when the active route href changes.
     */
    update(serverBase: string, course: CourseState | undefined): void {
      _nextPoint     = course?.nextPoint     ?? null;
      _previousPoint = course?.previousPoint ?? null;

      const ar = course?.activeRoute;
      const newHref = ar?.href ?? null;
      console.debug('[route] update — nextPoint:', !!_nextPoint, 'prevPoint:', !!_previousPoint, 'href:', newHref);

      if (ar) {
        _routeName  = ar.name    ?? null;
        _pointIndex = ar.pointIndex;
        _reverse    = ar.reverse;
      }

      if (newHref !== _activeHref) {
        _activeHref = newHref;
        _geometry   = null;
        _error      = null;

        if (newHref) {
          _loading = true;
          fetchRouteGeometry(serverBase, newHref)
            .then(geo => { _geometry = geo; _loading = false; console.debug('[route] geometry loaded:', !!geo); })
            .catch(e => { _error = String(e); _loading = false; console.warn('[route] fetch error:', e); });
        } else {
          _loading = false;
        }
      }
    },

    clear(): void {
      _nextPoint = _previousPoint = _activeHref = _routeName = _geometry = _error = null;
      _pointIndex = 0;
      _reverse = _loading = false;
    },
  };
}

export const route = createRoute();
