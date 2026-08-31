// The gate on the street: src/data/streetfurniture.ts, the parking widths in
// src/data/roadpack.ts, and the lamp half of the road shader.
//
// WHAT CAN GO WRONG HERE THAT STILL RENDERS PERFECTLY. Eight things, and every
// one of them produces a frame with no error in it:
//
//   * a lamp column stands where no pool of light is painted, or a pool has no
//     column over it. This is the failure the whole design exists to prevent:
//     the pool is a per-fragment function of the ribbon parameters and the post
//     is a TypeScript placement, and they agree only because the shader's
//     spacing table is GENERATED from the placement's. Asserted twice: once by
//     parsing the numbers back out of the generated GLSL, and once by walking
//     every placed lamp back to the pool centre the shader would paint for it.
//   * lamp spacing or mounting height drifts out of the band a real street
//     lamp occupies. A residential street lit from 10 m reads as a depot.
//   * a lamp stands inside a building, or in the middle of a crossroads.
//   * a moving car leaves the carriageway. Traffic drives the CHORD of a
//     straight run while the road follows its centreline, so the run merge is
//     exactly the thing that can put a car through a kerb.
//   * a car drives the wrong way down a one-way.
//   * a parked car sits in a traffic lane, or hangs off the kerb.
//   * traffic density stops tracking road class, and the alley behind the
//     arterial carries the same stream as the arterial.
//   * the player's own lane offset stops clearing the parking strip, and the
//     driver steers through a row of stationary cars at eye height.
//
// WATCHED TO FAIL. Every assertion's subject was broken, seen red, and
// restored; what was broken and what was seen is written up in the branch
// report. Every assertion also carries a VACUITY PROBE: the same predicate fed
// a case it must reject. Each probe is then BLINDED -- fed the real case, which
// it must accept -- so a probe that has stopped looking at anything cannot pass
// by rejecting everything.
//
// The bounds below are LITERALS. None of them is imported from the code under
// test. That rule is the point: this repo has shipped five gates whose bound
// was the constant they were checking, so raising the constant moved the
// goalposts with it.

import { readFileSync } from "node:fs";
import {
  addLamps,
  addParked,
  addTraffic,
  runsFor,
  straightRuns,
  trafficLaneOffsetsM,
  PointIndex,
  LAMP_GLSL,
  LAMP_HEIGHT_M,
  LAMP_SNAP_M,
  LAMP_SPACING_M,
  TRAFFIC_PER_KM_LANE,
  type LampInstance,
  type ParkedInstance,
  type StreetWorld,
  type TrafficInstance,
} from "../src/data/streetfurniture";
import { isCarriageway, KERB_HEIGHT_M } from "../src/data/pavement";
import {
  parseRoadPack,
  parkingStripM,
  roadLiftM,
  roadWidthM,
  RoadClass,
  ROAD_BRIDGE,
  ROAD_ONEWAY,
  type RoadPack,
} from "../src/data/roadpack";
import { laneOffsetM } from "../src/data/roadgraph";
import { FootprintMask, RoadIndex } from "../src/data/trees";
import { parseCityPack, type CityPack } from "../src/data/citypack";
import {
  encodeStreetPack,
  parseStreetPack,
  FurnitureKind,
  DIRECTION_UNKNOWN,
  type Furniture,
} from "../src/data/streetpack";
import { furnitureFromOsm, parseDirection } from "../src/data/osmfurniture";
import { roadsAndFurnitureQuery, roadsQuery } from "../src/data/osmroads";
import { Origin } from "../src/geo";

const DIR = "public/cities";

// --- literal bounds ---------------------------------------------------------

/** Metres between lamps on a real street. Under 20 is a light strip, over 70 is
 *  a road with dark between the pools. */
const SPACING_MIN_M = 20;
const SPACING_MAX_M = 70;
/** Mounting height of a real column. A 4 m lamp is a bollard and a 12 m one is
 *  a motorway mast. */
const HEIGHT_MIN_M = 4.5;
const HEIGHT_MAX_M = 11.0;
/** Metres a main road's column must stand above a residential one's. */
const MAIN_OVER_RESIDENTIAL_M = 2.0;
/** Metres a lamp head may sit from the centre of its own pool of light, when no
 *  survey has moved it. This is float noise; the two are the same arithmetic. */
const POOL_AGREE_M = 0.02;
/** And with a survey, which is allowed to move a lamp by the snap distance and
 *  not one centimetre more. Three metres and a little, in literals. */
const POOL_AGREE_SURVEYED_M = 3.05;
/** Half the width of a car, in metres. A real car is 1.8 m across. */
const CAR_HALF_M = 0.9;
/** Metres a car may overhang the kerb line. Zero, with float slack. */
const OVERHANG_EPS_M = 0.01;
/**
 * Metres of clear air a parked car must leave beside the nearest traffic lane.
 *
 * Ten centimetres, not a door's width. On a 7 m residential street with a 2 m
 * parking strip on each side there are three metres of running surface and a
 * 1.8 m car in it; the geometry cannot promise room to open a door and it is
 * not asked to. What it must promise is that the two cars do not intersect,
 * which is what this asserts.
 */
const PARKED_LANE_GAP_M = 0.10;
/** Fraction of a one-way's cars that must be travelling with it. Not 0.99: it
 *  is an equality on a dot product and anything under 1 is a bug. */
const ONEWAY_SHARE = 1.0;
/** Width of a kerbside parking strip a car can be left in, in metres. */
const PARK_STRIP_MIN_M = 1.85;
const PARK_STRIP_MAX_M = 2.6;
/** Radius about the pack centre the heavy assertions are measured over. The
 *  whole of Manhattan is 113k ways and this file has to run in the check
 *  chain; 2.5 km is the ground the detail ring and the car live in. */
const MEASURE_RADIUS_M = 2500;
/** Lamps that may stand inside a building footprint. Not a fraction: zero.
 *  FootprintMask is a 4 m raster and the column stands 750 mm outside the
 *  kerb, so unlike a tree there is no rounding case to allow for. */
const MAX_LAMPS_IN_BUILDINGS = 0;
/** Lamps that may stand on another carriageway. Also zero. */
const MAX_LAMPS_ON_TARMAC = 0;
/** How many lamps and cars a real city must produce before an assertion over
 *  them means anything. */
