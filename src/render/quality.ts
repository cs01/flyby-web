// Adaptive resolution.
//
// The frame cost of this renderer depends on the machine, the window size, the
// weather (an overcast sky marches clouds that a clear one skips) and the city.
// No fixed setting is right for all of those, so instead of guessing, measure
// the frame time and move the render scale until it fits.
//
// Hysteresis matters more than the exact thresholds. A controller that reacts
// to a single slow frame will oscillate between two scales forever, which looks
// far worse than simply running at the lower one, so both directions need a
// sustained run of frames and the step down is faster than the step up.

import * as THREE from "three";

const STEPS = [1.0, 0.85, 0.72, 0.6, 0.5, 0.4];

/** Frame time we aim to stay under, milliseconds. */
const TARGET_MS = 20;
/** Only scale back up when there is real headroom, or it will hunt. */
const COMFORTABLE_MS = 12;

export class AdaptiveQuality {
  private index = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private cooldown = 0;
  /** Non-null while the scale is pinned; see `pin`. */
  private pinned: number | null = null;

  /** Base pixel ratio before scaling. */
  readonly baseRatio: number;

  constructor(renderer: THREE.WebGLRenderer) {
    this.baseRatio = renderer.getPixelRatio();
  }

  get scale(): number {
    return this.pinned ?? STEPS[this.index];
  }

  /**
   * Hold the render scale still.
   *
   * The screenshot harness compares two builds pixel for pixel, and a
   * controller that reacts to frame time would pick a different scale on the
   * slower of the two -- so the comparison would be measuring the resolution
   * rather than the change. Pinning makes the render scale an INPUT of a shot
   * rather than an output of whatever else the machine was doing.
   */
  pin(scale: number): void {
    this.pinned = scale;
  }

  /**
   * Feed a smoothed frame time. Returns true when the scale changed, which is
   * the caller's cue to resize its render targets.
   */
  update(smoothedMs: number, dt: number): boolean {
    if (this.pinned !== null) return false;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return false;
    }

    if (smoothedMs > TARGET_MS) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (smoothedMs < COMFORTABLE_MS) {
      this.fastFrames++;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }

    // Drop quickly (30 frames of being slow is already unpleasant), recover
    // slowly (180 frames), because a wrong step up costs another stutter.
    if (this.slowFrames > 30 && this.index < STEPS.length - 1) {
      this.index++;
      this.slowFrames = 0;
      this.cooldown = 1.5;
      return true;
    }
    if (this.fastFrames > 180 && this.index > 0) {
      this.index--;
      this.fastFrames = 0;
      this.cooldown = 3;
      return true;
    }
    return false;
  }

  apply(renderer: THREE.WebGLRenderer): void {
    renderer.setPixelRatio(this.baseRatio * this.scale);
  }
}
