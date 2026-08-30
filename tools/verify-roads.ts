// Parses every .roads pack with the SAME reader the app uses and checks it is
// both whole and true. Run after any bake.
//
// Two different failures are in scope and only one of them is about bytes.
//
// The structural one is a truncated pack from an interrupted bake: it is large,
// it has a valid header, and it is on disk, so a size check and a directory
// listing both pass it happily. Only accounting for every byte proves it whole.
//
// The other is a pack that is perfectly well formed and simply wrong. Flip the
// sign of the z axis in the projection and every field is still legal, every
// length is still right, the class histogram does not move, and the whole city
// is mirrored about the origin. Nothing in the format can tell. The point
// probes below are the part that cannot be satisfied by accident: they say
// where the Golden Gate Bridge, Broadway, Lake Shore Drive and the empty water
// of Lake Michigan actually are.

import {
  LAYER_MAX,
  LAYER_MIN,
  MAX_OFFSET_M,
  parseRoadPack,
  roadLengthM,
  ROAD_CLASS_CODES,
  ROAD_CLASS_NAMES,
  RoadClass,
  SURFACE_CODES,
  type Road,
} from "../src/data/roadpack";
import { Origin } from "../src/geo";
import { readdirSync } from "node:fs";

const dir = new URL("../public/cities/", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith(".roads")).sort();

const LEGAL_CLASS = new Set<number>(ROAD_CLASS_CODES);
const LEGAL_SURFACE = new Set<number>(SURFACE_CODES);

// --- probes ---------------------------------------------------------------

interface Probe {
  name: string;
  lat: number;
  lon: number;
  /** Distance in metres the assertion is made at. */
  m: number;
  /** Classes the probe is about. Empty means "any class at all". */
  classes: RoadClass[];
  /** true: a way of these classes must be within `m`.
   *  false: no way of these classes may be within `m`. */
  want: boolean;
}

const DRIVABLE_FAST = [RoadClass.Motorway, RoadClass.Trunk];

/**
 * Places whose roads are not a matter of opinion. Every coordinate was read off
 * the real geometry: a mirrored, rotated or offset projection puts something
 * else there, and the negative probes are the half that catches the error a
 * positive probe cannot, because a mirrored city still has a motorway
 * SOMEWHERE near most points.
 */
const PROBES: Record<string, Probe[]> = {
  sf: [
    // US-101 across the Golden Gate Bridge, mid-span between the towers.
    {
      name: "Golden Gate Bridge deck is a motorway/trunk",
      lat: 37.8199, lon: -122.4783, m: 30, classes: DRIVABLE_FAST, want: true,
    },
    // The middle of Golden Gate Park, on the meadows south of Stow Lake. The
    // nearest freeway is over 2 km away, and mirroring the z axis about the sf
    // origin lands this point in the Marina/Bay instead.
    {
      name: "Golden Gate Park has no motorway/trunk",
      lat: 37.7702, lon: -122.4675, m: 30, classes: DRIVABLE_FAST, want: false,
    },
    // ... but it is full of park paths. Without this the negative above would
    // also pass on an empty pack, which is the way a "cannot fail" gate is born.
    {
      name: "Golden Gate Park does have paths",
      lat: 37.7702, lon: -122.4675, m: 80, classes: [], want: true,
    },
  ],
  manhattan: [
    // Broadway at W 42nd St, Times Square.
    {
      name: "Broadway at W 42nd is primary/secondary",
      lat: 40.7560, lon: -73.9871, m: 30,
      classes: [RoadClass.Primary, RoadClass.Secondary], want: true,
    },
  ],
  chicago: [
    // DuSable Lake Shore Drive just north of North Avenue.
    //
    // The first coordinate tried here was 41.8987, -87.6247 off Oak Street
    // Beach, which reads as 242 m from the nearest motorway: that point is on
    // the lakefront PATH, not the carriageway, and the nearest thing to it is
    // a footway 7 m away. The probe was in the wrong place, not the pack.
    {
      name: "Lake Shore Drive is a motorway/trunk",
      lat: 41.9131, lon: -87.6265, m: 30, classes: DRIVABLE_FAST, want: true,
    },
    // 2 km east of the Navy Pier head, open water. This is the probe that
    // catches a projection sign error: mirror the x axis and this point lands
    // in the Loop, which is solid streets in every direction.
    {
      name: "Lake Michigan 2 km offshore is empty",
      lat: 41.8917, lon: -87.5749, m: 200, classes: [], want: false,
    },
  ],
};

