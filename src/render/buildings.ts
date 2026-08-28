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
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
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
${SUN_SHADOW_GLSL}

uniform vec3  uCameraPos;
uniform vec3  uAmbient;
uniform float uNight;
uniform vec3  uNightGlow;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
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

// Facade materials.
//
// Keyed mostly on a per-building hash rather than on the OSM kind tag,
// because kind does not vary: most of Manhattan is tagged building=yes, so
// by kind alone produced a city of one grey with a second grey for anything
// over 100 m. Real cities are brick beside sandstone beside concrete beside
// glass, and that variety is most of what makes a skyline read as buildings
// rather than as extruded polygons.
//
// Towers stay keyed on kind: something over 100 m really is steel and glass,
// and giving one a brick facade looks wrong immediately.
vec3 facadeColour(float kind, float seed) {
  float h = hash11(seed * 1.7 + 0.3);
  float v = hash11(seed * 3.1 + 5.2);
  vec3 c;

  if (kind > 5.5) {
    // Tower: glass and steel, cool and fairly dark.
    c = mix(vec3(0.24, 0.28, 0.34), vec3(0.44, 0.47, 0.51), v);
  } else if (h < 0.24) {
    // Brick, the colour most cities are actually made of.
    c = mix(vec3(0.33, 0.16, 0.12), vec3(0.50, 0.27, 0.20), v);
  } else if (h < 0.44) {
    // Sandstone and warm render.
    c = mix(vec3(0.50, 0.43, 0.32), vec3(0.68, 0.59, 0.44), v);
  } else if (h < 0.63) {
    // Pale concrete.
    c = mix(vec3(0.52, 0.51, 0.49), vec3(0.72, 0.71, 0.68), v);
  } else if (h < 0.82) {
    // Grey concrete.
    c = mix(vec3(0.34, 0.35, 0.36), vec3(0.50, 0.51, 0.52), v);
  } else {
    // Painted.
    c = mix(vec3(0.56, 0.52, 0.45), vec3(0.74, 0.68, 0.57), v);
  }

  if (kind > 2.5 && kind < 3.5) c *= 0.88;   // industrial: grubbier
  if (kind > 4.5 && kind < 5.5) c = mix(c, vec3(0.66, 0.62, 0.54), 0.4);  // civic: stone

  // A small per-building shift on top, so neighbours in the same family differ.
  vec3 jitter = vec3(hash11(seed + 11.3), hash11(seed + 19.7), hash11(seed + 27.1)) - 0.5;
  return clamp(c * (1.0 + 0.16 * jitter.x) + 0.045 * jitter, 0.03, 0.94);
}

