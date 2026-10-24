// The gate on the touch controls.
//
// This is the only input path with no keyboard to fall back on: get a sign
// wrong and the phone build rolls left when you push right, with nothing else
// in the app disagreeing. It is also the code most likely to break silently,
// because it is a state machine over pointer ids and every wrong answer still
// produces a number in -1..1.
//
// Run against a DOM stub rather than a browser. TouchControls touches a small,
// fixed surface of the DOM -- createElement, append, classList, style,
// addEventListener, getBoundingClientRect -- so the stub is short, and a check
// that runs in `bun run check` in 50 ms is one that actually gets run.

class FakeClassList {
  private set = new Set<string>();
  constructor(initial: string) {
    for (const c of initial.split(/\s+/)) if (c) this.set.add(c);
  }
  add(c: string) { this.set.add(c); }
  remove(c: string) { this.set.delete(c); }
  toggle(c: string, on?: boolean) { (on ?? !this.set.has(c)) ? this.set.add(c) : this.set.delete(c); }
  contains(c: string) { return this.set.has(c); }
}

class FakeElement {
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  textContent = "";
  classList = new FakeClassList("");
  private listeners = new Map<string, ((e: any) => void)[]>();
  private _class = "";

  constructor(readonly tag: string) {}

  get className() { return this._class; }
  set className(v: string) { this._class = v; this.classList = new FakeClassList(v); }

  append(...kids: FakeElement[]) { this.children.push(...kids); }
  remove() {}
  setPointerCapture(_id: number) {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 800 }; }

  addEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  fire(type: string, e: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

const winListeners = new Map<string, ((e: any) => void)[]>();
const g = globalThis as any;
g.document = { createElement: (tag: string) => new FakeElement(tag) };
g.addEventListener = (type: string, fn: (e: any) => void) => {
  const list = winListeners.get(type) ?? [];
  list.push(fn);
  winListeners.set(type, list);
};
g.requestAnimationFrame = (fn: () => void) => { fn(); return 0; };
g.matchMedia = () => ({ matches: false });
g.navigator = g.navigator ?? { maxTouchPoints: 0 };

const { TouchControls, STICK_RADIUS, THROTTLE_RADIUS, expo, rateLimit, STICK_PUSH_S } = await import("../src/sim/touch");
const { EasyStick, EASY_RADIUS } = await import("../src/sim/easystick");
const { Aircraft } = await import("../src/sim/aircraft");
type EasyStick = InstanceType<typeof EasyStick>;
type Aircraft = InstanceType<typeof Aircraft>;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}
function near(name: string, v: number, want: number, tol = 1e-6): void {
  check(name, Math.abs(v - want) <= tol, `${v.toFixed(4)} (want ${want})`);
}
function between(name: string, v: number, lo: number, hi: number, unit: string): void {
  check(name, v >= lo && hi >= v, `${v.toFixed(3)} ${unit} (want ${lo}..${hi})`);
}

const surface = new FakeElement("canvas");
const ui = new FakeElement("div");
const tc = new TouchControls(surface as unknown as HTMLElement, ui as unknown as HTMLElement, "sticks");

/** A pointer event as the browser would deliver it. */
const ev = (pointerId: number, clientX: number, clientY: number) =>
  ({ pointerId, clientX, clientY, pointerType: "touch", preventDefault() {}, stopPropagation() {} });

const down = (id: number, x: number, y: number) => surface.fire("pointerdown", ev(id, x, y));
const move = (id: number, x: number, y: number) => surface.fire("pointermove", ev(id, x, y));
const up = (id: number, x: number, y: number) => surface.fire("pointerup", ev(id, x, y));

// The stick and the throttle spring back, so nothing is held between cases.
function reset(): void {
  for (const fn of winListeners.get("blur") ?? []) fn({});
}

// --- Nothing touched is nothing commanded ---------------------------------
check("idle is inactive", !tc.active, `active=${tc.active}`);
near("idle roll", tc.axes.roll, 0);
near("idle throttle", tc.axes.throttle, 0);

// --- The top band belongs to the clock, not the aeroplane ------------------
down(1, 100, 100); // 100 / 800 = 12.5% down, inside the 26% dead band
check("a touch in the top band is not a stick", !tc.active, `active=${tc.active}`);
reset();

