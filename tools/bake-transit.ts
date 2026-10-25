// Bakes the static GTFS the transit layer needs into public/transit/<city>.json.
//
//   bun tools/bake-transit.ts                 every transit city
//   bun tools/bake-transit.ts --city manhattan [--force]
//
// The agencies' static zips are fetched once into tools/.cache/transit (the
// CTA's is 69 MB, 367 MB of stop_times unzipped) and streamed through `unzip
// -p`; the app never fetches them. What is kept, per city, is the part that
// lies within CLIP of the centre: the track shapes cut to that circle, every
// stop the clipped trips call at, the timetable as patterns, and the service
// calendar. See src/data/transitpack.ts for the layout.
//
// THE VERTICAL. GTFS shapes are flat: nothing in them says that the Q is in a
// tunnel under Broadway and on the Manhattan Bridge over the East River. That
// comes from OpenStreetMap, whose railway ways carry tunnel/bridge/layer: every
// shape is sampled every 10 m and each sample takes the level of the nearest
// OSM railway within 20 m that is going the same way, preferring a way that is
// a member of the route's own OSM relation (Queens Boulevard has the elevated
// 7 above and the E/F/M/R tunnel below, 0 to 12 m apart in plan).

import { spawn } from "bun";
import { mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { cityById } from "../src/cities";
import { Origin } from "../src/geo";
import { delta, rle, QUANT, Level, type PackAgency, type RawPack, type TransitKind } from "../src/data/transitpack";
import { landmarksFor, axisOf } from "../src/data/landmarks";
import { parseLandPack, sampleLand, LandClass } from "../src/data/landcover";

const CACHE = new URL("./.cache/transit/", import.meta.url).pathname;
const OUT = new URL("../public/transit/", import.meta.url).pathname;

interface AgencyCfg {
  id: string;
  name: string;
  zip: string;
  kind: TransitKind;
  live: PackAgency["live"];
  /** GTFS route_type values to keep. */
  types: number[];
  /** Route ids to drop: BART's bus bridges are route_type 3 anyway. */
  elevatedM: number;
  /** Bake trip ids, for a feed that reports vehicles by trip. */
  tripIds?: boolean;
}

interface CityCfg {
  tz: string;
  /** Metres from the city centre that is kept. */
  clip: number;
  agencies: AgencyCfg[];
}

// Elevated top-of-rail heights. The IRT and BMT els are a single deck about
// 30 ft (9 m) to the top of rail over the avenue, more where the street dips;
// the Chicago Loop's structure clears the street by about 14 ft and stands
// 20 ft (6 m) to the rail; BART's aerials are 20 to 50 ft and 33 ft (10 m) in
// West Oakland. One number an agency: a structure that steps every block would
// be wrong in a more distracting way.
const CITIES: Record<string, CityCfg> = {
  manhattan: {
    tz: "America/New_York",
    clip: 12000,
    agencies: [
      { id: "mta", name: "MTA New York City Transit", zip: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip", kind: "subway", live: "mta", types: [1], elevatedM: 9 },
      { id: "nycferry", name: "NYC Ferry", zip: "http://nycferry.connexionz.net/rtt/public/resource/gtfs.zip", kind: "ferry", live: "nycferry", types: [4], elevatedM: 0, tripIds: true },
      { id: "siferry", name: "Staten Island Ferry", zip: "https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip", kind: "ferry", live: "", types: [4], elevatedM: 0 },
    ],
  },
  sf: {
    tz: "America/Los_Angeles",
    clip: 14000,
    agencies: [
      { id: "bart", name: "BART", zip: "https://www.bart.gov/dev/schedules/google_transit.zip", kind: "rail", live: "bart", types: [1], elevatedM: 10 },
      { id: "sfbayferry", name: "San Francisco Bay Ferry", zip: "https://gtfs.sanfranciscobayferry.com/gtfs.zip", kind: "ferry", live: "", types: [4], elevatedM: 0 },
      { id: "ggt", name: "Golden Gate Ferry", zip: "https://realtime.goldengate.org/gtfsstatic/GTFSTransitData.zip", kind: "ferry", live: "", types: [4], elevatedM: 0 },
    ],
  },
  chicago: {
    tz: "America/Chicago",
    clip: 10000,
    agencies: [
      { id: "cta", name: "CTA", zip: "https://www.transitchicago.com/downloads/sch_data/google_transit.zip", kind: "subway", live: "", types: [1], elevatedM: 6 },
    ],
  },
};

const SAMPLE_M = 10;
const OSM_NEAR_M = 20;
/** Douglas-Peucker tolerance. A car is 15 m: half a metre off the curve is invisible. */
const SIMPLIFY_M = 0.5;

// --- io ----------------------------------------------------------------------

async function ensureZip(a: AgencyCfg, force: boolean): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = `${CACHE}${a.id}.zip`;
  if (!force && existsSync(path) && statSync(path).size > 1000) return path;
  console.log(`  fetch ${a.zip}`);
  const res = await fetch(a.zip, { headers: { "User-Agent": "Mozilla/5.0 (flyby-web bake-transit)" } });
  if (!res.ok) throw new Error(`${a.zip}: ${res.status}`);
  await Bun.write(path, new Uint8Array(await res.arrayBuffer()));
  return path;
}

/** Lists the zip's entries; some zips nest the files under a directory. */
async function entries(zip: string): Promise<string[]> {
  const p = spawn(["unzip", "-Z1", zip], { stdout: "pipe" });
  return (await new Response(p.stdout).text()).split("\n").filter(Boolean);
}

function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Streams a CSV in the zip, row by row, as header-keyed lookups. */
async function eachRow(
  zip: string,
  names: string[],
  file: string,
  row: (get: (col: string) => string, raw: string) => void,
  prefilter?: (line: string) => boolean,
): Promise<void> {
  const entry = names.find((n) => n === file || n.endsWith(`/${file}`));
  if (!entry) return;
  const p = spawn(["unzip", "-p", zip, entry], { stdout: "pipe" });
  const dec = new TextDecoder();
  let buf = "";
  let cols: Map<string, number> | null = null;
  let vals: string[] = [];
  const get = (c: string): string => {
    const i = cols!.get(c);
    return i === undefined ? "" : (vals[i] ?? "").trim();
  };
  const line = (l: string) => {
    if (l.endsWith("\r")) l = l.slice(0, -1);
    if (!l) return;
    if (!cols) {
      cols = new Map(splitCsv(l.replace(/^﻿/, "")).map((c, i) => [c.trim(), i]));
      return;
    }
    if (prefilter && !prefilter(l)) return;
    vals = splitCsv(l);
    row(get, l);
  };
  for await (const chunk of p.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      line(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  line(buf);
}

function hms(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

// --- OSM ---------------------------------------------------------------------

interface OsmWay {
  id: number;
  lvl: number;
  /** world x,z */
  pts: number[];
  refs: Set<string>;
}

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

async function osmRail(cityId: string, o: Origin, clip: number, force: boolean): Promise<OsmWay[]> {
  const path = `${CACHE}osm-rail-${cityId}.json`;
  let body: { elements: { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; members?: { type: string; ref: number }[] }[] };
  if (!force && existsSync(path)) body = JSON.parse(await Bun.file(path).text());
  else {
    const s = o.toLatLon(0, clip + 500);
    const n = o.toLatLon(0, -clip - 500);
    const w = o.toLatLon(-clip - 500, 0);
    const e = o.toLatLon(clip + 500, 0);
    const bbox = `${s.lat},${w.lon},${n.lat},${e.lon}`;
    // Two queries, not one: ways plus `rel(bw)` in one request timed out
    // (504 after ~115 s) on every public instance on 2026-10-24, while the
    // ways alone answered in 46 s and the relations by bbox in under a minute.
    const queries = [
      `[out:json][timeout:600];way["railway"~"^(subway|light_rail|rail|monorail|narrow_gauge)$"](${bbox});out tags geom;`,
      `[out:json][timeout:300];rel["route"~"^(subway|light_rail|train)$"](${bbox});out body;`,
    ];
    const elements: unknown[] = [];
    for (const q of queries) {
      let text = "";
      for (let attempt = 0; attempt < 6 && !text; attempt++) {
        const ep = OVERPASS[attempt % OVERPASS.length];
        console.log(`  overpass ${ep}`);
        try {
          const r = await fetch(ep, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "flyby-web bake-transit" },
            body: "data=" + encodeURIComponent(q),
            signal: AbortSignal.timeout(600_000),
          });
          if (r.ok) text = await r.text();
          else console.log(`    ${r.status}`);
        } catch (err) {
          console.log(`    ${String(err)}`);
        }
        if (!text) await Bun.sleep(5000 * (attempt + 1));
      }
      if (!text) throw new Error("overpass failed");
      elements.push(...(JSON.parse(text) as { elements: unknown[] }).elements);
    }
    const text = JSON.stringify({ elements });
    await Bun.write(path, text);
    body = JSON.parse(text);
  }
  const refs = new Map<number, Set<string>>();
  for (const el of body.elements) {
    if (el.type !== "relation") continue;
    const t = el.tags ?? {};
    const toks = [t.ref, t.name, t["ref:colour"], t.colour].filter(Boolean).map((x) => x!.toLowerCase());
    for (const m of el.members ?? []) {
      if (m.type !== "way") continue;
      let set = refs.get(m.ref);
      if (!set) refs.set(m.ref, (set = new Set()));
      for (const k of toks) set.add(k);
    }
  }
  const ways: OsmWay[] = [];
  for (const el of body.elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const t = el.tags ?? {};
    const layer = Number(t.layer ?? 0) || 0;
    const tunnel = (t.tunnel && t.tunnel !== "no") || t.location === "underground" || (layer < 0 && !t.bridge);
    const bridge = t.bridge && t.bridge !== "no";
    const lvl = tunnel ? Level.Tunnel : bridge ? Level.Elevated : Level.Grade;
    const pts: number[] = [];
    for (const g of el.geometry) {
      const p = o.toWorld(g.lat, g.lon);
      pts.push(p.x, p.z);
    }
    ways.push({ id: el.id, lvl, pts, refs: refs.get(el.id) ?? new Set() });
  }
  return ways;
}

class SegIndex {
  private cells = new Map<string, number[]>();
  constructor(readonly ways: OsmWay[], readonly cell = 50) {
    ways.forEach((w, wi) => {
      for (let i = 0; i + 3 < w.pts.length; i += 2) {
        const x0 = Math.min(w.pts[i], w.pts[i + 2]) - OSM_NEAR_M, x1 = Math.max(w.pts[i], w.pts[i + 2]) + OSM_NEAR_M;
        const z0 = Math.min(w.pts[i + 1], w.pts[i + 3]) - OSM_NEAR_M, z1 = Math.max(w.pts[i + 1], w.pts[i + 3]) + OSM_NEAR_M;
        for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
          for (let cz = Math.floor(z0 / cell); cz <= Math.floor(z1 / cell); cz++) {
            const k = `${cx},${cz}`;
            let a = this.cells.get(k);
            if (!a) this.cells.set(k, (a = []));
            a.push(wi, i);
          }
        }
      }
    });
  }

  /** The best way at (x,z) heading (dx,dz), scored by distance with penalties. */
  best(x: number, z: number, dx: number, dz: number, tokens: string[]): OsmWay | null {
    const a = this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!a) return null;
    let best: OsmWay | null = null;
    let bs = Infinity;
    for (let k = 0; k < a.length; k += 2) {
      const w = this.ways[a[k]];
      const i = a[k + 1];
      const ax = w.pts[i], az = w.pts[i + 1], bx = w.pts[i + 2], bz = w.pts[i + 3];
      const vx = bx - ax, vz = bz - az;
      const L2 = vx * vx + vz * vz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2));
      const d = Math.hypot(ax + vx * u - x, az + vz * u - z);
      if (d > OSM_NEAR_M) continue;
      const cos = Math.abs((vx * dx + vz * dz) / Math.sqrt(L2));
      let score = d + (cos < 0.85 ? 15 : 0);
      if (tokens.length && ![...w.refs].some((r) => tokens.some((t) => r === t || r.includes(` ${t} `) || r.startsWith(`${t} `)))) score += 8;
      if (score < bs) {
        bs = score;
        best = w;
      }
    }
    return best;
  }
}

