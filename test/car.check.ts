// The gate on the driveable graph and the car that drives it, against the real
// committed packs.
//
// What is settled here is everything a screenshot cannot settle. A frame says
// whether a street looks like a street; it does not say whether the network is
// connected, whether a side street actually joins the avenue it ends on,
// whether the car is in the correct lane of a one-way, whether it is sitting on
// the tarmac or a metre under it, or whether the same drive twice is the same
// drive. Those are arithmetic, so they are asserted here, under Bun, against
// public/cities/*.roads.
//
// GATE DISCIPLINE. Every bound below is a LITERAL, never the constant under
// test, and where a constant exists it is asserted to be inside its own literal
// bound rather than being the bound. Every assertion is followed by a VACUITY
// PROBE: the same checker fed a case it MUST reject, so a checker that has
// quietly stopped looking at anything reports red rather than green. This repo
// has shipped five gates that could never fail, and the most recent reported
// 50/50 with the feature entirely removed.
//
// WATCHED TO FAIL. Every mutation below was applied, seen red, and restored.
//
//   * joining by exact equality instead of the 0.30 m tolerance: San Francisco
//     drops from 99.64% of its core network in one component to 0.97% over
//     1,609, junctions from 8,720 to 0, and every known crossroads to Infinity;
//   * joining endpoint-to-endpoint only, with no shared interior vertex: sf
//     junctions 8,720 -> 8,050, cut ways 3,176 -> 2,775, Divisadero and Geary
//     14.9 m -> 51.7 m away;
//   * letting paths and tunnels into the graph: 47,725 of sf's 78,446 edges are
//     then undriveable;
//   * giving a one-way a reverse half-edge: 6,365 illegal departures in sf;
//   * negating the lane offset: 129/397 one-ways correct instead of 397/397;
//   * removing the clamp that keeps the car on the carriageway: 9.8 half-widths
//     off the centreline in sf and 12.9 in manhattan;
//   * dropping the ribbon lift from the road surface: 0.35 m of error against a
//     0.005 m bound;
//   * a 1e-6 relative jitter in the lateral integration: the two runs diverge
//     by 5.3e-7 m;
//   * not stopping at a dead end: the car leaves the end of the road at 40 m/s;
//   * throwing away the inherited momentum: 0.0 m/s instead of 22;
//   * moving the near plane back to the aeroplane's 2 m: it no longer clears
//     the 1.60 m of ground the steepest look down can see.
//
// AND EVERY PROBE WAS BLINDED IN TURN, each reporting PROBE-FAIL: the scatter
// set to 0 m, the displacement set to 0 m, the mirror made an identity, the
// flat world made the same ramp, the second drive given the same plan, the
// nanometre tamper removed, the empty graph asked twice, the sideways momentum
// pointed along the road, the near-plane probe given the car's own constant,
// the one-way counter made unconditional, and the path/tunnel premise given a
// pack with nothing to reject.

import {
  parseRoadPack,
  roadWidthM,
  ROAD_LIFT_M,
  ROAD_ONEWAY,
  ROAD_TUNNEL,
  ROAD_BRIDGE,
  RoadClass,
  LANE_WIDTH_M,
  type Road,
  type RoadPack,
} from "../src/data/roadpack";
import {
  buildRoadGraph,
  connectedComponents,
  isDriveable,
  laneOffsetM,
  JOIN_TOLERANCE_M,
  FIRST_NON_DRIVEABLE_CLASS,
  type RoadGraph,
} from "../src/data/roadgraph";
import { RoadIndex } from "../src/data/trees";
import {
  Car,
  CAR_HALF_WIDTH_M,
  CAR_EYE_HEIGHT_M,
  CAR_TOP_SPEED,
  CAR_NEAR_PLANE_M,
  CAR_PITCH_LIMIT,
  type CarInput,
} from "../src/sim/car";
import { Origin } from "../src/geo";
import * as THREE from "three";

const DIR = "public/cities";

// --- literal bounds ---------------------------------------------------------
// None of these is a constant the graph or the car reads. They are the numbers
// this check is willing to accept, written down once, here.

/**
 * Radius about the pack centre the connectivity bound is measured over.
 *
 * The whole pack is the wrong denominator and the reason is geography, not
 * code. Manhattan's 8 km box reaches New Jersey, which this graph correctly
 * cannot reach: the Holland and Lincoln tunnels are the only crossings inside
 * the box and no tunnel geometry exists to drive through, so a third of the
 * pack's length is genuinely a separate network. Measured over the whole pack
 * the largest component is 65.5% there and 92.8% in San Francisco. Over the
 * 2 km the detail ring and the car actually live in, both are above 99.6%.
 */
const CORE_RADIUS_M = 2000;
/** Share of core driveable length the largest component must carry. */
const MIN_CORE_COMPONENT_SHARE = 0.97;
/** And what the poisoned graph must fall below, so the probe is not a whisker. */
const POISONED_COMPONENT_SHARE = 0.50;

