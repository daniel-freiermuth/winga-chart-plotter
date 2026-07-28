import { describe, expect, it } from 'vitest';
import { processTrack, splitToFit, splitRouteSegments } from './trackProcessing';

/** Wrap an unwrapped longitude back into [-180, 180] (what the track store holds). */
function wrap(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

const MAPLIBRE_RANGE = 540; // MapLibre renders lon within ±540°

describe('splitToFit', () => {
  it('returns empty for empty input', () => {
    expect(splitToFit([])).toEqual([]);
  });

  it('leaves an in-range track untouched', () => {
    const pts: [number, number][] = [[-170, 10], [-175, 10], [175, 10]];
    expect(splitToFit(pts)).toEqual([pts]);
  });

  it('splits eastward accumulation (oldest point < -540)', () => {
    // Oldest points below -540 must be shifted +720 into a renderable copy.
    const pts: [number, number][] = [[-700, 10], [-600, 10], [-500, 10], [-100, 10], [0, 10]];
    const segments = splitToFit(pts);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-MAPLIBRE_RANGE);
        expect(lon).toBeLessThanOrEqual(MAPLIBRE_RANGE);
      }
    }
  });

  it('splits westward accumulation (oldest point > +540)', () => {
    // BUG PROOF: Westward travel makes unwrapped longitude decrease; after
    // anchoring the newest point into [-180,180] the oldest sits at large
    // positive values (e.g. 700). splitToFit must split these.
    const pts: [number, number][] = [[700, 10], [600, 10], [500, 10], [100, 10], [0, 10]];
    const segments = splitToFit(pts);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-MAPLIBRE_RANGE);
        expect(lon).toBeLessThanOrEqual(MAPLIBRE_RANGE);
      }
    }
  });
});

describe('processTrack antimeridian overflow', () => {
  it('keeps every segment within ±540° for a track circling westward ~4.2 worlds', () => {
    // 500 points drifting 3° west each step → 1497° of westward accumulation.
    // After anchor, oldest lon ≈ 1497 — requires multiple recursive splits.
    const raw: [number, number][] = [];
    for (let i = 0; i < 500; i++) raw.push([wrap(-3 * i), 10]);
    const { coords, overflowSegments } = processTrack(raw);
    for (const seg of [coords, ...overflowSegments]) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-MAPLIBRE_RANGE);
        expect(lon).toBeLessThanOrEqual(MAPLIBRE_RANGE);
      }
    }
    // Multi-world path must produce more than one overflow segment (recursive split).
    expect(overflowSegments.length).toBeGreaterThan(1);
  });

  it('keeps every segment within ±540° for a track circling eastward ~4.2 worlds', () => {
    // 500 points drifting 3° east each step → 1497° of eastward accumulation.
    // After anchor, oldest lon ≈ -1497 — requires multiple recursive splits.
    const raw: [number, number][] = [];
    for (let i = 0; i < 500; i++) raw.push([wrap(3 * i), 10]);
    const { coords, overflowSegments } = processTrack(raw);
    for (const seg of [coords, ...overflowSegments]) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-MAPLIBRE_RANGE);
        expect(lon).toBeLessThanOrEqual(MAPLIBRE_RANGE);
      }
    }
    // Multi-world path must produce more than one overflow segment (recursive split).
    expect(overflowSegments.length).toBeGreaterThan(1);
  });
});
describe('splitRouteSegments', () => {
  it('returns empty for empty input', () => {
    expect(splitRouteSegments([])).toEqual([]);
  });

  it('leaves an in-range route untouched', () => {
    const pts: [number, number][] = [[-170, 10], [0, 10], [170, 10]];
    expect(splitRouteSegments(pts)).toEqual([pts]);
  });

  it('splits when first point > +540 (westward route after midpoint anchor)', () => {
    // processRouteCoords midpoint-anchors, which can leave the first point
    // at a large positive value for long westward routes.
    const pts: [number, number][] = [[700, 10], [500, 10], [300, 10], [100, 10], [0, 10]];
    const segments = splitRouteSegments(pts);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-MAPLIBRE_RANGE);
        expect(lon).toBeLessThanOrEqual(MAPLIBRE_RANGE);
      }
    }
  });

  it('splits when last point < -540 (westward route ending in overflow)', () => {
    // A route that starts in-range but decreases past -540.
    const pts: [number, number][] = [[0, 10], [-100, 10], [-300, 10], [-500, 10], [-700, 10]];
    const segments = splitRouteSegments(pts);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-MAPLIBRE_RANGE);
        expect(lon).toBeLessThanOrEqual(MAPLIBRE_RANGE);
      }
    }
  });
});
