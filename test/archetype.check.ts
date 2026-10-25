// Gates for the archetype library (src/render/archetype.ts) and the material
// bake it names (src/render/materials.ts, public/materials).
//
// What is claimed, and how each claim could be false:
//
//   1. The library is a survey, not a palette: enough types per city, each with
//      physical numbers inside the range real buildings have.
//   2. The assignment follows the city: per district, the mix is what that kind
//      of place is built of. No glass towers on the residential grid, no row
//      houses or cottages downtown, nothing over 100 m that is a walk-up.
//   3. Neighbours cohere: buildings sharing a party wall share a type far more
//      often than an independent draw would give, and still vary in colour.
//      Probed with `coherence: false`, the old per-building draw, which must fail.
//   4. The bake is what the table says: one layer per material, in order, with
//      measured means and tile sizes in a physical range, under the download
//      budget, and the files on disk are the bytes the manifest claims.
//   5. The byte block the shader reads round-trips.
//
// Every bound is a literal measured on the packs, with the measured value
// printed beside it, so a regression shows how far it moved.

import { readFileSync, statSync } from "node:fs";
import { parseCityPack, type CityPack } from "../src/data/citypack";
import {
  ARCHETYPES,
  District,
  DISTRICT_NAMES,
  Region,
  assignArchetypes,
  archetypesFor,
  ringsTouch,
  archetypeWeight,
  type ArchetypeChoice,
} from "../src/render/archetype";
import { materialTags, parseOsmColour } from "../src/data/osmbuildings";
import {
  MATERIALS,
  MAT_COUNT,
  MAT_BYTES_FULL_MAX,
  MAT_BYTES_REDUCED_MAX,
  MAT_RES_FULL,
  MAT_RES_REDUCED,
  type MaterialManifest,
} from "../src/render/materials";
import { FACADE_RAW_BYTES, encodeColourByte, facadeFor, packFacadeRaw } from "../src/render/facade";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(50)} ${detail}`);
  if (!ok) failures++;
}
/** A vacuity probe: the checker run on deliberately broken input must say no. */
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(40)} ${detail}`);
  if (!ok) failures++;
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

// --- 1. the library ------------------------------------------------------------

/** Own types per surveyed region. The doc asks for 25-30 across three cities. */
const MIN_OWN_TYPES = 7;
const MIN_TOTAL_TYPES = 25;
{
  check("library size", ARCHETYPES.length >= MIN_TOTAL_TYPES, `${ARCHETYPES.length} types (want >= ${MIN_TOTAL_TYPES})`);
  for (const r of [Region.NYC, Region.SF, Region.Chicago]) {
    const own = ARCHETYPES.filter((a) => a.region === r).length;
    check(`region ${Region[r]} has its own survey`, own >= MIN_OWN_TYPES, `${own} own + ${archetypesFor(r).length - own} shared`);
  }
  check("no region-less city draws from the survey", archetypesFor(Region.Generic).length === 0, "generic keeps the five families");

  // Physical ranges. A US floor-to-floor is 2.6 m (post-war flat) to 4.6 m (a
  // warehouse); a window rectangle has to be inside its cell; a wall albedo
  // above 0.8 is fresh snow and below 0.004 is black velvet.
  const bad: string[] = [];
  const ids = new Set<string>();
  for (const a of ARCHETYPES) {
    if (ids.has(a.id)) bad.push(`${a.id} duplicated`);
    ids.add(a.id);
    if (a.storeyM < 2.6 || a.storeyM > 4.7) bad.push(`${a.id} storey ${a.storeyM}`);
    if (a.columnM < 1.4 || a.columnM > 6.5) bad.push(`${a.id} column ${a.columnM}`);
    const [x0, x1, y0, y1] = a.win;
    if (!(x0 >= 0 && x0 < x1 && x1 <= 1 && y0 >= 0 && y0 < y1 && y1 <= 1)) bad.push(`${a.id} window ${a.win}`);
    if (!(a.heightM[0] < a.heightM[1])) bad.push(`${a.id} height range`);
    if (!a.palette.length || !a.trim.length || !a.frame.length || !a.roofs.length) bad.push(`${a.id} empty list`);
    for (const sw of a.palette) {
      const y = 0.2126 * sw.c[0] + 0.7152 * sw.c[1] + 0.0722 * sw.c[2];
      if (y < 0.004 || y > 0.8) bad.push(`${a.id} swatch luminance ${y.toFixed(3)}`);
      if (sw.m < 0 || sw.m >= MAT_COUNT) bad.push(`${a.id} layer ${sw.m}`);
    }
    if (a.corniceM < 0 || a.corniceM > 1.5) bad.push(`${a.id} cornice ${a.corniceM}`);
  }
  check("every archetype is physically plausible", bad.length === 0, bad.length ? bad.slice(0, 4).join("; ") : `${ARCHETYPES.length} checked`);
}

