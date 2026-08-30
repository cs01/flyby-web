// The gate on facades: that lit windows CLUSTER, that buildings are made of
// more than one thing, and that both are the same on every run.
//
// None of this is a screenshot test. What a city looks like is not assertable,
// but the structure underneath the look is, and the structure is what was
// actually wrong:
//
//   * Lit windows were hashed per cell, independently. That is IID noise, and
//     IID noise on a grid is a checkerboard -- which is exactly what a night
//     render of Chicago looked like. The fix is correlation, and correlation
//     is measurable: the mean RUN of lit cells along a floor and up a column
//     has to beat what the same density would give if the cells were
//     independent.
//
//   * Every building had one material. Dozens of identical facades in one
//     frame reads as fake faster than any lighting error does.
//
// The IID expectation is DERIVED from the occupancy measured in the same grid,
// not written down: a threshold copied out of the thing it is checking moves
// its own goalposts and can never fail. The constants themselves are checked
// against literals instead, further down.
//
// Watched to fail; see the notes on each block.

import { readdirSync } from "node:fs";
import { packFacadeBytes, FACADE_TEX_WIDTH } from "../src/render/buildings";
import { parseCityPack, BuildingKind } from "../src/data/citypack";
import {
  CORE_PERIOD_MAX,
  CORE_PERIOD_MIN,
  FACADE_BYTE_TEXELS,
  FACADE_ENCODE_MAX,
  FACADE_FLOATS,
  FACADE_GLSL,
  decodeFacadeValue,
  encodeFacadeValue,
  FAMILY_COUNT,
  FAMILY_NAMES,
  FacadeFamily,
  facadeFor,
  hash3,
  hourFactorFor,
  hourFactors,
  isLit,
  meanOccupancy,
  packFacade,
  type FacadeParams,
} from "../src/render/facade";

