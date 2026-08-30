// The gate on tree placement, against the real committed packs.
//
// Placement is the half of the vegetation work that can be silently wrong. A
// screenshot settles whether a tree looks like a tree; it does not settle
// whether one is standing in San Francisco Bay four kilometres offshore,
// whether a stand of them is straddling the Bayshore Freeway, or whether the
// same tree is in the same place after the camera has crossed a tile boundary
// and come back. Those are arithmetic, so they are asserted here, under Bun,
// against public/cities/*.land and *.roads rather than against a fixture.
//
// GATE DISCIPLINE. Every bound below is a LITERAL, never the constant under
// test, and where a constant exists it is asserted to be inside its own literal
// bound rather than being the bound. Every assertion is followed by a VACUITY
// PROBE: the same checker fed a case it MUST reject, so a checker that has
// quietly stopped looking at anything reports red rather than green. This repo
// has shipped four gates that could never fail; the probes are the price of not
// shipping a fifth.
//
// Watched to fail. Every one of these was applied, seen red, and restored:
//   * deleting the water rejection puts 32 trees on water texels in sf and
//     takes the worst water coverage under a tree from 0.108 to 0.931;
//   * deleting the road rejection drops the nearest motorway from 12.13 m to
//     1.69 m;
//   * deleting the footprint exclusion puts 15.5% of sf's trees and 8.4% of
//     emeraldhills' inside a building;
//   * accepting at a constant rate instead of the coverage collapses the
//     count/coverage correlation from 0.997 to 0.745 and the ratio to 0.401;
//   * y: heightAt(x, z) -> y: 0 fails all 1814 sampled instances;
//   * TREE_JITTER 0.92 -> 2.4 puts four trees in one lattice cell;
//   * hashing a running counter instead of the lattice cell breaks the tiling
//     identity (8695 whole against 8659 tiled);
//   * TREE_MAX_WATER 0.12 -> 0.4 and TREE_MIN_CARRIAGEWAY_CLEARANCE_M 6.5 ->
//     3.0 each break their own literal-bound assertion.
// And every probe was blinded in turn -- the bound dropped, the poison moved
// onto dry land, the comparator forced to "equal", the ring test forced to
// "outside", the counter capped at one -- and each reported PROBE-FAIL.

import { parseLandPack, sampleLand, LandClass, type LandPack } from "../src/data/landcover";
import { buildLandMaskRGBA, sampleMaskBilinear } from "../src/data/landmask";
import { parseRoadPack, RoadClass, type Road } from "../src/data/roadpack";
import { parseCityPack, type Building, type CityPack } from "../src/data/citypack";
import {
  placeTrees,
  meanTreeCoverage,
  FootprintMask,
  RoadIndex,
  treeRoadClearanceM,
  TREE_JITTER,
  TREE_SPACING_M,
  TREE_TILE_M,
  TREE_MAX_WATER,
  TREE_MIN_CARRIAGEWAY_CLEARANCE_M,
  type TreeField,
  type TreeInstance,
  type TreeMask,
} from "../src/data/trees";
import { Origin } from "../src/geo";

const DIR = "public/cities";

// --- literal bounds ---------------------------------------------------------
// None of these is a constant the placement code reads. They are the numbers
// this check is willing to accept, written down once, here.

/** Bilinear water coverage a tree is allowed to stand in. */
const MAX_WATER_AT_A_TREE = 0.25;
/** Metres a tree must clear a motorway, trunk or primary centreline by. */
const MIN_CARRIAGEWAY_M = 6.0;
/** How far out the carriageway index answers, so `nearest` is exact to here. */
const CARRIAGEWAY_SEARCH_M = 60;
/** Pearson correlation between per-box counts and per-box coverage. */
const MIN_COUNT_COVERAGE_R = 0.95;
/** How far the total count may sit from the coverage-derived expectation. */
const COUNT_RATIO_LO = 0.88;
const COUNT_RATIO_HI = 1.12;
/** How much leafier emeraldhills must come out than manhattan, at minimum. */
const MIN_LEAFY_RATIO = 2.5;
/** How far the measured leafiness ratio may sit from the coverage-derived one. */
const LEAFY_TOLERANCE = 0.25;
/** Trees one lattice cell may produce. The lattice is the density, so two from
 *  one cell means a candidate escaped the cell that generated it and the tile
 *  identity below is only holding by luck. */
