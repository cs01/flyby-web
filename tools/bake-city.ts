// Bakes OpenStreetMap building footprints + real heights into a compact binary
// `.city` pack the renderer streams at load time.
//
// Why Overpass and not vector tiles: OSM's own tile pyramid stops at zoom 14 and
// carries no height attribute at all. A skyline needs heights, so the only
// source is the raw element store, which means Overpass, which means a slow
// polite fetch we cache on disk rather than a CDN read.
//
//   bun tools/bake-city.ts --city sf
//   bun tools/bake-city.ts --lat 37.8 --lon -122.4 --radius 6000 --out out.city
//   bun tools/bake-city.ts --all [--force]
//
// The projection comes from ../src/geo. Re-deriving it here would drift by
// metres and put the buildings beside the terrain instead of on it.

import { CITIES, cityById, type City } from "../src/cities";
import { Origin } from "../src/geo";

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
const QUANT = 0.25; // metres per vertex-offset unit
const I16_LIMIT = 32000; // |offset| units; 8000 m
const MIN_AREA_M2 = 12;
const MIN_TOP_M = 2;
const MAX_TOP_M = 900;
const LEVEL_HEIGHT_M = 3.2;
const POLITE_DELAY_MS = 1500;
const MAX_ATTEMPTS = 6; // spec floor is 4; the public instances need the slack
const REQUEST_TIMEOUT_MS = 180_000;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// --- kind / roof enums ----------------------------------------------------

const KIND_GENERIC = 0;
const KIND_RESIDENTIAL = 1;
const KIND_COMMERCIAL = 2;
const KIND_INDUSTRIAL = 3;
const KIND_RETAIL = 4;
const KIND_CIVIC = 5;
const KIND_TOWER = 6;

const ROOF_FLAT = 0;
const ROOF_PITCHED = 1;
const ROOF_DOME = 2;
const ROOF_PYRAMID = 3;
const ROOF_TAPERED = 4;

// --- OSM shapes -----------------------------------------------------------

interface OsmPt {
  lat: number;
  lon: number;
}

interface OsmMember {
  type: string;
  ref: number;
  role?: string;
  geometry?: OsmPt[];
}

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmPt[];
  members?: OsmMember[];
}

interface OverpassResponse {
  elements?: OsmElement[];
}

// --- baked record ---------------------------------------------------------

interface Building {
  cx: number;
  cz: number;
  baseM: number;
  topM: number;
  kind: number;
  roof: number;
  /** i16 units of QUANT metres, offsets from the centroid. */
  dx: Int16Array;
  dz: Int16Array;
}

// --- small helpers --------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: string | undefined, what: string): number {
  const n = v === undefined ? NaN : Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${what} needs a number, got ${v ?? "(nothing)"}`);
  return n;
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

// --- length parsing -------------------------------------------------------

const FEET_INCH = /^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)\s*(?:"|''|in|inch(?:es)?)?$/;
const VALUE_UNIT = /^(-?\d+(?:[.,]\d+)?)\s*([a-z'"]*)$/;

/**
 * OSM height values are free text. A bare number is metres by convention, but
 * US mappers write feet in three different spellings and the `12'6"` form
 * shows up on low-rise housing. Anything else is dropped rather than guessed:
 * a wrong unit here is a 3x error in the skyline.
 */
function parseLength(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;

  const fi = FEET_INCH.exec(s);
  if (fi) {
    const ft = Number(fi[1]);
    const inch = Number(fi[2]);
    if (!Number.isFinite(ft) || !Number.isFinite(inch)) return null;
    return (ft * 12 + inch) * 0.0254;
  }

  const vu = VALUE_UNIT.exec(s);
  if (!vu) return null;
  const v = Number(vu[1].replace(",", "."));
  if (!Number.isFinite(v)) return null;
  switch (vu[2]) {
    case "":
    case "m":
    case "metre":
    case "metres":
    case "meter":
    case "meters":
      return v;
    case "'":
    case "ft":
    case "feet":
    case "foot":
      return v * 0.3048;
    default:
      return null;
  }
}

