/**
 * VesselIconLayer — custom deck.gl Layer that renders a fixed-pixel vessel icon with GPU
 * dead reckoning.
 *
 * MOB/AIS-SART ONLY. Every other nav-state (the plain arrow, anchored, moored, aground,
 * fishing, NUC, restricted, draught) is now rendered by VesselMorphLayer, which morphs
 * continuously between the icon silhouette and the real-world hull polygon as you zoom —
 * see that file's header for why. MOB has no hull counterpart (a person overboard or a
 * SART beacon has no AIS-reported length/beam) and always stays icon-only at a constant
 * screen size, exactly like a real chart plotter's MOB marker — so it keeps this simpler,
 * single-shape layer with no morph.
 *
 * Per-frame cost: only the `timeSinceUpload` and `zoom` uniforms change.
 * GPU buffers (position, heading, sog, cog, …) are uploaded once per AIS tick.
 */

import { Layer, project32, picking } from '@deck.gl/core';
import type { LayerProps, UpdateParameters, DefaultProps, Accessor } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';
import { ccwTriangleList } from './triangleWinding';

// ---------------------------------------------------------------------------
// Shader uniform module
// ---------------------------------------------------------------------------

const uniformBlock = /* glsl */`\
uniform aisIconUniforms {
  float timeSinceUpload;
  float drCapSeconds;
  float zoom;
  float settingsIconSize;
  float opacity;
} aisIcon;
`;