const MAX_PER_CELL = 1;
/** Fraction of trees allowed to stand inside a building's own footprint. Not
 *  zero: FootprintMask is a 4 m raster, so a ring that self-intersects can slip
 *  one through. It is three orders of magnitude under what deleting the
 *  exclusion produces. */
const MAX_INSIDE_FOOTPRINT = 0.001;

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} ${detail}`);
  if (!ok) failures++;
}

/**
 * A vacuity probe: the same predicate fed a case it must reject.
 *
 * `shouldFail` is the checker re-run over poisoned input. If it comes back
 * true, the checker cannot tell the poisoned case from the good one and the
 * assertion above it proved nothing.
 */
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(46)} ${detail}`);
  if (!ok) failures++;
}

// --- pack loading -----------------------------------------------------------

const landPacks = new Map<string, LandPack>();
async function land(id: string): Promise<LandPack> {
  if (!landPacks.has(id)) {
    const f = Bun.file(`${DIR}/${id}.land`);
    if (!(await f.exists())) throw new Error(`no ${DIR}/${id}.land -- run: bun tools/bake-land.ts --all`);
    landPacks.set(id, parseLandPack(await f.arrayBuffer()));
  }
  return landPacks.get(id)!;
}

async function roadsOf(id: string): Promise<Road[]> {
  const f = Bun.file(`${DIR}/${id}.roads`);
  if (!(await f.exists())) throw new Error(`no ${DIR}/${id}.roads -- run: bun tools/bake-roads.ts --all`);
  return parseRoadPack(await f.arrayBuffer()).roads;
}

async function cityOf(id: string): Promise<CityPack> {
  const f = Bun.file(`${DIR}/${id}.city`);
  if (!(await f.exists())) throw new Error(`no ${DIR}/${id}.city -- run: bun tools/bake-city.ts --all`);
  return parseCityPack(await f.arrayBuffer());
}

function maskOf(pack: LandPack): TreeMask {
  const level = pack.levels[0];
  return { rgba: buildLandMaskRGBA(level), n: level.n, extentM: level.extentM };
}

/**
 * A terrain that is not flat, so an instance that never asked the heightfield
 * is visible as y === 0. A ramp rather than noise, because the assertion has to
 * be an equality.
 */
const RAMP = (x: number, z: number): number => 12 + x * 0.011 - z * 0.007;

// --- 1. the count tracks the coverage ---------------------------------------

console.log("\n--- density follows the measured tree coverage ---");

