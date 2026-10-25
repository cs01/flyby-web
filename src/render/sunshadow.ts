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
//
// Beyond the cascades, a fourth map covers the WHOLE baked city and is
// rendered only when the sun moves. Without it the shadows ended where the
// cascades did, 1.4 km out on a phone and 6 km on a desktop, and from altitude
// that read as a disc of shadowed city travelling with the aircraft over an
// unshadowed one. See CityShadow below.

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

/**
 * Layer the city-wide map draws. SunShadow puts every mesh under the root it
 * is handed onto it, so the buildings module does not have to know this map
 * exists, and the terrain rings (camera-centred, so wrong the moment the
 * camera moves on) and the aircraft are kept out of a map that lives for
 * minutes.
 */
const CITY_SHADOW_LAYER = 3;

/**
 * Sun movement, in degrees, that re-renders the city map. The scene clock
 * moves the sun 0.25 degrees a minute, so this is one full-city depth pass a
 * minute. A shadow edge 4 m a texel wide moves well under a texel for a 0.25
 * degree change except at the tips of the longest low-sun shadows.
 */
const CITY_RESHADOW_DEG = 0.25;

/**
 * Minimum time between two city renders, for a sun that is being DRAGGED (the
 * time scrubber), where every frame would otherwise pay a full-city pass.
 */
const CITY_MIN_INTERVAL_MS = 200;

/** Metres added round the city's footprint, so the PCF taps at its rim stay on the map. */
const CITY_MARGIN_M = 100;

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
  /** The city-wide map, sampled wherever the cascades have run out. */
  uCityShadowMap: THREE.IUniform<THREE.Texture | null>;
  uCityShadowMat: THREE.IUniform<THREE.Matrix4>;
  /** x: 1 when the map holds the city (2: use it everywhere, ?cityshadowonly), y: world metres a texel, z: depth range in metres, w: 1 / size. */
  uCityShadow: THREE.IUniform<THREE.Vector4>;
  /**
   * Cloud shadow: the sun's transmittance through the low and mid decks, drawn
   * by render/composite.ts on the plane of the lowest cloud base. Null (and
   * uCloudShadow.x 0) on a clear day.
   */
  uCloudShadowMap: THREE.IUniform<THREE.Texture | null>;
  /** x0, z0 (world metres of the map's corner), 1 / extent, plane altitude. */
  uCloudShadowRect: THREE.IUniform<THREE.Vector4>;
  /** x: 1 when the map is live, y: the largest gain a gap may get; see cloudSunVisibility. */
  uCloudShadow: THREE.IUniform<THREE.Vector4>;
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
uniform sampler2D uCityShadowMap;
uniform mat4  uCityShadowMat;
uniform vec4  uCityShadow;
uniform sampler2D uCloudShadowMap;
uniform vec4  uCloudShadowRect;
uniform vec4  uCloudShadow;

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

// The city map needs none of the above, because it is drawn from BACK faces
// only (see CityShadow): what it stores along a sun ray is where the ray LEAVES
// a building, so a sunlit roof or wall lies a whole building in front of its
// own entry and cannot shadow itself, and the ground is not in the map at all.
// What is left is the 16-bit depth step (0.27 m over Manhattan) and a lee
// wall meeting the ground it shades, hence one metre.
//
// It matters because the normal offset is several texels and this map's
// texels are 4 to 9 m: on flat ground under a 15 degree sun that lifted the
// sample 41 m with a 2048 map on the reduced tier, which erased the shadow of every building lower than
// that and cut 150 m off the rest. Measured on manhattan-high-shadow, the
// shadowed share of the ground fell from 0.70 inside the last cascade to 0.13
// just outside it.
const float CITY_SHADOW_BIAS_M = 1.0;

/**
 * 3x3 PCF. sp is the shadow-map coordinate in 0..1, bias in depth units, texel
 * the map's 1 / size. c is 0..2 for the cascades, 3 for the city map.
 */
float shadowPcf(int c, vec3 sp, float bias, float texel) {
  float lit = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * texel;
      float d;
      // GLSL ES 3.0 will not index an array of samplers dynamically, so the
      // cascade choice has to be a branch.
      if (c == 0)      d = texture(uShadowMap0, sp.xy + o).r;
      else if (c == 1) d = texture(uShadowMap1, sp.xy + o).r;
      else if (c == 2) d = texture(uShadowMap2, sp.xy + o).r;
      else             d = texture(uCityShadowMap, sp.xy + o).r;
      lit += (sp.z - bias > d) ? 0.0 : 1.0;
    }
  }
  return lit * (1.0 / 9.0);
}

