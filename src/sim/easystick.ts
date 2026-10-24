// The one-thumb stick: the default on a phone.
//
// The two-stick scheme hands a thumb the raw ROLL RATE, and on a phone that
// was the complaint: "hard to control, jerky". A rate command means the bank
// is the integral of where the thumb has been, so holding a turn is a matter
// of flicking in, flicking back to centre at exactly the right moment, and
// correcting the overshoot. Every frame of thumb jitter is integrated into the
// attitude too.
//
// Here the thumb commands an ATTITUDE instead: how far it is from where it
// landed is the bank you get, and how far up or down is the climb. Hold the
// thumb still and the aeroplane holds that bank; let go and it levels and
// holds its height. The assistance is in stick space, the same trick the
// autopilot uses: it writes the -1..1 roll axis that rolls the aeroplane to
// the wanted bank, so the flight model underneath is unchanged and every
// honest thing it does (turn rate from bank and speed, the energy cost of a
// climb, wind) still happens.
//
// No rudder. The model has no sideslip: its turn rate falls straight out of
// the bank, so a turn flown on bank alone is already coordinated and a rudder
// axis would only add a skid nobody on a phone asked for.

import type { Axes } from "./input";

/** Degrees of bank at full thumb travel. Under the 55 deg model limit, so the
 *  limit is the assistance's and never the model's clamp: a clamped bank is a
 *  bank the controller cannot see it has reached. 45 deg comes round in about
 *  11 s at cruise, which is a lap of a landmark. */
export const EASY_MAX_BANK_DEG = 45;

/** CSS pixels from the landing point to full deflection. A thumb pivoting at
 *  its base sweeps about this much without regripping; at 412 px wide that is
 *  under a quarter of the screen, so a thumb that lands near an edge still has
 *  room to reach full the other way. */
export const EASY_RADIUS = 90;

/**
 * Expo on both axes. Lighter than the two-stick 0.55, because an attitude
 * command no longer needs it to hide an overshoot: what is left is fine
 * control near centre. 0.3 puts half travel at 0.39 of full (17 deg of bank)
 * and keeps the centre slope at 0.7, so the first few pixels still visibly
 * do something.
 */
export const EASY_EXPO = 0.3;

/**
 * 90% rise time of the finger filter, seconds.
 *
 * A thumb on glass is noisy: touch digitisers report at 60 to 240 Hz with a
 * pixel or two of jitter, and a fast flick is a step. 0.2 s is short enough
 * that a turn feels like it starts when the thumb moves, and long enough to
 * halve what a spike does: a one-frame 10 px jump on a held half-deflection
 * turn is 4.6 deg of command unfiltered and moves the bank 0.88 deg; filtered
 * it moves it 0.40 (measured in test/touch.check.ts). A slower filter buys
 * little more: 0.35 s still moves it 0.32, and by then a thumb feels it is
 * steering through syrup.
 */
export const EASY_RISE_S = 0.2;

/** A critically damped second-order system reaches 90% at 3.89 / omega. */
const OMEGA = 3.89 / EASY_RISE_S;

/** Bank error, degrees, at which the roll command saturates. With the 130
 *  deg/s roll rate this makes the bank loop a first-order lag of 12/130 =
 *  0.09 s, well inside the finger filter, so the aeroplane follows the filter
 *  rather than adding a second lag the thumb can feel. Larger and the bank
 *  trails the thumb; much smaller and a one-frame step in the error is a full
 *  roll command, which is the snap this file exists to remove. */
const ROLL_AUTHORITY_DEG = 12;

/** Just over the |roll| < 0.02 at which the model starts self-levelling. */
const SELF_LEVEL_BAND = 0.021;

/** Below this the filter has settled and the stick hands back. */
const SETTLED = 0.004;

export interface Finger {
  /** Whether a thumb is down. */
  held: boolean;
  /** Raw deflection from the landing point, -1..1. +x right, +y DOWN the
   *  screen, as the pointer reports it. */
  x: number;
  y: number;
}

