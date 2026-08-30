// A local Overpass that answers out of the bake cache, for the screenshot
// harness and for working on the live path offline.
//
// WHY THIS EXISTS. tools/shots.ts is a before/after instrument: the only thing
// allowed to differ between two runs of the same URL is the code. A pose over a
// place with no baked pack fetches from Overpass, and Overpass is a volunteer
// service that queues, rate-limits and occasionally refuses outright -- so
// pointing the harness at it would make the shot depend on somebody else's
// afternoon, and would spend their capacity on a question this machine has
// already asked and written down.
//
// So: the same real answers, served from disk, at the same URL shape. The page
// runs its whole live path unchanged -- same query, same client, same cache,
// same converters -- and only the host differs.
//
//   bun tools/overpass-replay.ts --port 5199 --key santarosa
//   bun tools/shots.ts --out shots/live --only santa-rosa --port 5178 \
//       --query 'overpass=http://localhost:5199/api/interpreter'
//
// It is NOT a general Overpass: it answers with every indexed element whose own
// bounding box meets the query box, regardless of which tag filters the query
// carried. That is deliberate and harmless, because every converter in this
// codebase filters by tag itself (see isBuildingElement and friends), and the
// alternative is reimplementing Overpass QL to no benefit.

import { readdirSync, readFileSync } from "node:fs";
import type { OsmElement, OverpassResponse } from "../src/data/osm";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};
declare const Bun: {
  serve(opts: {
    port: number;
    fetch(req: Request): Response | Promise<Response>;
  }): { port: number };
};

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const CACHE =
  arg("from") ?? process.env["FLYBY_CACHE"] ?? `${process.env["HOME"] ?? "."}/.cache/flyby-web-bake`;
const KEY = arg("key");
const PORT = Number(arg("port", "5199"));

interface Indexed {
  el: OsmElement;
  s: number;
  w: number;
  n: number;
  e: number;
}

/** The box an element occupies, from its own geometry. */
function boundsOf(el: OsmElement): Indexed | null {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  const eat = (lat: number, lon: number): void => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  };
  if (el.lat !== undefined && el.lon !== undefined) eat(el.lat, el.lon);
  for (const p of el.geometry ?? []) eat(p.lat, p.lon);
  for (const m of el.members ?? []) for (const p of m.geometry ?? []) eat(p.lat, p.lon);
  if (!Number.isFinite(s)) return null;
  return { el, s, w, n, e };
}

const index: Indexed[] = [];
const seen = new Set<string>();
let files = 0;
for (const f of readdirSync(CACHE).sort()) {
  if (!f.endsWith(".json")) continue;
  if (KEY && !f.startsWith(KEY)) continue;
  files++;
  const body = JSON.parse(readFileSync(`${CACHE}/${f}`, "utf8")) as OverpassResponse;
  for (const el of body.elements ?? []) {
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const b = boundsOf(el);
    if (b) index.push(b);
  }
}

if (index.length === 0) {
  console.error(
    `no cached elements under ${CACHE}${KEY ? ` matching --key ${KEY}` : ""}. ` +
      `Run a bake first, or point --from somewhere with a warm cache.`,
  );
  process.exit(2);
}

const cover = index.reduce(
  (acc, i) => ({
    s: Math.min(acc.s, i.s), w: Math.min(acc.w, i.w),
    n: Math.max(acc.n, i.n), e: Math.max(acc.e, i.e),
  }),
  { s: 90, w: 180, n: -90, e: -180 },
);
console.log(
  `overpass-replay: ${index.length} elements from ${files} cached answers under ${CACHE}\n` +
    `  covering ${cover.s.toFixed(4)},${cover.w.toFixed(4)} to ${cover.n.toFixed(4)},${cover.e.toFixed(4)}`,
);

/** The first bbox filter in an Overpass query, which is the one every query
 *  this codebase writes uses for all of its statements. */
function bboxOf(query: string): { s: number; w: number; n: number; e: number } | null {
  const m = /\(\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\)/.exec(
    query,
  );
  if (!m) return null;
  return { s: Number(m[1]), w: Number(m[2]), n: Number(m[3]), e: Number(m[4]) };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json",
};

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!url.pathname.endsWith("/interpreter")) {
      return new Response("not an interpreter endpoint", { status: 404, headers: CORS });
    }

    let query = url.searchParams.get("data") ?? "";
    if (query === "" && req.method === "POST") {
      query = new URLSearchParams(await req.text()).get("data") ?? "";
    }
    const box = bboxOf(query);
    if (!box) return new Response(`{"elements":[]}`, { headers: CORS });

    const elements: OsmElement[] = [];
    for (const i of index) {
      // `out geom` returns a way WHOLE whenever it touches the box, which is
      // what makes a building on a tile edge complete in both tiles. Anything
      // narrower here would give the live path a different picture from the one
      // the real endpoint gives it.
      if (i.n < box.s || i.s > box.n || i.e < box.w || i.w > box.e) continue;
      elements.push(i.el);
    }
    console.log(
      `  ${box.s.toFixed(4)},${box.w.toFixed(4)},${box.n.toFixed(4)},${box.e.toFixed(4)} -> ${elements.length} elements`,
    );
    return new Response(
      JSON.stringify({
        version: 0.6,
        generator: "flyby-web overpass-replay (cached real answers)",
        elements,
      }),
      { headers: CORS },
    );
  },
});

console.log(`  listening on http://localhost:${server.port}/api/interpreter`);