// --- 2 and 3. assignment over the packs ------------------------------------------

async function pack(name: string): Promise<CityPack> {
  return parseCityPack(await Bun.file(`public/cities/${name}.city`).arrayBuffer());
}

/** Shares of archetype ids within one district. */
function shares(ch: ArchetypeChoice[], d: District, ids: string[], filter?: (i: number) => boolean): number {
  let n = 0, hit = 0;
  for (let i = 0; i < ch.length; i++) {
    if (ch[i].district !== d || (filter && !filter(i))) continue;
    n++;
    if (ids.includes(ARCHETYPES[ch[i].archetype].id)) hit++;
  }
  return n ? hit / n : 0;
}

const ROWHOUSE_TYPES = [
  "nyc-brownstone", "nyc-house", "sf-victorian", "sf-edwardian", "sf-marina", "sf-house", "chi-two-flat", "chi-cottage",
];
const GLASS_TYPES = ARCHETYPES.filter((a) => a.family === 0).map((a) => a.id);
const HOME_TYPES = ARCHETYPES.filter((a) => a.interior === 0 && a.family !== 0).map((a) => a.id);
const WALKUP_TYPES = [...ROWHOUSE_TYPES, "nyc-walkup", "chi-courtyard", "sf-stucco-apt", "sf-postwar-apt"];

/** Buildings whose footprints touch, both under 25 m: the row-house scale. */
function touchingPairs(p: CityPack): [number, number][] {
  const g = new Map<string, number[]>();
  p.buildings.forEach((b, i) => {
    if (b.topM - b.baseM >= 25) return;
    const k = `${Math.floor(b.cx / 30)},${Math.floor(b.cz / 30)}`;
    let l = g.get(k);
    if (!l) g.set(k, (l = []));
    l.push(i);
  });
  const pairs: [number, number][] = [];
  for (const [k, list] of g) {
    const [x, z] = k.split(",").map(Number);
    for (let dx = 0; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz < 0) continue;
        const other = g.get(`${x + dx},${z + dz}`);
        if (!other) continue;
        for (const i of list) {
          for (const j of other) {
            if (dx === 0 && dz === 0 && j <= i) continue;
            if (ringsTouch(p.buildings[i].ring, p.buildings[j].ring)) pairs.push([i, j]);
          }
        }
      }
    }
  }
  return pairs;
}

function coherence(ch: ArchetypeChoice[], pairs: [number, number][]): number {
  let same = 0;
  for (const [i, j] of pairs) if (ch[i].archetype === ch[j].archetype) same++;
  return pairs.length ? same / pairs.length : 0;
}

/**
 * Floor on the share of touching low-rise pairs that are the same type.
 * Measured 0.728 Manhattan, 0.663 SF, 0.774 Chicago with clusters; 0.369,
 * 0.224, 0.399 drawn per building. 0.55 sits between the two populations with
 * room on both sides.
 */
const COHERENCE_FLOOR = 0.55;
/**
 * Ceiling on same-type touching pairs that also came out the SAME colour: a
 * terrace shares a type and varies its paint. Measured 0.03-0.12.
 */
const SAME_COLOUR_CEILING = 0.25;

