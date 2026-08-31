// Where a street lamp stands, where a car drives and where a car is parked.
//
// WHY THIS IS A PURE FILE, LIKE data/pavement.ts AND data/trees.ts. Whether a
// car looks like a car is a screenshot question. Whether it is inside the
// carriageway, whether it is going the right way down a one-way, whether a lamp
// is standing in somebody's front room and whether there are more cars on a
// motorway than in an alley are arithmetic, and arithmetic gets gated. So there
// is no THREE, no DOM and no fetch here, and test/street.check.ts runs this
// against the committed public/cities/*.roads under Bun.
//
// THE ONE THING TO UNDERSTAND ABOUT THE LAMPS. render/roads.ts has painted
// pools of lamplight on the carriageway for as long as there have been road
// ribbons, as a procedural function of (u, v) in the ribbon's own parameters --
// u in metres along the centreline, v across it. It did that with no object
// standing over any of the pools, and with a spacing constant of its own.
//
// Putting a post over each pool is only an improvement if the post and the pool
// cannot disagree, and two tables of numbers in two languages WILL disagree
// within a month. So the spacing table below is the only one that exists, and
// LAMP_GLSL below GENERATES the shader's copy of it from this array. The
// fragment shader indexes `LAMP_SPACING` and this file indexes
// `LAMP_SPACING_M`, and they are the same fourteen floats by construction. That
// is what test/street.check.ts checks by parsing the numbers back out of the
// generated GLSL rather than by trusting either side.
//
// WHAT IS MEASURED AND WHAT IS INVENTED. OSM maps street lamps as individual
// nodes and a well-mapped city has thousands of them: 2,461 in a 1.7 x 2.5 km
// box of Paris, 178 in the same box of Manhattan, and none at all in a suburb.
// tools/bake-roads.ts carries those nodes into a `.street` pack.
//
// They are used HERE, and in one bounded way: a procedural lamp within
// LAMP_SNAP_M of a surveyed node moves onto the node, and reports itself as
// measured. It cannot do more than that, because the pool the road shader
// paints is a per-fragment function of the ribbon parameters and has no channel
// through which a point cloud could move it. So the survey improves where a
// lamp stands, to the limit at which the post would leave its own light, and
// every lamp still has a pool and every pool still has a post. The split is
// counted per city rather than claimed.

import {
  LANE_WIDTH_M,
  parkingStripM,
  roadLiftM,
  roadWidthM,
  RoadClass,
  ROAD_ONEWAY,
  ROAD_TUNNEL,
  type Road,
} from "./roadpack";
import { KERB_HEIGHT_M } from "./pavement";

// --- tiling -----------------------------------------------------------------

/**
 * Tile edge, in metres. Same 400 m as the pavement, and for the same reason: a
 * way belongs to the tile its centroid falls in, ways are a few tens of metres
 * long, so the overhang past a tile edge is small and costs nothing but a
 * slightly generous bounding sphere.
 */
export const STREET_TILE_M = 400;

export function tileKey(x: number, z: number): string {
  return `${x},${z}`;
}

/** Way indices per tile, for every way an acceptor keeps. Built once. */
export function indexWaysByTile(
  roads: readonly Road[],
  accept: (r: Road) => boolean,
  tileM = STREET_TILE_M,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!accept(r)) continue;
    const key = tileKey(Math.floor(r.cx / tileM), Math.floor(r.cz / tileM));
    const list = out.get(key);
    if (list) list.push(i);
    else out.set(key, [i]);
  }
  return out;
}

export interface WantedTile {
  key: string;
  d2: number;
}

/**
 * The tiles of an index within `ringM` of a camera, nearest first.
 *
 * Nearest first is what lets a city denser than the budget lose its outermost
 * ring rather than an arbitrary slice; render/trees.ts and render/pavement.ts
 * both sort the same way and this is the third copy, which is why it is here
 * and not in either of them.
 */
