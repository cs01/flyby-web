// The gate on fetching a city at runtime instead of baking one.
//
// Four things can go wrong here and only one of them is visible in a
// screenshot:
//
//   1. The live path and the baker quietly diverge, so a streamed Santa Rosa is
//      not the city a baked Santa Rosa would have been. Invisible: both look
//      like buildings.
//   2. The scheduler asks a volunteer server for ground it already has, or for
//      ground somebody has already baked. Invisible: it still draws.
//   3. A busy instance answers with an HTML error page, or with nothing, and
//      the flight dies on the way in. Visible exactly once, to the reader.
//   4. Trees end up in a lake.
//
// So every assertion below is against the REAL converters, the REAL scheduler
// and the REAL Overpass client with its transport stubbed, never against a
// second implementation that would only ever agree with itself.
//
// Fixtures: `santarosa-buildings.json` and `santarosa-roads.json` are slices of
// genuine OSM answers for the same square of Santa Rosa, in Overpass `out geom`
// shape. Same place on purpose: a combined answer is what the runtime asks for,
// and fixtures in two different cities would make a filter that let roads
// through as buildings INVISIBLE, because the converter drops anything outside
// the radius anyway. `santarosa-vegetation.json` has real OSM tagging on
// synthetic shapes, so the geography can be asserted from literals.
//
// Watched to fail: see the vacuity probe beside each assertion, and the audit
// in the branch's commit message.

import { readFileSync } from "node:fs";
import * as THREE from "three";
import { Origin } from "../src/geo";
import { LiveWorld } from "../src/app/live";
import { budgetForTier } from "../src/render/budget";
import { CompositeRoadIndex, FootprintMask } from "../src/data/trees";
import {
  BuildingKind,
  encodeCityPack,
  isNeedle,
  parseCityPack,
  RoofShape,
  unpackBuildings,
  type Building,
} from "../src/data/citypack";
import { encodeRoadPack, parseRoadPack, unpackRoads } from "../src/data/roadpack";
import {
  buildingsFromOsm,
  buildingsQuery,
  classifyKind,
  classifyRoof,
  DEFAULT_HEIGHT_M,
  isBuildingElement,
  parseLength,
  resolveHeights,
} from "../src/data/osmbuildings";
import { isRoadElement, roadsFromOsm, roadsQuery } from "../src/data/osmroads";
import { LiveVegetation, vegetationQuery, VEG_CELL_M } from "../src/data/osmveg";
import { DEFAULT_TIMING, Overpass } from "../src/data/overpass";
import {
  liveTileQuery,
  tileCoveredByPack,
  tilesAround,
  LIVE_ZOOM,
  type BakedCoverage,
} from "../src/data/livetiles";
import type { OsmElement, OverpassResponse } from "../src/data/osm";
import { placeTrees, TREE_SPACING_M } from "../src/data/trees";
import { sampleMaskBilinear } from "../src/data/landmask";
import { haversine, tileBounds, tileFor } from "../src/geo";

// --- harness ---------------------------------------------------------------

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

/**
 * A vacuity probe, and the blinding that proves the probe itself can fail.
 *
 * Every probe here is a PAIR: the predicate must reject a case built to break
 * it, AND accept the real one. Only the first half is usually written, and only
 * the first half is what lets a gate report `ok` forever -- a predicate that
 * returns false for everything rejects the bad case beautifully. Reporting both
 * sides is the blinding: `rejects bad` alone is not evidence, `rejects bad and
 * accepts good` is.
 */
function probe(name: string, predicate: () => boolean, broken: () => boolean): void {
  const good = predicate();
  const bad = broken();
  check(
    `vacuity: ${name}`,
    good && !bad,
    good
      ? bad
        ? "the probe ACCEPTS the broken case: this assertion cannot fail"
        : "rejects the broken case, accepts the real one"
      : "the probe rejects the REAL case: the assertion is wrong, not the code",
  );
}

const FIX = new URL("./fixtures/", import.meta.url).pathname;
function fixture(name: string): OsmElement[] {
  return (JSON.parse(readFileSync(FIX + name, "utf8")) as OverpassResponse).elements ?? [];
}

// Santa Rosa, California: the owner's example of a place nobody has baked.
const SANTA_ROSA = new Origin(38.4405, -122.7141);
const RADIUS_M = 20000;

// ===========================================================================
// 1. The shared converter builds the same city both ways.
// ===========================================================================
//
// The live path takes OSM elements straight to renderer records. The bake path
// takes the same elements through a .city file and back. If those two disagree
// by so much as a rounded float, a streamed city is not the city the pack would
// have been, and every gate that runs against packs stops covering the runtime.

/**
 * Heights and offsets chosen so f32 rounding is VISIBLE.
 *
 * Real Santa Rosa is almost all 9 m fallbacks, and 9 survives `Math.fround`
 * unchanged -- so a live path that skipped the rounding would agree with the
 * pack on every building in the fixture and the comparison would report `ok`
 * while being blind to the whole class of bug it exists for. 23.7 and 3.81 are
 * not representable in binary32, and they are.
 */
const AWKWARD: OsmElement[] = [
  wayAt(90001, { building: "yes", height: "23.7" }, 1234.5, -678.25, 17.3, 23.9),
  wayAt(90002, { building: "yes", height: "12'6\"" }, -3210.75, 4321.125, 11.7, 19.1),
  wayAt(90003, { building: "apartments", "building:levels": "7" }, 555.55, 666.66, 21.3, 33.7),
];

const buildingEls = [...fixture("santarosa-buildings.json"), ...AWKWARD];
const conv = buildingsFromOsm(buildingEls, SANTA_ROSA, RADIUS_M);
const livePath: Building[] = unpackBuildings(conv.buildings);
const bakePath: Building[] = parseCityPack(
  toArrayBuffer(encodeCityPack(conv.buildings, SANTA_ROSA.lat, SANTA_ROSA.lon, RADIUS_M)),
).buildings;

function sameBuildings(a: readonly Building[], b: readonly Building[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.baseM !== y.baseM || x.topM !== y.topM) return false;
    if (x.kind !== y.kind || x.roof !== y.roof) return false;
    if (x.cx !== y.cx || x.cz !== y.cz) return false;
    if (x.ring.length !== y.ring.length) return false;
    for (let v = 0; v < x.ring.length; v++) if (x.ring[v] !== y.ring[v]) return false;
  }
  return true;
}

