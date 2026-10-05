import { describe, expect, it } from 'vitest';
import type { Layer } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { buildAisLayers } from './aisLayerBuilder';
import {
  AIS_HOT_STRIDE,
  AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG,
  AIS_F_HDG, AIS_F_ROT, AIS_F_AGE,
  type AisColdData,
} from '../stores/ais.svelte';
import type { AppearanceSettings } from '../stores/settings.svelte';
import { VesselMorphLayer } from '../layers/VesselMorphLayer';

interface TestVessel {
  id: string;
  lon?: number;
  lat?: number;
  cog?: number;
  sog?: number;
  hdg?: number;
  rot?: number;
  cold?: Omit<AisColdData, 'id'>;
}

const AP: AppearanceSettings['ais'] = {
  vesselColor: '#22c55e',
  vesselSize: 20,
  cog:   { color: '#374151', width: 1.5, style: 'dashed', lengthMinutes: 3 },
  track: { show: true, color: '#f97316', width: 2, style: 'solid', historyHours: 24 },
};

/** Moving vessel with valid telemetry and a known hull unless overridden. */
function build(vessels: TestVessel[], ap: AppearanceSettings['ais'] = AP): Map<string, Layer> {
  const hot = new Float64Array(vessels.length * AIS_HOT_STRIDE);
  const coldMap = new Map<string, AisColdData>();
  vessels.forEach((v, i) => {
    const b = i * AIS_HOT_STRIDE;
    hot[b + AIS_F_LON] = v.lon ?? 10;
    hot[b + AIS_F_LAT] = v.lat ?? 55;
    hot[b + AIS_F_COG] = v.cog ?? 1;
    hot[b + AIS_F_SOG] = v.sog ?? 5;
    hot[b + AIS_F_HDG] = v.hdg ?? 1;
    hot[b + AIS_F_ROT] = v.rot ?? 0;
    hot[b + AIS_F_AGE] = 0;
    if (v.cold) coldMap.set(v.id, { id: v.id, ...v.cold });
  });
  const layers = buildAisLayers(hot, vessels.map(v => v.id), coldMap, ap, 0, 30, null);
  const byId = new Map<string, Layer>();
  for (const l of layers) {
    expect(byId.has(l.id), `duplicate layer id ${l.id}`).toBe(false);
    byId.set(l.id, l);
  }
  return byId;
}

function dataOf(layers: Map<string, Layer>, id: string): number[] | undefined {
  return layers.get(id)?.props.data as number[] | undefined;
}

function morphLengthAccessor(layers: Map<string, Layer>, id: string): (i: number) => number {
  const layer = layers.get(id);
  if (!(layer instanceof VesselMorphLayer)) throw new Error(`${id} is not a VesselMorphLayer`);
  const acc: unknown = layer.props.getLength;
  if (typeof acc !== 'function') throw new Error(`${id}.getLength is not a function`);
  return acc as (i: number) => number;
}

function cogPathAccessor(layers: Map<string, Layer>): (i: number) => [number, number][] {
  const layer = layers.get('ais-cog');
  if (!(layer instanceof PathLayer)) throw new Error('ais-cog is not a PathLayer');
  const acc: unknown = (layer as PathLayer<number>).props.getPath;
  if (typeof acc !== 'function') throw new Error('ais-cog.getPath is not a function');
  return acc as (i: number) => [number, number][];
}

const STATE_LAYERS = [
  'ais-anchored', 'ais-moored', 'ais-aground', 'ais-fishing',
  'ais-nuc', 'ais-restricted', 'ais-draught',
] as const;

const HULL: Omit<AisColdData, 'id'> = { lengthM: 30, beamM: 8 };

