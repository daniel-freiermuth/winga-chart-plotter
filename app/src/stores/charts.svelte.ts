import { SvelteSet } from 'svelte/reactivity';
import { fetchCharts, resolveTileUrl, type Chart, type ChartRecord } from '../lib/signalk-api';

export type { Chart };

function createChartsStore() {
  let available   = $state<ChartRecord>({});
  const selected  = new SvelteSet<string>();
  let loading     = $state(false);
  let error       = $state<string | null>(null);
  let serverBase  = '';

  return {
    get available():  ChartRecord           { return available;  },
    get selected():   SvelteSet<string>     { return selected;   },
    get loading():    boolean               { return loading;    },
    get error():      string | null         { return error;      },

    /** Resolve a chart tile URL (may be relative) to an absolute URL. */
    tileUrl(url: string): string { return resolveTileUrl(url, serverBase); },

    async load(base: string) {
      serverBase = base;
      loading = true;
      error   = null;
      try {
        available = await fetchCharts(base);
      } catch (e) {
        error = String(e);
      } finally {
        loading = false;
      }
    },

    toggle(id: string) {
      if (selected.has(id)) {
        selected.delete(id);
      } else {
        selected.add(id);
      }
    },
  };
}

export const charts = createChartsStore();