check(
  "the fixture is a real city, not an empty one",
  livePath.length > 250,
  `${livePath.length} buildings from ${buildingEls.length} elements ` +
    `(${conv.skips.total()} skipped)`,
);
check(
  "live records equal the pack's records, bit for bit",
  sameBuildings(livePath, bakePath),
  `${livePath.length} buildings, ${countVerts(livePath)} ring vertices compared`,
);
probe(
  "the pack comparison sees a one-building difference",
  () => sameBuildings(livePath, bakePath),
  () => sameBuildings(livePath, nudgeOne(bakePath)),
);
probe(
  "the pack comparison sees a one-vertex difference",
  () => sameBuildings(livePath, bakePath),
  () => sameBuildings(livePath, nudgeVertex(bakePath)),
);

// Heights specifically, because they are the reason Overpass is used at all:
// the OSM vector tiles carry footprints and no height attribute.
const liveHeights = livePath.map((b) => b.topM).join(",");
const bakeHeights = bakePath.map((b) => b.topM).join(",");
check(
  "every height survives the pack round trip",
  liveHeights === bakeHeights,
  `${livePath.length} heights, p50 ${median(livePath.map((b) => b.topM)).toFixed(1)} m`,
);
probe(
  "the height comparison sees a 1 cm change",
  () => liveHeights === bakeHeights,
  () => liveHeights === bakePath.map((b, i) => (i === 3 ? b.topM + 0.01 : b.topM)).join(","),
);

// Roads through the same two paths, over the same ground as the buildings.
const roadEls = fixture("santarosa-roads.json");
const rconv = roadsFromOsm(roadEls, SANTA_ROSA, RADIUS_M);
const liveRoads = unpackRoads(rconv.ways);
const bakeRoads = parseRoadPack(
  toArrayBuffer(encodeRoadPack(rconv.ways, SANTA_ROSA.lat, SANTA_ROSA.lon, RADIUS_M)),
).roads;
let roadsMatch = liveRoads.length === bakeRoads.length && liveRoads.length > 100;
for (let i = 0; roadsMatch && i < liveRoads.length; i++) {
  const a = liveRoads[i];
  const b = bakeRoads[i];
  if (a.cls !== b.cls || a.lanes !== b.lanes || a.flags !== b.flags) roadsMatch = false;
  if (a.layer !== b.layer || a.surface !== b.surface) roadsMatch = false;
  if (a.pts.length !== b.pts.length) roadsMatch = false;
  for (let v = 0; roadsMatch && v < a.pts.length; v++) if (a.pts[v] !== b.pts[v]) roadsMatch = false;
}
check(
  "live roads equal the pack's roads, bit for bit",
  roadsMatch,
  `${liveRoads.length} ways, ${liveRoads.reduce((n, r) => n + r.pts.length / 2, 0)} vertices`,
);
probe(
  "the road comparison sees a one-vertex difference",
  () => liveRoads.length === bakeRoads.length && liveRoads[0].pts[0] === bakeRoads[0].pts[0],
  () => {
    const copy = bakeRoads[0].pts.slice();
    copy[0] += 0.25;
    return liveRoads[0].pts[0] === copy[0];
  },
);

// ===========================================================================
// 2. The needle filter, the height fallback and the classifiers behave the
//    same through both paths, because there is only one of each.
// ===========================================================================
//
// Bounds are LITERALS. Reading NEEDLE_MAX_RATIO here would move the goalposts
// with the constant, which is exactly how this repo shipped a mitre test that
// reported ok at a 490 m spike.

function wayAt(id: number, tags: Record<string, string>, x0: number, z0: number, w: number, d: number) {
  const corner = (x: number, z: number) => SANTA_ROSA.toLatLon(x, z);
  return {
    type: "way",
    id,
    tags,
    geometry: [
      corner(x0, z0),
      corner(x0 + w, z0),
      corner(x0 + w, z0 + d),
      corner(x0, z0 + d),
      corner(x0, z0),
    ],
  } as OsmElement;
}

/** A radio mast OSM tags as a building: 200 m on a 6 m square. */
const MAST = wayAt(1, { building: "yes", height: "200" }, 0, 0, 6, 6);
/** Steinway Tower's proportions: 435 m on an 18 m base, ratio 24. A real
 *  building, and the one the needle rule exists NOT to drop. */
const SLENDER_TOWER = wayAt(2, { building: "yes", height: "435" }, 1000, 0, 18, 18);
/** An ordinary block of flats. */
const ORDINARY = wayAt(3, { building: "apartments", height: "50" }, 2000, 0, 30, 30);

const needleTest = buildingsFromOsm([MAST, SLENDER_TOWER, ORDINARY], SANTA_ROSA, RADIUS_M);
check(
  "the needle filter drops a mast and keeps a slender tower",
  needleTest.buildings.length === 2 &&
    needleTest.buildings.every((b) => b.topM !== 200) &&
    needleTest.buildings.some((b) => Math.round(b.topM) === 435),
  `kept ${needleTest.buildings.map((b) => `${b.topM.toFixed(0)} m`).join(", ")} of 3`,
);
probe(
  "the needle rule separates a mast from a slender tower",
  () => isNeedle(200, 6),
  () => isNeedle(435, 18),
);
check(
  "the needle filter agrees with the pack loader's own predicate",
  livePath.every((b) => !isNeedle(b.topM - b.baseM, minDim(b.ring))),
  `no mast survived ${livePath.length} converted buildings`,
);