/**
 * Junctions (three or more edge ends) the graph must find, and through-ways it
 * must CUT because something met them part-way along.
 *
 * Set BETWEEN two measurements, which is what makes them able to fail rather
 * than merely be exceeded. As built: sf 8,720 junctions and 3,176 cut ways,
 * manhattan 24,769 and 8,311. With the shared-interior-vertex rule removed, so
 * that ways join end to end only: sf 8,050 and 2,775, manhattan 22,572 and
 * 7,266. The bounds below sit above the second pair, so losing that rule is a
 * failure and not a shrug.
 */
const MIN_JUNCTIONS: Record<string, number> = { sf: 8400, manhattan: 24000 };
const MIN_CUT_WAYS: Record<string, number> = { sf: 3000, manhattan: 8000 };
/** How near a hand-typed crossroads a degree-4 junction must be found. Wide
 *  because the coordinates below are read off a map by eye, not surveyed. */
const KNOWN_JUNCTION_M = 30;

/** Distance from the nearest driveable centreline, as a fraction of that road's
 *  half-width, that the car may ever reach. One means "on the carriageway". */
const MAX_CENTRELINE_RATIO = 1.0;
/** How far a probe displaces a sample to prove the ratio check can reject. */
const PROBE_DISPLACE_M = 3.0;

/** Metres the car's contact patch may differ from `heightAt` plus the ribbon
 *  lift, off a bridge. It is an equality; the slack is float noise. */
const MAX_SURFACE_ERROR_M = 0.005;
/** And on a bridge deck, where the ribbon interpolates between the ends. */
const MAX_BRIDGE_CLEARANCE_M = 32;

/** Metres the lane offset may differ from what roadpack's width table implies. */
const MAX_LANE_ERROR_M = 0.01;
/**
 * The kerbside parking strip, as LITERALS, so this file can re-derive the lane
 * offset without importing the constants it is checking.
 *
 * These three numbers are the parking rule in src/data/roadpack.ts written out
 * again: a 2.2 m strip each side, only where at least 3 m of running surface is
 * left between the two rows, and never a strip under 1.9 m. The lane a driver
 * can use starts inboard of that strip, which is what laneOffsetM has to say.
 */
const PARK_STRIP_M = 2.2;
const PARK_MIN_RUNNING_M = 3.0;
const PARK_MIN_STRIP_M = 1.9;
/** Classes with kerbside parking, in the roadpack class order. */
const PARK_CLASSES = [false, false, true, true, true, true, true, false, true, false, false, false, false, false];

/** The parking strip a way has, from literals only. */
function parkStrip(e: { cls: number; lanes: number; flags: number }): number {
  if (!PARK_CLASSES[e.cls]) return 0;
  // A bridge, a tunnel and a link ramp have no parking on them.
  if ((e.flags & (2 | 4 | 8)) !== 0) return 0;
  const w = roadWidthM(e.cls, e.lanes, e.flags);
  const strip = Math.min(PARK_STRIP_M, (w - PARK_MIN_RUNNING_M) * 0.5);
  return strip >= PARK_MIN_STRIP_M ? strip : 0;
}
/** Share of sampled one-way edges that must put the car strictly to the right
 *  of the direction of travel. Not 1: a single-track service road is one lane
 *  wide and its lane centre IS the centreline, correctly. */
const MIN_ONEWAY_RIGHT_SHARE = 0.80;

/** Seconds of driving per route, and the tick it is driven at. */
const DRIVE_S = 60;
const DRIVE_DT = 1 / 60;
/** Frames between samples. Six is a tenth of a second at 60 Hz. */
const SAMPLE_EVERY = 6;
/** Metres a route must cover, or the drive proved nothing about junctions. */
const MIN_ROUTE_M = 300;

// Constants under test, each asserted to be inside a literal band of its own.
const JOIN_TOLERANCE_BAND: [number, number] = [0.05, 0.5];
const CAR_HALF_WIDTH_BAND: [number, number] = [0.5, 1.5];
const EYE_HEIGHT_BAND: [number, number] = [1.2, 1.8];
const ROAD_LIFT_BAND: [number, number] = [0.05, 1.0];
const NEAR_PLANE_BAND: [number, number] = [0.5, 1.9];

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${detail}`);
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
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(48)} ${detail}`);
  if (!ok) failures++;
}

// --- pack loading -----------------------------------------------------------

const packs = new Map<string, RoadPack>();
async function pack(id: string): Promise<RoadPack> {
  if (!packs.has(id)) {
    const f = Bun.file(`${DIR}/${id}.roads`);
    if (!(await f.exists())) throw new Error(`no ${DIR}/${id}.roads -- run: bun tools/bake-roads.ts --all`);
    packs.set(id, parseRoadPack(await f.arrayBuffer()));
  }
  return packs.get(id)!;
}

