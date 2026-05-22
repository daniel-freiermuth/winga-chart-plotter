import { SvelteSet } from 'svelte/reactivity';

export interface BaseLayer {
  id: string;
  name: string;
}

export const BASE_LAYERS: BaseLayer[] = [
  { id: 'osm',      name: 'OpenStreetMap'  },
  { id: 'seamarks', name: 'OpenSeaMap'     },
];

function createBaseLayersStore() {
  // All layers enabled by default
  const enabled = new SvelteSet<string>(BASE_LAYERS.map(l => l.id));

  return {
    get enabled(): SvelteSet<string> { return enabled; },

    toggle(id: string) {
      if (enabled.has(id)) enabled.delete(id);
      else                 enabled.add(id);
    },
  };
}

export const baseLayers = createBaseLayersStore();
