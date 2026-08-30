// The gate on near-field ground: src/data/pavement.ts and the ground-storey
// half of src/render/facade.ts.
//
// A pavement is easy to get subtly wrong in ways that still produce a
// perfectly renderable buffer, and there are exactly five ways that matter:
//
//   * the kerb height drifts. At 50 mm the step is invisible from a car and at
//     300 mm it is a wall. Asserted against a literal band, and the constant
//     itself is asserted against the same band.
//   * the pavement overlaps the carriageway. Get the mitre or the half width
//     wrong and the concrete is laid over the nearside lane. Asserted as a
//     hard bound on the perpendicular distance from every vertex to its own
//     centreline.
//   * the pavement sinks below the road it borders. It is drawn without depth
//     write, so this does not z-fight, it silently disappears; that is exactly
//     the failure that cost half a day here, from a different cause.
//   * the junction suppression stops working, and a 135 mm slab is laid across
//     every crossroads in the city.
//   * the ground storey lands somewhere a person could not walk into, or stops
//     varying by what the building is.
//
// WATCHED TO FAIL. Seventeen mutations were applied to the subjects of these
// assertions -- the kerb height, the mitre, the offset, the junction test, the
// building-line query, the ground-storey rule, the module's own bounds, the
// station pitch, the ring radius and the budget -- each seen red and each
// restored green. Two of them went red only AFTER this file was changed: a
// clamped mitre was invisible until the hairpin case below was added (no way
// within 1200 m of the San Francisco origin bends sharply enough to reach that
// branch), and an unclamped mitre spike was invisible until the reach
// assertion was re-framed to measure from the vertex's own centreline point
// rather than from the origin.
//
// Every assertion also carries a VACUITY PROBE: a case it must reject, so an
// assertion that has stopped looking at anything cannot report "0 bad" for
// ever. Each probe is itself BLINDED -- fed the case it must NOT reject -- and
// the blinded form goes red under the mutations above, so the probe cannot be
// vacuous either.

import { readFileSync } from "node:fs";
import {
  addPavement,
  emptyPavement,
  hasPavement,
  pavementWidthM,
  KERB_HEIGHT_M,
  PAVEMENT_CROSSFALL,
  PAVEMENT_MAX_WIDTH_M,
  PAVEMENT_MIN_WIDTH_M,
  PAVEMENT_MITRE_LIMIT,
  PAVEMENT_STATION_M,
  PAVEMENT_RING_M,
  PAVEMENT_TILE_M,
  pavementTriangleCost,
  FACE_KERB,
  PAVEMENT_SIDE_STRIDE,
  type PavementScratch,
  type PavementWorld,
} from "../src/data/pavement";
import {
  parseRoadPack,
  roadWidthM,
  RoadClass,
  ROAD_LIFT_M,
  ROAD_BRIDGE,
  ROAD_TUNNEL,
  type Road,
} from "../src/data/roadpack";
import { RoadIndex } from "../src/data/trees";
import { classifyDevice, type DeviceDescriptor } from "../src/render/budget";
import {
  facadeFor,
  GROUND_STOREY_MAX_M,
  GROUND_STOREY_MIN_M,
} from "../src/render/facade";

// --- literals the whole file is judged against ------------------------------
//
// NONE of these is imported from the code under test. That rule is the point:
// this repo has shipped five gates whose bound was the constant they were
// checking, so raising the constant moved the goalposts with it and the gate
// reported ok at any value at all.

/** A kerb upstand outside this is not a kerb. UK 125 mm, US six inches. */
const KERB_MIN_M = 0.10;
const KERB_MAX_M = 0.16;
/** No pavement vertex may come this close to the centreline of its own road. */
const OVERLAP_EPS_M = 1e-4;
/** Widest and narrowest a footway may ever be. */
const WIDTH_FLOOR_M = 1.0;
const WIDTH_CEIL_M = 8.5;
/** A ground storey a person can walk into, and one that is not a double height hall. */
const GROUND_MIN_M = 2.8;
const GROUND_MAX_M = 6.1;
/** A retail base must be recognisably more glazed than a residential one. */
const SHOPFRONT_KIND_GAP = 0.40;
/**
 * How far a kerb vertex may run from its own centreline point, as a multiple
 * of the half width.
 *
 * A LITERAL, and NOT PAVEMENT_MITRE_LIMIT. The audit that produced this file
 * raised that constant to 1e9 and nothing went red, because the only reach
 * assertion here measured distance from the origin and a spike that runs 80 m
 * sideways off a way that already reaches 140 m is invisible that way. This is
 * the same bound, and the same reasoning, as MAX_REACH_H in ribbon.check.ts.
 */
const MAX_REACH_H = 2.05;

/** A desktop, so the budget under test is the full plan's. Same shape as the
 *  descriptors in test/budget.check.ts. */
