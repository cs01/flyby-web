// Rendered-frame gate for the archetype facades and roofs, in the discipline of
// tools/verify-water.ts: every assertion is a literal measured on real frames,
// and every one has a vacuity probe that runs the OLD behaviour in the SAME
// binary and must fail it.
//
//   bun tools/verify-buildings.ts            (renders, then measures)
//   bun tools/verify-buildings.ts --reuse    (measures the last render)
//
// What is claimed:
//
//   1. STREET-LEVEL MATERIAL. From two metres a wall has detail: brick, joints,
//      stucco float, sills and sash bars. Measured as the relative local
//      contrast over the facade pixels (the buildingDebug=1 mask). Probe:
//      ?flatfacade=1, the pre-archetype wall, must fall under the floor.
//
//   2. NO SHIMMER FROM ALTITUDE. A photographed brick course is 67 mm, which
//      from 400 m is a fraction of a pixel; sampled without its mips it
//      aliases into a moire. The same local contrast over the facade pixels of
//      an aerial frame has a CEILING. Probe: ?nomip=1 must exceed it.
//
//   3. NIGHT WINDOWS. Manhattan at night was grey slabs with almost no lit
//      windows. The fraction of facade pixels that are lit windows (well above
//      the facade median and warm) has a floor. Probe: ?flatfacade=1.
//
//   4. ROOFS DIFFER. From straight above a city is roofs, and they were one
//      grey. The top-down frame is cut into roofs by the buildingDebug=3 mask
//      and each roof's mean colour taken; the spread of those means (sd of
//      luminance over the mean, and the mean chroma distance) has a floor.
//      Probes: ?oneroof=1 (one cover, one colour, same textures and features)
//      and ?flatfacade=1 (the old roof) must both fall under it.
//
//   5. SETBACK SILHOUETTES. The Empire State against the sky, from 700 m: the
//      top of the buildingDebug=4 mask in each column over the tower is its
//      skyline, and a setback tower's has many steps where a box has a few.
//      Counted as column-to-column jumps of 3 px or more. Probe: ?flatparts=1,
//      every building:part group put back to the one box the pack used to be.
//
//   6. SHOPFRONTS AT NIGHT. Seventh Avenue from the kerb: over the ground
//      storey (the buildingDebug=5 mask) the relative local contrast, which
//      the shop rooms, signs and shutters put there and a row of uniformly
//      glowing panels does not have. Probe: ?flatshop=1.

import { existsSync, mkdirSync } from "node:fs";
import { decodePng } from "./pixdiff";