{
  const pack = await land("emeraldhills");
  const mask = maskOf(pack);
  // No road or footprint rejection here on purpose: this assertion is about the
  // density LAW, and mixing in exclusions would let a broken law hide behind
  // them. The exclusions get their own assertions below.
  const field: TreeField = { mask, heightAt: RAMP };

  const BOX = 250;
  const HALF = 6;
  const actual: number[] = [];
  const expected: number[] = [];
  for (let k = -HALF; k < HALF; k++) {
    for (let i = -HALF; i < HALF; i++) {
      const x0 = i * BOX, z0 = k * BOX;
      const n = placeTrees(field, x0, z0, x0 + BOX, z0 + BOX).length;
      // The oracle: coverage sampled on ITS OWN 5 m lattice, which shares
      // nothing with the placement lattice, times the area, over the cell area.
      // Derived here from the mask, so raising TREE_SPACING_M moves both sides
      // and the ratio below still has to hold.
      const cov = meanTreeCoverage(mask, x0, z0, x0 + BOX, z0 + BOX, 5);
      actual.push(n);
      expected.push((cov * BOX * BOX) / (TREE_SPACING_M * TREE_SPACING_M));
    }
  }

  const r = pearson(actual, expected);
  const sumA = actual.reduce((a, b) => a + b, 0);
  const sumE = expected.reduce((a, b) => a + b, 0);
  const ratio = sumA / sumE;
  check(
    "emeraldhills: count correlates with coverage",
    r > MIN_COUNT_COVERAGE_R,
    `r ${r.toFixed(4)} > ${MIN_COUNT_COVERAGE_R} over ${actual.length} boxes`,
  );
  check(
    "emeraldhills: count matches the coverage expectation",
    ratio > COUNT_RATIO_LO && ratio < COUNT_RATIO_HI,
    `${sumA} placed vs ${sumE.toFixed(0)} expected, ratio ${ratio.toFixed(3)}`,
  );

  // PROBE. A field whose density does NOT follow coverage: the same lattice,
  // the same total count, but every cell accepted with the region's MEAN
  // coverage instead of its own. If the two assertions above cannot tell that
  // apart from the real thing, they are asserting nothing about density.
  const meanCov = meanTreeCoverage(mask, -HALF * BOX, -HALF * BOX, HALF * BOX, HALF * BOX, 5);
  const flat: number[] = [];
  for (let k = -HALF; k < HALF; k++) {
    for (let i = -HALF; i < HALF; i++) {
      flat.push(uniformCount(i * BOX, k * BOX, BOX, meanCov));
    }
  }
  const rFlat = pearson(flat, expected);
  const ratioFlat = flat.reduce((a, b) => a + b, 0) / sumE;
  probe(
    "uniform density is rejected",
    rFlat > MIN_COUNT_COVERAGE_R && ratioFlat > COUNT_RATIO_LO && ratioFlat < COUNT_RATIO_HI,
    `flat field: r ${rFlat.toFixed(4)}, ratio ${ratioFlat.toFixed(3)}`,
  );

  // The terrain lookup is part of placement, and an instance that skipped it
  // sits at y = 0 while every other assertion here still passes.
  const sample = placeTrees(field, -400, -400, 400, 400);
  let offRamp = 0;
  for (const t of sample) if (Math.abs(t.y - RAMP(t.x, t.z)) > 1e-6) offRamp++;
  check(
    "trees sit on the terrain",
    sample.length > 100 && offRamp === 0,
    `${sample.length} sampled, ${offRamp} off the height field`,
  );
  probe(
    "a tree left at y = 0 is caught",
    sample.length > 100 && countOffRamp([...sample, { ...sample[0], y: 0 }]) === 0,
    `poisoned instance at y = 0`,
  );
}

// --- 2. never on water ------------------------------------------------------

console.log("\n--- never on water (sf is 64.5% water) ---");

