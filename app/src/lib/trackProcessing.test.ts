import { describe, expect, it } from 'vitest';
import { processRouteCoords, processTrack, splitAtAntimeridian } from './trackProcessing';

/** Wrap a longitude into [-180, 180] (what Signal K / the track store provides). */
function wrap(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

// Output coordinates are guaranteed within [-360, 360] (within MapLibre's ±540° limit).
const SEGMENT_RANGE = 360;

describe('splitAtAntimeridian', () => {
  it('returns empty for empty input', () => {
    expect(splitAtAntimeridian([])).toEqual([]);
  });

  it('returns one segment when there are no crossings', () => {
    const pts: [number, number][] = [[-170, 10], [0, 10], [170, 10]];
    expect(splitAtAntimeridian(pts)).toEqual([pts]);
  });

  it('splits on an eastward crossing and inserts a handover', () => {
    // 170°E → -170°W: short path is eastward 20°, crosses the antimeridian.
    const pts: [number, number][] = [[170, 10], [-170, 10]];
    const segs = splitAtAntimeridian(pts);
    expect(segs.length).toBe(2);
    // Segment 1 ends at the pre-crossing point.
    expect(segs[0]!.at(-1)![0]).toBe(170);
    // Segment 2 starts with prevLon shifted to the far side (170 - 360 = -190).
    expect(segs[1]![0]![0]).toBe(-190);
    // Segment 2 continues with the raw post-crossing point.
    expect(segs[1]![1]![0]).toBe(-170);
  });

  it('splits on a westward crossing and inserts a handover', () => {
    // -170°W → 170°E: short path is westward 20°.
    const pts: [number, number][] = [[-170, 10], [170, 10]];
    const segs = splitAtAntimeridian(pts);
    expect(segs.length).toBe(2);
    expect(segs[0]!.at(-1)![0]).toBe(-170);
    // Handover: -170 + 360 = 190.
    expect(segs[1]![0]![0]).toBe(190);
    expect(segs[1]![1]![0]).toBe(170);
  });

  it('all output coordinates are within [-360, 360]', () => {
    // 8 antimeridian crossings (westward 3°/step, 500 points).
    const raw: [number, number][] = [];
    for (let i = 0; i < 500; i++) raw.push([wrap(-3 * i), 10]);
    for (const seg of splitAtAntimeridian(raw)) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-SEGMENT_RANGE);
        expect(lon).toBeLessThanOrEqual(SEGMENT_RANGE);
      }
    }
  });

  it('produces multiple segments for a multi-circumnavigation track', () => {
    // 500 points × 3°/step westward: crosses the antimeridian roughly every 60 steps.
    const raw: [number, number][] = [];
    for (let i = 0; i < 500; i++) raw.push([wrap(-3 * i), 10]);
    const segs = splitAtAntimeridian(raw);
    expect(segs.length).toBeGreaterThan(4);
  });

  it('step within new segment is the short path (≤ 180°) after handover', () => {
    // Eastward crossing: handover at -190°, next raw at -170°. Step = +20°.
    const pts: [number, number][] = [[170, 10], [-170, 10], [-160, 10]];
    const segs = splitAtAntimeridian(pts);
    const seg2 = segs[1]!;
    // Step from handover (-190) to first raw point (-170).
    expect(Math.abs(seg2[1]![0] - seg2[0]![0])).toBeLessThanOrEqual(180);
  });
});

describe('processTrack', () => {
  it('returns raw coords and no overflow for empty/single input', () => {
    expect(processTrack([])).toMatchObject({ overflowSegments: [] });
    expect(processTrack([[0, 10]])).toMatchObject({ overflowSegments: [] });
  });

  it('produces no overflow for a simple non-crossing track', () => {
    const raw: [number, number][] = [[0, 10], [10, 10], [20, 10]];
    const { overflowSegments } = processTrack(raw);
    expect(overflowSegments).toHaveLength(0);
  });

  it('splits into overflow + coords on a single antimeridian crossing', () => {
    // Simple westward-crossing track: three points crossing the antimeridian.
    const raw: [number, number][] = [[170, 10], [175, 10], [-175, 10], [-170, 10]];
    const { coords, overflowSegments } = processTrack(raw);
    expect(overflowSegments).toHaveLength(1);
    // All coordinates within [-360, 360].
    for (const seg of [coords, ...overflowSegments]) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-SEGMENT_RANGE);
        expect(lon).toBeLessThanOrEqual(SEGMENT_RANGE);
      }
    }
  });

  it('keeps all segments within [-360, 360] for a westward multi-circumnavigation track', () => {
    const raw: [number, number][] = [];
    for (let i = 0; i < 500; i++) raw.push([wrap(-3 * i), 10]);
    const { coords, overflowSegments } = processTrack(raw);
    for (const seg of [coords, ...overflowSegments]) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-SEGMENT_RANGE);
        expect(lon).toBeLessThanOrEqual(SEGMENT_RANGE);
      }
    }
    expect(overflowSegments.length).toBeGreaterThan(1);
  });

  it('keeps all segments within [-360, 360] for an eastward multi-circumnavigation track', () => {
    const raw: [number, number][] = [];
    for (let i = 0; i < 500; i++) raw.push([wrap(3 * i), 10]);
    const { coords, overflowSegments } = processTrack(raw);
    for (const seg of [coords, ...overflowSegments]) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-SEGMENT_RANGE);
        expect(lon).toBeLessThanOrEqual(SEGMENT_RANGE);
      }
    }
    expect(overflowSegments.length).toBeGreaterThan(1);
  });

  it('coords is the last (most recent) segment', () => {
    // Track going eastward past the antimeridian: last raw point at -170°.
    // coords should contain that final point.
    const raw: [number, number][] = [[170, 10], [175, 10], [-175, 10], [-170, 10]];
    const { coords } = processTrack(raw);
    const lastCoord = coords[coords.length - 1]!;
    // After densification, the last point is the last raw point unchanged.
    expect(lastCoord[0]).toBeCloseTo(-170, 5);
    expect(lastCoord[1]).toBeCloseTo(10, 5);
  });
});

describe('processRouteCoords', () => {
  it('returns one segment for a route with no antimeridian crossing', () => {
    const raw: [number, number][] = [[-100, 10], [0, 10], [100, 10]];
    const segs = processRouteCoords(raw);
    expect(segs).toHaveLength(1);
  });

  it('returns two segments for a route crossing the antimeridian', () => {
    const raw: [number, number][] = [[170, 10], [-170, 10]];
    const segs = processRouteCoords(raw);
    expect(segs).toHaveLength(2);
    for (const seg of segs) {
      for (const [lon] of seg) {
        expect(lon).toBeGreaterThanOrEqual(-SEGMENT_RANGE);
        expect(lon).toBeLessThanOrEqual(SEGMENT_RANGE);
      }
    }
  });
});