const MIN_SAMPLE = 500;

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(62)} ${detail}`);
  if (!ok) failures++;
}

/**
 * A vacuity probe: the same predicate fed a case it must reject.
 *
 * `checkerSaidOk` is the checker re-run over poisoned input. If it comes back
 * true, the checker cannot tell the poisoned case from the good one and the
 * assertion above it proved nothing.
 */
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}

/**
 * The probe, blinded: the same predicate fed the REAL case, which it must
 * accept.
 *
 * Without this a probe can pass by rejecting everything, which is exactly as
 * useless as an assertion that accepts everything.
 */
function blind(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  console.log(`${checkerSaidOk ? "  ok" : "BLIND-FAIL"} blinded: ${label.padEnd(52)} ${detail}`);
  if (!checkerSaidOk) failures++;
}

// --- pack loading -----------------------------------------------------------

const roadPacks = new Map<string, RoadPack>();
async function roads(id: string): Promise<RoadPack> {
  if (!roadPacks.has(id)) {
    const f = Bun.file(`${DIR}/${id}.roads`);
    if (!(await f.exists())) throw new Error(`no ${DIR}/${id}.roads -- run: bun tools/bake-roads.ts --all`);
    roadPacks.set(id, parseRoadPack(await f.arrayBuffer()));
  }
  return roadPacks.get(id)!;
}

async function city(id: string): Promise<CityPack> {
  const f = Bun.file(`${DIR}/${id}.city`);
  if (!(await f.exists())) throw new Error(`no ${DIR}/${id}.city -- run: bun tools/bake-city.ts --all`);
  return parseCityPack(await f.arrayBuffer());
}

/** A terrain that is not flat, so an instance that never asked the height field
 *  is visible as y === 0. A ramp rather than noise: assertions on it are
 *  equalities. */
const RAMP = (x: number, z: number): number => 9 + x * 0.013 - z * 0.008;

/** Ways whose centroid is inside the measurement radius. */
function near(pack: RoadPack): number[] {
  const out: number[] = [];
  for (let i = 0; i < pack.roads.length; i++) {
    const r = pack.roads[i];
    if (Math.hypot(r.cx, r.cz) <= MEASURE_RADIUS_M) out.push(i);
  }
  return out;
}

// --- geometry the CHECK owns ------------------------------------------------
//
// Deliberately written out here rather than imported. An assertion that reuses
// the function under test to work out what the answer should be is an assertion
// that the function agrees with itself.

interface OnLine {
  distanceM: number;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
}

/** The nearest point on a polyline, and the direction of the segment it is on. */
function nearestOn(pts: Float32Array, x: number, z: number): OnLine {
  let best: OnLine = { distanceM: Infinity, x: 0, z: 0, dirX: 1, dirZ: 0 };
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2];
    const az = pts[i - 1];
    const dx = pts[i] - ax;
    const dz = pts[i + 1] - az;
    const len2 = dx * dx + dz * dz;
    if (len2 <= 0) continue;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx;
    const pz = az + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.distanceM) {
      const len = Math.sqrt(len2);
      best = { distanceM: d, x: px, z: pz, dirX: dx / len, dirZ: dz / len };
    }
  }
  return best;
}

/** The point and tangent at arc length `u` along a polyline. */
function stationAt(pts: Float32Array, u: number): OnLine | null {
  let acc = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2];
    const az = pts[i - 1];
    const dx = pts[i] - ax;
    const dz = pts[i + 1] - az;
    const len = Math.hypot(dx, dz);
    if (len <= 0) continue;
    if (acc + len >= u || i + 2 >= pts.length) {
      const t = Math.min(1, Math.max(0, (u - acc) / len));
      return {
        distanceM: 0,
        x: ax + dx * t,
        z: az + dz * t,
        dirX: dx / len,
        dirZ: dz / len,
      };
    }
    acc += len;
  }
  return null;
}

// ===========================================================================
// 1. The shader's spacing table IS the placement's spacing table.
// ===========================================================================
//
// Not "matches": IS. LAMP_GLSL is generated from LAMP_SPACING_M, and this
// section parses the floats back out of the generated text and compares them to
// the array they came from. That catches a hand-edit of the GLSL, a change to
// the generator that drops a class, and a table that grew a fifteenth entry the
// GLSL array size did not.

console.log("\n--- the post and the pool are placed from ONE table ---");

const glslNumbers = /float\[14\]\(([^)]*)\)/.exec(LAMP_GLSL);
const glslSpacing = glslNumbers
  ? glslNumbers[1].split(",").map((s) => Number(s.trim()))
  : [];
const poolVMatch = /LAMP_POOL_V\s*=\s*([0-9.]+)/.exec(LAMP_GLSL);
const glslPoolV = poolVMatch ? Number(poolVMatch[1]) : NaN;

function tablesAgree(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length || a.length !== 14) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}

check(
  "the generated GLSL carries exactly the placement spacing table",
  tablesAgree(glslSpacing, LAMP_SPACING_M),
  `${glslSpacing.length} floats: ${glslSpacing.join("/")}`,
);
probe(
  "the table comparison rejects one class moved by a metre",
  tablesAgree(glslSpacing, LAMP_SPACING_M.map((v, i) => (i === 5 ? v + 1 : v))),
  "residential moved from the shader's copy by 1 m",
);
blind(
  "the table comparison accepts the tables as they are",
  tablesAgree(glslSpacing, LAMP_SPACING_M.slice()),
  "the real pair",
);

check(
  "the pool offset across the carriageway is one number, not two",
  Number.isFinite(glslPoolV) && glslPoolV > 0 && glslPoolV < 0.5,
  `the shader uses v = ${glslPoolV}`,
);

// Every lit class must be lit at a spacing a street lamp is actually set at,
// and every unlit class must be unlit. Both halves, or a table of zeroes passes.
const litClasses = LAMP_SPACING_M.filter((s) => s > 0);
const outOfBand = litClasses.filter((s) => s < SPACING_MIN_M || s > SPACING_MAX_M);
check(
  "every lit class is lit at a spacing a real street is",
  litClasses.length >= 8 && outOfBand.length === 0,
  `${litClasses.length} lit classes, ${outOfBand.length} outside ${SPACING_MIN_M}..${SPACING_MAX_M} m`,
);
probe(
  "the spacing band rejects a 4 m and a 300 m spacing",
  [4, 300, 40].filter((s) => s < SPACING_MIN_M || s > SPACING_MAX_M).length !== 2,
  "2 of 3 probe spacings rejected",
);
blind(
  "the spacing band accepts three real spacings",
  [LAMP_SPACING_M[2], LAMP_SPACING_M[5], LAMP_SPACING_M[3]]
    .filter((s) => s < SPACING_MIN_M || s > SPACING_MAX_M).length === 0,
  "primary, residential and secondary all inside the band",
);

const litHeights = LAMP_HEIGHT_M.filter((_h, i) => LAMP_SPACING_M[i] > 0);
const heightBad = litHeights.filter((h) => h < HEIGHT_MIN_M || h > HEIGHT_MAX_M);
check(
  "every lit class is lit from a height a column reaches",
  litHeights.length === litClasses.length && heightBad.length === 0,
  `${litHeights.length} heights, ${heightBad.length} outside ${HEIGHT_MIN_M}..${HEIGHT_MAX_M} m`,
);
check(
  "a main road is lit from higher than a residential street",
  LAMP_HEIGHT_M[RoadClass.Primary] - LAMP_HEIGHT_M[RoadClass.Residential] >= MAIN_OVER_RESIDENTIAL_M,
  `primary ${LAMP_HEIGHT_M[RoadClass.Primary]} m against residential ${LAMP_HEIGHT_M[RoadClass.Residential]} m`,
);
probe(
  "the height gap rejects the comparison run backwards",
  LAMP_HEIGHT_M[RoadClass.Residential] - LAMP_HEIGHT_M[RoadClass.Primary] >= MAIN_OVER_RESIDENTIAL_M,
  "residential minus primary is negative",
);
blind(
  "the height gap accepts secondary over service",
  LAMP_HEIGHT_M[RoadClass.Secondary] - LAMP_HEIGHT_M[RoadClass.Service] >= MAIN_OVER_RESIDENTIAL_M,
  `secondary ${LAMP_HEIGHT_M[RoadClass.Secondary]} m against service ${LAMP_HEIGHT_M[RoadClass.Service]} m`,
);

// ===========================================================================
// 2. The road shader reads that table rather than a number of its own.
// ===========================================================================
//
// Sliced to the fragment shader before searching it. The failure this repo has
// already shipped is a shader check that searched the WHOLE file for a symbol
// something else also mentioned, so deleting the gated code still passed.

console.log("\n--- the road shader takes its spacing from the same place ---");

const roadsSrc = readFileSync(new URL("../src/render/roads.ts", import.meta.url), "utf8");
const fragStart = roadsSrc.indexOf("const FRAG = /* glsl */ `");
const fragEnd = roadsSrc.indexOf("\n`;", fragStart);
const frag = fragStart >= 0 && fragEnd > fragStart ? roadsSrc.slice(fragStart, fragEnd) : "";

