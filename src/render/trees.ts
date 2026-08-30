// The canopy: instanced trees, planted from the measured tree channel.
//
// WHY OPAQUE GEOMETRY AND NOT ALPHA-TESTED CARDS. The obvious build for foliage
// is crossed quads with an alpha test, and it is the wrong one here. Three
// measurements decide it. Per-fragment work is this renderer's scarce resource
// (the atmosphere march is ~5 ms while 1.4M triangles of skyline is ~0.26 ms),
// alpha-tested overdraw is per-fragment work multiplied by the number of cards
// a ray crosses, and `discard` disables early-Z on the fragment shader that
// then has to run the atmosphere, the sky SH and three shadow cascades. An
// opaque crown costs one shaded fragment per pixel with depth rejection intact,
// and geometry is the thing this renderer has spare.
//
// Alpha to coverage would also have shipped two different pictures: the scene
// target is multisampled on desktop and single-sampled on a coarse-pointer
// device, so the same tree would be soft on one and hard-edged on the other.
//
// So the silhouette a card would have given has to be bought with vertices
// instead, and that is what src/render/treemesh.ts is: one continuous shape
// function per form, sampled at three resolutions, ragged in the geometry.
// This file owns the buffers, the shaders and which instance is drawn at which
// level.
//
// WHAT MAKES A STAND STOP READING AS ONE ASSET REPEATED. Four things, and they
// are listed in the order they were worth:
//   1. the outline: baked lobes, twisted up the crown, plus a per-tree lobe
//      layer and a per-tree lean in the vertex shader;
//   2. motion: three sines of wind, weighted by the square of the height up the
//      tree so the trunk stays planted (see treemesh.ts);
//   3. the shading normal: perturbed per fragment from the analytic gradient of
//      a value noise, because a dome with one smooth normal shades like a ball
//      whatever shape its outline is;
//   4. the colour: canopy depth drives where a patch sits on the leaf ramp, not
//      just how dark it is.
//
// **The field follows the camera.** Trees are planted on an absolute lattice
// (see src/data/trees.ts) a 256 m tile at a time, and the tile set is rebuilt
// when the camera crosses a tile boundary. Because the lattice is absolute, a
// tree that leaves the set and comes back is the same tree in the same place:
// there is nothing to pop. A field pinned to the scene origin instead would
// leave the outskirts of a 12 km city bald, which is most of a flight.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL, shHemispherical } from "./sh";
import { AO_GLSL, aoUniforms, type AoUniforms } from "./ao";
import { InstancedField, INSTANCE_GLSL } from "./instanced";
import {
  buildTreeMesh,
  TREE_FORMS,
  TREE_LODS,
  TREE_SHAPE_GLSL,
  windStrength,
  FORM_CONIFER,
  FORM_BROADLEAF,
} from "./treemesh";
import {
  placeTrees,
  TREE_SPACING_M,
  TREE_SPECIES,
  TREE_TILE_M,
  type TreeField,
  type TreeInstance,
} from "../data/trees";

/** Where the field ends, in metres from the camera. */
const FIELD_RADIUS_M = 2200;
const MOBILE_FIELD_RADIUS_M = 1100;
/** Where trees stop being drawn into the shadow cascades; see the depth
 *  material below. Matches the middle cascade's far distance. */
const SHADOW_FADE_M = 1400;

/**
 * How far the camera may move before the level-of-detail buckets are repacked,
 * in metres.
 *
 * Placement is cached by tile and is the expensive half; this is only the walk
 * that sorts already-placed instances into buckets and uploads them, which is a
 * few hundred microseconds for a whole leafy suburb. It has to be much shorter
 * than a tile, because a tree's level is chosen here and a tile is 256 m.
 */
const LOD_REPACK_M = 64;

/**
 * Level distances are halved on the reduced tier.
 *
 * Not because the far levels are wrong on a phone, but because the NEAR one is:
 * the near crown is deliberately extravagant with vertices, which is free on a
 * desktop and is not free on a tile-based mobile GPU that has to bin them.
 */
const MOBILE_LOD_SCALE = 0.5;

