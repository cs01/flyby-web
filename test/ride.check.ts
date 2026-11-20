// The gate on riding transit (src/sim/ride.ts).
//
// The claim that matters is that the person and the car they are in are posed
// by the same transform: a rider whose frame disagrees with the mesh by a sign
// or an Euler order stands half outside the car on every curve, and on a
// straight track looks fine. So the frame is checked against three.js composing
// the pose exactly as render/transit.ts does, at headings and grades a straight
// test track would never reach. Each claim has a probe that must FAIL.

import * as THREE from "three";
import {
  canAlight,
  clampToDeck,
  deckFor,
  riderEye,
  stepRider,
  toLocal,
  toWorld,
  worldYawDeg,
  relYawDeg,
  AT_STOP_M,
  type RideInput,
  type RidePose,
  type Rider,
  type Vec3,
} from "../src/sim/ride";
import { WALK_EYE_M } from "../src/sim/drone";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

const v: Vec3 = { x: 0, y: 0, z: 0 };
const w: Vec3 = { x: 0, y: 0, z: 0 };

/** render/transit.ts: m.compose(position, quat(Euler(pitch, yaw, 0, "YXZ")), 1). */
function meshPoint(p: RidePose, lx: number, ly: number, lz: number, order: THREE.EulerOrder = "YXZ"): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.pitch, p.yaw, 0, order));
  return new THREE.Vector3(lx, ly, lz).applyQuaternion(q).add(new THREE.Vector3(p.x, p.y, p.z));
}

// --- The frame agrees with the mesh, and round-trips ---------------------------
{
  let worstMesh = 0, worstTrip = 0, worstProbe = 0;
  for (const yawDeg of [0, 37, 90, 145, 180, 233, 300, -71]) {
    for (const pitch of [0, 0.035, -0.035]) {
      const p: RidePose = { x: 120, y: 9, z: -340, yaw: (yawDeg * Math.PI) / 180, pitch };
      for (const [lx, ly, lz] of [[1.1, 2.95, -6.5], [-0.7, 2.95, 4], [3, 6, 9.5]]) {
        toWorld(p, lx, ly, lz, v);
        const m = meshPoint(p, lx, ly, lz);
        worstMesh = Math.max(worstMesh, Math.hypot(v.x - m.x, v.y - m.y, v.z - m.z));
        toLocal(p, v.x, v.y, v.z, w);
        worstTrip = Math.max(worstTrip, Math.hypot(w.x - lx, w.y - ly, w.z - lz));
        // Probe: the same pose in the wrong Euler order is a different place.
        const bad = meshPoint(p, lx, ly, lz, "XYZ");
        worstProbe = Math.max(worstProbe, Math.hypot(v.x - bad.x, v.y - bad.y, v.z - bad.z));
      }
    }
  }
  check("frame matches the mesh transform", worstMesh < 1e-6, `worst ${worstMesh.toExponential(2)} m`);
  check("local -> world -> local round trip", worstTrip < 1e-9, `worst ${worstTrip.toExponential(2)} m`);
  check("probe: XYZ order moves the point", worstProbe > 0.05, `${worstProbe.toFixed(3)} m apart`);
  // Look is relative to the car and maps back.
  let worstYaw = 0;
  for (const yr of [0, 1, 2.5, -3]) for (const h of [0, 10, 200, 359]) {
    const back = relYawDeg(worldYawDeg(h, yr), yr);
    worstYaw = Math.max(worstYaw, Math.min(Math.abs(back - h), 360 - Math.abs(back - h)));
  }
  check("relative heading round trip", worstYaw < 1e-9, `${worstYaw.toExponential(2)} deg`);
  // The camera's compass heading, turned into a three.js yaw (-h), must look
  // down the same line as the car nose turned by the rider's relative yaw.
  const p: RidePose = { x: 0, y: 0, z: 0, yaw: 0.9, pitch: 0 };
  const camQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (-worldYawDeg(30, p.yaw) * Math.PI) / 180, 0, "YXZ"));
  const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camQ);
  const lf = { x: Math.sin((30 * Math.PI) / 180), z: -Math.cos((30 * Math.PI) / 180) };
  toWorld(p, lf.x, 0, lf.z, v);
  check("camera heading agrees with the car frame", Math.hypot(camFwd.x - v.x, camFwd.z - v.z) < 1e-9, `${Math.hypot(camFwd.x - v.x, camFwd.z - v.z).toExponential(2)}`);
}

