// The driveable graph: .roads ways in, a connected network of edges and
// junctions out.
//
// WHY THIS IS A SEPARATE, PURE FILE. Same argument as data/trees.ts. Whether a
// car looks like a car is a screenshot question; whether the street grid it
// drives on is actually connected, whether a one-way is respected, and whether
// a side street joins the avenue it ends on are arithmetic, and arithmetic gets
// gated. So there is no THREE, no DOM and no fetch here, and test/car.check.ts
// runs this against the committed public/cities/*.roads under Bun.
//
// HOW WAYS ARE JOINED, AND WHY IT IS NOT AN EXACT MATCH.
//
// The packs carry no OSM node ids, so the only evidence that two ways meet is
// that they have a vertex in the same place. The obvious plan is to hash the
// quarter-metre grid the format quantises to and match exactly. MEASURED, that
// plan does not work: the format stores each vertex as an i16 offset from a
// PER-WAY f32 centroid (`(minX+maxX)/2` of that way's bounding box, see
// tools/bake-roads.ts), so two ways sharing an OSM node quantise that node
// against two different origins and reconstruct it to two different floats.
// Across San Francisco's 20,496 driveable endpoints, exact equality joins 52 of
// them. The distance between a coincident pair is the sum of two independent
// quarter-metre roundings: median 0.10 m, and 96.3% are inside 0.30 m while
// only 0.04% more arrive by 1.0 m, which is the gap that says 0.30 m is
// separating real coincidences from real neighbours rather than sitting on a
// slope.
//
// So the join is a TOLERANCE join at JOIN_TOLERANCE_M, done through a grid
// whose cell is the tolerance, scanning the 3x3 neighbourhood. That is the
// non-obvious thing that makes this work.
//
// WHAT COUNTS AS A JUNCTION. Endpoints alone are not enough. OSM splits a way
// when its tags change, not when it crosses another street, so an avenue can be
// one way running through several crossroads with the side streets ENDING on
// interior vertices of it. Measured: 5,506 of San Francisco's driveable
// endpoints and 16,999 of Manhattan's land on an interior vertex of a different
// way. So a vertex is a junction when two distinct ways touch it, whether or
// not either of them ends there, and a way is CUT at every junction it passes
// through.
//
// Honest about the size of this: most of those coincidences are ALSO endpoints
// of some third way, so the endpoint-only graph is not a disaster, it is a
// slightly holed one. Measured both ways, San Francisco has 8,720 junctions
// against 8,050 and 3,176 cut ways against 2,775, and its core network falls
// from 99.64% in one component to 98.63% in eight. What that costs in practice
// is specific junctions: with the rule off, the nearest crossroads to
// Divisadero and Geary moves from 14.9 m away to 51.7 m, which is to say it is
// not there any more. test/car.check.ts bounds all three.

import {
  RoadClass,
  ROAD_ONEWAY,
  ROAD_TUNNEL,
  LANE_WIDTH_M,
  parkingStripM,
  roadWidthM,
  type Road,
} from "./roadpack";

/**
 * How far apart two vertices may be and still be the same junction, in metres.
 *
 * See the header: this is a measured separation, not a guess. It is comfortably
 * under the narrowest carriageway in the table (a 3.5 m service road), so it
 * cannot fuse two genuinely different streets.
 */
export const JOIN_TOLERANCE_M = 0.30;

/**
 * The first class that is not a road for cars.
 *
 * Everything from pedestrian (10) down is a footway, a cycle track or a farm
 * track. Taken from the class ORDER in roadpack.ts rather than listed, so a new
 * vehicular class added to that enum before this line is driveable by default
 * and a new path class after it is not.
 */
export const FIRST_NON_DRIVEABLE_CLASS = RoadClass.Pedestrian;

/**
 * Whether a way can be driven.
 *
 * Tunnels are excluded for a reason that has nothing to do with legality: no
 * tunnel geometry exists. The renderer skips them too, so a car entering one
 * would drive through unbroken hillside with the terrain drawn over the lens.
 */
export function isDriveable(r: Road): boolean {
  if ((r.flags & ROAD_TUNNEL) !== 0) return false;
  return r.cls < FIRST_NON_DRIVEABLE_CLASS;
}

