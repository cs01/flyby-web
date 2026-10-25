// Measuring a car's place in its lane against the centreline it belongs to,
// shared by test/trafficmodel.check.ts and the in-browser lane gate
// (window.flybyShot.streetLanes, read by tools/verify-night.ts).
//
// Measured against the EDGE CENTRELINE by nearest point, which is independent
// of the lane paths sim/trafficsim.ts builds; only the expected lane centres
// come from data/lanes.ts.

import type { RoadGraph } from "../data/roadgraph";
import { laneLayout, lanesForTravel } from "../data/lanes";
import type { Pose, TrafficSim } from "./trafficsim";

/**
 * Whether (x, z) is inside the zone round a centreline vertex where the road
 * turns by 3 degrees or more: a hinge the sim rounds off, with no tangent to
 * measure a heading against. The zone is the half width (an outside lane is
 * that far from the vertex before it has turned at all) plus 3 m plus
 * 6 tan(angle / 2), so a 90 degree corner on a 7 m street is 12.5 m and a
 * 5 degree kink 6.8 m.
 */
export function inBend(pts: Float32Array, x: number, z: number, halfW: number): boolean {
  for (let k = 2; k + 2 < pts.length; k += 2) {
    const ax = pts[k] - pts[k - 2], az = pts[k + 1] - pts[k - 1];
    const bx = pts[k + 2] - pts[k], bz = pts[k + 3] - pts[k + 1];
    const c = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
    const th = Math.acos(Math.max(-1, Math.min(1, c)));
    if (th < 3 * Math.PI / 180) continue;
    if (Math.hypot(x - pts[k], z - pts[k + 1]) < halfW + 3 + 6 * Math.tan(th / 2)) return true;
  }
  return false;
}

/** Nearest point on a polyline, its travel tangent, and the signed lateral of
 *  (x, z) right of that tangent. */
export function onCentreline(pts: Float32Array, x: number, z: number, forward: boolean): { lat: number; tx: number; tz: number; d: number } {
  let best = Infinity, bl = 0, btx = 1, btz = 0;
  for (let k = 2; k < pts.length; k += 2) {
    const ax = pts[k - 2], az = pts[k - 1], bx = pts[k], bz = pts[k + 1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    if (l2 <= 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const qx = ax + t * dx, qz = az + t * dz;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) {
      const L = Math.sqrt(l2);
      const tx = (forward ? dx : -dx) / L, tz = (forward ? dz : -dz) / L;
      best = d; btx = tx; btz = tz;
      bl = (x - qx) * -tz + (z - qz) * tx;
    }
  }
  return { lat: bl, tx: btx, tz: btz, d: best };
}


export interface LaneReport {
  /** Cars measured: on a lane (not a junction connector), outside bends. */
  n: number;
  worstLaneErrM: number;
  worstHeadingDeg: number;
  /** Least distance from the divider into a car's own half on a two-way. */
  worstOwnSideM: number;
}

/**
 * Every car within `radiusM` of (cx, z), measured. `biasM` displaces every car
 * sideways before measuring: the vacuity probe for a gate that reads this.
 */
export function measureLanes(sim: TrafficSim, g: RoadGraph, cx: number, cz: number, radiusM: number, biasM = 0): LaneReport {
  const out: LaneReport = { n: 0, worstLaneErrM: 0, worstHeadingDeg: 0, worstOwnSideM: Infinity };
  const p: Pose = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };
  for (const c of sim.cars) {
    if (!c.path || c.s < 0 || c.scale < 1) continue;
    sim.pose(c, p);
    if ((p.x - cx) ** 2 + (p.z - cz) ** 2 > radiusM * radiusM) continue;
    const he = c.path.he;
    const e = g.edges[he >> 1];
    const forward = (he & 1) === 0;
    const lay = laneLayout(e);
    const x = p.x - p.dirZ * biasM, z = p.z + p.dirX * biasM;
    if (inBend(e.pts, x, z, lay.widthM / 2)) continue;
    const on = onCentreline(e.pts, x, z, forward);
    const lanes = lanesForTravel(lay, forward);
    out.n++;
    out.worstLaneErrM = Math.max(out.worstLaneErrM, Math.min(...lanes.map((l) => Math.abs(on.lat - l))));
    const cos = Math.max(-1, Math.min(1, p.dirX * on.tx + p.dirZ * on.tz));
    out.worstHeadingDeg = Math.max(out.worstHeadingDeg, (Math.acos(cos) * 180) / Math.PI);
    if (lay.dividerM !== null) {
      const div = forward ? lay.dividerM : -lay.dividerM;
      out.worstOwnSideM = Math.min(out.worstOwnSideM, on.lat - div);
    }
  }
  return out;
}
