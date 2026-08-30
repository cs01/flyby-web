// Street lamps as objects, standing over the pools render/roads.ts paints.
//
// THE POINT OF THIS FILE IS AGREEMENT, NOT GEOMETRY. The road shader has drawn
// lamplight on the carriageway since the ribbons existed, and drew it with no
// post above any of it: from a car the street was lit by nothing. Adding thirty
// six triangles of column is easy. Adding them so that a post stands over every
// pool and no pool has no post is the part that took the design, and it is done
// in one place: data/streetfurniture.ts owns the spacing table and GENERATES
// the shader's copy of it (LAMP_GLSL), so the k-th lamp of a way is at
// u = (k + 0.5) * spacing on both sides of the language boundary.
//
// The consequence to remember when changing anything here: the lamp's height,
// its setback and its arm reach are free, but its (u, side) is NOT. Move it and
// the pool stays where it was.
//
// ONE MESH, TWO SCALES. A residential column is 5.5 m and a trunk-road column
// is 10 m, and the arm reach depends on how wide the carriageway is, so the
// base mesh is parametric: `aLamp.x` is fraction of the ARM and `aLamp.y` is
// fraction of the HEIGHT, while `position` carries the absolute metres of steel
// thickness. The instance multiplies the parametric part and leaves the
// absolute part alone, which is what stops a 10 m column being twice as thick
// as a 5 m one. That is also why this cannot use instanceToWorld's uniform
// scale, and why the yaw rotation is applied by hand from the same helper.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SUN_SHADOW_GLSL, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL, shHemispherical } from "./sh";
import { AO_GLSL, aoUniforms, type AoUniforms } from "./ao";
import { InstancedField, INSTANCE_GLSL } from "./instanced";
import type { Budget } from "./budget";
import {
  addLamps,
  hasStreetLamps,
  indexWaysByTile,
  tilesAround,
  LAMP_COLUMN_RADIUS_M,
  type LampInstance,
  type StreetWorld,
} from "../data/streetfurniture";
import type { RoadPack } from "../data/roadpack";

/**
 * Where the columns stop, in metres from the camera.
 *
 * A 140 mm column is under a pixel past about 400 m at this field of view, so
 * this is generous, and it is generous on purpose: at night the LANTERN is a
 * bright point that reads much further than the post that carries it, and a
 * boulevard whose lamps stop half way down it is worse than no lamps.
 */
const RING_M = 950;
const MOBILE_RING_M = 500;

/** Where an instance is shrunk out rather than popped. */
const FADE_FRACTION = 0.85;

const PART_STEEL = 0;
const PART_HOUSING = 1;
const PART_LENS = 2;

/** Sides on the column. Four is a square post; six reads as round for eight
 *  more triangles on an object there are a few hundred of. */
const COLUMN_SIDES = 6;

interface LampMesh {
  position: Float32Array;
  normal: Float32Array;
  /** x: fraction of the arm reach. y: fraction of the mounting height.
   *  z: part id. */
  aLamp: Float32Array;
  index: Uint16Array;
  triangles: number;
}

/**
 * The base mesh: a tapered column, an arm and a lantern housing.
 *
 * `position` is in metres and is never scaled by the instance; `aLamp.xy` is
 * the parametric part that is. Every vertex therefore has an absolute thickness
 * and a relative place along the two dimensions that vary per lamp.
 */
