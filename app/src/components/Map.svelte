<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import type * as GeoJSON from 'geojson';
  import { get } from 'svelte/store';
  import { vesselState, vesselPosition, type VesselState } from '../stores/vessel';
  import { settings, type LineAppearance, type LineStyle, type SettingsTab, type AppearanceSettings } from '../stores/settings.svelte';
  import { fpsStore } from '../stores/fps.svelte';
  import { followMode, type FollowOffset } from '../stores/follow.svelte';
  import { rotateMode } from '../stores/rotateMode.svelte';
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';
  import { ais, AIS_HOT_STRIDE, AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG, AIS_F_HDG, AIS_F_ROT, AIS_F_AGE } from '../stores/ais.svelte';
  import type { AisTarget } from '../stores/ais.svelte';
  import { MapboxOverlay } from '@deck.gl/mapbox';
  import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
  import { PathStyleExtension } from '@deck.gl/extensions';
  import type { Layer } from '@deck.gl/core';
  import { rulers, rulerBearingText, rulerDistanceText, type Ruler } from '../stores/rulers.svelte';
  import { routePlanner } from '../stores/routePlanner.svelte';
  import { route } from '../stores/route.svelte';
  import { routes } from '../stores/routes.svelte';
  import { waypoints } from '../stores/waypoints.svelte';
  import { track } from '../stores/track.svelte';
  import { gcLine, gcBearingDeg, gcDistanceNm } from '../lib/geoMath';
  import { fetchAndResolveStyle } from '../lib/resolveStyle';
  import { auth } from '../stores/auth.svelte';
  import { fetchAisVesselTrack, navigateToPoint, clearCourse, activateRoute, deleteRoute, saveWaypoint, updateWaypoint, deleteWaypoint } from '../lib/signalk-api';
  import { AisHullLayer, AisHullDecorationLayer, AisHullBorderLayer, HULL_ANCHOR_DOT, HULL_MOORING_BARS, HULL_AGROUND_RING, HULL_FISHING_GEAR, HULL_NUC, HULL_RESTRICTED, HULL_DRAUGHT } from '../layers/AisHullLayer';
  import { VesselIconLayer, ANCHOR_DOT_GEOMETRY, AGROUND_CIRCLE_GEOMETRY, MOORING_BARS_GEOMETRY, FISHING_GEAR_GEOMETRY, NUC_GEOMETRY, RESTRICTED_MANOEUVRING_GEOMETRY, DRAUGHT_GEOMETRY, MOB_GEOMETRY } from '../layers/VesselIconLayer';
  import { extrapolatePos } from '../lib/deadReckoning';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { mapView } from '../stores/mapView.svelte';
  import { visibility } from '../stores/visibility.svelte';

  const { openSettings = () => { /* noop */ } }: { openSettings?: (tab: SettingsTab) => void } = $props();

  const DEFAULT_STYLE: maplibregl.StyleSpecification = {
    version: 8,
    projection: { type: 'mercator' },
    sources: {
      'osm-tiles':  { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' },
      'openseamap': { type: 'raster', tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'], tileSize: 256 },
    },
    layers: [
      { id: 'osm',      type: 'raster', source: 'osm-tiles' },
      { id: 'seamarks', type: 'raster', source: 'openseamap' },
    ],
  };

  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map | undefined;
  let onFsChange = () => { /* noop */ };

  export function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => { /* noop */ });
    } else {
      document.exitFullscreen().catch(() => { /* noop */ });
    }
  }

  // t 0, l 0 -> center
  // t 1, l 0 -> top middle
  // t 0, l 1 -> middle left

  /** Computes the vessel's screen position as viewport fractions in (-1, 1).
   *  Multiply left by W/2, top by H/2 to get pixel offsets for easeTo/flyTo. */
  function calcVesselOffset(pos: { longitude: number; latitude: number }): FollowOffset {
    if (!map) return { left: 0, top: 0 };
    const W = mapContainer.clientWidth;
    const H = mapContainer.clientHeight;
    const px = map.project([pos.longitude, pos.latitude] as [number, number]);
    return {
      left: px.x / W * 2 - 1,
      top:  px.y / H * 2 - 1,
    };
  }

  export function flyToVessel() {
    if (followMode.following) {
      followMode.offset = null;
      return;
    }
    const pos = get(vesselState).position;
    if (pos) {
      const { left, top } = calcVesselOffset(pos);
      const inView = Math.abs(left) < 0.9 && Math.abs(top) < 0.9;
      followMode.offset = inView ? { left, top } : { left: 0, top: 0 };
      // Seed the position deduplication cache atomically with the follow state.
      // inView → vessel is already here, posChanged stays false on first tick.
      // !inView → NaN forces posChanged true, triggering the re-centring flyTo.
      _easedLon = inView ? pos.longitude : NaN;
      _easedLat = inView ? pos.latitude  : NaN;
    }
  }
  /** Zoom in one step, keeping the vessel at its current screen pixel when following. */
  export function zoomIn() {
    if (!map) return;
    if (followMode.following) {
      const pos = get(vesselState).position;
      if (pos) {
        // Mirror zoomIn() behaviour: snap to the next integer zoom level.
        const snap = map.getZoomSnap() || 1;
        const target = Math.ceil(map.getZoom() / snap) * snap + snap;
        map.easeTo({ zoom: target, around: [pos.longitude, pos.latitude] });
        return;
      }
    }
    map.zoomIn();
  }

  /** Zoom out one step, keeping the vessel at its current screen pixel when following. */
  export function zoomOut() {
    if (!map) return;
    if (followMode.following) {
      const pos = get(vesselState).position;
      if (pos) {
        const snap = map.getZoomSnap() || 1;
        const target = Math.floor(map.getZoom() / snap) * snap - snap;
        map.easeTo({ zoom: target, around: [pos.longitude, pos.latitude] });
        return;
      }
    }
    map.zoomOut();
  }

  let mapLoaded     = $state(false);
  let mapZoom       = $state(10);
  // Fraction [0..1] of total track length over which the start fades from transparent to opaque.
  let trackFadeStop = $state(0);
  // Raw [lon, lat] coords of the currently-displayed AIS vessel track (empty = none shown).
  let aisTrackRaw      = $state<[number, number][]>([]);
  let aisTrackFadeStop = $state(0);
  let _aisTrackGen     = 0; // incremented to cancel in-flight fetches on popup close
  // Per-vessel track cache for all-tracks mode (visibility.aisTracks ON).
  const aisAllTracksMap = new SvelteMap<string, [number, number][]>();
  let _aisAllTracksGen = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const _fetchedAisTrackIds = new Set<string>();
  let mapBearing  = $state(0);

  // When we switch mercator→globe, MapLibre creates a fresh VerticalPerspectiveProjection
  // whose GPU latitude-error correction starts at 0. Over 500 ms the correction converges,
  // causing tiles to drift south then slide north. We work around this by caching the
  // converged correction before leaving globe mode and injecting it immediately into the
  // new projection instance so the first frame is already correct.
  let _cachedGlobeCorrection: number | null = null;
  let _globeInjectionPending = false;

  // Suppress programmatic camera moves while the user is interacting (drag, pinch, scroll).
  // movestart fires for both user gestures and programmatic easeTo/flyTo; originalEvent is only
  // present for gestures. moveend always fires, resetting the flag.
  let _isInteracting = false;

  // Camera deduplication state: used to avoid redundant easeTo/flyTo calls.
  let _easedLon = NaN;
  let _easedLat = NaN;
  let _lastRm = '';
  let _lastNonFollowBearing: number | undefined = undefined;

  // Own vessel deck.gl layer group (heading/COG/GC predictor lines + icon) — rendered last
  // (on top of all AIS layers and the course/route lines) so it's never obscured.
  // Rebuilt synchronously on every position tick — see buildOwnVesselLayers().
  let ownVesselLayerGroup: Layer[] = [];

  // AIS-label setData throttle: individual vessel updates trigger rebuilds of the whole
  // FeatureCollection. Limit to 1 Hz — labels don't need sub-second precision.
  let _aisLastUpdateMs = 0;
  let _aisThrottleId: ReturnType<typeof setTimeout> | null = null;
  let _pendingAisSetData: (() => void) | null = null;

  export function setProjection(id: import('../stores/mapView.svelte').ProjectionId) {
    // Phase 0 — cache the converged latitude correction before leaving globe mode.
    if (id !== 'globe' && mapView.projection === 'globe') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const vp = (map as any)?.style?.projection?._verticalPerspectiveProjection;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (vp) _cachedGlobeCorrection = vp._errorCorrectionUsable as number;
    }

    mapView.projection = id;
    map?.setProjection({ type: id });

    if (id === 'globe' && _cachedGlobeCorrection !== null) {
      // Phase 1 — synchronously inject cached correction into the fresh VP projection
      // so the very first rendered frame is already at the correct latitude.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const vp = (map as any)?.style?.projection?._verticalPerspectiveProjection;
      if (vp) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        vp._errorCorrectionUsable       = _cachedGlobeCorrection;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        vp._errorCorrectionPreviousValue = _cachedGlobeCorrection;
        // Pre-set lastValue so the first updateGPUdependent call doesn't immediately
        // start a transition away from the cached value.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        vp._errorMeasurementLastValue = -_cachedGlobeCorrection;
      }

      // Phase 2 — after the first render, seed _measuredError (lazily created by
      // updateGPUdependent) so the ~167 ms drift before the real GPU readback returns
      // is also prevented.
      _globeInjectionPending = true;
      requestAnimationFrame(() => {
        if (!_globeInjectionPending) return;
        _globeInjectionPending = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        const vp2 = (map as any)?.style?.projection?._verticalPerspectiveProjection;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (vp2?._errorMeasurement && _cachedGlobeCorrection !== null) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          vp2._errorMeasurement._measuredError  = -_cachedGlobeCorrection;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          vp2._errorMeasurementLastValue         = -_cachedGlobeCorrection;
          // Far-past timestamp forces mix=1 immediately, so correction is applied without delay.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          vp2._errorMeasurementLastChangeTime    = performance.now() - 10_000;
        }
      });
    } else {
      _globeInjectionPending = false;
    }
  }

  const AIS_SOURCE      = 'ais-targets'; // kept for ais-label text layer
  const ROUTE_WPT_SRC   = 'route-waypoints';
  const ALL_ROUTES_SRC   = 'all-routes';
  const ALL_WAYPOINTS_SRC = 'all-waypoints';
  const TRACK_SOURCE          = 'vessel-track';
  const TRACK_OVERFLOW_SOURCE = 'vessel-track-overflow';
  const AIS_TRACK_SOURCE          = 'ais-track';
  const AIS_TRACK_OVERFLOW_SOURCE = 'ais-track-overflow';
  const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

  // Track the tile URL each chart source was last created with, so we can
  // detect URL changes (e.g. WMTS layer switch) and recreate the source.
  const chartSourceUrls = new SvelteMap<string, string>();
  // The MapLibre style URL currently loaded as the map base (null = default OSM style).
  // Not $state — only read inside the $effect, never rendered.
  let activeStyleUrl: string | null = null;

  // Returns null for solid lines — callers must pass null to setPaintProperty / omit from addLayer paint.
  // MapLibre requires all dasharray values to be > 0; [1, 0] is invalid and causes worker errors.
  function dashArray(style: LineStyle, width: number): number[] | null {
    const w = Math.max(1, width);
    switch (style) {
      case 'dashed':   return [5, 3];
      case 'dotted':   return [w, 3];
      case 'dash-dot': return [5, 3, 1, 3];
      default:         return null; // solid — no dasharray
    }
  }

  // --- Track fade helpers -------------------------------------------------------

  /** Shortest-path longitude delta from `prev` to `lon`, result in (-180, 180]. */
  function unwrapLon(lon: number, prev: number): number {
    const d = ((lon - prev + 180) % 360 + 360) % 360 - 180;
    return prev + d;
  }

  /** Haversine distance in metres between two [lon, lat] points. */
  function haversineMeters(a: [number, number], b: [number, number]): number {
    const R = 6_371_000;
    const dLat = (b[1] - a[1]) * (Math.PI / 180);
    const dLon = (b[0] - a[0]) * (Math.PI / 180);
    const lat1 = a[1] * (Math.PI / 180);
    const lat2 = b[1] * (Math.PI / 180);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  /**
   * Densify a GC segment between two already-unwrapped [lon, lat] positions.
   * Returns intermediate points (excluding start) plus the exact endpoint.
   * Inserts one intermediate point per ~50 km of arc; for short segments (< 50 km)
   * this is a cheap no-op that just returns [[lon2, lat2]].
   * Longitude continuity is maintained via progressive unwrapping from lon1.
   *
   * Uses spherical SLERP so intermediate points are exactly on the GC.
   * The exact endpoint is pushed last to prevent floating-point drift accumulation.
   */
  function gcDensifySegment(
    lon1: number, lat1: number,
    lon2: number, lat2: number,
  ): [number, number][] {
    const R = 6_371_000;
    const DEG = Math.PI / 180;
    const φ1 = lat1 * DEG, λ1 = lon1 * DEG;
    const φ2 = lat2 * DEG, λ2 = lon2 * DEG;
    const cosD = Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
    const d = Math.acos(Math.min(1, Math.max(-1, cosD)));
    const nSegs = Math.max(1, Math.ceil(d * R / 50_000));
    if (nSegs === 1 || d < 1e-9) return [[lon2, lat2]];
    const sinD = Math.sin(d);
    const out: [number, number][] = [];
    let prevλ = λ1;
    for (let i = 1; i < nSegs; i++) {
      const f = i / nSegs;
      const A = Math.sin((1 - f) * d) / sinD;
      const B = Math.sin(f * d) / sinD;
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1)                 + B * Math.sin(φ2);
      const φi = Math.atan2(z, Math.sqrt(x * x + y * y));
      const λiRaw = Math.atan2(y, x);
      // Unwrap relative to previous intermediate point so longitude stays continuous.
      const diff = λiRaw - prevλ;
      const λi = prevλ + diff - Math.round(diff / (2 * Math.PI)) * 2 * Math.PI;
      prevλ = λi;
      out.push([λi / DEG, φi / DEG]);
    }
    out.push([lon2, lat2]);  // exact endpoint — avoids floating-point drift accumulation
    return out;
  }

  /**
   * Unwrap raw [-180, 180] track coordinates into a continuous longitude sequence,
   * densify each segment along a GC path, and compute the fade stop fraction.
   *
   * Storing raw coords in the track store and unwrapping here avoids unbounded
   * accumulation of out-of-range longitudes (e.g. 208°, 388°…) that would break
   * MapLibre's line-metrics computation across multiple antimeridian crossings.
   *
   * Fade distance = min(0.5 nm, 10 % of total track length).
   */
  // Recursively split unwrapped+anchored coordinates into segments that each fit within
  // MapLibre's ±540° rendering range. Points outside the range are shifted eastward by
  // 720° (two world copies) so they appear in an adjacent but renderable world copy.
  // Returns segments ordered oldest-first; each is guaranteed to have pts[0][0] >= -540.
  // NOTE: only handles western overflow (pts[0] < −540). Tracks always accumulate westward
  // so this is sufficient for own-vessel/AIS tracks.
  function splitToFit(pts: [number, number][]): [number, number][][] {
    if (pts.length === 0 || pts[0]![0] >= -540) return pts.length > 0 ? [pts] : [];
    let si = 0;
    while (si < pts.length - 1 && pts[si]![0] < -540) si++;
    const recent = pts.slice(si);
    const overflow = pts.slice(0, si + 1).map(pt => [pt[0] + 720, pt[1]] as [number, number]);
    return [...splitToFit(overflow), recent];
  }

  /**
   * Bidirectional split for routes (and any arbitrary line that may circle the globe).
   * Handles both western overflow (< −540°) and eastern overflow (> +540°) by recursively
   * shifting overflow segments by ∓720° into the nearest renderable world copy.
   * Returns an array of segments all within ±540° longitude.
   */
  function splitRouteSegments(pts: [number, number][]): [number, number][][] {
    if (pts.length === 0) return [];
    if (pts[0]![0] < -540) {
      let si = 0;
      while (si < pts.length - 1 && pts[si]![0] < -540) si++;
      const west = pts.slice(0, si + 1).map(p => [p[0] + 720, p[1]] as [number, number]);
      return [...splitRouteSegments(west), ...splitRouteSegments(pts.slice(si))];
    }
    if (pts[pts.length - 1]![0] > 540) {
      let si = pts.length - 1;
      while (si > 0 && pts[si]![0] > 540) si--;
      const east = pts.slice(si).map(p => [p[0] - 720, p[1]] as [number, number]);
      return [...splitRouteSegments(pts.slice(0, si + 1)), ...splitRouteSegments(east)];
    }
    return [pts];
  }

  function processTrack(raw: [number, number][]): { coords: [number, number][]; overflowSegments: [number, number][][]; fadeStop: number } {
    if (raw.length < 2) return { coords: raw, overflowSegments: [], fadeStop: 0 };
    const out: [number, number][] = [[raw[0]![0], raw[0]![1]]];
    for (let i = 1; i < raw.length; i++) {
      const prev = out[out.length - 1]!;
      const lon = unwrapLon(raw[i]![0], prev[0]);
      // Densify along the great-circle path. For short segments (< 50 km, the common
      // case for live tracks) gcDensifySegment is a cheap no-op returning just the endpoint.
      for (const pt of gcDensifySegment(prev[0], prev[1], lon, raw[i]![1])) out.push(pt);
    }
    // Anchor the most-recent point to [-180, 180]. Without this, multiple antimeridian
    // crossings accumulate unbounded longitude values which MapLibre cannot render.
    const shift = Math.round(out[out.length - 1]![0] / 360) * 360;
    if (shift !== 0) for (const pt of out) pt[0] -= shift;
    // Split into segments each within ±540°; the last segment is the most recent.
    const segments = splitToFit(out);
    const coords = segments[segments.length - 1] ?? out;
    const overflowSegments = segments.slice(0, -1);
    // Fade stop is computed over the most-recent segment only (where the gradient applies).
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1]!, coords[i]!);
    const fadeStop = total > 0 ? Math.min(Math.min(0.5 * 1852, total * 0.1) / total, 1) : 0;
    return { coords, overflowSegments, fadeStop };
  }

  /**
   * Unwraps longitudes, GC-densifies, and anchors a route or two-point line for
   * antimeridian-safe rendering. Anchors by the midpoint of first and last point so
   * both ends of the route stay near [-180, 180].
   */
  function processRouteCoords(raw: [number, number][]): [number, number][] {
    if (raw.length < 2) return raw;
    const out: [number, number][] = [[raw[0]![0], raw[0]![1]]];
    for (let i = 1; i < raw.length; i++) {
      const prev = out[out.length - 1]!;
      const lon = unwrapLon(raw[i]![0], prev[0]);
      for (const pt of gcDensifySegment(prev[0], prev[1], lon, raw[i]![1])) out.push(pt);
    }
    const mid = (out[0]![0] + out[out.length - 1]![0]) / 2;
    const shift = Math.round(mid / 360) * 360;
    if (shift !== 0) for (const pt of out) pt[0] -= shift;
    return out;
  }

  /**
   * Builds a MapLibre `line-gradient` expression that fades from transparent at the
   * track start (oldest point) to fully opaque at `fadeStop`, then stays opaque.
   * Used for solid-style tracks; non-solid styles use plain `line-color`.
   */
  function buildTrackGradient(color: string, fadeStop: number): unknown[] {
    const hex = color.replace('#', '');
    const r = parseInt(hex.length === 3 ? hex.charAt(0) + hex.charAt(0) : hex.slice(0, 2), 16);
    const g = parseInt(hex.length === 3 ? hex.charAt(1) + hex.charAt(1) : hex.slice(2, 4), 16);
    const b = parseInt(hex.length === 3 ? hex.charAt(2) + hex.charAt(2) : hex.slice(4, 6), 16);
    const transparent = `rgba(${String(r)},${String(g)},${String(b)},0)`;
    if (fadeStop < 0.001) {
      return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
    }
    return ['interpolate', ['linear'], ['line-progress'], 0, transparent, fadeStop, color, 1, color];
  }

  // --- End track fade helpers ---------------------------------------------------

  /** Rhumb line destination. Returns unwrapped longitude so antimeridian crossings render correctly. */
  function destPoint(lon: number, lat: number, bearingRad: number, distM: number): [number, number] {
    const R = 6371000;
    const δ = distM / R;
    const φ1 = (lat * Math.PI) / 180;
    const φ2 = φ1 + δ * Math.cos(bearingRad);
    const Δψ = Math.log(Math.tan(φ2 / 2 + Math.PI / 4) / Math.tan(φ1 / 2 + Math.PI / 4));
    const q = Math.abs(Δψ) > 1e-10 ? (φ2 - φ1) / Δψ : Math.cos(φ1);
    const λ2 = (lon * Math.PI) / 180 + δ * Math.sin(bearingRad) / q;
    return [(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI];
  }

  /**
   * Generate densified rhumb line coords with progressive unwrapping.
   * Unwrapped longitude keeps antimeridian crossings continuous for both Mercator and Globe.
   */
  function rhumbCoords(lon: number, lat: number, bearingRad: number, distM: number): [number, number][] {
    const R = 6371000;
    const φ1 = (lat * Math.PI) / 180;
    const cosB = Math.cos(bearingRad);
    if (Math.abs(cosB) > 1e-10) {
      const capφ = cosB > 0 ? (85.0 * Math.PI) / 180 : -(85.0 * Math.PI) / 180;
      const distToCap = ((capφ - φ1) / cosB) * R;
      if (distToCap > 0 && distToCap < distM) distM = distToCap;
    }
    const SEGMENTS = 256;
    const coords: [number, number][] = [];
    let prevλ = (lon * Math.PI) / 180;
    for (let i = 0; i <= SEGMENTS; i++) {
      const [rawLon, rawLat] = destPoint(lon, lat, bearingRad, (i / SEGMENTS) * distM);
      const rawλ = (rawLon * Math.PI) / 180;
      const diff = rawλ - prevλ;
      const λ = prevλ + diff - Math.round(diff / (2 * Math.PI)) * 2 * Math.PI;
      prevλ = λ;
      coords.push([(λ * 180) / Math.PI, rawLat]);
    }
    return coords;
  }

  function gcCoords(lon: number, lat: number, bearingRad: number, distM: number): [number, number][] {
    const R = 6371000;
    const SEGMENTS = 256;
    const φ1 = (lat * Math.PI) / 180;
    const λ1 = (lon * Math.PI) / 180;
    const coords: [number, number][] = [];
    let prevλ = λ1;

    for (let i = 0; i <= SEGMENTS; i++) {
      const d = (i / SEGMENTS) * distM / R;
      const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(bearingRad));
      const λ2raw = λ1 + Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
      // Unwrap: keep longitude continuous across the antimeridian
      const diff = λ2raw - prevλ;
      const λ2 = prevλ + diff - Math.round(diff / (2 * Math.PI)) * 2 * Math.PI;
      prevλ = λ2;
      coords.push([(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI]);
    }
    return coords;
  }

  function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b, alpha];
  }

  /**
   * Map a LineStyle + line width to a PathStyleExtension dash array [dashPx, gapPx].
   * Values are in pixels (same units as widthUnits: 'pixels').
   * Pattern scales with width so dots stay circular and dashes stay proportional.
   */
  function lineStyleDash(style: LineStyle, width: number): [number, number] {
    const w = Math.max(1, width);
    switch (style) {
      case 'dashed':   return [6 * w, 3 * w];
      case 'dotted':   return [w,     2 * w];  // dot ≈ square/circular, gap = 2× width
      case 'dash-dot': return [6 * w, 2 * w];  // deck.gl only supports two-element arrays
      default:         return [0, 0];
    }
  }

  /** Return the current map view for extension host API. */
  export function getView(): { center: [number, number]; zoom: number; bounds: [number, number, number, number] } {
    if (!map) return { center: [0, 0], zoom: 0, bounds: [0, 0, 0, 0] };
    const c = map.getCenter();
    const b = map.getBounds();
    return {
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    };
  }

  /** Fly to a position, optionally changing zoom. Used by extension map.center. */
  export function flyTo(position: [number, number], zoom?: number): void {
    map?.flyTo({ center: position, ...(zoom !== undefined ? { zoom } : {}) });
  }

  /** Fit the map to a bounding box [west, south, east, north]. Used by extension map.fitBounds. */
  export function fitBounds(bounds: [number, number, number, number]): void {
    map?.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 20 });
  }

  /** Add a new ruler in the lower third of the screen, endpoints ¼ screen-width apart. */
  export function addRuler() {
    if (!map) return;
    const w = mapContainer.clientWidth;
    const h = mapContainer.clientHeight;
    // Centre X, lower-third Y
    const cx = w / 2;
    const cy = h * 0.75;
    const halfSpanPx = w / 8;  // ¼ screen width total → ⅛ each side
    const a = map.unproject([cx - halfSpanPx, cy]);
    const b = map.unproject([cx + halfSpanPx, cy]);
    rulers.add(a.lng, a.lat, b.lng, b.lat);
  }

  // Ruler drag state: which (rulerId, endpoint) is currently being dragged.
  type DragState = { rulerId: string; endpoint: 'a' | 'b' } | null;
  let rulerDrag: DragState = null;
  // True while the cursor is over a ruler handle — dragPan disabled proactively on hover.
  let isHoveringHandle = false;
  // Ruler label popup: shown when user clicks a label; holds screen position and ruler id.
  let rulerPopup = $state<{ rulerId: string; x: number; y: number } | null>(null);
  // At most one MapLibre popup open at a time — each new popup closes the previous one.
  let activePopup: maplibregl.Popup | null = null;
  function openPopup(p: maplibregl.Popup): maplibregl.Popup {
    activePopup?.remove();
    activePopup = p;
    p.on('close', () => { if (activePopup === p) activePopup = null; });
    return p;
  }

  // Route planner drag state.
  let plannerDrag: { idx: number } | null = null;
  // Waypoint index targeted by a right-click (set in pointerdown, consumed in contextmenu).
  let plannerRightClickIdx: number | null = null;
  // Waypoint being relocated: next map click sets its new position.
  let movingWaypoint: { uuid: string; name: string } | null = $state(null);

  function setHandleHover(hovering: boolean) {
    if (hovering === isHoveringHandle) return;
    isHoveringHandle = hovering;
    mapContainer.style.cursor = hovering ? 'grab' : '';
    if (hovering) {
      map?.dragPan.disable();
    } else if (!rulerDrag && !followMode.following) {
      map?.dragPan.enable();
    }
  }

  // Native pointer-event drag handlers — deck.gl drag callbacks break when the layer
  // is recreated mid-drag (which happens every rAF because the data changes).
  // Hover/click are handled here via overlay.pickObject().
  function handleRulerPointerDown(e: PointerEvent) {
    if (!overlay || !map) return;
    const rect = mapContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Planner handles take priority when planner is active.
    if (routePlanner.active) {
      const plannerPick = overlay.pickObject({ x, y, radius: 12, layerIds: ['planner-handles'] });
      if (plannerPick?.object !== null && plannerPick?.object !== undefined) {
        interface PlannerHandle { idx: number }
        const d = plannerPick.object as PlannerHandle;
        if (e.button === 2) {
          // Right-click on a handle → store for deletion in the contextmenu handler.
          plannerRightClickIdx = d.idx;
          e.stopPropagation();
          return;
        }
        plannerDrag = { idx: d.idx };
        map.dragPan.disable();
        mapContainer.style.cursor = 'grabbing';
        mapContainer.setPointerCapture(e.pointerId);
        e.stopPropagation();
        return;
      }
    }

    // Check label click — opens the remove popup.
    const labelPick = overlay.pickObject({ x, y, radius: 14, layerIds: ['ruler-labels'] });
    if (labelPick?.object) {
      interface LabelDatum { ruler: { id: string } }
      const d = labelPick.object as LabelDatum;
      rulerPopup = { rulerId: d.ruler.id, x: e.clientX, y: e.clientY };
      e.stopPropagation();
      return;
    }
    // Dismiss popup on any other tap on the map.
    if (rulerPopup) { rulerPopup = null; return; }
    const picked = overlay.pickObject({ x, y, radius: 10, layerIds: ['ruler-handles'] });
    if (!picked?.object) return;
    interface HandleDatum { rulerId: string; endpoint: 'a' | 'b' }
    const d = picked.object as HandleDatum;
    rulerDrag = { rulerId: d.rulerId, endpoint: d.endpoint };
    map.dragPan.disable();
    mapContainer.style.cursor = 'grabbing';
    mapContainer.setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  function handleRulerPointerMove(e: PointerEvent) {
    if (!map) return;
    const rect = mapContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (plannerDrag) {
      const coord = map.unproject([x, y]);
      routePlanner.moveWaypoint(plannerDrag.idx, coord.lng, coord.lat);
      e.stopPropagation();
      return;
    }

    if (!rulerDrag) {
      // Hover detection via pickObject (avoids deck.gl layer recreation race on drag).
      if (overlay) {
        try {
          const handleLayers = ['ruler-handles', ...(routePlanner.active ? ['planner-handles'] : [])];
          const hoverPick = overlay.pickObject({ x, y, radius: 10, layerIds: handleLayers });
          setHandleHover(!!hoverPick?.object);
        } catch {
          // deck.gl overlay may be in a transient invalid state during map style reload
        }
      }
      return;
    }
    const coord = map.unproject([x, y]);
    rulers.moveEndpoint(rulerDrag.rulerId, rulerDrag.endpoint, coord.lng, coord.lat);
    e.stopPropagation();
  }

  function handleRulerPointerUp(e: PointerEvent) {
    if (plannerDrag) {
      plannerDrag = null;
      mapContainer.style.cursor = isHoveringHandle ? 'grab' : '';
      if (!isHoveringHandle && !followMode.following) map?.dragPan.enable();
      mapContainer.releasePointerCapture(e.pointerId);
      return;
    }

    if (!rulerDrag || !map) return;
    const rect = mapContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const coord = map.unproject([x, y]);
    // Snap check: find nearest target (AIS ghost or own vessel) within threshold
    let snapId: string | undefined;
    let snapLon = coord.lng;
    let snapLat = coord.lat;
    for (const t of liveSnapTargets) {
      const pt = map.project([t.position.longitude, t.position.latitude]);
      if (Math.hypot(pt.x - x, pt.y - y) < RULER_SNAP_PX) {
        snapId  = t.id;
        snapLon = t.position.longitude;
        snapLat = t.position.latitude;
        break;
      }
    }
    rulers.snapEndpoint(rulerDrag.rulerId, rulerDrag.endpoint, snapId, snapLon, snapLat);
    rulerDrag = null;
    mapContainer.style.cursor = isHoveringHandle ? 'grab' : '';
    if (!isHoveringHandle && !followMode.following) map.dragPan.enable();
    mapContainer.releasePointerCapture(e.pointerId);
  }

  // Snap threshold in pixels.
  const RULER_SNAP_PX = 24;

  // Ghost positions updated each rAF — dead-reckoned (lon, lat) keyed by AIS target id.
  // Used for ruler snap so endpoints follow the animated ghost, not last-known position.
  let liveSnapTargets: { id: string; position: { longitude: number; latitude: number } }[] = [];

  let overlay: MapboxOverlay | null = null;
  // Typed-array snapshots of the last AIS data batch — used by rafTick for ruler snap.
  let aisHotSnapshot: Float64Array | null = null;
  let aisIdsSnapshot: string[] = [];
  let aisUploadTimestamp = 0;
  // Reference to the last hotData array seen by the AIS deck.gl $effect.
  // Used to detect whether the effect was triggered by new WS data (hotData changed)
  // or by a cold-data-only change (e.g. setInfoCache every 3 min). Only update
  // aisUploadTimestamp when hotData actually changes — otherwise dead-reckoned
  // vessel positions snap backwards each time vessel info is refreshed.
  let _lastAisHotData: Float64Array | null = null;
  // Layer groups composed into overlay.setProps() — AIS layers set on data tick,
  // ruler layers rebuilt in rafTick (need map.project() for pixel distance checks).
  let aisLayerGroup: Layer[] = [];
  let rulerLayerGroup: Layer[] = [];
  let plannerLayerGroup: Layer[] = [];
  // Active route lines (full polyline, active leg, bearing) — deck.gl, not MapLibre.
  // MapLibre layers render below the deck.gl overlay's own canvas (interleaved: false,
  // see overlay setup), so a MapLibre line can never sit on top of an AIS target or the
  // own-vessel icon. Composed into flushLayers() like the other groups below.
  let courseLayerGroup: Layer[] = [];

  function flushLayers() {
    // Read visibility without establishing reactive dependency — callers should not
    // re-run just because the user toggled a layer. A dedicated $effect handles that.
    const showVessels    = untrack(() => visibility.aisVessels);
    const showPredictors = untrack(() => visibility.aisPredictors);
    const aisFiltered = (showVessels && showPredictors)
      ? aisLayerGroup
      : aisLayerGroup.filter(l => (l instanceof PathLayer ? (showVessels && showPredictors) : showVessels));
    overlay?.setProps({ layers: [...aisFiltered, ...courseLayerGroup, ...rulerLayerGroup, ...plannerLayerGroup, ...ownVesselLayerGroup] });
  }

  let rafId = 0;
  // Ref to scheduleRafTick (defined inside onMount) for use in the reactive effect below.
  let _scheduleRafTick: (() => void) | null = null;
  const _fpsSamples: number[] = [];

  // When the target FPS changes: cancel the pending tick, clear measurement history,
  // and reschedule immediately at the new rate.
  $effect(() => {
    void settings.targetFps;
    cancelAnimationFrame(rafId);
    clearTimeout(rafId);
    _fpsSamples.length = 0;
    fpsStore.set(0);
    _scheduleRafTick?.();
  });

  onMount(() => {
    mapView.isFullscreen = !!document.fullscreenElement;
    map = new maplibregl.Map({
      container: mapContainer,
      style: DEFAULT_STYLE,
      center: [10.75, 59.91],
      zoom: 10,
      maxPitch: 85,
      bearingSnap: 0,
      attributionControl: false,
    });

    // Zoom buttons + scale bar share the bottom-left slot, laid out as a row via CSS.
    // MapLibre prepends into bottom-* containers (insertBefore firstChild), so the
    // LAST control added ends up FIRST in the DOM → leftmost in our flex-row override.
    // Add scale first so zoom buttons end up left of the scale.
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');
    map.addControl({
      onAdd(_: maplibregl.Map): HTMLElement {
        const el = document.createElement('div');
        el.className = 'maplibregl-ctrl zoom-ctrl-group';
        const btnIn  = document.createElement('button');
        btnIn.className   = 'zoom-ctrl-btn';
        btnIn.title       = 'Zoom in';
        btnIn.textContent = '+';
        btnIn.addEventListener('click', () => { zoomIn(); });
        const btnOut = document.createElement('button');
        btnOut.className   = 'zoom-ctrl-btn';
        btnOut.title       = 'Zoom out';
        btnOut.textContent = '−';
        btnOut.addEventListener('click', () => { zoomOut(); });
        el.appendChild(btnIn);
        el.appendChild(btnOut);
        return el;
      },
      onRemove(_: maplibregl.Map): void { /* MapLibre removes the element */ },
    }, 'bottom-left');
    map.doubleClickZoom.disable(); // double-click zoom is too easy to trigger accidentally on a chart

    // deck.gl overlay — non-interleaved mode: deck.gl renders on its own canvas (on top of
    // MapLibre) with its own rAF loop. This decouples deck.gl animation from MapLibre's render
    // pipeline, preventing AIS animation from driving MapLibre's symbol worker continuously.
    //
    // deck.gl v9.1+ (Globe View ♥ MapLibre): GlobeViewport is updated to match
    // MapLibre v5's camera matrices — MapboxOverlay works without additional configuration.
    // Do NOT pass a custom `views` prop; let getDeckInstance choose GlobeView or MapView.
    //
    // cullMode:'none' — getDefaultParameters adds cullMode:'back' in globe mode to cull
    // far-hemisphere geometry. However, the IconLayer's billboard:false path applies a
    // pixelOffset.y flip before the globe orientation matrix, resulting in CW (back-face)
    // winding in screen space — culled invisible. We override to 'none' to keep all
    // overlay layers visible. Far-hemisphere hull artifacts are handled by the per-vertex
    // hemisphere discard in AisHullLayer instead.
    overlay = new MapboxOverlay({
      layers: [],
      interleaved: false,
      // depthCompare:'always' — our layers (hull + icon) occupy nearly identical depths so
      // depth testing causes z-fighting. We draw in painter's order and don't need occlusion
      // between our own layers. In non-interleaved mode this only affects deck.gl's canvas.
      parameters: { depthCompare: 'always', cullMode: 'none' },
    });
    map.addControl(overlay);
    // Flush any AIS layers that were built before the overlay was ready.
    flushLayers();

    // rAF loop: updates ruler layers (need map.project()) and snap targets each frame.
    // AIS layers are self-animating — no setProps() from here for them.
    function rafTick() {
      // Measure actual FPS using a rolling window of frame timestamps.
      const now = performance.now();
      _fpsSamples.push(now);
      const cutoff = now - 3000;
      while (_fpsSamples.length > 2 && _fpsSamples[0]! < cutoff) _fpsSamples.shift();
      if (_fpsSamples.length >= 2) {
        const span = _fpsSamples[_fpsSamples.length - 1]! - _fpsSamples[0]!;
        fpsStore.set((_fpsSamples.length - 1) / (span / 1000));
      }

      if (overlay !== null) {
        const nowMs = Date.now();

        // Ruler layers — rebuilt every frame only when rulers exist, because label
        // visibility uses map.project() which depends on the current viewport.
        // AIS layers are self-animating (no setProps needed from here for them).
        const currentRulers = rulers.rulers;

        // Build live snap targets only when there are active rulers to snap to.
        // For moving vessels: two snap points — last-known (id) and dead-reckoned (id+':ghost').
        // For stationary vessels: one snap point at last-known position.
        // Own vessel always included.
        if (currentRulers.length > 0) {
          const nowForSnap = nowMs;
          const ownPosForSnap = get(vesselState).position;
          const snapPts: typeof liveSnapTargets = [];
          const S = AIS_HOT_STRIDE;
          if (aisHotSnapshot && aisIdsSnapshot.length > 0) {
            const hd = aisHotSnapshot;
            const ids = aisIdsSnapshot;
            const n = ids.length;
            for (let i = 0; i < n; i++) {
              const lon = hd[i * S + AIS_F_LON]!;
              const lat = hd[i * S + AIS_F_LAT]!;
              snapPts.push({ id: ids[i]!, position: { longitude: lon, latitude: lat } });
              const cog = hd[i * S + AIS_F_COG]!;
              const sog = hd[i * S + AIS_F_SOG]!;
              if (!isNaN(cog) && !isNaN(sog) && sog > 0.1) {
                const rot = hd[i * S + AIS_F_ROT]!;
                const lastPosMs = aisUploadTimestamp - hd[i * S + AIS_F_AGE]! * 1000;
                const [gLon, gLat] = extrapolatePos(lon, lat, cog, sog, isNaN(rot) ? 0 : rot, lastPosMs, nowForSnap);
                snapPts.push({ id: `${String(ids[i])}:ghost`, position: { longitude: gLon, latitude: gLat } });
              }
            }
          }
          if (ownPosForSnap) {
            snapPts.push({ id: 'own-vessel', position: { longitude: ownPosForSnap.longitude, latitude: ownPosForSnap.latitude } });
          }
          liveSnapTargets = snapPts;
          rulers.syncSnapped(liveSnapTargets);

          // --- Ruler layers ---
          interface HandleDatum { rulerId: string; endpoint: 'a' | 'b'; lon: number; lat: number; snapId?: string | undefined }
          interface LineDatum { ruler: Ruler }

          const rulerColor    = settings.appearance.ruler.color;
          const rulerWidth    = settings.appearance.ruler.width;

          // Hex color → [r, g, b, a] for deck.gl (alpha 0.0–1.0)
          function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
            const n = parseInt(hex.replace('#', ''), 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255)];
          }
          const lineRgba   = hexToRgba(rulerColor, 0.87);
          const handleRgba = hexToRgba(rulerColor, 0.90);

          interface MidDatum { ruler: Ruler; lon: number; lat: number }

          // Exact GC midpoint — land on the line, not the chord.
          // Omit entries where the two handles are <200px apart (label would overlap handles).
          const LABEL_MIN_PX = 200;
          const midData: MidDatum[] = currentRulers.flatMap(r => {
            if (map) {
              const pA = map.project([r.a.lon, r.a.lat]);
              const pB = map.project([r.b.lon, r.b.lat]);
              if (Math.hypot(pB.x - pA.x, pB.y - pA.y) < LABEL_MIN_PX) return [];
            }
            const pts = gcLine(r.a.lon, r.a.lat, r.b.lon, r.b.lat);
            const mid = pts[Math.floor(pts.length / 2)]!;
            return [{ ruler: r, lon: mid[0], lat: mid[1] }];
          });

          const handleData: HandleDatum[] = currentRulers.flatMap(r => [
            { rulerId: r.id, endpoint: 'a', lon: r.a.lon, lat: r.a.lat, snapId: r.a.snapId },
            { rulerId: r.id, endpoint: 'b', lon: r.b.lon, lat: r.b.lat, snapId: r.b.snapId },
          ]);

          rulerLayerGroup = [
            new PathLayer<LineDatum>({
              id: 'ruler-line',
              data: currentRulers.map(r => ({ ruler: r })),
              getPath: (d: LineDatum) => gcLine(d.ruler.a.lon, d.ruler.a.lat, d.ruler.b.lon, d.ruler.b.lat),
              getColor: () => lineRgba,
              getWidth: rulerWidth,
              widthUnits: 'pixels',
              widthMinPixels: 1,
              pickable: false,
              updateTriggers: { getPath: [currentRulers] },
            }),

            // Endpoint handles — pickable for hover; drag handled via native pointer events
            new ScatterplotLayer<HandleDatum>({
              id: 'ruler-handles',
              data: handleData,
              getPosition: (d: HandleDatum) => [d.lon, d.lat, 0],
              getRadius: 7,
              radiusUnits: 'pixels',
              getFillColor: (d: HandleDatum) => d.snapId
                ? [255, 100, 50, 230] as [number, number, number, number]   // snapped: orange
                : handleRgba,                                                // free: ruler color
              getLineColor: [255, 255, 255, 180] as [number, number, number, number],
              lineWidthUnits: 'pixels',
              getLineWidth: 1.5,
              stroked: true,
              pickable: true,
              updateTriggers: {
                getPosition:  [currentRulers],
                getFillColor: [currentRulers, rulerColor],
              },
            }),

            // Label at GC midpoint — pickable so the user can click to open the remove popup.
            new TextLayer<MidDatum>({
              id: 'ruler-labels',
              data: midData,
              getText: (d: MidDatum) => `${rulerBearingText(d.ruler)}  ·  ${rulerDistanceText(d.ruler)}`,
              getPosition: (d: MidDatum) => [d.lon, d.lat, 0],
              getSize: 13,
              getColor: [255, 240, 180, 230] as [number, number, number, number],
              getBackgroundColor: [0, 0, 0, 160] as [number, number, number, number],
              background: true,
              backgroundPadding: [4, 2, 4, 2] as [number, number, number, number],
              getTextAnchor: 'middle' as const,
              getAlignmentBaseline: 'center' as const,
              fontFamily: 'monospace',
              characterSet: Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 °·.,\'-/T'),
              pickable: true,
              updateTriggers: { getText: [currentRulers], getPosition: [currentRulers] },
            }),
          ];
          flushLayers();
        } else if (rulerLayerGroup.length > 0) {
          // Rulers were just removed — clear popup and flush once.
          rulerLayerGroup = [];
          rulerPopup = null;
          flushLayers();
        }

        // --- Route planner layers ---
        {
          const wpts = routePlanner.waypoints;
          if (routePlanner.active) {
            interface PlannerHandle { idx: number; lon: number; lat: number }

            // Build per-segment label data: midpoint + bearing + distance for each leg.
            interface PlannerLabelDatum { lon: number; lat: number; text: string }
            const LABEL_MIN_PX = 150;
            const segmentLabels: PlannerLabelDatum[] = [];
            const paths: [number, number][][] = [];

            for (let i = 1; i < wpts.length; i++) {
              const a = wpts[i - 1]!;
              const b = wpts[i]!;
              const pts = gcLine(a.lon, a.lat, b.lon, b.lat);
              paths.push(pts);
              if (map) {
                const pA = map.project([a.lon, a.lat]);
                const pB = map.project([b.lon, b.lat]);
                if (Math.hypot(pB.x - pA.x, pB.y - pA.y) >= LABEL_MIN_PX) {
                  const mid = pts[Math.floor(pts.length / 2)]!;
                  const dist = gcDistanceNm(a.lon, a.lat, b.lon, b.lat);
                  const brg  = gcBearingDeg(a.lon, a.lat, b.lon, b.lat);
                  const distStr = dist < 10 ? dist.toFixed(2) : dist.toFixed(1);
                  segmentLabels.push({
                    lon: mid[0], lat: mid[1],
                    text: `${distStr} NM · ${brg.toFixed(0).padStart(3, '0')}° T`,
                  });
                }
              }
            }

            const handleData: PlannerHandle[] = wpts.map((w, idx) => ({ idx, lon: w.lon, lat: w.lat }));

            // Typed segment data so clicking a line returns the segment index.
            interface PlannerSegment { segIdx: number; path: [number, number][] }
            const segData: PlannerSegment[] = paths.map((path, segIdx) => ({ segIdx, path }));

            plannerLayerGroup = [
              new PathLayer<PlannerSegment>({
                id: 'planner-line',
                data: segData,
                getPath: (d) => d.path,
                getColor: hexToRgba(settings.appearance.planner.color, 210),
                getWidth: settings.appearance.planner.width,
                widthUnits: 'pixels',
                widthMinPixels: 1,
                pickable: true,
                updateTriggers: { getPath: [wpts] },
              }),
              new ScatterplotLayer<PlannerHandle>({
                id: 'planner-handles',
                data: handleData,
                getPosition: (d) => [d.lon, d.lat, 0],
                getRadius: 8,
                radiusUnits: 'pixels',
                getFillColor: hexToRgba(settings.appearance.planner.color, 220),
                getLineColor: [255, 255, 255, 200] as [number, number, number, number],
                lineWidthUnits: 'pixels',
                getLineWidth: 1.5,
                stroked: true,
                pickable: true,
                updateTriggers: { getPosition: [wpts] },
              }),
              new TextLayer<PlannerLabelDatum>({
                id: 'planner-labels',
                data: segmentLabels,
                getText: (d) => d.text,
                getPosition: (d) => [d.lon, d.lat, 0],
                getSize: 13,
                getColor: [255, 240, 180, 230] as [number, number, number, number],
                getBackgroundColor: [0, 0, 0, 160] as [number, number, number, number],
                background: true,
                backgroundPadding: [4, 2, 4, 2] as [number, number, number, number],
                getTextAnchor: 'middle' as const,
                getAlignmentBaseline: 'center' as const,
                fontFamily: 'monospace',
                characterSet: Array.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz °·.,\'-/TN'),
                pickable: false,
                updateTriggers: { getText: [wpts], getPosition: [wpts] },
              }),
            ];
            flushLayers();
          } else if (plannerLayerGroup.length > 0) {
            plannerLayerGroup = [];
            flushLayers();
          }
        }
      }
      scheduleRafTick();
    }

    function scheduleRafTick() {
      // Rulers and route planner require full-rate updates for responsive interaction,
      // regardless of the configured target FPS (which throttles only AIS animation).
      const needsFullRate = rulers.rulers.length > 0 || routePlanner.active;
      const intervalMs = 1000 / settings.targetFps;
      if (intervalMs <= 17 || needsFullRate) {
        rafId = requestAnimationFrame(rafTick);
      } else {
        rafId = setTimeout(rafTick, intervalMs) as unknown as number;
      }
    }

    _scheduleRafTick = scheduleRafTick;
    scheduleRafTick();

    // Native ruler drag — must be capture phase so we intercept before MapLibre.
    mapContainer.addEventListener('pointerdown', handleRulerPointerDown, { capture: true });
    mapContainer.addEventListener('pointermove', handleRulerPointerMove, { capture: true });
    mapContainer.addEventListener('pointerup',   handleRulerPointerUp,   { capture: true });
    mapContainer.addEventListener('pointercancel', handleRulerPointerUp, { capture: true });

    onFsChange = () => { mapView.isFullscreen = !!document.fullscreenElement; };
    document.addEventListener('fullscreenchange', onFsChange);

    map.on('zoom',   () => { mapZoom    = map?.getZoom()    ?? mapZoom; });
    map.on('rotate', () => { mapBearing = map?.getBearing() ?? mapBearing; });
    // Track user interactions so programmatic easeTo calls don't interrupt gestures.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    map.on('movestart', (e: any) => { if (e.originalEvent) _isInteracting = true; });
    map.on('moveend',   () => {
      _isInteracting = false;
    });

    // Cursor feedback for interactive MapLibre layers. The route-full/-leg/-bearing
    // lines moved to deck.gl (see buildCourseLayers()) and don't get hover-cursor
    // feedback here — only the click handler below picks them.
    map.on('mouseenter', 'route-waypoints', () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'route-waypoints', () => { if (map) map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'all-routes-line',      () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'all-routes-line',      () => { if (map) map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'all-waypoints-circle', () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'all-waypoints-circle', () => { if (map) map.getCanvas().style.cursor = ''; });

    // Single unified click handler — hits processed in explicit priority order so
    // exactly one action fires per click regardless of layer overlap.
    map.on('click', (e) => {
      if (!overlay) return;
      const m = map;
      if (!m) return;
      const { x, y } = e.point;

      // 1. Moving-waypoint mode: the next click places the waypoint.
      if (movingWaypoint) {
        const { uuid, name } = movingWaypoint;
        movingWaypoint = null;
        mapContainer.style.cursor = '';
        updateWaypoint(settings.signalkHttpUrl, uuid, name, e.lngLat.lat, e.lngLat.lng, auth.authHeaders)
          .then(() => waypoints.load(settings.signalkHttpUrl))
          .catch((err: unknown) => { console.error('[waypoint] Failed to move:', err); });
        return;
      }

      // 2. Route planner mode: click adds or inserts a waypoint.
      if (routePlanner.active) {
        const handlePick = overlay.pickObject({ x, y, radius: 12, layerIds: ['planner-handles'] });
        if (handlePick?.object) return; // clicked an existing handle — drag handles it
        const segPick = overlay.pickObject({ x, y, radius: 8, layerIds: ['planner-line'] });
        if (segPick?.object) {
          interface PlannerSeg { segIdx: number }
          const { segIdx } = segPick.object as PlannerSeg;
          routePlanner.insertWaypoint(segIdx + 1, e.lngLat.lng, e.lngLat.lat);
        } else {
          routePlanner.addWaypoint(e.lngLat.lng, e.lngLat.lat);
        }
        return;
      }

      // 3. Own vessel (deck.gl — topmost layer).
      const ownPicked = overlay.pickMultipleObjects({ x, y, radius: 5, layerIds: ['own-vessel-icon'] });
      if (ownPicked.length > 0) { showOwnVesselPopup(e.lngLat); return; }

      // 4. AIS vessels (deck.gl). Deduplicate by vessel index — multiple layers can match.
      const aisLayerIds = ['ais-confirmed-icon', 'ais-hull-ghost', 'ais-hull-confirmed', 'ais-ghost-icon', 'ais-mob-icon'];
      const allPicked = overlay.pickMultipleObjects({ x, y, radius: 5, layerIds: aisLayerIds });
      const seen = new SvelteSet<number>();
      const uniqueHits: { idx: number; coordinate: number[] }[] = [];
      for (const p of allPicked) {
        const idx = p.object as number | undefined | null;
        if (idx === undefined || idx === null) continue;
        if (seen.has(idx)) continue;
        seen.add(idx);
        if (p.coordinate) uniqueHits.push({ idx, coordinate: p.coordinate });
      }
      if (uniqueHits.length === 1) {
        const target = ais.getTarget(uniqueHits[0]!.idx);
        if (target?.position) { handleAisClick(uniqueHits[0]!.coordinate as [number, number], target); return; }
      }
      if (uniqueHits.length > 1) { openDisambigPopup(uniqueHits[0]!.coordinate as [number, number], uniqueHits.map(h => h.idx)); return; }

      // 5. Waypoints (MapLibre layer).
      const waypointFeats = m.queryRenderedFeatures(e.point, { layers: ['all-waypoints-circle'] });
      if (waypointFeats.length > 0) { showWaypointPopup(e.lngLat, waypointFeats[0]!); return; }

      // 6. Active route: deck.gl lines (full/leg/bearing) + MapLibre waypoint markers.
      const routeLinePick = overlay.pickObject({ x, y, radius: 6, layerIds: ['route-full', 'route-leg', 'route-bearing'] });
      const routeWptFeats = m.queryRenderedFeatures(e.point, { layers: ['route-waypoints'] });
      if (routeLinePick?.object || routeWptFeats.length > 0) { showActiveRoutePopup(e.lngLat); return; }

      // 7. All routes on map (MapLibre).
      const allRouteFeats = m.queryRenderedFeatures(e.point, { layers: ['all-routes-line'] });
      if (allRouteFeats.length > 0) { showAllRoutesPopup(e.lngLat, allRouteFeats[0]!); return; }
    });

    // Right-click (desktop) → remove planner waypoint, or show navigate popup.
    map.on('contextmenu', (e) => {
      if (overlay && routePlanner.active) {
        if (plannerRightClickIdx !== null) {
          routePlanner.removeWaypoint(plannerRightClickIdx);
          plannerRightClickIdx = null;
        }
        // Always suppress navigate popup while planner is active.
        return;
      }
      plannerRightClickIdx = null;
      showNavigatePopup(e.lngLat);
    });

    // Long-press (touch) → remove planner waypoint, or show navigate popup.
    // MapLibre does not synthesise contextmenu on long-press reliably, so handle it manually.
    {
      let longPressTimer: ReturnType<typeof setTimeout> | null = null;
      let longPressEvent: { lngLat: maplibregl.LngLat; x: number; y: number } | null = null;
      const LONG_PRESS_MS = 500;
      const MOVE_THRESHOLD_PX = 10;
      let startX = 0;
      let startY = 0;

      const cancelLongPress = () => {
        if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
        longPressEvent = null;
      };

      map.on('touchstart', (e) => {
        if (e.originalEvent.touches.length !== 1) { cancelLongPress(); return; }
        const touch = e.originalEvent.touches[0]!;
        startX = touch.clientX;
        startY = touch.clientY;
        const rect = mapContainer.getBoundingClientRect();
        longPressEvent = { lngLat: e.lngLat, x: touch.clientX - rect.left, y: touch.clientY - rect.top };
        longPressTimer = setTimeout(() => {
          if (!longPressEvent) return;
          const { lngLat, x, y } = longPressEvent;
          if (overlay && routePlanner.active) {
            const pick = overlay.pickObject({ x, y, radius: 20, layerIds: ['planner-handles'] });
            if (pick?.object !== null && pick?.object !== undefined) {
              interface PlannerHandle { idx: number }
              routePlanner.removeWaypoint((pick.object as PlannerHandle).idx);
            }
            // Long-press on empty space while drawing → do nothing (no undo).
            longPressTimer = null;
            return;
          }
          showNavigatePopup(lngLat);
          longPressTimer = null;
        }, LONG_PRESS_MS);
      });

      map.on('touchmove', (e) => {
        if (!longPressTimer) return;
        const touch = e.originalEvent.touches[0]!;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD_PX) cancelLongPress();
      });

      map.on('touchend', cancelLongPress);
      map.on('touchcancel', cancelLongPress);
    }

    // style.load fires on initial style ready AND after MapLibre's internal setStyle
    // (which it calls automatically on WebGL context restore), so this covers both cases.
    map.on('style.load', () => {
      const m = map;
      if (!m) return;
      const ap = settings.appearance;

      if (!m.getSource(AIS_SOURCE))    m.addSource(AIS_SOURCE,    { type: 'geojson', data: EMPTY_FC }); // for ais-label only
      if (!m.getSource(ROUTE_WPT_SRC))  m.addSource(ROUTE_WPT_SRC,  { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(ALL_ROUTES_SRC))   m.addSource(ALL_ROUTES_SRC,   { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(ALL_WAYPOINTS_SRC)) m.addSource(ALL_WAYPOINTS_SRC, { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(TRACK_SOURCE))          m.addSource(TRACK_SOURCE,          { type: 'geojson', data: EMPTY_FC, lineMetrics: true });
      if (!m.getSource(TRACK_OVERFLOW_SOURCE)) m.addSource(TRACK_OVERFLOW_SOURCE, { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(AIS_TRACK_SOURCE))          m.addSource(AIS_TRACK_SOURCE,          { type: 'geojson', data: EMPTY_FC, lineMetrics: true });
      if (!m.getSource(AIS_TRACK_OVERFLOW_SOURCE)) m.addSource(AIS_TRACK_OVERFLOW_SOURCE, { type: 'geojson', data: EMPTY_FC });

      // AIS vessel icon, hull, and COG line are rendered by deck.gl (see $effect below).
      // Only the text label stays in MapLibre for quality text rendering + collision detection.
      // text-font must be explicit: without it MapLibre requests "Open Sans Regular" (its built-in
      // default) from whatever glyph server is active (e.g. Skippo's server, which only has Roboto).
      if (!m.getLayer('ais-label')) m.addLayer({ id: 'ais-label', type: 'symbol', source: AIS_SOURCE,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Roboto Regular'],
          'text-size': 10,
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
          'text-optional': true,
        },
        paint: { 'text-color': settings.appearance.ais.vesselColor, 'text-halo-color': '#000', 'text-halo-width': 1 },
      });

      // Own vessel icon and heading/COG/GC predictor lines are rendered by deck.gl
      // (see buildOwnVesselLayers()) — MapLibre layers can't render above the deck.gl
      // overlay's own canvas, so they could never sit on top of an AIS target.

      // Track layer — below all vessel/route layers, above chart tiles.
      // AIS track is below the own-vessel track so own vessel always reads clearly on top.
      if (!m.getLayer('ais-track-overflow-line')) m.addLayer({
        id: 'ais-track-overflow-line', type: 'line', source: AIS_TRACK_OVERFLOW_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color':   ap.ais.track.color,
          'line-width':   ap.ais.track.width,
          'line-opacity': ap.ais.track.show ? 1 : 0,
        },
      });
      if (!m.getLayer('ais-track-line')) m.addLayer({
        id: 'ais-track-line', type: 'line', source: AIS_TRACK_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-gradient': buildTrackGradient(ap.ais.track.color, 0) as never,
          'line-width':    ap.ais.track.width,
          'line-opacity':  ap.ais.track.show ? 1 : 0,
        },
      });
      // Overflow track: older segments that fall outside MapLibre's ±540° rendering window,
      // shifted by 720° multiples back into view. Rendered below the main track (no gradient).
      if (!m.getLayer('vessel-track-overflow-line')) m.addLayer({
        id: 'vessel-track-overflow-line', type: 'line', source: TRACK_OVERFLOW_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color':   ap.track.color,
          'line-width':   ap.track.width,
          'line-opacity': 1,
        },
      });
      // Uses line-gradient (requires lineMetrics: true on source) for solid style fade.
      // line-gradient and line-dasharray are mutually exclusive in MapLibre, so non-solid
      // styles fall back to plain line-color (no fade, but dashes render correctly).
      if (!m.getLayer('vessel-track-line')) m.addLayer({
        id: 'vessel-track-line', type: 'line', source: TRACK_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-gradient': buildTrackGradient(ap.track.color, 0) as never,
          'line-width':    ap.track.width,
          'line-opacity':  1,
        },
      });

      // Route layers — appended above the track layers (added just above) and below
      // anything added after them in this same handler.
      if (!m.getLayer('all-routes-line')) m.addLayer({
        id: 'all-routes-line', type: 'line', source: ALL_ROUTES_SRC,
        paint: { 'line-color': '#7cc8e8', 'line-width': 1.5, 'line-opacity': 0.45 },
      });

      // Full route polyline, active leg, and bearing line are deck.gl PathLayers
      // (see buildCourseLayers()) — not MapLibre — so they render above AIS targets
      // and the own-vessel icon instead of underneath the deck.gl overlay's canvas.

      // Waypoint markers: above route lines, below deck.gl layers (own vessel + AIS).
      if (!m.getLayer('route-waypoints')) m.addLayer({
        id: 'route-waypoints', type: 'circle', source: ROUTE_WPT_SRC,
        paint: {
          'circle-radius':       ['match', ['get', 'wtype'], 'next', 7, 5],
          'circle-color':        ['match', ['get', 'wtype'], 'next', '#e040fb', '#9c27b0'],
          'circle-opacity':      0.9,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
      });

      // Server waypoints: small circles + labels.
      if (!m.getLayer('all-waypoints-circle')) m.addLayer({
        id: 'all-waypoints-circle', type: 'circle', source: ALL_WAYPOINTS_SRC,
        paint: {
          'circle-radius':       6,
          'circle-color':        '#f59e0b',
          'circle-opacity':      0.9,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
      });
      if (!m.getLayer('all-waypoints-label')) m.addLayer({
        id: 'all-waypoints-label', type: 'symbol', source: ALL_WAYPOINTS_SRC,
        layout: {
          'text-field':       ['get', 'name'],
          'text-font':        ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size':        11,
          'text-offset':      [0, 1.2],
          'text-anchor':      'top',
          'text-optional':    true,
        },
        paint: {
          'text-color':        '#f59e0b',
          'text-halo-color':   '#000',
          'text-halo-width':   1.2,
        },
      });

      mapZoom    = m.getZoom();
      mapBearing = m.getBearing();
      // Re-apply the stored projection on every style (re)load.
      // DEFAULT_STYLE hardcodes 'mercator'; setStyle() on chart-source switches
      // also resets it. Without this, new layers render in Mercator while MapLibre
      // still calculates globe coordinates, causing visible geometry mismatches.
      // setProjection() also re-injects the cached globe correction if applicable.
      setProjection(mapView.projection);

      mapLoaded  = true;
    }); // end style.load

    // On WebGL context loss, mark map as not ready. MapLibre internally calls setStyle()
    // on context restore, which re-fires style.load — that re-adds our sources/layers
    // and sets mapLoaded = true again, triggering all effects to re-run.
    map.on('webglcontextlost', () => {
      console.warn('[map] WebGL context lost');
      mapLoaded = false;
      chartSourceUrls.clear();
      activeStyleUrl = null;
    });

    map.on('webglcontextrestored', () => {
      console.info('[map] WebGL context restored');
    });

    map.on('error', (e) => {
      console.error('[map] error', e.error ?? e);
    });

    // Some nautical chart styles reference sprite images that aren't present in
    // the sprite sheet (e.g. depth-specific wreck variants at high zoom levels).
    // Without this handler MapLibre logs an error for every missing image on
    // every frame and refuses to render the symbol layer entirely.
    // Adding a 1×1 transparent placeholder silences the error and lets all other
    // symbols in the same layer render normally.
    map.on('styleimagemissing', (e: { id: string }) => {
      if (map?.hasImage(e.id)) return; // already added (re-entrant guard)
      map?.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
  });

  onDestroy(() => {
    cancelAnimationFrame(rafId);
    clearTimeout(rafId);
    overlay?.finalize();
    document.removeEventListener('fullscreenchange', onFsChange);
    mapContainer.removeEventListener('pointerdown',   handleRulerPointerDown, { capture: true });
    mapContainer.removeEventListener('pointermove',   handleRulerPointerMove, { capture: true });
    mapContainer.removeEventListener('pointerup',     handleRulerPointerUp,   { capture: true });
    mapContainer.removeEventListener('pointercancel', handleRulerPointerUp,   { capture: true });
    map?.remove();
  });

  function buildAisPopupHtml(t: AisTarget): string {
    const row = (label: string, value: string | number | null, unit = '') =>
      value !== null ? `<tr><td>${label}</td><td><b>${String(value)}${unit}</b></td></tr>` : '';

    const rotDpm = t.rot !== undefined ? (t.rot * 180 / Math.PI) * 60 : null;
    const rotStr = rotDpm !== null
      ? `${rotDpm > 0 ? '▶ ' : rotDpm < 0 ? '◀ ' : ''}${Math.abs(rotDpm).toFixed(1)}°/min`
      : null;

    const lookupLinks = t.mmsi
      ? `<div class="ais-links">
          <a href="https://www.vesselfinder.com/vessels/details/${t.mmsi}" target="_blank" rel="noopener">VesselFinder</a>
          <a href="https://www.myshiptracking.com/?mmsi=${t.mmsi}" target="_blank" rel="noopener">MyShipTracking</a>
        </div>`
      : '';

    const lon = t.position.longitude;
    const lat = t.position.latitude;

    const posMs = t.lastPositionUpdateMs;
    const lastSeenDate = new Date(posMs);
    const lastSeenTime = lastSeenDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const ageStr = formatAge(posMs);

    const identRows = [
      row('MMSI',         t.mmsi       ?? null),
      row('Callsign VHF', t.callsign   ?? null),
      row('Callsign HF',  t.callsignHf ?? null),
      row('Skipper',      t.skipperName ?? null),
      row('Type',         t.shipType   ?? null),
      row('Status',       t.navState   ?? null),
      row('Flag',         t.flag       ?? null),
      row('Port',         t.port       ?? null),
      row('Position', `${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E`),
      `<tr><td>Updated</td><td><b>${lastSeenTime} <span id="ais-age" data-posms="${String(posMs)}" style="opacity:0.6;font-size:0.85em">(${ageStr})</span></b></td></tr>`,
    ].join('');

    const navRows = [
      row('SOG',     t.sog     !== undefined ? (t.sog     * 1.94384).toFixed(1) : null, ' kn'),
      row('COG',     t.cog     !== undefined ? (t.cog     * 180 / Math.PI).toFixed(1) : null, '°'),
      row('Heading', t.heading !== undefined ? (t.heading * 180 / Math.PI).toFixed(1) : null, '°'),
      row('ROT',     rotStr),
    ].join('');

    const dimRows = [
      row('Length',     t.lengthM    ?? null, ' m'),
      row('Beam',       t.beamM      ?? null, ' m'),
      row('Draft',      t.draftM     ?? null, ' m'),
      row('Air height', t.airHeightM ?? null, ' m'),
    ].join('');

    return `
      <div class="ais-popup">
        <div class="ais-popup-title">${t.name ?? t.mmsi ?? 'Unknown vessel'}</div>
        <table>
          ${identRows}
          ${navRows ? `<tr><td colspan="2" class="ais-section">Navigation</td></tr>${navRows}` : ''}
          ${dimRows ? `<tr><td colspan="2" class="ais-section">Dimensions</td></tr>${dimRows}` : ''}
        </table>
        ${lookupLinks}
        <div class="ais-links" style="margin-top:6px">
          <button class="popup-settings-btn add-waypoint-here-btn"
            data-lat="${String(t.position.latitude)}" data-lon="${String(t.position.longitude)}">Add waypoint here</button>
          <button class="popup-settings-btn" data-settings="ais">AIS settings</button>
        </div>
      </div>`;
  }

  let aisAgeTimer: ReturnType<typeof setInterval> | null = null;

  function formatAge(posMs: number): string {
    const ageSec = Math.round((Date.now() - posMs) / 1000);
    return ageSec < 60
      ? `${String(ageSec)}s ago`
      : ageSec < 3600
        ? `${String(Math.floor(ageSec / 60))}m ${String(ageSec % 60)}s ago`
        : `${String(Math.floor(ageSec / 3600))}h ${String(Math.floor((ageSec % 3600) / 60))}m ago`;
  }

  function handleAisClick(coordinate: [number, number], t: AisTarget): boolean {
    if (!map) return false;

    if (aisAgeTimer !== null) {
      clearInterval(aisAgeTimer);
      aisAgeTimer = null;
    }

    const popup = openPopup(new maplibregl.Popup({ closeButton: true, maxWidth: 'none' })
      .setLngLat(coordinate)
      .setHTML(buildAisPopupHtml(t))
      ).addTo(map);

    const timerId = setInterval(() => {
      const el = document.getElementById('ais-age');
      if (!el) { clearInterval(timerId); aisAgeTimer = null; return; }
      const posMs = Number(el.dataset['posms']);
      el.textContent = `(${formatAge(posMs)})`;
    }, 1000);
    aisAgeTimer = timerId;

    // Fetch and display this vessel's position history.
    aisTrackRaw = [];
    const gen = ++_aisTrackGen;
    const historyHours = settings.appearance.ais.track.historyHours;
    const serverBase = settings.signalkHttpUrl;
    fetchAisVesselTrack(serverBase, t.id, historyHours).then(coords => {
      if (gen === _aisTrackGen) aisTrackRaw = coords;
    }).catch(() => { /* server may not have history for this vessel — silently skip */ });

    popup.on('close', () => {
      if (aisAgeTimer !== null) { clearInterval(aisAgeTimer); aisAgeTimer = null; }
      // Cancel any in-flight fetch and clear the track display.
      _aisTrackGen++;
      aisTrackRaw = [];
    });

    popup.getElement().addEventListener('click', (ev) => {
      const el = ev.target as HTMLElement;
      const settingsBtn = el.closest<HTMLElement>('[data-settings]');
      if (settingsBtn) { popup.remove(); openSettings((settingsBtn.dataset['settings'] ?? 'connection') as SettingsTab); return; }
      const wpBtn = el.closest<HTMLButtonElement>('.add-waypoint-here-btn');
      if (wpBtn && !wpBtn.disabled) {
        popup.remove();
        promptAndSaveWaypoint(Number(wpBtn.dataset['lat']), Number(wpBtn.dataset['lon']));
      }
    });

    return true;
  }

  function openDisambigPopup(coordinate: [number, number], indices: number[]) {
    const targets = indices.map(i => ({ idx: i, target: ais.getTarget(i) }))
      .filter((e): e is { idx: number; target: AisTarget } => e.target?.position != null);

    if (targets.length === 0) return;
    if (targets.length === 1) {
      handleAisClick(coordinate, targets[0]!.target);
      return;
    }

    const items = targets.map(({ idx, target: t }) =>
      `<li class="ais-disambig-item" data-idx="${String(idx)}">${t.name ?? t.mmsi ?? 'Unknown vessel'}</li>`
    ).join('');

    const html = `
      <div class="ais-disambig">
        <div class="ais-popup-title">Multiple vessels</div>
        <ul class="ais-disambig-list">${items}</ul>
      </div>`;

    if (!map) return;
    const popup = openPopup(new maplibregl.Popup({ closeButton: true, maxWidth: 'none' })
      .setLngLat(coordinate)
      .setHTML(html)
      ).addTo(map);

    // Attach click handler after the popup is in the DOM.
    const el = popup.getElement();
    el.addEventListener('click', (ev) => {
      const li = (ev.target as HTMLElement).closest<HTMLElement>('[data-idx]');
      if (!li) return;
      const idx = Number(li.dataset['idx']);
      const t = ais.getTarget(idx);
      if (!t?.position) return;
      popup.remove();
      handleAisClick(coordinate, t);
    });
  }

  /** Format a lat/lon pair as degrees and decimal minutes (marine standard). */
  function formatDm(lat: number, lon: number): string {
    const dm = (deg: number, isLat: boolean): string => {
      const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
      const abs = Math.abs(deg);
      const d = Math.floor(abs);
      const m = (abs - d) * 60;
      return `${String(d)}°\u202f${m.toFixed(3)}'\u202f${dir}`;
    };
    return `${dm(lat, true)}&emsp;${dm(lon, false)}`;
  }

  /** Prompt for a name and save a waypoint at the given position. */
  function promptAndSaveWaypoint(lat: number, lon: number): void {
    const name = prompt('Waypoint name:', formatDm(lat, lon));
    if (name === null) return; // cancelled
    saveWaypoint(settings.signalkHttpUrl, name.trim() || formatDm(lat, lon), lat, lon, auth.authHeaders)
      .then(() => waypoints.load(settings.signalkHttpUrl))
      .catch((err: unknown) => { console.error('[waypoint] Failed to save:', err); });
  }

  /** Show a "Navigate here" popup at an empty-water click location. */
  function showNavigatePopup(lngLat: maplibregl.LngLat): void {
    if (!map) return;
    const { lat, lng: lon } = lngLat;
    const serverBase = settings.signalkHttpUrl;
    const canNavigate = auth.isLoggedIn;
    const canWaypoint = auth.isLoggedIn;

    const popup = openPopup(new maplibregl.Popup({ closeButton: true, maxWidth: 'none' })
      .setLngLat(lngLat)
      .setHTML(`
        <div class="ais-popup navigate-popup">
          <div class="ais-popup-coords">${formatDm(lat, lon)}</div>
          <button class="popup-settings-btn navigate-here-btn"
            ${canNavigate ? '' : 'disabled title="Login required to set course"'}>
            Navigate here
          </button>
          <button class="popup-settings-btn add-waypoint-here-btn"
            ${canWaypoint ? `data-lat="${String(lat)}" data-lon="${String(lon)}"` : 'disabled title="Login required"'}>
            Add waypoint here
          </button>
        </div>
      `)
      ).addTo(map);

    popup.getElement().addEventListener('click', (ev) => {
      const el = ev.target as HTMLElement;
      const navBtn = el.closest<HTMLButtonElement>('.navigate-here-btn');
      if (navBtn && !navBtn.disabled) {
        popup.remove();
        navigateToPoint(serverBase, lat, lon, auth.authHeaders).catch((err: unknown) => {
          console.error('[navigate] Failed to set course:', err);
        });
        return;
      }
      const wpBtn = el.closest<HTMLButtonElement>('.add-waypoint-here-btn');
      if (wpBtn && !wpBtn.disabled) {
        popup.remove();
        promptAndSaveWaypoint(lat, lon);
      }
    });
  }

  function showOwnVesselPopup(lngLat: maplibregl.LngLat): void {
    if (!map) return;
    const ownPos = get(vesselState).position;
    const canWaypoint = auth.isLoggedIn && ownPos != null;
    const popup = openPopup(new maplibregl.Popup({ closeButton: false, offset: 14, className: 'vessel-self-popup' })
      .setLngLat(lngLat)
      .setHTML(`
        <button class="vessel-self-settings-btn">Own vessel settings</button>
        <button class="popup-settings-btn add-waypoint-here-btn"
          ${canWaypoint ? `data-lat="${String(ownPos.latitude)}" data-lon="${String(ownPos.longitude)}"` : 'disabled title="Login required"'}>Add waypoint here</button>
      `)
      ).addTo(map);
    popup.getElement().addEventListener('click', (ev) => {
      const settingsBtn = (ev.target as HTMLElement).closest('.vessel-self-settings-btn');
      if (settingsBtn) { popup.remove(); openSettings('vessel'); return; }
      const wpBtn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.add-waypoint-here-btn');
      if (wpBtn && !wpBtn.disabled) {
        popup.remove();
        promptAndSaveWaypoint(Number(wpBtn.dataset['lat']), Number(wpBtn.dataset['lon']));
      }
    });
  }

  function showActiveRoutePopup(lngLat: maplibregl.LngLat): void {
    if (!map) return;
    const name = route.routeName;
    const canStop = auth.isLoggedIn;
    const popup = openPopup(new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: 'none' })
      .setLngLat(lngLat)
      .setHTML(`
        <div class="ais-popup">
          ${name ? `<div class="ais-popup-title">${name}</div>` : ''}
          <div class="ais-links" style="margin-top:0">
            <button class="popup-settings-btn stop-nav-btn"
              ${canStop ? '' : 'disabled title="Login required"'}>Stop navigation</button>
            <button class="popup-settings-btn" data-settings="routes">Route settings</button>
          </div>
        </div>`)
      ).addTo(map);
    popup.getElement().addEventListener('click', (ev) => {
      const el = ev.target as HTMLElement;
      const settingsBtn = el.closest<HTMLElement>('[data-settings]');
      if (settingsBtn) { popup.remove(); openSettings((settingsBtn.dataset['settings'] ?? 'connection') as SettingsTab); return; }
      const stopBtn = el.closest<HTMLButtonElement>('.stop-nav-btn');
      if (stopBtn && !stopBtn.disabled) {
        popup.remove();
        clearCourse(settings.signalkHttpUrl, auth.authHeaders).catch((err: unknown) => {
          console.error('[navigate] Failed to clear course:', err);
        });
      }
    });
  }

  function showAllRoutesPopup(lngLat: maplibregl.LngLat, f: maplibregl.MapGeoJSONFeature): void {
    if (!map) return;
    const name = (f.properties['name'] as string | null | undefined) ?? '';
    const uuid = (f.properties['uuid'] as string | null | undefined) ?? '';
    const canAct = auth.isLoggedIn && uuid !== '';
    const popup = openPopup(new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: 'none' })
      .setLngLat(lngLat)
      .setHTML(`
        <div class="ais-popup">
          ${name ? `<div class="ais-popup-title">${name}</div>` : ''}
          <div class="ais-links" style="margin-top:0">
            <button class="popup-settings-btn activate-route-btn"
              ${canAct ? `data-uuid="${uuid}"` : 'disabled title="Login required to activate route"'}>Activate route</button>
            <button class="popup-settings-btn edit-route-btn"
              ${canAct ? `data-uuid="${uuid}"` : 'disabled title="Login required to edit route"'}>Edit route</button>
            <button class="popup-settings-btn delete-route-btn"
              ${canAct ? `data-uuid="${uuid}" data-name="${name}"` : 'disabled title="Login required to delete route"'}>Delete route</button>
            <button class="popup-settings-btn" data-settings="routes">Route style</button>
          </div>
        </div>`)
      ).addTo(map);
    popup.getElement().addEventListener('click', (ev) => {
      const el = ev.target as HTMLElement;
      const settingsBtn = el.closest<HTMLElement>('[data-settings]');
      if (settingsBtn) { popup.remove(); openSettings((settingsBtn.dataset['settings'] ?? 'connection') as SettingsTab); return; }
      const activateBtn = el.closest<HTMLButtonElement>('.activate-route-btn');
      if (activateBtn && !activateBtn.disabled && activateBtn.dataset['uuid']) {
        popup.remove();
        activateRoute(settings.signalkHttpUrl, activateBtn.dataset['uuid'], auth.authHeaders)
          .catch((err: unknown) => { console.error('[route] Failed to activate route:', err); });
        return;
      }
      const editBtn = el.closest<HTMLButtonElement>('.edit-route-btn');
      if (editBtn && !editBtn.disabled && editBtn.dataset['uuid']) {
        popup.remove();
        const r = routes.entries.find(r => r.uuid === editBtn.dataset['uuid']);
        if (r) {
          const coords = r.geometry.geometry.coordinates as [number, number][];
          routePlanner.loadRoute(r.uuid, r.name, coords.map(([lon, lat]) => ({ lon, lat })));
        }
        return;
      }
      const deleteBtn = el.closest<HTMLButtonElement>('.delete-route-btn');
      if (deleteBtn && !deleteBtn.disabled && deleteBtn.dataset['uuid']) {
        const routeUuid = deleteBtn.dataset['uuid'];
        const routeName = deleteBtn.dataset['name'] ?? 'this route';
        if (!confirm(`Delete "${routeName}"? This cannot be undone.`)) return;
        popup.remove();
        deleteRoute(settings.signalkHttpUrl, routeUuid, auth.authHeaders)
          .then(() => routes.load(settings.signalkHttpUrl))
          .catch((err: unknown) => { console.error('[route] Failed to delete route:', err); });
      }
    });
  }

  function showWaypointPopup(lngLat: maplibregl.LngLat, f: maplibregl.MapGeoJSONFeature): void {
    if (!map) return;
    const uuid = (f.properties['uuid'] as string | null | undefined) ?? '';
    const name = (f.properties['name'] as string | null | undefined) ?? '';
    const coords = (f.geometry as GeoJSON.Point).coordinates;
    const lon = coords[0] as number;
    const lat = coords[1] as number;
    const canAct = auth.isLoggedIn && uuid !== '';
    const popup = openPopup(new maplibregl.Popup({ closeButton: true, maxWidth: 'none' })
      .setLngLat([lon, lat])
      .setHTML(`
        <div class="ais-popup">
          <div class="ais-popup-title">${name || 'Waypoint'}</div>
          <div class="ais-popup-coords">${formatDm(lat, lon)}</div>
          <div class="ais-links" style="margin-top:4px">
            <button class="popup-settings-btn navigate-here-btn"
              ${auth.isLoggedIn ? '' : 'disabled title="Login required"'}>Navigate here</button>
            <button class="popup-settings-btn rename-waypoint-btn"
              ${canAct ? `data-uuid="${uuid}" data-name="${name}" data-lat="${String(lat)}" data-lon="${String(lon)}"` : 'disabled title="Login required"'}>Rename</button>
            <button class="popup-settings-btn move-waypoint-btn"
              ${canAct ? `data-uuid="${uuid}" data-name="${name}"` : 'disabled title="Login required"'}>Move</button>
            <button class="popup-settings-btn delete-waypoint-btn"
              ${canAct ? `data-uuid="${uuid}" data-name="${name}"` : 'disabled title="Login required"'}>Delete</button>
          </div>
        </div>`)
      ).addTo(map);
    popup.getElement().addEventListener('click', (ev) => {
      const el = ev.target as HTMLElement;
      const navBtn = el.closest<HTMLButtonElement>('.navigate-here-btn');
      if (navBtn && !navBtn.disabled) {
        popup.remove();
        navigateToPoint(settings.signalkHttpUrl, lat, lon, auth.authHeaders)
          .catch((err: unknown) => { console.error('[waypoint] Failed to set course:', err); });
        return;
      }
      const renameBtn = el.closest<HTMLButtonElement>('.rename-waypoint-btn');
      if (renameBtn && !renameBtn.disabled) {
        const newName = prompt('Rename waypoint:', renameBtn.dataset['name'] ?? '');
        if (newName === null) return;
        popup.remove();
        updateWaypoint(
          settings.signalkHttpUrl, uuid, newName.trim() || name,
          Number(renameBtn.dataset['lat']), Number(renameBtn.dataset['lon']), auth.authHeaders,
        ).then(() => waypoints.load(settings.signalkHttpUrl))
          .catch((err: unknown) => { console.error('[waypoint] Failed to rename:', err); });
        return;
      }
      const moveBtn = el.closest<HTMLButtonElement>('.move-waypoint-btn');
      if (moveBtn && !moveBtn.disabled) {
        popup.remove();
        movingWaypoint = { uuid: moveBtn.dataset['uuid'] ?? '', name: moveBtn.dataset['name'] ?? '' };
        mapContainer.style.cursor = 'crosshair';
        return;
      }
      const delBtn = el.closest<HTMLButtonElement>('.delete-waypoint-btn');
      if (delBtn && !delBtn.disabled) {
        if (!confirm(`Delete waypoint "${delBtn.dataset['name'] ?? 'this waypoint'}"?`)) return;
        popup.remove();
        deleteWaypoint(settings.signalkHttpUrl, uuid, auth.authHeaders)
          .then(() => waypoints.load(settings.signalkHttpUrl))
          .catch((err: unknown) => { console.error('[waypoint] Failed to delete:', err); });
      }
    });
  }


  $effect(() => {
    if (!map || !mapLoaded) return;
    const m   = map;
    const sel = charts.selected;
    const avail = charts.available;

    // Find the first selected chart that provides a full MapLibre style.
    const styleChart = Object.values(avail).find(c => sel.has(c.identifier) && !!c.style);
    const newStyleUrl = styleChart ? charts.styleUrl(styleChart) : null;

    // If the base style needs to change, call setStyle() and wait for style.load to retrigger us.
    if (newStyleUrl !== activeStyleUrl) {
      mapLoaded = false;
      chartSourceUrls.clear();
      activeStyleUrl = newStyleUrl;
      if (newStyleUrl) {
        const chartUrl = styleChart ? (charts.tileUrl(styleChart) || null) : null;
        fetchAndResolveStyle(newStyleUrl)
          .then(resolved => {
            // If chart.url is available, inject it as a source for any layer
            // whose source is not already defined in the style. This means:
            //   - style has sources.enc → use it (tile URL from style.json)
            //   - style lacks sources.enc but chart.url is set → inject from SK
            //   - both set → both exist (style wins for enc, SK url fills gaps)
            if (chartUrl) {
              const spec = resolved as maplibregl.StyleSpecification;
              const sources = spec.sources;
              const definedSources = new Set(Object.keys(sources));
              const referencedSources = new Set(
                spec.layers
                  .map((l: maplibregl.LayerSpecification) => ('source' in l ? l.source : undefined))
                  .filter((s): s is string => typeof s === 'string')
              );
              for (const src of referencedSources) {
                if (!definedSources.has(src)) {
                  sources[src] = {
                    type: 'vector',
                    tiles: [chartUrl],
                    minzoom: styleChart?.minzoom ?? 0,
                    maxzoom: styleChart?.maxzoom ?? 22,
                  };
                }
              }
              spec.sources = sources;
            }
            m.setStyle(resolved as maplibregl.StyleSpecification, { diff: false });
          })
          .catch((e: unknown) => {
            console.error('[map] Failed to load style', newStyleUrl, e);
            // setStyle() was never called, so the map's previous style is still intact.
            // Reset both flags so the effect can retry on next trigger (e.g. chart still
            // selected → effect re-runs because mapLoaded flipped back to true).
            activeStyleUrl = null;
            mapLoaded = true;
          });
      } else {
        m.setStyle(DEFAULT_STYLE, { diff: false });
      }
      return;
    }

    // Remove deselected tile-based chart layers.
    // Style-based charts never create a chart-* source/layer, so this is safe for them too.
    for (const id of Object.keys(avail)) {
      if (sel.has(id) && !avail[id]!.style) continue;
      const layerId  = `chart-layer-${id}`;
      const sourceId = `chart-${id}`;
      if (m.getLayer(layerId))   m.removeLayer(layerId);
      if (m.getSource(sourceId)) m.removeSource(sourceId);
      chartSourceUrls.delete(id);
    }

    // Add newly selected tile-based chart layers (style-based charts are handled by setStyle).
    for (const [id, chart] of Object.entries(avail)) {
      if (!sel.has(id) || chart.style) continue;
      const tileUrl  = charts.tileUrl(chart);
      if (!tileUrl) continue;
      const sourceId = `chart-${id}`;
      const layerId  = `chart-layer-${id}`;

      // If the tile URL changed (e.g. WMTS layer switch), tear down and rebuild
      if (chartSourceUrls.get(id) !== tileUrl) {
        if (m.getLayer(layerId))   m.removeLayer(layerId);
        if (m.getSource(sourceId)) m.removeSource(sourceId);
        chartSourceUrls.set(id, tileUrl);
      }

      if (!m.getSource(sourceId)) {
        // {-y} is a TMS-convention y-flip marker. MapLibre doesn't understand it
        // literally — replace with {y} and use scheme:'tms' so MapLibre flips it.
        const isTms = tileUrl.includes('{-y}');
        const resolvedUrl = isTms ? tileUrl.replace('{-y}', '{y}') : tileUrl;

        if (chart.format === 'pbf') {
          m.addSource(sourceId, { type: 'vector', tiles: [resolvedUrl] });
        } else {
          m.addSource(sourceId, {
            type: 'raster',
            tiles: [resolvedUrl],
            tileSize: 256,
            scheme: isTms ? 'tms' : 'xyz',
            minzoom: chart.minzoom ?? 0,
            maxzoom: chart.maxzoom ?? 22,
          });
        }
      }
      if (!m.getLayer(layerId)) {
        // Anchor below 'ais-track-overflow-line': chart layers are added by this effect
        // long after the initial style.load (e.g. on first chart selection, or any later
        // switch), well after route/track layers already exist. addLayer(layer, beforeId)
        // always inserts directly below beforeId, so anchoring on a layer added earlier in
        // style.load (e.g. the own-vessel predictor lines, which are deck.gl now anyway)
        // would stack new chart tiles above tracks/routes. 'ais-track-overflow-line' is the
        // documented bottom of the MapLibre track/route stack (see style.load above), so
        // chart layers added here always render below tracks, routes, and waypoint markers.
        if (chart.format === 'pbf') {
          const sourceLayer = chart.layers?.[0] ?? id;
          m.addLayer({ id: layerId, type: 'fill', source: sourceId, 'source-layer': sourceLayer }, 'ais-track-overflow-line');
        } else {
          m.addLayer({ id: layerId, type: 'raster', source: sourceId }, 'ais-track-overflow-line');
        }
      }
    }
  });

  // Toggle base layer visibility when store changes.
  // Guard with getLayer() — a style-based chart may not contain our default layer IDs.
  $effect(() => {
    if (!map || !mapLoaded) return;
    const enabled = baseLayers.enabled;
    for (const layer of BASE_LAYERS) {
      if (!map.getLayer(layer.id)) continue;
      map.setLayoutProperty(layer.id, 'visibility', enabled.has(layer.id) ? 'visible' : 'none');
    }
  });
  // MapLibre layer visibility — toggled independently of deck.gl layers.
  $effect(() => {
    if (!map || !mapLoaded) return;
    const v = (id: string, show: boolean) => {
      if (map!.getLayer(id)) map!.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    };
    v('ais-label',               visibility.aisVessels);
    // AIS tracks: visible when vessels are on AND (all-tracks toggle OR a popup track is active).
    // Using layout.visibility (not opacity) so MapLibre skips draw calls entirely when hidden.
    const showAisTracks = visibility.aisVessels && (visibility.aisTracks || aisTrackRaw.length >= 2);
    v('ais-track-line',          showAisTracks);
    v('ais-track-overflow-line', showAisTracks);
    v('vessel-track-line',       visibility.ownTrack);
    v('vessel-track-overflow-line', visibility.ownTrack);
    v('all-routes-line',         visibility.routes);
    v('all-waypoints-circle',    visibility.waypoints);
    v('all-waypoints-label',     visibility.waypoints);
  });

  // Re-flush deck.gl layers when AIS visibility changes.
  $effect(() => {
    const _vis  = visibility.aisVessels;
    const _pred = visibility.aisPredictors;
    flushLayers();
  });



  // Update ais-label text color when AIS appearance settings change.
  // Hull, icon, and COG rendering are handled by the deck.gl effect below.
  $effect(() => {
    if (!map || !mapLoaded) return;
    map.setPaintProperty('ais-label', 'text-color', settings.appearance.ais.vesselColor);
  });

  // Update MapLibre ais-label source with vessel name positions (label layer only).
  // Throttled to 1 Hz: AIS label positions don't need sub-second precision, and
  // rebuilding the full FeatureCollection on every individual vessel update is wasteful.
  $effect(() => {
    if (!map || !mapLoaded) return;
    const aisSrc = map.getSource(AIS_SOURCE);
    if (!(aisSrc instanceof maplibregl.GeoJSONSource)) return;

    const hotData = ais.hotData;
    const ids     = ais.ids;
    const coldMap = ais.coldMap;
    void ais.coldVersion; // register reactive dependency on cold data changes

    const S = AIS_HOT_STRIDE;
    const features: GeoJSON.Feature[] = [];
    if (hotData && ids.length > 0) {
      for (let i = 0; i < ids.length; i++) {
        features.push({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [hotData[i * S + AIS_F_LON]!, hotData[i * S + AIS_F_LAT]!],
          },
          properties: { label: coldMap.get(ids[i]!)?.name ?? '' },
        });
      }
    }

    const flush = () => {
      _aisLastUpdateMs = Date.now();
      aisSrc.setData({ type: 'FeatureCollection', features });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      if ((window as any).__mapDiag) (window as any).__mapDiag.aisLabels++;
    };
    _pendingAisSetData = flush;

    const remaining = 1000 - (Date.now() - _aisLastUpdateMs);
    if (remaining <= 0) {
      if (_aisThrottleId !== null) { clearTimeout(_aisThrottleId); _aisThrottleId = null; }
      flush();
      _pendingAisSetData = null;
    } else {
      _aisThrottleId ??= setTimeout(() => {
        _aisThrottleId = null;
        _pendingAisSetData?.();
        _pendingAisSetData = null;
      }, remaining);
    }
  });

  // Rebuild deck.gl AIS layers on AIS tick or appearance settings change.
  // Zoom is read from the live viewport in draw() — no rebuild needed on zoom changes.
  $effect(() => {
    const hotData  = ais.hotData;
    const ids      = ais.ids;
    const coldMap  = ais.coldMap;
    void ais.coldVersion; // register reactive dependency on cold data changes
    const ap = settings.appearance.ais;
    const settingsIconSize = ap.vesselSize / 64;
    const now = Date.now();

    // Only advance the upload timestamp when hotData itself changed (new WS batch).
    // Cold-only updates (e.g. setInfoCache) must reuse the existing timestamp so that
    // dead-reckoned ghost vessels don't snap back to their stored position.
    const hotDataChanged = hotData !== _lastAisHotData;
    _lastAisHotData = hotData;
    const uploadTs = hotDataChanged ? now : (aisUploadTimestamp || now);

    // Capture COG line settings explicitly so Svelte 5 tracks them as dependencies
    // and the closures below always close over the current values.
    const cogColor         = ap.cog.color;
    const cogWidth         = ap.cog.width;
    const cogStyle         = ap.cog.style;
    const cogLengthMinutes = ap.cog.lengthMinutes;

    if (!hotData || ids.length === 0) {
      aisLayerGroup = [];
      flushLayers();
      aisHotSnapshot     = null;
      aisIdsSnapshot     = [];
      aisUploadTimestamp = 0;
      _lastAisHotData    = null;
      return;
    }

    const S = AIS_HOT_STRIDE;
    const n = ids.length;
    // Single O(N) pass — independent axes, no cross-effects:
    //   Motion axis  (SOG):      ghostIndices, cogIndices
    //   Arrow axis   (always):   visIndices → all get a plain arrow
    //   State axis   (navState): all state/type decorations live here
    //   Hull axis    (heading+dims): hullIndices
    const visIndices:            number[] = []; // all vessels → arrow (SART excluded)
    const ghostIndices:          number[] = []; // SOG > 0.1 m/s → ghost DR arrow + COG
    const cogIndices:            number[] = [];
    const hullIndices:           number[] = [];
    const anchoredIndices:       number[] = []; // nav state "anchored" → icon dot overlay
    const agroundIndices:        number[] = []; // nav state "aground" → icon circle overlay
    const mooredIndices:         number[] = []; // nav state "moored" → icon bars overlay
    const fishingIndices:        number[] = []; // nav state "fishing" → icon gear overlay
    const nucIndices:            number[] = []; // nav state 2 "notUnderCommand" → icon two-dot overlay
    const restrictedIndices:     number[] = []; // nav state 3 "restrictedManoeuvrability" → ball-diamond-ball
    const draughtIndices:        number[] = []; // nav state 4 "constrainedByDraught" → side bars overlay
    const sarIndices:            number[] = []; // nav state 14 SART/MOB → special red icon, no arrow
    const anchoredHullIndices:   number[] = []; // anchored + hull known → hull-space dot
    const agroundHullIndices:    number[] = []; // aground  + hull known → hull-space ring
    const mooredHullIndices:     number[] = []; // moored   + hull known → hull-space bars
    const fishingHullIndices:    number[] = []; // fishing  + hull known → hull-space gear
    const nucHullIndices:        number[] = []; // NUC      + hull known → hull-space two dots
    const restrictedHullIndices: number[] = []; // restricted + hull known → hull-space ball-diamond-ball
    const draughtHullIndices:    number[] = []; // draught  + hull known → hull-space side bars

    for (let i = 0; i < n; i++) {
      // Nav state lookup first — SART vessels are routed entirely to their own layer.
      const cold = coldMap.get(ids[i]!);
      const ns = cold?.navState?.toLowerCase() ?? '';
      const isSart = ns.includes('sart') || ns.includes('transponder');

      if (isSart) {
        sarIndices.push(i);
        continue;
      }

      visIndices.push(i);

      // Motion — SOG only, nav state irrelevant
      const isog = hotData[i * S + AIS_F_SOG]!;
      const icog = hotData[i * S + AIS_F_COG]!;
      if (!isNaN(icog) && !isNaN(isog) && isog > 0.1) {
        ghostIndices.push(i);
        cogIndices.push(i);
      }

      // Hull — heading + dimensions only
      const ihdg = hotData[i * S + AIS_F_HDG]!;
      const hasHull = !isNaN(ihdg) && (cold?.lengthM ?? 0) > 0 && (cold?.beamM ?? 0) > 0;
      if (hasHull) {
        hullIndices.push(i);
      }

      // State annotations — nav state only, SOG and ship type irrelevant.
      if (ns.includes('aground')) {
        agroundIndices.push(i);
        if (hasHull) agroundHullIndices.push(i);
      } else if (ns.includes('anchor')) {
        anchoredIndices.push(i);
        if (hasHull) anchoredHullIndices.push(i);
      } else if (ns.includes('moor')) {
        mooredIndices.push(i);
        if (hasHull) mooredHullIndices.push(i);
      } else if (ns.includes('fishing')) {
        fishingIndices.push(i);
        if (hasHull) fishingHullIndices.push(i);
      } else if (ns.includes('command')) {
        // "notUnderCommand" — only nav state containing "command"
        nucIndices.push(i);
        if (hasHull) nucHullIndices.push(i);
      } else if (ns.includes('restrict')) {
        restrictedIndices.push(i);
        if (hasHull) restrictedHullIndices.push(i);
      } else if (ns.includes('draught')) {
        // "constrainedByHerDraught" / "constrainedByDraught"
        draughtIndices.push(i);
        if (hasHull) draughtHullIndices.push(i);
      }
    }

    // Snapshot for rafTick dead-reckoning (ruler snap).
    aisHotSnapshot = hotData;
    aisIdsSnapshot = ids;
    if (hotDataChanged) aisUploadTimestamp = now;

    const vesselColor      = hexToRgba(ap.vesselColor, 220);
    const ghostVesselColor = hexToRgba(ap.vesselColor, 130);
    // Adaptive border: mix vessel color toward white (dark vessel) or black (bright vessel),
    // mirroring the icon outline shader logic.
    const [vr, vg, vb] = vesselColor;
    const luma = (vr * 0.299 + vg * 0.587 + vb * 0.114) / 255;
    const mix  = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
    const target = luma < 0.5 ? 255 : 0;
    const br = mix(vr, target, 0.5), bg = mix(vg, target, 0.5), bb = mix(vb, target, 0.5);
    const borderColor:      [number,number,number,number] = [br, bg, bb, 220];
    const ghostBorderColor: [number,number,number,number] = [br, bg, bb, 160];

    // Accessor lambdas — close over hotData, coldMap, ids. Zero allocations per frame.
    const getPos  = (i: number): [number, number, number] => [hotData[i * S + AIS_F_LON]!, hotData[i * S + AIS_F_LAT]!, 0];
    const getSog  = (i: number) => { const v = hotData[i * S + AIS_F_SOG]!; return isNaN(v) ? 0 : v; };
    const getCog  = (i: number) => { const v = hotData[i * S + AIS_F_COG]!; return isNaN(v) ? 0 : v; };
    const getHdg  = (i: number) => { const h = hotData[i * S + AIS_F_HDG]!; if (!isNaN(h)) return h; const c = hotData[i * S + AIS_F_COG]!; return isNaN(c) ? 0 : c; };
    const getHdgStrict = (i: number) => { const h = hotData[i * S + AIS_F_HDG]!; return isNaN(h) ? 0 : h; };
    const getRot  = (i: number) => { const v = hotData[i * S + AIS_F_ROT]!; return isNaN(v) ? 0 : v; };
    const getAge  = (i: number) => hotData[i * S + AIS_F_AGE]!;
    const getLen  = (i: number, fallback: number) => coldMap.get(ids[i]!)?.lengthM ?? fallback;
    const getBeam = (i: number, fallback: number) => coldMap.get(ids[i]!)?.beamM ?? fallback;
    // Icon cross-fade only fires when a hull polygon is actually drawn for this vessel.
    // A vessel with length but no heading has no hull → icon must stay at full opacity.
    const hullSet = new Set(hullIndices);
    const getLenForIcon = (i: number) => hullSet.has(i) ? getLen(i, 0) : 0;

    const ghostIconLayer = ghostIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-ghost-icon',
          data: ghostIndices,
          getPosition:    getPos,
          getSog:         getSog,
          getCog:         getCog,
          getHeading:     getHdg,
          getRot:         getRot,
          getAgeAtUpload: getAge,
          getLength:      getLenForIcon,
          getColor:       ghostVesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: true,
          animationIntervalMs: 1000 / settings.targetFps,
          settingsIconSize,
          drCapSeconds: cogLengthMinutes * 60,
          pickable: true,
        })
      : null;

    // Arrow layer — all vessels, always.
    const confirmedIconLayer = new VesselIconLayer({
      id: 'ais-confirmed-icon',
      data: visIndices,
      getPosition:    getPos,
      getSog:         () => 0,
      getCog:         () => 0,
      getHeading:     getHdg,
      getRot:         () => 0,
      getAgeAtUpload: () => 0,
      getLength:      getLenForIcon,
      getColor:       vesselColor,
      uploadTimestamp: uploadTs,
      selfAnimate: false,
      settingsIconSize,
      pickable: true,
    });

    // Anchor-dot overlay — nav state only, arrow already drawn above.
    const anchoredIconLayer = anchoredIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-anchored-icon',
          data: anchoredIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      getLenForIcon,
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: ANCHOR_DOT_GEOMETRY,
          pickable: false,
        })
      : null;

    // Mooring-bars overlay — nav state only, arrow already drawn above.
    const mooredIconLayer = mooredIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-moored-icon',
          data: mooredIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      getLenForIcon,
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: MOORING_BARS_GEOMETRY,
          pickable: false,
        })
      : null;

    // Aground circle overlay — nav state only, arrow already drawn above.
    const agroundIconLayer = agroundIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-aground-icon',
          data: agroundIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      getLenForIcon,
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: AGROUND_CIRCLE_GEOMETRY,
          pickable: false,
        })
      : null;

    // Fishing gear overlay — nav state "fishing" / "engagedInFishing".
    const fishingIconLayer = fishingIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-fishing-icon',
          data: fishingIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      getLenForIcon,
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: FISHING_GEAR_GEOMETRY,
          pickable: false,
        })
      : null;

    // NUC overlay — nav state 2.
    const nucIconLayer = nucIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-nuc-icon',
          data: nucIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      getLenForIcon,
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: NUC_GEOMETRY,
          pickable: false,
        })
      : null;

    // Restricted manoeuvrability overlay — nav state 3.
    const restrictedIconLayer = restrictedIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-restricted-icon',
          data: restrictedIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      getLenForIcon,
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: RESTRICTED_MANOEUVRING_GEOMETRY,
          pickable: false,
        })
      : null;

    // Constrained by draught overlay — nav state 4.
    const draughtIconLayer = draughtIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-draught-icon',
          data: draughtIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      getLenForIcon,
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: DRAUGHT_GEOMETRY,
          pickable: false,
        })
      : null;

    // MOB / AIS-SART — nav state 14. Replaces the arrow with a red swimmer icon.
    // getLength = 0 disables cross-fade → icon always visible regardless of zoom.
    // getHeading = 0 keeps the swimmer north-up (no meaningful orientation for a beacon).
    const mobIconLayer = sarIndices.length > 0
      ? new VesselIconLayer({
          id: 'ais-mob-icon',
          data: sarIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     () => 0,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      () => 0,
          getColor:       () => [255, 40, 40, 220] as [number, number, number, number],
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: MOB_GEOMETRY,
          pickable: true,
        })
      : null;

    const ghostHullLayer = hullIndices.length > 0
      ? new AisHullLayer({
          id: 'ais-hull-ghost',
          data: hullIndices,
          getPosition:    getPos,
          getSog:         getSog,
          getCog:         getCog,
          getHeading:     getHdgStrict,
          getRot:         getRot,
          getAgeAtUpload: getAge,
          getLength:      (i) => getLen(i, 50),
          getBeam:        (i) => getBeam(i, 10),
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: true,
          animationIntervalMs: 1000 / settings.targetFps,
          settingsIconSize,
          opacity: 0.75,
          drCapSeconds: cogLengthMinutes * 60,
          pickable: true,
        })
      : null;

    const confirmedHullLayer = hullIndices.length > 0
      ? new AisHullLayer({
          id: 'ais-hull-confirmed',
          data: hullIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdgStrict,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 50),
          getBeam:        (i) => getBeam(i, 10),
          getColor:       vesselColor,
          uploadTimestamp: uploadTs,
          selfAnimate: false,
          settingsIconSize,
          opacity: 1,
          pickable: true,
        })
      : null;

    // Hull-space decoration layers — fade in/out with the hull polygon.
    const makeHullDecoration = (id: string, data: number[], decoration: typeof HULL_ANCHOR_DOT, animate: boolean) =>
      data.length > 0
        ? new AisHullDecorationLayer({
            id,
            data,
            getPosition:    getPos,
            getSog:         animate ? getSog : () => 0,
            getCog:         animate ? getCog : () => 0,
            getHeading:     getHdgStrict,
            getRot:         animate ? getRot : () => 0,
            getAgeAtUpload: animate ? getAge : () => 0,
            getLength:      (i) => getLen(i, 50),
            getBeam:        (i) => getBeam(i, 10),
            uploadTimestamp: uploadTs,
            selfAnimate: animate,
            animationIntervalMs: animate ? 1000 / settings.targetFps : 0,
            settingsIconSize,
            decoration,
          })
        : null;

    const makeBorderLayer = (id: string, animate: boolean, color: [number,number,number,number], opacity: number) =>
      hullIndices.length > 0
        ? new AisHullBorderLayer({
            id,
            data: hullIndices,
            getPosition:    getPos,
            getSog:         animate ? getSog : () => 0,
            getCog:         animate ? getCog : () => 0,
            getHeading:     getHdgStrict,
            getRot:         animate ? getRot : () => 0,
            getAgeAtUpload: animate ? getAge : () => 0,
            getLength:      (i) => getLen(i, 50),
            getBeam:        (i) => getBeam(i, 10),
            getBorderColor: () => color,
            uploadTimestamp: uploadTs,
            selfAnimate: animate,
            animationIntervalMs: animate ? 1000 / settings.targetFps : 0,
            settingsIconSize,
            opacity,
          })
        : null;

    const confirmedHullBorderLayer = makeBorderLayer('ais-hull-border-confirmed', false, borderColor, 1.0);
    const ghostHullBorderLayer     = makeBorderLayer('ais-hull-border-ghost',     true,  ghostBorderColor, 0.75);

    const anchoredHullDecoration = makeHullDecoration('ais-anchored-hull', anchoredHullIndices, HULL_ANCHOR_DOT, false);
    const mooredHullDecoration   = makeHullDecoration('ais-moored-hull',   mooredHullIndices,   HULL_MOORING_BARS, false);
    const agroundHullDecoration  = makeHullDecoration('ais-aground-hull',  agroundHullIndices,  HULL_AGROUND_RING, false);
    const fishingHullDecoration  = makeHullDecoration('ais-fishing-hull',  fishingHullIndices,  HULL_FISHING_GEAR, false);
    const nucHullDecoration      = makeHullDecoration('ais-nuc-hull',      nucHullIndices,      HULL_NUC, false);
    const restrictedHullDecoration = makeHullDecoration('ais-restricted-hull', restrictedHullIndices, HULL_RESTRICTED, false);
    const draughtHullDecoration  = makeHullDecoration('ais-draught-hull',  draughtHullIndices,  HULL_DRAUGHT, false);
    // Ghost variants animate with the DR hull
    const anchoredGhostDecoration = makeHullDecoration('ais-anchored-hull-ghost', anchoredHullIndices, HULL_ANCHOR_DOT, true);
    const mooredGhostDecoration   = makeHullDecoration('ais-moored-hull-ghost',   mooredHullIndices,   HULL_MOORING_BARS, true);
    const agroundGhostDecoration  = makeHullDecoration('ais-aground-hull-ghost',  agroundHullIndices,  HULL_AGROUND_RING, true);
    const fishingGhostDecoration  = makeHullDecoration('ais-fishing-hull-ghost',  fishingHullIndices,  HULL_FISHING_GEAR, true);
    const nucGhostDecoration      = makeHullDecoration('ais-nuc-hull-ghost',      nucHullIndices,      HULL_NUC, true);
    const restrictedGhostDecoration = makeHullDecoration('ais-restricted-hull-ghost', restrictedHullIndices, HULL_RESTRICTED, true);
    const draughtGhostDecoration  = makeHullDecoration('ais-draught-hull-ghost',  draughtHullIndices,  HULL_DRAUGHT, true);

    // getDashArray is a PathStyleExtension prop; spread from variable to bypass excess-property check.
    const cogDashProps = { getDashArray: lineStyleDash(cogStyle, cogWidth) };

    aisLayerGroup = [
      // bottom: confirmed hull at last-known position (full opacity, static)
      ...(confirmedHullLayer ? [confirmedHullLayer] : []),
      // border outline on confirmed hull (above fill, below decorations)
      ...(confirmedHullBorderLayer ? [confirmedHullBorderLayer] : []),
      // hull-space decorations at confirmed position (static)
      ...(anchoredHullDecoration    ? [anchoredHullDecoration]    : []),
      ...(mooredHullDecoration      ? [mooredHullDecoration]      : []),
      ...(agroundHullDecoration     ? [agroundHullDecoration]     : []),
      ...(fishingHullDecoration     ? [fishingHullDecoration]     : []),
      ...(nucHullDecoration         ? [nucHullDecoration]         : []),
      ...(restrictedHullDecoration  ? [restrictedHullDecoration]  : []),
      ...(draughtHullDecoration     ? [draughtHullDecoration]     : []),
      // ghost hull polygon (GPU animated, 75% opacity)
      ...(ghostHullLayer ? [ghostHullLayer] : []),
      // border outline on ghost hull (tracks dead-reckoned position)
      ...(ghostHullBorderLayer ? [ghostHullBorderLayer] : []),
      // hull-space decorations on ghost (animated, tracks DR hull)
      ...(anchoredGhostDecoration   ? [anchoredGhostDecoration]   : []),
      ...(mooredGhostDecoration     ? [mooredGhostDecoration]     : []),
      ...(agroundGhostDecoration    ? [agroundGhostDecoration]    : []),
      ...(fishingGhostDecoration    ? [fishingGhostDecoration]    : []),
      ...(nucGhostDecoration        ? [nucGhostDecoration]        : []),
      ...(restrictedGhostDecoration ? [restrictedGhostDecoration] : []),
      ...(draughtGhostDecoration    ? [draughtGhostDecoration]    : []),
      // COG arc prediction line
      new PathLayer<number>({
        id: 'ais-cog',
        data: cogIndices,
        getPath: (i: number) => {
          const lon  = hotData[i * S + AIS_F_LON]!;
          const lat  = hotData[i * S + AIS_F_LAT]!;
          const c    = hotData[i * S + AIS_F_COG]!;
          const s    = hotData[i * S + AIS_F_SOG]!;
          const r    = hotData[i * S + AIS_F_ROT]!;
          const totalSec = cogLengthMinutes * 60;
          const rotRad = isNaN(r) ? 0 : r;
          if (Math.abs(rotRad) < 1e-4) {
            const [endLon, endLat] = extrapolatePos(lon, lat, c, isNaN(s) ? 0 : s, 0, 0, totalSec * 1000);
            return [[lon, lat], [endLon, endLat]];
          }
          const N = 24;
          // Cap the drawn arc to one full circle (2π / |rotRad| = seconds per revolution).
          // All N segments are distributed evenly over that capped duration, so fast-turning
          // vessels use their full segment budget for a single loop rather than spiral beyond it.
          const fullCircleSec = (2 * Math.PI) / Math.abs(rotRad);
          const clampedSec = Math.min(totalSec, fullCircleSec);
          return Array.from({ length: N + 1 }, (_, k) => {
            const [pLon, pLat] = extrapolatePos(lon, lat, c, isNaN(s) ? 0 : s, rotRad, 0, clampedSec * k / N * 1000);
            return [pLon, pLat] as [number, number];
          });
        },
        getColor: () => hexToRgba(cogColor, 200),
        getWidth: cogWidth,
        ...cogDashProps,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: false,
        extensions: [new PathStyleExtension({ dash: true })],
        updateTriggers: {
          getPath:      [cogLengthMinutes],
          getColor:     [cogColor],
          getWidth:     [cogWidth],
          getDashArray: [cogStyle, cogWidth],
        },
      }),
      // ghost icon (self-animating, above hull) — SOG-driven
      ...(ghostIconLayer ? [ghostIconLayer] : []),
      // confirmed arrow icon — all vessels, always
      confirmedIconLayer,
      // decoration overlays — nav state driven, rendered on top of arrows
      ...(anchoredIconLayer   ? [anchoredIconLayer]   : []),
      ...(agroundIconLayer    ? [agroundIconLayer]    : []),
      ...(mooredIconLayer     ? [mooredIconLayer]     : []),
      ...(fishingIconLayer    ? [fishingIconLayer]    : []),
      ...(nucIconLayer        ? [nucIconLayer]        : []),
      ...(restrictedIconLayer ? [restrictedIconLayer] : []),
      ...(draughtIconLayer    ? [draughtIconLayer]    : []),
      // MOB/SART — rendered last (always on top) with its own icon replacing the arrow
      ...(mobIconLayer        ? [mobIconLayer]        : []),
    ];
    flushLayers();
  });

  /**
   * Builds the own-vessel deck.gl layers: heading/COG/GC predictor lines plus the vessel
   * icon. Rendered via deck.gl (not MapLibre) for the same reason as buildCourseLayers() —
   * the deck.gl overlay (interleaved: false) always draws on its own canvas above MapLibre's,
   * so a MapLibre predictor line could never be drawn on top of an AIS target.
   * Pure function of its arguments — callers control what's tracked as an effect dependency.
   * The position effect tracks $vesselState (60 Hz orientation ticks); the appearance effect
   * must not, so it reads state/zoom/projection via untrack() and passes them in here instead.
   */
  function buildOwnVesselLayers(
    ap: AppearanceSettings,
    state: VesselState,
    zoom: number,
    projection: import('../stores/mapView.svelte').ProjectionId,
  ): Layer[] {
    const layers: Layer[] = [];
    if (!state.position) return layers;
    const { longitude, latitude } = state.position;

    function lineDistM(line: LineAppearance, sogMs: number | null): number {
      if (line.lengthUnit === 'nm')  return line.lengthValue * 1852;
      if (line.lengthUnit === 'min') return sogMs !== null ? line.lengthValue * 60 * sogMs : 0;
      // px → meters per pixel at current zoom & latitude (WebMercator, 512px tile)
      const mpp = (Math.cos(latitude * Math.PI / 180) * 40075016.686) / (512 * Math.pow(2, zoom));
      return line.lengthValue * mpp;
    }

    if (state.cog !== null) {
      const cogDashProps = { getDashArray: lineStyleDash(ap.cog.style, ap.cog.width) };
      layers.push(new PathLayer<[number, number][]>({
        id: 'vessel-cog-line',
        data: [rhumbCoords(longitude, latitude, state.cog, lineDistM(ap.cog, state.sog))],
        getPath: d => d,
        getColor: hexToRgba(ap.cog.color, 255),
        getWidth: ap.cog.width,
        ...cogDashProps,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: false,
        extensions: [new PathStyleExtension({ dash: true })],
      }));

      const gcDashProps = { getDashArray: lineStyleDash(ap.gc.style, ap.gc.width) };
      layers.push(new PathLayer<[number, number][]>({
        id: 'vessel-gc-line',
        data: [gcCoords(longitude, latitude, state.cog, lineDistM(ap.gc, state.sog))],
        getPath: d => d,
        getColor: hexToRgba(ap.gc.color, 255),
        getWidth: ap.gc.width,
        ...gcDashProps,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: false,
        extensions: [new PathStyleExtension({ dash: true })],
      }));
    }

    if (state.heading !== null) {
      const hdgDashProps = { getDashArray: lineStyleDash(ap.heading.style, ap.heading.width) };
      const project = projection === 'globe' ? gcCoords : rhumbCoords;
      layers.push(new PathLayer<[number, number][]>({
        id: 'vessel-hdg-line',
        data: [project(longitude, latitude, state.heading, lineDistM(ap.heading, state.sog))],
        getPath: d => d,
        getColor: hexToRgba(ap.heading.color, 255),
        getWidth: ap.heading.width,
        ...hdgDashProps,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: false,
        extensions: [new PathStyleExtension({ dash: true })],
      }));
    }

    // Own vessel icon — rendered last (on top of its own predictor lines).
    // VesselIconLayer handles globe mode, map-aligned rotation, and picking correctly.
    const orientRad     = state.heading ?? state.cog ?? null;
    const ownVesselColor = hexToRgba(ap.vesselColor, 255);
    const ownVesselSize  = ap.vesselSize / 64;
    layers.push(new VesselIconLayer<number>({
      id: 'own-vessel-icon',
      data: [0],
      getPosition:    () => [longitude, latitude, 0],
      getSog:         () => 0,
      getCog:         () => 0,
      getHeading:     () => orientRad ?? 0,
      getRot:         () => 0,
      getAgeAtUpload: () => 0,
      getLength:      () => 0,
      getColor:       () => ownVesselColor,
      uploadTimestamp: 0,
      selfAnimate: false,
      settingsIconSize: ownVesselSize,
      pickable: true,
    }));

    return layers;
  }
  // Appearance-only effect: paint/layout properties that change only when settings change.
  // Deliberately does NOT read $vesselState so 60 Hz orientation updates don't trigger it.
  $effect(() => {
    const ap = settings.appearance;
    const ra = ap.route;
    if (!map || !mapLoaded) return;
    // vessel-gc/-cog/-hdg-line moved to deck.gl (see buildOwnVesselLayers()) since MapLibre
    // layers can't render above the deck.gl overlay's own canvas. Reads $vesselState/zoom/
    // projection untracked — only ap/ra are this effect's dependencies.
    {
      const { state, zoom, projection } = untrack(() => ({
        state: $vesselState, zoom: mapZoom, projection: mapView.projection,
      }));
      ownVesselLayerGroup = buildOwnVesselLayers(ap, state, zoom, projection);
    }
    // Track: solid style uses line-gradient for the fade effect (incompatible with line-dasharray).
    // Non-solid styles fall back to line-color + line-dasharray (no fade).
    if (ap.track.style === 'solid') {
      map.setPaintProperty('vessel-track-line', 'line-gradient',  buildTrackGradient(ap.track.color, trackFadeStop));
      map.setPaintProperty('vessel-track-line', 'line-dasharray', undefined);
    } else {
      map.setPaintProperty('vessel-track-line', 'line-gradient',  null);
      map.setPaintProperty('vessel-track-line', 'line-color',     ap.track.color);
      map.setPaintProperty('vessel-track-line', 'line-dasharray', dashArray(ap.track.style, ap.track.width) ?? undefined);
    }
    map.setPaintProperty('vessel-track-line',  'line-width',     ap.track.width);
    // Overflow segments: same color/width/dash as main track, no gradient.
    map.setPaintProperty('vessel-track-overflow-line', 'line-color',   ap.track.color);
    map.setPaintProperty('vessel-track-overflow-line', 'line-width',   ap.track.width);
    map.setPaintProperty('vessel-track-overflow-line', 'line-opacity', 1);
    map.setPaintProperty('vessel-track-overflow-line', 'line-dasharray',
      ap.track.style !== 'solid' ? dashArray(ap.track.style, ap.track.width) ?? undefined : undefined);
    // Route appearance — kept here so it never fires on 60 Hz heading ticks.
    map.setPaintProperty('all-routes-line', 'line-color',     ra.allRoutes.color);
    map.setPaintProperty('all-routes-line', 'line-width',     ra.allRoutes.width);
    map.setPaintProperty('all-routes-line', 'line-opacity',   0.55);
    map.setPaintProperty('all-routes-line', 'line-dasharray', dashArray(ra.allRoutes.style, ra.allRoutes.width) ?? undefined);
    // route-full/-leg/-bearing moved to deck.gl (see buildCourseLayers()) since MapLibre
    // layers can't render above the deck.gl overlay's own canvas.
    courseLayerGroup = buildCourseLayers();
    flushLayers();
  });

  // Position effect: own-vessel deck.gl layers + track sources updated whenever vessel
  // state or zoom changes. $vesselState changes at 60 Hz (orientation events); the deck.gl
  // rebuild below is synchronous per tick (cheap — same cost as the icon rebuild already was).
  $effect(() => {
    const ap    = settings.appearance;
    const state = $vesselState;
    const zoom  = mapZoom;
    const projection = mapView.projection;
    if (!map || !mapLoaded || !state.position) return;

    ownVesselLayerGroup = buildOwnVesselLayers(ap, state, zoom, projection);
    flushLayers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    if ((window as any).__mapDiag) (window as any).__mapDiag.ownVessel++;
  });

  // Track data effect: updates when track coordinates change (new point appended or historical data loaded).
  // Also recomputes trackFadeStop so the appearance effect re-runs and updates the line-gradient.
  $effect(() => {
    const coords = track.coordinates;
    if (!map || !mapLoaded) return;
    const src = map.getSource(TRACK_SOURCE);
    if (!(src instanceof maplibregl.GeoJSONSource)) return;
    const overflowSrc = map.getSource(TRACK_OVERFLOW_SOURCE);
    if (coords.length < 2) {
      src.setData(EMPTY_FC);
      if (overflowSrc instanceof maplibregl.GeoJSONSource) overflowSrc.setData(EMPTY_FC);
      trackFadeStop = 0;
      return;
    }
    const { coords: unwrapped, overflowSegments, fadeStop } = processTrack(coords);
    trackFadeStop = fadeStop;
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: unwrapped }, properties: {} }],
    });
    if (overflowSrc instanceof maplibregl.GeoJSONSource) {
      overflowSrc.setData({
        type: 'FeatureCollection',
        features: overflowSegments.map(seg => ({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: seg },
          properties: {},
        })),
      });
    }
  });

  // Fetch all AIS vessel tracks when the all-tracks toggle is on.
  // Increments _aisAllTracksGen to discard in-flight results when toggled off.
  $effect(() => {
    if (!visibility.aisTracks || !mapLoaded) {
      if (_fetchedAisTrackIds.size > 0) {
        _aisAllTracksGen++;
        _fetchedAisTrackIds.clear();
        aisAllTracksMap.clear();
      }
      return;
    }
    // Capture current gen without bumping — only the "toggle off" branch above should bump it.
    // Bumping here would cancel in-flight fetches every time ais.ids changes (1 Hz).
    const cancelAtGen = _aisAllTracksGen;
    const base  = settings.signalkHttpUrl;
    const hours = settings.appearance.ais.track.historyHours;
    for (const id of ais.ids) {
      if (_fetchedAisTrackIds.has(id)) continue;
      _fetchedAisTrackIds.add(id);
      fetchAisVesselTrack(base, id, hours).then(coords => {
        if (_aisAllTracksGen !== cancelAtGen) return;
        if (coords.length >= 2) aisAllTracksMap.set(id, coords);
      }).catch(() => { /* no history for this vessel — silently skip */ });
    }
  });

  // AIS track data effect: populates AIS track GeoJSON source.
  // In all-tracks mode: FeatureCollection from all fetched vessel tracks, overflow stays empty.
  // In popup mode: single selected vessel from aisTrackRaw with overflow segments.
  $effect(() => {
    if (!map || !mapLoaded) return;
    const src = map.getSource(AIS_TRACK_SOURCE);
    const overflowSrc = map.getSource(AIS_TRACK_OVERFLOW_SOURCE);
    if (!(src instanceof maplibregl.GeoJSONSource)) return;
    if (!(overflowSrc instanceof maplibregl.GeoJSONSource)) return;

    // Gate on aisVessels too: when vessels are hidden, clear the source to free GPU buffers.
    // The aisAllTracksMap cache is kept so re-enabling aisVessels doesn't require re-fetching.
    if (visibility.aisVessels && visibility.aisTracks && aisAllTracksMap.size > 0) {
      const features: GeoJSON.Feature[] = [];
      for (const [, coords] of aisAllTracksMap) {
        if (coords.length >= 2) {
          const { coords: processed } = processTrack(coords);
          features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: processed }, properties: {} });
        }
      }
      src.setData({ type: 'FeatureCollection', features });
      overflowSrc.setData(EMPTY_FC);
      aisTrackFadeStop = 0;
      return;
    }

    // When aisVessels is OFF, treat as no track data — clears source to EMPTY_FC below.
    const raw = visibility.aisVessels ? aisTrackRaw : [];
    if (raw.length < 2) {
      src.setData(EMPTY_FC);
      overflowSrc.setData(EMPTY_FC);
      aisTrackFadeStop = 0;
      return;
    }
    const { coords, overflowSegments, fadeStop } = processTrack(raw);
    aisTrackFadeStop = fadeStop;
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
    });
    overflowSrc.setData({
      type: 'FeatureCollection',
      features: overflowSegments.map(seg => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: seg },
        properties: {},
      })),
    });
  });

  // AIS track style effect: syncs appearance settings and fade gradient to the AIS track layers.
  // In all-tracks mode the gradient is suppressed — age encoding is per-vessel and cannot be
  // represented uniformly across a multi-feature FeatureCollection.
  $effect(() => {
    if (!map || !mapLoaded) return;
    const ta            = settings.appearance.ais.track;
    const allTracksMode = visibility.aisTracks && aisAllTracksMap.size > 0;
    const fadeStop      = allTracksMode ? 0 : aisTrackFadeStop;
    if (ta.style === 'solid' && !allTracksMode) {
      map.setPaintProperty('ais-track-line', 'line-gradient',  buildTrackGradient(ta.color, fadeStop));
      map.setPaintProperty('ais-track-line', 'line-dasharray', undefined);
    } else {
      map.setPaintProperty('ais-track-line', 'line-gradient',  null);
      map.setPaintProperty('ais-track-line', 'line-color',     ta.color);
      map.setPaintProperty('ais-track-line', 'line-dasharray', ta.style !== 'solid' ? dashArray(ta.style, ta.width) ?? undefined : undefined);
    }
    map.setPaintProperty('ais-track-line', 'line-width',   ta.width);
    const hasData = allTracksMode ? aisAllTracksMap.size > 0 : aisTrackRaw.length >= 2;
    map.setPaintProperty('ais-track-line',          'line-opacity', ta.show && hasData ? 1 : 0);
    map.setPaintProperty('ais-track-overflow-line', 'line-color',   ta.color);
    map.setPaintProperty('ais-track-overflow-line', 'line-width',   ta.width);
    map.setPaintProperty('ais-track-overflow-line', 'line-opacity', ta.show && !allTracksMode && aisTrackRaw.length >= 2 ? 1 : 0);
    map.setPaintProperty('ais-track-overflow-line', 'line-dasharray',
      ta.style !== 'solid' ? dashArray(ta.style, ta.width) ?? undefined : undefined);
  });

  /**
   * Builds the active-route deck.gl layers: full planned polyline, active leg
   * (previousPoint → nextPoint), and bearing line (own vessel → nextPoint).
   * Rendered via deck.gl rather than MapLibre so they sit above AIS targets and the
   * own-vessel icon — the deck.gl overlay (interleaved: false) always draws on its
   * own canvas above MapLibre's, so a MapLibre line can never appear on top of them.
   */
  function buildCourseLayers(): Layer[] {
    const geo     = route.geometry;
    const nxtPt   = route.nextPoint;
    const prevPt  = route.previousPoint;
    const ownPos  = $vesselPosition;
    const ra      = settings.appearance.route;
    const layers: Layer[] = [];

    // Full planned route polyline from the REST resource — GC-densified, antimeridian-unwrapped,
    // and split bidirectionally so globe-circling routes render across all world copies.
    if (geo) {
      const processed = processRouteCoords(geo.geometry.coordinates as [number, number][]);
      const segments  = splitRouteSegments(processed);
      // getDashArray is a PathStyleExtension prop; spread from a variable to bypass the
      // excess-property check (same technique as cogDashProps above).
      const fullDashProps = { getDashArray: lineStyleDash(ra.remaining.style, ra.remaining.width) };
      layers.push(new PathLayer<[number, number][]>({
        id: 'route-full',
        data: segments,
        getPath: d => d,
        getColor: hexToRgba(ra.remaining.color, 255),
        getWidth: ra.remaining.width,
        ...fullDashProps,
        opacity: 0.65,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: true,
        extensions: [new PathStyleExtension({ dash: true })],
      }));
    }

    // Active leg: previousPoint → nextPoint (the current planned segment) — GC path.
    if (nxtPt && prevPt) {
      const path = processRouteCoords([[prevPt.longitude, prevPt.latitude], [nxtPt.longitude, nxtPt.latitude]]);
      const legDashProps = { getDashArray: lineStyleDash(ra.segment.style, ra.segment.width) };
      layers.push(new PathLayer<[number, number][]>({
        id: 'route-leg',
        data: [path],
        getPath: d => d,
        getColor: hexToRgba(ra.segment.color, 255),
        getWidth: ra.segment.width,
        ...legDashProps,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: true,
        extensions: [new PathStyleExtension({ dash: true })],
      }));
    }

    // Bearing line: own vessel → nextPoint (where I need to actually steer) — GC path.
    if (nxtPt && ownPos) {
      const path = processRouteCoords([[ownPos.longitude, ownPos.latitude], [nxtPt.longitude, nxtPt.latitude]]);
      const bearingDashProps = { getDashArray: lineStyleDash(ra.bearing.style, ra.bearing.width) };
      layers.push(new PathLayer<[number, number][]>({
        id: 'route-bearing',
        data: [path],
        getPath: d => d,
        getColor: hexToRgba(ra.bearing.color, 255),
        getWidth: ra.bearing.width,
        ...bearingDashProps,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: true,
        extensions: [new PathStyleExtension({ dash: true })],
      }));
    }

    return layers;
  }

  // Route/course rendering — updates when route geometry, course points, own position,
  // or route appearance settings change.
  // Reads $vesselPosition (not $vesselState) so compass ticks at 60 Hz don't trigger this:
  // heading updates leave the position reference unchanged, so the derived store stays quiet.
  $effect(() => {
    const nxtPt   = route.nextPoint;
    const prevPt  = route.previousPoint;
    void route.geometry;
    void $vesselPosition;
    void settings.appearance.route;
    if (!map || !mapLoaded) return;

    const wptSrc = map.getSource(ROUTE_WPT_SRC);
    if (!(wptSrc instanceof maplibregl.GeoJSONSource)) return;

    courseLayerGroup = buildCourseLayers();
    flushLayers();

    const wptFeatures: GeoJSON.Feature[] = [];
    if (nxtPt) wptFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [nxtPt.longitude, nxtPt.latitude] }, properties: { wtype: 'next' } });
    if (prevPt) wptFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [prevPt.longitude, prevPt.latitude] }, properties: { wtype: 'prev' } });
    wptSrc.setData({ type: 'FeatureCollection', features: wptFeatures });
  });

  // Exclude the active route from the all-routes layer so it isn't double-styled.
  $effect(() => {
    const activeUuid = route.activeUuid;
    if (!map || !mapLoaded) return;
    if (!map.getLayer('all-routes-line')) return;
    map.setFilter('all-routes-line',
      activeUuid ? ['!=', ['get', 'uuid'], activeUuid] : null,
    );
  });

  // All server routes — rebuild GeoJSON source when the route list changes.
  // Each route is split into antimeridian-safe segments (same pipeline as the active route).
  $effect(() => {
    const entries = routes.entries;
    if (!map || !mapLoaded) return;
    const src = map.getSource(ALL_ROUTES_SRC);
    if (!(src instanceof maplibregl.GeoJSONSource)) return;

    const features: GeoJSON.Feature[] = [];
    for (const r of entries) {
      const coords = r.geometry.geometry.coordinates as [number, number][];
      const processed = processRouteCoords(coords);
      for (const seg of splitRouteSegments(processed)) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: seg },
          properties: { uuid: r.uuid, name: r.name },
        });
      }
    }
    src.setData({ type: 'FeatureCollection', features });
  });

  // All server waypoints — rebuild GeoJSON source when the waypoint list changes.
  $effect(() => {
    const entries = waypoints.entries;
    if (!map || !mapLoaded) return;
    const src = map.getSource(ALL_WAYPOINTS_SRC);
    if (!(src instanceof maplibregl.GeoJSONSource)) return;

    src.setData({
      type: 'FeatureCollection',
      features: entries.map(w => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
        properties: { uuid: w.uuid, name: w.name },
      })),
    });
  });

  // Auto-fallback: if the current rotation mode becomes unavailable (e.g. route cleared),
  // drop back to COG → north.
  $effect(() => {
    rotateMode.ensureAvailable(
      $vesselState.cog     !== null,
      $vesselState.heading !== null,
      route.nextPoint      !== null,
    );
  });
  // Gesture-rotation lock.
  //
  // map.dragRotate handles both bearing AND pitch from right-click drag — there is no public
  // API to split them. Rather than fight its event handling and inertia animations, we just
  // disable it entirely in non-manual modes and re-implement right-click as pitch-only
  // ourselves. Bearing is never touched, so no snap-back is needed at all.
  //
  // Right-click drag handler.
  //
  // Three cases:
  //   MAN + not following  → native dragRotate (MapLibre default, center-anchored is fine).
  //   MAN + following      → our handler: bearing + pitch, easeTo around vessel so it
  //                          stays pinned at its offset screen position.
  //   non-MAN              → our handler: pitch only, bearing stays locked.
  //
  // Pointer capture guarantees pointerup fires on the canvas even when the mouse leaves
  // the window — no window.addEventListener needed.
  // contextmenu is suppressed only after a real drag (> 3 px), so plain right-click
  // still shows the map context menu.
  $effect(() => {
    if (!mapLoaded || !map) return;

    const isManual   = rotateMode.mode === 'manual';
    const isFollowing = followMode.following;

    if (isManual && !isFollowing) {
      // Default MapLibre behaviour — rotate and pitch freely around map centre.
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      return;
    }

    map.dragRotate.disable();
    map.touchZoomRotate[isManual ? 'enableRotation' : 'disableRotation']();

    let capturedId = -1;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;
    let dragMoved = false;
    const canvas = map.getCanvas();

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2 || capturedId !== -1) return;
      canvas.setPointerCapture(e.pointerId);
      capturedId = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      lastX  = e.clientX; lastY  = e.clientY;
      dragMoved = false;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== capturedId || !map) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (!dragMoved && Math.hypot(e.clientX - startX, e.clientY - startY) > 3) dragMoved = true;

      if (isManual) {
        // MAN + following: rotate around vessel so it stays at its pinned screen pixel.
        const newBearing = map.getBearing() + dx * 0.4;
        const newPitch   = Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() - dy * 0.5));
        const pos = get(vesselState).position;
        const around: [number, number] | undefined = pos
          ? [pos.longitude, pos.latitude]
          : undefined;
        map.easeTo({ bearing: newBearing, pitch: newPitch, ...(around ? { around } : {}), duration: 0 });
      } else {
        // Non-manual: pitch only, bearing stays locked.
        // When following, anchor around the vessel so it stays at its pinned pixel.
        const newPitch = Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() - dy * 0.5));
        const pos = isFollowing ? get(vesselState).position : null;
        if (pos) {
          map.easeTo({ pitch: newPitch, around: [pos.longitude, pos.latitude], duration: 0 });
        } else {
          map.setPitch(newPitch);
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== capturedId) return;
      canvas.releasePointerCapture(e.pointerId);
      capturedId = -1;
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== capturedId) return;
      capturedId = -1;
      dragMoved = false;
    };

    const onContextMenu = (e: Event) => {
      if (dragMoved) { e.preventDefault(); dragMoved = false; }
    };

    canvas.addEventListener('pointerdown',   onPointerDown);
    canvas.addEventListener('pointermove',   onPointerMove);
    canvas.addEventListener('pointerup',     onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('contextmenu',   onContextMenu);

    // When following, disable all of MapLibre's two-finger handlers (touchZoomRotate
    // and touchPitch) and replace them with a single pointer-event loop that handles
    // zoom, bearing (MAN only), and pitch simultaneously — all anchored to the vessel.
    //
    // Why disable rather than patch: every map.easeTo() call fires movestart into
    // MapLibre's internal event bus. touchPitch and touchZoomRotate both watch for
    // movestart to detect competing camera movements and abort their gesture tracking.
    // Any "correct after the fact" approach (pitchend re-anchor, pitch-event correction)
    // therefore kills the very gesture it's trying to fix after the first frame.
    //
    // Gesture math mirrors MapLibre's internal TouchZoomRotateHandler:
    //   zoom    = log2(newSpan / prevSpan)  — finger span ratio
    //   bearing = –atan2(dy, dx) angle delta (neg sign flips screen-Y so CW = positive)
    //   pitch   = midpoint-Y delta × 0.5   — matching right-click convention
    if (isFollowing) {
      map.touchZoomRotate.disable();
      map.touchPitch.disable();

      interface TpEntry { id: number; x: number; y: number }
      let tp: TpEntry[] = [];
      // prevDist NaN = gesture not yet started; used as the single gate for all three.
      let prevDist = NaN, prevAngle = NaN, prevMidY = NaN;

      const onTPDown = (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        if (!tp.some(p => p.id === e.pointerId))
          tp.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
        prevDist = NaN; // reset gesture state on any finger-count change
      };

      const onTPMove = (e: PointerEvent) => {
        if (e.pointerType !== 'touch' || !map) return;
        const entry = tp.find(p => p.id === e.pointerId);
        if (!entry) return;
        entry.x = e.clientX;
        entry.y = e.clientY;
        if (tp.length !== 2) return;

        const dx    = tp[1]!.x - tp[0]!.x;
        const dy    = tp[1]!.y - tp[0]!.y;
        const dist  = Math.hypot(dx, dy);
        // Negate atan2 so CW screen rotation = positive angle, matching MapLibre convention.
        const angle = -Math.atan2(dy, dx) * 180 / Math.PI;
        const midY  = (tp[0]!.y + tp[1]!.y) / 2;

        if (Number.isNaN(prevDist)) {
          prevDist = dist; prevAngle = angle; prevMidY = midY;
          return;
        }

        const zoomDelta = dist > 0 && prevDist > 0 ? Math.log2(dist / prevDist) : 0;
        // Bearing only in MAN mode; normalise to [-180, 180] to handle atan2 wrap.
        let dAngle = isManual ? angle - prevAngle : 0;
        if (dAngle >  180) dAngle -= 360;
        if (dAngle < -180) dAngle += 360;
        const pitchDelta = midY - prevMidY;

        prevDist  = dist;
        prevAngle = angle;
        prevMidY  = midY;

        const newZoom    = map.getZoom()    + zoomDelta;
        const newBearing = map.getBearing() + dAngle;
        const newPitch   = Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() - pitchDelta * 0.5));
        const pos        = get(vesselState).position;

        // Use center+offset instead of `around` to keep the vessel at its pinned
        // screen position. `around` triggers _calcMatrices → calcMatrices → _calcMatrices
        // infinite recursion in MapLibre's globe projection; center+offset uses
        // the same code path as the follow-mode effect and has no such issue.
        const W   = mapContainer.clientWidth;
        const H   = mapContainer.clientHeight;
        const offset: [number, number] = [followMode.offset!.left * W / 2, followMode.offset!.top * H / 2];

        map.easeTo({
          zoom:    newZoom,
          bearing: newBearing,
          pitch:   newPitch,
          ...(pos ? { center: [pos.longitude, pos.latitude] as [number, number], offset } : {}),
          duration: 0,
        });
      };

      const onTPUp = (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        tp     = tp.filter(p => p.id !== e.pointerId);
        prevDist = NaN;
      };

      // Prevent the browser's native pinch-to-zoom. MapLibre's touchZoomRotate handler
      // normally does this by calling preventDefault() on touchmove. With it disabled,
      // we must do it ourselves — otherwise the whole page scales instead of the map.
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length >= 2) e.preventDefault();
      };

      canvas.addEventListener('pointerdown',   onTPDown);
      canvas.addEventListener('pointermove',   onTPMove);
      canvas.addEventListener('pointerup',     onTPUp);
      canvas.addEventListener('pointercancel', onTPUp);
      canvas.addEventListener('touchmove',     onTouchMove, { passive: false });

      return () => {
        canvas.removeEventListener('pointerdown',   onPointerDown);
        canvas.removeEventListener('pointermove',   onPointerMove);
        canvas.removeEventListener('pointerup',     onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
        canvas.removeEventListener('contextmenu',   onContextMenu);
        canvas.removeEventListener('pointerdown',   onTPDown);
        canvas.removeEventListener('pointermove',   onTPMove);
        canvas.removeEventListener('pointerup',     onTPUp);
        canvas.removeEventListener('pointercancel', onTPUp);
        canvas.removeEventListener('touchmove',     onTouchMove);
        map!.touchPitch.enable();
        map!.touchZoomRotate.enable();
        map!.touchZoomRotate.enableRotation();
        map!.dragRotate.enable();
      };
    }

    return () => {
      canvas.removeEventListener('pointerdown',   onPointerDown);
      canvas.removeEventListener('pointermove',   onPointerMove);
      canvas.removeEventListener('pointerup',     onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('contextmenu',   onContextMenu);
      map!.dragRotate.enable();
      map!.touchZoomRotate.enableRotation();
    };
  });


  // Follow + rotation mode: combined into one effect so we never issue two competing
  // easeTo/flyTo calls in the same reactive flush.
  //
  // HDG follow: easeTo at compass rate — short duration so frames chain into smooth rotation.
  //   - Initial snap (mode just switched): longer ease-out so the map glides to heading bearing.
  //   - Continuous tracking: quadratic ease-out (t*(2-t)). During active rotation the DeviceOrientation
  //     API fires at ~50Hz so each 200ms animation is interrupted after ~20ms — always in the fast early
  //     phase, keeping the map lag-free. When the compass stabilises the final frame plays out fully and
  //     the ease-out gives a smooth deceleration instead of an abrupt stop.
  // Other follow modes: easeTo/flyTo only when position or mode changes (~1Hz GPS rate).
  // Non-follow: easeTo for bearing — short animation, touch-safe.
  $effect(() => {
    if (!map) return;
    const state = $vesselState;
    const pos = state.position;
    const rm = rotateMode.mode;
    const following = followMode.following;

    // Compute target bearing.
    let bearing: number | undefined;
    if (rm === 'north') bearing = 0;
    else if (rm === 'cog'     && state.cog     !== null) bearing = (state.cog     * 180 / Math.PI);
    else if (rm === 'heading' && state.heading  !== null) bearing = (state.heading * 180 / Math.PI);
    else if (rm === 'bearing' && pos !== null && route.nextPoint !== null) {
      bearing = gcBearingDeg(pos.longitude, pos.latitude, route.nextPoint.longitude, route.nextPoint.latitude);
    }
    const posChanged = pos !== null && (pos.longitude !== _easedLon || pos.latitude !== _easedLat);
    const rmChanged  = rm !== _lastRm;
    if (posChanged) { _easedLon = pos.longitude; _easedLat = pos.latitude; }
    _lastRm = rm;

    if (pos && following) {
      const W = mapContainer.clientWidth;
      const H = mapContainer.clientHeight;
      const offset : [number, number] = [
        followMode.offset!.left * W/2,
        followMode.offset!.top * H/2,
      ];
      if (posChanged || rmChanged || rm === 'heading' || rm === 'cog') {
        const center = map.getCenter();
        const dist = Math.hypot(center.lng - pos.longitude, center.lat - pos.latitude);
        const bOpts = bearing !== undefined ? { bearing } : {};
        if (dist > 1) {
          map.flyTo({ center: [pos.longitude, pos.latitude], speed: 1.5, offset, ...bOpts });
        } else {
          map.easeTo({ center: [pos.longitude, pos.latitude], duration: 1000, offset, ...bOpts });
        }
      }
    } else if (bearing !== undefined && !_isInteracting) {
      // Not following: smooth bearing transition.
      if (bearing !== _lastNonFollowBearing || rmChanged) {
        map.easeTo({ bearing, duration: 300 });
        _lastNonFollowBearing = bearing;
      }
    }
  });

  // Lock interaction in follow mode:
  //   - Pan drag disabled.
  //   - Custom wheel handler zooms around the vessel, not the cursor. Uses rAF
  //     accumulation so rapid scroll events batch into a single easeTo per frame,
  //     matching MapLibre's native speed and feel. Two-finger trackpad scroll
  //     generates wheel events too, so this path covers it automatically.
  //   - Custom zoom buttons call zoomIn/Out({ around: vessel }) directly so no
  //     correction is needed. Touch pinch and keyboard zoom are handled by a
  //     `zoomend` listener that re-anchors the vessel to its pinned screen pixel.
  //   - Rotation (right-click drag, two-finger rotate) remains active throughout.
  $effect(() => {
    if (!map) return;

    if (!followMode.following) {
      map.dragPan.enable();
      map.scrollZoom.enable();
      return;
    }

    map.dragPan.disable();
    map.scrollZoom.disable();

    // Wheel accumulation state — local to this effect run.
    let wheelDelta  = 0;
    let zoomTarget: number | null = null;   // ongoing scroll zoom target
    let wheelRaf:   number | null = null;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;

    // Rate constants mirror MapLibre's ScrollZoomHandler.
    const WHEEL_RATE    = 1 / 450; // discrete scroll wheel (_wheelZoomRate)
    const TRACKPAD_RATE = 0.01;    // trackpad continuous (_defaultZoomRate)
    const WHEEL_THRESH  = 4;       // |delta| below this → trackpad heuristic

    function onWheel(e: WheelEvent): void {
      e.preventDefault();
      let dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 * e.deltaY : e.deltaY;
      if (e.shiftKey) dy /= 4;
      wheelDelta -= dy; // accumulate: up = negative deltaY = positive delta = zoom in

      // Debounce: keep scrollActive true until 350 ms after last wheel event so
      // the zoomend handler does not interfere with our own easeTo animation.
      if (scrollTimer !== null) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        zoomTarget  = null; // animation settled; next scroll starts fresh
      }, 350);

      if (wheelRaf !== null) return; // already scheduled this frame
      wheelRaf = requestAnimationFrame(() => {
        wheelRaf = null;
        if (!map) return;
        const pos = get(vesselState).position;
        if (!pos) return;
        const delta = wheelDelta;
        wheelDelta = 0;
        const rate = Math.abs(delta) > WHEEL_THRESH ? WHEEL_RATE : TRACKPAD_RATE;
        let scale = 2 / (1 + Math.exp(-Math.abs(delta * rate)));
        if (delta < 0) scale = 1 / scale; // negative accumulated delta → zoom out
        // Use zoomTarget as base so rapid scroll accumulates correctly even while
        // a previous easeTo animation is still in flight.
        zoomTarget = (zoomTarget ?? map.getZoom()) + Math.log2(scale);
        const W = mapContainer.clientWidth;
        const H = mapContainer.clientHeight;
        const offset: [number, number] = [followMode.offset!.left * W / 2, followMode.offset!.top * H / 2];
        map.easeTo({ zoom: zoomTarget, center: [pos.longitude, pos.latitude], offset, duration: 0 });
      });
    }

    // After any external zoom (scroll wheel, double-click, gesture), re-anchor
    // the vessel to its pinned screen pixel.
    // Re-entry guard: in globe projection easeTo({ center, offset }) internally
    // adjusts zoom to compensate for globe curvature at the new latitude, which
    // fires another zoomend → infinite recursion without this flag.
    let reanchoring = false;
    function onZoomEnd(): void {
      if (scrollTimer !== null) return; // our own scroll animation is still active
      if (reanchoring) return;
      const pos = get(vesselState).position;
      if (!pos || !map) return;
      const W = mapContainer.clientWidth;
      const H = mapContainer.clientHeight;
      const offset: [number, number] = [followMode.offset!.left * W / 2, followMode.offset!.top * H / 2];
      reanchoring = true;
      map.easeTo({ center: [pos.longitude, pos.latitude], offset, duration: 0 });
      reanchoring = false;
    }

    mapContainer.addEventListener('wheel', onWheel, { passive: false });
    map.on('zoomend', onZoomEnd);

    return () => {
      mapContainer.removeEventListener('wheel', onWheel);
      map?.off('zoomend', onZoomEnd);
      if (wheelRaf   !== null) cancelAnimationFrame(wheelRaf);
      if (scrollTimer !== null) clearTimeout(scrollTimer);
    };
  });
