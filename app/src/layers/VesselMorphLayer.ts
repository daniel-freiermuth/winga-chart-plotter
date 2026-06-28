/**
 * VesselMorphLayer — custom deck.gl Layer that continuously morphs an AIS vessel between
 * its fixed-pixel "icon" silhouette (zoomed out) and its real-world-metre "hull" polygon
 * (zoomed in), replacing the old VesselIconLayer + AisHullLayer + AisHullDecorationLayer +
 * AisHullBorderLayer alpha-crossfade with a single GPU vertex morph.
 *
 * Why a vertex morph instead of a crossfade:
 *   The old design rendered TWO independent shapes — a fixed-pixel arrow (or overlay mark)
 *   and a real-world-metre hull polygon (or hull-space decoration/border) — simultaneously,
 *   alpha-blended against each other across a zoom band. Around the midpoint you'd see both
 *   silhouettes overlapping, which reads as a jump/double-vision rather than a single vessel
 *   smoothly growing into its true shape. It was also wasteful: AisHullLayer (and its
 *   decoration/border siblings) ran a full vertex+fragment shader pass for every hull-having
 *   vessel even fully zoomed out, just to render at alpha≈0 — `hullIndices` is gated only on
 *   `hasHull`, never on zoom (see Map.svelte).
 *
 * The fix: every vertex of the static mesh carries BOTH an icon-local coordinate and a
 * hull-local coordinate. The vertex shader computes each side's contribution exactly as the
 * old per-layer shaders did (icon: fixed-pixel scale via project_pixel_size, zoom-independent;
 * hull: real-metre scale via length/beam then project_size, zoom-proportional), then linearly
 * interpolates the two FINAL common-space offsets by a single morph factor `t` (0 = icon,
 * 1 = hull) driven by the same transitionZoom formula the old shaders already used for alpha.
 * Mixing is done AFTER each side's own projection into common space, not on raw local
 * coordinates — the two sides use different units (pixels vs metres) and different
 * zoom-dependence, so only the post-projection common-space vectors are valid to lerp.
 *
 * Vertex topology correspondence:
 *   The icon's arrow silhouette is a 6-point hexagon (bow, sb-shoulder, sb-aft, stern-notch,
 *   port-aft, port-shoulder) fan-triangulated from the bow. The old hull polygon was a
 *   5-point pentagon (no stern notch — a flat stern edge) fan-triangulated the same way.
 *   To morph vertex-for-vertex, the hull silhouette here is PADDED with one colinear
 *   stern-mid vertex on that flat edge — this changes nothing about the hull's rendered
 *   shape (a straight edge with a redundant point on it is still straight) but gives it the
 *   same 6-point/4-triangle topology as the icon. The icon's stern-NOTCH vertex then
 *   corresponds 1:1 to the hull's stern-MID vertex: as t goes 0→1 the notch smoothly
 *   relaxes into the hull's true flat stern, instead of jumping.
 *
 * Outline/border unification:
 *   The icon's old "white ring" trick (draw a uniformly-larger copy of the same shape behind
 *   it) only produces a uniform-width border when the shape is centred on the scale origin —
 *   true for the compact arrow, false for anything off-centre. The hull's border was instead
 *   a genuinely separate stroke mesh (AisHullBorderLayer/HULL_BORDER_OUTLINE) tracing the
 *   pentagon's edges. Here both ends use ONE construction — `strokeBoundary()` over the same
 *   6 boundary points used for the fill, edge-stroked with a small fixed half-width — so the
 *   "outline pass" geometry morphs exactly like the fill pass, just with a different (still
 *   matching-topology) vertex set, and AisHullBorderLayer is no longer needed.
 *
 * Day-shape decorations (anchor dot, NUC, restricted) vs structural marks (mooring bars,
 * draught bars, fishing gear, aground ring):
 *   Compact point-symbols are anchored at their own centre; the icon side keeps its existing
 *   CPU-grown outline ring (RING_MARGIN), the hull side never had a ring (decorations always
 *   rendered solid black) — so its outline-pass hull coordinates are simply IDENTICAL to its
 *   fill-pass hull coordinates. Because mixing commutes with subtraction, the ring's on-screen
 *   width becomes `iconRingDelta * (1 - t)`: fully visible at t=0, shrinking smoothly to zero
 *   exactly at t=1 — matching today's "icon shows a ring, hull does not" look, with no special
 *   casing required. Structural marks (mooring/draught bars, fishing gear, aground ring) keep
 *   their full anisotropic (beam-X, length-Y) hull scaling — they're meant to track the hull's
 *   own elongated footprint, not stay an undistorted day-shape (aground ring is explicitly
 *   that way by design; fishing gear's reach toward the stern depends on it, see prior fix).
 */

