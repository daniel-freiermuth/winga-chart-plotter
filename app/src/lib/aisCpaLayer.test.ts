import { describe, expect, it } from 'vitest';
import { buildCpaLayers, type SkCpaInput } from './aisCpaLayer';
import { extrapolatePos } from './deadReckoning';
import type { CpaResult } from './wasmGeo';

// --- fixtures ---------------------------------------------------------------

/** A dummy Rust CPA result with vessels already opening (so Rust ghost is skipped). */
const openingRust: CpaResult = {
  cpa_nm: 2.0,
  tcpa_min: -1,
  own_lon: 24.0,
  own_lat: 60.0,
  tgt_lon: 24.2,
  tgt_lat: 60.0,
  isOpening: true,
  isCapped: false,
};

// Vessel moving due east at 10 m/s from 60°N, 24°E.
const TGT_LON = 24.0;
const TGT_LAT = 60.0;
const TGT_COG = Math.PI / 2;   // 90° — due east
const TGT_SOG = 10.0;          // m/s

// Own vessel stationary (NaN COG/SOG → no extrapolation for own).
const OWN_LON = 24.0;
const OWN_LAT = 60.05;
const OWN_COG = NaN;
const OWN_SOG = NaN;

// 6 hours in seconds — well beyond the 2 h projection cap.
const SIX_HOURS_S = 21_600;

// 2 hours in seconds — the projection cap.
const TWO_HOURS_S = 7_200;

const skCpa6h: SkCpaInput = { distanceM: 5000, timeToS: SIX_HOURS_S };

// --- helpers ----------------------------------------------------------------

/** Extract the ScatterplotLayer data (ghost dot coordinates) for the SK layer. */
function skGhostDots(layers: unknown[]): [number, number][] {
  const scatter = (layers as Array<{ id: string; props: { data: [number, number][] } }>)
    .find((l) => l.id === 'cpa-ghost-sk');
  return scatter?.props?.data ?? [];
}

// --- tests ------------------------------------------------------------------

describe('buildCpaLayers SK ghost projection cap', () => {
  it('caps the SK ghost at the 2 h projection horizon, not the raw timeToS', () => {
    const layers = buildCpaLayers(
      OWN_LON, OWN_LAT, OWN_COG, OWN_SOG,
      TGT_LON, TGT_LAT, TGT_COG, TGT_SOG, 0,
      openingRust,
      skCpa6h,
    );

    const dots = skGhostDots(layers);
    expect(dots.length).toBe(2);

    // Own vessel is stationary (NaN COG) → ghost should be at own position.
    const [ownGhostLon, ownGhostLat] = dots[0]!;
    expect(ownGhostLon).toBeCloseTo(OWN_LON, 4);
    expect(ownGhostLat).toBeCloseTo(OWN_LAT, 4);

    // Target ghost should match the 2 h-capped extrapolation.
    const [expected2hLon, expected2hLat] = extrapolatePos(
      TGT_LON, TGT_LAT, TGT_COG, TGT_SOG, 0, 0, TWO_HOURS_S * 1000,
    );
    const [uncapped6hLon] = extrapolatePos(
      TGT_LON, TGT_LAT, TGT_COG, TGT_SOG, 0, 0, SIX_HOURS_S * 1000,
    );

    // Sanity: the two extrapolations must differ (proves cap matters).
    expect(Math.abs(uncapped6hLon - expected2hLon)).toBeGreaterThan(0.1);

    // The ghost MUST match the capped 2 h position.
    const [tgtGhostLon, tgtGhostLat] = dots[1]!;
    expect(tgtGhostLon).toBeCloseTo(expected2hLon, 6);
    expect(tgtGhostLat).toBeCloseTo(expected2hLat, 6);
  });

  it('does not alter SK ghost projection when timeToS <= 7200', () => {
    const sk30min: SkCpaInput = { distanceM: 1000, timeToS: 1800 };
    const layers = buildCpaLayers(
      OWN_LON, OWN_LAT, OWN_COG, OWN_SOG,
      TGT_LON, TGT_LAT, TGT_COG, TGT_SOG, 0,
      openingRust,
      sk30min,
    );

    const dots = skGhostDots(layers);
    const [expected30mLon, expected30mLat] = extrapolatePos(
      TGT_LON, TGT_LAT, TGT_COG, TGT_SOG, 0, 0, 1800 * 1000,
    );

    const [tgtGhostLon, tgtGhostLat] = dots[1]!;
    expect(tgtGhostLon).toBeCloseTo(expected30mLon, 6);
    expect(tgtGhostLat).toBeCloseTo(expected30mLat, 6);
  });
});