check(
  "the fragment shader could be sliced out at all",
  frag.length > 2000 && frag.includes("fragColor"),
  `${frag.length} characters of fragment shader`,
);
check(
  "the lamp pool asks the shared table for its spacing",
  frag.includes("lampSpacingM(cls)") && frag.includes("${LAMP_GLSL}"),
  "the pool centre is a function of the generated table",
);
check(
  "the lamp pool no longer carries a spacing of its own",
  !/SPACING\s*=\s*[0-9]/.test(frag) && !/\/\s*52\.0/.test(frag),
  "no numeric spacing literal survives in the fragment shader",
);
probe(
  "the slice test rejects a fragment shader with the old constant back in it",
  !/SPACING\s*=\s*[0-9]/.test(frag.replace("float spacing = lampSpacingM(cls);", "const float SPACING = 52.0;")),
  "the old hard-coded 52 m is caught when reintroduced",
);
blind(
  "the slice test accepts the fragment shader as it stands",
  !/SPACING\s*=\s*[0-9]/.test(frag),
  "the real fragment shader",
);

// ===========================================================================
// 3. Every lamp stands over its own pool.
// ===========================================================================
//
// The assertion the whole design is for. For each placed column, the pool
// centre is re-derived HERE from the numbers parsed out of the SHADER's table
// -- not from LAMP_SPACING_M -- and the lamp's lantern is measured against it.

console.log("\n--- every column stands in its own pool of light ---");

const sf = await roads("sf");
const sfCity = await city("sf");
const sfNear = near(sf);

const footprints = new FootprintMask(sfCity.buildings, sfCity.radiusM);
/** A carriageway index whose ids are positions in the PACK, which is what
 *  `blockedExcept` is asked about. Built here rather than imported so the check
 *  does not inherit a mistake in how the app builds it. */
function carriagewayIndexFor(pack: RoadPack): RoadIndex {
  const ids: number[] = [];
  for (let i = 0; i < pack.roads.length; i++) {
    if (isCarriageway(pack.roads[i])) ids.push(i);
  }
  return new RoadIndex(
    ids.map((i) => pack.roads[i]),
    (r) => roadWidthM(r.cls, r.lanes, r.flags) * 0.5,
    32,
    (_r, i) => ids[i],
  );
}

const carriageways = carriagewayIndexFor(sf);

const plainWorld: StreetWorld = {
  groundY: RAMP,
  occupied: (x, z) => footprints.occupied(x, z),
  onCarriageway: (x, z, except) => carriageways.blockedExcept(x, z, except),
  nearestMeasuredLamp: null,
};

function placeLamps(world: StreetWorld, ways: readonly number[]): LampInstance[] {
  const out: LampInstance[] = [];
  for (const i of ways) addLamps(out, sf.roads[i], i, world);
  return out;
}

const lamps = placeLamps(plainWorld, sfNear);

/**
 * Distance from a lamp's lantern to the centre of the pool the road shader
 * paints for it, in metres.
 *
 * The pool centre is rebuilt from the shader's own arithmetic: index the run at
 * `floor(u / spacing)`, put the centre where `fract` is a half, and offset it
 * across the carriageway by `(1 - 2v)` half widths on the side the parity of
 * the index chooses. `spacing` and `v` are the values parsed out of the
 * generated GLSL above.
 */
function poolMiss(l: LampInstance, offsetU = 0): number {
  const r = sf.roads[l.road];
  const spacing = glslSpacing[l.cls];
  const u = l.u + offsetU;
  const idx = Math.floor(u / spacing);
  const centreU = (idx + 0.5) * spacing;
  const st = stationAt(r.pts, centreU);
  if (!st) return Infinity;
  const v = idx % 2 === 0 ? glslPoolV : 1 - glslPoolV;
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  // The ribbon's v=0 side is +(dirZ, -dirX); see data/ribbon.ts.
  const nx = st.dirZ;
  const nz = -st.dirX;
  const px = st.x + nx * half * (1 - 2 * v);
  const pz = st.z + nz * half * (1 - 2 * v);
  // The lantern: the column base plus the arm, in the direction the instance
  // yaw points its local +x. instanceToWorld maps local +x to (cos, -sin).
  const hx = l.x + Math.cos(l.yaw) * l.armM;
  const hz = l.z - Math.sin(l.yaw) * l.armM;
  return Math.hypot(hx - px, hz - pz);
}

let worstMiss = 0;
for (const l of lamps) worstMiss = Math.max(worstMiss, poolMiss(l));
check(
  "every lamp stands over the pool the shader paints for it",
  lamps.length >= MIN_SAMPLE && worstMiss <= POOL_AGREE_M,
  `${lamps.length} lamps, worst miss ${worstMiss.toFixed(4)} m against ${POOL_AGREE_M} m`,
);

// The probe: the same lamps with their arc length pushed on by half a spacing,
// which is where a post would land if the placement and the shader disagreed by
// one phase. It must be rejected.
let worstShifted = 0;
for (const l of lamps) {
  worstShifted = Math.max(worstShifted, poolMiss(l, LAMP_SPACING_M[l.cls] * 0.5));
}
probe(
  "the pool test rejects a post half a spacing out of phase",
  worstShifted <= POOL_AGREE_M,
  `worst miss with the phase shifted is ${worstShifted.toFixed(2)} m`,
);
blind(
  "the pool test accepts the real placement",
  worstMiss <= POOL_AGREE_M,
  `worst miss ${worstMiss.toFixed(4)} m`,
);

