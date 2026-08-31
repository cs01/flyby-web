// Where a bridge deck actually is.
//
// WHY THIS IS ITS OWN, PURE FILE. Two things drive on a bridge: the ribbon
// render/roads.ts draws, and the car sim/car.ts puts on it. They were each
// working the deck height out for themselves, over different units -- the
// ribbon per PACK WAY, the car per GRAPH EDGE, and the graph cuts a way at
// every junction it passes through. So the surface you could see and the
// surface you could drive on were not the same surface. That is the argument
// for one answer computed once, and for computing it somewhere with no THREE
// and no DOM so test/bridge.check.ts can run it under Bun.
//
// WHAT WAS WRONG, MEASURED. The old rule was a fixed lift over whatever the
// terrain happened to be doing underneath:
//
//   plain road 0.35 m,  bridge 3.85 m,  bridge on layer 1 6.35 m
//
// Nothing reconciled a bridge with the road it joins, so every abutment was a
// vertical cliff: 266 of them across San Francisco, the worst 11.00 m. Driving
// over one threw the car into the air. And because each piece was interpolated
// between the ground at its OWN two ends, a long bridge sagged onto whatever
// was below it in as many pieces as the graph had cut it into: the Golden Gate
// deck is 46 ways and 25 graph edges, and it lay about six metres over the
// strait in kinked segments instead of spanning it.
//
// THE MODEL, which is shorter than what it replaces. A bridge deck is a
// straight run between its ABUTMENTS -- the points where the bridge meets
// ordinary road -- and at an abutment the deck is exactly where the approach
// is, terrain plus the ordinary road lift. Written that way the step cannot
// exist, because the two heights are the same number by construction, and the
// span is straight because nothing between the abutments is consulted at all.
// BRIDGE_LIFT_M and LAYER_LIFT_M stop being needed: a flyover clears the road
// under it because its ramps climb, which is what the ramps are for, and not
// because a constant was added to it.
//
// CHAINS, NOT WAYS. OSM splits a bridge wherever its tags change, so one bridge
// is many ways and only the ones at the very ends touch ordinary road. The
// solve is therefore over the connected component of bridge ways: find its
// abutments, then give every joint in it a height blended from them by inverse
// distance ALONG THE CHAIN. For the ordinary case of two abutments that blend
// is exactly linear interpolation by arc length, which is what a deck is; for a
// junction with ramps it degrades to something continuous, which is the
// property that matters.
//
// LINEAR WITHIN A WAY, and that is deliberate rather than an approximation
// nobody noticed. Both consumers interpolate between a way's two end heights by
// arc length along that way, so both evaluate the identical expression and
// cannot drift apart again. The chain solve decides the joints; the way decides
// nothing.

import { BRIDGE_LIFT_M, ROAD_BRIDGE, ROAD_LIFT_M, roadLengthM, type Road } from "./roadpack";
import { isDriveable } from "./roadgraph";

/**
 * How far apart two vertices may be and still be the same joint, in metres.
 *
 * The same measured tolerance roadgraph.ts joins on, and for the same reason:
 * the pack quantises each way against its OWN bbox centre, so two ways sharing
 * an OSM node reconstruct it to two different floats. See the header of
 * roadgraph.ts for the measurement.
 */
const JOIN_M = 0.30;

/**
 * A bridge way's deck, as heights at breakpoints along the way.
 *
 * PIECEWISE, NOT A SINGLE SPAN, and the reason is where the breakpoints are:
 * they are the way's JUNCTIONS, the points another way touches it. A deck is
 * pinned wherever something joins it and is a straight run in between, which is
 * the only shape that can meet every road that arrives without a step. Pinning
 * only the way's two ends leaves a step wherever OSM ran a road into the middle
 * of a bridge way instead of at its end, which it does: five such joins in San
 * Francisco, the worst of them 5.40 m.
 */
export interface Deck {
  /** Arc length along the way, ascending, starting at 0 and ending at its length. */
  s: Float32Array;
  /** Deck height at each breakpoint. */
  y: Float32Array;
}

export interface BridgeDeckStats {
  bridgeWays: number;
  chains: number;
  abutments: number;
  /** Chains with no abutment at all, which fall back to the ground at their ends. */
  orphanChains: number;
  /** The longest single chain, in metres. */
  longestChainM: number;
  buildMs: number;
}

