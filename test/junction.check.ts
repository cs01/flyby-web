// The gate on junction corners: is there tarmac between the kerb lines where
// two streets meet, or does the terrain drape show through.
//
// THE OWNER'S REPORT, from the sf-street pose: a bright green patch on the
// carriageway beside the kerb and a glaring white one at the junction corner.
// Both were the satellite drape under a junction showing through. A pavement
// is built from stations every 5 m and stops at the last one clear of the
// crossing carriageway, so it can end up to a station short of the cross
// street's kerb, and the sliver between that end and the kerb line belongs to
// no ribbon and no pavement. Measured here on the packs: for every kerb-line
// corner of every junction, points 4 m out along each kerb line, half a metre
// onto the footway side, must be under a ribbon or a junction cap
// (data/junctioncaps.ts). Probe: the ribbons alone.
//
// Bounds are literals; the probe must fail.

import { parseRoadPack, roadWidthM, ROAD_BRIDGE, ROAD_TUNNEL, RoadClass, type RoadPack } from "../src/data/roadpack";
import { buildRoadGraph, type RoadGraph } from "../src/data/roadgraph";
import { junctionCaps, junctionCorners } from "../src/data/junctioncaps";

const DIR = new URL("../public/cities/", import.meta.url).pathname;
/** Radius about the pack centre measured, metres: the street-level ring. */
const MEASURE_RADIUS_M = 2500;
/** Share of corner samples that may still be uncovered. Measured 0.51 to
 *  0.60% across the three cities, all of them acute corners near 45 degrees
 *  whose kerb corner is further out than a cap is allowed to reach; the
 *  ribbons alone leave 96 to 98% open. */
const MAX_UNCOVERED_SHARE = 0.01;
/** Corners a city must have before the share means anything. */
const MIN_CORNERS = 500;

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(62)} ${detail}`);
  if (!ok) failures++;
}
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  console.log(`${!checkerSaidOk ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(52)} ${detail}`);
  if (checkerSaidOk) failures++;
}

function distToPolyline(pts: Float32Array, x: number, z: number): number {
  let best = Infinity;
  for (let k = 2; k < pts.length; k += 2) {
    const ax = pts[k - 2], az = pts[k - 1], dx = pts[k] - ax, dz = pts[k + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

function measure(id: string, pack: RoadPack): void {
  const g: RoadGraph = buildRoadGraph(pack.roads);
  const caps = junctionCaps(g);
  const capAt = new Map<number, number>();
  for (const c of caps) {
    // Caps are one per junction node, at the node.
    capAt.set(Math.round(c.x * 10) * 100003 + Math.round(c.z * 10), c.radiusM);
  }
  let corners = 0, byRibbon = 0, uncoveredWithCaps = 0;
  for (let n = 0; n < g.nodeCount; n++) {
    const nx = g.nodeX[n], nz = g.nodeZ[n];
    if (Math.hypot(nx, nz) > MEASURE_RADIUS_M || g.degree[n] < 3) continue;
    const incident = [...g.out[n], ...g.into[n]].map((h) => g.edges[h.edge])
      .filter((e) => (e.flags & (ROAD_TUNNEL | ROAD_BRIDGE)) === 0 && e.cls < RoadClass.Pedestrian);
    const r = capAt.get(Math.round(nx * 10) * 100003 + Math.round(nz * 10)) ?? 0;
    for (const c of junctionCorners(g, n)) {
      for (const [ux, uz] of [[c.ax, c.az], [c.bx, c.bz]]) {
        // 4 m out along this arm's kerb from the corner, 0.5 m off it on the
        // footway side (away from the node's bisector of the two arms).
        const ox = c.x - nx, oz = c.z - nz;
        const ol = Math.hypot(ox, oz) || 1;
        const x = c.x + ux * 4 + (ox / ol) * 0.5, z = c.z + uz * 4 + (oz / ol) * 0.5;
        corners++;
        const onRibbon = incident.some((e) => distToPolyline(e.pts, x, z) <= roadWidthM(e.cls, e.lanes, e.flags) / 2);
        if (onRibbon) byRibbon++;
        if (!onRibbon && Math.hypot(x - nx, z - nz) > r) uncoveredWithCaps++;
      }
    }
  }
  const share = corners ? uncoveredWithCaps / corners : 1;
  const ribbonOnly = corners ? (corners - byRibbon) / corners : 1;
  check(`${id}: every junction corner is under tarmac`, corners >= MIN_CORNERS && share <= MAX_UNCOVERED_SHARE,
    `${uncoveredWithCaps} of ${corners} corners uncovered (${(share * 100).toFixed(2)}%), ${caps.length} caps`);
  probe(`${id}: the ribbons alone leave the corners open`, corners >= MIN_CORNERS && ribbonOnly <= MAX_UNCOVERED_SHARE,
    `${((ribbonOnly) * 100).toFixed(1)}% of corners open without caps`);
}

for (const id of ["sf", "chicago", "manhattan"]) {
  measure(id, parseRoadPack(await Bun.file(`${DIR}${id}.roads`).arrayBuffer()));
}
console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) process.exit(1);