{
  const pack = await land("sf");
  const level = pack.levels[0];
  const mask = maskOf(pack);
  const origin = new Origin(pack.lat0, pack.lon0);
  const field: TreeField = { mask, heightAt: RAMP };

  const R = 4000;
  const trees = placeTrees(field, -R, -R, R, R);

  // Two independent tests, because they can fail apart. The class lookup is the
  // CATEGORICAL raster the pack actually stores; the coverage is the filtered
  // value the placement saw. A half-texel indexing error shows in the first and
  // not the second.
  const wet = trees.filter((t) => sampleLand(level, t.x, t.z) === LandClass.Water);
  let maxWater = 0;
  for (const t of trees) {
    const s = sampleMaskBilinear(mask.rgba, mask.n, mask.extentM, t.x, t.z);
    if (s.water > maxWater) maxWater = s.water;
  }
  check(
    "sf: no tree on a water texel",
    trees.length > 1000 && wet.length === 0,
    `${wet.length} of ${trees.length} trees over ${(2 * R) / 1000} km, worst water coverage ${maxWater.toFixed(3)}`,
  );
  check(
    "sf: water coverage under a tree stays low",
    maxWater < MAX_WATER_AT_A_TREE,
    `${maxWater.toFixed(3)} < ${MAX_WATER_AT_A_TREE}`,
  );
  check(
    "the placement threshold is inside that bound",
    TREE_MAX_WATER <= MAX_WATER_AT_A_TREE,
    `TREE_MAX_WATER ${TREE_MAX_WATER} <= ${MAX_WATER_AT_A_TREE}`,
  );

  // PROBE. One tree moved to open water 2.5 km off the Embarcadero, the same
  // point test/landmask.check.ts probes. Both tests must go red on it.
  const bay = origin.toWorld(37.81, -122.378);
  const poisoned: TreeInstance[] = [...trees, { ...trees[0], x: bay.x, z: bay.z }];
  const wetP = poisoned.filter((t) => sampleLand(level, t.x, t.z) === LandClass.Water);
  let maxWaterP = 0;
  for (const t of poisoned) {
    const s = sampleMaskBilinear(mask.rgba, mask.n, mask.extentM, t.x, t.z);
    if (s.water > maxWaterP) maxWaterP = s.water;
  }
  probe(
    "a tree in the Bay is caught",
    wetP.length === 0 && maxWaterP < MAX_WATER_AT_A_TREE,
    `class ${wetP.length} hits, coverage ${maxWaterP.toFixed(3)}`,
  );
}

// --- 3. never on a carriageway ---------------------------------------------

console.log("\n--- never on a carriageway ---");

for (const id of ["sf", "emeraldhills"]) {
  const pack = await land(id);
  const mask = maskOf(pack);
  const roads = await roadsOf(id);
  const city = await cityOf(id);

  const field: TreeField = {
    mask,
    heightAt: RAMP,
    roads: new RoadIndex(roads, treeRoadClearanceM),
    footprints: new FootprintMask(city.buildings, city.radiusM),
  };
  const R = 2200;
  const trees = placeTrees(field, -R, -R, R, R);

  // A SECOND index, built for measurement rather than for placement: only the
  // classes the assertion names, and a pad wide enough that `nearest` is an
  // exact distance out to CARRIAGEWAY_SEARCH_M rather than a rejection test.
  const carriageway = roads.filter(
    (r) => r.cls === RoadClass.Motorway || r.cls === RoadClass.Trunk || r.cls === RoadClass.Primary,
  );
  const measure = new RoadIndex(carriageway, () => CARRIAGEWAY_SEARCH_M);

  const { min, within } = nearestStats(measure, trees);
  check(
    `${id}: no tree within ${MIN_CARRIAGEWAY_M} m of a motorway/trunk/primary`,
    trees.length > 500 && min > MIN_CARRIAGEWAY_M,
    `nearest ${min.toFixed(2)} m over ${trees.length} trees (${within} inside the ${CARRIAGEWAY_SEARCH_M} m search)`,
  );
  // A search that found nothing would report Infinity and pass forever. This is
  // the assertion that says the index is actually looking at roads.
  check(
    `${id}: the carriageway search reaches trees at all`,
    within > 50,
    `${within} trees within ${CARRIAGEWAY_SEARCH_M} m of ${carriageway.length} ways`,
  );

  // Nothing standing in a building. Tested against the pack's own RINGS through
  // an independent point-in-polygon, not through FootprintMask, which is the
  // thing under test and would be agreeing with itself.
  const rings = new BuildingIndex(city.buildings, city.radiusM);
  let indoors = 0;
  for (const t of trees) if (rings.contains(t.x, t.z)) indoors++;
  check(
    `${id}: no tree standing inside a building`,
    trees.length > 500 && indoors / trees.length < MAX_INSIDE_FOOTPRINT,
    `${indoors} of ${trees.length} (${((100 * indoors) / trees.length).toFixed(3)}%)`,
  );

  if (id === "sf") {
    check(
      "the placement clearance is inside that bound",
      TREE_MIN_CARRIAGEWAY_CLEARANCE_M >= MIN_CARRIAGEWAY_M,
      `TREE_MIN_CARRIAGEWAY_CLEARANCE_M ${TREE_MIN_CARRIAGEWAY_CLEARANCE_M} >= ${MIN_CARRIAGEWAY_M}`,
    );
    // PROBE. The same field placed WITHOUT the footprint exclusion. If the ring
    // test cannot tell that apart, it is not looking at buildings.
    const unguarded = placeTrees({ ...field, footprints: null }, -R, -R, R, R);
    let unguardedIn = 0;
    for (const t of unguarded) if (rings.contains(t.x, t.z)) unguardedIn++;
    probe(
      "trees placed with no footprint mask are caught",
      unguardedIn / unguarded.length < MAX_INSIDE_FOOTPRINT,
      `${unguardedIn} of ${unguarded.length} indoors without the mask`,
    );

    // PROBE. One tree dropped exactly on a motorway centreline vertex.
    const mw = carriageway.find((r) => r.cls === RoadClass.Motorway)!;
    const onTarmac: TreeInstance[] = [...trees, { ...trees[0], x: mw.pts[0], z: mw.pts[1] }];
    const p = nearestStats(measure, onTarmac);
    probe(
      "a tree on the centreline is caught",
      p.min > MIN_CARRIAGEWAY_M,
      `nearest ${p.min.toFixed(2)} m`,
    );
  }
}

