/**
 * VesselIconLayer — custom deck.gl Layer that renders vessel arrow icons with GPU dead reckoning.
 *
 * Per-frame cost: only the `timeSinceUpload` and `zoom` uniforms change.
 * GPU buffers (position, heading, sog, cog, …) are uploaded once per AIS tick.
 *
 * The icon cross-fades with the hull: it fades OUT as zoom increases (hull fades IN).
 * Vessels without a known length (instanceLength == 0) skip cross-fading and are
 * always rendered at full opacity.
 *
 * Globe hemisphere discard matches AisHullLayer — far-side vessels are culled
 * before they can appear as mirrored ghosts through the globe.
 */

import { Layer, project32, picking } from '@deck.gl/core';
import type { LayerProps, UpdateParameters, DefaultProps, Accessor } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';

// ---------------------------------------------------------------------------
// Shader uniform module
// ---------------------------------------------------------------------------

const uniformBlock = /* glsl */`\
uniform aisIconUniforms {
  float timeSinceUpload;
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

// Per-vertex: arrow mesh in local space (bow = +Y, starboard = +X, range [-1, 1])
in vec3 positions;
// 1.0 = outline pass (white, larger), 0.0 = fill pass (vessel color, smaller)
in float aIsOutline;
// 1.0 = state indicator vertex (renders black in fill pass; white in outline pass)
in float aIsIndicator;

// Per-instance vessel data
in vec3 instancePositions;
in vec3 instancePositions64Low;
in float instanceSog;        // m/s
in float instanceCog;        // radians, north = 0, CW positive
in float instanceHeading;    // radians
in float instanceRot;        // rad/s
in float instanceAgeAtUpload;// seconds already elapsed when data was uploaded
in float instanceLength;     // metres; 0 = unknown → no cross-fade
in vec4 instanceColor;       // base RGBA [0..1]; alpha encodes ghost/confirmed opacity
in vec3 instancePickingColors;

out vec4 vColor;

void main(void) {
  // ------------------------------------------------------------------
  // 1. Dead-reckoning time delta
  // ------------------------------------------------------------------
  float dt = min(instanceAgeAtUpload + aisIcon.timeSinceUpload, 180.0);

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
  // 3. Scale arrow vertex to pixel size.
  //    Outline pass is slightly larger than fill pass (white ring effect).
  //    Sizes are computed in settingsIconSize units (1 unit = 64 px).
  // ------------------------------------------------------------------
  float fillSize    = aisIcon.settingsIconSize - 3.0 / 64.0;
  float outlineSize = aisIcon.settingsIconSize * 1.1 + 1.0 / 64.0;
  float effectiveSize = aIsOutline > 0.5 ? outlineSize : fillSize;
  float halfCommon = project_pixel_size(effectiveSize * 64.0) * 0.5;
  float localX = positions.x * halfCommon;
  float localY = positions.y * halfCommon;

  // ------------------------------------------------------------------
  // 4. Rotate arrow from local space (bow = +Y) into ENU-aligned common space
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
  // geometry.worldPosition must be set BEFORE project_size() — see AisHullLayer
  // for details on the Mercator latitude correction.
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
  // 6b. Far-hemisphere discard (globe mode) — see AisHullLayer for details.
  // ------------------------------------------------------------------
  if (project.projectionMode == PROJECTION_MODE_GLOBE &&
      dot(worldPos.xyz, project.cameraPosition) < 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  }

  // ------------------------------------------------------------------
  // 7. Cross-fade: icon fades OUT as zoom increases (hull fades IN).
  //    Mirrors the hull's transition formula but inverts the t01 factor.
  //    Vessels with instanceLength == 0 are always rendered at full alpha.
  //    Use fillSize for the transition zoom so the hull takes over cleanly.
  // ------------------------------------------------------------------
  float iconAlpha = instanceColor.a * aisIcon.opacity;
  if (instanceLength > 0.0) {
    float lat_rad = instancePositions.y * radians(1.0);
    float transitionZoom = log2(
      fillSize * 64.0 * 40075016.686 * cos(lat_rad) / (instanceLength * 256.0)
    );
    float t01 = clamp((aisIcon.zoom - transitionZoom + 1.0) / 2.0, 0.0, 1.0);
    iconAlpha *= (1.0 - t01);
  }

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
// ---------------------------------------------------------------------------
// Arrow mesh — double-pass: outline vertices first, fill vertices second.
// Within each instance the GPU renders outline first, then fill on top —
// giving each vessel its own painter's-algorithm border regardless of clusters.
//
// Shape: 6-point arrowhead with stern notch. Fan-triangulated from bow:
// 4 triangles × 3 vertices = 12 vertices per pass.
// Coordinates: bow = +Y, starboard = +X, normalised to [-1, 1].
// ---------------------------------------------------------------------------

const ARROW_SHAPE = [
  //  X        Y
   0.00,  1.000, 0.0,   // 1: bow
   0.50,  0.333, 0.0,   //    SB shoulder
   0.50, -0.750, 0.0,   //    SB aft
   0.00,  1.000, 0.0,   // 2: bow
   0.50, -0.750, 0.0,   //    SB aft
   0.00, -0.500, 0.0,   //    stern notch
   0.00,  1.000, 0.0,   // 3: bow
   0.00, -0.500, 0.0,   //    stern notch
  -0.50, -0.750, 0.0,   //    port aft
   0.00,  1.000, 0.0,   // 4: bow
  -0.50, -0.750, 0.0,   //    port aft
  -0.50,  0.333, 0.0,   //    port shoulder
];

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
  return v;
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

/**
 * Build an icon geometry with two passes (outline=white, fill=vessel-color) plus
 * optional indicator triangles that render black in the fill pass.
 *
 * Layout of the combined buffer:
 *   [base outline | indicator outline | base fill | indicator fill]
 *
 * aIsOutline:   1 for the first half, 0 for the second half.
 * aIsIndicator: 1 only for the indicator-fill slice.
 */
function buildIconGeometry(baseVerts: number[], indicatorVerts: number[] = []): IconGeometry {
  const bN    = baseVerts.length / 3;
  const iN    = indicatorVerts.length / 3;
  const passN = bN + iN;
  return {
    positions:   new Float32Array([...baseVerts, ...indicatorVerts,
                                   ...baseVerts, ...indicatorVerts]),
    isOutline:   new Float32Array([...Array<number>(passN).fill(1),
                                   ...Array<number>(passN).fill(0)]),
    isIndicator: new Float32Array([...Array<number>(passN).fill(0),   // outline pass: unused
                                   ...Array<number>(bN   ).fill(0),   // base fill: vessel color
                                   ...Array<number>(iN   ).fill(1)]), // indicator fill: black
    vertexCount: passN * 2,
  };
}

// ---------------------------------------------------------------------------
// Icon geometry types and presets
// ---------------------------------------------------------------------------

export interface IconGeometry {
  positions:   Float32Array;
  isOutline:   Float32Array;
  isIndicator: Float32Array;
  vertexCount: number;
}

/** Standard arrow — all vessels always get this. */
export const ARROW_GEOMETRY: IconGeometry = buildIconGeometry(ARROW_SHAPE);

/**
 * Anchor dot only — overlaid on the arrow for anchored vessels.
 * Black dot with white ring at bow position (Y=0.65), radius 0.18.
 * Rendered as a separate layer so motion rendering (ghost, COG) is unaffected.
 */
export const ANCHOR_DOT_GEOMETRY: IconGeometry = buildIconGeometry(
  [],
  circleVerts(0, 0.65, 0.18, 8),
);

/**
 * Circle ring around the vessel — overlaid for aground vessels.
 * Black 16-gon ring (outer r=1.55, inner r=1.35) surrounding the arrow shape.
 * Uses two concentric circles as a filled annulus approximation via triangle fans.
 */
export const AGROUND_CIRCLE_GEOMETRY: IconGeometry = (() => {
  const sides = 16;
  const outer = 1.55;
  const inner = 1.35;
  const verts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i       / sides) * 2 * Math.PI;
    const a1 = ((i + 1) / sides) * 2 * Math.PI;
    // Two triangles per segment forming the annulus band
    verts.push(
      inner * Math.sin(a0), inner * Math.cos(a0), 0,
      outer * Math.sin(a0), outer * Math.cos(a0), 0,
      outer * Math.sin(a1), outer * Math.cos(a1), 0,

      inner * Math.sin(a0), inner * Math.cos(a0), 0,
      outer * Math.sin(a1), outer * Math.cos(a1), 0,
      inner * Math.sin(a1), inner * Math.cos(a1), 0,
    );
  }
  return buildIconGeometry([], verts);
})();

/**
 * Mooring bars only — overlaid on the arrow for moored vessels.
 * Two black bars with white rings on port and starboard alongside the midsection.
 * Rendered as a separate layer so motion rendering (ghost, COG) is unaffected.
 */
export const MOORING_BARS_GEOMETRY: IconGeometry = buildIconGeometry(
  [],
  [
    ...rectVerts(-1.38, -0.55, -1.13, 0.22),  // port side bar
    ...rectVerts( 1.13, -0.55,  1.38, 0.22),  // starboard side bar
  ],
);

/**
 * Fishing gear — overlaid on the arrow for fishing vessels.
 * Two diagonal boom arms extending to port/starboard from midship, plus a trawl
 * net arc curving around the stern between the boom tips.
 *
 * Icon-space coordinates: bow=+Y, stern=−Y, starboard=+X, port=−X; scale ≈ 1.
 * Angles use hull convention: x=r·sin(a), y=r·cos(a); 180°=stern.
 * Arc center (0, 0.3), r≈1.7 connects boom tips via the stern at Y≈−1.4.
 */
export const FISHING_GEAR_GEOMETRY: IconGeometry = buildIconGeometry(
  [],
  [
    // Port boom: from (−0.8, 0.0) to (−1.5, −0.5)
    ...lineSeg(-0.8,  0.0, -1.5, -0.5, 0.08),
    // Starboard boom: mirror
    ...lineSeg( 0.8,  0.0,  1.5, -0.5, 0.08),
    // Trawl net arc: center (0, 0.3), r=1.7, from 242° to 118° via stern (180°)
    ...arcVerts(0, 0.3, 1.60, 1.78, 242, 118, 14),
  ],
);

/**
 * Not Under Command — overlaid on the arrow for NUC vessels (nav state 2).
 * Two black balls stacked vertically in the bow half of the icon.
 */
export const NUC_GEOMETRY: IconGeometry = buildIconGeometry(
  [],
  [
    ...circleVerts(0, 0.45, 0.15, 10),  // upper ball
    ...circleVerts(0, 0.10, 0.15, 10),  // lower ball
  ],
);

/**
 * Restricted Manoeuvrability — overlaid on the arrow for nav state 3.
 * Maritime dayshape: black ball / diamond / ball arranged vertically.
 */
export const RESTRICTED_MANOEUVRING_GEOMETRY: IconGeometry = buildIconGeometry(
  [],
  [
    ...circleVerts(0, 0.57, 0.13, 10),      // top ball
    ...diamondVerts(0, 0.15, 0.17, 0.17),   // middle diamond
    ...circleVerts(0, -0.28, 0.13, 10),     // bottom ball
  ],
);

/**
 * Constrained by Draught — overlaid on the arrow for nav state 4.
 * Two full-length bars along port and starboard, indicating the vessel fills
 * the navigable channel (cannot safely deviate laterally from its track).
 */
export const DRAUGHT_GEOMETRY: IconGeometry = buildIconGeometry(
  [],
  [
    ...rectVerts(-1.00, -0.80, -0.75, 0.85),  // port side full-length bar
    ...rectVerts( 0.75, -0.80,  1.00, 0.85),  // starboard side full-length bar
  ],
);

/**
 * MOB / AIS-SART — replaces the vessel arrow for nav state 14.
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
  return buildIconGeometry(disc, swimmer);
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
  /** Vessel length in metres. 0 = unknown → icon always visible, no cross-fade. */
  getLength?:      Accessor<DataT, number>;
  getColor?:       Accessor<DataT, [number, number, number, number]>;
  /** Custom icon geometry. Defaults to the standard arrow. */
  iconGeometry?: IconGeometry;
  /** Unix ms timestamp of the last data upload. draw() computes elapsed from this. */
  uploadTimestamp?: number;
  /** If true, draw() calls setNeedsRedraw() to keep animating each frame. */
  selfAnimate?: boolean;
  /** Minimum ms between animation redraws when selfAnimate is true. 0 = every frame. */
  animationIntervalMs?: number;
  settingsIconSize?: number;
  opacity?:         number;
}

const defaultProps: DefaultProps<VesselIconLayerProps<number>> = {
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
};

// ---------------------------------------------------------------------------
// Layer class
// ---------------------------------------------------------------------------

export class VesselIconLayer<DataT = number> extends Layer<VesselIconLayerProps<DataT>> {
  static override layerName = 'VesselIconLayer';
  static override defaultProps = defaultProps;

  private _animateTimerId: ReturnType<typeof setTimeout> | null = null;

  override getShaders() {
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
    const { uploadTimestamp, selfAnimate, animationIntervalMs, settingsIconSize, opacity } = this.props;
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
        zoom,
        settingsIconSize: settingsIconSize ?? 1,
        opacity:         opacity         ?? 1,
      },
    });
    model.draw(this.context.renderPass);
    if (selfAnimate) {
      const intervalMs = animationIntervalMs ?? 0;
      if (intervalMs <= 17) {
        // Native fps: request next frame immediately.
        this.setNeedsRedraw();
      } else if (this._animateTimerId === null) {
        // Throttled: schedule next redraw after interval, then let rAF fire draw().
        this._animateTimerId = setTimeout(() => {
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
    const geo = this.props.iconGeometry ?? ARROW_GEOMETRY;
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions:    { size: 3, value: geo.positions },
          aIsOutline:   { size: 1, value: geo.isOutline },
          aIsIndicator: { size: 1, value: geo.isIndicator },
        },
        vertexCount: geo.vertexCount,
      }),
      isInstanced: true,
    });
  }
}
