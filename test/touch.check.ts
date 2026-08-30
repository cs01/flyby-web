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

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}
function near(name: string, v: number, want: number, tol = 1e-6): void {
  check(name, Math.abs(v - want) <= tol, `${v.toFixed(4)} (want ${want})`);
}

const surface = new FakeElement("canvas");
const ui = new FakeElement("div");
const tc = new TouchControls(surface as unknown as HTMLElement, ui as unknown as HTMLElement);

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
check("three buttons exist", ui.children[0].children[0].children.length === 3,
  `${ui.children[0].children[0].children.length}`);
near("camera presses start at zero", tc.drainCameraPresses(), 0);
button("CAM").fire("pointerdown", ev(9, 0, 0));
button("CAM").fire("pointerdown", ev(9, 0, 0));
near("camera presses accumulate", tc.drainCameraPresses(), 2);
near("draining clears them", tc.drainCameraPresses(), 0);

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

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(46)} ${r.detail}`);
}

console.log(`\n${results.length - failed}/${results.length} touch checks passed`);
if (failed) process.exit(1);

