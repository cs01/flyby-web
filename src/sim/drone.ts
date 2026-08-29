// The camera drone: a separate simulation, flown first-person.
//
// This exists because the aeroplane cannot do it and should not be made to.
// A Cessna stalls around 50 kt so it cannot creep, needs a 300 m radius to
// come round at 100 kt when a Manhattan block is 80 x 270 m, and has a hard
// floor 25 m over the ground that shoves it back up. Every one of those is
// correct for an aeroplane and fatal for flying down a street. So the street
// gets its own machine rather than the aeroplane getting a mode.
//
// What makes it read as a QUADCOPTER rather than a floating camera is not the
// speed, it is the TILT. A real multirotor has no way to accelerate sideways
// except to lean, so the horizon rolls into every sidestep and the nose drops
// when it picks up speed -- and because a lean takes time to establish, the
// tilt lags the stick. That lag is the whole feel. Take the cosmetic bank out
// of this file and what remains is a noclip camera.
//
// The second half of the feel is MOMENTUM. Releasing the stick coasts, and the
// coast is `v *= DAMP^dt` rather than a per-frame multiply, so the machine
// behaves the same on a 30 Hz laptop and a 240 Hz monitor. A per-frame factor
// is the classic bug here and it is silent: it only shows up as the drone
// feeling draggy on a slow machine and slippery on a fast one.
//
// Buildings are NOT this file's problem. The pack is geometry with no
// collision data in it, so the solid city lives in sim/citycollision.ts and is
// applied by the caller after `update` has integrated and clamped to terrain.
// Keeping it out here is what lets the aeroplane share none of it.

import * as THREE from "three";

export interface DroneInput {
  /** -1..1 */
  forward: number;
  /** -1..1, positive right. */
  strafe: number;
  /** -1..1, positive up. */
  lift: number;
  /** -1..1, positive right. */
  yaw: number;
  /** -1..1, positive up. */
  pitch: number;
  /** 0..1 */
  boost: number;
  /**
   * Degrees of look asked for by an ABSOLUTE device this frame, i.e. a mouse
   * under pointer lock.
   *
   * A mouse delta is not an axis: it is already an angle, it has no maximum,
   * and squeezing it into -1..1 would cap a flick of the wrist at the keyboard
   * turn rate. So it arrives beside the axes rather than inside them, and the
   * two simply add -- which is also what makes the keyboard a working fallback
   * when pointer lock is refused.
   */
  lookYawDeg: number;
  lookPitchDeg: number;
}

const DEG = Math.PI / 180;

/** Metres per second held at full stick, and with boost. */
export const DRONE_CRUISE = 16;
export const DRONE_BOOST = 42;

/** Metres per second per second toward the commanded velocity. */
const ACCEL = 30;
const ACCEL_BOOST = 40;
/** The vertical is its own axis with its own authority. */
const ACCEL_V = 22;
const VERT_SPEED = 9;
const VERT_BOOST = 20;

/**
 * Fraction of the velocity surviving one second with the stick centred.
 *
 * This is the coast. 0.12 leaves it drifting for about a second and a half and
 * carrying ~7 m, which is enough that a stop is a decision rather than a
 * teleport, and short enough that a gap between two buildings is still a gap
 * you can stop in.
 */
export const DRONE_DAMP = 0.12;

export const DRONE_YAW_RATE = 110; // deg/s at full stick
const PITCH_RATE = 70; // deg/s at full stick
export const DRONE_PITCH_LIMIT = 85;

/** Cosmetic only. Degrees of lean at the full commanded acceleration. */
export const DRONE_MAX_BANK = 32;
const NOSE_DOWN = 12;
/**
 * Fraction of the tilt error left after one second.
 *
 * The lean has to LAG the stick or it reads as a camera being rotated rather
 * than a machine leaning into a manoeuvre. ~0.19 s of time constant is enough
 * to see it happen and not enough to feel disconnected.
 */
const TILT_FOLLOW = 0.005;

/**
 * Metres held above the terrain.
 *
 * Higher than a drone would really sit, and the reason is the near plane: the
 * camera clips at 2 m, so below about 2.4 m of clearance the ground directly
 * under the lens falls inside the near plane and the bottom of the frame turns
 * into a hole with the sky showing through it. Lowering `near` instead would
 * cost depth precision across a 200 km far plane, which is a real regression
 * everywhere to fix a wedge at the bottom of one view.
 */
export const DRONE_GROUND_CLEARANCE = 2.5;

