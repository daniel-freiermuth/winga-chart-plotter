/**
 * Pure resolution of the persisted base-layer preference
 * (localStorage key `base-layers-enabled`, parsed by paneStorage's loadJSON)
 * into the enabled id.
 *
 * Extracted from stores/baseLayers.svelte.ts so the decision logic is unit
 * testable in plain Node (no localStorage, no Svelte reactivity).
 *
 * The store persists `[id]`, or `[]` for no base layer. The result is
 * exactly one of:
 * - `null`      — the deliberate no-base-layer state deselectAll() persists
 *                 while a chart is selected (stored `'[]'`);
 * - `storedId`  — the first stored id that is still a known base layer
 *                 (older builds persisted independent toggles, so the array
 *                 may hold several ids — keep the first);
 * - `default`   — first known id, when nothing usable is stored: value
 *                 absent or corrupt (loadJSON yields null), not an array,
 *                 or only retired ids such as `["seamarks"]` (seamarks
 *                 moved to osm.extraLayerIds).
 *
 * @param stored   the parsed value stored under the key, or null when absent
 * @param knownIds ids of the currently available base layers, in order
 */
export function resolveEnabledId(stored: unknown, knownIds: readonly string[]): string | null {
  const fallback = knownIds[0] ?? null;
  if (!Array.isArray(stored)) return fallback;
  if (stored.length === 0) return null; // deselectAll() wrote '[]': a chart is selected
  const known = new Set(knownIds);
  return stored.find((id): id is string => typeof id === 'string' && known.has(id)) ?? fallback;
}
