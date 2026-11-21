// GLSL and uniforms the terrain rings and the FFT ocean mesh both need. Its own
// module, not part of render/ocean.ts, because ocean.ts imports the terrain
// shader and the terrain shader includes these: one file holding both ends
// would be a module cycle evaluated in the wrong order.

import * as THREE from "three";
import { OCEAN_FETCH_REF_M } from "./oceanspectrum";

/** The uniforms the terrain rings take from the ocean, shared by reference. */
export interface OceanLinkUniforms {
  uOceanOn: THREE.IUniform<number>;
  uOceanCentre: THREE.IUniform<THREE.Vector3>;
  uOceanRadius: THREE.IUniform<number>;
  uOceanSink: THREE.IUniform<number>;
  uOceanFetchRef: THREE.IUniform<number>;
}

/** Off by default: a terrain with no ocean attached never sinks. */
export function oceanLinkUniforms(): OceanLinkUniforms {
  return {
    uOceanOn: { value: 0 },
    uOceanCentre: { value: new THREE.Vector3() },
    uOceanRadius: { value: 1 },
    uOceanSink: { value: 0 },
    uOceanFetchRef: { value: OCEAN_FETCH_REF_M },
  };
}

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
// trough, so the old surface never shows through one.
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
in vec2 vOceanXZ;
in float vOceanH;

// Equal slope per octave (a k^-3 tail), so the share of a cascade's slope a
// mip level has averaged out is about the level over the octaves it holds.
float oceanLostFrac(float foot, float patchM) {
  float lod = log2(max(foot * uOceanN / patchM, 1.0));
  return clamp(lod / max(log2(uOceanN) - 2.0, 1.0), 0.0, 1.0);
}
`;
