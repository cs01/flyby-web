// The oil lamps' light in the town shader (render/pompeii.ts): the uniforms
// and the GLSL. Its own module so pompeii.ts and pompeiilamps.ts, which need
// each other, do not import each other at load time.

import * as THREE from "three";

/** Uniform slots in the shader. A phone uses fewer of them (LAMP_TIERS). */
export const OIL_LIGHTS_MAX = 32;

/** How far a lamp's light reaches before the window takes it to zero, metres. */
export const OIL_REACH_M = 9;

export interface TownLampUniforms {
  /** Nearest lit oil lamps: xyz, w power (0 unused). */
  uOilLamp: THREE.IUniform<THREE.Vector4[]>;
  uOilLampN: THREE.IUniform<number>;
  /** 1 while the lamps run: the town's flat night glows give way to them. */
  uLampNight: THREE.IUniform<number>;
}

/** One set, spread by reference into the town's uniforms, like eruptionSurfaceUniforms. */
export const townLampUniforms: TownLampUniforms = {
  uOilLamp: { value: Array.from({ length: OIL_LIGHTS_MAX }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uOilLampN: { value: 0 },
  uLampNight: { value: 0 },
};

/**
 * The town shader's oil-lamp term, summed beside the eruption's pointLamp()
 * lights. townLampSpec is for bronze only: a second loop, so it is not run
 * on every wall.
 */
export const TOWN_LAMPS_GLSL = /* glsl */ `
uniform vec4 uOilLamp[${OIL_LIGHTS_MAX}];
uniform int uOilLampN;
uniform float uLampNight;
float oilLamp(vec4 L, vec3 p, vec3 n) {
  vec3 d = L.xyz - p;
  float r2 = dot(d, d);
  float win = clamp(1.0 - r2 / ${(OIL_REACH_M * OIL_REACH_M).toFixed(1)}, 0.0, 1.0);
  win *= win;
  // A little wrap only: the lamps sit inside rooms and recesses, and a big
  // wrap would light the far side of the wall they stand behind.
  float ndl = max(0.0, dot(n, d * inversesqrt(max(r2, 1e-4)))) * 0.92 + 0.08;
  return L.w * ndl * win / (r2 + 0.5);
}
/** Oil flames as irradiance: about 1900 K. */
vec3 townLamps(vec3 p, vec3 n) {
  float s = 0.0;
  for (int i = 0; i < ${OIL_LIGHTS_MAX}; i++) {
    if (i >= uOilLampN) break;
    s += oilLamp(uOilLamp[i], p, n);
  }
  return vec3(1.0, 0.5, 0.18) * s;
}
/** Bronze catches each flame as a small warm highlight. */
vec3 townLampSpec(vec3 p, vec3 n, vec3 v) {
  float s = 0.0;
  for (int i = 0; i < ${OIL_LIGHTS_MAX}; i++) {
    if (i >= uOilLampN) break;
    vec3 d = uOilLamp[i].xyz - p;
    float r2 = dot(d, d);
    if (r2 > 25.0) continue;
    vec3 l = d * inversesqrt(max(r2, 1e-4));
    s += uOilLamp[i].w * pow(max(0.0, dot(n, normalize(l + v))), 40.0) * max(0.0, dot(n, l)) / (r2 + 0.3);
  }
  return vec3(1.0, 0.55, 0.22) * s;
}
`;
