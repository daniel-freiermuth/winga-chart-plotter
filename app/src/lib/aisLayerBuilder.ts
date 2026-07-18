import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { AisColdData } from '../stores/ais.svelte';
import {
  AIS_HOT_STRIDE,
  AIS_F_LON, AIS_F_LAT, AIS_F_COG, AIS_F_SOG,
  AIS_F_HDG, AIS_F_ROT, AIS_F_AGE,
} from '../stores/ais.svelte';
import type { AppearanceSettings } from '../stores/settings.svelte';
import {
  VesselMorphLayer,
  MORPH_ARROW, MORPH_ANCHOR_DOT, MORPH_AGROUND_RING, MORPH_MOORING_BARS,
  MORPH_FISHING_GEAR, MORPH_NUC, MORPH_RESTRICTED, MORPH_DRAUGHT,
  type MorphGeometry,
} from '../layers/VesselMorphLayer';
import { VesselIconLayer, MOB_GEOMETRY } from '../layers/VesselIconLayer';
import { extrapolatePos } from './deadReckoning';
import { hexToRgba, lineStyleDash } from './mapStyles';

/**
 * Builds all deck.gl AIS layers for the current data tick.
 * Pure function of its arguments — no reactive reads, no side effects.
 * Called from the AIS $effect in Map.svelte after snapshot management and the empty-data guard.
 */
