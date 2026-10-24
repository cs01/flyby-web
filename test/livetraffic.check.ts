// The gate on live traffic: src/data/livetraffic.ts (feed, altitude, dead
// reckoning, correction blend, stale removal) and src/data/aircrafttypes.ts
// (type and livery mapping).
//
// WHAT CAN GO WRONG HERE THAT STILL RENDERS. Every one of these draws a sky
// full of aircraft with no error anywhere:
//
//   * the projection flips north and south, and the whole sky is mirrored
//     about the city's parallel. Aircraft still fly, just over the wrong water.
//   * altitude is taken raw from pressure altitude. On a 1033 hPa day every
//     aircraft is drawn 160 m low, and a jet on the runway sits under it.
//   * track is read as a math angle (from east, anticlockwise) instead of a
//     compass bearing, and every aircraft flies sideways down its own track.
//   * a correction is applied in one frame, or eased over a fixed 2 s, and a
//     minute of turn-prediction error becomes a 500 m/s slide.
//   * an aircraft that left the feed is drawn forever, or one still in it is
//     dropped because the server re-served a cached answer.
//   * a landing dips the wheels through the runway while the ground report's
//     correction eases in.
//
// WATCHED TO FAIL. Every claim is a predicate, run on the real case (must
// pass) and on a broken case built to violate it (must fail), so a predicate
// that has stopped looking cannot pass. Bounds are literals.

import { Origin } from "../src/geo";
import {
  LiveTraffic,
  deadReckon,
  altitudeAmslM,
  feedQnh,
  parseFeed,
  worldToGeo,
  routePlausible,
  parseRoute,
  FT,
  KT,
  type Kinematics,
  type PlaneFeed,
  type PlaneReport,
  type Pose,
} from "../src/data/livetraffic";
import { familyFor, liveryFor, airlineOf } from "../src/data/aircrafttypes";
import { airportById, spotPose, bearingDeg } from "../src/data/airports";
import { haversine } from "../src/geo";

let checks = 0;
let failures = 0;

/** `holds` on the real case, and NOT on the probe case. */
function claim<T>(name: string, holds: (c: T) => boolean, real: T, probe: T, detail: string): void {
  checks++;
  const ok = holds(real);
  const probeRejected = !holds(probe);
  const pass = ok && probeRejected;
  if (!pass) failures++;
  console.log(
    `${pass ? "  ok" : "FAIL"} ${name.padEnd(64)} ${detail}` +
      (ok ? "" : "  [real case fails]") +
      (probeRejected ? "" : "  [VACUOUS: probe passed]"),
  );
}

const NYC = new Origin(40.7549, -73.984);
const T0 = Date.UTC(2026, 9, 24, 15, 0, 0);

function report(p: Partial<PlaneReport>): PlaneReport {
  return {
    hex: "abc123", flight: "DAL964", reg: "N387DN", type: "A321", desc: "", cat: "A3",
    lat: 40.7549, lon: -73.984, alt: 5000, baro: 4600, qnh: null, gs: 250, track: 90, vr: 0,
    seen: 0, ground: false, ...p,
  };
}

// --- 1. projection round trip ------------------------------------------------
{
  // 40 km out on a diagonal: the far side of the server's 40 nm cell.
  const lat = 41.05, lon = -73.55, altM = 3048;
  const roundTrip = (o: { toWorld: Origin["toWorld"] }) => {
    const w = o.toWorld(lat, lon);
    const g = worldToGeo(NYC, w.x, altM, w.z);
    return Math.abs(g.lat - lat) < 1e-7 && Math.abs(g.lon - lon) < 1e-7 && Math.abs(g.altFt * FT - altM) < 1e-6;
  };
  const mirrored = { toWorld: (a: number, b: number) => { const w = NYC.toWorld(a, b); return { x: w.x, z: -w.z }; } };
  claim("lat/lon/alt -> world -> lat/lon/alt is exact 40 km out", roundTrip, NYC, mirrored as Origin, "probe: z north instead of south");
  // And the sign itself: north of the origin is -z, the convention in geo.ts.
  const north = NYC.toWorld(40.85, -73.984);
  claim("north of the origin is -z", (z: number) => z < -10000, north.z, -north.z, `${north.z.toFixed(0)} m`);
}

