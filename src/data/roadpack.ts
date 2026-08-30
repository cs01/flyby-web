// Reader for the binary .roads packs produced by tools/bake-roads.ts.
//
// Why vector centrelines at all: close to the ground the satellite drape is the
// limiting detail. It is 0.47 m/px at its best, so a lane line is one texel and
// a road reads as a row of blurred pixels. A centreline plus a width is
// resolution-independent, so carriageways and markings stay crisp at any
// altitude, and the same graph is what ground vehicles will drive on later.
//
// Same shape as citypack.ts on purpose: little-endian, fields written back to
// back with no alignment padding, geometry as i16 quarter-metre offsets from a
// per-record f32 centroid. The format is defined once, here and in the baker,
// and the two must agree byte for byte.
//
// This file is deliberately PURE: no fetch, no cache, no DOM. The bake verifier
// runs it under Bun with no DOM lib at all, which is what lets the same parser
// the browser uses be the thing that gates a bake. A reader that only ran in a
// browser could not be the oracle for the writer.

export const ROAD_MAGIC = 0x524f4144; // "ROAD"

/** Quarter-metre fixed point for centreline vertices, relative to the centroid. */
const VERT_SCALE = 0.25;

/**
 * The i16 offsets reach +-32000 units, so +-8000 m about the centroid, exactly
 * as in .city. A city-length motorway easily exceeds that, and the baker must
 * SPLIT such a way into pieces (duplicating the shared vertex so they still
 * join) rather than clamp it. Clamping looks fine on every city until one has a
 * long straight road, and then a motorway folds back on itself at 8 km out.
 */
export const MAX_OFFSET_M = 8000;

export enum RoadClass {
  Motorway = 0,
  Trunk = 1,
  Primary = 2,
  Secondary = 3,
  Tertiary = 4,
  Residential = 5,
  Unclassified = 6,
  Service = 7,
  LivingStreet = 8,
  Busway = 9,
  Pedestrian = 10,
  Footway = 11,
  Cycleway = 12,
  Track = 13,
}

export enum SurfaceKind {
  Unknown = 0,
  Asphalt = 1,
  Concrete = 2,
  Paved = 3,
  Gravel = 4,
  Dirt = 5,
  Cobblestone = 6,
}

export const ROAD_CLASS_NAMES: string[] = [
  "motorway", "trunk", "primary", "secondary", "tertiary", "residential",
  "unclassified", "service", "living_street", "busway", "pedestrian",
  "footway", "cycleway", "track",
];

export const SURFACE_NAMES: string[] = [
  "unknown", "asphalt", "concrete", "paved", "gravel", "dirt", "cobblestone",
];

/** Every legal code, for the verifier. Derived from the name tables so a new
 *  class cannot be added to one and forgotten in the other. */
export const ROAD_CLASS_CODES: number[] = ROAD_CLASS_NAMES.map((_, i) => i);
export const SURFACE_CODES: number[] = SURFACE_NAMES.map((_, i) => i);

// --- flags ------------------------------------------------------------------

export const ROAD_ONEWAY = 1 << 0;
export const ROAD_BRIDGE = 1 << 1;
export const ROAD_TUNNEL = 1 << 2;
/** A `*_link` ramp, baked under its parent class. Ramps are one lane and want
 *  to be drawn narrower than the motorway they leave. */
export const ROAD_LINK = 1 << 3;

/** OSM `layer`, clamped to this range for bridge/tunnel stacking. */
export const LAYER_MIN = -5;
export const LAYER_MAX = 5;

// --- width ------------------------------------------------------------------

/**
 * Width lives HERE and nowhere else. The renderer draws the carriageway, the
 * baker decides what fits in the pack, and a future drivable graph will need
 * the same number: three places that must not be able to disagree about how
 * wide a road is.
 *
 * Measured against live Overpass on a 3.1 km slice of San Francisco, `lanes` is
 * tagged on only 15% of ways, so the default table is the common path and the
 * tag is the override. The defaults are deliberately conservative totals for
 * BOTH directions, not per carriageway.
 */
export const LANE_WIDTH_M = 3.5;

