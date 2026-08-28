// A camera that circles the city centre, with mouse/touch drag to steer.
//
// This is the placeholder the aircraft replaces, but it is also the mode a
// screenshot wants: a slow, level orbit shows a city's shape better than any
// flight path, and it never puts the camera somewhere unflattering.

import * as THREE from "three";

export interface OrbitOptions {
  centre: THREE.Vector3;
  radius: number;
  height: number;
}

export class OrbitCam {
  private cam: THREE.PerspectiveCamera;
  private centre: THREE.Vector3;
  private radius: number;
  private height: number;
  private angle = 0;
  private pitch = -0.18;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  /** Radians per second; drag sets it, friction returns it to the idle drift. */
  private spin = 0.045;

  speed = 0;
  heading = 0;

  constructor(cam: THREE.PerspectiveCamera, opts: OrbitOptions) {
    this.cam = cam;
    this.centre = opts.centre.clone();
    this.radius = opts.radius;
    this.height = opts.height;

    const el = cam as unknown as object;
    void el;
    addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    addEventListener("pointerup", () => (this.dragging = false));
    addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.angle -= (e.clientX - this.lastX) * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this.lastY) * 0.002, -1.2, 0.5);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    addEventListener(
      "wheel",
      (e) => {
        this.radius = THREE.MathUtils.clamp(this.radius * (1 + e.deltaY * 0.0011), 260, 40000);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  update(dt: number): void {
    if (!this.dragging) this.angle += this.spin * dt;

    const x = this.centre.x + Math.sin(this.angle) * this.radius;
    const z = this.centre.z + Math.cos(this.angle) * this.radius;
    const y = this.height + this.pitch * this.radius * -0.6;

    this.cam.position.set(x, Math.max(y, this.centre.y + 40), z);
    this.cam.lookAt(this.centre.x, this.centre.y + this.radius * 0.06, this.centre.z);

    this.speed = Math.abs(this.spin) * this.radius;
    this.heading = ((Math.atan2(this.centre.x - x, this.centre.z - z) * 180) / Math.PI + 360) % 360;
  }
}