// --- 2. altitude ---------------------------------------------------------------
{
  // An A321 on the runway at LGA, field elevation 21 ft, on a 1032.8 hPa day:
  // pressure altitude reads 21 - 19.55 * 27.3 = -513 ft.
  const onRunway = report({ baro: -513, alt: -350, qnh: 1032.8 });
  const qnh = feedQnh([onRunway, report({ qnh: 1032.8 }), report({ qnh: 1013.2 })]);
  const fieldM = 21 * FT;
  const near = (m: number | null) => m !== null && Math.abs(m - fieldM) < 4;
  claim(
    "baro + feed QNH puts a jet on the runway at LGA within 4 m",
    near,
    altitudeAmslM(onRunway, qnh, -30),
    altitudeAmslM(onRunway, null, -30) === null ? 0 : -513 * FT,
    `QNH ${qnh} -> ${altitudeAmslM(onRunway, qnh, -30)?.toFixed(1)} m vs ${fieldM.toFixed(1)}; probe: raw baro`,
  );
  // At cruise the geometric height wins: 35,000 ft geom with geoid -30 m.
  const cruise = report({ alt: 35000, baro: 34400, qnh: 1032.8 });
  const want = 35000 * FT + 30;
  claim(
    "above 14,000 ft the geometric height less the geoid is used",
    (m: number | null) => m !== null && Math.abs(m - want) < 1,
    altitudeAmslM(cruise, 1032.8, -30),
    (34400 + 19.55 * 27.3) * FT,
    `${altitudeAmslM(cruise, 1032.8, -30)?.toFixed(0)} m; probe: baro path at cruise`,
  );
  // Continuity through the baro/geom mix band: no step bigger than a
  // 100 ft climb's worth anywhere between 9,000 and 15,000 ft.
  let worst = 0;
  let prev: number | null = null;
  for (let ft = 9000; ft <= 15000; ft += 100) {
    const m = altitudeAmslM(report({ baro: ft, alt: ft + 500, qnh: 1032.8 }), 1032.8, -30)!;
    if (prev !== null) worst = Math.max(worst, Math.abs(m - prev));
    prev = m;
  }
  claim("altitude is continuous through the baro/geom mix", (w: number) => w < 100 * FT * 1.6, worst, 600 * FT, `worst step ${worst.toFixed(1)} m per 100 ft`);
}

// --- 3. dead reckoning -----------------------------------------------------------
{
  const k: Kinematics = { x: 0, y: 1000, z: 0, t: T0, trackDeg: 90, gsMs: 250 * KT, vrMs: 0, turnDps: 0, ground: false };
  const p: Pose = { x: 0, y: 0, z: 0, headingDeg: 0, pitchDeg: 0, bankDeg: 0 };
  deadReckon(k, T0 + 60000, p);
  const east = 250 * KT * 60;
  const isEast = (q: Pose) => Math.abs(q.x - east) < 0.5 && Math.abs(q.z) < 0.5;
  claim("track 090 for 60 s at 250 kt goes 7.7 km east", isEast, { ...p }, { ...p, x: 0, z: -east }, `x ${p.x.toFixed(1)} z ${p.z.toFixed(1)}; probe: math-angle track`);

  // A standard-rate right turn from north: 90 degrees in 30 s, then straight.
  const turn: Kinematics = { ...k, trackDeg: 0, turnDps: 3 };
  deadReckon(turn, T0 + 30000, p);
  const r = (250 * KT) / (3 * Math.PI / 180);
  const onArc = (q: Pose) => Math.abs(q.x - r) < 1 && Math.abs(q.z + r) < 1 && Math.abs(q.headingDeg - 90) < 0.01;
  claim("a 3 deg/s turn from north ends 90 deg on, at (r, -r)", onArc, { ...p }, { ...p, x: r * Math.PI / 2, z: 0 }, `r ${r.toFixed(0)} m -> (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) hdg ${p.headingDeg.toFixed(1)}`);
  deadReckon(turn, T0 + 60000, p);
  claim("the turn stops after 30 s", (h: number) => Math.abs(h - 90) < 0.01, p.headingDeg, 180, `heading at 60 s ${p.headingDeg.toFixed(1)}`);
}

