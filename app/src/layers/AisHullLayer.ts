/**
 * AisHullLayer — custom deck.gl Layer that renders vessel hull polygons with GPU dead reckoning.
 *
 * Each vessel is a single draw instance. The vertex shader:
 *   1. Scales the unit hull mesh by per-instance length/beam attributes.
 *   2. Rotates the hull in ship-space (using extrapolated heading).
 *   3. Adds a dead-reckoned ENU offset from the vessel's stored position.
 *   4. Projects to clip space via deck.gl's project32 module.
 *   5. Computes cross-fade opacity from zoom vs. transition zoom.
 *
 * Per-frame cost: only the `timeSinceUpload` uniform changes.
 * GPU buffers (position, heading, sog, cog, …) are uploaded once per AIS tick.
 */

import { Layer, project32, picking } from '@deck.gl/core';
import type { LayerProps, UpdateParameters, DefaultProps, Accessor } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';

// ---------------------------------------------------------------------------
// Shader uniform module
// ---------------------------------------------------------------------------

const uniformBlock = /* glsl */`\
uniform aisHullUniforms {
  float timeSinceUpload;
  float drCapSeconds;
  float zoom;
  float settingsIconSize;
  float opacity;
} aisHull;
`;

const aisHullUniformModule = {
  name: 'aisHull',
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
#define SHADER_NAME ais-hull-layer-vertex-shader

in vec3 positions;           // hull vertex in local space (X=sb, Y=bow, unit [-1,1])
in vec3 instancePositions;
in vec3 instancePositions64Low;
in float instanceSog;        // m/s
in float instanceCog;        // radians (north = 0, clockwise positive)
in float instanceHeading;    // radians
in float instanceRot;        // rad/s
in float instanceAgeAtUpload;// seconds the vessel was already aged when data was uploaded
in float instanceLength;     // metres
in float instanceBeam;       // metres
in vec4 instanceColor;       // premultiplied RGBA [0..1]
in vec3 instancePickingColors;

out vec4 vColor;

void main(void) {
  // ------------------------------------------------------------------
  // 1. Time delta (float32-safe: both components are small seconds values)
  // ------------------------------------------------------------------
  float dt = min(instanceAgeAtUpload + aisHull.timeSinceUpload, aisHull.drCapSeconds);

  // ------------------------------------------------------------------
  // 2. Dead-reckoned ENU offset from stored position (metres)
  //    Exact arc integral when ROT ≠ 0; straight line otherwise.
  // ------------------------------------------------------------------
  float dEast, dNorth;
  if (abs(instanceRot) > 1e-4) {
    float cogEnd = instanceCog + instanceRot * dt;
    float R = instanceSog / instanceRot;        // signed turn radius (m)
    dEast  = R * (cos(instanceCog) - cos(cogEnd));
    dNorth = R * (sin(cogEnd)      - sin(instanceCog));
  } else {
    dEast  = instanceSog * dt * sin(instanceCog);
    dNorth = instanceSog * dt * cos(instanceCog);
  }

  // ------------------------------------------------------------------
  // 3. Scale hull vertex from unit space to metres
  // ------------------------------------------------------------------
  float safelen  = max(instanceLength, 1.0);
  float safebeam = max(instanceBeam,  1.0);
  float localX = positions.x * safebeam  * 0.5; // port/starboard in metres
  float localY = positions.y * safelen   * 0.5; // bow/stern in metres

  // ------------------------------------------------------------------
  // 4. Rotate hull from ship space to ENU
  // ------------------------------------------------------------------
  float heading = instanceHeading + instanceRot * dt;
  float sinH = sin(heading);
  float cosH = cos(heading);
  float hullEast  = localY * sinH + localX * cosH;
  float hullNorth = localY * cosH - localX * sinH;

  // ------------------------------------------------------------------
  // 5. Total ENU offset from stored (fp64) anchor position
  //
  // geometry.worldPosition must be set BEFORE project_size() so that the
  // Mercator latitude correction (1/cos(lat)) uses the vessel's actual
  // latitude. Without this, the correction defaults to 1.0 (equator) and
  // EW offsets are undersized at non-equatorial latitudes (e.g. 55°N → 74%
  // of correct value).
  // ------------------------------------------------------------------
  geometry.worldPosition = instancePositions;
  vec3 offset = project_size(vec3(dEast + hullEast, dNorth + hullNorth, 0.0));

  // ------------------------------------------------------------------
  // 6. Project to clip space
  // ------------------------------------------------------------------
  vec4 worldPos;
  gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, offset, worldPos);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  // ------------------------------------------------------------------
  // 6b. Far-hemisphere discard (globe mode only)
  //
  // In globe mode the deck.gl orientation matrix uses ux = -East, which
  // mirrors hull X and flips winding CW→CCW as seen by the GPU.  That
  // makes our CW hull appear as a front-face for near-side vessels — good.
  // For far-side vessels the same mirror happens, but their clip-space W
  // is negative (they project behind the camera), and negating W flips
  // BOTH clip X and Y — an even number of flips — so the winding stays
  // CCW and they also appear as front-faces.  Combined with
  // depthCompare:'always' (which bypasses occlusion by the globe sphere)
  // they would show through the globe as mirrored ghosts.
  //
  // Fix: discard any vertex whose anchor sits on the far hemisphere.
  // dot(commonPos, cameraPosition) > 0 iff they are on the same side of
  // the plane through the globe centre that is perpendicular to the camera.
  // ------------------------------------------------------------------
  if (project.projectionMode == PROJECTION_MODE_GLOBE &&
      dot(worldPos.xyz, project.cameraPosition) < 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0); // outside clip volume → culled
  }

  // ------------------------------------------------------------------
  // 7. Cross-fade: hull fades in as zoom increases past the transition point
  // ------------------------------------------------------------------
  float lat_rad = instancePositions.y * radians(1.0);
  float transitionZoom = log2(
    aisHull.settingsIconSize * 64.0 * 40075016.686 * cos(lat_rad) / (safelen * 256.0)
  );
  float t01 = clamp((aisHull.zoom - transitionZoom + 1.0) / 2.0, 0.0, 1.0);
  float shapeAlpha = t01 * aisHull.opacity;

  vColor = vec4(instanceColor.rgb, instanceColor.a * shapeAlpha);

  // Picking
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
#define SHADER_NAME ais-hull-layer-fragment-shader

