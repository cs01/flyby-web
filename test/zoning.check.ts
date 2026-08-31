// The gate on recovering Residential from shape, for buildings OSM never tagged.
//
// 86-90% of every pack is `building=yes`, so in a suburb almost nothing is
// classified and a street of houses renders as flat commercial slabs. The
// second pass in osmbuildings.ts promotes the footprints that are
// geometrically houses. A rule like that is one bad threshold away from
// promoting a business park, and it fires on data nobody will ever inspect by
// hand, so it needs an oracle rather than an opinion.
//
// The oracle is already in the repo: the shipped .city packs carry a `kind`
// for every building, and a meaningful minority of those were tagged by a real
// mapper. Mask a label back to Generic, run the rule over the whole pack (the
// density term needs the whole candidate population), and read off whether it
// came back:
//
//   recall  -- tagged Residential under 9 m, which is houses and bungalows
//              rather than apartment blocks, that the rule recovers.
//   false + -- tagged Industrial / Commercial / Retail that it wrongly claims.
//
// The false-positive number is not meant to reach zero. A small shop on a
// suburban corner genuinely looks like a house from the air, and a rule
// contorted to never claim one would stop claiming houses too.
//
// This calls the same inferResidential that buildingsFromOsm calls. A second
// copy of the rule written for the test would only ever agree with itself
// (same discipline as the header of roof.check.ts).
//
// Watched to fail: MIN_NEIGHBOURS 6 -> 40 in osmbuildings.ts takes combined
// recall from 79.9% to 9.1% and emeraldhills from 66.2% residential back to
// the 12.6% OSM tagged, and this exits 1 with 7 of its 10 checks FAILED, the
// first being "recall on tagged low-rise Residential". Restored after.

import { readdirSync } from "node:fs";
import {
  BuildingKind,
  parseCityPack,
  RoofShape,
  type Building,
  type PackedBuilding,
} from "../src/data/citypack";
import {
  HOUSE_MAX_AREA_M2,
  HOUSE_MAX_EDGE_M,
  HOUSE_MAX_TOP_M,
  HOUSE_MIN_AREA_M2,
  inferResidential,
  MIN_NEIGHBOURS,
  NEIGHBOUR_RADIUS_M,
  QUANT,
} from "../src/data/osmbuildings";

const DIR = "public/cities";
const MIN_RECALL = 0.75;
const MAX_FP = 0.15;
const SUBURB_MIN_SHARE = 0.55;
const DOWNTOWN_MAX_SHARE = 0.25;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

/**
 * A vacuity probe and the blinding that proves the probe can fail, the same
 * pair live.check.ts uses: `rejects the bad case` alone is what a predicate
 * that returns false for everything scores full marks on.
 */
function probe(name: string, predicate: () => boolean, broken: () => boolean): void {
  const good = predicate();
  const bad = broken();
  check(
    `vacuity: ${name}`,
    good && !bad,
    good
      ? bad
        ? "the probe ACCEPTS the broken case: this assertion cannot fail"
        : "rejects the broken case, accepts the real one"
      : "the probe rejects the REAL case: the assertion is wrong, not the code",
  );
}

// --- packs as the rule's own input ------------------------------------------

/**
 * A pack record back into the form the rule consumes. The pack stores absolute
 * ring vertices; the rule reads i16 quarter-metre offsets, which is what the
 * live converter hands it, so the quantisation is redone here rather than the
 * rule being given a second entry point that skips it.
 */
function repack(b: Building): PackedBuilding {
  const n = b.ring.length / 2;
  const dx = new Int16Array(n);
  const dz = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    dx[i] = Math.round((b.ring[i * 2] - b.cx) / QUANT);
    dz[i] = Math.round((b.ring[i * 2 + 1] - b.cz) / QUANT);
  }
  return { cx: b.cx, cz: b.cz, baseM: b.baseM, topM: b.topM, kind: b.kind, roof: b.roof, dx, dz };
}

/**
 * Run the rule over a copy of the pack with `masked` labels forced to Generic.
 * Returns the promoted flag per index. The copy is per-run because the rule
 * mutates, and the whole population goes in every time because the density
 * term is a property of the neighbourhood, not of the building.
 */
function runMasked(pack: readonly PackedBuilding[], masked: Uint8Array): Uint8Array {
  const copy = pack.map((b, i) => (masked[i] === 1 ? { ...b, kind: BuildingKind.Generic } : { ...b }));
  // No pack records the mapper's roof tag, so nothing here is treated as
  // explicitly roofed. That is the conservative direction for this gate: it
  // can only make the rule change MORE roofs than it would on live data.
  inferResidential(copy, new Array<boolean>(copy.length).fill(false));
  const out = new Uint8Array(pack.length);
  for (let i = 0; i < copy.length; i++) {
    // Promoted means the rule changed this one, so the input kind has to be
    // Generic: either it was masked to Generic, or the pack already had it so.
    const wasGeneric = masked[i] === 1 || pack[i].kind === BuildingKind.Generic;
    if (wasGeneric && copy[i].kind === BuildingKind.Residential) out[i] = 1;
  }
  return out;
}

