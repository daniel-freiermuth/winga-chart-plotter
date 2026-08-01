import { SvelteSet } from 'svelte/reactivity';
import { resolveEnabledIds } from '../lib/baseLayerPrefs';

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

/** Per-pane base layer selection (exclusive — at most one active). */
export interface BaseLayersStore {
  readonly enabled: SvelteSet<string>;
  /** Activate a layer. No-op if already active (never deactivates). */
  toggle(id: string): void;
  /** Clear all active base layers (called when a chart is selected). */
  deselectAll(): void;
}

/** `lsSuffix` namespaces the localStorage key per pane ('' = primary pane, legacy key). */
export function createBaseLayersStore(lsSuffix = ''): BaseLayersStore {
  const key = LS_BASE_LAYERS_KEY + lsSuffix;

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch { /* storage unavailable */ }
  const enabled = new SvelteSet<string>(resolveEnabledIds(raw, BASE_LAYERS.map(l => l.id)));

  return {
    get enabled(): SvelteSet<string> { return enabled; },

    toggle(id: string) {
      if (enabled.has(id)) return; // already active — clicking again is a no-op
      enabled.clear();             // exclusive: only one base layer at a time
      enabled.add(id);
      try { localStorage.setItem(key, JSON.stringify([...enabled])); } catch { /* ignore */ }
    },

    deselectAll() {
      if (enabled.size === 0) return;
      enabled.clear();
      try { localStorage.setItem(key, JSON.stringify([])); } catch { /* ignore */ }
    },
  };
}