/**
 * Headroom over the geometric maximum number of instances in a level's annulus.
 *
 * The lattice in src/data/trees.ts admits at most one tree per TREE_SPACING_M
 * cell, so the count inside a radius is bounded by area over cell area and this
 * is a real ceiling rather than a guess. The headroom covers cells whose centre
 * is outside the annulus and whose jittered candidate is inside it.
 */
const CAPACITY_HEADROOM = 1.15;

/** How far a crown leans off its own trunk at the apex, in crown radii. */
const LEAN_MAX = 0.22;

/** Triangles in one tree at each level, for the frame budget the harness reports. */
export const TREE_LOD_TRIANGLES: readonly number[] = TREE_LODS.map((_, l) =>
  Math.max(...TREE_FORMS.map((_f, f) => buildTreeMesh(f, l).triangles)),
);

const VERT_COMMON = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
// x crown flag, y canopy depth, z angle 0..1, w this level's lobe gain.
in vec4 aTree;
// Two vec4s, not a mat4: see render/instanced.ts.
in vec4 iPos;    // xyz world origin, w yaw
in vec4 iShape;  // x crown radius m, y height m, z shape seed 0..1, w tint 0..1

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform vec2 uFade;
// xy: the unit direction the wind blows TOWARD. z: strength, 0 to 1.
uniform vec3 uWind;
uniform float uTime;

${INSTANCE_GLSL}
${TREE_SHAPE_GLSL}

const float LEAN_MAX = ${LEAN_MAX};
/** Radians of gust phase per metre downwind: a ~90 m gust front. */
const float GUST_WAVE_PER_M = 0.07;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

struct Placed {
  vec3 world;
  /** (cos, sin) of the instance yaw, kept so the beauty pass can reuse it. */
  vec2 yawCS;
  vec3 scale;
  bool culled;
};

/**
 * Everything BOTH passes need, and nothing either of them does not.
 *
 * The depth copy is drawn three times a frame -- two shadow cascades and the
 * ambient-occlusion prepass -- against the beauty pass's one, so the shading
 * normal and the facet hash are computed by the beauty vertex shader instead of
 * here. That is three quarters of the invocations that no longer pay for a
 * normalise and a hash they were going to throw away.
 */
Placed placeVertex() {
  Placed o;
  o.world = vec3(0.0);
  o.yawCS = vec2(1.0, 0.0);
  o.scale = vec3(1.0);
  float d = distance(iPos.xyz, uCameraPos);
  // Shrunk to nothing over the last stretch rather than popped out. At the far
  // end of the fade a tree is two or three pixels tall, so the shrink is
  // invisible, and it is what keeps the edge of the field from reading as a
  // circle drawn around the aircraft.
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, d);
  o.culled = fade <= 0.0;
  if (o.culled) return o;

  float crown = aTree.x;
  float seed = iShape.z;
  vec3 p = position;
  o.yawCS = vec2(cos(iPos.w), sin(iPos.w));

  // Per-tree crown lobes, on top of the baked ones, attenuated by aTree.w so a
  // level only carries the harmonics its ring count can actually resolve.
  // Radial, so a shared vertex moves identically from every triangle that owns
  // it and the crown stays closed.
  float lobe = crownLobe(aTree.z * 6.2831853, aTree.y, seed) * aTree.w;
  p.xz *= 1.0 + lobe * crown;

  // Lean. A crown centred exactly over its trunk is the other half of why a
  // stand of instances reads as one asset repeated: real crowns grow toward the
  // light and away from their neighbours. Zero at the crown base, so the crown
  // stays attached to the trunk it grew out of. The direction is the yaw's own
  // cosine and sine, which is a free uniformly random direction: the yaw is
  // already random per tree and the pair is already in a register.
  p.xz += o.yawCS * (LEAN_MAX * aTree.y * aTree.y * crown);

  o.scale = vec3(iShape.x, iShape.y, iShape.x) * fade;
  o.world = instanceToWorld(p, iPos.xyz, o.yawCS, o.scale);
  // Wind, applied in WORLD space so the sway direction does not have to be
  // rotated into every instance's own frame. |windSway| <= 1 by construction
  // and uWind.z is clamped to 0..1 on the way in, so no vertex ever travels
  // further than WIND_MAX_LOCAL crown radii.
  float gustPhase = dot(iPos.xz, uWind.xy) * GUST_WAVE_PER_M;
  float sway = windSway(p.y, seed, uTime, gustPhase);
  o.world.xz += uWind.xy * (sway * uWind.z * WIND_MAX_LOCAL * o.scale.x);
  return o;
}
`;

const VERT = /* glsl */ `
${VERT_COMMON}
out vec3 vNormal;
out vec3 vWorld;
out vec2 vTree;
out float vViewDist;
out float vTint;
out float vLeaf;