describe('buildAisLayers — nav state classification', () => {
  // Exact `navigation.state` strings emitted by Signal K's AIS mapping
  // (SignalK/nmea0183-signalk src/hooks/VDM.ts stateMapping), passed verbatim
  // through vessel_info.rs → coldMap.navState.
  const cases: [string, (typeof STATE_LAYERS)[number] | null][] = [
    ['motoring',                          null],
    ['anchored',                          'ais-anchored'],
    ['not under command',                 'ais-nuc'],
    ['restricted manouverability',        'ais-restricted'],
    ['constrained by draft',              'ais-draught'],
    ['moored',                            'ais-moored'],
    ['aground',                           'ais-aground'],
    ['fishing',                           'ais-fishing'],
    ['sailing',                           null],
    ['hazardous material high speed',     null],
    ['hazardous material wing in ground', null],
    ['default',                           null],
  ];

  it.each(cases)('%s → %s', (navState, expected) => {
    const layers = build([{ id: 'v', cold: { ...HULL, navState } }]);

    expect(dataOf(layers, 'ais-confirmed-main')).toEqual([0]);
    expect(dataOf(layers, 'ais-ghost-main')).toEqual([0]);
    expect(layers.has('ais-mob-icon')).toBe(false);
    for (const id of STATE_LAYERS) {
      if (id === expected) {
        expect(dataOf(layers, id), id).toEqual([0]);
        expect(dataOf(layers, `${id}-ghost`), `${id}-ghost`).toEqual([0]);
      } else {
        expect(layers.has(id), id).toBe(false);
        expect(layers.has(`${id}-ghost`), `${id}-ghost`).toBe(false);
      }
    }
  });

  it('classifies case-insensitively', () => {
    const layers = build([{ id: 'v', cold: { navState: 'Constrained By Draft' } }]);
    expect(dataOf(layers, 'ais-draught')).toEqual([0]);
  });

  it('routes each vessel of a mixed fleet to its own state layer by index', () => {
    const layers = build([
      { id: 'a', cold: { navState: 'anchored' } },
      { id: 'b', cold: { navState: 'motoring' } },
      { id: 'c', cold: { navState: 'constrained by draft' } },
      { id: 'd' },
      { id: 'e', cold: { navState: 'anchored' } },
    ]);
    expect(dataOf(layers, 'ais-confirmed-main')).toEqual([0, 1, 2, 3, 4]);
    expect(dataOf(layers, 'ais-anchored')).toEqual([0, 4]);
    expect(dataOf(layers, 'ais-draught')).toEqual([2]);
  });
});

describe('buildAisLayers — SART / MOB', () => {
  it("routes 'ais-sart' only to the MOB icon layer", () => {
    const layers = build([
      { id: 'sart', cold: { navState: 'ais-sart' } },
      { id: 'ship', cold: { ...HULL, navState: 'motoring' } },
    ]);
    expect(dataOf(layers, 'ais-mob-icon')).toEqual([0]);
    expect(dataOf(layers, 'ais-confirmed-main')).toEqual([1]);
    expect(dataOf(layers, 'ais-ghost-main')).toEqual([1]);
    expect(dataOf(layers, 'ais-cog')).toEqual([1]);
  });

  it('draws the MOB icon above every other layer', () => {
    const ids = [...build([
      { id: 'sart', cold: { navState: 'ais-sart' } },
      { id: 'ship', cold: { navState: 'anchored' } },
    ]).keys()];
    expect(ids[ids.length - 1]).toBe('ais-mob-icon');
  });
});

describe('buildAisLayers — ghost / COG gating', () => {
  it.each([
    ['SOG', { sog: NaN }],
    ['COG', { cog: NaN }],
  ])('NaN %s → confirmed arrow + state mark, no ghost and no COG line', (_label, telemetry) => {
    const layers = build([{ id: 'v', ...telemetry, cold: { ...HULL, navState: 'anchored' } }]);
    expect(dataOf(layers, 'ais-confirmed-main')).toEqual([0]);
    expect(dataOf(layers, 'ais-anchored')).toEqual([0]);
    expect(layers.has('ais-ghost-main')).toBe(false);
    expect(layers.has('ais-anchored-ghost')).toBe(false);
    expect(dataOf(layers, 'ais-cog')).toEqual([]);
  });

  it('SOG 0 still gets a ghost (it dead-reckons onto its own position)', () => {
    const layers = build([{ id: 'v', sog: 0, cold: { navState: 'moored' } }]);
    expect(dataOf(layers, 'ais-ghost-main')).toEqual([0]);
    expect(dataOf(layers, 'ais-moored-ghost')).toEqual([0]);
    expect(dataOf(layers, 'ais-cog')).toEqual([0]);
  });
});