const FP_KINDS = new Set([BuildingKind.Industrial, BuildingKind.Commercial, BuildingKind.Retail]);

interface PackScore {
  name: string;
  recallHit: number;
  recallTotal: number;
  fpHit: number;
  fpTotal: number;
  share: number;
  shareBefore: number;
  coreShare: number;
}

/**
 * The downtown test is scoped to the middle of the pack, not the whole of it.
 *
 * A pack is 6-8 km of radius around one point, which for manhattan.city
 * (Bryant Park) reaches Astoria, Williamsburg and Jersey City: three
 * boroughs' worth of two-storey row housing that really is residential, and
 * ~40% of the pack's 187k buildings. No setting of the rule brings that number
 * under 25% while it still works, measured: N=20 at a 50 m radius gets the
 * whole-pack share to 0.22 and keeps 13% of the recall. Within 2 km of the
 * origin it is Midtown, and there the rule promotes 4% -- which is the number
 * a rule that had learned "small footprint" and not "small footprints
 * TOGETHER, away from the towers" would blow through.
 */
const CORE_RADIUS_M = 2000;

const scores: PackScore[] = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".city")).sort()) {
  const pack = parseCityPack(await Bun.file(`${DIR}/${file}`).arrayBuffer());
  const packed = pack.buildings.map(repack);
  const n = packed.length;

  const resMask = new Uint8Array(n);
  let recallTotal = 0;
  for (let i = 0; i < n; i++) {
    if (packed[i].kind === BuildingKind.Residential && packed[i].topM <= 9) {
      resMask[i] = 1;
      recallTotal++;
    }
  }
  const resOut = runMasked(packed, resMask);
  let recallHit = 0;
  for (let i = 0; i < n; i++) if (resMask[i] === 1 && resOut[i] === 1) recallHit++;

  const fpMask = new Uint8Array(n);
  let fpTotal = 0;
  for (let i = 0; i < n; i++) {
    if (FP_KINDS.has(packed[i].kind)) {
      fpMask[i] = 1;
      fpTotal++;
    }
  }
  const fpOut = runMasked(packed, fpMask);
  let fpHit = 0;
  for (let i = 0; i < n; i++) if (fpMask[i] === 1 && fpOut[i] === 1) fpHit++;

  const plain = runMasked(packed, new Uint8Array(n));
  let residentialAfter = 0;
  let residentialBefore = 0;
  let coreCount = 0;
  let coreResidential = 0;
  for (let i = 0; i < n; i++) {
    const isResidential = packed[i].kind === BuildingKind.Residential || plain[i] === 1;
    if (packed[i].kind === BuildingKind.Residential) residentialBefore++;
    if (isResidential) residentialAfter++;
    if (Math.hypot(packed[i].cx, packed[i].cz) <= CORE_RADIUS_M) {
      coreCount++;
      if (isResidential) coreResidential++;
    }
  }

  scores.push({
    name: file.replace(".city", ""),
    recallHit,
    recallTotal,
    fpHit,
    fpTotal,
    share: residentialAfter / n,
    shareBefore: residentialBefore / n,
    coreShare: coreResidential / coreCount,
  });
}

const totalRecallHit = scores.reduce((a, s) => a + s.recallHit, 0);
const totalRecallTotal = scores.reduce((a, s) => a + s.recallTotal, 0);
const totalFpHit = scores.reduce((a, s) => a + s.fpHit, 0);
const totalFpTotal = scores.reduce((a, s) => a + s.fpTotal, 0);
const recall = totalRecallHit / totalRecallTotal;
const fp = totalFpHit / totalFpTotal;

console.log(
  `pack           houses recall   non-homes false+   residential share    core 2 km`,
);
for (const s of scores) {
  console.log(
    `${s.name.padEnd(13)} ${String(s.recallTotal).padStart(6)}  ` +
      `${(s.recallHit / s.recallTotal).toFixed(3)}   ` +
      `${String(s.fpTotal).padStart(7)}   ${(s.fpHit / s.fpTotal).toFixed(3)}    ` +
      `${(s.shareBefore * 100).toFixed(1)}% -> ${(s.share * 100).toFixed(1)}%`.padStart(16) +
      `    ${(s.coreShare * 100).toFixed(1)}%`,
  );
}
console.log("");

check(
  "recall on tagged low-rise Residential",
  recall >= MIN_RECALL,
  `${(recall * 100).toFixed(1)}% of ${totalRecallTotal} tagged houses recovered (need >= ${(MIN_RECALL * 100).toFixed(0)}%)`,
);
check(
  "false positives on tagged Industrial/Commercial/Retail",
  fp <= MAX_FP,
  `${(fp * 100).toFixed(1)}% of ${totalFpTotal} tagged non-homes claimed (need <= ${(MAX_FP * 100).toFixed(0)}%)`,
);

