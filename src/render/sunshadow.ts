// Cascaded shadow maps for the sun.
//
// Three depth-only passes over the casters, fitted to three slices of the view
// frustum, sampled by the terrain and building shaders. Nothing here goes
// through three.js's own shadow system: every material in this renderer is a
// RawShaderMaterial, into which three injects no shadow chunks at all, so the
// maps, the matrices and the sampling are ours.
//
// Two decisions carry the quality.
//
// **A bounding SPHERE per cascade, not a box.** A box fitted to the frustum
// slice changes size and orientation as the camera yaws, so every shadow edge
// in the frame re-quantises against a different texel grid on every frame and
// the whole city crawls. A sphere's radius depends only on the split distances
// and the field of view, so it is constant, and that constant is what makes
// texel snapping possible at all.
//
// **The ortho camera starts well up-sun of the slice.** A shadow caster does
// not have to be visible: a 380 m tower a kilometre behind you still lays its
// shadow across the street in front of you, and the only way it can is if the
// light frustum reaches far enough back along the sun direction to contain it.

import * as THREE from "three";
import type { Budget } from "./budget";

/**
 * Meshes that cast sun shadows live on this layer as well as layer 0.
 *
 * Always `layers.enable`, never `layers.set` -- `set` would take a mesh off
 * layer 0 and the main camera would stop drawing it entirely.
 */
export const SHADOW_CASTER_LAYER = 2;

/** View distance, in metres, where each cascade ends. */
const CASCADE_FAR = [350, 1400, 6000] as const;

/**
 * How far up-sun of the slice the light camera sits, in metres. This is the
 * height of the tallest thing that can cast INTO a cascade from outside it;
 * Burj Khalifa is 828 m, so 3 km is generous even for a low sun.
 */
const BACKOFF_M = 3000;

/** How many cascades, innermost first, the `extra` casters are drawn into. */
const EXTRA_CASTER_CASCADES = 2;

/** Sine of the sun altitude below which shadows are off. ~1.1 degrees. */
const SUN_MIN_Y = 0.02;
/** Fully on by this sun altitude. ~3.4 degrees. */
const SUN_FULL_Y = 0.06;

export interface SunShadowUniforms extends Record<string, THREE.IUniform> {
  uShadowMap0: THREE.IUniform<THREE.Texture | null>;
  uShadowMap1: THREE.IUniform<THREE.Texture | null>;
  uShadowMap2: THREE.IUniform<THREE.Texture | null>;
  uShadowMat0: THREE.IUniform<THREE.Matrix4>;
  uShadowMat1: THREE.IUniform<THREE.Matrix4>;
  uShadowMat2: THREE.IUniform<THREE.Matrix4>;
  /** Far view distance of each cascade, in metres. */
  uCascadeFar: THREE.IUniform<THREE.Vector3>;
  /**
   * World metres one shadow texel covers, per cascade. The bias is expressed in
   * texels rather than in metres, because a cascade covering 14 km of city per
   * map needs ~17x the slack of one covering 850 m.
   */
  uCascadeTexelWorld: THREE.IUniform<THREE.Vector3>;
  /** Metres the ortho depth range spans, per cascade, for converting bias to depth units. */
  uCascadeDepth: THREE.IUniform<THREE.Vector3>;
  uShadowTexel: THREE.IUniform<number>;
  uShadowStrength: THREE.IUniform<number>;
}

/**
 * The sampling half, shared by every shader that wants sun shadows.
 *
 * Interpolated into terrain.ts and buildings.ts the way TONEMAP_GLSL and
 * ATMOSPHERE_GLSL are: one implementation, so the two cannot drift apart.
 */
export const SUN_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadowMap0;
uniform sampler2D uShadowMap1;
uniform sampler2D uShadowMap2;
uniform mat4  uShadowMat0;
uniform mat4  uShadowMat1;
uniform mat4  uShadowMat2;
uniform vec3  uCascadeFar;
uniform vec3  uCascadeTexelWorld;
uniform vec3  uCascadeDepth;
uniform float uShadowTexel;
uniform float uShadowStrength;