// --- geometry ------------------------------------------------------------------

/** Douglas-Peucker over x,z pairs, keeping every index in `keep`. */
function simplify(pts: number[], keep: Set<number>, tol: number): number[] {
  const n = pts.length / 2;
  const mark = new Uint8Array(n);
  mark[0] = mark[n - 1] = 1;
  for (const k of keep) mark[k] = 1;
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) if (mark[i]) anchors.push(i);
  const stack: [number, number][] = [];
  for (let i = 0; i + 1 < anchors.length; i++) stack.push([anchors[i], anchors[i + 1]]);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a * 2], az = pts[a * 2 + 1], bx = pts[b * 2], bz = pts[b * 2 + 1];
    const vx = bx - ax, vz = bz - az;
    const L = Math.hypot(vx, vz) || 1;
    let md = -1;
    let mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i * 2] - ax) * vz - (pts[i * 2 + 1] - az) * vx) / L;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > tol) {
      mark[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (mark[i]) out.push(i);
  return out;
}

function densify(pts: number[], step: number): number[] {
  const out: number[] = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], az = pts[i - 1], bx = pts[i], bz = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.01) continue;
    const k = Math.ceil(L / step);
    for (let j = 1; j <= k; j++) out.push(ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k);
  }
  return out;
}

// --- bake ----------------------------------------------------------------------

