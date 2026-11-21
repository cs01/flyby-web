// Alcatraz Island as a hand-built landmark: a lidar ground patch with its own
// z19 drape, the island's structures modelled from OSM, and the lighthouse.
//
// Three hooks into the rest of the scene, all made from main.ts so neither
// the terrain nor the building renderer knows about the island:
//   * alcatrazRingFields(): puts the eroded patch at the head of the terrain's
//     finest-first field list (see data/alcatraz.ts for why eroded).
//   * patchedHeight(): wraps terrain.heightAt so walking, docking and every
//     object placed on the ground uses the lidar.
//   * the city pack's own Alcatraz boxes are dropped from the building
//     renderer by footprint (replacesPackBuilding), but stay in the collider.
//
// The ground patch shades with the terrain's own fragment shader and shares
// the terrain's uniform objects, so its light, fog, shadows and night glow are
// the city's to the bit. Two of those uniforms are its own: the drape, and a
// landcover texture that says "no water here". The city landcover is 10 m a
// texel and would paint the island's low rocky shore as sea; on this patch the
// lidar already says exactly where the water is (the mesh stops at it), so
// the terrain and the ocean around it carry the sea.

import * as THREE from "three";
import { TERRAIN_FRAG, type TerrainUniforms } from "./terrain";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL } from "./sh";
import { AO_GLSL } from "./ao";
import { makeStreetLampUniforms, type StreetLampUniforms } from "./streetlamps";
import { buildAlcatrazModel, pointInRing, DECAL_TEXT, type AlcatrazModel } from "./alcatrazmesh";
import { DECAL_ATLAS_W, DECAL_ATLAS_ROW_H } from "./budget";
import { alcatrazTrees } from "../data/alcatrazveg";
import type { TreeInstance } from "../data/trees";
import { patchedHeight, ringHeight, type AlcatrazMeta, type AlcatrazPatch } from "../data/alcatraz";
import { Heightfield } from "../data/dem";
import type { Origin } from "../geo";
import type { Building } from "../data/citypack";
import type { AlcatrazPlan, TerrainRing } from "./budget";

/**
 * The eroded island shaped as a Heightfield, so it can sit at the head of the
 * Terrain's finest-first field list without that class knowing about it.
 */
class AlcatrazRingField extends Heightfield {
  private readonly height: (lat: number, lon: number) => number;

  constructor(private readonly patch: AlcatrazPatch, base: (lat: number, lon: number) => number) {
    // No grid of its own: sample() is overridden, and a 1x1 data array keeps
    // the base class from allocating a second copy of the patch.
    super(patch.bbox, 1, 1);
    this.loaded = true;
    this.height = ringHeight(patch, base);
  }

  override sample(lat: number, lon: number): number {
    return this.height(lat, lon);
  }

  override contains(lat: number, lon: number): boolean {
    return this.patch.contains(lat, lon);
  }
}

/** The Terrain's own lookup over a field list: the first field that holds the point, else the last. */
function finestFirst(fields: Heightfield[]): (lat: number, lon: number) => number {
  return (lat, lon) => {
    for (const f of fields) if (f.contains(lat, lon)) return f.sample(lat, lon);
    const last = fields[fields.length - 1];
    return last ? last.sample(lat, lon) : 0;
  };
}

/**
 * The terrain's field list with the eroded island at its head.
 *
 * The erosion radius is the largest cell of any ring that can be drawn over
 * the patch: every ring whose square reaches the patch and whose static hole
 * does not swallow it. The detail ring's cells are finer than all of them.
 */
export function alcatrazRingFields(patch: AlcatrazPatch, fields: Heightfield[], rings: TerrainRing[], origin: Origin): Heightfield[] {
  const a = origin.toWorld(patch.bbox.north, patch.bbox.west);
  const b = origin.toWorld(patch.bbox.south, patch.bbox.east);
  const reachX = Math.max(Math.abs(a.x), Math.abs(b.x));
  const reachZ = Math.max(Math.abs(a.z), Math.abs(b.z));
  const nearX = a.x * b.x <= 0 ? 0 : Math.min(Math.abs(a.x), Math.abs(b.x));
  const nearZ = a.z * b.z <= 0 ? 0 : Math.min(Math.abs(a.z), Math.abs(b.z));
  let radius = 0;
  for (let r = 1; r < rings.length; r++) {
    const e = rings[r].extent;
    const hole = r >= 2 ? rings[r - 1].extent : 0;
    const overlaps = Math.max(nearX, nearZ) < e;
    const swallowed = Math.max(reachX, reachZ) < hole;
    if (overlaps && !swallowed) radius = Math.max(radius, (2 * e) / rings[r].segments);
  }
  patch.erode(radius + 1);
  return [new AlcatrazRingField(patch, finestFirst(fields)), ...fields];
}

/**
 * terrain.heightAt with the lidar in it: the TRUE patch height, over the
 * city DEM the rings had before the eroded field went in front of them.
 */
