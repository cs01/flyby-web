// GLSL and uniforms the terrain rings and the FFT ocean mesh both need. Its own
// module, not part of render/ocean.ts, because ocean.ts imports the terrain
// shader and the terrain shader includes these: one file holding both ends
// would be a module cycle evaluated in the wrong order.

import * as THREE from "three";
import { OCEAN_FETCH_REF_M, SWELL_N, swellWaves } from "./oceanspectrum";

/** Side of the swell exposure grid the CPU fills about the camera. */
export const SWELL_GRID = 10;

/** The uniforms the terrain rings take from the ocean, shared by reference. */
export interface OceanLinkUniforms {
  uOceanOn: THREE.IUniform<number>;
  uOceanCentre: THREE.IUniform<THREE.Vector3>;
  uOceanRadius: THREE.IUniform<number>;
  uOceanSink: THREE.IUniform<number>;
  uOceanFetchRef: THREE.IUniform<number>;
  /** Swell amplitude factor per grid node (row-major, four to a vec4). */
  uSwellGrid: THREE.IUniform<THREE.Vector4[]>;
  /** Grid node (0, 0) in world x, z, and the node spacing, metres. */
  uSwellGridO: THREE.IUniform<THREE.Vector3>;
  /** The ocean's phase clock, so the swell and the FFT sea move together. */
  uSwellTime: THREE.IUniform<number>;
  uSwellOn: THREE.IUniform<number>;
}

/** Off by default: a terrain with no ocean attached never sinks and has no swell. */
export function oceanLinkUniforms(): OceanLinkUniforms {
  return {
    uOceanOn: { value: 0 },
    uOceanCentre: { value: new THREE.Vector3() },
    uOceanRadius: { value: 1 },
    uOceanSink: { value: 0 },
    uOceanFetchRef: { value: OCEAN_FETCH_REF_M },
    uSwellGrid: { value: Array.from({ length: (SWELL_GRID * SWELL_GRID) / 4 }, () => new THREE.Vector4()) },
    uSwellGridO: { value: new THREE.Vector3(0, 0, 1000) },
    uSwellTime: { value: 0 },
    uSwellOn: { value: 0 },
  };
}

/**
 * The swell (see swellWaves in render/oceanspectrum.ts) as constant tables,
 * at the full offshore height: the exposure grid scales it per place. For the
 * ocean's vertex stage (displacement) and the terrain fragment stage, OCEAN or
 * not (normals): the far field has to carry the same swell the disc displaces,
 * or the rim is where the sea changes character.
 */
function swellTableGlsl(): string {
  const w = swellWaves();
  const f = (x: number): string => x.toFixed(6);
  return [
    `#define SWELL_N ${SWELL_N}`,
    `const vec4 SWELL_W[${SWELL_N}] = vec4[${SWELL_N}](${w.map((s) => `vec4(${f(s.dx)}, ${f(s.dz)}, ${f(s.k)}, ${f(s.omega)})`).join(", ")});`,
    `const vec2 SWELL_A[${SWELL_N}] = vec2[${SWELL_N}](${w.map((s) => `vec2(${f(s.amp)}, ${f(s.phase)})`).join(", ")});`,
  ].join("\n");
}

