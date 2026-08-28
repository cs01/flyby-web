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
  // Close, and slightly above, so the shot looks down onto the wing.
  //
  // The aeroplane is the subject and it has to be big enough to be one. At
  // 16 m plus the old speed stretch it sat ~26 m out, where an 11 m span fills
  // about a third of the frame and reads as a model of itself. At 10 m plus
  // the gentler stretch below it sits ~16 m out and fills nearer three fifths,
  // which is close enough to see the livery and the gear.
  //
  // y is above the wing (the airframe spans -1.2..2.1 m about its origin), so
  // the camera looks slightly DOWN on it and the city stays in the frame
  // behind. Lower than this and the wing hides the ground; higher and it turns
  // into a map view.
  chase: new THREE.Vector3(0, 3.5, 10),
  cockpit: new THREE.Vector3(0, 0.55, -1.1),
  wing: new THREE.Vector3(11, 2.0, 5),
  orbit: new THREE.Vector3(0, 40, 120),
};

const DEG = Math.PI / 180;

/**
 * Height above ground, in metres, over which the chase rig slides into the
 * left seat and back out again.
 *
 * The point is the street. Up at cruise the shot is about the aeroplane over
 * the city, so it wants to be outside looking at it; down among the buildings
 * that same rig is useless -- the airframe fills the frame, the camera is
 * 16 m behind you and keeps clipping the block you just passed, and you cannot
 * see the gap you are aiming for. Down there the shot is about the CITY, and
 * the only place to see it from is the seat.
 *
 * 150 m is roughly where Manhattan's rooftops start passing above you, and
 * 55 m is well down in the canyon, so the swap happens exactly over the run
 * where the buildings stop being scenery and start being obstacles.
 */
const FPV_OUT_M = 150;
const FPV_IN_M = 55;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const _seatOffset = new THREE.Vector3();
const _seatPos = new THREE.Vector3();
const _seatQuat = new THREE.Quaternion();
const _lookBackQuat = new THREE.Quaternion();

export class ChaseCam {
  private pos = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private orbitAngle = 0;
  private started = false;

  mode: CameraMode = "chase";

  /** Metres of extra standoff, so speed reads as speed. */
  private speedPullback = 0;

  /** 0 = chase rig, 1 = out of the left seat. Driven by height above ground. */
  private fpv = 0;

  /**
   * How far into the first-person view the camera currently is.
   *
   * Read by the renderer to decide whether to draw the aeroplane: at the seat
   * you are inside it.
   */
  get cockpitBlend(): number {
    return this.fpv;
  }

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
    // Gentler than it was: at the old rate the stretch alone was two thirds of
    // the standoff at cruise, which undid the close framing exactly when the
    // aeroplane was most worth looking at.
    const want = ac.groundSpeed * 0.07;
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

    // --- Slide into the seat as the ground comes up ------------------------
    //
    // Only from the chase rig. Picking `wing` or `orbit` is an explicit request
    // for a particular shot, and having it silently become something else at
    // 400 feet would be the camera arguing with you.
    //
    // Blended twice on purpose: `smoothstep` on HEIGHT so the transition has no
    // corner in it, and an exponential follow in TIME so that skimming a roof
    // or dropping into a single wide street does not snap the view across and
    // back. The height term alone made a hop over one tall building look like
    // a cut.
    const agl = ac.position.y - groundY;
    const wantFpv = this.mode === "chase" ? smoothstep(FPV_OUT_M, FPV_IN_M, agl) : 0;
    this.fpv += (wantFpv - this.fpv) * (1 - Math.pow(0.08, dt));

    if (this.fpv > 0.001) {
      _seatOffset.copy(OFFSETS.cockpit).applyQuaternion(ac.quaternion);
      _seatPos.copy(ac.position).add(_seatOffset);
      // In the seat the camera IS the aeroplane, roll and all -- which is the
      // whole reason to be there when a building is going past the wingtip.
      _lookBackQuat.setFromEuler(new THREE.Euler(0, lookBack ? Math.PI : 0, 0, "YXZ"));
      _seatQuat.copy(ac.quaternion).multiply(_lookBackQuat);

      cam.position.lerpVectors(this.pos, _seatPos, this.fpv);
      // Orientation is slerped rather than built from a look-at target, because
      // a look-at cannot express roll and roll is most of what the seat view is.
      cam.quaternion.slerp(_seatQuat, this.fpv);
      // Keep the rig's own state at the blended position, or letting go of the
      // blend snaps the camera back to wherever the chase rig had drifted to.
      this.pos.copy(cam.position);
    }
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