// --- Clamp keeps you on the deck ------------------------------------------------
const NO: RideInput = { forward: 0, strafe: 0, yaw: 0, pitch: 0, boost: 0, lookYawDeg: 0, lookPitchDeg: 0 };
{
  for (const [kind, len, width] of [["rail", 14.6, 2.84], ["subway", 18.4, 3.05], ["ferry", 40, 10], ["ferry", 94, 21], ["bus", undefined, undefined]] as const) {
    const d = deckFor(kind, len, width);
    let off = 0;
    for (const [yaw, f, s] of [[0, 1, 0], [90, 1, 0], [45, 1, 1], [180, 1, 0], [270, 0, 1], [10, -1, 0.3]]) {
      const r: Rider = { lx: 0, lz: (d.z0 + d.z1) / 2, relYawDeg: yaw, pitchDeg: 0 };
      for (let i = 0; i < 1200; i++) stepRider(r, { ...NO, forward: f, strafe: s, boost: 1 }, d, 1 / 60);
      off = Math.max(off, Math.abs(r.lx) - (d.hx - d.wall), d.z0 + d.wall - r.lz, r.lz - (d.z1 - d.wall));
    }
    check(`${kind}${len ? ` ${len} m` : ""}: 20 s of running stays inside`, off <= 1e-9, `worst ${off.toFixed(3)} m past the wall line`);
    check(`${kind}${len ? ` ${len} m` : ""}: deck has room to walk`, d.hx - d.wall > 0.3 && d.z1 - d.z0 - 2 * d.wall > 5, `${(2 * (d.hx - d.wall)).toFixed(2)} x ${(d.z1 - d.z0 - 2 * d.wall).toFixed(1)} m`);
  }
  // Probe: the same run with no clamp walks out through the side.
  const d = deckFor("rail", 14.6, 2.84);
  let lx = 0;
  for (let i = 0; i < 1200; i++) lx += 5.5 / 60;
  const c = clampToDeck(d, lx, 0, v);
  check("probe: unclamped run leaves the car", lx > d.hx && c.x <= d.hx - d.wall, `unclamped ${lx.toFixed(1)} m, clamped ${c.x.toFixed(2)} m`);
  // Eye is at standing height over the floor, not over the rail.
  const e = riderEye({ x: 0, y: 7, z: 0, yaw: 0, pitch: 0 }, { lx: 0, lz: 0, relYawDeg: 0, pitchDeg: 0 }, d, v);
  check("eye at floor + 1.7 m on an el", Math.abs(e.y - (7 + d.floor + WALK_EYE_M)) < 1e-9, `y ${e.y.toFixed(2)}`);
}

// --- Getting off -----------------------------------------------------------------
{
  check("refused while moving between stops", !canAlight(12, 500, 800), "12 m/s, 300 m short");
  check("refused while rolling into the platform", !canAlight(3, 790, 800), "3 m/s, 10 m short");
  check("refused when stopped at a signal", !canAlight(0, 500, 800), "0 m/s, 300 m short");
  check("allowed standing at the stop", canAlight(0, 800, 800), "0 m/s, at the stop");
  check("allowed with an eased live correction", canAlight(0.1, 800 - AT_STOP_M + 1, 800), `${AT_STOP_M - 1} m off`);
  check("refused with no stop", !canAlight(0, 0, null), "no next stop");
  // Probe: ignoring speed would let you step off at 12 m/s at the platform end.
  const speedless = (s: number, stopS: number) => Math.abs(s - stopS) <= AT_STOP_M;
  check("probe: a speed-blind rule opens the doors at 12 m/s", speedless(790, 800) && !canAlight(12, 790, 800), "at 10 m, 12 m/s");
}

// --- The rider is carried ---------------------------------------------------------
{
  const d = deckFor("rail", 14.6, 2.84);
  const r: Rider = { lx: 0.5, lz: -3, relYawDeg: 20, pitchDeg: 0 };
  const p: RidePose = { x: 100, y: 8, z: 50, yaw: 0.6, pitch: 0 };
  const a = { ...riderEye(p, r, d, v) };
  // The car runs 100 m along its own nose, as the timeline would carry it.
  p.x += -Math.sin(p.yaw) * 100;
  p.z += -Math.cos(p.yaw) * 100;
  stepRider(r, NO, d, 1 / 60);
  const b = riderEye(p, r, d, w);
  const moved = Math.hypot(b.x - a.x, b.z - a.z);
  check("carried 100 m with the car", Math.abs(moved - 100) < 1e-6, `${moved.toFixed(4)} m`);
  toLocal(p, b.x, b.y, b.z, v);
  check("still at the same seat", Math.abs(v.x - 0.5) < 1e-9 && Math.abs(v.z + 3) < 1e-9, `local ${v.x.toFixed(3)}, ${v.z.toFixed(3)}`);
  // Probe: a world-fixed eye (the old walk) is left 100 m behind.
  check("probe: a world-fixed eye is left behind", Math.hypot(a.x - p.x, a.z - p.z) > 50, `${Math.hypot(a.x - p.x, a.z - p.z).toFixed(1)} m from the car`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(46)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} ride checks passed`);
if (failed) process.exit(1);