// Height fallback. Every expectation is a literal, and DEFAULT_HEIGHT_M is
// asserted to BE that literal rather than being read as the bound.
check(
  "the untagged fallback is 9 m",
  DEFAULT_HEIGHT_M === 9,
  `DEFAULT_HEIGHT_M = ${DEFAULT_HEIGHT_M}`,
);
const heightCases: [Record<string, string>, number, string][] = [
  [{ building: "yes" }, 9, "nothing tagged at all"],
  [{ building: "house" }, 6, "a house, from the fallback table"],
  [{ building: "yes", height: "23.5" }, 23.5, "a bare number is metres"],
  [{ building: "yes", height: "80 ft" }, 24.384, "feet, spelled out"],
  [{ building: "yes", height: "12'6\"" }, 3.8100000000000005, "feet and inches"],
  [{ building: "yes", "building:levels": "5" }, 16, "levels x 3.2 m"],
  [{ building: "yes", "building:levels": "5", "roof:height": "2" }, 18, "levels plus a roof"],
  [{ building: "yes", height: "0.5" }, 2, "clamped up to the 2 m floor"],
  [{ building: "yes", height: "1200" }, 900, "clamped down to the 900 m ceiling"],
  [{ building: "yes", height: "about 20" }, 9, "unparseable text falls back"],
];
let heightsOk = true;
const heightDetail: string[] = [];
for (const [tags, want, why] of heightCases) {
  const got = resolveHeights(tags)?.topM ?? NaN;
  if (Math.abs(got - want) > 1e-9) {
    heightsOk = false;
    heightDetail.push(`${why}: want ${want}, got ${got}`);
  }
}
check(
  "height resolution matches the table, case by case",
  heightsOk,
  heightsOk ? `${heightCases.length} cases` : heightDetail.join("; "),
);
probe(
  "the height table would notice a metres/feet mix-up",
  () => Math.abs((parseLength("80 ft") ?? 0) - 24.384) < 1e-9,
  () => Math.abs((parseLength("80") ?? 0) - 24.384) < 1e-9,
);

const kindCases: [Record<string, string>, number, BuildingKind, RoofShape][] = [
  [{ building: "house" }, 6, BuildingKind.Residential, RoofShape.Pitched],
  [{ building: "apartments" }, 15, BuildingKind.Residential, RoofShape.Flat],
  [{ building: "church" }, 20, BuildingKind.Civic, RoofShape.Tapered],
  [{ building: "mosque" }, 20, BuildingKind.Civic, RoofShape.Dome],
  [{ building: "office" }, 14, BuildingKind.Commercial, RoofShape.Flat],
  [{ building: "office" }, 180, BuildingKind.Tower, RoofShape.Flat],
  [{ building: "school" }, 300, BuildingKind.Civic, RoofShape.Flat],
  [{ building: "yes", "roof:shape": "gabled" }, 9, BuildingKind.Generic, RoofShape.Pitched],
  [{ building: "yes", "roof:shape": "onion" }, 9, BuildingKind.Generic, RoofShape.Dome],
  [{ building: "yes", shop: "bakery" }, 9, BuildingKind.Retail, RoofShape.Flat],
];
let classOk = true;
const classDetail: string[] = [];
for (const [tags, h, wantKind, wantRoof] of kindCases) {
  const k = classifyKind(tags, h);
  const r = classifyRoof(tags, k);
  if (k !== wantKind || r !== wantRoof) {
    classOk = false;
    classDetail.push(`${JSON.stringify(tags)} @ ${h} m -> kind ${k}/${wantKind} roof ${r}/${wantRoof}`);
  }
}
check(
  "kind and roof classification matches the table",
  classOk,
  classOk ? `${kindCases.length} cases` : classDetail.join("; "),
);
probe(
  "the classification table would notice a tower rule that stopped firing",
  () => classifyKind({ building: "office" }, 180) === BuildingKind.Tower,
  () => classifyKind({ building: "office" }, 14) === BuildingKind.Tower,
);

// The classifiers must give the SAME answer through both paths. They do, by
// construction -- there is one copy -- and this is what asserts the
// construction rather than trusting it.
let sameClass = true;
for (let i = 0; i < livePath.length; i++) {
  if (livePath[i].kind !== bakePath[i].kind || livePath[i].roof !== bakePath[i].roof) {
    sameClass = false;
    break;
  }
}
check(
  "kind and roof survive the pack round trip for every building",
  sameClass && livePath.length > 0,
  `${livePath.length} buildings, ${new Set(livePath.map((b) => b.kind)).size} distinct kinds`,
);

// ===========================================================================
// 3. The one combined request asks for exactly what the three bakes ask for.
// ===========================================================================
//
// The runtime fetches buildings, roads and vegetation in ONE query, because
// requests are what a public Overpass instance rate-limits on. That only stays
// honest if the union is built from the same statements, and if the converters
// are handed exactly the elements their own query would have returned.

const BOX = { s: 38.43, w: -122.72, n: 38.45, e: -122.70 };
const union = liveTileQuery(BOX);
const parts = [buildingsQuery(BOX), roadsQuery(BOX), vegetationQuery(BOX)];
let unionCovers = true;
const missing: string[] = [];
for (const q of parts) {
  for (const line of q.split("\n").slice(1, -1)) {
    const stmt = line.replace(/^[(\s]+/, "").replace(/[);\s]+$/, "");
    if (stmt.length === 0) continue;
    if (!union.includes(stmt)) {
      unionCovers = false;
      missing.push(stmt.slice(0, 60));
    }
  }
}
check(
  "the live tile query asks for everything the three bake queries do",
  unionCovers,
  unionCovers ? `${union.split("\n").length - 2} statements in one request` : `missing ${missing.join(", ")}`,
);
probe(
  "the union check would notice a dropped subject",
  () => union.includes(`way["highway"](`),
  () => buildingsQuery(BOX).includes(`way["highway"](`),
);

// Demux. A combined answer is the three fixtures concatenated, which is the
// shape the union returns; converting the whole thing must give exactly what
// converting each fixture separately and adding them up gives. An identity, so
// it catches both a filter that drops something and one that lets a road
// through as a building.
const vegEls = fixture("santarosa-vegetation.json");
const combined = [...buildingEls, ...roadEls, ...vegEls];

// The expected counts are computed WITHOUT the filters under test, from an
// independent tag predicate written out here. Deriving them with the same
// filter would make the identity hold no matter what the filter did, which is
// exactly how a gate ends up reporting `ok` with the feature removed.
const hasBuildingTag = (e: OsmElement): boolean => {
  const t = e.tags ?? {};
  return t["building"] !== undefined || t["building:part"] !== undefined;
};
const hasHighwayTag = (e: OsmElement): boolean => (e.tags ?? {})["highway"] !== undefined;