/**
 * A terrain that is not flat, so a car that never asked the height field shows
 * up as a constant. A ramp rather than noise, because the assertion on it is an
 * equality; the same trick test/trees.check.ts uses.
 */
const RAMP = (x: number, z: number): number => 34 + x * 0.013 - z * 0.009;

/**
 * The poison: shift every way by a deterministic offset of its own.
 *
 * This is what a broken join looks like. Two ways that share an OSM node still
 * have a vertex at the same place in the source, and after this they do not:
 * they are up to 2 * `metres` apart, which is past any tolerance the join is
 * allowed to use. Nothing else about the data changes, so anything that goes
 * red under it went red because ways stopped being joined.
 */
function scatterWays(roads: readonly Road[], metres: number): Road[] {
  return roads.map((r, i) => {
    let h = Math.imul(i + 1, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    const a = ((h >>> 0) / 4294967296) * Math.PI * 2;
    const dx = Math.cos(a) * metres;
    const dz = Math.sin(a) * metres;
    const pts = new Float32Array(r.pts.length);
    for (let v = 0; v < r.pts.length; v += 2) {
      pts[v] = r.pts[v] + dx;
      pts[v + 1] = r.pts[v + 1] + dz;
    }
    return { ...r, pts };
  });
}

// --- the connectivity checker, used on real and on poisoned input -----------

/** Largest undirected component's share of driveable length near the centre. */
function coreComponentShare(g: RoadGraph): { share: number; totalM: number; comps: number } {
  const comp = connectedComponents(g);
  const lens = new Map<number, number>();
  let totalM = 0;
  for (const e of g.edges) {
    const mx = (g.nodeX[e.a] + g.nodeX[e.b]) * 0.5;
    const mz = (g.nodeZ[e.a] + g.nodeZ[e.b]) * 0.5;
    if (Math.hypot(mx, mz) > CORE_RADIUS_M) continue;
    totalM += e.lengthM;
    lens.set(comp[e.a], (lens.get(comp[e.a]) ?? 0) + e.lengthM);
  }
  const sorted = [...lens.values()].sort((a, b) => b - a);
  return { share: totalM > 0 ? sorted[0] / totalM : 0, totalM, comps: sorted.length };
}

/** Whole-pack share, printed rather than gated; see CORE_RADIUS_M. */
function wholeComponentShare(g: RoadGraph): number {
  const comp = connectedComponents(g);
  const lens = new Map<number, number>();
  let total = 0;
  for (const e of g.edges) {
    total += e.lengthM;
    lens.set(comp[e.a], (lens.get(comp[e.a]) ?? 0) + e.lengthM);
  }
  return total > 0 ? Math.max(...lens.values()) / total : 0;
}

// --- 1. the constants are inside their own literal bands --------------------

console.log("\n--- the constants under test are themselves in range ---");

for (const [name, value, band] of [
  ["JOIN_TOLERANCE_M", JOIN_TOLERANCE_M, JOIN_TOLERANCE_BAND],
  ["CAR_HALF_WIDTH_M", CAR_HALF_WIDTH_M, CAR_HALF_WIDTH_BAND],
  ["CAR_EYE_HEIGHT_M", CAR_EYE_HEIGHT_M, EYE_HEIGHT_BAND],
  ["ROAD_LIFT_M", ROAD_LIFT_M, ROAD_LIFT_BAND],
  ["CAR_NEAR_PLANE_M", CAR_NEAR_PLANE_M, NEAR_PLANE_BAND],
] as [string, number, [number, number]][]) {
  check(
    `${name} is inside its literal band`,
    value >= band[0] && value <= band[1],
    `${value} in [${band[0]}, ${band[1]}]`,
  );
}

// The near plane has to clear the ground the driver can see under the bonnet.
// Worst case is the steepest downward look: the bottom of a 70 degree frame at
// CAR_PITCH_LIMIT down puts the nearest visible ground at eye / sin(that).
{
  const worstDeg = CAR_PITCH_LIMIT + 70 / 2;
  const nearestGroundM = CAR_EYE_HEIGHT_M / Math.sin((worstDeg * Math.PI) / 180);
  check(
    "the near plane clears the ground at the steepest look down",
    CAR_NEAR_PLANE_M < nearestGroundM,
    `near ${CAR_NEAR_PLANE_M} m < ${nearestGroundM.toFixed(2)} m of ground at ${worstDeg} deg`,
  );
  probe(
    "the aeroplane's 2 m near plane would NOT clear it",
    2.0 < nearestGroundM,
    `2 m against ${nearestGroundM.toFixed(2)} m`,
  );
}

// --- 2. the graph is connected ----------------------------------------------

console.log("\n--- the driveable graph is one network ---");

for (const id of ["sf", "manhattan"]) {
  const p = await pack(id);
  const g = buildRoadGraph(p.roads);
  const core = coreComponentShare(g);
  check(
    `${id}: one component carries the core network`,
    core.share >= MIN_CORE_COMPONENT_SHARE,
    `${(core.share * 100).toFixed(2)}% of ${(core.totalM / 1000).toFixed(0)} km ` +
    `within ${CORE_RADIUS_M} m, ${core.comps} components ` +
    `(whole pack ${(wholeComponentShare(g) * 100).toFixed(1)}%)`,
  );

  const poisoned = coreComponentShare(buildRoadGraph(scatterWays(p.roads, 0.9)));
  probe(
    `${id}: ways scattered 0.9 m do not join`,
    poisoned.share >= MIN_CORE_COMPONENT_SHARE || poisoned.share >= POISONED_COMPONENT_SHARE,
    `largest ${(poisoned.share * 100).toFixed(2)}% over ${poisoned.comps} components`,
  );
}

// --- 3. joining actually joins ----------------------------------------------

console.log("\n--- ways are joined, and through-ways are cut at junctions ---");

/** Crossroads read off a map. The bound is generous because these coordinates
 *  are typed by hand and the graph's node is the surveyed one. */
const KNOWN: Record<string, [string, number, number][]> = {
  sf: [
    ["Market x Van Ness", 37.77517, -122.41913],
    ["Divisadero x Geary", 37.78436, -122.43949],
    ["Bay x Columbus", 37.80533, -122.41697],
    ["Cesar Chavez x Guerrero", 37.74807, -122.42239],
  ],
  manhattan: [
    ["Broadway x Canal", 40.72007, -74.00126],
    ["Lexington x 42nd", 40.75122, -73.97590],
    ["Houston x Broadway", 40.72534, -73.99646],
  ],
};

/** Distance to the nearest node of degree 4 or more. */
function nearestCrossroadsM(g: RoadGraph, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < g.nodeCount; i++) {
    if (g.degree[i] < 4) continue;
    const d = Math.hypot(g.nodeX[i] - x, g.nodeZ[i] - z);
    if (d < best) best = d;
  }
  return best;
}

