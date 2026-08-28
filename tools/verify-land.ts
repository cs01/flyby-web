// Parses every .land pack with the SAME reader the app uses and checks it is
// both whole and true. Run after any bake.
//
// Two different failures are in scope and only one of them is about bytes.
//
// The structural one is a truncated pack from an interrupted bake: it is large,
// it has a valid header, and it is on disk, so a size check and a directory
// listing both pass it happily. Only accounting for every byte proves it whole.
//
// The other is a pack that is perfectly well formed and simply wrong: a
// georeferencing slip, an off-by-one in the sheet indexing, a pyramid level
// read at the wrong scale. All of those produce a legal grid of legal class
// codes, so the format check waves them through. The point probes and coverage
// floors below are the part that cannot be satisfied by accident: they say
// where San Francisco, the Golden Gate and Lake Michigan actually are.

import {
  LAND_CLASS_CODES,
  LAND_CLASS_NAMES,
  LandClass,
  parseLandPack,
  sampleLand,
  type LandLevel,
} from "../src/data/landcover";
import { Origin } from "../src/geo";
import { readdirSync } from "node:fs";

const dir = new URL("../public/cities/", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith(".land")).sort();

const LEGAL = new Set<number>(LAND_CLASS_CODES);

interface Probe {
  name: string;
  lat: number;
  lon: number;
  want: LandClass[];
}

/** Points whose class is not a matter of opinion. A pack that disagrees is
 *  mis-georeferenced, not differently tuned. */
const PROBES: Record<string, Probe[]> = {
  sf: [
    { name: "SF centre", lat: 37.7749, lon: -122.4194, want: [LandClass.Built] },
    { name: "Golden Gate mid-channel", lat: 37.8199, lon: -122.4783, want: [LandClass.Water] },
    {
      name: "Golden Gate Park",
      lat: 37.7694,
      lon: -122.4862,
      want: [LandClass.Tree, LandClass.Grass],
    },
  ],
};

interface Floor {
  cls: LandClass;
  minPct: number;
  /** Measure against the non-water texels rather than the whole grid. */
  ofLand?: boolean;
}

/**
 * Coverage a correct bake cannot miss. Deliberately far below the real value,
 * so the floor catches a broken bake rather than tracking the dataset.
 *
 * San Francisco's built floor is measured over land and not over the box, and
 * that is a fact about where the pack is centred, not a softened threshold. The
 * sf origin (37.8085, -122.4098) is the northern waterfront, so 64.5% of its
 * 12 km box is the Bay, the Golden Gate and the Pacific, and no correct bake
 * can put built above 40% of the whole grid. Over the land it is 73.9%, which
 * matches a hand decode of one full-resolution source tile over the city
 * (built 74.8%, tree 19.6%, grass 3.5%, bare 0.6%) to within a point.
 */
const FLOORS: Record<string, Floor[]> = {
  sf: [
    { cls: LandClass.Built, minPct: 40, ofLand: true },
    { cls: LandClass.Water, minPct: 50 }, // the Bay and the Golden Gate
  ],
  manhattan: [{ cls: LandClass.Water, minPct: 10 }], // Hudson and East River
  chicago: [
    { cls: LandClass.Water, minPct: 10 }, // Lake Michigan
    { cls: LandClass.Built, minPct: 40 },
  ],
};

function pct(level: LandLevel, cls: number, ofLand: boolean): number {
  let n = 0;
  let total = 0;
  for (const c of level.cls) {
    if (ofLand && c === LandClass.Water) continue;
    total++;
    if (c === cls) n++;
  }
  return total === 0 ? 0 : (100 * n) / total;
}

function histogramLine(level: LandLevel): string {
  const counts = new Map<number, number>();
  for (const c of level.cls) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, k]) => `${LAND_CLASS_NAMES[c] ?? `?${c}`} ${((100 * k) / level.cls.length).toFixed(1)}%`)
    .join("  ");
}

let failed = 0;
const goodIds = new Set<string>();