in vec4 vColor;
out vec4 fragColor;

void main(void) {
  fragColor = vColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

// ---------------------------------------------------------------------------
// Hull mesh (triangle list, normalized local space: bow=+Y, starboard=+X)
// ---------------------------------------------------------------------------
// 5 vertices → 3 triangles → 9 positions.
//
// Winding order: CW in ENU space.
//
// In globe mode, deck.gl's project_get_orientation_matrix() sets
// ux = normalize(vec3(uz.y, -uz.x, 0)) which equals -East everywhere on the
// sphere.  This mirrors the hull along the East/West axis, flipping the
// on-screen winding from CW → CCW (front-face under cullMode:'back').
//
// In mercator mode cullMode is not active (getDefaultParameters only adds
// cullMode:'back' for globe), so the winding direction is irrelevant there.
//
// Far-side vessels are discarded in the vertex shader before they can
// appear as mirrored ghosts through the globe (see step 6b).
const HULL_POSITIONS = new Float32Array([
  //  X     Y      Z       triangle  (CW in ENU → CCW on screen in globe)
   0.0,  1.0,  0.0, //  bow          \ fan T0
   1.0,  0.6,  0.0, //  sb-shoulder   \
   1.0, -1.0,  0.0, //  sb-aft        /
   0.0,  1.0,  0.0, //  bow          \ fan T1
   1.0, -1.0,  0.0, //  sb-aft        \
  -1.0, -1.0,  0.0, //  port-aft      /
   0.0,  1.0,  0.0, //  bow          \ fan T2
  -1.0, -1.0,  0.0, //  port-aft      \
  -1.0,  0.6,  0.0, //  port-shoulder /
]);
const VERTEX_COUNT = 9;

// ---------------------------------------------------------------------------
// Props interface
// ---------------------------------------------------------------------------

export interface AisHullLayerProps<DataT = number> extends LayerProps {
  data: DataT[] | { length: number };
  getPosition?: Accessor<DataT, [number, number] | [number, number, number]>;
  getSog?: Accessor<DataT, number>;
  getCog?: Accessor<DataT, number>;
  getHeading?: Accessor<DataT, number>;
  getRot?: Accessor<DataT, number>;
  getAgeAtUpload?: Accessor<DataT, number>;
  getLength?: Accessor<DataT, number>;
  getBeam?: Accessor<DataT, number>;
  getColor?: Accessor<DataT, [number, number, number, number]>;
  /** Unix ms timestamp of the last data upload. draw() computes elapsed from this. */
  uploadTimestamp?: number;
  /** If true, draw() calls setNeedsRedraw() to keep animating each frame. */
  selfAnimate?: boolean;
  /** Minimum ms between animation redraws when selfAnimate is true. 0 = every frame. */
  animationIntervalMs?: number;
  settingsIconSize?: number;
  opacity?: number;
  /** DR cap in seconds — ghost hull won't extrapolate beyond this. Defaults to cogLengthMinutes*60. */
  drCapSeconds?: number;
}

const defaultProps: DefaultProps<AisHullLayerProps> = {
  getPosition:    { type: 'accessor', value: [0, 0] },
  getSog:         { type: 'accessor', value: 0 },
  getCog:         { type: 'accessor', value: 0 },
  getHeading:     { type: 'accessor', value: 0 },
  getRot:         { type: 'accessor', value: 0 },
  getAgeAtUpload: { type: 'accessor', value: 0 },
  getLength:      { type: 'accessor', value: 50 },
  getBeam:        { type: 'accessor', value: 10 },
  getColor:       { type: 'accessor', value: [0, 100, 200, 220] },
  uploadTimestamp:   0,
  selfAnimate:       false,
  animationIntervalMs: 0,
  settingsIconSize:  1,
  opacity:           1,
  drCapSeconds:      180,
};

// ---------------------------------------------------------------------------
// Layer class
// ---------------------------------------------------------------------------

export class AisHullLayer<DataT = number> extends Layer<AisHullLayerProps<DataT>> {
  static override layerName = 'AisHullLayer';
  static override defaultProps = defaultProps;

  private _animateTimerId: ReturnType<typeof setTimeout> | null = null;

  override getShaders() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return super.getShaders({
      vs, fs,
      modules: [project32, picking, aisHullUniformModule],
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
      instanceLength:      { size: 1, accessor: 'getLength',      defaultValue: 50 },
      instanceBeam:        { size: 1, accessor: 'getBeam',        defaultValue: 10 },
      instanceColor: {
        size: 4,
        type: 'unorm8',
        accessor: 'getColor',
        defaultValue: [0, 100, 200, 220],
      },
    });
  }

  override updateState(params: UpdateParameters<this>) {
    super.updateState(params);
    if (params.changeFlags.extensionsChanged) {
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
    // Read zoom from the live viewport — no need to pass it as a prop or rebuild
    // layer instances on zoom changes.
    const zoom = this.context.viewport.zoom;
    const model = this.state['model'] as Model;
    model.shaderInputs.setProps({
      aisHull: {
        timeSinceUpload,
        drCapSeconds: drCapSeconds ?? 180,
        zoom,
        settingsIconSize: settingsIconSize ?? 1,
        opacity: opacity,
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- deck.gl's getShaders() returns any
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions: { size: 3, value: HULL_POSITIONS },
        },
        vertexCount: VERTEX_COUNT,
      }),
      isInstanced: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Hull outline geometry — 5 triangulated quads, one per hull edge.
// Used by AisHullBorderLayer for a configurable-colour outline stroke.
// ---------------------------------------------------------------------------

/**
 * Build a triangle-list mesh that traces the hull outline.
 * Each of the 5 hull edges becomes a thin rectangular quad centred on the
 * edge line.  `halfWidth` is in hull-local units (X scaled by beam/2, Y by
 * length/2 in the vertex shader).
 */
function buildHullOutlineGeometry(halfWidth: number): HullDecorationGeometry {
  const outline: [number, number][] = [
    [0, 1],    // bow
    [1, 0.6],  // sb-shoulder
    [1, -1],   // sb-aft
    [-1, -1],  // port-aft
    [-1, 0.6], // port-shoulder
  ];
  const v: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i] as [number, number];
    const [x1, y1] = outline[(i + 1) % outline.length] as [number, number];
    v.push(...hullLineSeg(x0, y0, x1, y1, halfWidth));
  }
  return buildHullDecorationGeometry(v);
}

/** Pre-built hull outline geometry with a half-width of 0.05 local units. */
export const HULL_BORDER_OUTLINE: HullDecorationGeometry = buildHullOutlineGeometry(0.05);

// ---------------------------------------------------------------------------
// AisHullDecorationLayer
//
// Renders nav-state decoration geometry (anchor dot, mooring bars, aground
// ring) in hull-local space.  Identical dead-reckoning to AisHullLayer so
// decorations stay locked to the hull polygon under animation.
//
// Design decisions:
//   • Solid black fill — visible on any vessel color.
//   • Same cross-fade formula as AisHullLayer — fades in/out with the hull.
//   • Not pickable — decorations are visual only.
//   • Hull-local geometry means decorations scale proportionally with
//     vessel length and beam (anchor dot at bow, bars at hull edge, etc.).
// ---------------------------------------------------------------------------

const decorationVs = /* glsl */`\
#version 300 es
#define SHADER_NAME ais-hull-decoration-vertex-shader

in vec3 positions;
// Fixed-pixel-equivalent offset from positions (the anchor) — scaled isotropically by
// beam for BOTH axes (never by length), so day-shape marks (anchor dot, fishing gear,
// NUC dots, restricted dayshape) render as true circles/diamonds instead of being
// stretched into ellipses by the hull's length/beam aspect ratio. Zero for decorations
// that should keep the existing fully anisotropic hull-local scaling (mooring bars,
// aground ring, draught bars).
in vec3 aOffset;
in vec3 instancePositions;
in vec3 instancePositions64Low;
in float instanceSog;
in float instanceCog;
in float instanceHeading;
in float instanceRot;
in float instanceAgeAtUpload;
in float instanceLength;
in float instanceBeam;

out float vOpacity;

void main(void) {
  float dt = min(instanceAgeAtUpload + aisHull.timeSinceUpload, aisHull.drCapSeconds);

  float dEast, dNorth;
  if (abs(instanceRot) > 1e-4) {
    float cogEnd = instanceCog + instanceRot * dt;
    float R      = instanceSog / instanceRot;
    dEast  = R * (cos(instanceCog) - cos(cogEnd));
    dNorth = R * (sin(cogEnd)      - sin(instanceCog));
  } else {
    dEast  = instanceSog * dt * sin(instanceCog);
    dNorth = instanceSog * dt * cos(instanceCog);
  }

  float safelen  = max(instanceLength, 1.0);
  float safebeam = max(instanceBeam,  1.0);
  // Anchor: existing anisotropic hull-local scaling (X by beam/2, Y by length/2) — keeps
  // each mark's pivot at the right bow/stern, port/starboard position on the hull.
  // Offset: isotropic, beam-scaled on both axes — keeps the mark's own shape undistorted
  // regardless of how elongated the hull is.
  float localX = positions.x * safebeam * 0.5 + aOffset.x * safebeam * 0.5;
  float localY = positions.y * safelen  * 0.5 + aOffset.y * safebeam * 0.5;

  float heading = instanceHeading + instanceRot * dt;
  float sinH = sin(heading);
  float cosH = cos(heading);
  float hullEast  = localY * sinH + localX * cosH;
  float hullNorth = localY * cosH - localX * sinH;

  geometry.worldPosition = instancePositions;
  vec3 offset = project_size(vec3(dEast + hullEast, dNorth + hullNorth, 0.0));

  vec4 worldPos;
  gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, offset, worldPos);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  if (project.projectionMode == PROJECTION_MODE_GLOBE &&
      dot(worldPos.xyz, project.cameraPosition) < 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  }

  // Same cross-fade as AisHullLayer — decoration fades in with the hull.
  float lat_rad = instancePositions.y * radians(1.0);
  float transitionZoom = log2(
    aisHull.settingsIconSize * 64.0 * 40075016.686 * cos(lat_rad) / (safelen * 256.0)
  );
  float t01 = clamp((aisHull.zoom - transitionZoom + 1.0) / 2.0, 0.0, 1.0);
  vOpacity = t01;
}
`;

const decorationFs = /* glsl */`\
#version 300 es
precision highp float;
#define SHADER_NAME ais-hull-decoration-fragment-shader

in float vOpacity;
out vec4 fragColor;

void main(void) {
  fragColor = vec4(0.0, 0.0, 0.0, vOpacity);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

// ---------------------------------------------------------------------------
// Decoration geometry presets (hull-local unit space, bow=+Y, starboard=+X)
//
// X is scaled by beam/2, Y by length/2 in the vertex shader (anisotropic — matches
// the hull polygon itself). Marks that should instead render as true, undistorted
// circles/diamonds (anchor dot, fishing gear, NUC, restricted dayshape) are built via
// `hullAnchoredAt`/`hullConcatAnchored` below: their own extent goes through the
// isotropic, beam-only `offsets` attribute, while their anchor point still tracks the
// hull anisotropically. Marks that should keep the existing fully-anisotropic look
// (mooring bars, aground ring — see its own doc comment, draught bars) are built from a
// plain flat array, same as before.
// ---------------------------------------------------------------------------

export interface HullDecorationGeometry {
  positions:   Float32Array;
  offsets:     Float32Array;
  vertexCount: number;
}

/** A vertex set split into a per-mark anchor (anisotropic, hull-local) and an isotropic,
 *  beam-only offset-from-anchor — see the section comment above. */
interface HullAnchoredVerts {
  anchors: number[];
  offsets: number[];
}

/** Split a flat vertex array (built around (cx, cy)) into anchor + isotropic offset. */
function hullAnchoredAt(cx: number, cy: number, verts: number[]): HullAnchoredVerts {
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

/** Concatenate several independently-anchored mark parts into one HullAnchoredVerts. */
function hullConcatAnchored(...parts: HullAnchoredVerts[]): HullAnchoredVerts {
  return {
    anchors: parts.flatMap(p => p.anchors),
    offsets: parts.flatMap(p => p.offsets),
  };
}

/** Legacy/plain vertex array: anchor IS the vertex, offset is zero — the mark keeps the
 *  existing fully-anisotropic hull-local scaling (mooring bars, aground ring, draught). */
function hullUnanchored(verts: number[]): HullAnchoredVerts {
  return { anchors: verts, offsets: new Array<number>(verts.length).fill(0) };
}

function buildHullDecorationGeometry(verts: number[] | HullAnchoredVerts): HullDecorationGeometry {
  const v = Array.isArray(verts) ? hullUnanchored(verts) : verts;
  return {
    positions:   new Float32Array(v.anchors),
    offsets:     new Float32Array(v.offsets),
    vertexCount: v.anchors.length / 3,
  };
}


function hullCircleVerts(cx: number, cy: number, r: number, sides: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i       / sides) * 2 * Math.PI;
    const a1 = ((i + 1) / sides) * 2 * Math.PI;
    v.push(cx, cy, 0,
           cx + r * Math.sin(a0), cy + r * Math.cos(a0), 0,
           cx + r * Math.sin(a1), cy + r * Math.cos(a1), 0);
  }
  return v;
}

function hullRectVerts(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, 0,  x1, y0, 0,  x1, y1, 0,
          x0, y0, 0,  x1, y1, 0,  x0, y1, 0];
}

function hullAnnulusVerts(inner: number, outer: number, sides: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i       / sides) * 2 * Math.PI;
    const a1 = ((i + 1) / sides) * 2 * Math.PI;
    v.push(
      inner * Math.sin(a0), inner * Math.cos(a0), 0,
      outer * Math.sin(a0), outer * Math.cos(a0), 0,
      outer * Math.sin(a1), outer * Math.cos(a1), 0,

      inner * Math.sin(a0), inner * Math.cos(a0), 0,
      outer * Math.sin(a1), outer * Math.cos(a1), 0,
      inner * Math.sin(a1), inner * Math.cos(a1), 0,
    );
  }
  return v;
}

function hullDiamondVerts(cx: number, cy: number, w: number, h: number): number[] {
  return [
    cx, cy, 0,  cx,   cy+h, 0,  cx+w, cy,   0,
    cx, cy, 0,  cx+w, cy,   0,  cx,   cy-h, 0,
    cx, cy, 0,  cx,   cy-h, 0,  cx-w, cy,   0,
    cx, cy, 0,  cx-w, cy,   0,  cx,   cy+h, 0,
  ];
}

/**
 * Thin rectangular band along a straight line segment, in hull-local space.
 * Used for boom arms on fishing vessels.
 * halfWidth is in hull-local units (X scaled by beam/2, Y by length/2).
 */
function hullLineSeg(x0: number, y0: number, x1: number, y1: number, halfWidth: number): number[] {
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

/**
 * Annulus arc band in hull-local space (bow=+Y, starboard=+X convention).
 * Angles in degrees; sweeps from a_start_deg to a_end_deg (can decrease).
 */
function hullArcVerts(
  cx: number, cy: number,
  inner: number, outer: number,
  a_start_deg: number, a_end_deg: number,
  steps: number,
): number[] {
  const v: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = i       / steps;
    const t1 = (i + 1) / steps;
    const a0 = (a_start_deg + (a_end_deg - a_start_deg) * t0) * Math.PI / 180;
    const a1 = (a_start_deg + (a_end_deg - a_start_deg) * t1) * Math.PI / 180;
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

/**
 * Anchor ball at bow — circle at Y=0.65 (bow region), radius 0.20.
 * Anchored at the bow position (scales anisotropically with vessel length, like the
 * hull); the ball's own radius is isotropic (beam-scaled on both axes) so it renders as
 * a true circle instead of being stretched into an ellipse by the length/beam ratio.
 */
export const HULL_ANCHOR_DOT: HullDecorationGeometry = buildHullDecorationGeometry(
  hullAnchoredAt(0, 0.65, hullCircleVerts(0, 0.65, 0.20, 8)),
);

/**
 * Mooring bars — two black bars just outside port and starboard hull edges.
 * Scales with beam: bars at ±(1.10–1.35) × beam/2 from centreline.
 */
export const HULL_MOORING_BARS: HullDecorationGeometry = buildHullDecorationGeometry([
  ...hullRectVerts(-1.35, -0.55, -1.10, 0.22),  // port side
  ...hullRectVerts( 1.10, -0.55,  1.35, 0.22),  // starboard side
]);

/**
 * Aground ring — annulus surrounding the vessel hull.
 * In hull-local space the ring is circular, which renders as an ellipse in
 * world space (proportional to length and beam).  The ellipse still frames
 * the hull clearly at hull-zoom levels.
 */
export const HULL_AGROUND_RING: HullDecorationGeometry = buildHullDecorationGeometry(
  hullAnnulusVerts(1.30, 1.50, 16),
);

/**
 * Fishing gear — two diagonal boom arms to port and starboard, plus a trawl net
 * arc curving around the stern connecting the boom tips.
 *
 * Geometry in hull-local space (X scaled by beam/2, Y scaled by length/2):
 *   • Booms: diagonal bars from ~midship outward and aft (±0.8→±1.5, 0.0→−0.5)
 *   • Net arc: annulus arc centered at (0, 0.3), radius 1.7, sweeping from
 *     port-boom-tip (≈242°) through stern (180°) to starboard-boom-tip (≈118°).
 *
 * Kept fully anisotropic (NOT anchor/offset split like the day-shape marks below) —
 * this is an extended apparatus reaching well aft of the hull's own stern, not a
 * compact point-symbol. Its aft reach depends on the same length-scaling as the hull
 * itself; an isotropic (beam-only) offset would collapse that reach down near its
 * anchor instead of trailing behind the stern as intended.
 *
 * For a 40 m × 8 m vessel the booms extend ~6 m beyond the hull,
 * and the net arc reaches ~11 m aft of centre.
 */
export const HULL_FISHING_GEAR: HullDecorationGeometry = buildHullDecorationGeometry([
  // Port boom: from (−0.8, 0.0) out to (−1.5, −0.5)
  ...hullLineSeg(-0.8,  0.0, -1.5, -0.5, 0.055),
  // Starboard boom: mirror
  ...hullLineSeg( 0.8,  0.0,  1.5, -0.5, 0.055),
  // Trawl net arc: center (0, 0.3), r≈1.7, from 242° down through 180° to 118°
  // (hull angle convention: x=r·sin(a), y=r·cos(a); 180°=stern, 90°=starboard, 270°=port)
  ...hullArcVerts(0, 0.3, 1.62, 1.78, 242, 118, 18),
]);

/**
 * Not Under Command — two stacked balls in the forward (bow) section of the hull.
 * Each ball is anchored at its own centre (anisotropic, tracks hull length); its own
 * radius is isotropic so both balls render as true circles, not ellipses.
 */
export const HULL_NUC: HullDecorationGeometry = buildHullDecorationGeometry(
  hullConcatAnchored(
    hullAnchoredAt(0, 0.45, hullCircleVerts(0, 0.45, 0.10, 10)),  // upper ball
    hullAnchoredAt(0, 0.12, hullCircleVerts(0, 0.12, 0.10, 10)),  // lower ball
  ),
);

/**
 * Restricted Manoeuvrability — ball / diamond / ball in hull-local space.
 * Each part anchored at its own centre (anisotropic); each part's own shape is
 * isotropic so the balls stay circular and the diamond stays an undistorted diamond.
 */
export const HULL_RESTRICTED: HullDecorationGeometry = buildHullDecorationGeometry(
  hullConcatAnchored(
    hullAnchoredAt(0, 0.55,  hullCircleVerts(0, 0.55, 0.09, 10)),     // top ball
    hullAnchoredAt(0, 0.15,  hullDiamondVerts(0, 0.15, 0.13, 0.13)),  // middle diamond
    hullAnchoredAt(0, -0.25, hullCircleVerts(0, -0.25, 0.09, 10)),    // bottom ball
  ),
);

/**
 * Constrained by Draught — two full-length bars just outside the hull edges
 * on port and starboard, indicating the vessel fills the navigable channel.
 */
export const HULL_DRAUGHT: HullDecorationGeometry = buildHullDecorationGeometry([
  ...hullRectVerts(-1.35, -0.85, -1.10, 0.85),  // port side full-length bar
  ...hullRectVerts( 1.10, -0.85,  1.35, 0.85),  // starboard side full-length bar
]);

// ---------------------------------------------------------------------------
// Props / defaults
// ---------------------------------------------------------------------------

export interface AisHullDecorationLayerProps<DataT = number> extends LayerProps {
  data: DataT[] | { length: number };
  getPosition?:    Accessor<DataT, [number, number] | [number, number, number]>;
  getSog?:         Accessor<DataT, number>;
  getCog?:         Accessor<DataT, number>;
  getHeading?:     Accessor<DataT, number>;
  getRot?:         Accessor<DataT, number>;
  getAgeAtUpload?: Accessor<DataT, number>;
  getLength?:      Accessor<DataT, number>;
  getBeam?:        Accessor<DataT, number>;
  uploadTimestamp?: number;
  selfAnimate?:    boolean;
  /** Minimum ms between animation redraws when selfAnimate is true. 0 = every frame. */
  animationIntervalMs?: number;
  settingsIconSize?: number;
  decoration:      HullDecorationGeometry;
  /** DR cap in seconds — decoration won't extrapolate beyond this. */
  drCapSeconds?: number;
}

const decorationDefaultProps: DefaultProps<AisHullDecorationLayerProps> = {
  getPosition:    { type: 'accessor', value: [0, 0] },
  getSog:         { type: 'accessor', value: 0 },
  getCog:         { type: 'accessor', value: 0 },
  getHeading:     { type: 'accessor', value: 0 },
  getRot:         { type: 'accessor', value: 0 },
  getAgeAtUpload: { type: 'accessor', value: 0 },
  getLength:      { type: 'accessor', value: 50 },
  getBeam:        { type: 'accessor', value: 10 },
  uploadTimestamp:     0,
  selfAnimate:         false,
  animationIntervalMs: 0,
  settingsIconSize:    1,
  drCapSeconds:        180,
  decoration: { type: 'object', value: HULL_ANCHOR_DOT } as never,
};

// ---------------------------------------------------------------------------
// Layer class
// ---------------------------------------------------------------------------

export class AisHullDecorationLayer<DataT = number>
  extends Layer<AisHullDecorationLayerProps<DataT>>
{
  static override layerName = 'AisHullDecorationLayer';
  static override defaultProps = decorationDefaultProps;

  private _animateTimerId: ReturnType<typeof setTimeout> | null = null;

  override getShaders() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return super.getShaders({
      vs: decorationVs,
      fs: decorationFs,
      modules: [project32, aisHullUniformModule],
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
      instanceLength:      { size: 1, accessor: 'getLength',      defaultValue: 50 },
      instanceBeam:        { size: 1, accessor: 'getBeam',        defaultValue: 10 },
    });
  }

  override updateState(params: UpdateParameters<this>) {
    super.updateState(params);
    const needsNewModel = params.changeFlags.extensionsChanged
      || (params.changeFlags.propsChanged
          && (params.oldProps as AisHullDecorationLayerProps<DataT>).decoration
             !== (params.props as AisHullDecorationLayerProps<DataT>).decoration);
    if (needsNewModel) {
      (this.state['model'] as Model | undefined)?.destroy();
      this.state['model'] = this._getModel();
      this.getAttributeManager()!.invalidateAll();
    }
    if (params.changeFlags.propsChanged) {
      this.setNeedsRedraw();
    }
  }

  override draw({ uniforms: _uniforms }: { uniforms: Record<string, unknown> }) {
    const { uploadTimestamp, selfAnimate, animationIntervalMs, settingsIconSize, drCapSeconds } = this.props;
    const now = Date.now();
    const timeSinceUpload = selfAnimate
      ? Math.max(0, (now - (uploadTimestamp ?? 0)) / 1000)
      : 0;
    const zoom = this.context.viewport.zoom;
    const model = this.state['model'] as Model;
    model.shaderInputs.setProps({
      aisHull: { timeSinceUpload, drCapSeconds: drCapSeconds ?? 180, zoom, settingsIconSize: settingsIconSize ?? 1, opacity: 1 },
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
    const { positions, offsets, vertexCount } = this.props.decoration;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- deck.gl's getShaders() returns any
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions: { size: 3, value: positions },
          aOffset:   { size: 3, value: offsets },
        },
        vertexCount,
      }),
      isInstanced: true,
    });
  }
}

// ---------------------------------------------------------------------------
// AisHullBorderLayer
//
// Renders the hull polygon outline as a triangulated stroke with a
// configurable per-vessel RGBA colour.  Uses the same dead-reckoning maths
// as AisHullDecorationLayer so the border tracks the animated ghost hull.
// ---------------------------------------------------------------------------

const borderVs = /* glsl */`\
#version 300 es
#define SHADER_NAME ais-hull-border-vertex-shader

in vec3 positions;
in vec3 instancePositions;
in vec3 instancePositions64Low;
in float instanceSog;
in float instanceCog;
in float instanceHeading;
in float instanceRot;
in float instanceAgeAtUpload;
in float instanceLength;
in float instanceBeam;
in vec4 instanceBorderColor;   // unorm8 RGBA

out vec4 vColor;

void main(void) {
  float dt = min(instanceAgeAtUpload + aisHull.timeSinceUpload, aisHull.drCapSeconds);

  float dEast, dNorth;
  if (abs(instanceRot) > 1e-4) {
    float cogEnd = instanceCog + instanceRot * dt;
    float R      = instanceSog / instanceRot;
    dEast  = R * (cos(instanceCog) - cos(cogEnd));
    dNorth = R * (sin(cogEnd)      - sin(instanceCog));
  } else {
    dEast  = instanceSog * dt * sin(instanceCog);
    dNorth = instanceSog * dt * cos(instanceCog);
  }

  float safelen  = max(instanceLength, 1.0);
  float safebeam = max(instanceBeam,  1.0);
  float localX = positions.x * safebeam * 0.5;
  float localY = positions.y * safelen  * 0.5;

  float heading = instanceHeading + instanceRot * dt;
  float sinH = sin(heading);
  float cosH = cos(heading);
  float hullEast  = localY * sinH + localX * cosH;
  float hullNorth = localY * cosH - localX * sinH;

  geometry.worldPosition = instancePositions;
  vec3 offset = project_size(vec3(dEast + hullEast, dNorth + hullNorth, 0.0));

  vec4 worldPos;
  gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, offset, worldPos);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  if (project.projectionMode == PROJECTION_MODE_GLOBE &&
      dot(worldPos.xyz, project.cameraPosition) < 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  }

  // Same cross-fade as AisHullLayer — border fades in with the hull.
  float lat_rad = instancePositions.y * radians(1.0);
  float transitionZoom = log2(
    aisHull.settingsIconSize * 64.0 * 40075016.686 * cos(lat_rad) / (safelen * 256.0)
  );
  float t01 = clamp((aisHull.zoom - transitionZoom + 1.0) / 2.0, 0.0, 1.0);

  vColor = vec4(instanceBorderColor.rgb, instanceBorderColor.a * t01 * aisHull.opacity);
}
`;

const borderFs = /* glsl */`\
#version 300 es
precision highp float;
#define SHADER_NAME ais-hull-border-fragment-shader