export function tilesAround(
  index: ReadonlyMap<string, number[]>,
  camX: number,
  camZ: number,
  ringM: number,
  tileM = STREET_TILE_M,
): WantedTile[] {
  const tx = Math.floor(camX / tileM);
  const tz = Math.floor(camZ / tileM);
  const span = Math.ceil(ringM / tileM) + 1;
  const out: WantedTile[] = [];
  for (let k = tz - span; k <= tz + span; k++) {
    for (let i = tx - span; i <= tx + span; i++) {
      const key = tileKey(i, k);
      if (!index.has(key)) continue;
      const x0 = i * tileM;
      const z0 = k * tileM;
      const dx = Math.max(0, Math.max(x0 - camX, camX - (x0 + tileM)));
      const dz = Math.max(0, Math.max(z0 - camZ, camZ - (z0 + tileM)));
      const d2 = dx * dx + dz * dz;
      if (d2 > ringM * ringM) continue;
      out.push({ key, d2 });
    }
  }
  out.sort((a, b) => a.d2 - b.d2);
  return out;
}

// --- street lamps -----------------------------------------------------------

/**
 * Metres between consecutive lamps, by road class. Zero means this class is
 * not lit as a carriageway.
 *
 * THE SHADER'S COPY OF THIS ARRAY IS GENERATED FROM IT; see LAMP_GLSL. Do not
 * write these numbers anywhere else.
 *
 * Real spacing is roughly three to four times the mounting height, which is why
 * the two tables track each other: a 10 m column on a trunk road lights 60 m of
 * it and a 5 m column on a residential street lights 34.
 */
export const LAMP_SPACING_M: number[] = [
  62, // motorway
  58, // trunk
  52, // primary
  46, // secondary
  40, // tertiary
  34, // residential
  34, // unclassified
  44, // service
  28, // living_street
  46, // busway
  0,  // pedestrian
  0,  // footway
  0,  // cycleway
  0,  // track
];

/**
 * Mounting height of the lantern above the footway, by class, in metres.
 *
 * A main road is lit from 8-10 m and a residential street from about 5. The
 * difference is one of the loudest scale cues a street has: a residential
 * street lit from 10 m reads as an industrial estate.
 */
export const LAMP_HEIGHT_M: number[] = [
  10.0, // motorway
  10.0, // trunk
  9.5,  // primary
  8.5,  // secondary
  7.5,  // tertiary
  5.5,  // residential
  5.5,  // unclassified
  5.0,  // service
  5.0,  // living_street
  8.0,  // busway
  0, 0, 0, 0,
];

/**
 * Where the pool sits across the carriageway, as the ribbon's own v.
 *
 * v runs 0..1 kerb to kerb (see data/ribbon.ts), so 0.06 is just inside the
 * nearside edge and 0.94 is just inside the far one. Lamps alternate between
 * them, which is what a real street does and what stops the lit side of a road
 * being a continuous strip.
 */
export const LAMP_POOL_V = 0.06;

/** How far outside the kerb line the column stands, in metres. On the footway,
 *  clear of the channel, close enough that the arm can reach the carriageway. */
export const LAMP_SETBACK_M = 0.75;

/** Radius of the column, in metres. A real steel column is 100-140 mm. */
export const LAMP_COLUMN_RADIUS_M = 0.075;

/**
 * The shader's half of the placement, generated from the table above.
 *
 * A const array with a dynamic index is legal in GLSL ES 3.00 for everything
 * except samplers, so the class code the ribbon already carries can index it
 * directly. `cls` arrives as a float that was an integer, hence the rounding
 * bias and the clamp: a garbage class must return 0 (unlit) rather than read
 * off the end of the array.
 */
export const LAMP_GLSL = /* glsl */ `
const float LAMP_SPACING[14] = float[14](${LAMP_SPACING_M.map((v) => v.toFixed(1)).join(", ")});
const float LAMP_POOL_V = ${LAMP_POOL_V.toFixed(4)};

float lampSpacingM(float cls) {
  int i = int(clamp(cls + 0.5, 0.0, 13.0));
  return LAMP_SPACING[i];
}
`;

/** True when this way is lit by columns of its own. */
export function hasStreetLamps(r: Road): boolean {
  if ((r.flags & ROAD_TUNNEL) !== 0) return false;
  return (LAMP_SPACING_M[r.cls] ?? 0) > 0;
}

