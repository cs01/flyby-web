// The oil lamps' light in the town shader (render/pompeii.ts): the uniforms,
// the GLSL, and the light grid. Its own module so pompeii.ts and
// pompeiilamps.ts, which need each other, do not import each other at load.
//
// The grid: the chosen lights' ground footprint cut into OIL_GRID x OIL_GRID
// cells, each holding a 32-bit mask of the lights whose reach touches it, in
// a tiny RGBA8 texture rebuilt each frame. A pixel reads its cell and loops
// over those bits only, two to five lights in a lamp-lit street instead of
// all 32: looping them all cost a quarter of the frame at 720p.

import * as THREE from "three";

/** Uniform slots in the shader: the bits of one cell's mask. A phone uses fewer (LAMP_TIERS). */
export const OIL_LIGHTS_MAX = 32;

/** How far a lamp's light reaches before the window takes it to zero, metres. */
export const OIL_REACH_M = 9;

/** Cells along each side of the light grid. */
export const OIL_GRID = 16;

export interface TownLampUniforms {
  /** Nearest lit oil lamps: xyz, w power (0 unused). */
  uOilLamp: THREE.IUniform<THREE.Vector4[]>;
  uOilLampN: THREE.IUniform<number>;
  /** The grid: x0, z0 of its corner, 1 / cell size, 0 when no lights. */
  uOilGrid: THREE.IUniform<THREE.Vector4>;
  /** Per cell, the light mask as four bytes, low byte in r. */
  uOilMask: THREE.IUniform<THREE.DataTexture>;
  /** 1 while the lamps run: the town's flat night glows give way to them. */
  uLampNight: THREE.IUniform<number>;
}

const maskBytes = new Uint8Array(OIL_GRID * OIL_GRID * 4);
const maskTex = new THREE.DataTexture(maskBytes, OIL_GRID, OIL_GRID, THREE.RGBAFormat, THREE.UnsignedByteType);
maskTex.magFilter = THREE.NearestFilter;
maskTex.minFilter = THREE.NearestFilter;
maskTex.generateMipmaps = false;

/** One set, spread by reference into the town's uniforms, like eruptionSurfaceUniforms. */
export const townLampUniforms: TownLampUniforms = {
  uOilLamp: { value: Array.from({ length: OIL_LIGHTS_MAX }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uOilLampN: { value: 0 },
  uOilGrid: { value: new THREE.Vector4(0, 0, 0, 0) },
  uOilMask: { value: maskTex },
  uLampNight: { value: 0 },
};

/**
 * Rebuild the grid from the first `n` lights of uOilLamp. Returns the mean
 * number of lights per cell that has any, for the gate.
 */
export function buildOilGrid(n: number): number {
  const L = townLampUniforms.uOilLamp.value, G = townLampUniforms.uOilGrid.value;
  maskBytes.fill(0);
  if (n === 0) {
    G.set(0, 0, 0, 0);
    maskTex.needsUpdate = true;
    return 0;
  }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < n; k++) {
    x0 = Math.min(x0, L[k].x); x1 = Math.max(x1, L[k].x);
    z0 = Math.min(z0, L[k].z); z1 = Math.max(z1, L[k].z);
  }
  x0 -= OIL_REACH_M; z0 -= OIL_REACH_M; x1 += OIL_REACH_M; z1 += OIL_REACH_M;
  // Square cells; never finer than 2 m, where the masks stop getting sparser.
  const cs = Math.max(2, Math.max(x1 - x0, z1 - z0) / OIL_GRID);
  const inv = 1 / cs;
  const mask = new Uint32Array(OIL_GRID * OIL_GRID);
  for (let k = 0; k < n; k++) {
    if (L[k].w <= 0) continue;
    const i0 = Math.max(0, Math.floor((L[k].x - OIL_REACH_M - x0) * inv)), i1 = Math.min(OIL_GRID - 1, Math.floor((L[k].x + OIL_REACH_M - x0) * inv));
    const j0 = Math.max(0, Math.floor((L[k].z - OIL_REACH_M - z0) * inv)), j1 = Math.min(OIL_GRID - 1, Math.floor((L[k].z + OIL_REACH_M - z0) * inv));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // The cell's nearest point to the light: skip corners the circle misses.
      const cx = Math.max(x0 + i * cs, Math.min(L[k].x, x0 + (i + 1) * cs)), cz = Math.max(z0 + j * cs, Math.min(L[k].z, z0 + (j + 1) * cs));
      if ((cx - L[k].x) ** 2 + (cz - L[k].z) ** 2 >= OIL_REACH_M * OIL_REACH_M) continue;
      mask[j * OIL_GRID + i] |= 1 << k;
    }
  }
  let cells = 0, bits = 0;
  for (let c = 0; c < mask.length; c++) {
    const m = mask[c] >>> 0;
    maskBytes[c * 4] = m & 255; maskBytes[c * 4 + 1] = (m >>> 8) & 255; maskBytes[c * 4 + 2] = (m >>> 16) & 255; maskBytes[c * 4 + 3] = (m >>> 24) & 255;
    if (m) { cells++; let v = m; while (v) { v &= v - 1; bits++; } }
  }
  G.set(x0, z0, inv, 1);
  maskTex.needsUpdate = true;
  return cells ? bits / cells : 0;
}

