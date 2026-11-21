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
  clockRate, columnKm, eruptionAt, walkPace, fallRateCmH, lightFactor, localHours, pumiceDepthM, quake,
  realSecondsBetween, resolveEscape, roofFailure, surgeFront, surgeReachM, utcMsAt, S4,
  ROOF_FAIL_START_M, ROOF_FALL_M, ROOF_LETHAL_M, hourAtDepth, roofCollapse, roofTag, roofTagDepthM, shelterDeathH,
  type EscapeRun,
} from "../src/sim/eruption";
import { COAST_ROUTE, ENDINGS, GATE_ROUTES, STARTS, VENT, routeFor } from "../src/data/escape";
import { Origin } from "../src/geo";
import { parsePompeii } from "../src/data/pompeii";
import { PompeiiLife } from "../src/data/pompeiilife";
import {
  ERUPTION_SURFACE_GLSL, ERUPTION_TERRAIN_FRAG_GLSL, PUMICE_GLSL, PUMICE_WHITE, ROOF_COLLAPSE_VERT_GLSL, VENT_ASH, ashFanAt, pumiceAlbedo,
} from "../src/render/eruption";
import { buildPompeii } from "../src/render/pompeiimesh";
import { escapeLabelTargets } from "../src/app/labels";
import { Flee, FleeField, PERSON_R_M, crowdShare, separate } from "../src/sim/flee";

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

// --- walking in it, and the ground it lies on --------------------------------
check("bare ground walks at full pace", walkPace(0) === 1, "");
check("half a metre of pumice costs a quarter of the pace or more", walkPace(0.5) <= 0.75, `${walkPace(0.5).toFixed(2)}`);
check("deep pumice still moves you (pace >= 0.4)", walkPace(3) >= 0.4, `${walkPace(3).toFixed(2)}`);
let prevP = 2, paceMono = true;
for (let d = 0; d <= 3; d += 0.05) { if (walkPace(d) > prevP) paceMono = false; prevP = walkPace(d); }
check("pace never rises with depth", paceMono, "");
// The town floor rises by the full depth; the countryside by depth x fan. At
// every gate the fan must be 1, or the gate is a step.
const fans = data.gates.map((g) => ashFanAt(vent.x, vent.z, g.x, g.z));
check("the pumice fan is whole at every gate (no step)", fans.every((x) => x > 0.999), fans.map((x) => x.toFixed(2)).join(","));
const bay = o.toWorld(40.747, 14.346);
check("across the bay, 12 km west, no pumice", ashFanAt(vent.x, vent.z, bay.x, bay.z) === 0, `${ashFanAt(vent.x, vent.z, bay.x, bay.z).toFixed(2)}`);
const stab = o.toWorld(40.704, 14.483);
check("Stabiae is under the fall (Pliny 6.16)", ashFanAt(vent.x, vent.z, stab.x, stab.z) > 0.5, `${ashFanAt(vent.x, vent.z, stab.x, stab.z).toFixed(2)}`);
probe("the gate test sees a fan that misses the town", !data.gates.every((g) => ashFanAt(vent.x + 20000, vent.z, g.x, g.z) > 0.999), "");

// --- the townsfolk leaving (sim/flee.ts) -----------------------------------
const field = new FleeField(data);
const reach = field.open.length;
check("the flow field covers the streets (> 3000 cells)", reach > 3000, `${reach} cells`);
const forum = data.publics.find((p) => p.kind === "forum")!;
const fx0 = forum.ring.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / (forum.ring.length / 2);
const fz0 = forum.ring.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / (forum.ring.length / 2);
check("the forum has a way out", Number.isFinite(field.distanceAt(fx0, fz0)), `${field.distanceAt(fx0, fz0)} cells`);
// Walk a person from the forum: they must reach a gate, and never climb the field.
{
  let x = fx0, z = fz0, steps = 0, climbed = false, last = field.distanceAt(x, z);
  for (; steps < 2000; steps++) {
    const n = field.downhill(x, z);
    if (!n) break;
    [x, z] = n;
    const d = field.distanceAt(x, z);
    if (d >= last) climbed = true;
    last = d;
  }
  const gd = Math.min(...data.gates.map((g) => Math.hypot(g.x - x, g.z - z)));
  check("a walker from the forum reaches a gate", gd < 12, `${gd.toFixed(1)} m from a gate after ${steps} steps`);
  check("every step is nearer a gate", !climbed, "");
}
const gatesReached = data.gates.filter((g) => field.distanceAt(g.x, g.z) === 0).length;
check("every gate is a way out", gatesReached === data.gates.length, `${gatesReached}/${data.gates.length}`);
check("the crowd thins through the night", crowdShare(15) === 1 && crowdShare(22) < 0.25 && crowdShare(28) < 0.1, `${crowdShare(15)} ${crowdShare(22).toFixed(2)} ${crowdShare(28).toFixed(2)}`);
probe("a cell off the streets has no way out", field.distanceAt(1e6, 1e6) === Infinity, "");

