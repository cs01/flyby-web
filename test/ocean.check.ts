// The gate on the FFT ocean's pure half (src/render/oceanspectrum.ts): the
// spectrum, the CPU mirror of the GPU FFT, the Jacobian and the foam threshold.
//
// The GPU passes in render/ocean.ts are these functions transcribed, so what
// can go wrong there silently (an FFT index off by one still draws something
// wave-like; a spectrum normalised wrong draws a millpond or a cliff) is
// caught here, where it can be measured.
//
// Bounds are literals, never read back from the module under test, and every
// block carries a VACUITY PROBE: the same predicate fed a case it must reject,
// asserted to reject it. A gate that cannot go red is not a gate.

import {
  OCEAN_FETCH_REF_M,
  PHASE_PERIOD_S,
  cascadeBands,
  cascadeGaussians,
  cascadeStats,
  foamAt,
  foamThreshold,
  ifft,
  jacobianField,
  simulateCascade,
  whitecapCoverage,
  writeH0,
  type FoamThreshold,
  type OceanCascadePlan,
} from "../src/render/oceanspectrum";
import { budgetForTier, type DeviceDescriptor } from "../src/render/budget";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${detail}`);
  if (!ok) failures++;
}

const DESKTOP: DeviceDescriptor = {
  coarsePointer: false, deviceMemoryGb: 8, maxTextureSize: 16384,
  drawingBufferWidth: 2560, drawingBufferHeight: 1440,
} as DeviceDescriptor;
const PHONE: DeviceDescriptor = {
  coarsePointer: true, deviceMemoryGb: 4, maxTextureSize: 4096,
  drawingBufferWidth: 1170, drawingBufferHeight: 2532,
} as DeviceDescriptor;
const FULL = budgetForTier("full", DESKTOP).ocean;
const REDUCED = budgetForTier("reduced", PHONE).ocean;

// Wind along +x, the convention does not matter to any statistic below.
const WX = 1;
const WZ = 0;

// --- the FFT ------------------------------------------------------------------

{
  const n = 16;
  const re = Array.from({ length: n }, (_, i) => Math.sin(i * 1.7) + 0.3 * i);
  const im = Array.from({ length: n }, (_, i) => Math.cos(i * 0.9) - 0.1 * i);
  const naive = (x: number): [number, number] => {
    let r = 0, s = 0;
    for (let m = 0; m < n; m++) {
      const a = (2 * Math.PI * m * x) / n;
      r += re[m] * Math.cos(a) - im[m] * Math.sin(a);
      s += re[m] * Math.sin(a) + im[m] * Math.cos(a);
    }
    return [r, s];
  };
  const data = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { data[2 * i] = re[i]; data[2 * i + 1] = im[i]; }
  const out = ifft(data, n);
  let err = 0;
  for (let x = 0; x < n; x++) {
    const [r, s] = naive(x);
    err = Math.max(err, Math.abs(out[2 * x] - r), Math.abs(out[2 * x + 1] - s));
  }
  check("Stockham passes equal a direct inverse DFT", err < 1e-9, `max err ${err.toExponential(2)}`);
  // Probe: the same comparison against a shifted input must fail.
  const shifted = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { shifted[2 * i] = re[(i + 1) % n]; shifted[2 * i + 1] = im[(i + 1) % n]; }
  const bad = ifft(shifted, n);
  let errBad = 0;
  for (let x = 0; x < n; x++) errBad = Math.max(errBad, Math.abs(bad[2 * x] - naive(x)[0]));
  check("probe: the comparison rejects a permuted input", errBad > 1e-3, `max err ${errBad.toFixed(3)}`);
}

// --- the bands ----------------------------------------------------------------

for (const [name, plan] of [["full", FULL], ["reduced", REDUCED]] as const) {
  const b = cascadeBands(plan.cascades);
  let ok = b.length === plan.cascades.length;
  for (let i = 0; i < b.length; i++) {
    ok &&= b[i].lamLo < b[i].lamHi;
    if (i > 0) ok &&= b[i].lamHi === b[i - 1].lamLo;
    // Never finer than 4 texels a wavelength: below that it is aliasing.
    ok &&= b[i].lamLo >= 4 * plan.cascades[i].patchM / plan.cascades[i].n - 1e-9;
  }
  check(`${name}: cascade bands contiguous, disjoint, above Nyquist`, ok,
    b.map((x) => `[${x.lamLo.toFixed(2)}, ${x.lamHi.toFixed(0)}) m`).join(" "));
}
check("reduced tier runs ONE cascade of at most 128", REDUCED.cascades.length === 1 && REDUCED.cascades[0].n <= 128,
  `${REDUCED.cascades.length} x ${REDUCED.cascades[0].n}`);
{
  const items = budgetForTier("reduced", PHONE).memory.items;
  const it = items.find((i) => i.what.startsWith("ocean"));
  check("the memory estimate carries the ocean", !!it && it.bytes > 100_000 && it.bytes < 8 * 1048576,
    it ? `${it.what}: ${(it.bytes / 1048576).toFixed(2)} MB` : "missing");
}

// --- energy against wind ------------------------------------------------------

const totalStats = (plan: OceanCascadePlan[], U: number): { hv: number; sv: number } => {
  const bands = cascadeBands(plan);
  let hv = 0, sv = 0;
  plan.forEach((c, i) => {
    const s = cascadeStats(c, bands[i], U, WX, WZ);
    hv += s.heightVar;
    sv += s.slopeVar;
  });
  return { hv, sv };
};
const increasing = (v: number[]): boolean => v.every((x, i) => i === 0 || x > v[i - 1]);
{
  const winds = [2, 4, 6, 8, 10, 12, 15, 18, 22];
  for (const [name, plan] of [["full", FULL], ["reduced", REDUCED]] as const) {
    const st = winds.map((U) => totalStats(plan.cascades, U));
    const hs = st.map((s) => 4 * Math.sqrt(s.hv));
    check(`${name}: wave height rises with wind`, increasing(hs),
      winds.map((U, i) => `${U}:${hs[i].toFixed(2)}`).join(" "));
    check(`${name}: slope rises with wind`, increasing(st.map((s) => s.sv)),
      `rms ${Math.sqrt(st[0].sv).toFixed(3)} at 2 m/s, ${Math.sqrt(st[st.length - 1].sv).toFixed(3)} at 22`);
    // A Beaufort 6 bay chop is half a metre to a metre and a half, not a
    // millpond and not a storm.
    const hs11 = 4 * Math.sqrt(totalStats(plan.cascades, 11).hv);
    check(`${name}: Hs at 11 m/s is a bay chop`, hs11 > 0.35 && hs11 < 2.0, `${hs11.toFixed(2)} m`);
    check("probe: the monotone predicate rejects a reversed series", !increasing(hs.slice().reverse()), "");
  }
}

// --- the simulated field ------------------------------------------------------

function field(c: OceanCascadePlan, bandIndex: number, plan: OceanCascadePlan[], U: number, t: number, zero = false) {
  const b = cascadeBands(plan)[bandIndex];
  const h0 = new Float32Array(c.n * c.n * 4);
  if (!zero) writeH0(c, b, cascadeGaussians(c.n, 0x51ed270b + bandIndex * 0x9e3779b1), U, WX, WZ, OCEAN_FETCH_REF_M, h0, 0, c.n);
  return { f: simulateCascade(c, h0, 0, c.n, t), stats: cascadeStats(c, b, U, WX, WZ) };
}
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

{
  const c = FULL.cascades[0];
  const { f, stats } = field(c, 0, FULL.cascades, 11, 3.7);
  const ratio = rms(f.dy) / Math.sqrt(stats.heightVar);
  // The vacuity probe the GPU path leans on: a displacement that is zero (an
  // h0 never written, an FFT that lost its input) fails this.
  const nonzero = (r: number) => r > 0.6 && r < 1.4;
  check("displacement rms matches the spectrum's variance", nonzero(ratio),
    `rms ${rms(f.dy).toFixed(3)} m vs expected ${Math.sqrt(stats.heightVar).toFixed(3)} (x${ratio.toFixed(2)})`);
  check("horizontal displacement is there too (the chop)", rms(f.dx) > 0.3 * rms(f.dy), `rms dx ${rms(f.dx).toFixed(3)} m`);
  const z = field(c, 0, FULL.cascades, 11, 3.7, true);
  check("probe: a zero h0 fails the displacement check", !nonzero(rms(z.f.dy) / Math.sqrt(stats.heightVar)),
    `rms ${rms(z.f.dy).toFixed(4)}`);

  // Time: the sea moves, and repeats on the phase clock (which is what lets the
  // GPU take the clock mod the period).
  const later = field(c, 0, FULL.cascades, 11, 3.7 + 1).f;
  const wrapped = field(c, 0, FULL.cascades, 11, 3.7 + PHASE_PERIOD_S).f;
  let moved = 0, rep = 0;
  for (let i = 0; i < f.dy.length; i++) {
    moved = Math.max(moved, Math.abs(later.dy[i] - f.dy[i]));
    rep = Math.max(rep, Math.abs(wrapped.dy[i] - f.dy[i]));
  }
  check("the sea moves in a second and repeats on the phase clock", moved > 0.05 && rep < 1e-4,
    `moved ${moved.toFixed(3)} m, period err ${rep.toExponential(1)}`);
}

// --- foam ---------------------------------------------------------------------

{
  for (const [name, plan] of [["full", FULL], ["reduced", REDUCED]] as const) {
    // Every cascade foams on its own Jacobian (the GPU takes the max), so
    // every cascade is held to the coverage.
    plan.cascades.forEach((c, ci) => {
      const tag = `${name} ${c.patchM} m`;
      const winds = [4, 8, 11, 15, 20];
      const cover = (thOf: (U: number, sv: number) => FoamThreshold) => winds.map((U) => {
        const { f, stats } = field(c, ci, plan.cascades, U, 1.3);
        const J = jacobianField(f);
        const th = thOf(U, stats.slopeVar);
        let s = 0;
        for (const j of J) s += foamAt(j, th);
        return s / J.length;
      });
      const cv = cover(foamThreshold);
      check(`${tag}: foam coverage rises with wind`, increasing(cv.slice(1)) && cv[0] <= cv[1],
        winds.map((U, i) => `${U}:${(cv[i] * 100).toFixed(2)}%`).join(" "));
      // Beaufort 3 is "scattered whitecaps": some, well under a percent.
      check(`${tag}: a gentle breeze foams scattered crests only`, cv[0] < 0.01, `${(cv[0] * 100).toFixed(3)}% at 4 m/s`);
      const target = whitecapCoverage(15);
      check(`${tag}: coverage at 15 m/s near the Monahan target`, cv[3] > target / 3 && cv[3] < target * 3,
        `${(cv[3] * 100).toFixed(2)}% vs ${(target * 100).toFixed(2)}%`);
      const flat = cover(() => ({ jth: -10, soft: 0.1 }));
      check("probe: an unreachable threshold fails the rise", !increasing(flat.slice(1)), flat.map((x) => x.toFixed(3)).join(" "));
    });
  }
}

console.log(failures === 0 ? "\nall ocean checks ok" : `\n${failures} ocean check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
