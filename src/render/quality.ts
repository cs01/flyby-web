// Adaptive quality: features first, then resolution.
//
// The frame cost of this renderer depends on the machine, the window size, the
// weather (an overcast sky marches clouds that a clear one skips) and the city.
// No fixed setting is right for all of those, so instead of guessing, measure
// the frame time and walk a LADDER until it fits.
//
// The ladder sheds features before it touches resolution, because resolution
// is what makes a frame look broken: below a device pixel per CSS pixel every
// edge is a staircase. The features go in order of the frame time they give
// back against how much of the picture they take (tools/profile.ts measures
// both halves; the numbers are with each step below).
//
// Hysteresis matters more than the exact thresholds. A controller that reacts
// to a single slow frame will oscillate between two steps forever, which looks
// far worse than simply running at the lower one, so both directions need a
// sustained run of frames and the step down is faster than the step up.
//
// THE WAY BACK UP. A browser paces frames to the display, so on a 60 Hz panel
// a frame that would have taken 9 ms still reports 16.7, and "comfortably under
// budget" can never be seen. The old controller waited for 12 ms and therefore
// never stepped back up on a 60 Hz screen once it had stepped down. Running AT
// the refresh interval now also counts as headroom: the controller tries the
// next step up, and if that turns out slow it comes back down and waits twice
// as long before trying it again.

import * as THREE from "three";

/** What a step of the ladder switches. Everything on is `FULL_FEATURES`. */
export interface Features {
  /** Screen-space reflections on the water and the curtain walls. */
  ssr: boolean;
  /** The phone tier's cloud march (40 view steps and 3 light steps, not 64 and 5). */
  lowClouds: boolean;
  /** Screen-space ambient occlusion. */
  ao: boolean;
  /** Two sun cascades at most 1024, and the aircraft's probes at their small sizes. */
  lowShadows: boolean;
  /** Multisampling on the scene target, where the tier has it. */
  msaa: boolean;
}

export const FULL_FEATURES: Features = { ssr: true, lowClouds: false, ao: true, lowShadows: false, msaa: true };

interface Step {
  features: Features;
  scale: number;
}

/**
 * Feature steps, in order. Each step's share of the frame, measured with
 * `flybyShot.setLevel` in paired 2 s windows on an M4 (median of six pairs;
 * manhattan-cruise / manhattan-street / sf-street at 1280x720):
 *
 *   two small cascades   12% / 7% / 12%   softer near shadows, the city map from 1.4 km
 *   ambient occlusion    10% / 2% / 10%   contact darkening in the street canyons
 *   msaa                 25% / 18% / 16%  edge aliasing, least visible at high dpr
 *   ssr                   2% / 2% / 1%    the city leaves the water and the glass
 *   phone cloud march     0% under a clear or 30% sky; only an overcast pays it
 *
 * MSAA saves the most but costs the most to look at, so the two subtle steps
 * go first; SSR and the cloud march save so little that they come after it,
 * just before resolution starts to go.
 */
const FEATURE_STEPS: (keyof Features)[] = ["lowShadows", "ao", "msaa", "ssr", "lowClouds"];
const SCALES = [1.0, 0.85, 0.72, 0.6, 0.5, 0.4];

/**
 * Frame time above which a sustained run of frames steps down, and below which
 * one steps up, milliseconds, per tier.
 *
 * Full aims at 60 fps: 18.5 ms is a smoothed frame that is missing vsync often
 * enough to be seen. The reduced tier aims at 30 fps, not 50. A mid-range
 * Android GPU never makes 20 ms on this renderer at any scale worth looking at,
 * so chasing it walked the scale to the bottom step: 0.4 of a 1.5 ratio is 0.6
 * device pixels per CSS pixel, about 250 px across a phone, and the owner's
 * phone showed a picture made of visible blocks. A steady 30 at a readable
 * resolution beats a blurry frame that still misses 50; 36 ms rather than
 * 34 because a phone holding 30 on a 60 Hz panel reports 33.3 with jitter.
 */
const TARGET_MS = { full: 18.5, reduced: 36 };
const COMFORTABLE_MS = { full: 12, reduced: 22 };

/**
 * Lowest drawing-buffer pixels per CSS pixel the controller may choose. Below
 * one, the scene is upscaled and every edge turns into a staircase, which reads
 * far worse than the frame time it buys.
 */
const MIN_DEVICE_PER_CSS = 1.0;

const DOWN_FRAMES = 30;
/** Smoothed frame time this many times the target drops two steps, not one. */
const FAR_OVER = 1.6;
const UP_FRAMES = 180;
/** A step up that proves too slow within this long doubles the next wait. */
const BOUNCE_S = 6;
const MAX_UP_FRAMES = 3600;

/** Which features a tier has to shed at all; a phone already has no SSR or AO. */
export interface TierFeatures {
  ssr: boolean;
  ao: boolean;
  /** The tier marches the full cloud step count. */
  fullClouds: boolean;
  /** The tier draws more than two cascades or maps over 1024. */
  bigShadows: boolean;
  /** The tier multisamples the scene target. */
  msaa: boolean;
}

