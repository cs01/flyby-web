// The gate on Pompeii's lamps (src/data/pompeiilamps.ts, src/render/pompeiilamps.ts):
// where they stand, which houses get the bronze, when they go out, how many
// lights a pixel pays for on each tier, and that the flames stay flames.
//
// Each rule is a function run on the real placement, where it must pass, and
// again on a probe built to break it, where it must fail: a gate that cannot
// fail is not a gate.

import { readFileSync } from "node:fs";
import * as THREE from "three";
import { parsePompeii, pointInRing, ringArea, polylineLength, type PompeiiData } from "../src/data/pompeii";
import { buildPompeii } from "../src/render/pompeiimesh";
import {
  FLAME_JITTER_M, LAMPBEARER_AT, LampKind, flicker, jitter, lampCensus, lampLevel, placeLamps, type Lamp, type LampSites,
} from "../src/data/pompeiilamps";
import { LAMP_TIERS, PompeiiLamps } from "../src/render/pompeiilamps";
import { OIL_LIGHTS_MAX, OIL_REACH_M, TOWN_LAMPS_GLSL, oilMaskAt, townLampUniforms } from "../src/render/oillight";
import { budgetForTier, type DeviceDescriptor } from "../src/render/budget";
import { pompeiiHeightAt } from "../src/data/pompeiiroads";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(66)} ${detail}`);
  if (!ok) failures++;
}
/** A rule on the real input passes, on the probe fails. */
function rule(label: string, f: (probe: boolean) => [boolean, string]): void {
  const [ok, d] = f(false);
  check(label, ok, d);
  const [bad, pd] = f(true);
  check(`  probe breaks it: ${label}`, !bad, pd);
}

const data: PompeiiData = parsePompeii(readFileSync(new URL("../public/landmarks/pompeii.json", import.meta.url), "utf8"));
const ground = pompeiiHeightAt(data, () => 10);
const model = buildPompeii({ data, groundAt: ground });
const sites: LampSites = model.sites;
const lamps = placeLamps(data, sites, { groundAt: ground });
const plain = placeLamps(data, sites, { groundAt: ground, plain: true });
const census = lampCensus(lamps);
console.log(`lamps ${lamps.length}: ${JSON.stringify(census.byRole)}`);

// --- 1. placement counts by type -------------------------------------------------
{
  const r = census.byRole;
  const shops = sites.openings.filter((o) => o.kind === "shop").length;
  // Literal bounds from the town: ~870 shop fronts, ~800 courts, one forum.
  check("shop and tavern lamps: over half as many as shop fronts", r.shop + r.tavern > shops * 0.5, `${r.shop + r.tavern} lamps for ${shops} shops`);
  check("taverns are a minority of the shop lamps (1/10..1/2)", r.tavern > (r.shop + r.tavern) * 0.1 && r.tavern < (r.shop + r.tavern) * 0.5, `${r.tavern} of ${r.shop + r.tavern}`);
  check("a lararium in most atria", r.lararium > 0.6 * sites.courts.filter((c) => !c.garden).length, `${r.lararium}`);
  check("bronze stands in 40..300 atria", r.atrium >= 40 && r.atrium <= 300, `${r.atrium}`);
  check("forum colonnade: a few lamps, 4..16", r.forum >= 4 && r.forum <= 16, `${r.forum}`);
  check("exactly one statue lampbearer", census.byKind[LampKind.Lampbearer] === 1, `${census.byKind[LampKind.Lampbearer]}`);
  const lb = lamps.find((l) => l.kind === LampKind.Lampbearer);
  check("the lampbearer stands within 45 m of the House of Julius Polybius's door", !!lb && Math.hypot(lb.x - LAMPBEARER_AT[0], lb.z - LAMPBEARER_AT[1]) < 45, lb ? `${Math.hypot(lb.x - LAMPBEARER_AT[0], lb.z - LAMPBEARER_AT[1]).toFixed(1)} m` : "none");
  check("hanging lamps hang below a lintel, 2.9..3.5 m over their floor", lamps.filter((l) => l.kind === LampKind.Hanging).every((l) => {
    const o = sites.openings.find((s) => Math.hypot(s.x - l.x, s.z - l.z) < 0.5 + s.w);
    return !!o && l.y - o.g >= 2.9 && l.y - o.g <= 3.5;
  }), "");
}

// --- 2. rich houses get bronze stands ---------------------------------------------
{
  const named = data.domus.filter((d) => Math.abs(ringArea(d.ring)) < 4000);
  const richCourts = sites.courts.filter((c) => !c.garden && named.some((d) => {
    const cx = (c.ring[0] + c.ring[2] + c.ring[4] + c.ring[6]) / 4, cz = (c.ring[1] + c.ring[3] + c.ring[5] + c.ring[7]) / 4;
    return pointInRing(d.ring, cx, cz);
  }));
  const bronze = (ls: Lamp[]) => ls.filter((l) => l.kind === LampKind.Candelabrum || l.kind === LampKind.Lampbearer);
  rule("every atrium of a named house has a bronze stand or the lampbearer", (probe) => {
    const b = bronze(probe ? plain : lamps);
    const missing = richCourts.filter((c) => !b.some((l) => pointInRing(c.ring, l.x, l.z)));
    return [richCourts.length > 20 && missing.length === 0, `${richCourts.length - missing.length} of ${richCourts.length}`];
  });
  rule("no bronze stand in a small unnamed atrium", (probe) => {
    // Probe: a stand in every court.
    const ls = probe ? sites.courts.map((c): Lamp => ({ ...lamps[0], kind: LampKind.Candelabrum, x: c.ring[0], z: c.ring[1], role: "atrium" })) : lamps;
    const poor = sites.courts.filter((c) => !c.garden && Math.abs(ringArea(c.ring)) < 70 && !richCourts.includes(c));
    const wrong = poor.filter((c) => ls.some((l) => l.kind === LampKind.Candelabrum && l.role === "atrium" && Math.hypot(l.x - c.ring[0], l.z - c.ring[1]) < 0.01));
    return [wrong.length === 0, `${wrong.length} of ${poor.length}`];
  });
  check("every bronze stand is in a rich house's court or the forum", bronze(lamps).every((l) => l.rich || l.role === "forum"), "");
}

// --- 3. lamps sit where the town has room for them ---------------------------------
{
  rule("counter lamps stand behind the facade line, inside their opening", (probe) => {
    let bad = 0, n = 0;
    for (const l of lamps) {
      if (l.kind !== LampKind.Lucerna || (l.role !== "shop" && l.role !== "tavern")) continue;
      n++;
      // The opening it was put in: nearest shop opening.
      let best = sites.openings[0], bd = Infinity;
      for (const o of sites.openings) { const d = Math.hypot(o.x - l.x, o.z - l.z); if (o.kind === "shop" && d < bd) { bd = d; best = o; } }
      const into = probe ? -0.5 : -((l.x - best.x) * best.ox + (l.z - best.z) * best.oz);
      const along = Math.abs((l.x - best.x) * best.ex + (l.z - best.z) * best.ez);
      if (into < 0.12 || into > 0.75 || along > best.w / 2 || Math.abs(l.y - best.g - 1.0) > 0.01) bad++;
    }
    return [n > 200 && bad === 0, `${bad} of ${n} off their counter`];
  });
  check("lararia hang 1.2..1.8 m up a court wall", lamps.filter((l) => l.kind === LampKind.Lararium).every((l) =>
    sites.courts.some((c) => pointInRing(c.ring, l.x, l.z) && l.y - c.g > 1.2 && l.y - c.g < 1.8)), "");
}

// --- 4. the streets themselves stay dark -------------------------------------------
{
  // Share of street centreline, sampled every 4 m, within 5 m of a lamp lit at 21:30.
  const litShare = (ls: Lamp[], main: boolean): number => {
    // Only lamps that face a street: a lararium behind a house wall lights no street.
    const lit = ls.filter((l) => (l.role === "shop" || l.role === "tavern" || l.role === "doorway") && lampLevel(l, 21.5, 1) > 0.5);
    let n = 0, k = 0;
    for (const s of data.streets) {
      if (s.main !== main || polylineLength(s.pts) < 10) continue;
      for (let i = 2; i < s.pts.length; i += 2) {
        const ax = s.pts[i - 2], az = s.pts[i - 1], bx = s.pts[i], bz = s.pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        for (let t = 0; t < L; t += 4) {
          const x = ax + ((bx - ax) * t) / L, z = az + ((bz - az) * t) / L;
          n++;
          if (lit.some((l) => Math.abs(l.x - x) < 5 && Math.abs(l.z - z) < 5 && Math.hypot(l.x - x, l.z - z) < 5)) k++;
        }
      }
    }
    return k / Math.max(1, n);
  };
  rule("side streets mostly dark at 21:30: under a quarter near a lamp", (probe) => {
    // Probe: street lighting, a lamp every 10 m down every street.
    const ls = probe ? data.streets.flatMap((s) => {
      const out: Lamp[] = [];
      for (let i = 2; i < s.pts.length; i += 2) {
        const L = Math.hypot(s.pts[i] - s.pts[i - 2], s.pts[i + 1] - s.pts[i - 1]);
        for (let t = 0; t < L; t += 10) out.push({ ...lamps[0], role: "doorway", x: s.pts[i - 2] + ((s.pts[i] - s.pts[i - 2]) * t) / L, z: s.pts[i - 1] + ((s.pts[i + 1] - s.pts[i - 1]) * t) / L, outH: 26 });
      }
      return out;
    }) : lamps;
    const side = litShare(ls, false);
    return [side < 0.25, `${(side * 100).toFixed(0)}%`];
  });
  const main = litShare(lamps, true), side = litShare(lamps, false);
  check("main streets (the shops) more lit than side streets", main > side * 1.5, `${(main * 100).toFixed(0)}% vs ${(side * 100).toFixed(0)}%`);
}

// --- 5. late-night falloff -----------------------------------------------------------
{
  const litAt = (ls: Lamp[], h: number, level = lampLevel) => ls.filter((l) => level(l, h, 1) > 0.5);
  rule("fewer lamps lit at each hour: 21:30 > 23:00 > 00:30 > 02:30, none at 04:00", (probe) => {
    const lv = probe ? (_l: Lamp, _h: number, night: number) => night : lampLevel;
    const c = [21.5, 23, 0.5, 2.5, 4].map((h) => litAt(lamps, h, lv).length);
    return [c[0] > c[1] && c[1] > c[2] && c[2] > c[3] && c[4] === 0, c.join(" > ")];
  });
  const late = litAt(lamps, 0.5);
  check("after midnight only the taverns are lit", late.length > 0 && late.every((l) => l.role === "tavern"), `${late.length}`);
  const at23 = litAt(lamps, 23).length, at2130 = litAt(lamps, 21.5).length;
  check("most lamps out by 23:00 (under half of 21:30's)", at23 < at2130 * 0.5, `${at23} of ${at2130}`);
  check("taverns all still lit at 23:30", lamps.filter((l) => l.role === "tavern").every((l) => lampLevel(l, 23.5, 1) > 0.99), "");
  check("by day nothing burns", lamps.every((l) => lampLevel(l, 21.5, 0) === 0 && lampLevel(l, 12, 0) === 0), "");
  check("at dusk lamps come on one by one (some, not all, at night 0.5)", (() => { const n = litAt(lamps, 20, ((l, h) => lampLevel(l, h, 0.5))).length; return n > 0 && n < lamps.length * 0.8; })(), "");
}

// --- 6. flicker bounded -----------------------------------------------------------------
{
  rule("flicker stays in 0.8..1.0 and moves (range over 10 s > 0.08)", (probe) => {
    let lo = Infinity, hi = -Infinity, worst = 0;
    for (let s = 0; s < 40; s++) {
      let a = Infinity, b = -Infinity;
      for (let t = 0; t < 10; t += 1 / 60) {
        const f = probe ? 0.9 : flicker(t, s / 40);
        a = Math.min(a, f); b = Math.max(b, f);
      }
      lo = Math.min(lo, a); hi = Math.max(hi, b); worst = Math.max(worst, b - a);
    }
    return [lo >= 0.8 && hi <= 1.0 && worst > 0.08, `${lo.toFixed(3)}..${hi.toFixed(3)}`];
  });
  let jmax = 0, step = 0;
  for (let s = 0; s < 40; s++) for (let t = 0; t < 10; t += 1 / 60) {
    jmax = Math.max(jmax, Math.abs(jitter(t, s / 40, 0)), Math.abs(jitter(t, s / 40, 1)));
    step = Math.max(step, Math.abs(flicker(t + 1 / 60, s / 40) - flicker(t, s / 40)));
  }
  check(`flame jitter within ${FLAME_JITTER_M * 100} cm`, jmax <= FLAME_JITTER_M && jmax > FLAME_JITTER_M * 0.5, `${(jmax * 100).toFixed(2)} cm`);
  check("no frame-to-frame flash: flicker changes < 0.05 a frame", step < 0.05, step.toFixed(3));
}

// --- 7. lights capped per tier ------------------------------------------------------------
{
  const PHONE: DeviceDescriptor = { coarsePointer: true, deviceMemoryGb: 4, maxTextureSize: 4096, drawingBufferWidth: 618, drawingBufferHeight: 1373, pixelRatio: 1.5 };
  check("a phone builds the lean town, so the lean lamp tier", budgetForTier("reduced", PHONE).pompeii.lean, "");
  check("lean tier: 16 lights, at most 128 flames", LAMP_TIERS.lean.lights === 16 && LAMP_TIERS.lean.glows <= 128, `${LAMP_TIERS.lean.lights}/${LAMP_TIERS.lean.glows}`);
  check("the shader's uniform array holds the full tier, no more than 32", OIL_LIGHTS_MAX >= LAMP_TIERS.full.lights && OIL_LIGHTS_MAX <= 32 && TOWN_LAMPS_GLSL.includes(`uOilLamp[${OIL_LIGHTS_MAX}]`), `${OIL_LIGHTS_MAX}`);
  // Run the real selection at 21:30 on Via dell'Abbondanza, both tiers.
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 5000);
  for (const lean of [false, true]) {
    const pl = new PompeiiLamps({ data, sites, uniforms: {} as never, groundAt: ground, offX: 0, offZ: 0, lean });
    const tier = lean ? LAMP_TIERS.lean : LAMP_TIERS.full;
    const people = Array.from({ length: 48 }, (_, i) => ({ x: 189 + (i % 8) * 3, z: -213 - Math.floor(i / 8) * 3, heading: 1 }));
    // In the street, in the forum, and 400 m up over the town.
    const views: [number, number, number][] = [[189, 33.6, -213], [-260, 37, -40], [0, 400, 0]];
    let maxN = 0, maxF = 0, minN = Infinity;
    let w: number[] = [];
    views.forEach(([x, y, z], k) => {
      cam.position.set(x, y, z);
      cam.lookAt(x + 10, y - 1, z - 5);
      cam.updateMatrixWorld();
      pl.update({ hour: 21.5, night: 1, t: 3, camera: cam, viewH: 720, people, groundAt: () => 32 });
      maxN = Math.max(maxN, townLampUniforms.uOilLampN.value);
      if (k < 2) minN = Math.min(minN, townLampUniforms.uOilLampN.value);
      maxF = Math.max(maxF, pl.flamesDrawn);
      if (k === 0) {
        w = townLampUniforms.uOilLamp.value.slice(0, townLampUniforms.uOilLampN.value).map((v) => v.w);
        // The grid must hold every light whose reach covers a point (it may
        // hold more), and must cut the loop well below all of them.
        const L = townLampUniforms.uOilLamp.value, n = townLampUniforms.uOilLampN.value;
        rule(`${lean ? "lean" : "full"}: the light grid misses no light in reach of a pixel`, (probe) => {
          let missed = 0, tested = 0;
          for (let q = 0; q < 4000; q++) {
            const px = x - 60 + ((q * 7919) % 120), pz = z - 60 + ((q * 104729) % 120) * 1.0;
            const m = probe ? oilMaskAt(px, pz) & ~1 : oilMaskAt(px, pz);
            for (let i = 0; i < n; i++) {
              if (L[i].w <= 0 || (L[i].x - px) ** 2 + (L[i].z - pz) ** 2 >= OIL_REACH_M * OIL_REACH_M) continue;
              tested++;
              if (!((m >>> i) & 1)) missed++;
            }
          }
          return [tested > 100 && missed === 0, `${missed} of ${tested}`];
        });
        check(`${lean ? "lean" : "full"}: a lit cell loops over a fraction of the lights`, pl.lightsPerCell > 0 && pl.lightsPerCell < n * 0.35, `${pl.lightsPerCell.toFixed(1)} of ${n}`);
      }
    });
    check(`${lean ? "lean" : "full"}: lights handed to the shader <= ${tier.lights}, and filled at street level`, maxN <= tier.lights && minN === tier.lights, `${minN}..${maxN}`);
    check(`${lean ? "lean" : "full"}: flames drawn <= ${tier.glows}`, maxF <= tier.glows && maxF > 0, `${maxF}`);
    // The cut fades out: the weakest light handed over is near zero, the strongest not.
    check(`${lean ? "lean" : "full"}: the weakest chosen light is faded to near nothing`, Math.min(...w) < 0.05 * Math.max(...w), `${Math.min(...w).toFixed(3)} / ${Math.max(...w).toFixed(3)}`);
    // Daytime: nothing.
    pl.update({ hour: 12, night: 0, t: 3, camera: cam, viewH: 720, people, groundAt: () => 32 });
    check(`${lean ? "lean" : "full"}: by day no lights, no flames`, townLampUniforms.uOilLampN.value === 0 && pl.flamesDrawn === 0, "");
    pl.dispose();
  }
}

// --- 8. the kill switch --------------------------------------------------------------------
{
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  check("kill switch: ?off=pompeiilamps skips building the lamps", /if \(!perfOff\.has\("pompeiilamps"\)\) \{\s*pompeiiLamps = new PompeiiLamps/.test(main), "");
  check("killed, the town keeps its old night glow (uLampNight back to 0)", townLampUniforms.uLampNight.value === 0, "");
}

console.log(failures ? `\n${failures} pompeii lamp check(s) FAILED` : "\nall pompeii lamp checks ok");
if (failures) process.exit(1);
