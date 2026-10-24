// The gate on the sky: is it a weather, or a noise texture.
//
// Rendered-frame gate in the discipline of tools/verify-water.ts: it needs a
// GPU, a browser and a vite server, so it is its own script (`bun run clouds`)
// and not part of `bun run check`. Every bound is a LITERAL measured on both
// sides before it was written down (the table below), and every claim is
// paired with a VACUITY PROBE that must fail it.
//
// WHAT WAS WRONG (the owner's phone): fair-weather cumulus rendered as small
// puffs spread evenly over the whole sky, with no scale, no clustering and no
// common base; overcast was a flat grey smear. Coverage was a threshold on a
// 3D noise that repeats every 1.8 km, so the sky could only ever be one size
// of puff, everywhere.
//
// THE MEASUREMENT FRAME is `?clouddebug=1`: the present pass writes the cloud
// buffer raw, R = opacity, G/B = the altitude (16 bits over 8 km) at which the
// ray's opacity first passed 0.2. So "which pixels are cloud" and "how high is
// this cloud's base" are answered by the march itself, not inferred from
// colour.
//
// THE CLAIMS
//
//   (a) clouds-gate-up30, 30 deg up into a 30% cumulus sky. CLUSTERING: split
//       the frame into 160 px tiles; within each row of tiles (one elevation
//       band, so perspective cannot pass for structure) take the coefficient
//       of variation of tile coverage, and average the rows. A field of fields
//       with lanes between them varies tile to tile; an even scatter of puffs
//       does not. Probe: ?cloudwm=0, the same renderer with the weather map
//       replaced by uniform coverage.
//   (b) clouds-gate-side, 20 deg up at a 40% cumulus deck based at 1400 m. A
//       FLAT BASE: at every lower cloud edge more than ~10 deg up (cloud
//       above, sky two rows below) read the first-hit altitude; its 10th to
//       90th percentile must lie in a band 90 m deep at the reported base.
//       Probe: ?cloudflatbase=0, the old profile, whose base ramped in over
//       20% of the deck and wandered with the weather field.
//   (c) clouds-gate-cover20 / cover80, the up30 pose at 20% and 80%. COVERAGE TRACKS THE WEATHER:
//       the cloud fraction of each frame lies in a measured band, and each
//       band is probed with the other frame.
//   (d) clouds-manhattan-cumulus-morning. TEMPORAL STABILITY: the mean
//       absolute frame difference after stepping the clouds' clock by one
//       frame (1/60 s) has a ceiling. Probe: the same measure after a further
//       10 s, which must clear it, so the measure can see cloud motion at all.
//   (e) the same pose rendered twice is BYTE-IDENTICAL: `?shot` determinism
//       with a temporal march in the loop.
//
//   bun run clouds
//   bun tools/verify-clouds.ts --out shots/clouds/gate --reuse   (measure only)

import { mkdirSync, readFileSync } from "node:fs";
import { decodePng } from "./pixdiff";

