// The gate on the transit layer: the GTFS-realtime decoder (src/data/gtfsrt.ts),
// stop-time interpolation and the vertical (src/data/transit.ts), and the
// baked packs (public/transit/*.json from tools/bake-transit.ts).
//
// WHAT CAN GO WRONG HERE THAT STILL RENDERS. Each of these draws a city full
// of trains with no error anywhere:
//
//   * the decoder mis-skips one field (MTA's NYCT extension is field 1001) and
//     every stop time after it is garbage: trains placed at random on the line.
//   * an HTML error page from a proxy decodes as an empty feed, and the layer
//     silently shows no trains instead of falling back to the timetable.
//   * interpolation is linear in time, and trains glide through every station
//     at cruise speed without stopping.
//   * the tunnel flag is lost, and every subway train under Manhattan is drawn
//     on the street.
//   * a boat is placed from the wrong shape or the wrong height, and ferries
//     sail up Broadway or float above the river.
//
// WATCHED TO FAIL. Each claim runs on the real case (must pass) and on a
// probe built to violate it (must fail), as in test/livetraffic.check.ts.

import { decodeFeed, type FeedMsg } from "../src/data/gtfsrt";
import { parseTransitPack, sampleShape, Level, type TransitPack, type ShapeSample } from "../src/data/transitpack";
import {
  ACCEL,
  TransitModel,
  carUnderground,
  heightAtSample,
  runS,
  timelineS,
  trackHeights,
  type TimedStop,
} from "../src/data/transit";
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

const FIX = new URL("./fixtures/transit-nyc/", import.meta.url).pathname;
const meta = (await Bun.file(`${FIX}meta.json`).json()) as { city: string; now: number; feeds: string[] };
const bytes = async (k: string) => new Uint8Array(await Bun.file(`${FIX}${k}.pb`).arrayBuffer());
const tryDecode = (b: Uint8Array): FeedMsg | null => {
  try {
    return decodeFeed(b);
  } catch {
    return null;
  }
};

const packs = new Map<string, TransitPack>();
async function pack(id: string): Promise<TransitPack> {
  let p = packs.get(id);
  if (!p) {
    p = parseTransitPack(await Bun.file(new URL(`../public/transit/${id}.json`, import.meta.url).pathname).json());
    packs.set(id, p);
  }
  return p;
}
const originOf = (id: string) => {
  const c = cityById(id)!;
  return new Origin(c.lat, c.lon);
};

// --- 1. the decoder -------------------------------------------------------------
{
  const nqrw = await bytes("mta-gtfs-nqrw");
  // Plausible: trip updates on N/Q/R/W only, stop ids like R16N, every time
  // within three hours of the header.
  const plausible = (b: Uint8Array) => {
    const m = tryDecode(b);
    if (!m || m.tripUpdates.length < 20) return false;
    const routes = new Set(m.tripUpdates.map((t) => t.trip.routeId));
    const stops = m.tripUpdates.flatMap((t) => t.stops);
    return (
      [...routes].every((r) => /^[NQRW]$/.test(r)) &&
      stops.length > 200 &&
      stops.every((s) => /^[A-Z0-9]{3}[NS]$/.test(s.stopId) && s.arrival !== null && Math.abs(s.arrival - m.timestamp) < 3 * 3600)
    );
  };
  // The probe is the same answer one byte short, as a proxy that cut the
  // connection would hand over: every length must be checked, or the last
  // entity decodes as whatever follows it in memory.
  const broken = nqrw.slice(0, nqrw.length - 1);
  const m = decodeFeed(nqrw);
  claim(
    "the MTA N/Q/R/W fixture decodes to plausible stop times",
    plausible,
    nqrw,
    broken,
    `${m.tripUpdates.length} trips, ${m.tripUpdates.reduce((n, t) => n + t.stops.length, 0)} stop times; probe: one byte short`,
  );
  const html = new TextEncoder().encode("<html><body>502 Bad Gateway</body></html>");
  claim("an HTML error page is not a feed", (b: Uint8Array) => tryDecode(b) === null, html, nqrw, "probe: the real fixture");

  // Floats: NYC Ferry positions are fixed32 lat/lon and must land in the harbour.
  const vp = await bytes("nycferry-vehicleposition");
  const inHarbour = (b: Uint8Array) => {
    const f = tryDecode(b);
    return !!f && f.vehicles.length > 3 && f.vehicles.every((v) => v.lat! > 40.5 && v.lat! < 40.9 && v.lon! > -74.1 && v.lon! < -73.7);
  };
  const vpSwapped = vp.slice();
  // Turn every fixed32 field into a varint-typed one: the decoder must then
  // read no positions at all.
  for (let i = 0; i < vpSwapped.length; i++) if (vpSwapped[i] === 0x0d || vpSwapped[i] === 0x15) vpSwapped[i] -= 5;
  claim("NYC Ferry positions decode inside New York Harbor", inHarbour, vp, vpSwapped, `${decodeFeed(vp).vehicles.length} vessels; probe: wire types corrupted`);
}