/**
 * Where the car sits across the carriageway, in metres to the RIGHT of the
 * direction of travel.
 *
 * The centre of the kerb-side lane, derived from roadpack's width table and
 * lane width and from nothing else, so the tarmac and the car cannot disagree
 * about where the lane is. All four cities with a .roads pack drive on the
 * right; this is the one place that assumption is written down.
 *
 * A one-way needs no special case and deliberately does not get one: the offset
 * is relative to the direction of TRAVEL, and on a one-way the direction of
 * travel is the way's own direction, so the same formula puts the car in the
 * kerb lane of a one-way and on the correct side of a two-way whichever end it
 * entered from.
 *
 * A single-track service road comes out at 0, which is right: an alley has one
 * lane and its centre is the centreline.
 *
 * THE KERB LANE IS NOT THE KERBSIDE LANE. On a street with parking, the lane
 * against the kerb is full of parked cars, and the nearside lane a driver can
 * actually use starts inboard of them. Before there were parked cars this file
 * could ignore that; it cannot now, because the player would be steering
 * through a row of stationary vehicles at eye height. So the parking strip
 * comes off first, taken from roadpack.ts, which is the one place a width is
 * decided. On a narrow residential street the answer is zero, which is correct
 * and is what such a street does: traffic runs down the middle and pulls in.
 */
export function laneOffsetM(r: Road): number {
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  return Math.max(0, half - parkingStripM(r) - LANE_WIDTH_M * 0.5);
}

/**
 * One driveable stretch between two junctions.
 *
 * Structurally a `Road`, which is not an accident: it lets a graph edge go
 * straight into `RoadIndex` and into `roadWidthM` with no adapter, so the
 * carriageway a car is measured against is the same object the width table
 * answers for.
 */
export interface RoadEdge extends Road {
  /** Junction at `pts[0]`. */
  a: number;
  /** Junction at the last vertex. */
  b: number;
  lengthM: number;
  oneway: boolean;
  /** Index of the way in the pack this edge was cut from. */
  wayIndex: number;
}

/** An edge with a direction of travel. `forward` means a -> b. */
export interface HalfEdge {
  edge: number;
  forward: boolean;
}

export interface RoadGraphStats {
  ways: number;
  driveableWays: number;
  edges: number;
  nodes: number;
  /** Nodes with three or more edge ends on them: real intersections. */
  junctions: number;
  /** Ways that were cut because another way met them part-way along. */
  cutWays: number;
  onewayEdges: number;
  lengthM: number;
  buildMs: number;
}

export class RoadGraph {
  readonly nodeX: Float32Array;
  readonly nodeZ: Float32Array;
  readonly nodeCount: number;
  readonly edges: RoadEdge[];
  /** Half-edges leaving each node, one-way respected. */
  readonly out: HalfEdge[][];
  /** Half-edges arriving at each node. Not derivable from `out` in one step,
   *  and reversing out of a cul-de-sac needs it. */
  readonly into: HalfEdge[][];
  /** Every edge end on each node, direction ignored; the junction degree. */
  readonly degree: Int32Array;
  readonly stats: RoadGraphStats;

  constructor(
    nodeX: Float32Array,
    nodeZ: Float32Array,
    edges: RoadEdge[],
    out: HalfEdge[][],
    into: HalfEdge[][],
    degree: Int32Array,
    stats: RoadGraphStats,
  ) {
    this.nodeX = nodeX;
    this.nodeZ = nodeZ;
    this.nodeCount = nodeX.length;
    this.edges = edges;
    this.out = out;
    this.into = into;
    this.degree = degree;
    this.stats = stats;
  }

  /** The node a half-edge arrives at. */
  head(h: HalfEdge): number {
    const e = this.edges[h.edge];
    return h.forward ? e.b : e.a;
  }

  /** The node a half-edge leaves. */
  tail(h: HalfEdge): number {
    const e = this.edges[h.edge];
    return h.forward ? e.a : e.b;
  }
}

