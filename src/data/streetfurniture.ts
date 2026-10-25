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
  roadLiftM,
  roadWidthM,
  RoadClass,
  ROAD_BRIDGE,
  ROAD_TUNNEL,
  type Road,
} from "./roadpack";
import { KERB_HEIGHT_M } from "./pavement";
import { laneLayoutCached } from "./lanes";
import { deckYAt, type Deck } from "./bridgedeck";

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
  /**
   * The solved bridge deck of road `roadIndex`, or null where it has none.
   *
   * A bridge is NOT terrain plus a lift. data/bridgedeck.ts solves it abutment
   * to abutment, and render/roads.ts draws exactly that, so anything standing
   * on a bridge has to read the same answer or it stands on a different
   * surface: over the Bay Bridge the old groundY + roadLiftM put cars 27 m
   * above the drawn deck at the Yerba Buena end and under the bay in the
   * middle. Optional because a world with no bridges has nothing to say.
   */
  deckOf?: ((roadIndex: number) => Deck | null) | null;
}

/**
 * Height of the carriageway of road `r` at arc length `u` along it, where
 * (x, z) is that point.
 *
 * THE one answer for street furniture, and the same answer the ribbon draws:
 * the solved deck on a bridge, terrain plus the road lift everywhere else.
 */
export function carriagewayY(
  world: StreetWorld,
  r: Road,
  roadIndex: number,
  x: number,
  z: number,
  u: number,
): number {
  const deck = (r.flags & ROAD_BRIDGE) !== 0 && world.deckOf ? world.deckOf(roadIndex) : null;
  if (deck) return deckYAt(deck, u);
  return world.groundY(x, z) + roadLiftM(r.flags, r.layer);
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
      y: carriagewayY(world, r, roadIndex, cx, cz2, u) + KERB_HEIGHT_M,
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

/**
 * A deterministic hash, so the same street has the same cars on it every time
 * a ring is rebuilt around a camera that came back.
 *
 * A field that re-randomised on every rebuild would pop a whole block of cars
 * to new places every time the camera crossed a tile boundary, which is far
 * more visible than any amount of repetition.
 */
export function hash1(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
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
  /** Signed distance from the centreline, right of the way's vertex order,
   *  for the gate. */
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
  // Which kerbs have parking, and how wide, from the one lane layout: a narrow
  // two-way keeps its parking on one side only so two cars can pass.
  const lay = laneLayoutCached(r);
  if (!(lay.parkRightM > 0) && !(lay.parkLeftM > 0)) return 0;
  const half = lay.widthM * 0.5;

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
    // Right of the way's vertex order, the frame data/lanes.ts works in.
    const rx = -st.dirZ;
    const rz = st.dirX;
    for (let s = 0; s < 2; s++) {
      // s = 0 is the LEFT kerb and s = 1 the right, which keeps the seeds of
      // the cars that were already there where they were.
      const strip = s === 0 ? lay.parkLeftM : lay.parkRightM;
      if (!(strip > 0)) continue;
      const side = s === 0 ? 1 : -1;
      const seed = roadIndex * 131071 + k * 2 + s;
      if (hash1(seed * 1.13 + 0.7) > occupancy) continue;
      // The middle of the parking strip, which runs from the kerb inward.
      const offset = half - strip * 0.5;
      const px = st.x - rx * offset * side;
      const pz = st.z - rz * offset * side;
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
        offsetM: -offset * side,
      });
      placed++;
    }
  }
  return placed;
}
