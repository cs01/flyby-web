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
import { formatDistance } from "./units";

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

/**
 * How many can be on screen at once.
 *
 * Wikipedia knows about forty things within ten kilometres of anywhere
 * interesting, and drawing all forty produced a solid bar of overlapping black
 * boxes across the middle of the view. The nearest handful is the useful set:
 * the rest are in the list on the left, which is where a complete answer
 * belongs.
 */
const MAX_ON_SCREEN = 9;

/** Rough label size in screen pixels, for the overlap test. */
const CHAR_PX = 6.6;
const PAD_PX = 40;
const ROW_PX = 24;

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

    // Nearest first, so when two labels collide the one that survives is the
    // one you are closer to -- which is very nearly always the one you meant.
    const order = targets
      .map((t, i) => ({ t, i, d: Math.hypot(t.x - camera.position.x, t.z - camera.position.z) }))
      .sort((a, b) => a.d - b.d);

    const placed: { x: number; y: number; w: number }[] = [];
    let shown = 0;

    for (const { t, i } of order) {
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

      // Clamped inside the viewport by the label's own half-width, or a name
      // near the edge is drawn half off the screen and the half that goes is
      // usually the end of the name.
      const halfPct = ((t.name.length * CHAR_PX + PAD_PX) / 2 / innerWidth) * 100;
      const x = Math.max(halfPct, Math.min(100 - halfPct, (this.ndc.x * 0.5 + 0.5) * 100));
      const y = (-this.ndc.y * 0.5 + 0.5) * 100;

      // Overlap, in pixels rather than percent, because a label's width is in
      // pixels and the viewport is not square. The size is ESTIMATED from the
      // text rather than measured: measuring means reading offsetWidth, which
      // forces a layout, and forcing nine layouts a frame to tidy up nine
      // labels is a bad trade.
      const px = (x / 100) * innerWidth;
      const py = (y / 100) * innerHeight;
      const w = t.name.length * CHAR_PX + PAD_PX;
      const clash = placed.some(
        (p) => Math.abs(p.y - py) < ROW_PX && Math.abs(p.x - px) < (p.w + w) / 2,
      );
      if (clash || shown >= MAX_ON_SCREEN) {
        if (el.style.display !== "none") el.style.display = "none";
        continue;
      }
      placed.push({ x: px, y: py, w });
      shown++;

      el.style.display = "";
      el.style.left = `${x.toFixed(2)}%`;
      el.style.top = `${y.toFixed(2)}%`;
      el.classList.toggle("done", t.done);

      const name = el.firstElementChild as HTMLElement;
      const range = el.lastElementChild as HTMLElement;
      if (name.textContent !== t.name) name.textContent = t.name;
      const label = formatDistance(dist);
      if (range.textContent !== label) range.textContent = label;
    }

    for (let i = targets.length; i < this.els.length; i++) {
      this.els[i].style.display = "none";
    }
  }
}
