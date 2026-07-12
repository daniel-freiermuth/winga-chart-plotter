import { SvelteSet } from 'svelte/reactivity';

export interface BaseLayer {
  id: string;
  name: string;
  /** Additional MapLibre layer IDs to toggle in lockstep with `id`. */
  extraLayerIds?: string[];
  /** XYZ tile URL template used for the picker preview thumbnail. */
  tileUrl: string;
}

export const BASE_LAYERS: BaseLayer[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap + OpenSeaMap',
    extraLayerIds: ['seamarks'],
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  },
  {
    id: 'watercolor',
    name: 'Stamen Watercolor',
    tileUrl: 'https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg',
  },
];

const LS_BASE_LAYERS_KEY = 'base-layers-enabled';

function loadEnabledIds(): string[] {
  try {
    const raw = localStorage.getItem(LS_BASE_LAYERS_KEY);
    if (raw) {
      // Filter to known IDs — handles migration from the old two-entry format.
      const known = new Set(BASE_LAYERS.map(l => l.id));
      return (JSON.parse(raw) as string[]).filter(id => known.has(id));
    }
  } catch { /* ignore corrupt storage */ }
  return BASE_LAYERS.map(l => l.id);
}

function createBaseLayersStore() {
  const enabled = new SvelteSet<string>(loadEnabledIds());

  return {
    get enabled(): SvelteSet<string> { return enabled; },

    /** Activate a layer. No-op if already active (never deactivates). */
    toggle(id: string) {
      if (enabled.has(id)) return; // already active — clicking again is a no-op
      enabled.clear();             // exclusive: only one base layer at a time
      enabled.add(id);
      localStorage.setItem(LS_BASE_LAYERS_KEY, JSON.stringify([...enabled]));
    },

    /** Clear all active base layers (called when a chart is selected). */
    deselectAll() {
      if (enabled.size === 0) return;
      enabled.clear();
      localStorage.setItem(LS_BASE_LAYERS_KEY, JSON.stringify([]));
    },
  };
}

export const baseLayers = createBaseLayersStore();
