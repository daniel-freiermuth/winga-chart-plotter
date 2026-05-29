<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import FaIcon from '../lib/FaIcon.svelte';
  import { faGlobe, faMap, faExpand, faCompress } from '@fortawesome/free-solid-svg-icons';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import type * as GeoJSON from 'geojson';
  import { get } from 'svelte/store';
  import { vesselState } from '../stores/vessel';
  import { settings, type LineAppearance, type LineStyle } from '../stores/settings.svelte';
  import { fpsStore } from '../stores/fps.svelte';
  import { followMode } from '../stores/follow.svelte';
  import { rotateMode } from '../stores/rotateMode.svelte';
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';
  import { ais, AIS_HOT_STRIDE, AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG, AIS_F_HDG, AIS_F_ROT, AIS_F_AGE } from '../stores/ais.svelte';
  import type { AisTarget } from '../stores/ais.svelte';
  import { MapboxOverlay } from '@deck.gl/mapbox';
  import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
  import { PathStyleExtension } from '@deck.gl/extensions';
  import type { Layer } from '@deck.gl/core';
  import { rulers, rulerBearingText, rulerDistanceText, type Ruler, type RulerEndpoint } from '../stores/rulers.svelte';
  import { gcLine } from '../lib/geoMath';
  import { fetchAndResolveStyle } from '../lib/resolveStyle';
  import { AisHullLayer, AisHullDecorationLayer, HULL_ANCHOR_DOT, HULL_MOORING_BARS, HULL_AGROUND_RING, HULL_FISHING_GEAR, HULL_NUC, HULL_RESTRICTED, HULL_DRAUGHT } from '../layers/AisHullLayer';
  import { AisIconLayer, ANCHOR_DOT_GEOMETRY, AGROUND_CIRCLE_GEOMETRY, MOORING_BARS_GEOMETRY, FISHING_GEAR_GEOMETRY, NUC_GEOMETRY, RESTRICTED_MANOEUVRING_GEOMETRY, DRAUGHT_GEOMETRY, MOB_GEOMETRY } from '../layers/AisIconLayer';
  import { makeVesselIconData, extrapolatePos } from '../lib/deadReckoning';

  type ProjectionId = 'mercator' | 'globe';

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
  let isFullscreen = $state(!!document.fullscreenElement);
  let onFsChange = () => {};

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  export function flyToVessel() {
    if (followMode.following) {
      followMode.following = false;
      return;
    }
    followMode.following = true;
    // The follow $effect will move the map once following is set.
  }
  let mapLoaded   = $state(false);
  let mapZoom     = $state(10);
  let mapBearing  = $state(0);
  let projection  = $state<ProjectionId>('mercator');

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

  // Own-vessel setData coalescing: multiple Signal K field updates (lat, lon, COG, SOG, heading)
  // arrive per epoch and each triggers the $effect. We batch them into one setData per rAF frame.
  let _vesselRafId: number | null = null;
  let _pendingVesselSetData: (() => void) | null = null;

  // AIS-label setData throttle: individual vessel updates trigger rebuilds of the whole
  // FeatureCollection. Limit to 1 Hz — labels don't need sub-second precision.
  let _aisLastUpdateMs = 0;
  let _aisThrottleId: ReturnType<typeof setTimeout> | null = null;
  let _pendingAisSetData: (() => void) | null = null;

  function setProjection(id: ProjectionId) {
    // Phase 0 — cache the converged latitude correction before leaving globe mode.
    if (id !== 'globe' && projection === 'globe') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = (map as any)?.style?.projection?._verticalPerspectiveProjection;
      if (vp) _cachedGlobeCorrection = vp._errorCorrectionUsable as number;
    }

    projection = id;
    map?.setProjection({ type: id });

    if (id === 'globe' && _cachedGlobeCorrection !== null) {
      // Phase 1 — synchronously inject cached correction into the fresh VP projection
      // so the very first rendered frame is already at the correct latitude.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = (map as any)?.style?.projection?._verticalPerspectiveProjection;
      if (vp) {
        vp._errorCorrectionUsable       = _cachedGlobeCorrection;
        vp._errorCorrectionPreviousValue = _cachedGlobeCorrection;
        // Pre-set lastValue so the first updateGPUdependent call doesn't immediately
        // start a transition away from the cached value.
        vp._errorMeasurementLastValue = -_cachedGlobeCorrection;
      }

      // Phase 2 — after the first render, seed _measuredError (lazily created by
      // updateGPUdependent) so the ~167 ms drift before the real GPU readback returns
      // is also prevented.
      _globeInjectionPending = true;
      requestAnimationFrame(() => {
        if (!_globeInjectionPending) return;
        _globeInjectionPending = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vp2 = (map as any)?.style?.projection?._verticalPerspectiveProjection;
        if (vp2?._errorMeasurement && _cachedGlobeCorrection !== null) {
          vp2._errorMeasurement._measuredError  = -_cachedGlobeCorrection;
          vp2._errorMeasurementLastValue         = -_cachedGlobeCorrection;
          // Far-past timestamp forces mix=1 immediately, so correction is applied without delay.
          vp2._errorMeasurementLastChangeTime    = performance.now() - 10_000;
        }
      });
    } else {
      _globeInjectionPending = false;
    }
  }

  const VESSEL_SOURCE   = 'vessel';
  const COG_SOURCE      = 'vessel-cog';
  const HDG_SOURCE      = 'vessel-hdg';
  const GC_SOURCE       = 'vessel-gc';
  const AIS_SOURCE      = 'ais-targets'; // kept for ais-label text layer
  const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

  // Track the tile URL each chart source was last created with, so we can
  // detect URL changes (e.g. WMTS layer switch) and recreate the source.
  const chartSourceUrls = new Map<string, string>();
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

  function setHandleHover(hovering: boolean) {
    if (hovering === isHoveringHandle) return;
    isHoveringHandle = hovering;
    mapContainer.style.cursor = hovering ? 'grab' : '';
    if (hovering) {
      map?.dragPan.disable();
    } else if (!rulerDrag) {
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
    // Check delete button first — small ✕ offset from B endpoint.
    const deletePick = overlay.pickObject({ x, y, radius: 12, layerIds: ['ruler-delete'] });
    if (deletePick?.object) {
      type HandleDatum = { rulerId: string };
      const d = deletePick.object as HandleDatum;
      rulers.remove(d.rulerId);
      e.stopPropagation();
      return;
    }
    const picked = overlay.pickObject({ x, y, radius: 10, layerIds: ['ruler-handles'] });
    if (!picked?.object) return;
    type HandleDatum = { rulerId: string; endpoint: 'a' | 'b' };
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
    if (!rulerDrag) {
      // Hover detection via pickObject (avoids deck.gl layer recreation race on drag).
      if (overlay) {
        const hoverPick = overlay.pickObject({ x, y, radius: 10, layerIds: ['ruler-handles'] });
        setHandleHover(!!hoverPick?.object);
      }
      return;
    }
    const coord = map.unproject([x, y]);
    rulers.moveEndpoint(rulerDrag.rulerId, rulerDrag.endpoint, coord.lng, coord.lat);
    e.stopPropagation();
  }

  function handleRulerPointerUp(e: PointerEvent) {
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
    if (!isHoveringHandle) map.dragPan.enable();
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
  // Layer groups composed into overlay.setProps() — AIS layers set on data tick,
  // ruler layers rebuilt in rafTick (need map.project() for pixel distance checks).
  let aisLayerGroup: Layer[] = [];
  let rulerLayerGroup: Layer[] = [];

  function flushLayers() {
    overlay?.setProps({ layers: [...aisLayerGroup, ...rulerLayerGroup] });
  }

  let rafId = 0;
  // Ref to scheduleRafTick (defined inside onMount) for use in the reactive effect below.
  let _scheduleRafTick: (() => void) | null = null;
  const _fpsSamples: number[] = [];

  // When the target FPS changes: cancel the pending tick, clear measurement history,
  // and reschedule immediately at the new rate.
  $effect(() => {
    const _ = settings.targetFps;
    cancelAnimationFrame(rafId);
    clearTimeout(rafId);
    _fpsSamples.length = 0;
    fpsStore.set(0);
    _scheduleRafTick?.();
  });

  onMount(() => {
    map = new maplibregl.Map({
      container: mapContainer,
      style: DEFAULT_STYLE,
      center: [10.75, 59.91],
      zoom: 10,
      maxPitch: 85,
      bearingSnap: 0,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');

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
    map.addControl(overlay as unknown as maplibregl.IControl);
    // Flush any AIS layers that were built before the overlay was ready.
    flushLayers();

    // rAF loop: updates ruler layers (need map.project()) and snap targets each frame.
    // AIS layers are self-animating — no setProps() from here for them.
    function rafTick() {
      // Measure actual FPS using a rolling window of frame timestamps.
      const now = performance.now();
      _fpsSamples.push(now);
      const cutoff = now - 3000;
      while (_fpsSamples.length > 2 && _fpsSamples[0] < cutoff) _fpsSamples.shift();
      if (_fpsSamples.length >= 2) {
        const span = _fpsSamples[_fpsSamples.length - 1] - _fpsSamples[0];
        fpsStore.set((_fpsSamples.length - 1) / (span / 1000));
      }

      if (overlay !== null) {
        const nowMs = Date.now();

        // Build live snap targets every frame.
        // For moving vessels: two snap points — last-known (id) and dead-reckoned (id+':ghost').
        // For stationary vessels: one snap point at last-known position.
        // Own vessel always included.
        const ownPosForSnap = get(vesselState).position;
        {
          const nowForSnap = nowMs;
          const snapPts: typeof liveSnapTargets = [];
          const S = AIS_HOT_STRIDE;
          if (aisHotSnapshot && aisIdsSnapshot.length > 0) {
            const hd = aisHotSnapshot;
            const ids = aisIdsSnapshot;
            const n = ids.length;
            for (let i = 0; i < n; i++) {
              const lon = hd[i * S + AIS_F_LON];
              const lat = hd[i * S + AIS_F_LAT];
              snapPts.push({ id: ids[i], position: { longitude: lon, latitude: lat } });
              const cog = hd[i * S + AIS_F_COG];
              const sog = hd[i * S + AIS_F_SOG];
              if (!isNaN(cog) && !isNaN(sog) && sog > 0.1) {
                const rot = hd[i * S + AIS_F_ROT];
                const lastPosMs = aisUploadTimestamp - hd[i * S + AIS_F_AGE] * 1000;
                const [gLon, gLat] = extrapolatePos(lon, lat, cog, sog, isNaN(rot) ? 0 : rot, lastPosMs, nowForSnap);
                snapPts.push({ id: ids[i] + ':ghost', position: { longitude: gLon, latitude: gLat } });
              }
            }
          }
          if (ownPosForSnap) {
            snapPts.push({ id: 'own-vessel', position: { longitude: ownPosForSnap.longitude, latitude: ownPosForSnap.latitude } });
          }
          liveSnapTargets = snapPts;
          rulers.syncSnapped(liveSnapTargets);
        }

        // Ruler layers — rebuilt every frame only when rulers exist, because label
        // visibility uses map.project() which depends on the current viewport.
        // AIS layers are self-animating (no setProps needed from here for them).
        const currentRulers = rulers.rulers;
        if (currentRulers.length > 0) {
          // --- Ruler layers ---
          type HandleDatum    = { rulerId: string; endpoint: 'a' | 'b'; lon: number; lat: number; snapId?: string };
          type LineDatum      = { ruler: Ruler };

          const rulerColor    = settings.appearance.ruler.color;
          const rulerWidth    = settings.appearance.ruler.width;

          // Hex color → [r, g, b, a] for deck.gl (alpha 0.0–1.0)
          function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
            const n = parseInt(hex.replace('#', ''), 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255)];
          }
          const lineRgba   = hexToRgba(rulerColor, 0.87);
          const handleRgba = hexToRgba(rulerColor, 0.90);

          type MidDatum = { ruler: Ruler; lon: number; lat: number };

          // Exact GC midpoint — land on the line, not the chord.
          // Omit entries where the two handles are <100px apart (label would overlap handles).
          const LABEL_MIN_PX = 100;
          const midData: MidDatum[] = currentRulers.flatMap(r => {
            if (map) {
              const pA = map.project([r.a.lon, r.a.lat]);
              const pB = map.project([r.b.lon, r.b.lat]);
              if (Math.hypot(pB.x - pA.x, pB.y - pA.y) < LABEL_MIN_PX) return [];
            }
            const pts = gcLine(r.a.lon, r.a.lat, r.b.lon, r.b.lat);
            const mid = pts[Math.floor(pts.length / 2)];
            return [{ ruler: r, lon: mid[0], lat: mid[1] }];
          });

          const handleData: HandleDatum[] = currentRulers.flatMap(r => [
            { rulerId: r.id, endpoint: 'a', lon: r.a.lon, lat: r.a.lat, snapId: r.a.snapId },
            { rulerId: r.id, endpoint: 'b', lon: r.b.lon, lat: r.b.lat, snapId: r.b.snapId },
          ]);

          // Delete handle at the B end — hidden when handles are too close (same threshold as label)
          const deleteData: HandleDatum[] = currentRulers.flatMap(r => {
            if (map) {
              const pA = map.project([r.a.lon, r.a.lat]);
              const pB = map.project([r.b.lon, r.b.lat]);
              if (Math.hypot(pB.x - pA.x, pB.y - pA.y) < LABEL_MIN_PX) return [];
            }
            return [{ rulerId: r.id, endpoint: 'b' as const, lon: r.b.lon, lat: r.b.lat }];
          });

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

            // Single annotation label at GC midpoint, sitting on the line
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
              characterSet: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 °·.,\'-/T'],
              pickable: false,
              updateTriggers: { getText: [currentRulers], getPosition: [currentRulers] },
            }),

            // Delete handle (✕) at B endpoint
            new TextLayer<HandleDatum>({
              id: 'ruler-delete',
              data: deleteData,
              getText: () => '✕',
              getPosition: (d: HandleDatum) => [d.lon, d.lat, 0],
              getPixelOffset: [14, -14] as [number, number],
              getSize: 11,
              getColor: [255, 100, 100, 220] as [number, number, number, number],
              getBackgroundColor: [30, 10, 10, 180] as [number, number, number, number],
              background: true,
              backgroundPadding: [3, 1, 3, 1] as [number, number, number, number],
              getTextAnchor: 'middle' as const,
              getAlignmentBaseline: 'center' as const,
              characterSet: ['✕'],
              pickable: true,
              updateTriggers: { getPosition: [currentRulers] },
            }),
          ];
          flushLayers();
        } else if (rulerLayerGroup.length > 0) {
          // Rulers were just removed — clear and flush once.
          rulerLayerGroup = [];
          flushLayers();
        }
      }
      scheduleRafTick();
    }

    function scheduleRafTick() {
      const intervalMs = 1000 / settings.targetFps;
      if (intervalMs <= 17) {
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

    onFsChange = () => { isFullscreen = !!document.fullscreenElement; };
    document.addEventListener('fullscreenchange', onFsChange);

    map.on('zoom',   () => { mapZoom    = map?.getZoom()    ?? mapZoom; });
    map.on('rotate', () => { mapBearing = map?.getBearing() ?? mapBearing; });
    // Track user interactions so programmatic easeTo calls don't interrupt gestures.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on('movestart', (e: any) => { if (e.originalEvent) _isInteracting = true; });
    map.on('moveend',   () => { _isInteracting = false; });
    // User dragging the map cancels follow mode.
    map.on('dragstart', () => { if (!rulerDrag) followMode.following = false; });
    // User rotating the map (gesture) switches to manual rotate mode.
    // Programmatic camera moves (easeTo/flyTo) also fire rotatestart but without originalEvent.
    map.on('rotatestart', (e: maplibregl.MapRotateEvent) => {
      if (e.originalEvent) rotateMode.setManual();
    });

    // AIS vessel click — pick all vessels under the cursor and disambiguate if needed.
    map.on('click', (e) => {
      if (!overlay) return;
      const { x, y } = e.point;
      const aisLayerIds = ['ais-confirmed-icon', 'ais-hull-ghost', 'ais-hull-confirmed', 'ais-ghost-icon', 'ais-mob-icon'];
      const allPicked = overlay.pickMultipleObjects({ x, y, radius: 5, layerIds: aisLayerIds });

      // Deduplicate by vessel index — multiple layers can return the same vessel.
      const seen = new Set<number>();
      const uniqueHits: { idx: number; coordinate: number[] }[] = [];
      for (const p of allPicked) {
        const idx = p.object as number | undefined | null;
        if (idx === undefined || idx === null) continue;
        if (seen.has(idx)) continue;
        seen.add(idx);
        if (p.coordinate) uniqueHits.push({ idx, coordinate: p.coordinate as number[] });
      }

      if (uniqueHits.length === 0) return;

      const coordinate = uniqueHits[0].coordinate as [number, number];

      if (uniqueHits.length === 1) {
        const target = ais.getTarget(uniqueHits[0].idx);
        if (!target?.position) return;
        handleAisClick(coordinate, target);
        return;
      }

      // Multiple vessels — show a disambiguation list popup.
      openDisambigPopup(coordinate, uniqueHits.map(h => h.idx));
    });

    // style.load fires on initial style ready AND after MapLibre's internal setStyle
    // (which it calls automatically on WebGL context restore), so this covers both cases.
    map.on('style.load', () => {
      const m = map;
      if (!m) return;
      const ap = settings.appearance;
      // Image manager is not cleared by diff-mode style transitions — guard against duplicates.
      if (!m.hasImage('vessel-icon')) {
        m.addImage('vessel-icon', { width: 64, height: 64, data: makeVesselIconData(64, ap.vesselColor).data });
      }

      if (!m.getSource(VESSEL_SOURCE)) m.addSource(VESSEL_SOURCE, { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(COG_SOURCE))    m.addSource(COG_SOURCE,    { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(HDG_SOURCE))    m.addSource(HDG_SOURCE,    { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(GC_SOURCE))     m.addSource(GC_SOURCE,     { type: 'geojson', data: EMPTY_FC });
      if (!m.getSource(AIS_SOURCE))    m.addSource(AIS_SOURCE,    { type: 'geojson', data: EMPTY_FC }); // for ais-label only

      if (!m.getLayer('vessel-gc-line')) m.addLayer({ id: 'vessel-gc-line', type: 'line', source: GC_SOURCE,
        paint: { 'line-color': ap.gc.color, 'line-width': ap.gc.width, ...(dashArray(ap.gc.style, ap.gc.width) !== null && { 'line-dasharray': dashArray(ap.gc.style, ap.gc.width)! }) } });

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

      if (!m.getLayer('vessel-cog-line')) m.addLayer({ id: 'vessel-cog-line', type: 'line', source: COG_SOURCE,
        paint: { 'line-color': ap.cog.color, 'line-width': ap.cog.width, ...(dashArray(ap.cog.style, ap.cog.width) !== null && { 'line-dasharray': dashArray(ap.cog.style, ap.cog.width)! }) } });

      if (!m.getLayer('vessel-hdg-line')) m.addLayer({ id: 'vessel-hdg-line', type: 'line', source: HDG_SOURCE,
        paint: { 'line-color': ap.heading.color, 'line-width': ap.heading.width } });

      if (!m.getLayer('vessel-icon')) m.addLayer({ id: 'vessel-icon', type: 'symbol', source: VESSEL_SOURCE,
        layout: {
          'icon-image': 'vessel-icon',
          'icon-size': ap.vesselSize / 64,
          'icon-rotate': ['get', 'bearing_deg'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });

      mapZoom    = map.getZoom();
      mapBearing = map.getBearing();
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
      `<tr><td>${label}</td><td><b>${value !== null ? `${String(value)}${unit}` : '<span style="opacity:0.4">—</span>'}</b></td></tr>`;

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

    const lon = t.position?.longitude;
    const lat = t.position?.latitude;

    const posMs = t.lastPositionUpdateMs;
    const lastSeenDate = new Date(posMs);
    const lastSeenTime = lastSeenDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const ageStr = formatAge(posMs);

    return `
      <div class="ais-popup">
        <div class="ais-popup-title">${t.name ?? t.mmsi ?? 'Unknown vessel'}</div>
        <table>
          ${row('MMSI',     t.mmsi     ?? null)}
          ${row('Callsign VHF', t.callsign   ?? null)}
          ${row('Callsign HF',  t.callsignHf ?? null)}
          ${row('Skipper',      t.skipperName ?? null)}
          ${row('Type',     t.shipType ?? null)}
          ${row('Status',   t.navState ?? null)}
          ${row('Flag',     t.flag     ?? null)}
          ${row('Port',     t.port     ?? null)}
          ${row('Position', lon !== undefined && lat !== undefined ? `${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E` : null)}
          ${row('Updated',  `${lastSeenTime} <span id="ais-age" data-posms="${posMs}" style="opacity:0.6;font-size:0.85em">(${ageStr})</span>`)}
          <tr><td colspan="2" class="ais-section">Navigation</td></tr>
          ${row('SOG',     t.sog     !== undefined ? (t.sog     * 1.94384).toFixed(1) : null, ' kn')}
          ${row('COG',     t.cog     !== undefined ? (t.cog     * 180 / Math.PI).toFixed(1) : null, '°')}
          ${row('Heading', t.heading !== undefined ? (t.heading * 180 / Math.PI).toFixed(1) : null, '°')}
          ${row('ROT',     rotStr)}
          <tr><td colspan="2" class="ais-section">Dimensions</td></tr>
          ${row('Length',     t.lengthM    ?? null, ' m')}
          ${row('Beam',       t.beamM      ?? null, ' m')}
          ${row('Draft',      t.draftM     ?? null, ' m')}
          ${row('Air height', t.airHeightM ?? null, ' m')}
        </table>
        ${lookupLinks}
      </div>`;
  }

  let aisAgeTimer: ReturnType<typeof setInterval> | null = null;

  function formatAge(posMs: number): string {
    const ageSec = Math.round((Date.now() - posMs) / 1000);
    return ageSec < 60
      ? `${ageSec}s ago`
      : ageSec < 3600
        ? `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`
        : `${Math.floor(ageSec / 3600)}h ${Math.floor((ageSec % 3600) / 60)}m ago`;
  }

  function handleAisClick(coordinate: [number, number], t: AisTarget): boolean {
    if (!t.position) return false;

    if (aisAgeTimer !== null) {
      clearInterval(aisAgeTimer);
      aisAgeTimer = null;
    }

    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
      .setLngLat(coordinate)
      .setHTML(buildAisPopupHtml(t))
      .addTo(map!);

    aisAgeTimer = setInterval(() => {
      const el = document.getElementById('ais-age');
      if (!el) { clearInterval(aisAgeTimer!); aisAgeTimer = null; return; }
      const posMs = Number(el.dataset.posms);
      el.textContent = `(${formatAge(posMs)})`;
    }, 1000);

    popup.on('close', () => {
      if (aisAgeTimer !== null) { clearInterval(aisAgeTimer); aisAgeTimer = null; }
    });

    return true;
  }

  function openDisambigPopup(coordinate: [number, number], indices: number[]) {
    const targets = indices.map(i => ({ idx: i, target: ais.getTarget(i) }))
      .filter(e => e.target?.position != null);

    if (targets.length === 0) return;
    if (targets.length === 1) {
      handleAisClick(coordinate, targets[0].target!);
      return;
    }

    const items = targets.map(({ idx, target: t }) =>
      `<li class="ais-disambig-item" data-idx="${idx}">${t!.name ?? t!.mmsi ?? 'Unknown vessel'}</li>`
    ).join('');

    const html = `
      <div class="ais-disambig">
        <div class="ais-popup-title">Multiple vessels</div>
        <ul class="ais-disambig-list">${items}</ul>
      </div>`;

    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '220px' })
      .setLngLat(coordinate)
      .setHTML(html)
      .addTo(map!);

    // Attach click handler after the popup is in the DOM.
    const el = popup.getElement();
    el.addEventListener('click', (ev) => {
      const li = (ev.target as HTMLElement).closest('[data-idx]') as HTMLElement | null;
      if (!li) return;
      const idx = Number(li.dataset.idx);
      const t = ais.getTarget(idx);
      if (!t?.position) return;
      popup.remove();
      handleAisClick(coordinate, t);
    });
  }

  // Add / remove chart tile layers when selection changes
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
        fetchAndResolveStyle(newStyleUrl)
          .then(resolved => m.setStyle(resolved as maplibregl.StyleSpecification, { diff: false }))
          .catch(e => console.error('[map] Failed to load style', newStyleUrl, e));
      } else {
        m.setStyle(DEFAULT_STYLE, { diff: false });
      }
      return;
    }

    // Remove deselected tile-based chart layers.
    // Style-based charts never create a chart-* source/layer, so this is safe for them too.
    for (const id of Object.keys(avail)) {
      if (sel.has(id) && !avail[id].style) continue;
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
        if (chart.format === 'pbf') {
          const sourceLayer = chart.layers?.[0] ?? id;
          m.addLayer({ id: layerId, type: 'fill', source: sourceId, 'source-layer': sourceLayer }, 'vessel-gc-line');
        } else {
          m.addLayer({ id: layerId, type: 'raster', source: sourceId }, 'vessel-gc-line');
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


  $effect(() => {
    if (!map || !mapLoaded) return;
    const iconData = makeVesselIconData(64, settings.appearance.vesselColor);
    map.updateImage('vessel-icon', { width: 64, height: 64, data: iconData.data });
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
    const _coldVer = ais.coldVersion; // register reactive dependency on cold data changes

    const S = AIS_HOT_STRIDE;
    const features: GeoJSON.Feature[] = [];
    if (hotData && ids.length > 0) {
      for (let i = 0; i < ids.length; i++) {
        features.push({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [hotData[i * S + AIS_F_LON], hotData[i * S + AIS_F_LAT]],
          },
          properties: { label: coldMap.get(ids[i])?.name ?? '' },
        });
      }
    }

    const flush = () => {
      _aisLastUpdateMs = Date.now();
      aisSrc.setData({ type: 'FeatureCollection', features });
      if ((window as any).__mapDiag) (window as any).__mapDiag.aisLabels++;
    };
    _pendingAisSetData = flush;

    const remaining = 1000 - (Date.now() - _aisLastUpdateMs);
    if (remaining <= 0) {
      if (_aisThrottleId !== null) { clearTimeout(_aisThrottleId); _aisThrottleId = null; }
      flush();
      _pendingAisSetData = null;
    } else if (_aisThrottleId === null) {
      _aisThrottleId = setTimeout(() => {
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
    const _coldVer = ais.coldVersion; // register reactive dependency on cold data changes
    const ap = settings.appearance.ais;
    const settingsIconSize = ap.vesselSize / 64;
    const now = Date.now();

    // Capture COG line settings explicitly so Svelte 5 tracks them as dependencies
    // and the closures below always close over the current values.
    const cogColor         = ap.cog.color;
    const cogWidth         = ap.cog.width;
    const cogStyle         = ap.cog.style;
    const cogLengthMinutes = ap.cog.lengthMinutes;

    if (!hotData || ids.length === 0) {
      aisLayerGroup = [];
      flushLayers();
      aisHotSnapshot    = null;
      aisIdsSnapshot    = [];
      aisUploadTimestamp = 0;
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
      const cold = coldMap.get(ids[i]);
      const ns = cold?.navState?.toLowerCase() ?? '';
      const isSart = ns.includes('sart') || ns.includes('transponder');

      if (isSart) {
        sarIndices.push(i);
        continue;
      }

      visIndices.push(i);

      // Motion — SOG only, nav state irrelevant
      const isog = hotData[i * S + AIS_F_SOG];
      const icog = hotData[i * S + AIS_F_COG];
      if (!isNaN(icog) && !isNaN(isog) && isog > 0.1) {
        ghostIndices.push(i);
        cogIndices.push(i);
      }

      // Hull — heading + dimensions only
      const ihdg = hotData[i * S + AIS_F_HDG];
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
    aisHotSnapshot     = hotData;
    aisIdsSnapshot     = ids;
    aisUploadTimestamp = now;

    const vesselColor      = hexToRgba(ap.vesselColor, 220);
    const ghostVesselColor = hexToRgba(ap.vesselColor, 130);

    // Accessor lambdas — close over hotData, coldMap, ids. Zero allocations per frame.
    const getPos  = (i: number): [number, number, number] => [hotData[i * S + AIS_F_LON], hotData[i * S + AIS_F_LAT], 0];
    const getSog  = (i: number) => { const v = hotData[i * S + AIS_F_SOG]; return isNaN(v) ? 0 : v; };
    const getCog  = (i: number) => { const v = hotData[i * S + AIS_F_COG]; return isNaN(v) ? 0 : v; };
    const getHdg  = (i: number) => { const h = hotData[i * S + AIS_F_HDG]; if (!isNaN(h)) return h; const c = hotData[i * S + AIS_F_COG]; return isNaN(c) ? 0 : c; };
    const getHdgStrict = (i: number) => { const h = hotData[i * S + AIS_F_HDG]; return isNaN(h) ? 0 : h; };
    const getRot  = (i: number) => { const v = hotData[i * S + AIS_F_ROT]; return isNaN(v) ? 0 : v; };
    const getAge  = (i: number) => hotData[i * S + AIS_F_AGE];
    const getLen  = (i: number, fallback: number) => coldMap.get(ids[i])?.lengthM ?? fallback;
    const getBeam = (i: number, fallback: number) => coldMap.get(ids[i])?.beamM ?? fallback;

    const ghostIconLayer = ghostIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-ghost-icon',
          data: ghostIndices,
          getPosition:    getPos,
          getSog:         getSog,
          getCog:         getCog,
          getHeading:     getHdg,
          getRot:         getRot,
          getAgeAtUpload: getAge,
          getLength:      (i) => getLen(i, 0),
          getColor:       ghostVesselColor,
          uploadTimestamp: now,
          selfAnimate: true,
          settingsIconSize,
          pickable: true,
        })
      : null;

    // Arrow layer — all vessels, always.
    const confirmedIconLayer = new AisIconLayer({
      id: 'ais-confirmed-icon',
      data: visIndices,
      getPosition:    getPos,
      getSog:         () => 0,
      getCog:         () => 0,
      getHeading:     getHdg,
      getRot:         () => 0,
      getAgeAtUpload: () => 0,
      getLength:      (i) => getLen(i, 0),
      getColor:       vesselColor,
      uploadTimestamp: now,
      selfAnimate: false,
      settingsIconSize,
      pickable: true,
    });

    // Anchor-dot overlay — nav state only, arrow already drawn above.
    const anchoredIconLayer = anchoredIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-anchored-icon',
          data: anchoredIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 0),
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: ANCHOR_DOT_GEOMETRY,
          pickable: false,
        })
      : null;

    // Mooring-bars overlay — nav state only, arrow already drawn above.
    const mooredIconLayer = mooredIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-moored-icon',
          data: mooredIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 0),
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: MOORING_BARS_GEOMETRY,
          pickable: false,
        })
      : null;

    // Aground circle overlay — nav state only, arrow already drawn above.
    const agroundIconLayer = agroundIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-aground-icon',
          data: agroundIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 0),
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: AGROUND_CIRCLE_GEOMETRY,
          pickable: false,
        })
      : null;

    // Fishing gear overlay — nav state "fishing" / "engagedInFishing".
    const fishingIconLayer = fishingIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-fishing-icon',
          data: fishingIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 0),
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: FISHING_GEAR_GEOMETRY,
          pickable: false,
        })
      : null;

    // NUC overlay — nav state 2.
    const nucIconLayer = nucIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-nuc-icon',
          data: nucIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 0),
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: NUC_GEOMETRY,
          pickable: false,
        })
      : null;

    // Restricted manoeuvrability overlay — nav state 3.
    const restrictedIconLayer = restrictedIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-restricted-icon',
          data: restrictedIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 0),
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          iconGeometry: RESTRICTED_MANOEUVRING_GEOMETRY,
          pickable: false,
        })
      : null;

    // Constrained by draught overlay — nav state 4.
    const draughtIconLayer = draughtIndices.length > 0
      ? new AisIconLayer({
          id: 'ais-draught-icon',
          data: draughtIndices,
          getPosition:    getPos,
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     getHdg,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (i) => getLen(i, 0),
          getColor:       vesselColor,
          uploadTimestamp: now,
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
      ? new AisIconLayer({
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
          uploadTimestamp: now,
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
          uploadTimestamp: now,
          selfAnimate: true,
          settingsIconSize,
          opacity: 0.75,
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
          uploadTimestamp: now,
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
            uploadTimestamp: now,
            selfAnimate: animate,
            settingsIconSize,
            decoration,
          })
        : null;

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

    aisLayerGroup = [
      // bottom: confirmed hull at last-known position (full opacity, static)
      ...(confirmedHullLayer ? [confirmedHullLayer] : []),
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
          const lon  = hotData[i * S + AIS_F_LON];
          const lat  = hotData[i * S + AIS_F_LAT];
          const c    = hotData[i * S + AIS_F_COG];
          const s    = hotData[i * S + AIS_F_SOG];
          const r    = hotData[i * S + AIS_F_ROT];
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
        getDashArray: lineStyleDash(cogStyle, cogWidth),
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

  $effect(() => {
    const ap    = settings.appearance;
    const state = $vesselState;
    const zoom  = mapZoom;
    if (!map || !mapLoaded) return;

    // Paint properties fire immediately — they're cheap and only change when appearance settings change.
    map.setPaintProperty('vessel-gc-line',  'line-color',     ap.gc.color);
    map.setPaintProperty('vessel-gc-line',  'line-width',     ap.gc.width);
    map.setPaintProperty('vessel-gc-line',  'line-dasharray', dashArray(ap.gc.style, ap.gc.width) ?? undefined);
    map.setPaintProperty('vessel-cog-line', 'line-color',     ap.cog.color);
    map.setPaintProperty('vessel-cog-line', 'line-width',     ap.cog.width);
    map.setPaintProperty('vessel-cog-line', 'line-dasharray', dashArray(ap.cog.style, ap.cog.width) ?? undefined);
    map.setPaintProperty('vessel-hdg-line', 'line-color',     ap.heading.color);
    map.setPaintProperty('vessel-hdg-line', 'line-width',     ap.heading.width);
    map.setPaintProperty('vessel-hdg-line', 'line-dasharray', dashArray(ap.heading.style, ap.heading.width) ?? undefined);
    map.setLayoutProperty('vessel-icon',    'icon-size',       ap.vesselSize / 64);

    if (!state.position) return;
    const { longitude, latitude } = state.position;

    function lineDistM(line: LineAppearance, sogMs: number | null): number {
      if (line.lengthUnit === 'nm')  return line.lengthValue * 1852;
      if (line.lengthUnit === 'min') return sogMs !== null ? line.lengthValue * 60 * sogMs : 0;
      // px → meters per pixel at current zoom & latitude (WebMercator, 512px tile)
      const mpp = (Math.cos(latitude * Math.PI / 180) * 40075016.686) / (512 * Math.pow(2, zoom));
      return line.lengthValue * mpp;
    }

    const orientRad  = state.heading ?? state.cog ?? null;
    const bearingDeg = orientRad !== null ? (orientRad * 180) / Math.PI : 0;

    // Compute GeoJSON eagerly (cheap CPU work) so the closure captures the current values.
    const vesselFC: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties: { bearing_deg: bearingDeg } }],
    };
    const cogFC: GeoJSON.FeatureCollection = state.cog !== null ? { type: 'FeatureCollection', features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: rhumbCoords(longitude, latitude, state.cog, lineDistM(ap.cog, state.sog)) },
      properties: {},
    }]} : EMPTY_FC;
    const gcFC: GeoJSON.FeatureCollection = state.cog !== null ? { type: 'FeatureCollection', features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: gcCoords(longitude, latitude, state.cog, lineDistM(ap.gc, state.sog)) },
      properties: {},
    }]} : EMPTY_FC;
    const hdgFC: GeoJSON.FeatureCollection = state.heading !== null ? { type: 'FeatureCollection', features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: (projection === 'globe' ? gcCoords : rhumbCoords)(longitude, latitude, state.heading, lineDistM(ap.heading, state.sog)) },
      properties: {},
    }]} : EMPTY_FC;

    const m = map; // stable reference for the rAF closure

    // Coalesce: multiple Signal K field updates (lat, lon, COG, SOG, heading) fire this effect
    // separately in the same epoch. We only call setData once per animation frame so MapLibre
    // only queues one repaint per epoch instead of ~5–8.
    _pendingVesselSetData = () => {
      const vesselSrc = m.getSource(VESSEL_SOURCE);
      const cogSrc    = m.getSource(COG_SOURCE);
      const gcSrc     = m.getSource(GC_SOURCE);
      const hdgSrc    = m.getSource(HDG_SOURCE);
      if (!(vesselSrc instanceof maplibregl.GeoJSONSource)) return;
      if (!(cogSrc    instanceof maplibregl.GeoJSONSource)) return;
      if (!(gcSrc     instanceof maplibregl.GeoJSONSource)) return;
      if (!(hdgSrc    instanceof maplibregl.GeoJSONSource)) return;
      vesselSrc.setData(vesselFC);
      cogSrc.setData(cogFC);
      gcSrc.setData(gcFC);
      hdgSrc.setData(hdgFC);
      if ((window as any).__mapDiag) (window as any).__mapDiag.ownVessel++;
    };

    if (_vesselRafId === null) {
      _vesselRafId = requestAnimationFrame(() => {
        _vesselRafId = null;
        _pendingVesselSetData?.();
        _pendingVesselSetData = null;
      });
    }
  });

  // Follow + rotation mode: combined into one effect so we never issue two competing
  // easeTo/flyTo calls in the same reactive flush.
  $effect(() => {
    if (!map) return;
    const state = $vesselState;
    const pos = state.position;
    const rm = rotateMode.mode;

    // Compute target bearing. 'manual' and 'course' (TBD) produce no constraint.
    let bearing: number | undefined;
    if (rm === 'north') bearing = 0;
    else if (rm === 'cog'     && state.cog     !== null) bearing = (state.cog     * 180 / Math.PI);
    else if (rm === 'heading' && state.heading  !== null) bearing = (state.heading * 180 / Math.PI);

    if (pos && followMode.following) {
      const center = map.getCenter();
      const dist = Math.hypot(center.lng - pos.longitude, center.lat - pos.latitude);
      const bOpts = bearing !== undefined ? { bearing } : {};
      if (dist > 1) {
        map.flyTo({ center: [pos.longitude, pos.latitude], speed: 1.5, ...bOpts });
      } else {
        map.easeTo({ center: [pos.longitude, pos.latitude], duration: 1000, ...bOpts });
      }
    } else if (bearing !== undefined && !_isInteracting) {
      map.easeTo({ bearing, duration: 300 });
    }
  });
