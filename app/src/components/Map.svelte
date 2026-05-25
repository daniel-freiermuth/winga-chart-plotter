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
  import { followMode } from '../stores/follow.svelte';
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';
  import { ais, type AisTarget } from '../stores/ais.svelte';
  import { MapboxOverlay } from '@deck.gl/mapbox';
  import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
  import { PathStyleExtension } from '@deck.gl/extensions';
  import type { Layer, PickingInfo } from '@deck.gl/core';
  import { rulers, rulerBearingText, rulerDistanceText, type Ruler, type RulerEndpoint } from '../stores/rulers.svelte';
  import { gcLine } from '../lib/geoMath';
  import { AisHullLayer } from '../layers/AisHullLayer';
  import { AisIconLayer } from '../layers/AisIconLayer';
  import { makeVesselIconData, extrapolatePos, positionUpdateMs } from '../lib/deadReckoning';

  type ProjectionId = 'mercator' | 'globe';

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

  function dashArray(style: LineStyle, width: number): number[] {
    const w = Math.max(1, width);
    switch (style) {
      case 'dashed':   return [5, 3];
      case 'dotted':   return [w / w, 3];  // dot = 1 unit wide, gap = 3
      case 'dash-dot': return [5, 3, 1, 3];
      default:         return [1, 0];       // solid
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
  // All AIS targets with a known position — used for ruler snap hit-test in rafTick:
  let allVisTargets: AisTarget[] = [];
  // Layer groups composed into overlay.setProps() — AIS layers set on data tick,
  // ruler layers rebuilt in rafTick (need map.project() for pixel distance checks).
  let aisLayerGroup: Layer[] = [];
  let rulerLayerGroup: Layer[] = [];

  function flushLayers() {
    overlay?.setProps({ layers: [...aisLayerGroup, ...rulerLayerGroup] });
  }

  let rafId = 0;

  onMount(() => {
    map = new maplibregl.Map({
      container: mapContainer,
      style: {
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
      },
      center: [10.75, 59.91],
      zoom: 10,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

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
      if (overlay !== null) {
        const nowMs = Date.now();

        // Build live snap targets every frame.
        // For moving vessels: two snap points — last-known (id) and dead-reckoned (id+':ghost').
        // For stationary vessels: one snap point at last-known position.
        // Own vessel always included.
        const ownPosForSnap = get(vesselState).position;
        {
          const nowForSnap = nowMs;
          liveSnapTargets = [
            ...allVisTargets.flatMap(t => {
              const lastKnown = { id: t.id, position: { longitude: t.position!.longitude, latitude: t.position!.latitude } };
              if (t.cog !== undefined && (t.sog ?? 0) > 0.1) {
                const [gLon, gLat] = extrapolatePos(
                  t.position!.longitude, t.position!.latitude,
                  t.cog, t.sog ?? 0, t.rot ?? 0,
                  positionUpdateMs(t), nowForSnap,
                );
                return [
                  lastKnown,
                  { id: t.id + ':ghost', position: { longitude: gLon, latitude: gLat } },
                ];
              }
              return [lastKnown];
            }),
            ...(ownPosForSnap ? [{ id: 'own-vessel', position: { longitude: ownPosForSnap.longitude, latitude: ownPosForSnap.latitude } }] : []),
          ];
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
              pickable: false,
              updateTriggers: { getText: [currentRulers], getPosition: [currentRulers] },
            }),

            // Delete handle (×) at B endpoint
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
      rafId = requestAnimationFrame(rafTick);
    }
    rafId = requestAnimationFrame(rafTick);

    // Native ruler drag — must be capture phase so we intercept before MapLibre.
    mapContainer.addEventListener('pointerdown', handleRulerPointerDown, { capture: true });
    mapContainer.addEventListener('pointermove', handleRulerPointerMove, { capture: true });
    mapContainer.addEventListener('pointerup',   handleRulerPointerUp,   { capture: true });
    mapContainer.addEventListener('pointercancel', handleRulerPointerUp, { capture: true });

    onFsChange = () => { isFullscreen = !!document.fullscreenElement; };
    document.addEventListener('fullscreenchange', onFsChange);

    map.on('zoom',   () => { mapZoom    = map?.getZoom()    ?? mapZoom; });
    map.on('rotate', () => { mapBearing = map?.getBearing() ?? mapBearing; });
    // User dragging the map cancels follow mode.
    map.on('dragstart', () => { if (!rulerDrag) followMode.following = false; });

    // AIS vessel click — pick manually to stay consistent with ruler pointer handling.
    map.on('click', (e) => {
      if (!overlay) return;
      const { x, y } = e.point;
      const aisLayerIds = ['ais-confirmed-icon', 'ais-hull-ghost', 'ais-hull-confirmed', 'ais-ghost-icon'];
      const picked = overlay.pickObject({ x, y, radius: 5, layerIds: aisLayerIds });
      if (!picked?.object) return;
      const target = picked.object as AisTarget;
      if (!target?.position) return;
      handleAisClick({ ...picked, object: target });
    });

    // style.load fires on initial style ready AND after MapLibre's internal setStyle
    // (which it calls automatically on WebGL context restore), so this covers both cases.
    map.on('style.load', () => {
      const m = map;
      if (!m) return;
      const ap = settings.appearance;
      m.addImage('vessel-icon', { width: 64, height: 64, data: makeVesselIconData(64, ap.vesselColor).data });

      m.addSource(VESSEL_SOURCE, { type: 'geojson', data: EMPTY_FC });
      m.addSource(COG_SOURCE,    { type: 'geojson', data: EMPTY_FC });
      m.addSource(HDG_SOURCE,    { type: 'geojson', data: EMPTY_FC });
      m.addSource(GC_SOURCE,     { type: 'geojson', data: EMPTY_FC });
      m.addSource(AIS_SOURCE,    { type: 'geojson', data: EMPTY_FC }); // for ais-label only

      m.addLayer({ id: 'vessel-gc-line', type: 'line', source: GC_SOURCE,
        paint: { 'line-color': ap.gc.color, 'line-width': ap.gc.width, 'line-dasharray': dashArray(ap.gc.style, ap.gc.width) } });

      // AIS vessel icon, hull, and COG line are rendered by deck.gl (see $effect below).
      // Only the text label stays in MapLibre for quality text rendering + collision detection.
      m.addLayer({ id: 'ais-label', type: 'symbol', source: AIS_SOURCE,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 10,
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
          'text-optional': true,
        },
        paint: { 'text-color': settings.appearance.ais.vesselColor, 'text-halo-color': '#000', 'text-halo-width': 1 },
      });

      m.addLayer({ id: 'vessel-cog-line', type: 'line', source: COG_SOURCE,
        paint: { 'line-color': ap.cog.color, 'line-width': ap.cog.width, 'line-dasharray': dashArray(ap.cog.style, ap.cog.width) } });

      m.addLayer({ id: 'vessel-hdg-line', type: 'line', source: HDG_SOURCE,
        paint: { 'line-color': ap.heading.color, 'line-width': ap.heading.width } });

      m.addLayer({ id: 'vessel-icon', type: 'symbol', source: VESSEL_SOURCE,
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

    const posMs = positionUpdateMs(t);
    const lastSeenDate = new Date(posMs);
    const lastSeenTime = lastSeenDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const ageSec = Math.round((Date.now() - posMs) / 1000);
    const ageStr = ageSec < 60
      ? `${ageSec}s ago`
      : ageSec < 3600
        ? `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`
        : `${Math.floor(ageSec / 3600)}h ${Math.floor((ageSec % 3600) / 60)}m ago`;

    return `
      <div class="ais-popup">
        <div class="ais-popup-title">${t.name ?? t.mmsi ?? 'Unknown vessel'}</div>
        <table>
          ${row('MMSI',     t.mmsi     ?? null)}
          ${row('Type',     t.shipType ?? null)}
          ${row('Position', lon !== undefined && lat !== undefined ? `${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E` : null)}
          ${row('Updated',  `${lastSeenTime} <span style="opacity:0.6;font-size:0.85em">(${ageStr})</span>`)}
          <tr><td colspan="2" class="ais-section">Navigation</td></tr>
          ${row('SOG',     t.sog     !== undefined ? (t.sog     * 1.94384).toFixed(1) : null, ' kn')}
          ${row('STW',     t.stw     !== undefined ? (t.stw     * 1.94384).toFixed(1) : null, ' kn')}
          ${row('COG',     t.cog     !== undefined ? (t.cog     * 180 / Math.PI).toFixed(1) : null, '°')}
          ${row('Heading', t.heading !== undefined ? (t.heading * 180 / Math.PI).toFixed(1) : null, '°')}
          ${row('ROT',     rotStr)}
          <tr><td colspan="2" class="ais-section">Dimensions</td></tr>
          ${row('Length',  t.lengthM ?? null, ' m')}
          ${row('Beam',    t.beamM   ?? null, ' m')}
          ${row('Draft',   t.draftM  ?? null, ' m')}
        </table>
        ${lookupLinks}
      </div>`;
  }

  function handleAisClick(info: PickingInfo): boolean {
    const t = info.object as AisTarget | null | undefined;
    if (!t?.position || !info.coordinate) return false;
    new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
      .setLngLat(info.coordinate as [number, number])
      .setHTML(buildAisPopupHtml(t))
      .addTo(map!);
    return true;
  }

  // Add / remove chart tile layers when selection changes
  $effect(() => {
    if (!map || !mapLoaded) return;
    const m   = map;
    const sel = charts.selected;
    const avail = charts.available;

    // Remove deselected chart layers
    for (const id of Object.keys(avail)) {
      if (!sel.has(id)) {
        const layerId  = `chart-layer-${id}`;
        const sourceId = `chart-${id}`;
        if (m.getLayer(layerId))   m.removeLayer(layerId);
        if (m.getSource(sourceId)) m.removeSource(sourceId);
        chartSourceUrls.delete(id);
      }
    }

    // Add newly selected chart layers below vessel overlays
    for (const [id, chart] of Object.entries(avail)) {
      if (!sel.has(id)) continue;
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
        if (chart.format === 'pbf') {
          m.addSource(sourceId, { type: 'vector', tiles: [tileUrl] });
        } else {
          m.addSource(sourceId, {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
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

  // Toggle base layer visibility when store changes
  $effect(() => {
    if (!map || !mapLoaded) return;
    const enabled = baseLayers.enabled;
    for (const layer of BASE_LAYERS) {
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
  $effect(() => {
    if (!map || !mapLoaded) return;
    const aisSrc = map.getSource(AIS_SOURCE);
    if (!(aisSrc instanceof maplibregl.GeoJSONSource)) return;
    const features: GeoJSON.Feature[] = ais.targets
      .filter(t => t.position)
      .map(t => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [t.position!.longitude, t.position!.latitude] },
        properties: { label: t.name ?? '' },
      }));
    aisSrc.setData({ type: 'FeatureCollection', features });
  });

  // Rebuild deck.gl AIS layers on AIS tick or appearance settings change.
  // Zoom is read from the live viewport in draw() — no rebuild needed on zoom changes.
  $effect(() => {
    const targets = ais.targets;
    const ap = settings.appearance.ais;
    const settingsIconSize = ap.vesselSize / 64;
    const now = Date.now();

    // Capture COG line settings explicitly so Svelte 5 tracks them as dependencies
    // and the closures below always close over the current values.
    const cogColor        = ap.cog.color;
    const cogWidth        = ap.cog.width;
    const cogStyle        = ap.cog.style;
    const cogLengthMinutes = ap.cog.lengthMinutes;

    const visTargets = targets.filter(t => t.position);
    const hasHull = (t: AisTarget) =>
      t.heading !== undefined && t.lengthM !== undefined && t.beamM !== undefined;
    const cogTargets  = visTargets.filter(t => t.cog !== undefined && (t.sog ?? 0) > 0.1);

    const vesselColor      = hexToRgba(ap.vesselColor, 220);
    const ghostVesselColor = hexToRgba(ap.vesselColor, 130);

    allVisTargets = visTargets;
    const ghostTargets = visTargets.filter(t => t.cog !== undefined && (t.sog ?? 0) > 0.1);
    const hullTargets  = visTargets.filter(hasHull);

    // Create layer instances once per AIS data tick.
    // Animated layers set selfAnimate=true and drive their own repaint from draw().
    // No per-frame setProps() for AIS — only flushLayers() when the group changes.

    const ghostIconLayer = ghostTargets.length > 0
      ? new AisIconLayer({
          id: 'ais-ghost-icon',
          data: ghostTargets,
          getPosition:    (t: AisTarget) => [t.position!.longitude, t.position!.latitude, 0],
          getSog:         (t: AisTarget) => t.sog     ?? 0,
          getCog:         (t: AisTarget) => t.cog     ?? 0,
          getHeading:     (t: AisTarget) => t.heading ?? t.cog ?? 0,
          getRot:         (t: AisTarget) => t.rot     ?? 0,
          getAgeAtUpload: (t: AisTarget) => (now - positionUpdateMs(t)) / 1000,
          getLength:      (t: AisTarget) => t.lengthM ?? 0,
          getColor:       ghostVesselColor,
          uploadTimestamp: now,
          selfAnimate: true,
          settingsIconSize,
          pickable: true,
        })
      : null;

    const confirmedIconLayer = allVisTargets.length > 0
      ? new AisIconLayer({
          id: 'ais-confirmed-icon',
          data: allVisTargets,
          getPosition:    (t: AisTarget) => [t.position!.longitude, t.position!.latitude, 0],
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     (t: AisTarget) => t.heading ?? t.cog ?? 0,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (t: AisTarget) => t.lengthM ?? 0,
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          pickable: true,
        })
      : null;

    const ghostHullLayer = hullTargets.length > 0
      ? new AisHullLayer({
          id: 'ais-hull-ghost',
          data: hullTargets,
          getPosition:    (t: AisTarget) => [t.position!.longitude, t.position!.latitude, 0],
          getSog:         (t: AisTarget) => t.sog     ?? 0,
          getCog:         (t: AisTarget) => t.cog     ?? 0,
          getHeading:     (t: AisTarget) => t.heading ?? 0,
          getRot:         (t: AisTarget) => t.rot     ?? 0,
          getAgeAtUpload: (t: AisTarget) => (now - positionUpdateMs(t)) / 1000,
          getLength:      (t: AisTarget) => t.lengthM ?? 50,
          getBeam:        (t: AisTarget) => t.beamM   ?? 10,
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: true,
          settingsIconSize,
          opacity: 0.75,
          pickable: true,
        })
      : null;

    const confirmedHullLayer = hullTargets.length > 0
      ? new AisHullLayer({
          id: 'ais-hull-confirmed',
          data: hullTargets,
          getPosition:    (t: AisTarget) => [t.position!.longitude, t.position!.latitude, 0],
          getSog:         () => 0,
          getCog:         () => 0,
          getHeading:     (t: AisTarget) => t.heading ?? 0,
          getRot:         () => 0,
          getAgeAtUpload: () => 0,
          getLength:      (t: AisTarget) => t.lengthM ?? 50,
          getBeam:        (t: AisTarget) => t.beamM   ?? 10,
          getColor:       vesselColor,
          uploadTimestamp: now,
          selfAnimate: false,
          settingsIconSize,
          opacity: 1,
          pickable: true,
        })
      : null;

    aisLayerGroup = [
      // bottom: confirmed hull at last-known position (full opacity, static)
      ...(confirmedHullLayer ? [confirmedHullLayer] : []),
      // ghost hull polygon (GPU animated, 75% opacity)
      ...(ghostHullLayer ? [ghostHullLayer] : []),
      // COG arc prediction line
      new PathLayer<AisTarget>({
        id: 'ais-cog',
        data: cogTargets,
        getPath: (t: AisTarget) => {
          const { longitude, latitude } = t.position!;
          const totalSec = cogLengthMinutes * 60;
          const rot = t.rot ?? 0;
          if (Math.abs(rot) < 1e-4) {
            const [endLon, endLat] = extrapolatePos(longitude, latitude, t.cog!, t.sog ?? 0, 0, 0, totalSec * 1000);
            return [[longitude, latitude], [endLon, endLat]];
          }
          const N = 24;
          return Array.from({ length: N + 1 }, (_, i) => {
            const [lon, lat] = extrapolatePos(longitude, latitude, t.cog!, t.sog ?? 0, rot, 0, totalSec * i / N * 1000);
            return [lon, lat] as [number, number];
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
          getPath:     [cogLengthMinutes],
          getColor:    [cogColor],
          getWidth:    [cogWidth],
          getDashArray: [cogStyle, cogWidth],
        },
      }),
      // ghost icon (self-animating, above hull)
      ...(ghostIconLayer ? [ghostIconLayer] : []),
      // confirmed icon (static at last-known position, cross-fades with hull)
      ...(confirmedIconLayer ? [confirmedIconLayer] : []),
    ];
    flushLayers();
  });

  $effect(() => {
    const ap    = settings.appearance;
    const state = $vesselState;
    const zoom  = mapZoom;
    if (!map || !mapLoaded) return;

    // Line paint properties
    map.setPaintProperty('vessel-gc-line',  'line-color',     ap.gc.color);
    map.setPaintProperty('vessel-gc-line',  'line-width',     ap.gc.width);
    map.setPaintProperty('vessel-gc-line',  'line-dasharray', dashArray(ap.gc.style, ap.gc.width));
    map.setPaintProperty('vessel-cog-line', 'line-color',     ap.cog.color);
    map.setPaintProperty('vessel-cog-line', 'line-width',     ap.cog.width);
    map.setPaintProperty('vessel-cog-line', 'line-dasharray', dashArray(ap.cog.style, ap.cog.width));
    map.setPaintProperty('vessel-hdg-line', 'line-color',     ap.heading.color);
    map.setPaintProperty('vessel-hdg-line', 'line-width',     ap.heading.width);
    map.setPaintProperty('vessel-hdg-line', 'line-dasharray', dashArray(ap.heading.style, ap.heading.width));
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

    const orientRad = state.heading ?? state.cog ?? null;
    const bearingDeg = orientRad !== null ? (orientRad * 180) / Math.PI : 0;

    const vesselSrc = map.getSource(VESSEL_SOURCE);
    const cogSrc    = map.getSource(COG_SOURCE);
    const gcSrc     = map.getSource(GC_SOURCE);
    const hdgSrc    = map.getSource(HDG_SOURCE);
    if (!(vesselSrc instanceof maplibregl.GeoJSONSource)) return;
    if (!(cogSrc    instanceof maplibregl.GeoJSONSource)) return;
    if (!(gcSrc     instanceof maplibregl.GeoJSONSource)) return;
    if (!(hdgSrc    instanceof maplibregl.GeoJSONSource)) return;

    vesselSrc.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties: { bearing_deg: bearingDeg } }],
    });

    cogSrc.setData(
      state.cog !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: rhumbCoords(longitude, latitude, state.cog, lineDistM(ap.cog, state.sog)) },
        properties: {},
      }]} : EMPTY_FC
    );

    gcSrc.setData(
      state.cog !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: gcCoords(longitude, latitude, state.cog, lineDistM(ap.gc, state.sog)) },
        properties: {},
      }]} : EMPTY_FC
    );

    hdgSrc.setData(
      state.heading !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: (projection === 'globe' ? gcCoords : rhumbCoords)(longitude, latitude, state.heading, lineDistM(ap.heading, state.sog)) },
        properties: {},
      }]} : EMPTY_FC
    );
  });

  // Follow mode: smoothly track vessel position. Uses flyTo for large distances
  // (first enable), easeTo for incremental updates.
  $effect(() => {
    const pos = $vesselState.position;
    if (!pos || !map || !followMode.following) return;
    const center = map.getCenter();
    const dist = Math.hypot(center.lng - pos.longitude, center.lat - pos.latitude);
    if (dist > 1) {
      map.flyTo({ center: [pos.longitude, pos.latitude], speed: 1.5 });
    } else {
      map.easeTo({ center: [pos.longitude, pos.latitude], duration: 1000 });
    }
  });
</script>

<div bind:this={mapContainer} style="width: 100%; height: 100%;"></div>

<div class="projection-picker">
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
  :global(.maplibregl-popup-tip) { border-top-color: #1e1e2e; }
  :global(.maplibregl-popup-close-button) { color: #888; font-size: 16px; }
  /* Ensure MapLibre popups (DOM elements) always render above the deck.gl WebGL canvas */
  :global(.maplibregl-popup) { z-index: 10; }
</style>
