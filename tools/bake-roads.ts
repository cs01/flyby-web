// Bakes OpenStreetMap road centrelines into a compact binary `.roads` pack the
// renderer streams at load time.
//
// Why vectors and not more pixels: the satellite drape bottoms out at 0.47 m/px,
// so from low altitude a road is a row of blurred texels and a lane line does
// not exist at all. A centreline plus a width is resolution-independent. The
// same data is also the drivable graph ground vehicles will need later, which is
// why the pack keeps oneway/bridge/tunnel/layer rather than just a ribbon.
//
//   bun tools/bake-roads.ts --city sf
//   bun tools/bake-roads.ts --all [--force]
//
// The projection comes from ../src/geo and the format from ../src/data/roadpack.
// Re-deriving either here would drift and put the roads beside the terrain
// instead of on it.

import { CITIES, cityById, type City } from "../src/cities";
import { Origin } from "../src/geo";
import {
  LAYER_MAX,
  LAYER_MIN,
  MAX_OFFSET_M,
  parseRoadPack,
  ROAD_BRIDGE,
  ROAD_CLASS_NAMES,
  ROAD_LINK,
  ROAD_ONEWAY,
  ROAD_TUNNEL,
  RoadClass,
  SurfaceKind,
} from "../src/data/roadpack";

// The repo's tsconfig deliberately carries no node/bun types (`types:
// ["vite/client"]`), so the two runtime globals this script needs are declared
// here rather than pulled in from @types/node. Module-scoped `declare const`
// resolves to the real global at runtime and keeps `tsc --noEmit` clean without
// widening the type surface of the app itself.
declare const process: {
  argv: string[];
  exit(code?: number): never;
  stdout: { write(s: string): void };
};
declare const Bun: {
  file(path: string): {
    readonly size: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    exists(): Promise<boolean>;
  };
  /** Creates missing parent directories. */
  write(dest: string, data: string | Uint8Array): Promise<number>;
};

/** Repo root, with a trailing slash. Derived from this file's own URL so the
 *  script works from any cwd. */
const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);

// --- tunables -------------------------------------------------------------

const CACHE_DIR = `${ROOT}tools/.cache`;
const CELL_TARGET_M = 2000; // one whole-city query gets shed by public instances
const QUANT = 0.25; // metres per vertex-offset unit, must match roadpack.ts
const MAX_VERTS = 65535; // the u16 vertex count in the record
const MAX_LANES = 15;
const POLITE_DELAY_MS = 1500;
const MAX_ATTEMPTS = 6; // spec floor is 4; the public instances need the slack
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Split threshold for the greedy splitter, as a bounding-box extent. A piece
 * stores its vertices as i16 quarter-metre offsets from the piece's bbox
 * CENTRE, so an extent of E metres puts every offset within E/2. Leaving 50 m
 * of headroom under 2 * MAX_OFFSET_M keeps rounding from ever reaching the i16
 * limit.
 */
const SPLIT_EXTENT_M = 2 * MAX_OFFSET_M - 100;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// --- OSM shapes -----------------------------------------------------------

interface OsmPt {
  lat: number;
  lon: number;
}

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmPt[];
}

interface OverpassResponse {
  elements?: OsmElement[];
}

// --- baked record ---------------------------------------------------------

interface Way {
  cls: RoadClass;
  lanes: number;
  flags: number;
  layer: number;
  surface: SurfaceKind;
  cx: number;
  cz: number;
  /** i16 units of QUANT metres, offsets from (cx, cz). */
  dx: Int16Array;
  dz: Int16Array;
}

// --- small helpers --------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class Skips {
  private readonly counts = new Map<string, number>();
  add(reason: string, n = 1): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + n);
  }
  total(): number {
    let t = 0;
    for (const v of this.counts.values()) t += v;
    return t;
  }
  entries(): [string, number][] {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
  }
}

