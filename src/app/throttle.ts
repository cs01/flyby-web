// The throttle as a thing you can see and drag.
//
// W/S already move the lever, and the two-stick scheme's right thumb does too, but
// neither shows where the lever IS, and with the lever now reaching Mach 1
// "how fast am I going and how much is left" is the question. A slider on the
// right edge answers both and is the one control a phone in clean view keeps.

import { MACH1 } from "../sim/aircraft";
import { getUnits } from "./units";

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

  /**
   * `ground` is the car or the drone: the slider is their cruise speed, and
   * a road speed reads in mph or km/h, not knots.
   */
  update(lever: number, speedMs: number, visible: boolean, ground = false): void {
    this.root.style.display = visible ? "" : "none";
    // Do not fight the thumb: while dragging, the slider is the source.
    if (!this.dragging) this.input.value = String(Math.round(lever * 1000));
    if (ground) {
      const metric = getUnits() === "metric";
      const v = Math.abs(speedMs) * (metric ? 3.6 : 2.236936);
      this.readout.textContent = `${Math.round(v)} ${metric ? "km/h" : "mph"}`;
      return;
    }
    const kt = speedMs * 1.943844;
    const mach = speedMs / MACH1;
    this.readout.textContent = mach >= 0.5 ? `M ${mach.toFixed(2)}` : `${Math.round(kt)} kt`;
  }
}
