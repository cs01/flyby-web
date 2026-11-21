// The gate on Herculaneum: its baked pack (public/landmarks/herculaneum.json),
// the town Pompeii's builder makes from it (src/render/pompeiimesh.ts with
// src/render/herculaneummesh.ts), its 79 AD ground (src/data/herculaneum.ts)
// and the town definition (src/data/towns.ts) that keeps Pompeii as it was.
//
// Bounds are LITERALS from outside the code under test: the excavated
// cardines run about 50 m apart and the decumani about 90 m; twelve boat
// sheds open on the beach, each about 4 m wide and 9 m deep, under a terrace
// some 8 m up; the Villa of the Papyri is about 250 m long with a pool of
// about 66 by 7 m; Herculaneum is about 7 km from the vent, which the first
// surge reached about 01:00. Each rule is probed again where it must fail.

import { readFileSync } from "node:fs";
import { parsePompeii, pointInRing, ringArea, ringCentroid, type PompeiiData } from "../src/data/pompeii";
import { Surf, buildPompeii, type PompeiiModel } from "../src/render/pompeiimesh";
import { BEACH_M, cliffN, frameFwd, frameInv, hercGround } from "../src/data/herculaneum";
import { TOWNS, townDef, townForCity } from "../src/data/towns";
import { SURGES } from "../src/sim/eruption";
import { VESUVIUS } from "../src/render/pompeii";
import { pompeiiRoadPack } from "../src/data/pompeiiroads";
import { buildRoadGraph, componentLengths, connectedComponents } from "../src/data/roadgraph";
import { budgetForTier, pompeiiBytes, type DeviceDescriptor } from "../src/render/budget";
import { CITIES } from "../src/cities";
import { shoreAt } from "../src/data/pompeiisuburbs";
import { Origin } from "../src/geo";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(66)} ${detail}`);
  if (!ok) failures++;
}

const data = parsePompeii(readFileSync(new URL("../public/landmarks/herculaneum.json", import.meta.url), "utf8"));
const pompeii = parsePompeii(readFileSync(new URL("../public/landmarks/pompeii.json", import.meta.url), "utf8"));
const h = data.herc!;
const groundOf = (d: PompeiiData) => (x: number, z: number): number => (d.herc ? hercGround(d.herc, d.suburbs?.river ?? null, x, z, 20) : 30);
const ground = groundOf(data);

// --- 1. the pack and the grid ------------------------------------------------------------
check("pack is Herculaneum's, with its sea front", data.town === "herculaneum" && !!h && !!data.suburbs?.cliff, `${data.town}`);
const surveyed = (name: string) => data.streets.filter((s) => s.name === name && !s.inferred);
const lineT = (name: string): number => { const s = surveyed(name)[0]; return frameInv(h.frame, s.pts[0], s.pts[1])[0]; };
const lineN = (name: string): number => { const s = surveyed(name)[0]; return frameInv(h.frame, s.pts[0], s.pts[1])[1]; };
{
  for (const n of ["Cardo III", "Cardo IV", "Cardo V", "Decumano Inferiore", "Decumano Massimo"]) {
    check(`surveyed street present: ${n}`, surveyed(n).length > 0, `${surveyed(n).length} pieces`);
  }
  const ok = ["Cardo III", "Cardo IV", "Cardo V", "Decumano Inferiore", "Decumano Massimo"].every((n) => surveyed(n).length);
  if (ok) {
    const c3 = lineT("Cardo III"), c4 = lineT("Cardo IV"), c5 = lineT("Cardo V");
    check("cardines run 40..60 m apart", c4 - c3 > 40 && c4 - c3 < 60 && c5 - c4 > 40 && c5 - c4 < 60, `${(c4 - c3).toFixed(0)}, ${(c5 - c4).toFixed(0)} m`);
    const dn = lineN("Decumano Massimo") - lineN("Decumano Inferiore");
    check("decumani 75..105 m apart, the maximus inland", dn > 75 && dn < 105, `${dn.toFixed(0)} m`);
    // Square grid: a cardo's direction is the frame's n, a decumanus's its t.
    const s = surveyed("Cardo IV")[0], d = surveyed("Decumano Inferiore")[0];
    const a1 = Math.atan2(s.pts[s.pts.length - 1] - s.pts[1], s.pts[s.pts.length - 2] - s.pts[0]);
    const a2 = Math.atan2(d.pts[d.pts.length - 1] - d.pts[1], d.pts[d.pts.length - 2] - d.pts[0]);
    const ang = Math.abs(((((a1 - a2) * 180) / Math.PI) % 180 + 180) % 180);
    check("cardines cross the decumani at 85..95 degrees", ang > 85 && ang < 95, `${ang.toFixed(1)} deg`);
    // OSM's own centrelines lie on the fitted lines (the bake read them, not the other way round).
    check("the cardines run down to the sea front (south-west end at the terrace)", ["Cardo III", "Cardo IV", "Cardo V"].every((n) => Math.min(...surveyed(n).map((q) => frameInv(h.frame, q.pts[0], q.pts[1])[1])) < 30), "");
  }
  const mx = data.streets.find((s) => s.name === "Decumano Massimo")!;
  check("decumanus maximus is the broad one (>= 6 m between kerbs)", mx.carriageM >= 6 && data.streets.filter((s) => s.name.startsWith("Cardo")).every((s) => s.carriageM < mx.carriageM), `${mx.carriageM} m`);
  const inf = data.streets.filter((s) => s.inferred).length;
  check("streets past the excavation are marked inferred", inf >= 5 && inf < data.streets.length, `${inf} of ${data.streets.length}`);
  // Vacuity: the spacing rule rejects a grid with Cardo IV moved 25 m.
  if (ok) {
    const c3 = lineT("Cardo III"), c4 = lineT("Cardo IV") + 25, c5 = lineT("Cardo V");
    check("probe: a cardo 25 m off its line fails the spacing rule", !(c4 - c3 > 40 && c4 - c3 < 60 && c5 - c4 > 40 && c5 - c4 < 60), "");
  }
}

// --- 2. named houses on their outlines ---------------------------------------------------
const HOUSES = ["Casa dei Cervi", "Casa di Nettuno e Anfitrite", "Casa Sannitica", "Casa del Tramezzo di Legno", "Casa dell'Atrio a Mosaico", "Casa a Graticcio"];
const built = buildPompeii({ data, groundAt: ground });
const grey = buildPompeii({ data, groundAt: ground, greyBoxes: true });
/** Vertices of the town mesh inside a ring, more than `above` over the ground. */
function vertsIn(m: PompeiiModel, ring: number[], above: number, surf?: Surf): number {
  let n = 0;
  const p = m.mesh.position, s = m.mesh.surf;
  for (let i = 0; i < m.mesh.position.length / 3; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (surf !== undefined && s[i * 4] !== surf) continue;
    if (y > ground(x, z) + above && pointInRing(ring, x, z)) n++;
  }
  return n;
}
{
  for (const name of HOUSES) {
    const d = data.domus.find((q) => q.name === name);
    const place = data.places.find((p) => p.name === name);
    const area = d ? Math.abs(ringArea(d.ring)) : 0;
    check(`${name}: outline 60..3000 m2, its place inside it`, !!d && !!place && area > 60 && area < 3000 && pointInRing(d.ring, place.x, place.z), `${area.toFixed(0)} m2`);
    check(`${name}: built on its outline (walls over 3 m inside it)`, !!d && vertsIn(built, d.ring, 3) > 30, `${d ? vertsIn(built, d.ring, 3) : 0} verts`);
  }
  // Vacuity: a ring moved 400 m into the sea holds no house.
  const d = data.domus.find((q) => q.name === "Casa dei Cervi")!;
  const moved = d.ring.map((v, i) => (i % 2 ? v + 400 : v - 400));
  check("probe: an outline moved into the sea finds no walls", vertsIn(built, moved, 3) === 0, "");
}

// --- 3. the beach, the sheds and the shore of 79 -------------------------------------------
{
  const st = built.herc!;
  check("twelve boat sheds built", st && st.fornici === 12 && h.fornici.length === 12, `${st?.fornici}`);
  check("sheds about 4 m wide and 8..10 m deep", h.fornici.every((f) => f.w > 3.5 && f.w < 5 && f.d >= 8 && f.d <= 10), "");
  const beachY = h.levels.beach, terraceY = h.levels.terrace;
  check("shed floors on the beach (within 0.6 m of its level)", st.shedFloorY.every((y) => Math.abs(y - beachY) < 0.6), st.shedFloorY.map((y) => y.toFixed(1)).join(" "));
  check("the terrace 6..11 m over the beach", terraceY - beachY > 6 && terraceY - beachY < 11, `${(terraceY - beachY).toFixed(1)} m`);
  // On the 79 shoreline: every shed opens on dry beach with the sea within 40 m of it.
  const shore = data.suburbs!.shore;
  const ok = h.fornici.every((f) => { const s = shoreAt(shore, f.x + f.fx, f.z + f.fz).s; return s > 5 && s < 40; });
  check("each shed opens on the beach, the sea of 79 within 40 m", ok, h.fornici.map((f) => shoreAt(shore, f.x + f.fx, f.z + f.fz).s.toFixed(0)).join(" "));
  const f0 = h.fornici[5];
  const sea = ground(f0.x + f0.fx * (BEACH_M + 30), f0.z + f0.fz * (BEACH_M + 30));
  const beach = ground(f0.x + f0.fx * 6, f0.z + f0.fz * 6);
  const town = ground(...frameFwd(h.frame, 0, 120));
  check("the ground: sea in front of the beach, though today's DEM there is land", sea < 0.5, `${sea.toFixed(1)} m`);
  check("the ground: dry beach (3.5..5 m) in front of the sheds", beach > 3.5 && beach < 5, `${beach.toFixed(1)} m`);
  check("the ground: the town over the terrace", town > terraceY, `${town.toFixed(1)} m`);
  // The town's southern edge is the shore: the town ring's nearest point to the water within 60 m.
  let near = Infinity;
  for (let i = 0; i < data.wall.length; i += 2) near = Math.min(near, shoreAt(shore, data.wall[i], data.wall[i + 1]).s);
  check("the town's south edge stands within 60 m of the sea of 79", near > 0 && near < 60, `${near.toFixed(0)} m`);
  check("the sheds' face follows the cliff line", h.fornici.every((f) => Math.abs(frameInv(h.frame, f.x, f.z)[1] - cliffN(frameInv(h.frame, f.x, f.z)[0])) < 0.5), "");
  check("boats hauled up on the beach", data.suburbs!.boats.filter((b) => b.beached && shoreAt(shore, b.x, b.z).s > 0 && shoreAt(shore, b.x, b.z).s < BEACH_M).length >= 4, `${data.suburbs!.boats.length}`);
  check("probe: grey boxes build no sheds", grey.herc === null, "");
}

// --- 4. the Trellis House and the upper floors -------------------------------------------
{
  const tr = built.upperHouses.find((u) => u.name === h.trellis);
  check("Trellis House: two storeys, its upper floor timber framed", !!tr && tr.storeys === 2 && tr.craticium && tr.y1 - tr.y0 > 2.6, tr ? `${tr.y0.toFixed(1)}..${tr.y1.toFixed(1)} m` : "missing");
  const d = data.domus.find((q) => q.name === h.trellis)!;
  const grown = (r: number[], k: number): number[] => { const [cx, cz] = ringCentroid(r); return r.map((v, i) => (i % 2 ? cz + (v - cz) * k : cx + (v - cx) * k)); };
  const crat = vertsIn(built, grown(d.ring, 1.25), 3, Surf.Craticium);
  check("Trellis House: opus craticium on its upper wall", crat >= 4, `${crat} verts`);
  const wood = tr ? vertsIn(built, grown(d.ring, 1.25), tr.y0 - ground(tr.x, tr.z) - 0.5, Surf.Wood) : 0;
  check("Trellis House: timber at its upper floor", wood >= 8, `${wood} verts`);
  const two = built.lots.filter((l) => l.storeys === 2).length / built.lots.length;
  check("most of the town two storeys (Herculaneum kept its upper floors)", two > 0.5, `${(two * 100).toFixed(0)}%`);
  check("timber upper floors across the town", built.stats.timberFloors > 100, `${built.stats.timberFloors}`);
  check("probe: grey boxes have no craticium", vertsIn(grey, grown(d.ring, 1.25), 3, Surf.Craticium) === 0, "");
}

// --- 5. the Villa of the Papyri, the Neptune mosaic, the Sacred Area ---------------------
{
  const v = data.villa;
  let len = 0;
  if (v) for (let i = 0; i < v.ring.length; i += 2) for (let j = i + 2; j < v.ring.length; j += 2) len = Math.max(len, Math.hypot(v.ring[i] - v.ring[j], v.ring[i + 1] - v.ring[j + 1]));
  check("Villa of the Papyri present, 180..300 m long", !!v && v.name === "Villa dei Papiri" && len > 180 && len < 300, `${len.toFixed(0)} m`);
  check("Villa of the Papyri outside the town, to the north-west", !!v && !pointInRing(data.wall, ...(ringCentroid(v.ring) as [number, number])) && ringCentroid(v.ring)[0] < ringCentroid(data.wall)[0], "");
  check("Villa of the Papyri built (walls inside its outline)", !!v && vertsIn(built, v.ring, 3) > 100, `${v ? vertsIn(built, v.ring, 3) : 0} verts`);
  check("its long pool built, 150..600 m2", built.herc!.poolM2 > 150 && built.herc!.poolM2 < 600, `${built.herc!.poolM2.toFixed(0)} m2`);
  const art = built.art.find((a) => a.id === "neptune-amphitrite");
  check("Neptune and Amphitrite mosaic in its house, on OSM's point", !!art && art.house === "Casa di Nettuno e Anfitrite" && Math.hypot(art.x - h.neptune.x, art.z - h.neptune.z) < 3, art ? `${Math.hypot(art.x - h.neptune.x, art.z - h.neptune.z).toFixed(1)} m` : "missing");
  const ring = data.domus.find((q) => q.name === "Casa di Nettuno e Anfitrite")!.ring;
  check("the mosaic is drawn (glass mosaic surface in the house)", vertsIn(built, ring, 0.3, Surf.Mosaic) >= 8, `${vertsIn(built, ring, 0.3, Surf.Mosaic)} verts`);
  check("probe: grey boxes draw no mosaic", vertsIn(grey, ring, 0.3, Surf.Mosaic) === 0, "");
  check("Sacred Area: two temples and Balbus's altar and statue on the terrace", built.herc!.temples === 2 && built.herc!.statues >= 1 && pointInRing(h.terrace, h.balbus.x, h.balbus.z), "");
  const theatre = data.publics.find((p) => p.kind === "theatre");
  check("the theatre, north of the excavation", !!theatre && frameInv(h.frame, ...(ringCentroid(theatre.ring) as [number, number]))[1] > 230, "");
}

// --- 6. Pompeii is unchanged by any of it ------------------------------------------------
{
  check("Pompeii's pack has no town tag and no Herculaneum extras", pompeii.town === undefined && pompeii.herc === undefined, "");
  const p = TOWNS.pompeii;
  check("Pompeii's definition is the builder's old constants", p.walled && p.style.upperStorey === 0 && p.style.balcony === 0.4 && !p.style.timber && p.eruption.fall === 1, "");
  const pb = buildPompeii({ data: pompeii, groundAt: () => 30, lean: true });
  let newSurf = 0;
  for (let i = 0; i < pb.mesh.surf.length; i += 4) if (pb.mesh.surf[i] === Surf.Mosaic || pb.mesh.surf[i] === Surf.Craticium) newSurf++;
  check("Pompeii builds no timber floors, craticium or mosaic, no sea front", pb.stats.timberFloors === 0 && pb.upperHouses.length === 0 && newSurf === 0 && pb.herc === null, `${pb.stats.timberFloors}, ${newSurf}`);
  check("Pompeii keeps its walls and amphitheatre", pb.stats.towers > 0 && pb.amphitheatre.rimY > pb.amphitheatre.floorY, `${pb.stats.towers} towers`);
  // Vacuity: Herculaneum's definition on Pompeii's pack does build timber.
  const asHerc = buildPompeii({ data: { ...pompeii, town: "herculaneum" }, groundAt: () => 30, lean: true });
  check("probe: Pompeii's pack with Herculaneum's style does build timber", asHerc.stats.timberFloors > 0, `${asHerc.stats.timberFloors}`);
}

// --- 7. the city, the eruption, the cart and the phone -----------------------------------
{
  const c = CITIES.find((q) => q.id === "herculaneum");
  check("City entry on the pack's origin, in 79 AD", !!c && Math.abs(c.lat - data.lat0) < 1e-6 && Math.abs(c.lon - data.lon0) < 1e-6 && c.era?.at.startsWith("0079"), "");
  check("the city maps to its town definition", townForCity("herculaneum")?.pack === "herculaneum.json" && townForCity("paris") === null, "");
  const o = new Origin(data.lat0, data.lon0), v = o.toWorld(VESUVIUS.lat, VESUVIUS.lon);
  const km = Math.hypot(v.x, v.z) / 1000;
  check("Herculaneum 6..8 km from the vent", km > 6 && km < 8, `${km.toFixed(1)} km`);
  const t = townDef("herculaneum");
  const first = SURGES.find((s) => s.runoutM >= km * 1000);
  check("the first surge to reach it is S1, about 01:00 (hour 25)", !!first && first.name === "S1" && Math.abs(t.eruption.surgeH - first.atH) < 0.01 && t.eruption.surgeH > 24.5 && t.eruption.surgeH < 25.5, `${first?.name} ${t.eruption.surgeH}`);
  check("ash fall a few percent of Pompeii's (the plume blew south-east)", t.eruption.fall > 0 && t.eruption.fall < 0.1, `${t.eruption.fall}`);
  const g = buildRoadGraph(pompeiiRoadPack(data).roads);
  const comp = connectedComponents(g);
  const lens = [...componentLengths(g, comp).values()].sort((p, q) => q - p);
  const total = lens.reduce((s, x) => s + x, 0);
  check("cart graph: one connected grid (95%+ of the streets)", lens[0] / total > 0.95, `${(lens[0] / 1000).toFixed(2)} of ${(total / 1000).toFixed(2)} km`);
  const bytes = (m: PompeiiModel): number => [m.mesh, m.floor, m.streets].reduce((s, x) =>
    s + x.position.byteLength + x.normal.byteLength + x.colour.byteLength + x.surf.byteLength + x.wall.byteLength + x.index.byteLength, 0);
  const PHONE: DeviceDescriptor = { coarsePointer: true, deviceMemoryGb: 4, maxTextureSize: 4096, drawingBufferWidth: 618, drawingBufferHeight: 1373, pixelRatio: 1.5 };
  const phone = budgetForTier("reduced", PHONE);
  const lean = buildPompeii({ data, groundAt: ground, lean: phone.pompeii.lean });
  check("phone: the lean town fits the town budget the phone plan holds", phone.pompeii.lean && bytes(lean) <= pompeiiBytes(phone.pompeii), `${(bytes(lean) / 1048576).toFixed(1)} of ${(pompeiiBytes(phone.pompeii) / 1048576).toFixed(1)} MB`);
  check("full build under 1.5 s", built.stats.buildMs < 1500, `${built.stats.buildMs.toFixed(0)} ms`);
}

if (failures) {
  console.log(`\n${failures} herculaneum check(s) failed`);
  process.exit(1);
}
console.log("\nall herculaneum checks ok");
