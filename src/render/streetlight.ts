// Light that reaches the ground at night: the street lamps, from the lamps that
// actually stand there, and the player car's headlights.
//
// WHY A GRID OF LAMPS AND NOT A PATTERN. The road and pavement shaders used to
// paint their own pools as a procedural rhythm in each ribbon's (u, v), the
// pavement on a 52 m pitch of its own and neither through the posts that
// render/streetlamps.ts stands up; and at dusk a pool was a faint additive
// smudge on a road that was otherwise black. The owner, from the driver's seat
// in the Loop: "maybe we need headlights or something". Now the lamp list the
// posts are placed from is binned, around the camera, into a small float
// texture of cells, each cell holding the lenses whose light reaches it, and
// every lit surface (carriageway, footway, cars) sums those few point lights
// per pixel. A post and its pool cannot disagree because they are the same
// record.
//
// THE LAYOUT. GRID_CELLS x GRID_CELLS cells of GRID_CELL_M, centred on the
// camera and re-centred when it has moved a quarter of the window. Each cell
// is GRID_SLOTS texels wide in an RGBA32F texture: (x, y, z) of a lens and w =
// 1 + its LED share (0 for an empty slot). A lamp is written into every cell
// its LAMP_REACH_M disk touches, so a fragment reads ONE cell and never its
// neighbours. Past the window the shaders fall back to their old mean pool,
// which is what a lamp a kilometre off is anyway.
//
// The global uniforms are one shared object, spread by reference into every
// material that lights with them, exactly as the sun-shadow uniforms are: there
// is one scene and one camera, and a copy per material would have to be kept
// in step by hand.
//
// FOR render/buildings.ts (not edited here; another change owns it): spread
// `streetLightUniforms` into its uniforms, add STREET_LIGHT_GLSL to its
// fragment shader and add `albedo * streetLight(vWorld, n)` to its lit colour
// to have the headlights and the lamps reach the facades as well.

import * as THREE from "three";

export const GRID_CELLS = 64;
export const GRID_CELL_M = 16;
/** Lamps a cell can hold. Eight covers the densest procedural spacing (a lamp
 *  every 26 m down both kerbs of a two-way) with the 18 m reach overlapping. */
export const GRID_SLOTS = 8;
/** How far a lamp's light reaches before it is windowed to zero, metres. */
export const LAMP_REACH_M = 18;

/**
 * The player's headlights, as two spot lamps at the front of the car.
 *
 * Low beam is the European/US asymmetric pattern in outline: a hard cutoff
 * just under the horizon, a wide spread close in, and a kick up on the kerb
 * side; high beam has no cutoff and throws further. Intensities are in the
 * renderer's own irradiance units, set by tools/verify-night.ts's floor.
 */