for (const city of ["manhattan", "sf", "chicago"]) {
  const p = await pack(city);
  const t0 = performance.now();
  const ch = assignArchetypes(p);
  const ms = performance.now() - t0;
  if (!ch) {
    check(`${city} is a surveyed region`, false, "assignArchetypes returned null");
    continue;
  }
  // A building:part is drawn as part of its tower (render/archetype.ts weighs
  // the whole group), so the height a type has to fit is the TOWER's: a 20 m
  // crown stage of a 255 m tower is a tower type, correctly.
  const groupTop = new Map<number, number>();
  for (const b of p.buildings) if (b.group !== undefined) groupTop.set(b.group, Math.max(groupTop.get(b.group) ?? 0, b.topM));
  const h = (i: number): number => {
    const b = p.buildings[i];
    return b.group !== undefined ? groupTop.get(b.group)! : b.topM - b.baseM;
  };
  const dCount = [0, 0, 0, 0];
  for (const c of ch) dCount[c.district]++;
  console.log(`     ${city}: ${p.buildings.length} buildings in ${ms.toFixed(0)} ms, districts ` +
    DISTRICT_NAMES.map((n, i) => `${n} ${pct(dCount[i] / ch.length)}`).join(" "));

  // Each district must actually occur, or the per-district claims below are
  // claims about nothing.
  check(`${city} has a core and a residential grid`, dCount[District.Core] > 300 && dCount[District.Residential] > 10000,
    `core ${dCount[District.Core]}, residential ${dCount[District.Residential]}`);

  const glassRes = shares(ch, District.Residential, GLASS_TYPES);
  check(`${city} no glass on the residential grid`, glassRes < 0.005, `${pct(glassRes)} (want < 0.5%)`);

  const rowCore = shares(ch, District.Core, ROWHOUSE_TYPES);
  check(`${city} no row houses downtown`, rowCore < 0.06, `${pct(rowCore)} of the core (want < 6%)`);

  const homesRes = shares(ch, District.Residential, HOME_TYPES);
  check(`${city} the residential grid is homes`, homesRes > 0.75, `${pct(homesRes)} (want > 75%)`);

  let tallWalkups = 0, tall = 0;
  for (let i = 0; i < ch.length; i++) {
    if (h(i) < 100) continue;
    tall++;
    if (WALKUP_TYPES.includes(ARCHETYPES[ch[i].archetype].id)) tallWalkups++;
  }
  check(`${city} nothing over 100 m is a walk-up`, tallWalkups === 0, `${tallWalkups} of ${tall}`);

  // A tall building downtown is a type that is built that tall: its height
  // inside the archetype's own surveyed range, not out on the soft shoulder
  // the weighting allows so a 62 m block can still be a pre-war apartment.
  let inRange = 0, tallCore = 0;
  for (let i = 0; i < ch.length; i++) {
    if (ch[i].district !== District.Core || h(i) < 70) continue;
    tallCore++;
    const a = ARCHETYPES[ch[i].archetype];
    if (h(i) >= a.heightM[0] && h(i) <= a.heightM[1]) inRange++;
  }
  const towerFit = tallCore ? inRange / tallCore : 0;
  check(`${city} downtown towers are tower types`, towerFit > 0.9, `${pct(towerFit)} of ${tallCore} core buildings over 70 m inside their type's range`);

  // The city-specific claim each survey exists to make.
  if (city === "sf") {
    const sfRes = shares(ch, District.Residential, ["sf-victorian", "sf-edwardian", "sf-marina", "sf-stucco-apt", "sf-house", "sf-postwar-apt"]);
    check("sf the grid is timber and stucco", sfRes > 0.8, `${pct(sfRes)} Victorian/Edwardian/stucco (want > 80%)`);
  }
  if (city === "manhattan") {
    const pre = shares(ch, District.Midrise, ["nyc-walkup", "nyc-prewar-apt", "nyc-loft", "nyc-brownstone"]);
    check("manhattan mid-rise blocks are pre-war masonry", pre > 0.6, `${pct(pre)} walk-up/pre-war/loft/brownstone (want > 60%)`);
  }
  if (city === "chicago") {
    const chi = shares(ch, District.Residential, ["chi-two-flat", "chi-cottage", "chi-courtyard"]);
    check("chicago the grid is flats and cottages", chi > 0.75, `${pct(chi)} two-flat/cottage/courtyard (want > 75%)`);
  }

  // --- coherence ---
  const pairs = touchingPairs(p);
  const coh = coherence(ch, pairs);
  check(`${city} neighbours share a type`, coh >= COHERENCE_FLOOR, `${coh.toFixed(3)} of ${pairs.length} pairs (floor ${COHERENCE_FLOOR})`);
  const loose = assignArchetypes(p, { coherence: false })!;
  const cohLoose = coherence(loose, pairs);
  probe(`${city} per-building draw is incoherent`, cohLoose >= COHERENCE_FLOOR, `${cohLoose.toFixed(3)} must fall under ${COHERENCE_FLOOR}`);

  // Same type, different paint.
  let sameType = 0, sameColour = 0;
  for (const [i, j] of pairs) {
    if (ch[i].archetype !== ch[j].archetype) continue;
    sameType++;
    const a = facadeFor(p.buildings[i].kind, h(i), i, ch[i]).colour;
    const b = facadeFor(p.buildings[j].kind, h(j), j, ch[j]).colour;
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.01) sameColour++;
  }
  const sc = sameType ? sameColour / sameType : 1;
  check(`${city} a terrace varies its colour`, sc < SAME_COLOUR_CEILING, `${pct(sc)} of same-type pairs identical (want < ${pct(SAME_COLOUR_CEILING)})`);

  // Determinism.
  const again = assignArchetypes(p)!;
  let diff = 0;
  for (let i = 0; i < ch.length; i++) if (again[i].archetype !== ch[i].archetype) diff++;
  check(`${city} assignment is deterministic`, diff === 0, `${diff} differ on a second run`);
}

