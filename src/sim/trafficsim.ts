// Moving traffic as a simulation on the road graph: lanes, junction curves,
// car-following and signals.
//
// WHY IT STOPPED BEING A VERTEX SHADER. The cars used to be an analytic
// function of a clock: each instance carried the two ends of a straight run
// cut from one OSM way and drove it at constant speed, fading out at the end.
// That was cheap and it is the reason for every defect the owner reported from
// the driver's seat in the Loop:
//
//   * a run ended wherever the way did, usually in the middle of a junction,
//     so cars shrank to nothing on the crossing and grew out of it again;
//   * nothing knew about anything else, so cross streams drove through each
//     other on the junction box, and a car could not stop for a light, for
//     the car in front, or for the player;
//   * the lane offsets were their own formula (see data/lanes.ts for what that
//     did to two-way streets).
//
// What is here instead is the smallest model that answers those: a car is a
// position along a LANE PATH (the centreline offset to a lane centre and cut
// back from each junction to its stop line), a junction is a cubic CONNECTOR
// from one lane's end to the next lane's start, and speed comes from the
// Intelligent Driver Model against whatever is ahead: the next car in the
// lane, a red stop line, or the player. All of it is CPU, all of it is a few
// multiply-adds per car, and render/traffic.ts uploads one pose per car per
// frame. Measured cost is in the report of the change that introduced it.
//
// PURE: no THREE, no DOM. test/trafficmodel.check.ts drives it under Bun on
// the committed packs and measures lane error, heading error, gaps and
// signals against literals.

import type { RoadGraph, RoadEdge, HalfEdge } from "../data/roadgraph";
import { laneLayoutCached, lanesForTravel, TWO_WAY_MIN_LANE_M } from "../data/lanes";
import { RoadClass, roadLiftM, ROAD_BRIDGE } from "../data/roadpack";
import { deckYAt, type Deck } from "../data/bridgedeck";
import { TRAFFIC_PER_KM_LANE, TRAFFIC_SPEED_MS, hash1 } from "../data/streetfurniture";

// --- the driver model -------------------------------------------------------

/** Bumper to bumper length the gaps are measured with, metres. The archetypes
 *  run 4.4 (hatch) to 5.2 (van); the follower brakes for the longer one. */
export const CAR_LENGTH_M = 4.8;
/** IDM jam distance: the gap kept when stopped, metres. */
export const IDM_S0_M = 2.0;
/**
 * IDM time headway, seconds, and maximum acceleration, m/s^2.
 *
 * At Treiber's urban 1.2 s and 1.6 m/s^2 a queue discharged at about one car
 * per 2.3 s, so a 20 s green passed nine cars a lane while the placed peak
 * density (34 a kilometre at 10 m/s) delivers thirteen a cycle: every lane in
 * the Loop backed up a block further each cycle and half the field was
 * standing after three minutes. A city driver pulls away harder and sits
 * closer than the textbook; at 1.0 s and 2.0 m/s^2 discharge is one per 1.8 s.
 */
const IDM_T_S = 1.0;
const IDM_A = 2.0;
const IDM_B = 2.6;
/** Hardest a car will brake for a light before deciding to go through on
 *  amber, m/s^2. Over this it was already committed when the light changed. */
const AMBER_COMMIT_DECEL = 4.5;
/** Hard floor on the gap, metres. IDM keeps a car well behind this; the clamp
 *  is what makes "never overlaps" an invariant rather than a tendency. */
export const HARD_GAP_M = 0.5;

/**
 * Spacing a bridge lane is resampled at, metres. A car's height is linear
 * between samples, and on the pinned landmark decks (a cambered, sagging
 * profile) 8 m left six samples in 112k more than 0.3 m off the deck, the
 * worst 0.33 m; 4 m puts the worst at 0.14 m.
 */
const BRIDGE_SAMPLE_M = 4;

/**
 * Shortest edge traffic drives, metres. OSM junctions are full of stubs a
 * metre or two long where ways were split by hand; a lane on one is shorter
 * than the car on it, and the connectors into and out of it were cusps
 * (measured: 4,598 junction connectors in the Chicago ring curving tighter
 * than 2 m radius, the worst a 265 degree loop in 1.9 m). Such an edge is left
 * to the player, and a car whose only way on is one leaves the road there.
 */
const MICRO_EDGE_M = 8;

/** Shortest centreline segment a lane is built over, metres; see path(). */
const SLIVER_M = 2.5;
const SLIVER_DEV_M = 0.1;
const SLIVER_TINY_M = 0.75;

/** Centreline bends sharper than this inside an edge are rounded off, and
 *  the rounding is sampled every FILLET_STEP_RAD. Three degrees: an unrounded
 *  kink is a step in the car's heading, and at 8 degrees the gate measured
 *  cars 7.9 degrees off the road next to a vertex the rounding had skipped. */
const FILLET_MIN_RAD = 3 * Math.PI / 180;
const FILLET_STEP_RAD = 6 * Math.PI / 180;

/**
 * Narrowest carriageway a car turns round in at a dead end, metres. Under it
 * the U-turn connector is tighter than any car's lock (a 7 m street gives a
 * 1.7 m radius, measured as 52 degrees of heading in one frame), so the car
 * leaves the road at the end instead; see `advance`.
 */
const UTURN_MIN_WIDTH_M = 10;

/** Tightest radius a connector may turn at, metres: a city car's kerb-to-kerb
 *  turning circle is about 10.5 m, so 5 m at the centre of the car with a
 *  little wheel-scrub allowance. Junctions that need tighter are not taken. */
const MIN_TURN_RADIUS_M = 4.5;

/** Cell of the body grid, metres, and the lateral margin a car leaves a body
 *  in front of it on another path. */
const BODY_CELL_M = 8;
const BODY_MARGIN_M = 0.25;

/** Speed through a connector turning more than ~60 degrees, m/s. */
const TURN_SPEED_MS = 6;

// --- signals ----------------------------------------------------------------

/** One full signal cycle, seconds: two phases of green, amber and all-red. */
export const SIGNAL_CYCLE_S = 48;
const GREEN_S = 20;
const AMBER_S = 3;
/** Junctions closer than this are one intersection with one controller, and a
 *  car that has crossed the first stop line does not stop at the second. */
const CLUSTER_M = 30;

/** Where a half-edge's light is in its cycle: 0 green, 1 amber, 2 red. */
export type SignalState = 0 | 1 | 2;

/**
 * The approach group a half-edge belongs to at its head junction, and the
 * phase it is in at time `t`.
 *
 * Two groups per junction: approaches roughly parallel to the junction's main
 * road, and the ones across it. Phase A is green for the first 20 s of the
 * cycle, amber 3, all-red 1; phase B the same 24 s later.
 */
function phaseOf(t: number, offset: number, group: number): SignalState {
  const c = (((t + offset) % SIGNAL_CYCLE_S) + SIGNAL_CYCLE_S) % SIGNAL_CYCLE_S;
  const local = group === 0 ? c : (c + SIGNAL_CYCLE_S / 2) % SIGNAL_CYCLE_S;
  if (local < GREEN_S) return 0;
  if (local < GREEN_S + AMBER_S) return 1;
  return 2;
}

// --- geometry ---------------------------------------------------------------

/** A lane's drivable centreline between its two stop lines. */
export interface LanePath {
  key: number;
  he: number;
  lane: number;
  /** Offset right of travel this path was built at. */
  offsetM: number;
  xs: Float32Array;
  zs: Float32Array;
  ys: Float32Array;
  /** Cumulative length at each vertex. */
  cum: Float32Array;
  /** Travel direction at the two ends, from the CENTRELINE there: the
   *  connectors are built tangent to these, and a lane's own end segment can
   *  be a few centimetres long and point anywhere. */
  startDirX: number; startDirZ: number;
  endDirX: number; endDirZ: number;
  length: number;
  /** Cars on this path, ordered back to front by s. Connector cars (s < 0)
   *  heading INTO this path are included. */
  cars: Vehicle[];
  /** Front cars of OTHER paths about to enter this one, rebuilt each substep
   *  (valid when `rivalStamp` is the sim's current stamp). */
  rivals: Vehicle[];
  rivalVirt: number[];
  rivalStamp: number;
}

/** A connector: a cubic from one lane's stop line to the next lane's start. */
interface Connector {
  p0x: number; p0z: number; p0y: number;
  c1x: number; c1z: number;
  c2x: number; c2z: number;
  p1x: number; p1z: number; p1y: number;
  length: number;
  /** Turns more than ~60 degrees, so is taken at TURN_SPEED_MS. */
  sharp: boolean;
}

