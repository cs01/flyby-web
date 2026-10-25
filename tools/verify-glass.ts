// The gate on glass: is a facade a wall with holes in it or a sheet of paper
// with a grid printed on it, and is the glass in those holes a MIRROR or a
// painted panel. Two pieces of work, two halves of this file, one harness.
//
// WHY THIS IS NOT IN `bun run check`. Everything check runs is offline and
// Chrome-free, and it has to stay that way: it runs on every change, and there
// is no GPU under Bun. This measures a RENDERED FRAME, so it needs a browser, a
// GPU and a vite server. There is also nothing else it could be. The defect
// lives entirely in a fragment shader -- the CPU side (facadeFor) already
// produced the right numbers and is gated by test/facade.check.ts, whose sweep
// over every building in every pack is untouched by this work. So this is its
// own script, `bun run glass`, run when the facade shader is touched.
//
// WHAT WAS WRONG. The glazing sat exactly in the plane of the wall. A real
// window is set back 100-250 mm, and that reveal is what casts the line under
// every head and down one jamb; at a grazing angle it is most of what tells the
// eye the wall has thickness. With the glass in the wall plane there is no
// surface for any of it to fall on, so no amount of pattern work reaches it and
// a Chicago or Manhattan tower reads as painted concrete. The fix is a parallax
// offset of the glass along the view vector in the wall's own tangent frame,
// plus the aperture's own shadow on the plane it is recessed to.
//
// GATE DISCIPLINE, as in tools/verify-water.ts and test/facade.check.ts. Every
// bound below is a LITERAL, and every literal sits between the two numbers the
// run prints beside it, both of them measured before the bound was written
// down. Every assertion is paired with a VACUITY PROBE that must FAIL it. Two
// kinds are used:
//
//   * `?flatglass=1` restores the pre-reveal facade in the SAME binary, so an
//     assertion that would pass either way is caught immediately;
//   * the LOD CEILINGS have no such flag, because the honest opposite of "this
//     is correctly smooth at 500 m" is not "old code", it is "a frame where the
//     detail is legitimately resolved". So each ceiling is probed against the
//     SAME measurement on the Manhattan frame, which is far over it. A ceiling
//     nothing can exceed measures nothing.
//
// TWO POSES, ASSERTING OPPOSITE THINGS ON PURPOSE.
//
//   manhattan-7th     65 m in the 7th Avenue canyon, looking south down it at
//                     11:00. Every wall in the frame is seen at a grazing angle
//                     and the facade fills 86% of it. This is the pose the
//                     defect was reported from, and grazing is the condition
//                     the whole effect needs: looked at square on, a 100 mm
//                     setback displaces the glass by 100 mm and there is
//                     nothing to see. Floors.
//   hongkong-central  500 m over Victoria Harbour. A 1.6 m window column is
//                     well under a pixel at that range, so every reveal in the
//                     frame is sub-pixel and the only correct answer is smooth.
//                     Ceilings. This is the aliasing check: deleting the fwidth
//                     fade in the facade branch is exactly what would break it.
//
// POSES THAT WERE TRIED AND REJECTED, because a pose set that cannot see the
// thing under test reports every version of it as fine:
//
//   sf-street     the near facade filling that frame is entirely GROUND STOREY.
//                 The shopfront band draws its own geometry and has no reveal,
//                 so the pose photographs the one part of a wall this change
//                 does not touch. Measured 0.0307 -> 0.0320 vertical contrast,
//                 which is the far buildings and nothing else.
//   sf-vanness    105 m up the avenue, and almost every facade in it is seen
//                 square on rather than along. Measured 0.1369 -> 0.1374: the
//                 parallax term is proportional to the tangent of the angle off
//                 normal, and at this pose that tangent is near zero.
//
// TWO THINGS ARE MEASURED, and they are different claims about depth.
//
//   VERTICAL LOCAL CONTRAST. A high-pass along the facade's vertical axis --
//   which is the image's vertical axis, these poses having no roll and little
//   pitch. It answers "is there a hard horizontal line at each window head",
//   which is the head of the opening shading the glass behind it.
//
//   HORIZONTAL LOCAL CONTRAST. The same high-pass across the wall, and this is
//   the one that measures DEPTH rather than "something changed". At a grazing
//   angle the wall overhangs its own glass on the near side of every opening
//   and exposes the jamb on the far side, so a vertical strip of reveal appears
//   down one side of every window -- a surface a facade with its glass in the
//   wall plane HAS NO PIXELS FOR. It is the largest signal in the set, and it
//   has to stay absent at 500 m.
//
// AND EACH IS TAKEN TWO WAYS, because the two questions want different units.
// The FLOORS are absolute, in luminance out of 255. The CEILINGS are relative
// to the mean over the same pixels. That split is not tidiness, it is a defect
// this file had and the reflection work exposed:
//
//   Both numbers were originally relative, on the argument that a wall in
//   shadow should not score as flat merely for being dark. True, and it has an
//   inverse nobody wrote down: a wall that gets BRIGHTER scores as flatter.
//   Putting the real reflectance of glazing on a curtain wall raised mean
//   facade luminance on manhattan-7th from 26.2 to 37.5, and the relative jamb
//   number fell from 0.1395 to 0.1046 -- a 25% drop on a frame whose reveal
//   code had not been touched. The ABSOLUTE jamb number over the same pixels
//   went 3.976 -> 3.917, which is the truth: the strip of jamb is still there,
//   there is simply more light on the wall around it. A depth gate that reads a
//   lighting change as a loss of depth is measuring the wrong thing.
//
//   The ceilings keep the relative form, and have to. They compare one pose
//   with ANOTHER at fifteen times the range, and the two frames sit at very
//   different light levels: hongkong-central's facades mean 66 against
//   manhattan-7th's 37. In absolute units the Hong Kong jamb number is 3.911
//   and the Manhattan one 3.917, so the ceiling's own vacuity probe would clear
//   it by 0.15% and prove nothing. Relative, the same pair is 0.059 against
//   0.105. Absolute is the right unit for a before and an after in ONE frame;
//   relative is the right unit across two.
//
// WHAT WAS TRIED AND COULD NOT BE DEFENDED. The obvious asymmetry test -- that
// the shaded jamb is systematically darker than the lit one, so the skew of the
// horizontal gradient over facade pixels moves away from zero -- was measured
// and is FALSE as stated. A facade with its glass in the wall plane is already
// strongly skewed (-1.52 on this pose) because perspective and the canyon's own
// one-wall-lit shading are asymmetric long before any window is. The reveal
// actually moves that skew TOWARD zero (-0.14), by adding the mirrored edge the
// flat wall was missing. A bound on it would have been a bound on the canyon's
// lighting, so it is not asserted; the jamb's horizontal contrast is the same
// claim in a form the frame can actually support.
//
// THE FACADE MASK IS NOT GUESSED. Each pose is rendered a third time with
// `?buildingDebug=1`, which makes the building shader emit pure blue on its
// FACADE fragments and nothing else, so "which pixels are wall" is answered by
// the shader that decides it. Roofs, parapets, gables, terrain and sky are
// excluded by construction, and the buildings still occlude exactly what they
// occlude in the beauty frame, so mask and frame agree pixel for pixel.
//
// --- THE SECOND HALF: THE REFLECTION ----------------------------------------
//
// WHAT WAS WRONG, and it was NOT the radiance. The sky probe was already
// directional and already captured through the same atmosphere the dome runs,
// and swapping it for a non-directional one moved mean facade luminance on
// chicago-loop-day by 1.3%. What limited it was the REFLECTANCE: one flat
// F0 of 0.04 for every wall in the city, which is a single air/glass interface,
// i.e. bare float glass. No commercial tower is glazed in bare float glass. A
// curtain wall is a coated insulating unit at 0.22 and a punched masonry sash
// over a dark room is 0.05, and those are now per-family numbers out of the
// facade table (see the note on f0 in src/render/facade.ts). The probe's lower
// hemisphere -- one sunlit ground plane, because the probe has no geometry in
// it -- is darkened by the measured built-ness field from render/urbanmask.ts,
// so a downward reflected ray downtown returns dark building mass instead of
// open prairie.
//
// `?flatrefl=1` restores BOTH of those, in the same binary, and it is the
// vacuity probe for everything below. It is separate from `?flatglass=1`
// because they are separate claims about the same wall.
//
// THE POSE THAT WAS ADDED, and one that is only a control:
//
//   chicago-loop-day   420 m over the river looking into the Loop. Curtain wall
//                      everywhere and the camera ABOVE most of it, which is the
//                      condition the ground half of the probe is wrong under:
//                      every wall below eye level reflects downward. Carries
//                      the grazing-versus-square-on floor.
//   sf-residential     175 m over Pacific Heights: three-storey Victorians,
//                      brick and stucco, almost no curtain wall in the frame.
//                      This is the CEILING pose. "Every wall in the city got
//                      shinier" is the failure mode a reflectance change has,
//                      and this frame is where it would show.
//
// WHAT WAS TRIED AND IS FALSE AS STATED. The obvious Fresnel assertion is that
// GRAZING faces come out brighter than square-on ones, and that the change
// widens that gap. Measured, the gap NARROWS: manhattan-7th grazing/square-on
// 1.016 -> 0.889, chicago-loop-day 1.655 -> 1.368. That is not a defect, it is
// Schlick. At grazing incidence the term runs to 1 whatever F0 is, so the two
// versions agree there and the entire difference between them lands SQUARE ON,
// where 0.04 became 0.22. The change is a square-on change. So the assertion is
// inverted into the form the frames support -- square-on glass gains ON the
// grazing glass beside it, in one frame -- and that is what is bounded below.
//
// WHICH FACES ARE GRAZING IS NOT GUESSED EITHER. `?buildingDebug=2` is the same
// facade marker narrowed to the fragments whose FACE is more than 60 degrees off
// the view, so the split is made by the shader that owns the normal rather than
// by boxes drawn on a frame. Mode 1 minus mode 2 is the square-on set.
//
//   bun run glass
//   bun tools/verify-glass.ts --out shots/glass --keep

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
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(48)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(39)} ${detail}`);
  if (!ok) failures++;
}

// --- THE BOUNDS ------------------------------------------------------------
//
// Measured both ways on an M-series laptop before they were written down. The
// run prints the flat and recessed numbers next to each one, so a bound that
// has drifted out from between its two measurements shows in the output rather
// than only in a red line.
//
//   pose              measure         flat     recessed   bound
//   manhattan-7th     head, absolute  4.104    4.410      >= 4.25
//   manhattan-7th     jamb, absolute  2.942    3.917      >= 3.45
//   hongkong-central  head, relative  0.0292   0.0283     <= 0.045
//   hongkong-central  jamb, relative  0.0626   0.0591     <= 0.090
//
// The jamb bound has the separation the effect deserves: 17% clear of the flat
// facade and 12% under the recessed one. The head bound is TIGHT -- 3.6% either
// side -- and that is not carelessness, it is the size of the thing. A 115 mm
// reveal on a 3.9 m storey is a band 3% of a floor high, and it is competing
// with a storey line the facade already draws at every slab. It is a usable
// bound only because the harness pins the camera, the clock, the weather and
// the render scale, and its own --repeat check reports these poses byte
// identical between runs.
//
// THE HEAD BOUND IS ALSO NARROWER THAN IT WAS, from 5.7% either side to 3.6%,
// and the reason is worth recording because the next change to the glass will
// narrow it again. Real glazing reflectance put a hard radiance step at every
// window band edge, and a window band edge is HORIZONTAL, which is exactly what
// a vertical high-pass sees: on the flat facade the head measure rose 2.897 ->
// 4.104 with no reveal in the frame at all. The reveal's own head line is now a
// smaller share of a bigger number. It still separates and its probe still
// fails, so it stays; if it erodes further it should be deleted rather than
// shaved, because a floor the flat facade nearly clears is not a gate.
//
// Both ceilings sit ABOVE the flat facade's own number as well as above the
// recessed one, which is deliberate: at 500 m the correct answer is that
// nothing changed, and a ceiling the flat frame would fail would be asserting
// that the old code aliased rather than that the new code does not.
interface PoseGate {
  name: string;
  kind: "floor" | "ceiling";
  /**
   * Vertical local contrast over facade pixels: the window head.
   *
   * ABSOLUTE luminance on a floor, RELATIVE to the mean over the same pixels on
   * a ceiling. See the header for why the two are not the same unit.
   */
  vlc: number;
  /** Horizontal local contrast over facade pixels: the jamb. Same units rule. */
  hlc: number;
}

const GATES: PoseGate[] = [
  { name: "manhattan-7th", kind: "floor", vlc: 4.25, hlc: 3.45 },
  { name: "hongkong-central", kind: "ceiling", vlc: 0.045, hlc: 0.090 },
];

// --- THE REFLECTION BOUNDS --------------------------------------------------
//
// Same discipline: measured both ways on an M-series laptop before they were
// written down, and the run prints the flat and the reflecting number next to
// each one.
//
//   pose              measure          flatrefl   reflecting   bound
//   manhattan-7th     top/bottom       1.1920     1.4360       >= 1.32
//   chicago-loop-day  square/grazing   0.6042     0.7312       >= 0.67
//   sf-residential    mean gain          --       0.9983       <= 1.02
//
// TOP OVER BOTTOM is the directional test. A wall pixel ABOVE the camera
// reflects upward into the sky; one BELOW it reflects downward into the city.
// Nothing but a directional reflection puts those two on different sides of a
// ratio, and a facade shaded from an ambient term alone cannot: it has one
// answer for the whole wall. Taken over the top and bottom FIFTHS of the facade
// pixels by row, not of the frame, so it measures the walls and not how much
// sky the pose happens to include. 10.7% clear of the flat frame and 8.1% under
// the reflecting one.
//
// SQUARE-ON OVER GRAZING is the Fresnel test, in the direction the frames
// actually support (see the header). At grazing incidence Schlick returns ~1
// for both versions, so the grazing set is very nearly a CONTROL held fixed
// across the change, and the ratio is close to a direct read of what F0 did to
// the rest of the wall. 10.9% clear of flat, 8.4% under reflecting.
//
// THE MEAN GAIN CEILING is the one that says the change was aimed. It is the
// ratio of mean facade luminance with the reflection to mean facade luminance
// under ?flatrefl=1, on a frame that is almost entirely brick and stucco: the
// glazing there is a punched sash whose F0 moved 0.04 -> 0.05, so the honest
// answer is "nothing happened", and it measures 0.9983. Its vacuity probe is
// not ?flatrefl -- that would be a frame compared with itself, which is 1.000
// by construction and proves nothing. It is the SAME ratio on chicago-loop-day,
// which is 1.1803 and far over the ceiling, in the manner of the LOD ceilings
// above: the honest opposite of "this frame did not change" is a frame that
// legitimately did.
interface ReflGate {
  name: string;
  /** Mean facade luminance, top fifth of facade rows over bottom fifth. */
  vgrad?: number;
  /** Mean facade luminance, square-on faces over grazing faces, one frame. */
  fresnel?: number;
  /** Ceiling on mean facade luminance with the reflection over without it. */
  gain?: number;
}

const REFL_GATES: ReflGate[] = [
  { name: "manhattan-7th", vgrad: 1.32 },
  { name: "chicago-loop-day", fresnel: 0.67 },
  { name: "sf-residential", gain: 1.02 },
];

/** The pose whose mean gain probes the sf-residential ceiling. */
const GAIN_PROBE_POSE = "chicago-loop-day";

/**
 * Fraction of facade pixels, by row, in each end of the top/bottom ratio.
 *
 * A fifth at each end and not a half: the middle of these frames is where the
 * two reflections MEET, and including it in both terms only dilutes them. A
 * tenth was tried and is noisier for no more separation (1.0176 -> 1.1954 on
 * manhattan-7th at a tenth, against 1.1920 -> 1.4360 here) because the top
 * tenth of the canyon wall is its parapet and the sky behind it.
 */
const VGRAD_TAIL = 0.2;

/**
 * Neighbour distance for the high-pass, in pixels.
 *
 * Four, not one, and chosen by measurement: the jamb strip the parallax exposes
 * is several pixels wide on the near walls of the Manhattan pose, so a one-pixel
 * high-pass sees its interior as flat and scores it with the wall. At radius 4
 * the strip and the wall on either side of it fall in different samples, which
 * is where the flat and recessed frames separate most (vertical contrast moves
 * 1.010x at radius 2 against 1.116x here).
 */
const HP_RADIUS = 4;

/** Run the existing screenshot harness once, for one query variant. */
async function shoot(
  outDir: string,
  query: string,
  port: number,
  dbg: number,
  poses: string[],
): Promise<void> {
  const args = [
    "tools/shots.ts",
    "--only", poses.join(","),
    "--out", outDir,
    "--port", String(port),
    "--debug-port", String(dbg),
  ];
  if (query) args.push("--query", query);
  // Without this every run shared shots.ts's default profile, so `bun run gates`
  // could not keep one tile cache and two gates could fight over one profile.
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
 * Facade pixels, from the buildingDebug=1 frame: BLUE with two dead channels.
 *
 * The debug view writes vec3(0, 0, 1) on wall fragments and the frame is still
 * tone-mapped on the way out, so the marker lands near 181/255 in blue while
 * red and green stay at zero. Two dead channels is what rejects everything
 * else: sky, water, foliage and pale render all carry substantial red.
 */
function facadeMask(path: string): Uint8Array {
  const img = decodePng(path);
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    m[i] = r <= 25 && g <= 25 && b >= 120 ? 1 : 0;
  }
  return m;
}

interface Stats {
  n: number;
  mean: number;
  /**
   * Mean |L - (L above + L below)/2| over facade pixels, over the mean
   * luminance of the same pixels. The window HEAD is a horizontal edge and the
   * shadow it casts on the recessed glass is a horizontal band, so a high-pass
   * along the vertical axis is the one that sees it.
   *
   * A global standard deviation cannot answer this: a wall already varies over
   * tens of metres from aerial perspective and from the canyon's own shading,
   * and none of that is depth. A high-pass drops all of it.
   */
  vlc: number;
  /** The same across the wall. This is the jamb; see the header. */
  hlc: number;
  /** The same two high-passes in absolute luminance, 0..255. */
  vAbs: number;
  hAbs: number;
}

function stats(f: Frame, mask: Uint8Array): Stats {
  const d = HP_RADIUS;
  let n = 0;
  let sum = 0;
  let vSum = 0;
  let hSum = 0;
  for (let y = d; y < f.h - d; y++) {
    for (let x = d; x < f.w - d; x++) {
      const i = y * f.w + x;
      // Every neighbour has to be facade too, or the sample is a silhouette
      // against the sky rather than a measurement of a wall.
      if (!mask[i] || !mask[i - d] || !mask[i + d] || !mask[i - d * f.w] || !mask[i + d * f.w]) {
        continue;
      }
      vSum += Math.abs(f.lum[i] - (f.lum[i - d * f.w] + f.lum[i + d * f.w]) / 2);
      hSum += Math.abs(f.lum[i] - (f.lum[i - d] + f.lum[i + d]) / 2);
      sum += f.lum[i];
      n++;
    }
  }
  if (n === 0) return { n: 0, mean: 0, vlc: 0, hlc: 0, vAbs: 0, hAbs: 0 };
  return { n, mean: sum / n, vlc: vSum / sum, hlc: hSum / sum, vAbs: vSum / n, hAbs: hSum / n };
}

/** Mean luminance over the pixels a mask selects, and how many there were. */
function maskedMean(f: Frame, mask: Uint8Array): { mean: number; n: number } {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    sum += f.lum[i];
    n++;
  }
  return { mean: n ? sum / n : 0, n };
}

/**
 * Mean facade luminance in the top VGRAD_TAIL of facade rows over the bottom
 * VGRAD_TAIL, both weighted by how much facade each row holds.
 *
 * The cut rows come from the MASK, so the two ends always hold the same number
 * of facade pixels whatever the pose frames. A brightness change applied evenly
 * to the whole wall cancels in the ratio; only a reflection that answers
 * differently above and below the eye moves it.
 */
function vgrad(f: Frame, mask: Uint8Array): number {
  const perRow = new Int32Array(f.h);
  let total = 0;
  for (let y = 0; y < f.h; y++) {
    let c = 0;
    for (let x = 0; x < f.w; x++) if (mask[y * f.w + x]) c++;
    perRow[y] = c;
    total += c;
  }
  const cut = (frac: number): number => {
    let acc = 0;
    for (let y = 0; y < f.h; y++) {
      acc += perRow[y];
      if (acc >= frac * total) return y;
    }
    return f.h - 1;
  };
  const yTop = cut(VGRAD_TAIL);
  const yBot = cut(1 - VGRAD_TAIL);
  const band = (y0: number, y1: number): Uint8Array => {
    const m = new Uint8Array(mask.length);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < f.w; x++) m[y * f.w + x] = mask[y * f.w + x];
    }
    return m;
  };
  const bot = maskedMean(f, band(yBot, f.h)).mean;
  return bot > 0 ? maskedMean(f, band(0, yTop)).mean / bot : 0;
}

/** The square-on facade pixels: in the mask, out of the grazing mask. */
function squareOn(mask: Uint8Array, graze: Uint8Array): Uint8Array {
  const m = new Uint8Array(mask.length);
  for (let i = 0; i < m.length; i++) m[i] = mask[i] && !graze[i] ? 1 : 0;
  return m;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots/glass");
  const port = Number(arg("port", "5181"));
  const dbg = Number(arg("debug-port", "9415"));
  mkdirSync(outDir, { recursive: true });

  const revealPoses = GATES.map((g) => g.name);
  const reflPoses = REFL_GATES.map((g) => g.name);
  // Every pose either half measures, once, in the order the two lists give.
  const allPoses = [...revealPoses, ...reflPoses.filter((n) => !revealPoses.includes(n))];
  // Only chicago-loop-day splits its frame by face angle, so only it needs the
  // extra grazing pass; a pose list per pass rather than one for all of them is
  // what keeps this at fourteen renders instead of twenty.
  const grazePoses = REFL_GATES.filter((g) => g.fresnel !== undefined).map((g) => g.name);

  // `--reuse` measures frames already in --out instead of rendering them. It is
  // for working on the MEASUREMENT: five passes of the shot harness is several
  // minutes, and nothing about tuning a bound needs the pictures taken again.
  if (!has("reuse")) {
    console.log("rendering the recessed glazing ...");
    await shoot(`${outDir}/deep`, "", port, dbg, allPoses);
    console.log("rendering the flat glazing (?flatglass=1) ...");
    await shoot(`${outDir}/flat`, "flatglass=1", port, dbg, revealPoses);
    console.log("rendering the flat reflection (?flatrefl=1) ...");
    await shoot(`${outDir}/flatrefl`, "flatrefl=1", port, dbg, reflPoses);
    console.log("rendering the facade mask (?buildingDebug=1) ...");
    await shoot(`${outDir}/mask`, "buildingDebug=1", port, dbg, allPoses);
    console.log("rendering the grazing facade mask (?buildingDebug=2) ...");
    await shoot(`${outDir}/graze`, "buildingDebug=2", port, dbg, grazePoses);
    console.log("");
  }

  // The Manhattan numbers double as the vacuity probes for the Hong Kong
  // ceilings, so they are kept once every pose has been measured.
  const nearVlc: Record<string, number> = {};
  const nearHlc: Record<string, number> = {};
  const measured: { g: PoseGate; deep: Stats; flat: Stats; px: number }[] = [];

  for (const g of GATES) {
    const mask = facadeMask(`${outDir}/mask/${g.name}.png`);
    const deep = luminance(`${outDir}/deep/${g.name}.png`);
    const flat = luminance(`${outDir}/flat/${g.name}.png`);
    const sd = stats(deep, mask);
    const sf = stats(flat, mask);
    nearVlc[g.name] = sd.vlc;
    nearHlc[g.name] = sd.hlc;
    measured.push({ g, deep: sd, flat: sf, px: deep.w * deep.h });
    console.log(
      `${g.name.padEnd(18)} ${sd.n} facade px (${((100 * sd.n) / (deep.w * deep.h)).toFixed(1)}% of frame)  ` +
        `head ${sf.vAbs.toFixed(3)} -> ${sd.vAbs.toFixed(3)} (rel ${sf.vlc.toFixed(4)} -> ${sd.vlc.toFixed(4)})   ` +
        `jamb ${sf.hAbs.toFixed(3)} -> ${sd.hAbs.toFixed(3)} (rel ${sf.hlc.toFixed(4)} -> ${sd.hlc.toFixed(4)})   ` +
        `mean ${sf.mean.toFixed(1)} -> ${sd.mean.toFixed(1)}`,
    );
  }
  console.log("");

  for (const { g, deep, flat } of measured) {
    check(`${g.name}: enough facade to measure`, deep.n >= 60000, `${deep.n} px`);

    if (g.kind === "floor") {
      // THE HEAD CASTS A LINE. A facade with its glass in the wall plane has
      // nothing for that line to fall on.
      check(`${g.name}: head contrast on facades`, deep.vAbs >= g.vlc, `${deep.vAbs.toFixed(3)} >= ${g.vlc}`);
      probe(`${g.name}: head contrast, ?flatglass`, flat.vAbs >= g.vlc, `${flat.vAbs.toFixed(3)} >= ${g.vlc}`);

      // AND THE WALL OVERHANGS ITS OWN GLASS. This is the reported defect:
      // the strip of jamb a grazing view exposes is a surface the flat facade
      // does not have, and it is the largest number in the set.
      check(`${g.name}: jamb contrast on facades`, deep.hAbs >= g.hlc, `${deep.hAbs.toFixed(3)} >= ${g.hlc}`);
      probe(`${g.name}: jamb contrast, ?flatglass`, flat.hAbs >= g.hlc, `${flat.hAbs.toFixed(3)} >= ${g.hlc}`);
    } else {
      // AND NONE OF IT ALIASES. Every reveal in this frame is sub-pixel, so the
      // fwidth fade has to have taken the per-pixel structure back out and
      // rolled what it removed into the mean. Each probe is the same function
      // on the Manhattan frame, where the structure is legitimately resolved.
      const near = GATES.find((o) => o.kind === "floor")!;
      check(`${g.name}: head stays sub-pixel`, deep.vlc <= g.vlc, `${deep.vlc.toFixed(4)} <= ${g.vlc}`);
      probe(
        `${g.name}: head, same measure on ${near.name}`,
        nearVlc[near.name] <= g.vlc,
        `${nearVlc[near.name].toFixed(4)} <= ${g.vlc}`,
      );
      check(`${g.name}: jamb stays sub-pixel`, deep.hlc <= g.hlc, `${deep.hlc.toFixed(4)} <= ${g.hlc}`);
      probe(
        `${g.name}: jamb, same measure on ${near.name}`,
        nearHlc[near.name] <= g.hlc,
        `${nearHlc[near.name].toFixed(4)} <= ${g.hlc}`,
      );
    }
  }

  // --- the reflection half -------------------------------------------------
  console.log("");
  const gains: Record<string, number> = {};
  const measuredRefl: {
    g: ReflGate;
    gain: number;
    vgradDeep: number;
    vgradFlat: number;
    fresDeep: number;
    fresFlat: number;
  }[] = [];

  for (const g of REFL_GATES) {
    const mask = facadeMask(`${outDir}/mask/${g.name}.png`);
    const deep = luminance(`${outDir}/deep/${g.name}.png`);
    const flat = luminance(`${outDir}/flatrefl/${g.name}.png`);
    const gain = maskedMean(deep, mask).mean / maskedMean(flat, mask).mean;
    gains[g.name] = gain;

    let fresDeep = 0;
    let fresFlat = 0;
    if (g.fresnel !== undefined) {
      const graze = facadeMask(`${outDir}/graze/${g.name}.png`);
      const square = squareOn(mask, graze);
      fresDeep = maskedMean(deep, square).mean / maskedMean(deep, graze).mean;
      fresFlat = maskedMean(flat, square).mean / maskedMean(flat, graze).mean;
    }
    const vgradDeep = g.vgrad !== undefined ? vgrad(deep, mask) : 0;
    const vgradFlat = g.vgrad !== undefined ? vgrad(flat, mask) : 0;
    measuredRefl.push({ g, gain, vgradDeep, vgradFlat, fresDeep, fresFlat });

    const bits = [`gain ${gain.toFixed(4)}`];
    if (g.vgrad !== undefined) bits.push(`top/bot ${vgradFlat.toFixed(4)} -> ${vgradDeep.toFixed(4)}`);
    if (g.fresnel !== undefined) bits.push(`square/graze ${fresFlat.toFixed(4)} -> ${fresDeep.toFixed(4)}`);
    console.log(`${g.name.padEnd(18)} ${bits.join("   ")}`);
  }
  console.log("");

  for (const m of measuredRefl) {
    const { g } = m;
    if (g.vgrad !== undefined) {
      // THE SKY IS ABOVE AND THE CITY IS BELOW. A wall lit by an ambient term
      // has one answer for its whole height; a wall MIRRORING has two.
      check(`${g.name}: reflection is directional`, m.vgradDeep >= g.vgrad,
        `top/bottom ${m.vgradDeep.toFixed(4)} >= ${g.vgrad}`);
      probe(`${g.name}: directional, ?flatrefl`, m.vgradFlat >= g.vgrad,
        `${m.vgradFlat.toFixed(4)} >= ${g.vgrad}`);
    }
    if (g.fresnel !== undefined) {
      // AND THE SQUARE-ON WALL IS GLAZED IN SOMETHING. Grazing is where Schlick
      // returns ~1 for any F0, so the grazing set barely moves and the square-on
      // set gains on it; see the header for why the obvious form of this is
      // false.
      check(`${g.name}: square-on glass gains on grazing`, m.fresDeep >= g.fresnel,
        `square/grazing ${m.fresDeep.toFixed(4)} >= ${g.fresnel}`);
      probe(`${g.name}: square-on gain, ?flatrefl`, m.fresFlat >= g.fresnel,
        `${m.fresFlat.toFixed(4)} >= ${g.fresnel}`);
    }
    if (g.gain !== undefined) {
      // AND NOTHING ELSE IN THE CITY GOT SHINIER. Brick and stucco are glazed
      // in a punched sash over a dark room, which is 0.04 -> 0.05: no change is
      // the right answer, and this is where the wrong one would show.
      check(`${g.name}: masonry did not move`, m.gain <= g.gain,
        `mean gain ${m.gain.toFixed(4)} <= ${g.gain}`);
      probe(`${g.name}: gain, same measure on ${GAIN_PROBE_POSE}`,
        gains[GAIN_PROBE_POSE] <= g.gain,
        `${gains[GAIN_PROBE_POSE].toFixed(4)} <= ${g.gain}`);
    }
  }

  if (!has("keep")) rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