declare const process: { argv: string[]; exit(code?: number): never };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(43)} ${detail}`);
  if (!ok) failures++;
}

// --- the bounds ----------------------------------------------------------------
// Each with what it measured when it was set (2026-10-24, 1280x720, scale 1).

/** Street-level relative local contrast over the facade, floor. */
const STREET_POSES = ["sf-street", "manhattan-7th"];
// Measured: sf-street 0.0306 (flat 0.0157), manhattan-7th 0.1147 (flat 0.0878;
// both rose from 0.070 / 0.056 when main's street and traffic work landed in
// the same frame, which is why the floor is per pose and re-measured).
// manhattan-7th re-measured 2026-10-25 without the facade reflection (below):
// 0.0909, flat 0.0666; the floor is 0.080, 20% over the flat facade and 12%
// under the archetype one. It is lower than 0.100 because the unit changed,
// not the wall: with the reflection in, the pair was 0.1186 and 0.1065.
const STREET_LC_FLOOR: Record<string, number> = { "sf-street": 0.023, "manhattan-7th": 0.080 };
/**
 * The street-level claim is measured without the facade's screen-space
 * reflection of the city (?nossr=1), both frames. Re-measured 2026-10-25: the
 * pack rebake in f04430c re-rolled 7th Avenue's facades, the near walls came
 * up curtain wall, and the city reflected in them is most of the local
 * contrast on the pose: 0.1186 with it and 0.0909 without, and on the flat
 * facade 0.1065 and 0.0666, so ?flatfacade=1 cleared the 0.100 floor and the
 * claim measured the reflection, not the wall. The reflection has its own
 * gate (tools/verify-glass.ts); this claim is about brick, joints and sills.
 */
const STREET_QUERY = "nossr=1";
/**
 * Shimmer from the air: mean |frame - frame moved NUDGE_M east| over the
 * facade, divided by the facade's mean luminance. A single frame cannot see
 * shimmer (the relative local contrast of an unmipped frame came out within 8%
 * of the mipped one, because window edges dominate it); a 0.3 m move shifts
 * band-limited detail by a fraction of a pixel and leaves it nearly unchanged,
 * while aliased detail reshuffles completely.
 */
const AERIAL_POSES = ["chicago-loop-day", "manhattan-rooftops"];
const NUDGE_M = 0.3;
// Measured: chicago-loop-day 0.0327 (unmipped 0.0432), manhattan-rooftops
// 0.0766 (unmipped 0.1035). Most of what remains is the window grid's own
// edges, which predate this work; the ceiling sits between the two.
const AERIAL_SHIMMER_CEILING: Record<string, number> = { "chicago-loop-day": 0.038, "manhattan-rooftops": 0.090 };
/** Lit-window share of the facade on the Manhattan night pose, floor. */
const NIGHT_POSE = "manhattan-night";
// Measured 12.0%; the pre-archetype night 0.76%.
const NIGHT_LIT_FLOOR = 0.05;
/**
 * Night shimmer ceiling: see the aerial shimmer above. Measured 0.0840 with the
 * box-filtered windows and the softened tenancy blocks (0.1016 before the
 * softening), 0.1785 point-sampled (?nomip=1). Part of what is left is honest
 * parallax: the near blocks really do move by a pixel or two.
 */
const NIGHT_SHIMMER_CEILING = 0.11;
/** Roof spread: sd(lum)/mean(lum) of per-roof means, and mean chroma distance. */
const ROOF_POSES = ["manhattan-topdown", "sf-topdown"];
// Measured 0.466 Manhattan, 0.445 SF; one cover 0.175 / 0.102; the old roof 0.167 / 0.047.
const ROOF_SPREAD_FLOOR = 0.30;
/** Roofs under this many pixels are not measured: their mean is mostly edge. */
const ROOF_MIN_PX = 60;

/** The skyline claim: pose, the tower's column window, and the step floor. */
const SKYLINE_POSE = "manhattan-esb-skyline";
const SKYLINE_COLS: [number, number] = [600, 700];
const SKYLINE_STEP_PX = 3;
// Measured 2026-10-24: 13 steps with the parts, 4 as one box (?flatparts=1).
const SKYLINE_STEPS_FLOOR = 8;
/** The shopfront claim: relLC over the ground storey at night, floor. */
const SHOP_POSE = "manhattan-shops-night";
// Measured 0.0606 with the shop rooms, signs and shutters, 0.0399 without.
const SHOP_LC_FLOOR = 0.05;

const LC_RADIUS = 2;

async function shoot(outDir: string, query: string, poses: string[], port: number, dbg: number, profile: string, nudge = 0): Promise<void> {
  // --resume skips a variant whose frames are all on disk already: on a shared
  // GPU box a long render set gets interrupted, and the frames it did finish
  // are as good as new ones.
  if (has("resume") && poses.every((p) => existsSync(`${outDir}/${p}.png`))) {
    console.log(`  (resuming: ${outDir} already rendered)`);
    return;
  }
  const args = ["tools/shots.ts", "--only", poses.join(","), "--out", outDir,
    "--port", String(port), "--debug-port", String(dbg), "--profile", profile];
  // Every variant without the city's skyglow (render/skyglow.ts). It is an
  // additive veil over the night facades (their median went 15.3 -> 21.0 on
  // manhattan-night), and the night claims divide by the facade's mean and
  // median: the veil cut the unmipped twinkle probe from 0.128 to 0.098 and
  // the lit share from 15% to 10% with not one window changed. These claims
  // are about the windows; tools/verify-skyglow.ts gates the veil. By day the
  // glow is zero and the flag changes nothing.
  args.push("--query", query ? `${query}&noskyglow=1` : "noskyglow=1");
  if (nudge) args.push("--nudge", String(nudge));
  const p = Bun.spawn(["bun", ...args], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit",
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`shots.ts exited ${code} for query "${query || "(none)"}"`);
}

interface Img { w: number; h: number; data: Uint8Array }
const load = (path: string): Img => decodePng(path) as Img;
const lumAt = (img: Img, i: number): number =>
  0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];

/** Facade pixels from the buildingDebug=1 frame: blue, two dead channels. */
function facadeMask(path: string): Uint8Array {
  const img = load(path);
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    m[i] = r <= 3 && g <= 3 && b >= 60 ? 1 : 0;
  }
  return m;
}

/** Green-marker mask (buildingDebug=4 and =5). */
function greenMask(path: string): Uint8Array {
  const img = load(path);
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) {
    m[i] = img.data[i * 4] < 40 && img.data[i * 4 + 1] > 120 && img.data[i * 4 + 2] < 40 ? 1 : 0;
  }
  return m;
}

/** Column-to-column jumps of the skyline (topmost building pixel) in a window. */
function skylineSteps(path: string, cols: [number, number]): number {
  const img = load(path);
  const m = greenMask(path);
  let steps = 0, prev = -1;
  for (let x = cols[0]; x < cols[1]; x++) {
    let top = img.h;
    for (let y = 0; y < img.h; y++) if (m[y * img.w + x]) { top = y; break; }
    if (prev >= 0 && Math.abs(top - prev) >= SKYLINE_STEP_PX) steps++;
    prev = top;
  }
  return steps;
}

/** Relative local contrast over a mask: mean |p - mean of 4 neighbours| / mean p. */
function relLC(img: Img, mask: Uint8Array): { lc: number; n: number } {
  const d = LC_RADIUS;
  let s = 0, m = 0, n = 0;
  for (let y = d; y < img.h - d; y++) {
    for (let x = d; x < img.w - d; x++) {
      const i = y * img.w + x;
      if (!mask[i] || !mask[i - d] || !mask[i + d] || !mask[i - d * img.w] || !mask[i + d * img.w]) continue;
      const p = lumAt(img, i);
      const nb = (lumAt(img, i - d) + lumAt(img, i + d) + lumAt(img, i - d * img.w) + lumAt(img, i + d * img.w)) / 4;
      s += Math.abs(p - nb);
      m += p;
      n++;
    }
  }
  return { lc: m > 0 ? s / m : 0, n };
}

function shimmer(a: Img, b: Img, mask: Uint8Array): number {
  let d = 0, m = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const la = lumAt(a, i);
    d += Math.abs(la - lumAt(b, i));
    m += la;
  }
  return m > 0 ? d / m : 0;
}

/** Share of facade pixels that are lit windows. */
function litShare(img: Img, mask: Uint8Array): number {
  const lums: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) lums.push(lumAt(img, i));
  if (!lums.length) return 0;
  const sorted = [...lums].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Lit: three times the facade median and at least 45/255, and warmer than
  // it is blue. A grey wall lit by skyglow is none of the three.
  let lit = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    n++;
    const l = lumAt(img, i);
    if (l > Math.max(45, 3 * median) && img.data[i * 4] >= img.data[i * 4 + 2]) lit++;
  }
  return lit / n;
}

/** Roofs as connected components of one colour class in the buildingDebug=3 frame. */
function roofSpread(beautyPath: string, maskPath: string): { spread: number; chroma: number; roofs: number } {
  const mask = load(maskPath);
  const img = load(beautyPath);
  const w = mask.w, h = mask.h;
  const cls = new Int8Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    const r = mask.data[i * 4] > 90 ? 1 : mask.data[i * 4] < 25 ? 0 : -9;
    const g = mask.data[i * 4 + 1] > 90 ? 1 : mask.data[i * 4 + 1] < 25 ? 0 : -9;
    const b = mask.data[i * 4 + 2] > 90 ? 1 : mask.data[i * 4 + 2] < 25 ? 0 : -9;
    const c = r * 4 + g * 2 + b;
    if (c > 0 && c < 7) cls[i] = c;
  }
  const seen = new Uint8Array(w * h);
  const means: [number, number, number][] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (cls[i] < 0 || seen[i]) continue;
    let sr = 0, sg = 0, sb = 0, n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      sr += img.data[j * 4]; sg += img.data[j * 4 + 1]; sb += img.data[j * 4 + 2]; n++;
      const x = j % w, y = (j - x) / w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && !seen[k] && cls[k] === cls[i]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (n >= ROOF_MIN_PX) means.push([sr / n, sg / n, sb / n]);
  }
  if (means.length < 10) return { spread: 0, chroma: 0, roofs: means.length };
  const L = means.map(([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b);
  const mL = L.reduce((a, b) => a + b, 0) / L.length;
  const sd = Math.sqrt(L.reduce((a, b) => a + (b - mL) ** 2, 0) / L.length);
  // Chroma: each roof's colour with its luminance divided out, distance from
  // the mean chromaticity. A city of grey roofs at many brightnesses has
  // spread and no chroma; tar, gravel, sedum and clay tile have both.
  const chrom = means.map(([r, g, b]) => { const s = r + g + b + 1e-3; return [r / s, g / s]; });
  const cr = chrom.reduce((a, c) => a + c[0], 0) / chrom.length;
  const cg = chrom.reduce((a, c) => a + c[1], 0) / chrom.length;
  const chroma = chrom.reduce((a, c) => a + Math.hypot(c[0] - cr, c[1] - cg), 0) / chrom.length;
  return { spread: sd / mL, chroma, roofs: means.length };
}

async function main(): Promise<void> {
  const out = arg("out", "shots/buildings");
  const port = Number(arg("port", "5187"));
  const dbg = Number(arg("debug-port", "9451"));
  const profile = arg("profile", "/tmp/flyby-bldg-profile");
  mkdirSync(out, { recursive: true });

  const all = [...STREET_POSES, ...AERIAL_POSES, NIGHT_POSE, ...ROOF_POSES];
  if (!has("reuse")) {
    console.log("rendering the archetype facades ...");
    await shoot(`${out}/full`, "", all.filter((p) => !STREET_POSES.includes(p)), port, dbg, profile);
    await shoot(`${out}/full`, STREET_QUERY, STREET_POSES, port, dbg, profile);
    console.log("rendering the pre-archetype facades (?flatfacade=1) ...");
    await shoot(`${out}/flat`, "flatfacade=1", [NIGHT_POSE, ...ROOF_POSES], port, dbg, profile);
    await shoot(`${out}/flat`, `flatfacade=1&${STREET_QUERY}`, STREET_POSES, port, dbg, profile);
    console.log("rendering the scans without mips (?nomip=1) ...");
    await shoot(`${out}/nomip`, "nomip=1", [...AERIAL_POSES, NIGHT_POSE], port, dbg, profile);
    console.log(`rendering the aerial and night poses ${NUDGE_M} m east, filtered and not ...`);
    await shoot(`${out}/full-nudge`, "", [...AERIAL_POSES, NIGHT_POSE], port, dbg, profile, NUDGE_M);
    await shoot(`${out}/nomip-nudge`, "nomip=1", [...AERIAL_POSES, NIGHT_POSE], port, dbg, profile, NUDGE_M);
    console.log("rendering one roof for every building (?oneroof=1) ...");
    await shoot(`${out}/oneroof`, "oneroof=1", ROOF_POSES, port, dbg, profile);
    console.log("rendering the facade mask (?buildingDebug=1) ...");
    await shoot(`${out}/mask`, "buildingDebug=1", [...STREET_POSES, ...AERIAL_POSES, NIGHT_POSE], port, dbg, profile);
    console.log("rendering the roof mask (?buildingDebug=3) ...");
    await shoot(`${out}/roofmask`, "buildingDebug=3", ROOF_POSES, port, dbg, profile);
    console.log("rendering the skyline mask, with parts and as boxes (?buildingDebug=4, ?flatparts=1) ...");
    await shoot(`${out}/skyline`, "buildingDebug=4", [SKYLINE_POSE], port, dbg, profile);
    await shoot(`${out}/skyline-flat`, "buildingDebug=4&flatparts=1", [SKYLINE_POSE], port, dbg, profile);
    console.log("rendering the shopfronts and their mask (?flatshop=1, ?buildingDebug=5) ...");
    await shoot(`${out}/shop`, "", [SHOP_POSE], port, dbg, profile);
    await shoot(`${out}/shop-flat`, "flatshop=1", [SHOP_POSE], port, dbg, profile);
    await shoot(`${out}/shopmask`, "buildingDebug=5", [SHOP_POSE], port, dbg, profile);
    console.log("");
  }

  for (const p of STREET_POSES) {
    const mask = facadeMask(`${out}/mask/${p}.png`);
    const full = relLC(load(`${out}/full/${p}.png`), mask);
    const flat = relLC(load(`${out}/flat/${p}.png`), mask);
    const f = STREET_LC_FLOOR[p];
    check(`${p}: street-level material detail`, full.lc >= f, `relLC ${full.lc.toFixed(4)} >= ${f} over ${full.n} px`);
    probe(`${p}: the flat facade has none`, flat.lc >= f, `relLC ${flat.lc.toFixed(4)} must fall under ${f}`);
  }

  for (const p of AERIAL_POSES) {
    const mask = facadeMask(`${out}/mask/${p}.png`);
    const full = shimmer(load(`${out}/full/${p}.png`), load(`${out}/full-nudge/${p}.png`), mask);
    const nomip = shimmer(load(`${out}/nomip/${p}.png`), load(`${out}/nomip-nudge/${p}.png`), mask);
    const c = AERIAL_SHIMMER_CEILING[p];
    check(`${p}: no shimmer from altitude`, full <= c, `${full.toFixed(4)} <= ${c} for a ${NUDGE_M} m move`);
    probe(`${p}: unmipped scans shimmer`, nomip <= c, `${nomip.toFixed(4)} must exceed ${c}`);
  }

  {
    const mask = facadeMask(`${out}/mask/${NIGHT_POSE}.png`);
    const full = litShare(load(`${out}/full/${NIGHT_POSE}.png`), mask);
    const flat = litShare(load(`${out}/flat/${NIGHT_POSE}.png`), mask);
    // Night shimmer: the same 0.3 m move. Lit windows are the brightest small
    // things in the frame, and a per-cell on/off sampled at a pixel twinkles.
    const sh = shimmer(load(`${out}/full/${NIGHT_POSE}.png`), load(`${out}/full-nudge/${NIGHT_POSE}.png`), mask);
    const shSharp = shimmer(load(`${out}/nomip/${NIGHT_POSE}.png`), load(`${out}/nomip-nudge/${NIGHT_POSE}.png`), mask);
    check(`${NIGHT_POSE}: night windows are steady`, sh <= NIGHT_SHIMMER_CEILING, `${sh.toFixed(4)} <= ${NIGHT_SHIMMER_CEILING} for a ${NUDGE_M} m move`);
    probe(`${NIGHT_POSE}: point-sampled windows twinkle`, shSharp <= NIGHT_SHIMMER_CEILING, `${shSharp.toFixed(4)} must exceed ${NIGHT_SHIMMER_CEILING}`);
    check(`${NIGHT_POSE}: lit windows`, full >= NIGHT_LIT_FLOOR, `${(100 * full).toFixed(2)}% of the facade >= ${100 * NIGHT_LIT_FLOOR}%`);
    probe(`${NIGHT_POSE}: the old night had few`, flat >= NIGHT_LIT_FLOOR, `${(100 * flat).toFixed(2)}% must fall under ${100 * NIGHT_LIT_FLOOR}%`);
  }

  for (const p of ROOF_POSES) {
    const m = `${out}/roofmask/${p}.png`;
    const full = roofSpread(`${out}/full/${p}.png`, m);
    const one = roofSpread(`${out}/oneroof/${p}.png`, m);
    const flat = roofSpread(`${out}/flat/${p}.png`, m);
    check(`${p}: roofs differ`, full.spread >= ROOF_SPREAD_FLOOR,
      `spread ${full.spread.toFixed(3)} chroma ${full.chroma.toFixed(4)} over ${full.roofs} roofs (floor ${ROOF_SPREAD_FLOOR})`);
    probe(`${p}: one roof material is uniform`, one.spread >= ROOF_SPREAD_FLOOR, `spread ${one.spread.toFixed(3)} chroma ${one.chroma.toFixed(4)}`);
    probe(`${p}: the old roofs were uniform`, flat.spread >= ROOF_SPREAD_FLOOR, `spread ${flat.spread.toFixed(3)} chroma ${flat.chroma.toFixed(4)}`);
  }

  {
    const full = skylineSteps(`${out}/skyline/${SKYLINE_POSE}.png`, SKYLINE_COLS);
    const flat = skylineSteps(`${out}/skyline-flat/${SKYLINE_POSE}.png`, SKYLINE_COLS);
    check(`${SKYLINE_POSE}: setbacks in the silhouette`, full >= SKYLINE_STEPS_FLOOR,
      `${full} steps of ${SKYLINE_STEP_PX}+ px over columns ${SKYLINE_COLS.join("-")} (floor ${SKYLINE_STEPS_FLOOR})`);
    probe(`${SKYLINE_POSE}: one box per tower`, flat >= SKYLINE_STEPS_FLOOR, `${flat} steps must fall under ${SKYLINE_STEPS_FLOOR}`);
  }

  {
    const mask = greenMask(`${out}/shopmask/${SHOP_POSE}.png`);
    const full = relLC(load(`${out}/shop/${SHOP_POSE}.png`), mask);
    const flat = relLC(load(`${out}/shop-flat/${SHOP_POSE}.png`), mask);
    check(`${SHOP_POSE}: shopfronts have something in them`, full.lc >= SHOP_LC_FLOOR,
      `relLC ${full.lc.toFixed(4)} >= ${SHOP_LC_FLOOR} over ${full.n} ground-storey px`);
    probe(`${SHOP_POSE}: glowing panels do not`, flat.lc >= SHOP_LC_FLOOR, `relLC ${flat.lc.toFixed(4)} must fall under ${SHOP_LC_FLOOR}`);
  }

  console.log(failures ? `\n${failures} building check(s) FAILED` : "\nall building checks ok");
  if (failures) process.exit(1);
}

await main();