// --- Left zone: roll and climb, relative to where the finger landed --------
down(1, 100, 600);
check("left zone arms the stick", tc.active, `active=${tc.active}`);
near("no deflection before the finger moves", tc.axes.roll, 0);
near("no lift before the finger moves", tc.axes.lift, 0);

// Half the travel is NOT half the roll: the axis is expo'd, so the middle of
// the stick is soft. Asserted against the curve rather than a literal, because
// the number that matters is that it is well under half and still rising.
move(1, 100 + STICK_RADIUS / 2, 600);
near("half right is a soft half roll", tc.axes.roll, expo(0.5));
check("expo softens the middle", tc.axes.roll < 0.4, `${tc.axes.roll.toFixed(3)}`);
move(1, 100 - STICK_RADIUS, 600);
near("full left is full roll", tc.axes.roll, -1);
move(1, -400, 600);
near("past full stays full", tc.axes.roll, -1);

// Up is a climb, agreeing with the desktop mouse drag. Asserted rather than
// assumed: the two builds sharing one sense is the whole reason the toggle
// that used to switch it was deleted.
move(1, 100, 600 - STICK_RADIUS / 2);
near("finger up is a climb", tc.axes.lift, 0.5);
move(1, 100, 600 + STICK_RADIUS * 1.5);
near("finger down is a descent, clamped", tc.axes.lift, -1);

up(1, 100, 600);
check("release disarms", !tc.active, `active=${tc.active}`);
near("release centres roll", tc.axes.roll, 0);
near("release centres lift", tc.axes.lift, 0);

// --- Right zone: throttle and rudder --------------------------------------
down(2, 300, 600);
move(2, 300, 600 - THROTTLE_RADIUS / 2);
near("finger up opens the throttle", tc.axes.throttle, 0.5);
move(2, 300, 600 + THROTTLE_RADIUS * 1.5);
near("finger down closes it, clamped", tc.axes.throttle, -1);
move(2, 300 + THROTTLE_RADIUS / 2, 600);
near("sideways is rudder", tc.axes.yaw, expo(0.5));
up(2, 300, 600);
near("release centres the throttle", tc.axes.throttle, 0);

// --- Two thumbs at once ----------------------------------------------------
// The whole point of splitting the screen: rolling must not move the throttle.
down(3, 100, 600);
down(4, 300, 600);
move(3, 100 + STICK_RADIUS, 600);
move(4, 300, 600 - THROTTLE_RADIUS);
near("left thumb rolls", tc.axes.roll, 1);
near("right thumb throttles", tc.axes.throttle, 1);
check("both zones armed", tc.active, `active=${tc.active}`);
up(3, 100 + STICK_RADIUS, 600);
near("dropping the stick leaves the throttle", tc.axes.throttle, 1);
near("dropping the stick centres the roll", tc.axes.roll, 0);
check("still armed on one thumb", tc.active, `active=${tc.active}`);
up(4, 300, 542);
check("both released disarms", !tc.active, `active=${tc.active}`);

// --- A second finger in a zone that is already held ------------------------
// It must be IGNORED, not steal the stick: a palm brushing the glass while
// turning would otherwise re-origin the stick under the thumb and snap the
// aeroplane level.
down(5, 100, 600);
move(5, 100 + STICK_RADIUS, 600);
down(6, 120, 700); // same zone, second finger
near("a second finger does not steal the stick", tc.axes.roll, 1);
move(6, 200, 700);
near("and cannot drive it either", tc.axes.roll, 1);
reset();

// --- A mouse is not a finger ----------------------------------------------
surface.fire("pointerdown", { ...ev(7, 100, 600), pointerType: "mouse" });
check("a mouse press is not a stick", !tc.active, `active=${tc.active}`);
reset();

// --- Tab away with a thumb down -------------------------------------------
down(8, 100, 600);
move(8, 100 + STICK_RADIUS, 600);
near("armed before the blur", tc.axes.roll, 1);
for (const fn of winListeners.get("blur") ?? []) fn({});
near("blur centres the stick", tc.axes.roll, 0);
check("blur disarms", !tc.active, `active=${tc.active}`);