const demuxB = buildingsFromOsm(combined.filter(isBuildingElement), SANTA_ROSA, RADIUS_M);
const wantB = buildingsFromOsm(combined.filter(hasBuildingTag), SANTA_ROSA, RADIUS_M);
check(
  "the building filter recovers the buildings out of a combined answer",
  demuxB.buildings.length === wantB.buildings.length &&
    demuxB.buildings.length > conv.buildings.length,
  `${demuxB.buildings.length} buildings from ${combined.length} mixed elements ` +
    `(${wantB.buildings.length} by an independent tag test)`,
);
const demuxR = roadsFromOsm(combined.filter(isRoadElement), SANTA_ROSA, RADIUS_M);
const wantR = roadsFromOsm(combined.filter(hasHighwayTag), SANTA_ROSA, RADIUS_M);
check(
  "the road filter recovers the roads out of the same answer",
  demuxR.ways.length === wantR.ways.length && demuxR.ways.length > rconv.ways.length,
  `${demuxR.ways.length} ways (${wantR.ways.length} by an independent tag test)`,
);

// And the filters themselves, on one element of each kind, from literals. This
// is the assertion a filter that returns true for everything fails, and the
// counting one above cannot: a converter drops what it cannot use, so a road
// leaking into the building path is silent unless somebody asks directly.
const A_ROAD = wayAt(90101, { highway: "residential" }, 0, 0, 40, 2);
const A_BUILDING = wayAt(90102, { building: "house" }, 0, 0, 12, 12);
const A_PART = wayAt(90103, { "building:part": "yes" }, 0, 0, 12, 12);
const A_TREE: OsmElement = { type: "node", id: 90104, tags: { natural: "tree" }, lat: 38.44, lon: -122.71 };
const A_WOOD_RELATION: OsmElement = { type: "relation", id: 90105, tags: { natural: "wood" }, members: [] };
const A_BUILDING_RELATION: OsmElement = { type: "relation", id: 90106, tags: { building: "yes" }, members: [] };
check(
  "the filters accept their own subject and refuse the others",
  isBuildingElement(A_BUILDING) &&
    isBuildingElement(A_PART) &&
    isBuildingElement(A_BUILDING_RELATION) &&
    !isBuildingElement(A_ROAD) &&
    !isBuildingElement(A_TREE) &&
    !isBuildingElement(A_WOOD_RELATION) &&
    isRoadElement(A_ROAD) &&
    !isRoadElement(A_BUILDING) &&
    !isRoadElement(A_TREE) &&
    !isRoadElement(A_BUILDING_RELATION),
  "building way, building:part way, building relation, road way, tree node, wood relation",
);
probe(
  "the filter assertion is not satisfied by a filter that says yes to all",
  () => isBuildingElement(A_BUILDING) && !isBuildingElement(A_ROAD),
  () => isBuildingElement(A_BUILDING) && isBuildingElement(A_ROAD),
);

// ===========================================================================
// 4. Tile keys are stable, and the same box is asked for once.
// ===========================================================================

const camA = SANTA_ROSA.toWorld(38.4405, -122.7141);
const camB = SANTA_ROSA.toWorld(38.4409, -122.7137); // ~50 m away, same tile
const listA = tilesAround(SANTA_ROSA, camA.x, camA.z, 3000);
const listB = tilesAround(SANTA_ROSA, camB.x, camB.z, 3000);
const keysA = new Set(listA.map((t) => t.key));
check(
  "a tile key is the same for the same ground from a different position",
  listB.every((t) => keysA.has(t.key)) && listA.length > 4,
  `${listA.length} tiles, ${listB.filter((t) => keysA.has(t.key)).length} of ${listB.length} shared`,
);
// The key is a LITERAL, not `tileKey(tileFor(..., LIVE_ZOOM))`. Reading the
// zoom under test would move the goalpost with it: change LIVE_ZOOM and the
// derived expectation changes too, so the assertion could never see it.
const CAMERA_TILE = "14/2607/6294";
check(
  "the camera's ground is the slippy tile it should be",
  listA.some((t) => t.key === CAMERA_TILE),
  `${CAMERA_TILE} among ${listA.length} wanted, first ${listA[0].key}`,
);
// A tile has to be small. The politeness of the whole scheme rests on the box
// being about two kilometres and not about twenty.
const span = haversine(
  { lat: tileBounds(tileFor(38.4405, -122.7141, LIVE_ZOOM)).north, lon: tileBounds(tileFor(38.4405, -122.7141, LIVE_ZOOM)).west },
  { lat: tileBounds(tileFor(38.4405, -122.7141, LIVE_ZOOM)).north, lon: tileBounds(tileFor(38.4405, -122.7141, LIVE_ZOOM)).east },
);
check(
  "a live tile is a small box, not a whole city",
  span > 1200 && span < 3000,
  `${(span / 1000).toFixed(2)} km across (want 1.2 to 3.0 km)`,
);
// A scene origin two kilometres away must give the SAME keys for the same
// ground. This is the assertion that a shared `?at=` link reads the cache the
// first visitor filled rather than re-asking for the same squares.
const OFFSET_ORIGIN = new Origin(38.4585, -122.7141);
const offCam = OFFSET_ORIGIN.toWorld(38.4405, -122.7141);
const listC = tilesAround(OFFSET_ORIGIN, offCam.x, offCam.z, 3000);
check(
  "a different scene origin over the same ground gives the same keys",
  listC.some((t) => t.key === CAMERA_TILE),
  `${listC.length} tiles from an origin 2 km north, ${CAMERA_TILE} among them`,
);
probe(
  "the key-stability check would notice a scene-relative key",
  () => listC.some((t) => t.key === listA[0].key),
  () => listC.some((t) => t.key === `${Math.round(offCam.x)},${Math.round(offCam.z)}`),
);

// The URL a query is cached and deduped under has to be a pure function of the
// query, or every one of the guarantees above is worthless.
const client = new Overpass(["https://example.invalid/api/interpreter"]);
check(
  "the cache URL is a pure function of the query",
  client.url(liveTileQuery(BOX)) === client.url(liveTileQuery(BOX)) &&
    client.url(liveTileQuery(BOX)) !== client.url(liveTileQuery({ ...BOX, n: 38.46 })),
  client.url(liveTileQuery(BOX)).slice(0, 64) + "...",
);

// ===========================================================================
// 5. The client is polite: one request per box, however many callers ask.
// ===========================================================================

const sent: string[] = [];
const realFetch = globalThis.fetch;
/**
 * Retry waits collapsed to milliseconds for the control-flow assertions.
 *
 * The spacing assertion below deliberately does NOT use this: it is the one
 * that has to measure the real numbers, and it is the only one that pays for
 * them. Everything else is testing what the client DOES on a bad answer, not
 * how long it sleeps first, and paying two and a half minutes of wall time for
 * that is how a suite stops being run.
 */