/** The mask of the cell holding (x, z), as the shader reads it; for the gate. */
export function oilMaskAt(x: number, z: number): number {
  const G = townLampUniforms.uOilGrid.value;
  if (G.w === 0) return 0;
  const i = Math.floor((x - G.x) * G.z), j = Math.floor((z - G.y) * G.z);
  if (i < 0 || j < 0 || i >= OIL_GRID || j >= OIL_GRID) return 0;
  const c = (j * OIL_GRID + i) * 4;
  return (maskBytes[c] | (maskBytes[c + 1] << 8) | (maskBytes[c + 2] << 16) | (maskBytes[c + 3] << 24)) >>> 0;
}

/**
 * The town shader's oil-lamp term, summed beside the eruption's pointLamp()
 * lights. townLampSpec is for bronze only, so its loop is not run on every wall.
 */
export const TOWN_LAMPS_GLSL = /* glsl */ `
uniform vec4 uOilLamp[${OIL_LIGHTS_MAX}];
uniform int uOilLampN;
uniform vec4 uOilGrid;
uniform sampler2D uOilMask;
uniform float uLampNight;
uint oilCell(vec3 p) {
  if (uOilGrid.w == 0.0) return 0u;
  ivec2 c = ivec2(floor((p.xz - uOilGrid.xy) * uOilGrid.z));
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, ivec2(${OIL_GRID})))) return 0u;
  uvec4 b = uvec4(texelFetch(uOilMask, c, 0) * 255.0 + 0.5);
  return b.r | (b.g << 8) | (b.b << 16) | (b.a << 24);
}
// The index of the lowest set bit (findLSB is GLSL ES 3.1, WebGL2 is 3.0):
// the bit alone is an exact power of two, so its log2 is exact.
int lowBit(uint b) {
  return int(log2(float(b & (~b + 1u))) + 0.5);
}
float oilLamp(vec4 L, vec3 p, vec3 n) {
  vec3 d = L.xyz - p;
  float r2 = dot(d, d);
  if (r2 >= ${(OIL_REACH_M * OIL_REACH_M).toFixed(1)}) return 0.0;
  float win = 1.0 - r2 / ${(OIL_REACH_M * OIL_REACH_M).toFixed(1)};
  win *= win;
  // A little wrap only: the lamps sit inside rooms and recesses, and a big
  // wrap would light the far side of the wall they stand behind.
  float ndl = max(0.0, dot(n, d * inversesqrt(max(r2, 1e-4)))) * 0.92 + 0.08;
  return L.w * ndl * win / (r2 + 0.5);
}
/** Oil flames as irradiance: about 1900 K. */
vec3 townLamps(vec3 p, vec3 n) {
  float s = 0.0;
  uint bits = oilCell(p);
  while (bits != 0u) {
    int i = lowBit(bits);
    bits &= bits - 1u;
    s += oilLamp(uOilLamp[i], p, n);
  }
  return vec3(1.0, 0.5, 0.18) * s;
}
/** Bronze catches each flame as a small warm highlight. */
vec3 townLampSpec(vec3 p, vec3 n, vec3 v) {
  float s = 0.0;
  uint bits = oilCell(p);
  while (bits != 0u) {
    int i = lowBit(bits);
    bits &= bits - 1u;
    vec3 d = uOilLamp[i].xyz - p;
    float r2 = dot(d, d);
    if (r2 > 25.0) continue;
    vec3 l = d * inversesqrt(max(r2, 1e-4));
    s += uOilLamp[i].w * pow(max(0.0, dot(n, normalize(l + v))), 40.0) * max(0.0, dot(n, l)) / (r2 + 0.3);
  }
  return vec3(1.0, 0.55, 0.22) * s;
}
`;