export interface BridgeDecks {
  /** Indexed as `roads`; null wherever the way is not a bridge. */
  deck: (Deck | null)[];
  stats: BridgeDeckStats;
}

/**
 * Deck height `sM` metres along a bridge way.
 *
 * THE one expression. Both the ribbon and the car call it, with arc length
 * measured along the same way, which is what stops the drawn deck and the
 * driven deck being two different surfaces. In METRES rather than a fraction
 * because the car reaches a point as `startS + s` along its parent way and the
 * ribbon reaches it as the ribbon's own arc length, and both of those are
 * metres; converting each to a fraction was one more place for them to disagree.
 */
export function deckYAt(d: Deck, sM: number): number {
  const n = d.s.length;
  if (n === 0) return 0;
  if (sM <= d.s[0]) return d.y[0];
  if (sM >= d.s[n - 1]) return d.y[n - 1];
  // A way has a handful of breakpoints; a scan beats a search and has no cases.
  for (let i = 1; i < n; i++) {
    if (sM <= d.s[i]) {
      const span = d.s[i] - d.s[i - 1];
      const t = span > 1e-6 ? (sM - d.s[i - 1]) / span : 0;
      return d.y[i - 1] + (d.y[i] - d.y[i - 1]) * t;
    }
  }
  return d.y[n - 1];
}

/** A tolerance-joined point table. The grid cell IS the tolerance, so a lookup
 *  only has to scan the 3x3 neighbourhood. */
class Joiner {
  private cells = new Map<number, number[]>();
  readonly x: number[] = [];
  readonly z: number[] = [];

  private key(cx: number, cz: number): number {
    return (cx * 73856093) ^ (cz * 19349663);
  }

  /** The id at (x, z), creating it when `create` and nothing is near. */
  find(x: number, z: number, create: boolean): number {
    const cx = Math.floor(x / JOIN_M);
    const cz = Math.floor(z / JOIN_M);
    let best = -1;
    let bestD = JOIN_M * JOIN_M;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.cells.get(this.key(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const p of bucket) {
          const ddx = this.x[p] - x;
          const ddz = this.z[p] - z;
          const d = ddx * ddx + ddz * ddz;
          if (d < bestD || (d === bestD && best >= 0 && p < best)) { bestD = d; best = p; }
        }
      }
    }
    if (best >= 0 || !create) return best;
    const id = this.x.length;
    this.x.push(x);
    this.z.push(z);
    const k = this.key(cx, cz);
    const b = this.cells.get(k);
    if (b) b.push(id); else this.cells.set(k, [id]);
    return id;
  }
}

/**
 * Solve every bridge deck in the pack.
 *
 * `groundAt` is the terrain, and it is sampled ONLY at abutments -- a few
 * hundred points in a city rather than once per vertex. That is not an
 * optimisation, it is the model: nothing between the abutments has any say in
 * where the deck is.
 */
