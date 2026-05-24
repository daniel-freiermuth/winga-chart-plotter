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
import type { AisTarget } from '../stores/ais.svelte';

// ---------------------------------------------------------------------------
// Shader uniform module
// ---------------------------------------------------------------------------

const uniformBlock = /* glsl */`\
uniform aisHullUniforms {
  float timeSinceUpload;
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
  float dt = min(instanceAgeAtUpload + aisHull.timeSinceUpload, 180.0);

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
  // ------------------------------------------------------------------
  vec3 offset = project_size(vec3(dEast + hullEast, dNorth + hullNorth, 0.0));

  // ------------------------------------------------------------------
  // 6. Project to clip space
  // ------------------------------------------------------------------
  vec4 worldPos;
  gl_Position = project_position_to_clipspace(instancePositions, instancePositions64Low, offset, worldPos);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  geometry.worldPosition = instancePositions;

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
// 5 vertices → 3 triangles → 9 positions
const HULL_POSITIONS = new Float32Array([
  //  X     Y      Z       triangle
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

export interface AisHullLayerProps extends LayerProps {
  data: AisTarget[];
  getPosition?: Accessor<AisTarget, [number, number] | [number, number, number]>;
  getSog?: Accessor<AisTarget, number>;
  getCog?: Accessor<AisTarget, number>;
  getHeading?: Accessor<AisTarget, number>;
  getRot?: Accessor<AisTarget, number>;
  getAgeAtUpload?: Accessor<AisTarget, number>;
  getLength?: Accessor<AisTarget, number>;
  getBeam?: Accessor<AisTarget, number>;
  getColor?: Accessor<AisTarget, [number, number, number, number]>;
  timeSinceUpload?: number;
  zoom?: number;
  settingsIconSize?: number;
  opacity?: number;
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
  timeSinceUpload: 0,
  zoom: 10,
  settingsIconSize: 1,
  opacity: 1,
};

// ---------------------------------------------------------------------------
// Layer class
// ---------------------------------------------------------------------------

export class AisHullLayer extends Layer<AisHullLayerProps> {
  static override layerName = 'AisHullLayer';
  static override defaultProps = defaultProps;

  override getShaders() {
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
    const { timeSinceUpload, zoom, settingsIconSize, opacity } = this.props;
    const model = this.state['model'] as Model;
    model.shaderInputs.setProps({
      aisHull: {
        timeSinceUpload: timeSinceUpload ?? 0,
        zoom: zoom ?? 10,
        settingsIconSize: settingsIconSize ?? 1,
        opacity: opacity ?? 1,
      },
    });
    model.draw(this.context.renderPass);
  }

  _getModel() {
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