// --- 4. correction blend ------------------------------------------------------------
/**
 * Largest per-frame movement of the drawn aircraft beyond what its own speed
 * covers in a frame. Speed is the same 250 kt in both reports, so anything
 * over v*dt is the correction.
 */
function worstExcess(drawn: Pose[], perFrameM: number): number {
  let worst = 0;
  for (let i = 1; i < drawn.length; i++) {
    const d = Math.hypot(drawn[i].x - drawn[i - 1].x, drawn[i].y - drawn[i - 1].y, drawn[i].z - drawn[i - 1].z);
    worst = Math.max(worst, d - perFrameM);
  }
  return worst;
}
{
  // An aircraft the prediction carried straight while it actually turned: the
  // second report lands well off where the first one said it would be.
  const lt = new LiveTraffic(NYC);
  const feed = (now: number, p: Partial<PlaneReport>): PlaneFeed => ({ now, ac: [report(p)] });
  lt.ingest(feed(T0, { lat: 40.70, lon: -74.05, track: 90, gs: 250 }), T0);
  const FRAME = 1000 / 60;
  const tr = lt.tracks.get("abc123")!;
  const drawn: Pose[] = [];
  const predicted: Pose[] = [];
  let missM = 0;
  for (let t = T0; t < T0 + 120000; t += FRAME) {
    if (Math.abs(t - (T0 + 60000)) < FRAME / 2) {
      const before = deadReckon(tr.k, t, { x: 0, y: 0, z: 0, headingDeg: 0, pitchDeg: 0, bankDeg: 0 });
      lt.ingest(feed(t, { lat: 40.71, lon: -73.97, track: 60, gs: 250 }), t);
      const after = deadReckon(tr.k, t, { x: 0, y: 0, z: 0, headingDeg: 0, pitchDeg: 0, bankDeg: 0 });
      missM = Math.hypot(after.x - before.x, after.z - before.z);
    }
    lt.step(t);
    drawn.push({ ...tr.pose });
    predicted.push(deadReckon(tr.k, t, { x: 0, y: 0, z: 0, headingDeg: 0, pitchDeg: 0, bankDeg: 0 }));
  }
  const vFrame = (250 * KT) / 60;
  // 1.2 m per 60 Hz frame is 72 m/s: the 60 m/s cap plus smoothstep slack.
  const excess = worstExcess(drawn, vFrame);
  claim(
    `a ${(missM / 1000).toFixed(1)} km correction never moves it > 1.2 m/frame beyond its speed`,
    (tr2: Pose[]) => worstExcess(tr2, vFrame) < 1.2,
    drawn,
    predicted,
    `worst ${excess.toFixed(2)} m/frame; probe: the raw prediction jumps ${worstExcess(predicted, vFrame).toFixed(0)} m`,
  );
  const last = predicted[predicted.length - 1];
  const settled = Math.hypot(tr.pose.x - last.x, tr.pose.z - last.z);
  claim("and 60 s later it is back on the prediction", (d: number) => d < 0.01, settled, 50, `${settled.toFixed(3)} m off`);
}
{
  // Landing: airborne at 60 ft on short final, then a ground report 20 s on.
  // Ground is a flat 6 m (LGA's runway is 21 ft).
  const lt = new LiveTraffic(NYC, { groundAt: () => 6.4 });
  const fin = (now: number, p: Partial<PlaneReport>): PlaneFeed => ({ now, ac: [report(p)] });
  lt.ingest(fin(T0, { lat: 40.76, lon: -73.89, baro: 60, alt: 70, qnh: 1013.25, gs: 140, track: 40, vr: -700 }), T0);
  const tr = lt.tracks.get("abc123")!;
  let minY = Infinity;
  let worstDy = 0;
  let prevY: number | null = null;
  for (let t = T0; t < T0 + 40000; t += 1000 / 60) {
    if (Math.abs(t - (T0 + 20000)) < 1000 / 120) lt.ingest(fin(t, { lat: 40.770, lon: -73.877, ground: true, alt: 0, baro: null, gs: 60, track: 40, vr: null }), t);
    lt.step(t);
    minY = Math.min(minY, tr.pose.y);
    if (prevY !== null) worstDy = Math.max(worstDy, Math.abs(tr.pose.y - prevY));
    prevY = tr.pose.y;
  }
  claim("a landing never puts the aircraft below the runway", (y: number) => y >= 6.4 - 1e-9, minY, 6.4 - 3, `lowest ${minY.toFixed(2)} m on a 6.40 m runway`);
  claim("and never steps more than 0.5 m vertically in a frame", (d: number) => d < 0.5, worstDy, 18, `worst ${worstDy.toFixed(3)} m/frame; probe: alt-to-ground snap`);
  claim("after the ground report it ends on the ground", (y: number) => Math.abs(y - 6.4) < 1e-6, tr.pose.y, 6.4 + 18, `${tr.pose.y.toFixed(2)} m`);
}

