// The gate on the street floor: is a shadowed city street SHADOWED, or black.
//
// WHY THIS IS NOT IN `bun run check`. Everything check runs is offline and
// Chrome-free, and it has to stay that way: it runs on every change, and there
// is no GPU under Bun. This measures a RENDERED FRAME, so it needs a browser, a
// GPU and a vite server. There is also nothing else it could be -- the defect
// and the fix live entirely in a fragment shader, and no CPU-side unit test can
// look at what a shader drew. So it is its own script, `bun run bounce`, run
// when the ground bounce is touched.
//
// THE SCRIPT IS `bounce` AND NOT `street` because `street` is already the
// offline test/street.check.ts, which is in `check` and stays there. `bounce`
// follows `water` and `glass`: one word, naming the term under test.
//
// WHAT WAS WRONG. A user reported "the street is super dark, even in daytime"
// from the LaSalle Street canyon. Measured, the left half of that frame was not
// dim, it was ZERO: 86.8% of the shadowed street floor sat under 4 of 255 and
// 75.3% under 2. A carriageway between two forty-storey towers loses nearly the
// whole sky dome, so the sky irradiance collapses, and the sun is blocked, so
// the beam is gone. Sum: black at noon, under facades in full sun. The fix is
// the canyon bounce in render/groundbounce.ts -- the wall opposite is lit, and
// it throws most of that back down into the street.
//
// AND IT WAS NOT ONE SHADER. This was found by forcing each candidate fragment
// shader to a flat red in turn and rendering the pose. render/roads.ts covers
// the carriageway only; render/pavement.ts the footway only; the large black
// region that dominates the frame is the TERRAIN DRAPE. Three surfaces make up
// a street floor and all three were black, which is why the term is one shared
// helper rather than three coefficients that would have drifted apart.
//
// GATE DISCIPLINE, as in tools/verify-water.ts and tools/verify-glass.ts. Every
// bound below is a LITERAL, and every literal sits between the two numbers the
// run prints beside it, both measured before the bound was written down. Every
// assertion is paired with a VACUITY PROBE that must FAIL it. Two kinds:
//
//   * `?flatbounce=1` restores the pre-bounce street floor in the SAME binary,
//     so an assertion that would pass either way is caught immediately;
//   * the NO-CHANGE CEILINGS have no such flag, because the honest opposite of
//     "this frame did not move" is not "old code" -- comparing a frame with
//     itself is 1.000 by construction and proves nothing. It is a frame that
//     legitimately DID move, so those ceilings are probed against the same
//     measurement on chicago-lasalle-kerb.
//
// THREE POSES, ASSERTING OPPOSITE THINGS ON PURPOSE.
//
//   chicago-lasalle-kerb  from the kerb in a 24 m canyon at 11:39 CDT, high sun,
//                         canyon floor in shadow. The pose the defect was
//                         reported from and the only one in the set that can see
//                         it. Floors, and the stops ceiling.
//   sf-street             Van Ness at Pine, a wide avenue in FULL SUN at the
//                         same hour. The correct answer here is that nothing
//                         happens: the ground is lit by the beam and a bounce
//                         off a wall is worth nothing to it. Ceiling.
//   chicago-loop-night    the Loop at 22:30 CDT. The sun is below the horizon,
//                         so `max(0, sunDir.y)` must hold this frame EXACTLY
//                         fixed -- a street bounce that survives sunset is a
//                         fake daylight term on a night city. Ceiling.
//
// THE GROUND MASK IS NOT GUESSED, and neither is the shadow. Each pose is
// rendered again with `?groundDebug`, which makes all three ground shaders emit
// RED where their own `sunVisibility` says the fragment is shadowed and BLUE
// where the sun reaches it, and nothing anywhere else. So both "which pixels
// are street floor" and "which of them are in shadow" are answered by the
// shaders that decide them. The rest of the scene draws normally, so the mask
// occludes what the beauty frame occludes and the two agree pixel for pixel.
// Mode 1 is all three surfaces; mode 2 is the carriageway alone.
//
// THE RATIO IS TAKEN OVER THE CARRIAGEWAY ALONE, and that is the whole reason
// mode 2 exists. The physical claim is that a shadowed street is one to two
// stops darker than the sunlit ground beside it, and a ratio taken across all
// three surfaces at once is measuring ALBEDO as much as light: three quarters
// of the shadowed ground in the LaSalle frame is terrain drape, and the drape
// there is a satellite texel with a deep building shadow BAKED INTO IT. Over
// drape pixels the albedo frame itself (`?terrainDebug=1`) means 7.22 of 255
// with 46.3% under 4, so that ground cannot be made bright by any lighting term
// whatever. Over the carriageway it is one material either side of the shadow
// line, and the ratio is a ratio of light: 10.77 without the bounce, 2.46 with
// it. Taken over all ground the same pair reads 25.56 and 4.06, which flatters
// the bounce and indicts the drape, and is not what this file claims.
//
// THAT BAKED DRAPE SHADOW IS A SEPARATE, STILL-OPEN DEFECT. It is why the
// near-black ceiling below is 0.50 and not 0.05: with the bounce in, 24.6% of
// the street floor is still under 4 of 255, and essentially all of it is drape
// whose REFLECTANCE is that dark. The illumination on those same pixels is now
// correct -- their sunlit-over-shadowed ratio went 17.55 to 2.45 -- so a
// brighter bounce would only over-light the tarmac to compensate for a texture,
// which is measurable: at a target of 0.9 the carriageway ratio collapses to
// 1.46, half a stop, and the street stops reading as shadowed at all.
//
// A TEST THAT WAS WRITTEN AND REJECTED. The first ratio assertion was taken
// over ALL ground pixels with a ceiling of 6.0, and it is vacuous in the
// direction that matters: it passes at a shadow target of 0.35, where 43.6% of
// the street floor is still under 4 of 255 and the frame still reads black. It
// was measuring the drape's albedo and reporting it as light. Replaced by the
// carriageway ratio above, which moves 1.46 -> 2.46 -> 3.32 across the same
// sweep of the coefficient and so can actually say when it is wrong.
//
//   bun run bounce
//   bun tools/verify-street.ts --out shots/street --keep
//   bun tools/verify-street.ts --out shots/street --reuse   (tune a bound)

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
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(50)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(41)} ${detail}`);
  if (!ok) failures++;
}

// --- THE BOUNDS ------------------------------------------------------------
//
// Measured both ways on an M-series laptop before they were written down. The
// run prints the flat and the bounced number next to every one of them, so a
// bound that has drifted out from between its two measurements is visible in
// the output rather than only in a red line.
//
//   pose                  measure                    flat     bounce   bound
//   chicago-lasalle-kerb  shadowed road mean          5.78    25.50    >= 16
//   chicago-lasalle-kerb  shadowed ground mean        2.52    15.94    >= 10
//   chicago-lasalle-kerb  shadowed ground under 4    0.868    0.234    <= 0.50
//   chicago-lasalle-kerb  sunlit road / shadowed    10.777    2.459    <= 4.0
//   sf-street             ground mean, on over off     --    1.0041    <= 1.04
//   chicago-loop-night    ground mean, on over off     --    1.0000    <= 1.001
//
// THE RATIO CEILING IS THE PHYSICS, and it is the assertion that catches
// someone deleting the term. 4.0 is exactly two stops, which is the literal
// claim -- a shadowed street under lit walls is one to two stops darker than
// the sunlit pavement beside it, not twenty. It is not a round number chosen
// for looking reasonable, it is the number the claim is made of, and both
// measurements are far from it: 2.46 with the bounce and 10.77 (3.4 stops)
// without.
//
// THE TWO FLOORS have the separation the effect deserves -- the road floor is
// 37% under the measurement and 2.8x over the flat frame -- because this is not
// a subtle effect. The flat street floor is at 2.52 of 255. It is black.
//
// THE NIGHT CEILING IS 1.001 AND NOT 1.02, deliberately. At night the sun is
// below the horizon, so `max(0, sunDir.y)` zeroes the term and the two frames
// are the SAME frame; the assertion is that this is exact, not approximate, and
// a ceiling loose enough to hide a small dusk leak would not be testing the
// thing that keeps the moon path honest.
//
// THE NIGHT POSE HAS NO SHADOW SPLIT IN IT, and that is not a broken mask.
// render/sunshadow.ts turns the cascades off below about a degree of sun
// altitude, so `sunVisibility` returns 1 everywhere after dark and the whole
// night street floor comes back BLUE. Which is why the night assertion is the
// all-ground gain and not a shadow ratio: the quantity that has to be exactly
// zero there is the term, not a contrast.
//
// THE SF CEILING IS 1.04 and the measurement is 1.0041. It is not tighter
// because it should not be zero: a wide avenue in full sun still has a few
// building shadows across it (3188 of 315k ground pixels, 54.74 -> 75.57), and
// those are street floor in shadow under lit walls, which is exactly the case
// the term is for. What must not happen is the OTHER 99% moving, and it does
// not: the sunlit carriageway there reads 70.87 -> 70.92.
interface Gate {
  name: string;
  /** Floor on mean luminance over shadowed CARRIAGEWAY pixels, 0..255. */
  roadFloor?: number;
  /** Floor on mean luminance over all shadowed ground pixels, 0..255. */
  groundFloor?: number;
  /** Ceiling on the fraction of shadowed ground under NEAR_BLACK. */
  blackCeil?: number;
  /** Ceiling on sunlit over shadowed mean luminance, carriageway only. */
  stopsCeil?: number;
  /** Ceiling on mean ground luminance with the bounce over without it. */
  gainCeil?: number;
}

const GATES: Gate[] = [
  {
    name: "chicago-lasalle-kerb",
    roadFloor: 16,
    groundFloor: 10,
    blackCeil: 0.5,
    stopsCeil: 4.0,
  },
  { name: "sf-street", gainCeil: 1.04 },
  { name: "chicago-loop-night", gainCeil: 1.001 },
];

/** The pose whose gain probes the two no-change ceilings. */
const GAIN_PROBE_POSE = "chicago-lasalle-kerb";

/**
 * Luminance at or under which a pixel is not dark, it is BLACK, out of 255.
 *
 * Four, not zero. The reported defect is not "the shader output exactly 0.0",
 * it is a region with no readable structure in it, and the tone curve puts the
 * bottom two stops of that region inside a handful of codes: the flat frame has
 * 86.8% of its street floor under 4 and 75.3% under 2, which is the same claim
 * either way. Four is where an 8-bit frame stops carrying detail.
 */
const NEAR_BLACK = 4;

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

/** Rec.601 luminance of the displayed pixel, 0..255. */
function luminance(path: string): Float32Array {
  const img = decodePng(path);
  const lum = new Float32Array(img.w * img.h);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  }
  return lum;
}

interface Mask {
  /** Indices of ground pixels the sun does NOT reach. */
  shadow: number[];
  /** Indices of ground pixels it does. */
  sunlit: number[];
}

/**
 * The ground mask, from a ?groundDebug frame: PURE RED shadowed, PURE BLUE lit.
 *
 * The markers are written before the atmosphere and at full opacity, and the
 * frame is still tone-mapped on the way out, so 1.0 lands near 181/255 in one
 * channel with the other two at zero. Two dead channels is what rejects
 * everything else in the frame: sky, glass, foliage, render and tarmac all
 * carry substantial energy in more than one channel.
 */
function groundMask(path: string): Mask {
  const img = decodePng(path);
  const shadow: number[] = [];
  const sunlit: number[] = [];
  for (let i = 0; i < img.w * img.h; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    if (g > 25) continue;
    if (r >= 120 && b <= 25) shadow.push(i);
    else if (b >= 120 && r <= 25) sunlit.push(i);
  }
  return { shadow, sunlit };
}

/** The stops ratio as printed. "n/a" when a pose has no shadowed road in it,
 *  which is every night pose: see the header. */
const ratioText = (lum: Float32Array, m: Mask): string =>
  m.shadow.length ? (mean(lum, m.sunlit) / Math.max(1e-6, mean(lum, m.shadow))).toFixed(3) : "n/a";

const mean = (lum: Float32Array, ix: number[]): number =>
  ix.length ? ix.reduce((s, i) => s + lum[i], 0) / ix.length : 0;

const blackFrac = (lum: Float32Array, ix: number[]): number =>
  ix.length ? ix.filter((i) => lum[i] < NEAR_BLACK).length / ix.length : 0;

async function main(): Promise<void> {
  const outDir = arg("out", "shots/street");
  const port = Number(arg("port", "5183"));
  const dbg = Number(arg("debug-port", "9417"));
  mkdirSync(outDir, { recursive: true });

  // `--reuse` measures frames already in --out instead of rendering them. It is
  // for working on the MEASUREMENT: four passes of the shot harness is several
  // minutes, and nothing about tuning a bound needs the pictures taken again.
  if (!has("reuse")) {
    console.log("rendering the bounced street floor ...");
    await shoot(`${outDir}/on`, "", port, dbg);
    console.log("rendering the flat street floor (?flatbounce=1) ...");
    await shoot(`${outDir}/off`, "flatbounce=1", port, dbg);
    console.log("rendering the ground mask (?groundDebug=1) ...");
    await shoot(`${outDir}/mask`, "groundDebug=1", port, dbg);
    console.log("rendering the carriageway mask (?groundDebug=2) ...");
    await shoot(`${outDir}/road`, "groundDebug=2", port, dbg);
    console.log("");
  }

  interface Measured {
    g: Gate;
    ground: Mask;
    road: Mask;
    on: Float32Array;
    off: Float32Array;
    gainOn: number;
    gainOff: number;
  }
  const measured: Measured[] = [];

  for (const g of GATES) {
    const ground = groundMask(`${outDir}/mask/${g.name}.png`);
    const road = groundMask(`${outDir}/road/${g.name}.png`);
    const on = luminance(`${outDir}/on/${g.name}.png`);
    const off = luminance(`${outDir}/off/${g.name}.png`);
    const all = [...ground.shadow, ...ground.sunlit];
    measured.push({ g, ground, road, on, off, gainOn: mean(on, all), gainOff: mean(off, all) });

    console.log(
      `${g.name.padEnd(22)} ground ${String(all.length).padStart(6)} px ` +
        `(${ground.shadow.length} shadowed), road ${road.shadow.length}/${road.sunlit.length}\n` +
        `${" ".repeat(22)}   shadowed road   ${mean(off, road.shadow).toFixed(2)} -> ${mean(on, road.shadow).toFixed(2)}` +
        `   sunlit road ${mean(off, road.sunlit).toFixed(2)} -> ${mean(on, road.sunlit).toFixed(2)}\n` +
        `${" ".repeat(22)}   shadowed ground ${mean(off, ground.shadow).toFixed(2)} -> ${mean(on, ground.shadow).toFixed(2)}` +
        `   under ${NEAR_BLACK} ${blackFrac(off, ground.shadow).toFixed(3)} -> ${blackFrac(on, ground.shadow).toFixed(3)}\n` +
        `${" ".repeat(22)}   road sunlit/shadowed ` +
        `${ratioText(off, road)} -> ${ratioText(on, road)}` +
        `   all-ground mean ${mean(off, all).toFixed(2)} -> ${mean(on, all).toFixed(2)}`,
    );
  }
  console.log("");

  const gainOf = (m: Measured): number => m.gainOn / Math.max(1e-6, m.gainOff);
  const probeGain = gainOf(measured.find((m) => m.g.name === GAIN_PROBE_POSE)!);

  for (const m of measured) {
    const { g, ground, road, on, off } = m;

    if (g.roadFloor !== undefined) {
      // THE STREET IS NOT BLACK. On one material, so this is light and not
      // texture.
      check(`${g.name}: shadowed carriageway is lit`, mean(on, road.shadow) >= g.roadFloor,
        `${mean(on, road.shadow).toFixed(2)} >= ${g.roadFloor}`);
      probe(`${g.name}: shadowed carriageway, ?flatbounce`, mean(off, road.shadow) >= g.roadFloor,
        `${mean(off, road.shadow).toFixed(2)} >= ${g.roadFloor}`);
    }

    if (g.groundFloor !== undefined) {
      // AND NOR IS THE REST OF THE STREET FLOOR. Carriageway, footway and drape
      // together: the defect was reported about the whole frame, not the tarmac.
      check(`${g.name}: shadowed ground is lit`, mean(on, ground.shadow) >= g.groundFloor,
        `${mean(on, ground.shadow).toFixed(2)} >= ${g.groundFloor}`);
      probe(`${g.name}: shadowed ground, ?flatbounce`, mean(off, ground.shadow) >= g.groundFloor,
        `${mean(off, ground.shadow).toFixed(2)} >= ${g.groundFloor}`);
    }

    if (g.blackCeil !== undefined) {
      // AND IT IS NOT A MEAN OVER A BIMODAL FRAME. A mean alone cannot tell a
      // uniformly dim street from a bright road beside a black hole, and the
      // frame this was reported from was the second: at the coefficient this
      // repo shipped, mean shadowed ground read 28.09 with 75% of it under 4.
      check(`${g.name}: street floor under ${NEAR_BLACK} of 255`,
        blackFrac(on, ground.shadow) <= g.blackCeil,
        `${blackFrac(on, ground.shadow).toFixed(3)} <= ${g.blackCeil}`);
      probe(`${g.name}: near-black fraction, ?flatbounce`,
        blackFrac(off, ground.shadow) <= g.blackCeil,
        `${blackFrac(off, ground.shadow).toFixed(3)} <= ${g.blackCeil}`);
    }

    if (g.stopsCeil !== undefined) {
      // ONE TO TWO STOPS, NOT TWENTY. The physics, and the assertion that
      // catches someone deleting the term.
      const r = (l: Float32Array): number =>
        mean(l, road.sunlit) / Math.max(1e-6, mean(l, road.shadow));
      check(`${g.name}: sunlit road over shadowed road`, r(on) <= g.stopsCeil,
        `${r(on).toFixed(3)} <= ${g.stopsCeil} (${Math.log2(r(on)).toFixed(2)} stops)`);
      probe(`${g.name}: sunlit over shadowed, ?flatbounce`, r(off) <= g.stopsCeil,
        `${r(off).toFixed(3)} <= ${g.stopsCeil} (${Math.log2(r(off)).toFixed(2)} stops)`);
    }

    if (g.gainCeil !== undefined) {
      // AND THE CHANGE WAS AIMED. Nothing may move on a frame with no canyon in
      // it, or the term is a global ambient rise wearing a shadow for a hat.
      check(`${g.name}: ground did not move`, gainOf(m) <= g.gainCeil,
        `${gainOf(m).toFixed(4)} <= ${g.gainCeil}`);
      probe(`${g.name}: same gain on ${GAIN_PROBE_POSE}`, probeGain <= g.gainCeil,
        `${probeGain.toFixed(4)} <= ${g.gainCeil}`);
    }
  }

  if (!has("keep")) rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