export function alcatrazHeightAt(patch: AlcatrazPatch, fields: Heightfield[], origin: Origin): (x: number, z: number) => number {
  const h = patchedHeight(patch, finestFirst(fields));
  return (x, z) => {
    const ll = origin.toLatLon(x, z);
    return h(ll.lat, ll.lon);
  };
}

/** World box round the lidar's dry land, a few metres generous. */
export function alcatrazIslandBox(patch: AlcatrazPatch, origin: Origin): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const b = patch.bbox;
  for (let j = 0; j < patch.h; j += 2) {
    for (let i = 0; i < patch.w; i += 2) {
      if (patch.heights[j * patch.w + i] <= 0.3) continue;
      const p = origin.toWorld(b.north - ((j + 0.5) / patch.h) * (b.north - b.south), b.west + ((i + 0.5) / patch.w) * (b.east - b.west));
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  }
  return { minX: minX - 5, maxX: maxX + 5, minZ: minZ - 5, maxZ: maxZ + 5 };
}

/** True for a city-pack building standing on the island, which the model replaces. */
export function replacesPackBuilding(island: { minX: number; maxX: number; minZ: number; maxZ: number }, b: Building): boolean {
  return b.cx > island.minX && b.cx < island.maxX && b.cz > island.minZ && b.cz < island.maxZ;
}

