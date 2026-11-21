// Gate on src/sim/eruption.ts and src/data/escape.ts: the timeline against the
// published ranges, the pumice integral, the darkness, the roofs, the surge,
// the story clock and the escape's outcomes.
//
// Every bound is a literal taken from the literature range (Sigurdsson et al.
// 1985; Luongo et al. 2003; Pliny 6.16 and 6.20), never read from the module.
// Each predicate is also run on a case it must reject (the vacuity probes), so
// a check that has stopped measuring anything shows as PROBE-FAIL.

import { readFileSync } from "node:fs";
import {
  clockRate, columnKm, eruptionAt, fallRateCmH, lightFactor, localHours, pumiceDepthM, quake,
  realSecondsBetween, resolveEscape, roofFailure, surgeFront, surgeReachM, utcMsAt, S4,
  type EscapeRun,
} from "../src/sim/eruption";
import { COAST_ROUTE, ENDINGS, GATE_ROUTES, STARTS, VENT, routeFor } from "../src/data/escape";
import { Origin } from "../src/geo";
import { parsePompeii } from "../src/data/pompeii";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(62)} ${detail}`);
  if (!ok) failures++;
}
function probe(label: string, rejected: boolean, detail: string): void {
  console.log(`${rejected ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(52)} ${detail}`);
  if (!rejected) failures++;
}
const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
const hm = (h: number) => `${String(Math.floor(h % 24)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

// --- the clock --------------------------------------------------------------
const era = Date.parse("0079-08-22T07:30:00Z");
check("era start reads 08:20 on the town clock", within(localHours(era), 8.3, 8.4), hm(localHours(era)));
check("utcMsAt inverts localHours", Math.abs(localHours(utcMsAt(13.25)) - 13.25) < 1e-9, "");

// --- the column -------------------------------------------------------------
check("no column before 13:00", columnKm(12.9) === 0, `${columnKm(12.9)}`);
check("column ~15 km by 13:30 (Pliny's pine tree)", within(columnKm(13.5), 12, 20), `${columnKm(13.5).toFixed(1)} km`);
check("white phase column 20-30 km at 18:00", within(columnKm(18), 20, 30), `${columnKm(18).toFixed(1)} km`);
check("grey phase column 28-35 km at 22:00", within(columnKm(22), 28, 35), `${columnKm(22).toFixed(1)} km`);

// --- the fall ---------------------------------------------------------------
const rates = [14.5, 16, 18, 19.5].map(fallRateCmH);
check("white pumice falls 10-20 cm/h through the afternoon", rates.every((r) => within(r, 10, 20)), rates.join(","));
check("grey pumice falls 10-20 cm/h overnight", within(fallRateCmH(26), 10, 20), `${fallRateCmH(26)}`);
check("nothing falls before 13:30", pumiceDepthM(13.4) === 0 && fallRateCmH(13.4) === 0, "");
check("17:00 depth 35-65 cm", within(pumiceDepthM(17), 0.35, 0.65), `${(pumiceDepthM(17) * 100).toFixed(0)} cm`);
const atSurge = pumiceDepthM(S4.atH);
check("pumice at the first surge into town 2.5-3 m", within(atSurge, 2.5, 3.0), `${atSurge.toFixed(2)} m at ${hm(S4.atH)}`);
// The closed form against a numerical integral of the rate it claims to integrate.
let num = 0;
for (let h = 12; h < 33; h += 1 / 600) num += (fallRateCmH(h + 1 / 1200) / 100) * (1 / 600);
check("closed-form depth matches the integrated fall rate", Math.abs(num - pumiceDepthM(33)) < 0.01, `${num.toFixed(3)} vs ${pumiceDepthM(33).toFixed(3)} m`);
probe("a halved integral is caught", Math.abs(num / 2 - pumiceDepthM(33)) >= 0.01, "");

// --- the darkness -----------------------------------------------------------
const monotoneDown = (f: (h: number) => number, h0: number, h1: number) => {
  let prev = Infinity;
  for (let h = h0; h <= h1; h += 1 / 60) { const v = f(h); if (v > prev + 1e-12) return false; prev = v; }
  return true;
};
check("light never rises 12:00-19:00", monotoneDown(lightFactor, 12, 19), "");
probe("monotone test rejects a brightening afternoon", !monotoneDown((h) => (h > 16 ? 0.5 : lightFactor(h)), 12, 19), "");
check("full daylight before the column", lightFactor(12.5) === 1, "");
check("near-night under the plume by mid-afternoon (<10% at 16:30)", lightFactor(16.5) < 0.1, `${lightFactor(16.5).toFixed(3)}`);
check("still some light at 13:30 (under 100%, over 30%)", within(lightFactor(13.5), 0.3, 0.99), `${lightFactor(13.5).toFixed(2)}`);
check("visibility under 1 km by 16:00", eruptionAt(16).visibilityM < 1000, `${eruptionAt(16).visibilityM.toFixed(0)} m`);
check("the column is in sight at 14:00 (visibility > 10 km)", eruptionAt(14).visibilityM > 10000, `${eruptionAt(14).visibilityM.toFixed(0)} m`);

// --- the roofs --------------------------------------------------------------
let firstRoof = NaN;
for (let h = 13; h < 30; h += 1 / 60) if (roofFailure(pumiceDepthM(h)) > 0) { firstRoof = h; break; }
check("roofs start failing 16:00-18:30", within(firstRoof, 16, 18.5), hm(firstRoof));
check("at 40-60 cm of pumice", within(pumiceDepthM(firstRoof), 0.4, 0.6), `${(pumiceDepthM(firstRoof) * 100).toFixed(0)} cm`);
check("no roof fails under 40 cm", roofFailure(0.39) === 0, "");

// --- quakes -----------------------------------------------------------------
let qDay = 0, qNight = 0;
for (let h = 14; h < 19; h += 1 / 120) qDay = Math.max(qDay, quake(h));
for (let h = 24; h < 29; h += 1 / 120) qNight = Math.max(qNight, quake(h));
check("quakes before the column are nil", quake(12) === 0, "");
check("the night shakes harder than the afternoon (Pliny 6.20)", qNight > qDay, `${qDay.toFixed(2)} < ${qNight.toFixed(2)}`);

// --- the surges -------------------------------------------------------------
let wallH = NaN;
for (let h = 24; h < 34; h += 1 / 600) if (surgeReachM(h) >= 9300) { wallH = h; break; }
check("first surge reaches the town 06:30-07:30", within(wallH, 30.5, 31.5), hm(wallH));
check("no surge reaches the town before 06:00", surgeReachM(30) < 9300, `${surgeReachM(30).toFixed(0)} m`);
const f = surgeFront(S4.atH - 0.01);
check("the S4 front is moving toward the town just before arrival", !!f && f.moving && f.frontM < 9300 && f.frontM > 8000, f ? `${f.surge.name} ${f.frontM.toFixed(0)} m` : "none");

// --- the story clock --------------------------------------------------------
const runS = realSecondsBetween(12.75, S4.atH + 0.25, "story");
check("a full story run is 15-25 real minutes", within(runS / 60, 15, 25), `${(runS / 60).toFixed(1)} min`);
check("real-time mode runs at 1x", clockRate(15, "real") === 1 && clockRate(25, "real") === 1, "");
probe("the run length bound rejects real time", !within(realSecondsBetween(12.75, S4.atH + 0.25, "real") / 60, 15, 25), "");

// --- the routes, from the real gates ----------------------------------------
const data = parsePompeii(readFileSync("public/landmarks/pompeii.json", "utf8"));
const o = new Origin(data.lat0, data.lon0);
const vent = o.toWorld(VENT.lat, VENT.lon);
const gateDist = (name: string) => {
  const g = data.gates.find((q) => q.name === name);
  return g ? Math.hypot(g.x - vent.x, g.z - vent.z) : NaN;
};
check("every route names a gate in the pack", GATE_ROUTES.every((r) => Number.isFinite(gateDist(r.gate))), GATE_ROUTES.filter((r) => !Number.isFinite(gateDist(r.gate))).map((r) => r.gate).join(",") || "all");
check("the gates are 8.5-11 km from the vent", GATE_ROUTES.every((r) => within(gateDist(r.gate), 8500, 11000)), GATE_ROUTES.map((r) => (gateDist(r.gate) / 1000).toFixed(1)).join(","));
check("both starts are inside the walls", Object.values(STARTS).every((s) => {
  let inside = false;
  const w = data.wall, n = w.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (w[i * 2 + 1] > s.z !== w[j * 2 + 1] > s.z && s.x < ((w[j * 2] - w[i * 2]) * (s.z - w[i * 2 + 1])) / (w[j * 2 + 1] - w[i * 2 + 1]) + w[i * 2]) inside = !inside;
  }
  return inside;
}), "");

const run = (gate: string | null, h: number, lampH: number | null = 12.8, coast = false, roofH: number | null = null): ReturnType<typeof resolveEscape> => {
  const route = gate ? routeFor(gate, gateDist(gate), coast) : null;
  const r: EscapeRun = { lampH, exit: route ? { route, h } : null, roofH };
  return resolveEscape(r);
};
const early = run("Porta di Stabia", 14);
check("south at 14:00 with a lamp lives", early.ending === "survived", `${early.ending} ${(early.distM / 1000).toFixed(1)} km`);
const late = run("Porta di Stabia", 29.5);
check("south at 05:30 is caught on the road", late.ending === "road", `${late.ending} at ${hm(late.h)}`);
check("Nocera at 15:00 lives", run("Porta Nocera", 15).ending === "survived", run("Porta Nocera", 15).ending);
check("north by Porta di Ercolano at 13:30 dies", run("Porta di Ercolano", 13.5).ending === "north", run("Porta di Ercolano", 13.5).ending);
check("Porta Vesuvio is death too", run("Porta Vesuvio", 14).ending === "north", run("Porta Vesuvio", 14).ending);
check("waiting at the shore dies", run("Porta Marina", 14).ending === "shore", run("Porta Marina", 14).ending);
check("the coast walk to Stabiae from Porta Marina at 14:00 lives", run("Porta Marina", 14, 12.8, true).ending === "survived", run("Porta Marina", 14, 12.8, true).ending);
check("staying in town ends with the town surge", run(null, 0).ending === "town", run(null, 0).ending);
check("the town ending comes at the S4 arrival", within(run(null, 0).h, 30.5, 31.5), hm(run(null, 0).h));
check("sheltering under a failing roof ends under it", run(null, 0, 12.8, false, 18).ending === "roof", "");
// Leaving earlier never leaves you closer to the mountain at the end.
let prevD = Infinity, mono = true;
for (let h = 14; h <= 30; h += 0.5) {
  const d = run("Porta di Stabia", h, 12.8).distM;
  if (d > prevD + 1e-6) mono = false;
  prevD = d;
}
check("leaving later never ends further from the vent", mono, "");
const lampN = run("Porta di Stabia", 25, 12.8), darkN = run("Porta di Stabia", 25, null);
check("a lamp gets you further in the night", lampN.distM > darkN.distM, `${(lampN.distM / 1000).toFixed(2)} vs ${(darkN.distM / 1000).toFixed(2)} km`);
// Probe: with no surges at all, every road out lives; the town is the only death left.
const noSurge = resolveEscape({ lampH: null, exit: { route: routeFor("Porta di Stabia", gateDist("Porta di Stabia"))!, h: 29.5 }, roofH: null }, () => 0);
probe("the late road death comes from the surge model", noSurge.ending === "survived", noSurge.ending);
check("every ending has text", (["survived", "road", "town", "roof", "north", "shore"] as const).every((k) => ENDINGS[k].title && ENDINGS[k].history.length > 80), "");
check("coast route goes south (radial > 0.5)", COAST_ROUTE.radial > 0.5, "");
const banned = /enslaved person/i;
check('the story says "slave", not "enslaved person"', !banned.test(JSON.stringify([STARTS, ENDINGS])), "");
probe("the wording check sees the phrase", banned.test("an enslaved person"), "");

if (failures) {
  console.log(`${failures} eruption check(s) failed`);
  process.exit(1);
}
console.log("eruption: all checks pass");
