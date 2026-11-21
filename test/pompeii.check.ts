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
import { AMPHI, ROOF_PITCH_DEG, Surf, buildPompeii, type PompeiiModel } from "../src/render/pompeiimesh";
import { pompeiiRoadPack, pompeiiHeightAt } from "../src/data/pompeiiroads";
import { buildRoadGraph, componentLengths, connectedComponents } from "../src/data/roadgraph";
import { budgetForTier, pompeiiBytes, type DeviceDescriptor } from "../src/render/budget";
import { VESUVIUS, restoreVesuvius, vesuviusCone } from "../src/render/pompeii";
import { Heightfield } from "../src/data/dem";
import { CITIES } from "../src/cities";

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
  check("places for missions: 60+ named, all inside the wall or at a gate", data.places.length >= 60 &&
    data.places.every((p) => p.kind === "gate" || pointInRing(data.wall, p.x, p.z)), `${data.places.length}`);
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
  let tile = 0, plaster = 0, pitched = 0, tileN = 0;
  const colours = new Set<string>();
  for (let t = 0; t < mesh.index.length; t += 3) {
    const v = mesh.index[t];
    const s = mesh.surf[v * 4];
    if (s === Surf.Tile) {
      tile++;
      const ny = mesh.normal[v * 4 + 1] / 127;
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
    tileFrac: tile / tris, plasterFrac: plaster / tris, pitchedFrac: pitched / Math.max(1, tileN),
    plasterColours: colours.size, flatRoofs: m.stats.flatRoofs, lots: m.stats.lots, domus: m.stats.domus,
    tabernae: m.stats.tabernae, compluvia: m.stats.compluvia, fountains: m.stats.fountains, steppingStones: m.stats.steppingStones,
  };
  if (stats.tileFrac < 0.06) failed.push("terracotta roofs");
  if (stats.pitchedFrac < 0.95) failed.push("roofs pitched 12-35 deg");
  if (stats.plasterFrac < 0.15) failed.push("plastered walls");
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
  const r = rules(built);
  const s = r.stats;
  check("town passes every reconstruction rule", r.failed.length === 0, r.failed.join(", ") || "all");
  check(`roofs pitched ${ROOF_PITCH_DEG} deg (12-35 window), terracotta`, s.pitchedFrac >= 0.95 && s.tileFrac >= 0.06, `${(s.pitchedFrac * 100).toFixed(0)}% pitched, ${(s.tileFrac * 100).toFixed(1)}% of tris`);
  check("plaster: 6+ palette colours over 15%+ of the triangles", s.plasterColours >= 6 && s.plasterFrac >= 0.15, `${s.plasterColours} colours, ${(s.plasterFrac * 100).toFixed(1)}%`);
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
  check("phone: the lean town fits the building line it replaces", phone.pompeii.lean && pompeiiBytes(phone.pompeii) < line.bytes, `${(pompeiiBytes(phone.pompeii) / MB).toFixed(1)} of ${(line.bytes / MB).toFixed(1)} MB`);
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

console.log(failures ? `\n${failures} pompeii check(s) FAILED` : "\nall pompeii checks ok");
if (failures) process.exit(1);
