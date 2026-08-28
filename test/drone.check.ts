// The gate on the drone.
//
// Same reasoning as flight.check.ts: the numbers that define the FEEL have no
// visual tell when they go wrong by a factor of two. A drone that takes four
// seconds to reach cruise instead of one still looks exactly like a drone in a
// screenshot, and the only symptom is being vaguely dissatisfied while flying
// it.
//
// The one that earns its place above all the others is the frame-rate check.
// `v *= 0.94` per frame instead of `v *= pow(DAMP, dt)` is invisible on the
// machine it was written on and makes the drone draggy at 30 Hz and slippery
// at 240 Hz, and no screenshot and no other assertion here would ever catch it.
//
// Every bound below has been watched to FAIL, by perturbing the constant it
// guards. A check nobody has seen fail is not a check.

import * as THREE from "three";
import { Drone, DRONE_CRUISE, DRONE_BOOST, DRONE_MAX_BANK, DRONE_GROUND_CLEARANCE } from "../src/sim/drone";
import type { DroneInput } from "../src/sim/drone";

const DT = 1 / 60;

const NEUTRAL: DroneInput = {
  forward: 0,
  strafe: 0,
  lift: 0,
  yaw: 0,
  pitch: 0,
  boost: 0,
  lookYawDeg: 0,
  lookPitchDeg: 0,
};

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function between(name: string, v: number, lo: number, hi: number, unit: string): void {
  check(name, v >= lo && hi >= v, `${v.toFixed(3)} ${unit} (want ${lo}..${hi})`);
}

/** Ground is flat at y = 0 throughout; the terrain is not what is under test. */
function fly(d: Drone, input: Partial<DroneInput>, seconds: number, dt = DT): void {
  const full: DroneInput = { ...NEUTRAL, ...input };
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) d.update(full, dt, 0);
}

function fresh(alt = 200, hdg = 0): Drone {
  const d = new Drone();
  d.enterFrom(new THREE.Vector3(0, alt, 0), hdg, new THREE.Vector3());
  return d;
}

// --- Frame-rate independence ----------------------------------------------
// Written FIRST, because it is the one that catches a per-frame damping
// factor. The profile has to contain both regimes: powered acceleration, which
// a per-frame bug barely touches, and a coast, where it is everything.
{
  const run = (dt: number): { x: number; z: number; roll: number } => {
    const d = fresh();
    fly(d, { forward: 1 }, 2, dt);
    fly(d, {}, 3, dt);
    return { x: d.position.x, z: d.position.z, roll: d.rollDeg };
  };
  const slow = run(1 / 30);
  const fast = run(1 / 240);
  const travelled = Math.hypot(fast.x, fast.z);
  const gap = Math.hypot(slow.x - fast.x, slow.z - fast.z);
  const rel = gap / travelled;
  check(
    "damping is frame-rate independent",
    rel < 0.02,
    `${(rel * 100).toFixed(2)}% apart after 5 s (${travelled.toFixed(1)} m at 240 Hz, ${gap.toFixed(2)} m of disagreement)`,
  );

  // The tilt has its own exponential follow, and it is just as easy to write
  // per frame as the damping is. Same profile, different quantity: a hard
  // stop from cruise flares the nose, and how far it has flared five seconds
  // later must not depend on the monitor.
  const nose = (d: number): number => {
    const a = fresh();
    fly(a, { strafe: 1 }, 1.2, d);
    return a.rollDeg;
  };
  const rollSlow = nose(1 / 30);
  const rollFast = nose(1 / 240);
  check(
    "cosmetic tilt is frame-rate independent",
    Math.abs(rollSlow - rollFast) < 0.5,
    `${rollSlow.toFixed(2)} deg at 30 Hz vs ${rollFast.toFixed(2)} at 240 Hz`,
  );
}

// --- Hover -----------------------------------------------------------------
// A drone is not an aeroplane: hands off, it hangs there. Any sink at all here
// means gravity crept into the vertical axis.
{
  const d = fresh(200);
  // Measured from where the drone actually STARTS, not from the altitude the
  // aeroplane was handed over at: entering puts it a couple of metres above
  // the aircraft, and asserting against the seed would be asserting that.
  const start = d.position.y;
  fly(d, {}, 5);
  check("hovers hands off", Math.abs(d.position.y - start) < 0.01, `${(d.position.y - start).toFixed(4)} m in 5 s`);
}

// --- Cruise ----------------------------------------------------------------
{
  const d = fresh();
  fly(d, { forward: 1 }, 4);
  between("cruise speed", d.speed, 14, 19, "m/s");

  const b = fresh();
  fly(b, { forward: 1, boost: 1 }, 4);
  // Absolute numbers, not `DRONE_BOOST +- something`. A bound written in terms
  // of the constant it is guarding moves when the constant does and can never
  // fail, which is the failure mode this whole file exists to avoid.
  between("boost speed", b.speed, 35, 45, "m/s");
  check(
    "boost is worth pressing",
    b.speed > 2 * d.speed,
    `${b.speed.toFixed(1)} vs ${d.speed.toFixed(1)} m/s (want > 2x)`,
  );
}

