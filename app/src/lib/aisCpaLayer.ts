/**
 * Deck.gl layers for CPA (Closest Point of Approach) visualization.
 *
 * Renders two sets of projected ghost positions (Rust CPA with RoT; SK server CPA
 * when available), dashed projection lines from current to ghost positions, and a
 * thin connecting line between ghost positions at TCPA.
 *
 * Callers supply pre-computed ghost positions. The opening case (tcpa_min < 0) skips
 * ghost rendering entirely; the capped case (tcpa_min ≥ 120) renders at the 2 h mark.
 */

import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import type { CpaResult } from './wasmGeo';
import { extrapolatePos } from './deadReckoning';

// ── colours ──────────────────────────────────────────────────────────────────
const RUST_COLOR:      [number, number, number, number] = [255, 200,  50, 220]; // amber
const SK_COLOR:        [number, number, number, number] = [ 80, 200, 255, 200]; // cyan
const CPA_LINE_COLOR:  [number, number, number, number] = [255, 255, 255, 120]; // dim white
const GHOST_FILL:      [number, number, number, number] = [  0,   0,   0,   0]; // transparent

/** Dash pattern: [dash_px, gap_px] */
const PROJ_DASH: [number, number] = [8, 5];
const CPA_DASH:  [number, number] = [4, 4];

export interface SkCpaInput {
  /** Raw server-reported CPA distance in metres. */
  distanceM: number;
  /** Raw server-reported time-to-CPA in seconds. */
  timeToS:   number;
}

/**
 * Build deck.gl layers that visualize CPA for a selected AIS vessel.
 *
 * @param ownLon       Own vessel current longitude
 * @param ownLat       Own vessel current latitude
 * @param ownCog       Own vessel COG (radians), or NaN
 * @param ownSog       Own vessel SOG (m/s), or NaN
 * @param tgtLon       Target current longitude
 * @param tgtLat       Target current latitude
 * @param tgtCog       Target COG (radians), or NaN
 * @param tgtSog       Target SOG (m/s), or NaN
 * @param tgtRot       Target RoT (rad/s), or NaN / 0
 * @param rustCpa      CPA result from WASM (RoT-aware)
 * @param skCpa        Optional SK server CPA (linear model, if plugin is running)
 */