</script>

<div bind:this={mapContainer} style="width: 100%; height: 100%;"></div>

<div class="projection-picker">
  <button
    class="proj-btn"
    class:proj-btn--manual={rotateMode.mode === 'manual'}
    title="Rotation mode: {rotateMode.label}"
    onclick={() => rotateMode.toggle($vesselState.heading !== null, false)}
  >{rotateMode.label}</button>
  <button
    class="proj-btn"
    title="Switch to {projection === 'mercator' ? 'Globe' : 'Mercator'}"
    onclick={() => { setProjection(projection === 'mercator' ? 'globe' : 'mercator'); }}
  ><FaIcon icon={projection === 'mercator' ? faGlobe : faMap} /></button>
  <button
    class="proj-btn"
    title="{isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}"
    onclick={toggleFullscreen}
  ><FaIcon icon={isFullscreen ? faCompress : faExpand} /></button>
</div>

<!-- North indicator: visible whenever map bearing is non-zero.
     The needle always points toward true North.  Clicking snaps back to North-Up. -->
<button
  class="north-indicator"
  class:north-indicator--visible={Math.abs(mapBearing) > 0.5}
  title="Tap to reset to North-Up (bearing {mapBearing.toFixed(1)}°)"
  onclick={() => map?.easeTo({ bearing: 0, duration: 300 })}
  aria-label="Reset to North-Up"