for (const id of ["sf", "manhattan"]) {
  const p = await pack(id);
  const g = buildRoadGraph(p.roads);
  check(
    `${id}: junctions found`,
    g.stats.junctions >= MIN_JUNCTIONS[id],
    `${g.stats.junctions} nodes of degree 3+, at least ${MIN_JUNCTIONS[id]}`,
  );
  check(
    `${id}: through-ways cut where something meets them`,
    g.stats.cutWays >= MIN_CUT_WAYS[id],
    `${g.stats.cutWays} ways cut, at least ${MIN_CUT_WAYS[id]} ` +
    `(${g.stats.driveableWays} driveable ways -> ${g.stats.edges} edges)`,
  );

  const origin = new Origin(p.lat0, p.lon0);
  const found = KNOWN[id].map(([name, lat, lon]) => {
    const w = origin.toWorld(lat, lon);
    return { name, d: nearestCrossroadsM(g, w.x, w.z) };
  });
  const worst = found.reduce((a, b) => (a.d > b.d ? a : b));
  check(
    `${id}: every known crossroads is a junction`,
    found.every((f) => f.d <= KNOWN_JUNCTION_M),
    `worst ${worst.name} at ${worst.d.toFixed(1)} m, limit ${KNOWN_JUNCTION_M} m`,
  );

  const poisoned = buildRoadGraph(scatterWays(p.roads, 0.9));
  const poisonedFound = KNOWN[id].map(([, lat, lon]) => {
    const w = origin.toWorld(lat, lon);
    return nearestCrossroadsM(poisoned, w.x, w.z);
  });
  probe(
    `${id}: scattered ways lose their junctions`,
    poisoned.stats.junctions >= MIN_JUNCTIONS[id] &&
      poisoned.stats.cutWays >= MIN_CUT_WAYS[id] &&
      poisonedFound.every((d) => d <= KNOWN_JUNCTION_M),
    `${poisoned.stats.junctions} junctions, ${poisoned.stats.cutWays} cut, ` +
    `worst known crossroads ${Math.max(...poisonedFound).toFixed(0)} m`,
  );
}

// --- 4. nothing undriveable is in the graph ---------------------------------

console.log("\n--- footways, cycleways and tunnels are not driveable ---");