export function buildCpaLayers(
  ownLon: number, ownLat: number, ownCog: number, ownSog: number,
  tgtLon: number, tgtLat: number, tgtCog: number, tgtSog: number, tgtRot: number,
  rustCpa: CpaResult,
  skCpa?: SkCpaInput | null,
): Layer[] {
  const layers: Layer[] = [];

  // ── Rust CPA ghost (RoT-aware) ────────────────────────────────────────────
  if (!rustCpa.isOpening) {
    layers.push(...ghostLayers(
      'rust',
      ownLon, ownLat, tgtLon, tgtLat,
      rustCpa.own_lon, rustCpa.own_lat,
      rustCpa.tgt_lon, rustCpa.tgt_lat,
      RUST_COLOR,
    ));
  }

  // ── SK server CPA ghost (linear model) ───────────────────────────────────
  if (skCpa && skCpa.timeToS > 0) {
    const tcpa_s = Math.min(skCpa.timeToS, 7200);
    // Linear projection for both vessels (SK plugins use straight-line model).
    const [skOwnLon, skOwnLat] = (isNaN(ownCog) || isNaN(ownSog))
      ? [ownLon, ownLat]
      : extrapolatePos(ownLon, ownLat, ownCog, ownSog, 0, 0, tcpa_s * 1000);
    const [skTgtLon, skTgtLat] = (isNaN(tgtCog) || isNaN(tgtSog))
      ? [tgtLon, tgtLat]
      : extrapolatePos(tgtLon, tgtLat, tgtCog, tgtSog, isNaN(tgtRot) ? 0 : 0 /* linear */, 0, tcpa_s * 1000);

    layers.push(...ghostLayers(
      'sk',
      ownLon, ownLat, tgtLon, tgtLat,
      skOwnLon, skOwnLat,
      skTgtLon, skTgtLat,
      SK_COLOR,
    ));
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Build the 3-layer set for one CPA ghost (projection lines + ghost dots + CPA line). */
function ghostLayers(
  idPrefix: string,
  ownLon: number, ownLat: number,
  tgtLon: number, tgtLat: number,
  ownGhostLon: number, ownGhostLat: number,
  tgtGhostLon: number, tgtGhostLat: number,
  color: [number, number, number, number],
): Layer[] {
  type Coord = [number, number];

  const ownCurrent: Coord  = [ownLon, ownLat];
  const tgtCurrent: Coord  = [tgtLon, tgtLat];
  const ownGhost: Coord    = [ownGhostLon, ownGhostLat];
  const tgtGhost: Coord    = [tgtGhostLon, tgtGhostLat];

  const projPaths: Coord[][] = [
    [ownCurrent, ownGhost],
    [tgtCurrent, tgtGhost],
  ];

  const cpaLinePaths: Coord[][] = [[ownGhost, tgtGhost]];

  const ghostDots: Coord[] = [ownGhost, tgtGhost];

  // Ghost dot radius: ~120 m, visible at all useful chart scales
  const GHOST_RADIUS_M = 120;

  // getDashArray is a PathStyleExtension accessor — spread from a variable to bypass
  // TypeScript's excess-property check (same pattern as aisLayerBuilder.ts).
  const projDashProps  = { getDashArray: () => PROJ_DASH };
  const cpaDashProps   = { getDashArray: () => CPA_DASH };

  return [
    // Dashed projection lines: current → ghost
    new PathLayer<Coord[]>({
      id: `cpa-proj-${idPrefix}`,
      data: projPaths,
      getPath: (d) => d,
      getColor: color,
      getWidth: 2,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      ...projDashProps,
      pickable: false,
      extensions: [new PathStyleExtension({ dash: true })],
    }),
    // Thin dotted CPA distance line connecting ghost positions
    new PathLayer<Coord[]>({
      id: `cpa-line-${idPrefix}`,
      data: cpaLinePaths,
      getPath: (d) => d,
      getColor: CPA_LINE_COLOR,
      getWidth: 1,
      widthUnits: 'pixels',
      ...cpaDashProps,
      pickable: false,
      extensions: [new PathStyleExtension({ dash: true })],
    }),
    // Ghost position dots (outlined, not filled)
    new ScatterplotLayer<Coord>({
      id: `cpa-ghost-${idPrefix}`,
      data: ghostDots,
      getPosition: (d) => [d[0], d[1], 0],
      getRadius: GHOST_RADIUS_M,
      getLineColor: color,
      getFillColor: GHOST_FILL,
      stroked: true,
      filled: true,
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      radiusUnits: 'meters',
      pickable: false,
    }),
  ];
}

/**
 * Format the CPA mini-label text shown near the selected vessel.
 *
 * @param rustCpa  Rust-computed CPA result
 * @param skCpa    Optional SK server CPA (for secondary display)
 * @returns        HTML string for the mini-label popup
 */
export function formatCpaLabel(rustCpa: CpaResult, skCpa?: SkCpaInput | null): string {
  const nm = rustCpa.cpa_nm.toFixed(2);

  if (rustCpa.isOpening) {
    return `<span class="cpa-opening">↗ ${nm} nm</span>`;
  }

  const min = rustCpa.tcpa_min;
  const timeStr = rustCpa.isCapped
    ? '&gt;2h'
    : min < 60
      ? `${min.toFixed(0)}min`
      : `${(min / 60).toFixed(1)}h`;

  let html = `<span class="cpa-value">CPA ${nm}nm / ${timeStr}</span>`;

  if (skCpa && skCpa.timeToS > 0) {
    const skNm = (skCpa.distanceM / 1852).toFixed(2);
    const skMin = skCpa.timeToS / 60;
    const skTimeStr = skMin >= 120 ? '&gt;2h' : skMin < 60 ? `${skMin.toFixed(0)}min` : `${(skMin / 60).toFixed(1)}h`;
    html += `<br><span class="cpa-sk">SK: ${skNm}nm / ${skTimeStr}</span>`;
  }

  return html;
}