async function bakeCity(cityId: string, force: boolean): Promise<void> {
  const cfg = CITIES[cityId];
  const city = cityById(cityId);
  if (!cfg || !city) throw new Error(`no transit config for ${cityId}`);
  console.log(`== ${cityId}`);
  const o = new Origin(city.lat, city.lon);
  const R = cfg.clip;
  const inClip = (x: number, z: number) => Math.hypot(x, z) <= R;
  const hasRail = cfg.agencies.some((a) => a.kind !== "ferry");
  const osm = hasRail ? await osmRail(cityId, o, R, force) : [];
  const index = new SegIndex(osm);
  console.log(`  osm: ${osm.length} railway ways (${osm.filter((w) => w.lvl === Level.Tunnel).length} tunnel, ${osm.filter((w) => w.lvl === Level.Elevated).length} bridge)`);
  const landmarks = landmarksFor(cityId, o).filter((l) => l.spec.zone);
  // The city's own WorldCover pack, for putting docked ferries in the water.
  const landPath = new URL(`../public/cities/${cityId}.land`, import.meta.url).pathname;
  const land = existsSync(landPath) ? parseLandPack(await Bun.file(landPath).arrayBuffer()) : null;
  const wet = (x: number, z: number): boolean => {
    const l = land?.levels.find((lv) => Math.abs(x) < lv.extentM && Math.abs(z) < lv.extentM);
    if (!l) return true;
    const c = sampleLand(l, x, z);
    return c === LandClass.Water || c === LandClass.NoData;
  };

  const pack: RawPack = {
    v: 1, city: cityId, tz: cfg.tz, q: QUANT, agencies: [], routes: [], stops: [], shapes: [], patterns: [], services: [], structures: [],
  };
  const usedOsm = new Set<OsmWay>();

  for (const a of cfg.agencies) {
    const ai = pack.agencies.length;
    pack.agencies.push({ id: a.id, name: a.name, kind: a.kind, live: a.live, elevatedM: a.elevatedM });
    const zip = await ensureZip(a, force);
    const names = await entries(zip);

    const routes = new Map<string, number>();
    const routeTokens = new Map<string, string[]>();
    await eachRow(zip, names, "routes.txt", (g) => {
      if (!a.types.includes(Number(g("route_type")))) return;
      const id = g("route_id");
      routes.set(id, pack.routes.length);
      const short = g("route_short_name");
      const long = g("route_long_name");
      pack.routes.push([ai, id, short, long, (g("route_color") || "808080").toUpperCase(), (g("route_text_color") || "FFFFFF").toUpperCase()]);
      // Tokens to find the route's OSM relation by: "Q", "Yellow" from
      // BART's "Yellow-S", "Brown" from the CTA's "Brown Line".
      const toks = [short, id, short.split("-")[0], long.split(" ")[0]].filter((t) => t && t.length).map((t) => t.toLowerCase());
      routeTokens.set(id, [...new Set(toks)]);
    });

    interface Trip { route: string; service: string; shape: string; headsign: string; times: number[]; stops: string[]; seq: number[]; id: string }
    const trips = new Map<string, Trip>();
    await eachRow(zip, names, "trips.txt", (g) => {
      const r = g("route_id");
      if (!routes.has(r)) return;
      trips.set(g("trip_id"), { route: r, service: g("service_id"), shape: g("shape_id"), headsign: g("trip_headsign"), times: [], stops: [], seq: [], id: g("trip_id") });
    });
    console.log(`  ${a.id}: ${routes.size} routes, ${trips.size} trips`);

    await eachRow(
      zip, names, "stop_times.txt",
      (g) => {
        const t = trips.get(g("trip_id"));
        if (!t) return;
        const arr = g("arrival_time") || g("departure_time");
        const dep = g("departure_time") || arr;
        if (!arr) return;
        t.stops.push(g("stop_id"));
        t.seq.push(Number(g("stop_sequence")));
        t.times.push(hms(arr), hms(dep));
      },
      // The CTA's stop_times is 98% bus: skip a line by its first field before
      // splitting it, which is what keeps this to seconds rather than minutes.
      (line) => {
        const c = line.indexOf(",");
        const id = line.slice(0, c).replace(/"/g, "");
        return trips.has(id);
      },
    );

    const stopInfo = new Map<string, { name: string; lat: number; lon: number }>();
    await eachRow(zip, names, "stops.txt", (g) => {
      stopInfo.set(g("stop_id"), { name: g("stop_name"), lat: parseFloat(g("stop_lat")), lon: parseFloat(g("stop_lon")) });
    });

    const shapeRaw = new Map<string, { seq: number; lat: number; lon: number }[]>();
    const usedShapes = new Set([...trips.values()].map((t) => t.shape));
    await eachRow(zip, names, "shapes.txt", (g) => {
      const id = g("shape_id");
      if (!usedShapes.has(id)) return;
      let a2 = shapeRaw.get(id);
      if (!a2) shapeRaw.set(id, (a2 = []));
      a2.push({ seq: Number(g("shape_pt_sequence")), lat: parseFloat(g("shape_pt_lat")), lon: parseFloat(g("shape_pt_lon")) });
    });

    // Services.
    const svcIdx = new Map<string, number>();
    const svc = (id: string): number => {
      let i = svcIdx.get(id);
      if (i === undefined) {
        i = pack.services.length;
        svcIdx.set(id, i);
        pack.services.push([ai, id, 0, 0, 0, [], []]);
      }
      return i;
    };
    const usedSvc = new Set([...trips.values()].map((t) => t.service));
    await eachRow(zip, names, "calendar.txt", (g) => {
      const id = g("service_id");
      if (!usedSvc.has(id)) return;
      const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].reduce((m, d, i) => m | (g(d) === "1" ? 1 << i : 0), 0);
      const s = pack.services[svc(id)];
      s[2] = days;
      s[3] = Number(g("start_date"));
      s[4] = Number(g("end_date"));
    });
    await eachRow(zip, names, "calendar_dates.txt", (g) => {
      const id = g("service_id");
      if (!usedSvc.has(id)) return;
      const s = pack.services[svc(id)];
      (g("exception_type") === "1" ? s[5] : s[6]).push(Number(g("date")));
    });

    // Shapes: world, densified, levelled, simplified, clipped.
    const shapeIdx = new Map<string, { idx: number; pts: number[]; s: number[] } | null>();
    const bakeShape = (id: string, routeId: string): { idx: number; pts: number[]; s: number[] } | null => {
      if (shapeIdx.has(id)) return shapeIdx.get(id)!;
      const raw = shapeRaw.get(id);
      if (!raw || raw.length < 2) {
        shapeIdx.set(id, null);
        return null;
      }
      raw.sort((p, q) => p.seq - q.seq);
      const w: number[] = [];
      for (const p of raw) {
        const v = o.toWorld(p.lat, p.lon);
        w.push(v.x, v.z);
      }
      if (!w.some((_, i) => i % 2 === 0 && Math.hypot(w[i], w[i + 1]) < R + 200)) {
        shapeIdx.set(id, null);
        return null;
      }
      const d = densify(w, SAMPLE_M);
      const n = d.length / 2;
      const lv = new Uint8Array(n).fill(a.kind === "ferry" ? Level.Grade : 255);
      if (a.kind !== "ferry") {
        const toks = routeTokens.get(routeId) ?? [];
        for (let i = 0; i < n; i++) {
          const x = d[i * 2], z = d[i * 2 + 1];
          if (Math.hypot(x, z) > R + 300) continue;
          const j = Math.min(n - 1, i + 1), k = Math.max(0, i - 1);
          const dx = d[j * 2] - d[k * 2], dz = d[j * 2 + 1] - d[k * 2 + 1];
          const L = Math.hypot(dx, dz) || 1;
          const way = index.best(x, z, dx / L, dz / L, toks);
          if (way) {
            lv[i] = way.lvl;
            if (way.lvl === Level.Elevated) usedOsm.add(way);
          }
        }
        // Gaps (no OSM railway within reach) take the nearer neighbour's level;
        // a line with no OSM at all is assumed to be at grade.
        let last = -1;
        for (let i = 0; i < n; i++) {
          if (lv[i] !== 255) {
            for (let k = last + 1; k < i; k++) lv[k] = last < 0 || k - last > i - k ? lv[i] : lv[last];
            last = i;
          }
        }
        for (let k = last + 1; k < n; k++) lv[k] = last < 0 ? Level.Grade : lv[last];
        // A level that holds for under 40 m is a mis-snap to a crossing track.
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < n; ) {
            let j = i;
            while (j < n && lv[j] === lv[i]) j++;
            if (j - i < 4 && i > 0 && j < n && lv[i - 1] === lv[j]) for (let k = i; k < j; k++) lv[k] = lv[i - 1];
            i = j;
          }
        }
      }
      const keep = new Set<number>();
      for (let i = 1; i < n; i++) if (lv[i] !== lv[i - 1]) keep.add(i - 1), keep.add(i);
      const simple = simplify(d, keep, SIMPLIFY_M);
      // Heights are worked out per point in the app and are linear between, so
      // a straight stretch the simplifier left as two points 1.4 km apart
      // would cut through the ground between them and put the Manhattan
      // Bridge's deck curve on a chord (the Q drew at 15 m mid-span, under a
      // 41 m deck). Track that can be seen keeps a point every 30 m; tunnel
      // cannot be seen and keeps only its corners.
      const kept: number[] = [];
      for (let k = 0; k < simple.length; k++) {
        const i0 = simple[k];
        kept.push(i0);
        const i1 = simple[k + 1];
        if (i1 === undefined || a.kind === "ferry") continue;
        if (lv[i0] === Level.Tunnel && lv[i1] === Level.Tunnel) continue;
        for (let j = i0 + 3; j < i1 - 1; j += 3) kept.push(j);
      }
      // Quantise first, then measure, so the app recomputes identical s.
      const qp: number[] = [];
      const ql: number[] = [];
      for (const i of kept) qp.push(Math.round(d[i * 2] / QUANT) * QUANT, Math.round(d[i * 2 + 1] / QUANT) * QUANT), ql.push(lv[i]);
      const s: number[] = [0];
      for (let i = 2; i < qp.length; i += 2) s.push(s[s.length - 1] + Math.hypot(qp[i] - qp[i - 2], qp[i + 1] - qp[i - 1]));
      const runs: [number, number[], number[]][] = [];
      const m = qp.length / 2;
      for (let i = 0; i < m; ) {
        if (!inClip(qp[i * 2], qp[i * 2 + 1])) {
          i++;
          continue;
        }
        const a0 = Math.max(0, i - 1);
        let j = i;
        while (j < m && inClip(qp[j * 2], qp[j * 2 + 1])) j++;
        const b0 = Math.min(m - 1, j);
        runs.push([Math.round(s[a0] * 1000) / 1000, delta(qp.slice(a0 * 2, b0 * 2 + 2), QUANT), rle(ql.slice(a0, b0 + 1))]);
        i = j + 1;
      }
      if (!runs.length) {
        shapeIdx.set(id, null);
        return null;
      }
      const idx = pack.shapes.length;
      pack.shapes.push({ len: Math.round(s[s.length - 1]), runs });
      const r = { idx, pts: qp, s };
      shapeIdx.set(id, r);
      return r;
    };

    const stopIdx = new Map<string, number>();
    const stop = (id: string): number => {
      let i = stopIdx.get(id);
      if (i === undefined) {
        const si = stopInfo.get(id);
        const v = si ? o.toWorld(si.lat, si.lon) : { x: 0, z: 0 };
        i = pack.stops.length;
        stopIdx.set(id, i);
        pack.stops.push([ai, id, si?.name ?? id, Math.round(v.x / QUANT), Math.round(v.z / QUANT)]);
      }
      return i;
    };

    // Patterns.
    const patterns = new Map<string, RawPack["patterns"][number] & { tmKeys: Map<string, number> }>();
    let dropped = 0;
    for (const t of trips.values()) {
      if (t.stops.length < 2) continue;
      // stop_times are not promised to be in sequence order.
      const order = t.seq.map((_, i) => i).sort((p, q) => t.seq[p] - t.seq[q]);
      const stopsSorted = order.map((i) => t.stops[i]);
      const times = order.flatMap((i) => [t.times[i * 2], t.times[i * 2 + 1]]);
      const sh = bakeShape(t.shape, t.route);
      if (!sh) {
        dropped++;
        continue;
      }
      const key = `${t.route}|${t.shape}|${stopsSorted.join(",")}|${t.headsign}`;
      let p = patterns.get(key);
      if (!p) {
        // Each stop's arc length: the nearest point at or past the previous
        // stop's, so a loop (the Loop L, the Staten Island ferry) cannot
        // put a later stop back at an earlier pass.
        const ss: number[] = [];
        let from = 0;
        const n = sh.pts.length / 2;
        for (const sid of stopsSorted) {
          const si = stopInfo.get(sid);
          const v = si ? o.toWorld(si.lat, si.lon) : { x: 0, z: 0 };
          let best = Infinity;
          let bestS = sh.s[from];
          let bestI = from;
          for (let i = from; i + 1 < n; i++) {
            const ax = sh.pts[i * 2], az = sh.pts[i * 2 + 1], bx = sh.pts[i * 2 + 2], bz = sh.pts[i * 2 + 3];
            const vx = bx - ax, vz = bz - az;
            const L2 = vx * vx + vz * vz || 1;
            const u = Math.max(0, Math.min(1, ((v.x - ax) * vx + (v.z - az) * vz) / L2));
            const dd = Math.hypot(ax + vx * u - v.x, az + vz * u - v.z);
            // Strictly better by a metre, so the first pass wins a tie.
            if (dd < best - 1) {
              best = dd;
              bestS = sh.s[i] + u * Math.sqrt(L2);
              bestI = i;
            }
          }
          ss.push(Math.round(bestS));
          from = bestI;
        }
        // A ferry stop is the terminal building, and the shape runs up to it
        // over the pier: 296 of 527 dry Manhattan ferry positions were boats
        // standing at a stop on land. The berth is the nearest point along the
        // shape, between the neighbouring stops, that is water.
        if (a.kind === "ferry") {
          const at = (sv: number) => {
            let i = 0;
            while (i + 1 < sh.s.length - 1 && sh.s[i + 1] < sv) i++;
            const L = sh.s[i + 1] - sh.s[i] || 1;
            const u = Math.max(0, Math.min(1, (sv - sh.s[i]) / L));
            return [sh.pts[i * 2] + (sh.pts[i * 2 + 2] - sh.pts[i * 2]) * u, sh.pts[i * 2 + 1] + (sh.pts[i * 2 + 3] - sh.pts[i * 2 + 1]) * u];
          };
          const orig = ss.slice();
          for (let i = 0; i < ss.length; i++) {
            const [x, z] = at(ss[i]);
            if (wet(x, z)) continue;
            const lo = i > 0 ? (orig[i - 1] + orig[i]) / 2 : 0;
            const hi = i + 1 < ss.length ? (orig[i] + orig[i + 1]) / 2 : sh.s[sh.s.length - 1];
            for (let d = 5; d < 600; d += 5) {
              const cands = [ss[i] + d, ss[i] - d].filter((c) => c >= lo && c <= hi);
              const hit = cands.find((c) => {
                const [cx, cz] = at(c);
                return wet(cx, cz);
              });
              if (hit !== undefined) {
                // Ten metres further out, so the stern is not on the slip.
                ss[i] = Math.round(Math.max(lo, Math.min(hi, hit + Math.sign(hit - ss[i]) * 10)));
                break;
              }
            }
          }
          for (let i = 1; i < ss.length; i++) ss[i] = Math.max(ss[i], ss[i - 1]);
        }
        p = { r: routes.get(t.route)!, sh: sh.idx, hs: t.headsign, st: stopsSorted.map(stop), ss, tm: [], tr: [], tmKeys: new Map() };
        if (a.tripIds) p.tid = [];
        patterns.set(key, p);
      }
      const start = times[1];
      const rel = times.map((x) => x - start);
      const tk = rel.join(",");
      let v = p.tmKeys.get(tk);
      if (v === undefined) {
        v = p.tm.length;
        // Stored as successive differences: dwell, run, dwell... are two- and
        // three-digit numbers where the offsets themselves run to five, which
        // took the Manhattan timetable from 1376 kB to about 600 kB of JSON.
        p.tm.push(rel.map((x, i) => (i ? x - rel[i - 1] : x)));
        p.tmKeys.set(tk, v);
      }
      p.tr.push(svc(t.service), start, v);
      p.tid?.push(t.id);
    }
    for (const p of patterns.values()) {
      const { tmKeys: _drop, ...rest } = p;
      pack.patterns.push(rest);
    }
    console.log(`  ${a.id}: ${patterns.size} patterns, ${[...shapeIdx.values()].filter(Boolean).length} shapes in clip, ${dropped} trips outside or shapeless`);
  }

  // Elevated structure, from the OSM ways the shapes snapped to, minus the
  // landmark bridges that draw their own deck.
  for (const w of usedOsm) {
    const pts: number[] = [];
    for (let i = 0; i < w.pts.length; i += 2) {
      const x = w.pts[i], z = w.pts[i + 1];
      const onLandmark = landmarks.some((l) => {
        const { t, s } = axisOf(l, x, z);
        const zn = l.spec.zone!;
        return t >= zn[0] - 30 && t <= zn[1] + 30 && Math.abs(s) <= l.spec.halfWidthM + 10;
      });
      if (onLandmark || !inClip(x, z)) {
        if (pts.length >= 4) pack.structures.push(delta(pts, QUANT));
        pts.length = 0;
        continue;
      }
      pts.push(Math.round(x / QUANT) * QUANT, Math.round(z / QUANT) * QUANT);
    }
    if (pts.length >= 4) pack.structures.push(delta(pts, QUANT));
  }

  mkdirSync(OUT, { recursive: true });
  const json = JSON.stringify(pack);
  writeFileSync(`${OUT}${cityId}.json`, json);
  const gz = gzipSync(json).length;
  console.log(
    `  wrote ${cityId}.json ${(json.length / 1024).toFixed(0)} kB (${(gz / 1024).toFixed(0)} kB gzip): ` +
      `${pack.routes.length} routes, ${pack.stops.length} stops, ${pack.shapes.length} shapes, ` +
      `${pack.patterns.length} patterns, ${pack.patterns.reduce((n, p) => n + p.tr.length / 3, 0)} trips, ${pack.structures.length} structure ways`,
  );
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const ci = args.indexOf("--city");
const ids = ci >= 0 ? [args[ci + 1]] : Object.keys(CITIES);
for (const id of ids) await bakeCity(id, force);