// And with a survey. Synthetic, because Overpass has been refusing this machine
// and no city in the repo has a .street pack yet: a fixture of nodes two metres
// off where the procedure would have put a lamp. The snap must take them and
// must not drag a post out of its own pool.
{
  const surveyed: Furniture[] = lamps.slice(0, 400).map((l) => ({
    kind: FurnitureKind.StreetLamp,
    directionDeg: null,
    x: l.x + 2.0,
    z: l.z,
  }));
  const index = new PointIndex(surveyed, LAMP_SNAP_M);
  const surveyedWorld: StreetWorld = {
    ...plainWorld,
    nearestMeasuredLamp: (x, z, maxM) => index.nearest(x, z, maxM),
  };
  const snapped = placeLamps(surveyedWorld, sfNear);
  const moved = snapped.filter((l) => l.measured).length;
  let worstSurveyed = 0;
  for (const l of snapped) worstSurveyed = Math.max(worstSurveyed, poolMiss(l));
  check(
    "a surveyed lamp is used, and still stands in its own pool",
    moved >= 200 && worstSurveyed <= POOL_AGREE_SURVEYED_M,
    `${moved} of ${snapped.length} moved onto a surveyed node, worst miss ${worstSurveyed.toFixed(2)} m`,
  );

  // The probe: a survey twenty metres away, which is outside the snap and must
  // be ignored entirely rather than dragging posts across the road.
  const far: Furniture[] = lamps.slice(0, 400).map((l) => ({
    kind: FurnitureKind.StreetLamp,
    directionDeg: null,
    x: l.x + 20.0,
    z: l.z,
  }));
  const farIndex = new PointIndex(far, LAMP_SNAP_M);
  const farSnapped = placeLamps(
    { ...plainWorld, nearestMeasuredLamp: (x, z, m) => farIndex.nearest(x, z, m) },
    sfNear,
  );
  probe(
    "the snap rejects a surveyed node twenty metres away",
    farSnapped.some((l) => l.measured),
    `${farSnapped.filter((l) => l.measured).length} lamps moved onto a node 20 m off`,
  );
  blind(
    "the snap accepts a surveyed node two metres away",
    moved >= 200,
    `${moved} lamps moved`,
  );
}

// ===========================================================================
// 4. A lamp never stands inside a building, or in a crossroads.
// ===========================================================================

console.log("\n--- a column stands on the footway, not in the hall ---");

const inBuilding = lamps.filter((l) => footprints.occupied(l.x, l.z)).length;
const onTarmac = lamps.filter((l) => carriageways.blockedExcept(l.x, l.z, l.road)).length;
check(
  "no lamp stands inside a building footprint",
  inBuilding <= MAX_LAMPS_IN_BUILDINGS,
  `${inBuilding} of ${lamps.length} inside a footprint`,
);
check(
  "no lamp stands on another carriageway",
  onTarmac <= MAX_LAMPS_ON_TARMAC,
  `${onTarmac} of ${lamps.length} on tarmac that is not their own road`,
);

// The probe for both: placement with the exclusions switched OFF must produce
// lamps that the same two predicates reject. This is the strongest form the
// probe can take -- it proves the exclusions are doing work on this very city,
// not merely that the predicate compiles.
{
  const blindWorld: StreetWorld = {
    groundY: RAMP, occupied: null, onCarriageway: null, nearestMeasuredLamp: null,
  };
  const unfiltered = placeLamps(blindWorld, sfNear);
  const wouldBeInside = unfiltered.filter((l) => footprints.occupied(l.x, l.z)).length;
  const wouldBeOnTarmac = unfiltered.filter(
    (l) => carriageways.blockedExcept(l.x, l.z, l.road),
  ).length;
  probe(
    "the footprint test rejects placement with the exclusion removed",
    wouldBeInside <= MAX_LAMPS_IN_BUILDINGS,
    `${wouldBeInside} of ${unfiltered.length} would stand inside a building`,
  );
  probe(
    "the junction test rejects placement with the exclusion removed",
    wouldBeOnTarmac <= MAX_LAMPS_ON_TARMAC,
    `${wouldBeOnTarmac} of ${unfiltered.length} would stand on a crossing carriageway`,
  );
  blind(
    "both tests accept the filtered placement",
    inBuilding === 0 && onTarmac === 0,
    `${lamps.length} lamps, none inside a building and none on tarmac`,
  );
}

// Measured spacing, from the placement rather than from the table: the gap
// between consecutive lamps on the same way has to be the spacing the class
// says, or the walk along the centreline has drifted.
{
  const byRoad = new Map<number, LampInstance[]>();
  for (const l of lamps) {
    const list = byRoad.get(l.road);
    if (list) list.push(l);
    else byRoad.set(l.road, [l]);
  }
  let gaps = 0;
  let badGaps = 0;
  for (const [road, list] of byRoad) {
    if (list.length < 2) continue;
    const cls = sf.roads[road].cls;
    list.sort((a, b) => a.u - b.u);
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].u - list[i - 1].u;
      gaps++;
      // A gap that is a multiple of the spacing is a lamp suppressed by a
      // building or a junction, which is correct; a gap that is NOT is a walk
      // that has lost its place.
      const k = Math.round(gap / LAMP_SPACING_M[cls]);
      if (k < 1 || Math.abs(gap - k * LAMP_SPACING_M[cls]) > 0.01) badGaps++;
    }
  }
  check(
    "consecutive lamps on a way are a whole number of spacings apart",
    gaps >= MIN_SAMPLE && badGaps === 0,
    `${badGaps} of ${gaps} gaps are not a multiple of the class spacing`,
  );
  probe(
    "the gap test rejects a gap that is not a multiple",
    [1.0, 40.0, 80.0].filter((g) => {
      const k = Math.round(g / 40);
      return k >= 1 && Math.abs(g - k * 40) <= 0.01;
    }).length !== 2,
    "1 m is rejected, 40 m and 80 m are not",
  );
  blind(
    "the gap test accepts the real gaps",
    badGaps === 0,
    `${gaps} gaps, all whole multiples`,
  );
}

// ===========================================================================
// 5. A moving car never leaves the carriageway.
// ===========================================================================
//
// Sampled along the run rather than at its ends, because a car drives the CHORD
// while the carriageway follows its own centreline: the worst excursion is in
// the middle of a bend, which is precisely where the run merge decided to cut a
// corner. The measurement is against the ORIGINAL polyline, found by nearest
// point, and it is compared to the width table.

console.log("\n--- a car stays between the kerbs, and faces the right way ---");

function placeTraffic(ways: readonly number[]): TrafficInstance[] {
  const out: TrafficInstance[] = [];
  for (const i of ways) addTraffic(out, sf.roads[i], i, plainWorld);
  return out;
}

const cars = placeTraffic(sfNear);

/** Worst perpendicular excursion past the kerb over a set of cars, in metres. */
function worstOverhang(set: readonly TrafficInstance[], lateralBias = 0): number {
  let worst = -Infinity;
  for (const c of set) {
    const r = sf.roads[c.road];
    const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
    const dx = c.x1 - c.x0;
    const dz = c.z1 - c.z0;
    const len = Math.hypot(dx, dz);
    if (len <= 0) continue;
    // Push the car sideways off its own run, for the probe.
    const bx = (dz / len) * lateralBias;
    const bz = (-dx / len) * lateralBias;
    for (let k = 0; k <= 8; k++) {
      const s = k / 8;
      const x = c.x0 + dx * s + bx;
      const z = c.z0 + dz * s + bz;
      worst = Math.max(worst, nearestOn(r.pts, x, z).distanceM + CAR_HALF_M - half);
    }
  }
  return worst;
}