// --- 2. stop-time interpolation ---------------------------------------------------
{
  // 1200 m between stations in 120 s, a typical express run.
  const D = 1200, T = 120;
  const linear = (_D: number, _T: number, tau: number) => (D * Math.min(T, Math.max(0, tau))) / T;
  const profile = (f: (D: number, T: number, tau: number) => number) => {
    let maxA = 0;
    let vEnd = 0;
    const dt = 0.25;
    for (let t = dt; t < T - dt; t += dt) {
      const v0 = (f(D, T, t) - f(D, T, t - dt)) / dt;
      const v1 = (f(D, T, t + dt) - f(D, T, t)) / dt;
      maxA = Math.max(maxA, Math.abs(v1 - v0) / dt);
    }
    vEnd = (f(D, T, T) - f(D, T, T - 1)) / 1;
    return { arrives: Math.abs(f(D, T, T) - D) < 1e-6, starts: f(D, T, 0) === 0, maxA, vEnd };
  };
  const stands = (f: (D: number, T: number, tau: number) => number) => {
    const p = profile(f);
    // Arrives on the predicted second, standing (under 1.2 m/s in its last
    // second), never accelerating harder than the motors can.
    return p.arrives && p.starts && p.vEnd < 1.2 && p.maxA <= ACCEL + 1e-6;
  };
  const p = profile(runS);
  claim("a run arrives on time, at a stand, under 1 m/s^2", stands, runS, linear, `last second ${p.vEnd.toFixed(2)} m/s, peak ${p.maxA.toFixed(2)} m/s^2; probe: linear`);

  // A timeline: stand at A, run to B, dwell, run to C.
  const tl: TimedStop[] = [
    { stop: 0, s: 0, arr: 1000, dep: 1030 },
    { stop: 1, s: 900, arr: 1120, dep: 1150 },
    { stop: 2, s: 2100, arr: 1280, dep: 1280 },
  ];
  const at = (t: number) => timelineS(tl, t);
  const right = (f: (t: number) => { s: number } | null) =>
    f(1010)!.s === 0 && f(1135)!.s === 900 && f(1075)!.s > 0 && f(1075)!.s < 900 && f(1200)!.s > 900 && f(1280)!.s === 2100 && f(500) === null;
  const reversed = (t: number) => timelineS(tl.map((x) => ({ ...x, s: 2100 - x.s })), t);
  claim("a train stands through each dwell and is between stops between them", right, at, reversed, `mid-run s ${at(1075)!.s.toFixed(0)} m; probe: shape walked backwards`);

  // The live fixture end to end: every placed MTA train lies between the arc
  // lengths of the stop it last left and the one it reaches next.
  const nyc = await pack("manhattan");
  const model = new TransitModel(nyc, originOf("manhattan"));
  for (const k of meta.feeds) model.ingest(k.startsWith("mta") ? "mta" : "nycferry", decodeFeed(await bytes(k)), meta.now);
  model.step(meta.now + 15000);
  const live = [...model.vehicles.values()].filter((v) => v.live && nyc.agencies[v.agency].live === "mta");
  const between = (vs: typeof live) =>
    vs.length > 150 &&
    vs.every((v) => {
      const b = v.timeline[v.next];
      const a = v.timeline[Math.max(0, v.next - 1)];
      return v.s >= a.s - 1 && v.s <= b.s + 1;
    });
  const shifted = live.map((v) => ({ ...v, s: v.s + 3000 }));
  claim("every live MTA train is between its last and next stop", between, live, shifted, `${live.length} trains; probe: 3 km down the line`);
}

