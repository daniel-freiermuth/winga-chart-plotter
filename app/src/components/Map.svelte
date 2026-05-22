<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { vesselState } from '../stores/vessel';
  import { settings, type LineAppearance, type LineStyle } from '../stores/settings.svelte';

  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map | undefined;
  let mapLoaded = $state(false);
  let mapZoom   = $state(10);

  const VESSEL_SOURCE = 'vessel';
  const COG_SOURCE    = 'vessel-cog';
  const HDG_SOURCE    = 'vessel-hdg';
  const GC_SOURCE     = 'vessel-gc';
  const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

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
    const λ1 = (lon * Math.PI) / 180;
    const λ2 = λ1 + δ * Math.sin(bearingRad) / q;
    // Return unwrapped longitude — no % 360 normalization
    return [(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI];
  }

  /**
   * Densified rhumb line, 32 segments, truncated at the pole if needed.
   * Truncation is done by computing the exact max distance before overshooting,
   * so no point ever lands at or past ±90° — works correctly on Globe too.
   */
  function rhumbLine(lon: number, lat: number, bearingRad: number, distM: number): [number, number][] {
    const R = 6371000;
    const φ1 = (lat * Math.PI) / 180;
    const cosB = Math.cos(bearingRad);

    // Distance to reach the pole (±π/2) along this bearing
    if (Math.abs(cosB) > 1e-10) {
      const poleφ = cosB > 0 ? Math.PI / 2 : -Math.PI / 2;
      const distToPole = ((poleφ - φ1) / cosB) * R;
      if (distToPole < distM) distM = distToPole;
    }
    // Pure E/W bearing never reaches a pole — no truncation needed

    const SEGMENTS = 32;
    const coords: [number, number][] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      coords.push(destPoint(lon, lat, bearingRad, (i / SEGMENTS) * distM));
    }
    return coords;
  }

  /**
   * Great circle line: 32 segments along the geodesic, unwrapped longitude
   * so antimeridian crossings render correctly on all projections.
   */
  function greatCircleLine(lon: number, lat: number, bearingRad: number, distM: number): [number, number][] {
    const R = 6371000;
    const SEGMENTS = 32;
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

  function makeVesselIconData(size: number, color: string): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2, cy = size / 2, s = size / 32;
    ctx.beginPath();
    ctx.moveTo(cx,          cy - 12 * s); // bow
    ctx.lineTo(cx + 7 * s,  cy +  9 * s); // starboard stern
    ctx.lineTo(cx,           cy +  4 * s); // stern notch
    ctx.lineTo(cx - 7 * s,  cy +  9 * s); // port stern
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2 * s;
    ctx.lineJoin = 'round';
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  onMount(() => {
    map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
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
      projection: { type: 'mercator' },
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    map.on('zoom', () => { mapZoom = map!.getZoom(); });

    map.on('load', () => {
      const ap = settings.appearance;
      const iconData = makeVesselIconData(64, ap.vesselColor);
      map!.addImage('vessel-icon', { width: 64, height: 64, data: iconData.data });

      map!.addSource(VESSEL_SOURCE, { type: 'geojson', data: EMPTY_FC });
      map!.addSource(COG_SOURCE,    { type: 'geojson', data: EMPTY_FC });
      map!.addSource(HDG_SOURCE,    { type: 'geojson', data: EMPTY_FC });
      map!.addSource(GC_SOURCE,     { type: 'geojson', data: EMPTY_FC });

      map!.addLayer({ id: 'vessel-gc-line', type: 'line', source: GC_SOURCE,
        paint: { 'line-color': ap.gc.color, 'line-width': ap.gc.width, 'line-dasharray': dashArray(ap.gc.style, ap.gc.width) } });

      map!.addLayer({ id: 'vessel-cog-line', type: 'line', source: COG_SOURCE,
        paint: { 'line-color': ap.cog.color, 'line-width': ap.cog.width, 'line-dasharray': dashArray(ap.cog.style, ap.cog.width) } });

      map!.addLayer({ id: 'vessel-hdg-line', type: 'line', source: HDG_SOURCE,
        paint: { 'line-color': ap.heading.color, 'line-width': ap.heading.width } });

      map!.addLayer({ id: 'vessel-icon', type: 'symbol', source: VESSEL_SOURCE,
        layout: {
          'icon-image': 'vessel-icon',
          'icon-size': ap.vesselSize / 64,
          'icon-rotate': ['get', 'bearing_deg'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });

      mapLoaded = true;
    });
  });

  onDestroy(() => { map?.remove(); });

  // Update vessel icon when color changes
  $effect(() => {
    if (!map || !mapLoaded) return;
    const iconData = makeVesselIconData(64, settings.appearance.vesselColor);
    map.updateImage('vessel-icon', { width: 64, height: 64, data: iconData.data });
  });

  // Update all layers when vessel state or appearance settings change
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

    function lineDistM(line: LineAppearance): number {
      if (line.lengthUnit === 'nm')  return line.lengthValue * 1852;
      if (line.lengthUnit === 'min') return state.sog !== null ? line.lengthValue * 60 * state.sog : 0;
      // px → meters per pixel at current zoom & latitude (WebMercator, 512px tile)
      const mpp = (Math.cos(latitude * Math.PI / 180) * 40075016.686) / (512 * Math.pow(2, zoom));
      return line.lengthValue * mpp;
    }

    const orientRad = state.heading ?? state.cog ?? null;
    const bearingDeg = orientRad !== null ? (orientRad * 180) / Math.PI : 0;

    (map.getSource(VESSEL_SOURCE) as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties: { bearing_deg: bearingDeg } }],
    });

    (map.getSource(COG_SOURCE) as maplibregl.GeoJSONSource).setData(
      state.cog !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: rhumbLine(longitude, latitude, state.cog, lineDistM(ap.cog)) },
        properties: {},
      }]} : EMPTY_FC
    );

    (map.getSource(GC_SOURCE) as maplibregl.GeoJSONSource).setData(
      state.cog !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: greatCircleLine(longitude, latitude, state.cog, lineDistM(ap.gc)) },
        properties: {},
      }]} : EMPTY_FC
    );

    (map.getSource(HDG_SOURCE) as maplibregl.GeoJSONSource).setData(
      state.heading !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: rhumbLine(longitude, latitude, state.heading, lineDistM(ap.heading)) },
        properties: {},
      }]} : EMPTY_FC
    );
  });
</script>

<div bind:this={mapContainer} style="width: 100%; height: 100%;"></div>