const PATCH_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
in vec3 normal;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec3 uCameraPos;
out vec2 vUv;
out vec3 vNormal;
out vec3 vWorld;
out float vViewDist;
void main() {
  // The terrain's vertex shader without the ocean sink: no part of this mesh
  // is open water, so there is nothing to sink.
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vWorld = position;
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The terrain shader with the island's cliff colour put back.
 *
 * The z19 drape is a vertical photograph, so on the sheer faces every texel
 * is stretched down tens of metres from the cliff-top pixel, which is mostly
 * pale: surf, guano, the white seawall. Against the ferry photographs the
 * cliffs read as tan sandstone, grey where shaded, patched with dark
 * scrub and ice plant. Both places the terrain shader reads the drape for
 * colour are wrapped so the steep faces swap the stretched photo for that.
 */
const CLIFF_GLSL = /* glsl */ `
float cliffHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
float cliffNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cliffHash(i), cliffHash(i + vec2(1, 0)), f.x), mix(cliffHash(i + vec2(0, 1)), cliffHash(i + vec2(1, 1)), f.x), f.y);
}
vec3 islandCliff(vec3 photo) {
  vec3 nn = normalize(vNormal);
  float steep = 1.0 - smoothstep(0.45, 0.8, nn.y);
  // Low ground at the waterline stays the photograph's: the seawall and the
  // dock aprons are steep in the lidar too.
  steep *= smoothstep(1.5, 4.0, vWorld.y);
  if (steep <= 0.0) return photo;
  vec2 q = vec2(vWorld.x + vWorld.z, vWorld.y * 1.6);
  float big = cliffNoise(q * 0.06) * 0.6 + cliffNoise(q * 0.21) * 0.4;
  float fine = cliffNoise(q * 1.3);
  vec3 sand = mix(vec3(0.36, 0.26, 0.15), vec3(0.24, 0.21, 0.17), cliffNoise(q * 0.11 + 4.0));
  sand *= 0.8 + 0.4 * fine;
  // Scrub holds on wherever the face eases, and in patches across it.
  float veg = smoothstep(0.5, 0.7, big + 0.35 * nn.y);
  vec3 scrub = mix(vec3(0.035, 0.05, 0.03), vec3(0.08, 0.1, 0.06), fine);
  vec3 cliff = mix(sand, scrub, veg);
  return mix(photo, cliff, steep * 0.85);
}
`;

function islandPatchFrag(): string {
  const a = "srgbToLinear(texture(uDrape, vUv).rgb)";
  const b = "srgbToLinear(textureLod(uDrape, vUv, lodR).rgb)";
  // Fail loudly if the terrain shader is refactored under these hooks, rather
  // than silently drawing the stretched cliffs again.
  if (TERRAIN_FRAG.split(a).length !== 2 || TERRAIN_FRAG.split(b).length !== 2 || TERRAIN_FRAG.split("void main() {").length !== 2) {
    throw new Error("alcatraz: terrain shader no longer has the drape reads the island cliff hook wraps");
  }
  return TERRAIN_FRAG.replace("void main() {", `${CLIFF_GLSL}\nvoid main() {`)
    .replace(a, `islandCliff(${a})`)
    .replace(b, `islandCliff(${b})`);
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 aColour;
in vec3 aSurf;
in vec4 aWall;
in float aDecal;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
out vec3 vNormal;
out vec3 vWorld;
out vec3 vColour;
out vec3 vSurf;
out vec4 vWall;
out float vViewDist;
out float vDecal;
void main() {
  vDecal = aDecal;
  vNormal = normal;
  vWorld = position;
  vColour = aColour;
  vSurf = aSurf;
  vWall = aWall;
  vViewDist = distance(position, uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vColour;
in vec3 vSurf;
in vec4 vWall;
in float vViewDist;
in float vDecal;
out vec4 fragColor;

#define DECALS ${DECAL_TEXT.length}
uniform sampler2D uDecalAtlas;
uniform vec4 uDecalRect[DECALS];
uniform float uDecalGroup[DECALS];

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
uniform vec3  uBeamDir;

float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.1) + 0.2 * vnoise(p * 4.3); }

// The window grid of a facade. Returns (inside, frame, cell id, metres below
// the sill of the window above-or-at this column; -1 when not under one).
// Bays are centred on each facade with a pier at both corners, which is how
// the real elevations are laid out and what keeps a window off a corner.
struct Win { float inside; float frame; float id; float below; };
Win windows(float style, vec4 w) {
  Win o = Win(0.0, 0.0, 0.0, -1.0);
  float u = w.x, v = w.y, len = w.z, H = w.w;
  float bay, ww, sill, wh, pitch, rows, paneX, paneY;
  if (style < 0.5 || style > 6.5 && style < 8.5) return o;
  if (style < 1.5)      { bay = 4.0; ww = 2.1; sill = 2.0; wh = 3.8; pitch = 4.8; rows = 2.0; paneX = 0.26; paneY = 0.48; }
  else if (style < 3.5) { bay = 3.0; ww = 1.1; sill = 0.9; wh = 1.6; pitch = 3.3; rows = 9.0; paneX = 0.55; paneY = 0.8; }
  else if (style < 4.5) { bay = 3.6; ww = 2.8; sill = 1.3; wh = 2.2; pitch = 3.6; rows = 3.0; paneX = 0.46; paneY = 0.44; }
  else if (style < 5.5) { bay = len; ww = 0.5; sill = 3.0; wh = 0.9; pitch = 5.0; rows = 4.0; paneX = 0.5; paneY = 0.45; }
  else if (style > 8.5 && style < 9.5) {
    // Guard tower: a continuous glazed band under the roof.
    float b0 = H - 2.6, b1 = H - 0.5;
    if (v > b0 && v < b1) {
      o.inside = 1.0;
      o.frame = step(fract(u / 1.1), 0.06) + step(abs(v - b0 - 0.9), 0.04);
      o.id = floor(u / 1.1);
    }
    return o;
  } else return o;
  float margin = 0.9;
  float n = floor(max(0.0, len - 2.0 * margin) / bay);
  if (n < 1.0 && style < 4.5) return o;
  float off = (len - n * bay) * 0.5;
  if (style > 4.5 && style < 5.5) { n = 1.0; off = len * 0.04; bay = 1.4; }
  float col = floor((u - off) / bay);
  if (col < 0.0 || col >= n) return o;
  float lx = u - off - col * bay - (bay - ww) * 0.5;
  float row = floor((v - sill) / pitch);
  float ly = v - sill - row * pitch;
  float top = H > 0.0 ? H - 1.2 : 1e4;
  bool rowOk = row >= 0.0 && row < rows;
  bool inCol = lx > 0.0 && lx < ww;
  // Rust and salt run down from the sill of the nearest window above.
  float rAbove = clamp(ceil((v - sill) / pitch), 0.0, rows - 1.0);
  float sillAbove = sill + rAbove * pitch;
  if (lx > -0.1 && lx < ww + 0.1 && v < sillAbove && v > sillAbove - 3.5 && sillAbove < top) o.below = sillAbove - v;
  if (rowOk && inCol && ly >= 0.0 && ly < wh && v < top) {
    o.inside = 1.0;
    float fx = fract(lx / paneX), fy = fract(ly / paneY);
    float bar = style < 1.5 ? 0.16 : 0.08;
    o.frame = max(step(fx, bar), step(fy, bar * 0.8));
    // The outer frame.
    o.frame = max(o.frame, step(lx, 0.07) + step(ww - 0.07, lx) + step(ly, 0.07) + step(wh - 0.07, ly));
    o.id = col * 17.0 + row * 131.0 + floor(len * 3.0);
  }
  return o;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCameraPos - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float style = vSurf.z;
  float glow = vSurf.y;
  float gloss = vSurf.x;
  vec3 albedo = vColour;

  Win w = windows(style, vWall);
  // A roofless ruin's windows are holes.
  if (style > 2.5 && style < 3.5 && w.inside > 0.5 && w.frame < 0.5) discard;

  // --- weathering ---------------------------------------------------------
  // Large blotches of faded and patched paint, then vertical salt and soot
  // runs, then rust bleeding from every barred sill, then splash grime at the
  // foot. Blotches and runs are in wall-plane metres taken from world space,
  // so a free-standing wall (whose facade u restarts every few metres) still
  // weathers continuously; the rust is in facade metres, tied to its window.
  vec2 tng = normalize(vec2(-n.z, n.x) + vec2(1e-4, 0.0));
  vec2 wp = vec2(dot(vWorld.xz, tng), vWorld.y);
  bool isWall = style < 6.5 || (style > 8.5 && style < 9.5);
  // Perturbs the lighting normal: board-form ridges and spalled hollows have
  // to catch the sun, or at eye level the wall is still a flat colour.
  vec2 bump = vec2(0.0);
  if (isWall && abs(n.y) < 0.6) {
    float blot = fbm(vec2(wp.x * 0.18, wp.y * 0.25));
    albedo *= 0.86 + 0.26 * blot;
    float runs = vnoise(vec2(wp.x * 2.3, wp.y * 0.07)) * vnoise(vec2(wp.x * 0.7, wp.y * 0.2 + 3.0));
    // Fine grain and the faint lift lines of poured concrete.
    albedo *= 0.9 + 0.16 * vnoise(wp * 7.0);
    albedo *= 1.0 - 0.06 * smoothstep(0.03, 0.0, abs(fract(wp.y / 1.2) - 0.5) - 0.47);
    albedo *= 1.0 - 0.28 * smoothstep(0.25, 0.7, runs);
    // Eye-level detail, faded out by 60 m where it would only alias: the
    // 15 cm boards of the formwork, the tie-rod holes on a 60 cm grid, and
    // patches where the paint and skin have spalled to the darker aggregate.
    // Orange lichen, low on the walls and in the yard where spray reaches:
    // the warm stain every eye-level photograph of the yard walls shows.
    float lichen = smoothstep(0.62, 0.75, fbm(wp * 0.45 + 11.0)) * (1.0 - smoothstep(1.0, 6.0, vWall.y));
    albedo = mix(albedo, vec3(0.5, 0.3, 0.11), lichen * 0.4);
    // The cellhouse's rusticated base: channelled block joints up its first
    // three metres under the windows.
    if (style > 0.5 && style < 1.5 && vWall.y < 3.0) {
      float course = fract(vWall.y / 0.6);
      float block = fract(vWall.x / 1.5 + 0.5 * floor(vWall.y / 0.6));
      float joint = max(smoothstep(0.06, 0.0, course), smoothstep(0.03, 0.0, block));
      albedo *= 1.0 - 0.35 * joint;
      bump.y += (smoothstep(0.0, 0.08, course) - 1.0) * 0.4 * (1.0 - smoothstep(40.0, 120.0, vViewDist));
    }
    float near = 1.0 - smoothstep(25.0, 60.0, vViewDist);
    if (near > 0.0) {
      float board = fract(wp.y / 0.15 + 0.15 * vnoise(vec2(wp.x * 0.3, floor(wp.y / 0.15))));
      float seam = smoothstep(0.08, 0.0, board) + smoothstep(0.92, 1.0, board);
      albedo *= 1.0 - 0.07 * seam * near;
      bump.y += (smoothstep(0.0, 0.1, board) - smoothstep(0.9, 1.0, board) - 0.5) * 0.12 * near;
      vec2 tie = abs(fract(wp / vec2(0.6, 0.6) + vec2(0.5, 0.25)) - 0.5) * 0.6;
      albedo *= 1.0 - 0.35 * smoothstep(0.022, 0.012, length(tie)) * near;
      float sp = fbm(wp * 0.9 + 7.3) + 0.25 * vnoise(wp * 9.0);
      float spall = smoothstep(0.71, 0.74, sp);
      albedo = mix(albedo, albedo * vec3(0.84, 0.82, 0.78) + vec3(0.015), spall * near);
      bump += vec2(vnoise(wp * 9.0) - 0.5, vnoise(wp * 9.0 + 3.1) - 0.5) * (0.12 + 0.5 * spall) * near;
      // Pale salt bloom along the top of each spalled patch.
      albedo = mix(albedo, vec3(0.86, 0.85, 0.8), smoothstep(0.66, 0.71, sp) * (1.0 - spall) * 0.3 * near);
    }
    if (w.below > 0.0) {
      float streak = vnoise(vec2(vWall.x * 6.0, vWall.y * 0.4)) * exp(-w.below * 0.7);
      albedo = mix(albedo, vec3(0.32, 0.17, 0.09), clamp(streak * 0.9, 0.0, 0.6));
    }
    albedo *= mix(0.62, 1.0, smoothstep(0.0, 1.6, vWall.y));
  }
  if (style > 5.5 && style < 6.5) {
    // Painted steel: rust where the paint has gone, and runs below the seams.
    float rp = fbm(vWorld.xz * 0.9 + vWorld.y * 0.6);
    float runs = vnoise(vec2(vWall.x * 3.0, vWall.y * 0.12));
    float rust = smoothstep(0.55, 0.75, rp) + 0.6 * smoothstep(0.5, 0.85, runs);
    albedo = mix(albedo, vec3(0.3, 0.14, 0.07), clamp(rust, 0.0, 0.85));
  }
  if (style > 9.5) {
    // Kept-up paint: a faint mottle, rust in specks, and short runs below
    // the rivet seams, heaviest low on the tank where water sits.
    albedo *= 0.94 + 0.08 * fbm(vWorld.xz * 0.7 + vWorld.y * 0.9);
    float specks = smoothstep(0.86, 0.93, vnoise(vec2(vWall.x * 6.0, vWall.y * 6.0)));
    float runs = vnoise(vec2(vWall.x * 5.0, vWall.y * 0.25)) * smoothstep(0.7, 0.9, vnoise(vec2(vWall.x * 1.3, 1.7)));
    albedo = mix(albedo, vec3(0.32, 0.16, 0.08), clamp(specks * 0.7 + runs * 0.45, 0.0, 0.7));
  }
  if (style > 6.5 && style < 7.5) {
    float t = fbm(vWorld.xz * 0.35);
    albedo *= 0.75 + 0.45 * t;
  }

  // Painted lettering, crisp from the atlas, the brush paint faded unevenly.
  if (vDecal > 0.5) {
    for (int i = 0; i < DECALS; i++) {
      if (abs(uDecalGroup[i] - vDecal) > 0.5) continue;
      vec4 r = uDecalRect[i];
      vec2 st = vec2((vWall.x - r.x) / r.z + 0.5, (vWall.y - r.y) / r.w + 0.5);
      if (st.x < 0.0 || st.x > 1.0 || st.y < 0.0 || st.y > 1.0) continue;
      float a = texture(uDecalAtlas, vec2(st.x, (float(i) + 1.0 - st.y) / float(DECALS))).r;
      float fade = 0.75 + 0.25 * vnoise(vWall.xy * 3.0);
      albedo = mix(albedo, vec3(0.43, 0.06, 0.04), a * fade);
    }
  }
  if (bump != vec2(0.0)) {
    vec3 t = normalize(vec3(-n.z, 0.0, n.x) + vec3(1e-4, 0.0, 0.0));
    n = normalize(n + t * bump.x + vec3(0.0, 1.0, 0.0) * bump.y);
  }

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunT;
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 ambient = occludedSkyIrradiance(n);
  vec3 moon = uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));

  vec3 lit;
  vec3 h = normalize(uSunDir + v);
  if (w.inside > 0.5 && w.frame < 0.5 || style > 7.5 && style < 8.5) {
    // Glass in front of a dark room: a little of the room, the sky in the
    // glass at grazing angles, and the sun's glint.
    float fres = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(n, v)), 5.0);
    vec3 room = vec3(0.025, 0.024, 0.022) * (ambient + sunE * 0.05);
    lit = room + shIrradiance(reflect(-v, n)) * 0.25 * (0.3 + fres);
    lit += sunE * pow(max(0.0, dot(n, h)), 300.0) * 0.6 * sunVis;
    if (glow > 1.5 && h11(w.id + floor(vWorld.x * 0.1)) > 0.62) {
      lit += vec3(1.0, 0.68, 0.36) * 1.6 * uNight;
    }
    if (glow > 0.5 && glow < 1.5) {
      // The lantern: always faintly lit, a flash when the beam sweeps past
      // this side of the glazing, and the full lamp at night.
      float face = pow(max(0.0, dot(normalize(vec3(n.x, 0.0, n.z)), uBeamDir)), 6.0);
      lit += vec3(1.0, 0.93, 0.8) * (0.3 + uNight * (6.0 + 30.0 * face));
    }
  } else {
    vec3 a = w.inside > 0.5 ? vec3(0.07, 0.07, 0.068) : albedo;
    // Sunlit ground bouncing onto the walls: without it a shaded facade went
    // near black against the bright sky, which no photograph of the island
    // shows (its paved yards and pale rock throw a lot of light back up).
    // A quarter albedo of ground lit at the sun's elevation, seen over half
    // the hemisphere by a vertical wall.
    vec3 bounce = sunE * max(0.0, uSunDir.y) * 0.25 * 0.5 * (1.0 - n.y);
    lit = a * (sunE * ndl * sunVis + ambient + moon + bounce);
    lit += a * uNightGlow * uNight * 0.5;
    float spec = pow(max(0.0, dot(n, h)), mix(6.0, 90.0, gloss)) * (0.03 + 0.2 * gloss) * ndl;
    lit += sunE * spec * sunVis;
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

const BEAM_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform float uNight;
out vec4 fragColor;
void main() {
  // uv.y runs 0 at the lantern to 1 at the far end; uv.x round the cone. The
  // edges fade so the cone has no silhouette, the length fades as scattered
  // light does, and the whole beam exists only at night.
  // Clamped: the interpolated uv overshoots 1 by an ulp at the mouth, and
  // pow() of a negative base is NaN, which the bloom spread into a black square.
  float along = clamp(vUv.y, 0.0, 1.0);
  float rim = sin(vUv.x * 3.14159265 * 2.0) * 0.5 + 0.5;
  float a = pow(1.0 - along, 2.2) * (0.35 + 0.65 * rim) * smoothstep(0.0, 0.03, along);
  fragColor = vec4(vec3(1.0, 0.94, 0.82) * a * 0.16 * uNight, 1.0);
}
`;

export interface AlcatrazUniforms extends StreetLampUniforms {
  uBeamDir: THREE.IUniform<THREE.Vector3>;
  uDecalAtlas: THREE.IUniform<THREE.Texture>;
  uDecalRect: THREE.IUniform<THREE.Vector4[]>;
  uDecalGroup: THREE.IUniform<number[]>;
}

/**
 * The painted lettering as one single-channel atlas, a row per DECAL_TEXT
 * entry, drawn at startup rather than shipped: the text is a few dozen
 * characters and a canvas draws them crisper than any JPEG would keep them.
 * Each letter is set a little askew and off the line, because these were
 * brushed by hand and a typeset line reads as a modern sign.
 */
export function makeDecalAtlas(): THREE.DataTexture {
  const W = DECAL_ATLAS_W, RH = DECAL_ATLAS_ROW_H, rows = DECAL_TEXT.length;
  const data = new Uint8Array(W * RH * rows);
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, RH * rows) : null;
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (ctx) {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (let r = 0; r < rows; r++) {
      const d = DECAL_TEXT[r];
      // Atlas pixels per metre differ across and up a row; squeeze the
      // drawing so the letters come out the right shape on the wall.
      const sx = (W / d.w) / (RH / d.h);
      let px = RH * 0.78;
      ctx.font = `${px}px "Arial Narrow", Arial, sans-serif`;
      const natural = ctx.measureText(d.text).width * sx;
      if (natural > W * 0.96) px *= (W * 0.96) / natural;
      ctx.font = `${px}px "Arial Narrow", Arial, sans-serif`;
      ctx.lineWidth = px * 0.05;
      const total = ctx.measureText(d.text).width * sx;
      let x = (W - total) / 2;
      for (const ch of d.text) {
        const cw = ctx.measureText(ch).width * sx;
        ctx.save();
        ctx.translate(x + cw / 2, r * RH + RH / 2 + (rnd() - 0.5) * RH * 0.08);
        ctx.rotate((rnd() - 0.5) * 0.14);
        ctx.scale(sx * (0.94 + rnd() * 0.12), 0.94 + rnd() * 0.12);
        ctx.textAlign = "center";
        ctx.fillText(ch, 0, 0);
        ctx.strokeText(ch, 0, 0);
        ctx.restore();
        x += cw;
      }
    }
    const img = ctx.getImageData(0, 0, W, RH * rows).data;
    for (let i = 0; i < data.length; i++) data[i] = img[i * 4 + 3];
  }
  const t = new THREE.DataTexture(data, W, RH * rows, THREE.RedFormat, THREE.UnsignedByteType);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export interface AlcatrazStats {
  patchTriangles: number;
  buildingTriangles: number;
  structures: number;
  gpuBytes: number;
  buildMs: number;
}

/** A 1x1 landcover: no water, some built ground, a little green. See the module comment. */
function dryLand(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 110, 20, 50]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export class Alcatraz {
  readonly group = new THREE.Group();
  readonly uniforms: AlcatrazUniforms;
  readonly stats: AlcatrazStats = { patchTriangles: 0, buildingTriangles: 0, structures: 0, gpuBytes: 0, buildMs: 0 };
  readonly model: AlcatrazModel;
  private readonly beam: THREE.Mesh | null = null;
  private readonly beamUniforms = { uNight: { value: 0 } };
  private readonly patchMat: THREE.RawShaderMaterial;
  private readonly origin: Origin;
  private readonly heightAt: (x: number, z: number) => number;

  constructor(opts: {
    meta: AlcatrazMeta;
    patch: AlcatrazPatch;
    origin: Origin;
    heightAt: (x: number, z: number) => number;
    terrainUniforms: TerrainUniforms;
    shadow: SunShadowUniforms;
    plan: AlcatrazPlan;
    drape: ImageBitmap | null;
  }) {
    const t0 = performance.now();
    const { meta, patch, origin, heightAt, plan } = opts;
    this.origin = origin;
    this.heightAt = heightAt;
    this.group.name = "alcatraz";

    // --- the ground ---------------------------------------------------------
    const step = plan.gridStep;
    const gw = Math.floor((patch.w - 1) / step) + 1;
    const gh = Math.floor((patch.h - 1) / step) + 1;
    const db = meta.drape.bbox;
    const vid = new Int32Array(gw * gh).fill(-1);
    const hs = new Float32Array(gw * gh);
    const pos: number[] = [];
    const uvs: number[] = [];
    const nrm: number[] = [];
    const cellLon = (patch.bbox.east - patch.bbox.west) / patch.w;
    const cellLat = (patch.bbox.north - patch.bbox.south) / patch.h;
    const llOf = (i: number, j: number): [number, number] => [
      patch.bbox.north - (j * step + 0.5) * cellLat,
      patch.bbox.west + (i * step + 0.5) * cellLon,
    ];
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = Math.min(patch.h - 1, j * step) * patch.w + Math.min(patch.w - 1, i * step);
        hs[j * gw + i] = patch.heights[k];
      }
    }
    // A quad is drawn when any corner is above the water: the shore triangles
    // then run down to the sea surface and the ocean meets real rock.
    const keep = (i: number, j: number): boolean =>
      Math.max(hs[j * gw + i], hs[j * gw + i + 1], hs[(j + 1) * gw + i], hs[(j + 1) * gw + i + 1]) > 0.05;
    const index: number[] = [];
    const dxM = patch.cellX * step;
    const dzM = patch.cellZ * step;
    const vert = (i: number, j: number): number => {
      const id = j * gw + i;
      if (vid[id] >= 0) return vid[id];
      const [lat, lon] = llOf(i, j);
      const p = origin.toWorld(lat, lon);
      const y = heightAt(p.x, p.z);
      const hx = (hs[j * gw + Math.min(gw - 1, i + 1)] - hs[j * gw + Math.max(0, i - 1)]) / (dxM * (Math.min(gw - 1, i + 1) - Math.max(0, i - 1)));
      // Row j grows SOUTH, which is +z in world space.
      const hz = (hs[Math.min(gh - 1, j + 1) * gw + i] - hs[Math.max(0, j - 1) * gw + i]) / (dzM * (Math.min(gh - 1, j + 1) - Math.max(0, j - 1)));
      const nl = Math.hypot(hx, 1, hz);
      vid[id] = pos.length / 3;
      pos.push(p.x, y, p.z);
      nrm.push(-hx / nl, 1 / nl, -hz / nl);
      uvs.push((lon - db.west) / (db.east - db.west), (db.north - lat) / (db.north - db.south));
      return vid[id];
    };
    for (let j = 0; j < gh - 1; j++) {
      for (let i = 0; i < gw - 1; i++) {
        if (!keep(i, j)) continue;
        const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();

    const drapeTex = opts.drape ? new THREE.Texture(opts.drape as unknown as HTMLImageElement) : null;
    if (drapeTex) {
      // Decoded by the terrain shader's srgbToLinear, and stored north-up like
      // the ring drapes; see drapeTexture() in render/terrain.ts for both.
      drapeTex.colorSpace = THREE.NoColorSpace;
      drapeTex.flipY = false;
      drapeTex.anisotropy = 16;
      drapeTex.generateMipmaps = true;
      drapeTex.minFilter = THREE.LinearMipmapLinearFilter;
      drapeTex.wrapS = drapeTex.wrapT = THREE.ClampToEdgeWrapping;
      drapeTex.needsUpdate = true;
    }
    const land = dryLand();
    this.patchMat = new THREE.RawShaderMaterial({
      vertexShader: PATCH_VERT,
      fragmentShader: islandPatchFrag(),
      // By reference: every value main.ts writes into the terrain's uniforms
      // each frame lands here too. Only the drape and landcover are ours.
      uniforms: {
        ...opts.terrainUniforms,
        uDrape: { value: drapeTex ?? opts.terrainUniforms.uDrape.value },
        uLandNear: { value: land },
        uLandFar: { value: land },
      },
      glslVersion: THREE.GLSL3,
    });
    const ground = new THREE.Mesh(geo, this.patchMat);
    ground.name = "alcatraz-ground";
    ground.layers.enable(SHADOW_CASTER_LAYER);
    // After the rings (renderOrder 0..n), so the rings' depth is down first
    // and the patch's few overlapping fragments resolve on depth alone.
    ground.renderOrder = 10;
    this.group.add(ground);
    this.stats.patchTriangles = index.length / 3;

    // --- the structures -----------------------------------------------------
    this.model = buildAlcatrazModel({
      features: meta.features,
      toWorld: (lat, lon) => origin.toWorld(lat, lon),
      groundAt: heightAt,
    });
    const decalRect = DECAL_TEXT.map(() => new THREE.Vector4(0, 0, 1, 1));
    const decalGroup = DECAL_TEXT.map(() => 0);
    for (const d of this.model.decals) {
      decalRect[d.row].set(...d.rect);
      decalGroup[d.row] = d.group;
    }
    this.uniforms = {
      ...makeStreetLampUniforms(opts.shadow),
      uBeamDir: { value: new THREE.Vector3(1, 0, 0) },
      uDecalAtlas: { value: makeDecalAtlas() },
      uDecalRect: { value: decalRect },
      uDecalGroup: { value: decalGroup },
    };
    const m = this.model.mesh;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
    bg.setAttribute("normal", new THREE.BufferAttribute(m.normal, 3));
    bg.setAttribute("aColour", new THREE.BufferAttribute(m.colour, 3));
    bg.setAttribute("aSurf", new THREE.BufferAttribute(m.surf, 3));
    bg.setAttribute("aWall", new THREE.BufferAttribute(m.wall, 4));
    bg.setAttribute("aDecal", new THREE.BufferAttribute(m.decal, 1));
    bg.setIndex(new THREE.BufferAttribute(m.index, 1));
    bg.computeBoundingSphere();
    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      // Ruins and struts are seen from both sides; the shader turns the normal to the eye.
      side: THREE.DoubleSide,
    });
    const structures = new THREE.Mesh(bg, mat);
    structures.name = "alcatraz-structures";
    structures.layers.enable(SHADOW_CASTER_LAYER);
    this.group.add(structures);
    this.stats.buildingTriangles = m.triangles;
    this.stats.structures = this.model.modelled.length;

    // --- the lighthouse beam ------------------------------------------------
    const L = this.model.lantern;
    if (L) {
      // A pair of cones pointing opposite ways from the lantern, turned about
      // the vertical by update(). Open-ended and additive, so they need no
      // sorting and cost a few hundred fragments a pixel column at most.
      const cone = new THREE.CylinderGeometry(22, 0.5, 900, 16, 1, true);
      cone.translate(0, 450, 0);
      cone.rotateZ(-Math.PI / 2);
      const back = cone.clone();
      back.rotateY(Math.PI);
      const merged = mergeTwo(cone, back);
      const beamMat = new THREE.RawShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: this.beamUniforms,
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(merged, beamMat);
      beam.position.set(L.x, L.y, L.z);
      beam.name = "alcatraz-beam";
      beam.frustumCulled = false;
      beam.renderOrder = 20;
      this.beam = beam;
      this.group.add(beam);
    }

    const geoBytes = (g: THREE.BufferGeometry): number => {
      let s = 0;
      for (const a of Object.values(g.attributes)) s += (a as THREE.BufferAttribute).array.byteLength;
      return s + (g.index ? g.index.count * 4 : 0);
    };
    const [dw, dh] = plan.drapePx >= 1024 ? meta.drape.size : meta.drape.small;
    const atlasBytes = Math.round(DECAL_ATLAS_W * DECAL_ATLAS_ROW_H * DECAL_TEXT.length * (4 / 3));
    this.stats.gpuBytes = geoBytes(geo) + geoBytes(bg) + (drapeTex ? Math.round(dw * dh * 4 * (4 / 3)) : 0) + atlasBytes;
    this.stats.buildMs = performance.now() - t0;
  }

  /** The island's groves (data/alcatrazveg.ts), kept off every roof and out of the yard. */
  islandTrees(): TreeInstance[] {
    const { footprints, yard } = this.model;
    const blocked = (x: number, z: number): boolean =>
      (yard !== null && pointInRing(x, z, yard)) || footprints.some((r) => pointInRing(x, z, r));
    return alcatrazTrees((lat, lon) => this.origin.toWorld(lat, lon), this.heightAt, blocked);
  }

  /**
   * Per frame. The light turns once every ten seconds (two beams, so a
   * flash every five, the real characteristic); `time` is frozen in shot
   * mode, which parks the beam at a fixed bearing.
   */
  update(time: number, night: number): void {
    const a = 0.9 + (time / 10) * Math.PI * 2;
    this.uniforms.uBeamDir.value.set(Math.cos(a), 0, -Math.sin(a));
    if (this.beam) {
      this.beam.rotation.y = a;
      this.beam.visible = night > 0.05;
    }
    this.beamUniforms.uNight.value = night;
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const pa = a.getAttribute("position").array as Float32Array;
  const pb = b.getAttribute("position").array as Float32Array;
  const ua = a.getAttribute("uv").array as Float32Array;
  const ub = b.getAttribute("uv").array as Float32Array;
  const pos = new Float32Array(pa.length + pb.length);
  pos.set(pa);
  pos.set(pb, pa.length);
  const uv = new Float32Array(ua.length + ub.length);
  uv.set(ua);
  uv.set(ub, ua.length);
  const ia = Array.from(a.index!.array);
  const off = pa.length / 3;
  const ib = Array.from(b.index!.array).map((i) => i + off);
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  // Cylinder uv.y is 1 at the top, which after the rotation is the far end:
  // already the 0 at the lantern, 1 at the far end the beam shader wants.
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex([...ia, ...ib]);
  return out;
}

/** Fetch and decode the drape for the plan's size. Null on failure; the patch then borrows a ring drape. */
export async function loadAlcatrazDrape(plan: AlcatrazPlan, base = "landmarks"): Promise<ImageBitmap | null> {
  try {
    const r = await fetch(`${base}/${plan.drapePx >= 1024 ? "alcatraz-drape.jpg" : "alcatraz-drape-small.jpg"}`);
    if (!r.ok) return null;
    return await createImageBitmap(await r.blob(), { imageOrientation: "none", colorSpaceConversion: "none", premultiplyAlpha: "none" });
  } catch {
    return null;
  }
}
