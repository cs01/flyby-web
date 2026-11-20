// The gate on Muni and the Alcatraz ferry in the San Francisco transit pack
// (public/transit/sf.json from tools/bake-transit.ts).
//
// WHAT CAN GO WRONG HERE THAT STILL RENDERS: a route_type filter that keeps
// nothing (no Muni at all, and no error); the F snapping to the Market Street
// subway under it and vanishing underground; buses snapping to the BART and
// Muni Metro tunnels under their streets; the hand-written Alcatraz feed
// drifting from the operator's timetable, its path ending at the wrong pier,
// or crossing land.
//
// Each claim runs on the real pack (must pass) and on a probe built to
// violate it (must fail), as in test/transit.check.ts.

import { parseTransitPack, Level, activeServices, type TransitPack } from "../src/data/transitpack";
import { parseLandPack, sampleLand, LandClass } from "../src/data/landcover";
import { Origin } from "../src/geo";
import { cityById } from "../src/cities";

let checks = 0;
let failures = 0;

function claim<T>(name: string, holds: (c: T) => boolean, real: T, probe: T, detail: string): void {
  checks++;
  const ok = holds(real);
  const probeRejected = !holds(probe);
  const pass = ok && probeRejected;
  if (!pass) failures++;
  console.log(
    `${pass ? "  ok" : "FAIL"} ${name.padEnd(66)} ${detail}` +
      (ok ? "" : "  [real case fails]") +
      (probeRejected ? "" : "  [VACUOUS: probe passed]"),
  );
}

const pack = parseTransitPack(await Bun.file(new URL("../public/transit/sf.json", import.meta.url).pathname).json());
const city = cityById("sf")!;
const o = new Origin(city.lat, city.lon);
const land = parseLandPack(await Bun.file(new URL("../public/cities/sf.land", import.meta.url).pathname).arrayBuffer());
const isWet = (x: number, z: number) => {
  const l = land.levels.find((lv) => Math.abs(x) < lv.extentM && Math.abs(z) < lv.extentM);
  if (!l) return true;
  const c = sampleLand(l, x, z);
  return c === LandClass.Water || c === LandClass.NoData;
};

const agencyOf = (p: TransitPack, pi: number) => p.agencies[p.routes[p.patterns[pi].route].agency];
const patternsOf = (p: TransitPack, test: (id: string, kind: string) => boolean) =>
  p.patterns.map((_, i) => i).filter((i) => test(agencyOf(p, i).id, agencyOf(p, i).kind));
const routePatterns = (p: TransitPack, agency: string, route: string) =>
  p.patterns.map((_, i) => i).filter((i) => agencyOf(p, i).id === agency && p.routes[p.patterns[i].route].id === route);

// --- Muni modes ---------------------------------------------------------------

const withoutMuni: TransitPack = { ...pack, patterns: pack.patterns.filter((q) => !pack.agencies[pack.routes[q.route].agency].id.startsWith("sfmta")) };
for (const kind of ["bus", "tram", "cable"]) {
  const n = (p: TransitPack) => patternsOf(p, (id, k) => id.startsWith("sfmta") && k === kind).length;
  claim(`Muni ${kind} patterns in the pack`, (p) => n(p) > 0, pack, withoutMuni, `${n(pack)} patterns`);
}

// The cable cars are the three lines Muni runs; the probe is the bus agency's.
const cableRoutes = (p: TransitPack, agency: string) =>
  [...new Set(patternsOf(p, (id) => id === agency).map((i) => p.routes[p.patterns[i].route].id))].sort().join(",");
claim("cable car routes are CA, PH, PM", (a) => cableRoutes(pack, a) === "CA,PH,PM", "sfmta-cable", "sfmta-bus", cableRoutes(pack, "sfmta-cable"));

// --- the vertical -----------------------------------------------------------------

/** Fraction of a pattern set's track length at a level. */
function levelShare(p: TransitPack, pats: number[], lvl: number): number {
  let at = 0, all = 0;
  for (const pi of pats) {
    for (const run of p.shapes[p.patterns[pi].shape].runs) {
      for (let i = 1; i < run.s.length; i++) {
        const L = run.s[i] - run.s[i - 1];
        all += L;
        if (run.lvl[i] === lvl) at += L;
      }
    }
  }
  return all ? at / all : 0;
}
const F = routePatterns(pack, "sfmta-tram", "F");
const K = routePatterns(pack, "sfmta-tram", "K");
claim("the F runs on Market Street, not in the subway under it", (pats) => pats.length > 0 && levelShare(pack, pats, Level.Tunnel) === 0, F, K,
  `F tunnel ${(levelShare(pack, F, Level.Tunnel) * 100).toFixed(0)}%, K ${(levelShare(pack, K, Level.Tunnel) * 100).toFixed(0)}%`);
// Embarcadero to West Portal is underground: 8 of the K's 12 km in this pack
// measured 69%. The floor is what a K snapped to nothing (all grade) cannot reach.
claim("the K is in the Market Street and Twin Peaks tunnels", (pats) => levelShare(pack, pats, Level.Tunnel) > 0.4, K, F, "");
const buses = patternsOf(pack, (id) => id === "sfmta-bus");
const metro = patternsOf(pack, (id) => id === "sfmta-tram");
claim("no bus is in a tunnel", (pats) => pats.length > 0 && levelShare(pack, pats, Level.Tunnel) === 0, buses, metro,
  `Muni Metro ${(levelShare(pack, metro, Level.Tunnel) * 100).toFixed(0)}% tunnel`);
