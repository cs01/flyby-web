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
// AND THREE MORE CLAIMS, added with the sea state and the scene reflection:
//
//   chicago-river-kerb  the river MIRRORS THE SKYLINE. The column profile of
//                       the band of water under the far bank has to correlate
//                       with the column profile of the scene just above it,
//                       after a high-pass that removes the shadows and the
//                       sky gradient both bands share anyway. Probe: the same
//                       frame under ?nossr=1, which keeps the waves and the
//                       sky reflection and drops only the reflected city.
//   sf-bay-windy        an 11 m/s westerly BREAKS. Whitecap coverage over the
//                       water has a floor, and the foam pixels are visibly
//                       whiter than the water round them. Probes: the same
//                       coverage measure on the 4 m/s harbour, and the
//                       brightness measure on the ?flatwater frame.
//   sydney-harbour      a 4 m/s breeze DOES NOT. Beaufort 3 has no whitecaps;
//                       coverage there has a ceiling, probed with the windy
//                       frame.
//
// The foam mask comes from ?terrainDebug=18, for the same reason the water
// mask comes from =7.
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
// Re-measured when the sea state, the rough-surface Fresnel and the scene
// reflection landed (flat or probe, then the new water):
//
//   chicago-river-kerb  relative LC      0.0037    0.0847   >= 0.020 (kept)
//   chicago-river-kerb  luminance sd     28.70     20.75    DROPPED, see below
//   sydney-harbour      relative LC      0.0079    0.0053   <= 0.012 (kept)
//   sydney-harbour      luminance sd     39.35     43.41    >= 41.5
//   sydney-harbour      mirror ratio     0.931     1.034    >= 1.02 (kept)
//   chicago-river-kerb  skyline corr     -0.039    0.325    >= 0.15 (?nossr)
//   sf-bay-windy        whitecap cover   0.0003    0.0125   >= 0.005 (calm)
//   sydney-harbour      whitecap cover   0.0125    0.0003   <= 0.002 (windy)
//   sf-bay-windy        foam - ring lum  -0.9      80.5     >= 40
//
// The Chicago sd floor was dropped, not loosened: the river now mirrors the
// dark tower beside it, and a mirror of a dark wall is darker and more uniform
// than the old sky-only water, so the sd went DOWN past the flat frame's and
// no bound can sit between them. The claim it stood for (the river is not one
// value) is carried by the local contrast, 23x the flat frame's, and by the
// skyline correlation. The Sydney sd bound moved from 45 to 41.5, midway
// between its two new measurements: the rough-surface Fresnel takes some of
// the angular swing out of the far water, which is the physics, and the old
// number had been measured against a water with none.
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
  /** False where no sd floor separates flat from wave; see the table. */
  sdFloor: boolean;
}

const GATES: PoseGate[] = [
  { name: "chicago-river-kerb", lc: { kind: "floor", bound: 0.020 }, sd: 0, sdFloor: false, mirror: null },
  { name: "sydney-harbour", lc: { kind: "ceiling", bound: 0.012 }, sd: 41.5, sdFloor: true, mirror: 1.02 },
];

/** The pose the river reflection is asserted on, and its correlation floor. */
const REFLECT_POSE = "chicago-river-kerb";
const REFLECT_CORR = 0.15;
/** Rows of scene above, and of water below, the far waterline in each column. */
const REFLECT_BAND = 40;
/** Half-width in columns of the box the profiles are high-passed against. */
const REFLECT_HP = 60;

/** The breaking sea, and the breeze that must not break. */
const WINDY_POSE = "sf-bay-windy";
const CALM_POSE = "sydney-harbour";
const FOAM_FLOOR = 0.005;
const FOAM_CEILING = 0.002;
/** Foam luminance over the water within 6 px of it, 0..255. */
const FOAM_CONTRAST = 40;

/** Neighbour distance for the local contrast, in pixels. */
const LC_RADIUS = 2;

/** Run the existing screenshot harness once, for one query variant. */
async function shoot(outDir: string, query: string, port: number, dbg: number, poses: string[]): Promise<void> {
  const args = [
    "tools/shots.ts",
    "--only", poses.join(","),
    "--out", outDir,
    "--port", String(port),
    "--debug-port", String(dbg),
  ];
  if (query) args.push("--query", query);
  // See tools/verify-ground.ts: a profile of one's own on a shared GPU.
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
  return greyMask(path);
}