float cascadeVisibility(int c, vec3 worldPos, vec3 normal, vec3 sunDir) {
  float texelWorld = c == 0 ? uCascadeTexelWorld.x : (c == 1 ? uCascadeTexelWorld.y : (c == 2 ? uCascadeTexelWorld.z : uCityShadow.y));
  float depthRange = c == 0 ? uCascadeDepth.x     : (c == 1 ? uCascadeDepth.y     : (c == 2 ? uCascadeDepth.z     : uCityShadow.z));

  float ndl = clamp(dot(normal, sunDir), 0.0, 1.0);
  vec3 p = c == 3 ? worldPos
         : worldPos + normal * texelWorld * (SHADOW_NORMAL_OFFSET + SHADOW_SLOPE_OFFSET * (1.0 - ndl));

  vec4 sc = c == 0 ? uShadowMat0 * vec4(p, 1.0)
          : (c == 1 ? uShadowMat1 * vec4(p, 1.0)
          : (c == 2 ? uShadowMat2 * vec4(p, 1.0) : uCityShadowMat * vec4(p, 1.0)));
  vec3 sp = sc.xyz / sc.w * 0.5 + 0.5;
  if (sp.x < 0.0 || sp.x > 1.0 || sp.y < 0.0 || sp.y > 1.0 || sp.z > 1.0) return 1.0;

  float bias = c == 3 ? CITY_SHADOW_BIAS_M / depthRange
             : (SHADOW_DEPTH_BIAS + SHADOW_SLOPE_BIAS * (1.0 - ndl)) * texelWorld / depthRange;
  return shadowPcf(c, sp, bias, c == 3 ? uCityShadow.w : uShadowTexel);
}

/**
 * One cascade's answer, with the city map folded into the outermost.
 *
 * Cascade 2 spans 1.4 to 6 km on a 2048 map, 5 m a texel, and its normal
 * offset lifts a ground sample about 25 m under a 15 degree sun: everything
 * lower than that casts nothing. Measured on manhattan-higher-shadow it found
 * shadow on 0.26 of the ground at 4.2 to 5.1 km where the city map finds 0.61,
 * so handing over to the map at 6 km drew a ring where the shadows came BACK.
 * The minimum keeps cascade 2's terrain and the map's buildings, and closes
 * the same gap at the 1.4 km handover from cascade 1 (0.94 inside it, 0.11
 * just past it before, against 0.98 and 0.30 from the map).
 */
float bandVisibility(int c, vec3 worldPos, vec3 normal, vec3 sunDir) {
  float v = cascadeVisibility(c, worldPos, normal, sunDir);
  if (c == 2 && uCityShadow.x > 0.5) v = min(v, cascadeVisibility(3, worldPos, normal, sunDir));
  return v;
}

/**
 * How much sun the cloud decks let through to this point, RELATIVE TO THE
 * BEAM THE LIGHTING MODEL ALREADY DIMMED.
 *
 * render/lighting.ts takes the decks out of the sun as one global factor,
 * 1 - opacity, because that is all it knows. With a map of where the cloud
 * actually is, the honest answer is spatial: full sun in the gaps, the deck's
 * transmittance under a cloud. Dividing the map by its own MEAN (the top mip)
 * turns it into exactly that redistribution while keeping the average beam
 * the lighting model set, so nothing else in the frame has to change: a 30%
 * cumulus sky dims the beam to 0.72, the map's mean is ~0.74, so a gap gets
 * the dimmed beam times 1 / 0.74, which is the clear beam back, and a shadow
 * gets about a tenth of it. Can exceed 1 for that reason. The gain
 * is capped (uCloudShadow.y) at what undoes the low and mid decks' share of the
 * dimming, so a gap in an overcast cannot come out brighter than a clear day.
 */