export const STREET_LIGHT_GLSL = /* glsl */ `
uniform highp sampler2D uLampGrid;
uniform vec4 uLampGridOrigin;   // x0, z0, cell metres, lamps on (night * enabled)
uniform vec3 uLampSodium;
uniform vec3 uLampLed;
uniform float uLampIntensity;
uniform vec3 uHeadPos;          // between the lamps, at lamp height
uniform vec3 uHeadFwd;          // unit, horizontal
uniform vec4 uHeadParams;       // on (night * enabled), high beam 0/1, half track, intensity

vec3 lampLight(vec3 p, vec3 n) {
  if (uLampGridOrigin.w <= 0.0) return vec3(0.0);
  vec2 c = (p.xz - uLampGridOrigin.xy) / uLampGridOrigin.z;
  if (c.x < 0.0 || c.y < 0.0 || c.x >= ${GRID_CELLS}.0 || c.y >= ${GRID_CELLS}.0) return vec3(0.0);
  ivec2 cell = ivec2(c);
  vec3 sum = vec3(0.0);
  for (int k = 0; k < ${GRID_SLOTS}; k++) {
    vec4 l = texelFetch(uLampGrid, ivec2(cell.x * ${GRID_SLOTS} + k, cell.y), 0);
    if (l.w <= 0.0) break;
    vec3 d = l.xyz - p;
    float r2 = dot(d, d);
    float horiz = length(d.xz) / ${LAMP_REACH_M.toFixed(1)};
    if (horiz >= 1.0) continue;
    vec3 L = d * inversesqrt(r2);
    // A cobra-head lantern throws down and out: a cosine lobe about the
    // vertical, windowed to zero at the reach so cells do not seam.
    float lobe = 0.35 + 0.65 * max(0.0, L.y);
    float win = (1.0 - horiz * horiz);
    win *= win;
    sum += mix(uLampSodium, uLampLed, l.w - 1.0) * (lobe * win * max(0.0, dot(n, L)) / (r2 + 4.0));
  }
  return sum * uLampIntensity * uLampGridOrigin.w;
}

vec3 headLight(vec3 p, vec3 n) {
  if (uHeadParams.x <= 0.0) return vec3(0.0);
  vec3 f = uHeadFwd;
  vec3 r = vec3(-f.z, 0.0, f.x);
  vec3 sum = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    vec3 o = uHeadPos + r * (k == 0 ? -uHeadParams.z : uHeadParams.z);
    vec3 d = p - o;
    float r2 = max(dot(d, d), 9.0);
    vec3 L = d * inversesqrt(r2);
    float fwd = dot(L, f);
    if (fwd <= 0.05) continue;
    float side = dot(L, r);
    float up = L.y;
    float a = atan(side, fwd);          // horizontal, right positive
    float b = asin(clamp(up, -1.0, 1.0)); // vertical, up positive
    float low;
    {
      // The cutoff sits at -0.6 degrees and rises 1.5 degrees on the kerb
      // side past 10 degrees right: that kick is what lights the kerb and the
      // signs without dazzling the oncoming lane.
      float cut = -0.0105 + 0.026 * smoothstep(0.10, 0.30, a);
      float vert = 1.0 - smoothstep(cut - 0.004, cut + 0.004, b);
      // Aimed about 1.5 degrees down: the hot spot lands 25 to 40 m ahead
      // and the road under the bonnet gets little, which is what keeps the
      // foreground from blowing out at 1/r^2.
      float aim = (b + 0.026) / 0.045;
      low = vert * exp(-a * a / (0.42 * 0.42)) * (exp(-aim * aim) + 0.04);
    }
    float high = exp(-a * a / (0.22 * 0.22)) * exp(-b * b / (0.07 * 0.07)) * 2.2;
    float shape = mix(low, max(low, high), uHeadParams.y);
    sum += vec3(1.0, 0.97, 0.92) * shape * max(0.0, dot(n, -L)) / r2;
  }
  return sum * uHeadParams.w * uHeadParams.x;
}

/** Everything this file lights a surface with, as irradiance. */
vec3 streetLight(vec3 p, vec3 n) {
  return lampLight(p, n) + headLight(p, n);
}

/** Whether the lamp grid covers p: inside it the shader's old mean pool is
 *  replaced by real lamps, outside it the mean pool stands. */
float lampGridCovers(vec3 p) {
  vec2 c = (p.xz - uLampGridOrigin.xy) / uLampGridOrigin.z;
  vec2 e = min(c, vec2(${GRID_CELLS}.0) - c);
  return uLampGridOrigin.w > 0.0 ? smoothstep(0.0, 4.0, min(e.x, e.y)) : 0.0;
}
`;

export interface StreetLightUniforms {
  uLampGrid: THREE.IUniform<THREE.DataTexture>;
  uLampGridOrigin: THREE.IUniform<THREE.Vector4>;
  uLampSodium: THREE.IUniform<THREE.Color>;
  uLampLed: THREE.IUniform<THREE.Color>;
  uLampIntensity: THREE.IUniform<number>;
  uHeadPos: THREE.IUniform<THREE.Vector3>;
  uHeadFwd: THREE.IUniform<THREE.Vector3>;
  uHeadParams: THREE.IUniform<THREE.Vector4>;
}

const gridData = new Float32Array(GRID_CELLS * GRID_SLOTS * GRID_CELLS * 4);
const gridTex = new THREE.DataTexture(gridData, GRID_CELLS * GRID_SLOTS, GRID_CELLS, THREE.RGBAFormat, THREE.FloatType);
gridTex.minFilter = THREE.NearestFilter;
gridTex.magFilter = THREE.NearestFilter;
gridTex.generateMipmaps = false;
gridTex.needsUpdate = true;

