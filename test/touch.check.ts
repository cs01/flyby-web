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

const { TouchControls } = await import("../src/sim/touch");

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

move(1, 132, 600); // +32 px of a 64 px radius
near("half right is half roll", tc.axes.roll, 0.5);
move(1, 36, 600);
near("full left is full roll", tc.axes.roll, -1);
move(1, -400, 600);
near("past full stays full", tc.axes.roll, -1);

// Up is a climb, agreeing with the desktop mouse drag. Asserted rather than
// assumed: the two builds sharing one sense is the whole reason the toggle
// that used to switch it was deleted.
move(1, 100, 568); // 32 px UP the screen
near("finger up is a climb", tc.axes.lift, 0.5);
move(1, 100, 664); // 96 px DOWN, past the radius
near("finger down is a descent, clamped", tc.axes.lift, -1);

up(1, 100, 664);
check("release disarms", !tc.active, `active=${tc.active}`);
near("release centres roll", tc.axes.roll, 0);
near("release centres lift", tc.axes.lift, 0);

// --- Right zone: throttle and rudder --------------------------------------
down(2, 300, 600);
move(2, 300, 571); // 29 px up of a 58 px radius
near("finger up opens the throttle", tc.axes.throttle, 0.5);
move(2, 300, 658);
near("finger down closes it, clamped", tc.axes.throttle, -1);
move(2, 329, 600);
near("sideways is rudder", tc.axes.yaw, 0.5);
up(2, 329, 600);
near("release centres the throttle", tc.axes.throttle, 0);

// --- Two thumbs at once ----------------------------------------------------
// The whole point of splitting the screen: rolling must not move the throttle.
down(3, 100, 600);
down(4, 300, 600);
move(3, 164, 600);
move(4, 300, 542);
near("left thumb rolls", tc.axes.roll, 1);
near("right thumb throttles", tc.axes.throttle, 1);
check("both zones armed", tc.active, `active=${tc.active}`);
up(3, 164, 600);
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
move(5, 164, 600);
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
move(8, 164, 600);
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

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(46)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} touch checks passed`);
if (failed) process.exit(1);
