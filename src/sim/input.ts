// Keyboard, pointer and touch, reduced to one set of axes.
//
// Everything upstream of this file deals in "pitch/roll/yaw/throttle in -1..1",
// so a phone and a keyboard are the same thing to the flight model. The
// smoothing lives here too: a key is binary and an aircraft control is not, so
// raw key state fed straight into the model gives a twitch, not a turn.

export interface Axes {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
}

export class Input {
  private keys = new Set<string>();
  private axes: Axes = { pitch: 0, roll: 0, yaw: 0, throttle: 0.75 };
  private target: Axes = { pitch: 0, roll: 0, yaw: 0, throttle: 0.75 };

  /** Pointer drag, normalised to -1..1 of the smaller screen dimension. */
  private dragX = 0;
  private dragY = 0;
  private dragging = false;

  /** Set when the view should swing round for a look; not a control input. */
  lookBack = false;
  /** Toggled by C; the camera cycles chase / cockpit / wing. */
  cameraCycled = 0;
  paused = false;

  constructor(target: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "KeyC") this.cameraCycled++;
      if (e.code === "KeyP") this.paused = !this.paused;
      // Arrow keys and space scroll the page otherwise, which is jarring when
      // the page IS the aircraft.
      if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());

    target.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      target.setPointerCapture(e.pointerId);
      this.updateDrag(e);
    });
    target.addEventListener("pointermove", (e) => {
      if (this.dragging) this.updateDrag(e);
    });
    const end = () => {
      this.dragging = false;
      this.dragX = 0;
      this.dragY = 0;
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  private updateDrag(e: PointerEvent): void {
    const r = (e.target as HTMLElement).getBoundingClientRect();
    const half = Math.min(r.width, r.height) * 0.42;
    this.dragX = Math.max(-1, Math.min(1, (e.clientX - r.width / 2) / half));
    this.dragY = Math.max(-1, Math.min(1, (e.clientY - r.height / 2) / half));
  }

  private held(...codes: string[]): number {
    return codes.some((c) => this.keys.has(c)) ? 1 : 0;
  }

  /** Smoothed axes for this frame. */
  sample(dt: number): Axes {
    const t = this.target;
    t.pitch = this.held("ArrowUp", "KeyW") - this.held("ArrowDown", "KeyS");
    t.roll = this.held("ArrowRight", "KeyD") - this.held("ArrowLeft", "KeyA");
    t.yaw = this.held("KeyE") - this.held("KeyQ");

    if (this.dragging) {
      // Pointer overrides the keys, and behaves like a STICK: pulling back
      // (down the screen) raises the nose. The code used to negate this, which
      // contradicted the comment right above it and felt inverted to anyone who
      // reached for the mouse first.
      t.pitch = this.dragY;
      t.roll = this.dragX;
    }

    const throttleDelta = this.held("ShiftLeft", "ShiftRight", "Equal") - this.held("ControlLeft", "Minus");
    t.throttle = Math.max(0, Math.min(1, t.throttle + throttleDelta * dt * 0.7));

    this.lookBack = this.keys.has("Space");

    // First-order smoothing. The time constant is short enough to feel direct
    // and long enough that a key press is a control movement, not a step.
    const k = 1 - Math.pow(0.0008, dt);
    const a = this.axes;
    a.pitch += (t.pitch - a.pitch) * k;
    a.roll += (t.roll - a.roll) * k;
    a.yaw += (t.yaw - a.yaw) * k;
    a.throttle = t.throttle;
    return a;
  }
}