/** The one set, spread by reference into every lit material. */
export const streetLightUniforms: StreetLightUniforms = {
  uLampGrid: { value: gridTex },
  // Window parked far away until the first fill, with the lamps off.
  uLampGridOrigin: { value: new THREE.Vector4(1e9, 1e9, GRID_CELL_M, 0) },
  // Low-pressure-ish sodium, and a 4000 K LED. Measured as chromaticity
  // rather than invented: HPS sits near (0.52, 0.42) CIE xy, 4000 K near
  // (0.38, 0.38), converted to linear sRGB and normalised to the same luminance.
  uLampSodium: { value: new THREE.Color(1.0, 0.56, 0.20) },
  uLampLed: { value: new THREE.Color(0.86, 0.88, 0.94) },
  uLampIntensity: { value: 250 },
  uHeadPos: { value: new THREE.Vector3() },
  uHeadFwd: { value: new THREE.Vector3(0, 0, -1) },
  uHeadParams: { value: new THREE.Vector4(0, 0, 0.62, 1500) },
};

/** A lens, as the grid wants it. */
export interface GridLamp {
  x: number;
  y: number;
  z: number;
  /** 0 sodium .. 1 LED. */
  led: number;
}

/**
 * Bin `lamps` into the window centred on (cx, cz). Cheap (a few thousand
 * lamps, each into the handful of cells its reach touches); the caller only
 * does it when the window has moved or the lamp set has.
 */
export function fillLampGrid(lamps: readonly GridLamp[], cx: number, cz: number): { placed: number; dropped: number } {
  const half = (GRID_CELLS * GRID_CELL_M) / 2;
  const x0 = Math.floor((cx - half) / GRID_CELL_M) * GRID_CELL_M;
  const z0 = Math.floor((cz - half) / GRID_CELL_M) * GRID_CELL_M;
  gridData.fill(0);
  const fillCount = new Uint8Array(GRID_CELLS * GRID_CELLS);
  let placed = 0;
  let dropped = 0;
  for (const l of lamps) {
    const i0 = Math.floor((l.x - LAMP_REACH_M - x0) / GRID_CELL_M);
    const i1 = Math.floor((l.x + LAMP_REACH_M - x0) / GRID_CELL_M);
    const j0 = Math.floor((l.z - LAMP_REACH_M - z0) / GRID_CELL_M);
    const j1 = Math.floor((l.z + LAMP_REACH_M - z0) / GRID_CELL_M);
    if (i1 < 0 || j1 < 0 || i0 >= GRID_CELLS || j0 >= GRID_CELLS) continue;
    placed++;
    for (let j = Math.max(0, j0); j <= Math.min(GRID_CELLS - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(GRID_CELLS - 1, i1); i++) {
        // Only cells the reach disk actually touches.
        const nx = Math.max(x0 + i * GRID_CELL_M, Math.min(l.x, x0 + (i + 1) * GRID_CELL_M));
        const nz = Math.max(z0 + j * GRID_CELL_M, Math.min(l.z, z0 + (j + 1) * GRID_CELL_M));
        if ((nx - l.x) ** 2 + (nz - l.z) ** 2 > LAMP_REACH_M * LAMP_REACH_M) continue;
        const cell = j * GRID_CELLS + i;
        const k = fillCount[cell];
        if (k >= GRID_SLOTS) { dropped++; continue; }
        fillCount[cell] = k + 1;
        const t = ((j * GRID_CELLS * GRID_SLOTS) + i * GRID_SLOTS + k) * 4;
        gridData[t] = l.x;
        gridData[t + 1] = l.y;
        gridData[t + 2] = l.z;
        gridData[t + 3] = 1 + Math.min(1, Math.max(0, l.led));
      }
    }
  }
  gridTex.needsUpdate = true;
  const o = streetLightUniforms.uLampGridOrigin.value;
  o.x = x0;
  o.y = z0;
  o.z = GRID_CELL_M;
  return { placed, dropped };
}

/**
 * Share of a city's street lamps that are LED rather than sodium: rough
 * figures from each city's public conversion programme. New York finished
 * replacing its cobra heads with LED in 2017; San Francisco's and Chicago's
 * programmes were most of the way through by the early 2020s, Chicago's side
 * streets the last to go. Unknown cities get an even mix.
 */
export function ledShare(cityId: string): number {
  switch (cityId) {
    case "manhattan": return 1.0;
    case "sf": return 0.9;
    case "chicago": return 0.75;
    case "paris": return 0.6;
    default: return 0.5;
  }
}
