// Spherical-harmonic sky irradiance: the maths, with no THREE and no DOM in it.
//
// Split out from skyprobe.ts so test/sh.check.ts can gate it under Bun. An
// environment probe is easy to get subtly wrong in ways that never crash: a
// mirrored cube face, a missing solid-angle weight, a convolution constant off
// by a factor of pi. Every one of those renders as "the ambient looks a bit
// off", which is unarguable by eye and trivially assertable here.
//
// Representation: 9 RGB coefficients (L2), stored as 27 floats, coefficient
// major. Nine vec3 uniforms and a few ALU per fragment, no texture fetch. That
// is the whole reason SH is the right answer for diffuse: a per-fragment cube
// lookup on every wall in a city is not affordable, and a hemispherical
// constant cannot say which way a wall faces.
//
// Convolution constants are Ramamoorthi & Hanrahan's: irradiance is the
// radiance SH multiplied per band by A0 = pi, A1 = 2pi/3, A2 = pi/4.

/** Coefficients per colour channel. */
export const SH_COEFF_COUNT = 9;

/** 27 floats: coefficient i, channel c lives at `i * 3 + c`. */
export type SH9 = Float32Array;

export function shZero(): SH9 {
  return new Float32Array(SH_COEFF_COUNT * 3);
}

// Real SH basis normalisation constants, written as their closed forms rather
// than as decimals so the GLSL emitted below cannot drift from the TypeScript.
const K0 = Math.sqrt(1 / (4 * Math.PI)); // Y(0,0)
const K1 = Math.sqrt(3 / (4 * Math.PI)); // Y(1,m)
const K2 = 0.5 * Math.sqrt(15 / Math.PI); // Y(2,-2), Y(2,-1), Y(2,1)
const K3 = 0.25 * Math.sqrt(5 / Math.PI); // Y(2,0)
const K4 = 0.25 * Math.sqrt(15 / Math.PI); // Y(2,2)

const A0 = Math.PI;
const A1 = (2 * Math.PI) / 3;
const A2 = Math.PI / 4;

/** Per-coefficient band weight, so evaluation is one multiply per term. */
const AHAT = [A0, A1, A1, A1, A2, A2, A2, A2, A2] as const;

const _basis = new Float32Array(SH_COEFF_COUNT);

/**
 * The nine basis functions at a unit direction.
 *
 * Ordering is the usual one: 0 is the constant term, 1..3 are linear in y, z, x
 * and 4..8 are quadratic. Which axis is called polar does not matter, only that
 * projection and evaluation agree, so the y-first order is kept because the
 * hemispherical fallback below wants the y term at a fixed index.
 */
export function shBasis(x: number, y: number, z: number, out: Float32Array): void {
  out[0] = K0;
  out[1] = K1 * y;
  out[2] = K1 * z;
  out[3] = K1 * x;
  out[4] = K2 * x * y;
  out[5] = K2 * y * z;
  out[6] = K3 * (3 * z * z - 1);
  out[7] = K2 * x * z;
  out[8] = K4 * (x * x - y * y);
}

/** Add one direction's radiance, weighted by the solid angle it subtends. */
export function shAccumulate(
  sh: SH9,
  x: number,
  y: number,
  z: number,
  r: number,
  g: number,
  b: number,
  dOmega: number,
): void {
  shBasis(x, y, z, _basis);
  for (let i = 0; i < SH_COEFF_COUNT; i++) {
    const w = _basis[i] * dOmega;
    sh[i * 3] += r * w;
    sh[i * 3 + 1] += g * w;
    sh[i * 3 + 2] += b * w;
  }
}

/**
 * Irradiance arriving at a surface whose normal is (x, y, z).
 *
 * A constant environment of radiance L returns pi * L, which is the analytic
 * answer and the thing worth checking first.
 *
 * CLAMPED at zero. An L2 fit to a small bright source rings, and the ringing
 * genuinely goes negative about 40 degrees past the far side of the source;
 * negative light has no meaning downstream and subtracts from the sun term if
 * it is allowed through. The GLSL below clamps identically.
 */
export function shIrradiance(sh: SH9, x: number, y: number, z: number, out: Float32Array): void {
  shBasis(x, y, z, _basis);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < SH_COEFF_COUNT; i++) {
    const w = AHAT[i] * _basis[i];
    r += sh[i * 3] * w;
    g += sh[i * 3 + 1] * w;
    b += sh[i * 3 + 2] * w;
  }
  out[0] = Math.max(0, r);
  out[1] = Math.max(0, g);
  out[2] = Math.max(0, b);
}

/**
 * The SH whose irradiance is exactly `colour * (base + slope * n.y)`.
 *
 * This is the hemispherical ambient hack every surface shader used before the
 * probe existed, expressed in the probe's own representation. It is the safe
 * value to hold the uniforms at before the first probe render and the fallback
 * when the sky is too dark to normalise against, so a missing probe reproduces
 * the old look rather than a black frame.
 */
export function shHemispherical(colour: ArrayLike<number>, base: number, slope: number): SH9 {
  const sh = shZero();
  for (let c = 0; c < 3; c++) {
    sh[c] = (colour[c] * base) / (A0 * K0);
    sh[3 + c] = (colour[c] * slope) / (A1 * K1);
  }
  return sh;
}

const _probe = new Float32Array(3);

/**
 * Rescale each channel so irradiance along (x, y, z) equals `target`.
 *
 * The probe supplies the SHAPE of the sky and the scene's own lighting model
 * supplies the LEVEL. Anchoring at the zenith means a horizontal surface is lit
 * exactly as it was before the probe existed, so nothing global gets brighter
 * or darker: everything the probe does is a redistribution around that anchor.
 *
 * Per channel rather than by luminance on purpose. The probe renders the clear
 * atmosphere and knows nothing about the cloud decks, so under an overcast its
 * chroma would be sky blue while the scene's own ambient has correctly gone
 * grey. Normalising per channel keeps the scene's colour authoritative and
 * takes only the directionality from the probe.
 *
 * Returns false when the anchor is too dark to divide by, which is most of the
 * night; the caller should keep its fallback.
 */
