// The gate on the road coverage mask the terrain shader uses to stop grass
// running over the tarmac.
//
// A format check would be worthless here for the reason test/landmask.check.ts
// gives about its own subject: any wiring mistake still produces a perfectly
// well-formed grid of bytes. The only thing that catches a transposed index, a
// half-texel offset or a resolution quietly dropped back to urbanmask's 85 m is
// GEOGRAPHY, sampled through the same bilinear filter the GPU runs. So every
// assertion below is made at a point taken from a real .roads pack, through
// sampleRoadCoverage, which is the shader's maths and not a second opinion
// about it.
//
// Four rules, and each one exists because breaking it is a plausible change:
//
//   1  ON a carriageway the mask is ~1 and 40 m from one it is 0. A mask that
//      is on everywhere suppresses every lawn in the city; one that is on
//      nowhere fixes nothing.
//   2  It FALLS OFF rather than switching. A hard 0/1 edge at a texel boundary
//      is the same failure as the grass ending on a line, pointed the other
//      way, and it is the easy thing to write.
//   3  A park footpath is NOT a carriageway. Footways are the most common
//      class in every pack and thread through every park; masking them would
//      strip the grass out of Golden Gate Park to fix a street in Emerald
//      Hills.
//   4  No road pack means no mask at all. Only four cities have one, so the
//      no-op is the common path and it has to leave the terrain untouched.
//
// Watched to fail: see the vacuity notes on each section.

import { parseRoadPack, RoadClass, type Road, type RoadPack } from "../src/data/roadpack";
import {
  buildRoadCoverage, emptyRoadMask, sampleRoadCoverage, roadMaskSize,
  coverageAtDistance as coverage,
  KERB_MARGIN_M, VERGE_FADE_M, type RoadCoverage,
} from "../src/render/roadmask";