float cloudSunVisibility(vec3 worldPos, vec3 sunDir) {
  if (uCloudShadow.x < 0.5) return 1.0;
  // Along the sun ray to the plane the map was drawn on. Exact for anything
  // under the deck, which is everything that receives this.
  float s = (uCloudShadowRect.w - worldPos.y) / max(sunDir.y, 0.05);
  vec2 xz = worldPos.xz + sunDir.xz * s;
  vec2 uv = (xz - uCloudShadowRect.xy) * uCloudShadowRect.z;
  float mean = textureLod(uCloudShadowMap, vec2(0.5), 16.0).r;
  float t = textureLod(uCloudShadowMap, uv, 0.0).r;
  // Past the map's edge, the mean: unshadowed relative to the beam, rather
  // than a hard line where the map stops.
  vec2 e = min(uv, 1.0 - uv);
  t = mix(mean, t, smoothstep(0.0, 0.08, min(e.x, e.y)));
  return clamp(t / max(mean, 0.02), 0.0, uCloudShadow.y);
}

/** 0..1, how much of the sun the shadow maps let reach this fragment. */
float geometrySunVisibility(vec3 worldPos, vec3 normal, vec3 sunDir, float viewDist) {
  if (uShadowStrength <= 0.0) return 1.0;

  // Past the cascades the city map answers on its own; outside the city it
  // reads lit, which is right, since the city is everything it holds.
  // x above 1.5 is ?cityshadowonly, the map everywhere: tools/verify-shadow.ts
  // measures the cascades against it.
  bool city = uCityShadow.x > 0.5;
  if (viewDist >= uCascadeFar.z || uCityShadow.x > 1.5) {
    return city ? mix(1.0, cascadeVisibility(3, worldPos, normal, sunDir), uShadowStrength) : 1.0;
  }

  // Shadows must not end at a hard circle round the aircraft, so the last
  // stretch of the outermost cascade hands over to the city map, or, where
  // there is no city map (no baked pack, ?nocityshadow), fades to unshadowed.
  float handoff = smoothstep(uCascadeFar.z * 0.85, uCascadeFar.z, viewDist);

  int c;
  float nearD;
  float farD;
  if (viewDist < uCascadeFar.x)      { c = 0; nearD = 0.0;            farD = uCascadeFar.x; }
  else if (viewDist < uCascadeFar.y) { c = 1; nearD = uCascadeFar.x;  farD = uCascadeFar.y; }
  else                               { c = 2; nearD = uCascadeFar.y;  farD = uCascadeFar.z; }

  float vis = bandVisibility(c, worldPos, normal, sunDir);

  // Cross-fade into the next cascade over the last 12% of this one. Without it
  // the resolution step draws a visible line straight across the city.
  // The second test is what keeps a DISABLED outer cascade (whose far equals
  // the previous one's) from being blended in as a stale map.
  if (c < 2 && farD < uCascadeFar.z) {
    float t = smoothstep(farD - (farD - nearD) * 0.12, farD, viewDist);
    if (t > 0.0) vis = mix(vis, bandVisibility(c + 1, worldPos, normal, sunDir), t);
  }

  if (handoff > 0.0) vis = mix(vis, city ? cascadeVisibility(3, worldPos, normal, sunDir) : 1.0, handoff);
  return mix(1.0, vis, uShadowStrength);
}

/**
 * How much sun reaches this fragment: the shadow maps times the cloud decks.
 * Usually 0..1; above 1 in a gap between clouds, see cloudSunVisibility.
 */
