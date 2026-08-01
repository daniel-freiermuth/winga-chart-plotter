/**
 * Pure resolution of the persisted base-layer preference
 * (localStorage key `base-layers-enabled`, parsed by paneStorage's loadJSON)
 * into the set of enabled ids.
 *
 * Extracted from stores/baseLayers.svelte.ts so the decision logic is unit
 * testable in plain Node (no localStorage, no Svelte reactivity).
 *
 * Upholds the store's exclusivity invariant (at most ONE enabled id — see
 * toggle(), which clears the set before adding). The result is exactly one
 * of:
 * - `[]`         — the deliberate no-base-layer state deselectAll() persists
 *                  while a chart is selected (stored `'[]'`);
 * - `[storedId]` — the first stored id that is still a known base layer
 *                  (older builds persisted independent toggles, so the array
 *                  may hold several ids — clamp to one);
 * - `[default]`  — first known id, when nothing usable is stored: value
 *                  absent or corrupt (loadJSON yields null), not an array,
 *                  or only retired ids such as `["seamarks"]` (seamarks
 *                  moved to osm.extraLayerIds).
 *
 * @param stored   the parsed value stored under the key, or null when absent
 * @param knownIds ids of the currently available base layers, in order
 */
export function resolveEnabledIds(stored: unknown, knownIds: readonly string[]): string[] {
  const defaultId = knownIds[0];
  const fallback = defaultId !== undefined ? [defaultId] : [];
  if (!Array.isArray(stored)) return fallback;
  if (stored.length === 0) return []; // deselectAll() wrote '[]': a chart is selected
  const known = new Set(knownIds);
  const kept = stored.find((id): id is string => typeof id === 'string' && known.has(id));
  return kept !== undefined ? [kept] : fallback;
}
