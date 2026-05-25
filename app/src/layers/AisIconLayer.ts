/**
 * AisIconLayer — custom deck.gl Layer that renders vessel arrow icons with GPU dead reckoning.
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
import type { AisTarget } from '../stores/ais.svelte';

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
  // In globe mode, project_position_to_clipspace applies orientation matrix
  // mat3(-East, -North, up), which inverts both ENU axes. Negate the total
  // offset here so the net result after the orientation matrix is correct.
  // In mercator mode project_needs_rotation() returns false and no rotation
  // is applied, so the un-negated offset is used as-is.
  // ------------------------------------------------------------------
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
  geometry.worldPosition = instancePositions;

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

  // Outline pass → white; fill pass → vessel color. Both share the same iconAlpha.
  vec3 rgb = aIsOutline > 0.5 ? vec3(1.0) : instanceColor.rgb;
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
// Arrow mesh — double-pass: outline vertices first, fill vertices second.
// Within each instance the GPU renders outline first, then fill on top —
// giving each vessel its own painter's-algorithm border regardless of clusters.
//
// Shape: 6-point arrowhead with stern notch (matches drawVesselArrow() in
// deadReckoning.ts). Fan-triangulated from bow: 4 triangles × 3 vertices = 12.
// Coordinates: bow = +Y, starboard = +X, normalised to [-1, 1].
// ---------------------------------------------------------------------------

const ARROW_SHAPE = [
  //  X        Y
   0.00,  1.000, 0.0,   // 1: bow
   1.00,  0.333, 0.0,   //    SB shoulder
   1.00, -0.750, 0.0,   //    SB aft
   0.00,  1.000, 0.0,   // 2: bow
   1.00, -0.750, 0.0,   //    SB aft
   0.00, -0.500, 0.0,   //    stern notch
   0.00,  1.000, 0.0,   // 3: bow
   0.00, -0.500, 0.0,   //    stern notch
  -1.00, -0.750, 0.0,   //    port aft
   0.00,  1.000, 0.0,   // 4: bow
  -1.00, -0.750, 0.0,   //    port aft
  -1.00,  0.333, 0.0,   //    port shoulder
];

// Outline pass first (aIsOutline = 1), fill pass second (aIsOutline = 0).
// Fill always paints on top of its own outline within the same instance.
const ICON_POSITIONS = new Float32Array([...ARROW_SHAPE, ...ARROW_SHAPE]);
const VERTEX_COUNT   = 24;
const IS_OUTLINE     = new Float32Array([
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,   // outline pass
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,   // fill pass
]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AisIconLayerProps extends LayerProps {
  data: AisTarget[];
  getPosition?:    Accessor<AisTarget, [number, number] | [number, number, number]>;
  getSog?:         Accessor<AisTarget, number>;
  getCog?:         Accessor<AisTarget, number>;
  getHeading?:     Accessor<AisTarget, number>;
  getRot?:         Accessor<AisTarget, number>;
  getAgeAtUpload?: Accessor<AisTarget, number>;
  /** Vessel length in metres. 0 = unknown → icon always visible, no cross-fade. */
  getLength?:      Accessor<AisTarget, number>;
  getColor?:       Accessor<AisTarget, [number, number, number, number]>;
  /** Unix ms timestamp of the last data upload. draw() computes elapsed from this. */
  uploadTimestamp?: number;
  /** If true, draw() calls setNeedsRedraw() to keep animating each frame. */
  selfAnimate?: boolean;
  settingsIconSize?: number;
  opacity?:         number;
}

const defaultProps: DefaultProps<AisIconLayerProps> = {
  getPosition:    { type: 'accessor', value: [0, 0] },
  getSog:         { type: 'accessor', value: 0 },
  getCog:         { type: 'accessor', value: 0 },
  getHeading:     { type: 'accessor', value: 0 },
  getRot:         { type: 'accessor', value: 0 },
  getAgeAtUpload: { type: 'accessor', value: 0 },
  getLength:      { type: 'accessor', value: 0 },
  getColor:       { type: 'accessor', value: [255, 255, 255, 255] },
  uploadTimestamp:  0,
  selfAnimate:      false,
  settingsIconSize: 1,
  opacity:          1,
};

// ---------------------------------------------------------------------------
// Layer class
// ---------------------------------------------------------------------------

export class AisIconLayer extends Layer<AisIconLayerProps> {
  static override layerName = 'AisIconLayer';
  static override defaultProps = defaultProps;

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
    const { uploadTimestamp, selfAnimate, settingsIconSize, opacity } = this.props;
    const timeSinceUpload = selfAnimate
      ? Math.max(0, (Date.now() - (uploadTimestamp ?? 0)) / 1000)
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
    if (selfAnimate) this.setNeedsRedraw();
  }

  _getModel() {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions:  { size: 3, value: ICON_POSITIONS },
          aIsOutline: { size: 1, value: IS_OUTLINE },
        },
        vertexCount: VERTEX_COUNT,
      }),
      isInstanced: true,
    });
  }
}
