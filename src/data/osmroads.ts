// OpenStreetMap ways to road centrelines. The one copy.
//
// The counterpart of osmbuildings.ts: everything tools/bake-roads.ts did that
// was not Bun, the disk cache or the command line. Classify a highway tag,
// project a polyline, clip it to the scene circle, split it so its offsets fit
// an i16, quantise it. Both the offline bake and the runtime path come through
// here, so a live road and a baked road are the same road.
//
// PURE: no fetch, no cache, no DOM, no Bun.

import { Origin } from "../geo";
import { bboxFilter, Skips, truthy, type OsmBbox, type OsmElement, type OsmPt } from "./osm";
import {
  LAYER_MAX,
  LAYER_MIN,
  MAX_OFFSET_M,
  ROAD_BRIDGE,
  ROAD_LINK,
  ROAD_ONEWAY,
  ROAD_TUNNEL,
  RoadClass,
  SurfaceKind,
  type PackedWay,
} from "./roadpack";

// --- tunables ---------------------------------------------------------------

/** Metres per vertex-offset unit. Must match VERT_SCALE in roadpack.ts. */
export const QUANT = 0.25;
/** The u16 vertex count in the record. */
export const MAX_VERTS = 65535;
export const MAX_LANES = 15;

/**
 * Split threshold for the greedy splitter, as a bounding-box extent. A piece
 * stores its vertices as i16 quarter-metre offsets from the piece's bbox
 * CENTRE, so an extent of E metres puts every offset within E/2. Leaving 50 m
 * of headroom under 2 * MAX_OFFSET_M keeps rounding from ever reaching the i16
 * limit.
 */
export const SPLIT_EXTENT_M = 2 * MAX_OFFSET_M - 100;

// --- tag interpretation -----------------------------------------------------

/** `highway` value -> class. `*_link` is handled separately, as its parent. */
const CLASS_BY_HIGHWAY: Record<string, RoadClass> = {
  motorway: RoadClass.Motorway,
  trunk: RoadClass.Trunk,
  primary: RoadClass.Primary,
  secondary: RoadClass.Secondary,
  tertiary: RoadClass.Tertiary,
  residential: RoadClass.Residential,
  unclassified: RoadClass.Unclassified,
  road: RoadClass.Unclassified, // "somebody drove this and did not classify it"
  service: RoadClass.Service,
  living_street: RoadClass.LivingStreet,
  busway: RoadClass.Busway,
  bus_guideway: RoadClass.Busway,
  pedestrian: RoadClass.Pedestrian,
  footway: RoadClass.Footway,
  // OSM's footway/path split is a mapper convention rather than a physical
  // difference: the same park trail is tagged either way depending on the
  // continent. Dropping `path` would lose most of the trails in the parks.
  path: RoadClass.Footway,
  corridor: RoadClass.Footway,
  cycleway: RoadClass.Cycleway,
  track: RoadClass.Track,
};

/** Tagged `highway=x` but not a centreline we want. Named rather than left to
 *  fall through so the skip report distinguishes "excluded on purpose" from
 *  "highway value this baker has never seen". */
export const EXCLUDED_HIGHWAY = new Set([
  "steps",
  "platform",
  "construction",
  "proposed",
  "raceway",
  "bridleway",
]);

const SURFACE_BY_TAG: Record<string, SurfaceKind> = {
  asphalt: SurfaceKind.Asphalt,
  chipseal: SurfaceKind.Asphalt,
  concrete: SurfaceKind.Concrete,
  "concrete:plates": SurfaceKind.Concrete,
  "concrete:lanes": SurfaceKind.Concrete,
  paved: SurfaceKind.Paved,
  paving_stones: SurfaceKind.Paved,
  metal: SurfaceKind.Paved,
  wood: SurfaceKind.Paved,
  bricks: SurfaceKind.Paved,
  sett: SurfaceKind.Cobblestone,
  cobblestone: SurfaceKind.Cobblestone,
  unhewn_cobblestone: SurfaceKind.Cobblestone,
  "cobblestone:flattened": SurfaceKind.Cobblestone,
  gravel: SurfaceKind.Gravel,
  fine_gravel: SurfaceKind.Gravel,
  compacted: SurfaceKind.Gravel,
  pebblestone: SurfaceKind.Gravel,
  ground: SurfaceKind.Dirt,
  dirt: SurfaceKind.Dirt,
  earth: SurfaceKind.Dirt,
  mud: SurfaceKind.Dirt,
  sand: SurfaceKind.Dirt,
  grass: SurfaceKind.Dirt,
  unpaved: SurfaceKind.Dirt,
};

