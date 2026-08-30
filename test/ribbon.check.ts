// The gate on the ribbon builder in src/data/ribbon.ts.
//
// A ribbon is easy to get subtly wrong in ways that all still produce a
// well-formed, well-winded, perfectly renderable buffer, so nothing structural
// catches them. The four that actually happen:
//
//   * `u` drifts. Normalise it, or reset it per segment, or accumulate it from
//     the OFFSET vertices instead of the centreline, and every dash on the map
//     is a different length. Asserted to a millimetre against the true
//     polyline length, on synthetic roads and on all 38741 ways of sf.roads.
//   * the mitre is unclamped. OSM is full of hairpins; each one becomes a spike
//     tens of metres long lying across the city. Asserted as a hard bound on
//     the distance from any vertex to its own centreline point.
//   * the offset normal is flipped, so v=0 and v=1 land on the same side and
//     the ribbon collapses or turns inside out at every joint. Asserted by the
//     sign of cross(local direction, offset), which is provably negative for
//     every vertex a correct builder emits (see the note on LOCAL DIRECTION).
//   * `v` picks up an intermediate value, which silently smears the edge lines
//     across the carriageway.
//
// Watched to fail: raising MITRE_LIMIT in src/data/ribbon.ts turns the hairpin
// assertions red; negating nrmX/nrmZ there turns every cross-product assertion
// red. Both were run.

import { addRibbon, emptyRibbon, MITRE_LIMIT, type RibbonScratch } from "../src/data/ribbon";
import { parseRoadPack, roadLengthM, roadWidthM } from "../src/data/roadpack";

/**
 * Hard bound on how far a vertex may run from its own centreline point, as a
 * multiple of the half-width.
 *
 * A LITERAL, deliberately, and not MITRE_LIMIT. The first version of this file
 * asserted against the constant it was testing, so raising MITRE_LIMIT to 1e9
 * moved the goalposts with the code and the gate reported "ok" at a reach of 70
 * half-widths. An assertion that reads its threshold from the thing under test
 * cannot fail. MITRE_LIMIT is checked against this bound instead.
 */
const MAX_REACH_H = 2.05;

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${label.padEnd(56)} ${detail}`);
  }
}

/** Only prints when it passes, so a sweep of 38741 roads stays one line. */
function report(label: string, before: number, detail: string): void {
  const ok = failures === before;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} ${detail}`);
}

// --- geometry helpers the assertions are written against --------------------

/** Distinct centreline points and their cumulative arc length. The oracle for
 *  `u`, computed here rather than imported so it is a second opinion. */
function centreline(pts: ArrayLike<number>): { x: number[]; z: number[]; s: number[] } {
  const x: number[] = [];
  const z: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const last = x.length - 1;
    if (last >= 0 && Math.abs(pts[i] - x[last]) < 1e-4 && Math.abs(pts[i + 1] - z[last]) < 1e-4) continue;
    x.push(pts[i]);
    z.push(pts[i + 1]);
  }
  const s = [0];
  for (let i = 1; i < x.length; i++) s.push(s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]));
  return { x, z, s };
}

/**
 * LOCAL DIRECTION at centreline point i: the normalised mean of the segment
 * directions meeting there.
 *
 * This is the reference the cross-product assertion needs, and it is not an
 * approximation. For a mitred joint the offset lies along the bisector b, and
 * cross(mean direction, b) works out to exactly -cos(phi/2) for a turn of phi;
 * for a bevelled joint the offset is one segment's own normal and the same
 * algebra gives -cos(phi/2) again. So a correct builder puts EVERY v=0 vertex
 * at a strictly negative cross product, for every joint shape, with no case
 * analysis in the test. It degenerates only at phi = 180 exactly, where the
 * mean direction is zero and there is nothing to compare against.
 */
function localDir(c: { x: number[]; z: number[] }, i: number): [number, number] | null {
  let dx = 0;
  let dz = 0;
  if (i > 0) {
    const l = Math.hypot(c.x[i] - c.x[i - 1], c.z[i] - c.z[i - 1]);
    dx += (c.x[i] - c.x[i - 1]) / l;
    dz += (c.z[i] - c.z[i - 1]) / l;
  }
  if (i + 1 < c.x.length) {
    const l = Math.hypot(c.x[i + 1] - c.x[i], c.z[i + 1] - c.z[i]);
    dx += (c.x[i + 1] - c.x[i]) / l;
    dz += (c.z[i + 1] - c.z[i]) / l;
  }
  const l = Math.hypot(dx, dz);
  return l < 1e-6 ? null : [dx / l, dz / l];
}

