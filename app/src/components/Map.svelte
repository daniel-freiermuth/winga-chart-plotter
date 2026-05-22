<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { vesselState } from '../stores/vessel';

  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map | undefined;
  let marker: maplibregl.Marker | undefined;

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
      projection: { type: 'mercator' }, // start mercator, globe next
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    // Vessel marker
    const el = document.createElement('div');
    el.style.cssText = `
      width: 20px; height: 20px;
      background: #2563eb;
      border: 3px solid white;
      border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    `;

    marker = new maplibregl.Marker({ element: el, anchor: 'center' });
  });

  onDestroy(() => {
    marker?.remove();
    map?.remove();
  });

  // React to vessel position updates from the store
  $effect(() => {
    const state = $vesselState;
    if (map && state.position) {
      const { longitude, latitude } = state.position;
      if (!marker) return;
      marker.setLngLat([longitude, latitude]);
      if (!marker.getLngLat) return; // not yet added
      marker.addTo(map);
    }
  });
</script>

<div bind:this={mapContainer} style="width: 100%; height: 100%;"></div>
