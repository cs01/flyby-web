// Gates the exposure, because "it looks washed out" is not a thing you can
// bisect and "1.3 stops hot" is.
//
// This reproduces the terrain shader's path for a horizontal surface: direct
// beam, sky ambient, the ACES curve with its 0.6 pre-scale, and the sRGB
// encode. It is a MODEL of the shader, not the shader, so it can drift; the
// constants it reads come from lighting.ts so the two cannot disagree about
// exposure, which is the number this exists to protect.

import { DAY_EXPOSURE_FOR_TEST, AMBIENT_SCALE_FOR_TEST } from "../src/render/lighting";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

const aces = (x: number): number => {
  x *= 0.6;
  return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
};
const toSRGB = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

const SUN_SURFACE = 0.105;
const SUN_INTENSITY = 26;
const SUN_T = 0.9;
const CLEAR_AMB = (0.26 + 0.38 + 0.58) / 3;

function horizontal(albedo: number, sunElevDeg: number, exposure: number) {
  const ndl = Math.sin((sunElevDeg * Math.PI) / 180);
  const direct = SUN_INTENSITY * SUN_SURFACE * SUN_T * ndl;
  const ambient = CLEAR_AMB * AMBIENT_SCALE_FOR_TEST;
  const lit = albedo * (direct + ambient);
  return {
    srgb: Math.round(255 * toSRGB(aces(lit * exposure))),
    sunToSky: direct / ambient,
  };
}

// The assertion that catches the actual bug. Middle grey is sRGB 118; before
// this gate the same surface presented at ~163-181 depending on sun angle,
// which is where "San Francisco looks covered in snow" came from.
for (const elev of [45, 60, 75]) {
  const r = horizontal(0.18, elev, DAY_EXPOSURE_FOR_TEST);
  check(
    `18% grey at ${elev} deg sits near middle grey`,
    r.srgb >= 100 && r.srgb <= 135,
    `sRGB ${r.srgb} (want 100..135)`,
  );
}

// A white roof must still have somewhere to go. If 18% grey is correct but 80%
// white already clips, the curve is being used as a wall rather than a curve.
const white = horizontal(0.8, 60, DAY_EXPOSURE_FOR_TEST);
check("an 80% white roof does not clip", white.srgb < 252, `sRGB ${white.srgb}`);

// Dark surfaces must stay separable from black, or every shadowed roof reads
// as a hole.
const dark = horizontal(0.05, 60, DAY_EXPOSURE_FOR_TEST);
check("a 5% dark surface is not crushed", dark.srgb > 20, `sRGB ${dark.srgb}`);

// The scene ratio itself is NOT what was wrong, and this records that so a
// future reader does not "fix" the contrast by moving the ambient.
const ratio = horizontal(0.18, 60, DAY_EXPOSURE_FOR_TEST).sunToSky;
check(
  "sun:sky on a horizontal is a clear-day ratio",
  ratio >= 4 && ratio <= 20,
  `${ratio.toFixed(1)}:1`,
);

// Ordering: brighter albedo must present brighter, at every sun angle. A curve
// that inverted anywhere would be a real defect and is cheap to rule out.
let monotonic = true;
for (const elev of [30, 60, 80]) {
  let prev = -1;
  for (const a of [0.03, 0.08, 0.18, 0.35, 0.6, 0.9]) {
    const v = horizontal(a, elev, DAY_EXPOSURE_FOR_TEST).srgb;
    if (v < prev) monotonic = false;
    prev = v;
  }
}
check("brighter albedo always presents brighter", monotonic, "across 3 sun angles");

// VACUITY PROBE: the grey-card bound must reject the value it was written to
// catch. If this passes, the bound is too loose to be a gate.
const wasHot = horizontal(0.18, 60, 1.0).srgb;
check(
  "the bound rejects the old exposure",
  !(wasHot >= 100 && wasHot <= 135),
  `old exposure presented sRGB ${wasHot}, outside 100..135 as it must be`,
);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(48)} ${r.detail}`);
}
console.log(
  failed === 0
    ? `\nall ${results.length} lighting checks ok`
    : `\n${failed} of ${results.length} lighting checks FAILED`,
);
if (failed) process.exit(1);