function triangleArea(s: RibbonScratch): number {
  let a = 0;
  for (let t = 0; t + 2 < s.idx.length; t += 3) {
    const i0 = s.idx[t] * 2;
    const i1 = s.idx[t + 1] * 2;
    const i2 = s.idx[t + 2] * 2;
    a += Math.abs(
      (s.xz[i1] - s.xz[i0]) * (s.xz[i2 + 1] - s.xz[i0 + 1]) -
      (s.xz[i2] - s.xz[i0]) * (s.xz[i1 + 1] - s.xz[i0 + 1]),
    ) * 0.5;
  }
  return a;
}

interface Findings {
  worstU: number;
  worstEnd: number;
  worstReach: number;
  badV: number;
  badSide: number;
  badMonotonic: number;
  pairs: number;
}

/**
 * Every invariant, over one road. Written once and run on both the synthetic
 * cases and the real packs, because an assertion that only ever sees hand-made
 * input is an assertion about hand-made input.
 */
function inspect(pts: ArrayLike<number>, widthM: number, f: Findings): RibbonScratch | null {
  const s = emptyRibbon();
  const tris = addRibbon(s, pts, widthM);
  if (tris === 0) return null;

  const c = centreline(pts);
  const h = widthM * 0.5;
  const verts = s.xz.length / 2;
  f.pairs += verts / 2;

  let prevU = -Infinity;
  for (let k = 0; k * 2 < verts; k++) {
    const uA = s.uv[k * 4];
    const uB = s.uv[k * 4 + 2];
    const vA = s.uv[k * 4 + 1];
    const vB = s.uv[k * 4 + 3];

    if (uA !== uB) f.badV++;                       // a pair must share one u
    if (vA !== 0 || vB !== 1) f.badV++;
    if (uA < prevU) f.badMonotonic++;
    prevU = uA;

    // Which centreline point this pair belongs to, found by its u. Every
    // emitted vertex sits ON a polyline point, so the match must be exact.
    let best = 0;
    for (let i = 1; i < c.s.length; i++) if (Math.abs(c.s[i] - uA) < Math.abs(c.s[best] - uA)) best = i;
    f.worstU = Math.max(f.worstU, Math.abs(c.s[best] - uA));

    const ax = s.xz[k * 4];
    const az = s.xz[k * 4 + 1];
    const bx = s.xz[k * 4 + 2];
    const bz = s.xz[k * 4 + 3];

    // Mitre spike: how far the vertex ran from its own centreline point.
    f.worstReach = Math.max(f.worstReach, Math.hypot(ax - c.x[best], az - c.z[best]) / h);
    f.worstReach = Math.max(f.worstReach, Math.hypot(bx - c.x[best], bz - c.z[best]) / h);

    const d = localDir(c, best);
    if (d) {
      const crossA = d[0] * (az - c.z[best]) - d[1] * (ax - c.x[best]);
      const crossB = d[0] * (bz - c.z[best]) - d[1] * (bx - c.x[best]);
      // v=0 strictly one side, v=1 strictly the other. This is the assertion a
      // flipped normal cannot survive.
      if (!(crossA < -1e-6 && crossB > 1e-6)) f.badSide++;
    }
  }

  f.worstEnd = Math.max(f.worstEnd, Math.abs(s.uv[s.uv.length - 2] - c.s[c.s.length - 1]));
  return s;
}

function fresh(): Findings {
  return { worstU: 0, worstEnd: 0, worstReach: 0, badV: 0, badSide: 0, badMonotonic: 0, pairs: 0 };
}

// --- 1. a straight road is exactly length x width ---------------------------

{
  const before = failures;
  const L = 137.5;
  const W = 14.0;
  const s = emptyRibbon();
  addRibbon(s, [0, 0, L, 0], W);
  const area = triangleArea(s);
  check("straight quad area", Math.abs(area - L * W) < 1e-6, `${area} vs ${L * W}`);
  check("straight quad triangles", s.idx.length === 6, `${s.idx.length / 3} triangles`);
  const uEnd = s.uv[s.uv.length - 2];
  check("straight quad u ends at the length", Math.abs(uEnd - L) < 1e-9, `u ${uEnd} vs ${L}`);
  report("straight road: area = L x W, u = L", before, `${area.toFixed(6)} m2 = ${L} m x ${W} m`);
}

