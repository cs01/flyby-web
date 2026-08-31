// The gate on open water: is a river a surface, or a sheet of paper.
//
// WHY THIS IS NOT IN `bun run check`. Everything check runs is offline and
// Chrome-free, and it has to stay that way: it runs on every change. This
// measures a RENDERED FRAME, so it needs a GPU, a browser and a vite server,
// and there is no GPU under Bun. There is also nothing else it could be -- the
// defect lives entirely in a fragment shader, and no amount of CPU-side unit
// testing can look at what the shader drew. So it is its own script, `bun run
// water`, run when the water term is touched.
//
// WHAT WAS WRONG, and what a screenshot alone could not settle. The Fresnel
// model in render/terrain.ts was right; the normal it evaluated against was the
// TERRAIN's, and over water that is a plateau. One normal over the whole river
// means one Fresnel factor over the whole river, and from a kerb at a grazing
// angle that factor pins near 1 everywhere: the Chicago main branch rendered as
// a single uniform mauve slab, which is what was reported from the app. The fix
// is a wave normal, a sky reflection sampled along the reflected ray, and a GGX
// glint on the wave slope.
//
// GATE DISCIPLINE, as in test/bridge.check.ts. Every bound below is a LITERAL,
// and every literal is one of the two measured numbers printed beside it at run
// time, not a round number picked for looking reasonable. Every assertion is
// paired with a VACUITY PROBE that must FAIL it. Two kinds of probe are used:
//
//   * `?flatwater=1` restores the pre-wave water in the SAME binary, so an
//     assertion that would pass either way is caught immediately;
//   * for the aliasing CEILING there is no such flag, because the honest
//     opposite of "smooth" is not "old code", it is "a frame where the detail
//     is legitimately resolved". So that ceiling is probed against the SAME
//     measurement run on the Chicago frame, which is over it by 4x. A ceiling
//     nothing can exceed measures nothing.
//
// TWO POSES, AND THEY ASSERT OPPOSITE THINGS ON PURPOSE.
//
//   chicago-river-kerb  ten metres over the water, looking along it. A 2.6 m
//                       wave is tens of pixels across here, so the frame MUST
//                       have local structure in it. Floor.
//   sydney-harbour      420 m up at ten degrees below the horizontal. The pixel
//                       footprint on that water is several metres even before
//                       the grazing angle stretches it, so every wave in the
//                       model is sub-pixel and the ONLY correct answer is
//                       smooth. Ceiling. This is the aliasing check: a frame
//                       that sparkles here is a failure, and deleting the
//                       footprint fade is exactly what would make it sparkle.
//
// THE WATER MASK IS NOT GUESSED. Each pose is rendered a second time with
// `?terrainDebug=7`, which makes the terrain output its own water term as
// greyscale, so "which pixels are water" is answered by the shader that decides
// it. Buildings are left standing in that run on purpose: they occlude exactly
// what they occlude in the beauty frame, so mask and frame agree pixel for
// pixel.
//
//   bun run water
//   bun tools/verify-water.ts --out shots/water --keep

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
// Measured both ways on an M-series laptop before they were written down. The
// run prints the flat and wave numbers next to every one of them, so a bound
// that has drifted out from between its two measurements is visible in the
// output rather than only in a red line.
//
//   pose                measure          flat      wave     bound
//   chicago-river-kerb  relative LC      0.0036    0.0534   >= 0.020
//   chicago-river-kerb  luminance sd     28.69     46.04    >= 36
//   sydney-harbour      relative LC      0.0079    0.0022   <= 0.012
//   sydney-harbour      luminance sd     39.36     52.39    >= 45
//   sydney-harbour      mirror ratio     0.933     1.088    >= 1.02
//
// The two Chicago bounds have several times the separation they need and are
// where the reported defect lives. The Sydney sd and mirror bounds are TIGHT --
// about 15% and 8% clear of each measurement - and that is not carelessness,
// it is the size of the effect: from 420 m every wave is correctly invisible,
// so all that is left to measure there is the reflection getting a direction.
// They are usable bounds only because the harness pins the camera, the clock,
// the weather and the render scale, and its own --repeat check reports these
// poses byte-identical between runs.
interface PoseGate {
  name: string;
  /** Floor when the waves are resolved at this range, ceiling when they cannot be. */
  lc: { kind: "floor" | "ceiling"; bound: number };
  /** Luminance standard deviation over the water, 0..255. */
  sd: number;
  /**
   * Grazing water luminance over the sky luminance just above it, or null when
   * the pose cannot ask the question honestly.
   *
   * At the horizon Fresnel goes to 1, so water there is very nearly a mirror and
   * has to come out about as bright as the sky it is reflecting. That is the
   * assertion that specifically catches losing the reflected-ray sky sample: a
   * constant ambient has no horizon in it and cannot match one by accident.
   *
   * Not asserted on the Chicago pose. There the sun is 20 degrees up and almost
   * dead ahead, so the "sky just above the water" is a band of glare between
   * tower walls and the ratio is over 1.8 either way. It is not a mirror test
   * there, it is a picture of the sun.
   */
  mirror: number | null;
}

