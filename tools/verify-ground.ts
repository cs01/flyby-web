// The gate on the ground's own surface: does the detail layer add frequency
// where the photograph has none, without changing its colour, and without
// touching the far field.
//
// WHY THIS IS NOT IN `bun run check`: the same reason as tools/verify-water.ts.
// It measures rendered frames, which needs a GPU, a browser and a vite server.
//
// THE CLAIMS, and the probe that must fail each one. Every probe is the SAME
// binary with one gate flag (see uDetailMode in render/terrain.ts):
//
//   marin-headlands  NEAR. The drape here is the 7.5 m z14 ring seen from 100
//                    to 300 m, eight or more pixels a texel, and the ground was
//                    a smear. Local contrast over the ground has a floor.
//                    Probe: ?nodetail=1, the drape alone.
//   marin-headlands  AND IT IS STILL THE PHOTOGRAPH'S COLOUR. Mean RGB over
//                    32 px blocks of ground, against the ?nodetail frame, has
//                    a ceiling. Probe: ?detailtint=1, the layer tinted warm,
//                    which is what painting a material colour over the
//                    photograph instead of modulating it would do.
//   sf-peninsula     FAR. 1,100 m up; most of the drape is at or under a pixel
//                    a texel. The local contrast the layer ADDS (detail minus
//                    nodetail) has a ceiling: anything above it is octaves
//                    finer than a pixel, i.e. aliasing. Probe: ?detailalias=1,
//                    every octave in regardless of either footprint.
//   sf-peninsula     AND WHERE THE LAYER SAYS IT IS OFF, THE FRAME IS THE
//                    FRAME IT WAS. Mean absolute difference against ?nodetail
//                    over ground pixels the layer reports no band for
//                    (?terrainDebug=20, red channel zero) has a ceiling.
//                    Probe: the same pixels under ?detailalias=1.
//
// The ground mask is ?terrainDebug=19, the terrain's own land/water term, so
// "which pixels are ground" is answered by the shader that decides it. Trees,
// shrubs, roads and buildings are drawn in that run exactly as in the beauty
// frame, so they occlude exactly the same pixels and the mask agrees.
//
//   bun run ground
//   bun tools/verify-ground.ts --out shots/ground --keep
//   bun tools/verify-ground.ts --out shots/ground --reuse   (measure only)