// --- tag interpretation ---------------------------------------------------

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
const EXCLUDED_HIGHWAY = new Set([
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

interface Classified {
  cls: RoadClass;
  link: boolean;
}

function classify(tags: Record<string, string>): Classified | null {
  const h = (tags["highway"] ?? "").toLowerCase();
  if (h === "") return null;
  if (EXCLUDED_HIGHWAY.has(h)) return null;

  const direct = CLASS_BY_HIGHWAY[h];
  if (direct !== undefined) {
    // A `path` a cycle route is signed along is a cycleway in everything but
    // the tag, and it is drawn 2.5 m wide rather than 1.8 m.
    if (h === "path" && tags["bicycle"] === "designated") return { cls: RoadClass.Cycleway, link: false };
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
function parseLanes(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const m = /^\s*(\d+)/.exec(raw);
  if (!m) return 0;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_LANES, Math.round(v));
}

function parseLayer(raw: string | undefined): number {
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
function parseOneway(tags: Record<string, string>): { oneway: boolean; reversed: boolean } {
  const v = (tags["oneway"] ?? "").toLowerCase();
  if (v === "-1" || v === "reverse") return { oneway: true, reversed: true };
  if (v === "yes" || v === "true" || v === "1") return { oneway: true, reversed: false };
  // A roundabout is one way by definition and is very often not tagged as one.
  const j = (tags["junction"] ?? "").toLowerCase();
  if (j === "roundabout" || j === "circular") return { oneway: true, reversed: false };
  return { oneway: false, reversed: false };
}

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.toLowerCase();
  return s !== "" && s !== "no" && s !== "false" && s !== "0";
}

// --- Overpass -------------------------------------------------------------

interface Bbox {
  s: number;
  w: number;
  n: number;
  e: number;
}

function cellQuery(b: Bbox): string {
  const box = `${b.s.toFixed(7)},${b.w.toFixed(7)},${b.n.toFixed(7)},${b.e.toFixed(7)}`;
  // Ways only: a road centreline is never a relation, and route relations
  // (US-101, bus routes) would just be the same ways over again under another
  // name. `out geom` returns the whole way, not the part inside the cell, so a
  // way straddling a cell edge is complete in both copies and the de-dupe by id
  // keeps one whole one.
  return `[out:json][timeout:120];
way["highway"](${box});
out geom;`;
}

let lastRequestAt = 0;

async function politeGap(): Promise<void> {
  const wait = POLITE_DELAY_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
}

/**
 * Overpass answers 406 unless the body is form-encoded AND an Accept header is
 * present. Both halves have bitten this tool before; neither is optional.
 */
async function overpass(query: string): Promise<OverpassResponse> {
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    await politeGap();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "flyby-web bake-roads (https://github.com/cs01/flyby-web)",
        },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      lastRequestAt = Date.now();
      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text) as OverpassResponse;
        } catch {
          lastErr = `bad JSON from ${endpoint}: ${text.slice(0, 200)}`;
        }
      } else {
        lastErr = `${res.status} ${res.statusText} from ${endpoint}`;
        // 400 is a query bug and will not fix itself on another instance.
        if (res.status === 400) throw new Error(lastErr);
        await res.text().catch(() => "");
      }
    } catch (e) {
      lastRequestAt = Date.now();
      if (e instanceof Error && e.message.startsWith("400 ")) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
    const backoff = Math.min(60_000, 2000 * 2 ** attempt);
    process.stdout.write(`    retry in ${(backoff / 1000).toFixed(0)}s (${lastErr})\n`);
    await sleep(backoff);
  }
  throw new Error(`overpass failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
}

async function fetchCells(key: string, bbox: Bbox, force: boolean): Promise<OsmElement[]> {
  const spanLat = bbox.n - bbox.s;
  const spanLon = bbox.e - bbox.w;
  const origin = new Origin((bbox.n + bbox.s) / 2, (bbox.e + bbox.w) / 2);
  const widthM = spanLon * origin.mPerLon;
  const heightM = spanLat * origin.mPerLat;
  const nx = Math.max(1, Math.round(widthM / CELL_TARGET_M));
  const ny = Math.max(1, Math.round(heightM / CELL_TARGET_M));

  console.log(`  grid ${nx}x${ny} cells (~${(widthM / nx / 1000).toFixed(2)} km each)`);

  const byId = new Map<number, OsmElement>();
  const total = nx * ny;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const index = iy * nx + ix;
      const cell: Bbox = {
        s: bbox.s + (spanLat * iy) / ny,
        n: bbox.s + (spanLat * (iy + 1)) / ny,
        w: bbox.w + (spanLon * ix) / nx,
        e: bbox.w + (spanLon * (ix + 1)) / nx,
      };
      // Its own cache namespace: the building bake stores `<id>-<cell>.json`
      // for the same cells and a collision would silently feed buildings to
      // the road baker.
      const cachePath = `${CACHE_DIR}/${key}-${index}.json`;

      let body: OverpassResponse | null = null;
      if (!force) {
        try {
          body = JSON.parse(await Bun.file(cachePath).text()) as OverpassResponse;
        } catch {
          body = null;
        }
      }
      if (body === null) {
        process.stdout.write(`  cell ${index + 1}/${total} fetching...`);
        body = await overpass(cellQuery(cell));
        await Bun.write(cachePath, JSON.stringify(body));
        process.stdout.write(` ${(body.elements ?? []).length} elements\n`);
      } else {
        process.stdout.write(
          `  cell ${index + 1}/${total} cached ${(body.elements ?? []).length} elements\n`,
        );
      }

      for (const el of body.elements ?? []) {
        if (el.type === "way") byId.set(el.id, el);
      }
    }
  }
  return [...byId.values()];
}

// --- geometry -------------------------------------------------------------

interface Line {
  x: number[];
  z: number[];
}

/** Project and drop consecutive duplicates. Unlike a building ring this is an
 *  open polyline, so the first and last vertex are allowed to coincide (a
 *  closed loop road) as long as something happens in between. */
function toLine(origin: Origin, pts: OsmPt[]): Line | null {
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
function clipToRadius(line: Line, r: number): Line[] {
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
function splitToFit(line: Line): Line[] {
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

// --- bake -----------------------------------------------------------------

interface BakeResult {
  ways: Way[];
  skips: Skips;
  splits: number;
}

function bakeElements(elements: OsmElement[], origin: Origin, radius: number): BakeResult {
  const skips = new Skips();
  const ways: Way[] = [];
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
      skips.add(EXCLUDED_HIGHWAY.has(h) ? `excluded highway=${h}` : `unmapped highway=${h || "(none)"}`);
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

    const inside = clipToRadius(line, radius);
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

// --- serialise ------------------------------------------------------------

const MAGIC = 0x524f4144;
const VERSION = 1;
const HEADER_BYTES = 32;
const RECORD_BYTES = 16;

function encode(ways: Way[], lat0: number, lon0: number, radiusM: number): Uint8Array {
  let size = HEADER_BYTES;
  for (const w of ways) size += RECORD_BYTES + 4 * w.dx.length;

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, MAGIC, true); o += 4;
  dv.setUint32(o, VERSION, true); o += 4;
  dv.setFloat64(o, lat0, true); o += 8;
  dv.setFloat64(o, lon0, true); o += 8;
  dv.setFloat32(o, radiusM, true); o += 4;
  dv.setUint32(o, ways.length, true); o += 4;

  for (const w of ways) {
    dv.setUint8(o, w.cls); o += 1;
    dv.setUint8(o, w.lanes); o += 1;
    dv.setUint8(o, w.flags); o += 1;
    dv.setInt8(o, w.layer); o += 1;
    dv.setUint8(o, w.surface); o += 1;
    dv.setUint8(o, 0); o += 1; // reserved padding
    dv.setUint16(o, w.dx.length, true); o += 2;
    dv.setFloat32(o, w.cx, true); o += 4;
    dv.setFloat32(o, w.cz, true); o += 4;
    for (let i = 0; i < w.dx.length; i++) {
      dv.setInt16(o, w.dx[i], true); o += 2;
      dv.setInt16(o, w.dz[i], true); o += 2;
    }
  }
  return new Uint8Array(buf);
}

// --- report ---------------------------------------------------------------

function lengthKm(ways: Way[]): number {
  let m = 0;
  for (const w of ways) {
    for (let i = 1; i < w.dx.length; i++) {
      m += Math.hypot(w.dx[i] - w.dx[i - 1], w.dz[i] - w.dz[i - 1]) * QUANT;
    }
  }
  return m / 1000;
}

function histogram(ways: Way[]): [string, number][] {
  const counts = new Map<number, number>();
  for (const w of ways) counts.set(w.cls, (counts.get(w.cls) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => [ROAD_CLASS_NAMES[c] ?? `?${c}`, n] as [string, number]);
}

// --- driver ---------------------------------------------------------------

async function bake(city: City, force: boolean): Promise<boolean> {
  console.log(`\n=== ${city.id}  (${city.lat}, ${city.lon})  r=${city.radius} m ===`);
  const origin = new Origin(city.lat, city.lon);
  const dLat = city.radius / origin.mPerLat;
  const dLon = city.radius / origin.mPerLon;
  const bbox: Bbox = {
    s: city.lat - dLat,
    n: city.lat + dLat,
    w: city.lon - dLon,
    e: city.lon + dLon,
  };

  const elements = await fetchCells(`${city.id}-roads`, bbox, force);
  console.log(`  ${elements.length} unique OSM ways`);

  const { ways, skips, splits } = bakeElements(elements, origin, city.radius);
  const out = `${ROOT}public/cities/${city.id}.roads`;
  await Bun.write(out, encode(ways, city.lat, city.lon, city.radius));
  const onDiskSize = Bun.file(out).size;

  let verts = 0;
  for (const w of ways) verts += w.dx.length;

  console.log(`\n--- ${city.id} report ---`);
  console.log(`  ways        ${ways.length}  (${verts} vertices, ${splits} from splitting)`);
  console.log(`  length      ${lengthKm(ways).toFixed(1)} km of centreline`);
  console.log(`  skipped     ${skips.total()}`);
  for (const [reason, n] of skips.entries()) console.log(`      ${n.toString().padStart(7)}  ${reason}`);
  console.log("  classes:");
  for (const [name, n] of histogram(ways)) {
    console.log(`      ${n.toString().padStart(7)}  ${name}`);
  }
  console.log(`  file        ${out}  ${onDiskSize} bytes`);

  // Re-read with the app's parser. It is the only proof the writer laid the
  // fields out the way the format says, and it catches a truncated write here
  // rather than in the browser.
  const back = parseRoadPack(await Bun.file(out).arrayBuffer());
  const first = ways[0];
  const rtOk =
    back.roads.length === ways.length &&
    back.radiusM === Math.fround(city.radius) &&
    Math.abs(back.lat0 - city.lat) < 1e-12 &&
    Math.abs(back.lon0 - city.lon) < 1e-12 &&
    (first === undefined ||
      (back.roads[0].cls === first.cls &&
        back.roads[0].flags === first.flags &&
        back.roads[0].pts.length === first.dx.length * 2));
  console.log(`  ROUNDTRIP ${rtOk ? "OK" : "FAIL"}  (${back.roads.length} records re-read)`);
  return rtOk && ways.length > 0;
}

/** public/cities/roads-index.json: the ids that actually have a road pack.
 *  Generated, never hand-edited, and deliberately separate from index.json and
 *  land-index.json, each of which answers a different question. */
async function writeIndex(): Promise<void> {
  const dir = `${ROOT}public/cities/`;
  const { readdirSync } = await import("node:fs");
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".roads"))
    .map((f) => f.replace(/\.roads$/, ""))
    .sort();
  await Bun.write(`${dir}roads-index.json`, JSON.stringify(ids));
  console.log(`\nroads-index: ${ids.length} packs -> ${dir}roads-index.json`);
  console.log(ids.join(", "));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, "");
    }
  }

  const force = flags.has("force");
  const jobs: City[] = [];
  if (flags.has("all")) {
    jobs.push(...CITIES);
  } else if (flags.has("city")) {
    const id = flags.get("city") ?? "";
    const c = cityById(id);
    if (!c) {
      console.error(`unknown city "${id}". known: ${CITIES.map((x) => x.id).join(", ")}`);
      process.exit(2);
    }
    jobs.push(c);
  } else {
    console.error(
      "usage: bun tools/bake-roads.ts --city <id> [--force]\n" +
        "       bun tools/bake-roads.ts --all [--force]",
    );
    process.exit(2);
  }

  let ok = true;
  for (const c of jobs) {
    if (!(await bake(c, force))) ok = false;
  }
  await writeIndex();
  if (!ok) {
    console.error("\nsome checks FAILED");
    process.exit(1);
  }
}

await main();