// Bias constants, in units of ONE SHADOW TEXEL's world size. Expressing them
// this way is what lets one set of numbers serve a 0.4 m/texel cascade and a
// 7 m/texel one.
//
// The offset is applied along the NORMAL rather than only along the light,
// which is what handles the hard case here: a flat roof under a grazing sun.
// The depth across a texel then changes by texelWorld * tan(angle), which for a
// sun 5 degrees up is ten times the texel size, and no pure depth bias small
// enough to keep the wing of a shadow attached is large enough to stop that
// acneing. Moving the sample off the surface sidesteps the whole problem.
const float SHADOW_NORMAL_OFFSET = 1.5;
const float SHADOW_SLOPE_OFFSET  = 4.5;
const float SHADOW_DEPTH_BIAS    = 1.0;
const float SHADOW_SLOPE_BIAS    = 3.0;

/** 3x3 PCF. sp is the shadow-map coordinate in 0..1, bias in depth units. */
float shadowPcf(int c, vec3 sp, float bias) {
  float lit = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uShadowTexel;
      float d;
      // GLSL ES 3.0 will not index an array of samplers dynamically, so the
      // cascade choice has to be a branch.
      if (c == 0)      d = texture(uShadowMap0, sp.xy + o).r;
      else if (c == 1) d = texture(uShadowMap1, sp.xy + o).r;
      else             d = texture(uShadowMap2, sp.xy + o).r;
      lit += (sp.z - bias > d) ? 0.0 : 1.0;
    }
  }
  return lit * (1.0 / 9.0);
}

float cascadeVisibility(int c, vec3 worldPos, vec3 normal, vec3 sunDir) {
  float texelWorld = c == 0 ? uCascadeTexelWorld.x : (c == 1 ? uCascadeTexelWorld.y : uCascadeTexelWorld.z);
  float depthRange = c == 0 ? uCascadeDepth.x     : (c == 1 ? uCascadeDepth.y     : uCascadeDepth.z);

  float ndl = clamp(dot(normal, sunDir), 0.0, 1.0);
  vec3 p = worldPos + normal * texelWorld * (SHADOW_NORMAL_OFFSET + SHADOW_SLOPE_OFFSET * (1.0 - ndl));

  vec4 sc = c == 0 ? uShadowMat0 * vec4(p, 1.0)
          : (c == 1 ? uShadowMat1 * vec4(p, 1.0) : uShadowMat2 * vec4(p, 1.0));
  vec3 sp = sc.xyz / sc.w * 0.5 + 0.5;
  if (sp.x < 0.0 || sp.x > 1.0 || sp.y < 0.0 || sp.y > 1.0 || sp.z > 1.0) return 1.0;

  float bias = (SHADOW_DEPTH_BIAS + SHADOW_SLOPE_BIAS * (1.0 - ndl)) * texelWorld / depthRange;
  return shadowPcf(c, sp, bias);
}

/** Returns 0..1, how much of the sun reaches this fragment. */
float sunVisibility(vec3 worldPos, vec3 normal, vec3 sunDir, float viewDist) {
  if (uShadowStrength <= 0.0) return 1.0;
  if (viewDist >= uCascadeFar.z) return 1.0;

  // Shadows must not end at a hard circle round the aircraft, so the last
  // stretch of the outermost cascade fades to unshadowed.
  float fade = 1.0 - smoothstep(uCascadeFar.z * 0.85, uCascadeFar.z, viewDist);
  if (fade <= 0.0) return 1.0;

  int c;
  float nearD;
  float farD;
  if (viewDist < uCascadeFar.x)      { c = 0; nearD = 0.0;            farD = uCascadeFar.x; }
  else if (viewDist < uCascadeFar.y) { c = 1; nearD = uCascadeFar.x;  farD = uCascadeFar.y; }
  else                               { c = 2; nearD = uCascadeFar.y;  farD = uCascadeFar.z; }

  float vis = cascadeVisibility(c, worldPos, normal, sunDir);

  // Cross-fade into the next cascade over the last 12% of this one. Without it
  // the resolution step draws a visible line straight across the city.
  // The second test is what keeps a DISABLED outer cascade (whose far equals
  // the previous one's) from being blended in as a stale map.
  if (c < 2 && farD < uCascadeFar.z) {
    float t = smoothstep(farD - (farD - nearD) * 0.12, farD, viewDist);
    if (t > 0.0) vis = mix(vis, cascadeVisibility(c + 1, worldPos, normal, sunDir), t);
  }

  return mix(1.0, vis, uShadowStrength * fade);
}
`;

const DEPTH_VERT = /* glsl */ `precision highp float;
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const DEPTH_FRAG = /* glsl */ `precision highp float;
out vec4 c;
void main() { c = vec4(1.0); }`;

