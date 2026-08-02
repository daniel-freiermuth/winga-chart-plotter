import { visiblePanesFor } from './pane.svelte';
import { settings } from './settings.svelte';
import { SvelteMap } from 'svelte/reactivity';

const LS_KEY = 'chart-lru';

function load(): [string, number][] {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) return Object.entries(JSON.parse(s) as Record<string, number>);
  } catch { /* ignore corrupt storage */ }
  return [];
}

function createChartLruStore() {
  const _order = new SvelteMap<string, number>(load());

  return {
    /** Record ids as accessed right now and persist. */
    touch(ids: string[]): void {
      if (ids.length === 0) return;
      const now = Date.now();
      for (const id of ids) _order.set(id, now);
      const obj: Record<string, number> = {};
      _order.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    },

    /** Higher = more recent. Unknown ids return 0 (sort to back). */
    rank(id: string): number {
      return _order.get(id) ?? 0;
    },
  };
}

export const chartLru = createChartLruStore();

/**
 * Record every VISIBLE pane's active charts/layers as just-used — not only the
 * pane a picker configures — so neither pane's selection ages out of the LRU.
 * A chart with a WMTS layer selection keys as `${chartId}:${layerId}` (the id
 * the picker's per-layer cards rank by); everything else by its plain id.
 * Keyed off the pane's own selection state, NOT the chart catalog — the
 * catalog may not have loaded (or may have dropped the chart) when the picker
 * closes, and the selection must stay fresh regardless.
 * Called when a chart picker closes.
 */
export function touchVisibleSelections(): void {
  const activeIds: string[] = [];
  for (const p of visiblePanesFor(settings.paneLayout)) {
    activeIds.push(...p.baseLayers.enabled);
    for (const cid of p.chartSel.selected) {
      const layerId = p.chartSel.getLayerSel(cid);
      activeIds.push(layerId ? `${cid}:${layerId}` : cid);
    }
  }
  chartLru.touch(activeIds);
}
