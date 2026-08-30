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
// What is left in this file is only the parts a browser cannot have: the
// command line, the disk cache, the polite fetch and the report. Every decision
// about what an OSM element MEANS lives in ../src/data/osmbuildings, and the
// format lives in ../src/data/citypack, because the runtime path in the browser
// makes exactly the same buildings out of exactly the same answers and the two
// must not be able to drift.
//
// The projection comes from ../src/geo. Re-deriving it here would drift by
// metres and put the buildings beside the terrain instead of on it.

import { CITIES, cityById, type City } from "../src/cities";
import { Origin } from "../src/geo";
import { CITY_MAGIC, encodeCityPack, type PackedBuilding } from "../src/data/citypack";
import { buildingsFromOsm, buildingsQuery } from "../src/data/osmbuildings";
import type { OsmBbox, OsmElement, OverpassResponse } from "../src/data/osm";

// The repo's tsconfig deliberately carries no node/bun types (`types:
// ["vite/client"]`), so the two runtime globals this script needs are declared
// here rather than pulled in from @types/node. Module-scoped `declare const`
// resolves to the real global at runtime and keeps `tsc --noEmit` clean without
// widening the type surface of the app itself.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
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

/**
 * Shared, permanent, and OUTSIDE the checkout.
 *
 * This used to be `<repo>/tools/.cache`, which is per-worktree. Removing a
 * worktree after merging its branch therefore deleted every Overpass response
 * it had ever fetched, and the next bake re-fetched all of it. Doing that a few
 * times in an afternoon is how this project got itself rate-limited off the
 * public Overpass instances, which are donated infrastructure.
 *
 * An Overpass answer for a fixed bbox and a fixed query is effectively
 * immutable: OSM changes, but not in ways that matter to a skyline, and a
 * re-bake wanting fresher data has `--force`. So there is no TTL here on
 * purpose. Fetched once, kept forever, shared by every worktree.
 *
 * FLYBY_CACHE overrides it, for a machine that wants the cache somewhere else.
 */
const CACHE_ROOT =
  (process.env["FLYBY_CACHE"] ?? `${process.env["HOME"] ?? "."}/.cache/flyby-web-bake`);
const CACHE_DIR = `${CACHE_ROOT}`;
const CELL_TARGET_M = 2000; // one whole-city query gets shed by public instances
const POLITE_DELAY_MS = 1500;
const MAX_ATTEMPTS = 6; // spec floor is 4; the public instances need the slack
const REQUEST_TIMEOUT_MS = 180_000;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// --- small helpers --------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: string | undefined, what: string): number {
  const n = v === undefined ? NaN : Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${what} needs a number, got ${v ?? "(nothing)"}`);
  return n;
}

// --- Overpass -------------------------------------------------------------

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

async function fetchCells(key: string, bbox: OsmBbox, force: boolean): Promise<OsmElement[]> {
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
      const cell: OsmBbox = {
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
        body = await overpass(buildingsQuery(cell));
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

// --- verification ---------------------------------------------------------

interface DecodedHeader {
  lat0: number;
  lon0: number;
  radiusM: number;
  count: number;
}

interface Decoded {
  header: DecodedHeader;
  first: PackedBuilding | null;
  last: PackedBuilding | null;
}

/** Deliberately a second, independent reader: it is the only proof the writer
 *  laid the fields out the way the format says. Kept here rather than pointed
 *  at parseCityPack for exactly that reason -- a writer checked by its own
 *  matching reader proves only that the two agree. */
function decode(bytes: Uint8Array): Decoded {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const magic = dv.getUint32(o, true); o += 4;
  if (magic !== CITY_MAGIC) throw new Error(`bad magic 0x${magic.toString(16)}`);
  const version = dv.getUint32(o, true); o += 4;
  if (version !== 1) throw new Error(`bad version ${version}`);
  const lat0 = dv.getFloat64(o, true); o += 8;
  const lon0 = dv.getFloat64(o, true); o += 8;
  const radiusM = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;

  let first: PackedBuilding | null = null;
  let last: PackedBuilding | null = null;
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
    const rec: PackedBuilding = { cx, cz, baseM, topM, kind, roof, dx, dz };
    if (i === 0) first = rec;
    if (i === count - 1) last = rec;
  }
  if (o !== bytes.byteLength) throw new Error(`trailing bytes: read ${o} of ${bytes.byteLength}`);
  return { header: { lat0, lon0, radiusM, count }, first, last };
}

function sameBuilding(a: PackedBuilding | null, b: PackedBuilding | null): boolean {
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
  buildings: PackedBuilding[],
  origin: Origin,
  lat: number,
  lon: number,
  withinM: number,
  minHeight: number,
): { best: PackedBuilding | null; dist: number } {
  const t = origin.toWorld(lat, lon);
  let best: PackedBuilding | null = null;
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

function selfCheckSf(buildings: PackedBuilding[], origin: Origin, p50: number): Check[] {
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
  const bbox: OsmBbox = {
    s: job.lat - dLat,
    n: job.lat + dLat,
    w: job.lon - dLon,
    e: job.lon + dLon,
  };

  const elements = await fetchCells(job.key, bbox, force);
  console.log(`  ${elements.length} unique OSM elements`);

  const { buildings, skips } = buildingsFromOsm(elements, origin, job.radius);
  const bytes = encodeCityPack(buildings, job.lat, job.lon, job.radius);
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
      key: flags.get("key") || `custom-${lat.toFixed(4)}-${lon.toFixed(4)}-${Math.round(radius)}`,
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