import { mkdirSync, rmSync } from "node:fs";
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
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(47)} ${detail}`);
  if (!ok) failures++;
}

// --- THE BOUNDS ------------------------------------------------------------
//
// Literals, each measured both ways before it was written down, and printed
// beside its two measurements on every run:
//
//   pose             measure                     shipped   probe     bound
//   marin-headlands  relative local contrast     0.0253    0.0143    >= 0.020
//   marin-headlands  block colour shift, 0..255  1.39      4.30      <= 2.4
//   sf-peninsula     added local contrast        0.0000    0.0047    <= 0.002
//   sf-peninsula     far-field pixel diff        0.000     2.163     <= 0.25
//
// The colour bound is the geometric middle of its pair. It was 2.0 between
// 0.97 and 4.16 until the outcrop patches landed: rock is the photograph's
// own 8 m average a fifth desaturated, which is meant to move its pixels.
//
// The contrast floor has 1.8x between its two numbers, and that is the size of
// the effect rather than a loose bound: a first version that kept octaves down
// to four pixels for the SLOPE as well measured 0.0447, and drew corduroy
// across the Emerald Hills ridge under an 18:30 sun. The slope now keeps eight
// pixels a period and the contrast it gave up is what the floor stands on.
//
// The colour shift on the shipped layer is not zero, and should not be: the
// tone curve is concave, so zero-mean modulation of LINEAR albedo comes out a
// little darker once displayed, and the rock swap and the wet sand strip are
// meant to move their pixels. The tint probe is what a material painted over
// the photograph does, at 25% warm.
const NEAR = "marin-headlands";
const FAR = "sf-peninsula";
const LC_FLOOR = 0.020;
const COLOUR_CEILING = 2.4;
const ALIAS_CEILING = 0.002;
const FARFIELD_CEILING = 0.25;

/** Neighbour distance for the local contrast, in pixels. */
const LC_RADIUS = 2;
/** Block size for the colour comparison, pixels. */
const BLOCK = 32;

async function shoot(outDir: string, query: string, port: number, dbg: number, poses: string[]): Promise<void> {
  const args = ["tools/shots.ts", "--only", poses.join(","), "--out", outDir, "--port", String(port), "--debug-port", String(dbg)];
  if (query) args.push("--query", query);
  // Forwarded so two agents sharing a GPU can each run this gate with their
  // own Chrome profile; the default one is a single lock for the machine.
  const profile = arg("profile", "");
  if (profile) args.push("--profile", profile);
  const p = Bun.spawn(["bun", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`shots.ts exited ${code} for query "${query || "(none)"}"`);
}

interface Frame {
  w: number;
  h: number;
  rgb: Float32Array;
  lum: Float32Array;
}

function frame(path: string): Frame {
  const img = decodePng(path);
  const n = img.w * img.h;
  const rgb = new Float32Array(n * 3);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { w: img.w, h: img.h, rgb, lum };
}

/**
 * Ground pixels, from the terrainDebug=19 frame: grey and bright. The debug
 * view writes vec3(1) for land and is tone-mapped on the way out, so land
 * lands near 181 and nothing else in the frame is that neutral and that
 * bright (the same rule tools/verify-water.ts reads its masks with).
 */
function greyMask(path: string): Uint8Array {
  const img = decodePng(path);
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    m[i] = Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3 && r >= 170 ? 1 : 0;
  }
  return m;
}

/** Ground pixels the layer reports no octave for: terrainDebug=20 red at zero. */
function offMask(path: string, ground: Uint8Array): Uint8Array {
  const img = decodePng(path);
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) m[i] = ground[i] && img.data[i * 4] <= 2 ? 1 : 0;
  return m;
}

function count(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
}

/**
 * Mean |pixel - mean of its four neighbours LC_RADIUS away| over the mean
 * luminance, on pixels whose neighbours are all ground: the same high-pass
 * the water gate uses, so the kilometre-scale shading drops out and only the
 * surface is left.
 */
function relLC(f: Frame, mask: Uint8Array): number {
  const d = LC_RADIUS;
  let s = 0, m = 0, n = 0;
  for (let y = d; y < f.h - d; y++) {
    for (let x = d; x < f.w - d; x++) {
      const i = y * f.w + x;
      if (!mask[i]) continue;
      const a = i - d, b = i + d, c = i - d * f.w, e = i + d * f.w;
      if (!mask[a] || !mask[b] || !mask[c] || !mask[e]) continue;
      s += Math.abs(f.lum[i] - (f.lum[a] + f.lum[b] + f.lum[c] + f.lum[e]) / 4);
      m += f.lum[i];
      n++;
    }
  }
  return n && m ? s / m : 0;
}

/**
 * Mean over BLOCK x BLOCK tiles that are at least 90% ground of the mean
 * absolute per-channel difference of the two frames' block means, 0..255.
 * A low-pass on both, so detail that averages out costs nothing and a shift
 * in the average is all that is left.
 */
function blockColourDiff(a: Frame, b: Frame, mask: Uint8Array): { diff: number; blocks: number } {
  let sum = 0, blocks = 0;
  for (let by = 0; by + BLOCK <= a.h; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= a.w; bx += BLOCK) {
      const ma = [0, 0, 0], mb = [0, 0, 0];
      let n = 0;
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const i = y * a.w + x;
          if (!mask[i]) continue;
          for (let c = 0; c < 3; c++) { ma[c] += a.rgb[i * 3 + c]; mb[c] += b.rgb[i * 3 + c]; }
          n++;
        }
      }
      if (n < 0.9 * BLOCK * BLOCK) continue;
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(ma[c] - mb[c]) / n;
      sum += d / 3;
      blocks++;
    }
  }
  return { diff: blocks ? sum / blocks : 0, blocks };
}

/** Mean absolute per-channel difference over the mask, 0..255. */
function pixelDiff(a: Frame, b: Frame, mask: Uint8Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c++) s += Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c]);
    n++;
  }
  return n ? s / (3 * n) : 0;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots/ground");
  const port = Number(arg("port", "5180"));
  const dbg = Number(arg("debug-port", "9414"));
  mkdirSync(outDir, { recursive: true });

  if (!has("reuse")) {
    console.log("rendering the ground ...");
    await shoot(`${outDir}/detail`, "", port, dbg, [NEAR, FAR]);
    console.log("rendering the drape alone (?nodetail=1) ...");
    await shoot(`${outDir}/nodetail`, "nodetail=1", port, dbg, [NEAR, FAR]);
    console.log("rendering the tinted layer (?detailtint=1) ...");
    await shoot(`${outDir}/tint`, "detailtint=1", port, dbg, [NEAR]);
    console.log("rendering the unlimited layer (?detailalias=1) ...");
    await shoot(`${outDir}/alias`, "detailalias=1", port, dbg, [FAR]);
    console.log("rendering the ground mask (?terrainDebug=19) ...");
    await shoot(`${outDir}/mask`, "terrainDebug=19", port, dbg, [NEAR, FAR]);
    console.log("rendering the band map (?terrainDebug=20) ...");
    await shoot(`${outDir}/band`, "terrainDebug=20", port, dbg, [FAR]);
    console.log("");
  }

  // NEAR: the floor, and the colour.
  {
    const mask = greyMask(`${outDir}/mask/${NEAR}.png`);
    const det = frame(`${outDir}/detail/${NEAR}.png`);
    const off = frame(`${outDir}/nodetail/${NEAR}.png`);
    const tint = frame(`${outDir}/tint/${NEAR}.png`);
    const n = count(mask);
    const lcD = relLC(det, mask);
    const lcO = relLC(off, mask);
    const cD = blockColourDiff(det, off, mask);
    const cT = blockColourDiff(tint, off, mask);
    console.log(
      `${NEAR}: ${n} ground px (${((100 * n) / mask.length).toFixed(1)}%)  ` +
        `relLC nodetail ${lcO.toFixed(4)} detail ${lcD.toFixed(4)}  ` +
        `block colour shift detail ${cD.diff.toFixed(2)} tint ${cT.diff.toFixed(2)} over ${cD.blocks} blocks`,
    );
    check(`${NEAR}: enough ground to measure`, n >= 300000 && cD.blocks >= 200, `${n} px, ${cD.blocks} blocks`);
    check(`${NEAR}: local contrast over the ground`, lcD >= LC_FLOOR, `${lcD.toFixed(4)} >= ${LC_FLOOR}`);
    probe(`${NEAR}: local contrast, ?nodetail`, lcO >= LC_FLOOR, `${lcO.toFixed(4)} >= ${LC_FLOOR}`);
    check(`${NEAR}: block colour stays the photograph's`, cD.diff <= COLOUR_CEILING, `${cD.diff.toFixed(2)} <= ${COLOUR_CEILING}`);
    probe(`${NEAR}: block colour, ?detailtint`, cT.diff <= COLOUR_CEILING, `${cT.diff.toFixed(2)} <= ${COLOUR_CEILING}`);
  }

  // FAR: the aliasing ceiling, and the untouched far field.
  {
    const mask = greyMask(`${outDir}/mask/${FAR}.png`);
    const det = frame(`${outDir}/detail/${FAR}.png`);
    const off = frame(`${outDir}/nodetail/${FAR}.png`);
    const ali = frame(`${outDir}/alias/${FAR}.png`);
    const far = offMask(`${outDir}/band/${FAR}.png`, mask);
    const n = count(mask);
    const nf = count(far);
    const lcO = relLC(off, mask);
    const addD = relLC(det, mask) - lcO;
    const addA = relLC(ali, mask) - lcO;
    const dD = pixelDiff(det, off, far);
    const dA = pixelDiff(ali, off, far);
    console.log(
      `${FAR}: ${n} ground px, ${nf} with no band (${((100 * nf) / Math.max(1, n)).toFixed(1)}%)  ` +
        `added relLC detail ${addD.toFixed(4)} alias ${addA.toFixed(4)}  ` +
        `far-field diff detail ${dD.toFixed(3)} alias ${dA.toFixed(3)}`,
    );
    // The towers cover most of the city, so the ground is a quarter of this
    // frame: 222,675 px measured.
    check(`${FAR}: enough ground, and enough of it far`, n >= 150000 && nf >= 0.25 * n, `${n} px, ${nf} far`);
    check(`${FAR}: contrast the layer adds from altitude`, addD <= ALIAS_CEILING, `${addD.toFixed(4)} <= ${ALIAS_CEILING}`);
    probe(`${FAR}: added contrast, ?detailalias`, addA <= ALIAS_CEILING, `${addA.toFixed(4)} <= ${ALIAS_CEILING}`);
    check(`${FAR}: far field is the frame it was`, dD <= FARFIELD_CEILING, `${dD.toFixed(3)} <= ${FARFIELD_CEILING}`);
    probe(`${FAR}: far field, ?detailalias`, dA <= FARFIELD_CEILING, `${dA.toFixed(3)} <= ${FARFIELD_CEILING}`);
  }

  if (!has("keep") && !has("reuse")) rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
