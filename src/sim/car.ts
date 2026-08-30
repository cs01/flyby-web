// The car: a third machine, constrained to the driveable graph.
//
// WHY IT IS ON A RAIL AND NOT A FREE BODY. A free-body car needs kerbs, walls,
// verges and a recovery for every way it can end up somewhere it should not be,
// and this world has none of those: the only thing that knows where tarmac is
// is a centreline and a width. A free body over that data spends its life
// half-embedded in a building or coasting across the Bay, and every fix is a
// new invisible collider. Constraining the car to the centreline and giving it
// LATERAL FREEDOM inside the carriageway keeps the one property that matters
// (the car is on the road, always) and still leaves the two inputs a driver
// actually notices: how fast, and which way at the junction.
//
// So this is a rail with a metre and a half of play in it. You steer WITHIN
// the carriageway, and at a junction the steering picks the exit: hold right
// and you take the right turn, hold nothing and you go straight on. That is
// how it reads from the seat, and it is what makes "the car never leaves the
// road surface" an invariant of the model rather than a hope about a collider.
//
// MOMENTUM AND FEEL. Same rules as sim/drone.ts. Steering and throttle come
// through `rateLimit` from sim/touch.ts, never through an exponential filter: a
// filter never arrives and reads as lag. Nothing here integrates a per-frame
// multiply, so a 30 Hz laptop and a 240 Hz monitor drive the same.
//
// The camera heading is rate-limited toward the road's tangent, while the
// POSITION uses the tangent directly. That split is deliberate. A junction in
// OSM is a hinge: two edges meet at a vertex and the tangent changes by ninety
// degrees in one frame. Turning the camera at 220 deg/s rounds that off into a
// turn you can see happen, while leaving the lane offset on the true tangent
// keeps the car inside its own carriageway through the corner rather than
// swinging wide while the camera catches up.

import * as THREE from "three";
import { rateLimit } from "./touch";
import { RoadIndex } from "../data/trees";
import { laneOffsetM, type RoadEdge, type RoadGraph, type HalfEdge } from "../data/roadgraph";
import { roadWidthM, roadLiftM, ROAD_BRIDGE } from "../data/roadpack";

const DEG = Math.PI / 180;

/** Metres per second at full throttle, and with boost held. */
export const CAR_TOP_SPEED = 22;
export const CAR_BOOST_SPEED = 40;
/** Reverse is for getting out of a cul-de-sac, not for driving. */
export const CAR_REVERSE_SPEED = 6;

/** Metres per second per second, under power and on the brakes. */
const ACCEL = 6.5;
const BRAKE = 11;
/** Coasting: what the road takes back with nothing pressed. Gentler than the
 *  brakes, so lifting off is a lift-off and not a stop. */
const DRAG = 2.2;

/**
 * Speed the car is held to through a junction turn sharper than TURN_ANGLE_DEG.
 *
 * Not a physical grip model. It exists because a rail has no grip limit at all,
 * so without it a car takes a right angle at 80 km/h with the camera snapping
 * round, which is the single thing that most stops this reading as driving.
 */
const TURN_SPEED = 9;
const TURN_ANGLE_DEG = 55;

/** Eye height above the carriageway, in metres. A saloon's, near enough. */
export const CAR_EYE_HEIGHT_M = 1.5;

/**
 * Camera near plane while driving, in metres.
 *
 * The scene's 2 m near plane is set by the aircraft's nose (see
 * render/renderer.ts) and it is too far out for an eye at 1.5 m: looking down
 * the road it is fine, but at a downward pitch the ground under the lens falls
 * inside it and the bottom of the frame becomes a hole with the sky through it.
 * At 1.2 m, with the look pitch limited below, the nearest visible ground is
 * always outside the plane.
 *
 * It costs depth precision, and only while driving: the buffer is good to
 * roughly z^2 * 5e-8 metres here against z^2 * 3e-8 before, which is still
 * sub-millimetre at 100 m and goes from about 3 m to 5 m of slop at 10 km. From
 * a car, 10 km away is behind the buildings at the end of the street.
 */