export const SWELL_GLSL = /* glsl */ `
${swellTableGlsl()}
uniform vec4 uSwellGrid[${(SWELL_GRID * SWELL_GRID) / 4}];
uniform vec3 uSwellGridO;
uniform float uSwellTime;
// 0 with the ocean off (its kill switch): the swell goes with it.
uniform float uSwellOn;

float swellNode(int x, int y) {
  int j = y * ${SWELL_GRID} + x;
  return uSwellGrid[j >> 2][j & 3];
}

// The swell's amplitude factor here, bilinear over the grid. Past its edge the
// edge value holds: by then the swell is sub-pixel and only its roughness is
// left, which does not need to know about a headland 6 km away.
float swellAmpAt(vec2 xz) {
  vec2 g = clamp((xz - uSwellGridO.xy) / uSwellGridO.z, vec2(0.0), vec2(${SWELL_GRID - 1}.0 - 1e-3));
  ivec2 i = ivec2(floor(g));
  vec2 f = g - vec2(i);
  return mix(mix(swellNode(i.x, i.y), swellNode(i.x + 1, i.y), f.x),
             mix(swellNode(i.x, i.y + 1), swellNode(i.x + 1, i.y + 1), f.x), f.y);
}

// Gerstner displacement of the swell at xz, scaled by amp (swellAmpAt and any
// fades). Full steepness: at a 12 s period the swell's ka is ~0.03, so the
// horizontal motion only rounds the troughs.
vec3 swellDisp(vec2 xz, float amp) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < SWELL_N; i++) {
    vec4 w = SWELL_W[i];
    float a = SWELL_A[i].x * amp;
    float th = w.z * dot(w.xy, xz) - w.w * uSwellTime + SWELL_A[i].y;
    d.y += a * cos(th);
    d.xz -= w.xy * (a * sin(th));
  }
  return d;
}

// Height gradient of the swell, faded per component once a pixel spans more
// than an eighth of its wavelength (wdx, wdy: the pixel's world footprint),
// as the terrain's own waves are. The variance faded out comes back in
// .z, for the roughness.
vec3 swellSlope(vec2 xz, float amp, vec2 wdx, vec2 wdy) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < SWELL_N; i++) {
    vec4 w = SWELL_W[i];
    float a = SWELL_A[i].x * amp;
    float dph = w.z * max(abs(dot(w.xy, wdx)), abs(dot(w.xy, wdy)));
    float keep = smoothstep(1.57, 0.785, dph);
    float th = w.z * dot(w.xy, xz) - w.w * uSwellTime + SWELL_A[i].y;
    s.xy -= w.xy * (a * w.z * keep * sin(th));
    s.z += 0.5 * (a * w.z) * (a * w.z) * (1.0 - keep * keep);
  }
  return s;
}
`;

/**
 * Where the FFT sea applies and how big its waves are, shared by the ocean's
 * vertex and fragment stages and by the terrain's vertex stage (which sinks
 * the water it would otherwise draw over the ocean's troughs).
 */
