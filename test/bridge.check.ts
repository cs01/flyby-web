// The gate on bridge decks: data/bridgedeck.ts, and the two things that drive
// on what it produces.
//
// WHAT A SCREENSHOT CANNOT SETTLE, and this one shipped in front of a user. A
// frame shows a bridge. It does not show that the deck meets the road at the
// same height the road is at, and a 6 m cliff at an abutment is invisible in a
// still and unmissable the moment you drive over it. It does not show that the
// surface being drawn is the surface being driven, because you only find that
// out by falling through one. And it does not show a deck sagging onto the
// seabed, because from the air a bridge low over water still looks like a
// bridge.
//
// THE NUMBERS THIS WAS BUILT AGAINST, over public/cities/sf.roads:
//
//   * 175 of San Francisco's 280 bridge junctions had a height step over
//     0.25 m, the worst of them 11.00 m, because a bridge got a fixed extra
//     lift (3.85 m, or 6.35 m on layer 1) and the road it joined did not;
//   * the Golden Gate deck is 46 ways and 25 graph edges, each interpolated
//     between the ground at its OWN two ends, so it lay in kinked pieces a few
//     metres over the strait;
//   * render/roads.ts interpolated per pack WAY and sim/car.ts per graph EDGE,
//     and the graph cuts a way at every junction it passes through, so the two
//     were not the same surface at all.
//
// GATE DISCIPLINE, as in test/car.check.ts. Every bound is a LITERAL. Every
// assertion is followed by a VACUITY PROBE running the OLD rule, which must
// fail it -- so a checker that has stopped looking reports red.

import { readFileSync } from "node:fs";
import {
  ROAD_BRIDGE,
  parseRoadPack,
  roadLiftM,
  type RoadPack,
} from "../src/data/roadpack";
import { buildRoadGraph, isDriveable, type RoadEdge } from "../src/data/roadgraph";
import { ORPHAN_EDGE_MARGIN_M, buildBridgeDecks, deckYAt } from "../src/data/bridgedeck";
import { Origin } from "../src/geo";
import { addTraffic, type StreetWorld, type TrafficInstance } from "../src/data/streetfurniture";

