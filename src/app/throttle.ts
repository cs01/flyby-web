// The throttle as a thing you can see and drag.
//
// W/S already move the lever, and the right-hand touch zone does too, but
// neither shows where the lever IS, and with the lever now reaching Mach 1
// "how fast am I going and how much is left" is the question. A slider on the
// right edge answers both and is the one control a phone in clean view keeps.

import { MACH1 } from "../sim/aircraft";

export class ThrottleSlider {
  private root: HTMLDivElement;
  private input: HTMLInputElement;
  private readout: HTMLDivElement;
  private dragging = false;
  /** Lever position the user set, read once per frame by main. */
  private pending: number | null = null;

  constructor(ui: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "throttle";
    this.readout = document.createElement("div");
    this.readout.className = "throttle-readout";
    this.input = document.createElement("input");
    this.input.type = "range";
    this.input.min = "0";
    this.input.max = "1000";
    this.input.setAttribute("aria-label", "Throttle");
    this.input.addEventListener("pointerdown", () => (this.dragging = true));
    addEventListener("pointerup", () => (this.dragging = false));
    this.input.addEventListener("input", () => {
      this.pending = Number(this.input.value) / 1000;
    });
    const cap = document.createElement("div");
    cap.className = "throttle-cap";
    cap.textContent = "thr";
    this.root.append(this.readout, this.input, cap);
    ui.append(this.root);
  }

  /** A lever position the user dragged to since the last call, or null. */
  take(): number | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  update(lever: number, airspeed: number, visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
    // Do not fight the thumb: while dragging, the slider is the source.
    if (!this.dragging) this.input.value = String(Math.round(lever * 1000));
    const kt = airspeed * 1.943844;
    const mach = airspeed / MACH1;
    this.readout.textContent = mach >= 0.5 ? `M ${mach.toFixed(2)}` : `${Math.round(kt)} kt`;
  }
}
