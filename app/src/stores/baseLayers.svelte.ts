import { resolveEnabledId } from '../lib/baseLayerPrefs';
import { loadJSON, saveJSON } from './paneStorage';

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
  /** The pane's one active base layer id, or null when none is active. */
  readonly enabled: string | null;
  /** Activate a layer. No-op if already active (never deactivates). */
  toggle(id: string): void;
  /** Clear the active base layer (called when a chart is selected). */
  deselectAll(): void;
}

/** `lsSuffix` namespaces the localStorage key per pane ('' = primary pane, legacy key). */
export function createBaseLayersStore(lsSuffix = ''): BaseLayersStore {
  const key = LS_BASE_LAYERS_KEY + lsSuffix;

  let enabled = $state<string | null>(resolveEnabledId(loadJSON(key), BASE_LAYERS.map(l => l.id)));

  return {
    get enabled(): string | null { return enabled; },

    toggle(id: string) {
      if (enabled === id) return; // already active — clicking again is a no-op
      enabled = id;
      saveJSON(key, [id]);
    },

    deselectAll() {
      if (enabled === null) return;
      enabled = null;
      saveJSON(key, []);
    },
  };
}