// --- Buttons ---------------------------------------------------------------
function button(label: string): FakeElement {
  const col = ui.children[0].children[0];
  const b = col.children.find((c) => c.textContent === label);
  if (!b) throw new Error(`no ${label} button`);
  return b;
}
// Named rather than counted. A count says "three" and goes red the day a fourth
// is added for a good reason, which teaches whoever added it to change the
// number rather than to think; the names are what a thumb is actually looking
// for, and a missing one is the failure worth having.
const BUTTONS = ["CAM", "BST", "CAR", "LOOK"];
const btnLabels = ui.children[0].children[0].children.map((c) => c.textContent);
check("every button exists, and nothing else does",
  BUTTONS.every((b) => btnLabels.includes(b)) && btnLabels.length === BUTTONS.length,
  btnLabels.join(" "));
near("camera presses start at zero", tc.drainCameraPresses(), 0);
button("CAM").fire("pointerdown", ev(9, 0, 0));
button("CAM").fire("pointerdown", ev(9, 0, 0));
near("camera presses accumulate", tc.drainCameraPresses(), 2);
near("draining clears them", tc.drainCameraPresses(), 0);

near("car presses start at zero", tc.drainCarPresses(), 0);
button("CAR").fire("pointerdown", ev(9, 0, 0));
button("CAR").fire("pointerdown", ev(9, 0, 0));
near("car presses accumulate", tc.drainCarPresses(), 2);
near("draining clears the car presses too", tc.drainCarPresses(), 0);

check("boost starts off", !tc.boost, `${tc.boost}`);
button("BST").fire("pointerdown", ev(9, 0, 0));
check("boost latches on", tc.boost, `${tc.boost}`);
button("BST").fire("pointerdown", ev(9, 0, 0));
check("boost latches off", !tc.boost, `${tc.boost}`);

check("look back starts released", !tc.lookBack, `${tc.lookBack}`);
button("LOOK").fire("pointerdown", ev(9, 0, 0));
check("look back holds", tc.lookBack, `${tc.lookBack}`);
button("LOOK").fire("pointerup", ev(9, 0, 0));
check("look back releases", !tc.lookBack, `${tc.lookBack}`);

// --- Report ----------------------------------------------------------------

// --- keyboard stick rate limiting -------------------------------------------
//
// The flight model integrates the stick axes directly (roll straight into
// 130 deg/s, lift into a 45 m/s vertical speed command), so a key going 0 to 1
// in one frame asked for full deflection instantly and the aeroplane snapped.
// These assertions are about the SHAPE of the ramp, not its exact timing.
{
  const step = 1 / 60;

  // Full deflection is reached, and reached when it says it will be. An
  // exponential filter would fail this: it approaches and never arrives.
  let v = 0;
  let frames = 0;
  while (v < 1 && frames < 600) { v = rateLimit(v, 1, step); frames++; }
  check(
    "a held key reaches full deflection",
    v === 1,
    `${v.toFixed(3)} after ${frames} frames`,
  );
  check(
    "and reaches it in about the stated time",
    Math.abs(frames * step - STICK_PUSH_S) < 0.03,
    `${(frames * step).toFixed(3)} s vs ${STICK_PUSH_S} s`,
  );

  // One frame of a tap must not be full authority. This is the actual bug.
  const oneFrame = rateLimit(0, 1, step);
  check(
    "a one-frame tap is a small input",
    oneFrame < 0.15,
    `${oneFrame.toFixed(3)} of full travel`,
  );

  // Release is quicker than push, and also arrives.
  let r = 1;
  let rf = 0;
  while (r > 0 && rf < 600) { r = rateLimit(r, 0, step); rf++; }
  check("releasing returns to centre", r === 0, `${rf} frames`);
  check("release is quicker than push", rf < frames, `${rf} vs ${frames} frames`);

  // Sign is preserved: a left input never momentarily reads as right.
  let n = 0;
  for (let i = 0; i < 40; i++) {
    n = rateLimit(n, -1, step);
    if (n > 0) break;
  }
  check("a left input never reads as right", n <= 0, `${n.toFixed(3)}`);

  // Crossing centre passes through it rather than jumping.
  let c = 1;
  let sawCentreish = false;
  for (let i = 0; i < 60; i++) {
    c = rateLimit(c, -1, step);
    if (Math.abs(c) < 0.2) sawCentreish = true;
  }
  check("reversing passes through centre", sawCentreish, `ended at ${c.toFixed(3)}`);
}

