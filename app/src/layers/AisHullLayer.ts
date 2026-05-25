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
  /** Unix ms timestamp of the last data upload. draw() computes elapsed from this. */
  uploadTimestamp?: number;
  /** If true, draw() calls setNeedsRedraw() to keep animating each frame. */
  selfAnimate?: boolean;
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
  uploadTimestamp: 0,
  selfAnimate: false,
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
    const { uploadTimestamp, selfAnimate, zoom, settingsIconSize, opacity } = this.props;
    // Compute elapsed time in draw() so the uniform changes every frame without
    // creating new layer instances or triggering prop reconciliation.
    const timeSinceUpload = selfAnimate
      ? Math.max(0, (Date.now() - (uploadTimestamp ?? 0)) / 1000)
      : 0;
    const model = this.state['model'] as Model;
    model.shaderInputs.setProps({
      aisHull: {
        timeSinceUpload,
        zoom: zoom ?? 10,
        settingsIconSize: settingsIconSize ?? 1,
        opacity: opacity ?? 1,
      },
    });
    model.draw(this.context.renderPass);
    // Self-drive the animation loop: signal deck.gl that this layer needs another
    // frame without any external setProps() call.
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
          positions: { size: 3, value: HULL_POSITIONS },
        },
        vertexCount: VERTEX_COUNT,
      }),
      isInstanced: true,
    });
  }
}