// --- 4. determinism ---------------------------------------------------------

console.log("\n--- determinism and partition independence ---");

{
  const pack = await land("emeraldhills");
  const mask = maskOf(pack);
  const roads = await roadsOf("emeraldhills");
  const field: TreeField = { mask, heightAt: RAMP, roads: new RoadIndex(roads, treeRoadClearanceM) };

  const X0 = -TREE_TILE_M * 4, X1 = TREE_TILE_M * 4;
  const whole = placeTrees(field, X0, X0, X1, X1);
  const again = placeTrees(field, X0, X0, X1, X1);
  check(
    "the same box twice is the same field",
    whole.length > 500 && identical(whole, again),
    `${whole.length} instances`,
  );

  // The LOD case: the renderer builds this box as sixteen 256 m tiles as the
  // camera moves, and every tree has to land where the single call put it.
  const tiled: TreeInstance[] = [];
  for (let k = X0; k < X1; k += TREE_TILE_M) {
    for (let i = X0; i < X1; i += TREE_TILE_M) {
      placeTrees(field, i, k, i + TREE_TILE_M, k + TREE_TILE_M, tiled);
    }
  }
  check(
    "tiling the box gives the same field",
    identical(whole, tiled),
    `${whole.length} whole vs ${tiled.length} in ${((X1 - X0) / TREE_TILE_M) ** 2} tiles`,
  );

  // And an uneven split, so the identity is not an artefact of the tile size.
  const quads: TreeInstance[] = [];
  const MX = X0 + 337, MZ = X0 + 1093;
  for (const [a, b, c, d] of [
    [X0, X0, MX, MZ], [MX, X0, X1, MZ], [X0, MZ, MX, X1], [MX, MZ, X1, X1],
  ]) {
    placeTrees(field, a, b, c, d, quads);
  }
  check(
    "an arbitrary four-way split gives the same field",
    identical(whole, quads),
    `split at x=${MX}, z=${MZ}`,
  );

  // One cell, one tree. The tile identity above holds as long as a candidate
  // stays inside the cell that generated it; widen the jitter past a whole cell
  // and neighbouring cells start reaching into each other, which the partition
  // tests cannot see because both sides scan the same one-cell margin.
  let worstCell = 0;
  for (let k = 0; k < 40; k++) {
    for (let i = 0; i < 40; i++) {
      const x = i * TREE_SPACING_M, z = k * TREE_SPACING_M;
      const n = placeTrees(field, x, z, x + TREE_SPACING_M, z + TREE_SPACING_M).length;
      if (n > worstCell) worstCell = n;
    }
  }
  check(
    "one lattice cell yields at most one tree",
    worstCell <= MAX_PER_CELL,
    `worst single-cell box held ${worstCell}, limit ${MAX_PER_CELL}`,
  );
  check(
    "the jitter cannot leave its cell",
    TREE_JITTER < 1,
    `TREE_JITTER ${TREE_JITTER} < 1`,
  );
  // PROBE. The counter has to be able to report more than one, or the
  // assertion above is "a box I never looked in held nothing".
  let biggest = 0;
  for (let k = 0; k < 40; k++) {
    for (let i = 0; i < 40; i++) {
      const x = i * TREE_SPACING_M * 2, z = k * TREE_SPACING_M * 2;
      const n = placeTrees(field, x, z, x + TREE_SPACING_M * 2, z + TREE_SPACING_M * 2).length;
      if (n > biggest) biggest = n;
    }
  }
  probe(
    "the per-cell counter can count past one",
    biggest <= MAX_PER_CELL,
    `a two-by-two cell box held ${biggest}`,
  );

  // PROBE. The comparator has to be able to say "different". A field placed on
  // a different lattice pitch is the same region, the same data and the same
  // code, and must not compare equal.
  const coarser = placeTrees({ ...field, spacingM: TREE_SPACING_M + 1 }, X0, X0, X1, X1);
  probe(
    "a different lattice is not equal",
    identical(whole, coarser),
    `${whole.length} at ${TREE_SPACING_M} m vs ${coarser.length} at ${TREE_SPACING_M + 1} m`,
  );
}