/**
 * A scene.overrideMaterial that writes depth and nothing else.
 *
 * Shared with the ambient-occlusion prepass (render/ao.ts), which needs exactly
 * the same thing from the main camera. One definition, because the reason it
 * works at all is subtle: every geometry in this scene is drawn from `position`
 * and the standard matrices with no vertex displacement anywhere, so one
 * trivial vertex shader can stand in for all of them. A second copy would be
 * one more place for that invariant to be broken silently.
 */
export function createDepthOnlyMaterial(): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: DEPTH_VERT,
    fragmentShader: DEPTH_FRAG,
    side: THREE.DoubleSide,
    // Depth is the entire product of this pass. Writing colour as well cost a
    // measured 1.5 ms a frame over three 2048 maps, for a buffer nothing reads.
    colorWrite: false,
  });
}

function makeTarget(size: number): THREE.WebGLRenderTarget {
  const depth = new THREE.DepthTexture(size, size);
  depth.type = THREE.UnsignedIntType;
  depth.format = THREE.DepthFormat;
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  // Sampled as an ordinary sampler2D, not as a sampler2DShadow: the PCF loop
  // wants the raw depth so it can apply its own bias.
  depth.compareFunction = null;

  // A colour attachment because three always makes one; nothing ever reads it,
  // the depth material has colorWrite off and the pass never clears it, so it
  // costs one byte per texel of address space and no bandwidth. RGBA here would
  // be 12 MB of pointless store traffic per frame across the three cascades.
  return new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: depth,
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
  });
}

interface Cascade {
  target: THREE.WebGLRenderTarget;
  camera: THREE.OrthographicCamera;
  matrix: THREE.Matrix4;
  /** World metres per shadow texel for the fit last computed. */
  texelWorld: number;
  /** Metres the ortho near..far range spans. */
  depthRange: number;
}

const _centre = new THREE.Vector3();
const _lightSpace = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _up = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _rot = new THREE.Quaternion();
const _invRot = new THREE.Quaternion();

export class SunShadow {
  readonly uniforms: SunShadowUniforms;
  /** Off makes update() a no-op with the maps disabled; for A/B timing. */
  enabled = true;