const GATES: PoseGate[] = [
  { name: "chicago-river-kerb", lc: { kind: "floor", bound: 0.020 }, sd: 36, mirror: null },
  { name: "sydney-harbour", lc: { kind: "ceiling", bound: 0.012 }, sd: 45, mirror: 1.02 },
];

/** Neighbour distance for the local contrast, in pixels. */
const LC_RADIUS = 2;

/** Run the existing screenshot harness once, for one query variant. */
async function shoot(outDir: string, query: string, port: number, dbg: number): Promise<void> {
  const args = [
    "tools/shots.ts",
    "--only", GATES.map((g) => g.name).join(","),
    "--out", outDir,
    "--port", String(port),
    "--debug-port", String(dbg),
  ];
  if (query) args.push("--query", query);
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
  /** Rec.601 luminance of the displayed pixel, 0..255. */
  lum: Float32Array;
}

function luminance(path: string): Frame {
  const img = decodePng(path);
  const lum = new Float32Array(img.w * img.h);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  }
  return { w: img.w, h: img.h, lum };
}

/**
 * Water pixels, from the terrainDebug=7 frame: GREY and SATURATED-BRIGHT.
 *
 * The debug view writes vec3(water) and the frame is still tone-mapped on the
 * way out, so a water term of 1.0 lands at 181/255 and nothing goes above it.
 * Measured on the Chicago pose the grey histogram is empty from 192 up and has
 * a spike of 56k pixels in 176..191, which is the river. Greyness is what
 * rejects the sky, the drape and the buildings, none of which come out neutral.
 */
function waterMask(path: string): Uint8Array {
  const img = decodePng(path);
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    m[i] = Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3 && r >= 170 ? 1 : 0;
  }
  return m;
}

interface Stats {
  n: number;
  mean: number;
  sd: number;
  /**
   * Mean |pixel - mean of its four neighbours LC_RADIUS away|, divided by the
   * mean luminance over the same pixels.
   *
   * The GLOBAL standard deviation cannot answer "is this a sheet of paper",
   * because the flat water already had a large one: aerial perspective, the
   * shoreline and a shadow crossing the bay all vary over kilometres. What the
   * flat water had none of was LOCAL structure. This is a high-pass, so the
   * kilometre-scale gradients drop out of it and only the surface is left, and
   * dividing by the mean makes it a contrast rather than a brightness -- which
   * matters, because the near foreground of the Chicago pose is in deep shadow
   * and would otherwise score as flat simply for being dark.
   */
  relLC: number;
}

function stats(f: Frame, mask: Uint8Array): Stats {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { sum += f.lum[i]; n++; }
  if (n === 0) return { n: 0, mean: 0, sd: 0, relLC: 0 };
  const mean = sum / n;
  let q = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) q += (f.lum[i] - mean) * (f.lum[i] - mean);

  const d = LC_RADIUS;
  let lcSum = 0;
  let lcMean = 0;
  let lcN = 0;
  for (let y = d; y < f.h - d; y++) {
    for (let x = d; x < f.w - d; x++) {
      const i = y * f.w + x;
      if (!mask[i]) continue;
      const a = i - d, b = i + d, c = i - d * f.w, e = i + d * f.w;
      // Every neighbour must be water too, or the measurement is a shoreline
      // rather than a surface.
      if (!mask[a] || !mask[b] || !mask[c] || !mask[e]) continue;
      lcSum += Math.abs(f.lum[i] - (f.lum[a] + f.lum[b] + f.lum[c] + f.lum[e]) / 4);
      lcMean += f.lum[i];
      lcN++;
    }
  }
  return {
    n,
    mean,
    sd: Math.sqrt(q / n),
    relLC: lcN ? lcSum / lcMean : 0,
  };
}

/**
 * Luminance of the most grazing water in each column, over the sky just above
 * it. See PoseGate.mirror for what it is for.
 *
 * Columns where the topmost water pixel has any water within eight rows above
 * it are skipped: that is a gap in a shoreline or a bridge, not a horizon, and
 * the "sky" sample would be more water.
 */
