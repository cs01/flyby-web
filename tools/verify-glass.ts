// The gate on window reveals: is a facade a wall with holes in it, or a sheet
// of paper with a grid printed on it.
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
//   which is the head of the opening shading the glass behind it. Taken
//   relative to the mean over the same pixels, so a wall in shadow does not
//   score as flat merely for being dark.
//
//   HORIZONTAL LOCAL CONTRAST. The same high-pass across the wall, and this is
//   the one that measures DEPTH rather than "something changed". At a grazing
//   angle the wall overhangs its own glass on the near side of every opening
//   and exposes the jamb on the far side, so a vertical strip of reveal appears
//   down one side of every window -- a surface a facade with its glass in the
//   wall plane HAS NO PIXELS FOR. It is the largest signal in the set: 0.083 ->
//   0.140 on the Manhattan pose, and it has to stay absent at 500 m.
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
//   pose              measure    flat     recessed   bound
//   manhattan-7th     vLC        0.1107   0.1235     >= 0.117
//   manhattan-7th     hLC        0.0826   0.1395     >= 0.110
//   hongkong-central  vLC        0.0360   0.0347     <= 0.045
//   hongkong-central  hLC        0.0800   0.0756     <= 0.090
//
// The jamb bound has the separation the effect deserves: 33% clear of the flat
// facade and 21% under the recessed one. The head bound is TIGHT -- 5.7% either
// side -- and that is not carelessness, it is the size of the thing. A 115 mm
// reveal on a 3.9 m storey is a band 3% of a floor high, and it is competing
// with a storey line the facade already draws at every slab. It is a usable
// bound only because the harness pins the camera, the clock, the weather and
// the render scale, and its own --repeat check reports these poses byte
// identical between runs.
//
// Both ceilings sit ABOVE the flat facade's own number as well as above the
// recessed one, which is deliberate: at 500 m the correct answer is that
// nothing changed, and a ceiling the flat frame would fail would be asserting
// that the old code aliased rather than that the new code does not.
interface PoseGate {
  name: string;
  kind: "floor" | "ceiling";
  /** Relative vertical local contrast over facade pixels: the window head. */
  vlc: number;
  /** Relative horizontal local contrast over facade pixels: the jamb. */
  hlc: number;
}

const GATES: PoseGate[] = [
  { name: "manhattan-7th", kind: "floor", vlc: 0.117, hlc: 0.110 },
  { name: "hongkong-central", kind: "ceiling", vlc: 0.045, hlc: 0.090 },
];

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
  if (n === 0) return { n: 0, mean: 0, vlc: 0, hlc: 0 };
  return { n, mean: sum / n, vlc: vSum / sum, hlc: hSum / sum };
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots/glass");
  const port = Number(arg("port", "5181"));
  const dbg = Number(arg("debug-port", "9415"));
  mkdirSync(outDir, { recursive: true });

  // `--reuse` measures frames already in --out instead of rendering them. It is
  // for working on the MEASUREMENT: three passes of the shot harness is several
  // minutes, and nothing about tuning a bound needs the pictures taken again.
  if (!has("reuse")) {
    console.log("rendering the recessed glazing ...");
    await shoot(`${outDir}/deep`, "", port, dbg);
    console.log("rendering the flat glazing (?flatglass=1) ...");
    await shoot(`${outDir}/flat`, "flatglass=1", port, dbg);
    console.log("rendering the facade mask (?buildingDebug=1) ...");
    await shoot(`${outDir}/mask`, "buildingDebug=1", port, dbg);
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
        `head ${sf.vlc.toFixed(4)} -> ${sd.vlc.toFixed(4)}   ` +
        `jamb ${sf.hlc.toFixed(4)} -> ${sd.hlc.toFixed(4)}   ` +
        `mean ${sf.mean.toFixed(1)} -> ${sd.mean.toFixed(1)}`,
    );
  }
  console.log("");

  for (const { g, deep, flat } of measured) {
    check(`${g.name}: enough facade to measure`, deep.n >= 60000, `${deep.n} px`);

    if (g.kind === "floor") {
      // THE HEAD CASTS A LINE. A facade with its glass in the wall plane has
      // nothing for that line to fall on.
      check(`${g.name}: head contrast on facades`, deep.vlc >= g.vlc, `${deep.vlc.toFixed(4)} >= ${g.vlc}`);
      probe(`${g.name}: head contrast, ?flatglass`, flat.vlc >= g.vlc, `${flat.vlc.toFixed(4)} >= ${g.vlc}`);

      // AND THE WALL OVERHANGS ITS OWN GLASS. This is the reported defect:
      // the strip of jamb a grazing view exposes is a surface the flat facade
      // does not have, and it is the largest number in the set.
      check(`${g.name}: jamb contrast on facades`, deep.hlc >= g.hlc, `${deep.hlc.toFixed(4)} >= ${g.hlc}`);
      probe(`${g.name}: jamb contrast, ?flatglass`, flat.hlc >= g.hlc, `${flat.hlc.toFixed(4)} >= ${g.hlc}`);
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

  if (!has("keep")) rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