for (const id of ["sf", "manhattan"]) {
  const p = await pack(id);
  const g = buildRoadGraph(p.roads);
  const bad = g.edges.filter(
    (e) => e.cls >= FIRST_NON_DRIVEABLE_CLASS || (e.flags & ROAD_TUNNEL) !== 0,
  );
  check(
    `${id}: no path or tunnel edge in the graph`,
    bad.length === 0,
    `${bad.length} of ${g.edges.length} edges`,
  );
  // A filter with nothing to filter is a filter that proves nothing.
  const removable = p.roads.filter((r) => !isDriveable(r));
  const tunnels = p.roads.filter((r) => (r.flags & ROAD_TUNNEL) !== 0);
  const paths = p.roads.filter((r) => r.cls >= FIRST_NON_DRIVEABLE_CLASS);
  probe(
    `${id}: the pack HAS paths and tunnels to reject`,
    removable.length === 0 || tunnels.length === 0 || paths.length === 0,
    `${paths.length} path ways, ${tunnels.length} tunnel ways, ${removable.length} rejected`,
  );
}

// --- 5. one-way is respected ------------------------------------------------

console.log("\n--- one-way ways have no reverse half-edge ---");

for (const id of ["sf", "manhattan"]) {
  const p = await pack(id);
  const g = buildRoadGraph(p.roads);
  let wrong = 0;
  for (let n = 0; n < g.nodeCount; n++) {
    for (const h of g.out[n]) {
      const e = g.edges[h.edge];
      if (e.oneway && !h.forward) wrong++;
    }
  }
  const oneways = g.edges.filter((e) => e.oneway).length;
  check(
    `${id}: no half-edge travels a one-way backwards`,
    wrong === 0 && oneways > 0,
    `${oneways} one-way edges of ${g.edges.length}, ${wrong} illegal departures`,
  );
  // The same count taken with the one-way flag ignored, which is what a graph
  // that had forgotten to check it would produce.
  let ignoring = 0;
  for (const e of g.edges) if (e.oneway) ignoring++;
  probe(
    `${id}: ignoring the flag would create reverse half-edges`,
    ignoring === 0,
    `${ignoring} reverse half-edges suppressed`,
  );
}

// --- 6. the lane offset puts the car on the correct side --------------------

console.log("\n--- the lane offset is the kerb lane, right of travel ---");

for (const id of ["sf", "manhattan"]) {
  const p = await pack(id);
  const g = buildRoadGraph(p.roads);
  const oneways = g.edges.filter((e) => e.oneway);
  const step = Math.max(1, Math.floor(oneways.length / 500));

  let checked = 0;
  let right = 0;
  let wrongWidth = 0;
  let mirroredAccepted = 0;
  for (let i = 0; i < oneways.length; i += step) {
    const e = oneways[i];
    const half = roadWidthM(e.cls, e.lanes, e.flags) * 0.5;
    const want = laneOffsetM(e);
    // The formula, checked against the width table independently of the code
    // that produced it.
    if (Math.abs(want - Math.max(0, half - parkStrip(e) - LANE_WIDTH_M * 0.5)) > MAX_LANE_ERROR_M) {
      wrongWidth++;
    }

    const car = new Car(g);
    // Enter at the start of this edge, pointing along it, so the direction of
    // travel is the way's own direction and the offset must be to its right.
    const dirX = e.pts[2] - e.pts[0];
    const dirZ = e.pts[3] - e.pts[1];
    const k = Math.hypot(dirX, dirZ);
    const hdg = (Math.atan2(dirX / k, -dirZ / k) * 180) / Math.PI;
    const at = new THREE.Vector3(e.pts[0], 0, e.pts[1]);
    if (!car.enterFrom(at, hdg, new THREE.Vector3(), RAMP)) continue;
    if (car.edge !== e) continue;

    // Signed lateral: positive is right of travel, where right of (dx, dz) is
    // (-dz, dx).
    const ox = car.position.x - e.pts[0];
    const oz = car.position.z - e.pts[1];
    const lateral = ox * (-dirZ / k) + oz * (dirX / k);
    checked++;
    if (Math.abs(lateral - want) <= MAX_LANE_ERROR_M && (want === 0 || lateral > 0)) right++;
    // The probe, computed on the same sample: a car placed the same distance to
    // the LEFT must not be accepted.
    const mirrored = -lateral;
    if (Math.abs(mirrored - want) <= MAX_LANE_ERROR_M && (want === 0 || mirrored > 0)) {
      mirroredAccepted++;
    }
  }

  check(
    `${id}: one-way lane offsets sit right of travel`,
    checked > 100 && right / checked >= MIN_ONEWAY_RIGHT_SHARE && wrongWidth === 0,
    `${right}/${checked} correct, ${wrongWidth} disagree with the width table`,
  );
  probe(
    `${id}: the same offsets mirrored are rejected`,
    checked > 0 && mirroredAccepted / checked >= MIN_ONEWAY_RIGHT_SHARE,
    `${mirroredAccepted}/${checked} mirrored samples accepted`,
  );
}

// --- 7. driving ---------------------------------------------------------------

console.log("\n--- a car following a route stays on the carriageway ---");

