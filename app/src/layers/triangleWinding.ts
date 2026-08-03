/**
 * Triangle-winding normalization for the custom vessel layers.
 *
 * deck.gl ≥9.3.3 enables backface culling for the whole globe view
 * (GLOBE_VIEW_DEFAULT_PARAMETERS = { cullMode: 'back' }) so the GPU drops
 * far-hemisphere geometry. That makes winding part of the rendering contract:
 * a clockwise triangle is a backface on the NEAR side — it renders fine under
 * mercator (which has no view-level culling) and silently vanishes under
 * globe projection. Every geometry builder therefore normalizes its output
 * through ccwTriangleList; geometryWinding.test.ts pins the invariant across
 * all exported geometries, including intermediate morph blends.
 */

/**
 * Normalize a flat triangle list (xyz triples) to counter-clockwise winding
 * in the layers' local space (x starboard, y toward bow): triangles with
 * negative signed area get their 2nd and 3rd vertices swapped in place.
 * Degenerate (zero-area) triangles are left untouched.
 */
export function ccwTriangleList(verts: number[]): number[] {
  for (let t = 0; t + 9 <= verts.length; t += 9) {
    const ax = verts[t]!, ay = verts[t + 1]!;
    const area2 = (verts[t + 3]! - ax) * (verts[t + 7]! - ay)
                - (verts[t + 6]! - ax) * (verts[t + 4]! - ay);
    if (area2 < 0) {
      for (let k = 0; k < 3; k++) {
        const b = verts[t + 3 + k]!;
        verts[t + 3 + k] = verts[t + 6 + k]!;
        verts[t + 6 + k] = b;
      }
    }
  }
  return verts;
}