float sunVisibility(vec3 worldPos, vec3 normal, vec3 sunDir, float viewDist) {
  return geometrySunVisibility(worldPos, normal, sunDir, viewDist) * cloudSunVisibility(worldPos, sunDir);
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

function makeTarget(size: number, depthType: THREE.TextureDataType = THREE.UnsignedIntType): THREE.WebGLRenderTarget {
  const depth = new THREE.DepthTexture(size, size);
  depth.type = depthType;
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
  /** Null for a slot this tier never draws; see the constructor. */
  target: THREE.WebGLRenderTarget | null;
  camera: THREE.OrthographicCamera;
  matrix: THREE.Matrix4;
  /** World metres per shadow texel for the fit last computed. */
  texelWorld: number;
  /** Metres the ortho near..far range spans. */
  depthRange: number;
  /** The map holds a draw at its current size; until then it is drawn every frame. */
  drawn: boolean;
}

const _centre = new THREE.Vector3();
const _lightSpace = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _up = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _rot = new THREE.Quaternion();
const _invRot = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/** The city's footprint as a vertical cylinder, measured once from its meshes. */
interface CityBounds {
  centre: THREE.Vector3;
  radius: number;
  halfHeight: number;
}

/**
 * The static, city-wide shadow map.
 *
 * One ortho camera fitted to the whole baked city rather than to the view, so
 * it does not move with the aircraft and only has to be redrawn when the SUN
 * does. Its box is fitted to the city's bounding CYLINDER in light space, not
 * to a square: under a low sun a disc of city projects to an ellipse a fifth
 * as tall as it is wide, and a square map would spend four fifths of its
 * texels on nothing. Fitted this way a 4096 map over Manhattan comes out near
 * 4 m a texel on the ground in both directions.
 */
interface CityShadow {
  root: THREE.Object3D;
  bounds: CityBounds | null;
  target: THREE.WebGLRenderTarget;
  camera: THREE.OrthographicCamera;
  /** Sun direction the map was last drawn for; NaN until the first draw. */
  sun: THREE.Vector3;
  lastMs: number;
}

export class SunShadow {
  readonly uniforms: SunShadowUniforms;
  /** Off makes update() a no-op with the maps disabled; for A/B timing. */
  enabled = true;

  /**
   * Off stops the city map being drawn or sampled, so the cascades fade to
   * unshadowed as they did before it existed; for A/B timing from the console.
   */
  cityEnabled = true;
  /** The quality ladder's cap on the cascades drawn (the phone's lean preset draws one). */
  maxCascades = 3;
  /** Outer cascades on alternate frames; see update(). */
  alternate = true;
  private frame = 0;
  /** For the harness: how many times the city map has been drawn, and the CPU cost of the last draw. */
  readonly cityStats = { renders: 0, cpuMs: 0 };
  /** The city map everywhere and no cascades: the reference frame tools/verify-shadow.ts measures against. */
  cityOnly = false;

  private cascades: Cascade[] = [];
  private city: CityShadow | null = null;
  private depthMaterial: THREE.RawShaderMaterial;
  /** The same depth-only shader drawing back faces only; see CITY_SHADOW_BIAS_M in the GLSL. */
  private cityDepthMaterial: THREE.RawShaderMaterial;
  private size: number;
  private readonly budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
    const size = budget.shadowCascadeSize;
    this.size = size;
    // Three slots, but a map only for the cascades this tier can ever draw.
    // The shader names three samplers unconditionally, and an unallocated one
    // is bound to three's 1x1 placeholder, which is never read because a
    // cascade past `shadowCascadeCount` is never selected. The reduced tier
    // used to allocate its third 1024 map anyway: 5 MB of a phone's memory for
    // a texture nothing ever drew into.
    for (let i = 0; i < 3; i++) {
      this.cascades.push({
        target: i < budget.shadowCascadeCount ? makeTarget(size) : null,
        camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100),
        matrix: new THREE.Matrix4(),
        texelWorld: 1,
        drawn: false,
        depthRange: 1,
      });
    }

    this.depthMaterial = createDepthOnlyMaterial();
    // Building shells are closed and wound outward (their own material culls
    // back faces, so a reversed one would already show as a hole), which is
    // what makes back faces a well-defined exit surface along every sun ray.
    this.cityDepthMaterial = createDepthOnlyMaterial();
    this.cityDepthMaterial.side = THREE.BackSide;

    this.uniforms = {
      uShadowMap0: { value: this.cascades[0].target?.depthTexture ?? null },
      uShadowMap1: { value: this.cascades[1].target?.depthTexture ?? null },
      uShadowMap2: { value: this.cascades[2].target?.depthTexture ?? null },
      uShadowMat0: { value: this.cascades[0].matrix },
      uShadowMat1: { value: this.cascades[1].matrix },
      uShadowMat2: { value: this.cascades[2].matrix },
      uCascadeFar: { value: new THREE.Vector3(CASCADE_FAR[0], CASCADE_FAR[1], CASCADE_FAR[2]) },
      uCascadeTexelWorld: { value: new THREE.Vector3(1, 1, 1) },
      uCascadeDepth: { value: new THREE.Vector3(1, 1, 1) },
      uShadowTexel: { value: 1 / size },
      uShadowStrength: { value: 0 },
      uCityShadowMap: { value: null },
      uCityShadowMat: { value: new THREE.Matrix4() },
      uCityShadow: { value: new THREE.Vector4(0, 1, 1, 1) },
      uCloudShadowMap: { value: null },
      uCloudShadowRect: { value: new THREE.Vector4(0, 0, 1, 0) },
      uCloudShadow: { value: new THREE.Vector4(0, 1, 0, 0) },
    };
  }

  /**
   * Hand over the city's static casters (the baked buildings' group). The map
   * is allocated here, not in the constructor, so a place with no pack never
   * pays for it; render/budget.ts counts it regardless, as the worst case.
   */
  setCityCasters(root: THREE.Object3D): void {
    if (!this.city) {
      const size = this.budget.cityShadowSize;
      // 16-bit depth: see CITY_SHADOW_BYTES_PER_TEXEL in render/budget.ts.
      const target = makeTarget(size, THREE.UnsignedShortType);
      this.city = {
        root,
        bounds: null,
        target,
        camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100),
        sun: new THREE.Vector3(NaN, NaN, NaN),
        lastMs: -Infinity,
      };
      this.uniforms.uCityShadowMap.value = target.depthTexture;
      this.uniforms.uCityShadow.value.w = 1 / size;
    }
    this.city.root = root;
    this.city.bounds = null;
    this.city.sun.set(NaN, NaN, NaN);
  }

  /**
   * Draw the city map now, whatever the sun has done. Public so the harness
   * can time one draw in isolation; update() is what calls it in the app.
   */
  renderCity(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sunDir: THREE.Vector3): void {
    const city = this.city;
    if (!city) return;
    city.root.updateMatrixWorld(true);
    // Every pass, not once: the layer is how the root's meshes are picked out
    // of the main scene, and a mesh added to the group after the first draw
    // would otherwise be silently missing from every draw after it.
    city.root.traverse((o) => o.layers.enable(CITY_SHADOW_LAYER));
    city.bounds ??= measureCity(city.root);
    if (!city.bounds) return;

    const t0 = performance.now();
    this.fitCity(city, city.bounds, sunDir);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    scene.overrideMaterial = this.cityDepthMaterial;
    renderer.autoClear = false;
    city.camera.layers.set(CITY_SHADOW_LAYER);
    renderer.setRenderTarget(city.target);
    renderer.clear(false, true, false);
    renderer.render(scene, city.camera);
    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);

    city.sun.copy(sunDir);
    city.lastMs = t0;
    this.cityStats.renders++;
    this.cityStats.cpuMs = performance.now() - t0;
  }

  private fitCity(city: CityShadow, b: CityBounds, sunDir: THREE.Vector3): void {
    _up.set(0, 1, 0);
    if (Math.abs(sunDir.y) > 0.999) _up.set(0, 0, 1);
    _basis.lookAt(sunDir, _origin.set(0, 0, 0), _up);
    _rot.setFromRotationMatrix(_basis);

    // A cylinder's half-extent along a unit axis a: the disc contributes
    // radius * |a projected on the ground|, the height halfHeight * |a.y|.
    const extent = (col: number): number => {
      _axis.setFromMatrixColumn(_basis, col);
      return b.radius * Math.hypot(_axis.x, _axis.z) + b.halfHeight * Math.abs(_axis.y);
    };
    const hx = extent(0) + CITY_MARGIN_M;
    const hy = extent(1) + CITY_MARGIN_M;
    const hz = extent(2) + CITY_MARGIN_M;

    const cam = city.camera;
    cam.quaternion.copy(_rot);
    cam.position.copy(b.centre).addScaledVector(sunDir, hz + 10);
    cam.updateMatrixWorld(true);
    cam.left = -hx;
    cam.right = hx;
    cam.top = hy;
    cam.bottom = -hy;
    cam.near = 1;
    cam.far = 2 * hz + 20;
    cam.updateProjectionMatrix();

    const size = this.budget.cityShadowSize;
    this.uniforms.uCityShadowMat.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // The coarser of the two axes, for the world-metre figure the diagnostics
    // and the bias constants are stated in; a low sun makes the two differ by
    // up to 4x in light space.
    const u = this.uniforms.uCityShadow.value;
    u.y = (2 * Math.max(hx, hy)) / size;
    u.z = cam.far - cam.near;
  }

  /** Redraw the city map if the sun has moved enough to show. */
  private updateCity(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sunDir: THREE.Vector3): void {
    const city = this.city;
    if (!city || !this.cityEnabled) {
      this.uniforms.uCityShadow.value.x = 0;
      return;
    }
    const moved = Number.isNaN(city.sun.x) ||
      city.sun.angleTo(sunDir) > THREE.MathUtils.degToRad(CITY_RESHADOW_DEG);
    if (moved && performance.now() - city.lastMs >= CITY_MIN_INTERVAL_MS) {
      this.renderCity(renderer, scene, sunDir);
    }
    this.uniforms.uCityShadow.value.x = Number.isNaN(city.sun.x) ? 0 : this.cityOnly ? 2 : 1;
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
    const count = Math.min(
      this.maxCascades,
      lowTier ? Math.min(this.budget.shadowCascadeCount, 2) : this.budget.shadowCascadeCount,
    );

    // The outer cascades take turns: cascade 0 every frame, then 1 and 2 on
    // alternate frames (1 every other frame when there are only two). Each
    // keeps the matrix it was drawn with, so a skipped one is a frame old and
    // still exactly consistent; at 6 km a frame of camera motion is a few
    // texels of a 2048 map. Each cascade pass draws the city's casters again,
    // so this takes a third of the cascade passes off every frame.
    this.frame++;
    // A cascade the step has switched off is stale by the time it comes back.
    for (let i = count; i < 3; i++) this.cascades[i].drawn = false;
    const due = (i: number): boolean =>
      i === 0 || !this.alternate || !this.cascades[i].drawn || (count > 2 ? this.frame % 2 === i - 1 : this.frame % 2 === 0);
    for (let i = 0; i < count; i++) if (due(i)) this.fit(this.cascades[i], camera, sunDir, i);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    scene.overrideMaterial = this.depthMaterial;
    // Clear by hand, depth only: the colour attachment is never read and
    // clearing it is pure write bandwidth.
    renderer.autoClear = false;

    for (let i = 0; i < count; i++) {
      if (!due(i)) continue;
      const c = this.cascades[i];
      c.drawn = true;
      // Layer 2 alone: this excludes the sky (a full-screen triangle, which in
      // a shadow map would blanket the entire city), the clouds, the beacons
      // and the labels, without any of them having to know shadows exist.
      c.camera.layers.set(SHADOW_CASTER_LAYER);
      renderer.setRenderTarget(c.target!);
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
      count > 1 ? CASCADE_FAR[1] : CASCADE_FAR[0],
      count > 2 ? CASCADE_FAR[2] : count > 1 ? CASCADE_FAR[1] : CASCADE_FAR[0],
    );
    u.uShadowTexel.value = 1 / this.size;
    u.uShadowStrength.value = strength;

    this.updateCity(renderer, scene, sunDir);
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
    for (const c of this.cascades) {
      c.target?.setSize(size, size);
      c.drawn = false;
    }
    this.uniforms.uShadowMap0.value = this.cascades[0].target?.depthTexture ?? null;
    this.uniforms.uShadowMap1.value = this.cascades[1].target?.depthTexture ?? null;
    this.uniforms.uShadowMap2.value = this.cascades[2].target?.depthTexture ?? null;
  }

  dispose(): void {
    for (const c of this.cascades) c.target?.dispose();
    this.city?.target.dispose();
    this.depthMaterial.dispose();
    this.cityDepthMaterial.dispose();
  }
}

/**
 * The city's footprint: the centre of its world box, the farthest any mesh's
 * box corner reaches from that centre on the ground, and its height range.
 * Null for a root with no geometry under it.
 */
function measureCity(root: THREE.Object3D): CityBounds | null {
  const all = new THREE.Box3();
  const boxes: THREE.Box3[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.boundingBox ?? mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    boxes.push(b);
    all.union(b);
  });
  if (!boxes.length) return null;
  const centre = all.getCenter(new THREE.Vector3());
  let radius = 0;
  for (const b of boxes) {
    const dx = Math.max(Math.abs(b.min.x - centre.x), Math.abs(b.max.x - centre.x));
    const dz = Math.max(Math.abs(b.min.z - centre.z), Math.abs(b.max.z - centre.z));
    radius = Math.max(radius, Math.hypot(dx, dz));
  }
  return { centre, radius, halfHeight: (all.max.y - all.min.y) / 2 };
}
