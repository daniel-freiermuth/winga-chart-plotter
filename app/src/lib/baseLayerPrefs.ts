/**
 * Pure resolution of the persisted base-layer preference
 * (localStorage key `base-layers-enabled`) into the set of enabled ids.
 *
 * Extracted from stores/baseLayers.svelte.ts so the decision logic is unit
 * testable in plain Node (no localStorage, no Svelte reactivity).
 *
 * @param raw      the raw string stored under the key, or null when absent
 * @param knownIds ids of the currently available base layers, in order
 */
export function resolveEnabledIds(raw: string | null, knownIds: readonly string[]): string[] {
  try {
    if (raw) {
      // Filter to known IDs — handles migration from the old two-entry format.
      const known = new Set(knownIds);
      return (JSON.parse(raw) as string[]).filter(id => known.has(id));
    }
  } catch { /* ignore corrupt storage */ }
  return [...knownIds];
}
