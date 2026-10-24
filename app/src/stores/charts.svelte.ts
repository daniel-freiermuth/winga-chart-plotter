import { SvelteSet, SvelteMap } from 'svelte/reactivity';
import { fetchCharts, buildTileUrl, type Chart, type ChartRecord } from '../lib/wasmRest';
import { resolveWmtsTileUrl, type WmtsLayerInfo } from '../lib/wmts';
import { pickWmtsTileUrl } from '../lib/wmtsUrl';

export type { Chart };
export type { WmtsLayerInfo };

function createChartsStore() {
  let available     = $state<ChartRecord>({});
  let loading       = $state(false);
  let error         = $state<string | null>(null);
  let serverBase    = '';

  // Resolved tile URL templates (SvelteMap → reactive)
  const wmtsResolved      = new SvelteMap<string, string>();
  // Charts where auto-resolution failed
  const wmtsFailed        = new SvelteSet<string>();
  // Charts currently fetching their WMTS capabilities
  const wmtsResolving     = new SvelteSet<string>();
  // All layers from capabilities
  const wmtsAllLayers     = new SvelteMap<string, WmtsLayerInfo[]>();
  // Filtered layers (from chart.layers hint) — empty map entry means "no filter"
  const wmtsFilteredLayers = new SvelteMap<string, WmtsLayerInfo[]>();
  // Charts where user toggled "show all layers"
  const wmtsShowAll       = new SvelteSet<string>();

  return {
    get available():  ChartRecord              { return available;  },
    get loading():    boolean                  { return loading;    },
    get error():      string | null            { return error;      },
    get wmtsFailed():    SvelteSet<string>        { return wmtsFailed;    },
    get wmtsResolving(): SvelteSet<string>        { return wmtsResolving; },
    /** Layers to display in the picker for a given chart id. */
    visibleLayers(id: string): WmtsLayerInfo[] {
      if (wmtsShowAll.has(id)) return wmtsAllLayers.get(id) ?? [];
      return wmtsFilteredLayers.get(id) ?? wmtsAllLayers.get(id) ?? [];
    },

    /** Whether a filter is active (chart.layers was non-empty) and not overridden. */
    hasFilter(id: string): boolean {
      return (wmtsFilteredLayers.get(id)?.length ?? 0) > 0;
    },

    isShowingAll(id: string): boolean { return wmtsShowAll.has(id); },

    toggleShowAll(id: string) {
      if (wmtsShowAll.has(id)) wmtsShowAll.delete(id);
      else wmtsShowAll.add(id);
    },


    /**
     * Tile URL for a chart. For WMTS charts, `paneLayerId` — the calling
     * pane's layer selection — picks that layer's URL from the resolved
     * capabilities; see pickWmtsTileUrl for the precedence rules.
     */
    tileUrl(chart: Chart, paneLayerId?: string): string {
      if (chart.type === 'WMTS') {
        return pickWmtsTileUrl(
          wmtsAllLayers.get(chart.identifier),
          paneLayerId,
          wmtsResolved.get(chart.identifier),
        );
      }
      return buildTileUrl(chart, serverBase) ?? '';
    },

    /** Resolve chart.style against the SK server base (handles relative paths). */
    styleUrl(chart: Chart): string | null {
      if (!chart.style) return null;
      return chart.style.startsWith('/')
        ? `${serverBase}${chart.style}`
        : chart.style;
    },

    async load(base: string) {
      serverBase = base;
      loading = true;
      error   = null;
      try {
        available = await fetchCharts(base);
      } catch (e) {
        error = String(e);
        return;
      } finally {
        loading = false;
      }

      // Resolve WMTS capabilities in the background — each chart row updates
      // reactively as its request completes, without blocking the panel.
      const wmtsTasks = Object.values(available)
        .filter(c => c.type === 'WMTS')
        .map(async c => {
          const url = c.url?.startsWith('/') ? `${base}${c.url}` : (c.url ?? '');
          if (!url) { wmtsFailed.add(c.identifier); return; }
          wmtsResolving.add(c.identifier);
          const preferLayer = c.layers?.[0];
          try {
            const info = await resolveWmtsTileUrl(url, preferLayer);
            wmtsResolved.set(c.identifier, info.tileUrlTemplate);
            wmtsAllLayers.set(c.identifier, info.availableLayers);
            // Build filtered list from chart.layers hints (preserving server order).
            // Apply it only if a hinted layer has Web Mercator tiles: otherwise the
            // picker would offer nothing selectable, so show all layers (which
            // include the first-Web-Mercator fallback the chart opens on).
            if (c.layers && c.layers.length > 0) {
              const allById = new Map(info.availableLayers.map(l => [l.id, l]));
              const filtered = c.layers.map(id => allById.get(id)).filter(Boolean) as WmtsLayerInfo[];
              if (filtered.some(l => l.tileUrl !== '')) wmtsFilteredLayers.set(c.identifier, filtered);
            }
          } catch {
            wmtsFailed.add(c.identifier);
          } finally {
            wmtsResolving.delete(c.identifier);
          }
        });
      void Promise.allSettled(wmtsTasks);
    },
  };
}

export const charts = createChartsStore();