import { Layer, project32, picking } from '@deck.gl/core';
import type { LayerProps, UpdateParameters, DefaultProps, Accessor } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';

// ---------------------------------------------------------------------------
// Shader uniform module
// ---------------------------------------------------------------------------

const uniformBlock = /* glsl */`\
uniform morphUniforms {
  float timeSinceUpload;
  float drCapSeconds;
  float zoom;
  float settingsIconSize;
  float opacity;
} morph;
`;

const vesselMorphUniformModule = {
  name: 'morph',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    timeSinceUpload: 'f32',
    drCapSeconds: 'f32',
    zoom: 'f32',
    settingsIconSize: 'f32',
    opacity: 'f32',
  } as const,
};

// ---------------------------------------------------------------------------
// Vertex shader
// ---------------------------------------------------------------------------

const vs = /* glsl */`\
#version 300 es
#define SHADER_NAME vessel-morph-layer-vertex-shader

// Per-vertex: this vertex's coordinate at each end of the morph.
in vec3 iconPositions;  // icon-local space (pixel-fixed, bow=+Y, starboard=+X, range~[-1,1])
in vec3 hullPositions;  // hull-local space anchor (anisotropic: X scaled by beam/2, Y by length/2)
in vec3 hullOffset;     // hull-local space offset from hullPositions — isotropic (beam-scaled on
                         // BOTH axes), zero for structural marks that should stay anisotropic
in float aIsOutline;    // 1.0 = outline/border pass, 0.0 = fill pass
in float aIsIndicator;  // 1.0 = decoration vertex that renders solid black in the fill pass

// Per-instance vessel data
in vec3 instancePositions;
in vec3 instancePositions64Low;
in float instanceSog;        // m/s
in float instanceCog;        // radians, north = 0, CW positive
in float instanceHeading;    // radians
in float instanceRot;        // rad/s
in float instanceAgeAtUpload;// seconds already elapsed when data was uploaded
in float instanceLength;     // metres; 0 = unknown → never morphs into a hull, icon-only
in float instanceBeam;       // metres
in vec4 instanceColor;       // base RGBA [0..1]; alpha encodes ghost/confirmed opacity
in vec3 instancePickingColors;

out vec4 vColor;

void main(void) {
  // ------------------------------------------------------------------
  // 1. Dead-reckoning time delta
  // ------------------------------------------------------------------
  float dt = min(instanceAgeAtUpload + morph.timeSinceUpload, morph.drCapSeconds);

  // ------------------------------------------------------------------
  // 2. Dead-reckoned ENU offset from stored position (metres)
  //    Arc integral when ROT ≠ 0; straight line otherwise.
  // ------------------------------------------------------------------
  float dEast, dNorth;
  if (abs(instanceRot) > 1e-4) {
    float cogEnd = instanceCog + instanceRot * dt;
    float R = instanceSog / instanceRot;
    dEast  = R * (cos(instanceCog) - cos(cogEnd));
    dNorth = R * (sin(cogEnd)      - sin(instanceCog));
  } else {
    dEast  = instanceSog * dt * sin(instanceCog);
    dNorth = instanceSog * dt * cos(instanceCog);
  }

  float heading = instanceHeading + instanceRot * dt;
  float sinH = sin(heading);
  float cosH = cos(heading);

  // Must be set before any project_size()/project_pixel_size() call — the Mercator
  // latitude correction these apply reads the vessel's actual latitude from here.
  geometry.worldPosition = instancePositions;

  // ------------------------------------------------------------------
  // 3a. Icon-side offset: fixed pixel scale (1 unit = 64px), zoom-independent.
  //     Exactly mirrors the old VesselIconLayer vertex shader.
  // ------------------------------------------------------------------
  float iconHalfCommon = project_pixel_size(morph.settingsIconSize * 64.0) * 0.5;
  float iconLocalX = iconPositions.x * iconHalfCommon;
  float iconLocalY = iconPositions.y * iconHalfCommon;
  vec3 drCommonIcon = project_size(vec3(dEast, dNorth, 0.0));
  vec3 iconTotal = drCommonIcon + vec3(
    iconLocalY * sinH + iconLocalX * cosH,
    iconLocalY * cosH - iconLocalX * sinH,
    0.0
  );
  // In globe mode, project_position_to_clipspace applies orientation matrix
  // mat3(-East, -North, up), inverting both ENU axes. The hull side's offset goes through
  // project_size as a single combined vector and needs no correction (see 3b); the icon
  // side computes its rotated offset directly in ENU-aligned space, so it DOES need the
  // negation here to land correctly after that same orientation matrix.
  if (project.projectionMode == PROJECTION_MODE_GLOBE) {
    iconTotal = -iconTotal;
  }

  // ------------------------------------------------------------------
  // 3b. Hull-side offset: real-world metres, zoom-proportional.
  //     Anchor uses anisotropic hull scaling (X by beam/2, Y by length/2) so each mark
  //     tracks the right bow/stern, port/starboard position; offset uses isotropic
  //     beam-only scaling so day-shape marks stay undistorted circles/diamonds instead of
  //     being stretched into ellipses by the hull's length/beam aspect ratio.
  //     Exactly mirrors the old AisHullLayer/AisHullDecorationLayer vertex shaders.
  // ------------------------------------------------------------------
  float safelen  = max(instanceLength, 1.0);
  float safebeam = max(instanceBeam,  1.0);
  float hullLocalX = hullPositions.x * safebeam * 0.5 + hullOffset.x * safebeam * 0.5;
  float hullLocalY = hullPositions.y * safelen  * 0.5 + hullOffset.y * safebeam * 0.5;
  float hullEast  = hullLocalY * sinH + hullLocalX * cosH;
  float hullNorth = hullLocalY * cosH - hullLocalX * sinH;
  vec3 hullTotal = project_size(vec3(dEast + hullEast, dNorth + hullNorth, 0.0));

  // ------------------------------------------------------------------
  // 4. Morph factor: 0 = pure icon, 1 = pure hull. Forced to 0 (icon-only, forever) when
  //    length is unknown — there is no hull polygon to morph into. Same transitionZoom
  //    formula the old icon/hull shaders used independently for their alpha crossfade;
  //    here it drives a single continuous SHAPE interpolation instead.
  // ------------------------------------------------------------------
  float lat_rad = instancePositions.y * radians(1.0);
  float transitionZoom = log2(
    morph.settingsIconSize * 64.0 * 40075016.686 * cos(lat_rad) / (safelen * 256.0)
  );
  float t = instanceLength > 0.0
    ? clamp((morph.zoom - transitionZoom + 1.0) / 2.0, 0.0, 1.0)
    : 0.0;

  vec3 totalOffset = mix(iconTotal, hullTotal, t);

  // ------------------------------------------------------------------
  // 5. Project anchor + offset to clip space
  // ------------------------------------------------------------------
  vec4 worldPos;
  gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, totalOffset, worldPos);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  // ------------------------------------------------------------------
  // 5b. Far-hemisphere discard (globe mode) — see the old AisHullLayer for the full
  //      explanation of why this is needed to prevent mirrored ghosts through the globe.
  // ------------------------------------------------------------------
  if (project.projectionMode == PROJECTION_MODE_GLOBE &&
      dot(worldPos.xyz, project.cameraPosition) < 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  }

  // ------------------------------------------------------------------
  // 6. Color — identical formula regardless of t, so there is no alpha crossfade left:
  //    outline pass → halfway between vessel color and white (dark vessels) or black
  //    (bright vessels); fill pass → black for decoration marks, vessel color otherwise.
  // ------------------------------------------------------------------
  float luma = dot(instanceColor.rgb, vec3(0.299, 0.587, 0.114));
  vec3 outlineTarget = luma < 0.5 ? vec3(1.0) : vec3(0.0);
  vec3 outlineColor  = mix(instanceColor.rgb, outlineTarget, 0.5);
  vec3 rgb = aIsOutline > 0.5 ? outlineColor : (aIsIndicator > 0.5 ? vec3(0.0) : instanceColor.rgb);
  vColor = vec4(rgb, instanceColor.a * morph.opacity);

  geometry.pickingColor = instancePickingColors;
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

// ---------------------------------------------------------------------------
// Fragment shader
// ---------------------------------------------------------------------------

const fs = /* glsl */`\
#version 300 es
precision highp float;
#define SHADER_NAME vessel-morph-layer-fragment-shader

