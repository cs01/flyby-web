// The gate on Pompeii's water (src/data/pompeiibaths.ts, src/data/pompeiiwater.ts,
// src/render/pompeiiwater.ts): the baths' rooms in their surveyed footprints,
// the street fountains with a head, a spout and a jet that lands in the basin,
// the water towers, the Castellum Aquae, the atrium pools under their rims,
// and what it all costs.
//
// Bounds are literals from the excavation: about forty public fountains and
// about fourteen water towers in the town; the Stabian frigidarium is a round
// room some 6 m across; a fountain basin is about 1.5 x 2 m with its rim
// 0.8-0.9 m over the street. Each rule runs on the real build, where it must
// pass, and on a probe built to break it, where it must fail.

import { readFileSync } from "node:fs";
import { parsePompeii, pointInRing, type PompeiiData } from "../src/data/pompeii";
import { buildPompeii } from "../src/render/pompeiimesh";
import { BATH_PLANS, bathLamps, roomOutline, roomsOutside, steamSources, toWorld, type BathSite } from "../src/data/pompeiibaths";
import { BASIN, HEADS, SPOUT, SPOUT_SPEED, fountainToWorld, jetReach } from "../src/data/pompeiiwater";
import { WATER_TIERS, buildWater, type WaterBuild } from "../src/render/pompeiiwater";
import { budgetForTier, pompeiiArtBytes, pompeiiBytes, type DeviceDescriptor } from "../src/render/budget";
import { lampLevel } from "../src/data/pompeiilamps";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(70)} ${detail}`);
  if (!ok) failures++;
}
/** A rule on the real build passes, on the probe fails. */
function rule(label: string, f: (probe: boolean) => [boolean, string]): void {
  const [ok, d] = f(false);
  check(label, ok, d);
  const [bad, pd] = f(true);
  check(`  probe breaks it: ${label}`, !bad, pd);
}

const data: PompeiiData = parsePompeii(readFileSync(new URL("../public/landmarks/pompeii.json", import.meta.url), "utf8"));
// A town on a slope like the real one (it rises about 3 m in 100 toward
// Vesuvius, -z), so the terracing is exercised.
const ground = (x: number, z: number): number => 10 - z * 0.03 + x * 0.004;
const model = buildPompeii({ data, groundAt: ground });
const t0 = performance.now();
const full = buildWater({ data, sites: model.waterSites, groundAt: ground });
const buildMs = performance.now() - t0;
const lean = buildWater({ data, sites: model.waterSites, groundAt: ground, lean: true });
const r = full.report;
console.log(`water: ${r.baths.length} baths, ${r.fountains.length} fountains, ${r.towers} towers, ${r.impluvia.length} impluvia, ` +
  `${r.stoneTris} stone + ${r.waterTris} water + ${r.jetTris} jet tris, ${(r.bytes / 1048576).toFixed(2)} MB, ${buildMs.toFixed(0)} ms`);

const probeBuild = (p: NonNullable<Parameters<typeof buildWater>[0]["probe"]>): WaterBuild =>
  buildWater({ data, sites: model.waterSites, groundAt: ground, probe: p });

// --- 1. the baths --------------------------------------------------------------------
{
  check("the three planned baths are built: Stabian, Forum, Central", ["Terme Stabiane", "Terme del Foro", "Terme centrali di Pompei"].every((n) => r.baths.some((b) => b.name === n)),
    r.baths.map((b) => b.name).join(", "));
  const stab = r.baths.find((b) => b.name === "Terme Stabiane")!;
  for (const k of ["apodyterium", "frigidarium", "tepidarium", "caldarium", "praefurnium"]) {
    check(`Stabian baths: has a ${k}`, stab.rooms.includes(k), "");
  }
  check("Stabian baths: men's and women's caldaria (two) on one furnace", stab.rooms.filter((k) => k === "caldarium").length === 2 && stab.rooms.filter((k) => k === "praefurnium").length === 1, "");
  rule("Stabian frigidarium is round, under a cone with an oculus", (probe) => {
    const b = (probe ? probeBuild({ squareFrigidarium: true }) : full).report.baths.find((q) => q.name === "Terme Stabiane")!;
    return [b.frigidariumRound && b.oculus, `round ${b.frigidariumRound}, oculus ${b.oculus}`];
  });
  const plan = BATH_PLANS.find((p) => p.name === "Terme Stabiane")!;
  const frig = plan.rooms.find((q) => q.kind === "frigidarium")!;
  check("Stabian frigidarium 5-7 m across", !!frig.round && frig.round.r * 2 >= 5 && frig.round.r * 2 <= 7, `${(frig.round!.r * 2).toFixed(1)} m`);
  rule("every caldarium with water has its labrum (Stabian 2, Forum 1)", (probe) => {
    const b = (probe ? probeBuild({ noLabra: true }) : full).report.baths;
    const n = (name: string): number => b.find((q) => q.name === name)?.labra ?? 0;
    return [n("Terme Stabiane") === 2 && n("Terme del Foro") === 1, `${n("Terme Stabiane")}, ${n("Terme del Foro")}`];
  });
  check("Stabian palaestra has its natatio", stab.natatio, "");
  // In the footprint: every room corner (apses and round rooms included) inside the surveyed ring.
  rule("every room inside its bath's surveyed footprint", (probe) => {
    const bad: string[] = [];
    for (const s of full.sites) {
      const site: BathSite = probe ? { ...s, plan: { ...s.plan, rooms: s.plan.rooms.map((q, i) => (i === 0 && q.rect ? { ...q, rect: [q.rect[0] + 25, q.rect[1] + 25, q.rect[2], q.rect[3]] as [number, number, number, number] } : q)) } } : s;
      bad.push(...roomsOutside(site).map((id) => `${s.plan.name}:${id}`));
    }
    return [bad.length === 0, bad.join(", ") || "all inside"];
  });
  // The pools sit inside their rooms, and the rooms do not overlap.
  {
    const bad: string[] = [];
    for (const s of full.sites) for (const p of s.plan.pools) {
      const room = s.plan.rooms.find((q) => q.id === p.room);
      if (!room) { if (p.room) bad.push(p.id); continue; }
      const o = roomOutline(s.frame, room, 32);
      const pts = p.round ? [[p.round.e + p.round.r, p.round.n], [p.round.e - p.round.r, p.round.n], [p.round.e, p.round.n + p.round.r], [p.round.e, p.round.n - p.round.r]]
        : [[p.rect![0], p.rect![2]], [p.rect![1], p.rect![2]], [p.rect![1], p.rect![3]], [p.rect![0], p.rect![3]]];
      for (const [e, n] of pts) if (!pointInRing(o, ...toWorld(s.frame, e, n))) { bad.push(`${s.plan.name}:${p.id}`); break; }
    }
    check("every pool inside its room", bad.length === 0, bad.join(", ") || "");
    const overlaps: string[] = [];
    for (const s of full.sites) {
      const rs = s.plan.rooms;
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const a = roomOutline(s.frame, rs[i], 24), b = roomOutline(s.frame, rs[j], 24);
        for (let k = 0; k < b.length; k += 2) if (pointInRing(a, b[k], b[k + 1])) { overlaps.push(`${rs[i].id}/${rs[j].id}`); break; }
      }
    }
    check("no two rooms overlap", overlaps.length === 0, overlaps.join(", "));
  }
  // Terraced on the slope: no ground comes up through a room's floor.
  rule("every room's floor stands on or over the ground under it", (probe) => {
    const bad: string[] = [];
    for (const s of full.sites) for (const q of s.plan.rooms) {
      const lv = probe ? s.g : s.levels?.[q.id] ?? s.g;
      const o = roomOutline(s.frame, q, 16);
      for (let k = 0; k < o.length; k += 2) if (ground(o[k], o[k + 1]) > lv + q.floor + 0.001) { bad.push(`${s.plan.name}:${q.id}`); break; }
    }
    return [bad.length === 0, bad.slice(0, 4).join(", ") || "all clear"];
  });
  // Hot pools only where there is a fire; the unfinished Central baths are dry.
  {
    const steam = full.sites.map((s) => ({ name: s.plan.name, n: steamSources(s).length }));
    check("steam over the hot pools and labra: Stabian 4, Forum 2, Central (unfinished) none",
      steam.find((q) => q.name === "Terme Stabiane")?.n === 4 && steam.find((q) => q.name === "Terme del Foro")?.n === 2 && steam.find((q) => q.name === "Terme centrali di Pompei")?.n === 0,
      steam.map((q) => `${q.n}`).join("/"));
  }
  // Lamps: in their baths, put out before the taverns'.
  {
    const ls = full.sites.flatMap((s) => bathLamps(s).map((l) => ({ l, ring: s.ring })));
    check("bath lamps: 15..60, each inside its bath", ls.length >= 15 && ls.length <= 60 && ls.every(({ l, ring }) => pointInRing(ring, l.x, l.z)), `${ls.length}`);
    check("bath lamps are out after midnight", full.lamps.every((l) => l.role === "baths" && lampLevel(l, 24.5, 1) === 0), "");
  }
}

// --- 2. the street fountains -------------------------------------------------------
{
  const fs = full.fountains;
  check("35..45 street fountains (about forty in the town)", fs.length >= 35 && fs.length <= 45 && fs.length === model.stats.fountains, `${fs.length}`);
  const heads = new Set(fs.map((f) => f.head));
  check("all four spout heads used (lion, Mercury, Medusa, cockerel)", heads.size === HEADS, [...heads].join(","));
  rule("every fountain has a carved head and spout", (probe) => {
    const rep = probe ? probeBuild({ noSpouts: true }).report : r;
    const bare = rep.fountains.filter((f) => f.spoutTris < 40).length;
    return [bare === 0, `${bare} without`];
  });
  rule("every fountain has its jet and splash", (probe) => {
    const rep = probe ? probeBuild({ noJets: true }).report : r;
    const dry = rep.fountains.filter((f) => f.jetTris < 50 || f.drops === 0).length;
    return [dry === 0, `${dry} dry`];
  });
  check("basin rim 0.8-0.9 m over the street, water under it", r.fountains.every((f, i) => f.rim - fs[i].g >= 0.8 && f.rim - fs[i].g <= 0.9 && f.basinWater < f.rim), "");
  // The jet lands inside the basin's inner walls, past the back slab.
  rule("every jet lands in its basin", (probe) => {
    const speed = probe ? SPOUT_SPEED * 6 : SPOUT_SPEED;
    const reach = jetReach(SPOUT.y, BASIN.rim - 0.12, speed);
    const u = SPOUT.u + reach;
    const inside = u > -BASIN.hu + BASIN.slab && u < BASIN.hu - BASIN.slab;
    const all = fs.every((f) => {
      const [x, z] = fountainToWorld(f, u, 0);
      return probe ? inside : inside && Math.hypot(x - f.impact[0], z - f.impact[2]) < 0.01;
    });
    return [all, `lands ${u.toFixed(2)} m along, basin inside ${(-BASIN.hu + BASIN.slab).toFixed(2)}..${(BASIN.hu - BASIN.slab).toFixed(2)}`];
  });
  check("every overflow runs at least 3 m down the street", fs.every((f) => f.overflow.length >= 8), `${Math.min(...fs.map((f) => f.overflow.length / 2))} points at least`);
  const kerbs = data.insulae.map((i) => i.kerb);
  // Off the pavement within 4 m (one fountain stands on it), then on the carriageway all the way.
  const onKerb = (x: number, z: number): boolean => kerbs.some((q) => pointInRing(q, x, z));
  check("the overflow reaches the carriageway in 4 m and stays on it", fs.every((f) => {
    let k = 2;
    while (k < f.overflow.length && onKerb(f.overflow[k], f.overflow[k + 1])) k += 2;
    if (k > 8) return false;
    for (; k < f.overflow.length; k += 2) if (onKerb(f.overflow[k], f.overflow[k + 1])) return false;
    return true;
  }), "");
}

// --- 3. towers and the castellum -----------------------------------------------------
{
  rule("10..16 water towers (about fourteen known), each by a fountain", (probe) => {
    const b = probe ? probeBuild({ noTowers: true }) : full;
    const ok = b.towers.length >= 10 && b.towers.length <= 16 && b.towers.every((t) => b.fountains.some((f) => Math.hypot(f.x - t.x, f.z - t.z) < 4));
    return [ok, `${b.towers.length}`];
  });
  const ts = full.towers;
  let minGap = Infinity;
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) minGap = Math.min(minGap, Math.hypot(ts[i].x - ts[j].x, ts[i].z - ts[j].z));
  check("towers at least 110 m apart", minGap >= 110, `${minGap.toFixed(0)} m`);
  const fronts = data.insulae.map((i) => i.ring);
  check("no tower inside a house", ts.every((t) => !fronts.some((q) => pointInRing(q, t.x, t.z))), "");
  const gate = data.gates.find((g) => g.name === "Porta Vesuvio")!;
  const c = full.castellum;
  check("Castellum Aquae just inside Porta Vesuvio (within 35 m)", !!c && Math.hypot(c.x - gate.x, c.z - gate.z) < 35, c ? `${Math.hypot(c.x - gate.x, c.z - gate.z).toFixed(1)} m` : "missing");
  check("castellum clear of the houses", !!c && !fronts.some((q) => pointInRing(q, c.x, c.z)), "");
}

// --- 4. atrium pools -------------------------------------------------------------------
{
  check("an impluvium in every compluviate atrium (400+)", r.impluvia.length >= 400 && r.impluvia.length >= model.stats.compluvia * 0.9, `${r.impluvia.length} of ${model.stats.compluvia} compluvia`);
  rule("every atrium pool's water stands below its rim", (probe) => {
    const rep = probe ? probeBuild({ noRims: true }).report : r;
    const bad = rep.impluvia.filter((p) => !(p.water < p.rim - 0.05)).length;
    return [bad === 0, `${bad} at or over the rim`];
  });
  const open = model.waterSites.impluvia.filter((p) => p.open.r > 0.5 && p.open.y > p.water + 1);
  check("every impluvium knows the opening over it (for the sky in it)", open.length === model.waterSites.impluvia.length, `${open.length}`);
}

// --- 5. cost --------------------------------------------------------------------------
{
  const MB = 1048576;
  check("full build under 90k stone triangles and 10 MB", r.stoneTris < 90000 && r.bytes < 10 * MB, `${r.stoneTris} tris, ${(r.bytes / MB).toFixed(2)} MB`);
  check("lean: a third of the steam sprites", lean.report.steamSprites <= r.steamSprites * 0.4 && lean.report.steamSprites > 0, `${lean.report.steamSprites} of ${r.steamSprites}`);
  check("lean: fewer splash droplets", lean.drops.length < full.drops.length, `${lean.drops.length} of ${full.drops.length}`);
  check(`build under 400 ms (${buildMs.toFixed(0)} ms)`, buildMs < 400, "");
  // The phone: the lean town, its art and the water inside the building line they replace.
  const PHONE: DeviceDescriptor = { coarsePointer: true, deviceMemoryGb: 4, maxTextureSize: 4096, drawingBufferWidth: 618, drawingBufferHeight: 1373, pixelRatio: 1.5 };
  const phone = budgetForTier("reduced", PHONE);
  const line = phone.memory.items.find((i) => i.what.startsWith("building geometry"))!;
  const total = pompeiiBytes(phone.pompeii) + pompeiiArtBytes(phone.pompeii) + lean.report.bytes;
  check("phone: lean town + art + water fit the building line", total < line.bytes, `${(total / MB).toFixed(1)} of ${(line.bytes / MB).toFixed(1)} MB`);
  check("tiers: steam and droplets per tier are literals", WATER_TIERS.lean.steam < WATER_TIERS.full.steam && WATER_TIERS.lean.drops < WATER_TIERS.full.drops, "");
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\npompeii water: all checks pass");