// ===========================================================================
// Suburb vs downtown. The check a rule that promoted everything fails.
// ===========================================================================

const byName = new Map(scores.map((s) => [s.name, s]));
const suburb = byName.get("emeraldhills")!;
const downtown = byName.get("manhattan")!;

check(
  "emeraldhills reads as a suburb after inference",
  suburb.share > SUBURB_MIN_SHARE,
  `${(suburb.share * 100).toFixed(1)}% residential, from ${(suburb.shareBefore * 100).toFixed(1)}% tagged ` +
    `(need > ${(SUBURB_MIN_SHARE * 100).toFixed(0)}%)`,
);
check(
  "midtown manhattan does not",
  downtown.coreShare < DOWNTOWN_MAX_SHARE,
  `${(downtown.coreShare * 100).toFixed(1)}% residential within ${CORE_RADIUS_M / 1000} km of the origin, ` +
    `against ${(suburb.coreShare * 100).toFixed(1)}% for emeraldhills (need < ${(DOWNTOWN_MAX_SHARE * 100).toFixed(0)}%)`,
);

// ===========================================================================
// The mapper's own roof tag outranks the rule.
// ===========================================================================

/** A square footprint of `side` metres, at (x, z). */
function square(x: number, z: number, side: number, topM: number): PackedBuilding {
  const h = side / 2 / QUANT;
  return {
    cx: x,
    cz: z,
    baseM: 0,
    topM,
    kind: BuildingKind.Generic,
    roof: RoofShape.Flat,
    dx: Int16Array.from([-h, h, h, -h]),
    dz: Int16Array.from([-h, -h, h, h]),
  };
}

/**
 * A cul-de-sac: a 4x4 block of identical footprints on a `side + 4` metre
 * pitch. Every house in it is within NEIGHBOUR_RADIUS_M of all fifteen others
 * (a 15 m pitch puts the far corner at 64 m), so the density term is satisfied
 * for all of them and each probe below isolates one geometric test.
 */
function block(side = 11, topM = 7): PackedBuilding[] {
  const pitch = Math.max(15, side + 4);
  const out: PackedBuilding[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out.push(square(c * pitch, r * pitch, side, topM));
  return out;
}

{
  const houses = block();
  const tagged = houses.map((_, i) => i === 0);
  const promoted = inferResidential(houses, tagged);
  check(
    "an explicit roof:shape=flat survives promotion",
    promoted === houses.length &&
      houses[0].kind === BuildingKind.Residential &&
      houses[0].roof === RoofShape.Flat &&
      houses[1].roof === RoofShape.Pitched,
    `${promoted}/${houses.length} promoted, the tagged-flat house kept roof ${RoofShape[houses[0].roof]}, ` +
      `its untagged neighbour got ${RoofShape[houses[1].roof]}`,
  );
}

// ===========================================================================
// Vacuity. Every probe below is a pair: it must accept the real case AND
// reject one built to break it.
// ===========================================================================

function promotedCount(bs: PackedBuilding[]): number {
  return inferResidential(bs, new Array<boolean>(bs.length).fill(false));
}

/** Every house in the block promoted, which is what the negatives are read against. */
const wholeBlock = (): boolean => promotedCount(block()) === 16;

probe(
  "the density term would notice a lone small footprint",
  wholeBlock,
  // A pump house on its own: house-shaped, house-sized, no neighbours.
  () => promotedCount([square(0, 0, 11, 7)]) > 0,
);
probe(
  "the edge test would notice a business park",
  wholeBlock,
  // The same block at the same density, elevations past HOUSE_MAX_EDGE_M.
  () => promotedCount(block(HOUSE_MAX_EDGE_M + 6)) > 0,
);
probe(
  "the height test would notice an apartment block",
  () => promotedCount(block(11, HOUSE_MAX_TOP_M)) === 16,
  () => promotedCount(block(11, HOUSE_MAX_TOP_M + 9)) > 0,
);
probe(
  "the area test would notice a row of garden sheds",
  wholeBlock,
  () => promotedCount(block(Math.sqrt(HOUSE_MIN_AREA_M2) - 2, 3)) > 0,
);
probe(
  "the recall measurement moves with the rule, rather than reporting a constant",
  () => recall > 0 && recall < 1,
  () => totalRecallTotal === 0,
);

// ===========================================================================

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(58)} ${r.detail}`);
}
console.log(
  failed === 0
    ? `\nall ${results.length} zoning checks ok ` +
        `(rule: <= ${HOUSE_MAX_TOP_M} m, ${HOUSE_MIN_AREA_M2}-${HOUSE_MAX_AREA_M2} m^2, ` +
        `edge <= ${HOUSE_MAX_EDGE_M} m, ${MIN_NEIGHBOURS}+ within ${NEIGHBOUR_RADIUS_M} m)`
    : `\n${failed} of ${results.length} zoning checks FAILED`,
);
if (failed) process.exit(1);