const DIR = "public/cities";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${detail}`);
  if (!ok) failures++;
}

// --- a nearest-centreline index --------------------------------------------
//
// tools/verify-roads.ts scans every segment per query, which is fine for its
// dozen named probes and hopeless here: this asks thousands of times. Same
// answer, bucketed.

const BUCKET_M = 64;

/** One segment, as four numbers, so the buckets hold no objects. */
interface SegIndex {
  buckets: Map<number, number[]>;
  seg: Float64Array;
  /** Which road record each segment came from, so a query can ignore one. */
  owner: Int32Array;
}

function buildSegIndex(roads: readonly Road[], keep: (r: Road) => boolean): SegIndex {
  const seg: number[] = [];
  const own: number[] = [];
  const buckets = new Map<number, number[]>();
  const key = (bx: number, bz: number): number => bx * 100003 + bz;
  for (let ri = 0; ri < roads.length; ri++) {
    const r = roads[ri];
    if (!keep(r)) continue;
    for (let i = 2; i < r.pts.length; i += 2) {
      const s = seg.length / 4;
      seg.push(r.pts[i - 2], r.pts[i - 1], r.pts[i], r.pts[i + 1]);
      own.push(ri);
      const bx0 = Math.floor(Math.min(r.pts[i - 2], r.pts[i]) / BUCKET_M);
      const bx1 = Math.floor(Math.max(r.pts[i - 2], r.pts[i]) / BUCKET_M);
      const bz0 = Math.floor(Math.min(r.pts[i - 1], r.pts[i + 1]) / BUCKET_M);
      const bz1 = Math.floor(Math.max(r.pts[i - 1], r.pts[i + 1]) / BUCKET_M);
      for (let bz = bz0; bz <= bz1; bz++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const k = key(bx, bz);
          const list = buckets.get(k);
          if (list) list.push(s); else buckets.set(k, [s]);
        }
      }
    }
  }
  return { buckets, seg: Float64Array.from(seg), owner: Int32Array.from(own) };
}

function segDist(seg: Float64Array, s: number, px: number, pz: number): number {
  const ax = seg[s * 4], az = seg[s * 4 + 1], bx = seg[s * 4 + 2], bz = seg[s * 4 + 3];
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Distance to the nearest indexed centreline, searched out to `maxM`. Returns
 *  Infinity beyond that, which is all any caller here needs. */
function nearestDist(ix: SegIndex, x: number, z: number, maxM: number, ignore = -1): number {
  const rings = Math.ceil(maxM / BUCKET_M);
  const cx = Math.floor(x / BUCKET_M), cz = Math.floor(z / BUCKET_M);
  let best = Infinity;
  for (let bz = cz - rings; bz <= cz + rings; bz++) {
    for (let bx = cx - rings; bx <= cx + rings; bx++) {
      const list = ix.buckets.get(bx * 100003 + bz);
      if (!list) continue;
      for (const s of list) {
        if (ix.owner[s] === ignore) continue;
        const d = segDist(ix.seg, s, x, z);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

const CARRIAGEWAY = (r: Road): boolean =>
  r.cls !== RoadClass.Footway && r.cls !== RoadClass.Cycleway && r.cls !== RoadClass.Track;

// --- packs ------------------------------------------------------------------

async function pack(id: string): Promise<RoadPack | null> {
  const f = Bun.file(`${DIR}/${id}.roads`);
  if (!(await f.exists())) return null;
  return parseRoadPack(await f.arrayBuffer());
}

interface Loaded {
  id: string;
  pack: RoadPack;
  cov: RoadCoverage;
  extent: number;
  carriage: SegIndex;
}

const CITIES = ["emeraldhills", "sf"];
const loaded: Loaded[] = [];
for (const id of CITIES) {
  const p = await pack(id);
  if (!p) {
    // A missing pack is a failure, not a skip. Skipping is how a gate quietly
    // stops checking anything at all.
    check(`${id}: pack present`, false, `no ${DIR}/${id}.roads -- run: bun tools/bake-roads.ts --all`);
    continue;
  }
  const extent = Math.max(2000, p.radiusM);
  loaded.push({
    id, pack: p, extent,
    cov: buildRoadCoverage(p.roads, extent),
    carriage: buildSegIndex(p.roads, CARRIAGEWAY),
  });
}

// --- resolution -------------------------------------------------------------
//
// The mask has to out-resolve the 10 m landcover posting it is correcting, and
// it has to fit in memory. Both directions were run:
//   TARGET_CELL_M 5 -> 85 (urbanmask's grain) reds the first at 46.88 m/texel.
//   TARGET_CELL_M 5 -> 3 with MAX_N 2560 -> 8192 reds the second at 15.26 MiB.

const MAX_CELL_M = 6.5;
const MAX_BYTES = 8 * 1024 * 1024;
for (const L of loaded) {
  const cell = (L.extent * 2) / L.cov.n;
  const bytes = L.cov.data.length;
  console.log(
    `\n${L.id}: radius ${L.pack.radiusM} m, n ${L.cov.n}, ` +
      `${cell.toFixed(2)} m/texel, ${(bytes / 1048576).toFixed(2)} MiB, ` +
      `${L.pack.roads.length} ways`,
  );
  check(`${L.id}: resolves a carriageway`, cell <= MAX_CELL_M, `${cell.toFixed(2)} m/texel <= ${MAX_CELL_M}`);
  check(`${L.id}: fits the texture budget`, bytes <= MAX_BYTES, `${(bytes / 1048576).toFixed(2)} MiB <= 8 MiB`);
}

// --- 1. on a carriageway, and well away from one ----------------------------
//
// Points ON the centreline of a real road, taken at segment midpoints so the
// sample is not sitting on a vertex where two ways happen to meet.
//
// Watched to fail, both directions. Rasterising the centreline as a hairline
// (the reach test in buildRoadCoverage cut to half a metre) takes the on-road
// minimum from 0.973 to 0.000. VERGE_FADE_M 6 -> 60, and separately dropping
// Footway from HAS_CARRIAGEWAY, take the off-road maximum from 0.0000 to 0.43
// and 0.94.

const ON_ROAD_MIN = 0.9;
const OFF_ROAD_M = 40;
const OFF_ROAD_MAX = 0.001;

for (const L of loaded) {
  let n = 0, worst = 1, worstAt = "";
  for (const r of L.pack.roads) {
    // Residential and up: the classes the complaint is about, and wide enough
    // that no alignment of the grid can put a texel centre outside the flat
    // top of the falloff.
    if (r.cls > RoadClass.Residential) continue;
    for (let i = 2; i < r.pts.length && n < 4000; i += 2) {
      const mx = (r.pts[i - 2] + r.pts[i]) * 0.5;
      const mz = (r.pts[i - 1] + r.pts[i + 1]) * 0.5;
      if (Math.abs(mx) > L.extent - 20 || Math.abs(mz) > L.extent - 20) continue;
      const c = sampleRoadCoverage(L.cov, mx, mz);
      n++;
      if (c < worst) { worst = c; worstAt = `(${mx.toFixed(0)}, ${mz.toFixed(0)}) cls ${r.cls}`; }
    }
    if (n >= 4000) break;
  }
  check(`${L.id}: mask is on over carriageways`, n > 500 && worst > ON_ROAD_MIN,
    `${n} centreline points, min ${worst.toFixed(3)} > ${ON_ROAD_MIN}  ${worst > ON_ROAD_MIN ? "" : "at " + worstAt}`);
}

for (const L of loaded) {
  // A grid of candidates, keeping the ones with no carriageway within 40 m.
  // The widest road in any pack is a four-lane motorway, which reaches
  // 7 + 1.5 + 6 = 14.5 m, so 40 m is far outside every falloff by construction.
  let n = 0, worst = 0, worstAt = "";
  const step = 37; // not a multiple of the texel size, so the samples are not all texel centres
  for (let z = -L.extent + 100; z < L.extent - 100 && n < 4000; z += step) {
    for (let x = -L.extent + 100; x < L.extent - 100 && n < 4000; x += step) {
      if (nearestDist(L.carriage, x, z, OFF_ROAD_M) < OFF_ROAD_M) continue;
      const c = sampleRoadCoverage(L.cov, x, z);
      n++;
      if (c > worst) { worst = c; worstAt = `(${x.toFixed(0)}, ${z.toFixed(0)})`; }
    }
  }
  check(`${L.id}: mask is off away from roads`, n > 200 && worst < OFF_ROAD_MAX,
    `${n} points >${OFF_ROAD_M} m out, max ${worst.toFixed(4)} < ${OFF_ROAD_MAX}  ${worst < OFF_ROAD_MAX ? "" : "at " + worstAt}`);
}

// --- 2. the falloff is a falloff --------------------------------------------
//
// Transects perpendicular to a centreline, on roads with nothing else within
// 90 m so the profile is that one road's and not a junction's. Coverage must
// never rise as the sample walks away from the road: that is the difference
// between a transition across the verge and grass ending on a line.
//
// Watched to fail, and the pair is why both assertions are here rather than
// one. A hairline raster leaves 9 of 40 transects with any ramp at all (the
// second assertion reds, the first survives with one rise); inverting
// coverageAtDistance to `min(1, distM / reach)` reds the first with 516 rises
// while the ramp assertion still passes, since an inverted ramp is still a
// ramp. Only the two together pin the falloff down.

const TRANSECT_M = 30;
const TRANSECT_STEP = 0.5;
// The mask is a RESAMPLING of the falloff, not the falloff, so a transect that
// crosses the grid obliquely reconstructs with a little wobble: one 255th of
// byte quantisation, plus a fraction of a texel of bilinear error at the knee
// where the flat top meets the ramp. Measured worst over the 80 single-road
// transects below, both cities: +0.0048. This is four times that, and it is
// still an order of magnitude under the 0.083 a step of the ramp itself covers
// in one 0.5 m sample, so an inverted or hard-edged falloff cannot hide in it.
const MONO_EPS = 0.02;
/** How far a foreign road must stay from a transect to leave it alone. The
 *  widest class is a four-lane motorway, which reaches 7 + 1.5 + 6 = 14.5 m,
 *  so anything past this contributes exactly zero. */
const FOREIGN_CLEAR_M = 16;
/** How far the road's own geometry may curve back toward the transect. The
 *  sample at distance d is at exactly d from the segment it came off, so
 *  anything nearer is a bend of the same street, and coverage rising as the
 *  walk approaches the inside of a bend is again correct, not a broken ramp. */
const CURVE_SLACK_M = 0.05;

for (const L of loaded) {
  let transects = 0, breaks = 0, worstRise = 0, midCount = 0, tried = 0;
  outer:
  for (let ri = 0; ri < L.pack.roads.length; ri++) {
    const r = L.pack.roads[ri];
    if (r.cls > RoadClass.Residential) continue;
    for (let i = 2; i < r.pts.length; i += 2) {
      const ax = r.pts[i - 2], az = r.pts[i - 1], bx = r.pts[i], bz = r.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 40) continue;
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      if (Math.abs(mx) > L.extent - 200 || Math.abs(mz) > L.extent - 200) continue;
      const ux = -(bz - az) / len, uz = (bx - ax) / len;

      for (const side of [1, -1]) {
        // The transect is only about ONE road, and BOTH conditions are needed
        // to say so. The nearest centreline in the pack must be this one, at
        // exactly the distance walked, so the road does not curve back at the
        // sample; and no OTHER record may come within FOREIGN_CLEAR_M, so no
        // second road contributes coverage of its own. Without the second, a
        // motorway 25 m off pushes the profile back up as the walk approaches
        // it, and coverage rising because you are nearing a bigger road is
        // correct behaviour, not a broken ramp. That is what the three rises
        // in San Francisco were.
        tried++;
        const prof: number[] = [];
        let clean = true;
        for (let d = 0; d <= TRANSECT_M + 1e-9; d += TRANSECT_STEP) {
          const px = mx + ux * side * d, pz = mz + uz * side * d;
          if (nearestDist(L.carriage, px, pz, 45) < d - CURVE_SLACK_M ||
              nearestDist(L.carriage, px, pz, 45, ri) < FOREIGN_CLEAR_M) {
            clean = false;
            break;
          }
          prof.push(sampleRoadCoverage(L.cov, px, pz));
        }
        if (!clean) continue;

        let sawMiddle = 0;
        for (let k = 1; k < prof.length; k++) {
          // Tracked whether or not it trips, so the printed number is the
          // headroom under MONO_EPS and drift toward it is visible before the
          // gate goes red rather than after.
          worstRise = Math.max(worstRise, prof[k] - prof[k - 1]);
          if (prof[k] > prof[k - 1] + MONO_EPS) breaks++;
        }
        for (const c of prof) if (c > 0.15 && c < 0.85) sawMiddle++;
        // A hard 0/1 edge would step between two samples and never be caught by
        // monotonicity alone, which is why this rides alongside it.
        if (sawMiddle >= 3) midCount++;
        transects++;
        if (transects >= 40) break outer;
      }
    }
  }
  check(`${L.id}: coverage never rises with distance`, transects >= 20 && breaks === 0,
    `${transects} clean transects of ${tried} tried, ${breaks} rises > ${MONO_EPS}, worst +${worstRise.toFixed(4)}`);
  check(`${L.id}: falloff is a ramp, not an edge`, transects >= 20 && midCount === transects,
    `${midCount}/${transects} transects spend >=3 samples between 0.15 and 0.85`);
}

// The shape itself, independent of any grid. Cheap, and it is what the
// rasteriser is a sampling OF.
{
  const w = 7; // a two-lane residential street
  const full = w / 2 + KERB_MARGIN_M;
  const prof: number[] = [];
  for (let d = 0; d <= full + VERGE_FADE_M + 2; d += 0.25) prof.push(coverage(d, w));
  let mono = true;
  for (let i = 1; i < prof.length; i++) if (prof[i] > prof[i - 1] + 1e-9) mono = false;
  check("falloff shape is monotone", mono, `${prof.length} samples over 0..${(full + VERGE_FADE_M + 2).toFixed(1)} m`);
  check("full over the carriageway", coverage(full - 0.01, w) === 1, `coverage(${(full - 0.01).toFixed(2)} m) = 1`);
  check("zero past the verge", coverage(full + VERGE_FADE_M, w) === 0,
    `coverage(${(full + VERGE_FADE_M).toFixed(2)} m) = 0`);
  check("half way across the verge", Math.abs(coverage(full + VERGE_FADE_M / 2, w) - 0.5) < 1e-9,
    `coverage(${(full + VERGE_FADE_M / 2).toFixed(2)} m) = ${coverage(full + VERGE_FADE_M / 2, w).toFixed(3)}`);
}

// --- 3. a park path is not a carriageway ------------------------------------
//
// Golden Gate Park is threaded with footways and has real roads through it, so
// the assertion is made only at path points that are already 40 m from any
// carriageway. Watched to fail: dropping Footway from the exclusion list in
// HAS_CARRIAGEWAY takes the maximum from 0.0000 to 1.0000 in both cities.

for (const L of loaded) {
  let n = 0, worst = 0;
  for (const r of L.pack.roads) {
    if (r.cls !== RoadClass.Footway && r.cls !== RoadClass.Cycleway && r.cls !== RoadClass.Track) continue;
    for (let i = 2; i < r.pts.length && n < 1500; i += 2) {
      const mx = (r.pts[i - 2] + r.pts[i]) * 0.5;
      const mz = (r.pts[i - 1] + r.pts[i + 1]) * 0.5;
      if (nearestDist(L.carriage, mx, mz, OFF_ROAD_M) < OFF_ROAD_M) continue;
      const c = sampleRoadCoverage(L.cov, mx, mz);
      n++;
      if (c > worst) worst = c;
    }
    if (n >= 1500) break;
  }
  check(`${L.id}: paths away from roads keep their grass`, n > 50 && worst < OFF_ROAD_MAX,
    `${n} path points, max ${worst.toFixed(4)} < ${OFF_ROAD_MAX}`);
}

// --- 4. no road pack, no mask -----------------------------------------------
//
// Most cities have no .roads pack, so this is the common path and it must be a
// no-op twice over: the flag the shader multiplies by is 0, AND the one texel
// behind it is 0. Watched to fail: `has: true` reds the first; a 255 texel and
// an extent of 6000 red the next two; filling the grid in buildRoadCoverage
// with 255 reds the last.

{
  const e = emptyRoadMask();
  check("no pack: shader flag is off", !e.has, `has = ${e.has}`);
  check("no pack: the texel is zero too", (e.texture.image.data as Uint8Array)[0] === 0,
    `data[0] = ${(e.texture.image.data as Uint8Array)[0]}`);
  check("no pack: extent is inert", e.extent === 1, `extent = ${e.extent}`);

  // And a pack that parses but has no ways at all leaves an empty grid rather
  // than, say, a field of 255 from an uninitialised buffer.
  const cov = buildRoadCoverage([], 6000);
  let max = 0;
  for (const v of cov.data) if (v > max) max = v;
  check("no ways: grid is all zero", max === 0, `n ${cov.n} (${roadMaskSize(6000)}), max byte ${max}`);
}

console.log(failures === 0 ? "\nall road mask checks ok" : `\n${failures} road mask check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
