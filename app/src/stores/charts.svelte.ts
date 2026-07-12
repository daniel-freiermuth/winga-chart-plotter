import { SvelteSet, SvelteMap } from 'svelte/reactivity';
import { fetchCharts, buildTileUrl, type Chart, type ChartRecord } from '../lib/wasmRest';
import { resolveWmtsTileUrl, type WmtsLayerInfo } from '../lib/wmts';

export type { Chart };
export type { WmtsLayerInfo };

const LS_OVERRIDES_KEY  = 'chart-wmts-overrides';
const LS_LAYER_SEL_KEY  = 'chart-wmts-layer-sel';
const LS_SELECTED_KEY   = 'chart-selected';

function loadLS(key: string): Map<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Map(JSON.parse(raw) as [string, string][]);
  } catch { /* ignore */ }
  return new Map();
}

function loadSelectedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_SELECTED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveLS(key: string, m: Map<string, string>) {
  localStorage.setItem(key, JSON.stringify([...m]));
}

function createChartsStore() {
  let available     = $state<ChartRecord>({});
  const selected    = new SvelteSet<string>();
  const savedSelected = loadSelectedIds();
  let loading       = $state(false);
  let error         = $state<string | null>(null);
  let serverBase    = '';

  // Resolved tile URL templates (SvelteMap → reactive)
  const wmtsResolved      = new SvelteMap<string, string>();
  // Charts where auto-resolution failed
  const wmtsFailed        = new SvelteSet<string>();
  // Charts currently fetching their WMTS capabilities
  const wmtsResolving     = new SvelteSet<string>();
  // Manual URL overrides (persisted)
  const wmtsOverrides     = loadLS(LS_OVERRIDES_KEY);
  // All layers from capabilities
  const wmtsAllLayers     = new SvelteMap<string, WmtsLayerInfo[]>();
  // Filtered layers (from chart.layers hint) — empty map entry means "no filter"
  const wmtsFilteredLayers = new SvelteMap<string, WmtsLayerInfo[]>();
  // Charts where user toggled "show all layers"
  const wmtsShowAll       = new SvelteSet<string>();
  // Currently selected layer (persisted) — SvelteMap so isActive is reactive
  const wmtsLayerSel = new SvelteMap<string, string>(loadLS(LS_LAYER_SEL_KEY));

  return {
    get available():  ChartRecord              { return available;  },
    get selected():   SvelteSet<string>        { return selected;   },
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

    needsManualUrl(id: string): boolean {
      const chart = available[id];
      return !!chart && chart.type === 'WMTS' && wmtsFailed.has(id) && !wmtsOverrides.has(id);
    },

    getOverride(id: string):  string { return wmtsOverrides.get(id)  ?? ''; },
    getLayerSel(id: string):  string { return wmtsLayerSel.get(id)   ?? ''; },

    setOverride(id: string, tileUrlTemplate: string) {
      if (tileUrlTemplate.trim()) {
        wmtsOverrides.set(id, tileUrlTemplate.trim());
      } else {
        wmtsOverrides.delete(id);
      }
      saveLS(LS_OVERRIDES_KEY, wmtsOverrides);
      wmtsFailed.delete(id);
      wmtsFailed.add(id);
    },

    /** Switch to a specific WMTS layer immediately (no re-fetch). */
    activateLayer(id: string, layerId: string, tileUrl: string) {
      wmtsResolved.set(id, tileUrl);
      wmtsLayerSel.set(id, layerId);
      saveLS(LS_LAYER_SEL_KEY, wmtsLayerSel);
    },

    tileUrl(chart: Chart): string {
      if (chart.type === 'WMTS') {
        return wmtsOverrides.get(chart.identifier)
            ?? wmtsResolved.get(chart.identifier)
            ?? '';
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

        // Restore the previously selected chart (at most one — selection is exclusive).
        for (const id of savedSelected) {
          if (id in available) { selected.add(id); break; }
        }
        savedSelected.clear();
      } catch (e) {
        error = String(e);
        return;
      } finally {
        loading = false;
      }

      // Resolve WMTS capabilities in the background — each chart row updates
      // reactively as its request completes, without blocking the panel.
      const wmtsTasks = Object.values(available)
        .filter(c => c.type === 'WMTS' && !wmtsOverrides.has(c.identifier))
        .map(async c => {
          const url = c.url?.startsWith('/') ? `${base}${c.url}` : (c.url ?? '');
          if (!url) { wmtsFailed.add(c.identifier); return; }
          wmtsResolving.add(c.identifier);
          const preferLayer = wmtsLayerSel.get(c.identifier) ?? c.layers?.[0];
          try {
            const info = await resolveWmtsTileUrl(url, preferLayer);
            wmtsResolved.set(c.identifier, info.tileUrlTemplate);
            wmtsAllLayers.set(c.identifier, info.availableLayers);
            // Build filtered list from chart.layers hints (preserving server order)
            if (c.layers && c.layers.length > 0) {
              const allById = new Map(info.availableLayers.map(l => [l.id, l]));
              const filtered = c.layers.map(id => allById.get(id)).filter(Boolean) as WmtsLayerInfo[];
              if (filtered.length > 0) wmtsFilteredLayers.set(c.identifier, filtered);
            }
            if (!wmtsLayerSel.has(c.identifier)) {
              wmtsLayerSel.set(c.identifier, info.layerName);
            }
          } catch {
            wmtsFailed.add(c.identifier);
          } finally {
            wmtsResolving.delete(c.identifier);
          }
        });
      void Promise.allSettled(wmtsTasks);
    },

    /** Activate a chart. No-op if already active (never deactivates). */
    toggle(id: string) {
      if (selected.has(id)) return; // already active — clicking again is a no-op
      selected.clear();             // exclusive: only one chart at a time
      selected.add(id);
      localStorage.setItem(LS_SELECTED_KEY, JSON.stringify([...selected]));
    },

    /** Clear chart selection (called when a base layer is selected). */
    deselectAll() {
      if (selected.size === 0) return;
      selected.clear();
      localStorage.setItem(LS_SELECTED_KEY, JSON.stringify([]));
    },
  };
}

export const charts = createChartsStore();
