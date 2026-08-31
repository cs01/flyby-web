// What street am I on, and what is the next one I cross.
//
// WHY THIS IS A SEPARATE, PURE FILE. Same argument as roadgraph.ts, which it
// sits directly on top of: whether the app names the right street is
// arithmetic over the graph, not a screenshot question, so it gets a gate. No
// THREE, no DOM, no fetch, and test/streetsign.check.ts runs it against the
// committed public/cities/*.roads under Bun.
//
// WHAT MAKES THIS HARDER THAN READING A FIELD. OSM splits a way wherever its
// tags change, so one street is many ways and one way is many graph edges; the
// name is on all of them, which is the easy half. The hard half is the CROSS
// street, because "the next junction" is not the next node. A node exists
// wherever two ways touch, and most of those are the same street continuing:
// a name change on the tags, a bridge starting, a lane count changing. Stopping
// at the first node would announce the street you are already on.
//
// So the walk continues THROUGH any node that carries no other name, and the
// answer is the first node that does. That is also what makes the reported
// distance right: it is the distance to the junction a driver would call a
// junction, not to the next vertex in the data.

import { isDriveable } from "./roadgraph";
import type { HalfEdge, RoadGraph } from "./roadgraph";

export interface StreetSign {
  /** The street being driven. "" when the road carries no name in OSM. */
  street: string;
  /** The next differently-named street crossed ahead, or "". */
  cross: string;
  /** Metres to that crossing. Infinity when there is no cross street in reach. */
  crossM: number;
}

export const NO_SIGN: StreetSign = { street: "", cross: "", crossM: Infinity };

/**
 * How far ahead to look, in metres.
 *
 * A sign that names a crossing half a mile off is not telling a driver
 * anything, and the walk that finds it costs a hop per node. 400 m is about
 * four Manhattan blocks and one long block anywhere else.
 */
export const SIGN_REACH_M = 400;

/** A guard on the walk, not a budget: a cycle of zero-length edges would spin. */
const MAX_HOPS = 24;

/** Unit tangent of an edge at the end a half-edge ARRIVES at or LEAVES from. */
function tangent(g: RoadGraph, h: HalfEdge, leaving: boolean): [number, number] {
  const p = g.edges[h.edge].pts;
  const n = p.length / 2;
  // Travelling forward, the car leaves pts[0] and arrives at pts[n-1].
  let i0: number;
  let i1: number;
  if (h.forward === leaving) {
    i0 = 0;
    i1 = 1;
  } else {
    i0 = n - 1;
    i1 = n - 2;
  }
  if (!h.forward) {
    // Reverse travel walks the vertices the other way, so both ends swap.
    i0 = n - 1 - i0;
    i1 = n - 1 - i1;
  }
  const dx = p[i1 * 2] - p[i0 * 2];
  const dz = p[i1 * 2 + 1] - p[i0 * 2 + 1];
  const len = Math.hypot(dx, dz);
  return len > 1e-6 ? [dx / len, dz / len] : [0, 0];
}

/** Every edge touching a node, direction ignored, each one once. */
function incident(g: RoadGraph, node: number): number[] {
  const seen: number[] = [];
  for (const h of g.out[node]) if (!seen.includes(h.edge)) seen.push(h.edge);
  for (const h of g.into[node]) if (!seen.includes(h.edge)) seen.push(h.edge);
  return seen;
}

/**
 * The sign for a car at `s` metres along `half`.
 *
 * `reachM` is measured from the CAR and not from the next node, so a sign does
 * not appear and vanish as the car crosses an interior vertex of its own
 * street.
 */
export function streetSign(
  g: RoadGraph,
  half: HalfEdge,
  s: number,
  reachM: number = SIGN_REACH_M,
): StreetSign {
  if (half.edge < 0 || half.edge >= g.edges.length) return NO_SIGN;
  const street = g.edges[half.edge].name;

  let h = half;
  let dist = Math.max(0, g.edges[h.edge].lengthM - s);

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (dist > reachM) break;
    const node = g.head(h);
    const here = incident(g, node);

    // THE MOST MAJOR NAME WINS. A crossroads usually offers both halves of the
    // cross street and, in a city, a named service road or alley as well.
    // Announcing the alley because it came first in the adjacency list is worse
    // than announcing nothing, and the class order in roadpack.ts already ranks
    // a secondary above a service road.
    let best = "";
    let bestCls = Infinity;
    for (const e of here) {
      if (e === h.edge) continue;
      const edge = g.edges[e];
      if (edge.name === "" || edge.name === street) continue;
      if (!isDriveable(edge)) continue;
      if (edge.cls < bestCls) {
        bestCls = edge.cls;
        best = edge.name;
      }
    }
    if (best !== "") return { street, cross: best, crossM: dist };

    // Nothing new here, so this node is the street continuing. Go on through
    // it: STRAIGHTEST first, which is what a driver would do and what keeps the
    // walk on the same road when a side turning shares its name.
    const arrive = tangent(g, h, false);
    let next: HalfEdge | null = null;
    let bestDot = -2;
    for (const cand of g.out[node]) {
      if (cand.edge === h.edge) continue;
      const leave = tangent(g, cand, true);
      const dot = arrive[0] * leave[0] + arrive[1] * leave[1];
      if (dot > bestDot) {
        bestDot = dot;
        next = cand;
      }
    }
    // A dead end, or a turn so sharp it is a U-turn rather than the road going
    // on. Either way there is nothing ahead to name.
    if (next === null || bestDot < 0.0) break;
    h = next;
    dist += g.edges[h.edge].lengthM;
  }

  return { street, cross: "", crossM: Infinity };
}
