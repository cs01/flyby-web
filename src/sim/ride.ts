// Riding a train, tram, bus or ferry on foot: where the person stands in the
// vehicle's own frame, how that frame maps to the world, and when they may get
// off. app/ride.ts drives it from the transit model each frame.
//
// Pure: no scene, no DOM, no clock. The vehicle pose is the one
// data/transit.ts carPose/boatPose gives the renderer (render/transit.ts
// composes it as Euler(pitch, yaw, 0, "YXZ") at x,y,z), so the camera and the
// car mesh are posed by the same numbers.

import { DRONE_YAW_RATE, PITCH_RATE, WALK_EYE_M, WALK_RUN_SPEED, WALK_SPEED } from "./drone";

export type RideKind = "subway" | "rail" | "tram" | "bus" | "cable" | "ferry";

export interface RideSpec {
  /** Floor above the pose point: top of rail for a car, road for a bus, waterline for a hull. */
  floorM: number;
  ceilM: number;
  /** Default deck when the fleet sheet gives no length or width. */
  lenM: number;
  widthM: number;
  /**
   * Closest the eye gets to a wall. Wider than a body because the camera's
   * near plane is 0.5 m: closer, and a wall seen at an angle is clipped open.
   */
  wallM: number;
}

/**
 * One row per kind. The car floor and roof are the body box of
 * render/transit.ts carGeometry (1.25 to 3.5 m over the rail); the ferry row
 * is its smaller hulls' lower cabin (freeboard 1.8 m, deck 2.6 m), and
 * deckFor works the big double-enders out from the hull length the same way
 * hullGeometry does. The packs carry no buses or trams yet; their rows are
 * low-floor vehicles on the road.
 */
export const RIDE: Record<RideKind, RideSpec> = {
  subway: { floorM: 1.25, ceilM: 3.5, lenM: 15, widthM: 2.6, wallM: 0.7 },
  rail: { floorM: 1.25, ceilM: 3.5, lenM: 15, widthM: 2.6, wallM: 0.7 },
  tram: { floorM: 0.35, ceilM: 2.6, lenM: 14, widthM: 2.6, wallM: 0.65 },
  bus: { floorM: 0.35, ceilM: 2.5, lenM: 11, widthM: 2.5, wallM: 0.6 },
  // SF cable car: 8.4 to 9.2 m on Powell and California; the ends are open
  // platforms, so the walls are low and the deck short.
  cable: { floorM: 0.45, ceilM: 2.5, lenM: 8.4, widthM: 2.4, wallM: 0.5 },
  ferry: { floorM: 1.8, ceilM: 4.4, lenM: 20, widthM: 8, wallM: 0.7 },
};

/** The standable rectangle in the vehicle's frame: nose toward -z, x to the right. */
export interface Deck {
  hx: number;
  z0: number;
  z1: number;
  floor: number;
  ceil: number;
  wall: number;
}

/**
 * The deck of one car (or one hull) of `len` by `width` metres, the numbers
 * data/transit.ts rollingFor gives the renderer.
 */
export function deckFor(kind: RideKind, len = RIDE[kind].lenM, width = RIDE[kind].widthM): Deck {
  const r = RIDE[kind];
  if (kind === "ferry") {
    // The lower cabin of render/transit.ts hullGeometry: from 0.2 L aft of
    // the bow to 0.08 L short of the stern, 0.92 of the beam.
    const big = len > 60;
    const floor = big ? 4 : r.floorM;
    return { hx: (width / 2) * 0.92, z0: -len / 2 + len * 0.2, z1: len / 2 - len * 0.08, floor, ceil: floor + (big ? 3.2 : r.ceilM - r.floorM), wall: r.wallM };
  }
  // Car bodies are 0.5 m shorter than their length over couplers.
  const L = kind === "subway" || kind === "rail" ? len - 0.5 : len;
  return { hx: width / 2, z0: -L / 2, z1: L / 2, floor: r.floorM, ceil: r.ceilM, wall: r.wallM };
}

