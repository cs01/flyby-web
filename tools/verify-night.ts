// The gate on the street at night, from the driver's seat: is the road
// readable, and are the cars in their lanes.
//
// WHY THIS EXISTS. The owner, in the car in the Chicago Loop at dusk: "maybe
// we need headlights or something. Why are cars all over the road, including
// middle of road." Both halves of that are things `bun run check` cannot see
// whole. The lane arithmetic is gated there (test/trafficmodel.check.ts); what
// is gated HERE is the same claim on the running app, at the pose of the
// report, and the one claim only a rendered frame can settle: how bright the
// road ahead actually is once the lamps, the headlights, the night exposure
// and the tone map have all had their say.
//
// GATE DISCIPLINE, as tools/verify-water.ts. Every bound is a LITERAL, one of
// the measured numbers printed beside it, and every assertion has a vacuity
// probe that must fail it:
//
//   road luminance   mean Rec.601 luminance (0..255) over the carriageway
//                    pixels in a band of rows ahead of the car, the mask from
//                    ?groundDebug=2 (the road shader's own say on what is
//                    carriageway). Floor. Probe: the same pose under
//                    ?noheadlights=1&nolamplight=1, the street as it was.
//   lanes            window.flybyShot.streetLanes(): the sim stepped 20 s,
//                    every car within 200 m measured against its centreline.
//                    Ceilings on lane error and heading error, a floor on the
//                    distance kept from the opposing lane, none overlapping
//                    the player's car. Probe: the same report with every car
//                    displaced 1 m sideways (the biasM argument).
//
//   bun run night
//   bun tools/verify-night.ts --out shots/night --port 5195 --debug-port 9491 --profile /tmp/x

import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${detail}`);
  if (!ok) failures++;
}
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(49)} ${detail}`);
  if (!ok) failures++;
}

/** The poses: the report's (dusk and night in the Loop) and a one-way avenue. */
const POSES = ["chicago-drive-dusk", "chicago-drive-night", "manhattan-drive-night"];

/** Rows of the frame the "road ahead" band covers, as fractions of height:
 *  from just under the horizon to just above the bonnet. */
const BAND_TOP = 0.56;
const BAND_BOTTOM = 0.80;

/** Road luminance floor per pose, 0..255; see the printed measurements. */
//
// Measured: dusk 22.7 lit against 13.7 unlit; Loop at night 34.3 against
// 25.5; Seventh Avenue 76.4 against 17.6 (the dark Loop numbers are mostly the
// lit shopfronts' bounce, which is why the gap there is narrower). Each floor
// sits between the two, nearer the lit number.
const ROAD_FLOOR: Record<string, number> = {
  "chicago-drive-dusk": 19,
  "chicago-drive-night": 30,
  "manhattan-drive-night": 45,
};

/** Lane ceilings and floors, as in test/trafficmodel.check.ts. */
const LANE_ERROR_MAX_M = 0.15;
const HEADING_MAX_DEG = 3;
const OPPOSING_MIN_M = 1.0;

async function shoot(outDir: string, query: string, evalExpr: string): Promise<void> {
  const args = [
    "tools/shots.ts", "--only", POSES.join(","), "--out", outDir,
    "--port", arg("port", "5195"), "--debug-port", arg("debug-port", "9491"),
  ];
  if (query) args.push("--query", query);
  if (evalExpr) args.push("--eval", evalExpr);
  const profile = arg("profile", "");
  if (profile) args.push("--profile", profile);
  const p = Bun.spawn(["bun", ...args], { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`shots.ts failed for "${query}"`);
}

function luminance(path: string): { w: number; h: number; lum: Float32Array } {
  const img = decodePng(path);
  const lum = new Float32Array(img.w * img.h);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  }
  return { w: img.w, h: img.h, lum };
}

/** Carriageway pixels in the band, from a ?groundDebug=2 frame: one live
 *  channel (red shadowed, blue lit), the other two dead. */
function roadBand(path: string): number[] {
  const img = decodePng(path);
  const out: number[] = [];
  const y0 = Math.floor(img.h * BAND_TOP), y1 = Math.floor(img.h * BAND_BOTTOM);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      if (g > 25) continue;
      if ((r >= 120 && b <= 25) || (b >= 120 && r <= 25)) out.push(i);
    }
  }
  return out;
}

const mean = (lum: Float32Array, ix: number[]): number => (ix.length ? ix.reduce((s, i) => s + lum[i], 0) / ix.length : 0);

interface LaneEval {
  n: number;
  worstLaneErrM: number;
  worstHeadingDeg: number;
  worstOwnSideM: number | null;
  playerLaneErrM: number | null;
  overlapsPlayer: number;
}

function lanesOk(r: LaneEval): boolean {
  // Five cars within 200 m is what a side street at 22:30 has; under that the
  // measurement is of nothing.
  return r.n >= 5 && r.worstLaneErrM <= LANE_ERROR_MAX_M && r.worstHeadingDeg <= HEADING_MAX_DEG &&
    (r.worstOwnSideM === null || r.worstOwnSideM >= OPPOSING_MIN_M) &&
    (r.playerLaneErrM === null || r.playerLaneErrM <= LANE_ERROR_MAX_M) && r.overlapsPlayer === 0;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots/night");
  if (!has("reuse")) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    console.log("rendering the street at night, with the lane report ...");
    await shoot(`${outDir}/on`, "", "JSON.stringify([window.flybyShot.streetLanes(20, 200, 0), window.flybyShot.streetLanes(0, 200, 1)])");
    console.log("rendering it without headlights or lamp light ...");
    await shoot(`${outDir}/off`, "noheadlights=1&nolamplight=1", "");
    console.log("rendering the carriageway mask (?groundDebug=2) ...");
    await shoot(`${outDir}/mask`, "groundDebug=2", "");
  }

  for (const name of POSES) {
    const band = roadBand(`${outDir}/mask/${name}.png`);
    const on = mean(luminance(`${outDir}/on/${name}.png`).lum, band);
    const off = mean(luminance(`${outDir}/off/${name}.png`).lum, band);
    const floor = ROAD_FLOOR[name];
    check(`${name}: the road ahead is readable`, band.length > 2000 && on >= floor,
      `mean ${on.toFixed(1)} over ${band.length} px (floor ${floor}; dark street measures ${off.toFixed(1)})`);
    probe(`${name}: the floor rejects the unlit street`, band.length > 2000 && off >= floor,
      `noheadlights+nolamplight ${off.toFixed(1)}`);

    const ev = JSON.parse(JSON.parse(readFileSync(`${outDir}/on/${name}.eval.json`, "utf8"))) as [LaneEval, LaneEval];
    const [r, displaced] = ev;
    check(`${name}: cars and the player keep to their lanes`, lanesOk(r),
      `${r.n} cars: lane ${r.worstLaneErrM.toFixed(3)} m, heading ${r.worstHeadingDeg.toFixed(2)} deg, ` +
      `opposing ${r.worstOwnSideM === null ? "n/a" : r.worstOwnSideM.toFixed(2)} m, ` +
      `player ${r.playerLaneErrM === null ? "n/a" : r.playerLaneErrM.toFixed(3)} m, ${r.overlapsPlayer} on the player`);
    probe(`${name}: the lane test rejects every car 1 m sideways`, lanesOk(displaced),
      `displaced: lane ${displaced.worstLaneErrM.toFixed(2)} m`);
  }
  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

await main();
