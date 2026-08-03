import { describe, expect, it } from 'vitest';
import { buildSnapTargets } from './snapTargets';
import { extrapolatePos } from './deadReckoning';
import { AIS_HOT_STRIDE, AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG, AIS_F_ROT, AIS_F_AGE } from '../stores/ais.svelte';

interface HotRow {
  lon: number;
  lat: number;
  cog?: number; // rad; undefined → NaN (no valid COG)
  sog?: number; // m/s; undefined → NaN
  rot?: number; // rad/s; undefined → NaN
  age?: number; // seconds since last position fix at upload time
}

function mkHot(rows: HotRow[]): Float64Array {
  const hd = new Float64Array(rows.length * AIS_HOT_STRIDE);
  rows.forEach((r, i) => {
    const b = i * AIS_HOT_STRIDE;
    hd[b + AIS_F_LON] = r.lon;
    hd[b + AIS_F_LAT] = r.lat;
    hd[b + AIS_F_COG] = r.cog ?? NaN;
    hd[b + AIS_F_SOG] = r.sog ?? NaN;
    hd[b + AIS_F_ROT] = r.rot ?? NaN;
    hd[b + AIS_F_AGE] = r.age ?? 0;
  });
  return hd;
}

const UPLOAD_TS = 1_000_000;
const CAP_MS    = 3 * 60 * 1000;
const OWN       = { longitude: 5, latitude: 60 };

describe('buildSnapTargets', () => {
  it('emits last-known plus dead-reckoned ghost for a moving vessel', () => {
    const hd = mkHot([{ lon: 10, lat: 59, cog: 1.0, sog: 5, age: 10 }]);
    const now = UPLOAD_TS + 5000;
    const targets = buildSnapTargets(hd, ['v1'], UPLOAD_TS, null, now, CAP_MS);

    expect(targets.map(t => t.id)).toEqual(['v1', 'v1:ghost']);
    expect(targets[0]!.position).toEqual({ longitude: 10, latitude: 59 });

    const lastPosMs = UPLOAD_TS - 10 * 1000;
    const [gLon, gLat] = extrapolatePos(10, 59, 1.0, 5, 0, lastPosMs, now);
    expect(targets[1]!.position.longitude).toBeCloseTo(gLon, 12);
    expect(targets[1]!.position.latitude).toBeCloseTo(gLat, 12);
    // the ghost must actually have moved off the last-known position
    expect(targets[1]!.position.longitude).not.toBeCloseTo(10, 6);
  });

  it('emits only the last-known target for a stationary vessel (no COG/SOG)', () => {
    const hd = mkHot([{ lon: 10, lat: 59 }]);
    const targets = buildSnapTargets(hd, ['v1'], UPLOAD_TS, null, UPLOAD_TS + 5000, CAP_MS);
    expect(targets.map(t => t.id)).toEqual(['v1']);
  });

  it('caps dead reckoning at capMs for stale data', () => {
    const hd = mkHot([{ lon: 10, lat: 59, cog: 1.0, sog: 5, age: 10 }]);
    const lastPosMs = UPLOAD_TS - 10 * 1000;
    // Data outage: now is far beyond the cap.
    const now = lastPosMs + CAP_MS * 20;
    const targets = buildSnapTargets(hd, ['v1'], UPLOAD_TS, null, now, CAP_MS);

    const [cLon, cLat] = extrapolatePos(10, 59, 1.0, 5, 0, lastPosMs, lastPosMs + CAP_MS);
    expect(targets[1]!.position.longitude).toBeCloseTo(cLon, 12);
    expect(targets[1]!.position.latitude).toBeCloseTo(cLat, 12);

    const [uncappedLon] = extrapolatePos(10, 59, 1.0, 5, 0, lastPosMs, now);
    expect(targets[1]!.position.longitude).not.toBeCloseTo(uncappedLon, 6);
  });

  it('always appends the own vessel when a position exists', () => {
    const hd = mkHot([{ lon: 10, lat: 59 }]);
    const targets = buildSnapTargets(hd, ['v1'], UPLOAD_TS, OWN, UPLOAD_TS, CAP_MS);
    expect(targets.at(-1)).toEqual({ id: 'own-vessel', position: OWN });
  });

  it('handles missing AIS data: own vessel only', () => {
    expect(buildSnapTargets(null, [], 0, OWN, UPLOAD_TS, CAP_MS)).toEqual([
      { id: 'own-vessel', position: OWN },
    ]);
    expect(buildSnapTargets(null, [], 0, null, UPLOAD_TS, CAP_MS)).toEqual([]);
  });

  it('skips AIS targets when no upload timestamp exists yet', () => {
    const hd = mkHot([{ lon: 10, lat: 59 }]);
    expect(buildSnapTargets(hd, ['v1'], 0, null, UPLOAD_TS, CAP_MS)).toEqual([]);
  });

  it('never indexes past the hot-data buffer when ids outnumber rows', () => {
    const hd = mkHot([{ lon: 10, lat: 59 }]); // one row, two ids
    const targets = buildSnapTargets(hd, ['v1', 'v2'], UPLOAD_TS, null, UPLOAD_TS, CAP_MS);
    expect(targets.map(t => t.id)).toEqual(['v1']); // v2 has no row — dropped, not NaN
  });
});