// --- Coast -----------------------------------------------------------------
// Momentum, but finite momentum. Too little and releasing the stick is a
// handbrake; too much and a gap between two buildings is not somewhere you can
// stop.
{
  const d = fresh();
  fly(d, { forward: 1 }, 4);
  const from = d.position.clone();
  let t = 0;
  while (t < 3 && d.speed > 0.5) {
    d.update(NEUTRAL, DT, 0);
    t += DT;
  }
  const ran = from.distanceTo(d.position);
  check("coasts to a stop", d.speed <= 0.5, `${d.speed.toFixed(3)} m/s after ${t.toFixed(2)} s`);
  between("coast distance", ran, 5, 30, "m");
}

// --- Ground ----------------------------------------------------------------
{
  const d = fresh(40);
  fly(d, { lift: -1 }, 10);
  // Absolute, so that blowing the clearance up to the aeroplane's 25 m fails
  // here rather than quietly redefining what "the ground" means.
  between("settles just above the street", d.position.y, 2, 5, "m");
  check(
    "never sinks through the ground",
    d.position.y >= DRONE_GROUND_CLEARANCE - 1e-6,
    `y = ${d.position.y.toFixed(3)} m (floor ${DRONE_GROUND_CLEARANCE})`,
  );
  check("settles rather than bouncing", Math.abs(d.velocity.y) < 1e-6, `vy = ${d.velocity.y.toFixed(4)} m/s`);
}

// --- Look limits -----------------------------------------------------------
// The pitch clamp is what stops the world going upside down; the roll bound is
// what says roll is still cosmetic. A roll integrated from an input would sail
// straight past this.
{
  // 85 written out rather than read from the module, for the same reason as
  // the speeds above: a bound expressed in its own constant cannot fail. Past
  // about 88 the camera's up vector flips and the world rolls over, which is
  // the thing the clamp is really protecting.
  const up = fresh();
  fly(up, { pitch: 1 }, 6);
  between("pitch clamps looking up", up.pitchDeg, 84, 86, "deg");

  const down = fresh();
  fly(down, { pitch: -1 }, 6);
  between("pitch clamps looking down", down.pitchDeg, -86, -84, "deg");

  // Mouse look is unbounded degrees, so it is the input most able to run the
  // clamp over.
  const mouse = fresh();
  fly(mouse, { lookPitchDeg: 40 }, 3);
  check("mouse look cannot pass the clamp", mouse.pitchDeg <= 86, `${mouse.pitchDeg.toFixed(2)} deg`);

  // Yaw for ten seconds, on the spot and then at speed. Neither may leave any
  // roll behind, and the second may not exceed the cosmetic limit.
  const spin = fresh();
  fly(spin, { yaw: 1 }, 10);
  check("yaw alone does not roll", Math.abs(spin.rollDeg) < 1, `${spin.rollDeg.toFixed(3)} deg after 10 s of yaw`);

  const carve = fresh();
  fly(carve, { forward: 1, yaw: 1 }, 10);
  check(
    "roll never accumulates",
    Math.abs(carve.rollDeg) <= 34,
    `${carve.rollDeg.toFixed(2)} deg banked in a sustained turn (cosmetic limit ${DRONE_MAX_BANK}, gate 34)`,
  );
  check("banks INTO the turn", carve.rollDeg > 5, `${carve.rollDeg.toFixed(2)} deg right in a right turn`);
}

// --- Numerical -------------------------------------------------------------
{
  const d = fresh();
  const steps = Math.round(60 / DT);
  let seed = 12345;
  const rnd = (): number => {
    // Deterministic: a fuzz that cannot be reproduced is a flake generator.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < steps; i++) {
    d.update(
      {
        forward: rnd(),
        strafe: rnd(),
        lift: rnd(),
        yaw: rnd(),
        pitch: rnd(),
        boost: rnd() > 0 ? 1 : 0,
        lookYawDeg: rnd() * 12,
        lookPitchDeg: rnd() * 12,
      },
      DT,
      0,
    );
  }
  const finite =
    Number.isFinite(d.position.x) &&
    Number.isFinite(d.position.y) &&
    Number.isFinite(d.position.z) &&
    Number.isFinite(d.velocity.x) &&
    Number.isFinite(d.velocity.y) &&
    Number.isFinite(d.velocity.z) &&
    Number.isFinite(d.yawDeg) &&
    Number.isFinite(d.pitchDeg) &&
    Number.isFinite(d.rollDeg);
  check("stays finite under 60 s of noise", finite, `pos ${d.position.toArray().map((v) => v.toFixed(0)).join(",")}`);
  check(
    "speed stays inside the envelope",
    d.speed <= 55,
    `${d.speed.toFixed(1)} m/s (cruise ${DRONE_CRUISE}, boost ${DRONE_BOOST}, gate 55)`,
  );
  check(
    "angles stay inside their limits",
    Math.abs(d.pitchDeg) <= 86 &&
      Math.abs(d.rollDeg) <= 34 &&
      d.yawDeg >= 0 &&
      d.yawDeg < 360,
    `pitch ${d.pitchDeg.toFixed(1)}, roll ${d.rollDeg.toFixed(1)}, yaw ${d.yawDeg.toFixed(1)}`,
  );
}

// --- Report ----------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(34)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} drone checks passed`);
if (failed) process.exit(1);
