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
// What is left in this file is only the parts a browser cannot have: the
// command line, the disk cache, the polite fetch and the report. Every decision
// about what an OSM way MEANS lives in ../src/data/osmroads, and the format in
// ../src/data/roadpack, because the runtime path in the browser makes exactly
// the same roads out of exactly the same answers.
//
// The projection comes from ../src/geo. Re-deriving it here would drift and put
// the roads beside the terrain instead of on it.

import { CITIES, cityById, type City } from "../src/cities";
import { Origin } from "../src/geo";
import {
  encodeRoadPack,
  parseRoadPack,
  ROAD_CLASS_NAMES,
  type PackedWay,
} from "../src/data/roadpack";
import { QUANT, roadsFromOsm, roadsQuery } from "../src/data/osmroads";
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

async function fetchCells(key: string, bbox: OsmBbox, force: boolean): Promise<OsmElement[]> {
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
      const cell: OsmBbox = {
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
        body = await overpass(roadsQuery(cell));
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

// --- report ---------------------------------------------------------------

function lengthKm(ways: PackedWay[]): number {
  let m = 0;
  for (const w of ways) {
    for (let i = 1; i < w.dx.length; i++) {
      m += Math.hypot(w.dx[i] - w.dx[i - 1], w.dz[i] - w.dz[i - 1]) * QUANT;
    }
  }
  return m / 1000;
}

function histogram(ways: PackedWay[]): [string, number][] {
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
  const bbox: OsmBbox = {
    s: city.lat - dLat,
    n: city.lat + dLat,
    w: city.lon - dLon,
    e: city.lon + dLon,
  };

  const elements = await fetchCells(`${city.id}-roads`, bbox, force);
  console.log(`  ${elements.length} unique OSM ways`);

  const { ways, skips, splits } = roadsFromOsm(elements, origin, city.radius);
  const out = `${ROOT}public/cities/${city.id}.roads`;
  await Bun.write(out, encodeRoadPack(ways, city.lat, city.lon, city.radius));
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
