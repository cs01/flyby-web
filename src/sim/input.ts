// Keyboard, pointer and touch, reduced to one set of axes.
//
// Everything upstream of this file deals in "pitch/roll/yaw/lift/boost in
// -1..1", so a phone and a keyboard are the same thing to the flight model.
//
// The smoothing lives here, and it is a RAMP, not a filter. An exponential
// filter never reaches the value you asked for, so a tap gives a fraction of
// an input and holding a key gives an asymptote -- which reads as lag no
// matter how short the time constant. A ramp reaches full deflection in a
// known time (0.14 s here) and releases faster than it engages, which is what
// makes the aircraft feel bolted to the stick.

import { TouchControls, hasTouch, expo, rateLimit } from "./touch";
import type { DroneInput } from "./drone";

export interface Axes {
  /** Positive opens the throttle, negative closes it. */
  throttle: number;
  /** Positive rolls right. */
  roll: number;
  /** Positive yaws right. */
  yaw: number;
  /** Positive climbs. */
  lift: number;
  /** 0..1 sprint. */
  boost: number;
}

/** Seconds from centred to full deflection, and back. */
const ENGAGE = 0.14;
const RELEASE = 0.08;

/**
 * Degrees of look per pixel of mouse travel under pointer lock.
 *
 * 0.11 puts a 180-degree turn at about 1600 px, which is a normal mouse's
 * worth of desk. Higher and a nudge whips the city past; lower and you run out
 * of mat before you have looked behind you.
 */
const LOOK_DEG_PER_PX = 0.11;

function ramp(current: number, target: number, dt: number): number {
  const toward = Math.abs(target) > Math.abs(current) && target * current >= 0;
  const rate = dt / (toward ? ENGAGE : RELEASE);
  const d = target - current;
  return Math.abs(d) <= rate ? target : current + Math.sign(d) * rate;
}

function freshDrone(): DroneInput {
  return {
    forward: 0,
    strafe: 0,
    lift: 0,
    yaw: 0,
    pitch: 0,
    boost: 0,
    lookYawDeg: 0,
    lookPitchDeg: 0,
  };
}

export class Input {
  private keys = new Set<string>();
  private axes: Axes = { throttle: 0, roll: 0, yaw: 0, lift: 0, boost: 0 };
  private target: Axes = { throttle: 0, roll: 0, yaw: 0, lift: 0, boost: 0 };

  /** Pointer drag, normalised to -1..1 of the smaller screen dimension. */
  private dragX = 0;
  private dragY = 0;
  private dragging = false;

  /** Set when the view should swing round for a look; not a control input. */
  lookBack = false;
  /** Toggled by C; the camera cycles chase / cockpit / wing / orbit. */
  cameraCycled = 0;
  /** H presses. The controls card is asked for now rather than imposed. */
  helpToggled = 0;
  /** V presses. Counted, not latched, so main drains it and cannot miss one. */
  droneToggled = 0;
  paused = false;

  /**
   * Clock nudges, in seconds, accumulated since the last `drainTimeNudge`.
   *
   * The input layer does not own the clock -- it reports that a key was
   * pressed and main decides what a nudge means. Holding the offset here would
   * put the scene clock in two places, and the URL is already one of them.
   */
  private timeNudge = 0;
  /** Toggled by T: run the scene clock fast so the sun visibly moves. */
  timelapse = false;
  /** Set by 0: put the clock back on the present. */
  timeReset = false;

  /** Called when the timelapse toggles, so the HUD can say so. */
  onTimelapse: ((on: boolean) => void) | null = null;

  /** Present wherever a finger can reach the screen; null everywhere else. */
  private touch: TouchControls | null = null;

  /** The canvas, kept so pointer lock can be asked for and checked against. */
  private lockTarget: HTMLElement;
  /** Degrees of unread mouse look, accumulated since the last `droneAxes`. */
  private lookX = 0;
  private lookY = 0;
  private locked = false;
  /** Whether anything currently WANTS the mouse captured. */
  private wantLock = false;