in vec4 vColor;
out vec4 fragColor;

void main(void) {
  fragColor = vColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

// ---------------------------------------------------------------------------
// Primitive helpers — pure local-space coordinate math, shared by both the icon-end and
// hull-end of every geometry pair below (only the magnitudes passed in differ by end).
// ---------------------------------------------------------------------------

function circleVerts(cx: number, cy: number, r: number, sides: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * 2 * Math.PI;
    const a1 = ((i + 1) / sides) * 2 * Math.PI;
    v.push(cx, cy, 0,
           cx + r * Math.sin(a0), cy + r * Math.cos(a0), 0,
           cx + r * Math.sin(a1), cy + r * Math.cos(a1), 0);
  }
  return v;
}

function rectVerts(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, 0,  x1, y0, 0,  x1, y1, 0,
          x0, y0, 0,  x1, y1, 0,  x0, y1, 0];
}

function lineSeg(x0: number, y0: number, x1: number, y1: number, halfWidth: number): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = (-dy / len) * halfWidth;
  const ny = ( dx / len) * halfWidth;
  return [
    x0 + nx, y0 + ny, 0,
    x0 - nx, y0 - ny, 0,
    x1 - nx, y1 - ny, 0,
    x0 + nx, y0 + ny, 0,
    x1 - nx, y1 - ny, 0,
    x1 + nx, y1 + ny, 0,
  ];
}