/** The same rule for any of the terrain's binary debug outputs; see waterMask. */
function greyMask(path: string): Uint8Array {
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

/**
 * Does the water under the far bank carry the skyline above it?
 *
 * For every column, the mean luminance of REFLECT_BAND rows of scene above the
 * first water pixel, and of REFLECT_BAND rows of water below it. Both profiles
 * are high-passed (minus their own box mean over 2 * REFLECT_HP + 1 columns)
 * and correlated. Raw, they correlate at 0.6 to 0.8 under every variant,
 * because a tower's shadow on the water and the sky gradient line up with the
 * scene above whatever the water does; the high-pass leaves the tower edges,
 * which only a reflection can copy.
 */
function skylineCorrelation(f: Frame, mask: Uint8Array): number {
  const A: number[] = [];
  const B: number[] = [];
  const H = REFLECT_BAND;
  for (let x = 0; x < f.w; x++) {
    let yt = -1;
    for (let y = 0; y < f.h - 4; y++) {
      const i = y * f.w + x;
      if (mask[i] && mask[i + f.w] && mask[i + 2 * f.w] && mask[i + 3 * f.w]) { yt = y; break; }
    }
    if (yt < H + 4 || yt + H + 4 >= f.h) continue;
    let a = 0, an = 0, b = 0, bn = 0;
    for (let k = 4; k <= H; k++) {
      const ia = (yt - k) * f.w + x;
      const ib = (yt + k) * f.w + x;
      if (!mask[ia]) { a += f.lum[ia]; an++; }
      if (mask[ib]) { b += f.lum[ib]; bn++; }
    }
    if (an < H / 2 || bn < H / 2) continue;
    A.push(a / an);
    B.push(b / bn);
  }
  const hp = (v: number[]): number[] => v.map((x, i) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - REFLECT_HP); k <= Math.min(v.length - 1, i + REFLECT_HP); k++) { s += v[k]; n++; }
    return x - s / n;
  });
  const a = hp(A);
  const b = hp(B);
  const n = a.length;
  // Too few columns with a waterline under scene is not a measurement.
  if (n < 100) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb || 1);
}

/** Fraction of the water pixels the foam mask covers. */
function foamCoverage(water: Uint8Array, foam: Uint8Array): number {
  let nw = 0, nf = 0;
  for (let i = 0; i < water.length; i++) if (water[i]) { nw++; if (foam[i]) nf++; }
  return nw ? nf / nw : 0;
}

/**
 * Mean luminance of the foam pixels minus that of the water within 6 px of
 * them. The mask says where the shader put foam; this says it was DRAWN, i.e.
 * that the foam term reaches the frame as something whiter than the sea
 * around it. A ring rather than all the water, so the glitter path and the
 * dark far field do not decide it.
 */
