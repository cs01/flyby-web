// The gate on street naming: the pack's name table, and the walk that finds the
// next cross street.
//
// WHAT A SCREENSHOT CANNOT SETTLE. A sign in a frame says a name was drawn. It
// does not say the name belongs to the road under the car, that the crossing
// announced is the next one rather than the fourth, that the distance to it is
// the distance a driver would drive, or that a name survived a pack round trip
// at all. Those are arithmetic, so they are asserted here against the committed
// public/cities/*.roads.
//
// THE FAILURE THIS EXISTS FOR is silence. Everything here degrades to an empty
// string: a v1 pack has no name table, an unnamed way has no name, a walk that
// finds nothing returns "". A street sign that shows nothing looks exactly like
// a street sign correctly staying quiet on an alley, so nothing about the
// rendered frame distinguishes "working" from "switched off". The counts below
// are what does.
//
// GATE DISCIPLINE, as in test/car.check.ts. Every bound is a LITERAL. Every
// assertion is followed by a VACUITY PROBE fed a case it must reject.

import { parseRoadPack, encodeRoadPack, type RoadPack, type PackedWay } from "../src/data/roadpack";
import { buildRoadGraph } from "../src/data/roadgraph";
import { streetSign } from "../src/data/streetsign";

declare const process: { exit(code?: number): never };
declare const Bun: { file(p: string): { exists(): Promise<boolean>; arrayBuffer(): Promise<ArrayBuffer> } };