function diamondVerts(cx: number, cy: number, w: number, h: number): number[] {
  return [
    cx, cy, 0,  cx,   cy+h, 0,  cx+w, cy,   0,
    cx, cy, 0,  cx+w, cy,   0,  cx,   cy-h, 0,
    cx, cy, 0,  cx,   cy-h, 0,  cx-w, cy,   0,
    cx, cy, 0,  cx-w, cy,   0,  cx,   cy+h, 0,
  ];
}

function arcVerts(
  cx: number, cy: number,
  inner: number, outer: number,
  a_start_deg: number, a_end_deg: number,
  steps: number,
): number[] {
  const v: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a0 = (a_start_deg + (a_end_deg - a_start_deg) * (i       / steps)) * Math.PI / 180;
    const a1 = (a_start_deg + (a_end_deg - a_start_deg) * ((i + 1) / steps)) * Math.PI / 180;
    const s0 = Math.sin(a0), c0 = Math.cos(a0);
    const s1 = Math.sin(a1), c1 = Math.cos(a1);
    v.push(
      cx + inner * s0, cy + inner * c0, 0,
      cx + outer * s0, cy + outer * c0, 0,
      cx + outer * s1, cy + outer * c1, 0,
      cx + inner * s0, cy + inner * c0, 0,
      cx + outer * s1, cy + outer * c1, 0,
      cx + inner * s1, cy + inner * c1, 0,
    );
  }
  return v;
}

/** Fan-triangulate a closed N-point polygon from its first point — (N-2) triangles. */
function fanTriangulate(points: [number, number][]): number[] {
  const v: number[] = [];
  const [bx, by] = points[0]!;
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = points[i]!;
    const [cx, cy] = points[i + 1]!;
    v.push(bx, by, 0, ax, ay, 0, cx, cy, 0);
  }
  return v;
}

/** Stroke every edge of a closed N-point polygon with a fixed half-width — N*6 verts. */
function strokeBoundary(points: [number, number][], halfWidth: number): number[] {
  const v: number[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % n]!;
    v.push(...lineSeg(x0, y0, x1, y1, halfWidth));
  }
  return v;
}

// ---------------------------------------------------------------------------
// Hull-side anchor/offset split — see the file header for why decorations need this and
// structural marks don't.
// ---------------------------------------------------------------------------

interface AnchoredVerts {
  anchors: number[];
  offsets: number[];
}

/** Split a flat vertex array (built around (cx, cy)) into anchor + isotropic offset. */
function anchoredAt(cx: number, cy: number, verts: number[]): AnchoredVerts {
  const n = verts.length / 3;
  const anchors = new Array<number>(n * 3);
  const offsets = new Array<number>(n * 3);
  for (let i = 0; i < n; i++) {
    anchors[i * 3] = cx; anchors[i * 3 + 1] = cy; anchors[i * 3 + 2] = 0;
    offsets[i * 3]     = verts[i * 3]!     - cx;
    offsets[i * 3 + 1] = verts[i * 3 + 1]! - cy;
    offsets[i * 3 + 2] = 0;
  }
  return { anchors, offsets };
}

/** Concatenate several independently-anchored mark parts into one AnchoredVerts. */
function concatAnchored(...parts: AnchoredVerts[]): AnchoredVerts {
  return {
    anchors: parts.flatMap(p => p.anchors),
    offsets: parts.flatMap(p => p.offsets),
  };
}

/** Plain/structural vertex array: anchor IS the vertex, offset is zero — the mark keeps
 *  full anisotropic hull scaling (mooring bars, draught bars, fishing gear, aground ring,
 *  and the main hull silhouette itself). */
function unanchored(verts: number[]): AnchoredVerts {
  return { anchors: verts, offsets: new Array<number>(verts.length).fill(0) };
}

/** CPU-grown outline margin for icon-side decoration rings (matches the old RING_MARGIN). */
const RING_MARGIN = 0.05;
function growCircle(cx: number, cy: number, r: number, sides: number, m = RING_MARGIN): number[] {
  return circleVerts(cx, cy, r + m, sides);
}
function growRect(x0: number, y0: number, x1: number, y1: number, m = RING_MARGIN): number[] {
  return rectVerts(x0 - m, y0 - m, x1 + m, y1 + m);
}
function growDiamond(cx: number, cy: number, w: number, h: number, m = RING_MARGIN): number[] {
  return diamondVerts(cx, cy, w + m, h + m);
}
function growLineSeg(x0: number, y0: number, x1: number, y1: number, halfWidth: number, m = RING_MARGIN): number[] {
  return lineSeg(x0, y0, x1, y1, halfWidth + m);
}
function growArc(
  cx: number, cy: number, inner: number, outer: number,
  a_start_deg: number, a_end_deg: number, steps: number, m = RING_MARGIN,
): number[] {
  return arcVerts(cx, cy, inner - m, outer + m, a_start_deg, a_end_deg, steps);
}

