// On-screen flight controls for a touch device.
//
// The stick is DYNAMIC: it appears where the thumb lands rather than living in
// a fixed corner. A fixed pad has to be found by eye every time, and it costs a
// permanent hole in the picture on the one device with the least picture to
// spare. A stick that materialises under the thumb costs nothing until it is
// used, and the thumb is already where it wants to be when it appears.
//
// Two zones, split down the middle, because the two hands do different jobs:
// left is the stick (roll and climb), right is the throttle (fore/aft) and the
// rudder (left/right). Both are RELATIVE to where the finger went down. An
// absolute mapping -- deflection from the centre of the screen, which is what
// the mouse uses -- is fine for a mouse that is already somewhere, and wrong
// for a finger that has to arrive: the aircraft snaps to full deflection on
// touch-down before the thumb has moved at all.
//
// Everything above this file sees the same -1..1 axes a keyboard produces, so
// the flight model has no idea a phone is involved.

/**
 * Where the finger must travel for full deflection, in CSS pixels.
 *
 * The stick is the bigger of the two on purpose. A 64 px roll travel meant a
 * thumb flick was already at the bank limit before the aeroplane had visibly
 * moved, so every turn was entered at full deflection and then corrected back
 * out of -- the overshoot was in the mapping, not in the flight model.
 */
export const STICK_RADIUS = 96;
export const THROTTLE_RADIUS = 64;

/**
 * How much of the roll and rudder travel is spent on small inputs.
 *
 * A cubic blend, not a dead zone: a dead zone makes the first few pixels do
 * NOTHING, which reads as a broken control, while expo makes them do a little.
 * The ends are untouched -- full travel is still full deflection -- so nothing
 * is given up for the fine control near centre.
 */
export const ROLL_EXPO = 0.55;

/**
 * Seconds from centre to full deflection on a key, and back.
 *
 * 0.28 s is close to how long a hand actually takes to move a stick through
 * full travel, and it is short enough that the control never feels laggy: a
 * held key is at full authority in under a third of a second. The release is
 * quicker because stopping should feel immediate.
 */
export const STICK_PUSH_S = 0.28;
export const STICK_RELEASE_S = 0.16;

/**
 * Move `have` toward `want` at a bounded rate. Not an exponential filter: this
 * one arrives, and arrives when it says it will.
 */
export function rateLimit(have: number, want: number, dt: number): number {
  const towardCentre = Math.abs(want) < Math.abs(have);
  const step = dt / (towardCentre ? STICK_RELEASE_S : STICK_PUSH_S);
  const d = want - have;
  if (Math.abs(d) <= step) return want;
  return have + Math.sign(d) * step;
}

export function expo(v: number, amount = ROLL_EXPO): number {
  return v * (1 - amount) + v * v * v * amount;
}

/**
 * Fraction of the viewport height, measured from the top, that the flight
 * zones do NOT claim. The clock scrubber and the panels live up there and they
 * are what a tap in that band is for.
 */
const TOP_DEAD_BAND = 0.26;

export interface TouchAxes {
  roll: number;
  lift: number;
  throttle: number;
  yaw: number;
}

interface Stick {
  pointerId: number;
  originX: number;
  originY: number;
  /** Deflection, -1..1, already clamped. The knob's transform is drawn FROM
      these; they are not read back out of the DOM. */
  x: number;
  y: number;
  radius: number;
  ring: HTMLElement;
  knob: HTMLElement;
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

export class TouchControls {
  /** True while at least one flight zone is being touched. */
  active = false;
  private homeLeft?: HTMLElement;
  private homeRight?: HTMLElement;
  readonly axes: TouchAxes = { roll: 0, lift: 0, throttle: 0, yaw: 0 };
  /** Latched by the boost button; read every frame. */
  boost = false;

  private root: HTMLDivElement;
  private left: Stick | null = null;
  private right: Stick | null = null;
  private cameraPresses = 0;
  private lookBackHeld = false;

  constructor(surface: HTMLElement, ui: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "touch";
    ui.append(this.root);

    this.root.append(this.buttons());

    // Persistent HOME rings, one per zone.
    //
    // The sticks themselves stay dynamic, for all the reasons above: they still
    // materialise wherever the thumb lands. What was missing was any way to
    // DISCOVER that. A control with no affordance is not minimal, it is
    // invisible, and on a phone that is the difference between flying and
    // fighting the screen. These are drawn faint, they are not the input (the
    // whole zone is), and they fade out while that zone's stick is live so two
    // rings are never on screen at once.
    this.homeLeft = this.home("left");
    this.homeRight = this.home("right");
    this.root.append(this.homeLeft, this.homeRight);

    surface.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      const r = surface.getBoundingClientRect();
      if (e.clientY < r.top + r.height * TOP_DEAD_BAND) return;
      const side = e.clientX < r.left + r.width / 2 ? "left" : "right";
      if (side === "left" && this.left) return;
      if (side === "right" && this.right) return;
      // Capture on the surface, not on the ring: the ring is drawn under the
      // finger and moving off it must not end the gesture.
      surface.setPointerCapture(e.pointerId);
      const stick = this.spawn(e.pointerId, e.clientX, e.clientY, side);
      if (side === "left") this.left = stick;
      else this.right = stick;
      this.recompute();
      e.preventDefault();
    });

