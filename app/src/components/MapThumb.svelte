<script lang="ts">
  import type { StyleSpecification } from 'maplibre-gl';
  import maplibregl from 'maplibre-gl';
  import { untrack } from 'svelte';
  import { mapStyles } from '../stores/mapStyles.svelte';
  import { chartBoundsContain, chartBoundsCenter } from '../lib/wasmGeo';
  import type { MapViewStore } from '../stores/mapView.svelte';

  let {
    /**
     * Either a MapLibre style JSON URL (string) or an already-resolved
     * StyleSpecification object (e.g. a minimal raster-source style built
     * inline for tile-based charts).  URL strings are fetched, preprocessed
     * (config/pitch expressions substituted), and resolved before being
     * handed to MapLibre.
     */
    style,
    /**
     * Optional geographic bounds [west, south, east, north].  When provided,
     * the camera snaps to the current map position if it falls inside the
     * bounds, otherwise shows the geographic centre of the chart.  When
     * omitted, the camera follows view.center directly.
     */
    bounds,
    /** Camera state of the pane this thumbnail previews charts for. */
    view,
  }: {
    style: StyleSpecification | string;
    bounds?: [number, number, number, number] | undefined;
    view: MapViewStore;
  } = $props();

  let container = $state<HTMLDivElement | undefined>();
  let resolved  = $state<StyleSpecification | string | null>(null);
  let mapReady  = $state(false);
  let mapRef: maplibregl.Map | null = null;

  // ── Camera — derived from the pane's live view so the parent template never
  //    needs to track view.center/zoom (no re-renders, no style-recreation on pan). ─

  const cameraCenter = $derived.by((): [number, number] => {
    const [lon, lat] = view.center;
    if (bounds) {
      // Dateline-aware, via the WASM geo core: a naive interval test is never
      // true for bounds crossing the antimeridian, and the naive (w+e)/2
      // center lands on the wrong side of the planet.
      const inside = chartBoundsContain(bounds, lon, lat);
      if (inside) return [lon, lat];
      return chartBoundsCenter(bounds);
    }
    return [lon, lat];
  });

  // Follow view.zoom directly — no clamping to chart zoom bounds.
  // Clamping would make previews appear at different scales from each other
  // (too zoomed-in when view.zoom < minzoom, too zoomed-out when view.zoom > maxzoom).
  // MapLibre handles over/under-zoom gracefully; out-of-range tiles render gray.
  const cameraZoom = $derived(view.zoom);

  // ── Style resolution ──────────────────────────────────────────────────────

  $effect(() => {
    const s = style;
    if (typeof s !== 'string') {
      // Already a resolved object — use directly, no fetch needed.
      resolved = s;
      return;
    }
    // URL-based styles resolve through the app-level mapStyles store: shared
    // and cached, so re-opening the picker (or two panes' thumbnails of the
    // same chart) never refetches. This effect re-runs as resolution
    // progresses.
    const res = mapStyles.resolve(s);
    if (res.status === 'loading') { resolved = null; return; }
    if (res.status === 'error')   { resolved = s; return; } // last resort: let MapLibre fetch the URL itself
    // Clone — the store's cached style is shared and must stay pristine.
    // Strip style-level camera so MapLibre's style.load handler (which fires
    // one animation frame after the Map constructor) can't override the camera
    // we set via the constructor options and the camera-follow $effect.
    // The inline rasterStyle() has no such fields, so only URL-based styles need this.
    const { center: _c, zoom: _z, bearing: _b, pitch: _p, roll: _r, ...rest } = structuredClone(res.style);
    resolved = rest;
  });

  // ── Map lifecycle ─────────────────────────────────────────────────────────

  // Create the MapLibre instance only when container or style changes.
  // Camera is read with untrack() so pan events never trigger a recreation.
  $effect(() => {
    if (!container || !resolved) return;
    const m = new maplibregl.Map({
      container,
      style:              resolved,
      center:             untrack(() => cameraCenter),
      zoom:               untrack(() => cameraZoom),
      interactive:        false,
      attributionControl: false,
      fadeDuration:       0,
      renderWorldCopies:  false,
    });
    mapRef   = m;
    mapReady = true;
    return () => { mapReady = false; mapRef = null; m.remove(); };
  });

  // Follow the live map camera without recreating the MapLibre instance.
  $effect(() => {
    if (!mapReady || !mapRef) return;
    mapRef.jumpTo({ center: cameraCenter, zoom: cameraZoom });
  });
</script>

<div bind:this={container} class="map-thumb"></div>

<style>
  .map-thumb {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