/**
 * A tolerance-joined table of junction points.
 *
 * The grid cell IS the tolerance, so a query only has to look at the 3x3
 * neighbourhood: any point within the tolerance of an existing one is in that
 * neighbourhood by construction.
 */
class PointJoin {
  private readonly cells = new Map<number, number[]>();
  readonly x: number[] = [];
  readonly z: number[] = [];
  /** The last way seen at this point, and whether a second, different one has
   *  been. Two distinct ways touching is what makes a point a junction. */
  readonly firstWay: number[] = [];
  readonly shared: boolean[] = [];
  readonly isEnd: boolean[] = [];

  private key(cx: number, cz: number): number {
    // Cantor-ish mix into one integer key. The grid is unbounded in both signs
    // (local ENU metres run negative), so a row-major index is not available.
    return (cx * 73856093) ^ (cz * 19349663);
  }

  /** Find or create the point at (x, z), and record which way touched it. */
  add(x: number, z: number, way: number, end: boolean): number {
    const cx = Math.floor(x / JOIN_TOLERANCE_M);
    const cz = Math.floor(z / JOIN_TOLERANCE_M);
    const tol2 = JOIN_TOLERANCE_M * JOIN_TOLERANCE_M;
    let best = -1;
    let bestD = tol2;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.cells.get(this.key(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const p of bucket) {
          const ddx = this.x[p] - x;
          const ddz = this.z[p] - z;
          const d = ddx * ddx + ddz * ddz;
          // Strictly nearest, and ties broken by the lower index, so the answer
          // does not depend on which cell of the 3x3 was scanned first.
          if (d < bestD || (d === bestD && best >= 0 && p < best)) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    if (best < 0) {
      best = this.x.length;
      this.x.push(x);
      this.z.push(z);
      this.firstWay.push(way);
      this.shared.push(false);
      this.isEnd.push(end);
      const k = this.key(cx, cz);
      const bucket = this.cells.get(k);
      if (bucket) bucket.push(best);
      else this.cells.set(k, [best]);
      return best;
    }
    if (this.firstWay[best] !== way) this.shared[best] = true;
    if (end) this.isEnd[best] = true;
    return best;
  }
}

/**
 * Build the driveable graph.
 *
 * Two passes over the vertices. The first finds every point two ways share and
 * every point a way ends at; the second cuts each way at those points. One pass
 * cannot do it, because a way has to be cut at a junction that may only be
 * discovered by a way that comes later in the pack.
 */
export function buildRoadGraph(roads: readonly Road[]): RoadGraph {
  const t0 = Date.now();
  const driveable: Road[] = [];
  const sourceIndex: number[] = [];
  for (let i = 0; i < roads.length; i++) {
    if (isDriveable(roads[i])) {
      driveable.push(roads[i]);
      sourceIndex.push(i);
    }
  }

  // --- pass 1: where do ways touch --------------------------------------
  const join = new PointJoin();
  const vertexPoint: Int32Array[] = new Array(driveable.length);
  for (let w = 0; w < driveable.length; w++) {
    const pts = driveable[w].pts;
    const n = pts.length / 2;
    const ids = new Int32Array(n);
    for (let v = 0; v < n; v++) {
      ids[v] = join.add(pts[v * 2], pts[v * 2 + 1], w, v === 0 || v === n - 1);
    }
    vertexPoint[w] = ids;
  }

  // A point becomes a NODE if two different ways touch it, or if some way ends
  // there. A way's own interior vertex that nothing else touches is geometry,
  // not a junction, and making it one would multiply the edge count by ten for
  // no connectivity.
  const nodeOf = new Int32Array(join.x.length).fill(-1);
  const nodeX: number[] = [];
  const nodeZ: number[] = [];
  for (let p = 0; p < join.x.length; p++) {
    if (!join.shared[p] && !join.isEnd[p]) continue;
    nodeOf[p] = nodeX.length;
    nodeX.push(join.x[p]);
    nodeZ.push(join.z[p]);
  }

  // --- pass 2: cut every way at its junctions ----------------------------
  const edges: RoadEdge[] = [];
  let cutWays = 0;
  let onewayEdges = 0;
  let lengthM = 0;

  for (let w = 0; w < driveable.length; w++) {
    const r = driveable[w];
    const ids = vertexPoint[w];
    const n = ids.length;
    let cuts = 0;
    let start = 0;
    for (let v = 1; v < n; v++) {
      const isNode = nodeOf[ids[v]] >= 0;
      if (!isNode && v < n - 1) continue;
      const a = nodeOf[ids[start]];
      const b = nodeOf[ids[v]];
      // The first vertex of a way is always an endpoint and therefore always a
      // node, so `a` is never -1; the guard is for a degenerate way whose
      // vertices all collapsed onto one point.
      if (a < 0 || b < 0 || a === b) {
        start = v;
        continue;
      }
      const pts = new Float32Array((v - start + 1) * 2);
      let len = 0;
      for (let k = start; k <= v; k++) {
        pts[(k - start) * 2] = r.pts[k * 2];
        pts[(k - start) * 2 + 1] = r.pts[k * 2 + 1];
        if (k > start) {
          len += Math.hypot(r.pts[k * 2] - r.pts[(k - 1) * 2], r.pts[k * 2 + 1] - r.pts[(k - 1) * 2 + 1]);
        }
      }
      // A zero-length stretch is two junctions on the same spot; it would make
      // the along-edge parameter a division by zero and carries no road.
      if (len > 1e-3) {
        const oneway = (r.flags & ROAD_ONEWAY) !== 0;
        if (oneway) onewayEdges++;
        lengthM += len;
        edges.push({
          cls: r.cls,
          lanes: r.lanes,
          flags: r.flags,
          layer: r.layer,
          surface: r.surface,
          cx: r.cx,
          cz: r.cz,
          pts,
          a,
          b,
          lengthM: len,
          oneway,
          wayIndex: sourceIndex[w],
        });
      }
      if (v < n - 1) cuts++;
      start = v;
    }
    if (cuts > 0) cutWays++;
  }

  // --- adjacency ----------------------------------------------------------
  const out: HalfEdge[][] = new Array(nodeX.length);
  const into: HalfEdge[][] = new Array(nodeX.length);
  for (let i = 0; i < out.length; i++) { out[i] = []; into[i] = []; }
  const degree = new Int32Array(nodeX.length);
  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e];
    degree[edge.a]++;
    degree[edge.b]++;
    out[edge.a].push({ edge: e, forward: true });
    into[edge.b].push({ edge: e, forward: true });
    // A one-way is drawn in its direction of travel, so the reverse half-edge
    // simply does not exist. That is the whole of one-way handling: nothing
    // downstream has to remember to check a flag.
    if (!edge.oneway) {
      out[edge.b].push({ edge: e, forward: false });
      into[edge.a].push({ edge: e, forward: false });
    }
  }

