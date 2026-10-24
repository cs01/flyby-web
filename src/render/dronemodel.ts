// A quadcopter to look at.
//
// The drone was a camera with nothing around it, which the owner read as "the
// drone doesn't look like a drone". Now the default drone view is a chase
// shot of this airframe, a camera-drone layout in the DJI Inspire class:
// a pale shell over a dark body, four arms on the diagonals, motors, blurred
// rotors, a gimbal under the nose and nav LEDs. It is built from primitives
// because a few hundred triangles of honest shape at 4 m read better than a
// detailed model nobody is close enough to see.
//
// Scaled to 1.3x a real 0.7 m span on purpose: the chase camera sits 4.5 m
// back so the city still fills the frame, and at that range a true-size
// machine is a speck.

import * as THREE from "three";
import type { AircraftModel, Surface } from "./aircraftmodel";

const SCALE = 1.3;
const ARM_REACH = 0.3;

const SHELL: Surface = { color: 0xdfe3e8, roughness: 0.35, metalness: 0.05 };
const BODY: Surface = { color: 0x2b2e33, roughness: 0.55, metalness: 0.2 };
const CARBON: Surface = { color: 0x1c1d20, roughness: 0.45, metalness: 0.3 };
const MOTOR: Surface = { color: 0x5a5f66, roughness: 0.3, metalness: 0.8 };
const BLADE: Surface = { color: 0x101112, roughness: 0.4, metalness: 0.1 };
const BLUR: Surface = { color: 0x202224, roughness: 0.5, metalness: 0, opacity: 0.16, depthWrite: false, doubleSided: true };
const GLASS: Surface = { color: 0x0b0d10, roughness: 0.05, metalness: 0.0, envStrength: 1.4 };
const LED_RED: Surface = { color: 0xff2a1a, roughness: 0.5, metalness: 0, emissive: 4, emissiveColor: 0xff2a1a };
const LED_GREEN: Surface = { color: 0x29ff5a, roughness: 0.5, metalness: 0, emissive: 4, emissiveColor: 0x29ff5a };

export class DroneModel {
  readonly group = new THREE.Group();
  private rotors: THREE.Object3D[] = [];
  private spin = 0;

  constructor(aircraft: AircraftModel) {
    const m = (s: Surface) => aircraft.plainMaterial(s);
    const box = (w: number, h: number, d: number, s: Surface) =>
      new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m(s));
    const cyl = (r: number, h: number, s: Surface, seg = 16) =>
      new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m(s));

    const g = this.group;
    const body = box(0.22, 0.09, 0.34, BODY);
    g.add(body);
    const shell = box(0.18, 0.05, 0.28, SHELL);
    shell.position.y = 0.065;
    g.add(shell);
    const nose = box(0.12, 0.04, 0.06, SHELL);
    nose.position.set(0, 0.05, -0.17);
    g.add(nose);

    // Arms on the diagonals, motors and rotors at their tips. -z is forward,
    // matching the camera and the aircraft.
    for (const [sx, sz] of [[1, -1], [-1, -1], [1, 1], [-1, 1]] as const) {
      const tip = new THREE.Vector3(sx * ARM_REACH, 0.02, sz * ARM_REACH);
      const len = Math.hypot(tip.x, tip.z);
      const arm = box(0.03, 0.025, len, CARBON);
      arm.position.set(tip.x / 2, 0.02, tip.z / 2);
      arm.rotation.y = Math.atan2(tip.x, tip.z);
      g.add(arm);

      const motor = cyl(0.03, 0.045, MOTOR);
      motor.position.set(tip.x, 0.045, tip.z);
      g.add(motor);

      const rotor = new THREE.Group();
      rotor.position.set(tip.x, 0.072, tip.z);
      const blade = box(0.32, 0.004, 0.024, BLADE);
      rotor.add(blade);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.165, 28), m(BLUR));
      disc.rotation.x = -Math.PI / 2;
      rotor.add(disc);
      g.add(rotor);
      this.rotors.push(rotor);

      // Rear LEDs green, front red: the convention that lets a pilot tell
      // which way a distant drone is facing.
      const led = box(0.02, 0.012, 0.02, sz < 0 ? LED_RED : LED_GREEN);
      led.position.set(tip.x, 0.0, tip.z);
      g.add(led);
    }

    // Gimbal and lens under the nose, and two landing skids.
    const gimbal = cyl(0.035, 0.05, BODY);
    gimbal.position.set(0, -0.07, -0.12);
    g.add(gimbal);
    const cam = box(0.06, 0.05, 0.06, BODY);
    cam.position.set(0, -0.11, -0.13);
    g.add(cam);
    const lens = cyl(0.018, 0.012, GLASS);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, -0.11, -0.165);
    g.add(lens);
    for (const sx of [-1, 1]) {
      const leg = box(0.012, 0.11, 0.012, CARBON);
      leg.position.set(sx * 0.08, -0.09, 0);
      g.add(leg);
      const skid = box(0.014, 0.012, 0.24, CARBON);
      skid.position.set(sx * 0.08, -0.145, 0);
      g.add(skid);
    }

    g.scale.setScalar(SCALE);
    g.visible = false;
  }

  /** `paused` holds the rotors still, for the screenshot harness. */
  update(dt: number, paused: boolean): void {
    if (paused) return;
    // 31 rad/s, not a real 600: a blade turning faster than the frame rate
    // strobes into a slow wrong-way crawl, so it turns visibly and the disc
    // carries the impression of speed.
    this.spin += dt * 31;
    for (let i = 0; i < this.rotors.length; i++) {
      this.rotors[i].rotation.y = (i % 2 ? -1 : 1) * this.spin + i;
    }
  }
}