// --- the pumice's colour: never snow ------------------------------------------
// A colour reads as snow when it is bright and its blue is at least its red.
// Pumice is buff to grey: blue never above green, green never above red, and
// no brighter than old plaster.
const pumiceLike = (c: readonly number[]) => c[2] <= c[1] + 1e-9 && c[1] <= c[0] + 1e-9 && Math.max(...c) <= 0.65 && c[0] - c[2] < 0.2;
const tones = Array.from({ length: 21 }, (_, i) => pumiceAlbedo(i / 20));
check("pumice is never bluish or snow-bright, white phase to grey", tones.every(pumiceLike), tones.filter((c) => !pumiceLike(c)).map((c) => c.map((x) => x.toFixed(2)).join("/")).join(" ") || "all 21");
const wp = pumiceAlbedo(eruptionAt(15).whiteness), gp = pumiceAlbedo(eruptionAt(22).whiteness);
check("white phase (15:00) is buff: red over blue by 0.05+", wp[0] - wp[2] >= 0.05, wp.map((x) => x.toFixed(2)).join("/"));
check("grey phase (22:00) is grey: red and blue within 0.05", gp[0] - gp[2] < 0.05 && gp[0] < wp[0], gp.map((x) => x.toFixed(2)).join("/"));
check("the ash on the cone is darker than either pumice", Math.max(...VENT_ASH) < Math.min(...gp), VENT_ASH.join("/"));
// Both shaders that colour the pumice take it from the same snippet.
check("terrain and town draw pumice from pumiceAlbedo's numbers", ERUPTION_TERRAIN_FRAG_GLSL.includes(PUMICE_GLSL) && ERUPTION_SURFACE_GLSL.includes(PUMICE_GLSL) && PUMICE_GLSL.includes(PUMICE_WHITE[0].toFixed(4)), "");
check("no snow white left in the eruption shaders", !/vec3\(0\.9\d?, 0\.9\d?, 0\.9\d?\)/.test(ERUPTION_TERRAIN_FRAG_GLSL + ERUPTION_SURFACE_GLSL), "");
probe("the colour test rejects snow", !pumiceLike([0.92, 0.94, 0.98]), "");
probe("the colour test rejects a pale blue-grey", !pumiceLike([0.5, 0.52, 0.56]), "");