</script>

<div bind:this={mapContainer} style="width: 100%; height: 100%;"></div>

{#if movingWaypoint}
  <div class="move-waypoint-hint">
    Tap new location for <strong>{movingWaypoint.name || 'waypoint'}</strong>
    <button onclick={() => { movingWaypoint = null; mapContainer.style.cursor = ''; }}>Cancel</button>
  </div>
{/if}

<!-- Compass: always visible; clicking cycles rotation mode (N → COG → HDG → BRG → MAN → N).
     The needle rotates with map bearing so it always points toward true North. -->
<button
  class="north-indicator"
  title="Rotation: {rotateMode.label}"
  onclick={() => { rotateMode.toggle($vesselState.cog !== null, $vesselState.heading !== null, route.nextPoint !== null); }}
  aria-label="Rotation mode: {rotateMode.label}"
>
  <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
    <circle cx="22" cy="22" r="21"
      fill="rgba(0,0,0,0.72)"
      stroke="rgba(255,255,255,0.18)"
      stroke-width="1.5"/>
    <g transform="rotate({-mapBearing}, 22, 22)">
      <polygon points="22,5 17,23 22,20 27,23" fill="#e53e3e"/>
      <polygon points="22,39 17,21 22,24 27,21" fill="rgba(200,200,200,0.75)"/>
    </g>
    <text x="22" y="15.5" text-anchor="middle" font-size="7" font-family="system-ui,sans-serif"
      fill="rgba(255,255,255,0.55)" transform="rotate({-mapBearing}, 22, 22)">N</text>
  </svg>
</button>

{#if rulerPopup}
<div
  class="ruler-popup"
  role="dialog"
  aria-label="Ruler options"
  tabindex="-1"
  style="left: {rulerPopup.x}px; top: {rulerPopup.y}px;"
  onpointerdown={(e) => { e.stopPropagation(); }}
>
  <button
    class="ruler-popup-remove"
    onclick={() => { if (rulerPopup) { rulers.remove(rulerPopup.rulerId); rulerPopup = null; } }}
  >Remove</button>
</div>
{/if}

<style>
  .ruler-popup {
    position: fixed;
    z-index: 20;
    transform: translate(-50%, calc(-100% - 8px));
    background: #1e1e2e;
    border: 1px solid #444466;
    border-radius: 8px;
    padding: 6px 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    pointer-events: all;
  }
  .ruler-popup-remove {
    background: #e53e3e;
    color: white;
    border: none;
    border-radius: 5px;
    padding: 6px 16px;
    font-size: 14px;
    cursor: pointer;
    font-weight: 600;
    transition: background 0.15s;
  }
  @media (hover: hover) and (pointer: fine) {
    .ruler-popup-remove:hover { background: #c53030; }
  }

  .north-indicator {
    position: absolute;
    top: 80px;
    right: 10px;
    z-index: 10;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    border-radius: 50%;
    transition: opacity 0.15s ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .north-indicator:hover { opacity: 0.8; }
    /* circle fill is set inline; darken on hover via brightness filter */
    .north-indicator:hover svg { filter: brightness(1.25); }
  }

  :global(.ais-popup) {
    font-family: system-ui, sans-serif;
    font-size: 12px;
    color: #e0e0f0;
    min-width: 180px;
  }
  :global(.ais-popup-title) {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #f59e0b;
    border-bottom: 1px solid #444;
    padding-bottom: 5px;
  }
  :global(.ais-popup table) {
    border-collapse: collapse;
    width: 100%;
  }
  :global(.ais-popup td) {
    padding: 2px 6px 2px 0;
    vertical-align: top;
  }
  :global(.ais-popup td:first-child) {
    color: #888;
    white-space: nowrap;
    padding-right: 12px;
  }
  :global(.ais-section) {
    font-size: 10px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding-top: 8px;
  }
  :global(.ais-links) {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #333;
  }
  :global(.ais-links a) {
    font-size: 11px;
    color: #60a5fa;
    text-decoration: none;
    flex: 1;
    text-align: center;
    padding: 3px 0;
    border-radius: 4px;
    background: rgba(96,165,250,0.1);
  }
  @media (hover: hover) and (pointer: fine) {
    :global(.ais-links a:hover) {
      background: rgba(96,165,250,0.2);
    }
  }
  :global(.maplibregl-popup-content) {
    background: #1e1e2e;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    padding: 12px 14px;
  }
  :global(.ais-disambig-list) {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  :global(.ais-disambig-item) {
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    color: #e0e0f0;
    transition: background 0.12s;
    white-space: nowrap;
  }
  @media (hover: hover) and (pointer: fine) {
    :global(.ais-disambig-item:hover) {
      background: rgba(96, 165, 250, 0.18);
      color: #93c5fd;
    }
  }
  :global(.maplibregl-popup-tip) { border-top-color: #1e1e2e; }
  :global(.maplibregl-popup-close-button) { color: #888; font-size: 16px; }
  /* Ensure MapLibre popups (DOM elements) always render above the deck.gl WebGL canvas */
  :global(.maplibregl-popup) { z-index: 10; }
  :global(.vessel-self-settings-btn),
  :global(.popup-settings-btn) {
    display: block;
    width: 100%;
    padding: 7px 14px;
    background: rgba(96,165,250,0.15);
    color: #60a5fa;
    border: 1px solid rgba(96,165,250,0.3);
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    text-align: center;
  }
  @media (hover: hover) and (pointer: fine) {
    :global(.vessel-self-settings-btn:hover),
    :global(.popup-settings-btn:hover) {
      background: rgba(96,165,250,0.28);
    }
  }
  :global(.popup-settings-btn:disabled) {
    opacity: 0.45;
    cursor: not-allowed;
  }
  :global(.ais-popup-coords) {
    font-family: monospace;
    font-size: 11px;
    color: #9ca3af;
    margin-bottom: 8px;
    text-align: center;
  }

  .move-waypoint-hint {
    position: absolute;
    bottom: 32px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75);
    color: #fff;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: auto;
    z-index: 10;
  }
  .move-waypoint-hint button {
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.3);
    color: #fff;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 12px;
  }
  /* MapLibre's ctrl containers use float+clear layout, not flexbox.
     Switch bottom-left to a flex row so zoom buttons and scale sit side-by-side.
     float and clear on flex items are ignored, so MapLibre's per-ctrl rules are harmless.
     The zoom group has `maplibregl-ctrl` class for pointer-events:auto and margin. */
  :global(.maplibregl-ctrl-bottom-left) {
    display: flex !important;
    flex-direction: row !important;
    align-items: flex-end !important;
  }
  :global(.zoom-ctrl-group) {
    display: flex;
    gap: 2px;
  }
  :global(.zoom-ctrl-btn) {
    width: 26px;
    height: 26px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  @media (hover: hover) and (pointer: fine) {
    :global(.zoom-ctrl-btn:hover) { background: rgba(40, 40, 80, 0.9); }
  }
  :global(.zoom-ctrl-btn:active) { background: rgba(60, 60, 120, 0.95); }
  /* MapLibre's own CSS applies:
   *   @media (hover:hover) { .maplibregl-ctrl button:not(:disabled):hover { background-color: rgba(0,0,0,.05) } }
   * That rule has specificity 0,3,1 — higher than our .zoom-ctrl-btn:hover (0,2,0) — and only
   * guards on hover:hover, not pointer:fine. So on touch devices that still report hover:hover
   * (e.g. phones with a stylus) it fires and makes the button transparent. We counter it with
   * the same specificity (0,3,1) scoped to coarse/no-hover devices so source-order gives us the win. */
  @media (hover: none), (pointer: coarse) {
    :global(.maplibregl-ctrl button.zoom-ctrl-btn:hover) {
      background: rgba(0, 0, 0, 0.7);
    }
  }

</style>