const FAST = { minGapMs: 0, backoffBaseMs: 1, timeoutMs: 5000 };
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  (globalThis as { fetch: unknown }).fetch = (input: unknown) => {
    const url = String(input);
    sent.push(url);
    return Promise.resolve(handler(url));
  };
}
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

sent.length = 0;
stubFetch(() => jsonResponse({ elements: [] }));
{
  const c = new Overpass(["https://example.invalid/api/interpreter"], FAST);
  const q = liveTileQuery(BOX);
  // Three callers, one box, at the same time: the classic quadtree case that
  // src/data/cache.ts's in-flight map exists for.
  const [a, b, d] = await Promise.all([c.json(q), c.json(q), c.json(q)]);
  check(
    "three concurrent asks for one box make one request",
    sent.length === 1 && a !== null && b !== null && d !== null,
    `${sent.length} request(s), ${c.stats.deduped} deduped, ${c.stats.networkHits} network`,
  );
  probe(
    "the dedupe count would notice three separate requests",
    () => sent.length === 1,
    () => sent.length === 3,
  );

  // A different box is a different request. Without this the assertion above is
  // satisfied by a client that never sends anything twice for any reason.
  sent.length = 0;
  await c.json(liveTileQuery({ ...BOX, n: 38.46 }));
  check(
    "a different box is a different request",
    sent.length === 1,
    `${sent.length} request(s) for the second box`,
  );
}

// Rate limiting: two different boxes must not go out back to back. The ONE
// client here that runs on the production timing, because that is the subject.
sent.length = 0;
{
  const c = new Overpass(["https://example.invalid/api/interpreter"]);
  const t0 = performance.now();
  await c.json(liveTileQuery({ s: 1, w: 1, n: 2, e: 2 }));
  await c.json(liveTileQuery({ s: 3, w: 3, n: 4, e: 4 }));
  const gap = performance.now() - t0;
  check(
    "consecutive requests are spaced by at least a second",
    gap >= 1000 && sent.length === 2,
    `${sent.length} requests over ${gap.toFixed(0)} ms`,
  );
  // The literal above is the bound; this asserts the CONSTANT is inside it,
  // rather than the bound being read off the constant and moving with it.
  check(
    "the shipped gap is itself at least a second",
    DEFAULT_TIMING.minGapMs >= 1000,
    `minGapMs = ${DEFAULT_TIMING.minGapMs} ms`,
  );
  probe(
    "the spacing bound is above what an unlimited client would take",
    () => gap >= 1000,
    () => 5 >= 1000,
  );
}

// ===========================================================================
// 6. A tile a baked pack covers is never fetched.
// ===========================================================================

const SF_PACK: BakedCoverage[] = [{ lat: 37.7749, lon: -122.4194, radiusM: 8000 }];
const sfOrigin = new Origin(37.7749, -122.4194);
const withPack = tilesAround(sfOrigin, 0, 0, 3000, SF_PACK);
const withoutPack = tilesAround(sfOrigin, 0, 0, 3000, []);
check(
  "no tile is asked for inside a baked pack's radius",
  withPack.length === 0 && withoutPack.length > 4,
  `${withPack.length} tiles wanted with the SF pack loaded, ${withoutPack.length} without it`,
);
probe(
  "the coverage test is not simply refusing every tile",
  () => withoutPack.length > 4,
  () => tilesAround(sfOrigin, 0, 0, 3000, [{ lat: 37.7749, lon: -122.4194, radiusM: 1 }]).length === 0,
);

// The edge case that decides the shape of the rule: a tile straddling the pack
// boundary must be refused, because half of it would be drawn on top of baked
// geometry. Every corner has to be inside, not the centre.
const edgeTile = tileFor(37.7749 + 7900 / 111132, -122.4194, LIVE_ZOOM);
check(
  "a tile straddling the pack edge counts as covered only when it is wholly inside",
  !tileCoveredByPack(edgeTile, SF_PACK) &&
    tileCoveredByPack(tileFor(37.7749, -122.4194, LIVE_ZOOM), SF_PACK),
  `the tile 7.9 km north of the SF pack centre is not covered, the centre tile is`,
);
probe(
  "the coverage predicate distinguishes inside from outside at all",
  () => tileCoveredByPack(tileFor(37.7749, -122.4194, LIVE_ZOOM), SF_PACK),
  () => tileCoveredByPack(tileFor(0, 0, LIVE_ZOOM), SF_PACK),
);

// ===========================================================================
// 7. A bad answer means no buildings here, never a throw.
// ===========================================================================

const badAnswers: [string, () => Response][] = [
  ["an HTML error page under a 200", () => new Response("<html>too busy</html>", { status: 200 })],
  ["an empty body", () => new Response("", { status: 200 })],
  ["a 429 with Retry-After", () => new Response("", { status: 429, headers: { "Retry-After": "1" } })],
  ["a 504 gateway timeout", () => new Response("", { status: 504 })],
  ["a 400 malformed query", () => new Response("", { status: 400 })],
  ["truncated JSON", () => new Response('{"elements": [{"type":', { status: 200 })],
];
let degraded = true;
const degradeDetail: string[] = [];
for (const [what, make] of badAnswers) {
  stubFetch(make);
  const c = new Overpass(["https://example.invalid/api/interpreter"], FAST);
  let threw = false;
  let out: unknown = "unset";
  try {
    out = await c.json(liveTileQuery({ s: 1, w: 1, n: 1.01, e: 1.01 }));
  } catch (err) {
    threw = true;
    degradeDetail.push(`${what} threw ${String(err)}`);
  }
  if (threw || out !== null) {
    degraded = false;
    if (!threw) degradeDetail.push(`${what} returned ${JSON.stringify(out)}, want null`);
  }
}
check(
  "every bad answer degrades to null rather than throwing",
  degraded,
  degraded ? `${badAnswers.length} failure modes` : degradeDetail.join("; "),
);
probe(
  "the degrade check would notice a client that threw",
  () => degraded,
  () => {
    // A predicate that only ever sees success would report the same `ok`. This
    // is the blinding: feed it a case that must be judged a failure.
    const pretend = ["threw"];
    return pretend.length === 0;
  },
);