// --- names during the escape ---------------------------------------------------
const goal = { name: "Porta di Stabia", x: 165, z: 75 };
const shown = escapeLabelTargets(goal, () => 10);
check("during the escape only the objective is named, pinned", shown.length === 1 && shown[0].name === goal.name && !!shown[0].pin, shown.map((s) => s.name).join(","));
check("no objective, no names", escapeLabelTargets(null, () => 0).length === 0, "");
const mainSrc = readFileSync("src/main.ts", "utf8");
check("main.ts draws escapeLabelTargets while the escape runs", /escape\?\.running \? escapeLabelTargets\(escape\.objective/.test(mainSrc), "");
const onlyGoal = (names: string[]) => names.length <= 1 && names.every((n) => n === goal.name);
probe("the label test sees the town's names", !onlyGoal(["Villa Boscoreale", "House of the Greek Epigrams", goal.name]), "");

// --- the roofs coming down ------------------------------------------------------
const town = buildPompeii({ data, groundAt: () => 0, suburbs: false });
const roofs = town.roofs;
check("the town has its roofs listed (> 1000)", roofs.length > 1000, `${roofs.length}`);
let tiles = 0, tagged = 0;
const tagsSeen = new Set<number>();
for (let i = 0; i < town.mesh.surf.length; i += 4) if (town.mesh.surf[i] === 1) {
  tiles++;
  const t = town.mesh.surf[i + 3];
  if (t > 0) { tagged++; tagsSeen.add(t); }
}
check("nearly every tile vertex carries its roof's byte (> 98%)", tagged / tiles > 0.98, `${tagged}/${tiles}`);
const failSet = new Set(roofs.map((r) => roofTag(r.failM)));
check("every byte in the mesh is a listed roof's failure depth", [...tagsSeen].every((t) => failSet.has(t)), `${tagsSeen.size} distinct`);
check("each roof's depth survives the byte exactly", roofs.every((r) => Math.abs(roofTagDepthM(roofTag(r.failM)) - r.failM) < 1e-9), "");
check("failure depths lie in 40-120 cm", roofs.every((r) => within(r.failM, 0.4, 1.2)), "");
const fs = roofs.map((r) => r.failM).sort((a, b) => a - b);
const pct = (p: number) => fs[Math.floor(p * (fs.length - 1))];
check("staggered: the 10th and 90th percentile 20+ cm apart", pct(0.9) - pct(0.1) > 0.2, `${(pct(0.1) * 100).toFixed(0)}-${(pct(0.9) * 100).toFixed(0)} cm`);
const meanFail = (keep: (s: number) => boolean) => { const q = roofs.filter((r) => keep(r.spanM)); return q.reduce((a, r) => a + r.failM, 0) / Math.max(1, q.length); };
check("wide spans go first (mean depth, > 10 m vs < 5 m)", meanFail((s) => s > 10) < meanFail((s) => s < 5), `${meanFail((s) => s > 10).toFixed(2)} < ${meanFail((s) => s < 5).toFixed(2)} m`);
// The share of the town's roofs down never falls as the night goes on, and each roof only ever comes down.
const downAt = (h: number) => roofs.filter((r) => roofCollapse(r.failM, pumiceDepthM(h)) >= 1).length / roofs.length;
const collapseMono = (k: (failM: number, d: number) => number) => {
  for (const r of roofs.filter((_, i) => i % 25 === 0)) {
    let prev = -1;
    for (let h = 13; h < 31; h += 1 / 60) { const v = k(r.failM, pumiceDepthM(h)); if (v < prev - 1e-12) return false; prev = v; }
  }
  return true;
};
check("every roof only ever comes down (collapse monotone in time)", collapseMono(roofCollapse), "");
check("no roof down before 16:00, all down by 22:00", downAt(16) === 0 && downAt(22) === 1, `${downAt(16)} ${downAt(22)}`);
check("about half the town's roofs are down by 18:30", within(downAt(18.5), 0.3, 0.8), `${(downAt(18.5) * 100).toFixed(0)}%`);
probe("the monotone test sees a roof that stands back up", !collapseMono((f, d) => roofCollapse(f, d) * (d > 1 ? 0 : 1)), "");
// Sheltering: the end comes when the roof overhead has visibly finished coming down, never before.
const deathShown = (rule: (failM: number, h0: number) => number) => roofs.filter((_, i) => i % 10 === 0).every((r) => {
  for (const h0 of [13.5, 15, 16.5, 17.5]) {
    const startH = hourAtDepth(r.failM);
    if (h0 > startH) continue;
    const dh = rule(r.failM, h0);
    if (roofCollapse(r.failM, pumiceDepthM(dh)) < 1 - 1e-6 || dh >= S4.atH) return false;
  }
  return true;
});
check("sheltering ends as the roof overhead finishes falling (shown on screen)", deathShown(shelterDeathH), "");
check("with no roof standing nearby, the old 60 cm rule", within(shelterDeathH(null, 14), 17, 18.5), hm(shelterDeathH(null, 14)));
probe("the shelter test sees the old fixed-depth rule", !deathShown(() => hourAtDepth(ROOF_LETHAL_M)), "");
check("the shader's numbers are the module's", ROOF_COLLAPSE_VERT_GLSL.includes(ROOF_FALL_M.toFixed(6)) && ROOF_COLLAPSE_VERT_GLSL.includes(ROOF_FAIL_START_M.toFixed(6)), "");

// --- no one walks through anyone ---------------------------------------------------
{
  const n = 80, xs = new Float64Array(n), zs = new Float64Array(n), rs = new Float64Array(n).fill(PERSON_R_M);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) { xs[i] = rnd() * 9; zs[i] = rnd() * 9; }
  const minGap = () => { let m = Infinity; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) m = Math.min(m, Math.hypot(xs[i] - xs[j], zs[i] - zs[j])); return m; };
  const before = minGap();
  for (let k = 0; k < 20; k++) separate(xs, zs, rs, n, 3);
  check("separation spreads a packed crowd to shoulder room", minGap() >= 2 * PERSON_R_M * 0.9, `${before.toFixed(2)} -> ${minGap().toFixed(2)} m`);
}
const gateRun = (sep: boolean) => {
  const g = data.gates.find((q) => q.name === "Porta di Stabia")!;
  const cx = g.x - 5, cz = g.z - 7;
  const life = new PompeiiLife(data, { people: 64, carts: 2 });
  const fl = new Flee(field);
  fl.separation = sep;
  life.update(0, cx, cz);
  life.steer = (p, c, dt, x, z) => { fl.update(p, c, dt, x, z, 1, 1); };
  let worst = Infinity, crowd = 0;
  for (let step = 0; step < 900; step++) {
    life.update(1 / 30, cx, cz);
    if (step % 30 !== 29) continue;
    const ps = life.people.filter((a) => a.x < 5e4);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) worst = Math.min(worst, Math.hypot(ps[i].x - ps[j].x, ps[i].z - ps[j].z));
    crowd = Math.max(crowd, ps.filter((a) => Math.hypot(a.x - g.x, a.z - g.z) < 50).length);
  }
  return { worst, crowd };
};
const withSep = gateRun(true), noSep = gateRun(false);
check("walking to the gate, nobody passes through anybody (min gap > 0.45 m)", withSep.worst > 0.45, `${withSep.worst.toFixed(2)} m`);
check("a crowd at the gate in the fall (20+ people within 50 m)", withSep.crowd >= 20, `${withSep.crowd}`);
probe("without separation the stream overlaps", noSep.worst < 0.3, `${noSep.worst.toFixed(2)} m`);

if (failures) {
  console.log(`${failures} eruption check(s) failed`);
  process.exit(1);
}
console.log("eruption: all checks pass");