/** One placed column. `x, y, z` is the base of the column on the footway. */
export interface LampInstance {
  x: number;
  y: number;
  z: number;
  /** Rotation about +y that points the instance's local +x along the arm, i.e.
   *  from the column toward the carriageway. See render/instanced.ts. */
  yaw: number;
  /** Mounting height of the lantern above the base. */
  heightM: number;
  /** Horizontal reach of the arm, base to lantern. */
  armM: number;
  cls: RoadClass;
  /** Metres along its road's centreline. The pool the road shader paints for
   *  this lamp is centred at exactly this u; that is the whole contract. */
  u: number;
  /** Index into the road array this was placed from. */
  road: number;
  /** Which side of the centreline: +1 is the v=0 side, -1 the v=1 side. */
  side: number;
  /** True when a surveyed OSM node was close enough to move this lamp onto it.
   *  The measured/invented split, per object. */
  measured: boolean;
}

/**
 * How far a surveyed lamp node may be from where this file would have put a
 * lamp, and still be taken as the same lamp, in metres.
 *
 * This is the whole of how measured data gets used, and the bound is what keeps
 * it honest. The pool on the carriageway is a per-fragment function of the
 * ribbon parameters and cannot be moved to an arbitrary point, so a lamp that
 * jumps to a surveyed position drags its post AWAY from the light it casts.
 * Three metres is comfortably inside the ~5 m pool the road shader paints, so
 * the post still stands in its own light; at ten it would not, and at zero the
 * survey would be worth nothing.
 */
export const LAMP_SNAP_M = 3.0;

/** What placement needs to know about the world it is placing into. */
export interface StreetWorld {
  /** Terrain height, so a column stands on the ground rather than at y=0. */
  groundY(x: number, z: number): number;
  /** True where a building stands. A lamp inside a front room is the single
   *  placement failure a viewer spots immediately. Null means no pack. */
  occupied: ((x: number, z: number) => boolean) | null;
  /**
   * True where a carriageway OTHER than `exceptRoad` runs.
   *
   * Keeps a column and a parked car out of the middle of the crossroads their
   * own way passes through. The exclusion is not optional: a parked car is on
   * its own carriageway by definition, so a test that could not ignore its own
   * road would suppress every one of them. Null means do not test.
   */
  onCarriageway: ((x: number, z: number, exceptRoad: number) => boolean) | null;
  /** The nearest surveyed street lamp within `maxM`, or null. Null for the
   *  whole callback means this city has no .street pack. */
  nearestMeasuredLamp: ((x: number, z: number, maxM: number) => Point | null) | null;
}

export interface Point {
  x: number;
  z: number;
}

/**
 * A uniform grid over surveyed points, so "is there a real lamp near here" is
 * a 3x3 cell scan rather than a walk over several thousand nodes per candidate.
 *
 * The cell IS the query radius, which is what makes the 3x3 scan complete: a
 * point within the radius of the query is in one of those nine cells by
 * construction. The same trick RoadIndex uses, without the segment padding.
 */
export class PointIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly cellM: number;

  constructor(points: readonly Point[], cellM: number) {
    this.cellM = Math.max(1e-3, cellM);
    this.px = new Float32Array(points.length);
    this.pz = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) {
      this.px[i] = points[i].x;
      this.pz[i] = points[i].z;
      const k = this.key(Math.floor(points[i].x / this.cellM), Math.floor(points[i].z / this.cellM));
      const b = this.cells.get(k);
      if (b) b.push(i);
      else this.cells.set(k, [i]);
    }
  }

  private key(cx: number, cz: number): number {
    return (cx * 73856093) ^ (cz * 19349663);
  }

  /** The nearest point within `maxM`, or null. `maxM` above the cell pitch is
   *  clamped, or the 3x3 scan would silently miss candidates. */
  nearest(x: number, z: number, maxM: number): Point | null {
    const r = Math.min(maxM, this.cellM);
    const cx = Math.floor(x / this.cellM);
    const cz = Math.floor(z / this.cellM);
    let best = -1;
    let bestD = r * r;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.cells.get(this.key(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const i of bucket) {
          const ex = this.px[i] - x;
          const ez = this.pz[i] - z;
          const d = ex * ex + ez * ez;
          if (d < bestD || (d === bestD && best >= 0 && i < best)) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best < 0 ? null : { x: this.px[best], z: this.pz[best] };
  }
}

/** Running arc length at every vertex of a way, in metres. */
function arcLengths(pts: Float32Array): Float64Array {
  const n = pts.length / 2;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  }
  return arc;
}

