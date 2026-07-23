import { describe, expect, it } from 'vitest';
import { mergeSkCpa } from './skCpaMerge';
import type { SkClosestApproach } from './skCpaMerge';

const fresh: SkClosestApproach = { distanceM: 850, timeToS: 420 };
const cached: SkClosestApproach = { distanceM: 1200, timeToS: 900 };

describe('mergeSkCpa', () => {
  it('replaces the cached value with a fresh one', () => {
    expect(mergeSkCpa(fresh, cached)).toBe(fresh);
  });

  it('sets a fresh value when nothing was cached', () => {
    expect(mergeSkCpa(fresh, undefined)).toBe(fresh);
  });

  it('clears the cached value on explicit null retraction', () => {
    // The regression: `??` treated null like absent and kept the stale CPA.
    expect(mergeSkCpa(null, cached)).toBeUndefined();
  });

  it('retains the cached value when the field is absent', () => {
    expect(mergeSkCpa(undefined, cached)).toBe(cached);
  });

  it('stays empty when the field is absent and nothing was cached', () => {
    expect(mergeSkCpa(undefined, undefined)).toBeUndefined();
  });

  it('stays empty on null retraction with nothing cached', () => {
    expect(mergeSkCpa(null, undefined)).toBeUndefined();
  });
});
