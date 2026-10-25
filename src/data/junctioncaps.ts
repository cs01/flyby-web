// Tarmac over the corners of a junction.
//
// WHY. A road ribbon is a strip of constant width along its centreline, so
// where two of them cross at a right angle the four corners between their
// kerb lines (the quarter-circles a real junction rounds off) belong to
// neither strip. The pavement opens there, the ribbons stop short, and what
// shows is the terrain drape: the satellite texel under the junction, which
// in the owner's sf-street report was a bright green patch beside the kerb
// and a glaring white one at the corner. A cap is a disc of tarmac under each
// junction, big enough to reach the kerb-line corners, drawn beneath the
// ribbons so their paint stays on top.
//
// Pure, like the rest of data/: test/junction.check.ts measures the coverage.

import type { RoadGraph } from "./roadgraph";
import { roadWidthM, ROAD_BRIDGE, ROAD_TUNNEL, RoadClass, type Road } from "./roadpack";

export interface JunctionCap {
  x: number;
  z: number;
  radiusM: number;
  /** The widest road through it, for the material. */
  cls: RoadClass;
  surface: number;
}

/** Corner angles outside this band are not filled: an acute fork's kerb
 *  corner is far down the fork, already inside both ribbons. */
const MIN_CORNER_RAD = (45 * Math.PI) / 180;

/**
 * How far past a kerb-line corner a cap reaches, metres. The pavement along a
 * road is built from stations every PAVEMENT_STATION_M (5 m) and stops at the
 * last one whose middle is clear of the crossing carriageway, so its end can
 * fall up to a station short of the cross street's kerb: that sliver is the
 * hole the drape showed through. 5.5 m covers it, and under the pavements
 * that do reach, the cap is hidden beneath their raised surface.
 */
export const CORNER_REACH_M = 5.5;
/** Hard ceiling on a cap, metres past the widest half width, so an odd
 *  geometry cannot lay an acre of tarmac. */
const MAX_CAP_OVER_M = 9;

/** Unit direction of edge e leaving node n, from its first segment. */
function leaving(pts: Float32Array, atStart: boolean): [number, number] {
  const n = pts.length;
  const [dx, dz] = atStart ? [pts[2] - pts[0], pts[3] - pts[1]] : [pts[n - 4] - pts[n - 2], pts[n - 3] - pts[n - 1]];
  const L = Math.hypot(dx, dz) || 1;
  return [dx / L, dz / L];
}

/** Whether a road is drawn as a ground-level carriageway. */
function ground(r: Road): boolean {
  return (r.flags & (ROAD_TUNNEL | ROAD_BRIDGE)) === 0 && r.cls < RoadClass.Pedestrian;
}

/**
 * The kerb-line corners of a junction: for every pair of arms adjacent in
 * angle, the point where the left kerb of one meets the right kerb of the
 * next. Returned with the corner angle, for the coverage check and the caps.
 */
export function junctionCorners(
  g: RoadGraph, n: number,
): { x: number; z: number; angle: number; ax: number; az: number; bx: number; bz: number }[] {
  const arms: { a: number; hw: number }[] = [];
  const seen = new Set<number>();
  for (const h of [...g.out[n], ...g.into[n]]) {
    if (seen.has(h.edge)) continue;
    seen.add(h.edge);
    const e = g.edges[h.edge];
    if (!ground(e)) continue;
    const hw = roadWidthM(e.cls, e.lanes, e.flags) / 2;
    if (e.a === n) { const [x, z] = leaving(e.pts, true); arms.push({ a: Math.atan2(z, x), hw }); }
    if (e.b === n) { const [x, z] = leaving(e.pts, false); arms.push({ a: Math.atan2(z, x), hw }); }
  }
  if (arms.length < 3) return [];
  arms.sort((p, q) => p.a - q.a);
  const out: { x: number; z: number; angle: number; ax: number; az: number; bx: number; bz: number }[] = [];
  for (let i = 0; i < arms.length; i++) {
    const A = arms[i], B = arms[(i + 1) % arms.length];
    let th = B.a - A.a;
    if (th <= 0) th += Math.PI * 2;
    if (th < MIN_CORNER_RAD || th > Math.PI - 0.2) continue;
    // Kerb of A on the side toward B, and of B on the side toward A: their
    // intersection, in A's frame, is (hwB / sin th + hwA cot th, hwA).
    const ax = Math.cos(A.a), az = Math.sin(A.a);
    const nx = -az, nz = ax; // toward B (B is counter-clockwise of A)
    const along = B.hw / Math.sin(th) + A.hw * Math.cos(th) / Math.sin(th);
    out.push({
      x: g.nodeX[n] + ax * along + nx * A.hw, z: g.nodeZ[n] + az * along + nz * A.hw, angle: th,
      // The two arms' directions away from the node, for walking out along
      // each kerb from the corner.
      ax, az, bx: Math.cos(B.a), bz: Math.sin(B.a),
    });
  }
  return out;
}

/** One cap per junction of three or more ground-level carriageways. */
export function junctionCaps(g: RoadGraph): JunctionCap[] {
  const caps: JunctionCap[] = [];
  for (let n = 0; n < g.nodeCount; n++) {
    if (g.degree[n] < 3) continue;
    const corners = junctionCorners(g, n);
    if (!corners.length) continue;
    let widest = -1;
    let hwMax = 0;
    for (const h of [...g.out[n], ...g.into[n]]) {
      const e = g.edges[h.edge];
      if (!ground(e)) continue;
      const hw = roadWidthM(e.cls, e.lanes, e.flags) / 2;
      if (hw > hwMax) { hwMax = hw; widest = h.edge; }
    }
    let r = 0;
    for (const c of corners) r = Math.max(r, Math.hypot(c.x - g.nodeX[n], c.z - g.nodeZ[n]));
    r = Math.min(r + CORNER_REACH_M, hwMax + MAX_CAP_OVER_M);
    const e = g.edges[widest];
    caps.push({ x: g.nodeX[n], z: g.nodeZ[n], radiusM: r, cls: e.cls, surface: e.surface });
  }
  return caps;
}