export const CAR_NEAR_PLANE_M = 1.2;

/** Degrees the driver may look up or down. See CAR_NEAR_PLANE_M. */
export const CAR_PITCH_LIMIT = 35;
/** Degrees the driver may look either side without turning the car. */
const LOOK_YAW_LIMIT = 160;

/** Half the car's track, in metres. It never puts a wheel over the kerb. */
export const CAR_HALF_WIDTH_M = 0.9;

/** Metres per second sideways at full lock, once up to STEER_SPEED_M. */
const LATERAL_MS = 2.6;
/** And how fast it drifts back to the lane centre with the wheel released. */
const RECENTRE_MS = 1.4;
/** Speed at which full steering authority is available. A stationary car does
 *  not move sideways, which is also what stops the lane offset being steerable
 *  while parked. */
const STEER_SPEED_M = 5;

/** Degrees per second the camera heading follows the road tangent. */
const YAW_RATE_DEG = 220;
/** Degrees of body slip drawn from the lateral rate. Cosmetic, like the drone's
 *  bank: it is what says the car is changing lane rather than sliding. */
const MAX_SLIP_DEG = 16;

/** How far from the camera a road may be and still be worth getting into. */
export const CAR_ENTRY_SEARCH_M = 400;

/**
 * Degrees of extra "turn" that one step DOWN the road class costs at a junction.
 *
 * Measured need: without it a drive down Market Street took a hard right into a
 * twelve-metre one-way service aisle, dead-ended, and sat there. A driver
 * holding the wheel over wants the next STREET, not the next opening in the
 * kerb, and the class order in roadpack.ts already ranks those. Going UP in
 * class is free: coming out of an alley onto an avenue needs no encouragement.
 */
const CLASS_PENALTY_DEG = 14;

/**
 * And what an exit with nothing beyond it costs.
 *
 * Bigger than any turn, so a dead end is taken only when every arm of the
 * junction is one. This is a driver's own one-step lookahead: you can see that
 * the road you are about to turn into stops, so you do not turn into it.
 */
const DEAD_END_PENALTY_DEG = 400;

/** Edges one frame may cross. A 200 m step across 5 m edges is 40; the cap is
 *  a guard against a zero-length edge cycle, not a budget. */
const MAX_EDGE_STEPS = 256;

export interface CarInput {
  /** -1..1, positive accelerates, negative brakes and then reverses. */
  throttle: number;
  /** -1..1, positive steers right. */
  steer: number;
  /** 0..1 */
  boost: number;
  /** Degrees of look asked for by a mouse this frame; see DroneInput. */
  lookYawDeg: number;
  lookPitchDeg: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Compass heading, degrees clockwise from north, of a local ENU direction. */
function headingOf(dx: number, dz: number): number {
  return (Math.atan2(dx, -dz) / DEG + 360) % 360;
}

/** Signed turn from one direction to another, degrees, positive to the right. */
function turnBetween(ax: number, az: number, bx: number, bz: number): number {
  // Right of a heading (dx, dz) is (-dz, dx): north (0,-1) gives east (1,0).
  const along = bx * ax + bz * az;
  const across = bx * -az + bz * ax;
  return Math.atan2(across, along) / DEG;
}

export interface CarStats {
  edges: number;
  nodes: number;
  junctions: number;
  indexedSegments: number;
  buildMs: number;
}

/** Where on the network the car is. */
interface Where {
  half: HalfEdge;
  /** Metres from the tail of that half-edge. */
  s: number;
}

export class Car {
  /** The contact patch: the carriageway surface, not the eye. */
  readonly position = new THREE.Vector3();
  /** Compass heading the body is pointing, degrees clockwise from north. */
  headingDeg = 0;
  /** Metres per second along the road. Negative is reversing. */
  speed = 0;
  /** True when the road ran out and there was nowhere legal to go. */
  stalled = false;

