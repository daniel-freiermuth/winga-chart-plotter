<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import type { HitTarget, Gesture, DragTarget, Interactable } from '$lib/gesture.ts';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import type * as GeoJSON from 'geojson';
  import { get } from 'svelte/store';
  import { vesselState, vesselPosition } from '../stores/vessel';
  import { settings, type SettingsTab } from '../stores/settings.svelte';
  import { fpsStore } from '../stores/fps.svelte';
  import { followMode, type FollowOffset } from '../stores/follow.svelte';
  import { rotateMode } from '../stores/rotateMode.svelte';
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';
  import { ais, AIS_HOT_STRIDE, AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG, AIS_F_ROT, AIS_F_AGE } from '../stores/ais.svelte';
  import type { AisTarget } from '../stores/ais.svelte';
  import { MapboxOverlay } from '@deck.gl/mapbox';
  import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
  import type { Layer } from '@deck.gl/core';
  import { rulers, rulerBearingText, rulerDistanceText, type Ruler } from '../stores/rulers.svelte';
  import { routePlanner } from '../stores/routePlanner.svelte';
  import { route } from '../stores/route.svelte';
  import { routes } from '../stores/routes.svelte';
  import { waypoints } from '../stores/waypoints.svelte';
  import { track } from '../stores/track.svelte';
  import { gcLine, gcBearingDeg, gcDistanceNm } from '../lib/wasmGeo';
  import { fetchAndResolveStyle } from '../lib/resolveStyle';
  import { auth } from '../stores/auth.svelte';
  import { fetchAisVesselTrack, navigateToPoint, clearCourse, activateRoute, setActiveRoutePointIndex, deleteRoute, saveWaypoint, updateWaypoint, deleteWaypoint } from '../lib/wasmRest';
  import { extrapolatePos } from '../lib/deadReckoning';
  import { resolveDisambigEntry } from '../lib/disambig';
  import { SvelteMap } from 'svelte/reactivity';
  import { mapView, loadSavedView } from '../stores/mapView.svelte';
  import { visibility } from '../stores/visibility.svelte';
  import { buildTrackGradient, processTrack, processRouteCoords, splitRouteSegments } from '../lib/trackProcessing';
  import { hexToRgba, dashArray } from '../lib/mapStyles';
  import { buildAisLayers } from '../lib/aisLayerBuilder';
  import { buildCpaLayers, formatCpaLabel, type SkCpaInput } from '../lib/aisCpaLayer';
  import { computeCpa } from '../lib/wasmGeo';
  import { buildOwnVesselLayers, buildCourseLayers } from '../lib/vesselLayers';
  import ZoomSlider from './ZoomSlider.svelte';

  const {
    openSettings = () => { /* noop */ },
    onMapClick   = () => { /* noop */ },
  }: {
    openSettings?: (tab: SettingsTab) => void;
    onMapClick?:   () => void;
  } = $props();

  const DEFAULT_STYLE: maplibregl.StyleSpecification = {
    version: 8,
    projection: { type: 'mercator' },
    sources: {
      'osm-tiles':        { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' },
      'openseamap':       { type: 'raster', tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'], tileSize: 256 },
      'watercolor-tiles': { type: 'raster', tiles: ['https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg'], tileSize: 256, maxzoom: 16, attribution: 'Map tiles by <a href="https://stamen.com">Stamen Design</a>, under <a href="https://creativecommons.org/licenses/by/3.0">CC BY 3.0</a>. Data by <a href="https://openstreetmap.org">OpenStreetMap</a>. Tiles hosted by <a href="https://stadiamaps.com">Stadia Maps</a>.' },
    },
    layers: [
      { id: 'osm',        type: 'raster', source: 'osm-tiles' },
      { id: 'seamarks',   type: 'raster', source: 'openseamap' },
      { id: 'watercolor', type: 'raster', source: 'watercolor-tiles', layout: { visibility: 'none' } },
    ],
  };

  let mapContainer: HTMLDivElement;
  let map = $state.raw<maplibregl.Map | undefined>(undefined);
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
  function zoomIn() {
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
  function zoomOut() {
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
  // CPA visualization deck.gl layers (projection lines, ghost dots).
  let cpaLayerGroup: Layer[] = [];
  // MapLibre mini-label popup near the selected vessel showing CPA/TCPA.
  let cpaLabelPopup: maplibregl.Popup | null = null;

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
  // True when the preceding camera move was started by a user gesture (set in movestart,
  // consumed and cleared in moveend). Distinct from _isInteracting so moveend can still
  // read it after _isInteracting has been cleared.
  let _wasUserPan = false;
  // True while at least one finger is physically on the screen. Set earlier than
  // _isInteracting (which waits for movestart after the drag threshold). Prevents
  // the vessel-follow easeTo from firing in the touchstart→movestart gap, where a
  // competing camera movestart confuses MapLibre's DragPanHandler and silently
  // drops the pending drag — the "panning fails every ~1 s in follow mode" bug.
  let _touchActive = false;
  // True once the user has panned/zoomed/rotated the map by hand (gesture, not programmatic
  // easeTo/flyTo) — for the lifetime of this page load, never reset. Gates the one-shot
  // auto-fly-to-vessel below: once the user has shown intent to look elsewhere, never yank
  // the camera out from under them again this session.
  let _userHasInteracted = false;
  // One-shot guard: fires at most once per page load, the first time a real Signal K
  // position arrives while the user hasn't touched the map yet.
  let _didAutoFlyToFirstFix = false;
  // One-shot guard: the restored rotation mode (from localStorage) must not be collapsed
  // by ensureAvailable() just because cog/heading/route haven't arrived yet on a fresh
  // page load — that data starting out null means "not received yet", not "lost".
  let _receivedVesselData = false;

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

  /** Close any open MapLibre popup (e.g. before opening a settings panel). */
  export function closePopup(): void { activePopup?.remove(); }


  /** Fit the map to a bounding box [west, south, east, north]. Used by extension map.fitBounds. */
  export function fitBounds(bounds: [number, number, number, number]): void {
    map?.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 20 });
  }

  /** Add a new ruler in the lower third of the screen, endpoints ¼ screen-width apart. */
  export function addRuler() {
    if (!map) return;
    activePopup?.remove();
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

  // True while the cursor is over a ruler handle — dragPan disabled proactively on hover.
  let isHoveringHandle = false;
  // Ruler label popup: shown when user clicks a label; holds screen position and ruler id.
  let rulerPopup = $state<{ rulerId: string; x: number; y: number } | null>(null);
  // Planner handle popup: shown when user taps a route-planner waypoint handle.
  let plannerHandlePopup = $state<{ idx: number; x: number; y: number } | null>(null);
  // Drag FSM — only two phases needed. map.on('click') handles all taps (mouse + touch);
  // the long-press timer below handles touch long-press. No tap state, no panning state.
  type GesturePhase =
    | { phase: 'idle' }
    | { phase: 'dragging'; target: DragTarget; pointerId: number; moved: boolean; downX: number; downY: number }
  let gesturePhase: GesturePhase = { phase: 'idle' };
  const LONG_PRESS_MS = 500;


  // Close the ruler popup on any pointer interaction outside it.
  // The popup div calls e.stopPropagation() on its own pointerdown, so this bubble-phase
  // listener only fires for events that originate outside the popup element.
  $effect(() => {
    if (!rulerPopup) return;
    const dismiss = () => { rulerPopup = null; };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); };
  });
  $effect(() => {
    if (!plannerHandlePopup) return;
    const dismiss = () => { plannerHandlePopup = null; };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); };
  });
  // Close any open MapLibre popup when the route planner activates.
  $effect(() => { if (routePlanner.active) activePopup?.remove(); });
  $effect(() => { if (!routePlanner.active) plannerHandlePopup = null; });


  // At most one MapLibre popup open at a time — each new popup closes the previous one.
  let activePopup: maplibregl.Popup | null = null;
  function openPopup(p: maplibregl.Popup): maplibregl.Popup {
    activePopup?.remove();
    activePopup = p;
    p.on('close', () => { if (activePopup === p) activePopup = null; });
    return p;
  }

  // Waypoint being relocated: next map click sets its new position.
  let movingWaypoint: { uuid: string; name: string } | null = $state(null);

  function setHandleHover(hovering: boolean) {
    if (hovering === isHoveringHandle) return;
    isHoveringHandle = hovering;
    mapContainer.style.cursor = hovering ? 'grab' : '';
    if (hovering) {
      map?.dragPan.disable();
    } else if (gesturePhase.phase !== 'dragging') {
      map?.dragPan.enable();
    }
  }

  // ─── Gesture Recognizer ────────────────────────────────────────────────────
  //
  // Each Interactable owns its pick logic and its HitTarget behavior.
  // INTERACTIONS defines priority order — first match wins.
  // hit() iterates them; handleGesture() dispatches to the matched target.

  const plannerHandleInteractable: Interactable = {
    pick(x, y) {
      if (!overlay || !routePlanner.active) return null;
      const p = overlay.pickObject({ x, y, radius: 18, layerIds: ['planner-handles'] });
      if (p?.object == null) return null;
      const { idx } = p.object as { idx: number };
      return {
        kind: 'planner-handle',
        drag: {
          snapsToTargets: false,
          onMove:    (lngLat) => { routePlanner.moveWaypoint(idx, lngLat.lng, lngLat.lat); },
          onEnd:     () => { /* position committed during onMove */ },
          onCancel:  () => { /* noop */ },
        },
        onTap:         (_, clientX, clientY) => { plannerHandlePopup = { idx, x: clientX, y: clientY }; },
        onContextMenu: () => { routePlanner.removeWaypoint(idx); },
      };
    },
  };

  const plannerSegmentInteractable: Interactable = {
    pick(x, y) {
      if (!overlay || !routePlanner.active) return null;
      const p = overlay.pickObject({ x, y, radius: 16, layerIds: ['planner-line'] });
      if (p?.object == null) return null;
      const { segIdx } = p.object as { segIdx: number };
      return {
        kind: 'planner-segment',
        onTap:         (lngLat) => { routePlanner.insertWaypoint(segIdx + 1, lngLat.lng, lngLat.lat); },
        onContextMenu: () => { /* noop */ },
      };
    },
  };

  const rulerLabelInteractable: Interactable = {
    pick(x, y) {
      if (!overlay) return null;
      if (routePlanner.active) return null;
      const p = overlay.pickObject({ x, y, radius: 20, layerIds: ['ruler-labels'] });
      if (!p?.object) return null;
      const rulerId = (p.object as { ruler: { id: string } }).ruler.id;
      return {
        kind: 'ruler-label',
        onTap:         (_, clientX, clientY) => { rulerPopup = { rulerId, x: clientX, y: clientY }; },
        onContextMenu: () => { /* noop */ },
      };
    },
  };

  const rulerHandleInteractable: Interactable = {
    pick(x, y) {
      if (!overlay) return null;
      if (routePlanner.active) return null;
      const p = overlay.pickObject({ x, y, radius: 16, layerIds: ['ruler-handles'] });
      if (!p?.object) return null;
      const { rulerId, endpoint } = p.object as { rulerId: string; endpoint: 'a' | 'b' };
      return {
        kind: 'ruler-handle',
        drag: {
          snapsToTargets: true,
          onMove:    (lngLat) => { rulers.moveEndpoint(rulerId, endpoint, lngLat.lng, lngLat.lat); },
          onEnd:     (lngLat, snapId) => { rulers.snapEndpoint(rulerId, endpoint, snapId, lngLat.lng, lngLat.lat); },
          onCancel:  () => { /* noop */ },
        },
        onTap:         () => { /* noop */ },
        onContextMenu: () => { /* noop */ },
      };
    },
  };

  const ownVesselInteractable: Interactable = {
    pick(x, y) {
      if (!overlay) return null;
      if (routePlanner.active) return null;
      if (overlay.pickMultipleObjects({ x, y, radius: 5, layerIds: ['own-vessel-icon'] }).length === 0) return null;
      return {
        kind: 'own-vessel',
        onTap:         (lngLat) => { showOwnVesselPopup(lngLat); },
        onContextMenu: () => { /* noop */ },
      };
    },
  };

  const aisVesselInteractable: Interactable = {
    pick(x, y) {
      if (!overlay) return null;
      if (routePlanner.active) return null;
      const hits = overlay.pickMultipleObjects({ x, y, radius: 5, layerIds: ['ais-confirmed-main', 'ais-ghost-main', 'ais-mob-icon'] });
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const seen = new Set<number>();
      const uniq: { idx: number; coord: [number, number] }[] = [];
      for (const p of hits) {
        const idx = p.object as number | null | undefined;
        if (idx == null || seen.has(idx)) continue;
        seen.add(idx);
        if (p.coordinate) uniq.push({ idx, coord: p.coordinate as [number, number] });
      }
      if (uniq.length === 1) {
        const { idx } = uniq[0]!;
        return {
          kind: 'ais-vessel',
          onTap: () => {
            const t = ais.getTarget(idx);
            if (t?.position) handleAisClick(t);
          },
          onContextMenu: () => { /* noop */ },
        };
      }
      if (uniq.length > 1) {
        const coord = uniq[0]!.coord;
        const indices = uniq.map(h => h.idx);
        return {
          kind: 'ais-vessels-ambig',
          onTap:         () => { openDisambigPopup(coord, indices); },
          onContextMenu: () => { /* noop */ },
        };
      }
      return null;
    },
  };

  const waypointInteractable: Interactable = {
    pick(x, y) {
      if (!map) return null;
      if (routePlanner.active) return null;
      const feats = map.queryRenderedFeatures([[x-12, y-12], [x+12, y+12]] as [[number,number],[number,number]], { layers: ['all-waypoints-circle'] });
      if (feats.length === 0) return null;
      const feature = feats[0]!;
      return {
        kind: 'waypoint',
        onTap:         (lngLat) => { showWaypointPopup(lngLat, feature); },
        onContextMenu: () => { /* noop */ },
      };
    },
  };

  const activeRouteInteractable: Interactable = {
    pick(x, y) {
      if (!overlay || !map) return null;
      if (routePlanner.active) return null;
      const routeLine = overlay.pickObject({ x, y, radius: 16, layerIds: ['route-full', 'route-leg', 'route-bearing'] });
      const routeWpts = map.queryRenderedFeatures([[x-12, y-12], [x+12, y+12]] as [[number,number],[number,number]], { layers: ['route-waypoints'] });
      if (!routeLine?.object && routeWpts.length === 0) return null;
      const wptFeat = routeWpts[0];
      return {
        kind: 'active-route',
        onTap:         (lngLat) => { showActiveRoutePopup(lngLat, wptFeat); },
        onContextMenu: () => { /* noop */ },
      };
    },
  };

  const routeInteractable: Interactable = {
    pick(x, y) {
      if (!map) return null;
      if (routePlanner.active) return null;
      const feats = map.queryRenderedFeatures([[x-16, y-16], [x+16, y+16]] as [[number,number],[number,number]], { layers: ['all-routes-line'] });
      if (feats.length === 0) return null;
      const feature = feats[0]!;
      return {
        kind: 'route',
        onTap:         (lngLat) => { showAllRoutesPopup(lngLat, feature); },
        onContextMenu: () => { /* noop */ },
      };
    },
  };

  /** Priority-ordered registry of all interactive elements on the map canvas.
   *  To add a new element: write one Interactable and insert it at the right position. */
  const INTERACTIONS: Interactable[] = [
    plannerHandleInteractable,
    plannerSegmentInteractable,
    rulerLabelInteractable,
    rulerHandleInteractable,
    ownVesselInteractable,
    aisVesselInteractable,
    waypointInteractable,
    activeRouteInteractable,
    routeInteractable,
  ];

  /** Iterates INTERACTIONS in priority order; returns the first match or null. */
  function hit(x: number, y: number): HitTarget | null {
    if (!overlay || !map) return null;
    try {
      for (const i of INTERACTIONS) {
        const t = i.pick(x, y);
        if (t) return t;
      }
    } catch { /* transient overlay state during style reload */ }
    return null;
  }

  /** Single dispatcher — the only place application actions are triggered.
   *  For concrete targets, routes to the target's own behavior methods.
   *  Exhaustive on Gesture; the satisfies-never default enforces coverage. */
  function handleGesture(g: Gesture): void {
    switch (g.type) {
      case 'tap':
        rulerPopup = null;
        plannerHandlePopup = null;
        activePopup?.remove();
        // Clear AIS selection whenever the user taps anything that isn't an AIS vessel.
        if (g.target.kind !== 'ais-vessel' && g.target.kind !== 'ais-vessels-ambig') ais.clear();
        g.target.onTap(g.lngLat, g.clientX, g.clientY);
        return;
      case 'long-press':
        rulerPopup = null;
        plannerHandlePopup = null;
        if (!routePlanner.active) showNavigatePopup(g.lngLat);
        return;
      case 'drag-start':
        rulerPopup = null;
        plannerHandlePopup = null;
        return;
      case 'drag-move':
        g.target.drag.onMove(g.lngLat);
        return;
      case 'drag-end':
        g.target.drag.onEnd(g.lngLat, g.snapId);
        return;
      case 'drag-cancel':
        g.target.drag.onCancel();
        return;
      case 'context-menu':
        rulerPopup = null;
        plannerHandlePopup = null;
        if (g.target) g.target.onContextMenu(g.lngLat);
        else if (!routePlanner.active) showNavigatePopup(g.lngLat);
        return;
      default:
        g satisfies never;
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!overlay || !map) return;
    // Right-click and other non-primary buttons go to contextmenu.
    if (e.button !== 0) return;
    // Second+ finger: cancel any active drag and let MapLibre handle pinch-zoom.
    if (!e.isPrimary) {
      if (gesturePhase.phase === 'dragging') {
        mapContainer.releasePointerCapture(gesturePhase.pointerId);
        mapContainer.style.cursor = '';
        map.dragPan.enable();
        handleGesture({ type: 'drag-cancel', target: gesturePhase.target });
        gesturePhase = { phase: 'idle' };
      }
      return;
    }
    const rect = mapContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const target = hit(x, y);
    if (!target?.drag) return;  // no drag target — let MapLibre handle pan and click normally

    const dragTarget = target as DragTarget;
    map.dragPan.disable();
    mapContainer.style.cursor = 'grabbing';
    mapContainer.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
    gesturePhase = { phase: 'dragging', target: dragTarget, pointerId: e.pointerId, moved: false, downX: x, downY: y };
    handleGesture({ type: 'drag-start', target: dragTarget });
  }

  function onPointerMove(e: PointerEvent): void {
    if (!map || gesturePhase.phase !== 'dragging') return;
    const rect = mapContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    e.preventDefault(); e.stopPropagation();
    if (!gesturePhase.moved) {
      if (Math.hypot(x - gesturePhase.downX, y - gesturePhase.downY) <= 4) return;
      gesturePhase.moved = true;
    }
    handleGesture({ type: 'drag-move', target: gesturePhase.target, lngLat: map.unproject([x, y]) });
  }

  function onPointerUp(e: PointerEvent): void {
    if (gesturePhase.phase !== 'dragging') return;
    const { target, pointerId, moved } = gesturePhase;
    const rect = mapContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mapContainer.releasePointerCapture(pointerId);
    mapContainer.style.cursor = isHoveringHandle ? 'grab' : '';
    if (!isHoveringHandle) map?.dragPan.enable();
    gesturePhase = { phase: 'idle' };
    if (!moved) {
      // Zero-movement release — treat as a tap on the drag target.
      handleGesture({ type: 'tap', target, lngLat: map!.unproject([x, y]), clientX: e.clientX, clientY: e.clientY });
      return;
    }
    const coord = map!.unproject([x, y]);
    let lng = coord.lng, lat = coord.lat;
    let snapId: string | undefined;
    if (target.drag.snapsToTargets) {
      // Own vessel has priority: snap to it first if within radius.
      const own = liveSnapTargets.find(t => t.id === 'own-vessel');
      if (own) {
        const pt = map!.project([own.position.longitude, own.position.latitude]);
        if (Math.hypot(pt.x - x, pt.y - y) < RULER_SNAP_PX) {
          snapId = own.id; lng = own.position.longitude; lat = own.position.latitude;
        }
      }
      // Otherwise snap to the nearest AIS target within radius.
      if (!snapId) {
        let bestDist = RULER_SNAP_PX;
        for (const t of liveSnapTargets) {
          if (t.id === 'own-vessel') continue;
          const pt = map!.project([t.position.longitude, t.position.latitude]);
          const d = Math.hypot(pt.x - x, pt.y - y);
          if (d < bestDist) { bestDist = d; snapId = t.id; lng = t.position.longitude; lat = t.position.latitude; }
        }
      }
    }
    handleGesture({ type: 'drag-end', target, lngLat: new maplibregl.LngLat(lng, lat), snapId });
  }

  function onPointerCancel(e: PointerEvent): void {
    if (gesturePhase.phase !== 'dragging') return;
    mapContainer.releasePointerCapture(e.pointerId);
    mapContainer.style.cursor = '';
    map?.dragPan.enable();
    handleGesture({ type: 'drag-cancel', target: gesturePhase.target });
    gesturePhase = { phase: 'idle' };
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
    overlay?.setProps({ layers: [...aisFiltered, ...cpaLayerGroup, ...courseLayerGroup, ...plannerLayerGroup, ...ownVesselLayerGroup, ...rulerLayerGroup] });
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
    // Seed the camera from the last-persisted view instead of a hardcoded fallback (Oslo is
    // only used the very first time the app ever runs — see loadSavedView()).
    const savedView = loadSavedView();
    map = new maplibregl.Map({
      container: mapContainer,
      style: DEFAULT_STYLE,
      center: savedView.center,
      zoom: savedView.zoom,
      bearing: savedView.bearing,
      maxPitch: 85,
      bearingSnap: 0,
      attributionControl: false,
    });

    // Scale bar in the bottom-left, alongside the compass.
    // Dynamic scale bar: nautical miles ≥ 0.5 nm, metres below.
    // Reuses MapLibre's `.maplibregl-ctrl-scale` class so all built-in styling applies.
    map.addControl((() => {
      const NM = 1852;           // metres per nautical mile
      const THRESH = 0.5 * NM;  // 926 m — switch to metres below this
      const MAX_PX = 100;        // maximum bar width in pixels (matches MapLibre default)
      const NM_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
      const M_STEPS  = [1, 2, 5, 10, 20, 50, 100, 200, 500];
      let el!: HTMLElement;
      let m!: maplibregl.Map;

      function tick() {
        const h = m.getCanvas().clientHeight / 2;
        const maxM = m.unproject([0, h]).distanceTo(m.unproject([MAX_PX, h]));
        let px: number; let label: string;
        if (maxM >= THRESH) {
          const maxNm = maxM / NM;
          const step = NM_STEPS.filter(s => s <= maxNm).at(-1) ?? 0.05;
          px = Math.round(step * NM / maxM * MAX_PX);
          label = `${String(step)} nm`;
        } else {
          const step = M_STEPS.filter(s => s <= maxM).at(-1) ?? 1;
          px = Math.round(step / maxM * MAX_PX);
          label = `${String(step)} m`;
        }
        el.style.width = `${String(px)}px`;
        el.textContent = label;
      }

      return {
        onAdd(map: maplibregl.Map): HTMLElement {
          m = map;
          el = document.createElement('div');
          el.className = 'maplibregl-ctrl maplibregl-ctrl-scale';
          m.on('move', tick);
          tick();
          return el;
        },
        onRemove(): void { m.off('move', tick); },
      };
    })(), 'bottom-left');
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
    // overlay layers visible. Far-hemisphere hull/icon artifacts are handled by the
    // per-vertex hemisphere discard in VesselMorphLayer/VesselIconLayer instead.
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
              if (!isNaN(cog) && !isNaN(sog)) {
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

    // All pointer events flow through the capture-phase gesture recognizer.
    // Taps (click/touch) are handled by map.on('click') below.
    mapContainer.addEventListener('pointerdown',   onPointerDown,   { capture: true });
    mapContainer.addEventListener('pointermove',   onPointerMove,   { capture: true });
    mapContainer.addEventListener('pointerup',     onPointerUp,     { capture: true });
    mapContainer.addEventListener('pointercancel', onPointerCancel, { capture: true });

    onFsChange = () => {
      mapView.isFullscreen = !!document.fullscreenElement;
      if (!document.fullscreenElement) {
        // When the browser exits fullscreen and re-shows its chrome, the <html>
        // element's scrollTop is left non-zero — the page shifts up by the height
        // of the re-appeared address bar, leaving a white gap at the bottom.
        // Reset it immediately; MapLibre's ResizeObserver handles canvas resize.
        window.scrollTo(0, 0);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);

    map.on('zoom',   () => { mapZoom    = map?.getZoom()    ?? mapZoom; });
    map.on('rotate', () => { mapView.updateBearing(map?.getBearing() ?? mapView.bearing); });
    // Track user interactions so programmatic easeTo calls don't interrupt gestures.
    map.on('movestart', (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) { _isInteracting = true; _wasUserPan = true; _userHasInteracted = true; rulerPopup = null; }
    });
    map.on('moveend',   () => {
      const wasPan = _wasUserPan;
      _isInteracting = false;
      _wasUserPan = false;
      // When the user panned (not a programmatic easeTo/flyTo), slide the follow offset to
      // the vessel's new screen position, or drop follow entirely if the vessel left the
      // viewport (the deliberate "pan vessel off screen = unpin" exit gesture).
      if (wasPan && followMode.following) {
        const pos = get(vesselState).position;
        if (pos) {
          const { left, top } = calcVesselOffset(pos);
          if (Math.abs(left) < 0.9 && Math.abs(top) < 0.9) {
            followMode.offset = { left, top };
          } else {
            followMode.offset = null;
          }
        }
      }
      if (map) { const c = map.getCenter(); mapView.syncView([c.lng, c.lat], map.getZoom(), map.getBearing()); }
    });

    // Cursor feedback for interactive MapLibre layers. The route-full/-leg/-bearing
    // lines moved to deck.gl (see buildCourseLayers()) and don't get hover-cursor
    // feedback here — only the click handler below picks them.
    map.on('mouseenter', 'route-waypoints', () => { if (map && !routePlanner.active) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'route-waypoints', () => { if (map) map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'all-routes-line',      () => { if (map && !routePlanner.active) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'all-routes-line',      () => { if (map) map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'all-waypoints-circle', () => { if (map && !routePlanner.active) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'all-waypoints-circle', () => { if (map) map.getCanvas().style.cursor = ''; });

    // Context-menu re-hit-tests at the event position; each target's onContextMenu handles its own action.
    map.on('contextmenu', (e) => {
      const { x, y } = e.point;
      const target = hit(x, y);
      handleGesture({ type: 'context-menu', target, lngLat: e.lngLat });
    });

    // Long-press (touch only) → navigate popup.
    // map.on('contextmenu') is unreliable on touch; manual timer is more reliable.
    {
      let longPressTimer: ReturnType<typeof setTimeout> | null = null;
      let longPressLngLat: maplibregl.LngLat | null = null;
      let startX = 0, startY = 0;
      const LONG_PRESS_MOVE_PX = 20;

      map.on('touchstart', (e) => {
        _touchActive = true;  // finger is down — suppress vessel easeTo until lifted
        if (e.originalEvent.touches.length !== 1) {
          if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
          return;
        }
        const { x, y } = e.point;
        if (hit(x, y)?.drag) return;  // drag handles start a drag, not a long-press
        const touch = e.originalEvent.touches[0]!;
        startX = touch.clientX; startY = touch.clientY;
        longPressLngLat = e.lngLat;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (longPressLngLat) handleGesture({ type: 'long-press', lngLat: longPressLngLat });
        }, LONG_PRESS_MS);
      });
      const cancelLong = () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      };
      map.on('touchmove', (e) => {
        if (!longPressTimer) return;
        const touch = e.originalEvent.touches[0];
        if (!touch) return;
        if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > LONG_PRESS_MOVE_PX) cancelLong();
      });
      map.on('touchend',    (e) => { if (e.originalEvent.touches.length === 0) _touchActive = false; cancelLong(); });
      map.on('touchcancel', (e) => { if (e.originalEvent.touches.length === 0) _touchActive = false; cancelLong(); });
    }

    // Unified click/tap dispatcher — handles both mouse clicks and touch taps.
    // map.on('click') fires for both input types; MapLibre's TapRecognizer normalises them
    // and suppresses the event after a pan on either device. Popups opened here are safe
    // from the closeOnClick race: Evented.fire() snapshots listeners before dispatch, so
    // a closeOnClick handler registered inside this callback only fires on the next click.
    map.on('click', (e) => {
      if (!overlay || gesturePhase.phase === 'dragging') return;
      onMapClick();
      const { x, y } = e.point;
      const rect = mapContainer.getBoundingClientRect();
      if (movingWaypoint) {
        const { uuid, name } = movingWaypoint;
        movingWaypoint = null;
        mapContainer.style.cursor = '';
        updateWaypoint(settings.signalkHttpUrl, uuid, name, e.lngLat.lat, e.lngLat.lng, auth.authHeaders)
          .then(() => waypoints.load(settings.signalkHttpUrl))
          .catch((err: unknown) => { console.error('[waypoint] Failed to move:', err); });
        return;
      }
      const target = hit(x, y);
      if (!target) {
        activePopup?.remove();
        ais.clear();
        if (routePlanner.active) routePlanner.addWaypoint(e.lngLat.lng, e.lngLat.lat);
        return;
      }
      handleGesture({ type: 'tap', target, lngLat: e.lngLat, clientX: rect.left + x, clientY: rect.top + y });
    });

    // Hover: update cursor and proactively disable dragPan over drag handles so the user
    // can start dragging immediately without accidentally triggering a pan first.
    map.on('mousemove', (e) => {
      if (!overlay) return;
      const { x, y } = e.point;
      try {
        const layers = routePlanner.active ? ['planner-handles'] : ['ruler-handles'];
        setHandleHover(!!overlay.pickObject({ x, y, radius: 16, layerIds: layers })?.object);
      } catch { /* transient overlay state during style reload */ }
    });


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
          'circle-radius':       ['match', ['get', 'wtype'], 'next', 10, 8],
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
          'circle-radius':       8,
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
      mapView.updateBearing(m.getBearing());
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
    mapContainer.removeEventListener('pointerdown',   onPointerDown,   { capture: true });
    mapContainer.removeEventListener('pointermove',   onPointerMove,   { capture: true });
    mapContainer.removeEventListener('pointerup',     onPointerUp,     { capture: true });
    mapContainer.removeEventListener('pointercancel', onPointerCancel, { capture: true });
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
          <button class="popup-settings-btn route-here-btn"
            data-lat="${String(t.position.latitude)}" data-lon="${String(t.position.longitude)}">
            ${routePlanner.active ? 'Add to route' : 'Start route from here'}
          </button>
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

  function handleAisClick(t: AisTarget): void {
    if (!map) return;
    if (ais.selectedId === t.id && ais.selectionPhase === 'highlighted') {
      // Second click on the same vessel → elevate to popup.
      ais.elevateToPopup();
      openAisPopup(t);
      return;
    }
    // First click (new vessel or re-clicking a popup vessel) → highlight only.
    // Cancel any in-flight track fetch and clear existing track.
    _aisTrackGen++;
    aisTrackRaw = [];
    if (aisAgeTimer !== null) { clearInterval(aisAgeTimer); aisAgeTimer = null; }
    ais.highlight(t.id);
    // Fetch position history; shown while vessel is highlighted or in popup.
    const gen = ++_aisTrackGen;
    const historyHours = settings.appearance.ais.track.historyHours;
    fetchAisVesselTrack(settings.signalkHttpUrl, t.id, historyHours).then(coords => {
      if (gen !== _aisTrackGen) return;
      // Append live position so track reaches the vessel icon.
      const livePt: [number, number] = [t.position.longitude, t.position.latitude];
      const last = coords[coords.length - 1];
      const dx = last ? last[0] - livePt[0] : Infinity;
      const dy = last ? last[1] - livePt[1] : Infinity;
      // ~5 m threshold (matches server-side dedup).
      aisTrackRaw = (last && dx * dx + dy * dy < 2.02e-9) ? coords : [...coords, livePt];
    }).catch(() => { /* server may not have history — silently skip */ });
  }

  /** Open the detail popup for an already-selected (highlighted) vessel. */
  function openAisPopup(t: AisTarget): void {
    if (!map) return;
    if (aisAgeTimer !== null) { clearInterval(aisAgeTimer); aisAgeTimer = null; }
    const popup = openPopup(new maplibregl.Popup({ closeButton: true, maxWidth: 'none' })
      .setLngLat([t.position.longitude, t.position.latitude])
      .setHTML(buildAisPopupHtml(t))
    ).addTo(map);
    const timerId = setInterval(() => {
      const el = document.getElementById('ais-age');
      if (!el) { clearInterval(timerId); aisAgeTimer = null; return; }
      const posMs = Number(el.dataset['posms']);
      el.textContent = `(${formatAge(posMs)})`;
    }, 1000);
    aisAgeTimer = timerId;
    popup.on('close', () => {
      if (aisAgeTimer !== null) { clearInterval(aisAgeTimer); aisAgeTimer = null; }
      ais.clear(); // triggers reactive cleanup of track + CPA label + layers
    });
    popup.getElement().addEventListener('click', (ev) => {
      const el = ev.target as HTMLElement;
      const settingsBtn = el.closest<HTMLElement>('[data-settings]');
      if (settingsBtn) { popup.remove(); openSettings((settingsBtn.dataset['settings'] ?? 'connection') as SettingsTab); return; }
      const wpBtn = el.closest<HTMLButtonElement>('.add-waypoint-here-btn');
      if (wpBtn && !wpBtn.disabled) {
        popup.remove();
        promptAndSaveWaypoint(Number(wpBtn.dataset['lat']), Number(wpBtn.dataset['lon']));
        return;
      }
      const routeBtn = el.closest<HTMLButtonElement>('.route-here-btn');
      if (routeBtn) {
        popup.remove();
        const rlat = Number(routeBtn.dataset['lat']);
        const rlon = Number(routeBtn.dataset['lon']);
        if (routePlanner.active) routePlanner.addWaypoint(rlon, rlat);
        else routePlanner.enterAt(rlon, rlat);
      }
    });
  }

  function openDisambigPopup(coordinate: [number, number], indices: number[]) {
    const targets = indices.map(i => ais.getTarget(i))
      .filter((t): t is AisTarget => t?.position != null);

    if (targets.length === 0) return;
    if (targets.length === 1) {
      handleAisClick(targets[0]!);
      return;
    }

    // Capture stable vessel ids at build time. deck.gl pick indices are
    // positions in the per-batch arrays, which are rebuilt (in arbitrary
    // order) on every AIS batch — by click time an index can denote a
    // different vessel. data-entry indexes into this frozen list instead.
    const entryIds = targets.map(t => t.id);
    const items = targets.map((t, pos) =>
      `<li class="ais-disambig-item" data-entry="${String(pos)}">${t.name ?? t.mmsi ?? 'Unknown vessel'}</li>`
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
      const li = (ev.target as HTMLElement).closest<HTMLElement>('[data-entry]');
      if (!li) return;
      popup.remove();
      // Resolve entry → id → current index at click time; the vessel may have
      // expired since the popup was built — never select a different one.
      const curIdx = resolveDisambigEntry(entryIds, Number(li.dataset['entry']), ais.ids);
      if (curIdx === null) return;
      const t = ais.getTarget(curIdx);
      if (!t?.position) return;
      handleAisClick(t);
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
          <button class="popup-settings-btn route-here-btn">
            ${routePlanner.active ? 'Add to route' : 'Start route from here'}
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
        return;
      }
      const routeBtn = el.closest<HTMLButtonElement>('.route-here-btn');
      if (routeBtn) {
        popup.remove();
        if (routePlanner.active) routePlanner.addWaypoint(lon, lat);
        else routePlanner.enterAt(lon, lat);
      }
    });
  }

  function showOwnVesselPopup(lngLat: maplibregl.LngLat): void {
    if (!map) return;
    const ownPos = get(vesselState).position;
    const canWaypoint = auth.isLoggedIn && ownPos != null;
    const canRoute = ownPos != null;
    const popup = openPopup(new maplibregl.Popup({ closeButton: false, offset: 14, className: 'vessel-self-popup' })
      .setLngLat(lngLat)
      .setHTML(`
        <button class="vessel-self-settings-btn">Own vessel settings</button>
        <button class="popup-settings-btn add-waypoint-here-btn"
          ${canWaypoint ? `data-lat="${String(ownPos.latitude)}" data-lon="${String(ownPos.longitude)}"` : 'disabled title="Login required"'}>Add waypoint here</button>
        <button class="popup-settings-btn route-here-btn"
          ${canRoute ? `data-lat="${String(ownPos.latitude)}" data-lon="${String(ownPos.longitude)}"` : 'disabled title="Position unknown"'}>
          ${routePlanner.active ? 'Add to route' : 'Start route from here'}
        </button>
      `)
      ).addTo(map);
    popup.getElement().addEventListener('click', (ev) => {
      const settingsBtn = (ev.target as HTMLElement).closest('.vessel-self-settings-btn');
      if (settingsBtn) { popup.remove(); openSettings('vessel'); return; }
      const wpBtn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.add-waypoint-here-btn');
      if (wpBtn && !wpBtn.disabled) {
        popup.remove();
        promptAndSaveWaypoint(Number(wpBtn.dataset['lat']), Number(wpBtn.dataset['lon']));
        return;
      }
      const routeBtn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.route-here-btn');
      if (routeBtn && !routeBtn.disabled) {
        popup.remove();
        const rlat = Number(routeBtn.dataset['lat']);
        const rlon = Number(routeBtn.dataset['lon']);
        if (routePlanner.active) routePlanner.addWaypoint(rlon, rlat);
        else routePlanner.enterAt(rlon, rlat);
      }
    });
  }

  function showActiveRoutePopup(lngLat: maplibregl.LngLat, wptFeat?: maplibregl.MapGeoJSONFeature): void {
    if (!map) return;
    const name = route.routeName;
    const canStop = auth.isLoggedIn;
    const idxRaw = wptFeat?.properties['idx'] as number | null | undefined;
    const idx = typeof idxRaw === 'number' ? idxRaw : null;
    const isCurrentNext = idx !== null && idx === route.pointIndex;
    const canSetNext = idx !== null && !isCurrentNext && auth.isLoggedIn;
    const pointLabel = idx !== null ? `Point ${String(idx + 1)}` : null;
    const popup = openPopup(new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: 'none' })
      .setLngLat(lngLat)
      .setHTML(`
        <div class="ais-popup">
          ${name || pointLabel ? `<div class="ais-popup-title">${name ?? ''}${name && pointLabel ? ' — ' : ''}${pointLabel ?? ''}</div>` : ''}
          <div class="ais-links" style="margin-top:0">
            ${idx !== null ? `<button class="popup-settings-btn set-next-wpt-btn" data-idx="${String(idx)}"
              ${canSetNext ? '' : isCurrentNext ? 'disabled title="Already the next waypoint"' : 'disabled title="Login required"'}>Set as next waypoint</button>` : ''}
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
      const setNextBtn = el.closest<HTMLButtonElement>('.set-next-wpt-btn');
      if (setNextBtn && !setNextBtn.disabled && setNextBtn.dataset['idx']) {
        popup.remove();
        setActiveRoutePointIndex(settings.signalkHttpUrl, Number(setNextBtn.dataset['idx']), auth.authHeaders)
          .catch((err: unknown) => { console.error('[route] Failed to set next waypoint:', err); });
        return;
      }
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
            <button class="popup-settings-btn route-here-btn"
              data-lat="${String(lat)}" data-lon="${String(lon)}">
              ${routePlanner.active ? 'Add to route' : 'Start route from here'}
            </button>
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
        return;
      }
      const routeBtn = el.closest<HTMLButtonElement>('.route-here-btn');
      if (routeBtn) {
        popup.remove();
        const rlat = Number(routeBtn.dataset['lat']);
        const rlon = Number(routeBtn.dataset['lon']);
        if (routePlanner.active) routePlanner.addWaypoint(rlon, rlat);
        else routePlanner.enterAt(rlon, rlat);
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
      const vis = enabled.has(layer.id) ? 'visible' : 'none';
      for (const lid of [layer.id, ...(layer.extraLayerIds ?? [])]) {
        if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
      }
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
    const now = Date.now();

    // Only advance the upload timestamp when hotData itself changed (new WS batch).
    // Cold-only updates (e.g. setInfoCache) must reuse the existing timestamp so that
    // dead-reckoned ghost vessels don't snap back to their stored position.
    const hotDataChanged = hotData !== _lastAisHotData;
    _lastAisHotData = hotData;
    const uploadTs = hotDataChanged ? now : (aisUploadTimestamp || now);

    if (!hotData || ids.length === 0) {
      aisLayerGroup = [];
      flushLayers();
      aisHotSnapshot     = null;
      aisIdsSnapshot     = [];
      aisUploadTimestamp = 0;
      _lastAisHotData    = null;
      return;
    }

    // Snapshot for rafTick dead-reckoning (ruler snap).
    aisHotSnapshot = hotData;
    aisIdsSnapshot = ids;
    if (hotDataChanged) aisUploadTimestamp = now;

    aisLayerGroup = buildAisLayers(hotData, ids, coldMap, settings.appearance.ais, uploadTs, settings.targetFps, ais.selectedIndex);
    flushLayers();
  });

  // Clean up track, CPA label, and age timer when the AIS selection is cleared.
  $effect(() => {
    if (ais.selectionPhase !== null) return;
    _aisTrackGen++;
    aisTrackRaw = [];
    cpaLabelPopup?.remove();
    cpaLabelPopup = null;
    cpaLayerGroup = [];
    flushLayers();
    if (aisAgeTimer !== null) { clearInterval(aisAgeTimer); aisAgeTimer = null; }
  });

  // Bounded-staleness refresh for the CPA effect below: own vessel state is read
  // untracked there (to avoid 60 Hz reruns on heading ticks), so its only recompute
  // triggers would otherwise be AIS batches and selection changes. Class-B targets
  // legitimately report every 30 s–3 min; at 6 kn own ship moves ~550 m in 3 min, so
  // the displayed CPA/TCPA would lag own-ship motion by the *remote* target's report
  // interval. This tick re-runs the effect at most every CPA_OWN_REFRESH_MS while a
  // target is selected, so it re-reads the current vesselState with staleness bounded
  // by the interval instead. Timer runs only while a selection is live; the effect
  // teardown clears it on deselection and component destroy.
  const CPA_OWN_REFRESH_MS = 5000;
  let cpaOwnTick = $state(0);
  $effect(() => {
    if (ais.selectedId === null) return; // no CPA display → no timer
    const timer = setInterval(() => { cpaOwnTick++; }, CPA_OWN_REFRESH_MS);
    return () => { clearInterval(timer); };
  });

  // Recompute Rust CPA and rebuild CPA visualization whenever selection or AIS data changes.
  // Own vessel state is read untracked to avoid rerunning at 60 Hz on heading ticks;
  // cpaOwnTick bounds the resulting staleness (see above).
  $effect(() => {
    const selId  = ais.selectedId;
    const selIdx = ais.selectedIndex;
    const hotData = ais.hotData;
    void cpaOwnTick; // register bounded-staleness own-state refresh (see above)

    if (!selId || selIdx === null || !hotData || !map || !mapLoaded) {
      cpaLabelPopup?.remove();
      cpaLabelPopup = null;
      cpaLayerGroup = [];
      flushLayers();
      return;
    }

    const S  = AIS_HOT_STRIDE;
    const b  = selIdx * S;
    const tgtLon = hotData[b + AIS_F_LON]!;
    const tgtLat = hotData[b + AIS_F_LAT]!;
    const tgtCog = hotData[b + AIS_F_COG]!;
    const tgtSog = hotData[b + AIS_F_SOG]!;
    const tgtRot = hotData[b + AIS_F_ROT]!;

    const vs     = untrack(() => get(vesselState));
    const ownPos = vs.position;
    const ownCog = vs.cog;
    const ownSog = vs.sog;

    if (!ownPos || ownCog === null || ownSog === null) {
      cpaLabelPopup?.remove();
      cpaLabelPopup = null;
      cpaLayerGroup = [];
      flushLayers();
      return;
    }

    const rustCpa = computeCpa(
      ownPos.longitude, ownPos.latitude, ownCog, ownSog,
      isNaN(tgtLon) ? NaN : tgtLon, isNaN(tgtLat) ? NaN : tgtLat,
      isNaN(tgtCog) ? NaN : tgtCog, isNaN(tgtSog) ? NaN : tgtSog,
      isNaN(tgtRot) ? 0 : tgtRot,
    );

    if (!rustCpa) {
      cpaLabelPopup?.remove();
      cpaLabelPopup = null;
      cpaLayerGroup = [];
      flushLayers();
      return;
    }

    // SK CPA from delta stream (present only when a compatible SK plugin is running).
    const skCpaRaw = ais.coldMap.get(selId)?.skCpa ?? null;
    const skCpa: SkCpaInput | null = skCpaRaw
      ? { distanceM: skCpaRaw.distanceM, timeToS: skCpaRaw.timeToS }
      : null;

    cpaLayerGroup = buildCpaLayers(
      ownPos.longitude, ownPos.latitude, ownCog, ownSog,
      tgtLon, tgtLat, isNaN(tgtCog) ? NaN : tgtCog, isNaN(tgtSog) ? NaN : tgtSog, isNaN(tgtRot) ? 0 : tgtRot,
      rustCpa, skCpa,
    );
    flushLayers();

    // Update or create the mini-label popup near the target vessel.
    const labelHtml = formatCpaLabel(rustCpa, skCpa);
    if (!cpaLabelPopup) {
      cpaLabelPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'ais-cpa-label',
        anchor: 'bottom',
        offset: 8,
      })
      .setLngLat([tgtLon, tgtLat])
      .setHTML(labelHtml)
      .addTo(map);
    } else {
      cpaLabelPopup.setLngLat([tgtLon, tgtLat]).setHTML(labelHtml);
    }
  });

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
    courseLayerGroup = buildCourseLayers(route.geometry, route.nextPoint, route.previousPoint, $vesselPosition, ra);
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
        // Append current live position so each track reaches its vessel icon.
        // hotData/ids are read outside the reactive scope (inside async .then) so no dep created.
        const hotData = ais.hotData;
        const idx = ais.ids.indexOf(id);
        if (idx >= 0 && hotData) {
          const lon = hotData[idx * AIS_HOT_STRIDE + AIS_F_LON]!;
          const lat = hotData[idx * AIS_HOT_STRIDE + AIS_F_LAT]!;
          if (!isNaN(lon) && !isNaN(lat)) {
            const last = coords[coords.length - 1];
            const dx = last ? last[0] - lon : Infinity;
            const dy = last ? last[1] - lat : Infinity;
            // ~5 m threshold — skip if history already ends at the live position.
            if (!last || dx * dx + dy * dy >= 2.02e-9) coords = [...coords, [lon, lat] as [number, number]];
          }
        }
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


  // Route/course rendering — updates when route geometry, course points, own position,
  // or route appearance settings change.
  // Reads $vesselPosition (not $vesselState) so compass ticks at 60 Hz don't trigger this:
  // heading updates leave the position reference unchanged, so the derived store stays quiet.
  $effect(() => {
    const nxtPt   = route.nextPoint;
    const prevPt  = route.previousPoint;
    const ownPos  = $vesselPosition;
    void settings.appearance.route;
    if (!map || !mapLoaded) return;

    const wptSrc = map.getSource(ROUTE_WPT_SRC);
    if (!(wptSrc instanceof maplibregl.GeoJSONSource)) return;

    courseLayerGroup = buildCourseLayers(route.geometry, nxtPt, prevPt, ownPos, settings.appearance.route);
    flushLayers();

    const wptFeatures: GeoJSON.Feature[] = [];
    const geo = route.geometry;
    if (geo && route.activeHref) {
      const coords = geo.geometry.coordinates as [number, number][];
      coords.forEach((c, i) => {
        wptFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c },
          properties: { wtype: i === route.pointIndex ? 'next' : 'point', idx: i },
        });
      });
    } else if (nxtPt) {
      wptFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [nxtPt.longitude, nxtPt.latitude] }, properties: { wtype: 'next' } });
    }
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
  // drop back to COG → north. Gated on _receivedVesselData so a mode restored from
  // localStorage on a fresh load isn't collapsed before real data has even arrived —
  // null cog/heading/route at mount means "not received yet", not "lost".
  $effect(() => {
    const hasCog     = $vesselState.cog     !== null;
    const hasHeading = $vesselState.heading !== null;
    const hasCourse  = route.nextPoint      !== null;
    if (hasCog || hasHeading || hasCourse) _receivedVesselData = true;
    if (!_receivedVesselData) return;
    rotateMode.ensureAvailable(hasCog, hasHeading, hasCourse);
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

  // One-shot: fly to the vessel's first real position fix, but only if the user hasn't
  // already panned/zoomed/rotated the map by hand and isn't already in follow mode. Center
  // only (no zoom change) — same camera move as clicking "center on vessel" once, but never
  // engages follow mode itself ("not lock"), so the user can immediately pan away again.
  // Persisted-view restore (loadSavedView() in onMount) already avoided the old Oslo flash;
  // this corrects that persisted/stale view to the boat's actual position once we know it.
  $effect(() => {
    const pos = $vesselPosition;
    if (!map || !mapLoaded || !pos) return;
    if (_didAutoFlyToFirstFix || _userHasInteracted || followMode.following) return;
    _didAutoFlyToFirstFix = true;
    map.flyTo({ center: [pos.longitude, pos.latitude] });
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
      if (!_isInteracting && !_touchActive && (posChanged || rmChanged || rm === 'heading' || rm === 'cog')) {
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

  // Interaction constraints in follow mode:
  //   - Pan drag remains enabled; panning slides the follow offset (vessel's pinned screen
  //     position). Panning the vessel off the edge of the viewport drops the pin entirely.
  //   - ScrollZoom disabled; custom wheel handler zooms around the vessel, not the cursor.
  //     Uses rAF accumulation so rapid scroll events batch into a single easeTo per frame,
  //     matching MapLibre's native speed and feel. Two-finger trackpad scroll generates
  //     wheel events too, so this path covers it automatically.
  //   - Zoom slider and keyboard call zoomIn/Out (anchor-aware); zoomend re-anchors all others.
  //     Touch pinch and keyboard zoom are handled by a `zoomend` listener that re-anchors
  //     the vessel to its pinned screen pixel (guarded: no re-anchor during active gestures).
  //   - Rotation (right-click drag, two-finger rotate) remains active throughout.
  $effect(() => {
    if (!map) return;

    if (!followMode.following) {
      map.dragPan.enable();
      map.scrollZoom.enable();
      return;
    }

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
      if (_isInteracting) return;       // user is mid-gesture (pinch-zoom); don't fight it
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


<ZoomSlider map={map} zoom={mapZoom} onZoomIn={zoomIn} onZoomOut={zoomOut} />

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

{#if plannerHandlePopup}
<div
  class="planner-handle-popup"
  role="dialog"
  aria-label="Waypoint options"
  tabindex="-1"
  style="left: {plannerHandlePopup.x}px; top: {plannerHandlePopup.y}px;"
  onpointerdown={(e) => { e.stopPropagation(); }}
>
  <button
    class="planner-handle-popup-remove"
    onclick={() => { if (plannerHandlePopup) { routePlanner.removeWaypoint(plannerHandlePopup.idx); plannerHandlePopup = null; } }}
  >Remove waypoint {plannerHandlePopup.idx + 1}</button>
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

  .planner-handle-popup {
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
  .planner-handle-popup-remove {
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
    .planner-handle-popup-remove:hover { background: #c53030; }
  }


  /* CPA mini-label popup — shown near a highlighted AIS vessel */
  :global(.ais-cpa-label .maplibregl-popup-content) {
    background: rgba(15, 15, 25, 0.88);
    border: 1px solid rgba(255, 200, 50, 0.45);
    border-radius: 4px;
    padding: 4px 8px;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    line-height: 1.4;
    pointer-events: none;
    white-space: nowrap;
  }
  :global(.ais-cpa-label .maplibregl-popup-tip) { display: none; }
  :global(.cpa-value)   { color: #ffc832; font-weight: 600; }
  :global(.cpa-opening) { color: #9ca3af; }
  :global(.cpa-sk)      { color: #50c8ff; font-size: 10px; }

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
  /* MapLibre's ctrl containers use float+clear layout; override to flex so the
     scale bar sits horizontally. Offset from the left to clear the chart FAB
     (left: 16px + 52px wide + 16px gap = 84px). */
  :global(.maplibregl-ctrl-bottom-left) {
    display: flex !important;
    flex-direction: row !important;
    align-items: flex-end !important;
    padding-left: 84px !important;
  }

</style>