export interface Classified {
  cls: RoadClass;
  link: boolean;
}

export function classify(tags: Record<string, string>): Classified | null {
  const h = (tags["highway"] ?? "").toLowerCase();
  if (h === "") return null;
  if (EXCLUDED_HIGHWAY.has(h)) return null;

  const direct = CLASS_BY_HIGHWAY[h];
  if (direct !== undefined) {
    // A `path` a cycle route is signed along is a cycleway in everything but
    // the tag, and it is drawn 2.5 m wide rather than 1.8 m.
    if (h === "path" && tags["bicycle"] === "designated") {
      return { cls: RoadClass.Cycleway, link: false };
    }
    return { cls: direct, link: false };
  }

  if (h.endsWith("_link")) {
    const parent = CLASS_BY_HIGHWAY[h.slice(0, -5)];
    if (parent !== undefined) return { cls: parent, link: true };
  }
  return null;
}

/** OSM `lanes` is free text: `2`, `2;3`, `1.5`, and occasionally nonsense like
 *  `many`. Anything that is not a plain small integer becomes 0, which means
 *  "untagged" and sends the renderer to the class default. */
export function parseLanes(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const m = /^\s*(\d+)/.exec(raw);
  if (!m) return 0;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_LANES, Math.round(v));
}

export function parseLayer(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const m = /^\s*(-?\d+)/.exec(raw);
  if (!m) return 0;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return 0;
  return Math.max(LAYER_MIN, Math.min(LAYER_MAX, Math.round(v)));
}

/** -1 means "one way, against the node order". Returned separately because the
 *  geometry gets reversed rather than the flag being lost: vertex order is then
 *  always the direction of travel, which is what a drivable graph needs. */
export function parseOneway(tags: Record<string, string>): { oneway: boolean; reversed: boolean } {
  const v = (tags["oneway"] ?? "").toLowerCase();
  if (v === "-1" || v === "reverse") return { oneway: true, reversed: true };
  if (v === "yes" || v === "true" || v === "1") return { oneway: true, reversed: false };
  // A roundabout is one way by definition and is very often not tagged as one.
  const j = (tags["junction"] ?? "").toLowerCase();
  if (j === "roundabout" || j === "circular") return { oneway: true, reversed: false };
  return { oneway: false, reversed: false };
}

// --- geometry ---------------------------------------------------------------

export interface Line {
  x: number[];
  z: number[];
}

/** Project and drop consecutive duplicates. Unlike a building ring this is an
 *  open polyline, so the first and last vertex are allowed to coincide (a
 *  closed loop road) as long as something happens in between. */
export function toLine(origin: Origin, pts: OsmPt[]): Line | null {
  const x: number[] = [];
  const z: number[] = [];
  for (const p of pts) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const w = origin.toWorld(p.lat, p.lon);
    const n = x.length;
    if (n > 0 && Math.abs(w.x - x[n - 1]) < 1e-6 && Math.abs(w.z - z[n - 1]) < 1e-6) continue;
    x.push(w.x);
    z.push(w.z);
  }
  if (x.length < 2) return null;
  return { x, z };
}

/**
 * Cut a polyline down to the parts inside the city circle, adding a vertex
 * exactly on the boundary where it crosses.
 *
 * Clipping rather than "keep the way if any vertex is inside": Overpass returns
 * a way whole whenever it touches the query box, so a motorway that clips the
 * corner of the box arrives with 20 km of geometry attached, most of it in the
 * next county. Trimming it here is what lets the verifier hold every vertex to
 * the pack radius, which is the check that catches a projection error.
 */
