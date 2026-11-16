import { describe, expect, it } from 'vitest';
import { resolveEnabledId } from './baseLayerPrefs';

/**
 * Regression tests for the fresh-install / migration base-layer bug.
 *
 * The store holds at most one enabled base layer ("only one base layer at a
 * time"); resolveEnabledId() picks it from storage:
 *
 * - Fresh install (no stored key): the pre-fix fallback enabled EVERY id
 *   (['osm', 'watercolor']). DEFAULT_STYLE stacks watercolor above osm, so
 *   the opaque watercolor raster covered OSM+OpenSeaMap on first launch, and
 *   toggle() early-returned on either picker card: the user could not switch
 *   base layers at all. The default must be the first known layer alone.
 *
 * - Migration: older builds persisted independent toggles, so storage may
 *   hold '["seamarks"]' (now retired — seamarks moved to osm.extraLayerIds)
 *   or several ids at once. Retired-only selections must fall back to the
 *   default instead of yielding no base layer (blank map with no chart
 *   selected); multi-id selections must keep the first known id.
 *
 * - '[]' is a deliberate state written by deselectAll() when a chart is
 *   selected, and must round-trip unchanged.
 */
describe('resolveEnabledId', () => {
  const knownIds = ['osm', 'watercolor'];

  it('enables exactly one base layer (the default) on fresh install', () => {
    expect(resolveEnabledId(null, knownIds)).toBe('osm');
  });

  it('migrates a retired-ids-only selection to the default instead of a blank map', () => {
    // Legal under the old independent-toggle semantics; 'seamarks' is now an
    // extra layer of 'osm', not a base layer id.
    expect(resolveEnabledId(['seamarks'], knownIds)).toBe('osm');
  });

  it('clamps an old multi-toggle selection to a single base layer', () => {
    expect(resolveEnabledId(['osm', 'seamarks'], knownIds)).toBe('osm');
    expect(resolveEnabledId(['watercolor', 'osm'], knownIds)).toBe('watercolor');
  });

  it('keeps a stored single selection', () => {
    expect(resolveEnabledId(['watercolor'], knownIds)).toBe('watercolor');
  });

  it("round-trips '[]' — the deliberate no-base-layer state while a chart is selected", () => {
    expect(resolveEnabledId([], knownIds)).toBeNull();
  });

  it('falls back to the default on non-array values (corrupt storage parses to null)', () => {
    expect(resolveEnabledId(null, knownIds)).toBe('osm');
    expect(resolveEnabledId('osm', knownIds)).toBe('osm');
  });
});
