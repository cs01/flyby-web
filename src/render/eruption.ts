// The eruption drawn: the column over Vesuvius and its umbrella, the pumice
// falling round the camera and lying on the town, the dark, the lamps that
// matter in it, the quakes, and the surge rolling down at dawn. The numbers
// all come from sim/eruption.ts; this file only turns them into pixels.
//
// Where the dark comes from. Nothing here draws a fog. The fall's haze is the
// renderer's own aerial perspective with the aerosol load raised until the
// extinction matches the visibility, so every material that already calls
// atmosphere() (terrain, the town, the people, the sky) closes in on the
// camera together; and the sun and sky light are scaled by the plume's light
// factor before they reach any shader. The eye's adaptation is an exposure
// lift so a lamp-lit street reads as a street rather than as black.
//
// Phone budget: billows, pumice and glow are three instanced draws whose
// counts are set by the device tier; the umbrella is one grid mesh.

import * as THREE from "three";
import type { Weather } from "../data/weather";
import type { SceneLighting } from "./lighting";
import { COLUMN_H, ROOF_FAIL_END_M, ROOF_FAIL_START_M, ROOF_FALL_M, eruptionAt, hourAtDepth, type EruptionState } from "../sim/eruption";
import { LEAN, columnRadiusM, plumeShape } from "../sim/plume";
import { pointInRing } from "../data/pompeii";
import type { RoofInfo } from "./pompeiimesh";
import { EruptionVolume } from "./eruptionvolume";

// --- what the town's own shader reads --------------------------------------

export interface EruptionSurfaceUniforms {
  /** x pumice lift in metres (floor and streets), y whiteness, z cover 0..1, w lightning flash on the town. */
  uAsh: THREE.IUniform<THREE.Vector4>;
  /** The fall's footprint: vent x, vent z, pumice depth at Pompeii (m), whiteness. */
  uAshFan: THREE.IUniform<THREE.Vector4>;
  /** The carried lamp: xyz, w intensity (0 off). */
  uLamp: THREE.IUniform<THREE.Vector4>;
  /** Torches carried by the townsfolk near the camera. */
  uTorch: THREE.IUniform<THREE.Vector4[]>;
  /** For the terrain: x share of the camera outside the fall, y daylight under the plume, z eruption on, w column grown 0..1. */
  uAshView: THREE.IUniform<THREE.Vector4>;
}

export const TORCH_SLOTS = 6;