export class Vehicle {
  id = 0;
  path: LanePath | null = null;
  /** Metres along the path from its start; negative while on the connector
   *  into it, from -conn.length to 0. */
  s = 0;
  v = 0;
  /** Desired speed on the road it is on, m/s. */
  v0 = 10;
  /** This driver's share of the class speed, 0.85..1.10, kept for life. */
  temper = 1;
  /** Planned next half-edge and lane, or -1 when there is nowhere to go. */
  nextHe = -1;
  nextLane = 0;
  conn: Connector | null = null;
  /** Segment hint for the lane polyline lookup. */
  seg = 0;
  /** Stable look, 0..1 each. */
  tint = 0;
  archetype = 0;
  /** Place in the thinning queue; see data/trafficmodel.ts. */
  rank = 0;
  /** Class it was placed on: the hour thins a car by the class it belongs
   *  to, not by the street it happens to be crossing, or a car turning off an
   *  arterial into a side street at 03:00 would vanish at the corner. */
  cls: RoadClass = RoadClass.Residential;
  /** Class of the road it is on now, for its speed. */
  roadCls: RoadClass = RoadClass.Residential;
  /** Brake light, 0..1: decelerating harder than a lift-off. */
  brake = 0;
  /** Visible size, 0..1: grown in on spawn, shrunk out on thinning. */
  scale = 1;
  junctions = 0;
  /** Seconds stood still without a break; see the deadlock valve in step. */
  stoppedS = 0;
  /** World pose as of the start of the current substep, for the body check. */
  wx = 0;
  wz = 0;
  wdx = 1;
  wdz = 0;
  dead = false;
}

/** A car's world pose, as the renderer and the gates read it. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
}

/** The player's car, as the traffic sees it. */
export interface PlayerObstacle {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Signed speed along dir, m/s. */
  speed: number;
}

export interface TrafficSimWorld {
  graph: RoadGraph;
  heightAt(x: number, z: number): number;
  /** Solved bridge deck of a pack way, or null. */
  deckOf?: ((wayIndex: number) => Deck | null) | null;
}

export interface TrafficSimStats {
  cars: number;
  activeEdges: number;
  paths: number;
  spawned: number;
  recycled: number;
  lastStepMs: number;
}

function heOf(h: HalfEdge): number {
  return h.edge * 2 + (h.forward ? 0 : 1);
}

/** Whether traffic drives this edge at all: a two-way must give each direction
 *  a lane a car can pass in, and an alley that cannot is left to the parked
 *  cars and the player. */
export function trafficable(e: RoadEdge): boolean {
  if (!(TRAFFIC_PER_KM_LANE[e.cls] > 0)) return false;
  if (e.lengthM < MICRO_EDGE_M) return false;
  const l = laneLayoutCached(e);
  return l.laneM >= TWO_WAY_MIN_LANE_M - 1e-6;
}

const DEG = Math.PI / 180;

/**
 * The simulation. One per city; `setRing` says which part of the graph is
 * populated, `step` advances it.
 */
export class TrafficSim {
  readonly stats: TrafficSimStats = { cars: 0, activeEdges: 0, paths: 0, spawned: 0, recycled: 0, lastStepMs: 0 };
  readonly cars: Vehicle[] = [];
  /** Simulation time, seconds. Drives the signals. */
  time = 0;
  /** Per RoadClass: fraction of placed cars out, and the speed multiplier. */
  frac: number[] = new Array(16).fill(1);
  speedScale: number[] = new Array(16).fill(1);
  densityScale = 1;
  capacity: number;
  player: PlayerObstacle | null = null;
  /** False runs every junction as if it had no light: the vacuity probe for
   *  the red-light gate, and nothing else. */
  signalsEnabled = true;

  private readonly world: TrafficSimWorld;
  private readonly g: RoadGraph;
  private readonly paths = new Map<number, LanePath>();
  private readonly active = new Set<number>();
  /** Edge grid for ring queries, cell -> edges. */
  private readonly grid = new Map<number, number[]>();
  private readonly cellM = 200;
  private readonly edgeOk: Uint8Array;
  private readonly edgeMid: Float32Array;
  private readonly edgeRad: Float32Array;
  private readonly nodeSetback: Float32Array;
  private readonly nodeOffset: Float32Array;
  /** Approach group of each half-edge at its head, -1 for an unsignalised one. */
  private readonly heGroup: Int8Array;
  private nextId = 1;
  private ringX = 0;
  private ringZ = 0;
  private ringR = 0;
  private respawnCursor = 0;
  private pathKeys: number[] = [];
  private pathKeysDirty = true;

  constructor(world: TrafficSimWorld, capacity: number) {
    this.world = world;
    this.g = world.graph;
    this.capacity = capacity;
    const E = this.g.edges.length;
    this.edgeOk = new Uint8Array(E);
    this.edgeMid = new Float32Array(E * 2);
    this.edgeRad = new Float32Array(E);
    for (let e = 0; e < E; e++) {
      const edge = this.g.edges[e];
      this.edgeOk[e] = trafficable(edge) ? 1 : 0;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < edge.pts.length; k += 2) {
        minX = Math.min(minX, edge.pts[k]); maxX = Math.max(maxX, edge.pts[k]);
        minZ = Math.min(minZ, edge.pts[k + 1]); maxZ = Math.max(maxZ, edge.pts[k + 1]);
      }
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      this.edgeMid[e * 2] = cx;
      this.edgeMid[e * 2 + 1] = cz;
      this.edgeRad[e] = Math.hypot(maxX - minX, maxZ - minZ) / 2;
      if (!this.edgeOk[e]) continue;
      const c0x = Math.floor(minX / this.cellM), c1x = Math.floor(maxX / this.cellM);
      const c0z = Math.floor(minZ / this.cellM), c1z = Math.floor(maxZ / this.cellM);
      for (let x = c0x; x <= c1x; x++) {
        for (let z = c0z; z <= c1z; z++) {
          const k = x * 100003 + z;
          const b = this.grid.get(k);
          if (b) b.push(e); else this.grid.set(k, [e]);
        }
      }
    }