export const OCEAN_SHARED_GLSL = /* glsl */ `
// 0 with the ocean off: the terrain does not sink and the mesh is hidden.
uniform float uOceanOn;
// The camera, which the disc follows, in world metres (y unused).
uniform vec3 uOceanCentre;
uniform float uOceanRadius;
// Metres the terrain water sinks under the disc: deeper than the deepest
// trough (wind sea and swell), so the old surface never shows through one.
uniform float uOceanSink;
// The fetch the FFT spectrum was built for; see OCEAN_FETCH_REF_M.
uniform float uOceanFetchRef;

// 1 near the camera, 0 at the rim. The far half of the disc fades, so the
// rim where the FFT sea hands back to the terrain's own waves is a band a
// kilometre wide at a range where every wave is sub-pixel, not a line.
float oceanRadial(vec2 xz) {
  return uOceanOn * (1.0 - smoothstep(0.55 * uOceanRadius, uOceanRadius, length(xz - uOceanCentre.xz)));
}

// The displaced geometry flattens over the last tens of metres to a coast.
// Not for realism: the terrain water there is not sunk (its triangles reach
// up onto the land), so a trough here would show the old surface through it.
float oceanGeomRamp(float shoreD) {
  return smoothstep(8.0, 60.0, shoreD);
}

// One spectrum serves the disc, so a harbour arm and the open bay get the same
// waves at different heights. Fetch from shore distance as the terrain water
// takes it; the 0.35 power (not the 0.5 of Hs ~ sqrt(F)) because four times the
// nearest coast badly under-reads the fetch beside an island, and Alcatraz
// would otherwise sit in a millpond in a westerly.
float oceanFetchAmp(float shoreD) {
  return clamp(pow((4.0 * shoreD + 200.0) / uOceanFetchRef, 0.35), 0.0, 1.4);
}

float oceanHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float oceanNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(oceanHash(i), oceanHash(i + vec2(1.0, 0.0)), f.x),
             mix(oceanHash(i + vec2(0.0, 1.0)), oceanHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// TILE BREAKING, for a plan with one cascade (the phone's 80 m patch, whose
// repeat is plain from a deck). The sea is a blend of the patch and a second
// read of it, mirrored across the wind and shifted, weighted by a 170 m noise
// that never repeats. Mirrored across the wind, not rotated: the mirror image
// of a wind sea is the same spectrum (the spreading is symmetric about the
// wind) travelling the same way, so the second read is just as physical as
// the first. The blend is divided by the norm of its weights, so a 50/50 mix
// of two independent fields keeps the variance of one rather than losing
// half of it (Heitz and Neyret's variance-preserving blend).
vec2 oceanMirror(vec2 v, vec2 wdir) {
  return 2.0 * dot(v, wdir) * wdir - v;
}
float oceanDetileMask(vec2 xz) {
  return smoothstep(0.3, 0.7, oceanNoise(xz / 170.0 + vec2(3.7, 1.9)));
}
float oceanDetileNorm(float m) {
  return inversesqrt((1.0 - m) * (1.0 - m) + m * m);
}
// Shift of the second read, in patch units: far from any simple fraction.
const vec2 OCEAN_DETILE_OFS = vec2(0.371, 0.617);
// The detail octave's scale (render/terrain.ts): the patch read this many
// times smaller, so the band it carries starts where the cascade's ends (an
// 80 m patch's 5 m floor is 80 / 16) and no wavelength is in both.
const float OCEAN_DETAIL_S = 16.0;
`;

/**
 * For a VERTEX stage: the landcover uniforms the fragment stage already
 * declares, and the shore distance read without derivatives.
 */
export const OCEAN_VS_GLSL = /* glsl */ `
uniform sampler2D uShoreNear;
uniform sampler2D uShoreFar;
uniform float uLandNearExtent;
uniform float uLandFarExtent;
uniform float uWaterLevel;
${OCEAN_SHARED_GLSL}

// Distance from water to the nearest land, metres; the same decode as the
// terrain fragment shader, see encodeShoreDistance in data/landmask.ts.
float oceanShoreD(vec2 xz) {
  vec2 uvN = xz / (2.0 * uLandNearExtent) + 0.5;
  vec2 uvF = xz / (2.0 * uLandFarExtent) + 0.5;
  float r = max(abs(xz.x), abs(xz.y)) / max(1.0, uLandNearExtent);
  float sN = textureLod(uShoreNear, uvN, 0.0).r;
  float sF = textureLod(uShoreFar, uvF, 0.0).r;
  return mix(sN * sN * 4000.0, sF * sF * 40000.0, smoothstep(0.9, 1.0, r));
}

// How far a terrain vertex sinks. Only vertices AT the water level (a hill
// with a lake mask on it stays put), only away from the coast, and over a
// slightly wider disc and a slightly earlier shore ramp than the waves, so the
// sink is at least the trough wherever the ocean has one.
float oceanSinkAt(vec3 p) {
  if (uOceanOn < 0.5) return 0.0;
  float d = length(p.xz - uOceanCentre.xz);
  float radial = 1.0 - smoothstep(0.62 * uOceanRadius, 1.02 * uOceanRadius, d);
  if (radial <= 0.0) return 0.0;
  float level = 1.0 - smoothstep(0.5, 1.5, abs(p.y - uWaterLevel));
  return uOceanSink * radial * level * smoothstep(3.0, 40.0, oceanShoreD(p.xz));
}
`;