// --- 5. a leafy suburb against a built city ---------------------------------

console.log("\n--- 55% tree cover against 11% ---");

{
  const R = 2000;
  const leafy = await land("emeraldhills");
  const built = await land("manhattan");
  const mLeafy = maskOf(leafy);
  const mBuilt = maskOf(built);

  const nLeafy = placeTrees({ mask: mLeafy, heightAt: RAMP }, -R, -R, R, R).length;
  const nBuilt = placeTrees({ mask: mBuilt, heightAt: RAMP }, -R, -R, R, R).length;
  const covLeafy = meanTreeCoverage(mLeafy, -R, -R, R, R, 5);
  const covBuilt = meanTreeCoverage(mBuilt, -R, -R, R, R, 5);

  const measured = nLeafy / nBuilt;
  const derived = covLeafy / covBuilt;
  check(
    "emeraldhills is far leafier than manhattan",
    measured > MIN_LEAFY_RATIO,
    `${nLeafy} vs ${nBuilt} trees, ratio ${measured.toFixed(2)} > ${MIN_LEAFY_RATIO}`,
  );
  check(
    "the ratio is the coverage ratio",
    Math.abs(measured / derived - 1) < LEAFY_TOLERANCE,
    `measured ${measured.toFixed(2)} vs coverage-derived ${derived.toFixed(2)} ` +
      `(${(covLeafy * 100).toFixed(1)}% / ${(covBuilt * 100).toFixed(1)}% tree)`,
  );

  // PROBE. The masks swapped. If the assertion still passes, it is not reading
  // the coverage of the city it names.
  const swapped = nBuilt / nLeafy;
  probe(
    "the cities the other way round are rejected",
    swapped > MIN_LEAFY_RATIO && Math.abs(swapped / derived - 1) < LEAFY_TOLERANCE,
    `ratio ${swapped.toFixed(2)}`,
  );
}

// --- helpers ----------------------------------------------------------------

