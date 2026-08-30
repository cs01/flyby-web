// The canopy: instanced trees, planted from the measured tree channel.
//
// WHY OPAQUE GEOMETRY AND NOT ALPHA-TESTED CARDS. The obvious build for foliage
// is crossed quads with an alpha test, and it is the wrong one here. Three
// measurements decide it. Per-fragment work is this renderer's scarce resource
// (the atmosphere march is ~5 ms while 1.4M triangles of skyline is ~0.26 ms),
// alpha-tested overdraw is per-fragment work multiplied by the number of cards
// a ray crosses, and `discard` disables early-Z on the fragment shader that
// then has to run the atmosphere, the sky SH and three shadow cascades. A
// 44-triangle opaque crown costs one shaded fragment per pixel with depth
// rejection intact, and geometry is the thing this renderer has spare.
//
// Alpha to coverage would also have shipped two different pictures: the scene
// target is multisampled on desktop and single-sampled on a coarse-pointer
// device, so the same tree would be soft on one and hard-edged on the other.
//
// What buys back the silhouette that a card would have given is: the crown is
// LUMPY (every vertex displaced by a hash of its own position, so shared
// vertices move together and the mesh stays closed), the species table varies
// height, width and taper, and the colour varies per instance and per facet.
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
  placeTrees,
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
 * Instance ceiling.
 *
 * The attribute buffers are allocated once at this size and never grow, so it
 * is a memory budget rather than a quality knob: 32 bytes an instance, so 90k
 * is 2.9 MB of vertex buffer. A city leafier than the budget loses its
 * outermost tiles first, which is the least visible thing to lose.
 */
const MAX_INSTANCES = 90_000;
const MOBILE_MAX_INSTANCES = 22_000;

/** Sides on a crown ring. Six is where a lumpy dome stops reading as a prism. */
const CROWN_SIDES = 6;
/** Sides on the trunk. Four is a post, and at 10 m a post is right. */
const TRUNK_SIDES = 4;
/** Height fraction where the crown starts, and the trunk's top. */
const CROWN_BASE = 0.30;
const TRUNK_TOP = 0.36;
/** Trunk radius as a fraction of crown radius, at the base and at the top. */
const TRUNK_R0 = 0.13;
const TRUNK_R1 = 0.075;

/** Crown rings: height fraction, radius fraction. */
const CROWN_RINGS: readonly (readonly [number, number])[] = [
  [0.42, 0.72],
  [0.64, 1.00],
  [0.84, 0.68],
];

/**
 * One unit tree: 1 m tall, crown radius 1 m, standing on y = 0.
 *
 * Built rather than tabulated so the ring plan above is the single description
 * of the shape, and shared by the beauty pass and the depth pass so a tree
 * cannot cast a shadow it does not have.
 */
function unitTreeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  // uv.x flags crown versus trunk (the fragment shader picks bark or leaf and
  // the vertex shader only lumps the crown); uv.y is depth into the canopy,
  // which is the cheap ambient occlusion that stops a crown's underside being
  // as bright as its top.
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, crown: number): number => {
    pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.push(nx / l, ny / l, nz / l);
    uv.push(crown, crown > 0.5 ? (y - CROWN_BASE) / (1 - CROWN_BASE) : 0);
    return pos.length / 3 - 1;
  };

  // Winding: for a ring pair (A below, B above) walked with the angle
  // increasing, (A_j, B_j, B_j+1) and (A_j, B_j+1, A_j+1) both come out
  // counter-clockwise seen from OUTSIDE, which is what FrontSide wants.
  const band = (a: number[], b: number[]): void => {
    for (let j = 0; j < a.length; j++) {
      const j2 = (j + 1) % a.length;
      idx.push(a[j], b[j], b[j2], a[j], b[j2], a[j2]);
    }
  };

  const ring = (yF: number, rF: number, sides: number, upBias: number, crown: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < sides; j++) {
      const t = (j / sides) * Math.PI * 2;
      const c = Math.cos(t), s = Math.sin(t);
      out.push(push(c * rF, yF, s * rF, c, upBias, s, crown));
    }
    return out;
  };

  const trunkLo = ring(0, TRUNK_R0, TRUNK_SIDES, 0, 0);
  const trunkHi = ring(TRUNK_TOP, TRUNK_R1, TRUNK_SIDES, 0, 0);
  band(trunkLo, trunkHi);

  const skirt = push(0, CROWN_BASE, 0, 0, -1, 0, 1);
  const rings = CROWN_RINGS.map(([yF, rF], k) =>
    ring(yF, rF, CROWN_SIDES, k === 0 ? -0.5 : 0.35, 1),
  );
  // The crown's underside. A fan facing DOWN, so its winding is the reverse of
  // a band's: seen from below the angle runs the other way.
  for (let j = 0; j < CROWN_SIDES; j++) {
    idx.push(skirt, rings[0][j], rings[0][(j + 1) % CROWN_SIDES]);
  }
  for (let k = 0; k + 1 < rings.length; k++) band(rings[k], rings[k + 1]);
  const apex = push(0, 1, 0, 0, 1, 0, 1);
  const top = rings[rings.length - 1];
  for (let j = 0; j < CROWN_SIDES; j++) {
    idx.push(top[j], apex, top[(j + 1) % CROWN_SIDES]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/** Triangles in one tree, for the frame budget the shot harness reports. */
export const TREE_TRIANGLES = TRUNK_SIDES * 2 + CROWN_SIDES * (1 + 2 * (CROWN_RINGS.length - 1) + 1);

const VERT_COMMON = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;
// Two vec4s, not a mat4: see render/instanced.ts.
in vec4 iPos;    // xyz world origin, w yaw
in vec4 iShape;  // x crown radius m, y height m, z conifer 0..1, w tint 0..1

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform vec2 uFade;

${INSTANCE_GLSL}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

struct Placed {
  vec3 world;
  vec3 normal;
  float leaf;
  bool culled;
};

Placed placeVertex() {
  Placed o;
  o.world = vec3(0.0);
  o.normal = vec3(0.0, 1.0, 0.0);
  o.leaf = 0.0;
  float d = distance(iPos.xyz, uCameraPos);
  // Shrunk to nothing over the last stretch rather than popped out. At the far
  // end of the fade a tree is two or three pixels tall, so the shrink is
  // invisible, and it is what keeps the edge of the field from reading as a
  // circle drawn around the aircraft.
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, d);
  o.culled = fade <= 0.0;
  if (o.culled) return o;

  float crown = uv.x;
  float seed = iShape.w * 977.0;
  vec3 p = position;
  // Conifer: the same dome mesh with its rings pulled in as they rise, so one
  // base mesh and one draw call cover both a spire and a broadleaf.
  float taper = mix(1.0, clamp(1.35 - 1.15 * p.y, 0.0, 1.4), iShape.z);
  // Lumpiness, hashed off the vertex's OWN position so that two triangles
  // sharing a vertex displace it identically and the crown stays closed. A
  // hash of the triangle would tear it open.
  float lump = 0.74 + 0.52 * hash13(p * 31.7 + seed);
  o.leaf = lump;
  p.xz *= mix(1.0, taper * lump, crown);
  p.y += (hash13(p * 17.3 + seed + 5.0) - 0.5) * 0.10 * crown;

  vec3 scale = vec3(iShape.x, iShape.y, iShape.x) * fade;
  o.world = instanceToWorld(p, iPos.xyz, iPos.w, scale);
  // Inverse transpose of a diagonal scale is its reciprocal; the yaw is
  // orthonormal and needs no correction.
  o.normal = normalize(instanceRotate(normal / max(scale, vec3(1e-4)), iPos.w));
  return o;
}
`;

const VERT = /* glsl */ `
${VERT_COMMON}
out vec3 vNormal;
out vec3 vWorld;
out vec2 vUv;
out float vViewDist;
out float vTint;
out float vLeaf;

void main() {
  Placed pl = placeVertex();
  if (pl.culled) { gl_Position = INSTANCE_CULLED; return; }
  vNormal = pl.normal;
  vWorld = pl.world;
  vUv = uv;
  vTint = iShape.w;
  vLeaf = pl.leaf;
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
in vec2 vUv;
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

float hash13f(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

/** Trilinear value noise. One call, gated by distance; see below. */
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13f(i), hash13f(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(hash13f(i + vec3(0.0, 1.0, 0.0)), hash13f(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(hash13f(i + vec3(0.0, 0.0, 1.0)), hash13f(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(hash13f(i + vec3(0.0, 1.0, 1.0)), hash13f(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

void main() {
  vec3 n = normalize(vNormal);
  float crown = step(0.5, vUv.x);

  // Leaf break-up. The facet-scale term is the vertex lump interpolated across
  // the triangle and costs nothing; the metre-scale term is one noise lookup
  // and is switched off past 400 m, where a whole tree is a few pixels and the
  // detail would only alias.
  float near = smoothstep(400.0, 120.0, vViewDist);
  float fine = near > 0.0 ? vnoise3(vWorld * 1.6) : 0.5;
  float shade = mix(0.5, vLeaf, 0.75) * 0.6 + mix(0.5, fine, near) * 0.4;

  // Two greens per species position rather than a palette: the species tint
  // picks where in the ramp a tree sits, the break-up moves each patch of its
  // own crown around that point.
  vec3 leafDark = vec3(0.016, 0.042, 0.012);
  vec3 leafLight = vec3(0.068, 0.108, 0.028);
  vec3 leaf = mix(leafDark, leafLight, clamp(vTint * 0.62 + shade * 0.55 - 0.06, 0.0, 1.0));
  // Autumn is not modelled, but a stand where every tree is the same green is
  // the thing that reads as one asset repeated, so a few per cent of them are
  // pulled toward olive.
  leaf = mix(leaf, vec3(0.105, 0.086, 0.026), smoothstep(0.93, 1.0, vTint));
  vec3 bark = vec3(0.038, 0.028, 0.020) * (0.7 + 0.6 * shade);
  vec3 albedo = mix(bark, leaf, crown);

  // Depth into the canopy, as occlusion. A crown's underside sees almost no
  // sky and this is far cheaper than asking the screen-space pass to resolve
  // something a few metres across.
  float canopyAo = mix(0.42, 1.0, crown > 0.5 ? vUv.y : 0.35);

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
  /** Instances currently in the buffer. */
  count: number;
  tiles: number;
  triangles: number;
  /** Milliseconds the last rebuild took, placement plus repack. */
  rebuildMs: number;
  /** True once a rebuild has had to drop tiles to stay inside the budget. */
  clipped: boolean;
}

const _key = (tx: number, tz: number): string => `${tx},${tz}`;

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
  readonly stats: FoliageStats = { count: 0, tiles: 0, triangles: 0, rebuildMs: 0, clipped: false };

  private readonly field: TreeField;
  private readonly instances: InstancedField;
  private readonly tiles = new Map<string, TreeInstance[]>();
  private readonly radiusM: number;
  private readonly extentM: number;
  /** Camera tile the current buffer was packed for; -1e9 means "never packed". */
  private atX = -1e9;
  private atZ = -1e9;

  constructor(field: TreeField, shadow: SunShadowUniforms, mobile: boolean) {
    this.field = field;
    this.radiusM = mobile ? MOBILE_FIELD_RADIUS_M : FIELD_RADIUS_M;
    // Never plant outside the mask: sampleMaskBilinear clamps to the edge
    // texel, so a field that ran past the pack would extrude the coverage of
    // its border all the way to the horizon.
    this.extentM = field.mask.extentM;

    const base = unitTreeGeometry();
    this.instances = new InstancedField(base, mobile ? MOBILE_MAX_INSTANCES : MAX_INSTANCES, [
      { name: "iPos", itemSize: 4 },
      { name: "iShape", itemSize: 4 },
    ]);

    this.uniforms = {
      ...shadow,
      ...aoUniforms(),
      uCameraPos: { value: new THREE.Vector3() },
      uSH: { value: shHemispherical([0.28, 0.36, 0.5], 0.55, 0.45) },
      uFade: { value: new THREE.Vector2(this.radiusM * 0.76, this.radiusM) },
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

    const mesh = new THREE.Mesh(
      this.instances.geometry,
      new THREE.RawShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: this.uniforms,
        glslVersion: THREE.GLSL3,
        side: THREE.FrontSide,
      }),
    );
    mesh.frustumCulled = false;
    // Drawn BEFORE the ground it stands on. A canopy covers a lot of terrain,
    // the terrain shader is the most expensive one in the frame, and every
    // terrain fragment under a crown is one early-Z rejects for free once the
    // crown is already in the depth buffer. Roads (renderOrder 10+) come after
    // both, so a street under a tree is correctly hidden by it.
    mesh.renderOrder = -1;
    this.group.add(mesh);

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
    const depth = new THREE.Mesh(
      this.instances.geometry,
      new THREE.RawShaderMaterial({
        vertexShader: DEPTH_VERT,
        fragmentShader: DEPTH_FRAG,
        uniforms: depthUniforms,
        glslVersion: THREE.GLSL3,
        // Depth is the whole product; see createDepthOnlyMaterial's note.
        colorWrite: false,
      }),
    );
    depth.frustumCulled = false;
    // Both passes point their camera at this layer, so the depth copy has to
    // be on it even though it lives in its own scene.
    depth.layers.enable(SHADOW_CASTER_LAYER);
    this.depthScene.add(depth);
  }

  /**
   * Rebuild the field around a camera position. Cheap and idempotent between
   * tile crossings, so it is safe to call every frame.
   */
  update(camX: number, camZ: number): void {
    const tx = Math.floor(camX / TREE_TILE_M);
    const tz = Math.floor(camZ / TREE_TILE_M);
    if (tx === this.atX && tz === this.atZ) return;
    this.atX = tx;
    this.atZ = tz;

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

    const keep = new Set<string>();
    const iPos = this.instances.arrays.iPos;
    const iShape = this.instances.arrays.iShape;
    let count = 0;
    let clipped = false;
    for (const w of wanted) {
      let tile = this.tiles.get(w.key);
      if (!tile) {
        tile = placeTrees(this.field, w.x, w.z, w.x + TREE_TILE_M, w.z + TREE_TILE_M);
        this.tiles.set(w.key, tile);
      }
      if (count + tile.length > this.instances.capacity) {
        clipped = true;
        break;
      }
      keep.add(w.key);
      for (const t of tile) {
        const p = count * 4;
        iPos[p] = t.x;
        iPos[p + 1] = t.y;
        iPos[p + 2] = t.z;
        iPos[p + 3] = t.yaw;
        iShape[p] = t.radiusM;
        iShape[p + 1] = t.heightM;
        iShape[p + 2] = TREE_SPECIES[t.species].conifer;
        iShape[p + 3] = t.tint;
        count++;
      }
    }

    // Evicting the placement cache and not just the buffer: a tile is ~4 KB of
    // objects and a long flight would otherwise cache the whole city.
    for (const key of this.tiles.keys()) if (!keep.has(key)) this.tiles.delete(key);

    this.instances.upload(count);
    this.stats.count = count;
    this.stats.tiles = keep.size;
    this.stats.triangles = count * TREE_TRIANGLES;
    this.stats.rebuildMs = performance.now() - t0;
    this.stats.clipped = this.stats.clipped || clipped;
  }

  dispose(): void {
    this.instances.dispose();
  }
}