/** Point and unit tangent at arc length `u` along a polyline. */
interface Station {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
}

function stationAt(pts: Float32Array, arc: Float64Array, u: number): Station | null {
  const n = arc.length;
  if (n < 2) return null;
  let i = 1;
  while (i < n - 1 && arc[i] < u) i++;
  const segLen = arc[i] - arc[i - 1];
  if (!(segLen > 0)) return null;
  const t = Math.min(1, Math.max(0, (u - arc[i - 1]) / segLen));
  const ax = pts[i * 2 - 2];
  const az = pts[i * 2 - 1];
  const bx = pts[i * 2];
  const bz = pts[i * 2 + 1];
  return {
    x: ax + (bx - ax) * t,
    z: az + (bz - az) * t,
    dirX: (bx - ax) / segLen,
    dirZ: (bz - az) / segLen,
  };
}

/**
 * Place the columns for one way.
 *
 * The k-th lamp sits at u = (k + 0.5) * spacing, which is where the road shader
 * centres its k-th pool: the shader takes `idx = floor(u / spacing)` and the
 * pool centre is where `fract(u / spacing)` is 0.5. Sides alternate on the
 * parity of k, exactly as the shader does. Nothing here is free to drift.
 */
export function addLamps(
  out: LampInstance[],
  r: Road,
  roadIndex: number,
  world: StreetWorld,
): number {
  if (!hasStreetLamps(r)) return 0;
  const spacing = LAMP_SPACING_M[r.cls];
  const height = LAMP_HEIGHT_M[r.cls];
  if (!(spacing > 0) || !(height > 0)) return 0;

  const arc = arcLengths(r.pts);
  const total = arc[arc.length - 1];
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  // |1 - 2v| is how far off the centreline the pool centre is, in half widths.
  const poolReach = half * Math.abs(1 - 2 * LAMP_POOL_V);
  const baseReach = half + LAMP_SETBACK_M;
  const armM = baseReach - poolReach;

  let placed = 0;
  for (let k = 0; ; k++) {
    const u = (k + 0.5) * spacing;
    if (u > total) break;
    const st = stationAt(r.pts, arc, u);
    if (!st) break;
    // The ribbon's v=0 side is +(dirZ, -dirX); see addRibbon.
    const nx = st.dirZ;
    const nz = -st.dirX;
    const side = k % 2 === 0 ? 1 : -1;
    const bx = st.x + nx * baseReach * side;
    const bz = st.z + nz * baseReach * side;
    if (world.occupied && world.occupied(bx, bz)) continue;
    if (world.onCarriageway && world.onCarriageway(bx, bz, roadIndex)) continue;
    // Where a surveyor put a lamp within LAMP_SNAP_M of this one, use theirs.
    // Bounded on purpose: see the constant.
    const survey = world.nearestMeasuredLamp
      ? world.nearestMeasuredLamp(bx, bz, LAMP_SNAP_M)
      : null;
    const cx = survey ? survey.x : bx;
    const cz2 = survey ? survey.z : bz;
    // The arm points inward, against the side the column stands on.
    const ax = -nx * side;
    const az = -nz * side;
    out.push({
      x: cx,
      y: world.groundY(cx, cz2) + roadLiftM(r.flags, r.layer) + KERB_HEIGHT_M,
      z: cz2,
      // instanceToWorld maps local +x to (cos yaw, -sin yaw); see instanced.ts.
      yaw: Math.atan2(-az, ax),
      heightM: height,
      armM,
      cls: r.cls,
      u,
      road: roadIndex,
      side,
      measured: survey !== null,
    });
    placed++;
  }
  return placed;
}

// --- straight runs ----------------------------------------------------------