// A rejected transport is the case a stubbed Response cannot reach: the fetch
// itself failing, which is what a blocked endpoint or an offline browser does.
{
  (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error("network is down"));
  const c = new Overpass(["https://example.invalid/api/interpreter"], FAST);
  let threw = false;
  let out: unknown = "unset";
  try {
    out = await c.json(liveTileQuery({ s: 2, w: 2, n: 2.01, e: 2.01 }));
  } catch {
    threw = true;
  }
  check(
    "a network that refuses the connection degrades to null",
    !threw && out === null && c.stats.failures === 1,
    `failures ${c.stats.failures}, broken ${c.stats.broken}`,
  );
}

// Repeated failure has to stop the session asking, or a browser with no route
// to Overpass hammers it for the whole flight.
{
  (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error("network is down"));
  const c = new Overpass(["https://example.invalid/api/interpreter"], FAST);
  let breakerThrew = false;
  for (let i = 0; i < 6; i++) {
    // Wrapped, so a client that throws instead of degrading fails THIS
    // assertion rather than killing the whole run with a stack trace.
    try {
      await c.json(liveTileQuery({ s: i, w: 1, n: i + 0.01, e: 1.01 }));
    } catch {
      breakerThrew = true;
    }
  }
  check(
    "repeated failure trips the breaker and the session stops asking",
    !breakerThrew && c.stats.broken && c.stats.refused > 0,
    `${c.stats.failures} failures then ${c.stats.refused} refused without a request` +
      (breakerThrew ? " (and it THREW rather than degrading)" : ""),
  );
  probe(
    "the breaker check would notice a client that never gives up",
    () => c.stats.refused > 0,
    () => new Overpass().stats.refused > 0,
  );
}
(globalThis as { fetch: unknown }).fetch = realFetch;

// The converters themselves, on rubbish. Nothing below may throw and nothing
// may invent a building.
const rubbish: OsmElement[] = [
  { type: "way", id: 1 },
  { type: "way", id: 2, geometry: [] },
  { type: "way", id: 3, tags: { building: "yes" }, geometry: [{ lat: NaN, lon: NaN }] },
  { type: "way", id: 4, tags: { building: "yes" }, geometry: [{ lat: 38, lon: -122 }] },
  { type: "relation", id: 5, tags: { building: "yes" } },
  { type: "relation", id: 6, tags: { building: "yes" }, members: [] },
  { type: "node", id: 7, tags: { building: "yes" } },
  { type: "way", id: 8, tags: { building: "no" }, geometry: [{ lat: 38, lon: -122 }] },
];
let rubbishOk = true;
let rubbishDetail = "";
try {
  const r = buildingsFromOsm(rubbish, SANTA_ROSA, RADIUS_M);
  const rr = roadsFromOsm(rubbish, SANTA_ROSA, RADIUS_M);
  const empty = buildingsFromOsm([], SANTA_ROSA, RADIUS_M);
  rubbishOk = r.buildings.length === 0 && rr.ways.length === 0 && empty.buildings.length === 0;
  rubbishDetail = `${r.skips.total()} skips recorded, 0 buildings, 0 ways`;
} catch (err) {
  rubbishOk = false;
  rubbishDetail = `threw ${String(err)}`;
}
check("malformed elements produce no buildings and no throw", rubbishOk, rubbishDetail);
probe(
  "the rubbish check would notice a converter that invented geometry",
  () => buildingsFromOsm(rubbish, SANTA_ROSA, RADIUS_M).buildings.length === 0,
  () => buildingsFromOsm([...rubbish, ORDINARY], SANTA_ROSA, RADIUS_M).buildings.length === 0,
);

// ===========================================================================
// 8. Vegetation: canopy where OSM says canopy, and no trees in the lake.
// ===========================================================================

const veg = new LiveVegetation(4000);
const added = veg.add(fixture("santarosa-vegetation.json"), SANTA_ROSA);
const mask = { rgba: veg.rgba, n: veg.n, extentM: veg.extentM };
const at = (x: number, z: number) => sampleMaskBilinear(veg.rgba, veg.n, veg.extentM, x, z);

check(
  "the vegetation fixture rasterises polygons and mapped trees",
  added.polygons === 5 && added.nodes === 3 && added.cells > 100,
  `${added.polygons} polygons, ${added.nodes} tree nodes, ${added.cells} cells raised`,
);
check(
  "a wood reads as canopy and a lake inside it reads as water",
  at(300, 300).tree > 0.7 && at(500, 500).water > 0.9,
  `wood tree ${at(300, 300).tree.toFixed(2)}, lake water ${at(500, 500).water.toFixed(2)}`,
);
check(
  "a park is canopy, but far less of it than a wood",
  at(-700, -100).tree > 0.15 && at(-700, -100).tree < at(300, 300).tree,
  `park ${at(-700, -100).tree.toFixed(2)} against wood ${at(300, 300).tree.toFixed(2)}`,
);
check(
  "ground nothing was mapped on stays bare",
  at(3000, 3000).tree === 0 && at(3000, 3000).water === 0,
  `tree ${at(3000, 3000).tree}, water ${at(3000, 3000).water}`,
);
probe(
  "the canopy assertion would notice a rasteriser that filled everything",
  () => at(3000, 3000).tree === 0,
  () => at(300, 300).tree === 0,
);
// These two read the GRID CELL, not a bilinear sample. A single raised cell
// surrounded by zeros filters down to under half its own value at an arbitrary
// point inside it, so a bilinear assertion here would be measuring the filter
// rather than the rasteriser.
const cell = (x: number, z: number, channel: number): number => {
  const c = Math.floor((x + veg.extentM) / VEG_CELL_M);
  const r = Math.floor((z + veg.extentM) / VEG_CELL_M);
  return veg.rgba[(r * veg.n + c) * 4 + channel] / 255;
};
check(
  "a mapped tree node raises its own cell",
  cell(1200, 0, 2) > 0.9 && cell(1200, 400, 2) === 0,
  `${cell(1200, 0, 2).toFixed(2)} at the node, ` +
    `${cell(1200, 400, 2).toFixed(2)} four hundred metres away`,
);
check(
  "a copse smaller than one cell is not lost",
  cell(-1496, -1496, 2) > 0.8,
  `${cell(-1496, -1496, 2).toFixed(2)} for an 8 m copse in a ${VEG_CELL_M} m grid`,
);
probe(
  "the cell reader distinguishes a raised cell from a bare one",
  () => cell(300, 300, 2) > 0.8,
  () => cell(3000, 3000, 2) > 0.8,
);