export interface RidePose {
  x: number;
  y: number;
  z: number;
  /** Radians about +y, three.js sense: turns a -z nose onto the track. */
  yaw: number;
  /** Radians, nose up. */
  pitch: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A point in the vehicle's frame to the world: R = Ry(yaw) Rx(pitch), then the pose point. */
export function toWorld(p: RidePose, lx: number, ly: number, lz: number, out: Vec3): Vec3 {
  const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const y1 = ly * cp - lz * sp;
  const z1 = ly * sp + lz * cp;
  out.x = p.x + lx * cy + z1 * sy;
  out.y = p.y + y1;
  out.z = p.z - lx * sy + z1 * cy;
  return out;
}

/** The inverse of toWorld. */
export function toLocal(p: RidePose, wx: number, wy: number, wz: number, out: Vec3): Vec3 {
  const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const dx = wx - p.x, dy = wy - p.y, dz = wz - p.z;
  const lx = dx * cy - dz * sy;
  const z1 = dx * sy + dz * cy;
  out.x = lx;
  out.y = dy * cp + z1 * sp;
  out.z = -dy * sp + z1 * cp;
  return out;
}

/** Inside the walls by `wall`; a deck narrower than two walls pins to its centre line. */
export function clampToDeck(d: Deck, lx: number, lz: number, out: Vec3): Vec3 {
  const hx = Math.max(0, d.hx - d.wall);
  const za = d.z0 + d.wall, zb = d.z1 - d.wall;
  out.x = lx < -hx ? -hx : lx > hx ? hx : lx;
  out.z = za > zb ? (d.z0 + d.z1) / 2 : lz < za ? za : lz > zb ? zb : lz;
  return out;
}

/** Plan distance from a local point to the deck's outline, 0 inside it. */
export function distToDeck(d: Deck, lx: number, lz: number): number {
  const ex = Math.max(0, Math.abs(lx) - d.hx);
  const ez = Math.max(0, d.z0 - lz, lz - d.z1);
  return Math.hypot(ex, ez);
}

/** Below this the vehicle is standing, m/s. A berthed ferry reports a little drift. */
export const STOPPED_MPS = 0.4;
/**
 * How far the head (or bow) may be from the stop's arc length and still be
 * "at" it. Live trains carry an eased correction of a few tens of metres, and
 * a ferry's berth point is the bow, not the gangway.
 */
export const AT_STOP_M = 30;

/** The doors open only when it is standing at a stop. */
export function canAlight(speed: number, s: number, stopS: number | null): boolean {
  return Math.abs(speed) < STOPPED_MPS && stopS !== null && Math.abs(s - stopS) <= AT_STOP_M;
}

/** Compass heading the camera needs, from the person's heading relative to the vehicle. */
export function worldYawDeg(relDeg: number, poseYaw: number): number {
  const h = relDeg - (poseYaw * 180) / Math.PI;
  return ((h % 360) + 360) % 360;
}

export function relYawDeg(worldDeg: number, poseYaw: number): number {
  const h = worldDeg + (poseYaw * 180) / Math.PI;
  return ((h % 360) + 360) % 360;
}

export interface Rider {
  /** Eye position in the vehicle's frame; y is the floor plus eye height. */
  lx: number;
  lz: number;
  /** Compass-sense heading relative to the nose, degrees. */
  relYawDeg: number;
  pitchDeg: number;
}

export interface RideInput {
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  boost: number;
  lookYawDeg: number;
  lookPitchDeg: number;
}

const _c: Vec3 = { x: 0, y: 0, z: 0 };

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * One frame of walking about inside. Look is relative to the vehicle, so when
 * it turns a corner the world turns around you and your view down the aisle
 * stays put. Steps are at walking pace with no momentum to carry: the floor
 * moves with you.
 */
export function stepRider(r: Rider, inp: RideInput, d: Deck, dt: number): Rider {
  r.relYawDeg += clamp1(inp.yaw) * DRONE_YAW_RATE * dt + inp.lookYawDeg;
  r.relYawDeg = ((r.relYawDeg % 360) + 360) % 360;
  r.pitchDeg += clamp1(inp.pitch) * PITCH_RATE * dt + inp.lookPitchDeg;
  r.pitchDeg = r.pitchDeg < -80 ? -80 : r.pitchDeg > 80 ? 80 : r.pitchDeg;
  const yr = (r.relYawDeg * Math.PI) / 180;
  const f = clamp1(inp.forward), s = clamp1(inp.strafe);
  let mx = Math.sin(yr) * f + Math.cos(yr) * s;
  let mz = -Math.cos(yr) * f + Math.sin(yr) * s;
  const m = Math.hypot(mx, mz);
  if (m > 1) {
    mx /= m;
    mz /= m;
  }
  const b = inp.boost < 0 ? 0 : inp.boost > 1 ? 1 : inp.boost;
  const speed = WALK_SPEED + (WALK_RUN_SPEED - WALK_SPEED) * b;
  clampToDeck(d, r.lx + mx * speed * dt, r.lz + mz * speed * dt, _c);
  r.lx = _c.x;
  r.lz = _c.z;
  return r;
}

/** Where the eye is in the world: the deck point at standing height, through the pose. */
export function riderEye(p: RidePose, r: Rider, d: Deck, out: Vec3): Vec3 {
  return toWorld(p, r.lx, d.floor + WALK_EYE_M, r.lz, out);
}