const DIR = "public/cities";
let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(38)} ${detail}`);
  if (!ok) failures++;
}

async function pack(name: string) {
  return parseCityPack(await Bun.file(`${DIR}/${name}.city`).arrayBuffer());
}

// --- 1. lit windows cluster --------------------------------------------------

const COLS = 28;
const FLOORS = 44;

interface RunStats {
  occupancy: number;
  /** Mean length of the run a randomly chosen LIT cell belongs to. */
  across: number;
  up: number;
  /** What that would be at the same occupancy if the cells were independent. */
  iid: number;
}

/**
 * Runs are measured CELL-weighted, not run-weighted: the question the eye is
 * asking is "is the window I am looking at part of a long run", not "how long
 * is the average run". The two differ a lot, because a facade with a few
 * full-height cores and a scatter of singles has a short average run and yet
 * most of its lit area is in the cores.
 *
 * Cell-weighted mean is sum(len^2) / sum(len).
 */
class Runs {
  private sumLen = 0;
  private sumSq = 0;
  add(len: number): void {
    this.sumLen += len;
    this.sumSq += len * len;
  }
  get mean(): number {
    return this.sumLen > 0 ? this.sumSq / this.sumLen : 0;
  }
}

/**
 * Mean run length of lit cells along floors and up columns, over a sample of
 * real buildings.
 *
 * Runs that touch the edge of the sampled grid are still counted at their
 * truncated length. That is the conservative direction: truncation can only
 * make the measured run SHORTER, so a pass is never an artefact of the window.
 */
function runStats(sample: FacadeParams[], hour: number): RunStats {
  let lit = 0;
  let cells = 0;
  const across = new Runs();
  const up = new Runs();

  for (const p of sample) {
    const hf = hourFactorFor(hourFactors(hour), p.group);
    const grid: boolean[][] = [];
    for (let c = 0; c < COLS; c++) {
      grid[c] = [];
      for (let f = 0; f < FLOORS; f++) {
        const on = isLit(p, c, f, hf);
        grid[c][f] = on;
        cells++;
        if (on) lit++;
      }
    }
    for (let f = 0; f < FLOORS; f++) {
      let run = 0;
      for (let c = 0; c < COLS; c++) {
        if (grid[c][f]) run++;
        else if (run) { across.add(run); run = 0; }
      }
      if (run) across.add(run);
    }
    for (let c = 0; c < COLS; c++) {
      let run = 0;
      for (let f = 0; f < FLOORS; f++) {
        if (grid[c][f]) run++;
        else if (run) { up.add(run); run = 0; }
      }
      if (run) up.add(run);
    }
  }

  const occupancy = lit / cells;
  return {
    occupancy,
    across: across.mean,
    up: up.mean,
    // A Bernoulli(p) sequence's lit runs are geometric with P(L=k) =
    // p^(k-1)(1-p), so E[L] = 1/(1-p), E[L^2] = (1+p)/(1-p)^2, and the
    // cell-weighted mean E[L^2]/E[L] is (1+p)/(1-p).
    //
    // DERIVED, from the occupancy this very grid came out at. A number copied
    // out of the model being tested would move whenever the model did and the
    // assertion could never fail.
    iid: (1 + occupancy) / (1 - occupancy),
  };
}

/** How much better than independent the runs have to be. */
const CLUSTER_MARGIN = 1.6;

for (const city of ["manhattan", "chicago"]) {
  const p = await pack(city);
  // Every 400th building: a few hundred facades of every kind and height the
  // city actually contains, rather than a hand-picked set.
  const sample: FacadeParams[] = [];
  for (let i = 0; i < p.buildings.length; i += 400) {
    const b = p.buildings[i];
    sample.push(facadeFor(b.kind, b.topM - b.baseM, i));
  }

  for (const hour of [20, 23, 2]) {
    const s = runStats(sample, hour);
    check(
      `${city} @${String(hour).padStart(2, "0")}:00 runs along a floor`,
      s.across > s.iid * CLUSTER_MARGIN,
      `${s.across.toFixed(2)} vs iid ${s.iid.toFixed(2)} at occupancy ` +
      `${(100 * s.occupancy).toFixed(1)}% (want >${(s.iid * CLUSTER_MARGIN).toFixed(2)})`,
    );
    check(
      `${city} @${String(hour).padStart(2, "0")}:00 runs up a column`,
      s.up > s.iid * CLUSTER_MARGIN,
      `${s.up.toFixed(2)} vs iid ${s.iid.toFixed(2)} (want >${(s.iid * CLUSTER_MARGIN).toFixed(2)})`,
    );
  }
}

/**
 * The shader has to be running the same rule.
 *
 * `isLit` above is the reference, but the decision is per-fragment and the
 * fragment shader cannot call it, so facade.ts carries a GLSL transcription.
 * The statistical checks cannot see that copy. This one can: it asserts the
 * shader still gates on the floor, on the tenancy block and on the service
 * core, which is precisely what would go missing if someone put a plain
 * per-cell hash back.
 */
{
  // The BODY of facadeLit, not the whole of FACADE_GLSL. Watched to fail:
  // deleting the tenancy gate from facadeLit and searching the whole string
  // still passed, because facadeMeanOccupancy mentions p.pTenant too. A gate
  // that matches the right words in the wrong function is not a gate.
  const from = FACADE_GLSL.indexOf("float facadeLit(");
  const to = FACADE_GLSL.indexOf("float facadeMeanOccupancy(");
  const body = from >= 0 && to > from ? FACADE_GLSL.slice(from, to) : "";
  check("facadeLit is in the shader", body.length > 200, `${body.length} chars`);
  for (const term of ["p.pFloor", "p.pTenant", "p.pCore", "p.coreSlot", "p.tenantW", "p.tenantH"]) {
    check(`facadeLit gates on ${term}`, body.includes(term), "in the GLSL body");
  }
}

// --- 2. material variety -----------------------------------------------------

/** No single facade family may dominate a real city. */
const MAX_FAMILY_SHARE = 0.60;
/** A family under this share is not really in use. */
const MIN_FAMILY_SHARE = 0.03;
const MIN_FAMILIES_IN_USE = 4;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".city")).sort()) {
  const city = file.replace(".city", "");
  // Only the two the brief names are gated hard; the rest are printed so a
  // regression that only shows up in Paris is at least visible.
  const gated = city === "manhattan" || city === "chicago";
  const p = await pack(city);

  const counts = new Array<number>(FAMILY_COUNT).fill(0);
  const glassByKind = new Map<number, { sum: number; n: number }>();
  for (let i = 0; i < p.buildings.length; i++) {
    const b = p.buildings[i];
    const f = facadeFor(b.kind, b.topM - b.baseM, i);
    counts[f.family]++;
    let g = glassByKind.get(b.kind);
    if (!g) { g = { sum: 0, n: 0 }; glassByKind.set(b.kind, g); }
    g.sum += f.glassFrac;
    g.n++;
  }

  const total = p.buildings.length;
  const shares = counts.map((c) => c / total);
  const inUse = shares.filter((s) => s >= MIN_FAMILY_SHARE).length;
  const biggest = Math.max(...shares);
  const spread = shares.map((s, i) => `${FAMILY_NAMES[i]} ${(100 * s).toFixed(0)}%`).join(" ");

  const mean = (kind: number): number => {
    const g = glassByKind.get(kind);
    return g && g.n > 0 ? g.sum / g.n : 0;
  };
  const office = Math.max(mean(BuildingKind.Tower), mean(BuildingKind.Commercial));
  const home = mean(BuildingKind.Residential);

  if (gated) {
    check(`${city} families in use`, inUse >= MIN_FAMILIES_IN_USE, `${inUse} of 5: ${spread}`);
    check(`${city} no family dominates`, biggest <= MAX_FAMILY_SHARE,
      `largest ${(100 * biggest).toFixed(0)}% (want <=${100 * MAX_FAMILY_SHARE}%)`);
    check(`${city} towers glassier than homes`, office > home * 1.5,
      `tower/commercial ${office.toFixed(2)} vs residential ${home.toFixed(2)}`);
  } else {
    console.log(`     ${city.padEnd(38)} ${spread}`);
  }
}

// --- 3. determinism ----------------------------------------------------------

// A golden value for the hash itself. Everything downstream is a function of
// it, so if this moves, every facade in every screenshot moved with it -- which
// is worth knowing deliberately rather than discovering in a diff.
check("hash3 is pinned", Math.abs(hash3(12345, 678, 90) - 0.48969510104507208) < 1e-15,
  hash3(12345, 678, 90).toPrecision(17));

{
  const a = facadeFor(BuildingKind.Tower, 180, 4242);
  const b = facadeFor(BuildingKind.Tower, 180, 4242);
  check("facadeFor is a pure function", JSON.stringify(a) === JSON.stringify(b), "same seed, same params");

  const bufA = new Float32Array(FACADE_FLOATS);
  const bufB = new Float32Array(FACADE_FLOATS);
  packFacade(a, bufA, 0);
  packFacade(b, bufB, 0);
  check("packFacade is stable", bufA.every((v, i) => v === bufB[i]), `${FACADE_FLOATS} floats`);
  check("packFacade fills every slot", bufA.every((v) => Number.isFinite(v)), "no NaN, no holes");
}

{
  // Order independence: building 7's facade must not depend on whether
  // building 6 was asked for first. Anything with hidden state fails here.
  const forward = [1, 2, 3, 4, 5].map((i) => JSON.stringify(facadeFor(i % 7, 10 * i, i)));
  const backward = [5, 4, 3, 2, 1].map((i) => JSON.stringify(facadeFor(i % 7, 10 * i, i))).reverse();
  check("facadeFor has no hidden state", forward.join("|") === backward.join("|"), "5 seeds either way");
}

// --- 4. occupancy stays in range ---------------------------------------------

// Literals, not derived: at no hour of any night may a kind of building be
// entirely dark or entirely lit.
const OCC_MIN = 0.01;
const OCC_MAX = 0.70;

{
  let worstLow = 1;
  let worstHigh = 0;
  let where = "";
  for (let kind = 0; kind <= 6; kind++) {
    for (const heightM of [8, 20, 45, 120, 300]) {
      for (let seed = 0; seed < 400; seed++) {
        const p = facadeFor(kind, heightM, seed * 137 + kind);
        for (let hour = 16; hour <= 30; hour++) {
          const hf = hourFactorFor(hourFactors(hour % 24), p.group);
          for (const fade of [1, 0.55]) {
            const occ = meanOccupancy(p, hf, fade);
            if (occ < worstLow) { worstLow = occ; where = `${BuildingKind[kind]} ${heightM}m @${hour % 24}:00`; }
            if (occ > worstHigh) worstHigh = occ;
          }
        }
      }
    }
  }
  check("night occupancy never dies", worstLow >= OCC_MIN, `min ${worstLow.toFixed(3)} (${where})`);
  check("night occupancy never saturates", worstHigh <= OCC_MAX, `max ${worstHigh.toFixed(3)}`);
}

{
  let bad = "";
  for (let hour = 0; hour < 24; hour++) {
    const f = hourFactors(hour);
    for (const [name, v] of [["residential", f.residential], ["office", f.office], ["other", f.other]] as const) {
      if (!(v > 0 && v <= 1)) bad = `${name} @${hour}:00 = ${v}`;
    }
  }
  check("hour factors stay in (0,1]", bad === "", bad || "24 hours x 3 groups");

  const night = hourFactors(4);
  const evening = hourFactors(20);
  check("offices empty overnight", night.office < evening.office * 0.5,
    `04:00 ${night.office.toFixed(2)} vs 20:00 ${evening.office.toFixed(2)}`);
  check("homes stay busier than offices", night.residential > night.office,
    `04:00 homes ${night.residential.toFixed(2)} vs offices ${night.office.toFixed(2)}`);
}

// --- 5. the constants themselves ---------------------------------------------
//
// Bounds from LITERALS. The clustering check above compares a measurement
// against a measurement, which is right for what it tests but means the
// magnitudes underneath it are unconstrained; these pin them.

check("core period is bounded", CORE_PERIOD_MIN >= 6 && CORE_PERIOD_MAX <= 20 && CORE_PERIOD_MIN < CORE_PERIOD_MAX,
  `${CORE_PERIOD_MIN}..${CORE_PERIOD_MAX}`);

{
  let officeTenantW = { min: 99, max: 0 };
  let homeTenantW = { min: 99, max: 0 };
  let worstStorey = { min: 99, max: 0 };
  for (let seed = 0; seed < 4000; seed++) {
    const office = facadeFor(BuildingKind.Tower, 140, seed);
    const home = facadeFor(BuildingKind.Residential, 14, seed);
    officeTenantW = { min: Math.min(officeTenantW.min, office.tenantW), max: Math.max(officeTenantW.max, office.tenantW) };
    homeTenantW = { min: Math.min(homeTenantW.min, home.tenantW), max: Math.max(homeTenantW.max, home.tenantW) };
    for (const p of [office, home]) {
      worstStorey = { min: Math.min(worstStorey.min, p.storeyM), max: Math.max(worstStorey.max, p.storeyM) };
    }
  }
  // A tenancy one column wide IS the per-cell hash the old code had, so this is
  // the constant the clustering assertion depends on most directly.
  check("office tenancies span columns", officeTenantW.min >= 2,
    `${officeTenantW.min}..${officeTenantW.max} columns`);
  check("home tenancies are small", homeTenantW.max <= 4,
    `${homeTenantW.min}..${homeTenantW.max} columns`);
  // Storey height is what sets the apparent SIZE of a building. Anything
  // outside this is not a storey.
  check("storey heights are believable", worstStorey.min >= 2.4 && worstStorey.max <= 5.0,
    `${worstStorey.min.toFixed(2)}..${worstStorey.max.toFixed(2)} m`);
}

{
  // Glass is a curtain wall and stone is not, whatever the seed does.
  let glassWorst = 1;
  let brickWorst = 0;
  for (let seed = 0; seed < 4000; seed++) {
    const t = facadeFor(BuildingKind.Tower, 200, seed);
    if (t.family === FacadeFamily.Glass) glassWorst = Math.min(glassWorst, t.glassFrac);
    const r = facadeFor(BuildingKind.Residential, 12, seed);
    if (r.family === FacadeFamily.Brick) brickWorst = Math.max(brickWorst, r.glassFrac);
  }
  check("curtain walls are mostly glass", glassWorst >= 0.6, `worst ${glassWorst.toFixed(2)}`);
  check("brick walls are mostly wall", brickWorst <= 0.4, `worst ${brickWorst.toFixed(2)}`);
}

// --- fixed-point round-trip ------------------------------------------------
//
// The parameter table is RGBA8 with two bytes per value, because an Android
// device returned all zeros from the same table as fp32 AND as fp16 while
// reading every ordinary texture correctly. Fixed point in a byte texture is
// the format a photograph uses and nothing refuses to sample it.
//
// What has to hold: the round trip is accurate enough that no facade visibly
// changes, and EXACT on the packed integer field, because the shader recovers
// group and family with a floor and a subtraction.
{
  let worstAbs = 0;
  let worstRel = 0;
  let intFailures = 0;
  let overRange = 0;
  const out = new Float32Array(FACADE_FLOATS);
  for (let seed = 0; seed < 4000; seed++) {
    packFacade(facadeFor(seed % 7, 3 + (seed % 300), seed), out, 0);
    for (let i = 0; i < FACADE_FLOATS; i++) {
      const v = out[i];
      if (v > FACADE_ENCODE_MAX || v < 0) overRange++;
      const [lo, hi] = encodeFacadeValue(v);
      const r = decodeFacadeValue(lo, hi);
      worstAbs = Math.max(worstAbs, Math.abs(r - v));
      // Fixed point has uniform ABSOLUTE error by construction (half a quantum,
      // 2.44e-4), so relative error necessarily grows without bound as the
      // value approaches zero. That is the opposite of fp16, which this
      // replaced, and it means the absolute bound below is the real invariant.
      // The relative bound is kept only where it is meaningful: above 0.05 it
      // still catches a scale or endianness mistake, which absolute error
      // alone would not.
      if (Math.abs(v) >= 0.05) worstRel = Math.max(worstRel, Math.abs(r - v) / Math.abs(v));
      // group * 8 + family must survive to better than half a count, or the
      // floor recovers the wrong family.
      if (Number.isInteger(v) && Math.abs(r - v) > 0.002) intFailures++;
    }
  }
  check("no facade value escapes the encode range", overRange === 0, `${overRange} outside 0..${FACADE_ENCODE_MAX}`);
  // 1% is a bound on what is VISIBLE, deliberately not derived from the
  // encoder's own quantum: a gate whose threshold comes from the constant it
  // checks moves its goalposts with it, which this repo has shipped five times.
  // A storey height or a window fraction wrong by 1% is not perceptible; wrong
  // by a scale factor or a swapped byte order is, and that is what this catches.
  check("fixed point keeps every value", worstRel < 0.01, `worst relative ${worstRel.toExponential(2)}`);
  check("fixed point absolute error is negligible", worstAbs < 0.001, `worst absolute ${worstAbs.toExponential(2)}`);
  check("fixed point is safe on the packed integers", intFailures === 0, `${intFailures} integers drifted`);

  // VACUITY PROBE: the range assertion must reject a value that does not fit.
  const [plo, phi] = encodeFacadeValue(FACADE_ENCODE_MAX * 4);
  check(
    "the range check would catch an over-range value",
    Math.abs(decodeFacadeValue(plo, phi) - FACADE_ENCODE_MAX * 4) > 1,
    `clamped to ${decodeFacadeValue(plo, phi).toFixed(1)} as it must be`,
  );
}


// --- the per-tile lookup path ----------------------------------------------
//
// A LIVE-streamed city builds one facade table PER TILE, so a table with four
// buildings in it is routine there and impossible in a baked city, which builds
// one table for 180,000. That small-N path has never been exercised by any
// gate, and a wrong row stride in it decodes every parameter as garbage, which
// is what a city of randomly coloured buildings looks like.
//
// This walks the EXACT indexing the fragment shader walks, in TypeScript:
//   t = bidx * FACADE_BYTE_TEXELS + k
//   y = floor(t / width),  x = t - y * width
// and one RGBA8 texel carries two 16-bit values, (r,g) then (b,a).
{
  // texelFetch takes an (x, y) and the TEXTURE's own width decides where that
  // lands in memory. So the row arithmetic uses the width the shader believes,
  // and the fetch uses the width the texture actually has. Passing one value
  // for both cancels out algebraically and tests nothing, which is exactly what
  // the probe below caught the first time this was written.
  const shaderRead = (
    data: Uint8Array,
    believedWidth: number,
    bidx: number,
    valueIndex: number,
    trueWidth = FACADE_TEX_WIDTH,
  ): number => {
    // Which of the twelve byte-texels holds this value, and which half of it.
    const pair = Math.floor(valueIndex / 2);
    const half = valueIndex % 2;
    const t = bidx * FACADE_BYTE_TEXELS + pair;
    const y = Math.floor(t / believedWidth);
    const x = t - y * believedWidth;
    const o = (y * trueWidth + x) * 4 + half * 2;
    if (o + 1 >= data.length) return Number.NaN;
    return decodeFacadeValue(data[o], data[o + 1]);
  };

  let worstErr = 0;
  let checkedTiles = 0;
  const scratch = new Float32Array(FACADE_FLOATS);
  // 1 and 4 are real tile sizes; 85 crosses no row; 86 crosses exactly one row
  // boundary (86 * 12 = 1032 > 1024), which is the case a stride bug hides in.
  for (const n of [1, 4, 85, 86, 171, 512, 2000]) {
    const params = [];
    for (let i = 0; i < n; i++) params.push(facadeFor(i % 7, 4 + (i % 200), i * 7 + 1));
    const { data, height } = packFacadeBytes(params);
    checkedTiles++;
    for (let i = 0; i < n; i++) {
      packFacade(params[i], scratch, 0);
      for (let v = 0; v < FACADE_FLOATS; v++) {
        const got = shaderRead(data, FACADE_TEX_WIDTH, i, v);
        worstErr = Math.max(worstErr, Math.abs(got - scratch[v]));
      }
    }
    // The buffer must be big enough for the last building's last byte.
    const needed = n * FACADE_FLOATS * 2;
    check(
      `a ${n}-building table is large enough`,
      data.length >= needed,
      `${data.length} bytes for ${needed} needed, ${height} rows`,
    );
  }
  check(
    "every building reads back through the shader's own indexing",
    worstErr < 0.001,
    `worst error ${worstErr.toExponential(2)} across ${checkedTiles} table sizes`,
  );

  // VACUITY PROBE: the read must FAIL if the stride is wrong, or it is checking
  // nothing. 86 buildings is 1032 texels, so it spans two rows and a stride of
  // width+1 misplaces every building after the first row.
  const params86 = [];
  for (let i = 0; i < 86; i++) params86.push(facadeFor(i % 7, 4 + i, i * 7 + 1));
  const { data: d86 } = packFacadeBytes(params86);
  let wrongStrideErr = 0;
  for (let i = 0; i < 86; i++) {
    packFacade(params86[i], scratch, 0);
    for (let v = 0; v < FACADE_FLOATS; v++) {
      const got = shaderRead(d86, FACADE_TEX_WIDTH + 1, i, v);
      const err = Number.isNaN(got) ? Infinity : Math.abs(got - scratch[v]);
      wrongStrideErr = Math.max(wrongStrideErr, err);
    }
  }
  check(
    "probe: a wrong row stride is detectable",
    wrongStrideErr > 0.01,
    `off-by-one stride gives ${wrongStrideErr.toExponential(2)} error, so the check above can fail`,
  );
}

console.log(failures === 0 ? "\nall facade checks ok" : `\n${failures} facade check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