// ---------------------------------------------------------------------------
// MorphGeometry — the combined per-vertex buffer consumed by the Model.
// ---------------------------------------------------------------------------

export interface MorphGeometry {
  iconPositions: Float32Array;
  hullPositions: Float32Array;
  hullOffset:    Float32Array;
  isOutline:     Float32Array;
  isIndicator:   Float32Array;
  vertexCount:   number;
}

interface MorphSlice {
  /** Flat icon-local verts (xyz triples). */
  icon: number[];
  /** Hull-local anchor+offset verts — SAME vertex count/order as `icon`. */
  hull: AnchoredVerts;
}

/**
 * Build a morph geometry from an outline slice and a fill slice. `fillIsIndicator` marks
 * the fill slice as a decoration mark that renders solid black (vs. the main shape, which
 * renders the vessel's real color). The outline slice is never an indicator — it always
 * uses the white/black contrast-mix formula (see the vertex shader's color step).
 *
 * Layout of the combined buffer: [outline verts | fill verts]. `aIsOutline` selects pass;
 * `aIsIndicator` is only ever 1 within the fill slice.
 */
function buildMorphGeometry(outline: MorphSlice, fill: MorphSlice, fillIsIndicator: boolean): MorphGeometry {
  const outlineN = outline.icon.length / 3;
  const fillN    = fill.icon.length / 3;
  return {
    iconPositions: new Float32Array([...outline.icon, ...fill.icon]),
    hullPositions: new Float32Array([...outline.hull.anchors, ...fill.hull.anchors]),
    hullOffset:    new Float32Array([...outline.hull.offsets, ...fill.hull.offsets]),
    isOutline:     new Float32Array([...Array<number>(outlineN).fill(1), ...Array<number>(fillN).fill(0)]),
    isIndicator:   new Float32Array([...Array<number>(outlineN).fill(0),
                                     ...Array<number>(fillN).fill(fillIsIndicator ? 1 : 0)]),
    vertexCount: outlineN + fillN,
  };
}

// ---------------------------------------------------------------------------
// Main shape — arrow icon ↔ hull polygon.
// ---------------------------------------------------------------------------

// 6-point hexagon, bow-fan order: bow, sb-shoulder, sb-aft, stern-notch, port-aft,
// port-shoulder. Identical to the old ARROW_SHAPE silhouette.
const ICON_BOUNDARY: [number, number][] = [
  [0.00,  1.000], // bow
  [0.50,  0.333], // sb-shoulder
  [0.50, -0.750], // sb-aft
  [0.00, -0.500], // stern notch
  [-0.50, -0.750], // port-aft
  [-0.50,  0.333], // port-shoulder
];

// Same 6-point structure, but the "stern notch" slot is a colinear stern-MID point on what
// was a flat stern edge (sb-aft → port-aft, both at y=-1) — padding the old 5-point hull
// pentagon (bow, sb-shoulder(1,0.6), sb-aft(1,-1), port-aft(-1,-1), port-shoulder(-1,0.6))
// to the same topology as ICON_BOUNDARY without changing its rendered shape at all.
const HULL_BOUNDARY: [number, number][] = [
  [0.0,  1.0], // bow
  [1.0,  0.6], // sb-shoulder
  [1.0, -1.0], // sb-aft
  [0.0, -1.0], // stern mid (padding — colinear with sb-aft/port-aft, no shape change)
  [-1.0, -1.0], // port-aft
  [-1.0,  0.6], // port-shoulder
];

const ICON_OUTLINE_HALFWIDTH = 0.08;
const HULL_OUTLINE_HALFWIDTH = 0.05; // matches the old HULL_BORDER_OUTLINE convention

export const MORPH_ARROW: MorphGeometry = buildMorphGeometry(
  {
    icon: strokeBoundary(ICON_BOUNDARY, ICON_OUTLINE_HALFWIDTH),
    hull: unanchored(strokeBoundary(HULL_BOUNDARY, HULL_OUTLINE_HALFWIDTH)),
  },
  {
    icon: fanTriangulate(ICON_BOUNDARY),
    hull: unanchored(fanTriangulate(HULL_BOUNDARY)),
  },
  false,
);

// ---------------------------------------------------------------------------
// Decoration marks — overlaid on the main shape for specific AIS nav states.
// ---------------------------------------------------------------------------