  let junctions = 0;
  for (let i = 0; i < degree.length; i++) if (degree[i] >= 3) junctions++;

  return new RoadGraph(
    Float32Array.from(nodeX),
    Float32Array.from(nodeZ),
    edges,
    out,
    into,
    degree,
    {
      ways: roads.length,
      driveableWays: driveable.length,
      edges: edges.length,
      nodes: nodeX.length,
      junctions,
      cutWays,
      onewayEdges,
      lengthM,
      buildMs: Date.now() - t0,
    },
  );
}

/**
 * Connected components over the UNDIRECTED graph, as a component id per node.
 *
 * Undirected on purpose. A pair of one-way carriageways is one street even
 * though neither direction reaches the other without going round the block, and
 * a measure that called that two networks would be measuring the traffic
 * scheme rather than whether the ways were joined up.
 */
export function connectedComponents(g: RoadGraph): Int32Array {
  const parent = new Int32Array(g.nodeCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    // Path compression, or a long street is O(n) per query on a graph this size.
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  for (const e of g.edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const out = new Int32Array(g.nodeCount);
  for (let i = 0; i < out.length; i++) out[i] = find(i);
  return out;
}

/** Total edge length in each component, keyed by the component's root node. */
export function componentLengths(g: RoadGraph, comp: Int32Array): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of g.edges) {
    const c = comp[e.a];
    m.set(c, (m.get(c) ?? 0) + e.lengthM);
  }
  return m;
}