export function clipToRadius(line: Line, r: number): Line[] {
  const r2 = r * r;
  const out: Line[] = [];
  let cur: Line | null = null;

  const push = (l: Line, px: number, pz: number): void => {
    const n = l.x.length;
    if (n > 0 && Math.abs(px - l.x[n - 1]) < 1e-6 && Math.abs(pz - l.z[n - 1]) < 1e-6) return;
    l.x.push(px);
    l.z.push(pz);
  };
  const close = (): void => {
    if (cur !== null && cur.x.length >= 2) out.push(cur);
    cur = null;
  };

  for (let i = 0; i + 1 < line.x.length; i++) {
    const ax = line.x[i], az = line.z[i];
    const bx = line.x[i + 1], bz = line.z[i + 1];
    const ain = ax * ax + az * az <= r2;
    const bin = bx * bx + bz * bz <= r2;

    if (ain && bin) {
      if (cur === null) cur = { x: [ax], z: [az] };
      else push(cur, ax, az);
      push(cur, bx, bz);
      continue;
    }

    // |a + t(b-a)|^2 = r^2, for the t in [0, 1] where the segment meets the
    // circle. Both roots matter: a chord can enter and leave inside one segment.
    const dx = bx - ax, dz = bz - az;
    const qa = dx * dx + dz * dz;
    const qb = 2 * (ax * dx + az * dz);
    const qc = ax * ax + az * az - r2;
    const disc = qb * qb - 4 * qa * qc;
    if (qa === 0 || disc <= 0) {
      if (!ain) close();
      continue;
    }
    const sq = Math.sqrt(disc);
    const t1 = (-qb - sq) / (2 * qa);
    const t2 = (-qb + sq) / (2 * qa);
    const at = (t: number): [number, number] => [ax + t * dx, az + t * dz];

    if (ain && !bin) {
      const t = t1 >= 0 && t1 <= 1 ? t1 : t2;
      const [px, pz] = at(Math.min(1, Math.max(0, t)));
      if (cur === null) cur = { x: [ax], z: [az] };
      else push(cur, ax, az);
      push(cur, px, pz);
      close();
    } else if (!ain && bin) {
      const t = t2 >= 0 && t2 <= 1 ? t2 : t1;
      const [px, pz] = at(Math.min(1, Math.max(0, t)));
      close();
      cur = { x: [px], z: [pz] };
      push(cur, bx, bz);
    } else {
      close();
      if (t1 > 0 && t2 < 1) {
        const [p1x, p1z] = at(t1);
        const [p2x, p2z] = at(t2);
        const chord: Line = { x: [p1x], z: [p1z] };
        push(chord, p2x, p2z);
        if (chord.x.length >= 2) out.push(chord);
      }
    }
  }
  close();
  return out;
}

/**
 * Cut a polyline into pieces whose bounding box fits the i16 offset range,
 * duplicating the vertex they share so the pieces still join end to end.
 *
 * This is the case that looks fine until one city has a long road: a motorway
 * baked as a single OSM way can run 20 km, and clamping its far end to the i16
 * limit would fold it back over the city at 8 km out. Splitting is the only
 * option that neither loses the way nor lies about where it goes. Most cities
 * split nothing at all, which is exactly why it needs saying out loud here.
 */
export function splitToFit(line: Line): Line[] {
  const out: Line[] = [];
  let x: number[] = [];
  let z: number[] = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  const flush = (): void => {
    if (x.length >= 2) out.push({ x, z });
  };

  for (let i = 0; i < line.x.length; i++) {
    const px = line.x[i];
    const pz = line.z[i];
    const nMinX = Math.min(minX, px), nMaxX = Math.max(maxX, px);
    const nMinZ = Math.min(minZ, pz), nMaxZ = Math.max(maxZ, pz);
    const wouldOverflow =
      x.length > 0 &&
      (nMaxX - nMinX > SPLIT_EXTENT_M ||
        nMaxZ - nMinZ > SPLIT_EXTENT_M ||
        x.length >= MAX_VERTS);
    if (wouldOverflow) {
      flush();
      // The shared vertex is repeated so the two pieces meet rather than leave
      // a gap the width of one segment.
      const lastX = x[x.length - 1];
      const lastZ = z[z.length - 1];
      x = [lastX];
      z = [lastZ];
      minX = maxX = lastX;
      minZ = maxZ = lastZ;
    }
    x.push(px);
    z.push(pz);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
  }
  flush();
  return out;
}

// --- the query --------------------------------------------------------------

/**
 * Every road centreline in a box.
 *
 * Ways only: a road centreline is never a relation, and route relations
 * (US-101, bus routes) would just be the same ways over again under another
 * name. `out geom` returns the whole way, not the part inside the cell, so a
 * way straddling a cell edge is complete in both copies and the de-dupe by id
 * keeps one whole one.
 */