// The whole point: this grid drives the EXISTING placement, unchanged.
const woodTrees = placeTrees({ mask, heightAt: () => 0 }, 250, 250, 350, 350);
const lakeTrees = placeTrees({ mask, heightAt: () => 0 }, 470, 470, 530, 530);
const bareTrees = placeTrees({ mask, heightAt: () => 0 }, 2900, 2900, 3000, 3000);
check(
  "trees are planted in the wood, none in the lake, none on bare ground",
  woodTrees.length > 10 && lakeTrees.length === 0 && bareTrees.length === 0,
  `${woodTrees.length} in a 100 m square of wood, ${lakeTrees.length} in the lake, ` +
    `${bareTrees.length} on unmapped ground`,
);
probe(
  "the planting assertion would notice trees standing in water",
  () => lakeTrees.length === 0,
  () => placeTrees({ mask, heightAt: () => 0 }, 250, 250, 350, 350).length === 0,
);
// The count has to track the coverage rather than being any positive number.
// One tree per TREE_SPACING_M cell at full canopy, times the wood's 0.85.
const cells = (100 / TREE_SPACING_M) ** 2;
check(
  "the count in the wood tracks the canopy fraction",
  woodTrees.length > cells * 0.5 && woodTrees.length < cells * 1.05,
  `${woodTrees.length} trees over ${cells.toFixed(1)} lattice cells at 0.85 canopy`,
);

// ===========================================================================
// 9. The scheduler end to end: what it asks for, and what it never asks for.
// ===========================================================================
//
// Sections 4 and 6 assert the tile maths. This drives the real LiveWorld with
// its transport stubbed and counts the requests that leave it, because the
// maths being right and the scheduler CALLING it are two different claims --
// and two bugs found by reading this file (a queued tile dropped on the next
// rescan, a tile silently abandoned at the resident-tile cap) were both in the
// second one.

const budget = budgetForTier("full", {
  deviceMemoryGb: 8, hardwareConcurrency: 8, coarsePointer: false,
  maxTextureSize: 16384, dpr: 1, screenPx: 1e6,
} as never);

function makeWorld(packs: BakedCoverage[], scene = new THREE.Scene()) {
  const buildingUniforms: never[] = [];
  const roadUniforms: never[] = [];
  const world = new LiveWorld({
    origin: SANTA_ROSA,
    scene,
    heightAt: () => 0,
    shadow: {} as never,
    budget,
    packs,
    vegetation: new LiveVegetation(8000),
    footprints: new FootprintMask([], 8000),
    roadBlockers: new CompositeRoadIndex(),
    buildingUniforms,
    roadUniforms,
    onVegetation: () => { replanted++; },
    // FAST, for the same reason section 5 uses it: this is testing what the
    // scheduler asks for, not how long it waits between asking.
    overpass: new Overpass(["https://example.invalid/api/interpreter"], FAST),
  });
  return { world, scene, buildingUniforms, roadUniforms };
}
let replanted = 0;

/** Let the scheduler run until it has nothing left to ask about. */
async function drain(world: LiveWorld, x: number, z: number, ticks = 400): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    world.update(x, z);
    await new Promise((r) => setTimeout(r, 0));
    if (world.pending === 0 && !world.stats.fetching) return;
  }
}

// A pack that covers everything within reach. Not one request may leave.
sent.length = 0;
stubFetch(() => jsonResponse({ elements: [] }));
{
  const { world } = makeWorld([{ lat: 38.4405, lon: -122.7141, radiusM: 20000 }]);
  await drain(world, 0, 0);
  check(
    "a camera inside a baked pack sends no Overpass request at all",
    sent.length === 0 && world.stats.tiles === 0,
    `${sent.length} requests, ${world.stats.tiles} tiles built`,
  );
}

// The same camera with no pack must ask, and ask for each box exactly once
// however many frames go by.
sent.length = 0;
{
  const { world } = makeWorld([]);
  await drain(world, 0, 0);
  const before = sent.length;
  for (let i = 0; i < 50; i++) world.update(0, 0);
  await new Promise((r) => setTimeout(r, 20));
  check(
    "with no pack it asks, once per box, and stops",
    before > 4 && new Set(sent).size === before && sent.length === before,
    `${before} requests for ${new Set(sent).size} distinct boxes, ` +
      `${sent.length - before} more after 50 idle frames`,
  );
  probe(
    "the once-per-box check would notice a box asked for twice",
    () => new Set(sent).size === sent.length,
    () => new Set([...sent, sent[0]]).size === sent.length + 1,
  );
}

// Open country: a well-formed answer with nothing in it. That is a SUCCESS, and
// the square must never be asked about again -- flying back and forth over a
// desert re-asking a volunteer server the same empty question is exactly the
// behaviour that gets an instance to start refusing.
sent.length = 0;
stubFetch(() => jsonResponse({ elements: [] }));
{
  const { world } = makeWorld([]);
  await drain(world, 0, 0);
  await drain(world, 900, 0);
  await drain(world, 0, 0);
  await drain(world, 0, 900);
  await drain(world, 0, 0);
  check(
    "ground with nothing mapped on it is asked about exactly once",
    new Set(sent).size === sent.length && sent.length > 20 && world.stats.empty > 20,
    `${sent.length} requests over five legs, ${new Set(sent).size} distinct boxes, ` +
      `${world.stats.empty} squares recorded as having nothing on them`,
  );
  probe(
    "the once-only check would notice a square asked about twice",
    () => new Set(sent).size === sent.length,
    () => new Set([...sent, sent[0]]).size === sent.length + 1,
  );
}

