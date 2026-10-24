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

/**
 * Frame time we aim to stay under, and the headroom needed before scaling back
 * up (or it will hunt), milliseconds, per tier.
 *
 * The reduced tier aims at 30 fps, not 50. A mid-range Android GPU never makes
 * 20 ms on this renderer at any scale worth looking at, so chasing it walked
 * the scale to the bottom step: 0.4 of a 1.5 ratio is 0.6 device pixels per CSS
 * pixel, about 250 px across a phone, and the owner's phone showed a picture
 * made of visible blocks. A steady 30 at a readable resolution beats a blurry
 * frame that still misses 50.
 */
const TARGET_MS = { full: 20, reduced: 34 };
const COMFORTABLE_MS = { full: 12, reduced: 22 };

/**
 * Lowest drawing-buffer pixels per CSS pixel the controller may choose. Below
 * one, the scene is upscaled and every edge turns into a staircase, which reads
 * far worse than the frame time it buys.
 */
const MIN_DEVICE_PER_CSS = 1.0;

export class AdaptiveQuality {
  private index = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private cooldown = 0;
  /** Non-null while the scale is pinned; see `pin`. */
  private pinned: number | null = null;

  /** Base pixel ratio before scaling. */
  readonly baseRatio: number;

  private readonly targetMs: number;
  private readonly comfortableMs: number;
  /** Deepest index into STEPS that keeps MIN_DEVICE_PER_CSS. */
  private readonly lowest: number;

  constructor(renderer: THREE.WebGLRenderer, tier: "full" | "reduced" = "full") {
    this.baseRatio = renderer.getPixelRatio();
    this.targetMs = TARGET_MS[tier];
    this.comfortableMs = COMFORTABLE_MS[tier];
    let lowest = 0;
    while (lowest + 1 < STEPS.length && this.baseRatio * STEPS[lowest + 1] >= MIN_DEVICE_PER_CSS - 1e-6) lowest++;
    this.lowest = lowest;
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

    if (smoothedMs > this.targetMs) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (smoothedMs < this.comfortableMs) {
      this.fastFrames++;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }

    // Drop quickly (30 frames of being slow is already unpleasant), recover
    // slowly (180 frames), because a wrong step up costs another stutter.
    if (this.slowFrames > 30 && this.index < this.lowest) {
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