/** `building:levels` is often `4`, sometimes `4.5`, sometimes `3;4`. */
function parseLevels(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^-?\d+(?:[.,]\d+)?/.exec(raw.trim());
  if (!m) return null;
  const v = Number(m[0].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// --- tag interpretation ---------------------------------------------------

const FALLBACK_HEIGHT: Record<string, number> = {
  house: 6,
  detached: 6,
  bungalow: 6,
  semidetached_house: 6,
  terrace: 6,
  apartments: 15,
  residential: 10,
  dormitory: 10,
  hotel: 15,
  commercial: 14,
  office: 14,
  retail: 8,
  supermarket: 8,
  kiosk: 8,
  industrial: 10,
  warehouse: 10,
  manufacture: 10,
  church: 20,
  cathedral: 20,
  chapel: 20,
  mosque: 20,
  temple: 20,
  synagogue: 20,
  school: 12,
  university: 12,
  college: 12,
  hospital: 12,
  civic: 12,
  public: 12,
  government: 12,
  garage: 3,
  garages: 3,
  shed: 3,
  hut: 3,
  carport: 3,
  roof: 3,
};

const KIND_BY_BUILDING: Record<string, number> = {
  house: KIND_RESIDENTIAL,
  detached: KIND_RESIDENTIAL,
  bungalow: KIND_RESIDENTIAL,
  semidetached_house: KIND_RESIDENTIAL,
  terrace: KIND_RESIDENTIAL,
  apartments: KIND_RESIDENTIAL,
  residential: KIND_RESIDENTIAL,
  dormitory: KIND_RESIDENTIAL,
  house_boat: KIND_RESIDENTIAL,
  commercial: KIND_COMMERCIAL,
  office: KIND_COMMERCIAL,
  hotel: KIND_COMMERCIAL,
  industrial: KIND_INDUSTRIAL,
  warehouse: KIND_INDUSTRIAL,
  manufacture: KIND_INDUSTRIAL,
  hangar: KIND_INDUSTRIAL,
  retail: KIND_RETAIL,
  supermarket: KIND_RETAIL,
  kiosk: KIND_RETAIL,
  church: KIND_CIVIC,
  cathedral: KIND_CIVIC,
  chapel: KIND_CIVIC,
  mosque: KIND_CIVIC,
  temple: KIND_CIVIC,
  synagogue: KIND_CIVIC,
  shrine: KIND_CIVIC,
  monastery: KIND_CIVIC,
  school: KIND_CIVIC,
  university: KIND_CIVIC,
  college: KIND_CIVIC,
  kindergarten: KIND_CIVIC,
  hospital: KIND_CIVIC,
  civic: KIND_CIVIC,
  public: KIND_CIVIC,
  government: KIND_CIVIC,
  museum: KIND_CIVIC,
  train_station: KIND_CIVIC,
  transportation: KIND_CIVIC,
  stadium: KIND_CIVIC,
  tower: KIND_TOWER,
  skyscraper: KIND_TOWER,
};

function classifyKind(tags: Record<string, string>, topM: number): number {
  const b = (tags["building"] ?? tags["building:part"] ?? "").toLowerCase();
  const direct = KIND_BY_BUILDING[b];
  if (direct !== undefined) {
    // A 300 m "commercial" is a skyscraper to the renderer regardless of its tag.
    if (topM >= 100 && direct !== KIND_CIVIC) return KIND_TOWER;
    return direct;
  }
  if (topM >= 100) return KIND_TOWER;
  if (tags["man_made"] === "tower" || tags["man_made"] === "communications_tower") return KIND_TOWER;
  if (tags["office"] !== undefined) return KIND_COMMERCIAL;
  if (tags["shop"] !== undefined) return KIND_RETAIL;
  if (tags["amenity"] === "place_of_worship") return KIND_CIVIC;
  if (tags["amenity"] !== undefined || tags["tourism"] !== undefined) return KIND_CIVIC;
  if (tags["industrial"] !== undefined) return KIND_INDUSTRIAL;
  return KIND_GENERIC;
}

const ROOF_BY_SHAPE: Record<string, number> = {
  flat: ROOF_FLAT,
  gabled: ROOF_PITCHED,
  "half-hipped": ROOF_PITCHED,
  hipped: ROOF_PITCHED,
  "gabled-hipped": ROOF_PITCHED,
  gambrel: ROOF_PITCHED,
  mansard: ROOF_PITCHED,
  skillion: ROOF_PITCHED,
  "double_saltbox": ROOF_PITCHED,
  saltbox: ROOF_PITCHED,
  round: ROOF_PITCHED,
  "side_half_hipped": ROOF_PITCHED,
  dome: ROOF_DOME,
  onion: ROOF_DOME,
  cupola: ROOF_DOME,
  pyramidal: ROOF_PYRAMID,
  "half-pyramidal": ROOF_PYRAMID,
  quadruple_saltbox: ROOF_PYRAMID,
  spherical: ROOF_DOME,
  cone: ROOF_TAPERED,
  conical: ROOF_TAPERED,
  spire: ROOF_TAPERED,
  pyramidal_spire: ROOF_TAPERED,
  tented: ROOF_TAPERED,
};

function classifyRoof(tags: Record<string, string>, kind: number): number {
  const shape = (tags["roof:shape"] ?? tags["building:roof:shape"] ?? "").toLowerCase();
  const mapped = ROOF_BY_SHAPE[shape];
  if (mapped !== undefined) return mapped;
  // Untagged: a church/spire silhouette is the one that reads wrong as a box.
  const b = (tags["building"] ?? "").toLowerCase();
  if (b === "church" || b === "cathedral" || b === "chapel") return ROOF_TAPERED;
  if (b === "mosque" || b === "temple" || b === "synagogue") return ROOF_DOME;
  if (kind === KIND_RESIDENTIAL && b !== "apartments") return ROOF_PITCHED;
  return ROOF_FLAT;
}

interface Heights {
  baseM: number;
  topM: number;
}

/** Priority: explicit height, then levels x storey height, then a tag guess. */
function resolveHeights(tags: Record<string, string>): Heights | null {
  let top: number | null = parseLength(tags["height"] ?? tags["building:height"]);

  if (top === null) {
    const levels = parseLevels(tags["building:levels"] ?? tags["levels"]);
    if (levels !== null) {
      top = levels * LEVEL_HEIGHT_M;
      const roofH = parseLength(tags["roof:height"]);
      if (roofH !== null) top += roofH;
    }
  }

  if (top === null) {
    const b = (tags["building"] ?? tags["building:part"] ?? "").toLowerCase();
    top = FALLBACK_HEIGHT[b] ?? 9;
  }

  let base = parseLength(tags["min_height"] ?? tags["building:min_height"]);
  if (base === null) {
    const minLevel = parseLevels(tags["building:min_level"] ?? tags["min_level"]);
    base = minLevel !== null ? minLevel * LEVEL_HEIGHT_M : 0;
  }
  if (!Number.isFinite(base) || base < 0) base = 0;

  const topM = Math.min(MAX_TOP_M, Math.max(MIN_TOP_M, top));
  if (topM <= base) return null;
  return { baseM: base, topM };
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
  // `out geom` and not `out tags geom`: the `tags` verbosity drops a relation's
  // member list entirely, so `geom` has nothing to hang geometry off and every
  // multipolygon building comes back as bare tags + a bounding box. Measured on
  // SF that silently discarded 645 relations. `geom` implies body verbosity,
  // which carries tags anyway, so nothing is lost.
  return `[out:json][timeout:120];
(way["building"](${box});
 way["building:part"](${box});
 relation["building"](${box}););
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
          "User-Agent": "flyby-web bake-city (https://github.com/cs01/flyby-web)",
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

  const byId = new Map<string, OsmElement>();
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

      // Ways straddling a cell edge come back in both cells; way and relation
      // id spaces are separate, so the type has to be part of the key.
      for (const el of body.elements ?? []) byId.set(`${el.type}/${el.id}`, el);
    }
  }
  return [...byId.values()];
}

// --- geometry -------------------------------------------------------------

interface Ring {
  x: number[];
  z: number[];
}

/** Drop the OSM closing duplicate and any consecutive repeats. */
function toRing(origin: Origin, pts: OsmPt[]): Ring | null {
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
  while (
    x.length > 1 &&
    Math.abs(x[0] - x[x.length - 1]) < 1e-6 &&
    Math.abs(z[0] - z[z.length - 1]) < 1e-6
  ) {
    x.pop();
    z.pop();
  }
  if (x.length < 3) return null;
  return { x, z };
}

/** Shoelace with y := z, so positive means counter-clockwise in (x, z). */
function signedArea(r: Ring): number {
  let a = 0;
  const n = r.x.length;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += r.x[i] * r.z[j] - r.x[j] * r.z[i];
  }
  return a / 2;
}

function reverse(r: Ring): void {
  r.x.reverse();
  r.z.reverse();
}

// --- bake -----------------------------------------------------------------

interface BakeStats {
  buildings: Building[];
  skips: Skips;
}

function bakeElements(elements: OsmElement[], origin: Origin, radius: number): BakeStats {
  const skips = new Skips();
  const buildings: Building[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (tags["building"] === "no" || tags["building:part"] === "no") {
      skips.add("tagged building=no");
      continue;
    }

    const rings: Ring[] = [];
    if (el.type === "way") {
      if (!el.geometry || el.geometry.length === 0) {
        skips.add("way with no geometry");
        continue;
      }
      const r = toRing(origin, el.geometry);
      if (r === null) {
        skips.add("ring under 3 distinct vertices");
        continue;
      }
      rings.push(r);
    } else if (el.type === "relation") {
      let sawOuter = false;
      for (const m of el.members ?? []) {
        if (m.role !== "outer" || !m.geometry || m.geometry.length === 0) continue;
        sawOuter = true;
        const r = toRing(origin, m.geometry);
        if (r === null) {
          skips.add("ring under 3 distinct vertices");
          continue;
        }
        rings.push(r);
      }
      if (!sawOuter) {
        skips.add("relation with no outer geometry");
        continue;
      }
      if (rings.length === 0) continue;
    } else {
      skips.add(`unhandled element type ${el.type}`);
      continue;
    }

    const heights = resolveHeights(tags);
    if (heights === null) {
      skips.add("top height not above base");
      continue;
    }
    const kind = classifyKind(tags, heights.topM);
    const roof = classifyRoof(tags, kind);

    for (const ring of rings) {
      const area = signedArea(ring);
      if (Math.abs(area) < MIN_AREA_M2) {
        skips.add("footprint under 12 m^2");
        continue;
      }
      // Uniform winding: the renderer's triangulation and face winding assume it.
      if (area < 0) reverse(ring);

      const n = ring.x.length;
      let sx = 0;
      let sz = 0;
      for (let i = 0; i < n; i++) {
        sx += ring.x[i];
        sz += ring.z[i];
      }
      const cx = sx / n;
      const cz = sz / n;

      if (Math.hypot(cx, cz) > radius) {
        skips.add("centroid outside radius");
        continue;
      }
      if (n > 65535) {
        skips.add("ring over 65535 vertices");
        continue;
      }

      const dx = new Int16Array(n);
      const dz = new Int16Array(n);
      let overflow = false;
      for (let i = 0; i < n; i++) {
        const qx = Math.round((ring.x[i] - cx) / QUANT);
        const qz = Math.round((ring.z[i] - cz) / QUANT);
        if (Math.abs(qx) > I16_LIMIT || Math.abs(qz) > I16_LIMIT) {
          overflow = true;
          break;
        }
        dx[i] = qx;
        dz[i] = qz;
      }
      if (overflow) {
        // A footprint over 8 km across is a broken multipolygon, not a building.
        skips.add("vertex offset overflows i16 (bad relation)");
        continue;
      }

      buildings.push({ cx, cz, baseM: heights.baseM, topM: heights.topM, kind, roof, dx, dz });
    }
  }

  return { buildings, skips };
}

// --- serialise ------------------------------------------------------------

const MAGIC = 0x43495459;
const VERSION = 1;
const HEADER_BYTES = 32;
const RECORD_BYTES = 20;

function encode(buildings: Building[], lat0: number, lon0: number, radiusM: number): Uint8Array {
  let size = HEADER_BYTES;
  for (const b of buildings) size += RECORD_BYTES + 4 * b.dx.length;

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, MAGIC, true); o += 4;
  dv.setUint32(o, VERSION, true); o += 4;
  dv.setFloat64(o, lat0, true); o += 8;
  dv.setFloat64(o, lon0, true); o += 8;
  dv.setFloat32(o, radiusM, true); o += 4;
  dv.setUint32(o, buildings.length, true); o += 4;

  for (const b of buildings) {
    dv.setFloat32(o, b.cx, true); o += 4;
    dv.setFloat32(o, b.cz, true); o += 4;
    dv.setFloat32(o, b.baseM, true); o += 4;
    dv.setFloat32(o, b.topM, true); o += 4;
    dv.setUint8(o, b.kind); o += 1;
    dv.setUint8(o, b.roof); o += 1;
    dv.setUint16(o, b.dx.length, true); o += 2;
    for (let i = 0; i < b.dx.length; i++) {
      dv.setInt16(o, b.dx[i], true); o += 2;
      dv.setInt16(o, b.dz[i], true); o += 2;
    }
  }
  return new Uint8Array(buf);
}

// --- verification ---------------------------------------------------------

interface DecodedHeader {
  lat0: number;
  lon0: number;
  radiusM: number;
  count: number;
}

interface Decoded {
  header: DecodedHeader;
  first: Building | null;
  last: Building | null;
}

/** Deliberately a second, independent reader: it is the only proof the writer
 *  laid the fields out the way the format says. */
function decode(bytes: Uint8Array): Decoded {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const magic = dv.getUint32(o, true); o += 4;
  if (magic !== MAGIC) throw new Error(`bad magic 0x${magic.toString(16)}`);
  const version = dv.getUint32(o, true); o += 4;
  if (version !== VERSION) throw new Error(`bad version ${version}`);
  const lat0 = dv.getFloat64(o, true); o += 8;
  const lon0 = dv.getFloat64(o, true); o += 8;
  const radiusM = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;

  let first: Building | null = null;
  let last: Building | null = null;
  for (let i = 0; i < count; i++) {
    const cx = dv.getFloat32(o, true); o += 4;
    const cz = dv.getFloat32(o, true); o += 4;
    const baseM = dv.getFloat32(o, true); o += 4;
    const topM = dv.getFloat32(o, true); o += 4;
    const kind = dv.getUint8(o); o += 1;
    const roof = dv.getUint8(o); o += 1;
    const vc = dv.getUint16(o, true); o += 2;
    const dx = new Int16Array(vc);
    const dz = new Int16Array(vc);
    for (let v = 0; v < vc; v++) {
      dx[v] = dv.getInt16(o, true); o += 2;
      dz[v] = dv.getInt16(o, true); o += 2;
    }
    const rec: Building = { cx, cz, baseM, topM, kind, roof, dx, dz };
    if (i === 0) first = rec;
    if (i === count - 1) last = rec;
  }
  if (o !== bytes.byteLength) throw new Error(`trailing bytes: read ${o} of ${bytes.byteLength}`);
  return { header: { lat0, lon0, radiusM, count }, first, last };
}

function sameBuilding(a: Building | null, b: Building | null): boolean {
  if (a === null || b === null) return a === b;
  const f32 = (v: number) => Math.fround(v);
  return (
    f32(a.cx) === b.cx &&
    f32(a.cz) === b.cz &&
    f32(a.topM) === b.topM &&
    f32(a.baseM) === b.baseM &&
    a.dx.length === b.dx.length
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

// --- self-check -----------------------------------------------------------

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

function nearestTall(
  buildings: Building[],
  origin: Origin,
  lat: number,
  lon: number,
  withinM: number,
  minHeight: number,
): { best: Building | null; dist: number } {
  const t = origin.toWorld(lat, lon);
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of buildings) {
    if (b.topM < minHeight) continue;
    const d = Math.hypot(b.cx - t.x, b.cz - t.z);
    if (d <= withinM && d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return { best, dist: bestD };
}

function selfCheckSf(buildings: Building[], origin: Origin, p50: number): Check[] {
  const checks: Check[] = [];

  const landmarks: [string, number, number, number][] = [
    ["Salesforce Tower", 37.7897, -122.3972, 290],
    ["Transamerica Pyramid", 37.7952, -122.4028, 210],
  ];
  for (const [name, lat, lon, minH] of landmarks) {
    const { best, dist } = nearestTall(buildings, origin, lat, lon, 150, minH);
    checks.push({
      label: `${name} >= ${minH} m within 150 m`,
      ok: best !== null,
      detail:
        best !== null
          ? `found ${best.topM.toFixed(1)} m at ${dist.toFixed(0)} m`
          : `no building >= ${minH} m within 150 m`,
    });
  }

  checks.push({
    label: "building count > 20000",
    ok: buildings.length > 20000,
    detail: `${buildings.length}`,
  });
  checks.push({
    label: "p50 height in [4, 25] m",
    ok: p50 >= 4 && p50 <= 25,
    detail: `${p50.toFixed(1)} m`,
  });
  return checks;
}

// --- driver ---------------------------------------------------------------

interface Job {
  key: string;
  lat: number;
  lon: number;
  radius: number;
  out: string;
  isSf: boolean;
}

async function bake(job: Job, force: boolean): Promise<boolean> {
  console.log(`\n=== ${job.key}  (${job.lat}, ${job.lon})  r=${job.radius} m ===`);
  const origin = new Origin(job.lat, job.lon);
  const dLat = job.radius / origin.mPerLat;
  const dLon = job.radius / origin.mPerLon;
  const bbox: Bbox = {
    s: job.lat - dLat,
    n: job.lat + dLat,
    w: job.lon - dLon,
    e: job.lon + dLon,
  };

  const elements = await fetchCells(job.key, bbox, force);
  console.log(`  ${elements.length} unique OSM elements`);

  const { buildings, skips } = bakeElements(elements, origin, job.radius);
  const bytes = encode(buildings, job.lat, job.lon, job.radius);
  await Bun.write(job.out, bytes);
  const onDiskSize = Bun.file(job.out).size;

  const heights = buildings.map((b) => b.topM).sort((a, b) => a - b);
  const p50 = percentile(heights, 50);

  console.log(`\n--- ${job.key} report ---`);
  console.log(`  buildings   ${buildings.length}`);
  console.log(`  skipped     ${skips.total()}`);
  for (const [reason, n] of skips.entries()) console.log(`      ${n.toString().padStart(7)}  ${reason}`);
  console.log(`  file        ${job.out}  ${onDiskSize} bytes`);
  console.log(
    `  height      p50 ${p50.toFixed(1)}  p90 ${percentile(heights, 90).toFixed(1)}` +
      `  p99 ${percentile(heights, 99).toFixed(1)}  max ${(heights[heights.length - 1] ?? 0).toFixed(1)} m`,
  );

  const tallest = [...buildings].sort((a, b) => b.topM - a.topM).slice(0, 5);
  console.log("  tallest:");
  for (const b of tallest) {
    const ll = origin.toLatLon(b.cx, b.cz);
    console.log(
      `      ${b.topM.toFixed(1).padStart(6)} m  at ${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`,
    );
  }

  let allOk = true;
  if (job.isSf) {
    console.log("  self-check:");
    for (const c of selfCheckSf(buildings, origin, p50)) {
      console.log(`      ${c.ok ? "PASS" : "FAIL"}  ${c.label}  (${c.detail})`);
      if (!c.ok) allOk = false;
    }
  }

  const back = decode(new Uint8Array(await Bun.file(job.out).arrayBuffer()));
  const rtOk =
    back.header.count === buildings.length &&
    back.header.radiusM === Math.fround(job.radius) &&
    Math.abs(back.header.lat0 - job.lat) < 1e-12 &&
    Math.abs(back.header.lon0 - job.lon) < 1e-12 &&
    sameBuilding(buildings[0] ?? null, back.first) &&
    sameBuilding(buildings[buildings.length - 1] ?? null, back.last);
  console.log(`  ROUNDTRIP ${rtOk ? "OK" : "FAIL"}  (${back.header.count} records re-read)`);
  if (!rtOk) allOk = false;

  return allOk;
}

function jobForCity(c: City): Job {
  return {
    key: c.id,
    lat: c.lat,
    lon: c.lon,
    radius: c.radius,
    out: `${ROOT}public/cities/${c.id}.city`,
    isSf: c.id === "sf",
  };
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
  const jobs: Job[] = [];

  if (flags.has("all")) {
    for (const c of CITIES) jobs.push(jobForCity(c));
  } else if (flags.has("city")) {
    const id = flags.get("city") ?? "";
    const c = cityById(id);
    if (!c) {
      console.error(`unknown city "${id}". known: ${CITIES.map((x) => x.id).join(", ")}`);
      process.exit(2);
    }
    jobs.push(jobForCity(c));
  } else if (flags.has("lat") && flags.has("lon")) {
    const lat = num(flags.get("lat"), "lat");
    const lon = num(flags.get("lon"), "lon");
    const radius = flags.has("radius") ? num(flags.get("radius"), "radius") : 7000;
    const out = flags.get("out");
    if (!out) {
      console.error("--lat/--lon needs --out <path>");
      process.exit(2);
    }
    jobs.push({
      key: `custom-${lat.toFixed(4)}-${lon.toFixed(4)}-${Math.round(radius)}`,
      lat,
      lon,
      radius,
      out,
      isSf: false,
    });
  } else {
    console.error(
      "usage: bun tools/bake-city.ts --city <id> [--force]\n" +
        "       bun tools/bake-city.ts --lat <n> --lon <n> [--radius <m>] --out <path>\n" +
        "       bun tools/bake-city.ts --all [--force]",
    );
    process.exit(2);
  }

  let ok = true;
  for (const job of jobs) {
    if (!(await bake(job, force))) ok = false;
  }
  if (!ok) {
    console.error("\nsome checks FAILED");
    process.exit(1);
  }
}

await main();