  private readonly graph: RoadGraph;
  private readonly index: RoadIndex;
  readonly stats: CarStats;

  /** Null until `enterFrom` finds a road. */
  private where: Where | null = null;
  /** Lateral offset from the LANE centre, positive right of travel. */
  private q = 0;
  private steerAxis = 0;
  private throttleAxis = 0;
  /** Free look, relative to the body. */
  private lookYaw = 0;
  private lookPitch = 0;
  /** Cosmetic, from the lateral rate. */
  private slipDeg = 0;
  /** Speed ceiling imposed by the last junction turn, decayed back to top. */
  private cornerLimit = Infinity;

  constructor(graph: RoadGraph) {
    const t0 = Date.now();
    this.graph = graph;
    // The one spatial index, generalised rather than duplicated: the same class
    // data/trees.ts keeps trees off the carriageway answers which carriageway a
    // car is standing on. A pad of zero is right here because the query carries
    // its own search radius; the pad only decides how far a segment is
    // registered beyond its own bounding box.
    this.index = new RoadIndex(graph.edges, () => 0, 32);
    this.stats = {
      edges: graph.edges.length,
      nodes: graph.nodeCount,
      junctions: graph.stats.junctions,
      indexedSegments: this.index.segments,
      buildMs: Date.now() - t0,
    };
  }

  /** False when this city has no driveable road at all. */
  get hasRoads(): boolean {
    return this.graph.edges.length > 0;
  }

  /** The edge being driven, or null before the car has entered a road. */
  get edge(): RoadEdge | null {
    return this.where ? this.graph.edges[this.where.half.edge] : null;
  }

  /** Carriageway width of the road under the car, in metres. */
  get carriagewayWidthM(): number {
    const e = this.edge;
    return e ? roadWidthM(e.cls, e.lanes, e.flags) : 0;
  }

  /** Distance from the centreline of the road being driven, positive right of
   *  travel. Lane offset included; this is where the car actually is. */
  get lateralM(): number {
    const e = this.edge;
    if (!e) return 0;
    return this.clampLateral(laneOffsetM(e) + this.q, e);
  }

