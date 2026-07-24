import { describe, expect, it } from 'vitest';
import { resolveEnabledIds } from './baseLayerPrefs';

/**
 * Regression tests for the fresh-install / migration base-layer bug.
 *
 * The store's mutators enforce an exclusive model: toggle() clears the set
 * before adding ("only one base layer at a time") and no-ops when the id is
 * already enabled. resolveEnabledIds() must uphold the same `size <= 1`
 * invariant, because nothing downstream re-checks it:
 *
 * - Fresh install (no stored key): the pre-fix fallback returned EVERY id
 *   (['osm', 'watercolor']). Map.svelte maps the set straight onto layer
 *   visibility and DEFAULT_STYLE stacks watercolor above osm, so the opaque
 *   watercolor raster covers OSM+OpenSeaMap on first launch — and because
 *   both ids are in the set, toggle() early-returns on either picker card:
 *   the user cannot switch base layers at all.
 *
 * - Migration: older builds persisted independent toggles, so storage may
 *   hold '["seamarks"]' (now retired — seamarks moved to osm.extraLayerIds)
 *   or several ids at once. Retired-only selections must fall back to the
 *   default instead of yielding an empty set (blank map with no chart
 *   selected); multi-id selections must be clamped to one.
 *
 * - '[]' is a deliberate state written by deselectAll() when a chart is
 *   selected, and must round-trip unchanged.
 */
describe('resolveEnabledIds', () => {
  const knownIds = ['osm', 'watercolor'];

  it('enables exactly one base layer (the default) on fresh install', () => {
    const ids = resolveEnabledIds(null, knownIds);
    expect(ids).toEqual(['osm']);
  });

  it('never enables more than one base layer, whatever is stored', () => {
    for (const raw of [null, '["osm","watercolor"]', '["watercolor","osm"]', '["seamarks"]', '{bad json', '"osm"']) {
      const ids = resolveEnabledIds(raw, knownIds);
      expect(ids.length, `raw=${String(raw)} resolved to [${ids.join(', ')}]`).toBeLessThanOrEqual(1);
    }
  });

  it('migrates a retired-ids-only selection to the default instead of a blank map', () => {
    // Legal under the old independent-toggle semantics; 'seamarks' is now an
    // extra layer of 'osm', not a base layer id.
    expect(resolveEnabledIds('["seamarks"]', knownIds)).toEqual(['osm']);
  });

  it('clamps an old multi-toggle selection to a single base layer', () => {
    expect(resolveEnabledIds('["osm","seamarks"]', knownIds)).toEqual(['osm']);
    expect(resolveEnabledIds('["watercolor","osm"]', knownIds)).toEqual(['watercolor']);
  });

  it('keeps a stored single selection', () => {
    expect(resolveEnabledIds('["watercolor"]', knownIds)).toEqual(['watercolor']);
  });

  it("round-trips '[]' — the deliberate no-base-layer state while a chart is selected", () => {
    expect(resolveEnabledIds('[]', knownIds)).toEqual([]);
  });

  it('falls back to the default on corrupt storage', () => {
    expect(resolveEnabledIds('{not json', knownIds)).toEqual(['osm']);
    expect(resolveEnabledIds('"osm"', knownIds)).toEqual(['osm']);
  });
});