/** One set, spread by reference into the town's uniforms, like streetLightUniforms. */
export const eruptionSurfaceUniforms: EruptionSurfaceUniforms = {
  uAsh: { value: new THREE.Vector4(0, 1, 0, 0) },
  uAshFan: { value: new THREE.Vector4(0, 0, 0, 1) },
  uLamp: { value: new THREE.Vector4(0, 0, 0, 0) },
  uTorch: { value: Array.from({ length: TORCH_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uAshView: { value: new THREE.Vector4(0, 1, 0, 0) },
};

/** Downwind: the plume's axis ran south-east over Pompeii (bearing toward, radians). */
export const WIND_TOWARD = (150 * Math.PI) / 180;

/**
 * Share of Pompeii's pumice depth lying at (x, z), 0..1: the fan downwind of
 * the vent that the deposit maps show, widening south-east. 1 over the town
 * and for kilometres round it, so the town floor and the countryside rise
 * together and there is no step at the gates. Mirrored in ASH_FAN_GLSL.
 */
export function ashFanAt(ventX: number, ventZ: number, x: number, z: number): number {
  const fx = Math.sin(WIND_TOWARD), fz = -Math.cos(WIND_TOWARD);
  const dx = x - ventX, dz = z - ventZ;
  const along = dx * fx + dz * fz, cross = Math.abs(-dx * fz + dz * fx);
  const half = 5000 + 0.35 * Math.max(0, along);
  const c = Math.min(1, Math.max(0, (half + 2500 - cross) / 5000));
  return c * Math.min(1, Math.max(0, (along - 500) / 3500));
}

/** Metres the ground at (x, z) is raised by pumice: none on the sea or the shore line. */
export function ashLiftAt(fan: THREE.Vector4, x: number, z: number, groundY: number): number {
  if (fan.z <= 0) return 0;
  const shore = Math.min(1, Math.max(0, (groundY - 0.3) / 1.2));
  return fan.z * ashFanAt(fan.x, fan.y, x, z) * shore * shore * (3 - 2 * shore);
}

/**
 * What the fall looks like lying on the ground. The white phase's pumice is a
 * pale buff, the grey phase's a mid grey; the fine ash dusting the mountain
 * under the column is darker than either. Albedos, never brighter than old
 * plaster: at snow's 0.9 the afternoon sun on the fan read as a snowfield.
 */
export const PUMICE_WHITE: readonly [number, number, number] = [0.58, 0.53, 0.45];
export const PUMICE_GREY: readonly [number, number, number] = [0.34, 0.33, 0.31];
export const VENT_ASH: readonly [number, number, number] = [0.13, 0.12, 0.11];

/** The pumice's albedo at the top of the deposit: whiteness 1 white phase, 0 grey. Mirrored in PUMICE_GLSL. */
export function pumiceAlbedo(whiteness: number): [number, number, number] {
  const w = Math.min(1, Math.max(0, whiteness));
  return [0, 1, 2].map((i) => PUMICE_GREY[i] + (PUMICE_WHITE[i] - PUMICE_GREY[i]) * w) as [number, number, number];
}

const v3 = (c: readonly number[]) => `vec3(${c.map((x) => x.toFixed(4)).join(", ")})`;
export const PUMICE_GLSL = /* glsl */ `
vec3 pumiceColour(float white) { return mix(${v3(PUMICE_GREY)}, ${v3(PUMICE_WHITE)}, clamp(white, 0.0, 1.0)); }
`;

const ASH_FAN_GLSL = /* glsl */ `
uniform vec4 uAshFan;
float ashFan(vec2 xz) {
  vec2 f = vec2(${Math.sin(WIND_TOWARD).toFixed(6)}, ${(-Math.cos(WIND_TOWARD)).toFixed(6)});
  vec2 d = xz - uAshFan.xy;
  float along = dot(d, f), cross = abs(-d.x * f.y + d.y * f.x);
  float half_ = 5000.0 + 0.35 * max(0.0, along);
  return clamp((half_ + 2500.0 - cross) / 5000.0, 0.0, 1.0) * clamp((along - 500.0) / 3500.0, 0.0, 1.0);
}
float ashLift(vec3 p) {
  if (uAshFan.z <= 0.0) return 0.0;
  return uAshFan.z * ashFan(p.xz) * smoothstep(0.3, 1.5, p.y);
}
`;

/**
 * The town's roofs falling in (sim/eruption.ts roofCollapse, from the byte
 * render/pompeiimesh.ts stores in surf.w). Vertex stage: the share fallen,
 * -1 for anything that is not roof, and the frame slumping as it goes.
 * Timber counts only facing down (eave and portico soffits): doors and
 * counters are timber too and stay put.
 */
export const ROOF_COLLAPSE_VERT_GLSL = /* glsl */ `
out float vRoof;
float roofFallen(vec4 surf, float ny) {
  float st = floor(surf.x + 0.5);
  if (surf.w < 0.5 || !(st == 1.0 || (st == 7.0 && ny < -0.3))) return -1.0;
  float failM = ${ROOF_FAIL_START_M.toFixed(6)} + ${(ROOF_FAIL_END_M - ROOF_FAIL_START_M).toFixed(6)} * (surf.w - 1.0) / 254.0;
  return clamp((uAsh.x - failM) / ${ROOF_FALL_M.toFixed(6)}, 0.0, 1.0);
}
`;

/**
 * Fragment stage: patches of tiles a metre across drop in a random order,
 * each darkening as it cracks; the rafters under them stay a while longer
 * and then break one by one. Returns -1 for a fragment that has fallen
 * (the caller discards), 1 for a bare rafter, 0 for tiles still in place,
 * and between for a cracking patch.
 */
export const ROOF_COLLAPSE_FRAG_GLSL = /* glsl */ `
in float vRoof;
float roofRuin(vec3 p, vec3 gn, float seed, float k) {
  if (k <= 0.0) return 0.0;
  // Rafters run down the slope, so they are spaced across it.
  vec2 sd = length(gn.xz) > 0.05 ? normalize(gn.xz) : vec2(1.0, 0.0);
  float across = dot(p.xz, vec2(-sd.y, sd.x)) / 0.8;
  float rid = floor(across);
  bool rafter = fract(across) < 0.2;
  vec2 cell = floor(p.xz / 1.1);
  float fallAt = 0.04 + 0.8 * fract(sin(dot(cell + seed * 31.0, vec2(12.9898, 78.233))) * 43758.5453);
  if (k < fallAt) return k > fallAt - 0.1 ? 0.5 : 0.0;
  if (!rafter) return -1.0;
  // About half the rafters snap; the rest are left standing over the room.
  float breakAt = 0.7 + 0.6 * fract(sin(rid * 91.7 + seed * 47.0) * 43758.5453);
  return k > breakAt ? -1.0 : 1.0;
}
`;

/** Vertex stage: the pumice lift for the town floor and the terrain. */
export const ERUPTION_VERT_GLSL = /* glsl */ `
uniform vec4 uAsh;
${ASH_FAN_GLSL}
`;

/** For the terrain: its lift and its pumice colour. */
export const ERUPTION_TERRAIN_VERT_GLSL = ASH_FAN_GLSL;
export const ERUPTION_TERRAIN_FRAG_GLSL = /* glsl */ `
${ASH_FAN_GLSL}
${PUMICE_GLSL}
uniform vec4 uAshView;
float ashCone(vec2 xz) { return (1.0 - smoothstep(2000.0, 5500.0, distance(xz, uAshFan.xy))) * uAshView.w; }
// Under the umbrella's shadow: the fan, whose thin near edge it covers as
// fully as the middle, and the cone under the column.
float ashUnder(vec2 xz) { return max(clamp(ashFan(xz) * 4.0, 0.0, 1.0), ashCone(xz)); }
// Pumice on open ground, as deep as the fan says; the mountain under the
// column dusted dark from the first hour.
vec3 ashGround(vec3 albedo, vec3 n, vec3 p) {
  if (uAshView.z <= 0.0) return albedo;
  float cover = smoothstep(0.0, 0.05, uAshFan.z * ashFan(p.xz)) * smoothstep(0.45, 0.85, n.y) * smoothstep(0.3, 1.5, p.y);
  float g = fract(sin(dot(floor(p.xz * 0.7), vec2(12.9898, 78.233))) * 43758.5453);
  albedo = mix(albedo, pumiceColour(uAshFan.w) * (0.88 + 0.2 * g), cover);
  albedo = mix(albedo, ${v3(VENT_ASH)} * (0.85 + 0.3 * g), ashCone(p.xz));
  // Seen from outside the fall (the bay), the ground under the umbrella is
  // in its shadow while the camera's own sky is open. The global light is the
  // camera's, so the shadow goes on here; inside the fall uAshView.x is 0 and
  // the global light has already been dimmed.
  albedo *= mix(1.0, max(uAshView.y, 0.03), uAshView.x * ashUnder(p.xz));
  return albedo;
}
// The air in front of that ground: its far kilometres are in the same
// shadow and scatter no sun, or the dark slope wears a sunlit blue veil
// and reads as snow from across the bay.
// What light that air does carry is the plume's grey-brown, not sky blue.
vec3 ashAir(vec3 inscatter, vec3 p) {
  if (uAshView.z <= 0.0) return inscatter;
  float k = uAshView.x * ashUnder(p.xz);
  float lum = dot(inscatter, vec3(0.3, 0.45, 0.25));
  return mix(inscatter, vec3(lum) * vec3(1.0, 0.9, 0.78) * 0.3, k);
}
`;

export const ERUPTION_SURFACE_GLSL = /* glsl */ `
${PUMICE_GLSL}
uniform vec4 uAsh;
uniform vec4 uLamp;
uniform vec4 uTorch[${TORCH_SLOTS}];

// A few centimetres of pumice bury the paving's relief: back to the plain normal.
vec3 ashFlatten(vec3 n, vec3 geom) {
  if (uAsh.z <= 0.0) return n;
  float k = smoothstep(0.01, 0.06, uAsh.x) * smoothstep(0.45, 0.85, geom.y);
  return normalize(mix(n, geom, k));
}

// Pumice lies on whatever faces up and is open to the sky.
vec3 ashCover(vec3 albedo, vec3 n, vec3 p, float covered) {
  if (uAsh.z <= 0.0) return albedo;
  float up = smoothstep(0.45, 0.85, n.y) * (1.0 - covered);
  // Grain at two scales, smooth so it does not shimmer: drifts, then lapilli.
  vec2 q = p.xz * 2.7;
  vec2 i = floor(q), f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  float h00 = fract(sin(dot(i, vec2(12.9898, 78.233))) * 43758.5453), h10 = fract(sin(dot(i + vec2(1, 0), vec2(12.9898, 78.233))) * 43758.5453);
  float h01 = fract(sin(dot(i + vec2(0, 1), vec2(12.9898, 78.233))) * 43758.5453), h11 = fract(sin(dot(i + vec2(1, 1), vec2(12.9898, 78.233))) * 43758.5453);
  float g = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  vec3 pum = pumiceColour(uAsh.y) * (0.8 + 0.34 * g);
  return mix(albedo, pum, up * uAsh.z);
}

float pointLamp(vec4 L, vec3 p, vec3 n, float reach) {
  vec3 d = L.xyz - p;
  float r2 = dot(d, d);
  float win = clamp(1.0 - r2 / (reach * reach), 0.0, 1.0);
  win *= win;
  // Wrapped: a flame lights the side of a wall turned a little away from it.
  float ndl = max(0.0, dot(n, d * inversesqrt(max(r2, 1e-4)))) * 0.8 + 0.2;
  return L.w * ndl * win / (r2 + 1.0);
}

/** Oil lamps and torches, as irradiance: an open flame's 1900 K orange. */
vec3 eruptionLamps(vec3 p, vec3 n) {
  float s = 0.0;
  if (uLamp.w > 0.0) s += pointLamp(uLamp, p, n, 18.0);
  for (int i = 0; i < ${TORCH_SLOTS}; i++) if (uTorch[i].w > 0.0) s += pointLamp(uTorch[i], p, n, 14.0);
  // The lightning, lighting everything open to the sky for an instant.
  return vec3(1.0, 0.52, 0.2) * s + vec3(0.75, 0.8, 1.0) * uAsh.w * (0.3 + 0.7 * max(0.0, n.y));
}
`;

// --- tiny shared GLSL ------------------------------------------------------

const NOISE = /* glsl */ `
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm3(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.13) + 0.2 * vnoise(p * 4.37); }
`;

const COMMON_UNIFORMS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunE;     // the sun above the plume, irradiance
uniform vec3 uAmb;      // sky light on the column's shaded side
uniform vec3 uHaze;     // what the fall scatters toward the eye
uniform float uVis;     // metres
uniform vec4 uFlash;    // lightning: xyz, w strength
uniform vec3 uCamPos;
uniform vec3 uNearAmb;  // the dimmed light under the plume, as the town gets it
uniform float uShade;   // how much sun gets under the plume
uniform float uUmbY;    // world height of the umbrella's base: below it the column is in its shadow
`;

// Billows: one camera-facing quad each, shaded as a lumpy sphere.
const BILLOW_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aBillow;   // centre, radius
in vec4 aLook;     // seed, albedo, alpha, self-shadow (0 lit all over .. 1 dark underside)
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
out vec4 vLook;
out vec3 vRight;
out vec3 vUp;
out vec3 vCentre;
out float vRadius;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 w = aBillow.xyz + (right * position.x + up * position.y) * aBillow.w;
  vUv = position.xy;
  vLook = aLook;
  vRight = right;
  vUp = up;
  vCentre = aBillow.xyz;
  vRadius = aBillow.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const BILLOW_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec4 vLook;
in vec3 vRight;
in vec3 vUp;
in vec3 vCentre;
in float vRadius;
out vec4 fragColor;
${COMMON_UNIFORMS}
${NOISE}
${ERUPTION_SURFACE_GLSL}
uniform vec4 uCanopy;   // vent x, vent z, base height, thickness
uniform vec4 uShape;    // upwind m, downwind m, half width m, wind bearing
// 1 where the sun's ray up from p passes through the umbrella sheet: the
// column below it stands in the umbrella's shadow from most sides, but the
// low sun can still reach in under the upwind edge.
float umbrellaShadow(vec3 p) {
  if (uUmbY < -1.0e8) return 0.0;
  float t = (uUmbY - p.y) / max(uSunDir.y, 0.05);
  vec2 q = p.xz + uSunDir.xz * t - uCanopy.xy;
  vec2 f = vec2(sin(uShape.w), -cos(uShape.w));
  vec2 r = vec2(-f.y, f.x);
  float along = dot(q, f), cross = dot(q, r);
  float u = along < 0.0 ? along / uShape.x : along / uShape.y;
  float v = cross / (uShape.z * (0.55 + 0.45 * clamp(1.0 + u, 0.0, 1.0)));
  // Faded over the sheet's thickness, not cut at its base: a hard cut drew
  // a ruler line across every billow that straddled it.
  return (1.0 - smoothstep(0.7, 1.0, length(vec2(u, v)))) * (1.0 - smoothstep(uUmbY - 1500.0, uUmbY + 1000.0, p.y));
}
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  // Cauliflower lobes: a few big bumps on the outline, smaller ones on those.
  float n1 = fbm3(vUv * 2.4 + vLook.x * 31.0);
  float lobes = vnoise(vec2(atan(vUv.y, vUv.x) * 1.6, vLook.x * 17.0)) * 0.7 + vnoise(vec2(atan(vUv.y, vUv.x) * 4.1, vLook.x * 5.0)) * 0.3;
  float edge = sqrt(r2) + 0.3 * (n1 - 0.5) + 0.28 * (lobes - 0.5);
  float a = smoothstep(1.0, 0.62, edge) * vLook.z;
  if (a < 0.004) discard;
  vec3 back = normalize(uCamPos - vCentre);
  vec3 nrm = normalize(vRight * vUv.x + vUp * vUv.y + back * sqrt(max(0.0, 1.0 - r2)));
  vec3 p = vCentre + (vRight * vUv.x + vUp * vUv.y) * vRadius;
  float ndl = dot(nrm, uSunDir);
  float sun = max(0.0, ndl);
  float under = mix(1.0, 0.25 + 0.75 * smoothstep(-0.6, 0.8, nrm.y), vLook.w);
  // Surge and roof dust (w > 0.88) are under the plume: its light, not the open sky's.
  bool shaded = vLook.w > 0.88;
  // The column below the umbrella stands in the umbrella's shadow; only the
  // top and the spreading cloud are in the sun.
  float sunVis = shaded ? uShade : 1.0 - 0.92 * umbrellaShadow(p);
  // The shaded trunk still sees the open sky round the umbrella's edge.
  // Sky light on a cloud is about an eighth of the sun's (uAmb alone, the
  // ground's ambient, left the shaded trunk black). The trunk under the
  // umbrella still sees the open sky round its edge.
  vec3 sky = uSunE * 0.45 + uAmb;
  vec3 amb = shaded ? uNearAmb * 3.0 : sky * mix(0.65, 1.0, sunVis);
  // A dense ash cloud is dark inside: the sunlit side is lit, the rest is
  // its own shadow, and the outline catches the light (the lit rim).
  float rim = pow(1.0 - max(0.0, dot(nrm, back)), 2.0) * smoothstep(-0.2, 0.5, ndl);
  vec3 col = vLook.y * (uSunE * sunVis * (sun * under + 0.8 * rim) + amb * (0.35 + 0.3 * nrm.y));
  col *= vec3(1.0, 0.9, 0.78);
  // Lightning lights the cloud it is in from inside.
  vec3 fd = p - uFlash.xyz;
  col += vec3(0.75, 0.8, 1.0) * uFlash.w * exp(-dot(fd, fd) / 4.5e6);
  // Dust from a fallen roof, close by, is lit by the lamps round it.
  col += vLook.y * eruptionLamps(p, nrm) * 1.5;
  col *= 0.7 + 0.6 * n1;
  float T = exp(-distance(uCamPos, p) / uVis);
  col = mix(uHaze, col, T);
  fragColor = vec4(col, a);
}
`;

// The umbrella: a grid laid out in the vertex shader over the spreading cloud.
const CANOPY_VERT = /* glsl */ `
precision highp float;
in vec3 position;   // u along the wind -1..1, v across -1..1
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec4 uCanopy;   // vent x, vent z, base height, thickness
uniform vec4 uShape;    // upwind m, downwind m, half width m, wind bearing (rad, toward)
out vec2 vUv;
out vec3 vWorld;
void main() {
  float u = position.x, v = position.y;
  float along = u < 0.0 ? u * uShape.x : u * uShape.y;
  float cross = v * uShape.z * (0.55 + 0.45 * clamp(1.0 + u, 0.0, 1.0));
  vec2 f = vec2(sin(uShape.w), -cos(uShape.w));
  vec2 r = vec2(-f.y, f.x);
  vec2 xz = uCanopy.xy + f * along + r * cross;
  float rr = clamp(u * u + v * v, 0.0, 1.0);
  // Thickest over the vent, thinning to the spreading edge, sagging as it
  // drifts downwind and its stones drop out.
  // Sagging downwind toward the horizon as the sheet drops its stones.
  float y = uCanopy.z - uCanopy.w * 1.4 * max(0.0, u) + uCanopy.w * (1.0 - rr) * 0.3;
  vWorld = vec3(xz.x, y, xz.y);
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const CANOPY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vWorld;
out vec4 fragColor;
${COMMON_UNIFORMS}
uniform float uCanopyAlpha;
${NOISE}
void main() {
  float n1 = fbm3(vWorld.xz / 2600.0);
  float n2 = vnoise(vWorld.xz / 900.0);
  float rr = length(vUv);
  float a = smoothstep(1.0, 0.7, rr + 0.25 * (n1 - 0.5)) * uCanopyAlpha;
  // Edge-on from far off, the sheet's rim is a ruler-straight line: fade it.
  a *= smoothstep(0.02, 0.18, abs(normalize(vWorld - uCamPos).y));
  if (a < 0.004) discard;
  // Seen from below: the underside of a cloud full of stones, lit by the
  // sky round its edge and not at all by the sun above it. Lumps (mammatus)
  // where the noise is high are a little lighter.
  float side = step(vWorld.y, uCamPos.y);   // 1 when seen from above
  // Ash grey-brown, whatever colour the sky round it is.
  vec3 ash = vec3(dot(uAmb, vec3(0.3, 0.45, 0.25))) * vec3(1.0, 0.9, 0.78);
  vec3 col = mix(ash * (0.12 + 0.18 * n2 + 0.2 * smoothstep(0.6, 1.0, rr)), uSunE * 0.55 + ash * 0.3, side);
  col *= 0.75 + 0.5 * n1;
  vec3 fd = vWorld - uFlash.xyz;
  col += vec3(0.75, 0.8, 1.0) * uFlash.w * 0.3 * exp(-dot(fd, fd) / 3.2e7);
  float T = exp(-distance(uCamPos, vWorld) / uVis);
  fragColor = vec4(mix(uHaze, col, T), a);
}
`;

// The sky under the plume. The sky shader's own answer under this much
// aerosol is black (no sun gets in to scatter), and between the umbrella's
// edge and the horizon that read as a clear night. Under the real cloud the
// horizon is a dim brown-grey, a little lighter where the open sky is,
// upwind. A sphere round the camera, drawn behind everything nearer.
const DOME_VERT = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCamPos;
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(uCamPos + position * 120000.0, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;
in vec3 vDir;
out vec4 fragColor;
uniform vec3 uDomeColor;
uniform vec2 uUpwind;     // unit, x and z
uniform float uDomeAlpha;
void main() {
  vec3 d = normalize(vDir);
  float horizon = 1.0 - smoothstep(0.0, 0.45, d.y);
  float open = max(0.0, dot(normalize(d.xz + 1e-5), uUpwind)) * horizon;
  vec3 c = uDomeColor * (0.55 + 0.6 * horizon + 0.9 * open);
  fragColor = vec4(c, uDomeAlpha);
}
`;

// The fall round the camera, wrapped in a box anchored in the world so walking
// through it reads as walking through it. Two populations through one
// shader: uKind 0 the lapilli, pale stones 1 to 3 cm falling at 10 to 18 m/s;
// uKind 1 the fine ash, motes of a millimetre or two drifting down at a
// metre or two a second and swirling on the wind.
const PUMICE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aSeed;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uBox;
uniform vec3 uDrift;   // m/s, x and z; y the stones' fall speed
uniform float uKind;
out vec2 vUv;
out vec3 vWorld;
out float vShade;
out float vStretch;
out float vFade;
out float vSpin;
out float vSeed;
out vec3 vRight;
out vec3 vBack;
void main() {
  bool fine = uKind > 0.5;
  float speed = fine ? 1.0 + 1.4 * aSeed.w : uDrift.y * (0.7 + 0.6 * aSeed.w);
  vec3 vel = vec3(uDrift.x, -speed, uDrift.z);
  vec3 p0 = aSeed.xyz * uBox + vel * uTime;
  // The fine ash rides the gusts: each mote on its own slow loop.
  if (fine) p0 += vec3(sin(uTime * 0.9 + aSeed.x * 40.0), 0.4 * sin(uTime * 1.3 + aSeed.z * 30.0), cos(uTime * 0.7 + aSeed.y * 50.0)) * 0.7;
  vec3 rel = mod(p0 - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 c = uCamPos + rel;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float d = distance(c, uCamPos);
  float r = fine ? 0.0008 + 0.0012 * fract(aSeed.y * 53.1) : 0.005 + 0.01 * fract(aSeed.y * 53.1);
  // On screen never under about a pixel and a half (a smaller speck
  // flickers) and never over about a degree: the few closest stones once
  // filled a fifth of the screen as slabs.
  float size = clamp(r, d * 0.0016, d * 0.018);
  // The eye holds a falling stone for about 1/60 s, in which it drops some
  // 20 cm: a thin tapered streak, which is what a pumice fall looks like.
  // Capped against the stone's width so the nearest ones stay stones.
  float tail = fine ? 0.0 : min(0.5 * speed / 60.0, size * 9.0);
  vec3 along = normalize(vel) * (size + tail);
  // Minus: the fall points down, and right x down would turn the quad away from the camera.
  vec3 w = c + right * position.x * size - along * position.y;
  vUv = position.xy;
  vWorld = c;
  vShade = 0.75 + 0.4 * fract(aSeed.x * 91.7);
  vStretch = (size + tail) / size;
  // Gone before the near plane rather than through it.
  vFade = smoothstep(0.15, 0.65, d);
  vSeed = fract(aSeed.z * 71.3);
  // Tumbling a few turns a second as it falls.
  vSpin = uTime * (3.0 + 9.0 * vSeed) + vSeed * 6.28;
  vRight = right;
  vBack = back;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const PUMICE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vWorld;
in float vShade;
in float vStretch;
in float vFade;
in float vSpin;
in float vSeed;
in vec3 vRight;
in vec3 vBack;
out vec4 fragColor;
${COMMON_UNIFORMS}
uniform vec3 uPumice;
uniform float uKind;
${NOISE}
${ERUPTION_SURFACE_GLSL}
void main() {
  float T = exp(-distance(uCamPos, vWorld) / uVis);
  if (uKind > 0.5) {
    float a = smoothstep(1.0, 0.1, length(vUv)) * 0.4 * vFade;
    if (a < 0.01) discard;
    vec3 col = vec3(0.55, 0.52, 0.47) * (uNearAmb * 3.0 + uSunE * uShade * 0.3 + eruptionLamps(vWorld, vec3(0.0, 1.0, 0.0)));
    fragColor = vec4(mix(uHaze, col, T), a);
    return;
  }
  // The stone's own disc, with the smear collapsed out of it.
  vec2 q = vec2(vUv.x, sign(vUv.y) * max(0.0, abs(vUv.y) * vStretch - (vStretch - 1.0)));
  // An irregular outline: pumice is a broken froth, not a bead.
  float ang = atan(q.y, q.x) + vSpin;
  float rim = 0.84 + 0.09 * sin(3.0 * ang + vSeed * 17.0) + 0.06 * sin(5.0 * ang + vSeed * 31.0);
  // The smear narrows to a point at both ends and thins out along its
  // length: with square ends it read as a falling rectangle.
  float along = abs(vUv.y) * step(1.01, vStretch);
  float rr = length(vec2(q.x / (1.0 - 0.7 * along), q.y)) / rim;
  float a = smoothstep(1.0, 0.78, rr) * vFade * max(0.4, min(1.0, 1.5 / vStretch)) * (1.0 - 0.6 * along);
  if (a < 0.01) discard;
  // Shaded as a lump in the scene's own light: pale where the light falls on
  // it, dim in its own shade, mottled with vesicles that turn as it tumbles.
  vec2 qq = q / rim;
  vec3 n = normalize(vRight * qq.x + vec3(0.0, 1.0, 0.0) * qq.y + vBack * sqrt(max(0.0, 1.0 - dot(qq, qq))));
  float cs = cos(vSpin), sn = sin(vSpin);
  vec2 rq = vec2(cs * qq.x - sn * qq.y, sn * qq.x + cs * qq.y);
  float mott = 0.75 + 0.4 * vnoise(rq * 2.6 + vSeed * 13.0);
  vec3 light = uNearAmb * (2.0 + 1.4 * n.y) + uSunE * uShade * max(0.0, dot(n, uSunDir)) + eruptionLamps(vWorld, n);
  vec3 col = uPumice * vShade * mott * light;
  fragColor = vec4(mix(uHaze, col, T), a);
}
`;

// Bundles: what the fleeing carried on their backs, a box of cloth each.
const BUNDLE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec4 aAt;   // feet x, y, z, heading (radians clockwise from north)
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorld;
out vec3 vN;
out float vTone;
void main() {
  float c = cos(aAt.w), s = sin(aAt.w);
  // Forward is (sin h, -cos h); the bundle rides high on the back.
  vec3 local = position * vec3(0.42, 0.34, 0.30) + vec3(0.0, 1.38, 0.24);
  vec3 p = vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c);
  vN = vec3(normal.x * c - normal.z * s, normal.y, normal.x * s + normal.z * c);
  vWorld = aAt.xyz + p;
  vTone = fract(sin(aAt.x * 12.9898 + aAt.z * 78.233) * 43758.5453);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const BUNDLE_FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vN;
in float vTone;
out vec4 fragColor;
${COMMON_UNIFORMS}
${ERUPTION_SURFACE_GLSL}
void main() {
  vec3 n = normalize(vN);
  vec3 cloth = mix(vec3(0.55, 0.47, 0.36), vec3(0.42, 0.25, 0.18), step(0.6, vTone));
  vec3 col = cloth * (uNearAmb * (2.0 + n.y) + eruptionLamps(vWorld, n));
  float T = exp(-distance(uCamPos, vWorld) / uVis);
  fragColor = vec4(mix(uHaze, col, T), 1.0);
}
`;

// Flames: additive, HDR, a hot core in a soft halo.
const GLOW_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aGlow;     // centre, size
in vec4 aTint;     // rgb * intensity, flicker seed
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
out vec4 vTint;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 w = aGlow.xyz + (right * position.x + up * position.y) * aGlow.w;
  vUv = position.xy;
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec4 vTint;
out vec4 fragColor;
void main() {
  vec2 p = vUv * vec2(1.0, 0.8);
  float r2 = dot(p, p);
  float core = exp(-r2 * 60.0) * 6.0;
  float halo = exp(-r2 * 5.0) * 0.35;
  fragColor = vec4(vTint.rgb * (core + halo), 1.0);
}
`;

// --- geometry --------------------------------------------------------------

function quadGeometry(n: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = n;
  return g;
}

function gridGeometry(n: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push((i / n) * 2 - 1, (j / n) * 2 - 1, 0);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export interface EruptionViewOpts {
  /** The vent, world metres, y its height. */
  vent: THREE.Vector3;
  /** Where the town is: the surge is aimed at it. */
  town: { x: number; z: number };
  heightAt: (x: number, z: number) => number;
  reduced: boolean;
  /** The town's share of Pompeii's pumice fall (data/towns.ts); 1 when left out. */
  fall?: number;
  /**
   * Draw the column, umbrella and surge as the raymarched volume
   * (render/eruptionvolume.ts, marched in the cloud pass) instead of billows.
   * Off on the phone tier, which keeps the billows.
   */
  volume?: boolean;
}

interface Collapse { x: number; y: number; z: number; startH: number; seed: number }

/** Roof dust is drawn this far out; the lamps light the nearest of it. */
const DUST_RANGE_M = 160;
/** A falling roof within this range raises the debris event. */
const HEAR_M = 80;
/** How far from a roof sheltering under it still counts. */
const SHELTER_M = 14;

const _grey = new THREE.Color();
const BOLT_MAIN = 16;
const BOLT_FORK = 6;

export class EruptionView {
  readonly group = new THREE.Group();
  state: EruptionState = eruptionAt(0);
  /** On: the eruption follows the clock. Off: the eve of it, untouched. */
  enabled = false;

  private readonly common: Record<string, THREE.IUniform>;
  private readonly billows: THREE.Mesh;
  private readonly bGeo: THREE.InstancedBufferGeometry;
  private readonly bAttr: THREE.InstancedBufferAttribute;
  private readonly lAttr: THREE.InstancedBufferAttribute;
  private readonly cap: number;
  private readonly canopy: THREE.Mesh;
  private readonly dome: THREE.Mesh;
  private readonly bundleGeo: THREE.InstancedBufferGeometry;
  private readonly bundleAttr: THREE.InstancedBufferAttribute;
  private readonly bundleMesh: THREE.Mesh;
  /** The fleeing who carry something, set by main.ts from sim/flee.ts. */
  bundles: { x: number; z: number; heading: number }[] = [];
  private readonly domeU: { uCamPos: THREE.IUniform<THREE.Vector3>; uDomeColor: THREE.IUniform<THREE.Color>; uUpwind: THREE.IUniform<THREE.Vector2>; uDomeAlpha: THREE.IUniform<number> };
  private readonly canopyU: { uCanopy: THREE.IUniform<THREE.Vector4>; uShape: THREE.IUniform<THREE.Vector4>; uCanopyAlpha: THREE.IUniform<number> };
  private readonly pumice: THREE.Mesh;
  private readonly pGeo: THREE.InstancedBufferGeometry;
  private readonly pumiceN: number;
  private readonly pumiceU: Record<string, THREE.IUniform>;
  private readonly ash: THREE.Mesh;
  private readonly aGeo: THREE.InstancedBufferGeometry;
  private readonly ashN: number;
  private readonly ashU: Record<string, THREE.IUniform>;
  private readonly glow: THREE.Mesh;
  private readonly gGeo: THREE.InstancedBufferGeometry;
  private readonly gAttr: THREE.InstancedBufferAttribute;
  private readonly tAttr: THREE.InstancedBufferAttribute;
  private readonly bolt: THREE.LineSegments;
  private readonly boltPos: Float32Array;
  private readonly order: number[] = [];
  private readonly scratch: { x: number; y: number; z: number; r: number; seed: number; alb: number; a: number; dark: number; d: number }[] = [];
  /** The town's roofs, set by main.ts from the built model; empty away from Pompeii. */
  roofs: RoofInfo[] = [];
  /** Roofs whose fall has already raised the debris event. */
  private readonly heard = new Set<number>();
  private lastDepth = 0;
  private lastCollapse: Collapse | null = null;
  /** Per-billow random numbers for the column: a sin hash of consecutive
   *  integers is correlated enough to wind the column into a spiral. */
  private readonly colRand = new Float32Array(512).map(rng(1979));
  private rawSun = 0;
  /** The exposure lift under the plume, 1 in open daylight. */
  private adapt = 1;
  private readonly rawAmb = new THREE.Color();
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly sunColor = new THREE.Color(1, 1, 1);
  private flash = 0;
  private readonly shakeQ = new THREE.Quaternion();
  private readonly savedQ = new THREE.Quaternion();
  private readonly savedP = new THREE.Vector3();
  private shaken = false;

  /** The carried lamp, set by the escape each frame; null when nobody carries one. */
  lamp: THREE.Vector3 | null = null;
  /** A lamp lying somewhere to be picked up. */
  pickup: THREE.Vector3 | null = null;
  /** Townsfolk positions near the camera, world metres, for their torches. */
  torches: { x: number; y: number; z: number }[] = [];
  /** Extra darkness at the camera, 0..1: inside the surge cloud. */
  inSurge = 0;
  /** 1 inside the fall's footprint (Pompeii), 0 well outside it; see locate. */
  fallHere = 1;
  /** The raymarched column, umbrella and surge; null on the billow path. */
  readonly volume: EruptionVolume | null;

  constructor(private readonly opts: EruptionViewOpts) {
    this.group.name = "eruption";
    this.group.visible = false;
    this.volume = opts.volume ? new EruptionVolume(opts.vent, opts.heightAt) : null;
    this.common = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunE: { value: new THREE.Color() },
      uAmb: { value: new THREE.Color() },
      uHaze: { value: new THREE.Color() },
      uVis: { value: 40000 },
      uFlash: { value: new THREE.Vector4() },
      uCamPos: { value: new THREE.Vector3() },
      uNearAmb: { value: new THREE.Color() },
      uShade: { value: 1 },
      uUmbY: { value: -1e9 },
    };
    const red = opts.reduced;

    // Column + rim + surge + roof dust share one sorted instanced draw.
    this.cap = red ? 210 : 360;
    this.bGeo = quadGeometry(0);
    this.bAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);
    this.lAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);
    this.bAttr.setUsage(THREE.DynamicDrawUsage);
    this.lAttr.setUsage(THREE.DynamicDrawUsage);
    this.bGeo.setAttribute("aBillow", this.bAttr);
    this.bGeo.setAttribute("aLook", this.lAttr);
    this.canopyU = {
      uCanopy: { value: new THREE.Vector4() },
      uShape: { value: new THREE.Vector4(1, 1, 1, WIND_TOWARD) },
      uCanopyAlpha: { value: 0 },
    };
    this.billows = new THREE.Mesh(this.bGeo, new THREE.RawShaderMaterial({
      vertexShader: BILLOW_VERT, fragmentShader: BILLOW_FRAG, uniforms: { ...this.common, ...eruptionSurfaceUniforms, uCanopy: this.canopyU.uCanopy, uShape: this.canopyU.uShape },
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
    }));
    this.billows.frustumCulled = false;
    this.billows.name = "eruption-billows";
    this.billows.renderOrder = 20;

    this.canopy = new THREE.Mesh(gridGeometry(red ? 24 : 40), new THREE.RawShaderMaterial({
      vertexShader: CANOPY_VERT, fragmentShader: CANOPY_FRAG, uniforms: { ...this.common, ...this.canopyU },
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.canopy.frustumCulled = false;
    this.canopy.name = "eruption-umbrella";
    this.canopy.renderOrder = 19;

    this.pumiceN = red ? 1500 : 5000;
    this.pGeo = quadGeometry(0);
    const seeds = new Float32Array(this.pumiceN * 4);
    const r = rng(79);
    for (let i = 0; i < seeds.length; i++) seeds[i] = r();
    this.pGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    this.pumiceU = {
      ...this.common,
      ...eruptionSurfaceUniforms,
      uTime: { value: 0 },
      // Smaller than the old 22 m box at the same count: about 0.6 stones
      // a cubic metre, the number a 15 cm/h fall of 1-3 cm lapilli at 14 m/s gives.
      uBox: { value: new THREE.Vector3(22, 14, 22) },
      uDrift: { value: new THREE.Vector3(1.2, 14, 2.0) },
      uPumice: { value: new THREE.Color(0.8, 0.76, 0.68) },
      uKind: { value: 0 },
    };
    this.pumice = new THREE.Mesh(this.pGeo, new THREE.RawShaderMaterial({
      vertexShader: PUMICE_VERT, fragmentShader: PUMICE_FRAG, uniforms: this.pumiceU,
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
    }));
    this.pumice.frustumCulled = false;
    this.pumice.name = "eruption-pumice";
    this.pumice.renderOrder = 21;

    // The fine ash: a second draw of the same shader, its own seeds and a
    // smaller box (a mote further than a few metres is below a pixel).
    this.ashN = red ? 900 : 2500;
    this.aGeo = quadGeometry(0);
    const aSeeds = new Float32Array(this.ashN * 4);
    const ra = rng(1979);
    for (let i = 0; i < aSeeds.length; i++) aSeeds[i] = ra();
    this.aGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(aSeeds, 4));
    this.ashU = { ...this.pumiceU, uKind: { value: 1 }, uBox: { value: new THREE.Vector3(8, 6, 8) } };
    this.ash = new THREE.Mesh(this.aGeo, new THREE.RawShaderMaterial({
      vertexShader: PUMICE_VERT, fragmentShader: PUMICE_FRAG, uniforms: this.ashU,
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
    }));
    this.ash.frustumCulled = false;
    this.ash.name = "eruption-ash";
    this.ash.renderOrder = 21;

    this.gGeo = quadGeometry(0);
    this.gAttr = new THREE.InstancedBufferAttribute(new Float32Array(12 * 4), 4);
    this.tAttr = new THREE.InstancedBufferAttribute(new Float32Array(12 * 4), 4);
    this.gAttr.setUsage(THREE.DynamicDrawUsage);
    this.tAttr.setUsage(THREE.DynamicDrawUsage);
    this.gGeo.setAttribute("aGlow", this.gAttr);
    this.gGeo.setAttribute("aTint", this.tAttr);
    this.glow = new THREE.Mesh(this.gGeo, new THREE.RawShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, glslVersion: THREE.GLSL3,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.glow.frustumCulled = false;
    this.glow.name = "eruption-flames";
    this.glow.renderOrder = 22;

    this.boltPos = new Float32Array((BOLT_MAIN + 2 * BOLT_FORK) * 2 * 3);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(this.boltPos, 3));
    this.bolt = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: new THREE.Color(4, 4.2, 5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;

    this.domeU = {
      uCamPos: this.common.uCamPos as THREE.IUniform<THREE.Vector3>,
      uDomeColor: { value: new THREE.Color() },
      uUpwind: { value: new THREE.Vector2(-Math.sin(WIND_TOWARD), Math.cos(WIND_TOWARD)) },
      uDomeAlpha: { value: 0 },
    };
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.RawShaderMaterial({
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: this.domeU,
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, side: THREE.BackSide,
    }));
    this.dome.frustumCulled = false;
    this.dome.name = "eruption-sky";
    this.dome.renderOrder = 18;

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.bundleGeo = new THREE.InstancedBufferGeometry();
    this.bundleGeo.setAttribute("position", box.getAttribute("position"));
    this.bundleGeo.setAttribute("normal", box.getAttribute("normal"));
    this.bundleGeo.setIndex(box.getIndex());
    this.bundleAttr = new THREE.InstancedBufferAttribute(new Float32Array(64 * 4), 4);
    this.bundleAttr.setUsage(THREE.DynamicDrawUsage);
    this.bundleGeo.setAttribute("aAt", this.bundleAttr);
    this.bundleGeo.instanceCount = 0;
    this.bundleMesh = new THREE.Mesh(this.bundleGeo, new THREE.RawShaderMaterial({
      vertexShader: BUNDLE_VERT, fragmentShader: BUNDLE_FRAG, uniforms: { ...this.common, ...eruptionSurfaceUniforms },
      glslVersion: THREE.GLSL3,
    }));
    this.bundleMesh.frustumCulled = false;
    this.bundleMesh.name = "eruption-bundles";

    this.group.add(this.dome, this.canopy, this.billows, this.pumice, this.ash, this.glow, this.bolt, this.bundleMesh);
  }

  /** The state at local hour h, or the untouched eve when switched off. */
  setTime(h: number): EruptionState {
    this.state = eruptionAt(this.enabled ? h : 0);
    // Herculaneum lay upwind of the plume: a dusting where Pompeii got metres.
    const fall = this.opts.fall ?? 1;
    if (fall !== 1) this.state = { ...this.state, pumiceM: this.state.pumiceM * fall };
    return this.state;
  }

  get active(): boolean {
    return this.enabled && this.state.phase !== "before";
  }

  /** Whether the cloud pass should march the volume this frame. */
  get volumeActive(): boolean {
    return this.volume !== null && this.active;
  }

  /** The weather under the plume: no ordinary cloud (the plume is the sky), the fall's visibility. */
  weather(wx: Weather): Weather {
    if (!this.active) return wx;
    const none = { cover: 0, base: 900, top: 2100 };
    return {
      ...wx,
      low: none, mid: { ...none, base: 3800, top: 5000 }, high: { ...none, base: 8500, top: 9400 },
      totalCover: 0, opacity: 0, precip: 0, precipKind: "none",
      visibility: this.visibility(),
      windDir: 315, windSpeed: Math.max(wx.windSpeed, 4),
    };
  }

  private visibility(): number {
    const v = 40000 + (this.state.visibilityM - 40000) * this.fallHere;
    return Math.max(25, v * (1 - 0.85 * this.inSurge));
  }

  /** The plume's light factor where the camera is: the timeline's inside the fall, open daylight outside it. */
  private lightHere(): number {
    const l = 1 + (this.state.light - 1) * this.fallHere;
    return Math.max(0.002, l * (1 - 0.9 * this.inSurge));
  }

  /**
   * 0..1, whether the camera stands in the fall: the fan downwind of the vent
   * the deposit maps show, widening south-east. The timeline's darkness and
   * visibility are Pompeii's, which is inside it; across the bay (where Pliny
   * watched from) the sky stayed open and the column stood in plain view.
   */
  private locate(cam: THREE.Vector3): void {
    const v = this.opts.vent;
    const fx = Math.sin(WIND_TOWARD), fz = -Math.cos(WIND_TOWARD);
    const dx = cam.x - v.x, dz = cam.z - v.z;
    const along = dx * fx + dz * fz, cross = Math.abs(-dx * fz + dz * fx);
    const half = 5000 + 0.35 * Math.max(0, along);
    this.fallHere = Math.min(1, Math.max(0, (half + 2500 - cross) / 5000)) * Math.min(1, Math.max(0, (along + 2000) / 3000));
  }

  /** Dim the sun and sky to the plume's light; lift the exposure as an eye would. */
  light(light: SceneLighting): void {
    if (!this.active) return;
    this.rawSun = light.sunIntensity;
    this.rawAmb.copy(light.ambient);
    this.sunDir.copy(light.sunDir);
    this.sunColor.copy(light.sunColor);
    const f = this.lightHere();
    light.sunIntensity *= f * f;
    // The light that does get through is grey-brown, not sky blue.
    const g = (light.ambient.r + light.ambient.g + light.ambient.b) * 0.36;
    light.ambient.lerp(_grey.setRGB(g, g * 0.92, g * 0.8), 1 - f);
    light.ambient.multiplyScalar(f);
    light.moonLight.multiplyScalar(f * 0.1);
    light.nightGlow.multiplyScalar(f);
    // Extinction 3.9 / visibility, in the atmosphere shader's own aerosol units.
    // Only inside the fall: across the bay the air is the day's own.
    if (this.fallHere > 0.01) light.turbidity = Math.max(light.turbidity, this.fallHere * 3.9 / (4.44e-6 * this.visibility()));
    if (this.fallHere > 0.5) light.mieG = 0.35;
    const adapt = Math.min(5, Math.pow(f, -0.45));
    this.adapt = adapt;
    light.exposure = Math.max(light.exposure, 0.54 * adapt);
    // A flash lights the whole town for an instant.
    light.ambient.addScalar(this.flash * 0.02);
    (this.common.uNearAmb.value as THREE.Color).copy(light.ambient);
    this.common.uShade.value = f * f;
  }

  /** The sky shader takes its own sun and aerosol from the weather; put the plume's in. */
  sky(u: Record<string, THREE.IUniform>): void {
    if (!this.active) return;
    const f = this.lightHere();
    u.uSunIntensity.value = 22 * f * f;
    if (this.fallHere > 0.01) u.uTurbidity.value = Math.max(u.uTurbidity.value, this.fallHere * 3.9 / (4.44e-6 * this.visibility()));
    if (f < 0.6) u.uNightAmount.value = 0;
  }

  /**
   * Per frame, after the camera is placed and before the scene is drawn.
   * `t` is the animation clock (frozen in shot mode), `timeH` the eruption
   * hour used where a pose must be reproducible.
   */
  update(camera: THREE.PerspectiveCamera, t: number, frozen: boolean): void {
    const s = this.state;
    const on = this.active;
    this.group.visible = on || (this.enabled && this.pickup !== null);
    const su = eruptionSurfaceUniforms;
    su.uAsh.value.set(on ? s.pumiceM : 0, s.whiteness, on ? Math.min(1, s.pumiceM / 0.04) : 0, 0);
    su.uAshFan.value.set(this.opts.vent.x, this.opts.vent.z, on ? s.pumiceM : 0, s.whiteness);
    this.updateLamps(t, camera);
    su.uAshView.value.set(0, 1, on ? 1 : 0, on ? Math.min(1, s.columnKm / 15) : 0);
    if (!on) {
      this.billows.visible = this.canopy.visible = this.pumice.visible = this.ash.visible = this.bolt.visible = this.dome.visible = this.bundleMesh.visible = false;
      this.glow.visible = this.pickup !== null;
      return;
    }
    const c = this.common;
    const cam = camera.position;
    (c.uCamPos.value as THREE.Vector3).copy(cam);
    this.locate(cam);
    su.uAshView.value.x = 1 - this.fallHere;
    su.uAshView.value.y = s.light;
    (c.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    (c.uSunE.value as THREE.Color).copy(this.sunColor).multiplyScalar(this.rawSun * 0.105);
    (c.uAmb.value as THREE.Color).copy(this.rawAmb);
    c.uVis.value = this.visibility();
    const f = this.lightHere();
    const lum = this.rawAmb.r * 0.3 + this.rawAmb.g * 0.45 + this.rawAmb.b * 0.25;
    (c.uHaze.value as THREE.Color).setRGB(lum, lum * 0.9, lum * 0.78).multiplyScalar(0.55 * f).addScalar(0.003 + 0.004 * this.flash);

    // Lightning: the column was full of it (Pliny's "flashes larger than
    // lightning"). Live it runs on the real clock; a pinned pose reads it off
    // the eruption hour so a shot is reproducible.
    const lt = frozen ? s.h * 90 : t;
    const slot = Math.floor(lt * 1.3);
    const ph = lt * 1.3 - slot;
    // A moving surge throws its own lightning, more often, from its front:
    // the one thing that shows it coming in the dark.
    const sg = s.surge?.moving ? s.surge : null;
    const strike = hash(slot) < (sg ? 0.5 : 0.22) ? Math.max(0, 1 - ph * 6) * (ph < 0.05 || (ph > 0.09 && ph < 0.13) ? 1 : 0.35) : 0;
    this.flash = strike;
    su.uAsh.value.w = strike * 0.12;
    const fv = c.uFlash.value as THREE.Vector4;
    const vent = this.opts.vent;
    const hk = hash(slot + 0.5), hk2 = hash(slot + 0.25);
    let boltSpan = sg ? 120 : 700;
    if (sg) {
      const town = this.opts.town;
      const a = Math.atan2(town.x - vent.x, -(town.z - vent.z)) + (hk - 0.5) * 1.2;
      const x = vent.x + Math.sin(a) * (sg.frontM - 250), z = vent.z - Math.cos(a) * (sg.frontM - 250);
      fv.set(x, this.opts.heightAt(x, z) + 250 + hk2 * 300, z, strike * 4);
    } else if (this.volume) {
      // Inside the column, on the side facing the camera, where a flash is seen
      // through the least ash: out near the edge, where the channel shows
      const sh = plumeShape(s.columnKm, s.steadyKm, vent.y / 1000, Math.max(0, (s.h - COLUMN_H) * 3600));
      const z = (0.12 + 0.5 * hk2) * sh.topM;
      const b = columnRadiusM(z, sh);
      const a = Math.atan2(cam.x - vent.x, cam.z - vent.z) + (hk - 0.5) * 1.4;
      const lean = (LEAN * z * z) / Math.max(sh.topM, 1);
      fv.set(vent.x + Math.sin(a) * b * (0.85 + 0.25 * hash(slot + 0.75)) + Math.sin(WIND_TOWARD) * lean, vent.y + z,
        vent.z + Math.cos(a) * b * (0.85 + 0.25 * hash(slot + 0.75)) - Math.cos(WIND_TOWARD) * lean, strike * 5);
      boltSpan = Math.max(80, b * 0.3);
    } else {
      fv.set(vent.x + (hk - 0.5) * 2500, vent.y + 2500 + hk2 * s.columnKm * 600, vent.z + (hash(slot + 0.75) - 0.5) * 2500, strike * 5);
    }
    this.drawBolt(strike, fv, slot, boltSpan);

    this.updateCanopy();
    this.updateBundles();
    this.updateBillows(cam, t, frozen);
    this.updatePumice(t);
    if (this.volume) {
      const town = this.opts.town;
      this.volume.update({
        state: s,
        animT: t,
        sun: this.volSun.copy(this.sunColor).multiplyScalar(this.rawSun * 0.105),
        amb: this.rawAmb,
        nearAmb: c.uNearAmb.value as THREE.Color,
        shade: c.uShade.value as number,
        adapt: this.adapt,
        flash: fv,
        townBearing: Math.atan2(town.x - vent.x, -(town.z - vent.z)),
        outside: 1 - this.fallHere,
        sunY: this.sunDir.y,
        visibilityM: this.visibility(),
      });
    }
  }

  private readonly volSun = new THREE.Color();

  private updateCanopy(): void {
    const s = this.state, v = this.opts.vent;
    const reachM = s.umbrellaReachKm * 1000;
    const up = Math.min(14000, 2500 + reachM * 0.25);
    const half = Math.min(32000, 3000 + reachM * 0.38);
    this.canopyU.uCanopy.value.set(v.x, v.z, s.umbrellaKm * 1000, 5000);
    this.canopyU.uShape.value.set(up, Math.max(3000, reachM), half, WIND_TOWARD);
    this.canopyU.uCanopyAlpha.value = Math.min(0.97, s.columnKm / 12);
    this.canopy.visible = s.columnKm > 8 && !this.volume;
    this.common.uUmbY.value = this.canopy.visible ? s.umbrellaKm * 1000 : -1e9;
    // The sky closes over as the umbrella arrives overhead (about 13:10).
    this.domeU.uDomeAlpha.value = Math.min(0.97, Math.max(0, (s.h - 13.05) / 0.35)) * (0.25 + 0.75 * this.fallHere);
    const a = this.rawAmb, lum = a.r * 0.3 + a.g * 0.45 + a.b * 0.25 + this.rawSun * 0.105 * 0.12;
    this.domeU.uDomeColor.value.setRGB(1.0, 0.88, 0.74).multiplyScalar(lum * 0.6 * Math.max(0.12, Math.sqrt(this.lightHere())));
    // In the thick of the fall the sky is gone too: the dome fades to the haze.
    const seen = Math.min(1, Math.max(0, (this.visibility() - 300) / 4000));
    this.domeU.uDomeColor.value.lerp(this.common.uHaze.value as THREE.Color, 1 - seen);
    this.dome.visible = this.domeU.uDomeAlpha.value > 0;
  }

  private updateBundles(): void {
    const B = this.bundleAttr.array as Float32Array;
    const n = Math.min(64, this.bundles.length);
    for (let i = 0; i < n; i++) {
      const b = this.bundles[i];
      B.set([b.x, this.opts.heightAt(b.x, b.z), b.z, b.heading], i * 4);
    }
    this.bundleGeo.instanceCount = n;
    this.bundleAttr.needsUpdate = true;
    this.bundleMesh.visible = n > 0;
  }

  private push(x: number, y: number, z: number, r: number, seed: number, alb: number, a: number, dark: number, cam: THREE.Vector3): void {
    if (this.scratch.length >= this.cap) return;
    this.scratch.push({ x, y, z, r, seed, alb, a, dark, d: (x - cam.x) ** 2 + (y - cam.y) ** 2 + (z - cam.z) ** 2 });
  }

  private updateBillows(cam: THREE.Vector3, t: number, frozen: boolean): void {
    const s = this.state, v = this.opts.vent, red = this.opts.reduced;
    this.scratch.length = 0;
    const fx = Math.sin(WIND_TOWARD), fz = -Math.cos(WIND_TOWARD);
    const H = s.columnKm * 1000;
    const umb = s.umbrellaKm * 1000;
    const grey = 1 - s.whiteness;
    // Ash, not steam: a grey-brown cloud, darker still once the grey pumice
    // phase starts. The sunlit tops come from the shader, not the albedo.
    const alb = 0.5 - 0.16 * grey;
    // Pliny's column was "now white, now dark and mottled": the white
    // phase's sunlit top a pale cream, the base dark with the stones and
    // ash it is carrying up. The grey phase darkens both. Over 1 because the
    // billow shader's sun is a tenth of the ground's (uSunE): at 0.9 the top
    // came out the same mid grey as the rest, measured from the Forum at 13:05.
    const albTop = 2.4 - 1.7 * grey, albBase = 0.3 - 0.08 * grey;
    // The column: a straight trunk kilometres wide at the vent, widening as
    // it entrains air, bent downwind near the top. Billows keep their place
    // on the trunk and swell and roll slowly; the motion is the convection,
    // not a conveyor.
    const nCol = this.volume ? 0 : red ? 70 : 150;
    const R4 = this.colRand;
    const roll = frozen ? 0 : t * 0.0012;
    for (let i = 0; i < nCol && H > 0; i++) {
      const sd = R4[(i * 4) % 512];
      const k = ((i + 0.5) / nCol + (R4[(i * 4 + 5) % 512] - 0.5) / nCol + roll * (0.6 + 0.4 * sd)) % 1;
      const z = k * Math.min(H, umb + 2500);
      const R = 1400 + 0.16 * z;
      const ang = R4[(i * 4 + 1) % 512] * Math.PI * 2 + roll * 3, rad = Math.sqrt(R4[(i * 4 + 2) % 512]) * R * 0.75;
      const lean = 3000 * (z / Math.max(H, 1)) ** 2;
      // Fade in at the vent and as the top of the trunk folds into the umbrella.
      const a = Math.min(1, k * 30) * (z > umb ? 0.8 : 0.97);
      // Darker toward the vent, where the cloud is densest and in its own shade.
      const up = z / Math.max(H, 1);
      const t = up * up * (3 - 2 * up);
      this.push(v.x + Math.cos(ang) * rad + fx * lean, v.y + z, v.z + Math.sin(ang) * rad + fz * lean,
        R * (0.75 + 0.55 * R4[(i * 4 + 3) % 512]), sd, albBase + (albTop - albBase) * t, a, 0.35 - 0.2 * t, cam);
    }
    // The branches of Pliny's pine: the cloud spreading out on every side
    // from the top of the trunk before the wind carries it off.
    if (H > 8000 && !this.volume) {
      const nBr = red ? 18 : 36;
      const spread = Math.min(14000, 3000 + s.umbrellaReachKm * 220);
      for (let i = 0; i < nBr; i++) {
        const ang = (i / nBr) * Math.PI * 2 + hash(i * 3.7) * 0.4;
        const r = spread * (0.35 + 0.65 * hash(i * 1.9));
        const y = umb + 600 + hash(i * 2.3) * 2200 - (r / spread) * 1200;
        this.push(v.x + Math.cos(ang) * r + fx * r * 0.3, y, v.z + Math.sin(ang) * r + fz * r * 0.3,
          2200 + hash(i * 4.4) * 1800, hash(i * 8.8), alb + (albTop - alb) * 0.3, 0.9, 0.6, cam);
      }
      // The plume sheet drifting south-east, sagging as it drops its stones.
      const nRim = red ? 22 : 44;
      const reach = Math.max(3000, s.umbrellaReachKm * 1000);
      for (let i = 0; i < nRim; i++) {
        const u = hash(i * 5.3), w = hash(i * 9.1) * 2 - 1;
        const along = u * Math.min(reach, 60000);
        const cross = w * Math.min(26000, 4000 + along * 0.4) * 0.8;
        const x = v.x + fx * along - fz * cross, z = v.z + fz * along + fx * cross;
        const y = umb + 800 + hash(i * 2.7) * 2500 - u * 5000;
        this.push(x, y, z, 3000 + hash(i * 4.4) * 3000, hash(i * 6.6), alb * 0.9, 0.85, 0.8, cam);
      }
      // The overshooting top, above the trunk: the brightest thing in the sky.
      for (let i = 0; i < (red ? 5 : 10); i++) {
        this.push(v.x + fx * 2500 + (hash(i + 0.3) - 0.5) * 5000, H - 2000 + hash(i + 0.6) * 1800, v.z + fz * 2500 + (hash(i + 0.9) - 0.5) * 5000,
          3200 + hash(i + 0.1) * 1500, hash(i), albTop, 0.92, 0.25, cam);
      }
    }
    this.pushSurge(cam);
    this.pushCollapses(cam);

    // Back to front, so the alpha blend composes.
    const n = this.scratch.length;
    this.order.length = n;
    for (let i = 0; i < n; i++) this.order[i] = i;
    this.order.sort((a, b) => this.scratch[b].d - this.scratch[a].d);
    const B = this.bAttr.array as Float32Array, L = this.lAttr.array as Float32Array;
    for (let j = 0; j < n; j++) {
      const q = this.scratch[this.order[j]];
      B[j * 4] = q.x; B[j * 4 + 1] = q.y; B[j * 4 + 2] = q.z; B[j * 4 + 3] = q.r;
      L[j * 4] = q.seed; L[j * 4 + 1] = q.alb; L[j * 4 + 2] = q.a; L[j * 4 + 3] = q.dark;
    }
    this.bGeo.instanceCount = n;
    this.bAttr.needsUpdate = true;
    this.lAttr.needsUpdate = true;
    this.billows.visible = n > 0;
  }

  /** The surge: a ground-hugging wall of dark cloud on an arc about the vent. */
  private pushSurge(cam: THREE.Vector3): void {
    const sg = this.state.surge;
    this.inSurge = 0;
    if (!sg) return;
    const v = this.opts.vent, town = this.opts.town;
    const toTown = Math.atan2(town.x - v.x, -(town.z - v.z));
    const camR = Math.hypot(cam.x - v.x, cam.z - v.z);
    // Inside the cloud once the front has passed the camera.
    this.inSurge = Math.max(0, Math.min(1, (sg.frontM - camR) / 120 + 0.5));
    if (this.volume) return;
    const red = this.opts.reduced;
    const nA = red ? 14 : 26, rows = red ? 3 : 4;
    for (let row = 0; row < rows; row++) {
      const r = sg.frontM - row * 260;
      if (r < 200) continue;
      for (let i = 0; i < nA; i++) {
        const a = toTown + ((i + 0.5) / nA - 0.5) * 1.6 + (hash(i * 3.3 + row) - 0.5) * 0.05;
        const x = v.x + Math.sin(a) * r, z = v.z - Math.cos(a) * r;
        const g = this.opts.heightAt(x, z);
        const big = 140 + row * 70 + hash(i + row * 7) * 90;
        this.push(x, g + big * 0.6 + row * 90, z, big, hash(i * 1.7 + row * 3.1), 0.28, sg.moving ? 0.95 : 0.6, 0.95, cam);
      }
    }
  }

  /**
   * Dust from the roofs coming down near the camera: the town's own roofs
   * (render/pompeiimesh.ts), each at the depth its shader collapse runs at,
   * so the dust rises out of the house whose tiles are dropping. The dust
   * outlasts the fall by half again. A roof seen starting to go within
   * earshot raises the debris event once.
   */
  private pushCollapses(cam: THREE.Vector3): void {
    const s = this.state;
    const depth = s.pumiceM;
    if (depth < this.lastDepth) this.heard.clear();
    this.lastDepth = depth;
    if (s.roofFailure <= 0 || !this.roofs.length) return;
    const near: { r: RoofInfo; i: number; age: number; d2: number }[] = [];
    for (let i = 0; i < this.roofs.length; i++) {
      const r = this.roofs[i];
      const age = (depth - r.failM) / ROOF_FALL_M;
      if (age <= 0 || age > 1.5) continue;
      const d2 = (r.x - cam.x) ** 2 + (r.z - cam.z) ** 2;
      if (d2 > DUST_RANGE_M * DUST_RANGE_M) continue;
      near.push({ r, i, age, d2 });
      if (!this.heard.has(i) && age < 0.4 && d2 < HEAR_M * HEAR_M) {
        this.heard.add(i);
        const c: Collapse = { x: r.x, y: r.y, z: r.z, startH: hourAtDepth(r.failM), seed: hash(i) };
        this.lastCollapse = c;
        // The sound cue's hook: nothing plays yet; an audio layer listens here.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("flyby:debris", { detail: { x: r.x, z: r.z, distM: Math.sqrt(d2), spanM: r.spanM } }));
        }
      }
    }
    near.sort((a, b) => a.d2 - b.d2);
    for (const { r, i, age } of near.slice(0, this.opts.reduced ? 3 : 6)) {
      const a = age / 1.5, seed = hash(i * 1.7);
      // A burst up out of the house as the tiles go, spreading and thinning.
      for (let k = 0; k < 4; k++) {
        const sp = 2 + a * 10 + Math.min(r.spanM, 12) * 0.25;
        const ang = seed * 20 + k * 1.6;
        this.push(r.x + Math.cos(ang) * sp * 0.6, r.y - 1 + a * 8 + k * 1.2, r.z + Math.sin(ang) * sp * 0.6,
          2.5 + a * 7 + k + r.spanM * 0.15, seed + k * 0.1, 0.5, Math.min(1, age * 4) * (1 - a) * 0.85, 0.95, cam);
      }
    }
  }

  /** The roof that most recently started to fall within earshot, for the escape to report; null when none. */
  newestCollapse(): Collapse | null {
    return this.lastCollapse;
  }

  /**
   * The roof over (x, z) that is still standing, or the nearest standing one
   * within a few metres: where sheltering indoors puts you. Null when none.
   */
  shelterRoof(x: number, z: number): RoofInfo | null {
    const depth = this.state.pumiceM;
    let best: RoofInfo | null = null, bd = SHELTER_M * SHELTER_M;
    for (const r of this.roofs) {
      if (r.failM + ROOF_FALL_M <= depth) continue;
      if (pointInRing(r.ring, x, z)) return r;
      const d2 = (r.x - x) ** 2 + (r.z - z) ** 2;
      if (d2 < bd) { bd = d2; best = r; }
    }
    return best;
  }

  private updatePumice(t: number): void {
    const s = this.state;
    const k = Math.min(1, s.fallRateCmH / 15) * (1 - this.inSurge) * this.fallHere;
    this.pGeo.instanceCount = Math.round(this.pumiceN * k);
    this.pumice.visible = this.pGeo.instanceCount > 0;
    // The fine ash thickens as the light goes: the grey phase is finer and the
    // dark is mostly what it hangs in the air.
    this.aGeo.instanceCount = Math.round(this.ashN * k * (0.35 + 0.65 * (1 - s.light)));
    this.ash.visible = this.aGeo.instanceCount > 0;
    this.pumiceU.uTime.value = t;
    const grey = 1 - s.whiteness;
    (this.pumiceU.uPumice.value as THREE.Color).setRGB(0.8 - 0.42 * grey, 0.76 - 0.41 * grey, 0.68 - 0.34 * grey);
  }

  private drawBolt(strike: number, at: THREE.Vector4, slot: number, span: number): void {
    this.bolt.visible = strike > 0.3;
    if (!this.bolt.visible) return;
    const p = this.boltPos;
    let x = at.x, y = at.y + span * 2.5, z = at.z;
    const forks: number[][] = [];
    for (let i = 0; i < BOLT_MAIN; i++) {
      const nx = x + (hash(slot * 13 + i) - 0.5) * span, ny = y - span * (0.37 + 0.28 * hash(slot * 7 + i)), nz = z + (hash(slot * 3 + i) - 0.5) * span;
      p.set([x, y, z, nx, ny, nz], i * 6);
      if (i === 3 || i === 8) forks.push([nx, ny, nz]);
      x = nx; y = ny; z = nz;
    }
    // Two forks off the channel, wandering more and dying out.
    let k = BOLT_MAIN;
    for (let f = 0; f < forks.length; f++) {
      let [fx, fy, fz] = forks[f];
      const side = f ? 1 : -1;
      for (let i = 0; i < BOLT_FORK; i++, k++) {
        const s = span * (0.8 - i * 0.08);
        const nx = fx + side * s * (0.35 + 0.5 * hash(slot * 5 + f * 17 + i)), ny = fy - s * (0.2 + 0.4 * hash(slot * 11 + f * 7 + i)), nz = fz + (hash(slot * 19 + f * 3 + i) - 0.5) * s;
        p.set([fx, fy, fz, nx, ny, nz], k * 6);
        fx = nx; fy = ny; fz = nz;
      }
    }
    (this.bolt.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** The carried lamp's flame in the hand, the one to be picked up, and the townsfolk's torches. */
  private updateLamps(t: number, camera: THREE.PerspectiveCamera): void {
    const su = eruptionSurfaceUniforms;
    const flick = (k: number) => 0.85 + 0.1 * Math.sin(t * 13 + k) + 0.05 * Math.sin(t * 31 + k * 2);
    const G = this.gAttr.array as Float32Array, T = this.tAttr.array as Float32Array;
    let n = 0;
    const flame = (x: number, y: number, z: number, size: number, k: number, w: number) => {
      if (n >= 12) return;
      G.set([x, y, z, size], n * 4);
      T.set([w * 1.0, w * 0.5, w * 0.16, k], n * 4);
      n++;
    };
    if (this.lamp) {
      su.uLamp.value.set(this.lamp.x, this.lamp.y, this.lamp.z, 2.2 * flick(0));
      flame(this.lamp.x, this.lamp.y, this.lamp.z, 0.05, 0, flick(0));
    } else if (this.pickup) {
      // The lamp on the counter is lit, and lights the room it stands in.
      su.uLamp.value.set(this.pickup.x, this.pickup.y + 0.1, this.pickup.z, 1.4 * flick(3));
    } else su.uLamp.value.w = 0;
    if (this.pickup) flame(this.pickup.x, this.pickup.y + 0.1, this.pickup.z, 0.06, 3, flick(3));
    const dark = this.active && this.state.light < 0.3;
    for (let i = 0; i < TORCH_SLOTS; i++) {
      const tp = dark ? this.torches[i] : undefined;
      if (tp) {
        su.uTorch.value[i].set(tp.x, tp.y + 1.9, tp.z, 1.6 * flick(i + 5));
        flame(tp.x, tp.y + 1.95, tp.z, 0.16, i + 5, 2.5 * flick(i + 5));
      } else su.uTorch.value[i].w = 0;
    }
    this.gGeo.instanceCount = n;
    this.gAttr.needsUpdate = true;
    this.tAttr.needsUpdate = true;
    this.glow.visible = n > 0;
    void camera;
  }

  /** Shake the camera for this frame's draw; `unshake` puts it back. */
  shake(camera: THREE.PerspectiveCamera, t: number, frozen: boolean): void {
    if (!this.active || frozen) return;
    const q = this.state.quake + this.inSurge * 0.6;
    if (q < 0.05) return;
    const a = q * q * 0.012;
    this.savedQ.copy(camera.quaternion);
    this.savedP.copy(camera.position);
    const e = new THREE.Euler(
      a * (Math.sin(t * 37) + 0.5 * Math.sin(t * 61)),
      a * 0.6 * Math.sin(t * 43 + 1),
      a * 0.8 * Math.sin(t * 29 + 2),
    );
    this.shakeQ.setFromEuler(e);
    camera.quaternion.multiply(this.shakeQ);
    camera.position.y += a * 3 * Math.sin(t * 53);
    camera.updateMatrixWorld();
    this.shaken = true;
  }

  unshake(camera: THREE.PerspectiveCamera): void {
    if (!this.shaken) return;
    camera.quaternion.copy(this.savedQ);
    camera.position.copy(this.savedP);
    camera.updateMatrixWorld();
    this.shaken = false;
  }
}