/**
 * A stretch of a way straight enough for a car to drive it as one line.
 *
 * WHY RUNS AND NOT SEGMENTS OR EDGES. The motion lives in the vertex shader as
 * a route parameter against a time uniform, so an instance can carry a START
 * and an END and nothing in between; a curve would need a texture lookup per
 * vertex to interpolate. Driving raw OSM segments instead would work and would
 * look wrong, because a digitised straight avenue is thirty segments of forty
 * metres and every car would fade out and back in twice a second.
 *
 * So consecutive segments are merged while the polyline stays inside a corridor
 * about the chord. That corridor is the reason this is gate-able: the car
 * drives the CHORD and the carriageway follows the CENTRELINE, so the merge is
 * exactly the thing that can put a car through a kerb.
 */
export interface StraightRun {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  lengthM: number;
  /** Unit direction from (x0,z0) to (x1,z1). */
  dirX: number;
  dirZ: number;
}

/** Runs shorter than this carry no traffic worth drawing. */
export const RUN_MIN_LENGTH_M = 22;

/**
 * Widest corridor a run may cut off its own centreline, in metres.
 *
 * A ceiling, not the operating value: `runsFor` passes the smaller of this and
 * whatever the carriageway can actually spare once the car's own width and the
 * lane offset are taken out, so a narrow street gets a tighter merge than a
 * boulevard rather than the same one.
 */
export const RUN_MAX_DEVIATION_M = 0.8;

/** Clearance kept between a car's flank and the kerb, in metres. */
export const CARRIAGEWAY_MARGIN_M = 0.10;

/** Half the width of every car archetype, in metres. A real car is 1.8 wide. */
export const CAR_HALF_WIDTH_M = 0.9;

/** Perpendicular distance from point p to the infinite line through a, b. */
function deviation(
  ax: number, az: number, dx: number, dz: number, px: number, pz: number,
): number {
  return Math.abs((px - ax) * dz - (pz - az) * dx);
}

/**
 * Split a centreline into straight runs, none deviating from its own polyline
 * by more than `maxDeviationM`.
 *
 * Greedy and forward-only: extend the current run one vertex at a time, and
 * whenever the extension would push ANY vertex already in the run outside the
 * corridor about the NEW chord, close the run at the previous vertex and start
 * again from it. Re-testing the whole run rather than only the new vertex is
 * what makes the corridor a real bound: a gentle curve passes every incremental
 * test and ends up a long way off its own chord.
 */
export function straightRuns(
  pts: Float32Array,
  maxDeviationM: number,
  minLengthM = RUN_MIN_LENGTH_M,
): StraightRun[] {
  const out: StraightRun[] = [];
  const n = pts.length / 2;
  if (n < 2 || !(maxDeviationM >= 0)) return out;

  let start = 0;
  let end = 1;
  const close = (a: number, b: number): void => {
    const x0 = pts[a * 2];
    const z0 = pts[a * 2 + 1];
    const x1 = pts[b * 2];
    const z1 = pts[b * 2 + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len >= minLengthM) {
      out.push({ x0, z0, x1, z1, lengthM: len, dirX: (x1 - x0) / len, dirZ: (z1 - z0) / len });
    }
  };

  while (end < n) {
    const candidate = end + 1;
    if (candidate >= n) break;
    const x0 = pts[start * 2];
    const z0 = pts[start * 2 + 1];
    const cx = pts[candidate * 2];
    const cz = pts[candidate * 2 + 1];
    const len = Math.hypot(cx - x0, cz - z0);
    let ok = len > 1e-6;
    if (ok) {
      const dx = (cx - x0) / len;
      const dz = (cz - z0) / len;
      for (let i = start + 1; i <= end; i++) {
        if (deviation(x0, z0, dx, dz, pts[i * 2], pts[i * 2 + 1]) > maxDeviationM) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      end = candidate;
    } else {
      close(start, end);
      start = end;
      end = start + 1;
    }
  }
  close(start, end);
  return out;
}

// --- lanes ------------------------------------------------------------------

/**
 * Half the running surface, in metres: what is left of the carriageway once the
 * kerbside parking has been taken out of both sides.
 */
export function runningHalfWidthM(r: Road): number {
  return Math.max(0, roadWidthM(r.cls, r.lanes, r.flags) * 0.5 - parkingStripM(r));
}

/**
 * Narrowest carriageway that carries moving traffic, as a half width.
 *
 * A single-track service road is 3.5 m kerb to kerb, and a 1.8 m car in the
 * middle of it has 850 mm each side. That is a real alley and a real car and
 * drawing it would be defensible; the reason it is excluded is that the run
 * corridor then has nothing left to spend, so every service road would carry
 * traffic pinned to a corridor of a few centimetres and most of them would
 * produce no runs at all.
 */
export const TRAFFIC_MIN_HALF_WIDTH_M = 2.6;

/**
 * Where the traffic lanes are, in metres from the centreline, nearest kerb
 * first, for ONE direction of travel.
 *
 * Lanes are spread evenly across the running half width rather than laid out at
 * a fixed 3.5 m pitch, because the width table's `lanes` is a total for both
 * directions and dividing it up twice would leave gaps down the middle of every
 * road that has an odd number.
 *
 * Every offset is clamped so the car's flank stays inside the RUNNING surface,
 * not merely inside the carriageway. That distinction is the whole of "a parked
 * car is never in a traffic lane": on a 7 m residential street with 2 m of
 * parking each side there are three metres left, and a lane centred in half of
 * that puts a 1.8 m car five centimetres into the row of parked cars. Measured,
 * and caught by the gate rather than by reading. The clamp is what makes both
 * invariants true by construction, which is why the gate measures the RESULT of
 * driving rather than re-deriving this formula.
 */
export function trafficLaneOffsetsM(r: Road): number[] {
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  if (half < TRAFFIC_MIN_HALF_WIDTH_M) return [];
  const running = runningHalfWidthM(r);
  if (!(running > 0)) return [];
  const n = Math.max(1, Math.floor(running / LANE_WIDTH_M));
  const limit = running - CAR_HALF_WIDTH_M - CARRIAGEWAY_MARGIN_M;
  if (!(limit > 0)) return [];
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    out.push(Math.min(limit, (running * (2 * (n - 1 - k) + 1)) / (2 * n)));
  }
  return out;
}