export function buildBridgeDecks(
  roads: readonly Road[],
  groundAt: (x: number, z: number) => number,
): BridgeDecks {
  const t0 = Date.now();
  const deck: (Deck | null)[] = new Array(roads.length).fill(null);

  const bridgeIdx: number[] = [];
  for (let i = 0; i < roads.length; i++) {
    if ((roads[i].flags & ROAD_BRIDGE) !== 0 && roads[i].pts.length >= 4) bridgeIdx.push(i);
  }
  const empty = (): BridgeDecks => ({
    deck,
    stats: { bridgeWays: bridgeIdx.length, chains: 0, abutments: 0, orphanChains: 0, longestChainM: 0, buildMs: Date.now() - t0 },
  });
  if (bridgeIdx.length === 0) return empty();

  // --- pass 1: join EVERY vertex of EVERY way ------------------------------
  //
  // Every way, not just the bridges, and every vertex, not just the ends. Both
  // are needed and for the same reason: OSM splits a way when its tags change,
  // not when something crosses it, so a road can end on the INTERIOR vertex of
  // a bridge and that is a junction the deck has to meet. roadgraph.ts cuts on
  // exactly this rule; a solver that used a different one would pin the deck in
  // places the graph does not have junctions and miss the ones it does.
  const joints = new Joiner();
  const firstWay: number[] = [];
  const shared: boolean[] = [];
  // TWO KINDS OF ABUTMENT, and keeping them apart is what stops the Golden Gate
  // lying in the water.
  //
  // An abutment is where the deck is pinned to the ground, so what touches it
  // decides where a two-kilometre span ends up. Round the Golden Gate the
  // anchorages and the shoreline carry footpaths AT SEA LEVEL that touch the
  // bridge's own chain -- the deck's sidewalk is a bridge way and it meets them
  // -- and treating one of those as an abutment pins the middle of the span to
  // 0.35 m and drags the whole crossing down onto the strait. A path under a
  // bridge is not what holds it up.
  //
  // So a chain that carries motor traffic takes its abutments only from ways
  // that carry motor traffic. A chain that is only a footbridge still takes
  // them from footways, because for a footbridge that is exactly right.
  const roadTouch: boolean[] = [];
  const pathTouch: boolean[] = [];
  for (let i = 0; i < roads.length; i++) {
    const isBridge = (roads[i].flags & ROAD_BRIDGE) !== 0;
    const drives = isDriveable(roads[i]);
    const p = roads[i].pts;
    for (let v = 0; v < p.length; v += 2) {
      const id = joints.find(p[v], p[v + 1], true);
      while (firstWay.length <= id) { firstWay.push(i); shared.push(false); roadTouch.push(false); pathTouch.push(false); }
      if (firstWay[id] !== i) shared[id] = true;
      if (!isBridge) {
        if (drives) roadTouch[id] = true;
        else pathTouch[id] = true;
      }
    }
  }

  // --- pass 2: the breakpoints of each bridge way --------------------------
  //
  // Its two ends, plus every interior vertex something else touches. Those are
  // the points where the deck is pinned, and between them it is a straight run.
  const bpJoint: number[][] = [];
  const bpS: number[][] = [];
  const bpDrives: boolean[] = [];
  for (const i of bridgeIdx) {
    bpDrives.push(isDriveable(roads[i]));
    const p = roads[i].pts;
    const n = p.length / 2;
    const js: number[] = [];
    const ss: number[] = [];
    let arc = 0;
    for (let v = 0; v < n; v++) {
      if (v > 0) arc += Math.hypot(p[v * 2] - p[(v - 1) * 2], p[v * 2 + 1] - p[(v - 1) * 2 + 1]);
      const id = joints.find(p[v * 2], p[v * 2 + 1], false);
      const isEnd = v === 0 || v === n - 1;
      if (id >= 0 && (isEnd || shared[id])) {
        // A repeated joint at the same arc length carries no span.
        if (ss.length === 0 || arc - ss[ss.length - 1] > 1e-3) { js.push(id); ss.push(arc); }
      }
    }
    bpJoint.push(js);
    bpS.push(ss);
  }

  // --- the chain graph -----------------------------------------------------
  //
  // A node is a breakpoint joint; a link is the run of deck between two
  // consecutive breakpoints of one way, weighted by its length.
  const incident = new Map<number, { other: number; len: number }[]>();
  /** Joints on a chain that carries motor traffic, so the chain knows which
   *  kind of abutment it is allowed to be held up by. */
  const jointDrives = new Set<number>();
  const link = (a: number, b: number, len: number): void => {
    if (a === b) return;
    if (!incident.has(a)) incident.set(a, []);
    if (!incident.has(b)) incident.set(b, []);
    incident.get(a)!.push({ other: b, len });
    incident.get(b)!.push({ other: a, len });
  };
  for (let e = 0; e < bridgeIdx.length; e++) {
    const js = bpJoint[e];
    const ss = bpS[e];
    for (let k = 1; k < js.length; k++) link(js[k - 1], js[k], Math.max(1e-3, ss[k] - ss[k - 1]));
    if (js.length === 1 && !incident.has(js[0])) incident.set(js[0], []);
    if (bpDrives[e]) for (const j of js) jointDrives.add(j);
  }

  const jointY = new Map<number, number>();
  const seen = new Set<number>();
  let chains = 0;
  let abutments = 0;
  let orphanChains = 0;
  let longestChainM = 0;


  for (const startJoint of incident.keys()) {
    if (seen.has(startJoint)) continue;
    const nodes: number[] = [];
    const stack = [startJoint];
    seen.add(startJoint);
    let chainM = 0;
    while (stack.length) {
      const n = stack.pop()!;
      nodes.push(n);
      for (const { other, len } of incident.get(n) ?? []) {
        chainM += len * 0.5; // each link is walked from both ends
        if (!seen.has(other)) { seen.add(other); stack.push(other); }
      }
    }
    chains++;
    if (chainM > longestChainM) longestChainM = chainM;

    // A chain with any motor traffic on it is held up by roads only; a pure
    // footbridge may be held up by paths.
    const carries = nodes.some((n) => jointDrives.has(n));
    const sources = carries
      ? nodes.filter((n) => roadTouch[n])
      : nodes.filter((n) => roadTouch[n] || pathTouch[n]);
    abutments += sources.length;
    if (sources.length === 0) {
      // A chain nothing ordinary reaches: clipped at the city radius, or a
      // bridge whose approaches are outside the pack. There is nothing to
      // interpolate BETWEEN, so this keeps the OLD behaviour deliberately --
      // draped on the ground with the old bridge lift. It is wrong in the way
      // described at the top of this file, and it is wrong only at the edge of
      // the world, where the alternative is a deck lying in the water.
      orphanChains++;
      for (const n of nodes) jointY.set(n, groundAt(joints.x[n], joints.z[n]) + ROAD_LIFT_M + BRIDGE_LIFT_M);
      continue;
    }

    // Multi-source: one Dijkstra per abutment over the chain, then blend the
    // abutment heights by inverse distance. With two abutments at distances d0
    // and d1 along the deck this is (h0*d1 + h1*d0) / (d0 + d1), which is exactly
    // linear interpolation by arc length -- a straight span, which is what a
    // bridge is.
    const index = new Map<number, number>();
    nodes.forEach((n, k) => index.set(n, k));
    const dists: Float64Array[] = [];
    const heights: number[] = [];
    for (const src of sources) {
      heights.push(groundAt(joints.x[src], joints.z[src]) + ROAD_LIFT_M);
      const d = new Float64Array(nodes.length).fill(Infinity);
      d[index.get(src)!] = 0;
      const done = new Uint8Array(nodes.length);
      for (;;) {
        let best = -1;
        let bestD = Infinity;
        for (let k = 0; k < nodes.length; k++) if (!done[k] && d[k] < bestD) { bestD = d[k]; best = k; }
        if (best < 0) break;
        done[best] = 1;
        for (const { other, len } of incident.get(nodes[best]) ?? []) {
          const ko = index.get(other);
          if (ko === undefined) continue;
          const nd = bestD + len;
          if (nd < d[ko]) d[ko] = nd;
        }
      }
      dists.push(d);
    }

    for (let k = 0; k < nodes.length; k++) {
      let wsum = 0;
      let hsum = 0;
      let exact = -1;
      for (let a = 0; a < sources.length; a++) {
        const dk = dists[a][k];
        if (!isFinite(dk)) continue;
        if (dk < 1e-6) { exact = a; break; }
        const w = 1 / dk;
        wsum += w;
        hsum += w * heights[a];
      }
      const n = nodes[k];
      jointY.set(
        n,
        exact >= 0 ? heights[exact] : wsum > 0 ? hsum / wsum : groundAt(joints.x[n], joints.z[n]) + ROAD_LIFT_M,
      );
    }
  }

  for (let e = 0; e < bridgeIdx.length; e++) {
    const i = bridgeIdx[e];
    const js = bpJoint[e];
    const ss = bpS[e];
    if (js.length < 2) {
      // Degenerate: one breakpoint, or none. Flat at whatever that joint got.
      const y = js.length === 1 ? (jointY.get(js[0]) ?? groundAt(roads[i].pts[0], roads[i].pts[1]) + ROAD_LIFT_M) : groundAt(roads[i].pts[0], roads[i].pts[1]) + ROAD_LIFT_M;
      deck[i] = { s: Float32Array.from([0, Math.max(1e-3, roadLengthM(roads[i]))]), y: Float32Array.from([y, y]) };
      continue;
    }
    deck[i] = {
      s: Float32Array.from(ss),
      y: Float32Array.from(js.map((j) => jointY.get(j) ?? groundAt(joints.x[j], joints.z[j]) + ROAD_LIFT_M)),
    };
  }

  return {
    deck,
    stats: {
      bridgeWays: bridgeIdx.length,
      chains,
      abutments,
      orphanChains,
      longestChainM,
      buildMs: Date.now() - t0,
    },
  };
}
