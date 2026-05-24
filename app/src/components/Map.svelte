<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import FaIcon from '../lib/FaIcon.svelte';
  import { faGlobe, faMap, faExpand, faCompress } from '@fortawesome/free-solid-svg-icons';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import type * as GeoJSON from 'geojson';
  import { vesselState } from '../stores/vessel';
  import { settings, type LineAppearance, type LineStyle } from '../stores/settings.svelte';
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';
  import { ais } from '../stores/ais.svelte';

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
    const pos = $vesselState.position;
    if (pos && map) map.flyTo({ center: [pos.longitude, pos.latitude], speed: 1.5 });
  }
  let mapLoaded = $state(false);
  let mapZoom   = $state(10);
  let projection = $state<ProjectionId>('mercator');

  function setProjection(id: ProjectionId) {
    projection = id;
    map?.setProjection({ type: id });
  }

  const VESSEL_SOURCE   = 'vessel';
  const COG_SOURCE      = 'vessel-cog';
  const HDG_SOURCE      = 'vessel-hdg';
  const GC_SOURCE       = 'vessel-gc';
  const AIS_SOURCE      = 'ais-targets';
  const AIS_COG_SOURCE  = 'ais-cog';
  const AIS_SHAPE_SOURCE = 'ais-shapes';
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

  /** Return correct GeoJSON geometry for a line, projection-aware. */
  function makeVesselIconData(size: number, color: string): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');
    const cx = size / 2, cy = size / 2, s = size / 32;
    ctx.beginPath();
    ctx.moveTo(cx,          cy - 12 * s); // bow tip
    ctx.lineTo(cx + 8 * s,  cy -  4 * s); // starboard shoulder
    ctx.lineTo(cx + 8 * s,  cy +  9 * s); // starboard aft
    ctx.lineTo(cx,           cy +  6 * s); // stern notch
    ctx.lineTo(cx - 8 * s,  cy +  9 * s); // port aft
    ctx.lineTo(cx - 8 * s,  cy -  4 * s); // port shoulder
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * s;
    ctx.lineJoin = 'round';
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  /**
   * Build the geographic polygon ring for a vessel given its centre position,
   * heading (radians, clockwise from north), length and beam (metres).
   * Uses a flat-earth approximation — fine for vessels up to a few km long.
   */
  function vesselShapeRing(
    lon: number, lat: number,
    headingRad: number,
    lengthM: number, beamM: number,
  ): [number, number][] {
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
    const sinH = Math.sin(headingRad), cosH = Math.cos(headingRad);
    // Forward unit: (sinH, cosH) in (east, north). Right unit: (cosH, -sinH).
    const pt = (fwd: number, rgt: number): [number, number] => [
      lon + (fwd * sinH + rgt * cosH) / mPerDegLon,
      lat + (fwd * cosH - rgt * sinH) / mPerDegLat,
    ];
    const L2 = lengthM / 2, B2 = beamM / 2;
    const shoulder = L2 * 0.6; // bow taper start
    return [
      pt( L2,        0),  // bow tip
      pt( shoulder,  B2), // starboard shoulder
      pt(-L2,        B2), // starboard aft
      pt(-L2,       -B2), // port aft
      pt( shoulder, -B2), // port shoulder
      pt( L2,        0),  // close
    ];
  }

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

    onFsChange = () => { isFullscreen = !!document.fullscreenElement; };
    document.addEventListener('fullscreenchange', onFsChange);

    map.on('zoom', () => { mapZoom = map?.getZoom() ?? mapZoom; });

    // style.load fires on initial style ready AND after MapLibre's internal setStyle
    // (which it calls automatically on WebGL context restore), so this covers both cases.
    map.on('style.load', () => {
      const m = map;
      if (!m) return;
      const ap = settings.appearance;
      m.addImage('vessel-icon', { width: 64, height: 64, data: makeVesselIconData(64, ap.vesselColor).data });
      m.addImage('ais-icon',    { width: 64, height: 64, data: makeVesselIconData(64, ap.ais.vesselColor).data });

      m.addSource(VESSEL_SOURCE,    { type: 'geojson', data: EMPTY_FC });
      m.addSource(COG_SOURCE,       { type: 'geojson', data: EMPTY_FC });
      m.addSource(HDG_SOURCE,       { type: 'geojson', data: EMPTY_FC });
      m.addSource(GC_SOURCE,        { type: 'geojson', data: EMPTY_FC });
      m.addSource(AIS_SOURCE,       { type: 'geojson', data: EMPTY_FC });
      m.addSource(AIS_COG_SOURCE,   { type: 'geojson', data: EMPTY_FC });
      m.addSource(AIS_SHAPE_SOURCE, { type: 'geojson', data: EMPTY_FC });

      m.addLayer({ id: 'vessel-gc-line', type: 'line', source: GC_SOURCE,
        paint: { 'line-color': ap.gc.color, 'line-width': ap.gc.width, 'line-dasharray': dashArray(ap.gc.style, ap.gc.width) } });

      m.addLayer({ id: 'ais-cog-line', type: 'line', source: AIS_COG_SOURCE,
        paint: { 'line-color': settings.appearance.ais.cog.color, 'line-width': settings.appearance.ais.cog.width, 'line-dasharray': dashArray(settings.appearance.ais.cog.style, settings.appearance.ais.cog.width) } });

      // Exact-scale polygon footprints for vessels with known dimensions
      m.addLayer({ id: 'ais-vessel-fill', type: 'fill', source: AIS_SHAPE_SOURCE,
        paint: { 'fill-color': settings.appearance.ais.vesselColor, 'fill-opacity': ['get', 'shape_opacity'] } });
      m.addLayer({ id: 'ais-vessel-outline', type: 'line', source: AIS_SHAPE_SOURCE,
        paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': ['get', 'shape_opacity'] } });

      // Icon for all vessels; fades out as exact shape fades in
      m.addLayer({ id: 'ais-icon', type: 'symbol', source: AIS_SOURCE,
        layout: {
          'icon-image': 'ais-icon',
          'icon-size': ['coalesce', ['get', 'icon_size'], settings.appearance.ais.vesselSize / 64],
          'icon-rotate': ['get', 'bearing_deg'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': ['get', 'icon_opacity'] },
      });

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

      mapLoaded = true;
    }); // end style.load

    // Event handlers on the Map object persist across style reloads — register once.
    // Query both AIS layers at once to avoid double-popup when icon and fill overlap.
    const showAisPopup = (e: maplibregl.MapMouseEvent) => {
      const features = map!.queryRenderedFeatures(e.point, { layers: ['ais-icon', 'ais-vessel-fill'] });
      const feature = features[0];
      if (!feature) return;
      const p = feature.properties as Record<string, string | number | null>;
      const coords = feature.geometry.type === 'Point'
        ? (feature.geometry as GeoJSON.Point).coordinates
        : e.lngLat.toArray();
      const [lon, lat] = coords;

      const row = (label: string, value: string | number | null, unit = '') =>
        value !== null ? `<tr><td>${label}</td><td><b>${String(value)}${unit}</b></td></tr>` : '';

      const rotVal = p['rot_dpm'] !== null ? Number(p['rot_dpm']) : null;
      const rotStr = rotVal !== null
        ? `${rotVal > 0 ? '▶ ' : rotVal < 0 ? '◀ ' : ''}${Math.abs(rotVal)}°/min`
        : null;

      const html = `
        <div class="ais-popup">
          <div class="ais-popup-title">${String(p['name'] ?? p['mmsi'] ?? 'Unknown vessel')}</div>
          <table>
            ${row('MMSI',     p['mmsi'])}
            ${row('Type',     p['ship_type'])}
            ${row('Position', `${String(p['lat'])}°N, ${String(p['lon'])}°E`)}
            <tr><td colspan="2" class="ais-section">Navigation</td></tr>
            ${row('SOG',      p['sog_kn'],  ' kn')}
            ${row('STW',      p['stw_kn'],  ' kn')}
            ${row('COG',      p['cog_deg'], '°')}
            ${row('Heading',  p['hdg_deg'], '°')}
            ${row('ROT',      rotStr)}
            <tr><td colspan="2" class="ais-section">Dimensions</td></tr>
            ${row('Length',   p['length_m'], ' m')}
            ${row('Beam',     p['beam_m'],   ' m')}
            ${row('Draft',    p['draft_m'],  ' m')}
          </table>
        </div>`;

      new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat([lon, lat])
        .setHTML(html)
        .addTo(map!);
    };

    map.on('mouseenter', 'ais-icon',         () => { map!.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'ais-icon',         () => { map!.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'ais-vessel-fill',  () => { map!.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'ais-vessel-fill',  () => { map!.getCanvas().style.cursor = ''; });
    map.on('click', showAisPopup);

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
    document.removeEventListener('fullscreenchange', onFsChange);
    map?.remove();
  });

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

  $effect(() => {
    if (!map || !mapLoaded) return;
    const ap = settings.appearance.ais;
    const aisIconData = makeVesselIconData(64, ap.vesselColor);
    map.updateImage('ais-icon', { width: 64, height: 64, data: aisIconData.data });
    // icon-size is data-driven (per-feature, based on vessel length); only update paint/style here
    map.setPaintProperty('ais-vessel-fill', 'fill-color', ap.vesselColor);
    map.setPaintProperty('ais-cog-line', 'line-color', ap.cog.color);
    map.setPaintProperty('ais-cog-line', 'line-width', ap.cog.width);
    map.setPaintProperty('ais-cog-line', 'line-dasharray', dashArray(ap.cog.style, ap.cog.width));
    map.setPaintProperty('ais-label', 'text-color', ap.vesselColor);
  });

  // Update AIS targets on map
  $effect(() => {
    if (!map || !mapLoaded) return;
    const targets = ais.targets;
    const zoom = mapZoom;
    const settingsIconSize = settings.appearance.ais.vesselSize / 64;
    const aisSrc     = map.getSource(AIS_SOURCE);
    const aisCogSrc  = map.getSource(AIS_COG_SOURCE);
    const aisShapeSrc = map.getSource(AIS_SHAPE_SOURCE);
    if (!(aisSrc     instanceof maplibregl.GeoJSONSource)) return;
    if (!(aisCogSrc  instanceof maplibregl.GeoJSONSource)) return;
    if (!(aisShapeSrc instanceof maplibregl.GeoJSONSource)) return;

    const pointFeatures:  GeoJSON.Feature[] = [];
    const shapeFeatures:  GeoJSON.Feature[] = [];
    const cogLines:       GeoJSON.Feature[] = [];

    for (const t of targets) {
      if (!t.position) continue;
      const { longitude, latitude } = t.position;
      const headingRad = t.heading ?? t.cog ?? 0;
      const iconBearingDeg = (headingRad * 180) / Math.PI;

      const metersPerPixel = (40075016.686 * Math.cos(latitude * Math.PI / 180))
                             / (256 * Math.pow(2, zoom));

      // icon-size: real-world scale, minimum = settingsIconSize
      const iconSize = t.lengthM
        ? Math.max(settingsIconSize, t.lengthM / (metersPerPixel * 64))
        : settingsIconSize;

      // Cross-fade: compute transition zoom where real vessel length = minimum icon pixels.
      // Below that zoom → full icon. Above → full shape.
      const hasShape = !!(t.heading !== undefined && t.lengthM && t.beamM);
      let iconOpacity = 1;
      let shapeOpacity = 0;
      if (hasShape) {
        const transitionZoom = Math.log2(
          settingsIconSize * 64 * 40075016.686 * Math.cos(latitude * Math.PI / 180)
          / (t.lengthM! * 256)
        );
        // t01: 0 at (transitionZoom - 1), 1 at (transitionZoom + 1)
        const t01 = Math.max(0, Math.min(1, (zoom - transitionZoom + 1) / 2));
        shapeOpacity = t01 * 0.85;
        iconOpacity  = 1 - t01;
      }

      const sharedProps = {
        id:        t.id,
        name:      t.name      ?? null,
        mmsi:      t.mmsi      ?? null,
        ship_type: t.shipType  ?? null,
        cog_deg:   t.cog    !== undefined ? Number(((t.cog    * 180) / Math.PI).toFixed(1))         : null,
        sog_kn:    t.sog    !== undefined ? Number((t.sog    * 1.94384).toFixed(1))                  : null,
        hdg_deg:   t.heading !== undefined ? Number(((t.heading * 180) / Math.PI).toFixed(1))        : null,
        rot_dpm:   t.rot    !== undefined ? Number(((t.rot    * 180 / Math.PI) * 60).toFixed(1))     : null,
        stw_kn:    t.stw    !== undefined ? Number((t.stw    * 1.94384).toFixed(1))                  : null,
        length_m:  t.lengthM  ?? null,
        beam_m:    t.beamM    ?? null,
        draft_m:   t.draftM   ?? null,
        lat:       Number(latitude.toFixed(5)),
        lon:       Number(longitude.toFixed(5)),
      };

      if (hasShape) {
        const ring = vesselShapeRing(longitude, latitude, headingRad, t.lengthM!, t.beamM!);
        shapeFeatures.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { ...sharedProps, shape_opacity: shapeOpacity },
        });
      }

      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: {
          ...sharedProps,
          bearing_deg:  iconBearingDeg,
          icon_size:    iconSize,
          icon_opacity: iconOpacity,
          label:        t.name ?? '',
        },
      });

      if (t.cog !== undefined && t.sog !== undefined && t.sog > 0.1) {
        const distM = t.sog * 3 * 60;
        cogLines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: rhumbCoords(longitude, latitude, t.cog, distM) },
          properties: {},
        });
      }
    }

    aisSrc.setData({ type: 'FeatureCollection', features: pointFeatures });
    aisShapeSrc.setData({ type: 'FeatureCollection', features: shapeFeatures });
    aisCogSrc.setData({ type: 'FeatureCollection', features: cogLines });
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

    function lineDistM(line: LineAppearance): number {
      if (line.lengthUnit === 'nm')  return line.lengthValue * 1852;
      if (line.lengthUnit === 'min') return state.sog !== null ? line.lengthValue * 60 * state.sog : 0;
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
        geometry: { type: 'LineString', coordinates: rhumbCoords(longitude, latitude, state.cog, lineDistM(ap.cog)) },
        properties: {},
      }]} : EMPTY_FC
    );

    gcSrc.setData(
      state.cog !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: gcCoords(longitude, latitude, state.cog, lineDistM(ap.gc)) },
        properties: {},
      }]} : EMPTY_FC
    );

    hdgSrc.setData(
      state.heading !== null ? { type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: rhumbCoords(longitude, latitude, state.heading, lineDistM(ap.heading)) },
        properties: {},
      }]} : EMPTY_FC
    );
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
    top: 160px;
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
  :global(.maplibregl-popup-content) {
    background: #1e1e2e;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    padding: 12px 14px;
  }
  :global(.maplibregl-popup-tip) { border-top-color: #1e1e2e; }
  :global(.maplibregl-popup-close-button) { color: #888; font-size: 16px; }
</style>