/** Lane count assumed when the way carries no `lanes` tag, by class. */
export const DEFAULT_LANES: number[] = [
  4, // motorway      two each way
  4, // trunk
  4, // primary       urban arterial
  2, // secondary
  2, // tertiary
  2, // residential
  2, // unclassified
  1, // service       alleys and parking aisles
  1, // living_street a single shared surface, not a marked carriageway
  2, // busway
  0, // pedestrian    not measured in lanes, see FIXED_WIDTH_M
  0, // footway
  0, // cycleway
  0, // track
];

/**
 * Classes that are not measured in lanes at all. A footway with `lanes=2` is a
 * mapper describing something other than a carriageway, so the tag is ignored
 * for these rather than multiplied by 3.5 m into a road.
 */
export const FIXED_WIDTH_M: (number | null)[] = [
  null, null, null, null, null, null, null, null, null, null,
  6.0, // pedestrian  a pedestrianised street, kerb to kerb
  1.8, // footway     a pavement
  2.5, // cycleway    a two-way cycle track
  3.0, // track       an unsurfaced farm/park track
];

/** A link ramp is one lane whatever its parent class says. */
const LINK_LANES = 1;

/**
 * Carriageway width in metres. `lanes` of 0 means the way carried no tag.
 * The one place that answers "how wide is this road".
 */
export function roadWidthM(cls: RoadClass, lanes: number, flags = 0): number {
  const fixed = FIXED_WIDTH_M[cls];
  if (fixed != null) return fixed;
  const n = lanes > 0 ? lanes : (flags & ROAD_LINK) !== 0 ? LINK_LANES : (DEFAULT_LANES[cls] ?? 2);
  return n * LANE_WIDTH_M;
}

// --- records ----------------------------------------------------------------

export interface Road {
  cls: RoadClass;
  /** 0 means untagged; use roadWidthM rather than reading this directly. */
  lanes: number;
  /** ROAD_ONEWAY | ROAD_BRIDGE | ROAD_TUNNEL | ROAD_LINK. */
  flags: number;
  layer: number;
  surface: SurfaceKind;
  cx: number;
  cz: number;
  /** Centreline vertices in local ENU metres, absolute (centroid already
   *  added), as x,z pairs. Always at least 2 vertices. */
  pts: Float32Array;
}

export interface RoadPack {
  lat0: number;
  lon0: number;
  radiusM: number;
  roads: Road[];
}

export function parseRoadPack(buf: ArrayBuffer): RoadPack {
  const dv = new DataView(buf);
  let o = 0;

  const magic = dv.getUint32(o, true); o += 4;
  if (magic !== ROAD_MAGIC) {
    throw new Error(`not a .roads pack (magic 0x${magic.toString(16)})`);
  }
  const version = dv.getUint32(o, true); o += 4;
  if (version !== 1) throw new Error(`unsupported .roads version ${version}`);

  const lat0 = dv.getFloat64(o, true); o += 8;
  const lon0 = dv.getFloat64(o, true); o += 8;
  const radiusM = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;

  const roads: Road[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const cls = dv.getUint8(o); o += 1;
    const lanes = dv.getUint8(o); o += 1;
    const flags = dv.getUint8(o); o += 1;
    const layer = dv.getInt8(o); o += 1;
    const surface = dv.getUint8(o); o += 1;
    o += 1; // reserved: padding that keeps the fixed part an even 16 bytes
    const n = dv.getUint16(o, true); o += 2;
    const cx = dv.getFloat32(o, true); o += 4;
    const cz = dv.getFloat32(o, true); o += 4;

    const pts = new Float32Array(n * 2);
    for (let v = 0; v < n; v++) {
      pts[v * 2] = cx + dv.getInt16(o, true) * VERT_SCALE; o += 2;
      pts[v * 2 + 1] = cz + dv.getInt16(o, true) * VERT_SCALE; o += 2;
    }
    roads[i] = { cls, lanes, flags, layer, surface, cx, cz, pts };
  }

  return { lat0, lon0, radiusM, roads };
}

/** Centreline length in metres. */
export function roadLengthM(r: Road): number {
  let sum = 0;
  for (let i = 2; i < r.pts.length; i += 2) {
    sum += Math.hypot(r.pts[i] - r.pts[i - 2], r.pts[i + 1] - r.pts[i - 1]);
  }
  return sum;
}