// --- 5. stale removal and cached answers ----------------------------------------------
{
  const run = (relistEvery: number | null): boolean => {
    const lt = new LiveTraffic(NYC);
    const f: PlaneFeed = { now: T0, ac: [report({})] };
    lt.ingest(f, T0);
    for (let s = 1; s <= 61; s++) {
      // The server re-serving its cached answer: the same `now`, still listed.
      if (relistEvery !== null && s % relistEvery === 0) lt.ingest(f, T0 + s * 1000);
      lt.step(T0 + s * 1000);
    }
    return !lt.tracks.has("abc123");
  };
  claim("an aircraft no answer has listed for 61 s is dropped", (gone: boolean) => gone, run(null), run(5), "probe: re-listed every 5 s by a cached answer");
  const lt = new LiveTraffic(NYC);
  const f: PlaneFeed = { now: T0, ac: [report({})] };
  lt.ingest(f, T0);
  claim("a re-served cached answer brings in nothing", (n: number) => n === 0, lt.ingest(f, T0 + 5000), 1, "same `now` twice");
  const lt2 = new LiveTraffic(NYC);
  lt2.ingest(f, T0);
  for (let s = 1; s <= 59; s++) lt2.step(T0 + s * 1000);
  claim("and one listed 59 s ago is still drawn", (has: boolean) => has, lt2.tracks.has("abc123"), false, "");
}

// --- 6. feed parsing -------------------------------------------------------------------
{
  const body = { now: T0, ac: [{ hex: "a1b535", flight: "UAL2171 ", lat: 40.7, lon: -74.7, alt: 13825, baro: 13325, gs: 385, track: 297, vr: 3008, seen: 0.3, ground: false, type: "B772", cat: "A5" }, { hex: "nopos" }] };
  const parsed = parseFeed(body);
  claim(
    "parseFeed keeps positioned aircraft and trims callsigns",
    (p: ReturnType<typeof parseFeed>) => p !== null && p.ac.length === 1 && p.ac[0].flight === "UAL2171",
    parsed,
    parseFeed({ ac: "nope", now: T0 }),
    `${parsed?.ac.length} kept`,
  );
}