/**
 * Point-in-any-footprint, built from the pack's rings and a bbox grid.
 *
 * Deliberately NOT FootprintMask: that is a 4 m raster and it is the code the
 * assertion is about, so an oracle made of it would agree with itself however
 * wrong it was.
 */
class BuildingIndex {
  private readonly cells: number[][];
  private readonly n: number;
  private readonly extent: number;
  private static readonly CELL = 64;

  constructor(private readonly buildings: readonly Building[], extentM: number) {
    this.extent = extentM;
    this.n = Math.max(1, Math.ceil((extentM * 2) / BuildingIndex.CELL));
    this.cells = Array.from({ length: this.n * this.n }, () => [] as number[]);
    buildings.forEach((b, bi) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let v = 0; v < b.ring.length; v += 2) {
        x0 = Math.min(x0, b.ring[v]); x1 = Math.max(x1, b.ring[v]);
        z0 = Math.min(z0, b.ring[v + 1]); z1 = Math.max(z1, b.ring[v + 1]);
      }
      for (let r = this.idx(z0); r <= this.idx(z1); r++) {
        for (let c = this.idx(x0); c <= this.idx(x1); c++) {
          if (r >= 0 && c >= 0 && r < this.n && c < this.n) this.cells[r * this.n + c].push(bi);
        }
      }
    });
  }

  private idx(w: number): number {
    return Math.floor((w + this.extent) / BuildingIndex.CELL);
  }

  contains(x: number, z: number): boolean {
    const c = this.idx(x), r = this.idx(z);
    if (c < 0 || r < 0 || c >= this.n || r >= this.n) return false;
    for (const bi of this.cells[r * this.n + c]) {
      const ring = this.buildings[bi].ring;
      let inside = false;
      for (let a = 0, b = ring.length - 2; a < ring.length; b = a, a += 2) {
        const zi = ring[a + 1], zj = ring[b + 1];
        if (zi > z !== zj > z) {
          const t = (z - zi) / (zj - zi);
          if (x < ring[a] + t * (ring[b] - ring[a])) inside = !inside;
        }
      }
      if (inside) return true;
    }
    return false;
  }
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb || 1);
}

/**
 * The vacuity probe's straw man: how many trees a box would hold if density
 * were the region's mean rather than the box's own coverage. Same lattice, same
 * hash, so it differs from the real placement in exactly one respect.
 */
function uniformCount(x0: number, z0: number, box: number, density: number): number {
  let n = 0;
  const i0 = Math.floor(x0 / TREE_SPACING_M);
  const i1 = Math.floor((x0 + box) / TREE_SPACING_M);
  const k0 = Math.floor(z0 / TREE_SPACING_M);
  const k1 = Math.floor((z0 + box) / TREE_SPACING_M);
  for (let k = k0; k < k1; k++) {
    for (let i = i0; i < i1; i++) {
      // Any deterministic 0..1 value will do; it only has to be independent of
      // the coverage, which is the property under probe.
      const h = Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
      if (h < density) n++;
    }
  }
  return n;
}

function countOffRamp(trees: TreeInstance[]): number {
  let n = 0;
  for (const t of trees) if (Math.abs(t.y - RAMP(t.x, t.z)) > 1e-6) n++;
  return n;
}

function nearestStats(index: RoadIndex, trees: TreeInstance[]): { min: number; within: number } {
  let min = Infinity;
  let within = 0;
  for (const t of trees) {
    const d = index.nearest(t.x, t.z);
    if (Number.isFinite(d)) {
      within++;
      if (d < min) min = d;
    }
  }
  return { min, within };
}

/** Same instances, in any order, to the last bit of every field. */
function identical(a: TreeInstance[], b: TreeInstance[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: TreeInstance): string =>
    `${t.x} ${t.y} ${t.z} ${t.heightM} ${t.radiusM} ${t.yaw} ${t.species} ${t.tint}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

console.log(failures === 0 ? "\nall tree placement checks ok" : `\n${failures} tree check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