/**
 * Anchor ball at bow. Day-shape: anchored at its own centre (tracks the hull anisotropically
 * — i.e. with vessel length, like the bow itself), but its own radius is isotropic so it
 * stays a true circle instead of stretching into an ellipse with the hull's aspect ratio.
 * Hull side never shows a ring (outline == fill there); icon side keeps its CPU-grown ring.
 */
export const MORPH_ANCHOR_DOT: MorphGeometry = buildMorphGeometry(
  { icon: growCircle(0, 0.65, 0.18, 8), hull: anchoredAt(0, 0.65, circleVerts(0, 0.65, 0.20, 8)) },
  { icon: circleVerts(0, 0.65, 0.18, 8), hull: anchoredAt(0, 0.65, circleVerts(0, 0.65, 0.20, 8)) },
  true,
);

/**
 * Aground ring — annulus surrounding the vessel. Kept fully anisotropic by design: in
 * hull-local space the ring is circular, which renders as an ellipse proportional to
 * length/beam — intentional, the ellipse still frames the elongated hull clearly.
 */
export const MORPH_AGROUND_RING: MorphGeometry = buildMorphGeometry(
  { icon: growArc(0, 0, 1.35, 1.55, 0, 360, 16), hull: unanchored(arcVerts(0, 0, 1.30, 1.50, 0, 360, 16)) },
  { icon: arcVerts(0, 0, 1.35, 1.55, 0, 360, 16), hull: unanchored(arcVerts(0, 0, 1.30, 1.50, 0, 360, 16)) },
  true,
);

/**
 * Mooring bars — two bars just outside the port/starboard hull edges. Kept fully
 * anisotropic — these are meant to track hull beam/length, not stay an undistorted symbol.
 */
export const MORPH_MOORING_BARS: MorphGeometry = buildMorphGeometry(
  {
    icon: [...growRect(-1.38, -0.55, -1.13, 0.22), ...growRect(1.13, -0.55, 1.38, 0.22)],
    hull: unanchored([...rectVerts(-1.35, -0.55, -1.10, 0.22), ...rectVerts(1.10, -0.55, 1.35, 0.22)]),
  },
  {
    icon: [...rectVerts(-1.38, -0.55, -1.13, 0.22), ...rectVerts(1.13, -0.55, 1.38, 0.22)],
    hull: unanchored([...rectVerts(-1.35, -0.55, -1.10, 0.22), ...rectVerts(1.10, -0.55, 1.35, 0.22)]),
  },
  true,
);

/**
 * Constrained by draught — two full-length bars just outside the hull edges. Kept fully
 * anisotropic, same reasoning as mooring bars.
 */
export const MORPH_DRAUGHT: MorphGeometry = buildMorphGeometry(
  {
    icon: [...growRect(-1.00, -0.80, -0.75, 0.85), ...growRect(0.75, -0.80, 1.00, 0.85)],
    hull: unanchored([...rectVerts(-1.35, -0.85, -1.10, 0.85), ...rectVerts(1.10, -0.85, 1.35, 0.85)]),
  },
  {
    icon: [...rectVerts(-1.00, -0.80, -0.75, 0.85), ...rectVerts(0.75, -0.80, 1.00, 0.85)],
    hull: unanchored([...rectVerts(-1.35, -0.85, -1.10, 0.85), ...rectVerts(1.10, -0.85, 1.35, 0.85)]),
  },
  true,
);

/**
 * Fishing gear — two diagonal boom arms plus a trawl net arc trailing aft of the stern.
 * Kept fully anisotropic: this is an extended apparatus whose reach toward the stern
 * depends on the same length-scaling as the hull itself (an isotropic/beam-only offset
 * would collapse that reach down near its anchor instead of trailing behind the stern —
 * see prior fix history). Icon and hull arc step counts are harmonized to 18 (the icon
 * side previously used 14) so the two ends share one vertex topology.
 */
const FISHING_ARC_STEPS = 18;
export const MORPH_FISHING_GEAR: MorphGeometry = buildMorphGeometry(
  {
    icon: [
      ...growLineSeg(-0.8, 0.0, -1.5, -0.5, 0.08),
      ...growLineSeg(0.8, 0.0, 1.5, -0.5, 0.08),
      ...growArc(0, 0.3, 1.60, 1.78, 242, 118, FISHING_ARC_STEPS),
    ],
    hull: unanchored([
      ...lineSeg(-0.8, 0.0, -1.5, -0.5, 0.055),
      ...lineSeg(0.8, 0.0, 1.5, -0.5, 0.055),
      ...arcVerts(0, 0.3, 1.62, 1.78, 242, 118, FISHING_ARC_STEPS),
    ]),
  },
  {
    icon: [
      ...lineSeg(-0.8, 0.0, -1.5, -0.5, 0.08),
      ...lineSeg(0.8, 0.0, 1.5, -0.5, 0.08),
      ...arcVerts(0, 0.3, 1.60, 1.78, 242, 118, FISHING_ARC_STEPS),
    ],
    hull: unanchored([
      ...lineSeg(-0.8, 0.0, -1.5, -0.5, 0.055),
      ...lineSeg(0.8, 0.0, 1.5, -0.5, 0.055),
      ...arcVerts(0, 0.3, 1.62, 1.78, 242, 118, FISHING_ARC_STEPS),
    ]),
  },
  true,
);