// --- 7. type and livery mapping ---------------------------------------------------------
{
  const want: [string, string, string][] = [
    ["A20N", "A3", "a320"], ["A321", "A3", "a321"], ["A21N", "A3", "a321"], ["B738", "A3", "b738"],
    ["B39M", "A3", "b738"], ["B77W", "A5", "b77w"], ["B789", "A5", "b789"], ["E75L", "A3", "e175"],
    ["CRJ9", "A3", "crj7"], ["DH8D", "A2", "dh8d"], ["C172", "A1", "pa28"], ["GLF4", "A3", "cl60"],
    ["B407", "A7", "heli"], ["ZZZZ", "A7", "heli"], ["ZZZZ", "A1", "pa28"], ["", "A3", "a320"],
  ];
  const allMatch = (fn: typeof familyFor) => want.every(([t, c, f]) => fn(t, c) === f);
  claim("ICAO types and categories map to their families", allMatch, familyFor, () => "a320", `${want.length} cases; probe: everything an A320`);
  const liv = ["default", "DAL", "UAL", "AAL"];
  const cases: [string, string][] = [["DAL964", "DAL"], ["EDV5045", "DAL"], ["RPA4500", "default"], ["N543TH", "default"], ["JBU12", "default"], ["ENY3300", "AAL"]];
  const liveriesMatch = (fn: typeof liveryFor) => cases.every(([cs, w]) => fn(cs, liv) === w);
  claim("callsigns pick their brand's livery, or plain", liveriesMatch, liveryFor, (cs: string) => airlineOf(cs) || "default", `${cases.length} cases; probe: raw prefix`);
}

// --- 8. route plausibility -------------------------------------------------------------
{
  const end = (code: string, lat: number, lon: number) => ({ city: code, code, name: code, lat, lon });
  const jfkBos = parseRoute({ from: end("JFK", 40.64, -73.78), to: end("BOS", 42.36, -71.01), airline: "JetBlue" })!;
  const sjcAtl = parseRoute({ from: end("SJC", 37.36, -121.93), to: end("ATL", 33.64, -84.43), airline: "Delta" })!;
  // Over Long Island Sound, halfway up.
  claim("a JFK-BOS flight over the Sound has a plausible route", (r: typeof jfkBos) => routePlausible(r, 41.1, -72.9), jfkBos, sjcAtl, "probe: SJC-ATL, the stale route DAL964 came back with");
  claim("a route ending behind the aircraft is not plausible", (lat: number) => !routePlausible(jfkBos, lat, -70.0), 44.5, 41.5, "past BOS vs mid-route");
  claim("parseRoute reads {} as no route", (b: unknown) => parseRoute(b) === null, {}, { from: end("A", 1, 1), to: end("B", 2, 2) }, "");
}

// --- 9. airport spotting pose --------------------------------------------------------------
{
  const lga = airportById("lga")!;
  const sw = spotPose(lga, 215);
  claim("a south-west wind at LGA puts the drone on runway 22", (p: typeof sw) => p.runway === "22", sw, spotPose(lga, 35), `wind 215 -> ${sw.runway}; probe: wind 035 -> ${spotPose(lga, 35).runway}`);
  const thr = lga.runways[0][1];
  const off = haversine(thr, sw);
  claim("and 60-150 m beside its threshold", (m: number) => m > 60 && m < 150, off, haversine(thr, lga), `${off.toFixed(0)} m; probe: the airport reference point`);
  // On the right: the bearing from the threshold to the drone is ~90 deg
  // clockwise of the runway heading.
  const side = ((bearingDeg(thr, sw) - bearingDeg(thr, lga.runways[0][0]) + 360) % 360);
  claim("on the right of the centreline, looking down the runway", (d: number) => Math.abs(d - 90) < 3, side, 270, `${side.toFixed(1)} deg off the runway heading, looking ${sw.hdgDeg.toFixed(0)}`);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) process.exit(1);