const overhang = worstOverhang(cars);
check(
  "no moving car ever reaches past the kerb of its own road",
  cars.length >= MIN_SAMPLE && overhang <= OVERHANG_EPS_M,
  `${cars.length} cars, worst flank ${overhang.toFixed(3)} m past the kerb`,
);
// Displaced BOTH ways, and this is not fussiness. A one-way carries traffic on
// one side of its centreline only, so a bias applied in one fixed direction
// moves every car on it INWARD and the probe passes while proving nothing --
// which is exactly what it did the first time it was run.
const displaced = Math.max(worstOverhang(cars, 1.5), worstOverhang(cars, -1.5));
probe(
  "the kerb test rejects the same cars pushed 1.5 m sideways",
  displaced <= OVERHANG_EPS_M,
  `worst flank when displaced either way is ${displaced.toFixed(2)} m past the kerb`,
);
blind(
  "the kerb test accepts the cars where they are",
  overhang <= OVERHANG_EPS_M,
  `worst flank ${overhang.toFixed(3)} m`,
);

// One-way. The run direction against the direction of the centreline segment it
// is closest to; on a one-way the two must point the same way, always.
{
  const onOneway = cars.filter((c) => (sf.roads[c.road].flags & ROAD_ONEWAY) !== 0);
  const withIt = (set: readonly TrafficInstance[], reverse: boolean): number => {
    let n = 0;
    for (const c of set) {
      const r = sf.roads[c.road];
      let dx = c.x1 - c.x0;
      let dz = c.z1 - c.z0;
      if (reverse) { dx = -dx; dz = -dz; }
      const len = Math.hypot(dx, dz);
      if (len <= 0) continue;
      const on = nearestOn(r.pts, (c.x0 + c.x1) * 0.5, (c.z0 + c.z1) * 0.5);
      if ((dx / len) * on.dirX + (dz / len) * on.dirZ > 0) n++;
    }
    return n;
  };
  const right = withIt(onOneway, false);
  check(
    "every car on a one-way is travelling with it",
    onOneway.length >= MIN_SAMPLE && right / onOneway.length >= ONEWAY_SHARE,
    `${right} of ${onOneway.length} one-way cars going the right way`,
  );
  const mirrored = withIt(onOneway, true);
  probe(
    "the one-way test rejects the same cars driven backwards",
    onOneway.length > 0 && mirrored / onOneway.length >= ONEWAY_SHARE,
    `${mirrored} of ${onOneway.length} accepted when reversed`,
  );
  blind(
    "the one-way test accepts the cars as placed",
    right === onOneway.length,
    `${right} of ${onOneway.length}`,
  );
}

// The run merge itself: the corridor it is allowed to cut off the centreline.
// Asserted directly, because everything above measures the result and this
// measures the mechanism that could break it on a city with sharper bends than
// San Francisco has.
{
  // A quarter circle of radius 40 m, digitised every 5 degrees: a real curve, of
  // the kind no way within the measurement radius happens to have.
  const n = 19;
  const arc = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const th = (i / (n - 1)) * (Math.PI / 2);
    arc[i * 2] = Math.cos(th) * 40;
    arc[i * 2 + 1] = Math.sin(th) * 40;
  }
  const DEV = 0.5;
  const runs = straightRuns(arc, DEV, 1);
  let worstDev = 0;
  for (const run of runs) {
    for (let i = 0; i < n; i++) {
      const px = arc[i * 2];
      const pz = arc[i * 2 + 1];
      // Only the vertices this run actually spans.
      const t = ((px - run.x0) * run.dirX + (pz - run.z0) * run.dirZ) / run.lengthM;
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      worstDev = Math.max(
        worstDev,
        Math.abs((px - run.x0) * run.dirZ - (pz - run.z0) * run.dirX),
      );
    }
  }
  check(
    "a straight run never cuts more corner than it is allowed",
    runs.length >= 2 && worstDev <= DEV + 1e-6,
    `${runs.length} runs over a 40 m quarter circle, worst deviation ${worstDev.toFixed(3)} m against ${DEV} m`,
  );
  probe(
    "the corridor test rejects a run merged at ten times the corridor",
    (() => {
      const loose = straightRuns(arc, DEV * 10, 1);
      let w = 0;
      for (const run of loose) {
        for (let i = 0; i < n; i++) {
          const px = arc[i * 2];
          const pz = arc[i * 2 + 1];
          const t = ((px - run.x0) * run.dirX + (pz - run.z0) * run.dirZ) / run.lengthM;
          if (t < -1e-6 || t > 1 + 1e-6) continue;
          w = Math.max(w, Math.abs((px - run.x0) * run.dirZ - (pz - run.z0) * run.dirX));
        }
      }
      return w <= DEV + 1e-6;
    })(),
    "a 5 m corridor cuts more than 0.5 m of corner",
  );
  blind(
    "the corridor test accepts the run merge as configured",
    worstDev <= DEV + 1e-6,
    `worst deviation ${worstDev.toFixed(3)} m`,
  );
}

// ===========================================================================
// 6. Parked cars are at the kerb, not in a lane.
// ===========================================================================

console.log("\n--- a parked car is at the kerb and out of the running lane ---");

function placeParked(ways: readonly number[]): ParkedInstance[] {
  const out: ParkedInstance[] = [];
  for (const i of ways) addParked(out, sf.roads[i], i, plainWorld);
  return out;
}

const parked = placeParked(sfNear);

/** Worst overhang past the kerb, and worst intrusion into a traffic lane. */
function parkedFaults(set: readonly ParkedInstance[], bias = 0): { over: number; intrude: number } {
  let over = -Infinity;
  let intrude = -Infinity;
  for (const p of set) {
    const r = sf.roads[p.road];
    const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
    const offset = Math.abs(p.offsetM) + bias;
    over = Math.max(over, offset + CAR_HALF_M - half);
    const lanes = trafficLaneOffsetsM(r);
    const inner = lanes.length ? Math.max(...lanes) : 0;
    // The nearest traffic lane's outer flank against the parked car's inner one.
    intrude = Math.max(intrude, inner + CAR_HALF_M + PARKED_LANE_GAP_M - (offset - CAR_HALF_M));
  }
  return { over, intrude };
}

const faults = parkedFaults(parked);
check(
  "no parked car hangs off the kerb",
  parked.length >= MIN_SAMPLE && faults.over <= OVERHANG_EPS_M,
  `${parked.length} parked, worst flank ${faults.over.toFixed(3)} m past the kerb`,
);
check(
  "no parked car sits in a traffic lane",
  parked.length >= MIN_SAMPLE && faults.intrude <= 0,
  `worst gap deficit ${faults.intrude.toFixed(3)} m against a ${PARKED_LANE_GAP_M} m clearance`,
);
probe(
  "the lane test rejects parked cars moved 2 m toward the middle",
  parkedFaults(parked, -2).intrude <= 0,
  `deficit when moved inboard is ${parkedFaults(parked, -2).intrude.toFixed(2)} m`,
);
probe(
  "the kerb test rejects parked cars moved 2 m outward",
  parkedFaults(parked, 2).over <= OVERHANG_EPS_M,
  `overhang when moved outward is ${parkedFaults(parked, 2).over.toFixed(2)} m`,
);
blind(
  "both parked tests accept the cars where they are",
  faults.over <= OVERHANG_EPS_M && faults.intrude <= 0,
  `overhang ${faults.over.toFixed(3)} m, gap deficit ${faults.intrude.toFixed(3)} m`,
);