  /** Eye point for the camera. */
  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + CAR_EYE_HEIGHT_M, this.position.z);
  }

  /** Where the driver is looking: body heading plus the free look. */
  orientation(out: THREE.Quaternion): THREE.Quaternion {
    return out.setFromEuler(
      new THREE.Euler(
        this.lookPitch * DEG,
        -(this.headingDeg + this.lookYaw) * DEG,
        // Slip leans the view into the lane change, which is the same cosmetic
        // trick the drone's bank is and for the same reason.
        -this.slipDeg * 0.25 * DEG,
        "YXZ",
      ),
    );
  }

  /**
   * Get in, at the nearest road to `position`, pointing the way `headingDeg`
   * was already pointing and carrying whatever of `velocity` the road can use.
   *
   * Returns false when there is no road within CAR_ENTRY_SEARCH_M, which is the
   * caller's cue to say so rather than to drop a car into the sea.
   */
  enterFrom(
    position: THREE.Vector3,
    headingDeg: number,
    velocity: THREE.Vector3,
    heightAt: (x: number, z: number) => number,
  ): boolean {
    const hit = this.index.nearestSegment(position.x, position.z, CAR_ENTRY_SEARCH_M);
    if (!hit) return false;

    const edge = this.graph.edges[hit.road];
    const s = this.arcLengthTo(edge, hit.segment, hit.x, hit.z);

    // Which way round. A one-way has one legal answer whatever the aeroplane
    // was doing; a two-way takes whichever direction the nose was nearer.
    const hx = Math.sin(headingDeg * DEG);
    const hz = -Math.cos(headingDeg * DEG);
    const forward = edge.oneway || hx * hit.dirX + hz * hit.dirZ >= 0;

    this.where = { half: { edge: hit.road, forward }, s: forward ? s : edge.lengthM - s };
    this.q = 0;
    this.steerAxis = 0;
    this.throttleAxis = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.slipDeg = 0;
    this.stalled = false;
    this.cornerLimit = Infinity;

    const dir = this.direction();
    // Inherited momentum, projected onto the road, so arriving at 40 m/s in a
    // Cessna rolls to a stop down the street instead of stopping dead. Only the
    // component along the road survives, which is the honest projection: a car
    // cannot use the part of an aeroplane's velocity that pointed at a wall.
    this.speed = clamp(velocity.x * dir.x + velocity.z * dir.z, 0, CAR_TOP_SPEED);
    this.headingDeg = headingOf(dir.x, dir.z);
    this.place(heightAt);
    return true;
  }

  update(input: CarInput, dt: number, heightAt: (x: number, z: number) => number): void {
    if (!(dt > 0) || !this.where) return;

    // --- Controls ---------------------------------------------------------
    // Rate-limited, never filtered. A key is a step function and a one-frame
    // tap would otherwise be full lock; see sim/touch.ts.
    this.steerAxis = rateLimit(this.steerAxis, clamp(input.steer, -1, 1), dt);
    this.throttleAxis = rateLimit(this.throttleAxis, clamp(input.throttle, -1, 1), dt);

    this.lookYaw = clamp(this.lookYaw + input.lookYawDeg, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
    this.lookPitch = clamp(this.lookPitch + input.lookPitchDeg, -CAR_PITCH_LIMIT, CAR_PITCH_LIMIT);

    // --- Speed ------------------------------------------------------------
    const boost = clamp(input.boost, 0, 1);
    const top = Math.min(
      THREE.MathUtils.lerp(CAR_TOP_SPEED, CAR_BOOST_SPEED, boost),
      this.cornerLimit,
    );
    const want = this.throttleAxis >= 0
      ? this.throttleAxis * top
      : this.throttleAxis * CAR_REVERSE_SPEED;
    const idle = Math.abs(this.throttleAxis) < 0.02;
    const rate = idle ? DRAG : want > this.speed ? ACCEL : BRAKE;
    this.speed += clamp(want - this.speed, -rate * dt, rate * dt);
    if (this.speed > top) this.speed = Math.max(top, this.speed - BRAKE * dt);
    // The corner limit is released as the car straightens up, over about a
    // second, so a turn does not leave a speed cap hanging over the next
    // straight.
    if (this.cornerLimit < Infinity) this.cornerLimit += ACCEL * dt;
    if (this.cornerLimit > CAR_BOOST_SPEED) this.cornerLimit = Infinity;

    // --- Along the road ---------------------------------------------------
    this.advance(this.speed * dt);

    // --- Across the road --------------------------------------------------
    const edge = this.graph.edges[this.where.half.edge];
    const authority = Math.min(1, Math.abs(this.speed) / STEER_SPEED_M)
      * (this.speed < 0 ? -1 : 1);
    let lateralRate = this.steerAxis * LATERAL_MS * authority;
    if (Math.abs(this.steerAxis) < 0.02) {
      // Hands off, the car finds the middle of its lane again.
      const back = -Math.sign(this.q) * Math.min(Math.abs(this.q) / Math.max(dt, 1e-3), RECENTRE_MS);
      lateralRate = back * Math.min(1, Math.abs(this.speed) / STEER_SPEED_M);
    }
    this.q += lateralRate * dt;
    // Re-derived from the clamped result rather than clamped in place, so the
    // offset cannot wind up against the kerb and then take a second of steering
    // to unwind.
    const lane = laneOffsetM(edge);
    this.q = this.clampLateral(lane + this.q, edge) - lane;

    // --- Attitude ---------------------------------------------------------
    const dir = this.direction();
    const tangentDeg = (headingOf(dir.x, dir.z) + (this.speed < 0 ? 180 : 0)) % 360;
    this.headingDeg = (stepAngle(this.headingDeg, tangentDeg, YAW_RATE_DEG * dt) + 360) % 360;
    const slipWant = clamp(
      (Math.atan2(lateralRate, Math.max(2, Math.abs(this.speed))) / DEG),
      -MAX_SLIP_DEG,
      MAX_SLIP_DEG,
    );
    this.slipDeg = stepAngle(this.slipDeg, slipWant, YAW_RATE_DEG * dt);

    this.place(heightAt);
  }

  // --- geometry -------------------------------------------------------------

  /** Unit direction of travel at the current point. */
  private direction(): { x: number; z: number } {
    const w = this.where!;
    const e = this.graph.edges[w.half.edge];
    const n = e.pts.length / 2;
    // Arc length walk in the stored order, then flipped if travelling b -> a.
    const s = w.half.forward ? w.s : e.lengthM - w.s;
    let acc = 0;
    for (let v = 1; v < n; v++) {
      const dx = e.pts[v * 2] - e.pts[(v - 1) * 2];
      const dz = e.pts[v * 2 + 1] - e.pts[(v - 1) * 2 + 1];
      const len = Math.hypot(dx, dz);
      if (acc + len >= s || v === n - 1) {
        const k = len > 0 ? 1 / len : 0;
        const sign = w.half.forward ? 1 : -1;
        return { x: dx * k * sign, z: dz * k * sign };
      }
      acc += len;
    }
    return { x: 0, z: -1 };
  }

  /** The centreline point at the current arc length. */
  private centreline(): { x: number; z: number } {
    const w = this.where!;
    const e = this.graph.edges[w.half.edge];
    const n = e.pts.length / 2;
    const s = clamp(w.half.forward ? w.s : e.lengthM - w.s, 0, e.lengthM);
    let acc = 0;
    for (let v = 1; v < n; v++) {
      const x0 = e.pts[(v - 1) * 2], z0 = e.pts[(v - 1) * 2 + 1];
      const dx = e.pts[v * 2] - x0;
      const dz = e.pts[v * 2 + 1] - z0;
      const len = Math.hypot(dx, dz);
      if (acc + len >= s || v === n - 1) {
        const t = len > 0 ? clamp((s - acc) / len, 0, 1) : 0;
        return { x: x0 + dx * t, z: z0 + dz * t };
      }
      acc += len;
    }
    return { x: e.pts[0], z: e.pts[1] };
  }

  /** Lateral offset the carriageway will actually accept. */
  private clampLateral(lat: number, e: RoadEdge): number {
    const room = roadWidthM(e.cls, e.lanes, e.flags) * 0.5 - CAR_HALF_WIDTH_M;
    if (room <= 0) return 0;
    return clamp(lat, -room, room);
  }

  /** Write the world position from the current rail state. */
  private place(heightAt: (x: number, z: number) => number): void {
    const e = this.graph.edges[this.where!.half.edge];
    const c = this.centreline();
    const dir = this.direction();
    const lat = this.clampLateral(laneOffsetM(e) + this.q, e);
    // Right of the direction of travel, which is what makes one formula cover
    // both a one-way and either end of a two-way.
    const x = c.x + -dir.z * lat;
    const z = c.z + dir.x * lat;
    this.position.set(x, this.surfaceY(e, x, z, heightAt), z);
  }

  /**
   * Height of the carriageway at a point on this edge.
   *
   * Draped on the terrain, plus roadpack's own lift, so the car sits on the
   * ribbon render/roads.ts draws rather than in it or over it. A bridge deck is
   * interpolated between its ends by arc length for the same reason the ribbon
   * is: the ground under a bridge is a riverbed, and draping the deck on it
   * would sag the car into the water at midspan.
   */
  private surfaceY(
    e: RoadEdge,
    x: number,
    z: number,
    heightAt: (px: number, pz: number) => number,
  ): number {
    const lift = roadLiftM(e.flags, e.layer);
    if ((e.flags & ROAD_BRIDGE) === 0) return heightAt(x, z) + lift;
    const y0 = heightAt(e.pts[0], e.pts[1]);
    const y1 = heightAt(e.pts[e.pts.length - 2], e.pts[e.pts.length - 1]);
    const w = this.where!;
    const t = e.lengthM > 0
      ? clamp((w.half.forward ? w.s : e.lengthM - w.s) / e.lengthM, 0, 1)
      : 0;
    return y0 + (y1 - y0) * t + lift;
  }

  /** Arc length from an edge's first vertex to a point on one of its segments. */
  private arcLengthTo(e: RoadEdge, globalSegment: number, x: number, z: number): number {
    // `globalSegment` indexes the whole RoadIndex, so turn it into a local one
    // by walking this edge's own segments and taking the nearest. Cheaper than
    // carrying a second table, and an edge is a handful of segments.
    const n = e.pts.length / 2;
    let acc = 0;
    let best = Infinity;
    let bestS = 0;
    for (let v = 1; v < n; v++) {
      const x0 = e.pts[(v - 1) * 2], z0 = e.pts[(v - 1) * 2 + 1];
      const dx = e.pts[v * 2] - x0;
      const dz = e.pts[v * 2 + 1] - z0;
      const len2 = dx * dx + dz * dz;
      const len = Math.sqrt(len2);
      let t = len2 > 0 ? ((x - x0) * dx + (z - z0) * dz) / len2 : 0;
      t = clamp(t, 0, 1);
      const px = x - (x0 + t * dx);
      const pz = z - (z0 + t * dz);
      const d = px * px + pz * pz;
      if (d < best) {
        best = d;
        bestS = acc + t * len;
      }
      acc += len;
    }
    void globalSegment;
    return bestS;
  }

  // --- travel ---------------------------------------------------------------

  /** Move `remain` metres along the network, taking junctions as it goes. */
  private advance(remain: number): void {
    const w = this.where!;
    for (let step = 0; step < MAX_EDGE_STEPS; step++) {
      const len = this.graph.edges[w.half.edge].lengthM;
      const ns = w.s + remain;
      if (ns >= 0 && ns <= len) {
        w.s = ns;
        this.stalled = false;
        return;
      }
      if (ns > len) {
        remain = ns - len;
        const next = this.chooseExit(this.graph.head(w.half), w.half);
        if (!next) {
          w.s = len;
          this.speed = 0;
          this.stalled = true;
          return;
        }
        this.applyCorner(w.half, next);
        w.half = next;
        w.s = 0;
      } else {
        remain = ns;
        const prev = this.chooseEntry(this.graph.tail(w.half), w.half);
        if (!prev) {
          w.s = 0;
          this.speed = 0;
          this.stalled = true;
          return;
        }
        w.half = prev;
        w.s = this.graph.edges[prev.edge].lengthM;
      }
    }
    // A cycle of zero-length edges cannot happen (buildRoadGraph drops them),
    // so reaching here means an absurd single-frame step. Stop rather than spin.
    this.speed = 0;
  }

  /** Slow for a corner if the exit turns sharply out of the entry. */
  private applyCorner(from: HalfEdge, to: HalfEdge): void {
    const a = this.exitDirection(from);
    const b = this.entryDirection(to);
    if (Math.abs(turnBetween(a.x, a.z, b.x, b.z)) >= TURN_ANGLE_DEG) {
      this.cornerLimit = TURN_SPEED;
      if (this.speed > TURN_SPEED) this.speed = TURN_SPEED;
    }
  }

  /**
   * Which way out of a junction.
   *
   * The steering wheel picks it: full lock right asks for a 90 degree right
   * turn and the exit nearest that wins, centred asks for straight on. A U-turn
   * back down the edge just driven is excluded unless it is the only way out,
   * which is what makes a cul-de-sac somewhere you can turn round rather than
   * somewhere the car sticks.
   */
  private chooseExit(node: number, from: HalfEdge): HalfEdge | null {
    const outs = this.graph.out[node];
    if (!outs || outs.length === 0) return null;
    const dir = this.exitDirection(from);
    const wanted = this.steerAxis * 90;
    let best: HalfEdge | null = null;
    let bestScore = Infinity;
    let uturn: HalfEdge | null = null;
    const fromCls = this.graph.edges[from.edge].cls;
    for (const h of outs) {
      if (h.edge === from.edge && h.forward !== from.forward) {
        uturn = h;
        continue;
      }
      const d = this.entryDirection(h);
      const turn = turnBetween(dir.x, dir.z, d.x, d.z);
      // Tie-broken by the lower edge index, so a symmetric crossroads always
      // picks the same arm and a replay of the same inputs is the same drive.
      const score = Math.abs(turn - wanted)
        + Math.max(0, this.graph.edges[h.edge].cls - fromCls) * CLASS_PENALTY_DEG
        + (this.leadsNowhere(h) ? DEAD_END_PENALTY_DEG : 0);
      if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best && h.edge < best.edge)) {
        bestScore = score;
        best = h;
      }
    }
    return best ?? uturn;
  }

  /** The same question, reversing: which edge ARRIVES at this node. */
  private chooseEntry(node: number, from: HalfEdge): HalfEdge | null {
    const ins = this.graph.into[node];
    if (!ins || ins.length === 0) return null;
    const dir = this.entryDirection(from);
    let best: HalfEdge | null = null;
    let bestScore = Infinity;
    let uturn: HalfEdge | null = null;
    for (const h of ins) {
      if (h.edge === from.edge && h.forward !== from.forward) {
        uturn = h;
        continue;
      }
      const d = this.exitDirection(h);
      const turn = Math.abs(turnBetween(dir.x, dir.z, d.x, d.z));
      if (turn < bestScore - 1e-9 || (Math.abs(turn - bestScore) <= 1e-9 && best && h.edge < best.edge)) {
        bestScore = turn;
        best = h;
      }
    }
    return best ?? uturn;
  }

  /**
   * Whether taking this half-edge leaves the car with nowhere to go but back.
   *
   * One step, and one step is enough: it is the difference between turning into
   * a street and turning into a driveway.
   */
  private leadsNowhere(h: HalfEdge): boolean {
    const onward = this.graph.out[this.graph.head(h)];
    if (!onward) return true;
    for (const n of onward) {
      if (n.edge !== h.edge || n.forward === h.forward) return false;
    }
    return true;
  }

  /** Direction of travel at the far end of a half-edge. */
  private exitDirection(h: HalfEdge): { x: number; z: number } {
    const e = this.graph.edges[h.edge];
    const n = e.pts.length;
    if (h.forward) {
      return unit(e.pts[n - 2] - e.pts[n - 4], e.pts[n - 1] - e.pts[n - 3]);
    }
    return unit(e.pts[0] - e.pts[2], e.pts[1] - e.pts[3]);
  }

  /** Direction of travel at the near end of a half-edge. */
  private entryDirection(h: HalfEdge): { x: number; z: number } {
    const e = this.graph.edges[h.edge];
    const n = e.pts.length;
    if (h.forward) return unit(e.pts[2] - e.pts[0], e.pts[3] - e.pts[1]);
    return unit(e.pts[n - 4] - e.pts[n - 2], e.pts[n - 3] - e.pts[n - 1]);
  }
}

function unit(x: number, z: number): { x: number; z: number } {
  const k = Math.hypot(x, z);
  return k > 0 ? { x: x / k, z: z / k } : { x: 0, z: -1 };
}

/** Move an angle toward another by at most `step` degrees, the short way. */
function stepAngle(have: number, want: number, step: number): number {
  let d = ((want - have + 540) % 360) - 180;
  if (Math.abs(d) <= step) return want;
  d = Math.sign(d) * step;
  return have + d;
}