    surface.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "touch") return;
      this.drag(e);
    });

    const end = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (this.left && this.left.pointerId === e.pointerId) {
        this.despawn(this.left);
        this.left = null;
      }
      if (this.right && this.right.pointerId === e.pointerId) {
        this.despawn(this.right);
        this.right = null;
      }
      this.recompute();
    };
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
    // A backgrounded tab keeps the last deflection forever, and the aeroplane
    // flies off on its own while nobody is looking at it.
    addEventListener("blur", () => {
      for (const s of [this.left, this.right]) if (s) this.despawn(s);
      this.left = null;
      this.right = null;
      this.recompute();
    });
  }

  /** Camera-cycle taps since the last call. Clears them. */
  drainCameraPresses(): number {
    const n = this.cameraPresses;
    this.cameraPresses = 0;
    return n;
  }

  get lookBack(): boolean {
    return this.lookBackHeld;
  }

  private buttons(): HTMLElement {
    const col = document.createElement("div");
    col.className = "touch-btns";

    const add = (label: string, onDown: () => void, onUp?: () => void): HTMLElement => {
      const b = document.createElement("button");
      b.className = "touch-btn";
      b.textContent = label;
      // pointerdown, not click: a click waits for the finger to lift, and a
      // camera change or a look-back wants to happen when the thumb arrives.
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDown();
      });
      if (onUp) {
        b.addEventListener("pointerup", onUp);
        b.addEventListener("pointercancel", onUp);
        b.addEventListener("pointerleave", onUp);
      }
      col.append(b);
      return b;
    };

    add("CAM", () => this.cameraPresses++);
    const boost = add("BST", () => {
      this.boost = !this.boost;
      boost.classList.toggle("on", this.boost);
    });
    add(
      "LOOK",
      () => (this.lookBackHeld = true),
      () => (this.lookBackHeld = false),
    );
    return col;
  }

  /** The faint always-there ring that says "put your thumb about here". */
  private home(side: "left" | "right"): HTMLElement {
    const el = document.createElement("div");
    el.className = `touch-home ${side}`;
    const knob = document.createElement("div");
    knob.className = "touch-home-knob";
    el.append(knob);
    return el;
  }

  private spawn(pointerId: number, x: number, y: number, side: "left" | "right"): Stick {
    const ring = document.createElement("div");
    ring.className = `touch-ring ${side}`;
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    const knob = document.createElement("div");
    knob.className = "touch-knob";
    ring.append(knob);
    this.root.append(ring);
    // The ring fades in on the next frame; appending it already visible makes
    // it look like it was there before the finger was.
    requestAnimationFrame(() => ring.classList.add("in"));
    (side === "left" ? this.homeLeft : this.homeRight)?.classList.add("busy");
    const radius = side === "left" ? STICK_RADIUS : THROTTLE_RADIUS;
    return { pointerId, originX: x, originY: y, x: 0, y: 0, radius, ring, knob };
  }

  private despawn(s: Stick): void {
    const home = s.radius === STICK_RADIUS ? this.homeLeft : this.homeRight;
    home?.classList.remove("busy");
    s.ring.classList.remove("in");
    setTimeout(() => s.ring.remove(), 200);
  }

  private drag(e: PointerEvent): void {
    const s =
      this.left && this.left.pointerId === e.pointerId
        ? this.left
        : this.right && this.right.pointerId === e.pointerId
          ? this.right
          : null;
    if (!s) return;
    s.x = clamp1((e.clientX - s.originX) / s.radius);
    s.y = clamp1((e.clientY - s.originY) / s.radius);
    s.knob.style.transform =
      `translate(-50%, -50%) translate(${s.x * s.radius}px, ${s.y * s.radius}px)`;
    this.recompute();
  }

  private recompute(): void {
    const a = this.axes;
    const l = this.left ?? { x: 0, y: 0 };
    const r = this.right ?? { x: 0, y: 0 };
    // Expo on the two axes a thumb SWIPES rather than holds. Lift and throttle
    // are pushed to a position and left there, and softening those would just
    // make them feel slack.
    a.roll = expo(l.x);
    // Finger UP is a climb, which is the same sense as the mouse drag on the
    // desktop build. It is the screen-direct convention rather than the
    // pull-back-to-climb one a real stick uses, and the two must not disagree
    // between the two builds of the same app -- the app already decided, when
    // it deleted its invert-pitch toggle, that this axis gets one answer.
    a.lift = -l.y;
    a.throttle = -r.y;
    a.yaw = expo(r.x);
    this.active = this.left !== null || this.right !== null;
  }
}

/**
 * Whether a finger can reach the screen at all.
 *
 * This is the test for BUILDING the controls, and it is deliberately the loose
 * one. A touchscreen laptop reports a fine primary pointer and still gets
 * poked; the sticks draw nothing until a finger lands, so arming them where
 * they may never be used costs nothing, whereas the strict test costs a whole
 * class of device its only working input.
 */
export function hasTouch(): boolean {
  return navigator.maxTouchPoints > 0;
}

/**
 * Whether the device is FLOWN with thumbs, which is a different question.
 *
 * Coarse pointer rather than a user-agent string or a width: a phone in
 * landscape is wide, and what is being asked is what the input device is,
 * which is the thing `pointer: coarse` actually answers. Used for the things
 * that must not appear on a machine with a keyboard -- the permanent buttons,
 * and a controls card that would otherwise name keys nobody has.
 */
export function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches && hasTouch();
}
