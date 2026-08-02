import { describe, expect, it } from 'vitest';
import {
  MORPH_ARROW, MORPH_ANCHOR_DOT, MORPH_AGROUND_RING, MORPH_MOORING_BARS,
  MORPH_FISHING_GEAR, MORPH_NUC, MORPH_RESTRICTED, MORPH_DRAUGHT,
  type MorphGeometry,
} from './VesselMorphLayer';
import { MOB_GEOMETRY } from './VesselIconLayer';

/**
 * Winding contract: every non-degenerate triangle in every vessel geometry is
 * counter-clockwise, at BOTH morph ends and at every intermediate blend.
 *
 * deck.gl ≥9.3.3 enables backface culling for the whole globe view
 * (GLOBE_VIEW_DEFAULT_PARAMETERS = { cullMode: 'back' }) so the GPU can drop
 * far-hemisphere geometry. A clockwise triangle is a backface on the NEAR side
 * — it renders fine under mercator (no culling) and silently disappears under
 * globe projection. That failure mode is invisible in code review and in
 * mercator-only testing, so it is pinned here instead.
 *
 * The blend sweep matters because the vertex shader linearly mixes icon-space
 * and hull-space vertex positions: two CCW endpoint shapes can still invert
 * mid-morph if their vertex correspondence is bad.
 */

const MORPHS: Record<string, MorphGeometry> = {
  MORPH_ARROW, MORPH_ANCHOR_DOT, MORPH_AGROUND_RING, MORPH_MOORING_BARS,
  MORPH_FISHING_GEAR, MORPH_NUC, MORPH_RESTRICTED, MORPH_DRAUGHT,
};

// Icon size needs no sweep: a uniform icon scale only reparametrizes the
// blend pencil λ·icon + μ·hull (λ, μ ≥ 0), and the signed area is homogeneous
// in (λ, μ), so its sign along the pencil is icon-scale-invariant. Heading
// rotation, dead-reckoning translation and the globe 180° offset flip are
// winding-invariant too. The hull's length/beam ASPECT however reshapes the
// blend quadratic, so the invariant is checked across dimension extremes:
// the safelen/safebeam = 1 clamp floor, a dinghy, a coaster, a supertanker,
// and a square aspect.
const ICON_HALF = 32; // px — project_pixel_size(iconSize·64)/2
const HULL_SCALES: readonly (readonly [number, number])[] = [
  [1, 1], [8, 3], [30, 8], [400, 60], [15, 15],
];
const EPS_T = 1e-9; // stationary point strictly inside (0, 1)
const EPS = 1e-6; // intentionally-degenerate padding triangles are exactly zero-area

/** Twice the signed area of triangle (a, b, c); positive = CCW. */
function cross2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

interface Violation { tri: number; t: number; area2: number }

/**
 * The blended signed area A(t) is QUADRATIC in t (each vertex is linear in t
 * and the cross product is bilinear), so checking both endpoints plus the
 * quadratic's stationary point — when it falls inside (0, 1) — covers the
 * entire morph interval exactly. No sampling gaps.
 */
function morphViolations(g: MorphGeometry, len: number, beam: number): Violation[] {
  const bad: Violation[] = [];
  const triCount = g.vertexCount / 3;
  for (let tri = 0; tri < triCount; tri++) {
    const x = [0, 0, 0], y = [0, 0, 0], hx = [0, 0, 0], hy = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = tri * 3 + k;
      x[k] = g.iconPositions[v * 3]! * ICON_HALF;
      y[k] = g.iconPositions[v * 3 + 1]! * ICON_HALF;
      hx[k] = g.hullPositions[v * 3]! * beam / 2 + g.hullOffset[v * 3]! * beam / 2;
      hy[k] = g.hullPositions[v * 3 + 1]! * len / 2 + g.hullOffset[v * 3 + 1]! * beam / 2;
    }
    const areaAt = (t: number): number => {
      const bx = [0, 1, 2].map(k => x[k]! * (1 - t) + hx[k]! * t);
      const by = [0, 1, 2].map(k => y[k]! * (1 - t) + hy[k]! * t);
      return cross2(bx[0]!, by[0]!, bx[1]!, by[1]!, bx[2]!, by[2]!);
    };
    // Fit A(t) = a·t² + b·t + c exactly through t = 0, ½, 1.
    const a0 = areaAt(0), ah = areaAt(0.5), a1 = areaAt(1);
    const c = a0;
    const a = 2 * a0 - 4 * ah + 2 * a1;
    const b = a1 - c - a;
    if (a0 < -EPS) bad.push({ tri, t: 0, area2: a0 });
    if (a1 < -EPS) bad.push({ tri, t: 1, area2: a1 });
    if (Math.abs(a) > EPS_T) {
      const ts = -b / (2 * a);
      if (ts > 0 && ts < 1) {
        const as = c + ts * (b + ts * a);
        if (as < -EPS) bad.push({ tri, t: ts, area2: as });
      }
    }
  }
  return bad;
}

describe('vessel geometry winding', () => {
  for (const [name, geo] of Object.entries(MORPHS)) {
    for (const [len, beam] of HULL_SCALES) {
      it(`${name}: every triangle is CCW across the whole morph (len ${String(len)} × beam ${String(beam)})`, () => {
        expect(morphViolations(geo, len, beam)).toEqual([]);
      });
    }
  }

  it('MOB_GEOMETRY: every triangle is CCW', () => {
    const bad: Violation[] = [];
    const p = MOB_GEOMETRY.positions;
    for (let tri = 0; tri < MOB_GEOMETRY.vertexCount / 3; tri++) {
      const v = tri * 9;
      const area2 = cross2(p[v]!, p[v + 1]!, p[v + 3]!, p[v + 4]!, p[v + 6]!, p[v + 7]!);
      if (area2 < -EPS) bad.push({ tri, t: 0, area2 });
    }
    expect(bad).toEqual([]);
  });
});