    // Stop lines. A junction's stop line is back from the node by the half
    // width of the widest road through it plus a crossing, so a car waits at
    // the kerb line of the street it is about to cross rather than on its
    // centreline. A plain continuation (two edges meeting) needs only enough
    // to round a kink.
    const N = this.g.nodeCount;
    this.nodeSetback = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      if (this.g.degree[n] === 2) {
        // A plain continuation: back off far enough that the outside lane of
        // the widest road has not started to turn, or the two lane ends
        // overlap and the connector between them loops (measured: 40 to 50
        // degrees of heading in one frame on a 3 m connector).
        const hs = [...this.g.out[n], ...this.g.into[n]];
        let w = 0;
        for (const h of hs) w = Math.max(w, laneLayoutCached(this.g.edges[h.edge]).widthM);
        let th = 0;
        const ends = this.edgeEndsAt(n);
        if (ends.length === 2) {
          const [a, b] = ends;
          th = Math.acos(Math.max(-1, Math.min(1, -(a.x * b.x + a.z * b.z))));
        }
        this.nodeSetback[n] = Math.min(12, (w * 0.5 + 1) * Math.tan(Math.min(th, 2.6) / 2) + 1.5);
        continue;
      }
      if (this.g.degree[n] < 3) { this.nodeSetback[n] = 2.5; continue; }
      let w = 0;
      for (const h of this.g.out[n]) w = Math.max(w, laneLayoutCached(this.g.edges[h.edge]).widthM);
      for (const h of this.g.into[n]) w = Math.max(w, laneLayoutCached(this.g.edges[h.edge]).widthM);
      this.nodeSetback[n] = w * 0.5 + 1.5;
    }

    // Controllers: junctions within CLUSTER_M of each other share an offset.
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    for (const e of this.g.edges) {
      if (e.lengthM < CLUSTER_M && this.g.degree[e.a] >= 3 && this.g.degree[e.b] >= 3) {
        const ra = find(e.a), rb = find(e.b);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    this.nodeOffset = new Float32Array(N);
    for (let n = 0; n < N; n++) this.nodeOffset[n] = hash1(find(n) * 0.731 + 5.3) * SIGNAL_CYCLE_S;

    // Approach groups. The reference axis at a junction is its most important
    // approach (lowest class, then longest); an approach within 45 degrees of
    // that axis, either way, is group 0 and the rest group 1. A junction only
    // has a light if both groups have an approach: a bend with a driveway off
    // it is not an intersection anyone signalises.
    this.heGroup = new Int8Array(E * 2).fill(-1);
    for (let n = 0; n < N; n++) {
      if (this.g.degree[n] < 3) continue;
      // Service roads and alleys do not get a light: a driveway onto an avenue
      // is not a signalised junction, and counting them put a red every 50 m
      // down every street in the Loop.
      const ins = this.g.into[n].filter((h) => this.edgeOk[h.edge] && this.g.edges[h.edge].cls < RoadClass.Service);
      if (ins.length < 2) continue;
      let ref = ins[0];
      for (const h of ins) {
        const a = this.g.edges[h.edge], b = this.g.edges[ref.edge];
        if (a.cls < b.cls || (a.cls === b.cls && a.lengthM > b.lengthM)) ref = h;
      }
      const rd = this.exitDir(ref);
      const groups = ins.map((h) => {
        const d = this.exitDir(h);
        return Math.abs(d.x * rd.x + d.z * rd.z) >= Math.SQRT1_2 ? 0 : 1;
      });
      if (!groups.includes(0) || !groups.includes(1)) continue;
      ins.forEach((h, i) => { this.heGroup[heOf(h)] = groups[i]; });
    }
  }

  /** Unit directions pointing AWAY from node n along each edge end there. */
  private edgeEndsAt(n: number): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    const seen = new Set<number>();
    for (const h of [...this.g.out[n], ...this.g.into[n]]) {
      if (seen.has(h.edge)) continue;
      seen.add(h.edge);
      const e = this.g.edges[h.edge];
      const k = e.pts.length;
      if (e.a === n) {
        const dx = e.pts[2] - e.pts[0], dz = e.pts[3] - e.pts[1];
        const L = Math.hypot(dx, dz) || 1;
        out.push({ x: dx / L, z: dz / L });
      }
      if (e.b === n) {
        const dx = e.pts[k - 4] - e.pts[k - 2], dz = e.pts[k - 3] - e.pts[k - 1];
        const L = Math.hypot(dx, dz) || 1;
        out.push({ x: dx / L, z: dz / L });
      }
    }
    return out;
  }

  // --- public ---------------------------------------------------------------

  /** Populate the part of the graph within `radiusM` of (x, z). Cheap when the
   *  ring has not moved; call it every frame. */
  setRing(x: number, z: number, radiusM: number): void {
    const moved = Math.hypot(x - this.ringX, z - this.ringZ);
    if (this.ringR === radiusM && moved < radiusM * 0.15) return;
    this.ringX = x;
    this.ringZ = z;
    this.ringR = radiusM;
    const want = new Set<number>();
    const c0x = Math.floor((x - radiusM) / this.cellM), c1x = Math.floor((x + radiusM) / this.cellM);
    const c0z = Math.floor((z - radiusM) / this.cellM), c1z = Math.floor((z + radiusM) / this.cellM);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const b = this.grid.get(cx * 100003 + cz);
        if (!b) continue;
        for (const e of b) {
          const d = Math.hypot(this.edgeMid[e * 2] - x, this.edgeMid[e * 2 + 1] - z) - this.edgeRad[e];
          if (d < radiusM) want.add(e);
        }
      }
    }
    // Drop what left the ring. Its cars are at the rim, where the renderer has
    // already faded them out.
    for (const e of this.active) {
      if (want.has(e)) continue;
      this.active.delete(e);
      for (let dir = 0; dir < 2; dir++) {
        for (let lane = 0; lane < 8; lane++) {
          const key = (e * 2 + dir) * 8 + lane;
          const p = this.paths.get(key);
          if (!p) continue;
          for (const c of p.cars) c.dead = true;
          this.paths.delete(key);
          this.pathKeysDirty = true;
          this.pathListDirty = true;
        }
      }
    }
    this.rebuildBodies();
    for (const e of want) {
      if (this.active.has(e)) continue;
      this.active.add(e);
      this.populate(e);
    }
    this.sweepDead();
    this.stats.activeEdges = this.active.size;
    this.stats.paths = this.paths.size;
  }

  /** Signal state for a half-edge at its head junction, or null for none. */
  signalAt(he: number): SignalState | null {
    if (!this.signalsEnabled) return null;
    const g = this.heGroup[he];
    if (g < 0) return null;
    const e = this.g.edges[he >> 1];
    // Inside a cluster: the car crossed the controller's first stop line.
    if (e.lengthM < CLUSTER_M) return null;
    const head = (he & 1) === 0 ? e.b : e.a;
    return phaseOf(this.time, this.nodeOffset[head], g);
  }

  /** Advance by `dt` seconds. Sub-steps itself so a long frame is stable. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    let left = Math.min(dt, 1.0);
    while (left > 1e-6) {
      const h = Math.min(left, 0.1);
      this.substep(h);
      left -= h;
    }
    this.maintainPopulation();
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.stats.lastStepMs = t1 - t0;
    this.stats.cars = this.cars.length;
  }

  /** Where car `c` is and which way it faces. */
  pose(c: Vehicle, out: Pose): Pose {
    if (c.s < 0 && c.conn) {
      const k = c.conn;
      const t = Math.min(1, Math.max(0, 1 + c.s / k.length));
      const u = 1 - t;
      const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      out.x = b0 * k.p0x + b1 * k.c1x + b2 * k.c2x + b3 * k.p1x;
      out.z = b0 * k.p0z + b1 * k.c1z + b2 * k.c2z + b3 * k.p1z;
      out.y = k.p0y + (k.p1y - k.p0y) * t;
      const d0 = 3 * u * u, d1 = 6 * u * t, d2 = 3 * t * t;
      let dx = d0 * (k.c1x - k.p0x) + d1 * (k.c2x - k.c1x) + d2 * (k.p1x - k.c2x);
      let dz = d0 * (k.c1z - k.p0z) + d1 * (k.c2z - k.c1z) + d2 * (k.p1z - k.c2z);
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      out.dirX = dx;
      out.dirZ = dz;
      return out;
    }
    const p = c.path!;
    const s = Math.min(p.length, Math.max(0, c.s));
    let i = Math.min(Math.max(0, c.seg), p.cum.length - 2);
    while (i < p.cum.length - 2 && p.cum[i + 1] < s) i++;
    while (i > 0 && p.cum[i] > s) i--;
    c.seg = i;
    const segL = p.cum[i + 1] - p.cum[i];
    const t = segL > 1e-6 ? (s - p.cum[i]) / segL : 0;
    const dx = p.xs[i + 1] - p.xs[i];
    const dz = p.zs[i + 1] - p.zs[i];
    out.x = p.xs[i] + dx * t;
    out.z = p.zs[i] + dz * t;
    out.y = p.ys[i] + (p.ys[i + 1] - p.ys[i]) * t;
    const L = Math.hypot(dx, dz) || 1;
    out.dirX = dx / L;
    out.dirZ = dz / L;
    return out;
  }

  /** The lane path a car is on, or heading into. */
  pathOf(c: Vehicle): LanePath | null {
    return c.path;
  }

  /** Half-edge id of a path: edge * 2 + (forward ? 0 : 1). */
  edgeOfPath(p: LanePath): { edge: number; forward: boolean } {
    return { edge: p.he >> 1, forward: (p.he & 1) === 0 };
  }

  /**
   * The nearest traffic car ahead of a body at (x, z) heading (dirX, dirZ),
   * within a lateral band, as a bumper gap and its speed along that heading.
   * The player's car brakes on this.
   */
  ahead(
    x: number, z: number, dirX: number, dirZ: number,
    halfBandM: number, rangeM: number, selfHalfAlongM = CAR_LENGTH_M / 2,
  ): { gap: number; v: number } | null {
    let best: { gap: number; v: number } | null = null;
    const p: Pose = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };
    for (const c of this.cars) {
      if (c.dead || c.scale < 0.2) continue;
      this.pose(c, p);
      const rx = p.x - x, rz = p.z - z;
      if (rx * rx + rz * rz > (rangeM + CAR_LENGTH_M) ** 2) continue;
      const a = rx * dirX + rz * dirZ;
      if (a <= 0) continue;
      const lat = Math.abs(rx * -dirZ + rz * dirX);
      // The other car's half width projected across our heading: a car
      // crossing in front occupies its LENGTH across our path, not its width.
      const cross = Math.abs(p.dirX * -dirZ + p.dirZ * dirX);
      const along = Math.abs(p.dirX * dirX + p.dirZ * dirZ);
      const halfAcross = 0.9 * along + (CAR_LENGTH_M / 2) * cross;
      if (lat > halfBandM + halfAcross) continue;
      const halfAlong = (CAR_LENGTH_M / 2) * along + 0.9 * cross;
      const gap = a - selfHalfAlongM - halfAlong;
      if (gap > rangeM) continue;
      if (!best || gap < best.gap) best = { gap, v: c.v * (p.dirX * dirX + p.dirZ * dirZ) };
    }
    return best;
  }

  // --- population -----------------------------------------------------------

  private exitDir(h: HalfEdge): { x: number; z: number } {
    const e = this.g.edges[h.edge];
    const n = e.pts.length;
    const [dx, dz] = h.forward
      ? [e.pts[n - 2] - e.pts[n - 4], e.pts[n - 1] - e.pts[n - 3]]
      : [e.pts[0] - e.pts[2], e.pts[1] - e.pts[3]];
    const L = Math.hypot(dx, dz) || 1;
    return { x: dx / L, z: dz / L };
  }

  private entryDir(h: HalfEdge): { x: number; z: number } {
    const e = this.g.edges[h.edge];
    const n = e.pts.length;
    const [dx, dz] = h.forward
      ? [e.pts[2] - e.pts[0], e.pts[3] - e.pts[1]]
      : [e.pts[n - 4] - e.pts[n - 2], e.pts[n - 3] - e.pts[n - 1]];
    const L = Math.hypot(dx, dz) || 1;
    return { x: dx / L, z: dz / L };
  }

  /** Lanes for travel on a half-edge, right of travel, kerb first. */
  lanesOf(he: number): number[] {
    const e = this.g.edges[he >> 1];
    return lanesForTravel(laneLayoutCached(e), (he & 1) === 0);
  }

  /** Build (or fetch) one lane's path. */
  path(he: number, lane: number): LanePath {
    const key = he * 8 + lane;
    const have = this.paths.get(key);
    if (have) return have;
    const e = this.g.edges[he >> 1];
    const forward = (he & 1) === 0;
    const offset = this.lanesOf(he)[lane];
    const tail = forward ? e.a : e.b;
    const head = forward ? e.b : e.a;
    let sbT = this.nodeSetback[tail];
    let sbH = this.nodeSetback[head];
    // A short edge cannot give both ends their full stop line: share what it
    // has, keeping a metre of lane between them.
    const room = e.lengthM - 1;
    if (sbT + sbH > room) {
      const k = Math.max(0, room) / (sbT + sbH);
      sbT *= k;
      sbH *= k;
    }

    // Centreline in travel order, with its arc length, resampled every
    // BRIDGE_SAMPLE_M on a bridge so the deck's own profile is followed.
    const n = e.pts.length / 2;
    const cx: number[] = [];
    const cz: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = forward ? i : n - 1 - i;
      cx.push(e.pts[j * 2]);
      cz.push(e.pts[j * 2 + 1]);
    }
    const bridge = (e.flags & ROAD_BRIDGE) !== 0;
    const deck = bridge && this.world.deckOf ? this.world.deckOf(e.wayIndex) : null;
    let px = cx, pz = cz;
    if (deck) {
      px = [cx[0]]; pz = [cz[0]];
      for (let i = 1; i < cx.length; i++) {
        const L = Math.hypot(cx[i] - cx[i - 1], cz[i] - cz[i - 1]);
        const k = Math.max(1, Math.ceil(L / BRIDGE_SAMPLE_M));
        for (let m = 1; m <= k; m++) {
          px.push(cx[i - 1] + (cx[i] - cx[i - 1]) * (m / k));
          pz.push(cz[i - 1] + (cz[i] - cz[i - 1]) * (m / k));
        }
      }
    }
    // DROP THE SLIVERS first. OSM centrelines carry segments of a few
    // centimetres where two mapped ways were joined by hand, often at a wild
    // angle, and a fillet cannot round a corner its own segments are shorter
    // than: measured, a 0.2 m westward stub in a north-east street turned a
    // car 54 degrees in one frame. A vertex closer than SLIVER_M to the last
    // one kept is dropped; the end vertex always survives.
    if (px.length > 2) {
      const kx: number[] = [px[0]];
      const kz: number[] = [pz[0]];
      for (let i = 1; i < px.length; i++) {
        const last = i === px.length - 1;
        const d = Math.hypot(px[i] - kx[kx.length - 1], pz[i] - kz[kz.length - 1]);
        // Only a sliver that is also off the line to the next vertex by less
        // than SLIVER_DEV_M: dropping a real vertex of a curve moves the lane.
        let dev = 0;
        if (!last) {
          const ax = kx[kx.length - 1], az = kz[kz.length - 1];
          const bx = px[i + 1] - ax, bz = pz[i + 1] - az;
          const bl = Math.hypot(bx, bz) || 1;
          dev = Math.abs((px[i] - ax) * bz - (pz[i] - az) * bx) / bl;
        }
        // Under SLIVER_TINY_M a segment is dropped whatever its angle: it is a
        // digitising artefact, not a corner (the 54 degree stub was 0.2 m).
        if (d >= SLIVER_M || (dev > SLIVER_DEV_M && d >= SLIVER_TINY_M)) { kx.push(px[i]); kz.push(pz[i]); continue; }
        if (last) {
          // The end must survive. Replace the last kept vertex with it only
          // if that vertex is itself on the line from the one before to the
          // end; otherwise keep both and live with a short final segment.
          let devPrev = Infinity;
          if (kx.length > 1) {
            const ax = kx[kx.length - 2], az = kz[kz.length - 2];
            const bx = px[i] - ax, bz = pz[i] - az;
            const bl = Math.hypot(bx, bz) || 1;
            devPrev = Math.abs((kx[kx.length - 1] - ax) * bz - (kz[kz.length - 1] - az) * bx) / bl;
          }
          if (devPrev <= SLIVER_DEV_M) { kx[kx.length - 1] = px[i]; kz[kz.length - 1] = pz[i]; }
          else { kx.push(px[i]); kz.push(pz[i]); }
        }
      }
      px = kx;
      pz = kz;
    }

    // ROUND THE BENDS. A vertex inside an edge where the centreline turns is a
    // hinge, and a car following it pivots on the spot: measured, 90 degrees
    // in one frame on an L-shaped street with no junction at the corner. Each
    // such vertex is replaced by a quadratic fillet whose tangent points sit
    // back from it by up to 40% of the shorter neighbouring segment, so the
    // lane turns continuously. The radius is kept above the lane offset where
    // the segments allow it, which is what stops the offset folding back.
    if (px.length > 2) {
      const fx: number[] = [px[0]];
      const fz: number[] = [pz[0]];
      for (let i = 1; i < px.length - 1; i++) {
        const ax = px[i] - px[i - 1], az = pz[i] - pz[i - 1];
        const bx = px[i + 1] - px[i], bz = pz[i + 1] - pz[i];
        const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
        if (la < 1e-6 || lb < 1e-6) continue;
        const cos = (ax * bx + az * bz) / (la * lb);
        const th = Math.acos(Math.max(-1, Math.min(1, cos)));
        if (th < FILLET_MIN_RAD) { fx.push(px[i]); fz.push(pz[i]); continue; }
        const want = (Math.abs(offset) + 2.5) * Math.tan(th / 2);
        const T = Math.min(want, 0.4 * la, 0.4 * lb);
        const n = Math.max(2, Math.ceil(th / FILLET_STEP_RAD));
        const sx = px[i] - (ax / la) * T, sz = pz[i] - (az / la) * T;
        const ex = px[i] + (bx / lb) * T, ez = pz[i] + (bz / lb) * T;
        for (let q = 0; q <= n; q++) {
          const t = q / n, u = 1 - t;
          fx.push(u * u * sx + 2 * u * t * px[i] + t * t * ex);
          fz.push(u * u * sz + 2 * u * t * pz[i] + t * t * ez);
        }
      }
      fx.push(px[px.length - 1]);
      fz.push(pz[pz.length - 1]);
      px = fx;
      pz = fz;
    }
    const m = px.length;
    const arc = new Float64Array(m);
    for (let i = 1; i < m; i++) arc[i] = arc[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
    const total = arc[m - 1];
    const s0 = sbT;
    const s1 = Math.max(s0 + 0.5, total - sbH);

    // Offset with MITRE normals at the vertices, so the lane is one continuous
    // polyline rather than a run of offset segments with steps at each joint.
    const ox: number[] = [];
    const oz: number[] = [];
    const os: number[] = [];
    const segN = (i: number): [number, number] => {
      const dx = px[i + 1] - px[i], dz = pz[i + 1] - pz[i];
      const L = Math.hypot(dx, dz) || 1;
      return [-dz / L, dx / L]; // right of travel
    };
    const at = (s: number): [number, number] => {
      let i = 0;
      while (i < m - 2 && arc[i + 1] < s) i++;
      const L = arc[i + 1] - arc[i];
      const t = L > 1e-9 ? Math.min(1, Math.max(0, (s - arc[i]) / L)) : 0;
      const [nx, nz] = segN(i);
      return [px[i] + (px[i + 1] - px[i]) * t + nx * offset, pz[i] + (pz[i + 1] - pz[i]) * t + nz * offset];
    };
    const [ax, az] = at(s0);
    ox.push(ax); oz.push(az); os.push(s0);
    for (let i = 1; i < m - 1; i++) {
      // Not within 5 cm of either cut: the cut point already stands there.
      if (arc[i] <= s0 + 0.05 || arc[i] >= s1 - 0.05) continue;
      const [n0x, n0z] = segN(i - 1);
      const [n1x, n1z] = segN(i);
      let mx = n0x + n1x, mz = n0z + n1z;
      const mL = Math.hypot(mx, mz);
      if (mL < 1e-6) continue;
      mx /= mL; mz /= mL;
      // Mitre length, capped so a hairpin cannot throw the lane out of the road.
      const cosHalf = Math.max(0.5, mx * n0x + mz * n0z);
      ox.push(px[i] + mx * offset / cosHalf);
      oz.push(pz[i] + mz * offset / cosHalf);
      os.push(arc[i]);
    }
    const [bx, bz] = at(s1);
    ox.push(bx); oz.push(bz); os.push(s1);

    // An offset polyline folds back on itself on the inside of a bend tighter
    // than the offset: the mitre points overtake each other and a segment
    // runs BACKWARD. A car on it faced the wrong way (measured: 179 deg off its
    // centreline in the Loop). Drop any vertex whose segment does not advance
    // along the centreline direction it came from.
    for (let i = 1; i < ox.length; i++) {
      const dx = ox[i] - ox[i - 1], dz = oz[i] - oz[i - 1];
      const L = Math.hypot(dx, dz);
      const si = Math.min(m - 2, Math.max(0, (() => { let q = 0; while (q < m - 2 && arc[q + 1] < (os[i] + os[i - 1]) / 2) q++; return q; })()));
      const tx = px[si + 1] - px[si], tz = pz[si + 1] - pz[si];
      const tL = Math.hypot(tx, tz) || 1;
      if (L < 0.05 || (dx * tx + dz * tz) / (L * tL) < 0.5) {
        // Keep the end point; drop the interior one.
        const drop = i === ox.length - 1 ? i - 1 : i;
        if (drop <= 0) continue;
        ox.splice(drop, 1); oz.splice(drop, 1); os.splice(drop, 1);
        i = Math.max(0, drop - 1);
      }
    }

    const k = ox.length;
    const xs = new Float32Array(k), zs = new Float32Array(k), ys = new Float32Array(k), cum = new Float32Array(k);
    const lift = roadLiftM(e.flags, e.layer);
    for (let i = 0; i < k; i++) {
      xs[i] = ox[i];
      zs[i] = oz[i];
      if (i > 0) cum[i] = cum[i - 1] + Math.hypot(ox[i] - ox[i - 1], oz[i] - oz[i - 1]);
      if (deck) {
        // The deck is defined along the WAY; this edge starts startS into it
        // and is being driven forward or backward along it.
        const sEdge = forward ? os[i] : e.lengthM - os[i];
        ys[i] = deckYAt(deck, e.startS + Math.min(e.lengthM, Math.max(0, sEdge)));
      } else {
        ys[i] = this.world.heightAt(ox[i], oz[i]) + lift;
      }
    }
    const dirAt = (sq: number): [number, number] => {
      let i = 0;
      while (i < m - 2 && arc[i + 1] < sq) i++;
      const dx = px[i + 1] - px[i], dz = pz[i + 1] - pz[i];
      const L = Math.hypot(dx, dz) || 1;
      return [dx / L, dz / L];
    };
    const [sdx, sdz] = dirAt(s0 + 1e-3);
    const [edx, edz] = dirAt(s1 - 1e-3);
    const p: LanePath = {
      key, he, lane, offsetM: offset, xs, zs, ys, cum, length: cum[k - 1], cars: [],
      rivals: [], rivalVirt: [], rivalStamp: -1,
      startDirX: sdx, startDirZ: sdz, endDirX: edx, endDirZ: edz,
    };
    this.paths.set(key, p);
    this.pathKeysDirty = true;
    this.pathListDirty = true;
    return p;
  }

  /** Cars per lane on a fresh edge, at the hour's density. */
  private populate(e: number): void {
    const edge = this.g.edges[e];
    const perKm = (TRAFFIC_PER_KM_LANE[edge.cls] ?? 0) * this.densityScale;
    const frac = this.frac[edge.cls] ?? 1;
    for (let dir = 0; dir < (edge.oneway ? 1 : 2); dir++) {
      const he = e * 2 + dir;
      const lanes = this.lanesOf(he);
      for (let lane = 0; lane < lanes.length && lane < 8; lane++) {
        const p = this.path(he, lane);
        const want = (p.length / 1000) * perKm;
        const seed = (e * 16 + dir * 8 + lane) * 7.31;
        const n = Math.floor(want) + (hash1(seed * 1.7) < want - Math.floor(want) ? 1 : 0);
        // Even spread with jitter, never closer than a car and a jam gap.
        const pitch = p.length / Math.max(1, n);
        if (pitch < CAR_LENGTH_M + IDM_S0_M) continue;
        for (let k = 0; k < n; k++) {
          if (this.cars.length >= this.capacity) return;
          const h = hash1(seed * 3.1 + k * 1.37);
          const rank = hash1(seed * 13.9 + k * 2.71);
          // Placed at the peak, kept only if this hour has it out: thinning
          // by rank keeps the same cars on the street as the hour changes.
          if (rank >= frac) continue;
          const c = this.spawn(p, pitch * (k + 0.25 + 0.5 * h), seed + k, rank);
          if (c) c.scale = 1;
        }
      }
    }
  }

  /** Rebuild the body grid from every live car's current pose. */
  private rebuildBodies(): void {
    const grid = this.bodyGrid;
    grid.clear();
    const pose: Pose = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };
    for (const c of this.cars) {
      if (c.dead) continue;
      this.pose(c, pose);
      c.wx = pose.x; c.wz = pose.z; c.wdx = pose.dirX; c.wdz = pose.dirZ;
      this.binBody(c);
    }
  }

  private binBody(c: Vehicle): void {
    const k = Math.floor(c.wx / BODY_CELL_M) * 73856093 ^ Math.floor(c.wz / BODY_CELL_M) * 19349663;
    const b = this.bodyGrid.get(k);
    if (b) b.push(c); else this.bodyGrid.set(k, [c]);
  }

  /** True when a car body stands within `r` metres of (x, z). A car is never
   *  spawned on top of one on another path: a slip road beside a motorway, or
   *  the far lane of a junction, is somebody else's tarmac too. */
  private bodyNear(x: number, z: number, r: number): boolean {
    const cx0 = Math.floor(x / BODY_CELL_M), cz0 = Math.floor(z / BODY_CELL_M);
    for (let gx = -1; gx <= 1; gx++) {
      for (let gz = -1; gz <= 1; gz++) {
        const b = this.bodyGrid.get((cx0 + gx) * 73856093 ^ (cz0 + gz) * 19349663);
        if (!b) continue;
        for (const o of b) if (!o.dead && (o.wx - x) ** 2 + (o.wz - z) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  private spawn(p: LanePath, s: number, seed: number, rank: number): Vehicle | null {
    {
      const c0 = new Vehicle();
      c0.path = p;
      c0.s = s;
      const q = this.pose(c0, { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 });
      if (this.bodyNear(q.x, q.z, CAR_LENGTH_M + 1)) return null;
    }
    const c = new Vehicle();
    c.id = this.nextId++;
    c.path = p;
    c.s = s;
    const e = this.g.edges[p.he >> 1];
    c.cls = e.cls;
    c.roadCls = e.cls;
    c.temper = 0.85 + 0.25 * hash1(seed * 5.3);
    c.v0 = (TRAFFIC_SPEED_MS[e.cls] ?? 8) * c.temper;
    c.v = c.v0 * 0.7 * (this.speedScale[e.cls] ?? 1);
    c.tint = hash1(seed * 11.3);
    c.archetype = hash1(seed * 9.7);
    c.rank = rank;
    c.scale = 0;
    this.insert(p, c);
    this.plan(c);
    this.cars.push(c);
    const q = this.pose(c, { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 });
    c.wx = q.x; c.wz = q.z; c.wdx = q.dirX; c.wdz = q.dirZ;
    this.binBody(c);
    this.stats.spawned++;
    return c;
  }

  private insert(p: LanePath, c: Vehicle): void {
    const a = p.cars;
    let i = a.length;
    while (i > 0 && a[i - 1].s > c.s) i--;
    a.splice(i, 0, c);
  }

  private remove(p: LanePath, c: Vehicle): void {
    const i = p.cars.indexOf(c);
    if (i >= 0) p.cars.splice(i, 1);
  }

  /** Choose where the car goes at the end of its current path. */
  private plan(c: Vehicle): void {
    const p = c.path!;
    const here: HalfEdge = { edge: p.he >> 1, forward: (p.he & 1) === 0 };
    const node = this.g.head(here);
    const outs = this.g.out[node] ?? [];
    const d = this.exitDir(here);
    let total = 0;
    const cand: { h: HalfEdge; w: number; turn: number; lane: number }[] = [];
    for (const h of outs) {
      if (h.edge === here.edge) continue; // no U-turns
      if (!this.edgeOk[h.edge]) continue;
      if (!this.active.has(h.edge)) continue;
      const nd = this.entryDir(h);
      const turn = Math.atan2(nd.x * -d.z + nd.z * d.x, nd.x * d.x + nd.z * d.z) / DEG;
      if (Math.abs(turn) > 150) continue;
      // Mostly straight on; a right turn twice as likely as a left; a step
      // down into a service road rare.
      let w = Math.abs(turn) < 30 ? 6 : turn > 0 ? 2 : 1.2;
      const ne = this.g.edges[h.edge];
      if (ne.cls >= RoadClass.Service) w *= 0.15;
      // An exit that leads straight back to where this edge started is a
      // two-edge loop: a jughandle, a turnaround, a fragment of a roundabout.
      // Its capacity is two or three cars, and a car circling in it was the
      // seed of every deadlock the field ever had.
      if (this.g.head(h) === this.g.tail(here)) w *= 0.02;
      cand.push({ h, w, turn, lane: -1 });
      total += w;
    }
    if (!cand.length && laneLayoutCached(this.g.edges[here.edge]).widthM >= UTURN_MIN_WIDTH_M) {
      // A dead end inside the ring, wide enough to turn round in: do that,
      // as a driver does, rather than stopping at the end of the road.
      for (const h of outs) {
        if (h.edge === here.edge && h.forward !== here.forward && this.active.has(h.edge)) {
          cand.push({ h, w: 1, turn: -180, lane: -1 });
          total = 1;
        }
      }
    }
    // Which lane each exit is taken into, and whether a car can actually make
    // that turn: right turns into the kerb lane, left turns into the inside
    // one, straight on keeps its lane counted from the inside (so a lane that
    // drops at a junction does not funnel every car into the kerb). If the
    // connector into that lane is tighter than a car can turn, the nearest
    // lane that is not is used, and an exit with none is not an exit.
    const curLanes = this.lanesOf(p.he).length;
    total = 0;
    for (const k of cand) {
      const nhe = heOf(k.h);
      const nl = this.lanesOf(nhe).length;
      const want = k.turn > 30 ? 0 : k.turn < -30 ? nl - 1
        : Math.max(0, Math.min(nl - 1, nl - (curLanes - p.lane)));
      k.lane = -1;
      for (let d = 0; d < nl && k.lane < 0; d++) {
        for (const l of d === 0 ? [want] : [want - d, want + d]) {
          if (l < 0 || l >= nl) continue;
          if (this.drivable(p, this.path(nhe, l))) { k.lane = l; break; }
        }
      }
      if (k.lane < 0) k.w = 0;
      total += k.w;
    }
    if (!(total > 0)) {
      c.nextHe = -1;
      return;
    }
    let r = hash1(c.id * 0.917 + c.junctions * 3.77) * total;
    let pick = cand[cand.length - 1];
    for (const k of cand) {
      if (!(k.w > 0)) continue;
      pick = k;
      r -= k.w;
      if (r <= 0) break;
    }
    c.nextLane = pick.lane;
    c.nextHe = heOf(pick.h);
  }

  private drivableCache = new Map<number, boolean>();
  /**
   * Whether the connector between two lanes is one a car can drive: no cusp,
   * and nowhere tighter than MIN_TURN_RADIUS_M. Lanes that end on top of each
   * other at an acute junction otherwise produced connectors that looped
   * through 200 degrees in under a metre.
   */
  private drivable(from: LanePath, to: LanePath): boolean {
    const key = from.key * 2097152 + to.key;
    let ok = this.drivableCache.get(key);
    if (ok !== undefined) return ok;
    const k = this.connect(null as unknown as Vehicle, from, to);
    ok = true;
    let px = k.p0x, pz = k.p0z, pdx = from.endDirX, pdz = from.endDirZ;
    for (let q = 1; q <= 16 && ok; q++) {
      const t = q / 16, u = 1 - t;
      const x = u * u * u * k.p0x + 3 * u * u * t * k.c1x + 3 * u * t * t * k.c2x + t * t * t * k.p1x;
      const z = u * u * u * k.p0z + 3 * u * u * t * k.c1z + 3 * u * t * t * k.c2z + t * t * t * k.p1z;
      const dx = x - px, dz = z - pz;
      const ds = Math.hypot(dx, dz);
      if (ds > 1e-4) {
        const cos = (dx * pdx + dz * pdz) / ds;
        const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
        if (cos < 0 || ang / ds > 1 / MIN_TURN_RADIUS_M) ok = false;
        pdx = dx / ds; pdz = dz / ds;
      }
      px = x; pz = z;
    }
    // And it must arrive along the next lane, not across it.
    if (pdx * to.startDirX + pdz * to.startDirZ < 0.7) ok = false;
    if (this.drivableCache.size > 200000) this.drivableCache.clear();
    this.drivableCache.set(key, ok);
    return ok;
  }

  /** Build the connector from a car's current path end into its next path. */
  private connect(c: Vehicle, from: LanePath, to: LanePath): Connector {
    const i = from.xs.length - 1;
    const p0x = from.xs[i], p0z = from.zs[i], p0y = from.ys[i];
    const p1x = to.xs[0], p1z = to.zs[0], p1y = to.ys[0];
    // Tangent to the lane's own end segment where that is long enough to have
    // a direction, so the car does not turn as it leaves the lane; to the
    // centreline's where it is a stub.
    let d0x = from.endDirX, d0z = from.endDirZ;
    {
      const dx = from.xs[i] - from.xs[i - 1], dz = from.zs[i] - from.zs[i - 1];
      const L = Math.hypot(dx, dz);
      if (L > 0.5) { d0x = dx / L; d0z = dz / L; }
    }
    let d1x = to.startDirX, d1z = to.startDirZ;
    {
      const dx = to.xs[1] - to.xs[0], dz = to.zs[1] - to.zs[0];
      const L = Math.hypot(dx, dz);
      if (L > 0.5) { d1x = dx / L; d1z = dz / L; }
    }
    const chord = Math.hypot(p1x - p0x, p1z - p0z);
    // 0.39 of the chord on each handle is the cubic that best fits a quarter
    // circle through the same two points (0.552 of the radius), so a square
    // corner comes out as an arc and a straight crossing as a straight line.
    const h = chord * 0.39;
    const k: Connector = {
      p0x, p0z, p0y,
      c1x: p0x + d0x * h, c1z: p0z + d0z * h,
      c2x: p1x - d1x * h, c2z: p1z - d1z * h,
      p1x, p1z, p1y,
      length: 0,
      sharp: d0x * d1x + d0z * d1z < 0.5,
    };
    let len = 0, lx = p0x, lz = p0z;
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, u = 1 - t;
      const x = u * u * u * p0x + 3 * u * u * t * k.c1x + 3 * u * t * t * k.c2x + t * t * t * p1x;
      const z = u * u * u * p0z + 3 * u * u * t * k.c1z + 3 * u * t * t * k.c2z + t * t * t * p1z;
      len += Math.hypot(x - lx, z - lz);
      lx = x; lz = z;
    }
    k.length = Math.max(0.05, len);
    void c;
    return k;
  }

  // --- the step -------------------------------------------------------------

  private idm(v: number, v0: number, gap: number, dv: number): number {
    const sStar = IDM_S0_M + Math.max(0, v * IDM_T_S + (v * dv) / (2 * Math.sqrt(IDM_A * IDM_B)));
    const g = Math.max(0.1, gap);
    const r = v / Math.max(0.1, v0);
    const free = 1 - (r * r) * (r * r);
    return IDM_A * (free - (sStar / g) * (sStar / g));
  }

  private substep(dt: number): void {
    this.time += dt;
    const pl = this.player;
    const pose: Pose = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };

    // BODIES, in world space. Lanes keep cars apart only within a lane; two
    // OSM ways that run side by side into a merge (a slip road onto a
    // motorway) and two streams crossing on a junction box are different
    // lanes on the same tarmac. Measured before this: 322 overlapping pairs
    // outside junctions in the Loop ring over 80 s, all of them merges. Every
    // car is binned on an 8 m grid and checks the bodies ahead of it.
    this.rebuildBodies();
    const grid = this.bodyGrid;

    // MERGES. The front car of every path is about to enter its next path,
    // and two of them (two lanes funnelling into one, a turn and a straight
    // into the same lane) can be aiming at it together. Each sees the others
    // in the next path's own frame, so they zip rather than arrive side by
    // side: measured before this, two cars entered a one-metre lane in the same
    // frame and drove the next block inside each other.
    const stamp = ++this.stamp;
    const list = this.pathArray();
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi];
      const a = p.cars;
      if (!a.length) continue;
      const c = a[a.length - 1];
      if (c.dead || c.nextHe < 0) continue;
      // A car held at its own red is not a rival: it is not going anywhere,
      // and waiting for it held the green approach for the whole red.
      if (c.s >= 0 && c.v < 2 && this.signalAt(p.he) === 2) continue;
      const np = this.paths.get(c.nextHe * 8 + c.nextLane);
      if (!np) continue;
      if (np.rivalStamp !== stamp) {
        np.rivalStamp = stamp;
        np.rivals.length = 0;
        np.rivalVirt.length = 0;
      }
      np.rivals.push(c);
      np.rivalVirt.push(-(p.length - c.s) - this.connLength(p, np));
    }

    // Accelerations first, from a consistent snapshot, then integrate. A car
    // reads its leader's state from BEFORE this substep either way.
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi];
      const a = p.cars;
      for (let k = a.length - 1; k >= 0; k--) {
        const c = a[k];
        if (c.dead) continue;
        const v0 = c.v0 * (this.speedScale[c.roadCls] ?? 1) * (c.s < 0 && c.conn !== null && c.conn.sharp ? TURN_SPEED_MS / c.v0 : 1);
        let gap = Infinity;
        let lv = 0;
        // The car in front on this path.
        if (k + 1 < a.length) {
          const l = a[k + 1];
          gap = l.s - c.s - CAR_LENGTH_M;
          lv = l.v;
        } else if (c.nextHe >= 0) {
          // Nobody ahead on this path: look into the next one, at the last
          // car already on it or on a connector into it.
          const np = this.paths.get(c.nextHe * 8 + c.nextLane);
          let ls = Infinity;
          let lvv = 0;
          const virt = -(p.length - c.s) - (np ? this.connLength(p, np) : 0);
          if (np && np.cars.length) {
            // l.s < 0 is measured from the far end of ITS connector, which is
            // the same point (the next path's start), so one frame holds both.
            ls = np.cars[0].s;
            lvv = np.cars[0].v;
          }
          // Another path's front car aiming at the same lane, ahead of this
          // one in that lane's frame (ties go to the lower id).
          if (np && np.rivalStamp === stamp) {
            for (let ri = 0; ri < np.rivals.length; ri++) {
              const rc = np.rivals[ri];
              if (rc === c) continue;
              const rv = np.rivalVirt[ri];
              if (rv > virt || (rv === virt && rc.id < c.id)) {
                if (rv < ls) { ls = rv; lvv = rc.v; }
              }
            }
          }
          if (np && ls !== Infinity) {
            const l = { s: ls, v: lvv };
            gap = l.s - virt - CAR_LENGTH_M;
            lv = l.v;
            // KEEP THE BOX CLEAR. With no room for a whole car past the far
            // side of the junction, wait at this stop line instead of on the
            // crossing. Without this the Loop locked solid in under a minute:
            // a car queued on the junction box stops the cross street, whose
            // queue backs into the next box, and four of those round a block
            // is a cycle nobody can leave.
            if (c.s >= 0 && l.s < CAR_LENGTH_M + IDM_S0_M + 1) {
              const toLine = p.length - c.s - CAR_LENGTH_M / 2;
              if (toLine > -0.5 && toLine < gap) {
                gap = Math.max(0, toLine);
                lv = 0;
              }
            }
          }
        } else {
          // Nowhere to go: the rim of the populated ring, or a dead end too
          // narrow to turn round in. Pull up at the end and leave the road
          // there, shrinking out like a quiet hour, rather than vanishing
          // mid-stride or turning on the spot.
          const toEnd = p.length - c.s - CAR_LENGTH_M / 2;
          if (toEnd < gap) {
            gap = Math.max(0, toEnd);
            lv = 0;
          }
          if (toEnd < IDM_S0_M + 1.5 && c.v < 0.5) c.rank = 2;
        }
        // The light, for a car still short of its stop line.
        if (c.s >= 0) {
          const sig = this.signalAt(p.he);
          if (sig !== null && sig !== 0) {
            const toLine = p.length - c.s - CAR_LENGTH_M / 2;
            const need = (c.v * c.v) / (2 * Math.max(0.5, toLine));
            // Amber: stop if it can be done comfortably, go if it cannot.
            // Red: stop unless already committed over the line.
            const stop = sig === 2 ? toLine > -0.5 && need < AMBER_COMMIT_DECEL * 1.6 : need < AMBER_COMMIT_DECEL;
            if (stop && toLine < gap) {
              gap = Math.max(0, toLine);
              lv = 0;
            }
          }
        }
        // Other bodies ahead, on other paths. A car yields to one in its
        // band unless that one also has it in ITS band and has priority (the
        // lower id): crossing streams take turns rather than both stopping.
        {
          const cx0 = Math.floor(c.wx / BODY_CELL_M), cz0 = Math.floor(c.wz / BODY_CELL_M);
          const look = Math.min(gap, 6 + c.v * 1.5);
          for (let gx = -1; gx <= 1; gx++) {
            for (let gz = -1; gz <= 1; gz++) {
              const b = grid.get((cx0 + gx) * 73856093 ^ (cz0 + gz) * 19349663);
              if (!b) continue;
              for (const o of b) {
                if (o === c || o.path === c.path || o.dead || o.scale < 0.5) continue;
                const rx = o.wx - c.wx, rz = o.wz - c.wz;
                const ahead = rx * c.wdx + rz * c.wdz;
                // Down to half a car behind level: two cars arriving side by
                // side on overlapping tarmac are each "ahead" of the other.
                if (ahead <= -CAR_LENGTH_M / 2 || ahead > look + CAR_LENGTH_M) continue;
                const lat = Math.abs(rx * -c.wdz + rz * c.wdx);
                const cross = Math.abs(o.wdx * -c.wdz + o.wdz * c.wdx);
                const along = Math.abs(o.wdx * c.wdx + o.wdz * c.wdz);
                const band = 0.9 + 0.9 * along + (CAR_LENGTH_M / 2) * cross + BODY_MARGIN_M;
                if (lat > band) continue;
                // Does it have us in its band too? Then one of the two goes
                // first: the one further along when they are running the same
                // way, else (and on a tie) the lower id.
                const aheadO = -(rx * o.wdx + rz * o.wdz);
                const latO = Math.abs(rx * o.wdz - rz * o.wdx);
                if (aheadO > -CAR_LENGTH_M / 2 && latO < band) {
                  // Head on (bad geometry, two ways drawn over each other):
                  // nobody has priority and both stop; the deadlock valve
                  // takes one of them off the road.
                  const same = o.wdx * c.wdx + o.wdz * c.wdz;
                  if (same > -0.5) {
                    const mine = same >= 0.5 && Math.abs(ahead - aheadO) > 0.5
                      ? aheadO > ahead
                      : c.id < o.id;
                    if (mine) continue;
                  }
                }
                const og = ahead - CAR_LENGTH_M / 2 - (CAR_LENGTH_M / 2) * along - 0.9 * cross;
                // Already inside each other (two ways drawn over one another
                // meeting head on, where nobody can back out): the younger car
                // leaves the road, shrinking out, rather than both standing
                // there intersecting until the deadlock valve fires.
                if ((og < -1 || (og < 0 && o.wdx * c.wdx + o.wdz * c.wdz < -0.5)) && c.id > o.id) c.rank = 2;
                if (og < gap) {
                  gap = og;
                  lv = Math.max(0, o.v * (o.wdx * c.wdx + o.wdz * c.wdz));
                }
              }
            }
          }
        }
        // The player, in world space, so it works in a lane, across a lane,
        // and on the junction box alike.
        if (pl) {
          this.pose(c, pose);
          const rx = pl.x - pose.x, rz = pl.z - pose.z;
          if (rx * rx + rz * rz < 70 * 70) {
            const ahead = rx * pose.dirX + rz * pose.dirZ;
            const lat = Math.abs(rx * -pose.dirZ + rz * pose.dirX);
            const cross = Math.abs(pl.dirX * -pose.dirZ + pl.dirZ * pose.dirX);
            const along = Math.abs(pl.dirX * pose.dirX + pl.dirZ * pose.dirZ);
            const halfAcross = 0.9 * along + (CAR_LENGTH_M / 2) * cross;
            // 0.9 of our own half width, plus theirs projected, plus a margin
            // a driver would leave for someone wandering out of their lane.
            if (ahead > 0 && lat < 0.9 + halfAcross + 0.5) {
              const halfAlong = (CAR_LENGTH_M / 2) * along + 0.9 * cross;
              const pg = ahead - CAR_LENGTH_M / 2 - halfAlong;
              if (pg < gap) {
                gap = pg;
                lv = Math.max(0, pl.speed * (pl.dirX * pose.dirX + pl.dirZ * pose.dirZ));
              }
            }
          }
        }
        const acc = gap === Infinity
          ? IDM_A * (1 - (c.v / Math.max(0.1, v0)) ** 4)
          : this.idm(c.v, v0, gap, c.v - lv);
        const accC = Math.max(-9, acc);
        let nv = Math.max(0, c.v + accC * dt);
        // The hard floor: never close the gap past HARD_GAP_M in one step.
        if (gap !== Infinity) {
          const maxAdvance = Math.max(0, gap - HARD_GAP_M);
          if (nv * dt > maxAdvance) nv = maxAdvance / dt;
        }
        c.brake = accC < -0.8 || (nv < 0.3 && gap < 12) ? 1 : 0;
        c.v = nv;
        c.stoppedS = nv < 0.3 ? c.stoppedS + dt : 0;
      }
    }

    // Integrate, and move cars that crossed the end of their path on.
    const movers: Vehicle[] = [];
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi];
      for (const c of p.cars) {
        if (c.dead) continue;
        c.s += c.v * dt;
        if (c.s > p.length) movers.push(c);
      }
    }
    for (const c of movers) this.advance(c);

    // Visibility: grow in after a spawn, shrink out when the hour thins.
    for (const c of this.cars) {
      const f = this.frac[c.cls] ?? 1;
      // THE DEADLOCK VALVE. A minute stood still is longer than any red light
      // (28 s) and any queue that is moving at all, so a car that has done it
      // is in a jam that has stopped resolving itself: four full lanes round a
      // block, or a loop too small for the cars in it. It leaves the road, the
      // same shrink as a quiet hour, and the jam unpicks from that gap. Twice
      // as patient within sight of the camera.
      let stuck = c.stoppedS > 60;
      if (stuck && this.player && c.stoppedS < 120) {
        this.pose(c, pose);
        stuck = (pose.x - this.player.x) ** 2 + (pose.z - this.player.z) ** 2 > 80 * 80;
      }
      const want = c.rank < f && !stuck ? 1 : 0;
      c.scale += Math.max(-dt * 1.5, Math.min(dt * 1.5, want - c.scale));
      if (want === 0 && c.scale <= 0) c.dead = true;
    }
    this.sweepDead();
  }

  private connLen = new Map<number, number>();
  private stamp = 0;
  private readonly bodyGrid = new Map<number, Vehicle[]>();
  private pathList: LanePath[] = [];
  private pathListDirty = true;
  private targetCache = 0;
  private targetAge = Infinity;

  /** The live paths as an array, for the hot loops: a Map iterator per loop
   *  per substep was a measurable share of the step. */
  private pathArray(): LanePath[] {
    if (this.pathListDirty) {
      this.pathList = [...this.paths.values()];
      this.pathListDirty = false;
    }
    return this.pathList;
  }
  private connLength(from: LanePath, to: LanePath): number {
    const key = from.key * 2097152 + to.key;
    let l = this.connLen.get(key);
    if (l === undefined) {
      l = this.connect(null as unknown as Vehicle, from, to).length;
      if (this.connLen.size > 50000) this.connLen.clear();
      this.connLen.set(key, l);
    }
    return l;
  }

  private advance(c: Vehicle): void {
    const from = c.path!;
    if (c.nextHe < 0 || !this.active.has(c.nextHe >> 1)) {
      // Off the populated graph, or a dead end: recycle it into a lane far
      // from the camera so the ring does not drain.
      this.recycle(c);
      return;
    }
    const to = this.path(c.nextHe, c.nextLane);
    const over = c.s - from.length;
    this.remove(from, c);
    c.conn = this.connect(c, from, to);
    c.path = to;
    c.s = -c.conn.length + over;
    c.seg = 0;
    c.junctions++;
    c.roadCls = this.g.edges[to.he >> 1].cls;
    c.v0 = (TRAFFIC_SPEED_MS[c.roadCls] ?? 8) * c.temper;
    this.insert(to, c);
    this.plan(c);
    if (c.s > to.length) c.s = to.length;
  }

  private recycle(c: Vehicle): void {
    const from = c.path!;
    this.remove(from, c);
    c.dead = true;
    this.stats.recycled++;
  }

  /**
   * Keep the populated ring at its target: replace what was recycled or
   * thinned at the START of a lane far from the camera, where it grows in
   * unseen. A few per call, so a scrub to rush hour fills over a second or two.
   */
  private maintainPopulation(): void {
    if (!this.paths.size) return;
    // The same count `populate` places, so a ring that has only recycled what
    // it placed is exactly at target and spawns nothing.
    // Recounted about once a second: the hour moves slowly and the ring only
    // when the camera crosses a seventh of it.
    if (this.pathListDirty || ++this.targetAge > 30) {
      let target = 0;
      for (const p of this.pathArray()) {
        const cls = this.g.edges[p.he >> 1].cls;
        const perKm = (TRAFFIC_PER_KM_LANE[cls] ?? 0) * this.densityScale;
        const want = (p.length / 1000) * perKm;
        if (p.length / Math.max(1, Math.round(want)) < CAR_LENGTH_M + IDM_S0_M) continue;
        target += want * (this.frac[cls] ?? 1);
      }
      this.targetCache = Math.min(this.capacity, target);
      this.targetAge = 0;
    }
    const target = this.targetCache;
    let budget = 24;
    if (this.pathKeysDirty) {
      this.pathKeys = [...this.paths.keys()];
      this.pathKeysDirty = false;
    }
    const keys = this.pathKeys;
    const far2 = (this.ringR * 0.7) ** 2;
    for (let tries = 0; tries < 200 && budget > 0 && this.cars.length < target; tries++) {
      this.respawnCursor = (this.respawnCursor + 7919) % keys.length;
      const p = this.paths.get(keys[this.respawnCursor]);
      if (!p || p.length < 2 * CAR_LENGTH_M) continue;
      const dx = p.xs[0] - this.ringX, dz = p.zs[0] - this.ringZ;
      if (dx * dx + dz * dz < far2) continue;
      if (p.cars.length && p.cars[0].s < CAR_LENGTH_M + IDM_S0_M + 4) continue;
      const cls = this.g.edges[p.he >> 1].cls;
      const f = this.frac[cls] ?? 1;
      if (!(f > 0)) continue;
      const seed = this.nextId * 1.618 + 0.5;
      this.spawn(p, 0, seed, hash1(seed * 13.9) * f * 0.98);
      budget--;
    }
  }

  private sweepDead(): void {
    let w = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.dead) {
        if (c.path) {
          const k = c.path.cars.indexOf(c);
          if (k >= 0) c.path.cars.splice(k, 1);
        }
        continue;
      }
      this.cars[w++] = c;
    }
    this.cars.length = w;
  }
}