// Vacuity for the district claims: a city whose every building is drawn from
// the WHOLE pool regardless of district must trip at least one of them. Here
// the residential grid of Manhattan, re-labelled as core, is checked against
// the no-row-houses-downtown bound.
{
  const p = await pack("manhattan");
  const ch = assignArchetypes(p)!;
  const relabelled = ch.map((c) => ({ ...c, district: c.district === District.Residential ? District.Core : c.district }));
  const rowCore = shares(relabelled, District.Core, ROWHOUSE_TYPES);
  probe("row houses downtown is detectable", rowCore < 0.06, `${pct(rowCore)} with the grid labelled core`);
}

// --- 4. the bake ----------------------------------------------------------------

function manifestOk(m: MaterialManifest, sizes: Record<string, number>): string[] {
  const bad: string[] = [];
  if (m.layers !== MAT_COUNT || m.entries.length !== MAT_COUNT) bad.push(`${m.entries.length} layers, want ${MAT_COUNT}`);
  m.entries.forEach((e, i) => {
    const spec = MATERIALS[i];
    if (!spec || e.key !== spec.key || e.acg !== spec.acg) bad.push(`layer ${i} is ${e.key}, table says ${spec?.key}`);
    // A scan mean outside 0.01..0.9 linear is a broken decode or a black file.
    if (e.mean.some((v) => !(v > 0.01 && v < 0.9))) bad.push(`${e.key} mean ${e.mean}`);
    // A tile under 0.3 m repeats visibly from a car; over 10 m is a scale bug.
    if (e.tileM.some((v) => !(v >= 0.3 && v <= 10))) bad.push(`${e.key} tile ${e.tileM}`);
    if (spec && spec.moduleM[1] > 0 && !(e.period[1] >= 1)) bad.push(`${e.key} lost its course lattice`);
  });
  if ((m.bytes[String(MAT_RES_FULL)] ?? Infinity) > MAT_BYTES_FULL_MAX) bad.push(`full tier ${m.bytes[String(MAT_RES_FULL)]} B`);
  if ((m.bytes[String(MAT_RES_REDUCED)] ?? Infinity) > MAT_BYTES_REDUCED_MAX) bad.push(`reduced tier ${m.bytes[String(MAT_RES_REDUCED)]} B`);
  for (const res of [MAT_RES_FULL, MAT_RES_REDUCED]) {
    if (sizes[String(res)] !== m.bytes[String(res)]) bad.push(`${res} px files are ${sizes[String(res)]} B, manifest says ${m.bytes[String(res)]}`);
  }
  return bad;
}

