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
import { buildRoadGraph, type RoadEdge } from "../src/data/roadgraph";
import { buildBridgeDecks, deckYAt } from "../src/data/bridgedeck";
import { Origin } from "../src/geo";

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

const decks = buildBridgeDecks(pack.roads, ground);
const graph = buildRoadGraph(pack.roads);

console.log(
  `     ${decks.stats.bridgeWays} bridge ways in ${decks.stats.chains} chains, ` +
  `${decks.stats.abutments} abutments, ${decks.stats.orphanChains} orphan, ` +
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
