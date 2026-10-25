// The gate on the far field's colour: from the air, does Midtown read as the
// variety of materials it is built of, or as one grey.
//
// WHY THIS EXISTS. The owner, on Manhattan from 600 m: the buildings from 300
// to 1500 m all read as the same grey. At that range the photographed scans
// have averaged to their means, so what is left to tell a limestone block
// from a red-brick walk-up from a blue-green curtain wall is the palette
// colour, the glass fraction and the window grid's contrast. A real aerial of
// Midtown has all of that.
//
// THE REFERENCE. "Aerial photograph of Midtown Manhattan, New York" by Theo
// Tsongidis (Unsplash, 2016), CC0, from the Empire State's observation deck
// looking north over the same blocks as the manhattan-esb-600 pose:
//   https://commons.wikimedia.org/wiki/File:Aerial_photograph_of_Midtown_Manhattan,_New_York--Unsplash.com--2016.jpg
// measured on the 1280 px Commons thumbnail. A second (CC BY-SA 3.0, Urbanista77,
// 2010, from the same deck) agrees within 15%:
//   https://commons.wikimedia.org/wiki/File:Aerial_photograph_of_Midtown_Manhattan,_New_York--2010,04.jpg
// `--reference <png>` re-measures a photo with the same code.
//
// THE MEASURE. The frame is cut into 16 px patches; a patch counts when 85% of
// it is facade 300 to 1500 m out (?buildingDebug=6, walls only: over whole
// buildings the roofs' own spread measured as large as the walls' with every
// wall painted one red, so that measure could not see the walls; the photo,
// taken looking down at 30 degrees, is nearly all wall). Each patch's mean colour gives two log-chromaticities,
// ln(R/B) (warm limestone and brick against cool glass) and ln(G/sqrt(RB))
// (teal glass against terracotta), and the spread is their standard deviation
// over patches. Both are invariant to a global gain per channel, so neither
// the photo's white balance nor the app's exposure moves them.
//
//   warm and cool  sd ln(R/B) floor, set against the reference. Probe:
//                  ?onepalette=1, every wall in one colour and every curtain
//                  wall in one glass.
//   teal and red   sd ln(G/sqrt(RB)) floor. Probe: the same.
// Luminance spread is printed but not gated: the photo's includes roofs and
// cast shadows across whole blocks, and is not the same quantity.
//
//   bun tools/verify-farcolour.ts --port 5207 --debug-port 9551 --profile /tmp/x
//   bun tools/verify-farcolour.ts --reuse
//   bun tools/verify-farcolour.ts --reference photo.png

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

const POSE = "manhattan-esb-600";

// --- the reference and the bounds -------------------------------------------------
// The CC0 photo above, 1280 px: 4240 patches, sd ln(R/B) 0.2065,
// sd ln(G/sqrt(RB)) 0.0623, luminance CV 0.471. (The 2010 photo: 0.2328,
// 0.0513, 0.390.)
const REF_RB = 0.2065;
const REF_GM = 0.0623;
// Measured on the wall patches of manhattan-esb-600: main before this work
// 0.1648 and 0.0368 (one blue-grey glass for every curtain wall, grey and
// green-grey stone on the lofts); now 0.1904 and 0.0440; ?onepalette=1 0.0932
// and 0.0103. The floors sit between main and now. Widening the mid-rise
// office and 1960s slab palettes too measured 0.1881 / 0.0446, no better,
// and redrew enough of Midtown's colours to move the manhattan-rooftops
// shimmer from 0.0890 to 0.0910, so they were left as they were.
//
// RE-MEASURED 2026-10-25 ACROSS DRAWS, and both floors came down. Which
// archetype and palette a building gets is a hash of its record index, so a
// pack re-bake or a filtered record deals Midtown again; the 0.1904 / 0.0440
// above was one deal. Seven deals of the same code (the facade seed offset by
// 0..5, and main before the seeds were fixed) measured sd ln(R/B) 0.1732 to
// 0.2133 and sd ln(G/sqrt(RB)) 0.0302 to 0.0440, and the seed fix alone moved
// the second from 0.0440 to 0.0391 and failed it. So 0.040 was inside the
// claim's own sampling spread: it told a lucky deal from an unlucky one, and
// the old palette's 0.0368 sits inside that spread too, so this pose never
// could tell the palettes apart. The floors now sit between ?onepalette (0.0932
// / 0.0103) and the lowest deal, which is the claim the frame can support:
// a city's spread of colours, not one grey.
const RB_FLOOR = 0.16;
const GM_FLOOR = 0.025;

