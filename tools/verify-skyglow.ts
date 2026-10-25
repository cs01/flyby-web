// The gate on the night sky over a city: is it a lit dome, or pitch black with
// stars.
//
// WHY THIS EXISTS. The owner, on Manhattan at night: the sky gives it away. It
// was pitch black and full of stars over eight million people. A real city sky
// is a dome lit by the city's own light (render/skyglow.ts): orange near the
// horizon, darker and pinker overhead, most stars gone, and a low cloud deck
// glowing from underneath.
//
// GATE DISCIPLINE, as tools/verify-water.ts. Every bound is a LITERAL, one of
// the measured numbers printed beside it, and every assertion has a vacuity
// probe that must fail it. Sky pixels are taken by elevation, from the camera
// matrices shots.ts records, with every building pixel (?buildingDebug=4)
// masked out:
//
//   horizon glow   mean Rec.601 luminance (0..255) of the sky 3 to 10 degrees
//                  up, over Midtown. Floor. Probes: the same pose with
//                  ?noskyglow=1, and the Grand Canyon (no city) at night.
//   warm           mean R over mean B of that band. Floor. Probe: ?noskyglow=1,
//                  whose few lit pixels are blue-white stars.
//   a dome         horizon band over the 30 to 45 degree band. Floor: the glow
//                  is a gradient, not a lift. Probe: the Grand Canyon sky.
//   stars washed   star pixels (a local maximum 12 over its 5x5 ring) per
//                  10k sky pixels above 15 degrees. Ceiling. Probe:
//                  ?noskyglow=1, the old starfield.
//   lit overcast   mean luminance of a low deck's underside, 15 to 45 degrees
//                  up. Floor. Probe: the same deck with ?noskyglow=1.
//
//   bun tools/verify-skyglow.ts --port 5207 --debug-port 9551 --profile /tmp/x
//   bun tools/verify-skyglow.ts --reuse     (measures the last render)

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
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(43)} ${detail}`);
  if (!ok) failures++;
}

const CITY = "manhattan-skyglow";
const OVERCAST = "manhattan-skyglow-overcast";
const RURAL = "grandcanyon-night";

// --- the bounds, measured 2026-10-24 at 1280x720 -------------------------------
// Each floor sits between the lit value and the nearer of its probes.
//
// Measured: horizon 35.5 lit, 0.7 with ?noskyglow=1, 0.4 at the Grand Canyon.
const HORIZON_LUM_FLOOR = 20;
// R/B 1.27 lit (rgb 40,34,32: the orange of the haze), 1.01 noskyglow (its
// few lit pixels are stars, about neutral).
const WARM_FLOOR = 1.1;
// Horizon over 30-45 deg: 2.67 lit, 0.36 at the Grand Canyon (stars only).
const DOME_FLOOR = 1.6;
// Star pixels per 10k above 15 deg: 2.11 lit, 9.59 noskyglow, 9.70 rural.
const STARS_CEILING = 5;
// Low deck underside, 15-45 deg: 68.8 lit, 7.4 noskyglow.
const OVERCAST_LUM_FLOOR = 40;

async function shoot(outDir: string, poses: string[], query: string): Promise<void> {
  const args = [
    "tools/shots.ts", "--only", poses.join(","), "--out", outDir,
    "--port", arg("port", "5199"), "--debug-port", arg("debug-port", "9511"),
  ];
  if (query) args.push("--query", query);
  const profile = arg("profile", "");
  if (profile) args.push("--profile", profile);
  const p = Bun.spawn(["bun", ...args], { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`shots.ts failed for "${query}"`);
}

interface View { pos: number[]; world: number[]; projInv: number[] }
interface Img { w: number; h: number; data: Uint8Array }

/** Elevation in degrees of each pixel's ray, from the recorded matrices. */
function elevations(v: View, w: number, h: number): Float32Array {
  const P = v.projInv, M = v.world;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = ((x + 0.5) / w) * 2 - 1, ny = 1 - ((y + 0.5) / h) * 2;
      // Column-major 4x4 times (nx, ny, 1, 1), then the divide.
      const vx = P[0] * nx + P[4] * ny + P[8] + P[12];
      const vy = P[1] * nx + P[5] * ny + P[9] + P[13];
      const vz = P[2] * nx + P[6] * ny + P[10] + P[14];
      const vw = P[3] * nx + P[7] * ny + P[11] + P[15];
      const dx = vx / vw, dy = vy / vw, dz = vz / vw;
      const wx = M[0] * dx + M[4] * dy + M[8] * dz;
      const wy = M[1] * dx + M[5] * dy + M[9] * dz;
      const wz = M[2] * dx + M[6] * dy + M[10] * dz;
      out[y * w + x] = (Math.asin(wy / Math.hypot(wx, wy, wz)) * 180) / Math.PI;
    }
  }
  return out;
}

function viewOf(dir: string, pose: string): View {
  const shots = JSON.parse(readFileSync(`${dir}/shots.json`, "utf8")) as { name: string; view: View }[];
  const s = shots.find((x) => x.name === pose);
  if (!s?.view) throw new Error(`no view for ${pose} in ${dir}`);
  return s.view;
}

const lum = (d: Uint8Array, i: number): number => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];

/** Sky pixels in an elevation band, building pixels (green mask) excluded. */
function band(el: Float32Array, mask: Img | null, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < el.length; i++) {
    if (el[i] < lo || el[i] >= hi) continue;
    // Pure green only: the debug frame still draws the clouds.
    if (mask && mask.data[i * 4 + 1] > 60 && mask.data[i * 4] < 30 && mask.data[i * 4 + 2] < 30) continue;
    out.push(i);
  }
  return out;
}

function stats(img: Img, ix: number[]): { lum: number; r: number; g: number; b: number } {
  let L = 0, r = 0, g = 0, b = 0;
  for (const i of ix) { L += lum(img.data, i); r += img.data[i * 4]; g += img.data[i * 4 + 1]; b += img.data[i * 4 + 2]; }
  const n = Math.max(1, ix.length);
  return { lum: L / n, r: r / n, g: g / n, b: b / n };
}

/** Star pixels per 10k: local maxima standing 12 over the mean of their 5x5 ring. */
function starDensity(img: Img, ix: number[]): number {
  const set = new Uint8Array(img.w * img.h);
  for (const i of ix) set[i] = 1;
  let n = 0;
  for (const i of ix) {
    const x = i % img.w, y = (i - x) / img.w;
    if (x < 2 || y < 2 || x >= img.w - 2 || y >= img.h - 2) continue;
    const c = lum(img.data, i);
    let ring = 0, rn = 0, isMax = true;
    for (let dy = -2; dy <= 2 && isMax; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const j = i + dy * img.w + dx;
        const l = lum(img.data, j);
        if (l > c) { isMax = false; break; }
        if (Math.abs(dx) === 2 || Math.abs(dy) === 2) { ring += l; rn++; }
      }
    }
    if (isMax && c - ring / rn >= 12) n++;
  }
  return (n / Math.max(1, ix.length)) * 10000;
}

interface SkyRead { horizon: { lum: number; r: number; g: number; b: number }; high: number; stars: number }

function readSky(dir: string, pose: string, maskDir: string | null): SkyRead {
  const img = decodePng(`${dir}/${pose}.png`) as Img;
  const mask = maskDir ? (decodePng(`${maskDir}/${pose}.png`) as Img) : null;
  const el = elevations(viewOf(dir, pose), img.w, img.h);
  return {
    horizon: stats(img, band(el, mask, 3, 10)),
    high: stats(img, band(el, mask, 30, 45)).lum,
    stars: starDensity(img, band(el, mask, 15, 90)),
  };
}

async function main(): Promise<void> {
  const out = arg("out", "shots/skyglow");
  if (!has("reuse")) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    console.log("rendering the night sky over the city, and the rural control ...");
    await shoot(`${out}/on`, [CITY, OVERCAST, RURAL], "");
    console.log("rendering it with no skyglow (?noskyglow=1) ...");
    await shoot(`${out}/off`, [CITY, OVERCAST], "noskyglow=1");
    console.log("rendering the building mask (?buildingDebug=4) ...");
    await shoot(`${out}/mask`, [CITY, OVERCAST], "buildingDebug=4");
  }

  const on = readSky(`${out}/on`, CITY, `${out}/mask`);
  const off = readSky(`${out}/off`, CITY, `${out}/mask`);
  const rural = readSky(`${out}/on`, RURAL, null);
  const warm = (s: SkyRead): number => s.horizon.r / Math.max(1, s.horizon.b);
  const dome = (s: SkyRead): number => s.horizon.lum / Math.max(1, s.high);
  const fmt = (s: SkyRead): string =>
    `horizon ${s.horizon.lum.toFixed(1)} rgb(${s.horizon.r.toFixed(0)},${s.horizon.g.toFixed(0)},${s.horizon.b.toFixed(0)}) high ${s.high.toFixed(1)} stars ${s.stars.toFixed(2)}`;
  console.log(`  city    ${fmt(on)}\n  noglow  ${fmt(off)}\n  rural   ${fmt(rural)}`);

  check(`${CITY}: the sky over the city glows`, on.horizon.lum >= HORIZON_LUM_FLOOR,
    `${on.horizon.lum.toFixed(1)} >= ${HORIZON_LUM_FLOOR} at 3-10 deg`);
  probe(`${CITY}: the black sky does not`, off.horizon.lum >= HORIZON_LUM_FLOOR, `noskyglow ${off.horizon.lum.toFixed(1)}`);
  probe(`${RURAL}: nor does a sky with no city`, rural.horizon.lum >= HORIZON_LUM_FLOOR, `rural ${rural.horizon.lum.toFixed(1)}`);

  check(`${CITY}: the glow is sodium-warm`, warm(on) >= WARM_FLOOR, `R/B ${warm(on).toFixed(2)} >= ${WARM_FLOOR}`);
  probe(`${CITY}: starlight is not`, warm(off) >= WARM_FLOOR, `noskyglow R/B ${warm(off).toFixed(2)}`);

  check(`${CITY}: a dome, brightest at the horizon`, dome(on) >= DOME_FLOOR,
    `3-10 deg over 30-45 deg ${dome(on).toFixed(2)} >= ${DOME_FLOOR}`);
  probe(`${RURAL}: the dark sky has no dome`, dome(rural) >= DOME_FLOOR, `rural ${dome(rural).toFixed(2)}`);

  check(`${CITY}: the city washes out the stars`, on.stars <= STARS_CEILING,
    `${on.stars.toFixed(2)} per 10k sky px <= ${STARS_CEILING}`);
  probe(`${CITY}: the old starfield is full`, off.stars <= STARS_CEILING, `noskyglow ${off.stars.toFixed(2)}`);

  {
    const read = (dir: string): number => {
      const img = decodePng(`${dir}/${OVERCAST}.png`) as Img;
      const mask = decodePng(`${out}/mask/${OVERCAST}.png`) as Img;
      return stats(img, band(elevations(viewOf(dir, OVERCAST), img.w, img.h), mask, 15, 45)).lum;
    };
    const lit = read(`${out}/on`), dark = read(`${out}/off`);
    check(`${OVERCAST}: the deck is lit from below`, lit >= OVERCAST_LUM_FLOOR, `${lit.toFixed(1)} >= ${OVERCAST_LUM_FLOOR}`);
    probe(`${OVERCAST}: an unlit deck is dark`, dark >= OVERCAST_LUM_FLOOR, `noskyglow ${dark.toFixed(1)}`);
  }

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

await main();
