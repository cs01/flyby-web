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

/** Degrees of bank commanded per degree of heading error, and the ceiling. */
const BANK_PER_DEG = 1.15;
const MAX_BANK_DEG = 30;

/** Bank error, in degrees, at which the roll command saturates. */
const ROLL_AUTHORITY_DEG = 11;

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
  update(
    axes: Axes,
    position: THREE.Vector3,
    headingDeg: number,
    rollDeg: number,
    manualStick: boolean,
  ): Axes {
    this.justArrived = null;
    const t = this.target;
    if (!t) return axes;

    // Handing control back is decided by whether a STICK IS BEING HELD, not by
    // the value on the axis. The axis is the one this function wrote a moment
    // ago, and the input layer ramps from wherever it was left, so reading it
    // back meant the autopilot saw its own command as a pilot input and let go
    // one frame after engaging -- it turned toward the target, then stopped.
    if (manualStick) {
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

    // TWO loops, because the roll axis commands a bank RATE and not a bank
    // angle. Driving it straight from the heading error meant the aeroplane
    // kept rolling for as long as it was pointed the wrong way -- so it wound
    // on bank all the way to the limit, swept through the target heading at
    // full deflection and came back the other way. An outer loop picks the
    // bank the turn wants; the inner one rolls until it has it.
    const wantBank = Math.max(
      -MAX_BANK_DEG,
      Math.min(MAX_BANK_DEG, error * BANK_PER_DEG),
    );
    const bankError = wantBank - rollDeg;
    axes.roll = Math.max(-1, Math.min(1, bankError / ROLL_AUTHORITY_DEG));
    return axes;
  }
}
