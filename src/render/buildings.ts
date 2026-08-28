// The skyline: OSM footprints extruded to their real heights, lit by the same
// atmosphere as everything else.
//
// Three decisions carry most of the quality here.
//
// **Chunked, not one mesh.** The buildings are merged into ~1.5 km cells rather
// than a single giant buffer. One mesh cannot be frustum-culled, so flying with
// the city behind you would still pay for every triangle in it. Cells give
// culling for free and still keep the draw call count near a hundred.
//
// **Distance filter by HEIGHT, not by distance alone.** Past a few kilometres a
// two-storey house is a sub-pixel speck that costs a draw and adds nothing, but
// a 300 m tower is the whole reason you look that way. So the far field keeps
// only the tall things, which is also what the eye actually resolves.
//
// **The base is buried at the footprint's LOWEST ground sample.** Placing a
// building at the terrain height of its centroid leaves half of it hanging in
// the air on any slope, and San Francisco is nothing but slope.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import { triangulate, signedArea } from "./earcut";
import type { Building, CityPack } from "../data/citypack";

const CELL_M = 1500;

/**
 * Graduated level of detail: the minimum height a building needs to be kept,
 * as a function of its distance from the city centre.
 *
 * A single radius with a hard height cut-off was wrong in a way that is obvious
 * in flight: the pack origin is one corner of the city, so everything more than
 * a few kilometres from it vanished, and half of San Francisco was missing
 * while you flew over it. A ramp keeps the core complete and thins the outskirts
 * gradually, which is both what the eye expects and what the triangle budget
 * wants -- a two-storey house at 8 km is a sub-pixel speck.
 */
function minHeightAt(distM: number, k: number): number {
  if (distM < FULL_DETAIL_M / k) return 0;
  const t = (distM - FULL_DETAIL_M / k) / (THIN_TO_M - FULL_DETAIL_M / k);
  return Math.min(1, Math.max(0, t)) * MAX_CUTOFF_M * k;
}

const FULL_DETAIL_M = 4200;
const THIN_TO_M = 9000;
const MAX_CUTOFF_M = 40;

/**
 * Triangle budget for the whole skyline.
 *
 * Cities differ in density by more than a factor of five -- San Francisco bakes
 * to 62k buildings and Manhattan to 187k over a similar radius -- so a fixed
 * LOD curve that is right for one is either wasteful or unaffordable for the
 * other. Solving for the curve against a budget makes the frame cost a property
 * of the RENDERER rather than of whichever city was loaded.
 */
const TRIANGLE_BUDGET = 1_500_000;

/** Triangles a footprint costs: two per wall segment, plus the roof fan. */
function triangleCost(vertCount: number): number {
  return vertCount * 2 + Math.max(0, vertCount - 2);
}

/**
 * Find the smallest LOD aggression that fits the budget. Coarse steps, because
 * the difference between k=1 and k=1.5 is invisible and the loop is over every
 * building in the pack.
 */
