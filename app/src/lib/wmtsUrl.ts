import type { WmtsLayerInfo } from './wmts';

/**
 * Effective WMTS tile URL for one chart as rendered by one pane.
 *
 * Precedence: manual URL override > the pane's selected layer (looked up in
 * the resolved capabilities) > the catalog's resolution-time default > ''.
 * A pane layer id that no longer matches any resolved layer — or matches a
 * layer without a usable URL — falls through to the default rather than
 * producing a dead source.
 *
 * Extracted from stores/charts.svelte.ts so the precedence decision is unit
 * testable in plain Node (no reactive store state).
 */
export function pickWmtsTileUrl(
  override: string | undefined,
  allLayers: readonly WmtsLayerInfo[] | undefined,
  paneLayerId: string | undefined,
  resolvedDefault: string | undefined,
): string {
  if (override) return override;
  if (paneLayerId) {
    const layer = allLayers?.find(l => l.id === paneLayerId);
    if (layer?.tileUrl) return layer.tileUrl;
  }
  return resolvedDefault ?? '';
}