  private cascades: Cascade[] = [];
  private depthMaterial: THREE.RawShaderMaterial;
  private size: number;
  private readonly budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
    const size = budget.shadowCascadeSize;
    this.size = size;
    // Three slots whatever the tier renders: the shader samples three cascade
    // maps unconditionally, so three textures have to be bound even when only
    // two are fitted. render/budget.ts counts three when it estimates this.
    for (let i = 0; i < 3; i++) {
      this.cascades.push({
        target: makeTarget(size),
        camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100),
        matrix: new THREE.Matrix4(),
        texelWorld: 1,
        depthRange: 1,
      });
    }

    this.depthMaterial = createDepthOnlyMaterial();

    this.uniforms = {
      uShadowMap0: { value: this.cascades[0].target.depthTexture },
      uShadowMap1: { value: this.cascades[1].target.depthTexture },
      uShadowMap2: { value: this.cascades[2].target.depthTexture },
      uShadowMat0: { value: this.cascades[0].matrix },
      uShadowMat1: { value: this.cascades[1].matrix },
      uShadowMat2: { value: this.cascades[2].matrix },
      uCascadeFar: { value: new THREE.Vector3(CASCADE_FAR[0], CASCADE_FAR[1], CASCADE_FAR[2]) },
      uCascadeTexelWorld: { value: new THREE.Vector3(1, 1, 1) },
      uCascadeDepth: { value: new THREE.Vector3(1, 1, 1) },
      uShadowTexel: { value: 1 / size },
      uShadowStrength: { value: 0 },
    };
  }

  /**
   * Fit the cascades to the camera and render the casters. Once per frame.
   *
   * `extra` is for casters that cannot be drawn through `scene.overrideMaterial`
   * because their vertex shader moves the geometry -- an instanced field is the
   * case that exists -- so each one is a small scene of its own carrying its own
   * depth material. They are rendered with the override OFF, which is why they
   * have to be separate scenes rather than objects inside `scene`.
   *
   * They go into the NEAR cascades only. An instanced field is scattered props
   * a few metres across, and the outer cascade covers 6 km on a 2048 map, so
   * a whole tree there is one texel; drawing it costs a full pass over the
   * instance buffer and changes nothing in the picture.
   */
  update(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    sunDir: THREE.Vector3,
    quality: number,
    extra: readonly THREE.Scene[] = [],
  ): void {
    const u = this.uniforms;

    // Below the horizon the fit goes singular and a shadow would be meaningless
    // anyway: there is no beam left to block.
    const strength = THREE.MathUtils.smoothstep(sunDir.y, SUN_MIN_Y, SUN_FULL_Y);
    if (!this.enabled || strength <= 0) {
      u.uShadowStrength.value = 0;
      return;
    }

    // The device tier already chose a size and a count at load. The adaptive
    // controller may only take MORE away, never give any back: a device that
    // could not hold 2048 maps in the first place does not become able to when
    // its frames get quick.
    const lowTier = quality < 0.8;
    this.setSize(lowTier ? Math.min(this.budget.shadowCascadeSize, 1024) : this.budget.shadowCascadeSize);
    // The outermost cascade is the one that draws the whole city three times
    // over, and it is also the one carrying the least visible detail, so it is
    // what goes first when there is no frame time for it.
    const count = lowTier
      ? Math.min(this.budget.shadowCascadeCount, 2)
      : this.budget.shadowCascadeCount;

    for (let i = 0; i < count; i++) this.fit(this.cascades[i], camera, sunDir, i);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    scene.overrideMaterial = this.depthMaterial;
    // Clear by hand, depth only: the colour attachment is never read and
    // clearing it is pure write bandwidth.
    renderer.autoClear = false;

    for (let i = 0; i < count; i++) {
      const c = this.cascades[i];
      // Layer 2 alone: this excludes the sky (a full-screen triangle, which in
      // a shadow map would blanket the entire city), the clouds, the beacons
      // and the labels, without any of them having to know shadows exist.
      c.camera.layers.set(SHADOW_CASTER_LAYER);
      renderer.setRenderTarget(c.target);
      renderer.clear(false, true, false);
      renderer.render(scene, c.camera);
      if (extra.length && i < EXTRA_CASTER_CASCADES) {
        scene.overrideMaterial = null;
        for (const e of extra) renderer.render(e, c.camera);
        scene.overrideMaterial = this.depthMaterial;
      }
    }

    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);

    u.uShadowMat0.value.copy(this.cascades[0].matrix);
    u.uShadowMat1.value.copy(this.cascades[1].matrix);
    u.uShadowMat2.value.copy(this.cascades[2].matrix);
    u.uCascadeTexelWorld.value.set(
      this.cascades[0].texelWorld,
      this.cascades[1].texelWorld,
      this.cascades[2].texelWorld,
    );
    u.uCascadeDepth.value.set(
      this.cascades[0].depthRange,
      this.cascades[1].depthRange,
      this.cascades[2].depthRange,
    );
    // A skipped cascade gets its far collapsed onto the previous one's, which
    // both stops it being sampled and moves the outer fade in to meet it.
    u.uCascadeFar.value.set(
      CASCADE_FAR[0],
      CASCADE_FAR[1],
      count > 2 ? CASCADE_FAR[2] : CASCADE_FAR[1],
    );
    u.uShadowTexel.value = 1 / this.size;
    u.uShadowStrength.value = strength;
  }

  /**
   * Fit one cascade's ortho camera to its slice of the view frustum.
   *
   * The bounding sphere is analytic rather than measured from the eight corners
   * on purpose: its radius is then a function of the split distances and the
   * field of view ONLY, so it does not change when the camera turns, and a
   * constant radius is the precondition for the texel snapping below.
   */
  private fit(c: Cascade, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, index: number): void {
    const near = index === 0 ? camera.near : CASCADE_FAR[index - 1];
    const far = CASCADE_FAR[index];

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * camera.aspect;
    const k2 = tanH * tanH + tanV * tanV;

    let zCentre: number;
    let radius: number;
    if (k2 >= (far - near) / (far + near)) {
      // Wide slice: the far corners are the extremes, so the sphere sits on the
      // far plane.
      zCentre = -far;
      radius = far * Math.sqrt(k2);
    } else {
      zCentre = -0.5 * (far + near) * (1 + k2);
      radius = 0.5 * Math.sqrt(
        (far - near) * (far - near) +
        2 * (far * far + near * near) * k2 +
        (far + near) * (far + near) * k2 * k2,
      );
    }

    _centre.set(0, 0, zCentre).applyMatrix4(camera.matrixWorld);

    // The light's ORIENTATION, built about the world origin rather than about
    // the cascade centre. Anchoring it to the world is the whole trick: light
    // space then has a fixed grid that the centre slides across, so rounding a
    // coordinate in it means something. Built from the cascade centre instead,
    // the centre is by construction at (0, 0, -d) and the rounding below would
    // be a no-op that silently bought nothing.
    _up.set(0, 1, 0);
    // Degenerate when the sun is straight overhead: the view direction and `up`
    // become parallel and the basis comes out NaN.
    if (Math.abs(sunDir.y) > 0.999) _up.set(0, 0, 1);
    _basis.lookAt(sunDir, _origin.set(0, 0, 0), _up);
    _rot.setFromRotationMatrix(_basis);
    _invRot.copy(_rot).invert();

    // Quantise the cascade centre to whole shadow-map texels in that light
    // space.
    //
    // This is the single thing standing between this and shadows that shimmer
    // and crawl across every roof on every camera movement. Without it the
    // texel grid slides continuously under static geometry, so which side of a
    // shadow edge a given roof pixel falls on changes every frame, and the
    // result looks markedly worse than having no shadows at all. It only works
    // because `radius` above is a constant: a grid whose spacing changed with
    // the camera would have nothing stable to snap to.
    const worldUnitsPerTexel = (2 * radius) / this.size;
    _lightSpace.copy(_centre).applyQuaternion(_invRot);
    _lightSpace.x = Math.round(_lightSpace.x / worldUnitsPerTexel) * worldUnitsPerTexel;
    _lightSpace.y = Math.round(_lightSpace.y / worldUnitsPerTexel) * worldUnitsPerTexel;
    _centre.copy(_lightSpace).applyQuaternion(_rot);

    const cam = c.camera;
    cam.quaternion.copy(_rot);
    cam.position.copy(_centre).addScaledVector(sunDir, radius + BACKOFF_M);
    cam.updateMatrixWorld(true);

    // Half a texel of margin, because snapping can push the sphere that far off
    // centre.
    const extent = radius + worldUnitsPerTexel;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 2 * radius + 2 * BACKOFF_M;
    cam.updateProjectionMatrix();

    c.matrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    c.texelWorld = worldUnitsPerTexel;
    c.depthRange = cam.far - cam.near;
  }

  private setSize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    for (const c of this.cascades) c.target.setSize(size, size);
    this.uniforms.uShadowMap0.value = this.cascades[0].target.depthTexture;
    this.uniforms.uShadowMap1.value = this.cascades[1].target.depthTexture;
    this.uniforms.uShadowMap2.value = this.cascades[2].target.depthTexture;
  }

  dispose(): void {
    for (const c of this.cascades) c.target.dispose();
    this.depthMaterial.dispose();
  }
}