>
  <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
    <circle cx="22" cy="22" r="21" fill="rgba(0,0,0,0.72)" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>
    <g transform="rotate({-mapBearing}, 22, 22)">
      <!-- north half: red -->
      <polygon points="22,5 17,23 22,20 27,23" fill="#e53e3e"/>
      <!-- south half: light grey -->
      <polygon points="22,39 17,21 22,24 27,21" fill="rgba(200,200,200,0.75)"/>
    </g>
    <text x="22" y="15.5" text-anchor="middle" font-size="7" font-family="system-ui,sans-serif"
      fill="rgba(255,255,255,0.55)" transform="rotate({-mapBearing}, 22, 22)">N</text>
  </svg>
</button>

<style>
  .projection-picker {
    position: absolute;
    top: 200px;
    left: 10px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
  }
  .proj-btn {
    background: rgba(0,0,0,0.7);
    border: none;
    color: white;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    transition: background 0.15s;
  }
  .proj-btn:hover { background: rgba(40,40,80,0.9); }
  .proj-btn--manual { color: #f59e0b; }

  .north-indicator {
    position: absolute;
    top: 80px;
    right: 10px;
    z-index: 10;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
    border-radius: 50%;
  }
  .north-indicator--visible {
    opacity: 1;
    pointer-events: auto;
  }
  .north-indicator:hover circle { fill: rgba(30,30,70,0.85); }

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
    gap: 8px;
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
  :global(.ais-links a:hover) {
    background: rgba(96,165,250,0.2);
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
  :global(.ais-disambig-item:hover) {
    background: rgba(96, 165, 250, 0.18);
    color: #93c5fd;
  }
  :global(.maplibregl-popup-tip) { border-top-color: #1e1e2e; }
  :global(.maplibregl-popup-close-button) { color: #888; font-size: 16px; }
  /* Ensure MapLibre popups (DOM elements) always render above the deck.gl WebGL canvas */
  :global(.maplibregl-popup) { z-index: 10; }
</style>