/** Start points for the drives, by name so a failure says where. */
const STARTS: Record<string, [string, number, number, number][]> = {
  sf: [
    ["Market at Van Ness", 37.77517, -122.41913, 45],
    ["Geary at Divisadero", 37.78436, -122.43949, 270],
    ["Columbus at Bay", 37.80533, -122.41697, 135],
    ["Guerrero at Cesar Chavez", 37.74807, -122.42239, 0],
  ],
  manhattan: [
    ["Canal at Broadway", 40.72007, -74.00126, 90],
    ["42nd at Lexington", 40.75122, -73.97590, 270],
    ["Houston at Broadway", 40.72534, -73.99646, 180],
  ],
};

/**
 * The input plan, a function of time alone.
 *
 * Deliberately busy: it holds full throttle, swings the wheel through both
 * locks and through centre, and does so on a period that is not a multiple of
 * anything, so the drive takes left turns, right turns and straight-ons and
 * spends time hard against both kerbs.
 */
function plan(t: number, seed: number): CarInput {
  const s = Math.sin(t * 0.41 + seed * 1.7) + 0.6 * Math.sin(t * 0.17 + seed);
  return {
    throttle: 1,
    steer: Math.max(-1, Math.min(1, s)),
    boost: 0,
    lookYawDeg: 0,
    lookPitchDeg: 0,
  };
}

interface Sample {
  x: number;
  z: number;
  y: number;
  widthM: number;
  bridge: boolean;
}

function drive(g: RoadGraph, start: THREE.Vector3, hdg: number, seed: number): Sample[] | null {
  const car = new Car(g);
  if (!car.enterFrom(start, hdg, new THREE.Vector3(), RAMP)) return null;
  const out: Sample[] = [];
  const steps = Math.round(DRIVE_S / DRIVE_DT);
  for (let i = 0; i < steps; i++) {
    car.update(plan(i * DRIVE_DT, seed), DRIVE_DT, RAMP);
    if (i % SAMPLE_EVERY !== 0) continue;
    const e = car.edge!;
    out.push({
      x: car.position.x,
      z: car.position.z,
      y: car.position.y,
      widthM: car.carriagewayWidthM,
      bridge: (e.flags & ROAD_BRIDGE) !== 0,
    });
  }
  return out;
}

/** Worst distance from the nearest driveable centreline, in half-widths. */
function worstCentrelineRatio(
  index: RoadIndex,
  samples: Sample[],
  displaceM: number,
): { ratio: number; atX: number; atZ: number } {
  let worst = 0;
  let atX = 0;
  let atZ = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    // Displacement for the probe: a fixed step perpendicular to the last move,
    // so a poisoned sample is genuinely off the road rather than further along
    // it.
    let x = s.x;
    let z = s.z;
    if (displaceM !== 0 && i > 0) {
      const dx = s.x - samples[i - 1].x;
      const dz = s.z - samples[i - 1].z;
      const k = Math.hypot(dx, dz);
      if (k > 1e-6) {
        x += (-dz / k) * displaceM;
        z += (dx / k) * displaceM;
      }
    }
    const hit = index.nearestSegment(x, z, 200);
    const d = hit ? hit.distanceM : 200;
    const ratio = d / Math.max(1e-6, s.widthM * 0.5);
    if (ratio > worst) {
      worst = ratio;
      atX = x;
      atZ = z;
    }
  }
  return { ratio: worst, atX, atZ };
}