// --- 3. underground is hidden --------------------------------------------------------
{
  const nyc = await pack("manhattan");
  // Flat ground keeps the claim about the levels, not the DEM.
  const flat = () => 0;
  const deck = () => null;
  const hiddenWhereTunnel = (p: TransitPack) => {
    let tunnel = 0, tunnelHidden = 0, el = 0, elShown = 0;
    const smp: ShapeSample = { x: 0, z: 0, dx: 0, dz: 0, lvl: 0, run: 0, seg: 0, u: 0 };
    for (const sh of p.shapes) {
      const ag = p.agencies[p.routes[p.patterns.find((q) => p.shapes[q.shape] === sh)!.route].agency];
      if (ag.kind === "ferry") continue;
      const hs = trackHeights(sh, flat, ag.elevatedM, deck);
      sh.runs.forEach((run, ri) => {
        for (let i = 0; i + 1 < run.s.length; i++) {
          // Mid-segment, 400 m clear of any level change on either side, so the
          // ramps are out of it.
          const s = (run.s[i] + run.s[i + 1]) / 2;
          let clear = true;
          for (let j = 0; j < run.s.length && clear; j++) if (Math.abs(run.s[j] - s) < 400 && run.lvl[j] !== run.lvl[i]) clear = false;
          if (!clear || run.lvl[i] !== run.lvl[i + 1]) continue;
          if (!sampleShape(sh, s, smp) || smp.run !== ri) continue;
          const y = heightAtSample(hs, smp);
          if (run.lvl[i] === Level.Tunnel) {
            tunnel++;
            if (carUnderground(y, 0)) tunnelHidden++;
          } else if (run.lvl[i] === Level.Elevated) {
            el++;
            if (!carUnderground(y, 0)) elShown++;
          }
        }
      });
    }
    return tunnel > 500 && el > 100 && tunnelHidden === tunnel && elShown === el;
  };
  // Probe: the same pack with the levels read from OSM thrown away.
  const flattened: TransitPack = {
    ...nyc,
    shapes: nyc.shapes.map((sh) => ({ ...sh, runs: sh.runs.map((r) => ({ ...r, lvl: new Uint8Array(r.lvl.length).fill(Level.Grade) })) })),
  };
  claim("every tunnel car is hidden and every el car is shown", hiddenWhereTunnel, nyc, flattened, "probe: levels dropped to grade");

  // Two known places: the Q under Broadway at 34 St is in tunnel, the Q on
  // the Manhattan Bridge is not.
  const o = originOf("manhattan");
  const levelNear = (p: TransitPack, route: string, lat: number, lon: number) => {
    const w = o.toWorld(lat, lon);
    let best = Infinity, lvl = -1;
    for (const pt of p.patterns) {
      if (p.routes[pt.route].id !== route) continue;
      for (const run of p.shapes[pt.shape].runs) {
        for (let i = 0; i + 1 < run.s.length; i++) {
          const ax = run.pts[i * 2], az = run.pts[i * 2 + 1], vx = run.pts[i * 2 + 2] - ax, vz = run.pts[i * 2 + 3] - az;
          const L2 = vx * vx + vz * vz || 1;
          const u = Math.max(0, Math.min(1, ((w.x - ax) * vx + (w.z - az) * vz) / L2));
          const d = Math.hypot(ax + vx * u - w.x, az + vz * u - w.z);
          if (d < best) {
            best = d;
            lvl = run.lvl[u < 0.5 ? i : i + 1];
          }
        }
      }
    }
    return best < 60 ? lvl : -1;
  };
  const known = (p: TransitPack) =>
    levelNear(p, "Q", 40.7496, -73.9877) === Level.Tunnel && levelNear(p, "Q", 40.7076, -73.9905) === Level.Elevated && levelNear(p, "7", 40.7509, -73.9402) === Level.Elevated;
  claim("Q in tunnel at 34 St, on the Manhattan Bridge, 7 elevated at Queensboro Plaza", known, nyc, flattened, "probe: levels dropped to grade");
}

// --- 4. vessels on the water ---------------------------------------------------------
{
  // Every timetabled ferry, every 2 minutes over a weekday, against the
  // WorldCover water class in the city's own land pack.
  const onWater = async (id: string, shapesFrom: (p: TransitPack) => TransitPack) => {
    const p = shapesFrom(await pack(id));
    const land = parseLandPack(await Bun.file(new URL(`../public/cities/${id}.land`, import.meta.url).pathname).arrayBuffer());
    const o = originOf(id);
    const m = new TransitModel(p, o);
    let n = 0, wet = 0;
    // A Wednesday, inside every baked calendar.
    const t0 = Date.parse("2026-10-21T13:00:00Z");
    for (let t = t0; t < t0 + 10 * 3600_000; t += 120_000) {
      m.step(t);
      for (const v of m.vehicles.values()) {
        if (p.agencies[v.agency].kind !== "ferry") continue;
        const smp = m.sample(v, v.s);
        if (!smp) continue;
        const lvl = land.levels.find((l) => Math.abs(smp.x) < l.extentM && Math.abs(smp.z) < l.extentM);
        if (!lvl) continue;
        n++;
        const c = sampleLand(lvl, smp.x, smp.z);
        if (c === LandClass.Water || c === LandClass.NoData) wet++;
      }
    }
    return { n, frac: n ? wet / n : 0 };
  };
  // Probe: the ferries' trips run along the subway's shapes instead.
  const onSubwayShapes = (p: TransitPack): TransitPack => {
    const rail = p.patterns.find((q) => p.agencies[p.routes[q.route].agency].kind !== "ferry")!;
    return { ...p, patterns: p.patterns.map((q) => (p.agencies[p.routes[q.route].agency].kind === "ferry" ? { ...q, shape: rail.shape } : q)) };
  };
  for (const id of ["manhattan", "sf"]) {
    const real = await onWater(id, (p) => p);
    const probe = await onWater(id, onSubwayShapes);
    // Docking puts the hull on the shoreline texel: 10 m WorldCover cells and
    // a slip mapped as land. 95% is what is left after that.
    claim(
      `${id}: timetabled ferries are on water`,
      (r: { n: number; frac: number }) => r.n > 200 && r.frac > 0.95,
      real,
      probe,
      `${(real.frac * 100).toFixed(1)}% of ${real.n} positions; probe ${(probe.frac * 100).toFixed(1)}% on subway shapes`,
    );
  }
}

console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) process.exit(1);
