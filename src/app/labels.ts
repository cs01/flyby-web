// Names on the things you can see.
//
// The app already knew what every landmark was and never said so: a beam of
// light came out of the ground and the only way to learn what it was standing
// on was to read the route list and infer. A label on the thing itself is the
// whole difference between scenery and a place.
//
// Projected in SCREEN SPACE rather than drawn as billboards in the scene, for
// two reasons that both come down to legibility: text in the world is subject
// to the atmosphere, the tone curve and the depth buffer, and a label that is
// hazed out or half inside a building is worse than none; and a screen-space
// label can be clamped to a readable size at any distance, which a world-space
// one cannot without fighting the perspective divide.
//
// Nothing here is rebuilt per frame. The elements are made once per landmark
// and then only their transform and text change, because this runs at 60 Hz.

import * as THREE from "three";

export interface LabelTarget {
  name: string;
  /** World position of the thing being named. */
  x: number;
  y: number;
  z: number;
  /** Drawn dimmer once it has been visited. */
  done: boolean;
}

/** Past this the label is more clutter than information. */
const MAX_RANGE = 18000;

export class Labels {
  private root: HTMLDivElement;
  private els: HTMLElement[] = [];
  private ndc = new THREE.Vector3();

  visible = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "labels";
    parent.append(this.root);
  }

  private ensure(n: number): void {
    while (this.els.length < n) {
      const e = document.createElement("div");
      e.className = "label";
      e.innerHTML = `<b></b><i></i>`;
      this.root.append(e);
      this.els.push(e);
    }
  }

  update(camera: THREE.PerspectiveCamera, targets: LabelTarget[]): void {
    if (!this.visible) {
      this.root.style.display = "none";
      return;
    }
    this.root.style.display = "";
    this.ensure(targets.length);

    for (const [i, t] of targets.entries()) {
      const el = this.els[i];
      this.ndc.set(t.x, t.y, t.z);
      const dist = this.ndc.distanceTo(camera.position);
      this.ndc.project(camera);

      // z outside [-1, 1] is behind the camera or past the far plane. Without
      // this a landmark behind you is projected to a mirrored point in FRONT
      // of you, and the label sits confidently on empty sky.
      const off =
        this.ndc.z < -1 || this.ndc.z > 1 ||
        this.ndc.x < -1.1 || this.ndc.x > 1.1 ||
        this.ndc.y < -1.1 || this.ndc.y > 1.1 ||
        dist > MAX_RANGE;
      if (off) {
        if (el.style.display !== "none") el.style.display = "none";
        continue;
      }

      const x = (this.ndc.x * 0.5 + 0.5) * 100;
      const y = (-this.ndc.y * 0.5 + 0.5) * 100;
      el.style.display = "";
      el.style.left = `${x.toFixed(2)}%`;
      el.style.top = `${y.toFixed(2)}%`;
      el.classList.toggle("done", t.done);

      const name = el.firstElementChild as HTMLElement;
      const range = el.lastElementChild as HTMLElement;
      if (name.textContent !== t.name) name.textContent = t.name;
      // Whole kilometres past ten, because a tenth of a kilometre at that
      // range is a number changing every frame for no reason.
      const km = dist / 1000;
      const label = km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
      if (range.textContent !== label) range.textContent = label;
    }

    for (let i = targets.length; i < this.els.length; i++) {
      this.els[i].style.display = "none";
    }
  }
}
