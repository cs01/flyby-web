// The gate on Pompeii: the baked layout (public/landmarks/pompeii.json), the
// town built from it (src/render/pompeiimesh.ts), the cart's street graph
// (src/data/pompeiiroads.ts) and the restored Vesuvius (src/render/pompeii.ts).
//
// Bounds are LITERALS from outside the code under test: the excavated street
// network is about 15-20 km inside a 3.2 km circuit of wall with seven gates;
// the amphitheatre measures 135 x 104 m; insulae run to about 120 x 40 m.
// The reconstruction rules are probed on the built mesh, and every probe is
// run again on the same town drawn as flat grey boxes, where it must fail.

import { readFileSync } from "node:fs";
import { parsePompeii, plainName, pointInRing, polylineLength, ringArea, ringCentroid } from "../src/data/pompeii";
import { AMPHI, KERB_M, ROOF_PITCH_DEG, Store, Surf, buildPompeii, distToRing, type PompeiiModel } from "../src/render/pompeiimesh";
import { pompeiiRoadPack, pompeiiHeightAt } from "../src/data/pompeiiroads";
import { buildRoadGraph, componentLengths, connectedComponents } from "../src/data/roadgraph";
import { budgetForTier, pompeiiArtBytes, pompeiiBytes, type DeviceDescriptor } from "../src/render/budget";
import { AmphitheatreField, COLUMN_LOD, DIPINTI, type ColumnLod, POMPEII_SHADOW_SPLITS, VESUVIUS, dipintiTables, restoreVesuvius, vesuviusCone } from "../src/render/pompeii";
import { LocalClock, zoneLabel } from "../src/app/timebar";
import { LIFE_RADIUS_M, PompeiiLife } from "../src/data/pompeiilife";
import { Heightfield } from "../src/data/dem";
import { CITIES } from "../src/cities";
import { HORSE_BONES, buildHorse, hoofPoints, poseHorse } from "../src/render/horse";
import { Arms, FOLK_SCALE, FOLK_STRIDE_M, Gait, buildFaunBody, buildFolk, buildFolkFar, clipPose, faunPose, skinned, solePoints, solvePose, type FolkMesh, type FolkOpts, type PoseSpec } from "../src/render/folk";
import { LEAN_NEAR_CAP, folkFragment } from "../src/render/pompeiifolk";
import { ART_WORKS } from "../src/data/pompeiiart";
import { ORDERS, Order, columnTemplate, figure, shaftRadius } from "../src/render/pompeiiorders";
import { statSync } from "node:fs";
import { FIELD_CLASSES, Land, LandGrid, coastGround, lengthOf, nearestOn, shoreAt } from "../src/data/pompeiisuburbs";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(64)} ${detail}`);
  if (!ok) failures++;
}

const data = parsePompeii(readFileSync(new URL("../public/landmarks/pompeii.json", import.meta.url), "utf8"));

// --- 1. streets ------------------------------------------------------------------------
{
  const km = data.streets.reduce((s, st) => s + polylineLength(st.pts), 0) / 1000;
  check("street count in 100..260", data.streets.length >= 100 && data.streets.length <= 260, `${data.streets.length}`);
  check("street length 14..28 km", km >= 14 && km <= 28, `${km.toFixed(1)} km`);
  const names = new Set(data.streets.map((s) => s.name));
  for (const n of ["Via dell'Abbondanza", "Via Stabiana", "Via Nola", "Via della Fortuna", "Via Consolare", "Via di Mercurio", "Via del Vesuvio"]) {
    check(`named street present: ${n}`, names.has(n), "");
  }
  const mains = data.streets.filter((s) => s.main);
  check("main streets are wide and paved (>= 4 m carriageway)", mains.length >= 10 && mains.every((s) => s.carriageM >= 4), `${mains.length} main`);
  const inferred = data.streets.filter((s) => s.inferred).length;
  check("some streets inferred for the unexcavated blocks, most surveyed", inferred > 5 && inferred < data.streets.length * 0.4, `${inferred} inferred`);
  // Vacuity: the name test must miss on a list with one street renamed.
  const renamed = data.streets.map((s) => (s.name === "Via dell'Abbondanza" ? { ...s, name: "Via Roma" } : s));
  check("probe: a renamed street is missed", !new Set(renamed.map((s) => s.name)).has("Via dell'Abbondanza"), "");
}

// --- 2. walls, gates, landmarks ---------------------------------------------------------
{
  let per = 0;
  const w = data.wall, n = w.length / 2;
  for (let i = 0; i < n; i++) per += Math.hypot(w[((i + 1) % n) * 2] - w[i * 2], w[((i + 1) % n) * 2 + 1] - w[i * 2 + 1]);
  check("wall circuit 2.8..3.6 km", per > 2800 && per < 3600, `${(per / 1000).toFixed(2)} km`);
  const gates = new Set(data.gates.map((g) => g.name));
  for (const g of ["Porta Marina", "Porta di Ercolano", "Porta Vesuvio", "Porta Nola", "Porta Sarno", "Porta Nocera", "Porta di Stabia"]) {
    check(`gate present: ${g}`, gates.has(g), "");
  }
  check("every gate within 30 m of the wall line", data.gates.every((g) => {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const ax = w[i * 2], az = w[i * 2 + 1], bx = w[((i + 1) % n) * 2], bz = w[((i + 1) % n) * 2 + 1];
      const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((g.x - ax) * dx + (g.z - az) * dz) / (dx * dx + dz * dz || 1)));
      d = Math.min(d, Math.hypot(g.x - ax - t * dx, g.z - az - t * dz));
    }
    return d < 30;
  }), "");
  const pubs = new Map(data.publics.map((p) => [p.name, p]));
  for (const [name, kind] of [["Foro di Pompei", "forum"], ["Tempio di Giove", "temple"], ["Tempio di Apollo", "temple"], ["Basilica di Pompei", "basilica"],
    ["Teatro Grande", "theatre"], ["Teatro Piccolo", "odeon"], ["Terme Stabiane", "baths"], ["Palestra Grande", "palestra"]] as const) {
    const p = pubs.get(name);
    check(`landmark present and classed: ${name}`, !!p && p.kind === kind, p ? p.kind : "missing");
  }
  // The temple of Jupiter stands at the forum's north end, the forum runs
  // north-south: the arrangement the Vesuvius-behind-the-temple view needs.
  const f = pubs.get("Foro di Pompei")!, j = pubs.get("Tempio di Giove")!;
  const [fx, fz] = ringCentroid(f.ring), [jx, jz] = ringCentroid(j.ring);
  check("Temple of Jupiter north of the forum's centre", jz < fz - 20, `${(fz - jz).toFixed(0)} m north`);
  const forumArea = ringArea(f.ring);
  check("forum area 3,000..6,500 m2 (it is about 140 x 38 m)", forumArea > 3000 && forumArea < 6500, `${forumArea.toFixed(0)} m2`);
  check("places for missions: 60+ named, inside the wall, at a gate, or out in the suburbs", data.places.length >= 60 &&
    data.places.every((p) => p.kind === "gate" || (p.kind === "suburb" ? !pointInRing(data.wall, p.x, p.z) && Math.hypot(p.x, p.z) < 4000 : pointInRing(data.wall, p.x, p.z))), `${data.places.length}`);
  check("place names carry no regio.insula address", data.places.every((p) => p.name === plainName(p.name)), "");
  void fx; void jx;
}

// --- 3. the amphitheatre --------------------------------------------------------------
{
  const a = data.amphitheatre;
  const within = (v: number, ref: number, tol: number): boolean => Math.abs(v - ref) / ref <= tol;
  check("modelled outer ellipse within 10% of 135 m", within(AMPHI.a * 2, 135, 0.1), `${AMPHI.a * 2} m`);
  check("modelled outer ellipse within 10% of 104 m", within(AMPHI.b * 2, 104, 0.1), `${AMPHI.b * 2} m`);
  check("modelled arena within 10% of 66.8 x 34.5 m", within(AMPHI.arenaA * 2, 66.8, 0.1) && within(AMPHI.arenaB * 2, 34.5, 0.1), `${AMPHI.arenaA * 2} x ${AMPHI.arenaB * 2}`);
  // The OSM outline the centre and axis come from must itself be the
  // amphitheatre's: within 12% of the literature (it carries the stairs).
  check("OSM outline fit within 12% of 135 x 104", within(a.a * 2, 135, 0.12) && within(a.b * 2, 104, 0.12), `${(a.a * 2).toFixed(1)} x ${(a.b * 2).toFixed(1)}`);
  check("amphitheatre inside the walls, in the east corner", pointInRing(data.wall, a.cx, a.cz) && a.cx > 400, `${a.cx.toFixed(0)}, ${a.cz.toFixed(0)}`);
  check("probe: a 150 x 150 circle fails the 10% test", !(within(150, 135, 0.1) && within(150, 104, 0.1)), "");
}

// --- 4. insulae ------------------------------------------------------------------------
{
  const ins = data.insulae;
  check("insula count 100..260", ins.length >= 100 && ins.length <= 260, `${ins.length}`);
  const inf = ins.filter((i) => i.inferred).length / ins.length;
  check("inferred (unexcavated) insulae are a minority 15..60%", inf > 0.15 && inf < 0.6, `${(inf * 100).toFixed(0)}%`);
  check("every insula inside the walls", ins.every((i) => { const [x, z] = ringCentroid(i.ring); return pointInRing(data.wall, x, z); }), "");
  const areas = ins.map((i) => ringArea(i.ring)).sort((p, q) => p - q);
  const median = areas[Math.floor(areas.length / 2)];
  check("median insula 1,000..6,000 m2", median > 1000 && median < 6000, `${median.toFixed(0)} m2`);
  check("every kerb outline encloses its insula", ins.every((i) => ringArea(i.kerb) >= ringArea(i.ring) * 0.98), "");
}

// --- 5. the reconstruction rules on the built town -----------------------------------
const flat = (x: number, z: number): number => 20 - z * 0.02;
interface Rules { failed: string[]; stats: Record<string, number> }
function rules(m: PompeiiModel): Rules {
  const failed: string[] = [];
  const { mesh } = m;
  let tile = 0, plaster = 0, pitched = 0, tileN = 0, area = 0, plasterArea = 0;
  const colours = new Set<string>();
  const P = mesh.position;
  for (let t = 0; t < mesh.index.length; t += 3) {
    const v = mesh.index[t];
    const s = mesh.surf[v * 4];
    // Plaster is weighed by area: the street furniture adds many small
    // triangles, and a count would read a town of plastered walls as less
    // plastered for every jar on a shelf.
    const b = mesh.index[t + 1] * 3, c = mesh.index[t + 2] * 3, a = v * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const A = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    area += A;
    if (s === Surf.Plaster) plasterArea += A;
    const ny = mesh.normal[v * 4 + 1] / 127;
    // The tile ends along an eave are upright faces by construction, not a roof slope.
    if (s === Surf.Tile && Math.abs(ny) > 0.2) {
      tile++;
      tileN++;
      // A roof pitched between 12 and 35 degrees (Roman roofs are 18-25).
      const deg = (Math.acos(Math.min(1, Math.abs(ny))) * 180) / Math.PI;
      if (deg > 12 && deg < 35) pitched++;
    }
    if (s === Surf.Plaster) {
      plaster++;
      colours.add(`${mesh.colour[v * 4] >> 4},${mesh.colour[v * 4 + 1] >> 4},${mesh.colour[v * 4 + 2] >> 4}`);
    }
  }
  const tris = mesh.triangles;
  const stats = {
    tileFrac: tile / tris, plasterFrac: plasterArea / area, pitchedFrac: pitched / Math.max(1, tileN),
    plasterColours: colours.size, flatRoofs: m.stats.flatRoofs, lots: m.stats.lots, domus: m.stats.domus,
    tabernae: m.stats.tabernae, compluvia: m.stats.compluvia, fountains: m.stats.fountains, steppingStones: m.stats.steppingStones,
  };
  if (stats.tileFrac < 0.06) failed.push("terracotta roofs");
  if (stats.pitchedFrac < 0.95) failed.push("roofs pitched 12-35 deg");
  if (stats.plasterFrac < 0.25) failed.push("plastered walls");
  if (stats.plasterColours < 6) failed.push("plaster palette");
  if (stats.flatRoofs > 0) failed.push("no flat roofs");
  if (stats.lots < 1500) failed.push("lots");
  if (stats.domus < 400 || stats.compluvia < stats.domus) failed.push("atrium houses with a compluvium");
  if (stats.tabernae < 300) failed.push("shopfronts");
  if (stats.fountains < 10) failed.push("street fountains");
  if (stats.steppingStones < 100) failed.push("stepping stones");
  return { failed, stats };
}
let built: PompeiiModel;
{
  built = buildPompeii({ data, groundAt: flat });
  // The rules are the town's: the tombs and farms outside are held to their own below.
  const r = rules(buildPompeii({ data, groundAt: flat, suburbs: false }));
  const s = r.stats;
  check("town passes every reconstruction rule", r.failed.length === 0, r.failed.join(", ") || "all");
  check(`roofs pitched ${ROOF_PITCH_DEG} deg (12-35 window), terracotta`, s.pitchedFrac >= 0.95 && s.tileFrac >= 0.06, `${(s.pitchedFrac * 100).toFixed(1)}% pitched, ${(s.tileFrac * 100).toFixed(1)}% of tris`);
  check("plaster: 6+ palette colours over 25%+ of the surface area", s.plasterColours >= 6 && s.plasterFrac >= 0.25, `${s.plasterColours} colours, ${(s.plasterFrac * 100).toFixed(1)}%`);
  check("domus with compluvium, tabernae, fountains, stepping stones", s.domus >= 400 && s.tabernae >= 300 && s.fountains >= 10 && s.steppingStones >= 100,
    `${s.domus} domus, ${s.tabernae} tabernae, ${s.fountains} fountains, ${s.steppingStones} stones`);
  check("main-street lots are mostly shops", (() => {
    const main = built.lots.filter((l) => l.main);
    return main.length > 100 && main.filter((l) => l.kind === "taberna").length / main.length > 0.35;
  })(), "");
  check("every lot two storeys at most", built.lots.every((l) => l.storeys <= 2), "");
  // The vacuity probe: the same town as flat grey boxes must fail the rules
  // that make it Pompeii and not a massing model.
  const grey = rules(buildPompeii({ data, groundAt: flat, greyBoxes: true }));
  for (const rule of ["terracotta roofs", "plaster palette", "no flat roofs", "plastered walls"]) {
    check(`probe: grey boxes fail "${rule}"`, grey.failed.includes(rule), grey.failed.join(", "));
  }
  // Deterministic: the same pack builds the same town.
  const again = buildPompeii({ data, groundAt: flat });
  check("two builds are identical", again.mesh.triangles === built.mesh.triangles && again.stats.lots === built.stats.lots, `${built.mesh.triangles} tris`);
  check(`build under 1.5 s (${built.stats.buildMs.toFixed(0)} ms)`, built.stats.buildMs < 1500, "");
}

// --- 6. phone budget ----------------------------------------------------------------
{
  const bytes = (m: PompeiiModel): number => [m.mesh, m.floor, m.streets].reduce((s, x) =>
    s + x.position.byteLength + x.normal.byteLength + x.colour.byteLength + x.surf.byteLength + x.wall.byteLength + x.index.byteLength, 0);
  const lean = buildPompeii({ data, groundAt: flat, lean: true });
  const MB = 1048576;
  const full = bytes(built), small = bytes(lean);
  check("full build within the budget literal and within a quarter of it", full <= pompeiiBytes({ lean: false }) && full > pompeiiBytes({ lean: false }) * 0.75, `${(full / MB).toFixed(1)} MB`);
  check("lean build within the budget literal and within a quarter of it", small <= pompeiiBytes({ lean: true }) && small > pompeiiBytes({ lean: true }) * 0.75, `${(small / MB).toFixed(1)} MB`);
  const PHONE: DeviceDescriptor = { coarsePointer: true, deviceMemoryGb: 4, maxTextureSize: 4096, drawingBufferWidth: 618, drawingBufferHeight: 1373, pixelRatio: 1.5 };
  const phone = budgetForTier("reduced", PHONE);
  const line = phone.memory.items.find((i) => i.what.startsWith("building geometry"))!;
  const phoneTown = pompeiiBytes(phone.pompeii) + pompeiiArtBytes(phone.pompeii);
  check("phone: the lean town and its art atlas fit the building line they replace", phone.pompeii.lean && phoneTown < line.bytes, `${(phoneTown / MB).toFixed(1)} of ${(line.bytes / MB).toFixed(1)} MB`);
}

// --- 7. the cart's streets and the walker's ground -----------------------------------
{
  const pack = pompeiiRoadPack(data);
  const g = buildRoadGraph(pack.roads);
  const comp = connectedComponents(g);
  const lens = [...componentLengths(g, comp).values()].sort((p, q) => q - p);
  const total = lens.reduce((s, v) => s + v, 0);
  check("cart graph: the largest connected piece is 85%+ of the streets", lens[0] / total > 0.85, `${(lens[0] / 1000).toFixed(1)} of ${(total / 1000).toFixed(1)} km`);
  check("every street driveable", g.edges.length > 100, `${g.edges.length} edges`);
  // Vacuity: half the streets dropped breaks the network into pieces.
  const half = buildRoadGraph(pack.roads.filter((_, i) => i % 2 === 0));
  const hl = [...componentLengths(half, connectedComponents(half)).values()].sort((p, q) => q - p);
  check("probe: every other street dropped leaves it in pieces", hl[0] / hl.reduce((s, v) => s + v, 0) < 0.85, `${(hl[0] / hl.reduce((s, v) => s + v, 0) * 100).toFixed(0)}%`);
  const h = pompeiiHeightAt(data, () => 10);
  const ins = data.insulae[0];
  const [ix, iz] = ringCentroid(ins.ring);
  const st = data.streets.find((s) => s.main)!;
  check("walker stands on the pavement block, the cart on the carriageway", h(ix, iz) > 10.3 && h(st.pts[2], st.pts[3]) === 10, `${h(ix, iz).toFixed(2)} / ${h(st.pts[2], st.pts[3]).toFixed(2)}`);
}

// --- 8. Vesuvius and the era -------------------------------------------------------
{
  check("restored summit 1,600..2,000 m", vesuviusCone(VESUVIUS.lat, VESUVIUS.lon) > 1600 && vesuviusCone(VESUVIUS.lat, VESUVIUS.lon) < 2000, `${vesuviusCone(VESUVIUS.lat, VESUVIUS.lon).toFixed(0)} m`);
  check("cone does not reach the town (9 km off)", vesuviusCone(data.lat0, data.lon0) === -Infinity, "");
  const f = new Heightfield({ west: 14.3, east: 14.6, south: 40.7, north: 40.9 }, 64, 64);
  f.data.fill(200);
  const raised = restoreVesuvius([f]);
  const atSummit = f.sample(VESUVIUS.lat, VESUVIUS.lon), atTown = f.sample(data.lat0, data.lon0);
  check("DEM edit raises the summit and leaves the town", atSummit > 1500 && atTown === 200 && raised > 0, `${atSummit.toFixed(0)} m / ${atTown} m`);
  const city = CITIES.find((c) => c.id === "pompeii");
  check("pompeii is a menu city with an era and a cart", !!city && !!city.era && city.era.vehicle === "cart", "");
  const at = city?.era ? new Date(city.era.at) : null;
  check("era clock is a real instant in 79 AD", !!at && at.getUTCFullYear() === 79 && Number.isFinite(at.getTime()), at?.toISOString() ?? "");
  check("pack origin is the city's", !!city && Math.abs(city.lat - data.lat0) < 1e-6 && Math.abs(city.lon - data.lon0) < 1e-6, "");
}

// --- 9. second pass: real houses, the sunken arena, towers, fountains, clock, life ----
{
  // Surveyed houses stand on their OSM outlines: Casa del Fauno's footprint
  // is a building solid within 12% of its mapped area (it is pulled out
  // onto the street frontage, which is all the difference).
  const fauno = data.domus.find((d) => d.name === "Casa del Fauno")!;
  const hasFootprint = (m: PompeiiModel, ring: number[]): boolean => {
    const [cx, cz] = ringCentroid(ring), A = Math.abs(ringArea(ring));
    return m.solids.some((s) => { const [sx, sz] = ringCentroid(s.ring); return Math.hypot(sx - cx, sz - cz) < 15 && Math.abs(Math.abs(ringArea(s.ring)) / A - 1) < 0.12; });
  };
  check("Casa del Fauno built on its surveyed footprint", !!fauno && hasFootprint(built, fauno.ring), "");
  check("40+ named houses built on their outlines with courts", built.stats.surveyedHouses >= 40, `${built.stats.surveyedHouses}`);
  const courts = data.domus.filter((d) => (d.courts ?? []).length).length;
  check("courts found in the room walls of 30+ houses", courts >= 30, `${courts}`);
  const noDomus = buildPompeii({ data: { ...data, domus: [], villa: undefined }, groundAt: flat });
  check("probe: without the outlines no house stands on Fauno's footprint", !hasFootprint(noDomus, fauno.ring) && noDomus.stats.surveyedHouses === 0, "");

  // The arena dug into the ground.
  const a = built.amphitheatre;
  const sunk = (m: { floorY: number; rimY: number }): boolean => m.rimY - m.floorY >= 5 && m.rimY - m.floorY <= 7.5;
  check("arena floor 5-7.5 m below the ground round the amphitheatre", sunk(a), `${(a.rimY - a.floorY).toFixed(1)} m`);
  check("probe: an arena at ground level fails", !sunk({ floorY: a.rimY, rimY: a.rimY }), "");
  const dem = new Heightfield({ west: data.lon0 - 0.02, east: data.lon0 + 0.02, south: data.lat0 - 0.02, north: data.lat0 + 0.02 }, 160, 160);
  dem.data.fill(30);
  dem.loaded = true;
  const bowl = new AmphitheatreField(data, [dem]);
  const ll = (x: number, z: number): [number, number] => [data.lat0 - z / 111000, data.lon0 + x / (111000 * Math.cos((data.lat0 * Math.PI) / 180))];
  const inArena = bowl.sample(...ll(data.amphitheatre.cx, data.amphitheatre.cz));
  const ux = Math.cos(data.amphitheatre.rot), uz = Math.sin(data.amphitheatre.rot);
  const outside = bowl.sample(...ll(data.amphitheatre.cx + ux * (AMPHI.a + 8), data.amphitheatre.cz + uz * (AMPHI.a + 8)));
  check("terrain dug under the arena, untouched outside the wall", inArena < 30 - 5 && outside === 30, `${inArena.toFixed(1)} / ${outside.toFixed(1)}`);
  check("probe: the bare DEM is not dug", dem.sample(...ll(data.amphitheatre.cx, data.amphitheatre.cz)) === 30, "");

  // Towers: the twelve the survey numbers.
  check("12 wall towers", built.stats.towers === 12, `${built.stats.towers}`);
  const eleven = buildPompeii({ data: { ...data, towers: (data.towers ?? []).slice(1) }, groundAt: flat, lean: true });
  check("probe: one tower dropped from the survey fails", eleven.stats.towers !== 12, `${eleven.stats.towers}`);

  // The wall: no spur round the Villa Imperiale south of Porta Marina.
  const spurFree = (w: number[]): boolean => { for (let i = 0; i < w.length; i += 2) if (w[i] < -310 && w[i + 1] > 80) return false; return true; };
  check("wall clipped to the circuit at Porta Marina", spurFree(data.wall) && !pointInRing(data.wall, -380, 110), "");
  check("probe: a spur vertex is caught", !spurFree([...data.wall, -405, 123]), "");
  // Nothing built pokes out past the wall: the gate towers and gate piers
  // stand on it, so 15 m of slack, against the 80 m lot that once did.
  const pokesOut = (rings: number[][]): number => rings.filter((r) => {
    for (let i = 0; i < r.length; i += 2) if (!pointInRing(data.wall, r[i], r[i + 1]) && distToRing(data.wall, r[i], r[i + 1]) > 15) return true;
    return false;
  }).length;
  // The Villa dei Misteri is meant to be outside, 300 m north-west of the wall.
  const town = built.solids.slice(0, built.suburbs?.solidsFrom ?? built.solids.length).map((s) => s.ring).filter((r) => !data.villa || !pointInRing(data.villa.ring, ...ringCentroid(r)));
  check("no building stands more than 15 m outside the wall (the villa aside)", pokesOut(town) === 0, `${pokesOut(town)}`);
  check("probe: the old 100 m lot west of Porta Marina is caught", pokesOut([[-501, -30, -410, -30, -410, -16, -501, -16]]) === 1, "");

  // Fountains: about forty, the mapped ones among them.
  check("35..45 public fountains, 10+ from the survey", built.stats.fountains >= 35 && built.stats.fountains <= 45 && (data.fountains ?? []).length >= 10, `${built.stats.fountains} (${(data.fountains ?? []).length} mapped)`);

  // The HUD clock in 79: Rome's zone then is local mean time.
  const rome = new LocalClock("Europe/Rome").abbrev(new Date("0079-08-22T07:30:00Z"));
  check("HUD zone label in 79 AD reads 'local time'", rome === "local time", rome);
  check("probe: a real zone name passes through", zoneLabel("CEST") === "CEST" && zoneLabel("GMT+8") === "GMT+8" && zoneLabel("GMT+0:49:56") === "local time", "");

  // Painted notices: every glyph 5x5, every notice spelled from the font.
  const t = dipintiTables();
  check("dipinti: 6 notices, all letters in the font", DIPINTI.length >= 4 && t.chars.every((c) => c >= -1 && c < t.glyphs.length) && t.glyphs.every((g) => g > 0), `${t.chars.length} chars`);

  // Street shadows: the first cascade fitted to 150 m, not 350.
  const texel = (far: number): number => {
    const tanV = Math.tan((31 * Math.PI) / 180), k2 = tanV * tanV * (1 + (16 / 9) ** 2);
    return (2 * far * Math.sqrt(k2)) / 2048;
  };
  check("first shadow cascade under 0.25 m a texel at street level", texel(POMPEII_SHADOW_SPLITS[0]) < 0.25, `${texel(POMPEII_SHADOW_SPLITS[0]).toFixed(2)} m`);
  check("probe: the default 350 m split is not", texel(350) >= 0.25, `${texel(350).toFixed(2)} m`);

  // Life: people on the pavements and in the forum near the camera, walking.
  const forum = data.publics.find((p) => p.kind === "forum")!;
  const [fx, fz] = ringCentroid(forum.ring);
  const life = new PompeiiLife(data, { people: 48, carts: 2 });
  life.update(0, fx, fz);
  const h = pompeiiHeightAt(data, () => 10);
  const placed = life.people.filter((p) => pointInRing(data.wall, p.x, p.z) && Math.hypot(p.x - fx, p.z - fz) <= LIFE_RADIUS_M);
  const onFoot = life.people.filter((p) => h(p.x, p.z) > 10.3 || pointInRing(forum.ring, p.x, p.z));
  check("48 people placed near the camera, inside the walls", placed.length === 48, `${placed.length}`);
  check("people on the pavements or the forum, not the carriageway", onFoot.length >= 44, `${onFoot.length} of 48`);
  check("two carts on the main streets", life.carts.length === 2 && life.carts.every((c) => pointInRing(data.wall, c.x, c.z)), "");
  const before = life.people.map((p) => [p.x, p.z]);
  life.update(0, fx, fz);
  const still = life.people.every((p, i) => p.x === before[i][0] && p.z === before[i][1]);
  for (let k = 0; k < 50; k++) life.update(0.2, fx, fz);
  const moved = life.people.filter((p, i) => Math.hypot(p.x - before[i][0], p.z - before[i][1]) > 3).length;
  check("people walk: most move 3 m+ in 10 s", moved >= 36, `${moved} of 48`);
  check("probe: a held clock (dt 0) moves nobody", still, "");
}

// --- 10. the horse: a lofted body, and gaits with the right footfalls -----------------
{
  const full = buildHorse(), lean = buildHorse(true);
  check("horse mesh 2-5k tris desktop, under 1.2k lean", full.triangles >= 2000 && full.triangles <= 5000 && lean.triangles < 1200, `${full.triangles} / ${lean.triangles}`);
  let top = 0;
  for (let i = 1; i < full.position.length; i += 3) if (Math.abs(full.position[i + 1]) < 0.3) top = Math.max(top, full.position[i]);
  check("withers 1.3..1.6 m (Roman horses ran 1.3-1.5 m)", top > 1.3 && top < 1.6, `${top.toFixed(2)} m`);
  // Footfalls: sample a cycle, note when each hoof leaves the ground. A walk
  // lifts the four at four different times; a trot lifts diagonal pairs.
  const liftTimes = (g: "walk" | "trot"): number[] => {
    const b = new Float32Array(HORSE_BONES * 16);
    const up = [false, false, false, false], at: number[] = [];
    for (let k = 0; k <= 200; k++) {
      poseHorse(g, k / 200, b);
      hoofPoints(b).forEach((p, i) => {
        const lifted = p[1] > 0.1;
        if (lifted && !up[i] && k > 0) at.push(Math.round((k / 200) * 20) / 20);
        up[i] = lifted;
      });
    }
    return [...new Set(at)];
  };
  const walk = liftTimes("walk"), trot = liftTimes("trot");
  check("walk is four-beat: four separate lift-offs a stride", walk.length === 4, walk.join(" "));
  check("probe: the trot lifts in two diagonal pairs", trot.length === 2, trot.join(" "));
  const b = new Float32Array(HORSE_BONES * 16);
  let worst = 0;
  for (let k = 0; k < 40; k++) {
    poseHorse("walk", k / 40, b);
    const ys = hoofPoints(b).map((p) => p[1]).sort((p, q) => p - q);
    worst = Math.max(worst, Math.abs(ys[1]));
  }
  check("at a walk two or more hooves stay planted within 6 cm of the ground", worst < 0.06, `${(worst * 100).toFixed(1)} cm`);
}

// --- 10b. the townsfolk: a modelled body, dressed, walking without sliding ------------
{
  const kinds: FolkOpts[] = [
    { dress: "tunic" }, { dress: "tunic", load: "amphora" }, { dress: "tunic", load: "basket" },
    { dress: "stola" }, { dress: "stola", veil: true }, { dress: "stola", load: "basket" }, { dress: "toga" },
  ];
  const meshes = kinds.map((k) => buildFolk(k));
  const top = (pos: Float32Array): number => { let t = 0; for (let i = 1; i < pos.length; i += 3) t = Math.max(t, pos[i]); return t; };
  const low = (pos: Float32Array): number => { let t = Infinity; for (let i = 1; i < pos.length; i += 3) t = Math.min(t, pos[i]); return t; };
  // Height of the bare figure (no load on the head), at both ends of each sex's scale range.
  const tall = (scale: number): number => top(buildFolk({ dress: "tunic" }).position) * scale;
  const heights = [tall(FOLK_SCALE.man[0]), tall(FOLK_SCALE.man[1]), tall(FOLK_SCALE.woman[0]), tall(FOLK_SCALE.woman[1])];
  const inRange = (h: number[]): boolean => h.every((v) => v >= 1.5 && v <= 1.85);
  check("townsfolk stand 1.5..1.85 m at every scale they are drawn", inRange(heights), heights.map((v) => v.toFixed(2)).join(" "));
  check("probe: a figure drawn at 1.2x is caught", !inRange([tall(1.2)]), `${tall(1.2).toFixed(2)} m`);
  const tris = meshes.map((m) => m.triangles), far = buildFolkFar().triangles;
  const nearOk = (t: number[]): boolean => t.every((v) => v >= 400 && v <= 1000);
  check("near figure 400..1000 tris for every dress, far under 80", nearOk(tris) && far < 80, `${tris.join("/")} far ${far}`);
  check("probe: two figures in one mesh are over the bound", !nearOk([tris[0] * 2]), `${tris[0] * 2}`);
  // The phone's 24 walkers, none culled, against the 181-triangle box figures they replaced.
  const phone = (cap: number): number => cap * Math.max(...tris) + (24 - cap) * far;
  check("phone: people cost no more than the box figures (24 x 181)", phone(LEAN_NEAR_CAP) <= 24 * 181, `${phone(LEAN_NEAR_CAP)} <= ${24 * 181}`);
  check("probe: three full figures on the phone are over it", phone(LEAN_NEAR_CAP + 1) > 24 * 181, `${phone(LEAN_NEAR_CAP + 1)}`);
  const rest = meshes.map((m) => low(m.position));
  check("rest pose: soles on y 0 within 2 cm", rest.every((v) => Math.abs(v) < 0.02), rest.map((v) => v.toFixed(3)).join(" "));
  // The lowest point of the posed figure: on the ground, nothing under it.
  const lowest = (m: FolkMesh, spec: PoseSpec): number => low(skinned(m, solvePose(spec)));
  const phases = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 8);
  const walkLow = kinds.flatMap((_, i) => phases.map((p) => lowest(meshes[i], clipPose(Gait.Walk, i === 6 ? Arms.Toga : i >= 3 ? Arms.Woman : Arms.Free, p))));
  const idleLow = phases.map((p) => lowest(meshes[0], clipPose(Gait.Idle, Arms.Free, p)));
  const grounded = (v: number[]): boolean => v.every((y) => Math.abs(y) < 0.02);
  check("walking, 8 phases: the lowest point within 2 cm of y 0", grounded(walkLow), `${Math.min(...walkLow).toFixed(3)}..${Math.max(...walkLow).toFixed(3)}`);
  check("standing, 8 phases: the same", grounded(idleLow), `${Math.min(...idleLow).toFixed(3)}..${Math.max(...idleLow).toFixed(3)}`);
  const hopped = phases.map((p) => { const s = clipPose(Gait.Walk, Arms.Free, p); return lowest(meshes[0], { ...s, hip: [s.hip[0], s.hip[1] + 0.06, s.hip[2]] }); });
  check("probe: the hips 6 cm higher lift the feet off", !grounded(hopped), `${Math.min(...hopped).toFixed(3)}`);
  // A planted heel keeps still on the ground: in the body's frame it goes
  // back at exactly the stride the sim walks (1.4 m a cycle).
  const heelDrift = (stride: number): number => {
    const zs = [0.1, 0.2, 0.3].map((p) => solePoints(solvePose(clipPose(Gait.Walk, Arms.Free, p)))[0][2] + stride * p);
    return Math.max(...zs) - Math.min(...zs);
  };
  check("a planted heel does not slide (under 1 cm over the stance)", heelDrift(FOLK_STRIDE_M) < 0.01, `${(heelDrift(FOLK_STRIDE_M) * 100).toFixed(2)} cm`);
  check("probe: against a 1.2 m stride it slides", heelDrift(1.2) > 0.01, `${(heelDrift(1.2) * 100).toFixed(1)} cm`);
  const frag = folkFragment();
  check("the town's fragment shader carries the figures' materials", frag.includes("style > 22.5 && style < 23.5"), "");
  check("probe: a shader without the anchor line gets none", !folkFragment("void main() {}").includes("style > 22.5"), "");

  // The Dancing Faun: the phone keeps the townsfolk's body, the desktop gets the muscled one.
  const plainBody = buildFolk({ dress: "nude", faun: true }), fineBody = buildFaunBody();
  // Torso-only vertices (weighted to the pelvis and chest) in a band across the chest: the box they span, width x depth.
  const chestBox = (m: FolkMesh): number => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < m.position.length / 3; i++) {
      const y = m.position[i * 3 + 1];
      if (y < 1.25 || y > 1.35) continue;
      let w = 0;
      for (let k = 0; k < 3; k++) if (m.skin[i * 4 + k] === 0 || m.skin[i * 4 + k] === 1) w += m.weight[i * 4 + k];
      if (w < 200) continue;
      x0 = Math.min(x0, m.position[i * 3]); x1 = Math.max(x1, m.position[i * 3]);
      z0 = Math.min(z0, m.position[i * 3 + 2]); z1 = Math.max(z1, m.position[i * 3 + 2]);
    }
    return (x1 - x0) * (z1 - z0);
  };
  const near = (m: FolkMesh, f: (x: number, y: number, z: number) => boolean): number => {
    let n = 0;
    for (let i = 0; i < m.position.length / 3; i++) if (f(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2])) n++;
    return n;
  };
  const bulk = (m: FolkMesh): number => chestBox(m) / chestBox(plainBody);
  const tailOf = (m: FolkMesh): number => near(m, (x, y, z) => Math.abs(x) < 0.03 && y > 0.9 && y < 1.1 && z < -0.15);
  const beardOf = (m: FolkMesh): number => near(m, (x, y, z) => Math.abs(x) < 0.05 && y > 1.39 && y < 1.45 && z > 0.06);
  const looksFine = (m: FolkMesh): boolean => bulk(m) >= 1.3 && tailOf(m) > 0 && beardOf(m) >= 6;
  check("detailed faun: chest 1.3x the plain body's, a tail behind the pelvis, a beard under the chin", looksFine(fineBody),
    `chest ${bulk(fineBody).toFixed(2)}x, tail ${tailOf(fineBody)} verts, beard ${beardOf(fineBody)} verts`);
  check("probe: the plain faun body fails it", !looksFine(plainBody), `chest ${bulk(plainBody).toFixed(2)}x, beard ${beardOf(plainBody)} verts`);
  const fineTris = fineBody.triangles;
  check("detailed faun: 2000..6000 triangles", fineTris >= 2000 && fineTris <= 6000, `${fineTris} (plain ${plainBody.triangles})`);
  const fineLow = low(skinned(fineBody, solvePose(faunPose(true))));
  check("detailed faun in his pose: the toes on y 0 within 2 cm", Math.abs(fineLow) < 0.02, `${fineLow.toFixed(3)}`);
  const hopFaun = faunPose(true), up6 = (f: PoseSpec["feet"][0]): PoseSpec["feet"][0] => ({ ...f, ankle: [f.ankle[0], f.ankle[1] + 0.06, f.ankle[2]] });
  check("probe: feet 6 cm higher lift him off", Math.abs(low(skinned(fineBody, solvePose({ ...hopFaun, feet: [up6(hopFaun.feet[0]), up6(hopFaun.feet[1])] })))) >= 0.02, "");
  // The phone's statue is the old one, triangle for triangle; only `detailed` swaps the body.
  const statueTris = (detailed: boolean): number => { const S = new Store(); figure(S, [0, 0, 0], 0, 0.42, "faun", [0.2, 0.15, 0.1], 17, detailed); return S.ni / 3; };
  check("the phone's faun statue keeps its 965 triangles, the detailed one is the new body", statueTris(false) === 965 && statueTris(true) === fineTris, `${statueTris(false)} / ${statueTris(true)}`);
  check("probe: asking for the plain statue does not give the detailed body", statueTris(false) !== fineTris, "");
}

// --- 11. the art: restored works in their houses, the atlas in budget ------------------
{
  const want: Record<string, string> = {
    "alexander": "Casa del Fauno", "faun-have": "Casa del Fauno", "dancing-faun": "Casa del Fauno",
    "cave-canem": "Casa del Poeta Tragico", "vettii-ixion": "Casa dei Vettii", "vettii-wall": "Casa dei Vettii",
    "misteri-north": "Villa dei Misteri", "misteri-east": "Villa dei Misteri",
  };
  // In the house by name, and inside that house's surveyed outline.
  const ringOf = (name: string): number[] | undefined => name === "Villa dei Misteri" ? data.villa?.ring : data.domus.find((d) => d.name === name)?.ring;
  const placedIn = (m: PompeiiModel, id: string): boolean => {
    const a = m.art.find((x) => x.id === id);
    const r = ringOf(want[id]);
    return !!a && !!r && a.house === want[id] && (pointInRing(r, a.x, a.z) || distToRing(r, a.x, a.z) < 3);
  };
  for (const id of Object.keys(want)) check(`art in its house: ${id} in ${want[id]}`, placedIn(built, id), "");
  const off = buildPompeii({ data, groundAt: flat, art: false });
  check("probe: with the art off nothing is placed", Object.keys(want).every((id) => !placedIn(off, id)), `${off.art.length} placed`);
  // A mosaic moved to another house is caught.
  const moved = { ...built, art: built.art.map((a) => (a.id === "alexander" ? { ...a, x: a.x + 120 } : a)) };
  check("probe: the Alexander Mosaic 120 m away fails", !placedIn(moved, "alexander"), "");
  const MB = 1048576;
  // Every tile drawn exists in the atlas, the files are in budget.
  const dir = new URL("../public/landmarks/pompeii-art/", import.meta.url);
  const atlas = JSON.parse(readFileSync(new URL("atlas.json", dir), "utf8")) as { size: number; tiles: { id: string; rect: number[] }[] };
  check("atlas has a tile for every work, inside the image", ART_WORKS.every((w) => atlas.tiles.some((t) => t.id === w.id && t.rect[0] + t.rect[2] <= atlas.size && t.rect[1] + t.rect[3] <= atlas.size)), `${atlas.tiles.length} tiles`);
  const big = statSync(new URL("atlas.jpg", dir)).size, small = statSync(new URL("atlas-small.jpg", dir)).size;
  check("atlas download under 4 MB (desktop) and 1 MB (phone)", big + small < 4 * MB && small < MB, `${(big / MB).toFixed(2)} + ${(small / MB).toFixed(2)} MB`);
  const credits = readFileSync(new URL("CREDITS.md", dir), "utf8");
  const usedSources = (credits.match(/^\| [a-z]/gm) ?? []).length;
  check("every atlas source credited with a free licence", usedSources >= 10 && !/\| \?|NC|ND/.test(credits), `${usedSources} sources`);
}

// --- 12. the orders: Vitruvius's proportions ------------------------------------------
{
  const within = (v: number, ref: number, tol: number): boolean => Math.abs(v - ref) <= tol;
  // Height in lower diameters: Doric 7, Ionic 9, Corinthian 10 (V. IV.1-3).
  const ratio = { 0: 7, 1: 9, 2: 10 } as Record<number, number>;
  const offProportion = (cols: PompeiiModel["orders"]): number => cols.filter((c) => !within(c.h / c.d, ratio[c.order], 0.3)).length;
  const bad = offProportion(built.orders);
  check("every column's height / lower diameter is its order's (7, 9, 10)", built.orders.length > 1000 && bad === 0, `${built.orders.length} columns, ${bad} off`);
  const kinds = [0, 1, 2].map((o) => built.orders.filter((c) => c.order === o).length);
  check("all three orders stand in the town (temples Corinthian, forum Doric and Ionic)", kinds.every((k) => k > 0), kinds.join(" / "));
  // The peristyle prisms this replaced were 0.4 m across at any height.
  const old = built.orders.map((c) => ({ ...c, d: 0.4 }));
  check("probe: the old 0.4 m prisms are caught as off-proportion", offProportion(old) > old.length * 0.9, `${offProportion(old)} of ${old.length}`);
  // The template: the shaft tapers to 5/6 (III.3.12), the Doric capital is
  // D/2 high, the Corinthian a full D.
  check("shaft tapers to 5/6 of the lower diameter", within(shaftRadius(1) * 2, 5 / 6, 0.01) && within(shaftRadius(0) * 2, 1, 0.01), `${(shaftRadius(1) * 2).toFixed(3)}`);
  const topOf = (o: Order): number => {
    const st = new Store();
    columnTemplate(st, o, false);
    let m = 0;
    for (let i = 0; i < st.n; i++) m = Math.max(m, st.pos[i * 3 + 1]);
    return m;
  };
  check("templates stand their order's height in diameters", within(topOf(Order.Doric), 7, 0.01) && within(topOf(Order.Ionic), 9, 0.01) && within(topOf(Order.Corinthian), 10, 0.01),
    `${topOf(Order.Doric).toFixed(2)} / ${topOf(Order.Ionic).toFixed(2)} / ${topOf(Order.Corinthian).toFixed(2)}`);
  check("Doric capital D/2, Corinthian D (in the order table)", ORDERS[Order.Doric].capital === 0.5 && ORDERS[Order.Corinthian].capital === 1, "");
  // Cost: the detailed columns at their caps, the heaviest order in every
  // slot. Bounds are literals: 800k triangles on a desktop, 120k on a phone.
  const tris = (lean: boolean): number => Math.max(...[Order.Doric, Order.Ionic, Order.Corinthian].map((o) => { const st = new Store(); columnTemplate(st, o, lean); return st.ni / 3; }));
  const worst = (l: ColumnLod): number => l.nearCap * tris(false) + l.farCap * tris(true);
  check("detailed columns at their caps: under 800k tris desktop, 120k phone", worst(COLUMN_LOD.desktop) < 800000 && worst(COLUMN_LOD.phone) < 120000,
    `${(worst(COLUMN_LOD.desktop) / 1000).toFixed(0)}k / ${(worst(COLUMN_LOD.phone) / 1000).toFixed(0)}k`);
  check("probe: drawing every column in full detail is caught", built.orders.length * tris(false) > 800000, `${(built.orders.length * tris(false) / 1e6).toFixed(1)}M`);
}

// --- 13. bakeries and thermopolia ----------------------------------------------------
{
  const modestus = (data.sites ?? []).find((s) => /Modestus/.test(s.name));
  const millsAt = (m: PompeiiModel): number => m.sites.mills.filter((q) => /Modestus/.test(q.site) && !!modestus && Math.hypot(q.x - modestus.x, q.z - modestus.z) < 15).length;
  check("the Bakery of Modestus (VII.1.36) has its three mills and its oven", !!modestus && millsAt(built) === 3 && built.sites.ovens.some((o) => /Modestus/.test(o)), `${millsAt(built)} mills`);
  check("8+ mapped bakeries built with mills and an oven", new Set(built.sites.mills.map((q) => q.site)).size >= 8 && built.sites.ovens.length >= 8, `${built.sites.ovens.length} ovens`);
  const noSites = buildPompeii({ data: { ...data, sites: [] }, groundAt: flat });
  check("probe: without the mapped sites there are no mills", millsAt(noSites) === 0 && noSites.sites.mills.length === 0, "");
  check("10+ thermopolia with dolia counters at mapped sites", built.sites.thermopolia >= 10 && noSites.sites.thermopolia === 0, `${built.sites.thermopolia}`);
  check("forum: equestrian and togate statues on the bases", built.sites.statues.filter((s) => s === "equestrian").length === 2 && built.sites.statues.filter((s) => s === "togate").length >= 4, built.sites.statues.join(", "));
}

// --- 14. outside the walls: tomb streets, suburbs, the river, the 79 AD shore ----------------
// Bounds from the literature, not the layout: the Porta Ercolano and Nocera
// necropoleis each hold dozens of excavated tombs; the 79 AD shore ran one
// to two kilometres west of Porta Marina; the Sarno passed under the town to
// the south, closer than its canal today (1.5 km and more off the south wall).
{
  const sub = data.suburbs;
  check("pack has its suburbs", !!sub && !!built.suburbs, "");
  if (sub && built.suburbs) {
    const st = built.suburbs;
    const want: [string, number][] = [["Porta di Ercolano", 40], ["Porta Nocera", 60], ["Porta Vesuvio", 8], ["Porta Nola", 8], ["Porta di Stabia", 8], ["Porta Sarno", 6], ["Porta Marina", 4]];
    const short = (by: Record<string, number>): string[] => want.filter(([g, n]) => (by[g] ?? 0) < n).map(([g]) => g);
    check("tombs built along every gate road (Ercolano 40+, Nocera 60+, the rest 4-8+)", short(st.tombsByGate).length === 0, want.map(([g]) => `${g.replace(/Porta (di )?/, "")} ${st.tombsByGate[g] ?? 0}`).join(", "));
    check("probe: the town alone has no tomb roads", short(buildPompeii({ data, groundAt: flat, lean: true, suburbs: false }).suburbs?.tombsByGate ?? {}).length === want.length, "");
    const osm = sub.tombs.filter((t) => !t.inferred).length;
    check("100+ tombs placed from their OSM outlines, the rest marked inferred", osm >= 100 && sub.tombs.every((t) => t.inferred || t.name !== undefined), `${osm} of ${sub.tombs.length}`);
    check("all five tomb types stand (altar, aedicula, schola, tower, enclosure)", ["altar", "aedicula", "schola", "tower", "enclosure"].every((k) => sub.tombs.some((t) => t.kind === k)), "");
    const named = (re: RegExp, kind: string): boolean => sub.tombs.some((t) => re.test(t.name) && t.kind === kind);
    check("Mamia's tomb a schola, Naevoleia Tyche's an altar", named(/Mamia/, "schola") && named(/Naevoleia/, "altar"), "");
    // Every tomb fronts its road within 25 m and keeps off the carriageway.
    const offRoad = sub.tombs.filter((t) => {
      const n = nearestOn(sub.roads[t.road].pts, t.x, t.z);
      return n.d > 35 || n.d < sub.roads[t.road].widthM / 2 + Math.min(t.w, t.d) / 2 - 0.5;
    });
    check("every tomb fronts its road (within 35 m, back rows included; off the carriageway)", offRoad.length === 0, `${offRoad.length} off`);
    check("probe: a tomb moved 60 m off its road is caught", (() => { const t = sub.tombs[0]; return nearestOn(sub.roads[t.road].pts, t.x + 60 * t.fx * -1, t.z + 60 * t.fz * -1).d > 35; })(), "");

    // Villas: Diomedes where OSM marks it, the Villa Imperiale under Porta Marina, the Mysteries not doubled.
    const D2R = Math.PI / 180, mLat = 111132.92 - 559.82 * Math.cos(2 * data.lat0 * D2R), mLon = 111412.84 * Math.cos(data.lat0 * D2R);
    const ll = (lat: number, lon: number): [number, number] => [(lon - data.lon0) * mLon, (data.lat0 - lat) * mLat];
    const dio = sub.buildings.find((b) => b.name === "Villa di Diomede");
    const [dx, dz] = ll(40.75239, 14.47865);
    check("Villa di Diomede built within 40 m of its OSM marker", !!dio && Math.hypot(dio.x - dx, dio.z - dz) < 40 && st.villas.includes("Villa di Diomede"), dio ? `${Math.hypot(dio.x - dx, dio.z - dz).toFixed(0)} m` : "missing");
    const pm = data.gates.find((g) => g.name === "Porta Marina")!;
    const imp = sub.buildings.find((b) => b.name === "Villa Imperiale");
    check("Villa Imperiale outside the wall within 100 m of Porta Marina", !!imp && !pointInRing(data.wall, imp.x, imp.z) && Math.hypot(imp.x - pm.x, imp.z - pm.z) < 100, "");
    const [mx, mz] = ringCentroid(data.villa!.ring);
    check("Villa dei Misteri integrated, not duplicated (no suburb building on it)", sub.buildings.every((b) => Math.hypot(b.x - mx, b.z - mz) > 40) && sub.roads.some((r) => /Misteri/.test(r.name)), "");
    check("Insula Occidentalis: 5+ terraces over the west wall", sub.buildings.filter((b) => b.kind === "terrace").length >= 5, `${sub.buildings.filter((b) => b.kind === "terrace").length}`);
    check("inns, stables and workshops at the gates", ["inn", "stable", "workshop"].every((k) => sub.buildings.filter((b) => b.kind === k).length >= 2), "");
    check("8+ farm villas in the country, Villa Regina among them", st.farms >= 8 && st.villas.includes("Villa Regina (Boscoreale)"), `${st.farms}`);

    // The shore: 0.8-2.2 km west of Porta Marina, and the terrain there under the sea.
    const ds = shoreAt(sub.shore, pm.x, pm.z).s;
    check("79 AD shoreline 0.8..2.2 km from Porta Marina", ds > 800 && ds < 2200, `${(ds / 1000).toFixed(2)} km`);
    const today = sub.shore.map((v, i) => (i % 2 === 0 ? v - 1400 : v));
    const dt = shoreAt(today, pm.x, pm.z).s;
    check("probe: today's coast (2.7 km out) fails the band", !(dt > 800 && dt < 2200), `${(dt / 1000).toFixed(2)} km`);
    const west = (s: number): [number, number] => { for (let x = pm.x; x > pm.x - 4000; x -= 5) if (shoreAt(sub.shore, x, pm.z).s < s) return [x, pm.z]; return [pm.x, pm.z]; };
    const [sx, sz] = west(-200), [bx2, bz2] = west(20);
    // The terrain without a landcover pack shades ground under 3.5 m as water:
    // the plain behind the dunes, low in today's DEM, must stay above it.
    const [px2, pz2] = west(400);
    check("terrain: the plain 400 m behind the shore stays dry (over 3.5 m) on a 2 m DEM", coastGround(sub, px2, pz2, 2) > 3.5, `${coastGround(sub, px2, pz2, 2).toFixed(1)} m`);
    check("terrain: sea floor 200 m off the old shore, beach above water at it", coastGround(sub, sx, sz, 6) < -1 && coastGround(sub, bx2, bz2, 6) > 0 && coastGround(sub, pm.x, pm.z, 35) === 35,
      `${coastGround(sub, sx, sz, 6).toFixed(1)} / ${coastGround(sub, bx2, bz2, 6).toFixed(1)} m`);

    // The river: south of the walls, nearer than today's.
    let wz1 = -Infinity, wx0 = Infinity, wx1 = -Infinity;
    for (let i = 0; i < data.wall.length; i += 2) { wz1 = Math.max(wz1, data.wall[i + 1]); wx0 = Math.min(wx0, data.wall[i]); wx1 = Math.max(wx1, data.wall[i]); }
    const southOf = (pts: number[]): { ok: boolean; near: number } => {
      let ok = true, near = Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] < wx0 || pts[i] > wx1) continue;
        if (pts[i + 1] < wz1 + 150) ok = false;
        near = Math.min(near, distToRing(data.wall, pts[i], pts[i + 1]));
      }
      return { ok, near };
    };
    const rs = southOf(sub.river.pts);
    check("Sarno south of the walls, 250..900 m off them", rs.ok && rs.near > 250 && rs.near < 900, `${rs.near.toFixed(0)} m`);
    const moved = southOf(sub.river.pts.map((v, i) => (i % 2 ? v - 600 : v)));
    check("probe: the river moved 600 m north fails", !(moved.ok && moved.near > 250 && moved.near < 900), "");
    check("harbour: a 150 m+ quay, warehouses and boats at the mouth", lengthOf(sub.quay) > 150 && sub.buildings.filter((b) => b.kind === "warehouse").length >= 4 && st.boats >= 4, `${lengthOf(sub.quay).toFixed(0)} m quay, ${st.boats} boats`);
    check("a bridge carries the Stabiae road over the Sarno", sub.bridges.length >= 1, "");

    // The gradient: no fields within 150 m of the tombs; gardens, then vines, then fields going out.
    const grid = new LandGrid(sub, data.wall);
    const fieldsNearTombs = (g: LandGrid): number => {
      let n = 0;
      for (const t of sub.tombs) for (let r = 10; r <= 150; r += 20) for (let a = 0; a < 8; a++) {
        if ((FIELD_CLASSES as Land[]).includes(g.at(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r, 1))) n++;
      }
      return n;
    };
    const near = fieldsNearTombs(grid);
    check("no fields within 150 m of a gate road's tombs", near === 0, `${near} samples`);
    check("probe: without the gradient the fields run up to the tombs", fieldsNearTombs(new LandGrid(sub, data.wall, false)) > 100, "");
    const meanDist: Record<number, number[]> = {};
    for (let z = -3500; z <= 3500; z += 50) for (let x = -3500; x <= 3500; x += 50) {
      const c = grid.at(x, z, 1);
      (meanDist[c] ??= []).push(distToRing(data.wall, x, z));
    }
    const md = (c: Land): number => { const l = meanDist[c] ?? [Infinity]; return l.reduce((s, v) => s + v, 0) / l.length; };
    check("gradient out from the walls: tombs < suburbs < gardens < vineyards < fields", md(Land.Tombs) < md(Land.Suburb) && md(Land.Suburb) < md(Land.Garden) && md(Land.Garden) < md(Land.Vineyard) && md(Land.Vineyard) < md(Land.Fields),
      [Land.Tombs, Land.Suburb, Land.Garden, Land.Vineyard, Land.Fields].map((c) => md(c).toFixed(0)).join(" < "));
    check("missions reach the suburbs: tombs, Villa di Diomede, the harbour", ["Villa di Diomede", "Porto alla foce del Sarno", "Necropoli di Porta Ercolano", "Necropoli di Porta Nocera"].every((n) => data.places.some((p) => p.name === n && p.kind === "suburb")), "");
  }
}

// --- 15. the street: counters, eaves, and the walkers' line kept clear -----------------
// Measured on the built mesh, not read back from the builder's constants:
// counter tops are the up-facing marble near each shop opening, eaves the
// terracotta past each street wall, obstacles any vertex at body height.
{
  const { mesh, lampSites } = built;
  const P = mesh.position, I = mesh.index;
  const shops = lampSites.openings.filter((o) => o.kind === "shop" && o.counter);
  // Up-facing marble triangles near the street, gridded by centroid.
  const cell = (x: number, z: number): number => Math.floor(x / 4) * 100003 + Math.floor(z / 4);
  const tops = new Map<number, number[]>();
  const tileV = new Map<number, number[]>();
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], s = mesh.surf[a * 4];
    if (s === Surf.Marble && mesh.normal[a * 4 + 1] > 100) {
      const k = cell((P[a * 3] + P[I[t + 1] * 3] + P[I[t + 2] * 3]) / 3, (P[a * 3 + 2] + P[I[t + 1] * 3 + 2] + P[I[t + 2] * 3 + 2]) / 3);
      (tops.get(k) ?? tops.set(k, []).get(k)!).push(t);
    }
  }
  const near = <T>(m: Map<number, T[]>, x: number, z: number): T[] => {
    const out: T[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(m.get(cell(x + i * 4, z + j * 4)) ?? []));
    return out;
  };
  // Every shop's counter: a top 0.8..1.0 m over the shop floor across the
  // front, behind the facade line and inside the opening, a doorway of
  // 0.85 m+ left at one end, and the L's arm going back into the shop.
  // `out` looks for it on the pavement instead: the probe.
  const counterFaults = (out: boolean): number => {
    let bad = 0;
    for (const o of shops) {
      const sx = out ? -o.ox : o.ox, sz = out ? -o.oz : o.oz;
      let lo = Infinity, hi = -Infinity, amin = Infinity, amax = -Infinity, arm = false;
      for (const t of near(tops, o.x, o.z)) {
        let cx = 0, cy = 0, cz = 0;
        for (let j = 0; j < 3; j++) { const v = I[t + j]; cx += P[v * 3] / 3; cy += P[v * 3 + 1] / 3; cz += P[v * 3 + 2] / 3; }
        const into = -((cx - o.x) * sx + (cz - o.z) * sz), along = (cx - o.x) * o.ex + (cz - o.z) * o.ez, h = cy - o.g;
        if (Math.abs(along) > o.w / 2 || h < 0.3 || h > 1.05) continue;
        if (into > 1.0 && into < 2.2) arm = true;
        if (into < 0.1 || into > 0.85) continue;
        lo = Math.min(lo, h); hi = Math.max(hi, h);
        for (let j = 0; j < 3; j++) {
          const v = I[t + j];
          const a = (P[v * 3] - o.x) * o.ex + (P[v * 3 + 2] - o.z) * o.ez;
          amin = Math.min(amin, a); amax = Math.max(amax, a);
        }
      }
      const gap = Math.max(amin + o.w / 2, o.w / 2 - amax);
      if (!(lo >= 0.8 && hi <= 1.0 + 1e-3 && gap >= 0.85 && (arm || o.w < 1.5))) bad++;
    }
    return bad;
  };
  const cf = counterFaults(false);
  check("every shop counter: top 0.8-1.0 m over its floor, behind the sill, a doorway, an L", shops.length > 600 && cf === 0, `${cf} of ${shops.length} wrong`);
  check("probe: the same counters looked for out on the pavement are missed", counterFaults(true) > shops.length * 0.9, `${counterFaults(true)} missed`);

  // The street eave: over every opening the roof's tiles reach 0.3..0.7 m
  // past the wall, read off the roof's section through the opening's middle.
  // `bare` ignores tile past the wall line: the roofs that stopped at the
  // wall, which is what the probe must catch.
  const tiles = new Map<number, number[]>();
  for (let t = 0; t < I.length; t += 3) {
    if (mesh.surf[I[t] * 4] !== Surf.Tile) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let j = 0; j < 3; j++) { const v = I[t + j]; x0 = Math.min(x0, P[v * 3]); x1 = Math.max(x1, P[v * 3]); z0 = Math.min(z0, P[v * 3 + 2]); z1 = Math.max(z1, P[v * 3 + 2]); }
    for (let i = Math.floor(x0 / 4); i <= Math.floor(x1 / 4); i++) for (let j = Math.floor(z0 / 4); j <= Math.floor(z1 / 4); j++) {
      const k = i * 100003 + j;
      (tiles.get(k) ?? tiles.set(k, []).get(k)!).push(t);
    }
  }
  const openings = lampSites.openings;
  const eaveReach = (o: (typeof openings)[number], bare: boolean): number => {
    let reach = 0;
    for (const t of tiles.get(cell(o.x, o.z)) ?? []) for (let j = 0; j < 3; j++) {
      const p = I[t + j] * 3, q = I[t + ((j + 1) % 3)] * 3;
      const ap = (P[p] - o.x) * o.ex + (P[p + 2] - o.z) * o.ez, aq = (P[q] - o.x) * o.ex + (P[q + 2] - o.z) * o.ez;
      if ((ap > 0) === (aq > 0) || ap === aq) continue;
      const f = ap / (ap - aq);
      const x = P[p] + (P[q] - P[p]) * f, y = P[p + 1] + (P[q + 1] - P[p + 1]) * f, z = P[p + 2] + (P[q + 2] - P[p + 2]) * f;
      const r = (x - o.x) * o.ox + (z - o.z) * o.oz;
      // Above the shop roofs (o.h + 0.72) and inside a balcony roof's reach.
      if (y < o.g + o.h + 1.0 || r > 0.9 || (bare && r > 0.05)) continue;
      reach = Math.max(reach, r);
    }
    return reach;
  };
  const eaved = (bare: boolean): number => openings.filter((o) => { const r = eaveReach(o, bare); return r >= 0.3 && r <= 0.7; }).length;
  const ok = eaved(false);
  check("street eaves: tiles 0.3-0.7 m past the wall over 95%+ of the openings", ok >= openings.length * 0.95, `${ok} of ${openings.length}`);
  check("probe: roofs stopped at the wall line fail it", eaved(true) < openings.length * 0.95, `${eaved(true)} of ${openings.length}`);

  // Nothing stood on a pavement blocks the walkers' line down its middle
  // (data/pompeiilife.ts): no vertex at body height within 0.15 m of it.
  // The probe walks a line 0.3 m off the wall, where the stock and benches are.
  // Furniture is small: triangles under 2.5 m an edge. Walls, columns and
  // the like that stand on a pavement are buildings, which the walker's
  // collider and the house rules answer for.
  const body = new Map<number, number[]>();
  for (let t = 0; t < I.length; t += 3) {
    let big = false;
    for (let j = 0; j < 3 && !big; j++) {
      const a = I[t + j] * 3, b = I[t + ((j + 1) % 3)] * 3;
      big = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]) > 2.5;
    }
    if (big) continue;
    for (let j = 0; j < 3; j++) {
      const v = I[t + j], x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], g = flat(x, z) + KERB_M;
      if (y < g + 0.1 || y > g + 1.9) continue;
      const k = Math.floor(x * 2) * 100003 + Math.floor(z * 2);
      (body.get(k) ?? body.set(k, []).get(k)!).push(v);
    }
  }
  // Where a house or a public building stands out over the pavement the
  // walkers cannot pass anyway: those stretches are building, not furniture.
  const solidCells = new Map<number, [number[], number][]>();
  for (const [s, pad] of [...built.solids.map((s) => [s, 0.3] as const), ...data.publics.map((p) => [p, 3] as const)]) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < s.ring.length; i += 2) { x0 = Math.min(x0, s.ring[i]); x1 = Math.max(x1, s.ring[i]); z0 = Math.min(z0, s.ring[i + 1]); z1 = Math.max(z1, s.ring[i + 1]); }
    for (let i = Math.floor((x0 - 1) / 8); i <= Math.floor((x1 + 1) / 8); i++) for (let j = Math.floor((z0 - 1) / 8); j <= Math.floor((z1 + 1) / 8); j++) {
      const k = i * 100003 + j;
      (solidCells.get(k) ?? solidCells.set(k, []).get(k)!).push([s.ring, pad]);
    }
  }
  const byBuilding = (x: number, z: number): boolean =>
    (solidCells.get(Math.floor(x / 8) * 100003 + Math.floor(z / 8)) ?? []).some(([r, pad]) => pointInRing(r, x, z) || distToRing(r, x, z) < pad);
  const styles = new Map<number, number>();
  const blocked = (wallSide: boolean): number => {
    let hits = 0;
    for (const s of data.streets) {
      const off = s.carriageM / 2 + (wallSide ? s.sidewalkM - 0.3 : s.sidewalkM / 2);
      for (let i = 0; i + 3 < s.pts.length; i += 2) {
        const ax = s.pts[i], az = s.pts[i + 1], bx = s.pts[i + 2], bz = s.pts[i + 3];
        const L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L;
        for (const side of [-1, 1]) for (let d = 0.5; d < L; d += 0.5) {
          const x = ax + ((bx - ax) * d) / L + nx * off * side, z = az + ((bz - az) * d) / L + nz * off * side;
          if (!data.insulae.some((ins) => pointInRing(ins.kerb, x, z) && !pointInRing(ins.ring, x, z)) || byBuilding(x, z)) continue;
          let hit = -1;
          for (let ci = -1; ci <= 1 && hit < 0; ci++) for (let cj = -1; cj <= 1 && hit < 0; cj++) {
            for (const v of body.get((Math.floor(x * 2) + ci) * 100003 + Math.floor(z * 2) + cj) ?? []) {
              if (Math.hypot(P[v * 3] - x, P[v * 3 + 2] - z) < 0.15) { hit = v; break; }
            }
          }
          if (hit < 0) continue;
          hits++;
          if (!wallSide) styles.set(mesh.surf[hit * 4], (styles.get(mesh.surf[hit * 4]) ?? 0) + 1);
        }
      }
    }
    return hits;
  };
  const walk = blocked(false), hug = blocked(true);
  check("the walkers' line down every pavement is clear at body height", walk === 0, `${walk} blocked samples ${JSON.stringify([...styles])}`);
  check("probe: a line hugging the wall runs into the stock and benches", hug > 10, `${hug} blocked samples`);
  check("crossroads shrines and forum stalls built", built.sites.shrines >= 5 && built.sites.stalls >= 3, `${built.sites.shrines} shrines, ${built.sites.stalls} stalls`);
}

// --- 16. no coincident faces along the street fronts --------------------------------
// Two differently coloured or styled faces within 2 cm of each other in the
// same plane z-fight: a phone's coarser depth buffer shows it as a stipple of
// one colour through the other (the kerb faces on Via di Stabia, the shop
// floors over the block slab). Sampled along every kerb line and building
// line, up-facing surfaces just either side of it and upright faces on it.
{
  type Face = { s: number; c: number; n: number[] };
  const fights = (m: PompeiiModel): { up: number; side: number } => {
    // The town mesh and the carriageways; the beaten-earth sheet under everything is drawn biased behind them.
    const meshes = [m.mesh, m.streets];
    // Inside a house that stands out over the pavement its own floors are the house rules' business.
    const inHouse = (x: number, z: number): boolean => m.solids.some((s) => pointInRing(s.ring, x, z) && distToRing(s.ring, x, z) > 0.05);
    const cells = new Map<number, [number, number][]>();
    const key = (i: number, j: number): number => i * 100003 + j;
    meshes.forEach((st, mi) => {
      const P = st.position, I = st.index;
      for (let t = 0; t < I.length; t += 3) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let j = 0; j < 3; j++) { const v = I[t + j]; x0 = Math.min(x0, P[v * 3]); x1 = Math.max(x1, P[v * 3]); z0 = Math.min(z0, P[v * 3 + 2]); z1 = Math.max(z1, P[v * 3 + 2]); }
        if (x1 - x0 > 60 || z1 - z0 > 60) continue;
        for (let i = Math.floor(x0 / 2); i <= Math.floor(x1 / 2); i++) for (let j = Math.floor(z0 / 2); j <= Math.floor(z1 / 2); j++) {
          const k = key(i, j);
          (cells.get(k) ?? cells.set(k, []).get(k)!).push([mi, t]);
        }
      }
    });
    // Each triangle near (x, y, z) whose plane passes within 2 cm of it and that contains its foot.
    const at = (x: number, y: number, z: number, up: boolean): (Face & { y: number })[] => {
      const out: (Face & { y: number })[] = [];
      for (const [mi, t] of cells.get(key(Math.floor(x / 2), Math.floor(z / 2))) ?? []) {
        const st = meshes[mi], P = st.position, I = st.index;
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const L = Math.hypot(nx, ny, nz);
        if (L < 1e-9) continue;
        nx /= L; ny /= L; nz /= L;
        // Up-facing only: a soffit under its own eave tiles faces the other way and never fights them.
        if (up ? ny < 0.5 : Math.abs(ny) > 0.3) continue;
        // Height of the plane over (x, z), or the distance off it for an upright face.
        let yy = y, dist: number;
        if (up) { yy = P[a + 1] - (nx * (x - P[a]) + nz * (z - P[a + 2])) / ny; dist = 0; } else dist = nx * (x - P[a]) + ny * (y - P[a + 1]) + nz * (z - P[a + 2]);
        if (Math.abs(dist) > 0.02) continue;
        // Inside: barycentric on the plane's dominant axes.
        const px = x - nx * dist - P[a], py = yy - ny * dist - P[a + 1], pz = z - nz * dist - P[a + 2];
        const ax_ = Math.abs(nx), ay_ = Math.abs(ny), az_ = Math.abs(nz);
        const [u1, u2, v1, v2, p1, p2] = ay_ >= ax_ && ay_ >= az_ ? [ux, uz, vx, vz, px, pz] : ax_ >= az_ ? [uy, uz, vy, vz, py, pz] : [ux, uy, vx, vy, px, py];
        const den = u1 * v2 - u2 * v1;
        if (Math.abs(den) < 1e-12) continue;
        const s = (p1 * v2 - p2 * v1) / den, r = (u1 * p2 - u2 * p1) / den;
        if (s < 0.001 || r < 0.001 || s + r > 0.999) continue;
        const v = I[t];
        out.push({ s: st.surf[v * 4], c: st.colour[v * 4] * 65536 + st.colour[v * 4 + 1] * 256 + st.colour[v * 4 + 2], y: yy, n: [nx, nz] });
      }
      return out;
    };
    const differ = (p: Face, q: Face): boolean => p.s !== q.s || p.c !== q.c;
    let up = 0, side = 0;
    for (const ins of data.insulae) for (const ring of [ins.kerb, ins.ring]) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[((i + 1) % n) * 2], bz = ring[((i + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.5) continue;
        const ox = (bz - az) / L, oz = -(bx - ax) / L;
        for (let d = 0.5; d < L - 0.3; d += 1.5) {
          const x = ax + ((bx - ax) * d) / L, z = az + ((bz - az) * d) / L, g = flat(x, z);
          const sides = at(x, g + KERB_M - 0.12, z, false);
          // Pairs with a kerb or block-step face: walls overlapping walls are the house rules' business.
          // Parallel faces only (within half a degree): one meeting the wall square on does not fight
          // it, and a wall crossing a kerb at a shallow angle meets it along a line, not over a face.
          const par = (p: Face, q: Face): boolean => Math.abs(p.n[0] * q.n[0] + p.n[1] * q.n[1]) > 0.99996;
          if (sides.some((p, k) => sides.some((q, j) => j > k && differ(p, q) && par(p, q) && (p.s === Surf.Kerb || q.s === Surf.Kerb)))) side++;
          for (const off of [-0.15, 0.15]) {
            if (inHouse(x + ox * off, z + oz * off)) continue;
            // Roofs left out: their overlaps are no part of the street's ground.
            const ups = at(x + ox * off, 0, z + oz * off, true).filter((p) => p.s !== Surf.Tile).sort((p, q) => p.y - q.y);
            if (ups.some((p, k) => k > 0 && ups[k].y - ups[k - 1].y < 0.02 && differ(p, ups[k - 1]))) up++;
          }
        }
      }
    }
    return { up, side };
  };
  const now = fights(buildPompeii({ data, groundAt: flat, suburbs: false }));
  const old = fights(buildPompeii({ data, groundAt: flat, suburbs: false, probeCoplanar: true }));
  check("no coincident faces along the kerbs and building lines", now.up === 0 && now.side === 0, `${now.up} up-facing, ${now.side} upright`);
  check("probe: the old kerb faces and shop floors are caught", old.up + old.side > 0, `${old.up} up-facing, ${old.side} upright`);
}

// --- 17. inside the houses, and the open frontage ------------------------------------
// The full build furnishes its atrium houses (render/pompeiiinterior.ts): a
// fauces from the street into each rule-built atrium, a tablinum and
// cubicula off the surveyed ones, peristyle gardens. Floors and ceilings are
// their own styles. Ground a block leaves open at its street edge is walled,
// never a lawn to the kerb, and no house's colonnade stands out on a
// pavement. Each is held against a build that lacks it.
{
  const full = buildPompeii({ data, groundAt: flat, suburbs: false });
  const lean = buildPompeii({ data, groundAt: flat, suburbs: false, lean: true });
  type Counts = { fauces: number; tablinum: number; cubiculum: number; peristyle: number; furnished: number; floors: number; ceilings: number };
  const rooms = (m: PompeiiModel): Counts => {
    const n = (k: string): number => m.interiors.filter((v) => v.kind === k).length;
    let floors = 0, ceilings = 0;
    for (let t = 0; t < m.mesh.index.length; t += 3) {
      const s = m.mesh.surf[m.mesh.index[t] * 4];
      if (s === Surf.Floor) floors++;
      if (s === Surf.Ceiling) ceilings++;
    }
    return { fauces: n("fauces"), tablinum: n("tablinum"), cubiculum: n("cubiculum"), peristyle: n("peristyle"), furnished: m.interiors.filter((v) => v.kind === "atrium" && v.furniture >= 2).length, floors, ceilings };
  };
  const ok = (c: Counts): boolean => c.fauces >= 400 && c.tablinum >= 40 && c.cubiculum >= 60 && c.peristyle >= 10 && c.furnished >= 20 && c.floors > 2000 && c.ceilings > 2000;
  const fc = rooms(full), lc = rooms(lean);
  check("full build: fauces, tablina, cubicula, peristyles, furnished atria, floors, ceilings", ok(fc), JSON.stringify(fc));
  check("probe: the phone build, with no rooms inside, fails it", !ok(lc), JSON.stringify(lc));

  // No house colonnade on a pavement: every column inside a block's kerb
  // stands inside its building line.
  // A public building (the Temple of Vespasian) can stand inside a block's kerb on its own podium.
  const onPavement = (m: PompeiiModel): number => m.orders.filter((c) => !data.publics.some((p) => pointInRing(p.ring, c.x, c.z)) && data.insulae.some((i) => pointInRing(i.kerb, c.x, c.z) && !pointInRing(i.ring, c.x, c.z))).length;
  const pv = onPavement(full), pvProbe = onPavement(buildPompeii({ data, groundAt: flat, suburbs: false, probePorticoOut: true }));
  check("no column stands on a pavement", pv === 0, `${pv} columns`);
  check("probe: the colonnades left unchecked are caught", pvProbe > 0, `${pvProbe} columns`);

  // Open frontage on the kerb line: metres of building line with the kerb on
  // it and nothing standing within 3 m inside (sampled every 25 cm in).
  const bare = (m: PompeiiModel): number => {
    let metres = 0;
    for (const ins of data.insulae) {
      if (ins.garden) continue;
      const r = ins.ring, n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1) continue;
        const nx = -(bz - az) / L, nz = (bx - ax) / L;
        for (let d = 0.5; d < L; d += 1) {
          const x = ax + ((bx - ax) * d) / L, z = az + ((bz - az) * d) / L;
          if (distToRing(ins.kerb, x, z) > 0.15) continue;
          const s = pointInRing(r, x + nx, z + nz) ? 1 : -1;
          if (data.publics.some((p) => pointInRing(p.ring, x + nx * s, z + nz * s))) continue;
          let hit = false;
          for (let k = 0.15; k < 3 && !hit; k += 0.25) hit = m.solids.some((so) => pointInRing(so.ring, x + nx * s * k, z + nz * s * k));
          if (!hit) metres++;
        }
      }
    }
    return metres;
  };
  const bm = bare(full), bmProbe = bare(buildPompeii({ data, groundAt: flat, suburbs: false, probeNoPlotWalls: true }));
  check("open frontage on the kerb line is walled (under 120 m of the town's left bare)", bm < 120, `${bm} m bare, ${full.stats.plotWallM.toFixed(0)} m of plot wall`);
  check("probe: without the plot walls it is caught", bmProbe > 500, `${bmProbe} m bare`);

  // Every column carries something and stands on something: straight up
  // from its capital the town mesh is within 5 cm (an architrave, a beam),
  // and down from its base there is a floor within 5 cm under it or one it
  // is set into. Beams were boxes open underneath, colonnades stopped short
  // of their roofs, the forum's gallery stood half a metre over its floor.
  const unsupported = (m: PompeiiModel): { top: number; base: number } => {
    const meshes = [m.mesh, m.floor, m.streets];
    const grid = new Map<number, [number, number][]>();
    const key = (i: number, j: number): number => i * 100003 + j;
    meshes.forEach((st, mi) => {
      const P = st.position, I = st.index;
      for (let t = 0; t < I.length; t += 3) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let j = 0; j < 3; j++) { const v = I[t + j]; x0 = Math.min(x0, P[v * 3]); x1 = Math.max(x1, P[v * 3]); z0 = Math.min(z0, P[v * 3 + 2]); z1 = Math.max(z1, P[v * 3 + 2]); }
        if (x1 - x0 > 300 || z1 - z0 > 300) continue;
        for (let i = Math.floor(x0 / 2); i <= Math.floor(x1 / 2); i++) for (let j = Math.floor(z0 / 2); j <= Math.floor(z1 / 2); j++) (grid.get(key(i, j)) ?? grid.set(key(i, j), []).get(key(i, j))!).push([mi, t]);
      }
    });
    const heights = (x: number, z: number): number[] => {
      const out: number[] = [];
      for (const [mi, t] of grid.get(key(Math.floor(x / 2), Math.floor(z / 2))) ?? []) {
        const P = meshes[mi].position, I = meshes[mi].index;
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const d = (P[b + 2] - P[c + 2]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 2] - P[c + 2]);
        if (Math.abs(d) < 1e-9) continue;
        const wa = ((P[b + 2] - P[c + 2]) * (x - P[c]) + (P[c] - P[b]) * (z - P[c + 2])) / d;
        const wb = ((P[c + 2] - P[a + 2]) * (x - P[c]) + (P[a] - P[c]) * (z - P[c + 2])) / d;
        if (wa < -1e-6 || wb < -1e-6 || wa + wb > 1 + 1e-6) continue;
        out.push(wa * P[a + 1] + wb * P[b + 1] + (1 - wa - wb) * P[c + 1]);
      }
      return out;
    };
    let top = 0, base = 0;
    for (const c of m.orders) {
      const t = c.y0 + c.h, hs = heights(c.x, c.z);
      if (!hs.some((y) => y >= t - 0.1 && y <= t + 0.05)) top++;
      if (!hs.some((y) => y >= c.y0 - 0.05 && y < t - 0.5)) base++;
    }
    return { top, base };
  };
  const cu = unsupported(full), cuProbe = unsupported(buildPompeii({ data, groundAt: flat, suburbs: false, probeOpenBeams: true }));
  check("every column inside the walls carries a beam and stands on a floor", cu.top === 0 && cu.base === 0, `${full.orders.length} columns: ${cu.top} carry nothing, ${cu.base} stand on nothing`);
  check("probe: open beams and the unbeamed colonnades are caught", cuProbe.top > 100, `${cuProbe.top} carry nothing, ${cuProbe.base} stand on nothing`);
}

console.log(failures ? `\n${failures} pompeii check(s) FAILED` : "\nall pompeii checks ok");
if (failures) process.exit(1);