export function easyExpo(v: number): number {
  return v * (1 - EASY_EXPO) + v * v * v * EASY_EXPO;
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Critically damped spring toward `target`, advanced EXACTLY over dt (the
 * closed-form solution for a constant target, not an Euler step), so a long
 * frame on a phone that hitches cannot make it ring or blow up.
 *
 * Critically damped rather than first-order: a first-order lag responds to a
 * step with an instant change of SLOPE, which on a bank is a visible kick at
 * the start of every turn. This one starts with zero slope and arrives with
 * zero slope, and never overshoots.
 */
function spring(pos: number, vel: number, target: number, dt: number): [number, number] {
  const e = pos - target;
  const k = vel + OMEGA * e;
  const decay = Math.exp(-OMEGA * dt);
  return [target + (e + k * dt) * decay, (vel - OMEGA * k * dt) * decay];
}

/** Knobs for the vacuity probes in test/touch.check.ts, which have to show
 *  that each bound fails without the thing it is guarding. The app never
 *  passes these. */
export interface EasyStickOptions {
  /** false skips the finger filter: the raw thumb straight to the command. */
  filter?: boolean;
  authorityDeg?: number;
}

export class EasyStick {
  private readonly filter: boolean;
  private readonly authorityDeg: number;
  private x = 0;
  private vx = 0;
  private y = 0;
  private vy = 0;
  /** True while this stick is writing the roll and lift axes. */
  engaged = false;
  /** The bank currently asked for, degrees, for the instruments and tests. */
  bankCommandDeg = 0;

  constructor(opts: EasyStickOptions = {}) {
    this.filter = opts.filter ?? true;
    this.authorityDeg = opts.authorityDeg ?? ROLL_AUTHORITY_DEG;
  }

  /**
   * Overwrites roll, lift and yaw while a thumb is down, and for the moment
   * after it lifts while the command eases back to centre. After that it
   * writes nothing, so the keyboard, the autopilot and the model's own
   * self-levelling own the axes again. `finger` null means the easy scheme is
   * not in use at all.
   */
  update(axes: Axes, finger: Finger | null, rollDeg: number, dt: number): Axes {
    if (!finger) {
      this.engaged = false;
      return axes;
    }
    const ux = finger.held ? clamp1(finger.x) : 0;
    // Finger UP is a climb. That is the screen-direct sense every phone game
    // uses (drag the thing where you want it to go) rather than a real stick's
    // pull-back-to-climb, and it is the sense the mouse drag and the two-stick
    // scheme already use, so the app keeps one answer for this axis.
    const uy = finger.held ? -clamp1(finger.y) : 0;
    if (this.filter) {
      [this.x, this.vx] = spring(this.x, this.vx, ux, dt);
      [this.y, this.vy] = spring(this.y, this.vy, uy, dt);
    } else {
      this.x = ux;
      this.y = uy;
    }

    const quiet =
      Math.abs(this.x) < SETTLED && Math.abs(this.y) < SETTLED &&
      Math.abs(this.vx) < SETTLED && Math.abs(this.vy) < SETTLED;
    if (!finger.held && quiet) {
      this.x = this.vx = this.y = this.vy = 0;
      this.bankCommandDeg = 0;
      this.engaged = false;
      return axes;
    }

    this.engaged = true;
    this.bankCommandDeg = easyExpo(clamp1(this.x)) * EASY_MAX_BANK_DEG;
    const error = this.bankCommandDeg - rollDeg;
    let roll = clamp1(error / this.authorityDeg);
    // The model self-levels whenever |roll| < 0.02 (sim/aircraft.ts), and at
    // a held bank that is exactly where a proportional loop sits: inside a
    // quarter of a degree of the target it let go, the self-levelling pulled
    // 0.34 deg a frame off a 17 deg bank, and the two chattered a 0.7 deg
    // wobble into the horizon. Keeping the command just outside that band
    // leaves a 0.05 deg limit cycle instead, which is under a pixel. Near
    // wings level the self-levelling is going where the command is, so there
    // it is let in.
    if (Math.abs(roll) < SELF_LEVEL_BAND && Math.abs(this.bankCommandDeg) > 1) {
      roll = (error >= 0 ? 1 : -1) * SELF_LEVEL_BAND;
    }
    axes.roll = roll;
    axes.lift = easyExpo(clamp1(this.y));
    axes.yaw = 0;
    return axes;
  }

  /** Drop any half-settled command, e.g. on a tab-away. */
  reset(): void {
    this.x = this.vx = this.y = this.vy = 0;
    this.bankCommandDeg = 0;
    this.engaged = false;
  }
}
