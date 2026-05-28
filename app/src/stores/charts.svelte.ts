import { SvelteSet, SvelteMap } from 'svelte/reactivity';
import { fetchCharts, buildTileUrl, type Chart, type ChartRecord } from '../lib/signalk-api';
import { resolveWmtsTileUrl, resolveWmtsLayer, type WmtsLayerInfo } from '../lib/wmts';

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
  // Manual URL overrides (persisted)
  const wmtsOverrides     = loadLS(LS_OVERRIDES_KEY);
  // All layers from capabilities
  const wmtsAllLayers     = new SvelteMap<string, WmtsLayerInfo[]>();
  // Filtered layers (from chart.layers hint) — empty map entry means "no filter"
  const wmtsFilteredLayers = new SvelteMap<string, WmtsLayerInfo[]>();
  // Charts where user toggled "show all layers"
  const wmtsShowAll       = new SvelteSet<string>();
  // Currently selected layer (persisted)
  const wmtsLayerSel      = loadLS(LS_LAYER_SEL_KEY);

  return {
    get available():  ChartRecord              { return available;  },
    get selected():   SvelteSet<string>        { return selected;   },
    get loading():    boolean                  { return loading;    },
    get error():      string | null            { return error;      },
    get wmtsFailed(): SvelteSet<string>        { return wmtsFailed; },

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

    async selectLayer(id: string, layerId: string) {
      const chart = available[id];
      if (!chart || chart.type !== 'WMTS') return;
      const url = chart.url && chart.url.startsWith('/') ? `${serverBase}${chart.url}` : (chart.url ?? '');
      try {
        const info = await resolveWmtsLayer(url, layerId);
        wmtsResolved.set(id, info.tileUrlTemplate);
        wmtsAllLayers.set(id, info.availableLayers);
        wmtsLayerSel.set(id, info.layerName);
        saveLS(LS_LAYER_SEL_KEY, wmtsLayerSel);
      } catch (e) {
        console.warn(`[charts] WMTS layer switch failed for ${id}:`, e);
      }
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

        // Restore previously selected charts that still exist on this server.
        for (const id of savedSelected) {
          if (id in available) selected.add(id);
        }
        savedSelected.clear();

        const wmtsTasks = Object.values(available)
          .filter(c => c.type === 'WMTS' && !wmtsOverrides.has(c.identifier))
          .map(async c => {
            const url = c.url && c.url.startsWith('/') ? `${base}${c.url}` : (c.url ?? '');
            if (!url) { wmtsFailed.add(c.identifier); return; }
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
            }
          });
        await Promise.allSettled(wmtsTasks);
      } catch (e) {
        error = String(e);
      } finally {
        loading = false;
      }
    },

    toggle(id: string) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      localStorage.setItem(LS_SELECTED_KEY, JSON.stringify([...selected]));
    },
  };
}

export const charts = createChartsStore();