export function shNormaliseAt(
  sh: SH9,
  x: number,
  y: number,
  z: number,
  target: ArrayLike<number>,
  floor: number,
): boolean {
  shIrradiance(sh, x, y, z, _probe);
  for (let c = 0; c < 3; c++) {
    if (!(_probe[c] > floor) || !Number.isFinite(_probe[c])) return false;
  }
  for (let c = 0; c < 3; c++) {
    const k = target[c] / _probe[c];
    if (!Number.isFinite(k)) return false;
    for (let i = 0; i < SH_COEFF_COUNT; i++) sh[i * 3 + c] *= k;
  }
  return true;
}

// --- cube faces --------------------------------------------------------------

/**
 * Face bases in the standard GL cube order: +X, -X, +Y, -Y, +Z, -Z.
 *
 * Each row is three vectors (su, sv, sw) so that a face coordinate (u, v) in
 * [-1, 1] maps to the direction `su * u + sv * v + sw`. Shipping the mapping as
 * data rather than as two copies of a switch statement is what lets the probe
 * shader be handed the same basis as a mat3 uniform: there is one definition of
 * which texel looks where, so the captured sky cannot come back mirrored.
 */
export const CUBE_FACE_BASIS: readonly (readonly number[])[] = [
  [0, 0, -1, 0, -1, 0, 1, 0, 0], // +X
  [0, 0, 1, 0, -1, 0, -1, 0, 0], // -X
  [1, 0, 0, 0, 0, 1, 0, 1, 0], // +Y
  [1, 0, 0, 0, 0, -1, 0, -1, 0], // -Y
  [1, 0, 0, 0, -1, 0, 0, 0, 1], // +Z
  [-1, 0, 0, 0, -1, 0, 0, 0, -1], // -Z
];

export const CUBE_FACES = CUBE_FACE_BASIS.length;

/** Unit direction for face coordinates (u, v), both in [-1, 1]. */
export function cubeFaceDirection(face: number, u: number, v: number, out: Float32Array): void {
  const m = CUBE_FACE_BASIS[face];
  const x = m[0] * u + m[3] * v + m[6];
  const y = m[1] * u + m[4] * v + m[7];
  const z = m[2] * u + m[5] * v + m[8];
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
}

function areaElement(x: number, y: number): number {
  return Math.atan2(x * y, Math.sqrt(x * x + y * y + 1));
}

/**
 * Exact solid angle of the face rectangle [u0, u1] x [v0, v1].
 *
 * Exact rather than the usual `(2/N)^2 / (1 + u^2 + v^2)^1.5` approximation
 * because the six faces then sum to 4*pi to float precision, which turns the
 * uniform-environment test into a tight equality instead of a tolerance the
 * face resolution has to be tuned against.
 */
export function cubeTexelSolidAngle(u0: number, u1: number, v0: number, v1: number): number {
  return areaElement(u1, v1) - areaElement(u0, v1) - areaElement(u1, v0) + areaElement(u0, v0);
}

const _dir = new Float32Array(3);

/**
 * Project six square faces of RGBA radiance into SH.
 *
 * `pixels` is the six faces stacked in the GL face order, each `size` by `size`,
 * four floats per texel, with row 0 of each face at the BOTTOM: that is the
 * layout `gl.readPixels` hands back from a render target whose viewport was set
 * per face, and matching it here rather than flipping is what keeps the probe
 * the right way up.
 */
export function shProjectCubeFaces(pixels: ArrayLike<number>, size: number, out: SH9): void {
  out.fill(0);
  const step = 2 / size;
  for (let face = 0; face < CUBE_FACES; face++) {
    for (let row = 0; row < size; row++) {
      const v0 = row * step - 1;
      const v1 = v0 + step;
      const v = (v0 + v1) * 0.5;
      for (let col = 0; col < size; col++) {
        const u0 = col * step - 1;
        const u1 = u0 + step;
        const u = (u0 + u1) * 0.5;
        cubeFaceDirection(face, u, v, _dir);
        const p = ((face * size + row) * size + col) * 4;
        shAccumulate(
          out,
          _dir[0],
          _dir[1],
          _dir[2],
          pixels[p],
          pixels[p + 1],
          pixels[p + 2],
          cubeTexelSolidAngle(u0, u1, v0, v1),
        );
      }
    }
  }
}

// --- GLSL --------------------------------------------------------------------

const g = (n: number): string => n.toPrecision(9);

/**
 * The same evaluation, for the surface shaders.
 *
 * Constants are interpolated from the values above rather than typed in, so
 * the gate on the TypeScript is a gate on the GLSL too.
 */
export const SH_GLSL = /* glsl */ `
uniform vec3 uSH[9];

/** Sky irradiance for a surface normal. Clamped: see the note in sh.ts. */
vec3 shIrradiance(vec3 n) {
  vec3 e = ${g(A0 * K0)} * uSH[0]
         + ${g(A1 * K1)} * (uSH[1] * n.y + uSH[2] * n.z + uSH[3] * n.x)
         + ${g(A2 * K2)} * (uSH[4] * n.x * n.y + uSH[5] * n.y * n.z + uSH[7] * n.x * n.z)
         + ${g(A2 * K3)} * uSH[6] * (3.0 * n.z * n.z - 1.0)
         + ${g(A2 * K4)} * uSH[8] * (n.x * n.x - n.y * n.y);
  return max(e, vec3(0.0));
}
`;