const DESKTOP: DeviceDescriptor = {
  deviceMemoryGb: 8,
  hardwareConcurrency: 12,
  coarsePointer: false,
  drawingBufferWidth: 2560,
  drawingBufferHeight: 1440,
  maxTextureSize: 16384,
};

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${detail}`);
}

// --- helpers ----------------------------------------------------------------

/** A straight road along +x through the origin. */
function straight(cls: RoadClass, lengthM: number, lanes = 0): Road {
  const n = Math.max(2, Math.round(lengthM / 20) + 1);
  const pts = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pts[i * 2] = -lengthM / 2 + (lengthM * i) / (n - 1);
    pts[i * 2 + 1] = 0;
  }
  return { cls, lanes, flags: 0, layer: 0, surface: 1, cx: 0, cz: 0, pts };
}

/** A world on a plane, with nothing crossing and no buildings anywhere. */
function flatWorld(overrides: Partial<PavementWorld> = {}): PavementWorld {
  return {
    roadSurfaceY: () => 10 + ROAD_LIFT_M,
    groundY: () => 10,
    onCarriageway: () => false,
    clearanceM: (_x, _z, _dx, _dz, m) => m,
    ...overrides,
  };
}

function distToSegment(
  ax: number, az: number, bx: number, bz: number, x: number, z: number,
): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}

/**
 * The oracle for "does the pavement lap the carriageway", and the one place in
 * this file where the shape of the question had to be argued about.
 *
 * The obvious test -- distance from every vertex to the NEAREST segment of the
 * whole polyline -- is wrong, and measuring it that way is what found out why:
 * five of San Francisco's 618 ways in this ring are car-park aisles that loop
 * back and run alongside themselves, so their own carriageway overlaps their
 * own carriageway and no offset of any width can sit clear of all of it. That
 * is the road's geometry, not the builder's.
 *
 * The invariant that IS the builder's is per segment: a cross-section is
 * generated from one segment (or, at a shared vertex, from the two that meet
 * there) and must sit a full half width off it. A mitre puts the vertex exactly
 * one half width off BOTH; a bevel puts it exactly one half width off its own
 * and may be a hair inside the other, which is why this takes the MAXIMUM over
 * the segments at the station rather than the minimum.
 *
 * The station is located by `u`, which is arc length along the centreline in
 * metres -- so this reads the coordinate the format already carries rather than
 * guessing which segment a vertex came from.
 */
function halfWidthClearance(pts: ArrayLike<number>, u: number, x: number, z: number): number {
  // The builder collapses duplicate points before measuring arc length, so the
  // oracle has to as well or every `u` past a duplicate is off by nothing here
  // and by a segment index everywhere it matters.
  const px: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const last = px.length - 1;
    if (last >= 0 && Math.abs(pts[i] - px[last]) < 1e-4 && Math.abs(pts[i + 1] - pz[last]) < 1e-4) continue;
    px.push(pts[i]);
    pz.push(pts[i + 1]);
  }
  let arc = 0;
  let best = 0;
  for (let i = 0; i + 1 < px.length; i++) {
    const len = Math.hypot(px[i + 1] - px[i], pz[i + 1] - pz[i]);
    // A station exactly on a shared vertex belongs to both segments, so the
    // window is closed at both ends with a millimetre of slack.
    if (u >= arc - 1e-3 && u <= arc + len + 1e-3) {
      best = Math.max(best, distToSegment(px[i], pz[i], px[i + 1], pz[i + 1], x, z));
    }
    arc += len;
  }
  return best;
}

/**
 * The centreline point at arc length `u`, which is the point a cross-section
 * was generated from. Same dedupe as the builder, for the same reason.
 */
function centrelineAt(pts: ArrayLike<number>, u: number): [number, number] {
  const px: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const last = px.length - 1;
    if (last >= 0 && Math.abs(pts[i] - px[last]) < 1e-4 && Math.abs(pts[i + 1] - pz[last]) < 1e-4) continue;
    px.push(pts[i]);
    pz.push(pts[i + 1]);
  }
  let arc = 0;
  for (let i = 0; i + 1 < px.length; i++) {
    const len = Math.hypot(px[i + 1] - px[i], pz[i + 1] - pz[i]);
    if (u <= arc + len || i === px.length - 2) {
      const t = len > 0 ? Math.min(1, Math.max(0, (u - arc) / len)) : 0;
      return [px[i] + (px[i + 1] - px[i]) * t, pz[i] + (pz[i + 1] - pz[i]) * t];
    }
    arc += len;
  }
  return [px[0], pz[0]];
}

interface Vertex {
  x: number; y: number; z: number;
  u: number; t: number;
  kind: number; nx: number; nz: number; w: number;
}

function vertices(s: PavementScratch): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 0; i < s.pos.length / 3; i++) {
    const raw = s.info[i * 4];
    out.push({
      x: s.pos[i * 3], y: s.pos[i * 3 + 1], z: s.pos[i * 3 + 2],
      u: s.uv[i * 2], t: s.uv[i * 2 + 1],
      kind: raw % PAVEMENT_SIDE_STRIDE,
      nx: s.info[i * 4 + 1], nz: s.info[i * 4 + 2], w: s.info[i * 4 + 3],
    });
  }
  return out;
}

// --- 1. the kerb --------------------------------------------------------------

console.log("\n--- kerb ---");
{
  check(
    "the kerb height constant is a kerb height",
    KERB_HEIGHT_M >= KERB_MIN_M && KERB_HEIGHT_M <= KERB_MAX_M,
    `${(KERB_HEIGHT_M * 1000).toFixed(0)} mm in ${KERB_MIN_M * 1000}..${KERB_MAX_M * 1000} mm`,
  );

  // A road on a 6% grade, so "the pavement is level with the road" is a claim
  // about a moving surface rather than about one constant.
  const grade = (x: number): number => 10 + 0.06 * x;
  const world = flatWorld({
    roadSurfaceY: (x) => grade(x) + ROAD_LIFT_M,
    groundY: (x) => grade(x),
  });
  const s = emptyPavement();
  addPavement(s, straight(RoadClass.Residential, 400), world, PAVEMENT_STATION_M);
  const vs = vertices(s);

  // Every kerb-face quad is a vertical pair at the same point, KERB_HEIGHT_M
  // apart, and the top of the kerb IS the front of the pavement.
  let worstRise = 0;
  let worstBelow = Infinity;
  let pairs = 0;
  for (let i = 0; i + 1 < vs.length; i += 4) {
    const bot = vs[i];
    const top = vs[i + 1];
    if (bot.kind !== FACE_KERB || top.kind !== FACE_KERB) continue;
    pairs++;
    worstRise = Math.max(worstRise, Math.abs(top.y - bot.y - KERB_HEIGHT_M));
    // The road surface under this exact kerb point, from the same oracle the
    // renderer feeds the builder.
    worstBelow = Math.min(worstBelow, top.y - world.roadSurfaceY(bot.x, bot.z));
  }
  check(
    "the kerb face is vertical and one kerb tall",
    pairs > 60 && worstRise < 1e-4,
    `${pairs} faces, worst error ${(worstRise * 1000).toFixed(4)} mm`,
  );
  check(
    "the pavement is never below the road it borders",
    worstBelow >= KERB_MIN_M && worstBelow <= KERB_MAX_M,
    `closest approach ${(worstBelow * 1000).toFixed(1)} mm above the channel`,
  );

  // VACUITY PROBE. The two assertions above are "worst over the set"; both
  // report a clean number when the set is EMPTY, which is how a gate reports ok
  // for ever. Feed the same predicates a set that must be rejected.
  const bad = vs.map((v, i) => (i % 4 === 1 ? { ...v, y: v.y - 0.09 } : v));
  let probeWorstBelow = Infinity;
  for (let i = 0; i + 1 < bad.length; i += 4) {
    if (bad[i].kind !== FACE_KERB) continue;
    probeWorstBelow = Math.min(probeWorstBelow, bad[i + 1].y - world.roadSurfaceY(bad[i].x, bad[i].z));
  }
  check(
    "probe: a 90 mm kerb is rejected as not a kerb",
    !(probeWorstBelow >= KERB_MIN_M && probeWorstBelow <= KERB_MAX_M),
    `probe measured ${(probeWorstBelow * 1000).toFixed(1)} mm, outside ${KERB_MIN_M * 1000}..${KERB_MAX_M * 1000}`,
  );
  // BLIND THE PROBE: hand it the untouched vertices, where it must NOT reject.
  // If this comes out the same way as the line above, the probe is measuring
  // nothing and neither is the assertion it guards.
  let blindWorstBelow = Infinity;
  for (let i = 0; i + 1 < vs.length; i += 4) {
    if (vs[i].kind !== FACE_KERB) continue;
    blindWorstBelow = Math.min(blindWorstBelow, vs[i + 1].y - world.roadSurfaceY(vs[i].x, vs[i].z));
  }
  check(
    "probe: blinded, the same predicate accepts the real geometry",
    blindWorstBelow >= KERB_MIN_M && blindWorstBelow <= KERB_MAX_M,
    `blinded probe measured ${(blindWorstBelow * 1000).toFixed(1)} mm`,
  );
}

// --- 2. the pavement never laps the carriageway -------------------------------

console.log("\n--- overlap ---");
{
  // A road with a hard bend, because the mitre at a bend is where an offset
  // builder actually goes wrong.
  const pts = new Float32Array([-120, 0, 0, 0, 70, 60, 70, 200]);
  const road: Road = { cls: RoadClass.Primary, lanes: 4, flags: 0, layer: 0, surface: 1, cx: 0, cz: 0, pts };
  const hw = roadWidthM(road.cls, road.lanes, road.flags) * 0.5;
  const s = emptyPavement();
  addPavement(s, road, flatWorld(), PAVEMENT_STATION_M);
  const vs = vertices(s);

  let closest = Infinity;
  for (const v of vs) closest = Math.min(closest, halfWidthClearance(pts, v.u, v.x, v.z));
  check(
    "no pavement vertex reaches into the carriageway",
    vs.length > 100 && closest >= hw - OVERLAP_EPS_M,
    `${vs.length} vertices, closest ${closest.toFixed(4)} m against a ${hw.toFixed(2)} m half width`,
  );

  // Widths, measured off the emitted geometry rather than trusted from the
  // table: the back vertex of every pavement quad against its own kerb vertex.
  let minW = Infinity;
  let maxW = 0;
  let quads = 0;
  for (let i = 0; i + 3 < vs.length; i += 4) {
    const front = vs[i + 2];
    const back = vs[i + 3];
    const wM = Math.hypot(back.x - front.x, back.z - front.z);
    minW = Math.min(minW, wM);
    maxW = Math.max(maxW, wM);
    quads++;
  }
  check(
    "every pavement is a width a pavement can be",
    quads > 50 && minW >= WIDTH_FLOOR_M && maxW <= WIDTH_CEIL_M,
    `${quads} cross-sections, ${minW.toFixed(2)}..${maxW.toFixed(2)} m in ${WIDTH_FLOOR_M}..${WIDTH_CEIL_M}`,
  );
  check(
    "the width bounds in the module are inside the bounds asserted here",
    PAVEMENT_MIN_WIDTH_M >= WIDTH_FLOOR_M && PAVEMENT_MAX_WIDTH_M <= WIDTH_CEIL_M,
    `module allows ${PAVEMENT_MIN_WIDTH_M}..${PAVEMENT_MAX_WIDTH_M} m`,
  );

  // VACUITY PROBE for the overlap sweep: move every vertex one metre inward and
  // assert the same predicate rejects it.
  let probeClosest = Infinity;
  for (const v of vs) {
    probeClosest = Math.min(probeClosest, halfWidthClearance(pts, v.u, v.x - v.nx * 1.0, v.z - v.nz * 1.0));
  }
  check(
    "probe: a pavement pushed a metre into the road is rejected",
    !(probeClosest >= hw - OVERLAP_EPS_M),
    `probe closest ${probeClosest.toFixed(3)} m against ${hw.toFixed(2)} m`,
  );
  check(
    "probe: blinded, the same sweep accepts the real vertices",
    closest >= hw - OVERLAP_EPS_M && vs.length > 100,
    `blinded probe closest ${closest.toFixed(4)} m over ${vs.length} vertices`,
  );
}

// --- 2b. hairpins -------------------------------------------------------------
//
// Added because the audit found this path UNTESTED. Reverting the bevel in
// data/pavement.ts to a clamped mitre changed nothing anywhere else in this
// file: no way within 1200 m of the San Francisco origin bends sharply enough
// to reach it, so a gate built only on real geometry would have watched that
// code rot for ever. OSM is full of switchbacks, cul-de-sac heads and badly
// digitised kerb lines, and every one of them takes this branch.

console.log("\n--- hairpins ---");
{
  // Out and back with about 175 degrees of turn: the bisector all but collapses
  // and a clamped mitre pulls the kerb most of a half width into the road.
  const pts = new Float32Array([-140, 0, 0, 0, -140, 9]);
  const road: Road = { cls: RoadClass.Tertiary, lanes: 2, flags: 0, layer: 0, surface: 1, cx: 0, cz: 0, pts };
  const hw = roadWidthM(road.cls, road.lanes, road.flags) * 0.5;
  const s = emptyPavement();
  addPavement(s, road, flatWorld(), PAVEMENT_STATION_M);
  const vs = vertices(s);

  let closest = Infinity;
  for (const v of vs) closest = Math.min(closest, halfWidthClearance(pts, v.u, v.x, v.z));
  check(
    "a hairpin does not push the kerb into the carriageway",
    vs.length > 100 && closest >= hw - OVERLAP_EPS_M,
    `${vs.length} vertices round a 175 degree turn, closest ${closest.toFixed(4)} m against ${hw.toFixed(2)} m`,
  );
  // The reach of the outer corner, measured from the centreline point the
  // cross-section came from. An unclamped mitre runs out to h/cos(phi/2),
  // which for this turn is twenty-three half widths.
  let reach = 0;
  for (const v of vs) {
    if (v.t > 0) continue;   // kerb vertices only: t is 0 or negative on the face
    const [cx, cz] = centrelineAt(pts, v.u);
    reach = Math.max(reach, Math.hypot(v.x - cx, v.z - cz) / hw);
  }
  check(
    "the hairpin grows no spike",
    reach <= MAX_REACH_H,
    `furthest kerb vertex ${reach.toFixed(3)} half widths from its own centreline point`,
  );
  check(
    "the mitre limit in the module is inside the reach asserted here",
    PAVEMENT_MITRE_LIMIT <= MAX_REACH_H,
    `module allows ${PAVEMENT_MITRE_LIMIT} half widths`,
  );

  // VACUITY PROBE for the reach: the same measurement on a set pushed outward
  // must be rejected.
  let probeReach = 0;
  for (const v of vs) {
    if (v.t > 0) continue;
    const [cx, cz] = centrelineAt(pts, v.u);
    probeReach = Math.max(probeReach, Math.hypot(v.x + v.nx * hw * 1.5 - cx, v.z + v.nz * hw * 1.5 - cz) / hw);
  }
  check(
    "probe: the reach test rejects a kerb pushed 1.5 half widths out",
    !(probeReach <= MAX_REACH_H),
    `probe reach ${probeReach.toFixed(3)} half widths`,
  );
  check(
    "probe: blinded, the reach test accepts the real kerb",
    reach <= MAX_REACH_H && vs.length > 100,
    `blinded probe reach ${reach.toFixed(3)} half widths`,
  );

  // VACUITY PROBE: the same sweep must reject the same vertices pulled inward.
  let probe = Infinity;
  for (const v of vs) probe = Math.min(probe, halfWidthClearance(pts, v.u, v.x - v.nx * 0.9, v.z - v.nz * 0.9));
  check(
    "probe: the hairpin sweep rejects a kerb pulled 0.9 m inward",
    !(probe >= hw - OVERLAP_EPS_M),
    `probe closest ${probe.toFixed(3)} m against ${hw.toFixed(2)} m`,
  );
  check(
    "probe: blinded, the hairpin sweep accepts the real kerb",
    closest >= hw - OVERLAP_EPS_M && vs.length > 100,
    `blinded probe closest ${closest.toFixed(4)} m over ${vs.length} vertices`,
  );
}

// --- 3. junctions open --------------------------------------------------------

console.log("\n--- junctions ---");
{
  // One road along x, one carriageway crossing it: a 12 m road down the z axis,
  // so everything with |x| <= 6 is tarmac.
  const CROSS_HALF_M = 6;
  const crossed = flatWorld({ onCarriageway: (x) => Math.abs(x) <= CROSS_HALF_M });

  const road = straight(RoadClass.Residential, 400);
  const open = emptyPavement();
  addPavement(open, road, crossed, PAVEMENT_STATION_M);
  const solid = emptyPavement();
  addPavement(solid, road, flatWorld(), PAVEMENT_STATION_M);

  const vs = vertices(open);
  let nearest = Infinity;
  for (const v of vs) nearest = Math.min(nearest, Math.abs(v.x));
  check(
    "no pavement is laid across a crossing carriageway",
    vs.length > 100 && nearest > CROSS_HALF_M - OVERLAP_EPS_M,
    `nearest vertex ${nearest.toFixed(2)} m from the cross centreline, half width ${CROSS_HALF_M} m`,
  );
  check(
    "the junction actually removed geometry",
    open.idx.length < solid.idx.length && open.idx.length > 0,
    `${open.idx.length / 3} triangles with the junction, ${solid.idx.length / 3} without`,
  );

  // VACUITY PROBE: the same sweep over the UNSUPPRESSED build must be rejected,
  // or the sweep is not looking at where the vertices are.
  let probeNearest = Infinity;
  for (const v of vertices(solid)) probeNearest = Math.min(probeNearest, Math.abs(v.x));
  check(
    "probe: the same sweep rejects a pavement built with no junction test",
    !(probeNearest > CROSS_HALF_M - OVERLAP_EPS_M),
    `unsuppressed build reaches ${probeNearest.toFixed(2)} m from the cross centreline`,
  );
  check(
    "probe: blinded, the sweep accepts the suppressed build",
    nearest > CROSS_HALF_M - OVERLAP_EPS_M,
    `blinded probe measured ${nearest.toFixed(2)} m`,
  );
}

// --- 4. the width follows the building line -----------------------------------

console.log("\n--- building line ---");
{
  const road = straight(RoadClass.Residential, 300);
  const classW = pavementWidthM(RoadClass.Residential);

  const wall = 2.6;
  const tight = emptyPavement();
  addPavement(tight, road, flatWorld({ clearanceM: () => wall }), PAVEMENT_STATION_M);
  let worst = 0;
  const tv = vertices(tight);
  for (let i = 0; i + 3 < tv.length; i += 4) {
    worst = Math.max(worst, Math.abs(Math.hypot(tv[i + 3].x - tv[i + 2].x, tv[i + 3].z - tv[i + 2].z) - wall));
  }
  check(
    "a wall close to the kerb pulls the pavement out to meet it",
    tv.length > 50 && worst < 1e-3,
    `${tv.length / 4} cross-sections, worst ${(worst * 1000).toFixed(3)} mm from the ${wall} m wall`,
  );

  const openField = emptyPavement();
  addPavement(openField, road, flatWorld(), PAVEMENT_STATION_M);
  const ov = vertices(openField);
  let worstOpen = 0;
  for (let i = 0; i + 3 < ov.length; i += 4) {
    worstOpen = Math.max(worstOpen, Math.abs(Math.hypot(ov[i + 3].x - ov[i + 2].x, ov[i + 3].z - ov[i + 2].z) - classW));
  }
  check(
    "with nothing to run up to, the class width stands",
    ov.length > 50 && worstOpen < 1e-3 && classW >= 2.0 && classW <= 4.0,
    `class width ${classW.toFixed(2)} m, worst ${(worstOpen * 1000).toFixed(3)} mm`,
  );

  // The open back edge falls to the ground; the closed one stays flat.
  const dipped = emptyPavement();
  addPavement(dipped, road, flatWorld({ groundY: () => 8.0 }), PAVEMENT_STATION_M);
  const dv = vertices(dipped);
  let maxFall = 0;
  for (let i = 0; i + 3 < dv.length; i += 4) maxFall = Math.max(maxFall, dv[i + 2].y - dv[i + 3].y);
  check(
    "an open back edge chases the ground instead of ending in a cliff",
    maxFall > 0.3 && maxFall <= 1.0,
    `back edge drops ${maxFall.toFixed(3)} m toward ground two metres below`,
  );
  let maxFlat = 0;
  for (let i = 0; i + 3 < tv.length; i += 4) maxFlat = Math.max(maxFlat, tv[i + 2].y - tv[i + 3].y);
  check(
    "a pavement that reaches a wall stays flat to it, bar the crossfall",
    maxFlat > 0 && maxFlat < 0.5,
    `${(maxFlat * 1000).toFixed(1)} mm of fall over ${wall} m, crossfall ${PAVEMENT_CROSSFALL}`,
  );

  // VACUITY PROBE: the same measurement against the WRONG expected width must
  // reject, or it is not measuring the geometry.
  let probeWorst = 0;
  for (let i = 0; i + 3 < tv.length; i += 4) {
    probeWorst = Math.max(probeWorst, Math.abs(Math.hypot(tv[i + 3].x - tv[i + 2].x, tv[i + 3].z - tv[i + 2].z) - classW));
  }
  check(
    "probe: the width measurement rejects the class width where a wall decided it",
    !(probeWorst < 1e-3),
    `measured against ${classW.toFixed(2)} m instead of ${wall} m, worst ${probeWorst.toFixed(3)} m`,
  );
  check(
    "probe: blinded, the same measurement accepts the wall width",
    worst < 1e-3 && tv.length > 50,
    `blinded probe worst ${(worst * 1000).toFixed(3)} mm over ${tv.length / 4} cross-sections`,
  );
}

// --- 5. the real packs --------------------------------------------------------
//
// Everything above is synthetic. This runs the same builder over the ways of a
// real city with a real junction index, because the failures that actually
// happen come from OSM geometry (hairpins, duplicate points, ways that double
// back) and not from a straight line.

console.log("\n--- sf.roads ---");
{
  const buf = readFileSync(new URL("../public/cities/sf.roads", import.meta.url));
  const pack = parseRoadPack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const carriageways = pack.roads.filter(
    (r) => r.cls <= RoadClass.Busway && (r.flags & (ROAD_TUNNEL | ROAD_BRIDGE)) === 0,
  );
  const index = new RoadIndex(carriageways, (r) => roadWidthM(r.cls, r.lanes, r.flags) * 0.5);
  const world = flatWorld({
    // A tilted plane, so a bug that silently flattens the surface shows up.
    roadSurfaceY: (x, z) => 40 + 0.01 * x - 0.004 * z + ROAD_LIFT_M,
    groundY: (x, z) => 40 + 0.01 * x - 0.004 * z,
    onCarriageway: (x, z) => index.blocked(x, z),
  });

  let ways = 0;
  let triangles = 0;
  let worstOverlap = 0;
  let worstReach = 0;
  let worstKerb = 0;
  let worstBelow = Infinity;
  let widest = 0;
  let narrowest = Infinity;
  let nonFinite = 0;

  for (const r of pack.roads) {
    if (!hasPavement(r)) continue;
    // The ring the renderer actually keeps resident; see RING_M in
    // render/pavement.ts. Enough ways to be a real sweep, few enough to run in
    // a second.
    if (Math.hypot(r.cx, r.cz) > 1200) continue;
    const s = emptyPavement();
    const tris = addPavement(s, r, world, PAVEMENT_STATION_M);
    if (tris === 0) continue;
    ways++;
    triangles += tris;

    const hw = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
    const vs = vertices(s);
    for (const v of vs) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) nonFinite++;
      worstOverlap = Math.max(worstOverlap, hw - halfWidthClearance(r.pts, v.u, v.x, v.z));
      if (v.t <= 0) {
        const [cx, cz] = centrelineAt(r.pts, v.u);
        worstReach = Math.max(worstReach, Math.hypot(v.x - cx, v.z - cz) / hw);
      }
    }
    for (let i = 0; i + 3 < vs.length; i += 4) {
      if (vs[i].kind !== FACE_KERB) continue;
      worstKerb = Math.max(worstKerb, Math.abs(vs[i + 1].y - vs[i].y - KERB_HEIGHT_M));
      worstBelow = Math.min(worstBelow, vs[i + 1].y - world.roadSurfaceY(vs[i].x, vs[i].z));
      const wM = Math.hypot(vs[i + 3].x - vs[i + 2].x, vs[i + 3].z - vs[i + 2].z);
      widest = Math.max(widest, wM);
      narrowest = Math.min(narrowest, wM);
    }
  }

  check(
    "the sweep had a real city to look at",
    ways > 400 && triangles > 20_000,
    `${ways} ways, ${triangles} triangles within 1200 m of the origin`,
  );
  check(
    "no vertex is anything but finite",
    nonFinite === 0,
    `${nonFinite} non-finite coordinates`,
  );
  check(
    "no real way laps its own carriageway",
    worstOverlap <= OVERLAP_EPS_M,
    `worst intrusion ${(worstOverlap * 1000).toFixed(4)} mm`,
  );
  check(
    "no real way grows a mitre spike",
    worstReach <= MAX_REACH_H,
    `furthest kerb vertex ${worstReach.toFixed(3)} half widths from its own centreline point`,
  );
  check(
    "every real kerb is one kerb tall",
    worstKerb < 1e-3,
    `worst error ${(worstKerb * 1000).toFixed(4)} mm`,
  );
  check(
    "no real pavement sits below its road",
    worstBelow >= KERB_MIN_M && worstBelow <= KERB_MAX_M,
    `closest approach ${(worstBelow * 1000).toFixed(1)} mm`,
  );
  check(
    "no real pavement is an impossible width",
    narrowest >= WIDTH_FLOOR_M && widest <= WIDTH_CEIL_M,
    `${narrowest.toFixed(2)}..${widest.toFixed(2)} m`,
  );

  // VACUITY PROBE: the sweep is a max over a loop, and a loop that never runs
  // reports a perfect zero. Confirm the same predicates reject a deliberately
  // shifted copy of the same geometry.
  let probeOverlap = 0;
  let probeWays = 0;
  for (const r of pack.roads) {
    if (!hasPavement(r)) continue;
    if (Math.hypot(r.cx, r.cz) > 1200) continue;
    const s = emptyPavement();
    if (addPavement(s, r, world, PAVEMENT_STATION_M) === 0) continue;
    probeWays++;
    const hw = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
    for (const v of vertices(s)) {
      probeOverlap = Math.max(probeOverlap, hw - halfWidthClearance(r.pts, v.u, v.x - v.nx * 0.5, v.z - v.nz * 0.5));
    }
  }
  check(
    "probe: the real-pack sweep rejects a pavement moved 0.5 m inward",
    probeWays === ways && probeOverlap > OVERLAP_EPS_M,
    `${probeWays} ways probed, worst intrusion ${probeOverlap.toFixed(3)} m`,
  );
  check(
    "probe: blinded, the same sweep accepts the unmoved pavement",
    worstOverlap <= OVERLAP_EPS_M && ways > 400,
    `blinded probe worst ${(worstOverlap * 1000).toFixed(4)} mm over ${ways} ways`,
  );
}

// --- 5b. the ring fits the budget ---------------------------------------------
//
// render/pavement.ts keeps a ring of tiles round the camera and stops adding
// them when the triangle budget is full. If the ring were routinely over
// budget the outer tiles would silently never be built and the pavement would
// end in a visible arc a few hundred metres out, which is the sort of thing
// that is obvious in motion and invisible in a screenshot.

console.log("\n--- ring budget ---");
{
  const buf = readFileSync(new URL("../public/cities/sf.roads", import.meta.url));
  const pack = parseRoadPack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const budget = classifyDevice(DESKTOP).pavementTriangleBudget;

  // The worst ring anywhere in the city, walked on the same tile lattice the
  // renderer uses, so this is the number the renderer will actually meet.
  let worst = 0;
  let worstAt = "";
  let rings = 0;
  const step = PAVEMENT_TILE_M;
  for (let cz = -pack.radiusM; cz <= pack.radiusM; cz += step) {
    for (let cx = -pack.radiusM; cx <= pack.radiusM; cx += step) {
      let tris = 0;
      for (const r of pack.roads) {
        if (!hasPavement(r)) continue;
        if (Math.hypot(r.cx - cx, r.cz - cz) > PAVEMENT_RING_M) continue;
        tris += pavementTriangleCost(r, PAVEMENT_STATION_M);
      }
      rings++;
      if (tris > worst) { worst = tris; worstAt = `${cx.toFixed(0)},${cz.toFixed(0)}`; }
    }
  }
  check(
    "the ring budget sweep had rings to look at",
    rings > 500 && worst > 10_000,
    `${rings} camera positions swept, worst ring ${worst} triangles at ${worstAt}`,
  );
  check(
    "the densest ring in San Francisco fits the desktop budget",
    worst <= budget,
    `${worst} triangles against a budget of ${budget}`,
  );
  // A literal, so the budget itself cannot be raised to make this pass.
  check(
    "the pavement budget is a near-field budget, not a skyline one",
    budget >= 100_000 && budget <= 400_000,
    `${budget} triangles`,
  );

  // VACUITY PROBE: the sweep is a max over a loop, so it reads zero if the loop
  // never runs. Confirm the same predicate rejects a ring four times as dense.
  check(
    "probe: the budget test rejects a ring four times as dense",
    !(worst * 4 <= budget),
    `${worst * 4} triangles against ${budget}`,
  );
  check(
    "probe: blinded, the budget test accepts the real densest ring",
    worst <= budget && worst > 10_000,
    `blinded probe measured ${worst} triangles`,
  );
}

// --- 6. the ground storey -----------------------------------------------------

console.log("\n--- ground storey ---");
{
  check(
    "the ground storey bounds are heights a ground storey can be",
    GROUND_STOREY_MIN_M >= GROUND_MIN_M && GROUND_STOREY_MAX_M <= GROUND_MAX_M
      && GROUND_STOREY_MIN_M < GROUND_STOREY_MAX_M,
    `module allows ${GROUND_STOREY_MIN_M}..${GROUND_STOREY_MAX_M} m`,
  );

  let sampled = 0;
  let outOfBand = 0;
  let shorterThanUpper = 0;
  let tallerThanBuilding = 0;
  const byKind: number[][] = [[], [], [], [], [], [], []];
  for (let kind = 0; kind <= 6; kind++) {
    for (let seed = 0; seed < 400; seed++) {
      for (const heightM of [4, 9, 15, 24, 45, 90, 180]) {
        const p = facadeFor(kind, heightM, seed * 7919 + kind);
        sampled++;
        if (p.groundStoreyM < GROUND_MIN_M || p.groundStoreyM > GROUND_MAX_M) outOfBand++;
        // A ground floor is never SHORTER than the flat above it.
        if (p.groundStoreyM < p.storeyM) shorterThanUpper++;
        // And the band the shader paints must fit inside a building tall enough
        // to have one; the shader clamps to 92% of the height for the rest.
        if (heightM > 8 && p.groundStoreyM > heightM * 0.92) tallerThanBuilding++;
        byKind[kind].push(p.shopfront);
      }
    }
  }
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  check(
    "the ground storey sweep had something to look at",
    sampled === 7 * 400 * 7,
    `${sampled} buildings sampled across 7 kinds, 7 heights and 400 seeds`,
  );
  check(
    "every ground storey is a height a person can walk into",
    outOfBand === 0,
    `${outOfBand} of ${sampled} outside ${GROUND_MIN_M}..${GROUND_MAX_M} m`,
  );
  check(
    "no ground storey is shorter than the storey above it",
    shorterThanUpper === 0,
    `${shorterThanUpper} of ${sampled} shorter than their own storeyM`,
  );
  check(
    "no ground storey swallows the building it is in",
    tallerThanBuilding === 0,
    `${tallerThanBuilding} of ${sampled} over 92% of a building taller than 8 m`,
  );
  // 4 is Retail and 1 is Residential in the kind table; a shopfront model that
  // does not tell them apart is a shopfront model that is not reading its input.
  const retail = mean(byKind[4]);
  const residential = mean(byKind[1]);
  check(
    "a shop has a shopfront and a house does not",
    retail - residential >= SHOPFRONT_KIND_GAP,
    `retail ${retail.toFixed(3)} against residential ${residential.toFixed(3)}, gap ${(retail - residential).toFixed(3)}`,
  );

  // VACUITY PROBE. The three counters above all report 0 when the loop never
  // runs, and the kind gap reports NaN. Feed the same predicates values that
  // must be rejected.
  const probeBand = [2.0, 7.5, 3.4].filter((v) => v < GROUND_MIN_M || v > GROUND_MAX_M).length;
  check(
    "probe: the band test rejects a 2 m and a 7.5 m ground storey",
    probeBand === 2,
    `${probeBand} of 3 probe values rejected`,
  );
  const probeGap = mean(byKind[1]) - mean(byKind[4]);
  check(
    "probe: the kind gap rejects the comparison run backwards",
    !(probeGap >= SHOPFRONT_KIND_GAP),
    `residential minus retail is ${probeGap.toFixed(3)}, below the ${SHOPFRONT_KIND_GAP} gap`,
  );
  check(
    "probe: blinded, the band test accepts three real ground storeys",
    [
      facadeFor(4, 12, 1).groundStoreyM,
      facadeFor(1, 9, 2).groundStoreyM,
      facadeFor(6, 120, 3).groundStoreyM,
    ].filter((v) => v < GROUND_MIN_M || v > GROUND_MAX_M).length === 0,
    "0 of 3 real ground storeys rejected",
  );
}

console.log(
  failures === 0
    ? `\nall ${checks} pavement checks ok`
    : `\n${failures} of ${checks} pavement check(s) FAILED`,
);
if (failures > 0) process.exit(1);