export function buildAisLayers(
  hotData: Float64Array,
  ids: string[],
  coldMap: Map<string, AisColdData>,
  ap: AppearanceSettings['ais'],
  uploadTimestamp: number,
  targetFps: number,
  selectedIndex: number | null,
): Layer[] {
  const S = AIS_HOT_STRIDE;
  const n = ids.length;

  const settingsIconSize = ap.vesselSize / 64;
  const cogColor         = ap.cog.color;
  const cogWidth         = ap.cog.width;
  const cogStyle         = ap.cog.style;
  const cogLengthMinutes = ap.cog.lengthMinutes;

  // Single O(N) pass — independent axes, no cross-effects:
  //   Motion axis  (SOG):      ghostIndices, cogIndices
  //   Arrow axis   (always):   visIndices → all get a plain arrow
  //   State axis   (navState): all state/type decorations live here
  //   Hull gate    (heading+dims): hullIndices — gates the morph layers' getLength so
  //                                vessels without a real hull stay icon-only forever.
  const visIndices:            number[] = []; // all vessels → arrow (SART excluded)
  const ghostIndices:          number[] = []; // valid SOG/COG → ghost DR arrow + COG
  const cogIndices:            number[] = [];
  const hullIndices:           number[] = [];
  const anchoredIndices:       number[] = []; // nav state "anchored" → anchor-ball mark
  const agroundIndices:        number[] = []; // nav state "aground" → aground-ring mark
  const mooredIndices:         number[] = []; // nav state "moored" → mooring-bars mark
  const fishingIndices:        number[] = []; // nav state "fishing" → fishing-gear mark
  const nucIndices:            number[] = []; // nav state 2 "notUnderCommand" → two-dot mark
  const restrictedIndices:     number[] = []; // nav state 3 "restrictedManoeuvrability" → ball-diamond-ball
  const draughtIndices:        number[] = []; // nav state 4 "constrainedByDraught" → side-bars mark
  const sarIndices:            number[] = []; // nav state 14 SART/MOB → special red icon, no arrow
  // Ghost-decoration subsets — a state mark's GHOST (dead-reckoned) copy must only exist
  // for vessels actually qualifying for dead-reckoning (same gate as ghostIndices above:
  // valid SOG/COG telemetry to extrapolate from at all). Without this, a state mark's
  // ghost copy could exist with no corresponding main ghost arrow, or vice versa. Note a
  // vessel reporting SOG ≈ 0 still gets a ghost — it just dead-reckons to its own
  // last-known position, so the ghost and confirmed marks simply coincide (no drift).
  const anchoredGhostIndices:    number[] = [];
  const agroundGhostIndices:     number[] = [];
  const mooredGhostIndices:      number[] = [];
  const fishingGhostIndices:     number[] = [];
  const nucGhostIndices:         number[] = [];
  const restrictedGhostIndices:  number[] = [];
  const draughtGhostIndices:     number[] = [];

  for (let i = 0; i < n; i++) {
    // Nav state lookup first — SART vessels are routed entirely to their own layer.
    const cold = coldMap.get(ids[i]!);
    const ns = cold?.navState?.toLowerCase() ?? '';
    const isSart = ns.includes('sart') || ns.includes('transponder');

    if (isSart) {
      sarIndices.push(i);
      continue;
    }

    visIndices.push(i);

    // Motion — SOG only, nav state irrelevant
    const isog = hotData[i * S + AIS_F_SOG]!;
    const icog = hotData[i * S + AIS_F_COG]!;
    const isGhost = !isNaN(icog) && !isNaN(isog);
    if (isGhost) {
      ghostIndices.push(i);
      cogIndices.push(i);
    }

    // Hull gate — orientation (heading or COG) + dimensions known. Vessels failing this
    // stay icon-only forever (VesselMorphLayer forces t=0 when getLength returns 0).
    // getHdg already falls back to COG when heading is NaN; the gate mirrors that so a
    // vessel with dimensions but only COG orientation still morphs into a hull shape.
    const ihdg = hotData[i * S + AIS_F_HDG]!;
    const hasHull = (!isNaN(ihdg) || !isNaN(icog)) && (cold?.lengthM ?? 0) > 0 && (cold?.beamM ?? 0) > 0;
    if (hasHull) {
      hullIndices.push(i);
    }

    // State annotations — nav state only, SOG and ship type irrelevant. One morph layer
    // per state handles both the icon-zoom mark and the hull-zoom mark (and everything
    // between); no separate hull-having subset needed. The Ghost-subset push mirrors
    // ghostIndices's own gate so a state mark's ghost copy never exists without a
    // genuine dead-reckoning prediction also being shown for that vessel.
    if (ns.includes('aground')) {
      agroundIndices.push(i);
      if (isGhost) agroundGhostIndices.push(i);
    } else if (ns.includes('anchor')) {
      anchoredIndices.push(i);
      if (isGhost) anchoredGhostIndices.push(i);
    } else if (ns.includes('moor')) {
      mooredIndices.push(i);
      if (isGhost) mooredGhostIndices.push(i);
    } else if (ns.includes('fishing')) {
      fishingIndices.push(i);
      if (isGhost) fishingGhostIndices.push(i);
    } else if (ns.includes('command')) {
      // "notUnderCommand" — only nav state containing "command"
      nucIndices.push(i);
      if (isGhost) nucGhostIndices.push(i);
    } else if (ns.includes('restrict')) {
      restrictedIndices.push(i);
      if (isGhost) restrictedGhostIndices.push(i);
    } else if (ns.includes('draught')) {
      // "constrainedByHerDraught" / "constrainedByDraught"
      draughtIndices.push(i);
      if (isGhost) draughtGhostIndices.push(i);
    }
  }

  const vesselColor      = hexToRgba(ap.vesselColor, 220);
  const ghostVesselColor = hexToRgba(ap.vesselColor, 130);

  // Accessor lambdas — close over hotData, coldMap, ids. Zero allocations per frame.
  const getPos  = (i: number): [number, number, number] => [hotData[i * S + AIS_F_LON]!, hotData[i * S + AIS_F_LAT]!, 0];
  const getSog  = (i: number) => { const v = hotData[i * S + AIS_F_SOG]!; return isNaN(v) ? 0 : v; };
  const getCog  = (i: number) => { const v = hotData[i * S + AIS_F_COG]!; return isNaN(v) ? 0 : v; };
  const getHdg  = (i: number) => { const h = hotData[i * S + AIS_F_HDG]!; if (!isNaN(h)) return h; const c = hotData[i * S + AIS_F_COG]!; return isNaN(c) ? 0 : c; };
  const getRot  = (i: number) => { const v = hotData[i * S + AIS_F_ROT]!; return isNaN(v) ? 0 : v; };
  const getAge  = (i: number) => hotData[i * S + AIS_F_AGE]!;
  const getLen  = (i: number, fallback: number) => coldMap.get(ids[i]!)?.lengthM ?? fallback;
  const getBeam = (i: number, fallback: number) => coldMap.get(ids[i]!)?.beamM ?? fallback;
  // The morph only fires when a hull polygon can actually be drawn for this vessel.
  // Vessels with no orientation at all (both heading and COG unknown) have no hull →
  // VesselMorphLayer forces t=0 and stays icon-only forever (see hasHull above).
  const hullSet = new Set(hullIndices);
  const getLengthForMorph = (i: number) => hullSet.has(i) ? getLen(i, 50) : 0;

  // Builds one VesselMorphLayer instance for a nav-state category. `animate` selects
  // confirmed (static, last-known position) vs ghost (GPU dead-reckoned) motion — both
  // exist simultaneously, mirroring the old confirmed/ghost hull pair, so a moving
  // vessel's state marks keep tracking its predicted position once morphed into the
  // hull silhouette, not just at icon zoom.
  const makeMorphLayer = (
    id: string,
    data: number[],
    morphGeometry: MorphGeometry,
    animate: boolean,
    pickable: boolean,
  ) =>
    data.length > 0
      ? new VesselMorphLayer({
          id,
          data,
          getPosition:    getPos,
          getSog:         animate ? getSog : () => 0,
          getCog:         animate ? getCog : () => 0,
          getHeading:     getHdg,
          getRot:         animate ? getRot : () => 0,
          getAgeAtUpload: animate ? getAge : () => 0,
          getLength:      getLengthForMorph,
          getBeam:        (i: number) => getBeam(i, 10),
          getColor:       animate ? ghostVesselColor : vesselColor,
          uploadTimestamp,
          selfAnimate: animate,
          animationIntervalMs: animate ? 1000 / targetFps : 0,
          settingsIconSize,
          drCapSeconds: cogLengthMinutes * 60,
          morphGeometry,
          pickable,
        })
      : null;

  const confirmedMainLayer   = makeMorphLayer('ais-confirmed-main',   visIndices,             MORPH_ARROW,        false, true);
  const ghostMainLayer       = makeMorphLayer('ais-ghost-main',       ghostIndices,           MORPH_ARROW,        true,  true);
  const anchoredLayer        = makeMorphLayer('ais-anchored',         anchoredIndices,        MORPH_ANCHOR_DOT,   false, false);
  const anchoredGhostLayer   = makeMorphLayer('ais-anchored-ghost',   anchoredGhostIndices,   MORPH_ANCHOR_DOT,   true,  false);
  const mooredLayer          = makeMorphLayer('ais-moored',           mooredIndices,          MORPH_MOORING_BARS, false, false);
  const mooredGhostLayer     = makeMorphLayer('ais-moored-ghost',     mooredGhostIndices,     MORPH_MOORING_BARS, true,  false);
  const agroundLayer         = makeMorphLayer('ais-aground',          agroundIndices,         MORPH_AGROUND_RING, false, false);
  const agroundGhostLayer    = makeMorphLayer('ais-aground-ghost',    agroundGhostIndices,    MORPH_AGROUND_RING, true,  false);
  const fishingLayer         = makeMorphLayer('ais-fishing',          fishingIndices,         MORPH_FISHING_GEAR, false, false);
  const fishingGhostLayer    = makeMorphLayer('ais-fishing-ghost',    fishingGhostIndices,    MORPH_FISHING_GEAR, true,  false);
  const nucLayer             = makeMorphLayer('ais-nuc',              nucIndices,             MORPH_NUC,          false, false);
  const nucGhostLayer        = makeMorphLayer('ais-nuc-ghost',        nucGhostIndices,        MORPH_NUC,          true,  false);
  const restrictedLayer      = makeMorphLayer('ais-restricted',       restrictedIndices,      MORPH_RESTRICTED,   false, false);
  const restrictedGhostLayer = makeMorphLayer('ais-restricted-ghost', restrictedGhostIndices, MORPH_RESTRICTED,   true,  false);
  const draughtLayer         = makeMorphLayer('ais-draught',          draughtIndices,         MORPH_DRAUGHT,      false, false);
  const draughtGhostLayer    = makeMorphLayer('ais-draught-ghost',    draughtGhostIndices,    MORPH_DRAUGHT,      true,  false);

  // MOB / AIS-SART — nav state 14. Replaces the arrow with a red swimmer icon. No hull
  // counterpart exists (a person overboard / SART beacon has no AIS length/beam) — it
  // stays icon-only forever via the plain VesselIconLayer (getLength = 0 disables any
  // morph/cross-fade attempt). getHeading = 0 keeps the swimmer north-up (no meaningful
  // orientation for a beacon).
  const mobIconLayer = sarIndices.length > 0
    ? new VesselIconLayer({
        id: 'ais-mob-icon',
        data: sarIndices,
        getPosition:    getPos,
        getSog:         () => 0,
        getCog:         () => 0,
        getHeading:     () => 0,
        getRot:         () => 0,
        getAgeAtUpload: () => 0,
        getLength:      () => 0,
        getColor:       () => [255, 40, 40, 220] as [number, number, number, number],
        uploadTimestamp,
        selfAnimate: false,
        settingsIconSize,
        iconGeometry: MOB_GEOMETRY,
        pickable: true,
      })
    : null;

  // getDashArray is a PathStyleExtension prop; spread from variable to bypass excess-property check.
  const cogDashProps = { getDashArray: lineStyleDash(cogStyle, cogWidth) };

  return [
    // bottom: confirmed vessels at their last-known position, then their state marks
    ...(confirmedMainLayer  ? [confirmedMainLayer]  : []),
    ...(anchoredLayer       ? [anchoredLayer]       : []),
    ...(mooredLayer         ? [mooredLayer]         : []),
    ...(agroundLayer        ? [agroundLayer]        : []),
    ...(fishingLayer        ? [fishingLayer]        : []),
    ...(nucLayer            ? [nucLayer]            : []),
    ...(restrictedLayer     ? [restrictedLayer]     : []),
    ...(draughtLayer        ? [draughtLayer]        : []),
    // ghost (GPU dead-reckoned) vessels and their state marks, drawn above confirmed
    ...(ghostMainLayer      ? [ghostMainLayer]      : []),
    ...(anchoredGhostLayer  ? [anchoredGhostLayer]  : []),
    ...(mooredGhostLayer    ? [mooredGhostLayer]    : []),
    ...(agroundGhostLayer   ? [agroundGhostLayer]   : []),
    ...(fishingGhostLayer   ? [fishingGhostLayer]   : []),
    ...(nucGhostLayer       ? [nucGhostLayer]       : []),
    ...(restrictedGhostLayer ? [restrictedGhostLayer] : []),
    ...(draughtGhostLayer   ? [draughtGhostLayer]   : []),
    // COG arc prediction line
    new PathLayer<number>({
      id: 'ais-cog',
      data: cogIndices,
      getPath: (i: number) => {
        const lon  = hotData[i * S + AIS_F_LON]!;
        const lat  = hotData[i * S + AIS_F_LAT]!;
        const c    = hotData[i * S + AIS_F_COG]!;
        const s    = hotData[i * S + AIS_F_SOG]!;
        const r    = hotData[i * S + AIS_F_ROT]!;
        const totalSec = cogLengthMinutes * 60;
        const rotRad = isNaN(r) ? 0 : r;
        if (Math.abs(rotRad) < 1e-4) {
          const [endLon, endLat] = extrapolatePos(lon, lat, c, isNaN(s) ? 0 : s, 0, 0, totalSec * 1000);
          return [[lon, lat], [endLon, endLat]];
        }
        const N = 24;
        // Cap the drawn arc to one full circle (2π / |rotRad| = seconds per revolution).
        // All N segments are distributed evenly over that capped duration, so fast-turning
        // vessels use their full segment budget for a single loop rather than spiral beyond it.
        const fullCircleSec = (2 * Math.PI) / Math.abs(rotRad);
        const clampedSec = Math.min(totalSec, fullCircleSec);
        return Array.from({ length: N + 1 }, (_, k) => {
          const [pLon, pLat] = extrapolatePos(lon, lat, c, isNaN(s) ? 0 : s, rotRad, 0, clampedSec * k / N * 1000);
          return [pLon, pLat] as [number, number];
        });
      },
      getColor: () => hexToRgba(cogColor, 200),
      getWidth: cogWidth,
      ...cogDashProps,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: false,
      extensions: [new PathStyleExtension({ dash: true })],
      updateTriggers: {
        getPath:      [cogLengthMinutes],
        getColor:     [cogColor],
        getWidth:     [cogWidth],
        getDashArray: [cogStyle, cogWidth],
      },
    }),
    // Selected vessel highlight ring — drawn last so it sits on top of all vessel layers.
    // Positioned at the last-known (confirmed) position; ~70% of vessel length radius,
    // min 16 px so it remains visible at all zoom levels.
    ...(selectedIndex !== null ? [new ScatterplotLayer<number>({
      id: 'ais-highlight-ring',
      data: [selectedIndex],
      getPosition: getPos,
      getRadius:   (i: number) => Math.max(getLen(i, 80) * 0.7, 50),
      getLineColor: [255, 200, 50, 220] as [number, number, number, number],
      getFillColor: [0, 0, 0, 0] as [number, number, number, number],
      stroked: true,
      filled:  true,
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      radiusUnits: 'meters',
      radiusMinPixels: 16,
      pickable: false,
    })] : []),
    // MOB/SART — rendered last (always on top) with its own icon replacing the arrow
    ...(mobIconLayer ? [mobIconLayer] : []),
  ];
}