// --- The one-thumb easy scheme ----------------------------------------------
//
// The default on a phone. The DOM half first: one stick anywhere below the
// clock band, nothing drawn until a thumb is down, relative to where it landed.
{
  const s2 = new FakeElement("canvas");
  const ui2 = new FakeElement("div");
  const ez = new TouchControls(s2 as unknown as HTMLElement, ui2 as unknown as HTMLElement, "easy");
  const d = (id: number, x: number, y: number) => s2.fire("pointerdown", ev(id, x, y));
  const m = (id: number, x: number, y: number) => s2.fire("pointermove", ev(id, x, y));
  const u = (id: number, x: number, y: number) => s2.fire("pointerup", ev(id, x, y));
  const root = ui2.children[0];
  check("easy draws no permanent home rings",
    !root.children.some((c) => c.className.startsWith("touch-home")),
    root.children.map((c) => c.className).join(" "));
  d(1, 100, 100);
  check("easy: the top band is still the clock's", !ez.finger.held, `held=${ez.finger.held}`);
  for (const fn of winListeners.get("blur") ?? []) fn({});
  // The RIGHT half, which the two-stick scheme gives to the throttle.
  d(2, 330, 700);
  check("easy: a thumb on the right half is the flight stick", ez.finger.held, `held=${ez.finger.held}`);
  near("easy: no deflection on touch-down", Math.hypot(ez.finger.x, ez.finger.y), 0);
  m(2, 330 + EASY_RADIUS / 2, 700 - EASY_RADIUS);
  near("easy: sideways is relative to the landing point", ez.finger.x, 0.5);
  near("easy: up is negative y, as the pointer reports it", ez.finger.y, -1);
  check("easy: exactly one ring under the thumb",
    root.children.filter((c) => c.className.startsWith("touch-ring")).length === 1, "");
  d(3, 60, 600);
  m(3, 0, 600);
  near("easy: a second finger cannot drive it", ez.finger.x, 0.5);
  u(2, 330, 700);
  check("easy: release lets go", !ez.finger.held && !ez.active, `held=${ez.finger.held}`);
}

