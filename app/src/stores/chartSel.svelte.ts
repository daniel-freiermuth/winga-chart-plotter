import { SvelteMap } from 'svelte/reactivity';
import { loadJSON, saveJSON } from './paneStorage';

const LS_SELECTED_KEY  = 'chart-selected';
const LS_LAYER_SEL_KEY = 'chart-wmts-layer-sel';

/**
 * Per-pane chart selection, including which WMTS layer a pane displays for a
 * chart. The chart *catalog* (available charts, WMTS capability resolution,
 * tile URLs) is app-level — see charts.svelte.ts. What a pane shows is
 * pane-level.
 */
export interface ChartSelStore {
  /** The pane's one selected chart id, or null when none is selected. */
  readonly selected: string | null;
  /** Activate a chart. No-op if already active (never deactivates). */
  toggle(id: string): void;
  /** Clear chart selection (called when a base layer is selected). */
  deselectAll(): void;
  /** Selected WMTS layer id for a chart in this pane ('' = none chosen yet). */
  getLayerSel(id: string): string;
  /** Select a WMTS layer for a chart in this pane. */
  activateLayer(chartId: string, layerId: string): void;
}

/**
 * The persisted selection is restored eagerly; an id that no longer exists in
 * the catalog is inert (Map.svelte only renders selected charts it finds in
 * charts.available) and gets overwritten by the next toggle().
 *
 * `lsSuffix` namespaces the localStorage keys per pane. The primary pane's
 * un-suffixed keys match the formats older app versions wrote (including the
 * layer selection, which used to be app-global) — no migration needed.
 */
export function createChartSelStore(lsSuffix = ''): ChartSelStore {
  const selectedKey = LS_SELECTED_KEY + lsSuffix;
  const layerKey    = LS_LAYER_SEL_KEY + lsSuffix;

  const savedSel = loadJSON(selectedKey);
  // Persisted as `[id]` / `[]`. Older app versions persisted multiple ids —
  // keep only the first valid one.
  let selected = $state<string | null>(
    (Array.isArray(savedSel) ? savedSel.find((v): v is string => typeof v === 'string') : undefined) ?? null,
  );

  // chartId → WMTS layer id, persisted as a Map-entries array ([[id, layer]]).
  const layerSel = new SvelteMap<string, string>();
  const savedLayers = loadJSON(layerKey);
  if (Array.isArray(savedLayers)) {
    for (const e of savedLayers) {
      if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') {
        layerSel.set(e[0], e[1]);
      }
    }
  }

  return {
    get selected(): string | null { return selected; },

    toggle(id: string) {
      if (selected === id) return; // already active — clicking again is a no-op
      selected = id;
      saveJSON(selectedKey, [id]);
    },

    deselectAll() {
      if (selected === null) return;
      selected = null;
      saveJSON(selectedKey, []);
    },

    getLayerSel(id: string): string { return layerSel.get(id) ?? ''; },

    activateLayer(chartId: string, layerId: string) {
      layerSel.set(chartId, layerId);
      saveJSON(layerKey, [...layerSel]);
    },
  };
}