function solveLod(pack: CityPack): number {
  for (const k of [1, 1.4, 2, 3, 4.5, 7, 11, 18]) {
    let tris = 0;
    for (const b of pack.buildings) {
      if (b.topM - b.baseM < minHeightAt(Math.hypot(b.cx, b.cz), k)) continue;
      tris += triangleCost(b.ring.length / 2);
      if (tris > TRIANGLE_BUDGET) break;
    }
    if (tris <= TRIANGLE_BUDGET) return k;
  }
  return 18;
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;        // x: metres along the wall, y: metres up the wall
in vec4 info;      // seed, kind, isRoof, building height

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;

out vec3 vNormal;
out vec3 vWorld;
out vec2 vUv;
out vec4 vInfo;
out float vViewDist;

void main() {
  vNormal = normal;
  vWorld = position;
  vUv = uv;
  vInfo = info;
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUv;
in vec4 vInfo;
in float vViewDist;
out vec4 fragColor;

// Aerial perspective only: a shorter march than the sky uses. See the note in
// atmosphere.glsl.ts -- this is per-fragment with overdraw, and it is smooth.
#define ATMO_STEPS 7
#define ATMO_SUN_STEPS 2
${ATMOSPHERE_GLSL}
${TONEMAP_GLSL}

uniform vec3  uCameraPos;
uniform vec3  uAmbient;
uniform float uNight;
uniform vec3  uNightGlow;
uniform float uWetness;
uniform float uSunSurface;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Facade palettes by building kind. Real cities are not one colour, and the
// variation between neighbours is what stops an extruded block from reading as
// a grey heightmap.
vec3 facadeColour(float kind, float seed) {
  vec3 c;
  if (kind < 0.5)      c = vec3(0.42, 0.40, 0.38);          // generic
  else if (kind < 1.5) c = vec3(0.52, 0.45, 0.39);          // residential
  else if (kind < 2.5) c = vec3(0.38, 0.41, 0.45);          // commercial
  else if (kind < 3.5) c = vec3(0.40, 0.39, 0.36);          // industrial
  else if (kind < 4.5) c = vec3(0.50, 0.44, 0.40);          // retail
  else if (kind < 5.5) c = vec3(0.55, 0.51, 0.44);          // civic
  else                 c = vec3(0.30, 0.34, 0.40);          // tower
  // Per-building tint, deterministic in the seed so it never flickers.
  vec3 jitter = vec3(hash11(seed), hash11(seed + 7.7), hash11(seed + 19.3)) - 0.5;
  return clamp(c * (1.0 + 0.30 * jitter.x) + 0.06 * jitter, 0.03, 0.9);
}

void main() {
  float seed = vInfo.x;
  float kind = vInfo.y;
  float isRoof = vInfo.z;
  float bldH = vInfo.w;

  vec3 n = normalize(vNormal);
  vec3 albedo = facadeColour(kind, seed);

  float glassiness = 0.0;

  if (isRoof < 0.5) {
    // --- Facade ---------------------------------------------------------
    // Storeys are ~3.2 m; window columns ~2.6 m. Quantising to a real storey
    // height is what makes a building read at the right SIZE: get it wrong and
    // a 40-storey tower looks like a 10-storey one from the same distance.
    const float STOREY = 3.2;
    const float COLUMN = 2.6;

    float floorIdx = floor(vUv.y / STOREY);
    float colIdx = floor(vUv.x / COLUMN);
    vec2 cell = fract(vec2(vUv.x / COLUMN, vUv.y / STOREY));

    // Detail fade. A 2.6 m window at 2 km is far smaller than a pixel, and
    // point-sampling it produces sparkling orange noise rather than a city --
    // the pattern aliases against the pixel grid and every frame lands on
    // different windows. Past the fade distance the pattern is replaced by its
    // own MEAN, which is what a correctly filtered version would converge to.
    float detail = smoothstep(2400.0, 700.0, vViewDist);
    const float WIN_MEAN = 0.68 * 0.62;

    // A tall building is mostly glass; a low one is mostly wall.
    glassiness = smoothstep(18.0, 70.0, bldH) * 0.75 + 0.1;

    // Window rectangle inside the cell, with a sill and a mullion.
    float winPattern = step(0.16, cell.x) * step(cell.x, 0.84)
                     * step(0.30, cell.y) * step(cell.y, 0.92);
    float win = mix(WIN_MEAN, winPattern, detail);

    // Ground floor is taller and shopfront-like, not a repeated window.
    if (vUv.y < STOREY * 1.15) win *= 0.35;

    vec3 glass = mix(vec3(0.10, 0.13, 0.17), vec3(0.16, 0.22, 0.28), hash11(seed + 3.3));
    albedo = mix(albedo, glass, win * glassiness);

    // Horizontal banding between storeys: a thin darker line reads as a floor
    // slab and gives the facade its scale at distance.
    albedo *= 1.0 - 0.18 * detail * smoothstep(0.10, 0.0, cell.y);

    // Ambient occlusion down the wall. Streets are canyons; the bottom five
    // metres of every facade sit in everyone else's shadow.
    float streetAO = mix(0.45, 1.0, smoothstep(0.0, 14.0, vUv.y));
    albedo *= streetAO;

    // --- Lit windows at night -------------------------------------------
    if (uNight > 0.02) {
      float r = hash21(vec2(colIdx + seed * 31.0, floorIdx + seed * 17.0));
      // Occupancy falls off up the building and varies per building.
      float occupancy = mix(0.10, 0.55, hash11(seed + 5.1)) * mix(1.0, 0.55, smoothstep(0.0, 120.0, vUv.y));
      // Same treatment as the window pattern: resolve individual lit windows
      // up close, converge to the average glow of a lit building far away.
      float litPattern = step(1.0 - occupancy, r) * winPattern;
      float lit = mix(occupancy * WIN_MEAN, litPattern, detail);
      vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(0.85, 0.90, 1.0), step(0.82, hash11(r * 91.0)));
      albedo += warm * lit * uNight * 0.85;
    }
  } else {
    // --- Roof -----------------------------------------------------------
    // Roofs are dirtier and flatter than facades, and they are what you see
    // most of from an aircraft, so they get their own noise rather than the
    // facade colour applied upward.
    float g = hash21(floor(vWorld.xz * 0.35) + seed);
    albedo = mix(vec3(0.26, 0.26, 0.25), vec3(0.42, 0.41, 0.38), g);
    // Rooftop plant: a few darker blocks scattered on the big roofs.
    float plant = step(0.93, hash21(floor(vWorld.xz * 0.12) + seed * 3.0));
    albedo = mix(albedo, vec3(0.20, 0.21, 0.22), plant * step(400.0, bldH * 40.0));
  }

  albedo *= (1.0 - 0.35 * uWetness);

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl;

  // Sky visibility: an upward face sees the whole dome, a wall sees half, and
  // a wall down in the street sees less still.
  // Sky visibility. A vertical wall sees roughly half the dome and a roof sees
  // all of it; the floor matters because a shadowed facade lit only by a tenth
  // of the sky goes darker than the in-scattered haze in front of it, and the
  // building reads as a navy silhouette rather than a wall in shade.
  float skyView = 0.62 + 0.38 * n.y;
  // Skyglow reaches walls better than roofs: it comes from the street below.
  vec3 ambient = uAmbient * skyView + uNightGlow * (1.35 - 0.5 * n.y);

  vec3 lit = albedo * (direct + ambient);

  // Specular: strong on glass, present on wet stone, absent otherwise.
  float gloss = max(glassiness * 0.8, uWetness);
  if (gloss > 0.02) {
    vec3 v = normalize(uCameraPos - vWorld);
    vec3 h = normalize(v + uSunDir);
    float spec = pow(max(0.0, dot(n, h)), 64.0);
    lit += uSunColor * uSunIntensity * uSunSurface * sunT * spec * gloss * 1.2;
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);

  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export interface BuildingUniforms extends Record<string, THREE.IUniform> {
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uWetness: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
}

function makeUniforms(): BuildingUniforms {
  return {
    uCameraPos: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uWetness: { value: 0 },
    uSunSurface: { value: 0.105 },
    uExposure: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSunIntensity: { value: 16 },
    uMieG: { value: 0.76 },
    uTurbidity: { value: 1 },
    uCamAltitude: { value: 100 },
    uMultiScatter: { value: 0.055 },
  };
}

interface Scratch {
  pos: number[];
  nrm: number[];
  uv: number[];
  info: number[];
  idx: number[];
}

function emptyScratch(): Scratch {
  return { pos: [], nrm: [], uv: [], info: [], idx: [] };
}

function addBuilding(s: Scratch, b: Building, groundY: number, seed: number): void {
  const n = b.ring.length / 2;
  if (n < 3) return;

  const base = groundY + b.baseM;
  const top = groundY + b.topM;
  const height = top - base;
  if (height <= 0.5) return;

  // Sink the base so the walls meet sloping terrain instead of hovering.
  const sunk = base - 3.0;

  const kind = b.kind;
  const pushInfo = () => s.info.push(seed, kind, 0, b.topM - b.baseM);

  // --- Walls ---
  let run = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = b.ring[i * 2], z0 = b.ring[i * 2 + 1];
    const x1 = b.ring[j * 2], z1 = b.ring[j * 2 + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;

    // Outward normal for a counter-clockwise ring in (x, z).
    const nx = dz / len;
    const nz = -dx / len;

    const v0 = s.pos.length / 3;
    s.pos.push(x0, sunk, z0,  x1, sunk, z1,  x1, top, z1,  x0, top, z0);
    for (let k = 0; k < 4; k++) s.nrm.push(nx, 0, nz);
    // v runs from 0 at the true base (not the sunk base) so the storey grid
    // lines up with the visible building rather than with the buried part.
    const vBot = sunk - base;
    const vTop = height;
    s.uv.push(run, vBot, run + len, vBot, run + len, vTop, run, vTop);
    for (let k = 0; k < 4; k++) pushInfo();
    s.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    run += len;
  }

  // --- Roof ---
  const tri = triangulate(b.ring);
  if (tri.length) {
    const v0 = s.pos.length / 3;
    for (let i = 0; i < n; i++) {
      s.pos.push(b.ring[i * 2], top, b.ring[i * 2 + 1]);
      s.nrm.push(0, 1, 0);
      s.uv.push(b.ring[i * 2], b.ring[i * 2 + 1]);
      s.info.push(seed, kind, 1, b.topM - b.baseM);
    }
    for (let i = 0; i < tri.length; i++) s.idx.push(v0 + tri[i]);
  }
}

function buildMesh(s: Scratch, uniforms: BuildingUniforms): THREE.Mesh | null {
  if (!s.idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(s.pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(s.nrm, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(s.uv, 2));
  geo.setAttribute("info", new THREE.Float32BufferAttribute(s.info, 4));
  geo.setIndex(s.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(s.idx, 1) : new THREE.Uint16BufferAttribute(s.idx, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.RawShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    glslVersion: THREE.GLSL3,
    side: THREE.FrontSide,
  });
  return new THREE.Mesh(geo, mat);
}

export interface BuildingStats {
  drawn: number;
  skippedFar: number;
  triangles: number;
  cells: number;
  /** LOD aggression the budget solver settled on; 1 means everything fits. */
  lod: number;
}

export class Buildings {
  readonly group = new THREE.Group();
  readonly uniforms: BuildingUniforms;
  readonly stats: BuildingStats;

  constructor(pack: CityPack, groundAt: (x: number, z: number) => number) {
    this.uniforms = makeUniforms();
    const lodK = solveLod(pack);
    const cells = new Map<string, Scratch>();
    let drawn = 0;
    let skippedFar = 0;

    for (let i = 0; i < pack.buildings.length; i++) {
      const b = pack.buildings[i];
      const dist = Math.hypot(b.cx, b.cz);
      const h = b.topM - b.baseM;
      if (h < minHeightAt(dist, lodK)) { skippedFar++; continue; }

      // Winding must be counter-clockwise for the wall normals and the ear
      // clipper to agree. The baker normalises it, but a pack from an older
      // baker (or a hand-made one) must not silently render inside out.
      if (signedArea(b.ring) < 0) {
        const r = b.ring;
        for (let a = 0, z = r.length / 2 - 1; a < z; a++, z--) {
          const tx = r[a * 2], tz = r[a * 2 + 1];
          r[a * 2] = r[z * 2]; r[a * 2 + 1] = r[z * 2 + 1];
          r[z * 2] = tx; r[z * 2 + 1] = tz;
        }
      }

      // Lowest ground under the footprint, so nothing floats on a hillside.
      let groundY = Infinity;
      for (let v = 0; v < b.ring.length; v += 2) {
        const g = groundAt(b.ring[v], b.ring[v + 1]);
        if (g < groundY) groundY = g;
      }
      if (!Number.isFinite(groundY)) groundY = groundAt(b.cx, b.cz);

      const key = `${Math.floor(b.cx / CELL_M)},${Math.floor(b.cz / CELL_M)}`;
      let s = cells.get(key);
      if (!s) { s = emptyScratch(); cells.set(key, s); }

      addBuilding(s, b, groundY, (i * 2654435761) % 1024 / 1024);
      drawn++;
    }

    let triangles = 0;
    for (const s of cells.values()) {
      const mesh = buildMesh(s, this.uniforms);
      if (mesh) {
        triangles += s.idx.length / 3;
        this.group.add(mesh);
      }
    }

    this.stats = { drawn, skippedFar, triangles, cells: cells.size, lod: lodK };
  }
}