for (const id of ["sf", "manhattan"]) {
  const p = await pack(id);
  const g = buildRoadGraph(p.roads);
  const origin = new Origin(p.lat0, p.lon0);
  // An index over the PACK's own ways, not over the graph's edges. That is what
  // makes this an independent oracle: if the graph itself were wrong the car
  // would still be measured against the roads as baked.
  const index = new RoadIndex(p.roads.filter(isDriveable), () => 0, 32);

  let worstRatio = 0;
  let worstWhere = "";
  let worstProbeRatio = Infinity;
  let worstSurface = 0;
  let worstBridge = 0;
  let minRoute = Infinity;
  let drives = 0;

  for (let r = 0; r < STARTS[id].length; r++) {
    const [name, lat, lon, hdg] = STARTS[id][r];
    const w = origin.toWorld(lat, lon);
    const samples = drive(g, new THREE.Vector3(w.x, 0, w.z), hdg, r);
    if (!samples) continue;
    drives++;

    let route = 0;
    for (let i = 1; i < samples.length; i++) {
      route += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
    }
    minRoute = Math.min(minRoute, route);

    const good = worstCentrelineRatio(index, samples, 0);
    if (good.ratio > worstRatio) {
      worstRatio = good.ratio;
      worstWhere = name;
    }
    const poisoned = worstCentrelineRatio(index, samples, PROBE_DISPLACE_M);
    worstProbeRatio = Math.min(worstProbeRatio, poisoned.ratio);

    for (const s of samples) {
      const ground = RAMP(s.x, s.z);
      if (s.bridge) {
        worstBridge = Math.max(worstBridge, s.y - ground);
      } else {
        worstSurface = Math.max(worstSurface, Math.abs(s.y - ground - ROAD_LIFT_M));
      }
    }
  }

  check(
    `${id}: ${drives} routes stay within half a carriageway`,
    drives === STARTS[id].length && worstRatio <= MAX_CENTRELINE_RATIO,
    `worst ${worstRatio.toFixed(3)} half-widths on ${worstWhere}, limit ${MAX_CENTRELINE_RATIO}`,
  );
  probe(
    `${id}: samples pushed ${PROBE_DISPLACE_M} m off the road are rejected`,
    worstProbeRatio <= MAX_CENTRELINE_RATIO,
    `worst route's displaced ratio ${worstProbeRatio.toFixed(3)}`,
  );

  check(
    `${id}: routes are long enough to have taken junctions`,
    minRoute >= MIN_ROUTE_M,
    `shortest route ${minRoute.toFixed(0)} m in ${DRIVE_S} s`,
  );

  check(
    `${id}: the car sits on the carriageway, never in it`,
    worstSurface <= MAX_SURFACE_ERROR_M && worstBridge <= MAX_BRIDGE_CLEARANCE_M,
    `worst road ${worstSurface.toFixed(4)} m from heightAt + ${ROAD_LIFT_M}, ` +
    `worst deck ${worstBridge.toFixed(2)} m over the terrain`,
  );
}

// The surface probe gets its own block: the checker is re-run against a car
// whose height was taken from a flat world, which is what a car that never
// asked the height field would produce.
{
  const p = await pack("sf");
  const g = buildRoadGraph(p.roads);
  const origin = new Origin(p.lat0, p.lon0);
  const [, lat, lon, hdg] = STARTS.sf[0];
  const w = origin.toWorld(lat, lon);

  const car = new Car(g);
  car.enterFrom(new THREE.Vector3(w.x, 0, w.z), hdg, new THREE.Vector3(), () => 0);
  let worstFlat = 0;
  const steps = Math.round(DRIVE_S / DRIVE_DT);
  for (let i = 0; i < steps; i++) {
    car.update(plan(i * DRIVE_DT, 0), DRIVE_DT, () => 0);
    if (i % SAMPLE_EVERY !== 0) continue;
    const e = car.edge!;
    if ((e.flags & ROAD_BRIDGE) !== 0) continue;
    worstFlat = Math.max(
      worstFlat,
      Math.abs(car.position.y - RAMP(car.position.x, car.position.z) - ROAD_LIFT_M),
    );
  }
  probe(
    "sf: a car driven over a flat world fails the ramp",
    worstFlat <= MAX_SURFACE_ERROR_M,
    `worst ${worstFlat.toFixed(2)} m against a ${MAX_SURFACE_ERROR_M} m limit`,
  );
}

// --- 8. determinism -----------------------------------------------------------

console.log("\n--- the same route and inputs give the same positions ---");

{
  const p = await pack("sf");
  const g = buildRoadGraph(p.roads);
  const origin = new Origin(p.lat0, p.lon0);
  const [, lat, lon, hdg] = STARTS.sf[0];
  const w = origin.toWorld(lat, lon);
  const start = new THREE.Vector3(w.x, 0, w.z);

  const a = drive(g, start, hdg, 0)!;
  const b = drive(g, start, hdg, 0)!;
  let same = true;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i].x - b[i].x) + Math.abs(a[i].y - b[i].y) + Math.abs(a[i].z - b[i].z);
    if (d !== 0) same = false;
    worst = Math.max(worst, d);
  }
  check(
    "two runs of the same route are identical",
    same && a.length === b.length && a.length > 100,
    `${a.length} samples, worst difference ${worst}`,
  );

  // TWO probes, because the assertion has two ways of being vacuous: the
  // comparator could be blind to any difference, or it could be comparing with
  // a tolerance that hides a real drift.
  //
  // Note what is NOT used here: a one-frame input nudge. Tried, and it changes
  // nothing, legitimately. The steering is rate-limited and the lateral offset
  // is clamped at the kerb, so one frame of opposite lock while the car is
  // already against the kerb produces the same position; and while the car is
  // still accelerating the throttle is a rate, not a level, so one frame of a
  // smaller axis still accelerates at ACCEL. A probe built on that would have
  // been testing the model's saturation, not the checker.
  const other = drive(g, start, hdg, 3)!;
  let otherSame = true;
  for (let i = 0; i < Math.min(a.length, other.length); i++) {
    if (a[i].x !== other[i].x || a[i].z !== other[i].z) { otherSame = false; break; }
  }
  probe(
    "a different steering plan gives a different drive",
    otherSame,
    otherSame ? "identical, which is wrong" : "diverges, as it must",
  );

  const tampered = a.map((p, i) => (i === 300 ? { ...p, x: p.x + 1e-9 } : p));
  let tamperedSame = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== tampered[i].x || a[i].z !== tampered[i].z) { tamperedSame = false; break; }
  }
  probe(
    "one sample moved by a nanometre is caught",
    tamperedSame,
    tamperedSame ? "1e-9 slipped through" : "1e-9 detected, so the compare is exact",
  );
}