/** The ladder for a tier: every feature step that changes something, then resolution. */
export function buildLadder(baseRatio: number, tier: TierFeatures): Step[] {
  const steps: Step[] = [];
  let f: Features = { ...FULL_FEATURES };
  steps.push({ features: f, scale: 1 });
  const has: Record<keyof Features, boolean> = {
    ssr: tier.ssr, lowClouds: tier.fullClouds, ao: tier.ao, lowShadows: tier.bigShadows, msaa: tier.msaa,
  };
  for (const k of FEATURE_STEPS) {
    if (!has[k]) continue;
    f = { ...f, [k]: k === "lowClouds" || k === "lowShadows" };
    steps.push({ features: f, scale: 1 });
  }
  for (let i = 1; i < SCALES.length; i++) {
    if (baseRatio * SCALES[i] < MIN_DEVICE_PER_CSS - 1e-6) break;
    steps.push({ features: f, scale: SCALES[i] });
  }
  return steps;
}

export class AdaptiveQuality {
  private index = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private cooldown = 0;
  private upWait = UP_FRAMES;
  /** Seconds since the last step up, for the bounce test. */
  private sinceUp = Infinity;
  /** Shortest recent frame, which is the display's refresh interval or less. */
  private refreshMs = 1000 / 60;
  /** Non-null while the scale is pinned; see `pin`. */
  private pinned: number | null = null;
  private frozen = false;

  /** Base pixel ratio before scaling. */
  readonly baseRatio: number;
  readonly ladder: Step[];

  private readonly targetMs: number;
  private readonly comfortableMs: number;

  constructor(
    renderer: THREE.WebGLRenderer,
    tier: "full" | "reduced" = "full",
    features: TierFeatures = {
      ssr: tier === "full", ao: tier === "full", fullClouds: tier === "full", bigShadows: tier === "full", msaa: tier === "full",
    },
  ) {
    this.baseRatio = renderer.getPixelRatio();
    this.targetMs = TARGET_MS[tier];
    this.comfortableMs = COMFORTABLE_MS[tier];
    this.ladder = buildLadder(this.baseRatio, features);
  }

  get scale(): number {
    return this.pinned ?? this.ladder[this.index].scale;
  }

  /** What the current step leaves switched on. A pinned controller has everything. */
  get features(): Features {
    return this.pinned !== null ? FULL_FEATURES : this.ladder[this.index].features;
  }

  /** Index into the ladder, for the HUD and the harness. */
  get level(): number {
    return this.index;
  }

  /**
   * Hold the render scale still.
   *
   * The screenshot harness compares two builds pixel for pixel, and a
   * controller that reacts to frame time would pick a different scale on the
   * slower of the two -- so the comparison would be measuring the resolution
   * rather than the change. Pinning makes the render scale an INPUT of a shot
   * rather than an output of whatever else the machine was doing, and it
   * holds every feature on for the same reason.
   */
  pin(scale: number): void {
    this.pinned = scale;
  }

  /**
   * Hold a ladder step, features and scale both: tools/profile.ts measures
   * each step this way (`?qlevel=N`). Clears any pin.
   */
  force(level: number): void {
    this.pinned = null;
    this.frozen = true;
    this.index = Math.max(0, Math.min(this.ladder.length - 1, level));
  }

  /**
   * Feed a smoothed frame time and the raw one. Returns true when the step
   * changed, which is the caller's cue to resize its render targets and
   * re-read `features`.
   */
  update(smoothedMs: number, dt: number, rawMs = smoothedMs): boolean {
    if (this.pinned !== null || this.frozen) return false;
    // Decays upward slowly so one odd short frame does not stick.
    this.refreshMs = Math.min(rawMs > 1 ? rawMs : this.refreshMs, this.refreshMs + 0.01);
    this.sinceUp += dt;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return false;
    }

    const atRefresh = smoothedMs < this.refreshMs * 1.06 && smoothedMs < this.targetMs;
    if (smoothedMs > this.targetMs) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (smoothedMs < this.comfortableMs || atRefresh) {
      this.fastFrames++;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }

    if (this.slowFrames > DOWN_FRAMES && this.index < this.ladder.length - 1) {
      // Slow straight after a step up: that step does not fit, so the next
      // attempt waits twice as long. A step that held for a while resets it.
      if (this.sinceUp < BOUNCE_S) this.upWait = Math.min(MAX_UP_FRAMES, this.upWait * 2);
      // Far over budget, two steps at once. Each step costs half a second of
      // slow frames and a cooldown, and a laptop that loads Manhattan at 50 ms
      // would otherwise spend the first ten seconds of the flight walking
      // down a ladder one rung at a time.
      const far = smoothedMs > this.targetMs * FAR_OVER;
      this.index = Math.min(this.ladder.length - 1, this.index + (far ? 2 : 1));
      this.slowFrames = 0;
      this.cooldown = 1.5;
      return true;
    }
    if (this.sinceUp > 30) this.upWait = UP_FRAMES;
    if (this.fastFrames > this.upWait && this.index > 0) {
      this.index--;
      this.fastFrames = 0;
      this.cooldown = 3;
      this.sinceUp = 0;
      return true;
    }
    return false;
  }

  apply(renderer: THREE.WebGLRenderer): void {
    renderer.setPixelRatio(this.baseRatio * this.scale);
  }
}
