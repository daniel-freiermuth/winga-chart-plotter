import type { ChartRecord } from './wasmRest';

/**
 * Ids of tile-based chart sources/layers (`chart-${id}` / `chart-layer-${id}`)
 * the map must tear down: every mounted one that is deselected, now carries a
 * style (rendered via setStyle instead), or is no longer in the catalog.
 *
 * Walks the MOUNTED ids, not the catalog: after a server switch the catalog
 * is emptied (and stays empty if the new server's chart fetch fails), so a
 * catalog-driven walk would never visit the previous server's layers and
 * they would keep rendering its tiles.
 *
 * Extracted from Map.svelte's chart effect so the decision is unit testable
 * in plain Node (no MapLibre instance).
 *
 * @param mounted    ids of the chart sources currently on the map
 * @param selected   the pane's selected chart ids
 * @param available  the current chart catalog
 */
export function chartSourcesToRemove(
  mounted: Iterable<string>,
  selected: ReadonlySet<string>,
  available: ChartRecord,
): string[] {
  return [...mounted].filter(id => {
    const chart = available[id];
    return !chart || !selected.has(id) || !!chart.style;
  });
}
