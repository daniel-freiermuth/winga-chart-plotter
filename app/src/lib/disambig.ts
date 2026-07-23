/**
 * Resolve a click on an AIS disambiguation-popup entry to the vessel's index
 * in the *current* per-batch ids array.
 *
 * `entryIds` is the list of stable vessel ids frozen when the popup was built;
 * `entryPos` is the position of the clicked list item within it. The per-batch
 * AIS arrays are rebuilt in arbitrary (HashMap-iteration) order on every
 * batch, so by click time an index captured at tap time may denote a
 * different vessel — resolution must go through the stable id.
 *
 * Returns the vessel's current index, or null when the entry is unknown or
 * the vessel has expired since the popup was built (in which case nothing
 * must be selected).
 */
export function resolveDisambigEntry(
  entryIds: readonly string[],
  entryPos: number,
  currentIds: readonly string[],
): number | null {
  const id = entryIds[entryPos];
  if (id == null) return null;
  const idx = currentIds.indexOf(id);
  return idx >= 0 ? idx : null;
}