// The 25 crosses the Bay Bridge west span to Treasure Island; at grade it
// would drive on the water. Probe: the 38 Geary, which crosses no bridge.
const r25 = routePatterns(pack, "sfmta-bus", "25");
const r38 = routePatterns(pack, "sfmta-bus", "38");
claim("the 25 Treasure Island is raised over the bay", (pats) => levelShare(pack, pats, Level.Elevated) > 0.2, r25, r38,
  `${(levelShare(pack, r25, Level.Elevated) * 100).toFixed(0)}% elevated`);

// --- Alcatraz -------------------------------------------------------------------

// The operator's published day tour (schedule PDF, summer 2026, read
// 2026-11-20): first boat 8:40 AM from Pier 33, last day-tour return 6:30 PM,
// last night-tour return 9:25 PM. Re-typed here, not imported from the bake,
// so a slip in either shows.
const FIRST_OUT_S = 8 * 3600 + 40 * 60;
const LAST_BACK_S = 18 * 3600 + 30 * 60;
const NIGHT_BACK_S = 21 * 3600 + 25 * 60;
const PIER33 = o.toWorld(37.8069704, -122.404159);
const ISLAND = o.toWorld(37.8266612, -122.420808);

const alc = patternsOf(pack, (id) => id === "alcatraz");
// A Sunday and a Wednesday inside the published season: the night and
// Behind the Scenes tours run Tuesday to Saturday only.
const SUN = activeServices(pack, 20260719, 6);
const WED = activeServices(pack, 20260715, 2);
function departures(p: TransitPack, fromStopNear: { x: number; z: number }, on = SUN): number[] {
  const out: number[] = [];
  for (const pi of patternsOf(p, (id) => id === "alcatraz")) {
    const q = p.patterns[pi];
    const s0 = p.stops[q.stops[0]];
    if (Math.hypot(s0.x - fromStopNear.x, s0.z - fromStopNear.z) > 300) continue;
    for (let k = 0; k < q.trips.length; k += 3) if (on.has(q.trips[k])) out.push(q.trips[k + 1]);
  }
  return out.sort((a, b) => a - b);
}
const shifted: TransitPack = {
  ...pack,
  patterns: pack.patterns.map((q) =>
    pack.agencies[pack.routes[q.route].agency].id === "alcatraz" ? { ...q, trips: q.trips.map((v, i) => (i % 3 === 1 ? v + 300 : v)) } : q,
  ),
};
const fmt = (s: number | undefined) => (s === undefined ? "none" : `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`);
claim("first Alcatraz boat leaves Pier 33 at 8:40", (p) => departures(p, PIER33)[0] === FIRST_OUT_S, pack, shifted, `first ${fmt(departures(pack, PIER33)[0])}`);
claim("last Sunday return leaves the island at 6:30 PM", (p) => departures(p, ISLAND).at(-1) === LAST_BACK_S, pack, shifted,
  `Sunday returns ${departures(pack, ISLAND).length}, last ${fmt(departures(pack, ISLAND).at(-1))}`);
claim("last Wednesday return is the night tour's, 9:25 PM", (p) => departures(p, ISLAND, WED).at(-1) === NIGHT_BACK_S, pack, shifted,
  `Wednesday returns ${departures(pack, ISLAND, WED).length}`);

/** Every 10 m of a pattern's shape, world x,z. */
function samples(p: TransitPack, pi: number): [number, number][] {
  const out: [number, number][] = [];
  for (const run of p.shapes[p.patterns[pi].shape].runs) {
    for (let i = 1; i < run.s.length; i++) {
      const ax = run.pts[i * 2 - 2], az = run.pts[i * 2 - 1], bx = run.pts[i * 2], bz = run.pts[i * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d < L; d += 10) out.push([ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L]);
    }
  }
  return out;
}
const ends = (p: TransitPack, pi: number) => {
  const sm = samples(p, pi);
  return [sm[0], sm[sm.length - 1]];
};
const dockOk = (p: TransitPack, pis: number[]) =>
  pis.length === 2 &&
  pis.every((pi) => {
    const [a, b] = ends(p, pi);
    const d = (q: [number, number], t: { x: number; z: number }) => Math.hypot(q[0] - t.x, q[1] - t.z);
    return (d(a, PIER33) < 300 && d(b, ISLAND) < 300) || (d(a, ISLAND) < 300 && d(b, PIER33) < 300);
  });
// Probe: the Golden Gate Ferry's patterns, which end at the Ferry Building and Marin.
const ggt = patternsOf(pack, (id) => id === "ggt").slice(0, 2);
claim("Alcatraz shapes run Pier 33 to the island dock (300 m)", (pis) => dockOk(pack, pis), alc, ggt, `${alc.length} patterns`);

// Probe: the same path pulled halfway to the city centre, over North Beach.
const pulled: TransitPack = {
  ...pack,
  shapes: pack.shapes.map((sh, si) =>
    alc.some((pi) => pack.patterns[pi].shape === si)
      ? { ...sh, runs: sh.runs.map((r) => ({ ...r, pts: r.pts.map((v) => v * 0.5) })) }
      : sh,
  ),
};
const dry = (p: TransitPack) => alc.reduce((n, pi) => n + samples(p, pi).filter(([x, z]) => !isWet(x, z)).length, 0);
claim("no Alcatraz shape sample is on land", (p) => alc.length > 0 && dry(p) === 0, pack, pulled,
  `${alc.reduce((n, pi) => n + samples(pack, pi).length, 0)} samples, probe ${dry(pulled)} dry`);

console.log(`muni: ${checks} checks, ${failures} failed`);
if (failures) process.exit(1);