/**
 * For the terrain FRAGMENT stage compiled as the ocean (OCEAN defined): the
 * FFT normal maps and what the shading needs to know about them.
 */
export const OCEAN_FS_GLSL = /* glsl */ `
${OCEAN_SHARED_GLSL}
// Per cascade: (height gradient x, z, Jacobian, accumulated foam), mipmapped.
uniform sampler2D uOceanNrm0;
uniform sampler2D uOceanNrm1;
uniform vec2 uOceanPatch;
uniform float uOceanN;
// Expected slope variance each cascade carries, for the share a pixel's mip
// has averaged away (it goes to the glint roughness, as the analytic waves'
// does).
uniform vec2 uOceanSlopeVar;
uniform float uOceanHeightSd;
// Wavelengths the FFT carries, metres: the analytic waves inside it are
// dropped so no wave is counted twice.
uniform vec2 uOceanBand;
// Unit wind direction (east, south): the mirror axis of the tile breaking.
uniform vec2 uOceanWind;
// Per cascade (Jacobian threshold, soft half-width): see foamThreshold. What
// is folding NOW is the breaking crest, as against the foam it left behind.
uniform vec4 uOceanFoamTh;
in vec2 vOceanXZ;
in float vOceanH;

// How far into its breaking a crest is: 1 where the post pass's own foam
// threshold (th.x +- th.y) says foam, falling off over three times its soft
// width above it, so the sheet has a feathered rim rather than the contour
// of one Jacobian level.
float oceanBreaking(float J, vec2 th) {
  return smoothstep(th.x + 3.0 * th.y, th.x - th.y, J);
}

// THE FOAM'S OWN TEXTURE, 0..1 and roughly uniform over that range. qa is the
// position in wind axes (x downwind), metres; foot the pixel footprint.
//
// Foam is not a blob with a soft edge; it is a lace of bubble walls round
// holes, drawn out into streaks along the wind as it ages. Ridged noise (bright
// where the noise crosses its middle) is a network of thin walls; stretching
// it 3x downwind and warping it at 10 m makes the walls into streaks that bend.
// Each octave fades to its mean once the pixel covers its period, so far off
// this is a flat 0.5 and the caller's coverage turns into the plain average.
float oceanFoamTex(vec2 qa, float foot) {
  vec2 p = qa / vec2(3.0, 1.0);
  vec2 w = vec2(oceanNoise(p * 0.12 + vec2(3.1, 7.7)), oceanNoise(p * 0.12 + vec2(8.4, 1.3))) - 0.5;
  p += 3.0 * w;
  float r1 = 1.0 - abs(2.0 * oceanNoise(p * 0.6) - 1.0);
  float r2 = 1.0 - abs(2.0 * oceanNoise(p * 1.9 + vec2(5.2, 3.3)) - 1.0);
  float n3 = oceanNoise(p * 6.0 + vec2(1.7, 6.1));
  float t = 0.5 * mix(0.5, r1, smoothstep(2.4, 0.8, foot))
          + 0.32 * mix(0.5, r2, smoothstep(0.8, 0.25, foot))
          + 0.18 * mix(0.5, n3, smoothstep(0.25, 0.08, foot));
  return smoothstep(0.28, 0.78, t);
}

// Equal slope per octave (a k^-3 tail), so the share of a cascade's slope a
// mip level has averaged out is about the level over the octaves it holds.
float oceanLostFrac(float foot, float patchM) {
  float lod = log2(max(foot * uOceanN / patchM, 1.0));
  return clamp(lod / max(log2(uOceanN) - 2.0, 1.0), 0.0, 1.0);
}

// The mip level that blurs a cascade's map over blurM metres, or a level
// past the pixel's own where the pixel is already wider than that.
float oceanBlurLod(float blurM, float foot, float patchM) {
  float texM = patchM / uOceanN;
  return max(log2(max(blurM / texM, 1.0)), log2(max(foot / texM, 1.0)) + 1.0);
}
`;