function buildLampMesh(): LampMesh {
  const pos: number[] = [];
  const nrm: number[] = [];
  const lamp: number[] = [];
  const idx: number[] = [];

  const R = LAMP_COLUMN_RADIUS_M;

  /** A prism between two rings, both centred on the column axis. */
  const column = (up0: number, r0: number, up1: number, r1: number): void => {
    const base = pos.length / 3;
    for (let i = 0; i <= COLUMN_SIDES; i++) {
      const th = (i / COLUMN_SIDES) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      pos.push(c * r0, 0, s * r0);
      nrm.push(c, 0, s);
      lamp.push(0, up0, PART_STEEL);
      pos.push(c * r1, 0, s * r1);
      nrm.push(c, 0, s);
      lamp.push(0, up1, PART_STEEL);
    }
    for (let i = 0; i < COLUMN_SIDES; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  };

  /**
   * A box in the mixed frame: `ax0..ax1` along the arm, `up0..up1` up the
   * column, plus absolute metre offsets in x, y and z.
   */
  const boxParam = (
    ax0: number, ax1: number, up0: number, up1: number,
    ox0: number, ox1: number, oy0: number, oy1: number, oz0: number, oz1: number,
    part: number,
  ): void => {
    // Eight corners, indexed by (a, u, z) bits, emitted as six quads so each
    // face keeps its own normal.
    const corner = (ai: number, ui: number, zi: number): number[] => [
      ai ? ax1 : ax0, ui ? up1 : up0,
      ai ? ox1 : ox0, ui ? oy1 : oy0, zi ? oz1 : oz0,
    ];
    const faces: [number[][], number[]][] = [
      [[corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)], [1, 0, 0]],
      [[corner(0, 0, 1), corner(0, 1, 1), corner(0, 1, 0), corner(0, 0, 0)], [-1, 0, 0]],
      [[corner(0, 1, 0), corner(0, 1, 1), corner(1, 1, 1), corner(1, 1, 0)], [0, 1, 0]],
      [[corner(0, 0, 1), corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1)], [0, -1, 0]],
      [[corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1), corner(0, 0, 1)], [0, 0, 1]],
      [[corner(0, 0, 0), corner(0, 1, 0), corner(1, 1, 0), corner(1, 0, 0)], [0, 0, -1]],
    ];
    for (const [quad, n] of faces) {
      const base = pos.length / 3;
      for (const c of quad) {
        pos.push(c[2], c[3], c[4]);
        nrm.push(n[0], n[1], n[2]);
        // The underside of the housing is the lens; every other face is not.
        lamp.push(c[0], c[1], part === PART_HOUSING && n[1] < 0 ? PART_LENS : part);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };

  // The column, tapering the way a real steel one does.
  column(0, R, 0.94, R * 0.78);
  // The arm, rising slightly as it reaches out over the carriageway.
  boxParam(0, 1, 0.94, 1.0, 0, 0, -0.045, 0.045, -0.045, 0.045, PART_STEEL);
  // The lantern: a flat housing hung under the far end of the arm.
  boxParam(1, 1, 1.0, 1.0, -0.34, 0.14, -0.20, -0.02, -0.19, 0.19, PART_HOUSING);

  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nrm),
    aLamp: new Float32Array(lamp),
    index: new Uint16Array(idx),
    triangles: idx.length / 3,
  };
}

export const LAMP_TRIANGLES = buildLampMesh().triangles;

const VERT_COMMON = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 aLamp;   // x along the arm 0..1, y up the column 0..1, z part id

// Two vec4s, not a mat4; see render/instanced.ts.
in vec4 iPos;    // xyz base of the column in world metres, w yaw
in vec4 iShape;  // x mounting height m, y arm reach m, z seed 0..1, w unused

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform vec2 uFade;

${INSTANCE_GLSL}

struct Placed {
  vec3 world;
  vec2 yawCS;
  float part;
  bool culled;
};

Placed placeVertex() {
  Placed o;
  o.world = vec3(0.0);
  o.yawCS = vec2(1.0, 0.0);
  o.part = aLamp.z;
  float d = distance(iPos.xyz, uCameraPos);
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, d);
  o.culled = fade <= 0.0;
  if (o.culled) return o;

  o.yawCS = vec2(cos(iPos.w), sin(iPos.w));
  // The parametric part scales with the instance; the metres of steel do not.
  // A 10 m column is not twice as thick as a 5 m one.
  vec3 local = vec3(position.x + aLamp.x * iShape.y,
                    position.y + aLamp.y * iShape.x,
                    position.z);
  // The fade shrinks the lamp toward its own base rather than toward the world
  // origin, so the last few metres of the ring is a column getting shorter and
  // not a column sliding along the ground.
  local *= fade;
  o.world = instanceToWorld(local, iPos.xyz, o.yawCS, vec3(1.0));
  return o;
}
`;

const VERT = /* glsl */ `
${VERT_COMMON}
out vec3 vNormal;
out vec3 vWorld;
out float vPart;
out float vViewDist;
out float vSeed;

