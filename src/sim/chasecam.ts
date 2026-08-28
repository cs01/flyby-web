// The camera that makes it look like a film rather than a simulator.
//
// A camera rigidly bolted behind the aircraft is correct and horrible: every
// control input becomes a whip pan, and the horizon never sits still. The
// chase views LAG. Position and aim are both damped, so the aeroplane moves
// first and the camera follows, which is what a helicopter operator chasing
// one actually produces.
//
// The lag also does the composition: in a turn the aircraft slides toward the
// outside of frame and you see where it is going, which is exactly the shot
// you want over a city.
//
// The cockpit view is the exception and is rigid on purpose. You are sitting
// in the aeroplane, so the world banks and you do not, and damping that would
// feel like the airframe was made of rubber.

import * as THREE from "three";
import type { Aircraft } from "./aircraft";

export type CameraMode = "chase" | "cockpit" | "wing" | "orbit";

export const CAMERA_MODES: CameraMode[] = ["chase", "cockpit", "wing", "orbit"];

const OFFSETS: Record<CameraMode, THREE.Vector3> = {
  // Close. At 26 m plus the speed stretch the aeroplane sat ~37 m out and read
  // as a model of itself in the middle of the frame; the shot is about the
  // aeroplane over the city, and it has to be big enough to be the subject.
  chase: new THREE.Vector3(0, 4.6, 16),
  // Behind the windscreen of the REAL airframe, which is a different aeroplane
  // from the box this was measured against: the imported C182 is 8.5 m long
  // with its propeller 3.8 m forward of the datum, and the old eye point put
  // the camera out in front of the glass and half a wingspan from the blades,
  // so the view was a propeller filling the frame with nothing around it.
  cockpit: new THREE.Vector3(0, 0.92, -0.15),
  wing: new THREE.Vector3(11, 2.0, 5),
  orbit: new THREE.Vector3(0, 40, 120),
};

const DEG = Math.PI / 180;

export class ChaseCam {
  private pos = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private orbitAngle = 0;
  private started = false;

  mode: CameraMode = "chase";

  /** Metres of extra standoff, so speed reads as speed. */
  private speedPullback = 0;

  update(
    cam: THREE.PerspectiveCamera,
    ac: Aircraft,
    dt: number,
    lookBack: boolean,
    groundY: number,
  ): void {
    if (this.mode === "cockpit") {
      this.updateCockpit(cam, ac, dt, lookBack);
      return;
    }

    const desiredOffset = OFFSETS[this.mode].clone();

    if (this.mode === "orbit") {
      this.orbitAngle += dt * 0.25;
      desiredOffset.set(Math.sin(this.orbitAngle) * 120, 45, Math.cos(this.orbitAngle) * 120);
    } else if (lookBack) {
      desiredOffset.z = -Math.abs(desiredOffset.z) - 4;
    }

    // Pull back with speed. A fixed offset makes a hover and a 100 kt run look
    // identical; a few metres of stretch is most of what sells the difference.
    const want = ac.groundSpeed * 0.13;
    this.speedPullback += (want - this.speedPullback) * (1 - Math.pow(0.02, dt));
    if (this.mode === "chase") desiredOffset.z += this.speedPullback;

    // The chase rig hangs off the aircraft's HEADING, not its full attitude. A
    // rig that inherited the bank would roll the whole frame through every
    // turn, which is nauseating, and one that inherited the pitch would swing
    // the ground in and out of shot on every level-off. The bank is put back
    // below, as a fraction, where it can be tuned independently.
    // Some of the PITCH, because a nose-up attitude the camera ignores is an
    // aeroplane climbing out of its own shot: pull up hard and the frame stays
    // resolutely horizontal while the aeroplane points at a sky you cannot
    // see. A fraction rather than all of it, so an ordinary level-off does not
    // swing the ground in and out. The bank is still left out entirely -- a
    // rig that rolls with the aircraft turns every turn into a barrel roll of
    // the whole frame.
    const pitchFollow = ac.pitchDeg * 0.62 * DEG;
    const yawOnly = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pitchFollow, -ac.headingDeg * DEG, 0, "YXZ"),
    );
    const target = desiredOffset.clone().applyQuaternion(yawOnly).add(ac.position);

    // Never let the camera go underground; clipping through a hill behind the
    // aircraft is the fastest way to break the shot.
    target.y = Math.max(target.y, groundY + 4);

    if (!this.started) {
      this.pos.copy(target);
      this.aim.copy(ac.position);
      this.started = true;
    }

    this.pos.lerp(target, 1 - Math.pow(0.0006, dt));

    const lookTarget = ac.position.clone();
    if (this.mode !== "orbit") {
      // Aim ahead of the aircraft, so the frame leads the flight path.
      lookTarget.addScaledVector(
        new THREE.Vector3(0, 0, -1).applyQuaternion(yawOnly),
        18,
      );
    }
    this.aim.lerp(lookTarget, 1 - Math.pow(0.003, dt));

    // Roll the camera a fraction of the aircraft's bank. None at all feels
    // detached; all of it is nauseating.
    //
    // Taken from the aircraft's OWN up vector rather than rebuilt from its bank
    // angle. Rebuilding it meant the sign convention was written down twice,
    // and when the roll sign was wrong the camera reproduced the error
    // faithfully instead of revealing it.
    const acUp = new THREE.Vector3(0, 1, 0).applyQuaternion(ac.quaternion);
    const rolled = new THREE.Vector3(0, 1, 0).lerp(acUp, 0.22).normalize();
    this.up.lerp(rolled, 1 - Math.pow(0.01, dt));

    cam.position.copy(this.pos);
    cam.up.copy(this.up);
    cam.lookAt(this.aim);
  }

  /**
   * The view from the left seat.
   *
   * Built from a quaternion rather than `lookAt`, because a look-at target
   * cannot express roll at all -- and roll is most of what a cockpit view is
   * for. It lags the airframe by a few milliseconds so that turbulence reads as
   * the aeroplane moving under you rather than as the camera being shaken.
   */
  private updateCockpit(cam: THREE.PerspectiveCamera, ac: Aircraft, dt: number, lookBack: boolean): void {
    const offset = OFFSETS.cockpit.clone().applyQuaternion(ac.quaternion);
    cam.position.copy(ac.position).add(offset);
    cam.up.set(0, 1, 0);
    const look = lookBack
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0, "YXZ"))
      : new THREE.Quaternion();
    cam.quaternion.slerp(ac.quaternion.clone().multiply(look), 1 - Math.pow(0.0002, dt));
    this.pos.copy(cam.position);
    this.started = true;
  }
}
