import type { ChartRecord } from './wasmRest';

/**
 * Ids of tile-based chart sources/layers (`chart-${id}` / `chart-layer-${id}`)
 * the map must tear down.
 *
 * Extracted from Map.svelte's chart effect so the decision is unit testable
 * in plain Node (no MapLibre instance).
 *
 * @param _mounted   ids of the chart sources currently on the map
 * @param selected   the pane's selected chart ids
 * @param available  the current chart catalog
 */
export function chartSourcesToRemove(
  _mounted: Iterable<string>,
  selected: ReadonlySet<string>,
  available: ChartRecord,
): string[] {
  return Object.keys(available).filter(id => !(selected.has(id) && !available[id]!.style));
}