void main() {
  float seed = vInfo.x;
  float kind = vInfo.y;
  float isRoof = vInfo.z;
  float bldH = vInfo.w;

  vec3 n = normalize(vNormal);
  vec3 albedo = facadeColour(kind, seed);

  // A lit window EMITS. It was being added into the albedo, which then went
  // through the sun and ambient terms like everything else -- so a lit window
  // got dimmer at night, which is the one time it is supposed to be the
  // brightest thing on the building.
  vec3 emissive = vec3(0.0);

  float glassiness = 0.0;

  if (isRoof < 0.5) {
    // --- Facade ---------------------------------------------------------
    // Storeys are ~3.2 m; window columns ~2.6 m. Quantising to a real storey
    // height is what makes a building read at the right SIZE: get it wrong and
    // a 40-storey tower looks like a 10-storey one from the same distance.
    const float STOREY = 3.2;
    const float COLUMN = 2.6;

    vec2 grid = vec2(vUv.x / COLUMN, vUv.y / STOREY);
    float floorIdx = floor(grid.y);
    float colIdx = floor(grid.x);
    vec2 cell = fract(grid);

    // How much of a window cell one pixel covers. Taken on the CONTINUOUS
    // grid coordinate, not on the fract()ed one: fract() has a derivative spike
    // at every seam, and fwidth of that reads as an enormous width along a
    // one-pixel line.
    vec2 w = max(fwidth(grid), vec2(1e-4));

    // Analytic filtering, not a distance fade.
    //
    // A 2.6 m window at 2 km is far smaller than a pixel, and point-sampling
    // it sparkles: the pattern aliases against the pixel grid and every frame
    // lands on different windows. The old answer was to cross-fade the whole
    // pattern to its mean between 4200 m and 900 m, which killed it while it
    // was still several pixels wide -- from 800 m up, most of the city was
    // past the fade, and a city of flat-shaded boxes is exactly what it looked
    // like.
    //
    // Widening each edge by the pixel footprint is what a correctly filtered
    // version does: the windows stay resolved for as long as the PIXELS can
    // hold them, and dissolve into their own mean exactly when they can't.
    // It is also per-pixel rather than per-vertex-distance, so a wall seen
    // edge-on -- where a pixel really does span many windows -- converges even
    // though it is close.
    float detail = 1.0 - clamp(max(w.x, w.y) * 1.6, 0.0, 1.0);
    const float WIN_MEAN = 0.68 * 0.62;

    // A tall building is mostly glass; a low one is mostly wall.
    glassiness = smoothstep(18.0, 70.0, bldH) * 0.75 + 0.1;

    // Window rectangle inside the cell, with a sill and a mullion, every edge
    // softened by the footprint so it antialiases instead of stair-stepping.
    float winPattern =
        smoothstep(0.16 - w.x, 0.16 + w.x, cell.x)
      * smoothstep(0.84 + w.x, 0.84 - w.x, cell.x)
      * smoothstep(0.30 - w.y, 0.30 + w.y, cell.y)
      * smoothstep(0.92 + w.y, 0.92 - w.y, cell.y);
    float win = mix(WIN_MEAN, winPattern, detail);

    // Ground floor is taller and shopfront-like, not a repeated window.
    if (vUv.y < STOREY * 1.15) win *= 0.35;

    vec3 glass = mix(vec3(0.10, 0.13, 0.17), vec3(0.16, 0.22, 0.28), hash11(seed + 3.3));
    albedo = mix(albedo, glass, win * glassiness);

    // Horizontal banding between storeys: a thin darker line reads as a floor
    // slab and gives the facade its scale at distance.
    albedo *= 1.0 - 0.18 * detail * smoothstep(0.10 + w.y, 0.0, cell.y);

    // Ambient occlusion down the wall. Streets are canyons, so the base of a
    // facade genuinely is darker -- but 0.45 over the bottom 14 m stacked with
    // every neighbouring wall doing the same turned the streets into black
    // trenches from the air. Shallower, and over a shorter run.
    float streetAO = mix(0.74, 1.0, smoothstep(0.0, 9.0, vUv.y));
    albedo *= streetAO;

    // --- Lit windows at night -------------------------------------------
    if (uNight > 0.02) {
      float r = hash21(vec2(colIdx + seed * 31.0, floorIdx + seed * 17.0));
      // Occupancy falls off up the building and varies per building.
      float occupancy = mix(0.06, 0.40, hash11(seed + 5.1)) * mix(1.0, 0.55, smoothstep(0.0, 120.0, vUv.y));
      // Same treatment as the window pattern: resolve individual lit windows
      // up close, converge to the average glow of a lit building far away.
      float litPattern = step(1.0 - occupancy, r) * winPattern;
      float lit = mix(occupancy * WIN_MEAN, litPattern, detail);
      // A third of the windows cool. Offices are fluorescent and LED, homes
      // are warm, and a city that is entirely sodium-orange at night is a city
      // from before about 1995.
      vec3 warm = mix(vec3(1.0, 0.74, 0.42), vec3(0.82, 0.88, 1.0), step(0.66, hash11(r * 91.0)));
      // The number to watch is not the peak, it is the MEAN. Far away this
      // converges to occupancy x 0.42 x scale over the whole facade, and at
      // 0.2 that mean was about four times the wall's own night lighting: a
      // warm wash over every surface, which is what made the city read tan
      // however neutral the skyglow and the albedo were made. At 0.09 the mean
      // sits at roughly the wall, so a building is dark with lit windows in
      // it, and the peak is still 12x the wall up close where it should be.
      emissive += warm * lit * uNight * 0.09;
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

  // At night a facade has no colour of its own. It is lit by skyglow and by
  // whatever is lit opposite it, and both are the same colour for every
  // building on the block -- so carrying the daytime brick, sandstone and
  // concrete palette through at full strength is what made a night city read
  // as a tan photograph with dots sprinkled over it. The windows keep their
  // colour, because they are the light source rather than a surface.
  if (uNight > 0.02) {
    float ng = dot(albedo, vec3(0.299, 0.587, 0.114));
    albedo = mix(albedo, vec3(ng * 0.55), uNight * 0.88);
  }

  albedo *= (1.0 - 0.35 * uWetness);

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  // Cascaded shadow map. It multiplies the DIRECT beam and the sun's specular
  // and nothing else: a wall in shadow is still lit by the sky above it and by
  // the light bouncing off everything opposite, which is why real city shadows
  // are blue rather than black.
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl * sunVis;
  // Moonlight, same units as the sun beam. Lit windows alone made a night city
  // read as a floating grid of dots with no buildings behind them; this is
  // what puts the facades back under the lights.
  vec3 beam = direct + uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));

  // Sky visibility: an upward face sees the whole dome, a wall sees half, and
  // a wall down in the street sees less still.
  // Sky visibility. A vertical wall sees roughly half the dome and a roof sees
  // all of it. Under an overcast, where the direct term is almost gone, this is
  // the ONLY thing separating one face from another -- flat ambient across
  // orientations is what makes a city look like untextured boxes.
  float skyView = 0.48 + 0.52 * n.y;
  // North/south faces differ even under cloud, because the sky is brighter
  // toward the sun. A small term, but it restores the sense of which way a
  // building faces.
  skyView *= 1.0 + 0.14 * dot(n, normalize(vec3(uSunDir.x, 0.0, uSunDir.z)));
  // Skyglow reaches walls better than roofs: it comes from the street below.
  vec3 ambient = uAmbient * skyView + uNightGlow * (1.0 - 0.35 * n.y);

  vec3 lit = albedo * (beam + ambient) + emissive;

  // Specular: strong on glass, present on wet stone, absent otherwise.
  float gloss = max(glassiness * 0.8, uWetness);
  if (gloss > 0.02) {
    vec3 v = normalize(uCameraPos - vWorld);
    vec3 h = normalize(v + uSunDir);
    float spec = pow(max(0.0, dot(n, h)), 64.0);
    lit += uSunColor * uSunIntensity * uSunSurface * sunT * spec * gloss * 1.2 * sunVis;
    vec3 hm = normalize(v + uMoonDir);
    lit += uMoonLight * uSunSurface * pow(max(0.0, dot(n, hm)), 64.0) * gloss * 1.2;
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);

  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export interface BuildingUniforms extends SunShadowUniforms {
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
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

/**
 * `shadow` is spread in by REFERENCE, so the cascade matrices and maps the
 * SunShadow pass writes each frame are the same objects these materials read.
 */
function makeUniforms(shadow: SunShadowUniforms): BuildingUniforms {
  return {
    ...shadow,
    uCameraPos: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonLight: { value: new THREE.Color(0, 0, 0) },
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

/** Exported so test/roof.check.ts can gate the real geometry, not a copy. */
export interface Scratch {
  pos: number[];
  nrm: number[];
  uv: number[];
  info: number[];
  idx: number[];
}

export function emptyScratch(): Scratch {
  return { pos: [], nrm: [], uv: [], info: [], idx: [] };
}

export function addBuilding(s: Scratch, b: Building, groundY: number, seed: number): void {
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

    // Winding must agree with the normal above, or backface culling removes the
    // wrong side. It did: the triangle (v0,v1,v2) faces (-dz, 0, dx) while the
    // shading normal is (dz, 0, -dx) -- exactly opposite. So every OUTWARD wall
    // was culled and every inward one drawn, and the buildings rendered as open
    // shells you could see inside, lit by normals pointing away from the face
    // actually on screen.
    s.idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
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
    // REVERSED against the ring's own winding, and that is not a typo.
    //
    // `triangulate` takes a ring that is counter-clockwise in (x, z) and hands
    // back triangles in that same order. Lifted into 3D with y up, a ring that
    // is counter-clockwise in (x, z) winds CLOCKWISE seen from above, so those
    // triangles face STRAIGHT DOWN. With THREE.FrontSide that culls every roof
    // when you look at the city from the air, and a city of open-topped boxes
    // is exactly what it sounds like -- measured at 99.8% of roof triangles on
    // the Manhattan pack before this line was reversed.
    //
    // The walls hit the same trap and carry their own note above.
    // test/roof.check.ts is the gate; it fails if this flips back.
    for (let i = 0; i + 2 < tri.length; i += 3) {
      s.idx.push(v0 + tri[i], v0 + tri[i + 2], v0 + tri[i + 1]);
    }
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
  /** Huge near-flat footprints (rail yards, piers) dropped as visual noise. */
  skippedFlat: number;
  triangles: number;
  cells: number;
  /** LOD aggression the budget solver settled on; 1 means everything fits. */
  lod: number;
}

export class Buildings {
  readonly group = new THREE.Group();
  readonly uniforms: BuildingUniforms;
  readonly stats: BuildingStats;

  constructor(
    pack: CityPack,
    groundAt: (x: number, z: number) => number,
    shadow: SunShadowUniforms,
  ) {
    this.uniforms = makeUniforms(shadow);
    const lodK = solveLod(pack);
    const cells = new Map<string, Scratch>();
    let drawn = 0;
    let skippedFar = 0;
    let skippedFlat = 0;

    for (let i = 0; i < pack.buildings.length; i++) {
      const b = pack.buildings[i];
      const dist = Math.hypot(b.cx, b.cz);
      const h = b.topM - b.baseM;
      if (h < minHeightAt(dist, lodK)) { skippedFar++; continue; }

      // Drop enormous near-flat footprints.
      //
      // OSM tags rail yards, pier decks, quays and station train sheds as
      // buildings. Extruded a couple of metres over a hundred thousand square
      // metres they are not buildings in any visual sense -- they are dark flat
      // plates lying on the ground, and several of Manhattan's sit out in the
      // Hudson looking like holes in the water. A genuine large building (a
      // stadium, a convention centre, a big-box store) clears 8 m easily, so
      // the pair of conditions is narrow: 50 of Manhattan's 187k, 7 of San
      // Francisco's 62k.
      if (h < 8) {
        const area = Math.abs(signedArea(b.ring));
        if (area > 20000) { skippedFlat++; continue; }
      }

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
        // enable, not set: `set` would drop the mesh off layer 0 and the main
        // camera would stop drawing the city altogether.
        mesh.layers.enable(SHADOW_CASTER_LAYER);
        triangles += s.idx.length / 3;
        this.group.add(mesh);
      }
    }

    this.stats = { drawn, skippedFar, skippedFlat, triangles, cells: cells.size, lod: lodK };
  }
}
