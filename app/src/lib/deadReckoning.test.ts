import { describe, expect, it } from 'vitest';
import { extrapolateHeading, extrapolatePos } from './deadReckoning';

const M_PER_DEG_LAT = 111320;

describe('extrapolatePos', () => {
  it('returns the input position when no time has elapsed', () => {
    expect(extrapolatePos(5, 60, 0, 10, 0, 1000, 1000)).toEqual([5, 60]);
  });

  it('returns the input position when the vessel is effectively stationary', () => {
    expect(extrapolatePos(5, 60, 0, 0.005, 0, 0, 60_000)).toEqual([5, 60]);
  });

  it('dead-reckons a straight northbound track at the equator', () => {
    // 10 m/s due north for 60 s = 600 m north; at the equator 1° lat = 111320 m.
    const [lon, lat] = extrapolatePos(0, 0, 0, 10, 0, 0, 60_000);
    expect(lon).toBeCloseTo(0, 10);
    expect(lat).toBeCloseTo(600 / M_PER_DEG_LAT, 10);
  });

  it('scales eastbound displacement by cos(lat)', () => {
    // 600 m due east at 60°N: 1° lon = 111320·cos(60°) = 55660 m,
    // so the longitude delta is twice the equatorial one.
    const [lon, lat] = extrapolatePos(0, 60, Math.PI / 2, 10, 0, 0, 60_000);
    expect(lat).toBeCloseTo(60, 10);
    expect(lon).toBeCloseTo(600 / (M_PER_DEG_LAT * Math.cos(Math.PI / 3)), 10);
  });

  it('follows a circular arc when turning', () => {
    // Heading north, turning right through exactly 90° over dt: the vessel
    // traces a quarter circle of radius R = sog/rot and ends displaced
    // (R east, R north) of the start.
    const dtS = 30;
    const rot = Math.PI / 2 / dtS;
    const sog = 10;
    const R = sog / rot;
    const [lon, lat] = extrapolatePos(0, 0, 0, sog, rot, 0, dtS * 1000);
    expect(lon).toBeCloseTo(R / M_PER_DEG_LAT, 10);
    expect(lat).toBeCloseTo(R / M_PER_DEG_LAT, 10);
  });
});

describe('extrapolateHeading', () => {
  it('advances heading linearly by rate of turn', () => {
    expect(extrapolateHeading(1, 0.01, 0, 30_000)).toBeCloseTo(1.3, 12);
  });

  it('keeps heading constant with zero rate of turn', () => {
    expect(extrapolateHeading(2.5, 0, 0, 120_000)).toBe(2.5);
  });
});
