// The gate on the opening sweep's camera path (src/sim/intro.ts).
//
// What must hold: the move is continuous (no frame steps further or turns
// faster than the bounds, at a steady 60 Hz or with ragged frame times), it
// ends exactly at the walker's eye looking level along the heading, and a skip
// finishes in INTRO_SKIP_S without a cut. Each bound has a probe beside it
// that breaks the thing on purpose and must fail the same measure, so a
// checker that stops measuring cannot pass silently.

import * as THREE from "three";
import {
  IntroPath, IntroRun, traceContinuity, INTRO_MAX_SPEED, INTRO_MAX_TURN_DEG_S, INTRO_SKIP_S,
  type PoseSample,
} from "../src/sim/intro";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

function record(run: IntroRun, dts: () => number, skipAtS = Infinity): PoseSample[] {
  const pos = new THREE.Vector3(), q = new THREE.Quaternion();
  const out: PoseSample[] = [];
  let t = 0;
  for (let i = 0; i < 10000; i++) {
    const dt = dts();
    t += dt;
    if (t >= skipAtS) run.skip();
    const more = run.update(dt, pos, q);
    out.push({ dt, x: pos.x, y: pos.y, z: pos.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w });
    if (!more) break;
  }
  return out;
}

// A spawn on a hill with a roof field round it, heading 337 (Pompeii's).
const eye = new THREE.Vector3(-253, 13.7, -6);
const spec = { eye, headingDeg: 337, groundY: 12, clearAt: (x: number, z: number) => 12 + (Math.abs(x + z) % 40) };
const path = new IntroPath(spec);

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (const [label, dts] of [
  ["60 Hz", () => 1 / 60],
  ["ragged 8-50 ms", () => 0.008 + rand() * 0.042],
] as const) {
  const tr = record(new IntroRun(path), dts);
  const c = traceContinuity(tr);
  const total = tr.reduce((s, p) => s + p.dt, 0);
  check(`${label}: duration ~${path.duration} s`, Math.abs(total - path.duration) < 0.1, `${total.toFixed(2)} s`);
  check(`${label}: max speed <= ${INTRO_MAX_SPEED} m/s`, c.maxSpeed <= INTRO_MAX_SPEED, `${c.maxSpeed.toFixed(0)} m/s`);
  check(`${label}: max turn <= ${INTRO_MAX_TURN_DEG_S} deg/s`, c.maxTurnDegS <= INTRO_MAX_TURN_DEG_S, `${c.maxTurnDegS.toFixed(1)} deg/s`);
  const end = tr[tr.length - 1];
  const miss = Math.hypot(end.x - eye.x, end.y - eye.y, end.z - eye.z);
  check(`${label}: ends at the eye`, miss < 1e-6, `${miss.toExponential(2)} m`);
  // Level along the heading: the walker's own orientation (drone.ts builds
  // it as YXZ Euler with pitch 0, yaw -heading).
  const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (-337 * Math.PI) / 180, 0, "YXZ"));
  const got = new THREE.Quaternion(end.qx, end.qy, end.qz, end.qw);
  const ang = (want.angleTo(got) * 180) / Math.PI;
  check(`${label}: ends facing the walker's way`, ang < 0.01, `${ang.toFixed(4)} deg`);
  // Near rest at the hand-over: the final frames move no faster than a run,
  // so control starts from what reads as standing still.
  const tail = tr.slice(-3);
  const tailSpeed = traceContinuity(tail).maxSpeed;
  check(`${label}: slows to a run at the eye`, tailSpeed < 6, `${tailSpeed.toFixed(2)} m/s`);
}

// Starts high: the opening frame is an aerial, not a street.
check("starts at least 600 m up", path.heightAt(0) >= 600, `${path.heightAt(0).toFixed(0)} m`);
// Stays clear of the roof field until the final drop.
let low = Infinity;
for (let d = 0; d < path.length * 0.85; d += 5) low = Math.min(low, path.heightAt(d));
check("clear of the town until the last stretch", low > 30, `${low.toFixed(0)} m min`);

// The skip: finishes within INTRO_SKIP_S of the tap, no single frame jumps
// more than the skip's own speed allows, and lands on the eye.
{
  const tr = record(new IntroRun(path), () => 1 / 60, 3);
  const skipFrame = Math.round(3 * 60);
  const after = tr.length - skipFrame;
  check("skip: ends within the skip time", after <= Math.ceil(INTRO_SKIP_S * 60) + 1, `${after} frames`);
  const end = tr[tr.length - 1];
  check("skip: lands on the eye", Math.hypot(end.x - eye.x, end.y - eye.y, end.z - eye.z) < 1e-6, "");
  // The skip is fast by design, but a cut is a whole path length in one frame.
  const c = traceContinuity(tr);
  check("skip: no frame covers a fifth of the path", c.maxStepM < path.length / 5, `${c.maxStepM.toFixed(0)} m of ${path.length.toFixed(0)}`);
}

// Vacuity probes: the same measure must fail a cut.
{
  const tr = record(new IntroRun(path), () => 1 / 60);
  const cut = tr.map((p, i) => (i > tr.length / 2 ? { ...p, x: p.x + 300 } : p));
  const c = traceContinuity(cut);
  check("probe: a 300 m cut FAILS the speed bound", c.maxSpeed > INTRO_MAX_SPEED, `${c.maxSpeed.toFixed(0)} m/s`);
  const turned = tr.map((p, i) => (i > tr.length / 2 ? { ...p, qx: p.qy, qy: -p.qx } : p));
  const t2 = traceContinuity(turned);
  check("probe: a snapped orientation FAILS the turn bound", t2.maxTurnDegS > INTRO_MAX_TURN_DEG_S, `${t2.maxTurnDegS.toFixed(0)} deg/s`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(46)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} intro checks passed`);
if (failed) process.exit(1);