function mirrorRatio(f: Frame, mask: Uint8Array): number {
  let water = 0;
  let sky = 0;
  let cols = 0;
  for (let x = 0; x < f.w; x++) {
    let yw = -1;
    for (let y = 0; y < f.h; y++) if (mask[y * f.w + x]) { yw = y; break; }
    if (yw < 12) continue;
    let clear = true;
    for (let k = 1; k <= 8; k++) if (mask[(yw - k) * f.w + x]) clear = false;
    if (!clear) continue;
    let ws = 0;
    let wn = 0;
    for (let k = 0; k < 4; k++) if (mask[(yw + k) * f.w + x]) { ws += f.lum[(yw + k) * f.w + x]; wn++; }
    if (wn < 3) continue;
    let ss = 0;
    for (let k = 3; k <= 8; k++) ss += f.lum[(yw - k) * f.w + x];
    water += ws / wn;
    sky += ss / 6;
    cols++;
  }
  return cols ? water / sky : 0;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots/water");
  const port = Number(arg("port", "5179"));
  const dbg = Number(arg("debug-port", "9413"));
  mkdirSync(outDir, { recursive: true });

  // `--reuse` measures frames already in --out instead of rendering them. It is
  // for working on the MEASUREMENT: three passes of the shot harness is eight
  // minutes, and nothing about tuning a bound needs the pictures taken again.
  if (!has("reuse")) {
    console.log("rendering the wave water ...");
    await shoot(`${outDir}/wave`, "", port, dbg);
    console.log("rendering the flat water (?flatwater=1) ...");
    await shoot(`${outDir}/flat`, "flatwater=1", port, dbg);
    console.log("rendering the water mask (?terrainDebug=7) ...");
    await shoot(`${outDir}/mask`, "terrainDebug=7", port, dbg);
    console.log("");
  }

  // The Chicago local contrast doubles as the vacuity probe for the Sydney
  // ceiling, so it is kept once both poses have been measured.
  const waveLC: Record<string, number> = {};
  const measured: { g: PoseGate; wave: Stats; flat: Stats; mw: number; mf: number }[] = [];

  for (const g of GATES) {
    const mask = waterMask(`${outDir}/mask/${g.name}.png`);
    const wave = luminance(`${outDir}/wave/${g.name}.png`);
    const flat = luminance(`${outDir}/flat/${g.name}.png`);
    const sw = stats(wave, mask);
    const sf = stats(flat, mask);
    waveLC[g.name] = sw.relLC;
    measured.push({ g, wave: sw, flat: sf, mw: mirrorRatio(wave, mask), mf: mirrorRatio(flat, mask) });
    console.log(
      `${g.name.padEnd(20)} ${sw.n} water px (${((100 * sw.n) / (wave.w * wave.h)).toFixed(1)}% of frame)  ` +
        `relLC ${sf.relLC.toFixed(4)} -> ${sw.relLC.toFixed(4)}   ` +
        `sd ${sf.sd.toFixed(2)} -> ${sw.sd.toFixed(2)}   ` +
        `mean ${sf.mean.toFixed(1)} -> ${sw.mean.toFixed(1)}   ` +
        `mirror ${mirrorRatio(flat, mask).toFixed(3)} -> ${mirrorRatio(wave, mask).toFixed(3)}`,
    );
  }
  console.log("");

  for (const { g, wave, flat, mw, mf } of measured) {
    check(`${g.name}: enough water to measure`, wave.n >= 100000, `${wave.n} px`);

    if (g.lc.kind === "floor") {
      // THE SURFACE IS A SURFACE. This one number is the reported defect.
      check(
        `${g.name}: local contrast over water`,
        wave.relLC >= g.lc.bound,
        `${wave.relLC.toFixed(4)} >= ${g.lc.bound}`,
      );
      probe(
        `${g.name}: local contrast, ?flatwater`,
        flat.relLC >= g.lc.bound,
        `${flat.relLC.toFixed(4)} >= ${g.lc.bound}`,
      );
    } else {
      // AND IT DOES NOT SPARKLE. Every wave in this frame is sub-pixel, so the
      // footprint fade and the widened GGX lobe have to have taken the
      // per-pixel structure out of it. The probe is the same function on the
      // Chicago frame, where the same structure is legitimately present.
      check(
        `${g.name}: local contrast stays sub-pixel`,
        wave.relLC <= g.lc.bound,
        `${wave.relLC.toFixed(4)} <= ${g.lc.bound}`,
      );
      const other = GATES.find((o) => o.lc.kind === "floor")!;
      probe(
        `${g.name}: same measure on ${other.name}`,
        waveLC[other.name] <= g.lc.bound,
        `${waveLC[other.name].toFixed(4)} <= ${g.lc.bound}`,
      );
    }

    // AND IT IS NOT ONE VALUE.
    check(`${g.name}: luminance sd over water`, wave.sd >= g.sd, `${wave.sd.toFixed(2)} >= ${g.sd}`);
    probe(`${g.name}: luminance sd, ?flatwater`, flat.sd >= g.sd, `${flat.sd.toFixed(2)} >= ${g.sd}`);

    if (g.mirror !== null) {
      // AND AT THE HORIZON IT IS A MIRROR.
      check(`${g.name}: grazing water against the sky`, mw >= g.mirror, `${mw.toFixed(3)} >= ${g.mirror}`);
      probe(`${g.name}: mirror ratio, ?flatwater`, mf >= g.mirror, `${mf.toFixed(3)} >= ${g.mirror}`);
    }
  }

  if (!has("keep")) rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
