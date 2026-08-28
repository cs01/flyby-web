// Parses every .city pack with the SAME reader the app uses and checks it is
// sane. Run after any bake.
//
// The failure this exists to catch is a truncated pack from an interrupted
// bake: it is large, it has a valid header, and it is on disk, so a size check
// and a directory listing both pass it happily. Only actually walking the
// records to the final byte proves the file is whole -- and a half-written pack
// is worse than a missing one, because the menu promises a skyline the renderer
// then fails to load.

import { buildingIsNeedle, isNeedle, parseCityPack } from "../src/data/citypack";
import { signedArea } from "../src/render/earcut";
import { readdirSync } from "node:fs";

const dir = new URL("../public/cities/", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith(".city")).sort();

let failed = 0;
const badIds = new Set<string>();

for (const f of files) {
  const id = f.replace(/\.city$/, "");
  const buf = await Bun.file(dir + f).arrayBuffer();
  const problems: string[] = [];

  let pack;
  try {
    pack = parseCityPack(buf);
  } catch (err) {
    console.log(`FAIL ${id.padEnd(12)} unparseable: ${(err as Error).message}`);
    failed++;
    badIds.add(id);
    continue;
  }

  // Every record must have been consumed. A pack that parses but leaves bytes
  // over, or that ran out early, is corrupt however plausible it looks.
  // Header: magic+version (8) + lat0/lon0 (16) + radius (4) + count (4) = 32.
  // Record: cx,cz,base,top (16) + kind,roof (2) + vertCount (2) = 20, plus
  // 4 bytes per vertex. Getting these two constants wrong makes the check fail
  // on every pack at once by a constant per-record amount -- which is what a
  // wrong ORACLE looks like, as opposed to a real corruption, which would hit
  // one file and by an arbitrary amount.
  let expected = 32;
  for (const b of pack.buildings) expected += 20 + (b.ring.length / 2) * 4;
  if (expected !== buf.byteLength) {
    problems.push(`size mismatch: records account for ${expected} of ${buf.byteLength} bytes`);
  }

  if (pack.buildings.length === 0) problems.push("no buildings");

  let cw = 0;
  let tooFar = 0;
  let badHeight = 0;
  let maxH = 0;
  for (const b of pack.buildings) {
    if (signedArea(b.ring) <= 0) cw++;
    if (Math.hypot(b.cx, b.cz) > pack.radiusM * 1.02) tooFar++;
    const h = b.topM - b.baseM;
    if (!(h > 0) || h > 1000) badHeight++;
    if (h > maxH) maxH = h;
  }
  if (cw) problems.push(`${cw} rings not counter-clockwise`);
  if (tooFar) problems.push(`${tooFar} centroids outside radius`);
  if (badHeight) problems.push(`${badHeight} implausible heights`);

  const needles = pack.buildings.filter(buildingIsNeedle).length;

  const heights = pack.buildings.map((b) => b.topM - b.baseM).sort((a, b) => a - b);
  const p50 = heights[Math.floor(heights.length / 2)];
  if (p50 < 3 || p50 > 30) problems.push(`median height ${p50.toFixed(1)} m is implausible`);

  if (problems.length) {
    console.log(`FAIL ${id.padEnd(12)} ${problems.join("; ")}`);
    failed++;
    badIds.add(id);
  } else {
    console.log(
      `ok   ${id.padEnd(12)} ${String(pack.buildings.length).padStart(7)} buildings  ` +
      `p50 ${p50.toFixed(0).padStart(3)} m  max ${maxH.toFixed(0).padStart(4)} m  ` +
      `${(buf.byteLength / 1048576).toFixed(1)} MB` +
      // Not a failure: packs baked before the mast filter still contain these,
      // and the loader drops them. It is reported so a re-bake can be seen to
      // have actually removed them rather than assumed to have.
      (needles ? `  (${needles} masts, dropped at load)` : ""),
    );
  }
}

// The mast filter is a threshold, and a threshold nobody tests drifts until it
// is either useless or eats the landmarks. These are the cases it exists to get
// right: real slender towers stay, OSM masts go. Checking the PREDICATE rather
// than a pack count is what makes this a gate, because a pack with no masts in
// it would otherwise let any threshold pass.
const NEEDLE_CASES: [string, number, number, boolean][] = [
  ["Steinway Tower 435 m on 18 m", 435, 18, false],
  ["432 Park 426 m on 28 m", 426, 28, false],
  ["Empire State 381 m on 129 m", 381, 129, false],
  ["Manhattan worst mast 471 m on 11 m", 471, 11, true],
  // Only the ratio rule can catch this one: its footprint clears the minimum
  // dimension, so without the ratio the mast would survive. Keeping a case per
  // rule is what stops either threshold from becoming decoration.
  ["a 600 m radio mast on 15 m", 600, 15, true],
  ["Sydney worst mast 266 m on 7 m", 266, 7, true],
  ["a 366 m spire on 7 m", 366, 7, true],
  ["an ordinary house 8 m on 9 m", 8, 9, false],
];
for (const [name, h, dim, want] of NEEDLE_CASES) {
  if (isNeedle(h, dim) !== want) {
    console.log(`FAIL needle rule: ${name} should ${want ? "" : "not "}be a mast`);
    failed++;
  }
}

// Cross-check the menu's index against what is actually on disk. The start
// screen marks a city as having a skyline from this file, so an id listed here
// with no readable pack is the menu making a promise the renderer cannot keep.
const good = new Set(
  files.map((f) => f.replace(/\.city$/, "")).filter((id) => !badIds.has(id)),
);
try {
  const listed: string[] = JSON.parse(await Bun.file(dir + "index.json").text());
  const missing = listed.filter((id) => !good.has(id));
  const unlisted = [...good].filter((id) => !listed.includes(id));
  if (missing.length) {
    console.log(`FAIL index.json lists ${missing.join(", ")} with no readable pack`);
    failed++;
  }
  if (unlisted.length) {
    console.log(`FAIL index.json is missing ${unlisted.join(", ")} -- run: bun tools/city-index.ts`);
    failed++;
  }
} catch {
  console.log("FAIL index.json missing or unreadable -- run: bun tools/city-index.ts");
  failed++;
}

console.log(failed ? `\n${failed} problem(s) across ${files.length} packs` : `\nall ${files.length} packs ok, index.json agrees`);
process.exit(failed ? 1 : 0);