// --- 9. leaving the graph gracefully ------------------------------------------

console.log("\n--- a car with nowhere to go stops rather than falls through ---");

{
  // A graph with a single dead-end edge and nothing else: the car reaches the
  // end, has no legal exit, and must stop ON the road.
  const stub: Road = {
    cls: RoadClass.Residential,
    lanes: 2,
    flags: ROAD_ONEWAY,
    layer: 0,
    surface: 0,
    cx: 0,
    cz: 0,
    pts: new Float32Array([0, 0, 0, -80]),
  };
  const g = buildRoadGraph([stub]);
  const car = new Car(g);
  const entered = car.enterFrom(new THREE.Vector3(0, 0, 0), 0, new THREE.Vector3(), RAMP);
  for (let i = 0; i < 60 * 30; i++) {
    car.update({ throttle: 1, steer: 0, boost: 1, lookYawDeg: 0, lookPitchDeg: 0 }, DRIVE_DT, RAMP);
  }
  const ground = RAMP(car.position.x, car.position.z);
  check(
    "a dead end stops the car on the road surface",
    entered && car.stalled && car.speed === 0 &&
      Math.abs(car.position.y - ground - ROAD_LIFT_M) <= MAX_SURFACE_ERROR_M &&
      Math.abs(car.position.z + 80) < 1e-3,
    `stalled ${car.stalled}, speed ${car.speed}, at z ${car.position.z.toFixed(3)}, ` +
    `y ${(car.position.y - ground).toFixed(3)} over the terrain`,
  );

  // Reverse gets it out again.
  for (let i = 0; i < 60 * 5; i++) {
    car.update({ throttle: -1, steer: 0, boost: 0, lookYawDeg: 0, lookPitchDeg: 0 }, DRIVE_DT, RAMP);
  }
  check(
    "reverse backs out of the dead end",
    car.position.z > -80 + 1 && !car.stalled,
    `backed up to z ${car.position.z.toFixed(1)}`,
  );

  // And a city with no roads at all has no car to get into.
  const empty = new Car(buildRoadGraph([]));
  const got = empty.enterFrom(new THREE.Vector3(0, 100, 0), 0, new THREE.Vector3(), RAMP);
  check(
    "a city with no driveable road refuses to seat a driver",
    !got && !empty.hasRoads,
    `enterFrom returned ${got}`,
  );
  probe(
    "the same call on a real graph succeeds",
    !new Car(buildRoadGraph([stub])).enterFrom(new THREE.Vector3(0, 0, 0), 0, new THREE.Vector3(), RAMP),
    "a graph with one road seats the driver",
  );
}

// --- 10. momentum carries in ---------------------------------------------------

console.log("\n--- entering the car carries the aeroplane's momentum ---");

{
  const p = await pack("sf");
  const g = buildRoadGraph(p.roads);
  const origin = new Origin(p.lat0, p.lon0);
  const [, lat, lon, hdg] = STARTS.sf[0];
  const w = origin.toWorld(lat, lon);
  const rad = (hdg * Math.PI) / 180;
  const fast = new THREE.Vector3(Math.sin(rad) * 46, 0, -Math.cos(rad) * 46);

  const moving = new Car(g);
  moving.enterFrom(new THREE.Vector3(w.x, 0, w.z), hdg, fast, RAMP);
  const still = new Car(g);
  still.enterFrom(new THREE.Vector3(w.x, 0, w.z), hdg, new THREE.Vector3(), RAMP);

  check(
    "arriving at speed rolls, arriving stopped does not",
    moving.speed > 5 && moving.speed <= CAR_TOP_SPEED && still.speed === 0,
    `${moving.speed.toFixed(1)} m/s inherited of 46, capped at ${CAR_TOP_SPEED}`,
  );
  probe(
    "a velocity across the road contributes nothing",
    (() => {
      const across = new Car(g);
      across.enterFrom(
        new THREE.Vector3(w.x, 0, w.z),
        hdg,
        new THREE.Vector3(Math.cos(rad) * 46, 0, Math.sin(rad) * 46),
        RAMP,
      );
      return across.speed > 5;
    })(),
    "a sideways 46 m/s must not become road speed",
  );
}

console.log(failures === 0 ? "\nall car checks ok" : `\n${failures} car check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
