import { SvelteSet, SvelteMap } from 'svelte/reactivity';

const LS_SELECTED_KEY  = 'chart-selected';
const LS_LAYER_SEL_KEY = 'chart-wmts-layer-sel';

/**
 * Per-pane chart selection, including which WMTS layer a pane displays for a
 * chart. The chart *catalog* (available charts, WMTS capability resolution,
 * tile URLs) is app-level — see charts.svelte.ts. What a pane shows is
 * pane-level.
 */
export interface ChartSelStore {
  readonly selected: SvelteSet<string>;
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

  let restored: string[] = [];
  try {
    const s = localStorage.getItem(selectedKey);
    if (s) {
      const p = JSON.parse(s) as unknown;
      if (Array.isArray(p)) {
        // Exclusivity invariant: at most ONE selected chart. Older app
        // versions persisted multiple ids — keep only the first valid one.
        const first = p.find((v): v is string => typeof v === 'string');
        if (first !== undefined) restored = [first];
      }
    }
  } catch { /* ignore */ }
  const selected = new SvelteSet<string>(restored);

  // chartId → WMTS layer id, persisted as a Map-entries array ([[id, layer]]).
  const layerSel = new SvelteMap<string, string>();
  try {
    const s = localStorage.getItem(layerKey);
    if (s) {
      const p = JSON.parse(s) as unknown;
      if (Array.isArray(p)) {
        for (const e of p) {
          if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') {
            layerSel.set(e[0], e[1]);
          }
        }
      }
    }
  } catch { /* ignore */ }

  return {
    get selected(): SvelteSet<string> { return selected; },

    toggle(id: string) {
      if (selected.has(id)) return; // already active — clicking again is a no-op
      selected.clear();             // exclusive: only one chart at a time
      selected.add(id);
      try { localStorage.setItem(selectedKey, JSON.stringify([...selected])); } catch { /* ignore */ }
    },

    deselectAll() {
      if (selected.size === 0) return;
      selected.clear();
      try { localStorage.setItem(selectedKey, JSON.stringify([])); } catch { /* ignore */ }
    },

    getLayerSel(id: string): string { return layerSel.get(id) ?? ''; },

    activateLayer(chartId: string, layerId: string) {
      layerSel.set(chartId, layerId);
      try { localStorage.setItem(layerKey, JSON.stringify([...layerSel])); } catch { /* ignore */ }
    },
  };
}