/** Corridor a run may cut off its centreline on this road, in metres. */
export function runDeviationM(r: Road): number {
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  const lanes = trafficLaneOffsetsM(r);
  if (!lanes.length) return 0;
  const worst = Math.max(...lanes.map(Math.abs));
  return Math.max(0, Math.min(RUN_MAX_DEVIATION_M, half - worst - CAR_HALF_WIDTH_M - CARRIAGEWAY_MARGIN_M));
}

/** The straight runs of one way, at that way's own corridor. */
export function runsFor(r: Road): StraightRun[] {
  const dev = runDeviationM(r);
  if (!(dev > 0)) return [];
  return straightRuns(r.pts, dev);
}

// --- moving traffic ---------------------------------------------------------

/**
 * Cars per kilometre per lane, by class, at the busiest hour this renderer
 * draws.
 *
 * Monotone by class on purpose, and gated to stay that way: an arterial that
 * carries the same traffic as the alley behind it is the thing that reads as a
 * particle system rather than as a city.
 *
 * The absolute figures are free-flow at a two-second headway, which is what
 * makes an avenue read as busy without reading as a jam: 34 per kilometre per
 * lane is a car every 29 m, and at 15 m/s that is two seconds apart. They were
 * half this at first and the measurement that moved them was a screenshot:
 * looking down 250 m of Van Ness from 120 m up, half a dozen cars reads as a
 * street with some traffic on it rather than as a street.
 */
export const TRAFFIC_PER_KM_LANE: number[] = [
  42, // motorway
  38, // trunk
  34, // primary
  28, // secondary
  22, // tertiary
  14, // residential
  14, // unclassified
  5,  // service
  8,  // living_street
  12, // busway
  0,  // pedestrian
  0,  // footway
  0,  // cycleway
  0,  // track
];

/** Metres per second, by class. Not a speed limit: what traffic does. */
export const TRAFFIC_SPEED_MS: number[] = [
  28, // motorway
  26, // trunk
  15, // primary
  13, // secondary
  11, // tertiary
  8,  // residential
  8,  // unclassified
  5,  // service
  4,  // living_street
  10, // busway
  0, 0, 0, 0,
];