/**
 * Not Under Command — two stacked balls. Each anchored at its own centre (anisotropic);
 * each ball's own radius is isotropic so both stay true circles.
 */
export const MORPH_NUC: MorphGeometry = buildMorphGeometry(
  {
    icon: [...growCircle(0, 0.45, 0.15, 10), ...growCircle(0, 0.10, 0.15, 10)],
    hull: concatAnchored(
      anchoredAt(0, 0.45, circleVerts(0, 0.45, 0.10, 10)),
      anchoredAt(0, 0.12, circleVerts(0, 0.12, 0.10, 10)),
    ),
  },
  {
    icon: [...circleVerts(0, 0.45, 0.15, 10), ...circleVerts(0, 0.10, 0.15, 10)],
    hull: concatAnchored(
      anchoredAt(0, 0.45, circleVerts(0, 0.45, 0.10, 10)),
      anchoredAt(0, 0.12, circleVerts(0, 0.12, 0.10, 10)),
    ),
  },
  true,
);

/**
 * Restricted Manoeuvrability — ball / diamond / ball. Each part anchored at its own
 * centre (anisotropic); each part's own shape is isotropic so the balls stay circular and
 * the diamond stays an undistorted diamond.
 */
export const MORPH_RESTRICTED: MorphGeometry = buildMorphGeometry(
  {
    icon: [
      ...growCircle(0, 0.57, 0.13, 10),
      ...growDiamond(0, 0.15, 0.17, 0.17),
      ...growCircle(0, -0.28, 0.13, 10),
    ],
    hull: concatAnchored(
      anchoredAt(0, 0.55, circleVerts(0, 0.55, 0.09, 10)),
      anchoredAt(0, 0.15, diamondVerts(0, 0.15, 0.13, 0.13)),
      anchoredAt(0, -0.25, circleVerts(0, -0.25, 0.09, 10)),
    ),
  },
  {
    icon: [
      ...circleVerts(0, 0.57, 0.13, 10),
      ...diamondVerts(0, 0.15, 0.17, 0.17),
      ...circleVerts(0, -0.28, 0.13, 10),
    ],
    hull: concatAnchored(
      anchoredAt(0, 0.55, circleVerts(0, 0.55, 0.09, 10)),
      anchoredAt(0, 0.15, diamondVerts(0, 0.15, 0.13, 0.13)),
      anchoredAt(0, -0.25, circleVerts(0, -0.25, 0.09, 10)),
    ),
  },
  true,
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VesselMorphLayerProps<DataT = number> extends LayerProps {
  data: DataT[] | { length: number };
  getPosition?:    Accessor<DataT, [number, number] | [number, number, number]>;
  getSog?:         Accessor<DataT, number>;
  getCog?:         Accessor<DataT, number>;
  getHeading?:     Accessor<DataT, number>;
  getRot?:         Accessor<DataT, number>;
  getAgeAtUpload?: Accessor<DataT, number>;
  /** Vessel length in metres. 0 = unknown → stays icon-only forever, never morphs. */
  getLength?:      Accessor<DataT, number>;
  /** Vessel beam in metres. Irrelevant when getLength is 0. */
  getBeam?:        Accessor<DataT, number>;
  getColor?:       Accessor<DataT, [number, number, number, number]>;
  /** Which silhouette/decoration this layer instance renders. Defaults to the main shape. */
  morphGeometry?: MorphGeometry;
  /** Unix ms timestamp of the last data upload. draw() computes elapsed from this. */
  uploadTimestamp?: number;
  /** If true, draw() calls setNeedsRedraw() to keep animating each frame. */
  selfAnimate?: boolean;
  /** Minimum ms between animation redraws when selfAnimate is true. 0 = every frame. */
  animationIntervalMs?: number;
  settingsIconSize?: number;
  opacity?: number;
  /** DR cap in seconds — ghost vessel won't extrapolate beyond this. */
  drCapSeconds?: number;
}

const defaultProps: DefaultProps<VesselMorphLayerProps> = {
  getPosition:    { type: 'accessor', value: [0, 0] },
  getSog:         { type: 'accessor', value: 0 },
  getCog:         { type: 'accessor', value: 0 },
  getHeading:     { type: 'accessor', value: 0 },
  getRot:         { type: 'accessor', value: 0 },
  getAgeAtUpload: { type: 'accessor', value: 0 },
  getLength:      { type: 'accessor', value: 0 },
  getBeam:        { type: 'accessor', value: 10 },
  getColor:       { type: 'accessor', value: [255, 255, 255, 255] },
  uploadTimestamp:     0,
  selfAnimate:         false,
  animationIntervalMs: 0,
  settingsIconSize:    1,
  opacity:             1,
  drCapSeconds:        180,
};

// ---------------------------------------------------------------------------
// Layer class
// ---------------------------------------------------------------------------

export class VesselMorphLayer<DataT = number> extends Layer<VesselMorphLayerProps<DataT>> {
  static override layerName = 'VesselMorphLayer';
  static override defaultProps = defaultProps;

  private _animateTimerId: ReturnType<typeof setTimeout> | null = null;

  override getShaders() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return super.getShaders({
      vs, fs,
      modules: [project32, picking, vesselMorphUniformModule],
    });
  }

  override initializeState() {
    const attributeManager = this.getAttributeManager()!;
    attributeManager.addInstanced({
      instancePositions: {
        size: 3,
        type: 'float64',
        fp64: this.use64bitPositions(),
        transition: true,
        accessor: 'getPosition',
        defaultValue: [0, 0, 0],
      },
      instanceSog:         { size: 1, accessor: 'getSog',         defaultValue: 0 },
      instanceCog:         { size: 1, accessor: 'getCog',         defaultValue: 0 },
      instanceHeading:     { size: 1, accessor: 'getHeading',     defaultValue: 0 },
      instanceRot:         { size: 1, accessor: 'getRot',         defaultValue: 0 },
      instanceAgeAtUpload: { size: 1, accessor: 'getAgeAtUpload', defaultValue: 0 },
      instanceLength:      { size: 1, accessor: 'getLength',      defaultValue: 0 },
      instanceBeam:        { size: 1, accessor: 'getBeam',        defaultValue: 10 },
      instanceColor: {
        size: 4,
        type: 'unorm8',
        accessor: 'getColor',
        defaultValue: [255, 255, 255, 255],
      },
    });
  }

  override updateState(params: UpdateParameters<this>) {
    super.updateState(params);
    const needsModelRebuild = params.changeFlags.extensionsChanged ||
      params.props.morphGeometry !== params.oldProps.morphGeometry;
    if (needsModelRebuild) {
      (this.state['model'] as Model | undefined)?.destroy();
      this.state['model'] = this._getModel();
      this.getAttributeManager()!.invalidateAll();
    }
    if (params.changeFlags.propsChanged) {
      this.setNeedsRedraw();
    }
  }

  override draw({ uniforms: _uniforms }: { uniforms: Record<string, unknown> }) {
    const { uploadTimestamp, selfAnimate, animationIntervalMs, settingsIconSize, opacity, drCapSeconds } = this.props;
    const now = Date.now();
    const timeSinceUpload = selfAnimate
      ? Math.max(0, (now - (uploadTimestamp ?? 0)) / 1000)
      : 0;
    // Read zoom from the live viewport — no prop needed, no layer rebuild on zoom change.
    const zoom = this.context.viewport.zoom;
    const model = this.state['model'] as Model;
    model.shaderInputs.setProps({
      morph: {
        timeSinceUpload,
        drCapSeconds: drCapSeconds ?? 180,
        zoom,
        settingsIconSize: settingsIconSize ?? 1,
        opacity,
      },
    });
    model.draw(this.context.renderPass);
    if (selfAnimate) {
      const intervalMs = animationIntervalMs ?? 0;
      if (intervalMs <= 17) {
        this.setNeedsRedraw();
      } else {
        this._animateTimerId ??= setTimeout(() => {
          this._animateTimerId = null;
          this.setNeedsRedraw();
        }, intervalMs);
      }
    }
  }

  override finalizeState(context: Parameters<Layer['finalizeState']>[0]) {
    if (this._animateTimerId !== null) {
      clearTimeout(this._animateTimerId);
      this._animateTimerId = null;
    }
    super.finalizeState(context);
  }

  _getModel() {
    const geo = this.props.morphGeometry ?? MORPH_ARROW;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- deck.gl's getShaders() returns any
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: {
          iconPositions: { size: 3, value: geo.iconPositions },
          hullPositions: { size: 3, value: geo.hullPositions },
          hullOffset:    { size: 3, value: geo.hullOffset },
          aIsOutline:    { size: 1, value: geo.isOutline },
          aIsIndicator:  { size: 1, value: geo.isIndicator },
        },
        vertexCount: geo.vertexCount,
      }),
      isInstanced: true,
    });
  }
}
