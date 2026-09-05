import { describe, expect, it } from 'vitest';
import { destPoint, rhumbCoords, gcCoords } from './lineGeometry';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111_320; // approximate metres per degree of latitude

// ───── destPoint ─────────────────────────────────────────────────────────────

describe('destPoint', () => {
  it('returns the start position for zero distance', () => {
    const [lon, lat] = destPoint(10, 55, 0, 0);
    expect(lon).toBeCloseTo(10, 10);
    expect(lat).toBeCloseTo(55, 10);
  });

  it('moves due north at the equator by the expected amount', () => {
    const dist = 1000; // 1 km
    const [lon, lat] = destPoint(0, 0, 0, dist);
    expect(lon).toBeCloseTo(0, 10);
    expect(lat).toBeCloseTo(dist / M_PER_DEG_LAT, 3);
  });

  it('moves due east, scaling longitude by cos(lat)', () => {
    const dist = 1000;
    const [lon, lat] = destPoint(0, 60, Math.PI / 2, dist);
    expect(lat).toBeCloseTo(60, 3);
    expect(lon).toBeCloseTo(dist / (M_PER_DEG_LAT * Math.cos(60 * DEG)), 2);
  });

  it('clamps latitude near the north pole (no NaN or Infinity)', () => {
    const [lon, lat] = destPoint(0, 89.9999, 0, 100_000);
    expect(Number.isFinite(lon)).toBe(true);
    expect(Number.isFinite(lat)).toBe(true);
    // Latitude should be clamped to just under 90°
    expect(lat).toBeLessThan(90);
  });

  it('clamps latitude near the south pole', () => {
    const [lon, lat] = destPoint(0, -89.9999, Math.PI, 100_000);
    expect(Number.isFinite(lon)).toBe(true);
    expect(Number.isFinite(lat)).toBe(true);
    expect(lat).toBeGreaterThan(-90);
  });

  it('handles start at exactly ±90° without blowing up', () => {
    const [lonN, latN] = destPoint(0, 90, 0, 0);
    expect(Number.isFinite(lonN)).toBe(true);
    expect(Number.isFinite(latN)).toBe(true);

    const [lonS, latS] = destPoint(0, -90, Math.PI, 0);
    expect(Number.isFinite(lonS)).toBe(true);
    expect(Number.isFinite(latS)).toBe(true);
  });
});

// ───── rhumbCoords ───────────────────────────────────────────────────────────

describe('rhumbCoords', () => {
  it('returns 257 points (256 segments + start)', () => {
    const coords = rhumbCoords(0, 0, 0, 10_000);
    expect(coords).toHaveLength(257);
  });

  it('first point equals the start position', () => {
    const coords = rhumbCoords(10, 55, 1.0, 50_000);
    expect(coords[0][0]).toBeCloseTo(10, 10);
    expect(coords[0][1]).toBeCloseTo(55, 10);
  });

  it('zero distance returns 257 copies of the start position', () => {
    const coords = rhumbCoords(5, 60, 0, 0);
    expect(coords).toHaveLength(257);
    for (const [lon, lat] of coords) {
      expect(lon).toBeCloseTo(5, 10);
      expect(lat).toBeCloseTo(60, 10);
    }
  });

  // ── pole cap: starting below 85° ──

  it('caps latitude at 85° when heading north from below the cap', () => {
    const coords = rhumbCoords(0, 80, 0, 1_000_000);
    const maxLat = Math.max(...coords.map(c => c[1]));
    expect(maxLat).toBeCloseTo(85, 3);
    expect(maxLat).toBeLessThanOrEqual(85.001);
  });

  it('caps latitude at −85° when heading south from above the cap', () => {
    const coords = rhumbCoords(0, -80, Math.PI, 1_000_000);
    const minLat = Math.min(...coords.map(c => c[1]));
    expect(minLat).toBeCloseTo(-85, 3);
    expect(minLat).toBeGreaterThanOrEqual(-85.001);
  });

  // ── pole cap: starting AT or ABOVE 85° (the former bug) ──

  it('produces no NaN/Infinity when starting at 86° heading poleward', () => {
    const coords = rhumbCoords(0, 86, 0.1, 500_000);
    for (const [lon, lat] of coords) {
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
    // With the cap fix, distance is clamped to 0 so all coords equal start
    expect(coords[0][0]).toBeCloseTo(0, 8);
    expect(coords[0][1]).toBeCloseTo(86, 8);
  });

  it('produces no NaN/Infinity when starting at −87° heading south', () => {
    const coords = rhumbCoords(10, -87, Math.PI, 300_000);
    for (const [lon, lat] of coords) {
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });

  it('clamps to zero-length at exactly ±90° heading poleward', () => {
    const coords = rhumbCoords(0, 90, 0, 10_000);
    for (const [lon, lat] of coords) {
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
    // All points should be at the (clamped) start
    const lats = coords.map(c => c[1]);
    const spread = Math.max(...lats) - Math.min(...lats);
    expect(spread).toBeLessThan(0.001);
  });

  // ── antimeridian crossing ──

  it('maintains continuous longitude across the antimeridian', () => {
    // Due east from 170°E, 50 km — should cross 180° without a 360° jump
    const coords = rhumbCoords(170, 0, Math.PI / 2, 5_000_000);
    for (let i = 1; i < coords.length; i++) {
      const jump = Math.abs(coords[i][0] - coords[i - 1][0]);
      // Adjacent points should never jump by ~360°
      expect(jump).toBeLessThan(10);
    }
    // Final longitude should be past 180° (unwrapped)
    expect(coords[coords.length - 1][0]).toBeGreaterThan(180);
  });

  it('maintains continuous longitude heading west across the antimeridian', () => {
    // Due west from −170° — crosses −180°
    const coords = rhumbCoords(-170, 0, (3 * Math.PI) / 2, 5_000_000);
    for (let i = 1; i < coords.length; i++) {
      const jump = Math.abs(coords[i][0] - coords[i - 1][0]);
      expect(jump).toBeLessThan(10);
    }
    expect(coords[coords.length - 1][0]).toBeLessThan(-180);
  });
});

// ───── gcCoords (smoke) ──────────────────────────────────────────────────────

describe('gcCoords', () => {
  it('returns 257 points', () => {
    expect(gcCoords(0, 0, 0, 10_000)).toHaveLength(257);
  });

  it('first point equals the start position', () => {
    const coords = gcCoords(5, 60, 1.0, 50_000);
    expect(coords[0][0]).toBeCloseTo(5, 10);
    expect(coords[0][1]).toBeCloseTo(60, 10);
  });
});