// The player drives inboard of the row. This is the assertion that would have
// caught the bug this change could easily have introduced: the driver's own
// camera passing through a line of stationary vehicles.
{
  const withParking = sf.roads.filter((r) => parkingStripM(r) > 0);
  const clears = withParking.filter((r) => {
    const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
    // The player's flank against the parked car's inner flank.
    const parkedInner = half - parkingStripM(r) - 0 + 0;
    return laneOffsetM(r) + CAR_HALF_M <= parkedInner + 1e-6;
  }).length;
  check(
    "the player's own lane clears the parked row on every street that has one",
    withParking.length >= MIN_SAMPLE && clears === withParking.length,
    `${clears} of ${withParking.length} streets with parking`,
  );
  const wouldClear = withParking.filter((r) => {
    const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
    // The offset laneOffsetM used to return, before the parking strip existed.
    return Math.max(0, half - 1.75) + CAR_HALF_M <= half - parkingStripM(r) + 1e-6;
  }).length;
  probe(
    "the clearance test rejects the lane offset that ignores parking",
    withParking.length > 0 && wouldClear === withParking.length,
    `${wouldClear} of ${withParking.length} would clear without the parking strip`,
  );
  blind(
    "the clearance test accepts the lane offset as it is",
    clears === withParking.length,
    `${clears} of ${withParking.length}`,
  );

  const strips = withParking.map(parkingStripM);
  const stripBad = strips.filter((s) => s < PARK_STRIP_MIN_M || s > PARK_STRIP_MAX_M).length;
  check(
    "every parking strip is wide enough for a car and no wider than a lane",
    stripBad === 0,
    `${strips.length} strips, ${stripBad} outside ${PARK_STRIP_MIN_M}..${PARK_STRIP_MAX_M} m`,
  );
  probe(
    "the strip band rejects a 0.5 m and a 4 m strip",
    [0.5, 4.0, 2.2].filter((s) => s < PARK_STRIP_MIN_M || s > PARK_STRIP_MAX_M).length !== 2,
    "2 of 3 probe strips rejected",
  );
  blind(
    "the strip band accepts the real strips",
    stripBad === 0,
    `${strips.length} real strips, none outside the band`,
  );

  // A motorway must never grow a row of parked cars, whatever its width says.
  const motorwayParking = sf.roads.filter(
    (r) => (r.cls === RoadClass.Motorway || r.cls === RoadClass.Trunk) && parkingStripM(r) > 0,
  ).length;
  check(
    "no motorway or trunk road has cars parked on it",
    motorwayParking === 0,
    `${motorwayParking} motorway or trunk ways with a parking strip`,
  );
  probe(
    "the motorway test rejects a class table that allowed it",
    // The same predicate over the classes that DO have parking: it must find
    // some, or the test above is passing because nothing anywhere has parking.
    sf.roads.filter((r) => r.cls === RoadClass.Residential && parkingStripM(r) > 0).length === 0,
    `${sf.roads.filter((r) => r.cls === RoadClass.Residential && parkingStripM(r) > 0).length} residential ways do have parking`,
  );
  blind(
    "the motorway test accepts the class table as it is",
    motorwayParking === 0,
    "no motorway parking",
  );
}

// ===========================================================================
// 7. Density tracks road class.
// ===========================================================================

console.log("\n--- an arterial carries more traffic than the alley behind it ---");

const HIERARCHY = [
  RoadClass.Motorway, RoadClass.Trunk, RoadClass.Primary, RoadClass.Secondary,
  RoadClass.Tertiary, RoadClass.Residential, RoadClass.Service,
];

function monotone(table: readonly number[]): boolean {
  for (let i = 1; i < HIERARCHY.length; i++) {
    if (table[HIERARCHY[i]] > table[HIERARCHY[i - 1]]) return false;
  }
  return table[HIERARCHY[0]] > table[HIERARCHY[HIERARCHY.length - 1]];
}

check(
  "the density table never rises as the road class falls",
  monotone(TRAFFIC_PER_KM_LANE),
  HIERARCHY.map((c) => TRAFFIC_PER_KM_LANE[c]).join(" >= "),
);
probe(
  "the monotone test rejects the table with two classes swapped",
  monotone(
    TRAFFIC_PER_KM_LANE.map((v, i) =>
      i === RoadClass.Residential ? TRAFFIC_PER_KM_LANE[RoadClass.Motorway]
      : i === RoadClass.Motorway ? TRAFFIC_PER_KM_LANE[RoadClass.Residential]
      : v),
  ),
  "the motorway and the residential street traded densities",
);
blind(
  "the monotone test accepts the table as it is",
  monotone(TRAFFIC_PER_KM_LANE.slice()),
  "the real table",
);

// And measured on the city, which is the half that catches a table that is
// monotone and a placement that ignores it.
{
  const lengthByClass = new Float64Array(14);
  for (const i of sfNear) {
    const r = sf.roads[i];
    let m = 0;
    for (let v = 2; v < r.pts.length; v += 2) {
      m += Math.hypot(r.pts[v] - r.pts[v - 2], r.pts[v + 1] - r.pts[v - 1]);
    }
    lengthByClass[r.cls] += m;
  }
  const carsByClass = new Float64Array(14);
  for (const c of cars) carsByClass[c.cls]++;
  const perKm = (c: RoadClass): number =>
    lengthByClass[c] > 0 ? carsByClass[c] / (lengthByClass[c] / 1000) : 0;

  const arterial = perKm(RoadClass.Primary);
  const street = perKm(RoadClass.Residential);
  const alley = perKm(RoadClass.Service);
  check(
    "measured on the city, a primary carries more than a residential, and a residential more than a service road",
    arterial > street && street > alley,
    `primary ${arterial.toFixed(1)}/km, residential ${street.toFixed(1)}/km, service ${alley.toFixed(1)}/km`,
  );
  probe(
    "the measured test rejects the comparison run backwards",
    alley > street && street > arterial,
    "service does not carry more than primary",
  );
  blind(
    "the measured test accepts the city as placed",
    arterial > street && street > alley,
    `${arterial.toFixed(1)} > ${street.toFixed(1)} > ${alley.toFixed(1)}`,
  );
}

// ===========================================================================
// 8. The .street pack survives a round trip, and the bake asks for it.
// ===========================================================================
//
// Nobody has been able to bake one: Overpass has refused this machine for the
// whole of this branch, and the disk cache predates the furniture statements,
// so every cached cell yields zero nodes. The format and the converter are
// therefore gated against a fixture, and the QUERY is gated against the text it
// has to contain, which is what will make the first successful bake land in a
// pack the renderer can already read.

console.log("\n--- the furniture pack, gated against a fixture ---");