export function roadsStatements(b: OsmBbox): string {
  return `way["highway"](${bboxFilter(b)});`;
}

export function roadsQuery(b: OsmBbox, timeoutS = 120): string {
  return `[out:json][timeout:${timeoutS}];
${roadsStatements(b)}
out geom;`;
}

/** True for the elements roadsQuery asks for; see isBuildingElement. */
export function isRoadElement(el: OsmElement): boolean {
  return el.type === "way" && (el.tags ?? {})["highway"] !== undefined;
}

// --- the conversion ---------------------------------------------------------

export interface RoadConversion {
  ways: PackedWay[];
  skips: Skips;
  /** Extra pieces the splitter produced, for the bake report. */
  splits: number;
}

export function roadsFromOsm(
  elements: readonly OsmElement[],
  origin: Origin,
  radiusM: number,
): RoadConversion {
  const skips = new Skips();
  const ways: PackedWay[] = [];
  let splits = 0;

  for (const el of elements) {
    if (el.type !== "way") {
      skips.add(`unhandled element type ${el.type}`);
      continue;
    }
    const tags = el.tags ?? {};

    // An `area=yes` highway is a plaza or a car park drawn as a polygon. Its
    // "centreline" would be the outline of the square, which is not a road.
    if (truthy(tags["area"])) {
      skips.add("area=yes (a polygon, not a centreline)");
      continue;
    }

    const c = classify(tags);
    if (c === null) {
      const h = (tags["highway"] ?? "").toLowerCase();
      skips.add(
        EXCLUDED_HIGHWAY.has(h) ? `excluded highway=${h}` : `unmapped highway=${h || "(none)"}`,
      );
      continue;
    }

    if (!el.geometry || el.geometry.length === 0) {
      skips.add("way with no geometry");
      continue;
    }
    const line = toLine(origin, el.geometry);
    if (line === null) {
      skips.add("under 2 distinct vertices");
      continue;
    }

    const inside = clipToRadius(line, radiusM);
    if (inside.length === 0) {
      skips.add("entirely outside the city radius");
      continue;
    }

    const { oneway, reversed } = parseOneway(tags);
    if (reversed) {
      for (const piece of inside) {
        piece.x.reverse();
        piece.z.reverse();
      }
    }

    let flags = 0;
    if (oneway) flags |= ROAD_ONEWAY;
    if (truthy(tags["bridge"])) flags |= ROAD_BRIDGE;
    if (truthy(tags["tunnel"])) flags |= ROAD_TUNNEL;
    if (c.link) flags |= ROAD_LINK;

    const lanes = parseLanes(tags["lanes"]);
    const layer = parseLayer(tags["layer"]);
    const surface = SURFACE_BY_TAG[(tags["surface"] ?? "").toLowerCase()] ?? SurfaceKind.Unknown;

    const pieces: Line[] = [];
    for (const seg of inside) pieces.push(...splitToFit(seg));
    if (pieces.length > inside.length) splits += pieces.length - inside.length;

    for (const piece of pieces) {
      const n = piece.x.length;
      // The centroid is the bbox CENTRE and not the mean of the vertices: the
      // splitter bounds the bbox, so this is the point that provably keeps every
      // offset inside the i16 range. The mean of a lopsided polyline does not.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        if (piece.x[i] < minX) minX = piece.x[i];
        if (piece.x[i] > maxX) maxX = piece.x[i];
        if (piece.z[i] < minZ) minZ = piece.z[i];
        if (piece.z[i] > maxZ) maxZ = piece.z[i];
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;

      const dx = new Int16Array(n);
      const dz = new Int16Array(n);
      let overflow = false;
      for (let i = 0; i < n; i++) {
        const qx = Math.round((piece.x[i] - cx) / QUANT);
        const qz = Math.round((piece.z[i] - cz) / QUANT);
        if (Math.abs(qx) > 32767 || Math.abs(qz) > 32767) {
          overflow = true;
          break;
        }
        dx[i] = qx;
        dz[i] = qz;
      }
      if (overflow) {
        // Unreachable unless SPLIT_EXTENT_M and the i16 range disagree, which
        // is worth a loud count rather than a silent wrap to a negative offset.
        skips.add("BUG: offset overflows i16 after split");
        continue;
      }

      ways.push({ cls: c.cls, lanes, flags, layer, surface, cx, cz, dx, dz });
    }
  }

  return { ways, skips, splits };
}
