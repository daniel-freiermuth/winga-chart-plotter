import { describe, expect, it } from 'vitest';
import { resolveDisambigEntry } from './disambig';

/**
 * Regression tests for the wrong-vessel disambiguation race (PR: key AIS
 * disambiguation selection by stable vessel id).
 *
 * The AIS hot/ids arrays are rebuilt from a Rust HashMap on every batch, so
 * vessel indices shift arbitrarily between the moment the popup is built and
 * the moment the user clicks an entry. The pre-fix code resolved the click by
 * the deck.gl pick index captured at tap time (`ais.getTarget(idx)`), i.e. it
 * selected whichever vessel happened to occupy that slot in the *new* array.
 * These tests encode that exact failure mode: with `entryIds` built in
 * capture-time array order, the old behavior is equivalent to returning
 * `entryPos` itself — which points at the wrong vessel after a reorder and at
 * a phantom vessel after a prune.
 */
describe('resolveDisambigEntry', () => {
  // Popup built while the batch order was A, B, C (entry pos == index then).
  const entryIds = ['vessel-A', 'vessel-B', 'vessel-C'];

  it('selects the same vessel after the ids array is rebuilt in a different order', () => {
    // Two batches later the HashMap iterates D, C, A, B.
    const currentIds = ['vessel-D', 'vessel-C', 'vessel-A', 'vessel-B'];
    // User clicks the first entry, labeled "vessel-A".
    const idx = resolveDisambigEntry(entryIds, 0, currentIds);
    expect(idx).not.toBeNull();
    expect(currentIds[idx!]).toBe('vessel-A');
    // Old index-based behavior returned the captured index 0, i.e. vessel-D:
    // the popup said "A" but a different vessel got highlighted.
    expect(idx).not.toBe(0);
  });

  it('resolves every entry to its own vessel under reordering', () => {
    const currentIds = ['vessel-C', 'vessel-B', 'vessel-A'];
    for (let pos = 0; pos < entryIds.length; pos++) {
      const idx = resolveDisambigEntry(entryIds, pos, currentIds);
      expect(idx).not.toBeNull();
      expect(currentIds[idx!]).toBe(entryIds[pos]);
    }
  });

  it('selects nothing when the clicked vessel has expired', () => {
    // vessel-B was pruned; a click on its entry must not fall through to
    // whichever vessel now occupies the captured slot.
    const currentIds = ['vessel-A', 'vessel-C'];
    expect(resolveDisambigEntry(entryIds, 1, currentIds)).toBeNull();
  });

  it('selects nothing when the entry position is out of range', () => {
    expect(resolveDisambigEntry(entryIds, 3, entryIds)).toBeNull();
    expect(resolveDisambigEntry(entryIds, -1, entryIds)).toBeNull();
    expect(resolveDisambigEntry(entryIds, Number.NaN, entryIds)).toBeNull();
  });

  it('resolves normally when the order happens to be unchanged', () => {
    expect(resolveDisambigEntry(entryIds, 1, entryIds)).toBe(1);
  });
});