/**
 * Radius of the drone as the city collider sees it, in metres.
 *
 * Bigger than the airframe, and deliberately. The camera sits at the centre of
 * this circle and its near plane is 2 m, so a radius that matched a real 30 cm
 * quadcopter would put the wall INSIDE the near plane every time you skimmed
 * one and the facade would tear open. At 1.2 m the drone stops with the brick
 * filling the frame, which is the shot, and a 2.4 m machine still fits down
 * every street and airshaft in the pack.
 */
export const DRONE_RADIUS = 1.2;

/** Where the drone appears relative to the aeroplane it just left, in metres. */
const ENTRY_BACK = 18;
const ENTRY_UP = 2.5;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _want = new THREE.Vector3();
const _prevV = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Drone {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  /** Compass heading, degrees clockwise from north, like the aircraft's. */
  yawDeg = 0;
  /** Nose-up positive. Clamped; this is a look angle, not an attitude. */
  pitchDeg = 0;
  /**
   * Cosmetic bank from lateral acceleration, right-wing-down positive.
   *
   * Never integrated from an input. There is no roll axis on this machine, and
   * a roll that accumulated would eventually put the horizon upside down with
   * nothing to bring it back.
   */
  rollDeg = 0;

  /** The nose-down the same tilt logic produces when accelerating forward. */
  private noseDeg = 0;

  get speed(): number {
    return this.velocity.length();
  }

  /**
   * Take over from the aeroplane, at its position, on its heading, carrying
   * its momentum.
   *
   * Inheriting the velocity is what makes the swap read as stepping out of the
   * aircraft rather than cutting to a different shot: the drone slides forward
   * for a moment and settles.
   *
   * Capped at CRUISE rather than at boost, which is a number arrived at by
   * flying it. A Cessna at 90 kt hands over 46 m/s, and 46 m/s coasts 22 m --
   * far enough that the drone sails straight through the aeroplane it was
   * meant to be looking at, and the first second of the new view is empty sky.
   * At cruise it slides about 7 m and stops with the aircraft filling the
   * frame, which is the shot the whole feature is for.
   */
  enterFrom(position: THREE.Vector3, headingDeg: number, velocity: THREE.Vector3): void {
    this.yawDeg = ((headingDeg % 360) + 360) % 360;
    // Launched from BEHIND and above the aeroplane rather than out of its
    // origin. Spawned at the origin the first frame of the new view is the
    // inside of the airframe, which is both ugly and the exact opposite of the
    // thing worth showing: from back here the Cessna is hanging in the middle
    // of the frame, and the first thing you understand is that you have left
    // it behind and can go and look at it.
    const yr = this.yawDeg * DEG;
    this.position.set(
      position.x - Math.sin(yr) * ENTRY_BACK,
      position.y + ENTRY_UP,
      position.z + Math.cos(yr) * ENTRY_BACK,
    );
    this.pitchDeg = 0;
    this.rollDeg = 0;
    this.noseDeg = 0;
    this.velocity.copy(velocity);
    if (this.velocity.length() > DRONE_CRUISE) this.velocity.setLength(DRONE_CRUISE);
  }

  update(input: DroneInput, dt: number, groundY: number): void {
    if (!(dt > 0)) return;
    const boost = clamp(input.boost, 0, 1);

    // --- Look ------------------------------------------------------------
    // Keyboard rates and mouse degrees add, so both work at once and either
    // alone is sufficient.
    this.yawDeg += clamp(input.yaw, -1, 1) * DRONE_YAW_RATE * dt + input.lookYawDeg;
    this.pitchDeg += clamp(input.pitch, -1, 1) * PITCH_RATE * dt + input.lookPitchDeg;
    this.yawDeg = ((this.yawDeg % 360) + 360) % 360;
    this.pitchDeg = clamp(this.pitchDeg, -DRONE_PITCH_LIMIT, DRONE_PITCH_LIMIT);

    // The command basis is the LOOK angle, never the cosmetic tilt. Feeding
    // the lean back into the direction of travel would be a loop: accelerate,
    // nose drops, forward now points down, descend, accelerate.
    const yawRad = this.yawDeg * DEG;
    const pitchRad = this.pitchDeg * DEG;
    const cp = Math.cos(pitchRad);
    _fwd.set(Math.sin(yawRad) * cp, Math.sin(pitchRad), -Math.cos(yawRad) * cp);
    _right.set(Math.cos(yawRad), 0, Math.sin(yawRad));

    // --- Commanded velocity ----------------------------------------------
    _move.set(0, 0, 0);
    _move.addScaledVector(_fwd, clamp(input.forward, -1, 1));
    _move.addScaledVector(_right, clamp(input.strafe, -1, 1));
    // Diagonals are not faster. Normalised rather than clamped per axis, so
    // forward-and-right is the same speed as forward.
    if (_move.lengthSq() > 1) _move.normalize();

    const speedTarget = THREE.MathUtils.lerp(DRONE_CRUISE, DRONE_BOOST, boost);
    const vertTarget = THREE.MathUtils.lerp(VERT_SPEED, VERT_BOOST, boost);
    const accel = THREE.MathUtils.lerp(ACCEL, ACCEL_BOOST, boost);

    _want.copy(_move).multiplyScalar(speedTarget);
    _want.y += clamp(input.lift, -1, 1) * vertTarget;

    _prevV.copy(this.velocity);

    // --- Horizontal -------------------------------------------------------
    // Two regimes, and the split is what gives the machine both a crisp stick
    // and momentum: under power it is driven toward the commanded velocity at
    // a fixed acceleration, and with nothing commanded it COASTS on an
    // exponential decay. A single spring would have to choose between the two.
    const horizCommanded = _move.lengthSq() > 1e-9;
    if (horizCommanded) {
      const dx = _want.x - this.velocity.x;
      const dz = _want.z - this.velocity.z;
      const mag = Math.hypot(dx, dz);
      const step = accel * dt;
      if (mag > step && mag > 1e-9) {
        this.velocity.x += (dx / mag) * step;
        this.velocity.z += (dz / mag) * step;
      } else {
        this.velocity.x = _want.x;
        this.velocity.z = _want.z;
      }
    } else {
      // Frame-rate independent by construction: `pow(DAMP, dt)`, never a
      // per-frame factor.
      const keep = Math.pow(DRONE_DAMP, dt);
      this.velocity.x *= keep;
      this.velocity.z *= keep;
    }

    // --- Vertical ---------------------------------------------------------
    // Its own axis, and with no gravity: this is a stabilised camera drone, so
    // hands off means it hangs there. A sink rate would be honest for a real
    // quad and would mean nobody could hold a shot.
    if (Math.abs(_want.y) > 1e-9) {
      const dy = _want.y - this.velocity.y;
      const stepY = ACCEL_V * dt;
      this.velocity.y += Math.abs(dy) > stepY ? Math.sign(dy) * stepY : dy;
    } else {
      this.velocity.y *= Math.pow(DRONE_DAMP, dt);
    }

    // --- Integrate --------------------------------------------------------
    // Trapezoidal in the velocity, which costs one add and removes most of the
    // frame-rate dependence that plain Euler leaves in an exponential coast.
    _accel.subVectors(this.velocity, _prevV).divideScalar(dt);
    this.position.x += ((this.velocity.x + _prevV.x) * 0.5) * dt;
    this.position.y += ((this.velocity.y + _prevV.y) * 0.5) * dt;
    this.position.z += ((this.velocity.z + _prevV.z) * 0.5) * dt;

    // --- Ground -----------------------------------------------------------
    // Settle, do not bounce: the downward velocity is killed rather than
    // reflected, so arriving at the street is an arrival.
    const floor = groundY + DRONE_GROUND_CLEARANCE;
    if (this.position.y < floor) {
      this.position.y = floor;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    // --- Cosmetic tilt ----------------------------------------------------
    // Taken from the acceleration that actually happened, resolved in the
    // machine's own frame, so a sidestep, a turn at speed and a hard stop all
    // lean the right way without any of them being special-cased. Braking
    // flares the nose up for free, which is what a quad does.
    const aRight = _accel.x * _right.x + _accel.z * _right.z;
    const aFwd = _accel.x * Math.sin(yawRad) + _accel.z * -Math.cos(yawRad);
    const wantRoll = clamp(aRight / accel, -1, 1) * DRONE_MAX_BANK;
    const wantNose = -clamp(aFwd / accel, -1, 1) * NOSE_DOWN;
    const follow = 1 - Math.pow(TILT_FOLLOW, dt);
    this.rollDeg += (wantRoll - this.rollDeg) * follow;
    this.noseDeg += (wantNose - this.noseDeg) * follow;
  }

  /** Orientation for the camera: look angle plus the cosmetic lean. */
  orientation(out: THREE.Quaternion): THREE.Quaternion {
    // Negated roll: the camera looks down -z, and a positive rotation about +z
    // carries the right side UP, which is a left bank. `rollDeg` is
    // right-wing-down positive, matching the aircraft's.
    _euler.set(
      (this.pitchDeg + this.noseDeg) * DEG,
      -this.yawDeg * DEG,
      -this.rollDeg * DEG,
      "YXZ",
    );
    return out.setFromEuler(_euler);
  }
}