{
  const items: Furniture[] = [
    { kind: FurnitureKind.StreetLamp, directionDeg: null, x: 12.5, z: -300.25 },
    { kind: FurnitureKind.Bench, directionDeg: 137.0, x: -1200.0, z: 640.5 },
    { kind: FurnitureKind.TrafficSignal, directionDeg: 0, x: 0, z: 0 },
    // 359 degrees is the case the sentinel clamp exists for: it quantises to
    // 255, which IS the sentinel, so without the clamp a real bearing comes
    // back as "not mapped". 359.5 would not do -- it rounds to 256 and wraps
    // harmlessly to zero -- and picking it is how this assertion first passed
    // over a broken encoder.
    { kind: FurnitureKind.WasteBasket, directionDeg: 359.0, x: 3000.5, z: -2.5 },
    { kind: FurnitureKind.FireHydrant, directionDeg: null, x: -7.75, z: 7.75 },
  ];
  const back = parseStreetPack(
    encodeStreetPack(items, 37.8085, -122.4098, 4000).buffer as ArrayBuffer,
  );
  const kindsKept = back.items.every((b, i) => b.kind === items[i].kind);
  let worstPos = 0;
  for (let i = 0; i < items.length; i++) {
    worstPos = Math.max(
      worstPos,
      Math.hypot(back.items[i].x - items[i].x, back.items[i].z - items[i].z),
    );
  }
  check(
    "a furniture pack round-trips its kinds and its coordinates",
    back.items.length === items.length && kindsKept && worstPos < 1e-3,
    `${back.items.length} records, worst position error ${worstPos.toExponential(2)} m`,
  );

  // The bearing is a byte, so it is lossy; what must NOT be lossy is the
  // difference between "north" and "not mapped". 359.5 degrees quantises to the
  // sentinel and has to be pulled off it.
  const unknowns = back.items.filter((b) => b.directionDeg === null).length;
  const northIsNorth = Math.abs((back.items[2].directionDeg ?? -1) - 0) < 2;
  const nearlyNorth = back.items[3].directionDeg;
  check(
    "a bearing of due north is not confused with no bearing at all",
    unknowns === 2 && northIsNorth && nearlyNorth !== null && nearlyNorth > 350,
    `${unknowns} unknown, signal at ${back.items[2].directionDeg}, bin at ${nearlyNorth?.toFixed(1)}`,
  );
  probe(
    "the bearing test rejects a pack where the sentinel swallowed a real bearing",
    // The same predicate over a pack whose 359.5 degree bearing was written as
    // the sentinel: it must notice the bin has lost its direction.
    (() => {
      const poisoned = items.map((it, i) => (i === 3 ? { ...it, directionDeg: null } : it));
      const p = parseStreetPack(
        encodeStreetPack(poisoned, 0, 0, 1).buffer as ArrayBuffer,
      );
      const un = p.items.filter((b) => b.directionDeg === null).length;
      const bin = p.items[3].directionDeg;
      return un === 2 && bin !== null && bin > 350;
    })(),
    `the sentinel is ${DIRECTION_UNKNOWN} and must not be reachable by rounding`,
  );
  blind(
    "the bearing test accepts the real pack",
    unknowns === 2 && northIsNorth && nearlyNorth !== null,
    "two unknown, three mapped",
  );
}

{
  // The converter, from an Overpass answer shaped exactly as the real one is.
  const origin = new Origin(37.8085, -122.4098);
  const at = (dx: number, dz: number): { lat: number; lon: number } => ({
    lat: 37.8085 - dz / origin.mPerLat,
    lon: -122.4098 + dx / origin.mPerLon,
  });
  const elements = [
    { type: "node", id: 1, lat: at(50, 50).lat, lon: at(50, 50).lon, tags: { highway: "street_lamp" } },
    { type: "node", id: 1, lat: at(50, 50).lat, lon: at(50, 50).lon, tags: { highway: "street_lamp" } },
    { type: "node", id: 2, lat: at(-80, 20).lat, lon: at(-80, 20).lon, tags: { amenity: "bench", direction: "220" } },
    { type: "node", id: 3, lat: at(0, 0).lat, lon: at(0, 0).lon, tags: { amenity: "cafe" } },
    { type: "node", id: 4, lat: at(9000, 0).lat, lon: at(9000, 0).lon, tags: { emergency: "fire_hydrant" } },
    { type: "way", id: 5, tags: { highway: "residential" } },
  ];
  const conv = furnitureFromOsm(elements, origin, 4000);
  const kinds = conv.items.map((i) => i.kind);
  check(
    "the converter keeps the furniture, de-dupes it, and drops the rest",
    conv.items.length === 2 &&
      kinds.includes(FurnitureKind.StreetLamp) &&
      kinds.includes(FurnitureKind.Bench),
    `${conv.items.length} kept of ${elements.length} elements, ${conv.skips.total()} skipped`,
  );
  probe(
    "the converter test rejects an answer with the cafe counted",
    conv.items.length === 3,
    "a cafe is not street furniture",
  );
  blind(
    "the converter test accepts the real answer",
    conv.items.length === 2,
    "a lamp and a bench, the duplicate lamp merged and the distant hydrant clipped",
  );

  check(
    "a bearing that is not a number is no bearing, rather than north",
    parseDirection("forward") === null && parseDirection("N") === null &&
      parseDirection("220") === 220,
    "forward and N are unknown, 220 is 220",
  );
  probe(
    "the bearing parser rejects a parser that guessed",
    parseDirection("forward") === 0,
    "forward would have become due north",
  );
  blind(
    "the bearing parser accepts a plain bearing",
    parseDirection("47.5") === 47.5,
    "47.5 parses",
  );
}

{
  // The bake query must ask for every statement the runtime query asks for AND
  // for the furniture. The first half is what stops the bake quietly diverging
  // from the live path; the second is the feature.
  const BOX = { s: 37.79, w: -122.42, n: 37.81, e: -122.40 };
  const bake = roadsAndFurnitureQuery(BOX);
  const runtime = roadsQuery(BOX);
  const runtimeStatements = runtime
    .split("\n")
    .slice(1, -1)
    .map((l) => l.replace(/^[(\s]+/, "").replace(/[);\s]+$/, ""))
    .filter((l) => l.length > 0);
  const covers = runtimeStatements.every((s) => bake.includes(s));
  const asksFor = [
    "street_lamp", "traffic_signals", "bench", "waste_basket", "fire_hydrant",
  ].filter((tag) => bake.includes(tag));
  check(
    "the bake query is the runtime query plus the furniture",
    covers && asksFor.length === 5 && !runtime.includes("street_lamp"),
    `${runtimeStatements.length} road statements covered, ${asksFor.length} furniture tags asked for`,
  );
  probe(
    "the query test rejects a bake query with a furniture tag dropped",
    ["street_lamp", "traffic_signals", "bench", "waste_basket", "fire_hydrant"]
      .filter((tag) => bake.replace(/street_lamp/g, "lamppost").includes(tag)).length === 5,
    "renaming the street lamp tag is caught",
  );
  blind(
    "the query test accepts the queries as they are",
    covers && asksFor.length === 5,
    "all five tags, and every road statement",
  );
}

// ===========================================================================
// 9. Two cities, so the assertions are not San Francisco's alone.
// ===========================================================================

console.log("\n--- and the same over Chicago ---");