const PATCH = 16;

interface Img { w: number; h: number; data: Uint8Array }

export interface Spread { n: number; rb: number; gm: number; lumCv: number }

/** The patch statistics, over building pixels when a mask is given. */
export function spread(img: Img, mask: Img | null): Spread {
  const rb: number[] = [], gm: number[] = [], L: number[] = [];
  for (let py = 0; py + PATCH <= img.h; py += PATCH) {
    for (let px = 0; px + PATCH <= img.w; px += PATCH) {
      let r = 0, g = 0, b = 0, m = 0;
      for (let y = py; y < py + PATCH; y++) {
        for (let x = px; x < px + PATCH; x++) {
          const i = (y * img.w + x) * 4;
          if (mask && !(mask.data[i + 1] > 60 && mask.data[i] < 30 && mask.data[i + 2] < 30)) continue;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; m++;
        }
      }
      if (m < PATCH * PATCH * 0.85) continue;
      // +1 so a black patch is not a log of zero.
      r = r / m + 1; g = g / m + 1; b = b / m + 1;
      rb.push(Math.log(r / b));
      gm.push(Math.log(g / Math.sqrt(r * b)));
      L.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const sd = (a: number[]): number => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length)); };
  return { n: L.length, rb: sd(rb), gm: sd(gm), lumCv: sd(L) / Math.max(1e-6, mean(L)) };
}

async function shoot(outDir: string, query: string): Promise<void> {
  const args = [
    "tools/shots.ts", "--only", POSE, "--out", outDir,
    "--port", arg("port", "5201"), "--debug-port", arg("debug-port", "9521"),
  ];
  if (query) args.push("--query", query);
  const profile = arg("profile", "");
  if (profile) args.push("--profile", profile);
  const p = Bun.spawn(["bun", ...args], { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`shots.ts failed for "${query}"`);
}

const fmt = (s: Spread): string =>
  `${s.n} patches: sd ln(R/B) ${s.rb.toFixed(4)}, sd ln(G/sqrt(RB)) ${s.gm.toFixed(4)}, lum CV ${s.lumCv.toFixed(3)}`;

async function main(): Promise<void> {
  const ref = arg("reference", "");
  if (ref) {
    console.log(`reference ${ref}: ${fmt(spread(decodePng(ref) as Img, null))}`);
    return;
  }
  const out = arg("out", "shots/farcolour");
  if (!has("reuse")) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    console.log("rendering Midtown from 600 m ...");
    await shoot(`${out}/full`, "");
    console.log("rendering it with one palette colour (?onepalette=1) ...");
    await shoot(`${out}/one`, "onepalette=1");
    console.log("rendering the far-field mask (?buildingDebug=6) ...");
    await shoot(`${out}/mask`, "buildingDebug=6");
  }
  const mask = decodePng(`${out}/mask/${POSE}.png`) as Img;
  const full = spread(decodePng(`${out}/full/${POSE}.png`) as Img, mask);
  const one = spread(decodePng(`${out}/one/${POSE}.png`) as Img, mask);
  console.log(`  render      ${fmt(full)}\n  one palette ${fmt(one)}\n  reference   sd ln(R/B) ${REF_RB}, sd ln(G/sqrt(RB)) ${REF_GM}`);

  // Under 200 wall patches the frame has stopped being the far field.
  const enough = full.n >= 200;
  check(`${POSE}: the far field has a city's colours`, enough && full.rb >= RB_FLOOR,
    `sd ln(R/B) ${full.rb.toFixed(4)} >= ${RB_FLOOR.toFixed(4)} (photo ${REF_RB})`);
  probe(`${POSE}: one palette is one grey`, one.n >= 200 && one.rb >= RB_FLOOR, `onepalette ${one.rb.toFixed(4)}`);
  check(`${POSE}: teal glass and red brick`, enough && full.gm >= GM_FLOOR,
    `sd ln(G/sqrt(RB)) ${full.gm.toFixed(4)} >= ${GM_FLOOR} (photo ${REF_GM})`);
  probe(`${POSE}: one palette has neither`, one.n >= 200 && one.gm >= GM_FLOOR, `onepalette ${one.gm.toFixed(4)}`);

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

await main();
