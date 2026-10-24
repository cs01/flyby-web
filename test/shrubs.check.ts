// The gate on shrub placement, against the real committed packs.
//
// Same discipline as test/trees.check.ts: every bound is a literal, never the
// constant under test, and every assertion is followed by a vacuity probe, the
// same checker fed a case it must reject.
//
// Watched to fail, each applied to src/data/shrubs.ts, seen red, restored:
//   * deleting the water rejection: worst water under a shrub 0.034 -> 0.558;
//   * deleting the road rejection: 1070 of 4525 on a carriageway;
//   * deleting the slope rejection: 3455 shrubs on a 50 degree slope;
//   * hashing the box corner into the jitter: 4088 whole against 4075 tiled.

import { parseLandPack, type LandPack } from "../src/data/landcover";
import { buildLandMaskRGBA, sampleMaskBilinear } from "../src/data/landmask";
import { parseRoadPack } from "../src/data/roadpack";
import { RoadIndex, treeRoadClearanceM, type TreeInstance, type TreeMask } from "../src/data/trees";
import {
  buildShrubMaskRGBA,
  placeShrubs,
  shrubClump,
  SHRUB_SPACING_M,
  type ShrubField,
} from "../src/data/shrubs";

const DIR = "public/cities";

// --- literal bounds ----------------------------------------------------------

/** Bilinear water coverage (the GPU mask's) a shrub may stand in. */
const MAX_WATER_AT_A_SHRUB = 0.1;
/** How far the count may sit from the clump-weighted coverage expectation. */
const COUNT_RATIO_LO = 0.9;
const COUNT_RATIO_HI = 1.1;
/** Shrubs per square kilometre the Marin headlands must carry. */
const MIN_MARIN_PER_KM2 = 4000;
/** How many times denser Marin must be with the stand-in rule than without. */
const MIN_STAND_IN_RATIO = 2;

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} ${detail}`);
  if (!ok) failures++;
}
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(46)} ${detail}`);
  if (!ok) failures++;
}

async function land(id: string): Promise<LandPack> {
  return parseLandPack(await Bun.file(`${DIR}/${id}.land`).arrayBuffer());
}

function shrubMask(pack: LandPack, level: number, treesPlanted: boolean): TreeMask {
  const l = pack.levels[level];
  return { rgba: buildShrubMaskRGBA(l, treesPlanted), n: l.n, extentM: l.extentM };
}

const FLAT = (): number => 30;
const key = (s: TreeInstance): string => `${s.x.toFixed(3)},${s.z.toFixed(3)}`;

const sf = await land("sf");
const sfRoads = parseRoadPack(await Bun.file(`${DIR}/sf.roads`).arrayBuffer()).roads;
const roads = new RoadIndex(sfRoads, treeRoadClearanceM);
const field: ShrubField = {
  near: shrubMask(sf, 0, true),
  far: shrubMask(sf, 1, false),
  heightAt: FLAT,
  roads,
};
const water = (() => {
  const l = sf.levels[0];
  const rgba = buildLandMaskRGBA(l);
  return (x: number, z: number): number => sampleMaskBilinear(rgba, l.n, l.extentM, x, z).water;
})();

// --- 1. the lattice is absolute ----------------------------------------------

console.log("\n--- placing a box equals placing its quadrants ---");
{
  // The Presidio: shrubland, trees, roads and water in one box.
  const x0 = -5376, z0 = 512, s = 1024, h = s / 2;
  const whole = placeShrubs(field, x0, z0, x0 + s, z0 + s);
  const parts: TreeInstance[] = [];
  for (const [dx, dz] of [[0, 0], [h, 0], [0, h], [h, h]]) {
    placeShrubs(field, x0 + dx, z0 + dz, x0 + dx + h, z0 + dz + h, parts);
  }
  const a = new Set(whole.map(key));
  const b = new Set(parts.map(key));
  const same = a.size === b.size && [...a].every((k) => b.has(k)) && whole.length === parts.length;
  check("tiles partition the lattice", same && whole.length > 500, `${whole.length} whole, ${parts.length} tiled`);
  probe("a dropped shrub is noticed", parts.length - 1 === whole.length, `${parts.length - 1} vs ${whole.length}`);
}

// --- 2. rejection by evidence ------------------------------------------------