void main() {
  Placed pl = placeVertex();
  if (pl.culled) { gl_Position = INSTANCE_CULLED; return; }
  // Inverse transpose of a diagonal scale is its reciprocal; the yaw is
  // orthonormal and needs no correction.
  vNormal = normalize(instanceRotate(normal / max(pl.scale, vec3(1e-4)), pl.yawCS));
  // Facet-scale break-up, hashed off the vertex's OWN base position so shared
  // vertices agree. Carries the crown at distances where the fragment shader's
  // noise is switched off.
  vLeaf = 0.72 + 0.56 * hash13(position * 13.7 + iShape.z * 331.0);
  vWorld = pl.world;
  vTree = aTree.xy;
  vTint = iShape.w;
  vViewDist = distance(pl.world, uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pl.world, 1.0);
}
`;

const DEPTH_VERT = /* glsl */ `
${VERT_COMMON}
void main() {
  Placed pl = placeVertex();
  gl_Position = pl.culled ? INSTANCE_CULLED
              : projectionMatrix * modelViewMatrix * vec4(pl.world, 1.0);
}
`;

const DEPTH_FRAG = /* glsl */ `precision highp float;
out vec4 c;
void main() { c = vec4(1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vTree;
in float vViewDist;
in float vTint;
in float vLeaf;
out vec4 fragColor;

// Aerial perspective only, the same short march the terrain and the buildings
// use. Trees without it are a saturated green band against a hazed hillside.
#define ATMO_STEPS 7
#define ATMO_SUN_STEPS 2
${ATMOSPHERE_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}

uniform vec3  uCameraPos;
uniform float uSunSurface;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uNight;
uniform vec3  uNightGlow;

/** How far the leaf-cluster noise is allowed to tilt the shading normal. */
const float LEAF_BUMP = 0.42;

float hash13f(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

/**
 * Trilinear value noise AND its analytic gradient, from one set of corners.
 *
 * The gradient is the product here: it is what perturbs the shading normal, and
 * the alternative -- four separate noise lookups differenced against each other
 * -- costs four times the hashes for a worse answer. Returned as
 * (value, d/dx, d/dy, d/dz) with the derivative of the smoothstep folded in.
 */
vec4 vnoise3d(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 du = 6.0 * f * (1.0 - f);

  float a = hash13f(i);
  float b = hash13f(i + vec3(1.0, 0.0, 0.0));
  float c = hash13f(i + vec3(0.0, 1.0, 0.0));
  float d = hash13f(i + vec3(1.0, 1.0, 0.0));
  float e = hash13f(i + vec3(0.0, 0.0, 1.0));
  float g = hash13f(i + vec3(1.0, 0.0, 1.0));
  float h = hash13f(i + vec3(0.0, 1.0, 1.0));
  float k = hash13f(i + vec3(1.0, 1.0, 1.0));

  float k1 = b - a;
  float k2 = c - a;
  float k3 = e - a;
  float k4 = a - b - c + d;
  float k5 = a - c - e + h;
  float k6 = a - b - e + g;
  float k7 = -a + b + c - d + e - g - h + k;

  float v = a + k1 * u.x + k2 * u.y + k3 * u.z
          + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x
          + k7 * u.x * u.y * u.z;
  vec3 grad = du * vec3(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k4 * u.x + k5 * u.z + k7 * u.z * u.x,
    k3 + k5 * u.y + k6 * u.x + k7 * u.x * u.y);
  return vec4(v, grad);
}

void main() {
  vec3 n = normalize(vNormal);
  float crown = step(0.5, vTree.x);
  // Depth into the canopy: 0 at the crown base, 1 at the apex. The trunk is
  // given a fixed mid value; it is inside the crown's shadow either way.
  float exposure = crown > 0.5 ? vTree.y : 0.35;

  // Leaf break-up, switched off past ~430 m where a whole tree is a few pixels
  // and the detail would only alias. There is no temporal antialiasing to hide
  // shimmer, so anything at this scale has to converge with distance rather
  // than be filtered later.
  float near = smoothstep(430.0, 140.0, vViewDist);
  float fine = 0.5;
  if (crown > 0.5 && near > 0.0) {
    vec4 a = vnoise3d(vWorld * 0.62);
    vec4 b = vnoise3d(vWorld * 2.35);
    fine = a.x * 0.62 + b.x * 0.38;
    // Leaf clusters as a NORMAL perturbation rather than as a colour. Foliage
    // is thousands of small surfaces at random orientations; a crown with one
    // smooth normal over it shades like a ball whatever colour it is painted,
    // and that is most of what reads as a plastic tree.
    n = normalize(n - (a.yzw + b.yzw * 0.35) * (LEAF_BUMP * near));
  }

  // Three scales of variation, deliberately: the facet term is the vertex hash
  // interpolated across the triangle and costs nothing, the fine term is the
  // noise above, and the exposure term says where in its own crown this patch
  // is. A canopy with only one of them reads as one painted surface.
  float upFace = n.y * 0.5 + 0.5;
  float sunlit = clamp(exposure * 0.65 + upFace * 0.35, 0.0, 1.0);
  float shade = mix(0.5, vLeaf, 0.60) * 0.40
              + mix(0.5, fine, near) * 0.30
              + sunlit * 0.30;

  // Two greens per species position rather than a palette: the species tint
  // picks where in the ramp a tree sits, the break-up moves each patch of its
  // own crown around that point.
  vec3 leafDark = vec3(0.014, 0.036, 0.011);
  vec3 leafLight = vec3(0.088, 0.134, 0.034);
  vec3 leaf = mix(leafDark, leafLight, clamp(vTint * 0.55 + shade * 0.60 - 0.06, 0.0, 1.0));
  // The inside of a crown is BROWNER as well as darker: bare wood, last year's
  // growth and leaves that never see the sun. Darkening alone leaves the whole
  // crown one hue and that is the tell.
  leaf = mix(leaf, vec3(0.030, 0.028, 0.014), (1.0 - exposure) * 0.34 * crown);
  // A few leaves in every patch are turned edge-on and catch the sky instead of
  // the sun.
  leaf = mix(leaf, vec3(0.115, 0.135, 0.058), smoothstep(0.70, 0.96, fine) * 0.35 * near);
  // Autumn is not modelled, but a stand where every tree is the same green is
  // the thing that reads as one asset repeated, so a few per cent of them are
  // pulled toward olive.
  leaf = mix(leaf, vec3(0.105, 0.086, 0.026), smoothstep(0.93, 1.0, vTint));
  vec3 bark = vec3(0.038, 0.028, 0.020) * (0.7 + 0.6 * shade);
  vec3 albedo = mix(bark, leaf, crown);

  // Depth into the canopy, as occlusion. A crown's underside sees almost no
  // sky and this is far cheaper than asking the screen-space pass to resolve
  // something a few metres across.
  float canopyAo = mix(0.46, 1.0, exposure);

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunT;
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);

  // Transmission through the leaf. A leaf is thin and green, so the light that
  // comes through the far side of a crown is a large fraction of what a tree
  // looks like against a low sun, and leaving it out is most of the difference
  // between a tree and a green rock.
  float back = max(0.0, dot(-n, uSunDir));
  vec3 through = sunE * pow(back, 1.6) * sunVis * crown * 0.7 * vec3(0.62, 1.0, 0.30);

  vec3 ambient = occludedSkyIrradiance(n) * canopyAo;
  vec3 moon = uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));

  vec3 lit = albedo * (sunE * ndl * sunVis + ambient + moon) + albedo * through;
  // Skyglow, so a tree in a lit city at night is dark rather than a black
  // cut-out. No street lamps on the canopy: the lamp field in terrain.ts is a
  // ground pattern and stamping it onto a crown would light the treetops.
  lit += albedo * uNightGlow * uNight * 0.35;

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export interface FoliageUniforms extends SunShadowUniforms, AoUniforms {
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uSH: THREE.IUniform<Float32Array>;
  uFade: THREE.IUniform<THREE.Vector2>;
  uWind: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
}

export interface FoliageStats {
  /** Instances currently in the buffers. */
  count: number;
  tiles: number;
  triangles: number;
  /** Instances at each level of detail, nearest first. */
  lodCounts: number[];
  /** Milliseconds the last rebuild took, placement plus repack. */
  rebuildMs: number;
  /** True once a rebuild has had to drop tiles or instances to stay inside the
   *  budget. */
  clipped: boolean;
}

const _key = (tx: number, tz: number): string => `${tx},${tz}`;
const fract = (x: number): number => x - Math.floor(x);

/** One (form, level) pair: a base mesh and the instances currently at it. */
interface Bucket {
  form: number;
  lod: number;
  field: InstancedField;
  triangles: number;
  count: number;
}

export class Foliage {
  readonly group = new THREE.Group();
  /**
   * The depth-only copy, in a scene of its own.
   *
   * The sun cascades and the AO prepass draw the world through
   * `scene.overrideMaterial`, and that override would replace this vertex
   * shader with the shared one, which reads no instance attributes at all and
   * would stack every tree in the city on the origin. A separate scene is how
   * an instanced caster gets its own depth shader without the override having
   * to learn about exceptions, and it is one object to traverse rather than the
   * whole city a second time.
   */
  readonly depthScene = new THREE.Scene();
  readonly uniforms: FoliageUniforms;
  readonly stats: FoliageStats = {
    count: 0,
    tiles: 0,
    triangles: 0,
    lodCounts: TREE_LODS.map(() => 0),
    rebuildMs: 0,
    clipped: false,
  };

  private readonly field: TreeField;
  private readonly buckets: Bucket[] = [];
  private readonly lodFarM: number[];
  private readonly tiles = new Map<string, TreeInstance[]>();
  private readonly radiusM: number;
  private readonly extentM: number;
  /** Camera tile the current buffers were packed for; -1e9 means "never". */
  private atX = -1e9;
  private atZ = -1e9;
  /** Camera position the buffers were packed at, for the repack threshold. */
  private packedX = 0;
  private packedZ = 0;

  constructor(field: TreeField, shadow: SunShadowUniforms, mobile: boolean) {
    this.field = field;
    this.radiusM = mobile ? MOBILE_FIELD_RADIUS_M : FIELD_RADIUS_M;
    // Never plant outside the mask: sampleMaskBilinear clamps to the edge
    // texel, so a field that ran past the pack would extrude the coverage of
    // its border all the way to the horizon.
    this.extentM = field.mask.extentM;

    const lodScale = mobile ? MOBILE_LOD_SCALE : 1;
    this.lodFarM = TREE_LODS.map((l) => Math.min(l.farM * lodScale, this.radiusM));

    this.uniforms = {
      ...shadow,
      ...aoUniforms(),
      uCameraPos: { value: new THREE.Vector3() },
      uSH: { value: shHemispherical([0.28, 0.36, 0.5], 0.55, 0.45) },
      uFade: { value: new THREE.Vector2(this.radiusM * 0.76, this.radiusM) },
      uWind: { value: new THREE.Vector3(1, 0, 0.3) },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 22 },
      uSunSurface: { value: 0.105 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonLight: { value: new THREE.Color(0, 0, 0) },
      uNight: { value: 0 },
      uNightGlow: { value: new THREE.Color(0, 0, 0) },
      uMieG: { value: 0.76 },
      uTurbidity: { value: 1 },
      uCamAltitude: { value: 100 },
      uMultiScatter: { value: 0.055 },
    };

    const beauty = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
    });

    // The depth pass gets its own fade and shares everything else by reference.
    //
    // A tree stops casting a useful shadow long before it stops being visible:
    // the outer cascade covers 6 km across a 2048 map, which is ~7 m a texel,
    // so a 10 m crown out there is one texel of noise. Cutting the caster field
    // at the middle cascade's far distance takes two thirds of the instances
    // out of every cascade and empties the outer one entirely, and nothing in
    // the picture changes.
    const depthUniforms = {
      ...this.uniforms,
      uFade: { value: new THREE.Vector2(SHADOW_FADE_M * 0.8, SHADOW_FADE_M) },
    };
    const depthMat = new THREE.RawShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms: depthUniforms,
      glslVersion: THREE.GLSL3,
      // Depth is the whole product; see createDepthOnlyMaterial's note.
      colorWrite: false,
    });

    for (let lod = 0; lod < TREE_LODS.length; lod++) {
      const cap = this.capacityFor(lod);
      for (let form = 0; form < TREE_FORMS.length; form++) {
        const mesh = buildTreeMesh(form, lod);
        const base = new THREE.BufferGeometry();
        base.setAttribute("position", new THREE.BufferAttribute(mesh.position, 3));
        base.setAttribute("normal", new THREE.BufferAttribute(mesh.normal, 3));
        base.setAttribute("aTree", new THREE.BufferAttribute(mesh.aTree, 4));
        base.setIndex(new THREE.BufferAttribute(mesh.index, 1));

        const instances = new InstancedField(base, cap, [
          { name: "iPos", itemSize: 4 },
          { name: "iShape", itemSize: 4 },
        ]);
        this.buckets.push({ form, lod, field: instances, triangles: mesh.triangles, count: 0 });

        const drawn = new THREE.Mesh(instances.geometry, beauty);
        drawn.frustumCulled = false;
        // Drawn BEFORE the ground it stands on. A canopy covers a lot of
        // terrain, the terrain shader is the most expensive one in the frame,
        // and every terrain fragment under a crown is one early-Z rejects for
        // free once the crown is already in the depth buffer. Roads
        // (renderOrder 10+) come after both, so a street under a tree is
        // correctly hidden by it.
        drawn.renderOrder = -1;
        this.group.add(drawn);

        const caster = new THREE.Mesh(instances.geometry, depthMat);
        caster.frustumCulled = false;
        // Both passes point their camera at this layer, so the depth copy has
        // to be on it even though it lives in its own scene.
        caster.layers.enable(SHADOW_CASTER_LAYER);
        this.depthScene.add(caster);
      }
    }
  }

  /**
   * Instance ceiling for one level, from the area of the annulus it covers.
   *
   * A budget rather than a quality knob: the buffers are allocated once at this
   * size and never grow. Deriving it from the lattice pitch rather than writing
   * a round number down means a change to TREE_SPACING_M cannot silently start
   * clipping the field.
   */
  private capacityFor(lod: number): number {
    const inner = lod === 0 ? 0 : this.lodFarM[lod - 1];
    const outer = Math.min(this.lodFarM[lod], this.radiusM);
    const area = Math.PI * Math.max(0, outer * outer - inner * inner);
    return Math.max(64, Math.ceil((area / (TREE_SPACING_M * TREE_SPACING_M)) * CAPACITY_HEADROOM));
  }

  /**
   * Rebuild the field around a camera position. Cheap and idempotent between
   * repack thresholds, so it is safe to call every frame.
   */
  update(camX: number, camZ: number): void {
    const tx = Math.floor(camX / TREE_TILE_M);
    const tz = Math.floor(camZ / TREE_TILE_M);
    const moved = Math.hypot(camX - this.packedX, camZ - this.packedZ);
    if (tx === this.atX && tz === this.atZ && moved < LOD_REPACK_M) return;
    this.atX = tx;
    this.atZ = tz;
    this.packedX = camX;
    this.packedZ = camZ;

    const t0 = performance.now();
    const r = this.radiusM;
    const span = Math.ceil(r / TREE_TILE_M) + 1;

    // Nearest tile first, so a city leafier than the budget loses its outermost
    // ring rather than an arbitrary slice.
    const wanted: { key: string; x: number; z: number; d2: number }[] = [];
    for (let k = tz - span; k <= tz + span; k++) {
      for (let i = tx - span; i <= tx + span; i++) {
        const x0 = i * TREE_TILE_M;
        const z0 = k * TREE_TILE_M;
        if (x0 + TREE_TILE_M < -this.extentM || x0 > this.extentM) continue;
        if (z0 + TREE_TILE_M < -this.extentM || z0 > this.extentM) continue;
        // Distance from the camera to the nearest point of the tile.
        const dx = Math.max(0, Math.max(x0 - camX, camX - (x0 + TREE_TILE_M)));
        const dz = Math.max(0, Math.max(z0 - camZ, camZ - (z0 + TREE_TILE_M)));
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r) continue;
        wanted.push({ key: _key(i, k), x: x0, z: z0, d2 });
      }
    }
    wanted.sort((a, b) => a.d2 - b.d2);

    for (const b of this.buckets) b.count = 0;
    const keep = new Set<string>();
    let count = 0;
    let clipped = false;
    for (const w of wanted) {
      let tile = this.tiles.get(w.key);
      if (!tile) {
        tile = placeTrees(this.field, w.x, w.z, w.x + TREE_TILE_M, w.z + TREE_TILE_M);
        this.tiles.set(w.key, tile);
      }
      keep.add(w.key);
      for (const t of tile) {
        const d = Math.hypot(t.x - camX, t.z - camZ);
        if (d > r) continue;
        let lod = TREE_LODS.length - 1;
        for (let l = 0; l < this.lodFarM.length; l++) {
          if (d <= this.lodFarM[l]) { lod = l; break; }
        }
        const form = TREE_SPECIES[t.species].conifer >= 0.5 ? FORM_CONIFER : FORM_BROADLEAF;
        const bucket = this.buckets[lod * TREE_FORMS.length + form];
        if (bucket.count >= bucket.field.capacity) {
          clipped = true;
          continue;
        }
        const p = bucket.count * 4;
        const iPos = bucket.field.arrays.iPos;
        const iShape = bucket.field.arrays.iShape;
        iPos[p] = t.x;
        iPos[p + 1] = t.y;
        iPos[p + 2] = t.z;
        iPos[p + 3] = t.yaw;
        iShape[p] = t.radiusM;
        iShape[p + 1] = t.heightM;
        // A second, decorrelated hash per tree. src/data/trees.ts hands out one
        // (`tint`), and driving both the colour and the crown's shape from it
        // would tie how green a tree is to what it looks like.
        iShape[p + 2] = fract(t.tint * 7.13 + t.yaw * 0.6180339);
        iShape[p + 3] = t.tint;
        bucket.count++;
        count++;
      }
    }

    // Evicting the placement cache and not just the buffers: a tile is ~4 KB of
    // objects and a long flight would otherwise cache the whole city.
    for (const key of this.tiles.keys()) if (!keep.has(key)) this.tiles.delete(key);

    let triangles = 0;
    const lodCounts = TREE_LODS.map(() => 0);
    for (const b of this.buckets) {
      b.field.upload(b.count);
      triangles += b.count * b.triangles;
      lodCounts[b.lod] += b.count;
    }

    this.stats.count = count;
    this.stats.tiles = keep.size;
    this.stats.triangles = triangles;
    this.stats.lodCounts = lodCounts;
    this.stats.rebuildMs = performance.now() - t0;
    this.stats.clipped = this.stats.clipped || clipped;
  }

  /**
   * Point the sway at the observed wind.
   *
   * @param speedMs metres per second at 10 m, as the weather reports it.
   * @param fromDeg degrees the wind comes FROM, meteorological convention.
   */
  setWind(speedMs: number, fromDeg: number): void {
    // Toward, not from, and in world axes: +x east, +z SOUTH (see src/geo.ts).
    const toward = ((fromDeg + 180) * Math.PI) / 180;
    const w = this.uniforms.uWind.value;
    w.x = Math.sin(toward);
    w.y = -Math.cos(toward);
    // Clamped to 0..1 in treemesh.ts, beside the constant it bounds: the
    // vertex shader's displacement bound is stated in terms of this factor and
    // the sway, and the check asserts both are at most one.
    w.z = windStrength(speedMs);
  }

  dispose(): void {
    for (const b of this.buckets) b.field.dispose();
  }
}

