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
  // Bumped on every load(); only the newest load() may commit its catalog.
  let requestSeq    = 0;
  // Bumped whenever the server base changes; WMTS resolutions started for an
  // older base must not land in the caches of the new one.
  let baseGen       = 0;

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

    /**
     * Resolve the chart's MapLibre style against the SK server base (handles
     * relative paths). Signal K mapstyleJSON charts carry the style document in
     * `url`; the vendor `style` field takes precedence when set.
     */
    styleUrl(chart: Chart): string | null {
      const style = chart.style ?? (chart.type === 'mapstyleJSON' ? chart.url : undefined);
      if (!style) return null;
      return style.startsWith('/')
        ? `${serverBase}${style}`
        : style;
    },

    async load(base: string) {
      const seq = ++requestSeq;
      if (base !== serverBase) {
        // The old server's catalog and WMTS resolutions are void: tileUrl()
        // and styleUrl() would resolve its relative paths against the new
        // base, and same-identifier WMTS charts would reuse old templates.
        // Same-server failures keep the last good catalog.
        serverBase = base;
        baseGen++;
        available = {};
        wmtsResolved.clear();
        wmtsFailed.clear();
        wmtsResolving.clear();
        wmtsAllLayers.clear();
        wmtsFilteredLayers.clear();
      }
      const gen = baseGen;
      loading = true;
      error   = null;
      try {
        const fetched = await fetchCharts(base);
        // A newer load() started meanwhile — its response is authoritative.
        if (seq !== requestSeq) return;
        available = fetched;
      } catch (e) {
        if (seq !== requestSeq) return;
        error = String(e);
        return;
      } finally {
        if (seq === requestSeq) loading = false;
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
            if (gen !== baseGen) return;
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
            if (gen === baseGen) wmtsFailed.add(c.identifier);
          } finally {
            if (gen === baseGen) wmtsResolving.delete(c.identifier);
          }
        });
      void Promise.allSettled(wmtsTasks);
    },
  };
}

export const charts = createChartsStore();
