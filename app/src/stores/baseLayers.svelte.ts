import { SvelteSet } from 'svelte/reactivity';

export interface BaseLayer {
  id: string;
  name: string;
}

export const BASE_LAYERS: BaseLayer[] = [
  { id: 'osm',      name: 'OpenStreetMap'  },
  { id: 'seamarks', name: 'OpenSeaMap'     },
];

const LS_BASE_LAYERS_KEY = 'base-layers-enabled';

function loadEnabledIds(): string[] {
  try {
    const raw = localStorage.getItem(LS_BASE_LAYERS_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* ignore corrupt storage */ }
  return BASE_LAYERS.map(l => l.id);
}

function createBaseLayersStore() {
  const enabled = new SvelteSet<string>(loadEnabledIds());

  return {
    get enabled(): SvelteSet<string> { return enabled; },

    toggle(id: string) {
      if (enabled.has(id)) enabled.delete(id);
      else                 enabled.add(id);
      localStorage.setItem(LS_BASE_LAYERS_KEY, JSON.stringify([...enabled]));
    },
  };
}

export const baseLayers = createBaseLayersStore();