{
  const chi = await roads("chicago");
  const chiNear = near(chi);
  const chiCity = await city("chicago");
  const chiFootprints = new FootprintMask(chiCity.buildings, chiCity.radiusM);
  const chiCarriageways = carriagewayIndexFor(chi);
  const world: StreetWorld = {
    groundY: RAMP,
    occupied: (x, z) => chiFootprints.occupied(x, z),
    onCarriageway: (x, z, except) => chiCarriageways.blockedExcept(x, z, except),
    nearestMeasuredLamp: null,
  };
  const chiLamps: LampInstance[] = [];
  const chiCars: TrafficInstance[] = [];
  const chiParked: ParkedInstance[] = [];
  for (const i of chiNear) {
    addLamps(chiLamps, chi.roads[i], i, world);
    addTraffic(chiCars, chi.roads[i], i, world);
    addParked(chiParked, chi.roads[i], i, world);
  }

  let worstChiOverhang = -Infinity;
  for (const c of chiCars) {
    const r = chi.roads[c.road];
    const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
    const dx = c.x1 - c.x0;
    const dz = c.z1 - c.z0;
    for (let k = 0; k <= 8; k++) {
      const s = k / 8;
      worstChiOverhang = Math.max(
        worstChiOverhang,
        nearestOn(r.pts, c.x0 + dx * s, c.z0 + dz * s).distanceM + CAR_HALF_M - half,
      );
    }
  }
  const chiInside = chiLamps.filter((l) => chiFootprints.occupied(l.x, l.z)).length;
  check(
    "Chicago: every column is clear of the buildings and every car is between the kerbs",
    chiLamps.length >= MIN_SAMPLE && chiCars.length >= MIN_SAMPLE &&
      chiInside === 0 && worstChiOverhang <= OVERHANG_EPS_M,
    `${chiLamps.length} lamps (${chiInside} inside a building), ${chiCars.length} cars ` +
      `(worst flank ${worstChiOverhang.toFixed(3)} m), ${chiParked.length} parked`,
  );

  // Every instance sits on the height field rather than at zero. The cheapest
  // possible bug in a placement that takes a callback is not calling it.
  //
  // AND IT SITS ON THE DECK, NOT ON THE TERRAIN. render/roads.ts draws the
  // carriageway lifted off the ground under it, so a car placed at the raw
  // height field is BELOW the tarmac by that lift. At 0.35 m against a road
  // wheel of 0.33 m that buried every car in every city to its axles, which is
  // what it looked like: vehicles wading through the road rather than standing
  // on it. A lamp column takes the same lift plus a kerb, because it stands on
  // the pavement rather than in the gutter.
  //
  // The expected heights below are computed from the pack's own flags but the
  // BAND is a literal, so raising the lift cannot move the goalposts with it.
  const deck = (p: { x: number; z: number; road: number }): number => {
    const r = chi.roads[p.road];
    return RAMP(p.x, p.z) + roadLiftM(r.flags, r.layer);
  };
  const flat = [...chiLamps, ...chiParked].filter((p) => p.y === 0).length;
  const parkedOnDeck = chiParked.filter((p) => Math.abs(p.y - deck(p)) < 1e-3).length;
  const lampsOnKerb = chiLamps.filter(
    (p) => Math.abs(p.y - deck(p) - KERB_HEIGHT_M) < 1e-3,
  ).length;
  check(
    "every column and every parked car sits on the deck, not in it",
    flat === 0 && parkedOnDeck === chiParked.length && lampsOnKerb === chiLamps.length,
    `${parkedOnDeck}/${chiParked.length} parked on the deck, ` +
      `${lampsOnKerb}/${chiLamps.length} lamps on the kerb, ${flat} at y=0`,
  );

  // And the clearance is inside the band a real kerbed street occupies,
  // independent of how it was arrived at. 0.20 m is under any road wheel this
  // repo builds, so a car standing this high off the terrain cannot be buried;
  // 0.90 m is well under the 3.85 m a bridge deck adds, so this is a statement
  // about ordinary streets and the sample is restricted to them.
  const onGrade = chiParked.filter((p) => (chi.roads[p.road].flags & ROAD_BRIDGE) === 0);
  let lowest = Infinity;
  let highest = -Infinity;
  for (const p of onGrade) {
    const c = p.y - RAMP(p.x, p.z);
    lowest = Math.min(lowest, c);
    highest = Math.max(highest, c);
  }
  check(
    "a parked car on an ordinary street stands clear of the terrain",
    onGrade.length >= MIN_SAMPLE && lowest > 0.20 && highest < 0.90,
    `${onGrade.length} cars, clearance ${lowest.toFixed(3)}..${highest.toFixed(3)} m`,
  );
  probe(
    "the clearance test rejects a car left on the raw height field",
    onGrade.length >= MIN_SAMPLE && 0 > 0.20 && 0 < 0.90,
    "placing at groundY gives a clearance of 0.000 m",
  );
  blind(
    "the clearance test accepts the cars as placed",
    onGrade.length >= MIN_SAMPLE && lowest > 0.20 && highest < 0.90,
    `${lowest.toFixed(3)}..${highest.toFixed(3)} m`,
  );
  probe(
    "the height test rejects instances left at zero",
    [{ x: 1, y: 0, z: 1, road: 0 }].filter((p) => Math.abs(p.y - deck(p)) < 1e-3).length === 1,
    "a y of zero is not the deck anywhere in this city",
  );
  blind(
    "the height test accepts the instances as placed",
    parkedOnDeck === chiParked.length && lampsOnKerb === chiLamps.length,
    `${parkedOnDeck} parked, ${lampsOnKerb} lamps`,
  );

  // Runs on a real city, so `runsFor` is exercised against digitised geometry
  // rather than the synthetic arc above.
  let longest = 0;
  let runCount = 0;
  for (const i of chiNear) {
    for (const run of runsFor(chi.roads[i])) {
      runCount++;
      longest = Math.max(longest, run.lengthM);
    }
  }
  check(
    "the run merge produces stretches a car can actually drive down",
    runCount >= MIN_SAMPLE && longest >= 150,
    `${runCount} runs, longest ${longest.toFixed(0)} m`,
  );
  // The probe is a zigzag rather than the city with the corridor turned down,
  // because a genuinely straight avenue merges at ANY corridor including zero:
  // the corridor decides what curves through, not what is already a line. A
  // sawtooth of 30 m teeth is geometry no merge is allowed to straighten.
  probe(
    "the run-length test rejects a road no merge can straighten",
    (() => {
      const n = 60;
      const saw = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        saw[i * 2] = i * 30;
        saw[i * 2 + 1] = i % 2 === 0 ? 0 : 14;
      }
      const runs = straightRuns(saw, 0.8, 22);
      let l = 0;
      for (const r of runs) l = Math.max(l, r.lengthM);
      return runs.length >= MIN_SAMPLE && l >= 150;
    })(),
    "a 30 m sawtooth produces no run of 150 m",
  );
  blind(
    "the run-length test accepts the merge as configured",
    runCount >= MIN_SAMPLE && longest >= 150,
    `longest ${longest.toFixed(0)} m`,
  );
}

// ===========================================================================

console.log(
  failures === 0
    ? `\nall ${checks} street checks ok`
    : `\n${failures} of ${checks} street check(s) FAILED`,
);
if (failures > 0) process.exit(1);