describe('buildAisLayers — hull gate', () => {
  it.each<[string, TestVessel, number]>([
    ['full hull data',             { id: 'v', cold: HULL },                                 30],
    ['heading NaN, COG valid',     { id: 'v', hdg: NaN, cold: HULL },                       30],
    ['heading and COG both NaN',   { id: 'v', hdg: NaN, cog: NaN, cold: HULL },             0],
    ['no cold data',               { id: 'v' },                                             0],
    ['length missing',             { id: 'v', cold: { beamM: 8 } },                         0],
    ['beam missing',               { id: 'v', cold: { lengthM: 30 } },                      0],
    ['length 0',                   { id: 'v', cold: { lengthM: 0, beamM: 8 } },             0],
    ['beam 0',                     { id: 'v', cold: { lengthM: 30, beamM: 0 } },            0],
  ])('%s → morph length %d', (_label, vessel, expectedLength) => {
    const layers = build([{ ...vessel, cold: { ...vessel.cold, navState: 'aground' } }]);
    // Every morph layer shares the same gate — main arrow and state mark must agree,
    // or a hull silhouette would appear without its mark (or vice versa).
    expect(morphLengthAccessor(layers, 'ais-confirmed-main')(0)).toBe(expectedLength);
    expect(morphLengthAccessor(layers, 'ais-aground')(0)).toBe(expectedLength);
  });
});

describe('buildAisLayers — COG prediction path', () => {
  const totalSec = AP.cog.lengthMinutes * 60;
  const dist = ([aLon, aLat]: [number, number], [bLon, bLat]: [number, number]) =>
    Math.hypot(aLon - bLon, aLat - bLat);

  it.each([
    ['zero ROT', 0],
    ['NaN ROT',  NaN],
    ['ROT just under the 1e-4 rad/s threshold', 0.9e-4],
  ])('%s → straight 2-point line', (_label, rot) => {
    const layers = build([{ id: 'v', rot }]);
    const path = cogPathAccessor(layers)(0);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual([10, 55]);
  });

  it('turning vessel slower than one revolution → open 25-point arc', () => {
    // Half a revolution over the prediction horizon: the end is far from the start.
    const rot = Math.PI / totalSec;
    const path = cogPathAccessor(build([{ id: 'v', rot }]))(0);
    expect(path).toHaveLength(25);
    expect(dist(path[0]!, path[24]!)).toBeGreaterThan(1e-4);
  });

  it('fast-turning vessel → arc capped at exactly one revolution', () => {
    // 10.5 revolutions within the horizon; the cap must stop at one closed loop
    // instead of spiralling, so the last point returns to the start (uncapped, it
    // would end half a turn away).
    const rot = (10.5 * 2 * Math.PI) / totalSec;
    const path = cogPathAccessor(build([{ id: 'v', rot }]))(0);
    expect(path).toHaveLength(25);
    const start = path[0]!;
    const end = path[24]!;
    const midway = path[12]!;
    expect(dist(start, end)).toBeLessThan(1e-9);
    expect(dist(start, midway)).toBeGreaterThan(1e-5);
  });
});

describe('buildAisLayers — empty input', () => {
  it('returns only the always-present, empty COG path layer', () => {
    const layers = build([]);
    expect([...layers.keys()]).toEqual(['ais-cog']);
    expect(dataOf(layers, 'ais-cog')).toEqual([]);
  });
});