declare const process: { argv: string[]; exit(code?: number): never };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(43)} ${detail}`);
  if (!ok) failures++;
}

// --- THE BOUNDS ------------------------------------------------------------
//
// Measured on an M-series laptop (Apple M4, ANGLE Metal), new renderer and
// then its probe. Each bound sits between the two, roughly at their geometric
// mean where the measure is a ratio-like quantity.
//
//   claim  pose          measure                         new      probe    bound
//   (a)    up30          mean row CV of tile coverage    1.551    0.369    >= 0.75
//   (b)    side          lower-edge altitude p10..p90    1432..   1540..   1400..1490 m
//                                                        1447     1566     (deck base 1400)
//   (c)    cover20       cloud fraction, rows 0..640     0.120    0.892    0.07..0.20
//   (c)    cover80       cloud fraction, rows 0..640     0.892    0.120    0.80..0.97
//   (d)    morning       mean |dL| after 1/60 s, 0..255  0.0054   1.97     <= 0.1
//                        (probe: after a further 10 s)
//
// The (a) probe is the same renderer with the weather map switched off, so
// coverage is a threshold on the 3D noise alone: it covers 0.52 of the frame
// to the new 0.23 at the same 30% deck and still varies less tile to tile,
// which is the even scatter of puffs the owner photographed.
// The (b) probe's base is no wider than the new one over the few clouds in
// view (both under 30 m p10..p90), so the claim is the BAND and not the
// spread: the old profile ramped density in over the bottom 20% of the deck,
// so its visible base floated 150 m above the reported one and wandered with
// the weather field.
const CLUSTER_FLOOR = 0.75;
const BASE_BAND: [number, number] = [1400, 1490];
const COVER20: [number, number] = [0.07, 0.2];
const COVER80: [number, number] = [0.8, 0.97];
const STEP_CEIL = 0.1;

const UP = "clouds-gate-up30";
const SIDE = "clouds-gate-side";
const C20 = "clouds-gate-cover20";
const C80 = "clouds-gate-cover80";
const MOTION = "clouds-manhattan-cumulus-morning";

async function shoot(outDir: string, query: string, poses: string[], extra: string[] = []): Promise<void> {
  const args = [
    "tools/shots.ts", "--only", poses.join(","), "--out", outDir,
    "--port", arg("port", "5197"), "--debug-port", arg("debug-port", "9501"), ...extra,
  ];
  if (query) args.push("--query", query);
  const profile = arg("profile", "");
  if (profile) args.push("--profile", profile);
  const p = Bun.spawn(["bun", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) throw new Error(`shots.ts failed for "${query || "(none)"}"`);
}

interface Debug {
  w: number;
  h: number;
  /** Cloud opacity 0..1. */
  op: Float32Array;
  /** First-hit altitude in metres, 0 where none was recorded. */
  alt: Float32Array;
}

function debugFrame(path: string): Debug {
  const img = decodePng(path);
  const n = img.w * img.h;
  const op = new Float32Array(n);
  const alt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    op[i] = img.data[i * 4] / 255;
    alt[i] = ((img.data[i * 4 + 1] * 256 + img.data[i * 4 + 2]) / 65535) * 8000;
  }
  return { w: img.w, h: img.h, op, alt };
}

/** Fraction of pixels in rows [0, rows) that are mostly cloud. */
function coverage(f: Debug, rows: number): number {
  let c = 0;
  for (let i = 0; i < f.w * rows; i++) if (f.op[i] > 0.5) c++;
  return c / (f.w * rows);
}

/** (a): mean over tile rows of the sd of tile coverage across that row. */
function clustering(f: Debug, tile: number, rows: number): number {
  const tx = Math.floor(f.w / tile);
  const ty = Math.floor(rows / tile);
  let sum = 0;
  for (let r = 0; r < ty; r++) {
    const cov: number[] = [];
    for (let c = 0; c < tx; c++) {
      let n = 0;
      for (let y = r * tile; y < (r + 1) * tile; y++) {
        for (let x = c * tile; x < (c + 1) * tile; x++) if (f.op[y * f.w + x] > 0.5) n++;
      }
      cov.push(n / (tile * tile));
    }
    // The coefficient of variation, not the sd: the sd of a coverage grows
    // with the coverage itself, and the probe's uniform field covers several
    // times more sky than the clustered one at the same 30% deck.
    const m = cov.reduce((a, b) => a + b, 0) / cov.length;
    sum += m > 0 ? Math.sqrt(cov.reduce((a, b) => a + (b - m) * (b - m), 0) / cov.length) / m : 0;
  }
  return sum / ty;
}

const BASE_ROWS = 360;

/** (b): first-hit altitudes along every lower cloud edge, as [p10, p50, p90, count]. */
function baseSpread(f: Debug): [number, number, number, number] {
  const alts: number[] = [];
  // Only rows more than ~12 degrees up (the pose is pitched 20 up): there a lower edge is the near
  // underside of a cloud. Lower in the frame the ray skims under near bases
  // and its first hit is the flank of a cloud tens of kilometres off.
  for (let y = 0; y < BASE_ROWS; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x;
      if (f.op[i] > 0.5 && f.op[i + 2 * f.w] < 0.2 && f.alt[i] > 0) alts.push(f.alt[i]);
    }
  }
  alts.sort((a, b) => a - b);
  const q = (p: number) => alts[Math.min(alts.length - 1, Math.floor(p * alts.length))] ?? 0;
  return [q(0.1), q(0.5), q(0.9), alts.length];
}

/** Mean absolute difference of Rec.601 luminance, 0..255. */
function frameDiff(a: string, b: string): number {
  const A = decodePng(a);
  const B = decodePng(b);
  let s = 0;
  const n = A.w * A.h;
  for (let i = 0; i < n; i++) {
    const la = 0.299 * A.data[i * 4] + 0.587 * A.data[i * 4 + 1] + 0.114 * A.data[i * 4 + 2];
    const lb = 0.299 * B.data[i * 4] + 0.587 * B.data[i * 4 + 1] + 0.114 * B.data[i * 4 + 2];
    s += Math.abs(la - lb);
  }
  return s / n;
}

async function main(): Promise<void> {
  const out = arg("out", "shots/clouds/gate");
  mkdirSync(out, { recursive: true });
  if (!has("reuse")) {
    console.log("rendering the measurement frames (?clouddebug=1) ...");
    await shoot(`${out}/debug`, "clouddebug=1", [UP, SIDE, C20, C80]);
    console.log("rendering the uniform-coverage probe (?cloudwm=0) ...");
    await shoot(`${out}/uniform`, "clouddebug=1&cloudwm=0", [UP]);
    console.log("rendering the old-base probe (?cloudflatbase=0) ...");
    await shoot(`${out}/oldbase`, "clouddebug=1&cloudflatbase=0", [SIDE]);
    console.log("rendering the clock steps and the repeat ...");
    await shoot(`${out}/motion`, "", [MOTION], ["--step-clouds", `${1 / 60},10`, "--repeat"]);
    console.log("");
  }

  // Rows above the bottom 80: the up-looking poses keep the ground out of
  // them, so every pixel measured is sky or cloud.
  const ROWS = 640;

  const up = debugFrame(`${out}/debug/${UP}.png`);
  const upU = debugFrame(`${out}/uniform/${UP}.png`);
  const cl = clustering(up, 160, ROWS);
  const clU = clustering(upU, 160, ROWS);
  console.log(`(a) ${UP}: clustering ${cl.toFixed(4)} (coverage ${coverage(up, ROWS).toFixed(3)}), ` +
    `?cloudwm=0 ${clU.toFixed(4)} (coverage ${coverage(upU, ROWS).toFixed(3)})`);

  const side = debugFrame(`${out}/debug/${SIDE}.png`);
  const sideO = debugFrame(`${out}/oldbase/${SIDE}.png`);
  const bs = baseSpread(side);
  const bsO = baseSpread(sideO);
  console.log(`(b) ${SIDE}: base p10/p50/p90 ${bs.slice(0, 3).map((v) => v.toFixed(0)).join("/")} m over ${bs[3]} edge px, ` +
    `?cloudflatbase=0 ${bsO.slice(0, 3).map((v) => v.toFixed(0)).join("/")} m over ${bsO[3]}`);

  const c20 = coverage(debugFrame(`${out}/debug/${C20}.png`), ROWS);
  const c80 = coverage(debugFrame(`${out}/debug/${C80}.png`), ROWS);
  console.log(`(c) coverage at 20% low cover ${c20.toFixed(3)}, at 80% ${c80.toFixed(3)}`);

  const d1 = frameDiff(`${out}/motion/${MOTION}.png`, `${out}/motion/${MOTION}-step0.png`);
  const d10 = frameDiff(`${out}/motion/${MOTION}.png`, `${out}/motion/${MOTION}-step1.png`);
  console.log(`(d) ${MOTION}: one frame of cloud time ${d1.toFixed(4)}/255, a further 10 s ${d10.toFixed(4)}/255`);
  console.log("");

  check("(a) cumulus cluster into fields", cl >= CLUSTER_FLOOR, `${cl.toFixed(4)} >= ${CLUSTER_FLOOR}`);
  probe("(a) uniform coverage (?cloudwm=0)", clU >= CLUSTER_FLOOR, `${clU.toFixed(4)} >= ${CLUSTER_FLOOR}`);
  check("(b) enough lower edges to measure", bs[3] >= 200 && bsO[3] >= 50, `${bs[3]} px`);
  const inBand = (b: number[]) => b[0] >= BASE_BAND[0] && b[2] <= BASE_BAND[1];
  check("(b) cumulus share one flat base", inBand(bs),
    `${bs[0].toFixed(0)}..${bs[2].toFixed(0)} m in ${BASE_BAND.join("..")}`);
  probe("(b) old wandering base (?cloudflatbase=0)", inBand(bsO),
    `${bsO[0].toFixed(0)}..${bsO[2].toFixed(0)} m in ${BASE_BAND.join("..")}`);
  const in20 = (v: number) => v >= COVER20[0] && v <= COVER20[1];
  const in80 = (v: number) => v >= COVER80[0] && v <= COVER80[1];
  check("(c) 20% low cover lands in its band", in20(c20), `${c20.toFixed(3)} in ${COVER20.join("..")}`);
  check("(c) 80% low cover lands in its band", in80(c80), `${c80.toFixed(3)} in ${COVER80.join("..")}`);
  probe("(c) 20% band, measured on the 80% frame", in20(c80), `${c80.toFixed(3)} in ${COVER20.join("..")}`);
  probe("(c) 80% band, measured on the 20% frame", in80(c20), `${c20.toFixed(3)} in ${COVER80.join("..")}`);
  check("(d) one frame of cloud time is invisible", d1 <= STEP_CEIL, `${d1.toFixed(4)} <= ${STEP_CEIL}`);
  probe("(d) ten seconds of cloud time", d10 <= STEP_CEIL, `${d10.toFixed(4)} <= ${STEP_CEIL}`);
  const same = Buffer.from(readFileSync(`${out}/motion/${MOTION}.png`)).equals(
    Buffer.from(readFileSync(`${out}/motion/${MOTION}-repeat.png`)),
  );
  check("(e) ?shot is byte-identical across runs", same, same ? "identical" : "DIFFERS");

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures) process.exit(1);
}

await main();