/** Distance from a point to a segment, not to its endpoints. A bridge deck is
 *  three vertices over 2 km, so a vertex-only test would miss it by 500 m. */
function pointToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

interface Nearest {
  dist: number;
  road: Road | null;
}

function nearest(roads: Road[], x: number, z: number, classes: RoadClass[]): Nearest {
  const want = classes.length === 0 ? null : new Set<number>(classes);
  let best = Infinity;
  let bestRoad: Road | null = null;
  for (const r of roads) {
    if (want !== null && !want.has(r.cls)) continue;
    // Cheap reject on the record centroid before touching the vertices. A
    // record reaches at most MAX_OFFSET_M in each axis from its centroid.
    if (Math.hypot(r.cx - x, r.cz - z) - MAX_OFFSET_M * Math.SQRT2 > best) continue;
    for (let i = 2; i < r.pts.length; i += 2) {
      const d = pointToSegment(x, z, r.pts[i - 2], r.pts[i - 1], r.pts[i], r.pts[i + 1]);
      if (d < best) {
        best = d;
        bestRoad = r;
      }
    }
  }
  return { dist: best, road: bestRoad };
}

// --- checks ---------------------------------------------------------------

let failed = 0;
const goodIds = new Set<string>();

for (const f of files) {
  const id = f.replace(/\.roads$/, "");
  const buf = await Bun.file(dir + f).arrayBuffer();
  const problems: string[] = [];

  let pack;
  try {
    pack = parseRoadPack(buf);
  } catch (err) {
    console.log(`FAIL ${id.padEnd(12)} unparseable: ${(err as Error).message}`);
    failed++;
    continue;
  }

  // Every byte must be accounted for. A pack that parses but leaves bytes over,
  // or that ran out early, is corrupt however plausible it looks.
  // Header: magic+version (8) + lat0/lon0 (16) + radius (4) + wayCount (4) = 32.
  // Record: class,lanes,flags,layer,surface,reserved (6) + vertCount (2)
  //         + cx,cz (8) = 16, plus 4 bytes per vertex.
  // Getting these two constants wrong makes the check fail on every pack at
  // once by a constant per-record amount, which is what a wrong ORACLE looks
  // like, as opposed to a real corruption, which would hit one file and by an
  // arbitrary amount.
  let expected = 32;
  for (const r of pack.roads) expected += 16 + (r.pts.length / 2) * 4;
  if (expected !== buf.byteLength) {
    problems.push(`size mismatch: records account for ${expected} of ${buf.byteLength} bytes`);
  }

  if (pack.roads.length === 0) problems.push("no ways");

  let shortWays = 0;
  let badClass = -1;
  let badSurface = -1;
  // Not a sentinel of -1: layer -1 is a legal and very common value (tunnels).
  let badLayers = 0;
  let firstBadLayer = 0;
  let tooFar = 0;
  let farthest = 0;
  let overreach = 0;
  let totalM = 0;
  const counts = new Map<number, number>();
  const limit = pack.radiusM * 1.02;

  for (const r of pack.roads) {
    const n = r.pts.length / 2;
    if (n < 2) shortWays++;
    if (!LEGAL_CLASS.has(r.cls) && badClass < 0) badClass = r.cls;
    if (!LEGAL_SURFACE.has(r.surface) && badSurface < 0) badSurface = r.surface;
    if (r.layer < LAYER_MIN || r.layer > LAYER_MAX) {
      if (badLayers === 0) firstBadLayer = r.layer;
      badLayers++;
    }
    for (let i = 0; i < r.pts.length; i += 2) {
      const d = Math.hypot(r.pts[i], r.pts[i + 1]);
      if (d > farthest) farthest = d;
      if (d > limit) tooFar++;
      // The i16 offsets cannot represent more than MAX_OFFSET_M about the
      // record centroid, so a vertex further out than that came back WRAPPED to
      // the far side of the road. It reads as a legal coordinate, which is why
      // the splitter that prevents it needs a check that can see it.
      if (Math.abs(r.pts[i] - r.cx) > MAX_OFFSET_M || Math.abs(r.pts[i + 1] - r.cz) > MAX_OFFSET_M) {
        overreach++;
      }
    }
    totalM += roadLengthM(r);
    counts.set(r.cls, (counts.get(r.cls) ?? 0) + 1);
  }

  if (shortWays) problems.push(`${shortWays} ways with under 2 vertices`);
  if (badClass >= 0) problems.push(`illegal class code ${badClass}`);
  if (badSurface >= 0) problems.push(`illegal surface code ${badSurface}`);
  if (badLayers) {
    problems.push(`${badLayers} layers outside ${LAYER_MIN}..${LAYER_MAX} (first ${firstBadLayer})`);
  }
  if (overreach) problems.push(`${overreach} vertices further than ${MAX_OFFSET_M} m from their centroid`);
  if (tooFar) {
    problems.push(
      `${tooFar} vertices outside radius*1.02 (farthest ${farthest.toFixed(0)} m, radius ${pack.radiusM})`,
    );
  }

  const origin = new Origin(pack.lat0, pack.lon0);
  const probeLines: string[] = [];
  for (const p of PROBES[id] ?? []) {
    const w = origin.toWorld(p.lat, p.lon);
    const { dist, road } = nearest(pack.roads, w.x, w.z, p.classes);
    const found = dist <= p.m;
    const ok = found === p.want;
    const what = p.classes.length === 0
      ? "any road"
      : p.classes.map((c) => ROAD_CLASS_NAMES[c]).join("/");
    const got = road === null || !Number.isFinite(dist)
      ? "nothing in the pack"
      : `${ROAD_CLASS_NAMES[road.cls]} at ${dist.toFixed(0)} m`;
    probeLines.push(
      `     ${ok ? "PASS" : "FAIL"}  ${p.name}: ${p.want ? "want" : "want NO"} ${what}` +
        ` within ${p.m} m, nearest is ${got}`,
    );
    if (!ok) problems.push(`probe "${p.name}" (nearest ${got})`);
  }

  const histogram = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${ROAD_CLASS_NAMES[c] ?? `?${c}`} ${n}`)
    .join("  ");

  if (problems.length) {
    console.log(`FAIL ${id.padEnd(12)} ${problems.join("; ")}`);
    failed++;
  } else {
    goodIds.add(id);
    console.log(
      `ok   ${id.padEnd(12)} ${String(pack.roads.length).padStart(6)} ways  ` +
        `${(totalM / 1000).toFixed(0).padStart(5)} km  ` +
        `${(buf.byteLength / 1048576).toFixed(2)} MB  at ${pack.lat0}, ${pack.lon0}`,
    );
  }
  console.log(`     ${histogram}`);
  for (const line of probeLines) console.log(line);
}

// Cross-check the index against what is actually on disk, the way
// verify-land.ts does for land-index.json. An id listed with no readable pack
// is the index making a promise the renderer cannot keep.
try {
  const listed: string[] = JSON.parse(await Bun.file(dir + "roads-index.json").text());
  const missing = listed.filter((id) => !goodIds.has(id));
  const unlisted = [...goodIds].filter((id) => !listed.includes(id));
  if (missing.length) {
    console.log(`FAIL roads-index.json lists ${missing.join(", ")} with no readable pack`);
    failed++;
  }
  if (unlisted.length) {
    console.log(`FAIL roads-index.json is missing ${unlisted.join(", ")} -- run: bun tools/bake-roads.ts`);
    failed++;
  }
} catch {
  console.log("FAIL roads-index.json missing or unreadable -- run: bun tools/bake-roads.ts");
  failed++;
}

// A pack for a city with no probes is checked for shape only, so say so rather
// than let a silent pass read as a verified one.
const probed = files.map((f) => f.replace(/\.roads$/, "")).filter((id) => (PROBES[id] ?? []).length > 0);
console.log(
  failed
    ? `\n${failed} problem(s) across ${files.length} road packs`
    : `\nall ${files.length} road packs ok, roads-index.json agrees` +
      `  (geographic probes on ${probed.join(", ") || "none"})`,
);
process.exit(failed ? 1 : 0);