/** One car on the road, as the instance buffer wants it. */
export interface TrafficInstance {
  /** Ends of the run it drives, and the lane offset already applied. */
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  /** Where along the run it starts, 0..1. */
  phase: number;
  /** Metres per second along the run. */
  speedMs: number;
  /** Body archetype and colour seed, both 0..1. */
  archetype: number;
  tint: number;
  /**
   * Which cars are on the road first, 0..1.
   *
   * The field is placed once at the busiest hour and thinned by a uniform (see
   * data/trafficmodel.ts), so every car needs a stable place in the queue: the
   * shader keeps the ones whose rank is below the hour's fraction. It has to be
   * INDEPENDENT of everything else the instance carries. Ranking by `phase`
   * would empty the start of every run and leave the tail full, which is a
   * street with a gap in it rather than a quiet street; ranking by `tint` would
   * take all the red cars off the road first. Hence its own hash multiplier,
   * and a gate in test/trafficmodel.check.ts that measures the correlation.
   */
  rank: number;
  cls: RoadClass;
  road: number;
}

/**
 * A deterministic hash, so the same street has the same traffic on it every
 * time the ring is rebuilt around a camera that came back.
 *
 * A field that re-randomised on every rebuild would pop a whole block of cars
 * to new places every time the camera crossed a tile boundary, which is far
 * more visible than any amount of repetition.
 */
export function hash1(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Populate one way with moving traffic.
 *
 * Direction: a one-way is driven in the way's own vertex order and in no other,
 * which needs no flag test downstream because the reverse direction is simply
 * never emitted. The baker already reversed the geometry of an `oneway=-1`, so
 * vertex order IS the direction of travel; see osmroads.ts.
 */
export function addTraffic(
  out: TrafficInstance[],
  r: Road,
  roadIndex: number,
  world: StreetWorld,
  densityScale = 1,
): number {
  if ((r.flags & ROAD_TUNNEL) !== 0) return 0;
  if (r.cls >= RoadClass.Pedestrian) return 0;
  const perKm = (TRAFFIC_PER_KM_LANE[r.cls] ?? 0) * densityScale;
  const speed = TRAFFIC_SPEED_MS[r.cls] ?? 0;
  if (!(perKm > 0) || !(speed > 0)) return 0;
  const lanes = trafficLaneOffsetsM(r);
  if (!lanes.length) return 0;

  // THE CARRIAGEWAY IS NOT THE TERRAIN. render/roads.ts draws the deck at
  // roadLiftM above the ground under it, so a vehicle placed at groundY sits
  // 0.35 m BELOW the tarmac it is supposed to be standing on -- and a road
  // wheel is 0.33 m in radius, which is why every car in every city was buried
  // to its axles and looked like it was wading. One constant, two readers.
  const lift = roadLiftM(r.flags, r.layer);

  const oneway = (r.flags & ROAD_ONEWAY) !== 0;
  const runs = runsFor(r);
  let placed = 0;
  let seed = roadIndex * 7919 + 13;

  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri];
    // The ribbon's v=0 side; the same normal the lamps use.
    const nx = run.dirZ;
    const nz = -run.dirX;
    for (let dir = 0; dir < (oneway ? 1 : 2); dir++) {
      // Right-hand traffic: travelling in the way's own direction puts the car
      // on the v=1 side of the centreline, and travelling against it puts the
      // car on the v=0 side. Both are the driver's right, which is the only
      // convention any city with a .roads pack uses; the same statement that
      // roadgraph.ts's laneOffsetM makes about the player's car.
      const forward = dir === 0;
      const sideSign = forward ? -1 : 1;
      for (let li = 0; li < lanes.length; li++) {
        const offset = lanes[li] * sideSign;
        const ox = nx * offset;
        const oz = nz * offset;
        const ax = (forward ? run.x0 : run.x1) + ox;
        const az = (forward ? run.z0 : run.z1) + oz;
        const bx = (forward ? run.x1 : run.x0) + ox;
        const bz = (forward ? run.z1 : run.z0) + oz;
        // Cars on this lane of this run, from its length and the class density.
        const want = (run.lengthM / 1000) * perKm;
        // The fractional part becomes a probability rather than a rounding, or
        // every residential street in the city would carry exactly zero cars.
        seed = seed + 1;
        const n = Math.floor(want) + (hash1(seed * 1.7) < want - Math.floor(want) ? 1 : 0);
        for (let c = 0; c < n; c++) {
          seed = seed + 1;
          const h = hash1(seed * 3.1);
          out.push({
            x0: ax,
            y0: world.groundY(ax, az) + lift,
            z0: az,
            x1: bx,
            y1: world.groundY(bx, bz) + lift,
            z1: bz,
            // Spread evenly and then jittered, so a lane is a stream with gaps
            // in it rather than a comb.
            phase: (c + 0.35 * h) / Math.max(1, n),
            speedMs: speed * (0.82 + 0.36 * hash1(seed * 5.3)),
            archetype: hash1(seed * 9.7),
            tint: hash1(seed * 11.3),
            rank: hash1(seed * 13.9),
            cls: r.cls,
            road: roadIndex,
          });
          placed++;
        }
      }
    }
  }
  return placed;
}