console.log("\n--- nothing on water or tarmac, nothing on a cliff ---");
{
  const box = placeShrubs(field, -5600, -1500, -3000, 1100);
  let worst = 0;
  let onRoad = 0;
  for (const s of box) {
    worst = Math.max(worst, water(s.x, s.z));
    if (roads.blocked(s.x, s.z)) onRoad++;
  }
  check("no shrub stands in water", worst <= MAX_WATER_AT_A_SHRUB && box.length > 1000, `worst ${worst.toFixed(3)} over ${box.length}`);
  // Poison: the Golden Gate strait, open water by any measure.
  probe("a shrub in the strait is caught", water(-5800, -1100) <= MAX_WATER_AT_A_SHRUB, `water ${water(-5800, -1100).toFixed(3)}`);
  check("no shrub stands on a carriageway", onRoad === 0, `${onRoad} of ${box.length}`);
  // Poison: the first vertex of the first carriageway in the pack.
  const r = sfRoads.find((rd) => rd.cls < 10)!;
  const rx = r.pts[0], rz = r.pts[1];
  probe("a point on a road centreline is blocked", !roads.blocked(rx, rz), `blocked ${roads.blocked(rx, rz)}`);

  const steep: ShrubField = { ...field, heightAt: (x: number) => x * 1.2 };
  const gentle: ShrubField = { ...field, heightAt: (x: number) => x * 0.5 };
  const nSteep = placeShrubs(steep, -5600, -1500, -3000, 1100).length;
  const nGentle = placeShrubs(gentle, -5600, -1500, -3000, 1100).length;
  check("a 50 degree slope holds no shrub", nSteep === 0, `${nSteep}`);
  probe("a 27 degree slope still does", nGentle === 0, `${nGentle}`);
}

// --- 3. density is the coverage, arranged by the clump field ------------------

console.log("\n--- the count tracks the coverage ---");
{
  const x0 = -5600, z0 = -1500, x1 = -3000, z1 = 1100;
  const noRoads: ShrubField = { ...field, roads: null };
  const n = placeShrubs(noRoads, x0, z0, x1, z1).length;
  // The oracle walks the cell CENTRES, not the jittered candidates, and reads
  // the coverage there: it shares the clump field (which IS the arrangement
  // being claimed) and nothing else of the placement.
  let expected = 0;
  const sp = SHRUB_SPACING_M;
  const l = sf.levels[0];
  const rgba = field.near.rgba;
  for (let z = Math.floor(z0 / sp) * sp + sp / 2; z < z1; z += sp) {
    for (let x = Math.floor(x0 / sp) * sp + sp / 2; x < x1; x += sp) {
      const s = sampleMaskBilinear(rgba, l.n, l.extentM, x, z);
      if (s.water > 0.05 || s.built > 0.4) continue;
      expected += Math.min(1, s.tree * 2 * shrubClump(x, z));
    }
  }
  const ratio = n / expected;
  check("count over clump-weighted coverage", ratio >= COUNT_RATIO_LO && ratio <= COUNT_RATIO_HI, `${n} / ${expected.toFixed(0)} = ${ratio.toFixed(3)}`);
  const half = (n * 0.5) / expected;
  probe("half the count is caught", half >= COUNT_RATIO_LO && half <= COUNT_RATIO_HI, `${half.toFixed(3)}`);
}

// --- 4. past the near level, the far level, and the stand-in rule -------------

console.log("\n--- the Marin headlands, past the near level ---");
{
  const x0 = -9000, z0 = -3500, x1 = -7000, z1 = -2000;
  const km2 = ((x1 - x0) * (z1 - z0)) / 1e6;
  const n = placeShrubs(field, x0, z0, x1, z1).length;
  const nNoFar = placeShrubs({ ...field, far: null }, x0, z0, x1, z1).length;
  const nUnder = placeShrubs({ ...field, far: shrubMask(sf, 1, true) }, x0, z0, x1, z1).length;
  check("Marin carries a shrub stand", n / km2 >= MIN_MARIN_PER_KM2, `${(n / km2).toFixed(0)} per km2`);
  probe("without the far level it does not", nNoFar / km2 >= MIN_MARIN_PER_KM2, `${(nNoFar / km2).toFixed(0)} per km2`);
  check("the stand-in rule is what carries it", n >= MIN_STAND_IN_RATIO * nUnder, `${n} vs ${nUnder} as understorey`);
  probe("the same field compared with itself", n >= MIN_STAND_IN_RATIO * n, `${n} vs ${n}`);
}

console.log(failures ? `\n${failures} shrub check(s) FAILED` : "\nall shrub checks ok");
if (failures) process.exit(1);