const aisIconUniformModule = {
  name: 'aisIcon',
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
#define SHADER_NAME ais-icon-layer-vertex-shader

// Per-vertex: icon mesh in local space (bow = +Y, starboard = +X, range [-1, 1])
in vec3 positions;
// 1.0 = outline pass (white, larger), 0.0 = fill pass (vessel color, smaller)
in float aIsOutline;
// 1.0 = state indicator vertex (renders black in fill pass; white in outline pass)
in float aIsIndicator;
// 1.0 = vertex belongs to an indicator/overlay shape (the MOB swimmer) in EITHER pass —
// pins the GPU scale to fillSize so it is never grown from the icon's local origin (see
// buildIconGeometry doc comment for why that would displace it).
in float aIsIndicatorShape;

// Per-instance vessel data
in vec3 instancePositions;
in vec3 instancePositions64Low;
in float instanceSog;        // m/s
in float instanceCog;        // radians, north = 0, CW positive
in float instanceHeading;    // radians
in float instanceRot;        // rad/s
in float instanceAgeAtUpload;// seconds already elapsed when data was uploaded
in float instanceLength;     // metres; always 0 for MOB → always full opacity, never fades
in vec4 instanceColor;       // base RGBA [0..1]; alpha encodes ghost/confirmed opacity
in vec3 instancePickingColors;

out vec4 vColor;

void main(void) {
  // ------------------------------------------------------------------
  // 1. Dead-reckoning time delta
  // ------------------------------------------------------------------
  float dt = min(instanceAgeAtUpload + aisIcon.timeSinceUpload, aisIcon.drCapSeconds);

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

  // ------------------------------------------------------------------
  // 3. Scale icon vertex to pixel size.
  //    Outline pass is slightly larger than fill pass (white ring effect).
  //    Indicator/overlay shapes are pinned to fillSize regardless of pass — their own
  //    outline-pass vertices already encode a small ring grown around their own centroid
  //    on the CPU (see growRect/growCircle/… ), so the GPU must not also scale them from
  //    the icon's local origin or the ring displaces into a visibly separate shape.
  //    Sizes are computed in settingsIconSize units (1 unit = 64 px).
  // ------------------------------------------------------------------
  float fillSize    = aisIcon.settingsIconSize - 3.0 / 64.0;
  float outlineSize = aisIcon.settingsIconSize * 1.1 + 1.0 / 64.0;
  float effectiveSize = (aIsOutline > 0.5 && aIsIndicatorShape < 0.5) ? outlineSize : fillSize;
  float halfCommon = project_pixel_size(effectiveSize * 64.0) * 0.5;
  float localX = positions.x * halfCommon;
  float localY = positions.y * halfCommon;

  // ------------------------------------------------------------------
  // 4. Rotate icon from local space (bow = +Y) into ENU-aligned common space
  //    using the dead-reckoned heading.
  // ------------------------------------------------------------------
  float heading = instanceHeading + instanceRot * dt;
  float sinH = sin(heading);
  float cosH = cos(heading);
  float iconCommonX = localY * sinH + localX * cosH;  // East component
  float iconCommonY = localY * cosH - localX * sinH;  // North component

  // ------------------------------------------------------------------
  // 5. Total offset: DR movement (metres → common) + rotated icon corner
  //
  // geometry.worldPosition must be set BEFORE project_size() for the Mercator latitude
  // correction (1/cos(lat)) to use the vessel's actual latitude.
  //
  // In globe mode, project_position_to_clipspace applies orientation matrix
  // mat3(-East, -North, up), which inverts both ENU axes. Negate the total
  // offset here so the net result after the orientation matrix is correct.
  // In mercator mode project_needs_rotation() returns false and no rotation
  // is applied, so the un-negated offset is used as-is.
  // ------------------------------------------------------------------
  geometry.worldPosition = instancePositions;
  vec3 drCommon    = project_size(vec3(dEast, dNorth, 0.0));
  vec3 totalOffset = drCommon + vec3(iconCommonX, iconCommonY, 0.0);
  if (project.projectionMode == PROJECTION_MODE_GLOBE) {
    totalOffset = -totalOffset;
  }

  // ------------------------------------------------------------------
  // 6. Project anchor + offset to clip space
  // ------------------------------------------------------------------
  vec4 worldPos;
  gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, totalOffset, worldPos);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  // ------------------------------------------------------------------
  // 6b. Far hemisphere (globe mode): handled by GlobeView's default backface
  //     culling — all triangles are CCW by construction (ccwTriangleList,
  //     pinned by geometryWinding.test.ts). Mirrors VesselMorphLayer.
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 7. instanceLength is always 0 for MOB, so there is no cross-fade here — the icon is
  //    always rendered at full alpha, exactly like a real chart plotter's MOB marker.
  // ------------------------------------------------------------------
  float iconAlpha = instanceColor.a * aisIcon.opacity;

  // Outline pass → halfway between vessel color and white (dark vessels) or black (bright vessels).
  // fill pass → black for state indicators, vessel color otherwise.
  float luma = dot(instanceColor.rgb, vec3(0.299, 0.587, 0.114));
  vec3 outlineTarget = luma < 0.5 ? vec3(1.0) : vec3(0.0);
  vec3 outlineColor  = mix(instanceColor.rgb, outlineTarget, 0.5);
  vec3 rgb = aIsOutline > 0.5 ? outlineColor : (aIsIndicator > 0.5 ? vec3(0.0) : instanceColor.rgb);
  vColor = vec4(rgb, iconAlpha);

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
#define SHADER_NAME ais-icon-layer-fragment-shader

in vec4 vColor;
out vec4 fragColor;

void main(void) {
  fragColor = vColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

// ---------------------------------------------------------------------------
// Icon geometry helpers
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
  return ccwTriangleList(v);
}

function rectVerts(x0: number, y0: number, x1: number, y1: number): number[] {
  return ccwTriangleList([x0, y0, 0,  x1, y0, 0,  x1, y1, 0,
                          x0, y0, 0,  x1, y1, 0,  x0, y1, 0]);
}

function lineSeg(x0: number, y0: number, x1: number, y1: number, halfWidth: number): number[] {
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

/** Upper semicircle (bump pointing +Y) fan from center — used for wave crests. */
function waveBumpVerts(cx: number, cy: number, r: number, sides: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = -Math.PI / 2 + (Math.PI * i)       / sides;
    const a1 = -Math.PI / 2 + (Math.PI * (i + 1)) / sides;
    v.push(cx, cy, 0,
           cx + r * Math.sin(a0), cy + r * Math.cos(a0), 0,
           cx + r * Math.sin(a1), cy + r * Math.cos(a1), 0);
  }
  return ccwTriangleList(v);
}

/**
 * Build an icon geometry with two passes (outline=halo, fill=vessel-color/indicator-black)
 * plus optional indicator triangles that render black in the fill pass.
 *
 * The outline pass for the BASE shape (MOB's disc) is grown by the icon's global
 * zoom-dependent scale in the vertex shader — correct because the disc is centered on the
 * icon's local origin, so scaling from the origin grows it symmetrically about itself.
 *
 * The indicator shape (the swimmer) is NOT centered on the icon's origin. Scaling it from
 * the origin would shift the whole shape outward by (distance × scale delta) rather than
 * growing it about its own centroid, which reads as a second, displaced shape once that
 * shift exceeds the shape's own half-size. So the indicator outline vertices are supplied
 * separately — pre-grown around the swimmer's own centroid by the helpers below — and
 * pinned to the fill-pass GPU scale via aIsIndicatorShape, so the global zoom-dependent
 * scale never touches them.
 *
 * Layout of the combined buffer:
 *   [base outline | indicator outline | base fill | indicator fill]
 *
 * aIsOutline:        1 for the first half, 0 for the second half.
 * aIsIndicator:      1 only for the indicator-fill slice (renders black).
 * aIsIndicatorShape: 1 for every indicator vertex in BOTH halves (pins GPU scale to fillSize
 *                    regardless of aIsOutline, so the indicator shape never gets origin-scaled).
 *
 * `indicatorOutlineVerts` must have the same vertex count as `indicatorVerts` (each grow*
 * helper below preserves vertex count/order, only moving coordinates) — defaults to
 * `indicatorVerts` unchanged, i.e. no ring, for indicator shapes close enough to the
 * origin that none is needed.
 */
function buildIconGeometry(
  baseVerts: number[],
  indicatorVerts: number[] = [],
  indicatorOutlineVerts: number[] = indicatorVerts,
): IconGeometry {
  const bN    = baseVerts.length / 3;
  const iN    = indicatorVerts.length / 3;
  const passN = bN + iN;
  return {
    positions:   new Float32Array([...baseVerts, ...indicatorOutlineVerts,
                                   ...baseVerts, ...indicatorVerts]),
    isOutline:   new Float32Array([...Array<number>(passN).fill(1),
                                   ...Array<number>(passN).fill(0)]),
    isIndicator: new Float32Array([...Array<number>(passN).fill(0),   // outline pass: unused
                                   ...Array<number>(bN   ).fill(0),   // base fill: vessel color
                                   ...Array<number>(iN   ).fill(1)]), // indicator fill: black
    isIndicatorShape: new Float32Array([...Array<number>(bN).fill(0), ...Array<number>(iN).fill(1),  // outline pass
                                        ...Array<number>(bN).fill(0), ...Array<number>(iN).fill(1)]), // fill pass
    vertexCount: passN * 2,
  };
}

/** Local-unit half-width growth applied to the swimmer's outline ring (see buildIconGeometry). */
const RING_MARGIN = 0.05;

function growRect(x0: number, y0: number, x1: number, y1: number, m = RING_MARGIN): number[] {
  return rectVerts(x0 - m, y0 - m, x1 + m, y1 + m);
}
function growCircle(cx: number, cy: number, r: number, sides: number, m = RING_MARGIN): number[] {
  return circleVerts(cx, cy, r + m, sides);
}
function growLineSeg(x0: number, y0: number, x1: number, y1: number, halfWidth: number, m = RING_MARGIN): number[] {
  return lineSeg(x0, y0, x1, y1, halfWidth + m);
}
function growWaveBump(cx: number, cy: number, r: number, sides: number, m = RING_MARGIN): number[] {
  return waveBumpVerts(cx, cy, r + m, sides);
}

// ---------------------------------------------------------------------------
// Icon geometry types and presets
// ---------------------------------------------------------------------------

export interface IconGeometry {
  positions:        Float32Array;
  isOutline:         Float32Array;
  isIndicator:       Float32Array;
  isIndicatorShape:  Float32Array;
  vertexCount:       number;
}

/**
 * MOB / AIS-SART — the only nav-state still rendered by this layer.
 * A red disc (base geometry, rendered in instanceColor → set to bright red in the
 * layer) with a black swimmer silhouette (indicator geometry) on top.
 *
 * The swimmer: head circle at bow end, arms spread wide, torso, and a water
 * band with two wave crests at the stern end of the icon.
 */
export const MOB_GEOMETRY: IconGeometry = (() => {
  const disc = circleVerts(0, 0, 1.10, 16);
  const swimmer = [
    ...circleVerts(0, 0.62, 0.20, 12),             // head
    ...lineSeg(-0.19, 0.32, -0.78, 0.50, 0.08),   // left arm
    ...lineSeg( 0.19, 0.32,  0.78, 0.50, 0.08),   // right arm
    ...rectVerts(-0.15, -0.30, 0.15, 0.32),        // torso
    ...waveBumpVerts(-0.42, -0.55, 0.18, 8),       // left wave crest
    ...waveBumpVerts( 0.42, -0.55, 0.18, 8),       // right wave crest
    ...rectVerts(-0.83, -0.80, 0.83, -0.55),       // water band below crests
  ];
  const swimmerOutline = [
    ...growCircle(0, 0.62, 0.20, 12),
    ...growLineSeg(-0.19, 0.32, -0.78, 0.50, 0.08),
    ...growLineSeg( 0.19, 0.32,  0.78, 0.50, 0.08),
    ...growRect(-0.15, -0.30, 0.15, 0.32),
    ...growWaveBump(-0.42, -0.55, 0.18, 8),
    ...growWaveBump( 0.42, -0.55, 0.18, 8),
    ...growRect(-0.83, -0.80, 0.83, -0.55),
  ];
  return buildIconGeometry(disc, swimmer, swimmerOutline);
})();

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VesselIconLayerProps<DataT = number> extends LayerProps {
  data: DataT[] | { length: number };
  getPosition?:    Accessor<DataT, [number, number] | [number, number, number]>;
  getSog?:         Accessor<DataT, number>;
  getCog?:         Accessor<DataT, number>;
  getHeading?:     Accessor<DataT, number>;
  getRot?:         Accessor<DataT, number>;
  getAgeAtUpload?: Accessor<DataT, number>;
  /** Vessel length in metres. Always 0 for MOB — no hull, no cross-fade, always full opacity. */
  getLength?:      Accessor<DataT, number>;
  getColor?:       Accessor<DataT, [number, number, number, number]>;
  /** Custom icon geometry. Defaults to MOB_GEOMETRY (the only geometry this layer renders). */
  iconGeometry?: IconGeometry;
  /** Unix ms timestamp of the last data upload. draw() computes elapsed from this. */
  uploadTimestamp?: number;
  /** If true, draw() calls setNeedsRedraw() to keep animating each frame. */
  selfAnimate?: boolean;
  /** Minimum ms between animation redraws when selfAnimate is true. 0 = every frame. */
  animationIntervalMs?: number;
  settingsIconSize?: number;
  opacity?:         number;
  /** DR cap in seconds — ghost icon won't extrapolate beyond this. Defaults to cogLengthMinutes*60. */
  drCapSeconds?: number;
}

const defaultProps: DefaultProps<VesselIconLayerProps> = {
  // NOTE: no cullMode override — GlobeView's default backface culling is
  // load-bearing (it hides the far hemisphere); geometry must stay CCW.
  // See triangleWinding.ts and geometryWinding.test.ts.
  getPosition:    { type: 'accessor', value: [0, 0] },
  getSog:         { type: 'accessor', value: 0 },
  getCog:         { type: 'accessor', value: 0 },
  getHeading:     { type: 'accessor', value: 0 },
  getRot:         { type: 'accessor', value: 0 },
  getAgeAtUpload: { type: 'accessor', value: 0 },
  getLength:      { type: 'accessor', value: 0 },
  getColor:       { type: 'accessor', value: [255, 255, 255, 255] },
  uploadTimestamp:  0,
  selfAnimate:         false,
  animationIntervalMs: 0,
  settingsIconSize: 1,
  opacity:          1,
  drCapSeconds:     180,
};

// ---------------------------------------------------------------------------
// Layer class
// ---------------------------------------------------------------------------

export class VesselIconLayer<DataT = number> extends Layer<VesselIconLayerProps<DataT>> {
  static override layerName = 'VesselIconLayer';
  static override defaultProps = defaultProps;

  private _animateTimerId: ReturnType<typeof setTimeout> | null = null;

  override getShaders() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return super.getShaders({
      vs, fs,
      modules: [project32, picking, aisIconUniformModule],
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
      params.props.iconGeometry !== params.oldProps.iconGeometry;
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
      aisIcon: {
        timeSinceUpload,
        drCapSeconds: drCapSeconds ?? 180,
        zoom,
        settingsIconSize: settingsIconSize ?? 1,
        opacity:         opacity,
      },
    });
    model.draw(this.context.renderPass);
    if (selfAnimate) {
      const intervalMs = animationIntervalMs ?? 0;
      if (intervalMs <= 17) {
        // Native fps: request next frame immediately.
        this.setNeedsRedraw();
      } else {
        // Throttled: schedule next redraw after interval, then let rAF fire draw().
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
    const geo = this.props.iconGeometry ?? MOB_GEOMETRY;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- deck.gl's getShaders() returns any
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions:        { size: 3, value: geo.positions },
          aIsOutline:       { size: 1, value: geo.isOutline },
          aIsIndicator:     { size: 1, value: geo.isIndicator },
          aIsIndicatorShape:{ size: 1, value: geo.isIndicatorShape },
        },
        vertexCount: geo.vertexCount,
      }),
      isInstanced: true,
    });
  }
}