{
  const m = JSON.parse(readFileSync("public/materials/manifest.json", "utf8")) as MaterialManifest;
  const sizes: Record<string, number> = {};
  for (const res of [MAT_RES_FULL, MAT_RES_REDUCED]) {
    sizes[String(res)] = ["albedo", "normal", "rh"]
      .map((k) => statSync(`public/materials/${k}-${res}.jpg`).size)
      .reduce((a, b) => a + b, 0);
  }
  const bad = manifestOk(m, sizes);
  check("the material bake matches the table", bad.length === 0,
    bad.length ? bad.slice(0, 3).join("; ") : `${m.entries.length} layers, ${(m.bytes[String(MAT_RES_FULL)] / 1e6).toFixed(2)} MB full, ${(m.bytes[String(MAT_RES_REDUCED)] / 1e6).toFixed(2)} MB reduced`);
  const dropped = { ...m, entries: m.entries.slice(1), layers: m.layers };
  probe("a missing layer is detectable", manifestOk(dropped, sizes).length === 0, "first layer removed");
  const shrunk = { ...m, entries: m.entries.map((e) => ({ ...e, tileM: [e.tileM[0] / 20, e.tileM[1] / 20] as [number, number] })) };
  probe("a scale bug is detectable", manifestOk(shrunk, sizes).length === 0, "every tile divided by 20");
}

// --- 5. the byte block ------------------------------------------------------------

{
  // Decode exactly as readFacade does: byte / 255, squared.
  const decode = (b: number): number => (b / 255) ** 2;
  let worst = 0;
  const out = new Uint8Array(FACADE_RAW_BYTES);
  const p = await pack("chicago");
  const ch = assignArchetypes(p)!;
  for (let i = 0; i < 3000; i++) {
    const b = p.buildings[i];
    const f = facadeFor(b.kind, b.topM - b.baseM, i, ch[i]);
    packFacadeRaw(f, out, 0);
    for (const [rgb, at] of [[f.trim, 0], [f.frameColour, 4], [f.roofColour, 8], [f.glassTint, 12]] as const) {
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(decode(out[at + k]) - rgb[k]));
    }
    if (out[3] !== f.wallLayer || out[7] !== f.baseLayer || out[15] !== f.windowStyle) worst = Infinity;
  }
  // sqrt encoding: the step is 2 * sqrt(v) / 255, at most 2/255 = 0.008 at v=1.
  check("the byte block round-trips", worst < 0.008, `worst colour error ${worst.toExponential(2)}`);
  // Why sqrt: black steel and tar sit near 0.003-0.04 linear, where a linear
  // byte has one step per 0.0039. The same bound on a linear byte must fail.
  const dark = 0.003;
  const sqrtErr = Math.abs(decode(encodeColourByte(dark)) - dark) / dark;
  check("sqrt bytes keep a black-steel albedo", sqrtErr < 0.05, `${pct(sqrtErr)} error at ${dark}`);
  const linErr = Math.abs(Math.round(dark * 255) / 255 - dark) / dark;
  probe("a linear byte would lose it", linErr < 0.05, `${pct(linErr)} error at ${dark}`);
}

// --- 6. OSM evidence overrides the guess ----------------------------------------
{
  const red = parseOsmColour("#c04030");
  check("building:colour parses", !!red && red[0] > red[1] && red[0] > 0.3, `#c04030 -> ${red?.map((v) => v.toFixed(3))}`);
  check("an unknown colour is no evidence", parseOsmColour("sort of mauve") === null, "null");
  const t = materialTags({ "building:material": "Brick", start_date: "c. 1928", "building:levels": "6" });
  check("material, date and levels are read", t?.material === "brick" && t?.year === 1928 && t?.levels === 6, JSON.stringify(t));
  check("a record with none carries none", materialTags({ building: "yes", height: "20" }) === null, "null");
  // A dated record must move the draw: a 2015 building cannot be a walk-up.
  const walkup = ARCHETYPES[ARCHETYPES.findIndex((a) => a.id === "nyc-walkup")];
  const base = { kind: 0, heightM: 18, areaM2: 200, district: District.Midrise, lat: 40.75, lon: -73.99 };
  const plain = archetypeWeight(walkup, base);
  const dated = archetypeWeight(walkup, { ...base, tags: { year: 2015 } });
  check("start_date overrides the guess", dated < plain * 0.1, `walk-up weight ${plain.toFixed(3)} -> ${dated.toFixed(3)} for 2015`);
  const glassy = archetypeWeight(walkup, { ...base, tags: { material: "glass" } });
  check("building:material overrides the guess", glassy < plain * 0.2, `walk-up weight ${plain.toFixed(3)} -> ${glassy.toFixed(3)} for glass`);
}

console.log(failures ? `\n${failures} archetype check(s) FAILED` : "\nall archetype checks ok");
if (failures) process.exit(1);