declare const process: { exit(code?: number): never };

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(46)} ${detail}`);
  if (!ok) failures++;
}

function load(id: string): RoadPack {
  const b = readFileSync(`public/cities/${id}.roads`);
  return parseRoadPack(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

const pack = load("sf");
const origin = new Origin(pack.lat0, pack.lon0);
const gg = origin.toWorld(37.8199, -122.4783);

/**
 * A terrain with the relief that exposes the defect: water across the strait,
 * headlands rising away from it.
 *
 * NOT the DEM. The DEM needs a network fetch and this has to run in CI, and
 * more to the point the assertion is not about San Francisco's real heights --
 * it is that a deck is decided by its abutments and not by what is underneath.
 * A synthetic ground with a hole in it says that far more sharply than real
 * bathymetry, because the hole is where the answer must NOT go.
 */
const WATER_R = 900;
const ground = (x: number, z: number): number => {
  const d = Math.hypot(x - gg.x, z - gg.z);
  const base = d < WATER_R ? 0 : Math.min(80, (d - WATER_R) * 0.06);
  // NOT LINEAR, and that is required rather than decorative. Interpolating
  // between a WAY's two ends and interpolating between an EDGE's two ends give
  // the same answer whenever the ground between them is a straight line, so a
  // smooth ramp hides the very disagreement this file is here to catch: a first
  // version of it used one and measured the old pair as agreeing to 0.00 m.
  // Real terrain rolls, so this rolls, on a wavelength shorter than a bridge.
  return base + 6 * Math.sin(x / 140) * Math.cos(z / 190);
};

const decks = buildBridgeDecks(pack.roads, ground, pack.radiusM);
const graph = buildRoadGraph(pack.roads);

console.log(
  `     ${decks.stats.bridgeWays} bridge ways in ${decks.stats.chains} chains, ` +
  `${decks.stats.abutments} abutments, ${decks.stats.orphanChains} orphan ` +
  `(${decks.stats.orphanChainsLifted} lifted, ${decks.stats.orphanChainsDraped} draped), ` +
  `longest chain ${decks.stats.longestChainM.toFixed(0)} m, ${decks.stats.buildMs} ms`,
);

check(
  "there are bridges in the pack to check at all",
  decks.stats.bridgeWays > 100 && decks.stats.chains > 10,
  `${decks.stats.bridgeWays} ways, ${decks.stats.chains} chains`,
);

// ---------------------------------------------------------------------------
// Height of an edge AT a node, which is the only comparison that means
// anything: a junction is one point, and every edge on it has to agree there.
// ---------------------------------------------------------------------------

/** The rule that shipped: a fixed lift over the ground, per edge. */
function oldY(e: RoadEdge, node: number): number {
  const atA = e.a === node;
  const x = atA ? e.pts[0] : e.pts[e.pts.length - 2];
  const z = atA ? e.pts[1] : e.pts[e.pts.length - 1];
  if ((e.flags & ROAD_BRIDGE) === 0) return ground(x, z) + roadLiftM(e.flags, e.layer);
  const y0 = ground(e.pts[0], e.pts[1]);
  const y1 = ground(e.pts[e.pts.length - 2], e.pts[e.pts.length - 1]);
  return (atA ? y0 : y1) + roadLiftM(e.flags, e.layer);
}

/** What sim/car.ts now does: the solved deck, at this point's arc length along
 *  its parent way. */
function newY(e: RoadEdge, node: number): number {
  const atA = e.a === node;
  const x = atA ? e.pts[0] : e.pts[e.pts.length - 2];
  const z = atA ? e.pts[1] : e.pts[e.pts.length - 1];
  if ((e.flags & ROAD_BRIDGE) === 0) return ground(x, z) + roadLiftM(e.flags, e.layer);
  const d = decks.deck[e.wayIndex];
  if (!d) return ground(x, z) + roadLiftM(e.flags, e.layer);
  return deckYAt(d, e.startS + (atA ? 0 : e.lengthM));
}

function stepsAt(y: (e: RoadEdge, n: number) => number): { steps: number; joins: number; worst: number } {
  let steps = 0;
  let joins = 0;
  let worst = 0;
  for (let n = 0; n < graph.nodeCount; n++) {
    const inc = new Set<number>();
    for (const h of graph.out[n]) inc.add(h.edge);
    for (const h of graph.into[n]) inc.add(h.edge);
    if (inc.size < 2) continue;
    let anyBridge = false;
    for (const ei of inc) if ((graph.edges[ei].flags & ROAD_BRIDGE) !== 0) anyBridge = true;
    if (!anyBridge) continue;
    joins++;
    const hs = [...inc].map((ei) => y(graph.edges[ei], n));
    const d = Math.max(...hs) - Math.min(...hs);
    if (d > 0.25) steps++;
    if (d > worst) worst = d;
  }
  return { steps, joins, worst };
}

{
  const now = stepsAt(newY);
  const then = stepsAt(oldY);
  check(
    "no bridge junction is a step",
    now.steps === 0 && now.worst < 0.10,
    `${now.steps} of ${now.joins} step over 0.25 m, worst ${now.worst.toFixed(2)} m`,
  );
  probe(
    "abutment step",
    then.steps === 0 && then.worst < 0.10,
    `the fixed-lift rule steps at ${then.steps} of ${then.joins}, worst ${then.worst.toFixed(2)} m`,
  );
}

// ---------------------------------------------------------------------------
// The ribbon and the car evaluate the SAME surface.
//
// render/roads.ts walks the pack WAY and uses arc length along it. sim/car.ts
// walks a graph EDGE and uses `startS + s` over `wayLengthM`. Those are only
// the same number if the graph carried the arc length correctly, and if it did
// not, the two surfaces differ by however far the cut moved -- which is exactly
// the bug that made the Golden Gate undrivable.
// ---------------------------------------------------------------------------

{
  let worst = 0;
  let compared = 0;
  for (const e of graph.edges) {
    if ((e.flags & ROAD_BRIDGE) === 0) continue;
    const way = pack.roads[e.wayIndex];
    if (!way) continue;
    const d = decks.deck[e.wayIndex];
    if (!d) continue;
    // Walk the edge's own vertices, find each one's arc length along the WAY by
    // measuring the way itself, and compare the two evaluations.
    let sEdge = 0;
    for (let v = 0; v < e.pts.length / 2; v++) {
      if (v > 0) {
        sEdge += Math.hypot(e.pts[v * 2] - e.pts[(v - 1) * 2], e.pts[v * 2 + 1] - e.pts[(v - 1) * 2 + 1]);
      }
      // The ribbon's parameter: arc length of this same point along the way.
      let sWay = 0;
      let found = -1;
      for (let k = 0; k < way.pts.length / 2; k++) {
        if (k > 0) {
          sWay += Math.hypot(way.pts[k * 2] - way.pts[(k - 1) * 2], way.pts[k * 2 + 1] - way.pts[(k - 1) * 2 + 1]);
        }
        if (Math.hypot(way.pts[k * 2] - e.pts[v * 2], way.pts[k * 2 + 1] - e.pts[v * 2 + 1]) < 0.05) {
          found = sWay;
          break;
        }
      }
      if (found < 0) continue;
      const ribbon = deckYAt(d, found);
      const car = deckYAt(d, e.startS + sEdge);
      compared++;
      if (Math.abs(ribbon - car) > worst) worst = Math.abs(ribbon - car);
    }
  }
  check(
    "the drawn deck and the driven deck are the same surface",
    compared > 200 && worst < 0.02,
    `worst ${worst.toFixed(4)} m over ${compared} vertices`,
  );
  // THE OLD PAIR, which is the defect this whole file exists for. The ribbon
  // interpolated between the ground at the WAY's two ends; the car interpolated
  // between the ground at the EDGE's two ends; and the graph cuts a way at
  // every junction it passes through. Wherever a bridge way was cut, the two
  // read a different height for the same point, and a car drives through a
  // deck it can see.
  {
    let worstOld = 0;
    let comparedOld = 0;
    for (const e of graph.edges) {
      if ((e.flags & ROAD_BRIDGE) === 0) continue;
      const way = pack.roads[e.wayIndex];
      if (!way) continue;
      const lift = roadLiftM(e.flags, e.layer);
      const wy0 = ground(way.pts[0], way.pts[1]);
      const wy1 = ground(way.pts[way.pts.length - 2], way.pts[way.pts.length - 1]);
      const wLen = Math.max(1e-3, wayLength(way.pts));
      const ey0 = ground(e.pts[0], e.pts[1]);
      const ey1 = ground(e.pts[e.pts.length - 2], e.pts[e.pts.length - 1]);
      let sEdge = 0;
      for (let v = 0; v < e.pts.length / 2; v++) {
        if (v > 0) {
          sEdge += Math.hypot(e.pts[v * 2] - e.pts[(v - 1) * 2], e.pts[v * 2 + 1] - e.pts[(v - 1) * 2 + 1]);
        }
        const ribbon = wy0 + (wy1 - wy0) * ((e.startS + sEdge) / wLen) + lift;
        const car = ey0 + (ey1 - ey0) * (sEdge / Math.max(1e-3, e.lengthM)) + lift;
        comparedOld++;
        if (Math.abs(ribbon - car) > worstOld) worstOld = Math.abs(ribbon - car);
      }
    }
    probe(
      "same surface",
      worstOld < 0.02,
      `the old pair disagreed by up to ${worstOld.toFixed(2)} m over ${comparedOld} vertices`,
    );
  }
}

// ---------------------------------------------------------------------------
// A bridge is not faded out before you can see across it.
//
// THE ONE THE USER FOUND. Road ribbons fade with distance and discard when the
// fade reaches nil, which is invisible on a street: the satellite drape below
// still shows a road, so what fades is the detail and not the road. A bridge
// deck has nothing behind it but open water. At the street range of 400 to
// 800 m the Golden Gate -- 2.7 km of it -- was two towers standing in an empty
// strait from every distance far enough away to see the whole span.
//
// The bound is DERIVED from the packs rather than written down: whatever the
// longest bridge way in the repo is, you have to be able to stand back far
// enough to see all of it, and that is at least its own length again.
// ---------------------------------------------------------------------------

{
  const src = readFileSync("src/render/roads.ts", "utf8");
  const m = /const float BRIDGE_FADE_NEAR = ([\d.]+);/.exec(src);
  check(
    "the bridge fade is where this gate can read it",
    m !== null,
    m ? `BRIDGE_FADE_NEAR = ${m[1]}` : "PATTERN NOT FOUND in roads.ts",
  );
  const near = m ? Number(m[1]) : NaN;

  let longest = 0;
  for (const id of ["sf", "manhattan", "chicago", "emeraldhills"]) {
    for (const r of load(id).roads) {
      if ((r.flags & ROAD_BRIDGE) === 0) continue;
      const len = wayLength(r.pts);
      if (len > longest) longest = len;
    }
  }
  check(
    "a bridge stays drawn from far enough away to see all of it",
    near >= 2 * longest,
    `fade starts at ${near.toFixed(0)} m, longest bridge way ${longest.toFixed(0)} m`,
  );
  // The street fade, which is what this used to be.
  {
    const street = /uFadeNear: \{ value: (\d+) \}/.exec(src);
    const sv = street ? Number(street[1]) : 400;
    probe("bridge fade", sv >= 2 * longest, `the street fade of ${sv} m does not`);
  }
}

// ---------------------------------------------------------------------------
// An orphan chain in the MIDDLE of the city is a tagging artifact, not a
// bridge.
//
// WHY CHICAGO AND WHY A FLAT GROUND. sf was the only pack this file loaded, and
// that is how this shipped. A chain with no abutment kept the old fixed lift on
// the grounds that an orphan is a crossing clipped at the pack radius, where
// draping it would put the deck in the water. Over chicago.roads that excuse
// covers almost none of them: nine DRIVEABLE ways sat at 3.85 m, the nearest
// 199 m from the pack centre, in the middle of the Loop. They are 2 to 4 vertex
// stubs whose approaches are themselves tagged bridge=yes, so no ordinary road
// touches the chain -- and the car sim spawned cars on them and drove them one
// storey above the street.
//
// The ground here is FLAT, so every height reported below is pure lift and the
// assertion is about the rule rather than about Illinois.
// ---------------------------------------------------------------------------

{
  const chi = load("chicago");
  const flat = (): number => 0;
  const now = buildBridgeDecks(chi.roads, flat, chi.radiusM);
  const then = buildBridgeDecks(chi.roads, flat); // no extent: the old rule
  const s = now.stats;
  console.log(
    `     chicago: ${s.bridgeWays} bridge ways in ${s.chains} chains, ` +
    `${s.abutments} abutments, ${s.orphanChains} orphan ` +
    `(${s.orphanChainsLifted} lifted, ${s.orphanChainsDraped} draped), ` +
    `longest chain ${s.longestChainM.toFixed(0)} m, ${s.buildMs} ms`,
  );

  /**
   * Driveable bridge ways lying wholly inside the pack that float above `bound`.
   *
   * INTERIOR is the whole point: a chain that reaches the pack's edge may have
   * had its approaches cut off, and lifting that one is right. The margin is the
   * solver's own, so the gate and the rule cannot drift apart about where the
   * edge of the world is.
   */
  function floaters(decks: ReturnType<typeof buildBridgeDecks>, bound: number): { ways: number[]; worst: number } {
    const ways: number[] = [];
    let worst = 0;
    for (let i = 0; i < chi.roads.length; i++) {
      const r = chi.roads[i];
      const d = decks.deck[i];
      if (!d || !isDriveable(r)) continue;
      let interior = true;
      for (let v = 0; v < r.pts.length; v += 2) {
        if (Math.hypot(r.pts[v], r.pts[v + 1]) > chi.radiusM - ORPHAN_EDGE_MARGIN_M) { interior = false; break; }
      }
      if (!interior) continue;
      let hi = 0;
      for (let k = 0; k < d.y.length; k++) if (d.y[k] > hi) hi = d.y[k];
      if (hi > worst) worst = hi;
      if (hi > bound) ways.push(i);
    }
    return { ways, worst };
  }

  // 0.5 m, against a ROAD_LIFT_M of 0.35: an interior deck under flat ground is
  // pinned to abutments that are all at 0.35, so it is at 0.35 everywhere, and
  // anything materially over that is a fixed lift nobody reconciled.
  const BOUND_M = 0.5;
  const f = floaters(now, BOUND_M);
  check(
    "no interior chicago deck floats over the street",
    f.ways.length === 0,
    `${f.ways.length} driveable ways over ${BOUND_M} m, worst ${f.worst.toFixed(2)} m`,
  );
  const fOld = floaters(then, BOUND_M);
  probe(
    "interior orphan lift",
    fOld.ways.length === 0,
    `the old orphan rule floats ${fOld.ways.length} driveable ways, worst ${fOld.worst.toFixed(2)} m`,
  );

  check(
    "chicago's orphan chains are mostly interior artifacts, not clipped spans",
    s.orphanChains > 50 && s.orphanChainsDraped > s.orphanChainsLifted,
    `${s.orphanChainsDraped} draped vs ${s.orphanChainsLifted} lifted of ${s.orphanChains}`,
  );
  probe(
    "orphan split",
    then.stats.orphanChains > 50 && then.stats.orphanChainsDraped > then.stats.orphanChainsLifted,
    `the old rule lifted all ${then.stats.orphanChains} of them`,
  );
}

// ---------------------------------------------------------------------------
// A car on a bridge drives ON the deck.
//
// THE ONE THE OWNER FOUND, over the Bay Bridge: "the cars are not actually on
// the road, they're above". data/streetfurniture.ts placed traffic at
// groundY + roadLiftM long after the ribbon had moved to the solved deck, so
// the two disagreed by however far the deck was from terrain-plus-a-constant.
// Over the real DEM that was 7184 of 7422 car samples more than 0.3 m off, the
// worst 65 m: the west span is one 3.2 km way with three vertices, its run ends
// were at YBI hill height and at SoMa street height, and every car between was
// a straight line through the air above a deck it never touched.
//
// Measured where the CAR is, not where the run ends are: each car's straight
// line is sampled along its length and compared with the deck at that point's
// arc length along its way, so a run that cuts the corner of a bent deck fails
// here too and not only a run with wrong ends.
// ---------------------------------------------------------------------------

/** Arc length along the polyline of the point on it nearest (x, z). */
function arcAt(pts: Float32Array, x: number, z: number): number {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let k = 2; k < pts.length; k += 2) {
    const ax = pts[k - 2], az = pts[k - 1], bx = pts[k], bz = pts[k + 1];
    const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const l = Math.sqrt(l2);
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / l2)) : 0;
    const d = Math.hypot(ax + t * (bx - ax) - x, az + t * (bz - az) - z);
    if (d < best) { best = d; bestS = acc + t * l; }
    acc += l;
  }
  return bestS;
}

function carsOffDeck(
  roads: RoadPack["roads"],
  decksOf: ReturnType<typeof buildBridgeDecks>,
  world: StreetWorld,
  boundM: number,
): { samples: number; over: number; worst: number } {
  let samples = 0;
  let over = 0;
  let worst = 0;
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if ((r.flags & ROAD_BRIDGE) === 0) continue;
    const d = decksOf.deck[i];
    if (!d) continue;
    const cars: TrafficInstance[] = [];
    addTraffic(cars, r, i, world);
    for (const c of cars) {
      for (const q of [0, 0.25, 0.5, 0.75, 1]) {
        const x = c.x0 + (c.x1 - c.x0) * q;
        const z = c.z0 + (c.z1 - c.z0) * q;
        const y = c.y0 + (c.y1 - c.y0) * q;
        const e = Math.abs(y - deckYAt(d, arcAt(r.pts, x, z)));
        samples++;
        if (e > boundM) over++;
        if (e > worst) worst = e;
      }
    }
  }
  return { samples, over, worst };
}

{
  const world: StreetWorld = {
    groundY: ground,
    deckOf: (i) => decks.deck[i],
    occupied: null,
    onCarriageway: null,
    nearestMeasuredLamp: null,
  };
  // 0.3 m: a road wheel is 0.33 m in radius, so this is a car visibly sitting
  // in or over the tarmac rather than on it.
  const BOUND_M = 0.3;
  const now = carsOffDeck(pack.roads, decks, world, BOUND_M);
  check(
    "every car on a bridge is on the deck",
    now.samples > 1000 && now.over === 0,
    `${now.over} of ${now.samples} car samples over ${BOUND_M} m off, worst ${now.worst.toFixed(3)} m`,
  );
  // The old placement: terrain plus the fixed bridge lift, no deck at all.
  const then = carsOffDeck(pack.roads, decks, { ...world, deckOf: null }, BOUND_M);
  probe(
    "car off deck",
    then.samples > 1000 && then.over === 0,
    `groundY + roadLiftM puts ${then.over} of ${then.samples} off, worst ${then.worst.toFixed(1)} m`,
  );
}

function wayLength(pts: Float32Array): number {
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return s;
}

// ---------------------------------------------------------------------------

console.log(
  failures === 0
    ? `\nall ${checks} bridge checks ok`
    : `\n${failures} of ${checks} bridge check(s) FAILED`,
);
if (failures > 0) process.exit(1);
