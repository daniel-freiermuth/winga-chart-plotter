/**
 * Pure resolution of the persisted base-layer preference
 * (localStorage key `base-layers-enabled`) into the set of enabled ids.
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
 * - `[default]`  — first known id, when nothing usable is stored: key absent
 *                  (fresh install), corrupt JSON, or only retired ids such as
 *                  `'["seamarks"]'` (seamarks moved to osm.extraLayerIds).
 *
 * @param raw      the raw string stored under the key, or null when absent
 * @param knownIds ids of the currently available base layers, in order
 */
export function resolveEnabledIds(raw: string | null, knownIds: readonly string[]): string[] {
  const defaultId = knownIds[0];
  const fallback = defaultId !== undefined ? [defaultId] : [];
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    if (parsed.length === 0) return []; // deselectAll() wrote '[]': a chart is selected
    const known = new Set(knownIds);
    const stored = parsed.find((id): id is string => typeof id === 'string' && known.has(id));
    return stored !== undefined ? [stored] : fallback;
  } catch { /* ignore corrupt storage */ }
  return fallback;
}