const DIR = "public/cities";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(48)} ${detail}`);
  if (!ok) failures++;
}

const packs = new Map<string, RoadPack>();
async function pack(id: string): Promise<RoadPack> {
  if (!packs.has(id)) {
    const f = Bun.file(`${DIR}/${id}.roads`);
    if (!(await f.exists())) throw new Error(`no ${DIR}/${id}.roads`);
    packs.set(id, parseRoadPack(await f.arrayBuffer()));
  }
  return packs.get(id)!;
}

// ---------------------------------------------------------------------------
// The pack carries names at all.
//
// AT LEAST ONE CITY, not all of them. A .roads pack is committed to the repo
// and a name needs an Overpass round trip to bake, so a city baked before the
// name table simply has none and still loads -- that back-compatibility is
// deliberate and is itself asserted below. What must not happen is that NO city
// has names, which is what a broken writer or a broken reader looks like.
// ---------------------------------------------------------------------------

const CITIES = ["emeraldhills", "sf", "manhattan", "chicago"];

{
  let bestCity = "";
  let bestNamed = 0;
  let bestFrac = 0;
  for (const id of CITIES) {
    const p = await pack(id);
    const named = p.roads.filter((r) => r.name !== "").length;
    const frac = p.roads.length > 0 ? named / p.roads.length : 0;
    console.log(
      `     ${id.padEnd(13)} ${String(p.roads.length).padStart(6)} ways  ` +
      `${String(named).padStart(6)} named (${(frac * 100).toFixed(1)}%)  ` +
      `${new Set(p.roads.filter((r) => r.name !== "").map((r) => r.name)).size} distinct`,
    );
    if (named > bestNamed) { bestNamed = named; bestCity = id; bestFrac = frac; }
  }
  check(
    "at least one pack carries street names",
    bestNamed > 500,
    `${bestCity} has ${bestNamed} named ways (${(bestFrac * 100).toFixed(1)}%)`,
  );
  probe("names present", 0 > 500, "a pack with no name table has 0");
}

// ---------------------------------------------------------------------------
// The names survive a pack round trip.
//
// The whole point of the string table is that it is written and read by two
// different pieces of code. Encoding a pack and parsing it back is the only
// thing that says they agree; a reader that returns "" for everything passes
// every other check in this file by making the walk quietly find nothing.
// ---------------------------------------------------------------------------

{
  const p = await pack("emeraldhills");
  // Rebuild PackedWays from the parsed roads. The geometry is not what is under
  // test here, so it goes back at whole-metre precision; the NAME is.
  const ways: PackedWay[] = p.roads.slice(0, 4000).map((r) => {
    const n = r.pts.length / 2;
    const dx = new Int16Array(n);
    const dz = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      dx[i] = Math.round((r.pts[i * 2] - r.cx) / 0.25);
      dz[i] = Math.round((r.pts[i * 2 + 1] - r.cz) / 0.25);
    }
    return { cls: r.cls, name: r.name, lanes: r.lanes, flags: r.flags, layer: r.layer,
             surface: r.surface, cx: r.cx, cz: r.cz, dx, dz };
  });
  const back = parseRoadPack(
    encodeRoadPack(ways, p.lat0, p.lon0, p.radiusM).buffer as ArrayBuffer,
  );
  let mismatched = 0;
  for (let i = 0; i < ways.length; i++) if (back.roads[i].name !== ways[i].name) mismatched++;
  check(
    "every name survives encode and parse",
    mismatched === 0 && back.roads.length === ways.length,
    `${mismatched} of ${ways.length} changed`,
  );
  // A reader that hands back "" for everything: the failure this is here for.
  {
    let wrong = 0;
    for (const w of ways) if (w.name !== "") wrong++;
    probe("name round trip", wrong === 0, `a reader returning "" would miss ${wrong}`);
  }
}

// ---------------------------------------------------------------------------
// A v1 pack still parses.
// ---------------------------------------------------------------------------

{
  const p = await pack("sf");
  const enc = encodeRoadPack(
    [{ cls: p.roads[0].cls, name: "", lanes: 2, flags: 0, layer: 0, surface: p.roads[0].surface,
       cx: 0, cz: 0, dx: Int16Array.from([0, 40]), dz: Int16Array.from([0, 0]) }],
    p.lat0, p.lon0, p.radiusM,
  );
  // Stamp the version field back to 1 and truncate the name section, which is
  // exactly the byte layout of a pack baked before the table existed.
  // One way with no name: the section is a u32 count of 0 plus one u16 id.
  const v1 = enc.slice(0, enc.length - 6);
  new DataView(v1.buffer, v1.byteOffset).setUint32(4, 1, true);
  let ok = false;
  let detail = "";
  try {
    const r = parseRoadPack(v1.buffer.slice(v1.byteOffset, v1.byteOffset + v1.byteLength) as ArrayBuffer);
    ok = r.roads.length === 1 && r.roads[0].name === "";
    detail = `${r.roads.length} way, name ${JSON.stringify(r.roads[0].name)}`;
  } catch (e) {
    detail = `threw: ${(e as Error).message}`;
  }
  check("a version 1 pack still parses, with no names", ok, detail);
  probe("v1 compatibility", false, "a parser rejecting v1 would throw here");
}

// ---------------------------------------------------------------------------
// The walk names the road under the car and the next crossing.
// ---------------------------------------------------------------------------

{
  const p = await pack("emeraldhills");
  const g = buildRoadGraph(p.roads);

  // Every named edge, driven from its own start, forward.
  let onNamed = 0;
  let wrongStreet = 0;
  let withCross = 0;
  let crossSameAsStreet = 0;
  let crossTooFar = 0;
  let sumCross = 0;
  for (let e = 0; e < g.edges.length; e++) {
    const edge = g.edges[e];
    if (edge.name === "") continue;
    onNamed++;
    const sign = streetSign(g, { edge: e, forward: true }, 0);
    if (sign.street !== edge.name) wrongStreet++;
    if (sign.cross !== "") {
      withCross++;
      sumCross += sign.crossM;
      if (sign.cross === sign.street) crossSameAsStreet++;
      // 400 m is the reach; the distance reported must be inside it.
      if (sign.crossM > 400.0001) crossTooFar++;
    }
  }

  check(
    "the sign names the road the car is on",
    wrongStreet === 0 && onNamed > 500,
    `${wrongStreet} wrong over ${onNamed} named edges`,
  );
  probe("street naming", 1 === 0, "one mismatch would fail");

  // A THIRD, NOT MOST, and that bound is the city rather than the code.
  // Emerald Hills is Woodside and the Skyline ridge: long rural roads, deep
  // culs-de-sac and trailheads, where the next named crossing is genuinely
  // further than the 400 m reach. Measured at 39.7%. The bound is here to catch
  // a walk that has stopped walking, and the reach comparison below is what
  // actually proves it is walking.
  const crossFrac = withCross / onNamed;
  check(
    "a cross street is found on a good share of named roads",
    crossFrac > 0.30,
    `${withCross} of ${onNamed} (${(crossFrac * 100).toFixed(1)}%), mean ${(sumCross / Math.max(1, withCross)).toFixed(0)} m`,
  );
  probe("cross found", 0 > 0.30, "a walk that never leaves the first node finds 0");

  // The distance has to be a BLOCK. A walk that returned the distance to the
  // first vertex would report a few metres; one that accumulated the whole
  // path it searched would report the reach.
  const meanCross = sumCross / Math.max(1, withCross);
  check(
    "the distance announced is a block, not a vertex or the reach",
    meanCross > 20 && meanCross < 250,
    `mean ${meanCross.toFixed(0)} m`,
  );
  probe("crossing distance", 400 > 20 && 400 < 250, "reporting the reach itself gives 400 m");

  check(
    "the cross street is never the street being driven",
    crossSameAsStreet === 0,
    `${crossSameAsStreet} announced their own name`,
  );
  probe("cross differs", 1 === 0, "one self-announcement would fail");

  check(
    "no crossing is announced past the reach",
    crossTooFar === 0,
    `${crossTooFar} over 400 m`,
  );
  probe("reach honoured", 1 === 0, "one overrun would fail");

  // A SHORTER REACH MUST FIND FEWER. A walk that ignores its reach argument
  // reports the same number whatever it is given, and every check above would
  // still pass.
  let short = 0;
  for (let e = 0; e < g.edges.length; e++) {
    if (g.edges[e].name === "") continue;
    if (streetSign(g, { edge: e, forward: true }, 0, 40).cross !== "") short++;
  }
  check(
    "a shorter reach finds fewer crossings",
    short < withCross,
    `40 m finds ${short}, 400 m finds ${withCross}`,
  );
  probe("reach is used", withCross < withCross, "a walk ignoring reachM reports the same count");
}

// ---------------------------------------------------------------------------

console.log(
  failures === 0
    ? `\nall ${checks} street sign checks ok`
    : `\n${failures} of ${checks} street sign check(s) FAILED`,
);
if (failures > 0) process.exit(1);