void main() {
  Placed pl = placeVertex();
  if (pl.culled) { gl_Position = INSTANCE_CULLED; return; }
  vNormal = instanceRotate(normal, pl.yawCS);
  vWorld = pl.world;
  vPart = pl.part;
  vSeed = iShape.z;
  vViewDist = distance(pl.world, uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pl.world, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in float vPart;
in float vViewDist;
in float vSeed;
out vec4 fragColor;

// Three steps: the same argument render/traffic.ts makes. A column is 10 m of
// 150 mm steel and the field ends at 950 m.
#define ATMO_STEPS 3
#define ATMO_SUN_STEPS 1
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

void main() {
  vec3 n = normalize(vNormal);
  float part = vPart;

  // Galvanised steel, going greener and duller with age; a run of columns put
  // up in the same year weathers together, so the seed varies slowly.
  vec3 steel = mix(vec3(0.104, 0.108, 0.104), vec3(0.062, 0.068, 0.060), vSeed);
  vec3 housing = vec3(0.145, 0.146, 0.140);
  vec3 albedo = part < 0.5 ? steel : housing;

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunT;
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 ambient = occludedSkyIrradiance(n);
  vec3 moon = uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));

  vec3 lit = albedo * (sunE * ndl * sunVis + ambient + moon);
  lit += albedo * uNightGlow * uNight * 0.5;

  // The lens. This is the whole reason the object is worth drawing at night:
  // the pool on the road already exists, and what it was missing was a source
  // above it. Bright enough to bloom, and warm, because the pool it agrees with
  // is a sodium-to-LED mix; the same hash the road shader uses would be nice
  // here and is not available across the language boundary, so the colour
  // varies on the instance seed and the two only have to agree in POSITION.
  if (part > 1.5) {
    vec3 warm = mix(vec3(1.0, 0.74, 0.40), vec3(0.86, 0.90, 1.0),
                    smoothstep(0.35, 0.75, vSeed));
    // Faded with distance, and not because a distant lamp is dimmer. The lens
    // is 480 by 380 mm, so past a few hundred metres it is under a pixel, and a
    // sub-pixel emitter at five times white is a bloom blob that crawls as the
    // camera moves. The pool on the carriageway already carries the lit street
    // from the air, and it has its own converge-to-the-mean term for exactly
    // this reason; this is that term's counterpart on the object.
    float near = 1.0 - smoothstep(90.0, 430.0, vViewDist);
    lit += warm * uNight * mix(0.35, 5.5, near);
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export interface StreetLampUniforms extends SunShadowUniforms, AoUniforms {
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

export function makeStreetLampUniforms(shadow: SunShadowUniforms): StreetLampUniforms {
  return {
    ...shadow,
    ...aoUniforms(),
    uCameraPos: { value: new THREE.Vector3() },
    uSH: { value: shHemispherical([0.28, 0.36, 0.5], 0.55, 0.45) },
    uFade: { value: new THREE.Vector2(RING_M * FADE_FRACTION, RING_M) },
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
}

export interface StreetLampStats {
  /** Tiles of lit carriageway in the pack. Fixed at construction. */
  indexedTiles: number;
  tiles: number;
  count: number;
  triangles: number;
  /** Instances the capacity could not hold. */
  clipped: number;
  lastBuildMs: number;
  worstBuildMs: number;
  rebuilds: number;
  /** Placed procedurally along the carriageway, and measured in OSM. The two
   *  are reported separately because the honest answer to "is this lamp real"
   *  is different in Paris and in a suburb. */
  procedural: number;
  measured: number;
}

export class StreetLamps {
  readonly group = new THREE.Group();
  readonly uniforms: StreetLampUniforms;
  readonly stats: StreetLampStats = {
    indexedTiles: 0, tiles: 0, count: 0, triangles: 0, clipped: 0,
    lastBuildMs: 0, worstBuildMs: 0, rebuilds: 0, procedural: 0, measured: 0,
  };

  private readonly pack: RoadPack;
  private readonly world: StreetWorld;
  private readonly field: InstancedField;
  private readonly byTile: Map<string, number[]>;
  private readonly ringM: number;
  private readonly triangles: number;
  /** Placement is the expensive half and a tile's lamps never move, so it is
   *  cached exactly as render/trees.ts caches its planted tiles. */
  private readonly cache = new Map<string, LampInstance[]>();
  private atX = Number.NaN;
  private atZ = Number.NaN;

  constructor(pack: RoadPack, world: StreetWorld, shadow: SunShadowUniforms, budget: Budget) {
    this.pack = pack;
    this.world = world;
    this.ringM = budget.tier === "reduced" ? MOBILE_RING_M : RING_M;
    this.uniforms = makeStreetLampUniforms(shadow);
    this.uniforms.uFade.value.set(this.ringM * FADE_FRACTION, this.ringM);

    const mesh = buildLampMesh();
    this.triangles = mesh.triangles;
    const base = new THREE.BufferGeometry();
    base.setAttribute("position", new THREE.BufferAttribute(mesh.position, 3));
    base.setAttribute("normal", new THREE.BufferAttribute(mesh.normal, 3));
    base.setAttribute("aLamp", new THREE.BufferAttribute(mesh.aLamp, 3));
    base.setIndex(new THREE.BufferAttribute(mesh.index, 1));

    this.field = new InstancedField(base, budget.lampInstanceBudget, [
      { name: "iPos", itemSize: 4 },
      { name: "iShape", itemSize: 4 },
    ]);

    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
    });
    const drawn = new THREE.Mesh(this.field.geometry, mat);
    drawn.frustumCulled = false;
    this.group.add(drawn);

    this.byTile = indexWaysByTile(pack.roads, hasStreetLamps);
    this.stats.indexedTiles = this.byTile.size;
  }

  /** Follow a camera. Cheap between tile crossings; safe every frame. */
  update(camX: number, camZ: number): void {
    const tx = Math.floor(camX / 400);
    const tz = Math.floor(camZ / 400);
    if (tx === this.atX && tz === this.atZ) return;
    this.atX = tx;
    this.atZ = tz;

    const t0 = performance.now();
    const wanted = tilesAround(this.byTile, camX, camZ, this.ringM);
    const iPos = this.field.arrays.iPos;
    const iShape = this.field.arrays.iShape;
    let count = 0;
    let measured = 0;
    let clipped = 0;
    const keep = new Set<string>();

    for (const w of wanted) {
      let lamps = this.cache.get(w.key);
      if (!lamps) {
        lamps = [];
        for (const i of this.byTile.get(w.key) ?? []) {
          addLamps(lamps, this.pack.roads[i], i, this.world);
        }
        this.cache.set(w.key, lamps);
      }
      keep.add(w.key);
      for (const l of lamps) {
        if (count >= this.field.capacity) { clipped++; continue; }
        const p = count * 4;
        iPos[p] = l.x;
        iPos[p + 1] = l.y;
        iPos[p + 2] = l.z;
        iPos[p + 3] = l.yaw;
        iShape[p] = l.heightM;
        iShape[p + 1] = l.armM;
        // A stable per-lamp hash: the road it belongs to and how far along it.
        iShape[p + 2] = fract(l.road * 0.6180339887 + l.u * 0.013);
        iShape[p + 3] = 0;
        count++;
        if (l.measured) measured++;
      }
    }

    // A tile is a few hundred small objects; a long flight would otherwise
    // cache the whole city's lamps.
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);

    this.field.upload(count);
    this.stats.tiles = keep.size;
    this.stats.count = count;
    this.stats.measured = measured;
    this.stats.procedural = count - measured;
    this.stats.triangles = count * this.triangles;
    this.stats.clipped = clipped;
    this.stats.lastBuildMs = performance.now() - t0;
    this.stats.worstBuildMs = Math.max(this.stats.worstBuildMs, this.stats.lastBuildMs);
    this.stats.rebuilds++;
  }

  dispose(): void {
    this.field.dispose();
    this.group.clear();
  }
}

const fract = (x: number): number => x - Math.floor(x);
