// The gate on the sky probe's maths.
//
// The probe itself needs a GPU, a cube render target and a sky shader, none of
// which exist under Bun. What CAN be pinned down is the part that is easy to
// get wrong and impossible to see: the spherical-harmonic projection and
// evaluation. Every failure mode here renders as "the ambient looks a bit off"
// rather than as a crash, so nothing but arithmetic will catch it.
//
// The expected values are DERIVED, from Math.PI and from the environment the
// test builds, never from the module under test. A threshold read out of the
// thing it is checking moves its own goalposts and can never go red; the
// tolerances below are literals for the same reason.
//
// One thing this file deliberately cannot check: whether the GPU writes a cube
// face the same way up as shProjectCubeFaces reads it. A test that builds its
// own environment through cubeFaceDirection and then projects it with the same
// function is self-consistent under any mirroring of a face, so a mirrored face
// is invisible here. That is why the face mapping is a table in sh.ts handed to
// the probe shader as a mat3 uniform rather than a switch statement written out
// twice: it is settled by construction instead of by assertion.
//
// Watched to fail; the notes on each block say what was broken and what the
// break looked like.

import {
  CUBE_FACES,
  SH_COEFF_COUNT,
  cubeFaceDirection,
  cubeTexelSolidAngle,
  shHemispherical,
  shIrradiance,
  shNormaliseAt,
  shProjectCubeFaces,
  shZero,
  type SH9,
} from "../src/render/sh";

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(40)} ${detail}`);
  if (!ok) failures++;
}

const FACE = 32;

/** Radiance as a function of direction, written into `out` as RGB. */
type Environment = (x: number, y: number, z: number, out: Float32Array) => void;

/** Six faces of RGBA radiance in the layout shProjectCubeFaces expects. */
function renderCube(env: Environment, size = FACE): Float32Array {
  const px = new Float32Array(size * size * CUBE_FACES * 4);
  const dir = new Float32Array(3);
  const rgb = new Float32Array(3);
  const step = 2 / size;
  for (let face = 0; face < CUBE_FACES; face++) {
    for (let row = 0; row < size; row++) {
      const v = (row + 0.5) * step - 1;
      for (let col = 0; col < size; col++) {
        const u = (col + 0.5) * step - 1;
        cubeFaceDirection(face, u, v, dir);
        env(dir[0], dir[1], dir[2], rgb);
        const p = ((face * size + row) * size + col) * 4;
        px[p] = rgb[0];
        px[p + 1] = rgb[1];
        px[p + 2] = rgb[2];
        px[p + 3] = 1;
      }
    }
  }
  return px;
}

function project(env: Environment, size = FACE): SH9 {
  const sh = shZero();
  shProjectCubeFaces(renderCube(env, size), size, sh);
  return sh;
}

/** Evenly spread unit directions, for "is this true everywhere" questions. */
function sphere(n: number): number[][] {
  const out: number[][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}

const _e = new Float32Array(3);
function irradianceAt(sh: SH9, d: number[]): Float32Array {
  shIrradiance(sh, d[0], d[1], d[2], _e);
  return _e;
}

// --- 1. the quadrature covers the sphere exactly -----------------------------
//
// Everything below rests on this. If the solid angles are wrong the constant
// environment comes out at the wrong level and every other number inherits the
// error, so it is checked first and against 4*pi rather than against anything
// the module computed.
//
// Watched to fail: dropping the fourth term of the inclusion-exclusion in
// cubeTexelSolidAngle took the sum to 9.424777961 sr against 12.566370614 and
// reddened this, both halves of block 2, the rotation check and the anchor.
// Restored: green.
{
  let total = 0;
  const step = 2 / FACE;
  for (let row = 0; row < FACE; row++) {
    for (let col = 0; col < FACE; col++) {
      const u0 = col * step - 1;
      const v0 = row * step - 1;
      total += cubeTexelSolidAngle(u0, u0 + step, v0, v0 + step);
    }
  }
  total *= CUBE_FACES;
  check("cube texels sum to 4 pi", Math.abs(total - 4 * Math.PI) < 1e-9,
    `${total.toFixed(9)} sr vs ${(4 * Math.PI).toFixed(9)}`);
}

// --- 2. a uniform environment ------------------------------------------------
//
// Irradiance under a constant radiance L is pi * L in every direction. That is
// the analytic answer, it is the single most useful thing to know about an SH
// irradiance pipeline, and getting it right requires the solid angles, the
// basis normalisation and the band convolution constants to ALL be right.
//
// Watched to fail, twice, and the two halves went red separately, which is the
// whole reason both are here:
//   * shBasis out[0] = K0 * (1 + 0.3 * y): spread 46.06507%, flatness red,
//     level red at 29.92519%.
//   * A0 = pi * 1.4: flatness stayed GREEN at 0.00012% and the level went red
//     at 40.00025%. A pipeline that is flat at the wrong level is exactly what
//     a wrong band constant produces, and only the second assertion sees it.
// Restored: green.
{
  const L = [0.37, 0.62, 1.13];
  const sh = project((_x, _y, _z, out) => {
    out[0] = L[0];
    out[1] = L[1];
    out[2] = L[2];
  });

  const lo = [Infinity, Infinity, Infinity];
  const hi = [0, 0, 0];
  let worstError = 0;
  for (const d of sphere(400)) {
    const e = irradianceAt(sh, d);
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], e[c]);
      hi[c] = Math.max(hi[c], e[c]);
      const expected = Math.PI * L[c];
      worstError = Math.max(worstError, Math.abs(e[c] - expected) / expected);
    }
  }
  // Two separate claims, measured two separate ways. Flatness compares the
  // sphere against itself and says nothing about the level; the level is
  // compared against pi * L, where pi comes from the language rather than from
  // the module. A pipeline can easily be flat at the wrong level, and a band
  // constant that is wrong is exactly that failure.
  let spread = 0;
  for (let c = 0; c < 3; c++) spread = Math.max(spread, (hi[c] - lo[c]) / hi[c]);
  check("uniform sky is flat", spread < 1e-4, `spread ${(spread * 100).toFixed(5)}%`);
  check("uniform sky is pi * L", worstError < 1e-4, `worst error ${(worstError * 100).toFixed(5)}%`);
}

// --- 3. one bright direction -------------------------------------------------
//
// A single lit texel is the hardest thing an L2 fit has to do, and it is what
// the sun-facing quarter of a sunset sky looks like. Two claims: the peak is
// where the light is, and the ringing never delivers negative light.
//
// The analytic reconstruction of a delta at d is 0.09375 + 0.5 t + 0.46875 t^2
// in t = cos(angle), which is 1.031 at t = 1, 0.0625 at t = -1 and dips to
// -0.040 at t = -0.53. So the ringing genuinely goes negative and the clamp in
// shIrradiance is what stops it subtracting from the sun term.
//
// Watched to fail, four ways:
//   * Removing the max() in shIrradiance: floor -0.093981147, "never negative"
//     and "the clamp is doing work" both red.
//   * Negating the linear band (AHAT[1..3] = -A1): the peak moved to the far
//     side, 0.148394 against 2.519826 elsewhere, and the far side came out at
//     17x the peak. Three of these five red.
//   * K4 wrong by 1.6x: the fall-off developed a 6.868682% uphill step while
//     every other assertion in the block stayed green.
//   * Replacing the single bright texel with a uniform environment: "facing
//     away is much dimmer" red at 0.5811 of peak and "the clamp is doing work"
//     red at zero, so this block cannot pass vacuously on an environment that
//     has no bright direction in it.
// Restored: green.
{
  const bright = 900;
  // One texel of face +Z, chosen by INDEX and the direction derived from it, so
  // the light really is where this block says it is. Asking for a direction and
  // rounding to the nearest texel puts the two a couple of degrees apart, which
  // is enough to make a fall-off measured against the wrong axis look ragged.
  const step = 2 / FACE;
  const col = 20;
  const row = 8;
  const target = new Float32Array(3);
  cubeFaceDirection(4, (col + 0.5) * step - 1, (row + 0.5) * step - 1, target);
  const d = [target[0], target[1], target[2]];

  const sh = shZero();
  const px = renderCube(() => {}, FACE);
  const p = ((4 * FACE + row) * FACE + col) * 4;
  px[p] = px[p + 1] = px[p + 2] = bright;
  shProjectCubeFaces(px, FACE, sh);

  const peak = irradianceAt(sh, d)[0];
  const away = irradianceAt(sh, [-d[0], -d[1], -d[2]])[0];

  let maxElsewhere = 0;
  let floor = Infinity;
  let zeros = 0;
  // Sorted by angle from the light, so the fall-off can be checked as a whole
  // rather than only at two points. A sign error anywhere in the linear band
  // moves the peak; a mangled quadratic band puts a bump in the middle.
  const byAngle: number[][] = [];
  for (const s of sphere(2000)) {
    const e = irradianceAt(sh, s)[0];
    floor = Math.min(floor, e);
    if (e === 0) zeros++;
    const t = s[0] * d[0] + s[1] * d[1] + s[2] * d[2];
    // Ten degrees of margin, so this is a real claim about where the peak is
    // and not a statement that the nearest sample point is slightly lower.
    if (t < 0.985) maxElsewhere = Math.max(maxElsewhere, e);
    // Only out to 120 degrees. The analytic form above turns back upward at
    // t = -0.53, which is the ringing itself and is not a defect: past that
    // point the clamp is what the surface actually sees.
    if (t >= -0.5) byAngle.push([t, e]);
  }
  byAngle.sort((p, q) => q[0] - p[0]);
  // The worst uphill step, as a fraction of the peak. Not zero: the basis is
  // evaluated in single precision, so two directions a thousandth of a degree
  // apart disagree in the last few bits.
  let worstRise = 0;
  for (let i = 1; i < byAngle.length; i++) {
    worstRise = Math.max(worstRise, (byAngle[i][1] - byAngle[i - 1][1]) / peak);
  }

  check("peak faces the light", peak > maxElsewhere && peak > 0,
    `${peak.toFixed(6)} vs ${maxElsewhere.toFixed(6)} beyond 10 deg`);
  check("irradiance falls off with angle", worstRise < 1e-4,
    `worst uphill step ${(worstRise * 100).toFixed(6)}% of peak`);
  check("facing away is much dimmer", away < 0.2 * peak,
    `${(away / peak).toFixed(4)} of peak`);
  check("irradiance is never negative", floor >= 0, `floor ${floor.toFixed(9)}`);
  check("the clamp is doing work", zeros > 0, `${zeros} of 2000 directions clamped`);
}

// --- 4. rotation -------------------------------------------------------------
//
// Rotating the sky and the surface together must not change how the surface is
// lit. This is what catches a typo in a basis polynomial, which nothing else
// here would: a per-band scale error survives rotation untouched, because the
// bands are rotation-invariant subspaces, so assertions 2 and 5 can both pass
// with a mangled Y(2,m).
//
// Watched to fail, twice:
//   * shBasis out[4] = K2 * x * x instead of K2 * x * y: worst disagreement
//     130.1361%.
//   * K4 wrong by 1.6x: worst disagreement 9.8529%, and the uniform-sky level,
//     the energy check and the fallback all stayed GREEN. That is the case
//     nothing else in this file can see.
// Restored: green.
{
  // Rodrigues about a deliberately un-axis-aligned axis, so a rotation that is
  // secretly a coordinate swap cannot pass.
  const ax = 0.3717;
  const ay = 0.8153;
  const az = -0.4443;
  const an = Math.hypot(ax, ay, az);
  const a = [ax / an, ay / an, az / an];
  const ang = 0.9273;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const rot = (v: number[], sign: number): number[] => {
    const ss = s * sign;
    const dot = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
    const cr = [
      a[1] * v[2] - a[2] * v[1],
      a[2] * v[0] - a[0] * v[2],
      a[0] * v[1] - a[1] * v[0],
    ];
    return [
      v[0] * c + cr[0] * ss + a[0] * dot * (1 - c),
      v[1] * c + cr[1] * ss + a[1] * dot * (1 - c),
      v[2] * c + cr[2] * ss + a[2] * dot * (1 - c),
    ];
  };

  // A smooth environment with a different shape in each channel, so a channel
  // that has been mixed up with another one shows.
  const env: Environment = (x, y, z, out) => {
    out[0] = 1.0 + 0.7 * x - 0.4 * y + 0.5 * z * z;
    out[1] = 0.6 + 0.3 * y + 0.8 * x * z;
    out[2] = 0.9 - 0.5 * z + 0.6 * x * y;
  };
  const still = project(env);
  const turned = project((x, y, z, out) => {
    const back = rot([x, y, z], -1);
    env(back[0], back[1], back[2], out);
  });

  let worst = 0;
  for (const n of sphere(400)) {
    const before = irradianceAt(still, n);
    const b = [before[0], before[1], before[2]];
    const after = irradianceAt(turned, rot(n, 1));
    for (let ch = 0; ch < 3; ch++) {
      worst = Math.max(worst, Math.abs(after[ch] - b[ch]) / Math.max(b[ch], 1e-6));
    }
  }
  check("rotating sky and normal agrees", worst < 2e-3, `worst ${(worst * 100).toFixed(4)}%`);
}

// --- 5. energy ---------------------------------------------------------------
//
// Twice the sky is twice the light. Trivially true of a linear pipeline, which
// is exactly why it is worth pinning: the temptation in a probe is to bake a
// normalisation or a floor into the evaluation, and either one breaks this.
//
// Watched to fail: a 0.01 floor added to the result of shIrradiance took the
// worst ratio error to 1.610489% and reddened this. Restored: green.
{
  const env: Environment = (x, y, z, out) => {
    out[0] = 0.2 + 0.5 * Math.max(0, y);
    out[1] = 0.3 + 0.4 * Math.max(0, x);
    out[2] = 0.1 + 0.9 * Math.max(0, -z);
  };
  const single = project(env);
  const double = project((x, y, z, out) => {
    env(x, y, z, out);
    out[0] *= 2;
    out[1] *= 2;
    out[2] *= 2;
  });

  let worst = 0;
  for (const n of sphere(300)) {
    const one = irradianceAt(single, n);
    const a = [one[0], one[1], one[2]];
    const two = irradianceAt(double, n);
    for (let ch = 0; ch < 3; ch++) {
      if (a[ch] < 1e-6) continue;
      worst = Math.max(worst, Math.abs(two[ch] - 2 * a[ch]) / (2 * a[ch]));
    }
  }
  check("doubling the sky doubles the light", worst < 1e-5, `worst ${(worst * 100).toFixed(6)}%`);
}

// --- 6. the fallback ---------------------------------------------------------
//
// shHemispherical is what the uniforms hold before the first capture and what
// stands in when the sky is too dark to normalise against, which is most of the
// night. It has to reproduce the hemispherical ambient the shaders ran before
// the probe existed, EXACTLY, or the safe path is its own visual change.
//
// Watched to fail: putting the linear coefficient at index 2 (the z term)
// instead of index 1 (the y term) took the worst error to 3.18e-1, the full
// slope, and reddened this alone. That is the mistake worth catching, because a
// probe that works makes the fallback almost never run. Restored: green.
{
  const colour = [0.28, 0.36, 0.5];
  const base = 0.55;
  const slope = 0.45;
  const sh = shHemispherical(colour, base, slope);
  let worst = 0;
  for (const n of sphere(400)) {
    const e = irradianceAt(sh, n);
    for (let ch = 0; ch < 3; ch++) {
      const expected = colour[ch] * (base + slope * n[1]);
      worst = Math.max(worst, Math.abs(e[ch] - expected));
    }
  }
  check("hemispherical fallback is exact", worst < 1e-6, `worst ${worst.toExponential(2)}`);
}

// --- 7. the anchor -----------------------------------------------------------
//
// The probe supplies shape and the scene's lighting model supplies level, which
// only holds if normalising actually lands on the level it was given. The
// second half is the guard that keeps a black sky from being scaled up into
// something enormous.
//
// Watched to fail:
//   * A 0.01 floor inside shIrradiance: the anchor missed by 9.05e-3 and the
//     black sky was scaled anyway. Both red.
//   * Dropping the floor test from shNormaliseAt and keeping only the
//     is-it-finite test: the black sky was still refused (dividing by zero is
//     not finite) and the near-black sky was scaled to 1.10e-1, 1e8 times what
//     it was. Only the last assertion went red, which is why it is separate.
{
  const sh = project((x, y, z, out) => {
    const up = Math.max(0, y);
    out[0] = 0.1 + 0.4 * up;
    out[1] = 0.2 + 0.5 * up;
    out[2] = 0.4 + 0.9 * up;
  });
  const target = [0.11, 0.19, 0.31];
  const ok = shNormaliseAt(sh, 0, 1, 0, target, 1e-5);
  const at = irradianceAt(sh, [0, 1, 0]);
  let worst = 0;
  for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(at[ch] - target[ch]));
  check("normalising hits the anchor", ok && worst < 1e-6, `worst ${worst.toExponential(2)}`);

  const dark = shZero();
  const refusedBlack = !shNormaliseAt(dark, 0, 1, 0, target, 1e-5);
  let finite = true;
  for (let i = 0; i < SH_COEFF_COUNT * 3; i++) finite &&= Number.isFinite(dark[i]);
  check("a black sky is refused", refusedBlack && finite,
    refusedBlack ? "left alone" : "scaled anyway");

  // Not the same test. A black sky is caught by the division alone; a sky that
  // is merely a billionth as bright as the target divides perfectly well and
  // comes back scaled up by 1e8, which is the actual night failure mode and is
  // what the floor is for.
  const dim = project((_x, _y, _z, out) => {
    out[0] = out[1] = out[2] = 1e-9;
  });
  const refusedDim = !shNormaliseAt(dim, 0, 1, 0, target, 1e-5);
  const grew = irradianceAt(dim, [0, 1, 0])[0];
  check("a near-black sky is refused", refusedDim && grew < 1e-6,
    refusedDim ? `left at ${grew.toExponential(2)}` : `scaled to ${grew.toExponential(2)}`);
}

console.log(failures === 0 ? "\nall sh checks ok" : `\n${failures} sh check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