// The closed-loop half: the stick flying the real flight model. Bounds are
// measured literals, and each one has a probe beside it that must FAIL it, run
// against the scheme or the knob the bound exists to rule out.
{
  const step = 1 / 60;
  type Drive = (t: number) => { held: boolean; x: number; y: number };
  /** Fly `seconds` and return the bank and vertical speed every frame. */
  function flyEasy(stick: EasyStick, drive: Drive, seconds: number, a = new Aircraft()) {
    if (a.position.y === 0) a.reset(0, 600, 0, 0);
    const bank: number[] = [];
    const vs: number[] = [];
    for (let i = 0; i < Math.round(seconds / step); i++) {
      const axes = { throttle: 0, roll: 0, yaw: 0, lift: 0, boost: 0 };
      stick.update(axes, drive(i * step), a.rollDeg, step);
      a.update(axes, step, 0);
      bank.push(a.rollDeg);
      vs.push(a.verticalSpeed);
    }
    return { bank, vs, a };
  }
  const held = (x: number, y = 0) => () => ({ held: true, x, y });
  const off = () => ({ held: false, x: 0, y: 0 });

  // Release from a full-deflection turn.
  function release(stick: EasyStick) {
    const ac = flyEasy(stick, held(1), 4).a;
    const from = ac.rollDeg;
    const { bank } = flyEasy(stick, off, 4, ac);
    const level = bank.findIndex((b, i) => bank.slice(i).every((v) => Math.abs(v) < 1));
    const overshoot = Math.max(0, -Math.min(...bank));
    return { from, levelS: level < 0 ? Infinity : level * step, overshoot };
  }
  const rel = release(new EasyStick());
  between("easy: full deflection banks to the limit", rel.from, 44, 45.5, "deg");
  between("easy: release is wings level (<1 deg) within 0.6 s", rel.levelS, 0, 0.6, "s");
  between("easy: and does not overshoot past level by 0.2 deg", rel.overshoot, 0, 0.2, "deg");
  // Probes. The two-stick release (roll axis to zero, model self-levelling)
  // is what the time bound is for; a bang-bang bank loop is what the
  // overshoot bound is for.
  {
    const ac = new Aircraft();
    ac.reset(0, 600, 0, 0);
    for (let i = 0; i < 240; i++) ac.update({ throttle: 0, roll: 1, yaw: 0, lift: 0, boost: 0 }, step, 0);
    let frames = 0;
    while (Math.abs(ac.rollDeg) >= 1 && frames < 600) {
      ac.update({ throttle: 0, roll: 0, yaw: 0, lift: 0, boost: 0 }, step, 0);
      frames++;
    }
    check("probe: the two-stick release FAILS the 0.6 s bound", frames * step > 0.6,
      `${(frames * step).toFixed(2)} s`);
  }
  const bang = release(new EasyStick({ authorityDeg: 0.5 }));
  check("probe: a bang-bang bank loop FAILS the overshoot bound", bang.overshoot > 0.2,
    `${bang.overshoot.toFixed(2)} deg`);

  // A held half deflection holds a bank. Expo puts half travel at 0.39 of
  // the limit, 17.4 deg, rather than at exactly half.
  const half = flyEasy(new EasyStick(), held(0.5), 6).bank;
  const steady = half[half.length - 1];
  between("easy: a held half deflection is a steady bank", steady, 15, 20, "deg");
  check("easy: and it is steady (<0.1 deg drift over the last 2 s)",
    Math.abs(steady - half[half.length - 120]) < 0.1,
    `${(steady - half[half.length - 120]).toFixed(3)} deg`);
  {
    // Probe: the same thumb on the two-stick ROLL RATE axis winds on bank
    // until the model's limit stops it.
    const ac = new Aircraft();
    ac.reset(0, 600, 0, 0);
    for (let i = 0; i < 360; i++) ac.update({ throttle: 0, roll: expo(0.5), yaw: 0, lift: 0, boost: 0 }, step, 0);
    check("probe: a rate command FAILS the steady-bank bound", ac.rollDeg > 20,
      `${ac.rollDeg.toFixed(1)} deg`);
  }

  // A one-frame 10 px spike, each way, on top of a held half deflection: the
  // "not jerky" claim, about the finger the digitiser actually reports.
  function jitter(mk: () => EasyStick): number {
    let worst = 0;
    for (const sign of [1, -1]) {
      const stick = mk();
      const base = flyEasy(stick, held(0.5), 4);
      const steadyBank = base.a.rollDeg;
      let frame = 0;
      const { bank } = flyEasy(stick, () => {
        const spike = frame++ === 0 ? (sign * 10) / EASY_RADIUS : 0;
        return { held: true, x: 0.5 + spike, y: 0 };
      }, 1, base.a);
      worst = Math.max(worst, ...bank.map((b) => Math.abs(b - steadyBank)));
    }
    return worst;
  }
  const jit = jitter(() => new EasyStick());
  between("easy: a 1-frame 10 px jitter moves the bank < 0.45 deg", jit, 0, 0.45, "deg");
  const rawJit = jitter(() => new EasyStick({ filter: false }));
  check("probe: the unfiltered thumb FAILS the jitter bound", rawJit > 0.45,
    `${rawJit.toFixed(3)} deg`);

  // Finger up climbs, and letting go holds the height it got to.
  const climb = flyEasy(new EasyStick(), held(0, -0.6), 3);
  check("easy: finger up is a climb", climb.vs[climb.vs.length - 1] > 5,
    `${climb.vs[climb.vs.length - 1].toFixed(1)} m/s`);
  const after = flyEasy(new EasyStick(), off, 2, climb.a).vs;
  between("easy: release levels off (|vs| after 2 s)", Math.abs(after[after.length - 1]), 0, 0.5, "m/s");
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(46)} ${r.detail}`);
}

console.log(`\n${results.length - failed}/${results.length} touch checks passed`);
if (failed) process.exit(1);