for (const f of files) {
  const id = f.replace(/\.land$/, "");
  const buf = await Bun.file(dir + f).arrayBuffer();
  const problems: string[] = [];

  let pack;
  try {
    pack = parseLandPack(buf);
  } catch (err) {
    console.log(`FAIL ${id.padEnd(12)} unparseable: ${(err as Error).message}`);
    failed++;
    continue;
  }

  // Every byte must be accounted for. A pack that parses but leaves bytes over,
  // or that ran out early, is corrupt however plausible it looks.
  // Header: magic+version (8) + lat0/lon0 (16) + levelCount (1) = 25.
  // Level:  extentM (4) + n (2) = 6, plus n*n payload bytes.
  // Getting these two constants wrong makes the check fail on every pack at
  // once by a constant per-level amount, which is what a wrong ORACLE looks
  // like, as opposed to a real corruption, which would hit one file and by an
  // arbitrary amount.
  let expected = 25;
  for (const l of pack.levels) expected += 6 + l.n * l.n;
  if (expected !== buf.byteLength) {
    problems.push(`size mismatch: levels account for ${expected} of ${buf.byteLength} bytes`);
  }

  if (pack.levels.length !== 2) problems.push(`${pack.levels.length} levels, expected 2`);

  for (let i = 0; i < pack.levels.length; i++) {
    const l = pack.levels[i];
    if (!(l.n > 0)) problems.push(`L${i} n is ${l.n}`);
    if (!(l.extentM > 0)) problems.push(`L${i} extentM is ${l.extentM}`);
    let illegal = 0;
    let firstIllegal = -1;
    for (const c of l.cls) {
      if (!LEGAL.has(c)) {
        illegal++;
        if (firstIllegal < 0) firstIllegal = c;
      }
    }
    if (illegal) problems.push(`L${i} has ${illegal} illegal class codes (first ${firstIllegal})`);
  }

  const l0 = pack.levels[0];
  const origin = new Origin(pack.lat0, pack.lon0);

  const probeLines: string[] = [];
  for (const p of PROBES[id] ?? []) {
    const w = origin.toWorld(p.lat, p.lon);
    const got = sampleLand(l0, w.x, w.z);
    const ok = p.want.includes(got);
    // Clamp-to-edge is the sampler's contract and the renderer will sample the
    // same way, but a probe that clamps is testing a nearby texel rather than
    // the one it named, so say by how much.
    const outBy = Math.max(0, Math.abs(w.x) - l0.extentM, Math.abs(w.z) - l0.extentM);
    probeLines.push(
      `     ${ok ? "PASS" : "FAIL"}  ${p.name}: ${LAND_CLASS_NAMES[got] ?? got}` +
        ` (want ${p.want.map((c) => LAND_CLASS_NAMES[c]).join("/")})` +
        (outBy > 0 ? `  [clamped, ${outBy.toFixed(0)} m outside L0]` : ""),
    );
    if (!ok) problems.push(`probe ${p.name} is ${LAND_CLASS_NAMES[got] ?? got}`);
  }

  for (const fl of FLOORS[id] ?? []) {
    const of = fl.ofLand ? "of land" : "of box";
    const v = pct(l0, fl.cls, fl.ofLand === true);
    if (v < fl.minPct) {
      problems.push(`L0 ${LAND_CLASS_NAMES[fl.cls]} ${v.toFixed(1)}% ${of} < ${fl.minPct}% floor`);
    }
    probeLines.push(
      `     ${v < fl.minPct ? "FAIL" : "PASS"}  ${LAND_CLASS_NAMES[fl.cls]} ${of}` +
        ` ${v.toFixed(1)}% >= ${fl.minPct}%`,
    );
  }

  if (problems.length) {
    console.log(`FAIL ${id.padEnd(12)} ${problems.join("; ")}`);
    failed++;
  } else {
    goodIds.add(id);
    console.log(`ok   ${id.padEnd(12)} ${(buf.byteLength / 1048576).toFixed(2)} MB  at ${pack.lat0}, ${pack.lon0}`);
  }
  for (let i = 0; i < pack.levels.length; i++) {
    const l = pack.levels[i];
    console.log(
      `     L${i} ${l.n}x${l.n} +-${l.extentM} m (${((l.extentM * 2) / l.n).toFixed(1)} m/texel)  ` +
        histogramLine(l),
    );
  }
  for (const line of probeLines) console.log(line);
}

// Cross-check the index against what is actually on disk, the way
// verify-packs.ts does for index.json. An id listed with no readable pack is
// the index making a promise the renderer cannot keep.
try {
  const listed: string[] = JSON.parse(await Bun.file(dir + "land-index.json").text());
  const missing = listed.filter((id) => !goodIds.has(id));
  const unlisted = [...goodIds].filter((id) => !listed.includes(id));
  if (missing.length) {
    console.log(`FAIL land-index.json lists ${missing.join(", ")} with no readable pack`);
    failed++;
  }
  if (unlisted.length) {
    console.log(`FAIL land-index.json is missing ${unlisted.join(", ")} -- run: bun tools/bake-land.ts`);
    failed++;
  }
} catch {
  console.log("FAIL land-index.json missing or unreadable -- run: bun tools/bake-land.ts");
  failed++;
}

console.log(
  failed
    ? `\n${failed} problem(s) across ${files.length} land packs`
    : `\nall ${files.length} land packs ok, land-index.json agrees`,
);
process.exit(failed ? 1 : 0);