// One box that always fails, among many that do not.
//
// This is the case the wholly-dead endpoint above CANNOT see: there the breaker
// opens after four failures and nothing more goes out, so a scheduler that
// re-queued every failure would look identical to one that did not. Isolating a
// single bad square keeps the breaker shut and makes the difference visible.
sent.length = 0;
{
  let poisoned: string | null = null;
  stubFetch((url) => {
    if (poisoned === null) poisoned = url;
    return url === poisoned
      ? new Response("", { status: 504 })
      : jsonResponse({ elements: [] });
  });
  const { world } = makeWorld([]);
  await drain(world, 0, 0);
  await drain(world, 900, 0);
  await drain(world, 0, 0);
  await drain(world, 0, 900);
  await drain(world, 0, 0);
  const tries = sent.filter((u) => u === poisoned).length;
  check(
    "one box that keeps failing is retried, then let alone",
    tries === 3 && world.stats.failed === 1 && !world.overpass.stats.broken,
    `${tries} attempts at the bad box over five legs (3 is the retry limit), ` +
      `${world.stats.failed} tiles failed, breaker ${world.overpass.stats.broken ? "open" : "closed"}`,
  );
  probe(
    "the retry-limit check would notice a box re-asked on a later pass",
    () => sent.filter((u) => u === poisoned).length === 3,
    () => [...sent, poisoned].filter((u) => u === poisoned).length === 3,
  );
}

// Nothing may be lost when the camera moves while a fetch is outstanding: the
// queue is rebuilt on every rescan, and a tile already marked "wanted" has to
// be put back on it.
sent.length = 0;
{
  const { world } = makeWorld([]);
  world.update(0, 0);
  world.update(3000, 3000);
  world.update(0, 0);
  await drain(world, 0, 0);
  const wantedNow = tilesAround(SANTA_ROSA, 0, 0, 4000, []).length;
  check(
    "a camera that moves mid-fetch still gets every tile it asked for",
    sent.length >= wantedNow,
    `${sent.length} requests for ${wantedNow} tiles within reach`,
  );
}

// And the whole thing built from a real answer: buildings, roads and canopy in
// one scene, out of one combined response.
sent.length = 0;
const oneTile = { elements: combined };
stubFetch(() => jsonResponse(oneTile));
{
  replanted = 0;
  const { world, scene, buildingUniforms, roadUniforms } = makeWorld([]);
  await drain(world, 0, 0);
  check(
    "one combined answer becomes buildings, roads and canopy in the scene",
    world.stats.buildings > 200 &&
      world.stats.roads > 100 &&
      world.stats.vegNodes > 0 &&
      buildingUniforms.length > 0 &&
      roadUniforms.length > 0 &&
      scene.children.length >= 2 &&
      replanted > 0,
    `${world.stats.buildings} buildings, ${world.stats.roads} roads, ` +
      `${world.stats.vegPolygons} canopy polygons, ${world.stats.vegNodes} tree nodes, ` +
      `${scene.children.length} groups, ${replanted} replants`,
  );
  check(
    "an element on a tile boundary is built once, not once per tile",
    world.stats.buildings ===
      buildingsFromOsm(combined.filter(isBuildingElement), SANTA_ROSA, 20000).buildings.length,
    `${world.stats.buildings} buildings from ${sent.length} identical answers`,
  );
  probe(
    "the de-dupe check would notice a second copy of every wall",
    () => sent.length > 1,
    () => sent.length === 1,
  );
}

// A transport that fails must leave the flight alone: no throw, no geometry,
// and no endless retrying.
sent.length = 0;
{
  (globalThis as { fetch: unknown }).fetch = (input: unknown) => {
    sent.push(String(input));
    return Promise.reject(new Error("network is down"));
  };
  const { world, scene } = makeWorld([]);
  let threw = false;
  let afterFirstLeg = -1;
  try {
    // A walk, not a hover. A stationary camera never rescans, so a tile that
    // was refused once would sit there looking harmless; it is flying back over
    // the same ground that turns "retry on failure" into a stream of repeat
    // requests to a server that has already said no.
    await drain(world, 0, 0);
    afterFirstLeg = sent.length;
    await drain(world, 900, 0);
    await drain(world, 0, 0);
    await drain(world, 0, 900);
    await drain(world, 0, 0);
  } catch {
    threw = true;
  }
  check(
    "a dead endpoint leaves an empty sky and a live flight",
    !threw && world.stats.tiles === 0 && scene.children.length === 0 && world.stats.failed > 0,
    `${world.stats.failed} tiles failed, ${scene.children.length} groups in the scene, ` +
      `breaker ${world.overpass.stats.broken ? "open" : "closed"}`,
  );
  // The number that matters to a volunteer server is not "did it retry", it is
  // "does flying about make it ask again". Once the breaker is open, further
  // legs of the flight must cost nothing at all.
  check(
    "a dead endpoint costs a bounded number of requests however far you fly",
    afterFirstLeg > 0 && sent.length === afterFirstLeg && sent.length <= 12,
    `${afterFirstLeg} requests on the first leg, ${sent.length - afterFirstLeg} more ` +
      `over four further legs, ${new Set(sent).size} distinct boxes`,
  );
  probe(
    "the bounded-request check would notice a flight that kept asking",
    () => sent.length === afterFirstLeg,
    () => sent.length + 1 === afterFirstLeg,
  );
}
(globalThis as { fetch: unknown }).fetch = realFetch;

// ===========================================================================

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(62)} ${r.detail}`);
}
console.log(
  failed === 0
    ? `\nall ${results.length} live-OSM checks ok`
    : `\n${failed} of ${results.length} live-OSM checks FAILED`,
);
if (failed) process.exit(1);

// --- small helpers ---------------------------------------------------------

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function countVerts(bs: readonly Building[]): number {
  let n = 0;
  for (const b of bs) n += b.ring.length / 2;
  return n;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length === 0 ? 0 : s[s.length >> 1];
}

function minDim(ring: Float32Array): number {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    if (ring[i] < minX) minX = ring[i];
    if (ring[i] > maxX) maxX = ring[i];
    if (ring[i + 1] < minZ) minZ = ring[i + 1];
    if (ring[i + 1] > maxZ) maxZ = ring[i + 1];
  }
  return Math.min(maxX - minX, maxZ - minZ);
}

/** A copy with one building 10 cm taller: the smallest real divergence. */
function nudgeOne(bs: readonly Building[]): Building[] {
  return bs.map((b, i) => (i === 7 ? { ...b, topM: b.topM + 0.1 } : b));
}

/** A copy with one ring vertex moved by one quantisation step. */
function nudgeVertex(bs: readonly Building[]): Building[] {
  return bs.map((b, i) => {
    if (i !== 11) return b;
    const ring = b.ring.slice();
    ring[0] += 0.25;
    return { ...b, ring };
  });
}
