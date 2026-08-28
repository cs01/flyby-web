// Fly me to that one.
//
// A place list you can only READ is a list of things you now have to go and
// find by hand, at a hundred knots, over a city you have never seen from the
// air. Clicking a name and having the aeroplane turn toward it is what makes
// the list worth having.
//
// It commands the same -1..1 axes a thumb or a keyboard produces, so the
// flight model has no idea it exists -- the assistance is in the STICK, not in
// the physics, and every honest thing the model does (wind drift, the turn
// rate falling out of bank and speed, the energy cost of a climb) still
// happens underneath it.
//
// It only ever touches ROLL. Height and speed stay yours, because an autopilot
// that also flew the altitude would take the sightseeing away, which is the
// entire activity. It disengages the moment you touch the stick: an assistance
// you have to fight is worse than none.

import type * as THREE from "three";
import type { Axes } from "./input";

/** Close enough to say you have arrived, metres. */
const ARRIVED_M = 500;

/** Heading error, in degrees, at which the roll command saturates. */
const FULL_DEFLECTION_DEG = 32;

export interface AutopilotTarget {
  name: string;
  x: number;
  z: number;
}

export class Autopilot {
  target: AutopilotTarget | null = null;
  /** Set for one frame when the target is reached, for the HUD to announce. */
  justArrived: string | null = null;

  engage(target: AutopilotTarget): void {
    this.target = target;
  }

  disengage(): void {
    this.target = null;
  }

  get engaged(): boolean {
    return this.target !== null;
  }

  /**
   * Overwrites the roll axis when engaged. Returns the same object it was
   * given: the caller's axes are the aircraft's input and there is no reason
   * to allocate a second one sixty times a second.
   */
  update(axes: Axes, position: THREE.Vector3, headingDeg: number): Axes {
    this.justArrived = null;
    const t = this.target;
    if (!t) return axes;

    // Any real stick input hands control back. Checked against the SMOOTHED
    // axis rather than the key state, so releasing a key does not re-engage
    // half a ramp later.
    if (Math.abs(axes.roll) > 0.05 || Math.abs(axes.yaw) > 0.05) {
      this.disengage();
      return axes;
    }

    const dx = t.x - position.x;
    const dz = t.z - position.z;
    if (Math.hypot(dx, dz) < ARRIVED_M) {
      this.justArrived = t.name;
      this.disengage();
      return axes;
    }

    // World bearing, in compass degrees. Forward is -z, so the bearing to a
    // point is atan2 of east over NORTH, and north is -dz.
    const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
    let error = bearing - headingDeg;
    // Wrap to [-180, 180) or the aeroplane turns the long way round for any
    // target behind its left shoulder.
    error = ((((error + 180) % 360) + 360) % 360) - 180;

    const cmd = Math.max(-1, Math.min(1, error / FULL_DEFLECTION_DEG));
    // A dead band around zero, because the roll axis also commands the bank
    // ANGLE: without one the aeroplane holds a degree or two of bank forever
    // and crabs along the track it is trying to fly down.
    axes.roll = Math.abs(error) < 1.5 ? 0 : cmd;
    return axes;
  }
}
