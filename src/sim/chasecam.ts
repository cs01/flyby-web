// The camera that makes it look like a film rather than a simulator.
//
// A camera rigidly bolted behind the aircraft is correct and horrible: every
// control input becomes a whip pan, and the horizon never sits still. This one
// LAGS. Position and aim are both critically damped springs, so the aircraft
// moves first and the camera follows, which is what a helicopter operator
// chasing an aeroplane actually produces.
//
// The lag also does the composition: in a turn the aircraft slides toward the
// outside of frame and you see where it is going, which is exactly the shot you
// want over a city.

import * as THREE from "three";
import type { Aircraft } from "./aircraft";

export type CameraMode = "chase" | "cockpit" | "wing" | "orbit";

export const CAMERA_MODES: CameraMode[] = ["chase", "cockpit", "wing", "orbit"];

const OFFSETS: Record<CameraMode, THREE.Vector3> = {
  chase: new THREE.Vector3(0, 7.5, 30),
  cockpit: new THREE.Vector3(0, 1.1, 1.2),
  wing: new THREE.Vector3(13, 2.2, 6),
  orbit: new THREE.Vector3(0, 40, 120),
};

export class ChaseCam {
  private pos = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private orbitAngle = 0;
  private started = false;

  mode: CameraMode = "chase";

  /** Metres of extra standoff, so speed reads as speed. */
  private speedPullback = 0;

  update(cam: THREE.PerspectiveCamera, ac: Aircraft, dt: number, lookBack: boolean, groundY: number): void {
    const desiredOffset = OFFSETS[this.mode].clone();

    if (this.mode === "orbit") {
      this.orbitAngle += dt * 0.25;
      desiredOffset.set(Math.sin(this.orbitAngle) * 120, 45, Math.cos(this.orbitAngle) * 120);
    } else if (lookBack) {
      desiredOffset.z = -Math.abs(desiredOffset.z) - 6;
    }

    // Pull back with speed. A fixed offset makes 60 kt and 160 kt look
    // identical; a few metres of stretch is most of what sells the difference.
    const want = (ac.airspeed - 70) * 0.16;
    this.speedPullback += (want - this.speedPullback) * (1 - Math.pow(0.02, dt));
    if (this.mode === "chase") desiredOffset.z += Math.max(-4, this.speedPullback);

    const target = desiredOffset.clone().applyQuaternion(ac.quaternion).add(ac.position);

    // Never let the camera go underground; clipping through a hill behind the
    // aircraft is the fastest way to break the shot.
    target.y = Math.max(target.y, groundY + 6);

    if (!this.started) {
      this.pos.copy(target);
      this.aim.copy(ac.position);
      this.started = true;
    }

    // Critically damped follow. The cockpit view is rigid (it IS the aircraft),
    // everything else lags.
    const posK = this.mode === "cockpit" ? 1 : 1 - Math.pow(0.0009, dt);
    const aimK = this.mode === "cockpit" ? 1 : 1 - Math.pow(0.004, dt);
    this.pos.lerp(target, posK);

    const lookTarget = ac.position.clone();
    if (this.mode !== "orbit") {
      // Aim slightly ahead of the aircraft, so the frame leads the flight path.
      lookTarget.addScaledVector(
        new THREE.Vector3(0, 0, -1).applyQuaternion(ac.quaternion),
        this.mode === "cockpit" ? 60 : 26,
      );
    }
    this.aim.lerp(lookTarget, aimK);

    // Roll the camera a fraction of the aircraft's bank. None at all feels
    // detached; all of it is nauseating.
    const bankShare = this.mode === "cockpit" ? 0.9 : 0.30;
    const rolled = new THREE.Vector3(0, 1, 0).applyAxisAngle(
      new THREE.Vector3(0, 0, -1).applyQuaternion(ac.quaternion),
      ac.bankDeg * (Math.PI / 180) * bankShare,
    );
    this.up.lerp(rolled, 1 - Math.pow(0.01, dt));

    cam.position.copy(this.pos);
    cam.up.copy(this.up);
    cam.lookAt(this.aim);
  }
}