// A dog-leg of two equal runs meeting at a right angle, and the same at a
// gentler bend. A correctly scaled mitre is AREA-PRESERVING: it pushes the
// outer edge out by exactly as much as it pulls the inner edge in, so the
// strip still measures length x width however the road turns. An offset scaled
// by cos instead of 1/cos, or applied along the segment normal instead of the
// bisector, breaks that immediately, and it does so at every joint in the city
// rather than only at the sharp ones.
for (const [name, mid] of [["right-angle", [100, 100]], ["45-degree", [100 + 70.71067811865476, 70.71067811865476]]] as const) {
  const before = failures;
  const W = 10.0;
  const s = emptyRibbon();
  addRibbon(s, [0, 0, 100, 0, mid[0], mid[1]], W);
  const area = triangleArea(s);
  const len = 100 + Math.hypot(mid[0] - 100, mid[1]);
  const want = len * W;
  check(`${name} mitre area`, Math.abs(area - want) < 1e-6, `${area} vs ${want}`);
  const uEnd = s.uv[s.uv.length - 2];
  check(`${name} u`, Math.abs(uEnd - len) < 1e-9, `u ${uEnd} vs ${len}`);
  report(`${name} dog-leg: mitre preserves area`, before, `${area.toFixed(4)} m2 = ${len.toFixed(4)} m x ${W} m`);
}

// --- 2. hairpins do not spike ----------------------------------------------

{
  const before = failures;
  const f = fresh();
  // A switchback that doubles back at 170 degrees, then a 179.5-degree one, then
  // the pathological case of a way that reverses exactly onto itself.
  inspect([0, 0, 100, 0, 100 - 100 * Math.cos(Math.PI / 18), 100 * Math.sin(Math.PI / 18)], 12, f);
  inspect([0, 0, 100, 0, 0.5, 0.9], 12, f);
  inspect([0, 0, 100, 0, 0, 0.0], 12, f);
  // A whole comb of them, every turn angle from gentle to a full reversal.
  for (let deg = 5; deg <= 179; deg += 2) {
    const a = (deg * Math.PI) / 180;
    inspect([0, 0, 80, 0, 80 + 80 * Math.cos(Math.PI - a), 80 * Math.sin(Math.PI - a)], 9, f);
  }
  check("mitre limit is itself within the hard bound", MITRE_LIMIT <= MAX_REACH_H, `MITRE_LIMIT ${MITRE_LIMIT} > ${MAX_REACH_H}`);
  check("hairpin: no mitre spike", f.worstReach <= MAX_REACH_H, `reach ${f.worstReach.toFixed(4)} h > ${MAX_REACH_H} h`);
  check("hairpin: v stays 0/1", f.badV === 0, `${f.badV} bad`);
  check("hairpin: sides stay opposite", f.badSide === 0, `${f.badSide} bad`);
  check("hairpin: u monotonic", f.badMonotonic === 0, `${f.badMonotonic} bad`);
  check("hairpin: u ends at the true length", f.worstEnd < 1e-9, `worst ${f.worstEnd} m`);
  report("hairpins: worst reach within the mitre limit", before, `${f.worstReach.toFixed(4)} h <= ${MAX_REACH_H.toFixed(2)} h`);
}

// --- 3. the real packs ------------------------------------------------------

const DIR = "public/cities";
for (const id of ["sf", "manhattan", "chicago"]) {
  const before = failures;
  const file = Bun.file(`${DIR}/${id}.roads`);
  if (!(await file.exists())) {
    // A missing pack is a failure, not a skip. Skipping is how a gate quietly
    // stops checking anything at all.
    check(`${id}: pack present`, false, `no ${DIR}/${id}.roads -- run: bun tools/bake-roads.ts --all`);
    report(`${id}.roads`, before, "missing");
    continue;
  }
  const pack = parseRoadPack(await file.arrayBuffer());
  const f = fresh();
  let lengthErr = 0;
  for (const r of pack.roads) {
    const w = roadWidthM(r.cls, r.lanes, r.flags);
    const s = inspect(r.pts, w, f);
    if (!s) continue;
    lengthErr = Math.max(lengthErr, Math.abs(s.uv[s.uv.length - 2] - roadLengthM(r)));
  }
  check(`${id}: u matches the true length`, lengthErr < 1e-3, `worst ${lengthErr} m`);
  check(`${id}: u monotonic`, f.badMonotonic === 0, `${f.badMonotonic} bad`);
  check(`${id}: u lands on a polyline point`, f.worstU < 1e-6, `worst ${f.worstU} m`);
  check(`${id}: v is 0 or 1`, f.badV === 0, `${f.badV} bad`);
  check(`${id}: no mitre spike`, f.worstReach <= MAX_REACH_H, `reach ${f.worstReach.toFixed(4)} h > ${MAX_REACH_H} h`);
  check(`${id}: sides stay opposite`, f.badSide === 0, `${f.badSide} of ${f.pairs} pairs`);
  report(
    `${id}.roads: ${pack.roads.length} ways, ${f.pairs} pairs`,
    before,
    `u err ${(lengthErr * 1000).toFixed(4)} mm, reach ${f.worstReach.toFixed(3)} h`,
  );
}

console.log(
  failures === 0
    ? `\nall ${checks} ribbon assertions ok`
    : `\n${failures} of ${checks} ribbon assertion(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