// --- parked cars ------------------------------------------------------------

/** Metres of kerb one parked car occupies, bumper to bumper. */
export const PARKING_BAY_M = 6.4;

/**
 * Share of the bays that have a car in them.
 *
 * Not 1. A solid unbroken row of cars down both sides reads as a wall, and the
 * gaps are where a street shows its kerb, its gullies and its crossings.
 */
export const PARKING_OCCUPANCY = 0.62;

export interface ParkedInstance {
  x: number;
  y: number;
  z: number;
  /** Heading as TURNS about +y (yaw / 2pi), which is the form the instance
   *  buffer wants: a parked car has no run to take a direction from, so the
   *  vertex shader reads its heading out of the phase slot. */
  yawTurns: number;
  archetype: number;
  tint: number;
  cls: RoadClass;
  road: number;
  /** Perpendicular distance from the centreline, for the gate. */
  offsetM: number;
}

/**
 * Fill the kerbside bays of one way.
 *
 * Bays are laid out along the centreline at a fixed pitch from the way's start,
 * which is what makes a rebuild reproduce the same row: the k-th bay of a way
 * is at the same u for ever, and whether it is occupied is a hash of (way, k).
 */
export function addParked(
  out: ParkedInstance[],
  r: Road,
  roadIndex: number,
  world: StreetWorld,
  occupancy = PARKING_OCCUPANCY,
): number {
  if ((r.flags & ROAD_TUNNEL) !== 0) return 0;
  const strip = parkingStripM(r);
  if (!(strip > 0)) return 0;
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  // The middle of the parking strip, which runs from the kerb inward.
  const offset = half - strip * 0.5;

  // See addTraffic: the deck is lifted off the terrain and a car stands on
  // the deck.
  const lift = roadLiftM(r.flags, r.layer);

  const arc = arcLengths(r.pts);
  const total = arc[arc.length - 1];
  let placed = 0;
  for (let k = 0; ; k++) {
    const u = (k + 0.5) * PARKING_BAY_M;
    if (u > total) break;
    const st = stationAt(r.pts, arc, u);
    if (!st) break;
    const nx = st.dirZ;
    const nz = -st.dirX;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      const seed = roadIndex * 131071 + k * 2 + s;
      if (hash1(seed * 1.13 + 0.7) > occupancy) continue;
      const px = st.x + nx * offset * side;
      const pz = st.z + nz * offset * side;
      if (world.occupied && world.occupied(px, pz)) continue;
      if (world.onCarriageway && world.onCarriageway(px, pz, roadIndex)) continue;
      // Facing along the kerb. A parked car points with the traffic on its own
      // side, which on the right is the way's direction on the v=1 side and
      // against it on the v=0 side.
      const along = side === 1 ? -1 : 1;
      const ax = st.dirX * along;
      const az = st.dirZ * along;
      out.push({
        x: px,
        y: world.groundY(px, pz) + lift,
        z: pz,
        yawTurns: Math.atan2(-az, ax) / (Math.PI * 2),
        archetype: hash1(seed * 7.7),
        tint: hash1(seed * 3.9),
        cls: r.cls,
        road: roadIndex,
        offsetM: offset,
      });
      placed++;
    }
  }
  return placed;
}
