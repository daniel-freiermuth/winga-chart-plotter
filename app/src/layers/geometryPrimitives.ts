/**
 * Local-space triangle-list primitives shared by the custom vessel layers
 * (VesselIconLayer, VesselMorphLayer). Every builder emits flat xyz triples
 * normalized to CCW winding — see triangleWinding.ts.
 */

import { ccwTriangleList } from './triangleWinding';

export function circleVerts(cx: number, cy: number, r: number, sides: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * 2 * Math.PI;
    const a1 = ((i + 1) / sides) * 2 * Math.PI;
    v.push(cx, cy, 0,
           cx + r * Math.sin(a0), cy + r * Math.cos(a0), 0,
           cx + r * Math.sin(a1), cy + r * Math.cos(a1), 0);
  }
  return ccwTriangleList(v);
}

export function rectVerts(x0: number, y0: number, x1: number, y1: number): number[] {
  return ccwTriangleList([x0, y0, 0,  x1, y0, 0,  x1, y1, 0,
                          x0, y0, 0,  x1, y1, 0,  x0, y1, 0]);
}

export function lineSeg(x0: number, y0: number, x1: number, y1: number, halfWidth: number): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = (-dy / len) * halfWidth;
  const ny = ( dx / len) * halfWidth;
  return ccwTriangleList([
    x0 + nx, y0 + ny, 0,
    x0 - nx, y0 - ny, 0,
    x1 - nx, y1 - ny, 0,
    x0 + nx, y0 + ny, 0,
    x1 - nx, y1 - ny, 0,
    x1 + nx, y1 + ny, 0,
  ]);
}

/**
 * Local-unit growth applied to CPU-grown outline rings around off-origin
 * indicator/decoration shapes. Each grow* helper preserves vertex count and
 * order, only moving coordinates, so the grown ring pairs 1:1 with its fill.
 */
export const RING_MARGIN = 0.05;

export function growRect(x0: number, y0: number, x1: number, y1: number, m = RING_MARGIN): number[] {
  return rectVerts(x0 - m, y0 - m, x1 + m, y1 + m);
}
export function growCircle(cx: number, cy: number, r: number, sides: number, m = RING_MARGIN): number[] {
  return circleVerts(cx, cy, r + m, sides);
}
export function growLineSeg(x0: number, y0: number, x1: number, y1: number, halfWidth: number, m = RING_MARGIN): number[] {
  return lineSeg(x0, y0, x1, y1, halfWidth + m);
}