  private droneCurrent: DroneInput = freshDrone();
  private droneTarget: DroneInput = freshDrone();

  constructor(target: HTMLElement, ui?: HTMLElement) {
    if (ui && hasTouch()) this.touch = new TouchControls(target, ui);

    addEventListener("keydown", (e) => {
      if (e.repeat) {
        // Held , and . should scrub, so those repeat; nothing else does.
        if (e.code === "Comma" || e.code === "Period") this.nudge(e);
        return;
      }
      this.keys.add(e.code);
      if (e.code === "KeyC") this.cameraCycled++;
      if (e.code === "KeyP") this.paused = !this.paused;
      if (e.code === "KeyH") this.helpToggled++;
      if (e.code === "KeyV") this.droneToggled++;
      // Escape already drops pointer lock in every browser; doing it here as
      // well is what stops us asking for it straight back on the next click.
      if (e.code === "Escape") this.setPointerLock(false);
      if (e.code === "KeyT") {
        this.timelapse = !this.timelapse;
        this.onTimelapse?.(this.timelapse);
      }
      if (e.code === "Digit0") this.timeReset = true;
      this.nudge(e);
      // Arrow keys and space scroll the page otherwise, which is jarring when
      // the page IS the aeroplane.
      if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    // A tab-away with keys held leaves them held forever, and the aircraft
    // flies off on its own while nobody is looking at it.
    addEventListener("blur", () => this.keys.clear());

    target.addEventListener("pointerdown", (e) => {
      // Touch is the virtual stick's, not the mouse stick's. The mouse maps
      // deflection from the centre of the SCREEN, which on a finger means full
      // deflection the instant it lands.
      if (e.pointerType === "touch") return;
      // A click while the drone wants the mouse is a request to get the mouse
      // back, not a stick input: escaping the lock is how you reach the HUD,
      // and clicking the view is how everyone expects to return to the game.
      if (this.wantLock) {
        this.requestLock();
        return;
      }
      this.dragging = true;
      target.setPointerCapture(e.pointerId);
      this.updateDrag(e);
    });
    target.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      if (this.locked) {
        // Under lock there is no cursor position, only movement, and it is
        // already in degrees once scaled. Accumulated rather than sampled, so
        // a fast flick between two frames is not thrown away.
        this.lookX += e.movementX * LOOK_DEG_PER_PX;
        this.lookY += e.movementY * LOOK_DEG_PER_PX;
        return;
      }
      if (this.dragging) this.updateDrag(e);
    });

    this.lockTarget = target;
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.lockTarget;
      // Whatever was half-accumulated when the lock went away is not a look
      // the pilot asked for. Dropping it is what stops the drone spinning on
      // the frame after Escape.
      if (!this.locked) {
        this.lookX = 0;
        this.lookY = 0;
      }
    });
    // A refused or lost lock must not take the mouse deltas with it silently.
    document.addEventListener("pointerlockerror", () => {
      this.locked = false;
    });
    const end = () => {
      this.dragging = false;
      this.dragX = 0;
      this.dragY = 0;
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  private nudge(e: KeyboardEvent): void {
    // Shift takes the step from half an hour to six, so a whole day is two
    // presses rather than forty-eight.
    const step = e.shiftKey ? 6 * 3600 : 1800;
    if (e.code === "Comma") this.timeNudge -= step;
    if (e.code === "Period") this.timeNudge += step;
  }

  /** Seconds of clock movement asked for since the last call. Clears it. */
  drainTimeNudge(): number {
    const n = this.timeNudge;
    this.timeNudge = 0;
    return n;
  }

  /** True once, on the frame after 0 was pressed. */
  drainTimeReset(): boolean {
    const r = this.timeReset;
    this.timeReset = false;
    return r;
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

  /**
   * Whether a roll or rudder input is actually being ASKED for right now,
   * before any smoothing. The smoothed axis cannot answer this: anything that
   * writes to it -- an autopilot, say -- reads its own output back a frame
   * later and cannot tell it from a hand on the stick.
   */
  get manualStick(): boolean {
    return Math.abs(this.target.roll) > 0.02 || Math.abs(this.target.yaw) > 0.02;
  }

  /** Smoothed axes for this frame. */
  private stickRoll = 0;
  private stickYaw = 0;
  private stickLift = 0;

  sample(dt: number): Axes {
    const t = this.target;

    // W is FORWARD, which is the question everybody asks first. It opens the
    // throttle rather than pitching the nose down: on this aeroplane the
    // throttle commands a speed, so holding W accelerates and holding S slows
    // right down to a crawl, and neither one costs you any height.
    //
    // There is no invert-pitch toggle any more. It existed because "up" on a
    // pitch axis genuinely has two right answers; a climb axis on Space/Ctrl
    // has one, and the ambiguity goes away rather than becoming a setting.
    t.throttle = this.held("KeyW") - this.held("KeyS");
    // A key is a step function, and the flight model integrates these axes
    // directly: roll goes straight into 130 deg/s and lift into a 45 m/s
    // vertical speed command. So a tap that lasts one frame asked for FULL
    // deflection, and the aeroplane snapped. Touch never had this problem
    // because a thumb travels 96 px to reach full and gets expo on top; the
    // keyboard had neither.
    //
    // The fix is the one this file's header already says the controls use, and
    // which had only ever been applied to the throttle lever: RATE LIMIT, do
    // not filter. A rate limit reaches exactly the value asked for, in a known
    // time. An exponential filter never arrives, which reads as lag however
    // it is tuned.
    //
    // Release is quicker than push, because letting go should stop the
    // aeroplane doing the thing rather than feeling like a spring unwinding.
    this.stickRoll = rateLimit(
      this.stickRoll,
      this.held("KeyD", "ArrowRight") - this.held("KeyA", "ArrowLeft"),
      dt,
    );
    t.roll = expo(this.stickRoll);
    this.stickYaw = rateLimit(this.stickYaw, this.held("KeyE") - this.held("KeyQ"), dt);
    t.yaw = expo(this.stickYaw);
    // The arrows are a STICK: pull BACK to climb, push forward to dive. That
    // is what every aeroplane does and what a hand reaching for an arrow key
    // expects, and the arrows are free for it now that the throttle is W/S --
    // they were only ever duplicating those keys.
    this.stickLift = rateLimit(
      this.stickLift,
      this.held("ArrowDown", "KeyR") -
        this.held("ArrowUp", "ControlLeft", "ControlRight", "KeyF"),
      dt,
    );
    t.lift = expo(this.stickLift);
    // Space is turbo. It is the key everybody's thumb is already on and the
    // one they reach for meaning "go", and it is no longer the climb axis,
    // which is what made it feel like it did nothing much.
    t.boost = this.held("Space", "ShiftLeft", "ShiftRight");

    if (this.dragging) {
      // The pointer flies it directly: sideways rolls, and UP climbs. That is
      // the screen-direct sense rather than a stick's pull-back-to-climb, and
      // the touch controls match it, because the app already decided this axis
      // gets one answer when it deleted its invert-pitch toggle. It does not
      // touch the throttle, so a mouse user can fly a whole circuit with one
      // hand and still reach for W when they want to get somewhere.
      t.roll = this.dragX;
      t.lift = -this.dragY;
    }

    const touch = this.touch;
    if (touch) {
      // A touched axis WINS over the keyboard rather than summing with it. A
      // phone with a bluetooth keyboard is the only case where both are live,
      // and there the thumb is the more recent intent.
      if (touch.active) {
        t.roll = touch.axes.roll;
        t.lift = touch.axes.lift;
        t.throttle = touch.axes.throttle;
        t.yaw = touch.axes.yaw;
      }
      if (touch.boost) t.boost = 1;
      this.cameraCycled += touch.drainCameraPresses();
    }

    this.lookBack = this.keys.has("KeyB") || (touch?.lookBack ?? false);

    const a = this.axes;
    a.throttle = ramp(a.throttle, t.throttle, dt);
    a.roll = ramp(a.roll, t.roll, dt);
    a.yaw = ramp(a.yaw, t.yaw, dt);
    a.lift = ramp(a.lift, t.lift, dt);
    // Boost is a mode, not a control surface; ramping it would put a
    // quarter-second of nothing between pressing shift and going anywhere.
    a.boost = t.boost;
    return a;
  }

  // --- Pointer lock ---------------------------------------------------------
  //
  // Wanted only by the drone. Everything here degrades to nothing: a browser
  // that refuses the lock, a user who presses Escape, or a platform with no
  // pointer at all leaves `locked` false, the mouse deltas at zero, and the
  // keyboard look working exactly as it did.

  /** True while the mouse is actually captured, not merely asked for. */
  get pointerLocked(): boolean {
    return this.locked;
  }

  /** Ask for or give up the mouse. Safe to call every frame. */
  setPointerLock(want: boolean): void {
    this.wantLock = want;
    if (want) {
      this.requestLock();
    } else if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  private requestLock(): void {
    if (this.locked || !this.lockTarget.requestPointerLock) return;
    // Chrome rejects a request made too soon after an exit, and the rejection
    // arrives as an unhandled promise if it is not caught. Neither the throw
    // nor the rejection is worth reporting: the fallback is the keyboard.
    try {
      const r = this.lockTarget.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      /* no lock, no mouse look, keyboard still flies it */
    }
  }

  /**
   * Smoothed drone axes for this frame, plus the mouse look that has arrived
   * since the last call.
   *
   * Ramped through the same `ramp` the aeroplane uses, so the two machines
   * respond to a key press identically and only the models differ. The look
   * degrees are NOT ramped: they are already a finished movement, and
   * smoothing a mouse is how a game earns the word "floaty".
   */
  droneAxes(dt: number): DroneInput {
    const t = this.droneTarget;
    t.forward = this.held("KeyW") - this.held("KeyS");
    t.strafe = this.held("KeyD") - this.held("KeyA");
    t.yaw = this.held("KeyE", "ArrowRight") - this.held("KeyQ", "ArrowLeft");
    // Same sense as the aeroplane's: ArrowDown climbs, because the arrows are
    // a stick there and having them mean the opposite here would be a trap.
    t.lift = this.held("KeyR", "ArrowDown") - this.held("KeyF", "ArrowUp", "ControlLeft", "ControlRight");
    // Keyboard look. X/Z rather than the arrows, which are already the lift
    // axis; this is the fallback for a browser that will not give up the
    // mouse, and the mouse is the way it is meant to be flown.
    t.pitch = this.held("KeyX") - this.held("KeyZ");
    t.boost = this.held("ShiftLeft", "ShiftRight", "Space");

    const touch = this.touch;
    if (touch?.active) {
      // The virtual stick means the same things it does in the aeroplane:
      // move with the left thumb, turn and climb with the right.
      t.forward = touch.axes.throttle;
      t.strafe = touch.axes.roll;
      t.yaw = touch.axes.yaw;
      t.lift = touch.axes.lift;
    }
    if (touch?.boost) t.boost = 1;

    const a = this.droneCurrent;
    a.forward = ramp(a.forward, t.forward, dt);
    a.strafe = ramp(a.strafe, t.strafe, dt);
    a.lift = ramp(a.lift, t.lift, dt);
    a.yaw = ramp(a.yaw, t.yaw, dt);
    a.pitch = ramp(a.pitch, t.pitch, dt);
    a.boost = t.boost;

    a.lookYawDeg = this.lookX;
    a.lookPitchDeg = -this.lookY;
    this.lookX = 0;
    this.lookY = 0;
    return a;
  }
}
