<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { vesselState } from '../stores/vessel';

  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map | undefined;

  const VESSEL_SOURCE = 'vessel';
  const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

  onMount(() => {
    map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
          'openseamap': {
            type: 'raster',
            tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
            tileSize: 256,
          },
        },
        layers: [
          { id: 'osm', type: 'raster', source: 'osm-tiles' },
          { id: 'seamarks', type: 'raster', source: 'openseamap' },
        ],
      },
      center: [10.75, 59.91],
      zoom: 10,
      projection: { type: 'mercator' },
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    map.on('load', () => {
      map!.addSource(VESSEL_SOURCE, { type: 'geojson', data: EMPTY_FC });
      map!.addLayer({
        id: 'vessel-dot',
        type: 'circle',
        source: VESSEL_SOURCE,
        paint: {
          'circle-radius': 8,
          'circle-color': '#2563eb',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff',
          'circle-pitch-alignment': 'map', // rotates with the map, repeats across world copies
        },
      });
    });
  });

  onDestroy(() => { map?.remove(); });

  $effect(() => {
    const state = $vesselState;
    if (!map || !state.position) return;
    const { longitude, latitude } = state.position;
    const source = map.getSource(VESSEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties: {} }],
    });
  });
</script>

<div bind:this={mapContainer} style="width: 100%; height: 100%;"></div>