in vec4 vColor;
out vec4 fragColor;

void main(void) {
  fragColor = vColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export interface AisHullBorderLayerProps<DataT = number> extends LayerProps {
  data: DataT[] | { length: number };
  getPosition?:     Accessor<DataT, [number, number] | [number, number, number]>;
  getSog?:          Accessor<DataT, number>;
  getCog?:          Accessor<DataT, number>;
  getHeading?:      Accessor<DataT, number>;
  getRot?:          Accessor<DataT, number>;
  getAgeAtUpload?:  Accessor<DataT, number>;
  getLength?:       Accessor<DataT, number>;
  getBeam?:         Accessor<DataT, number>;
  getBorderColor?:  Accessor<DataT, [number, number, number, number]>;
  uploadTimestamp?: number;
  selfAnimate?:     boolean;
  /** Minimum ms between animation redraws when selfAnimate is true. 0 = every frame. */
  animationIntervalMs?: number;
  settingsIconSize?: number;
  opacity?:         number;
  /** DR cap in seconds — border hull won't extrapolate beyond this. */
  drCapSeconds?: number;
}

const borderDefaultProps: DefaultProps<AisHullBorderLayerProps> = {
  getPosition:    { type: 'accessor', value: [0, 0] },
  getSog:         { type: 'accessor', value: 0 },
  getCog:         { type: 'accessor', value: 0 },
  getHeading:     { type: 'accessor', value: 0 },
  getRot:         { type: 'accessor', value: 0 },
  getAgeAtUpload: { type: 'accessor', value: 0 },
  getLength:      { type: 'accessor', value: 50 },
  getBeam:        { type: 'accessor', value: 10 },
  getBorderColor: { type: 'accessor', value: [0, 0, 0, 200] },
  uploadTimestamp:     0,
  selfAnimate:         false,
  animationIntervalMs: 0,
  settingsIconSize:    1,
  opacity:             1,
  drCapSeconds:        180,
};

export class AisHullBorderLayer<DataT = number>
  extends Layer<AisHullBorderLayerProps<DataT>>
{
  static override layerName = 'AisHullBorderLayer';
  static override defaultProps = borderDefaultProps;

  private _animateTimerId: ReturnType<typeof setTimeout> | null = null;

  override getShaders() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return super.getShaders({
      vs: borderVs,
      fs: borderFs,
      modules: [project32, aisHullUniformModule],
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
      instanceLength:      { size: 1, accessor: 'getLength',      defaultValue: 50 },
      instanceBeam:        { size: 1, accessor: 'getBeam',        defaultValue: 10 },
      instanceBorderColor: {
        size: 4,
        type: 'unorm8',
        accessor: 'getBorderColor',
        defaultValue: [0, 0, 0, 200],
      },
    });
  }

  override updateState(params: UpdateParameters<this>) {
    super.updateState(params);
    if (params.changeFlags.extensionsChanged) {
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
    const zoom = this.context.viewport.zoom;
    const model = this.state['model'] as Model;
    model.shaderInputs.setProps({
      aisHull: {
        timeSinceUpload,
        drCapSeconds: drCapSeconds ?? 180,
        zoom,
        settingsIconSize: settingsIconSize ?? 1,
        opacity: opacity,
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
    const { positions, vertexCount } = HULL_BORDER_OUTLINE;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- deck.gl's getShaders() returns any
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: { positions: { size: 3, value: positions } },
        vertexCount,
      }),
      isInstanced: true,
    });
  }
}