function foamContrast(f: Frame, water: Uint8Array, foam: Uint8Array): number {
  let sf = 0, cf = 0, sn = 0, cn = 0;
  for (let i = 0; i < f.lum.length; i++) {
    if (!water[i]) continue;
    if (foam[i]) { sf += f.lum[i]; cf++; continue; }
    let near = false;
    for (let d = -6; d <= 6 && !near; d += 3) {
      const a = i + d, b = i + d * f.w;
      if ((a >= 0 && a < foam.length && foam[a]) || (b >= 0 && b < foam.length && foam[b])) near = true;
    }
    if (near) { sn += f.lum[i]; cn++; }
  }
  return cf && cn ? sf / cf - sn / cn : 0;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots/water");
  const port = Number(arg("port", "5179"));
  const dbg = Number(arg("debug-port", "9413"));
  mkdirSync(outDir, { recursive: true });

  // `--reuse` measures frames already in --out instead of rendering them. It is
  // for working on the MEASUREMENT: three passes of the shot harness is eight
  // minutes, and nothing about tuning a bound needs the pictures taken again.
  const all = [...GATES.map((g) => g.name), WINDY_POSE];
  if (!has("reuse")) {
    console.log("rendering the wave water ...");
    await shoot(`${outDir}/wave`, "", port, dbg, all);
    console.log("rendering the flat water (?flatwater=1) ...");
    await shoot(`${outDir}/flat`, "flatwater=1", port, dbg, all);
    console.log("rendering the water mask (?terrainDebug=7) ...");
    await shoot(`${outDir}/mask`, "terrainDebug=7", port, dbg, all);
    console.log("rendering the river without its reflection (?nossr=1) ...");
    await shoot(`${outDir}/nossr`, "nossr=1", port, dbg, [REFLECT_POSE]);
    console.log("rendering the foam mask (?terrainDebug=18) ...");
    await shoot(`${outDir}/foam`, "terrainDebug=18", port, dbg, [WINDY_POSE, CALM_POSE]);
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
    if (g.sdFloor) {
      check(`${g.name}: luminance sd over water`, wave.sd >= g.sd, `${wave.sd.toFixed(2)} >= ${g.sd}`);
      probe(`${g.name}: luminance sd, ?flatwater`, flat.sd >= g.sd, `${flat.sd.toFixed(2)} >= ${g.sd}`);
    }

    if (g.mirror !== null) {
      // AND AT THE HORIZON IT IS A MIRROR.
      check(`${g.name}: grazing water against the sky`, mw >= g.mirror, `${mw.toFixed(3)} >= ${g.mirror}`);
      probe(`${g.name}: mirror ratio, ?flatwater`, mf >= g.mirror, `${mf.toFixed(3)} >= ${g.mirror}`);
    }
  }

  // THE RIVER MIRRORS THE SKYLINE.
  {
    const mask = waterMask(`${outDir}/mask/${REFLECT_POSE}.png`);
    const cw = skylineCorrelation(luminance(`${outDir}/wave/${REFLECT_POSE}.png`), mask);
    const cn = skylineCorrelation(luminance(`${outDir}/nossr/${REFLECT_POSE}.png`), mask);
    check(`${REFLECT_POSE}: water carries the skyline`, cw >= REFLECT_CORR, `${cw.toFixed(3)} >= ${REFLECT_CORR}`);
    probe(`${REFLECT_POSE}: skyline, ?nossr`, cn >= REFLECT_CORR, `${cn.toFixed(3)} >= ${REFLECT_CORR}`);
  }

  // AN 11 M/S SEA BREAKS AND A 4 M/S ONE DOES NOT.
  {
    const wWater = waterMask(`${outDir}/mask/${WINDY_POSE}.png`);
    const wFoam = greyMask(`${outDir}/foam/${WINDY_POSE}.png`);
    const cWater = waterMask(`${outDir}/mask/${CALM_POSE}.png`);
    const cFoam = greyMask(`${outDir}/foam/${CALM_POSE}.png`);
    const windy = foamCoverage(wWater, wFoam);
    const calm = foamCoverage(cWater, cFoam);
    check(`${WINDY_POSE}: whitecap coverage`, windy >= FOAM_FLOOR, `${windy.toFixed(4)} >= ${FOAM_FLOOR}`);
    probe(`${WINDY_POSE}: coverage, ${CALM_POSE}'s`, calm >= FOAM_FLOOR, `${calm.toFixed(4)} >= ${FOAM_FLOOR}`);
    check(`${CALM_POSE}: no whitecaps at 4 m/s`, calm <= FOAM_CEILING, `${calm.toFixed(4)} <= ${FOAM_CEILING}`);
    probe(`${CALM_POSE}: ceiling, ${WINDY_POSE}'s`, windy <= FOAM_CEILING, `${windy.toFixed(4)} <= ${FOAM_CEILING}`);
    const kw = foamContrast(luminance(`${outDir}/wave/${WINDY_POSE}.png`), wWater, wFoam);
    const kf = foamContrast(luminance(`${outDir}/flat/${WINDY_POSE}.png`), wWater, wFoam);
    check(`${WINDY_POSE}: foam is drawn white`, kw >= FOAM_CONTRAST, `${kw.toFixed(1)} >= ${FOAM_CONTRAST}`);
    probe(`${WINDY_POSE}: foam contrast, ?flatwater`, kf >= FOAM_CONTRAST, `${kf.toFixed(1)} >= ${FOAM_CONTRAST}`);
  }

  if (!has("keep")) rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
