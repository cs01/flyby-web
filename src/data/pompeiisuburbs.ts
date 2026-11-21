// Pompeii outside its walls in 79 AD: the tomb streets out of every gate, the
// suburban villas, inns and workshops, the terraced houses over the west wall,
// the Sarno and its harbour, the shoreline as it then ran, the roads into the
// country with their farm villas, and the land-use gradient from the tombs out
// to the grain fields. Laid out by tools/bake-pompeii.ts into the pack's
// `suburbs`, built by render/pompeiisuburbs.ts, gated by test/pompeii.check.ts.
//
// Sources, in order of trust: OSM (the tombs of the Porta Ercolano, Nocera,
// Stabia, Vesuvio and Nola necropoleis, Via delle Tombe, the Villa di Diomede
// and Terme Suburbane markers); the excavation literature for what is known
// but unmapped (the Pagus Augustus Felix Suburbanus round Porta Ercolano, the
// Villa Imperiale and Insula Occidentalis against the west wall, Moregine on
// the Sarno); and estimates where nobody has a survey (the 79 AD coast and
// river course, the roads past the excavation, the farm villas). Everything
// not read off OSM is flagged `inferred`, and the estimates say so where they
// are defined.
//
// Pure: no DOM, no THREE. Pack coordinates (x east, z south, metres).

import { pointInRing, type Ring } from "./pompeii";

export type TombKind = "altar" | "aedicula" | "schola" | "tower" | "enclosure" | "tholos" | "niche";

export interface SuburbTomb {
  name: string;
  kind: TombKind;
  /** Footprint centre and size: w along the road, d back from it. */
  x: number; z: number; w: number; d: number;
  /** The road's direction here, radians from +x; the tomb's front faces (fx, fz), toward the road. */
  rot: number; fx: number; fz: number;
  /** Index into `roads`. */
  road: number;
  inferred: boolean;
}

export interface SuburbRoad {
  name: string;
  gate: string;
  pts: number[];
  /** Carriageway width, metres. */
  widthM: number;
  /** Basalt-paved from the gate out to this arc length; beaten gravel beyond. */
  pavedM: number;
  /** Tombs line it from the gate out to this arc length. */
  tombM: number;
}

export type SuburbKind =
  | "villa" | "inn" | "stable" | "tabernae" | "workshop" | "baths" | "terrace" | "warehouse" | "farm" | "shrine" | "porticus";

export interface SuburbBuilding {
  name: string;
  kind: SuburbKind;
  /** Footprint centre and size; the front (toward the road, the sea or the river) faces (fx, fz). */
  x: number; z: number; w: number; d: number;
  rot: number; fx: number; fz: number;
  inferred: boolean;
}

export interface SuburbBoat { x: number; z: number; rot: number; len: number; beached: boolean }

export interface PompeiiSuburbs {
  roads: SuburbRoad[];
  tombs: SuburbTomb[];
  buildings: SuburbBuilding[];
  /** The 79 AD shoreline, north to south, sea to the west (right of the direction of travel). */
  shore: number[];
  /** The Sarno's centreline, upstream (east) to the mouth, with its water level and half width per point. */
  river: { pts: number[]; level: number[]; halfW: number[] };
  /** Quay line along the north bank at the mouth. */
  quay: number[];
  boats: SuburbBoat[];
  /** Where a bridge carries a road over the river. */
  bridges: { x: number; z: number; rot: number; len: number; deckY: number }[];
  /** A beach under a sea cliff (Herculaneum's), not Pompeii's beach and dunes. */
  cliff?: boolean;
}

// --- documented and estimated positions -------------------------------------------------
//
// The 79 AD coast: the beach ridges the borehole studies find (Pescatore et
// al. 2001; Vogel and Maerker 2010; Stefaniuk et al. 2016) put the shore one
// to two kilometres inside today's, furthest in at the Sarno mouth, where the
// river's own fill and the eruption's built the plain out since. The line
// below is an estimate drawn through that band, about 1.3 km west of Porta
// Marina, meeting today's coast north of Oplontis and below the Varano
// plateau at Stabiae, where the shore has moved least.
export const SHORE_79: number[] = [
  -4500, -700, -3400, -560, -2500, -260, -1800, 60, -1580, 600, -1480, 1150, -1380, 1500, -1150, 2200,
  -850, 3000, -500, 3900, -250, 4700, -150, 5400,
];

// The Sarno in 79: a navigable river that ran closer under the town than the
// canalised one today, past the Moregine (Murecine) complex about 600 m south
// of Porta Stabia, to a mouth on the shore above. Course and levels are an
// estimate on today's DEM: levels fall from the plain's 8 m to the sea.
// [x, z, water level, half width]
const SARNO_79: [number, number, number, number][] = [
  [3300, 380, 8.2, 12], [2700, 440, 7.8, 12], [2150, 520, 7.4, 13], [1720, 470, 7.1, 13], [1320, 565, 6.8, 14],
  [960, 515, 6.5, 14], [660, 600, 6.1, 15], [400, 560, 5.8, 15], [120, 660, 5.4, 16], [-200, 615, 5.0, 16],
  [-480, 720, 4.4, 17], [-760, 815, 3.6, 18], [-1000, 960, 2.6, 19], [-1200, 1060, 1.6, 20], [-1380, 1180, 0.8, 22],
  [-1520, 1240, 0.3, 24],
];

/** Lat/lon to pack metres, the same tangent plane as src/geo.ts Origin. */
function project(lat0: number, lon0: number): (lat: number, lon: number) => [number, number] {
  const p = (lat0 * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
  return (lat, lon) => [(lon - lon0) * mLon, (lat0 - lat) * mLat];
}

// --- polyline helpers ----------------------------------------------------------------------

export function pointAlong(p: number[], s: number): { x: number; z: number; tx: number; tz: number } {
  let acc = 0;
  const n = p.length / 2;
  for (let i = 0; i + 1 < n; i++) {
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (acc + L >= s || i + 2 === n) {
      const t = L > 0 ? Math.max(0, Math.min(1, (s - acc) / L)) : 0;
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / (L || 1), tz: (bz - az) / (L || 1) };
    }
    acc += L;
  }
  return { x: p[0], z: p[1], tx: 1, tz: 0 };
}

/** Nearest point on a polyline: distance, arc length there, the segment's direction, and the side (cross > 0: right of travel, +x east, +z south). */
export function nearestOn(p: number[], x: number, z: number): { d: number; s: number; tx: number; tz: number; cross: number; i: number; t: number } {
  let best = { d: Infinity, s: 0, tx: 1, tz: 0, cross: 0, i: 0, t: 0 };
  let acc = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az;
    const L2 = dx * dx + dz * dz, L = Math.sqrt(L2);
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best.d) best = { d, s: acc + L * t, tx: dx / (L || 1), tz: dz / (L || 1), cross: (dx * (z - az) - dz * (x - ax)) / (L || 1), i: i / 2, t };
    acc += L;
  }
  return best;
}

export function lengthOf(p: number[]): number {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

/**
 * Signed distance from the 79 AD shore, positive inland, and how much the
 * line governs here: 1 along it, falling to 0 within 600 m past either end,
 * where today's coast is left as it is.
 */
export function shoreAt(shore: number[], x: number, z: number): { s: number; w: number } {
  const n = nearestOn(shore, x, z);
  // Travelling north to south the sea is on the right: x decreasing is west,
  // and a point west of a southward segment has a negative cross product here.
  const s = n.cross >= 0 ? -n.d : n.d;
  const L = lengthOf(shore);
  let w = 1;
  if (n.s <= 0.01 || n.s >= L - 0.01) {
    // Past an end: how far beyond it, along the end segment's direction.
    const end = n.s <= 0.01 ? 0 : 1;
    const k = end ? shore.length - 4 : 0;
    const tx = shore[k + 2] - shore[k], tz = shore[k + 3] - shore[k + 1], tl = Math.hypot(tx, tz) || 1;
    const ex = end ? shore[shore.length - 2] : shore[0], ez = end ? shore[shore.length - 1] : shore[1];
    const past = ((x - ex) * tx + (z - ez) * tz) / tl * (end ? 1 : -1);
    w = Math.max(0, 1 - past / 600);
  }
  return { s, w };
}

/** The river at a point: distance from its centreline, the water level and half width there. */
export function riverAt(r: PompeiiSuburbs["river"], x: number, z: number): { d: number; level: number; halfW: number; cross: number; s: number } {
  const n = nearestOn(r.pts, x, z);
  const i = n.i, j = Math.min(i + 1, r.level.length - 1);
  return { d: n.d, level: r.level[i] + (r.level[j] - r.level[i]) * n.t, halfW: r.halfW[i] + (r.halfW[j] - r.halfW[i]) * n.t, cross: n.cross, s: n.s };
}

function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Catmull-Rom through the control points, about `step` metres apart, the extra channels interpolated linearly. */
function smooth(ctrl: number[][], step: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 1 < ctrl.length; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(1, Math.round(L / step));
    for (let m = 0; m < k; m++) {
      const t = m / k, t2 = t * t, t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const row = [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
      for (let c = 2; c < p1.length; c++) row.push(p1[c] + (p2[c] - p1[c]) * t);
      out.push(row);
    }
  }
  out.push([...ctrl[ctrl.length - 1]]);
  return out;
}

// --- the layout -----------------------------------------------------------------------------

export interface OsmTomb { name: string; tag: string; ring: number[] | null; x: number; z: number }

export interface SuburbInput {
  lat0: number;
  lon0: number;
  wall: Ring;
  gates: { name: string; x: number; z: number }[];
  /** Every historic=tomb in the OSM answer. */
  osmTombs: OsmTomb[];
  /** Via delle Tombe (Via dei Sepolcri) as OSM draws it, from Porta Ercolano. */
  sepolcri: number[] | null;
  /** OSM markers: the Villa di Diomede, the Terme Suburbane. */
  markers: Record<string, [number, number]>;
  /** The Villa dei Misteri's outline, for its lane. */
  misteri: Ring | null;
}

function distToRingEdge(r: Ring, x: number, z: number): number {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/** OSM's `tomb=` values (and a few names) to the five types modelled. */
function tombKind(tag: string, name: string, seed: number): TombKind {
  const t = tag.toLowerCase();
  if (/mamia|aulus veius$|herennius|schola|exedra|eumachia/i.test(name) || /schola|exedra/.test(t)) return "schola";
  if (/istacidi/i.test(name)) return "tower";
  if (/naevoleia|calventius|umbricius|allei/i.test(name) || /altar/.test(t)) return "altar";
  if (/tholos/.test(t)) return "tholos";
  if (/aedicul|naiskos|tetrapylon|arch/.test(t)) return "aedicula";
  if (/niche|cerrinius/.test(t + name.toLowerCase())) return "niche";
  if (/enclos|burial|ustrin|triclin|mausoleum|house/.test(t)) return "enclosure";
  if (/podium/.test(t)) return seed < 0.5 ? "tower" : "altar";
  return (["altar", "aedicula", "enclosure", "tower"] as TombKind[])[Math.floor(seed * 4)];
}

const TOMB_SIZE: Record<TombKind, [number, number]> = {
  altar: [4.2, 4.2], aedicula: [4.6, 4.6], schola: [7.2, 4.2], tower: [5, 5], enclosure: [6.5, 5.5], tholos: [5, 5], niche: [3.2, 2.6],
};

export function layoutSuburbs(inp: SuburbInput): PompeiiSuburbs {
  const P = project(inp.lat0, inp.lon0);
  const gate = (name: string): [number, number] => {
    const g = inp.gates.find((q) => q.name === name);
    if (!g) throw new Error(`suburbs: no gate ${name}`);
    return [g.x, g.z];
  };
  const r1 = (v: number): number => Math.round(v * 10) / 10;

  // --- roads ---
  // Past the excavated stretches, every course below is an estimate along the
  // bearing to the town the road served.
  const roads: SuburbRoad[] = [];
  const road = (name: string, g: string, pts: number[], widthM: number, pavedM: number, tombM: number): void => {
    roads.push({ name, gate: g, pts: pts.map(r1), widthM, pavedM, tombM });
  };
  {
    const [gx, gz] = gate("Porta di Ercolano");
    // OSM's Via delle Tombe to the Villa di Diomede, then on north-west for Herculaneum and Naples.
    const sep = inp.sepolcri && inp.sepolcri.length >= 4 ? [...inp.sepolcri] : [gx, gz, -812, -410];
    sep[0] = gx; sep[1] = gz;
    road("Via dei Sepolcri", "Porta di Ercolano", [...sep, -880, -445, -1150, -600, -1600, -850, -2300, -1200, -3200, -1600, -4200, -2000], 5.6, 420, 330);
  }
  {
    const [gx, gz] = gate("Porta Vesuvio");
    road("Road to Vesuvius", "Porta Vesuvio", [gx, gz, gx - 15, gz - 75, -370, -800, -420, -1300, -480, -2000, -560, -3000, -640, -4000], 4.2, 120, 230);
  }
  {
    const [gx, gz] = gate("Porta Nola");
    road("Road to Nola", "Porta Nola", [gx, gz, gx + 34, gz - 76, 420, -900, 800, -1500, 1400, -2400, 2100, -3500], 4.6, 150, 210);
  }
  {
    const [gx, gz] = gate("Porta Sarno");
    road("Road to Sarnum", "Porta Sarno", [gx, gz, gx + 78, gz - 6, 900, -470, 1500, -560, 2300, -640, 3200, -700, 4200, -760], 4.6, 140, 210);
  }
  {
    const [gx, gz] = gate("Porta Nocera");
    // Out of the gate to the necropolis road, which runs along the wall:
    // east through the Fondo Pacifico tombs for Nuceria, west to Porta Stabia.
    road("Via Nucerina", "Porta Nocera", [gx, gz, gx + 3, 12, 600, -55, 745, -105, 1000, -170, 1600, -250, 2600, -300, 4200, -320], 5.2, 330, 420);
    road("Necropolis road west", "Porta Nocera", [gx + 3, 12, 330, 62, 230, 120], 4.4, 260, 260);
  }
  {
    const [gx, gz] = gate("Porta di Stabia");
    road("Via Stabiana to Stabiae", "Porta di Stabia", [gx, gz, gx + 35, gz + 35, 240, 180, 280, 400, 292, 600, 310, 900, 300, 1600, 250, 2600, 200, 3800, 150, 5000], 5.2, 200, 190);
  }
  {
    const [gx, gz] = gate("Porta Marina");
    road("Road to the harbour", "Porta Marina", [gx, gz, gx - 55, gz + 8, -620, 90, -850, 170, -1080, 320, -1250, 560, -1340, 860, -1345, 1110], 4.6, 160, 130);
    road("Road to the beach", "Porta Marina", [-1080, 320, -1300, 380, -1500, 420, -1640, 440], 3.6, 0, 0);
  }
  road("River road", "Porta di Stabia", [287, 500, 0, 555, -400, 612, -760, 740, -1000, 880, -1250, 1040, -1338, 1085], 4, 0, 0);
  {
    // A lane from Via dei Sepolcri to the Villa dei Misteri's front.
    if (inp.misteri) {
      let cx = 0, cz = 0;
      const n = inp.misteri.length / 2;
      for (let i = 0; i < n; i++) { cx += inp.misteri[i * 2]; cz += inp.misteri[i * 2 + 1]; }
      cx /= n; cz /= n;
      const sep = roads[0].pts;
      const near = nearestOn(sep, cx, cz);
      const a = pointAlong(sep, near.s);
      // Stop at the villa's outline, not its middle.
      const dx = cx - a.x, dz = cz - a.z, L = Math.hypot(dx, dz) || 1;
      let stop = L;
      for (let t = 0; t < L; t += 1) if (pointInRing(inp.misteri, a.x + (dx / L) * t, a.z + (dz / L) * t)) { stop = t - 3; break; }
      road("Lane to the Villa dei Misteri", "Porta di Ercolano", [a.x, a.z, a.x + (dx / L) * stop, a.z + (dz / L) * stop], 3, 0, 0);
    }
  }

  // --- the river ---
  const sm = smooth(SARNO_79, 25);
  // The water is held at the terrain's dry floor (LAND_MIN, less half a
  // metre) until the last 60 m before the shore: lower, the banks the terrain
  // must keep above 3.5 m would stand over it as a trench, and the terrain
  // mesh between them hides the water. A rendering floor, not a gradient.
  const river = {
    pts: sm.flatMap((p) => [r1(p[0]), r1(p[1])]),
    level: sm.map((p) => Math.round((shoreAt(SHORE_79, p[0], p[1]).s > 60 ? Math.max(p[2], LAND_MIN - 0.5) : p[2]) * 100) / 100),
    halfW: sm.map((p) => r1(p[3])),
  };

  // Bridges: wherever a road crosses the river.
  const bridges: PompeiiSuburbs["bridges"] = [];
  for (const rd of roads) {
    const p = rd.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const L = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      for (let s = 0; s < L; s += 2) {
        const x = p[i] + ((p[i + 2] - p[i]) * s) / L, z = p[i + 1] + ((p[i + 3] - p[i + 1]) * s) / L;
        const rv = riverAt(river, x, z);
        if (rv.d < 2 && !bridges.some((b) => Math.hypot(b.x - x, b.z - z) < 40)) {
          bridges.push({ x: r1(x), z: r1(z), rot: Math.atan2(p[i + 3] - p[i + 1], p[i + 2] - p[i]), len: r1(rv.halfW * 2 + 16), deckY: Math.round((rv.level + 3.2) * 10) / 10 });
        }
      }
    }
  }

  // --- buildings ---
  const buildings: SuburbBuilding[] = [];
  /** A building beside a road: `side` +1 right of travel, -1 left; `back` metres from the carriageway edge to its front. */
  const roadside = (name: string, kind: SuburbKind, ri: number, s: number, side: number, w: number, d: number, back = 1.5, inferred = true): void => {
    const rd = roads[ri];
    const a = pointAlong(rd.pts, s);
    // Right of travel with +z south is (-tz, tx).
    const nx = -a.tz * side, nz = a.tx * side;
    const off = rd.widthM / 2 + back + d / 2;
    buildings.push({ name, kind, x: r1(a.x + nx * off), z: r1(a.z + nz * off), w, d, rot: Math.atan2(a.tz, a.tx), fx: -nx, fz: -nz, inferred });
  };
  const ri = (name: string): number => roads.findIndex((r) => r.name === name);
  const SEP = ri("Via dei Sepolcri");
  // The Pagus Augustus Felix Suburbanus: between the gate's tombs and the
  // necropolis proper (the 60-120 m gap OSM leaves) stood shops under a
  // portico, an inn with its stable, and the Villa delle Colonne a Mosaico.
  roadside("Tabernae of the Pagus", "tabernae", SEP, 90, 1, 52, 11, 2.5);
  roadside("Villa delle Colonne a Mosaico", "villa", SEP, 96, 1, 26, 30, 15.5);
  roadside("Hospitium at Porta Ercolano", "inn", SEP, 86, -1, 38, 16, 2.5);
  roadside("Stable of the hospitium", "stable", SEP, 92, -1, 26, 12, 21);
  roadside("Potter's workshop", "workshop", SEP, 250, 1, 18, 14, 9);
  {
    // The Villa di Diomede: OSM marks it; it stood on the road's south-west
    // side, the house at the road and the garden court below it toward the sea.
    const m = inp.markers["Villa di Diomede"] ?? P(40.75239, 14.47865);
    const n = nearestOn(roads[SEP].pts, m[0], m[1]);
    const side = n.cross >= 0 ? 1 : -1;
    roadside("Villa di Diomede", "villa", SEP, n.s, side, 34, 62, Math.max(1.5, n.d - roads[SEP].widthM / 2 - 31));
  }
  roadside("Caupona at Porta Vesuvio", "inn", ri("Road to Vesuvius"), 95, 1, 18, 12, 2);
  roadside("Fullery at Porta Vesuvio", "workshop", ri("Road to Vesuvius"), 160, -1, 20, 14, 6);
  roadside("Stabulum at Porta Nola", "stable", ri("Road to Nola"), 85, -1, 28, 14, 3);
  roadside("Caupona at Porta Nola", "inn", ri("Road to Nola"), 120, 1, 20, 12, 2);
  roadside("Tannery at Porta Sarno", "workshop", ri("Road to Sarnum"), 110, 1, 24, 16, 4);
  roadside("Hospitium at Porta Nocera", "inn", ri("Via Nucerina"), 30, 1, 22, 13, 3);
  roadside("Workshops at Porta Nocera", "workshop", ri("Via Nucerina"), 470, -1, 26, 14, 4);
  roadside("Hospitium at Porta Stabia", "inn", ri("Via Stabiana to Stabiae"), 105, -1, 30, 14, 2);
  roadside("Stabulum at Porta Stabia", "stable", ri("Via Stabiana to Stabiae"), 112, -1, 24, 12, 20);
  roadside("Warehouse at Porta Marina", "warehouse", ri("Road to the harbour"), 260, 1, 30, 12, 3);
  {
    // The Terme Suburbane, outside Porta Marina on the road's south side, built against the wall.
    const m = inp.markers["Terme Suburbane"] ?? P(40.74868, 14.48278);
    const n = nearestOn(roads[ri("Road to the harbour")].pts, m[0], m[1]);
    roadside("Terme Suburbane", "baths", ri("Road to the harbour"), Math.max(14, n.s), n.cross >= 0 ? 1 : -1, 28, 24, 2.5, false);
  }
  {
    // The Villa Imperiale: a long portico and its rooms built against the
    // outside of the wall south of Porta Marina, facing the sea (Maiuri's
    // excavation; the OSM wall still bulges round its terrace).
    const [gx, gz] = gate("Porta Marina");
    // Its portico ran east-west, open to the south; OSM's wall spur round its
    // terrace spans about x -410..-310, z 80..125 in the pack.
    const ang = (-8 * Math.PI) / 180;
    const cx = gx + 55, cz = gz + 50;
    buildings.push({ name: "Villa Imperiale", kind: "porticus", x: r1(cx), z: r1(cz), w: 78, d: 16, rot: ang, fx: -Math.sin(ang), fz: Math.cos(ang), inferred: true });
  }
  // Insula Occidentalis: houses terraced down over the west wall between
  // Porta Marina and Porta Ercolano (the Casa del Bracciale d'Oro is three
  // storeys of them), their loggias on the sea.
  {
    const w = inp.wall, n = w.length / 2;
    const [mx, mz] = gate("Porta Marina"), [ex, ez] = gate("Porta di Ercolano");
    let k = 0;
    for (let i = 0; i < n; i++) {
      const ax = w[i * 2], az = w[i * 2 + 1], bx = w[((i + 1) % n) * 2], bz = w[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 10) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      // Out of the town: the right of a positive-area ring.
      const ox = tz, oz = -tx;
      if (ox > -0.5) continue; // west-facing stretches only
      for (let s = 0; s + 20 <= L; s += 24) {
        const x = ax + tx * (s + 10), z = az + tz * (s + 10);
        if (z > mz - 40 || z < ez + 45) continue;
        if (Math.hypot(x - mx, z - mz) < 45 || Math.hypot(x - ex, z - ez) < 45) continue;
        const dep = 24;
        buildings.push({ name: `Insula Occidentalis ${++k}`, kind: "terrace", x: r1(x + ox * (dep / 2 - 3)), z: r1(z + oz * (dep / 2 - 3)), w: 22, d: dep, rot: Math.atan2(tz, tx), fx: ox, fz: oz, inferred: true });
      }
    }
  }

  // --- the harbour at the river mouth ---
  const quay: number[] = [];
  const boats: SuburbBoat[] = [];
  {
    const L = lengthOf(river.pts);
    // The mouth: where the river meets the shore.
    let sMouth = L;
    for (let s = L; s > 0; s -= 5) {
      const a = pointAlong(river.pts, s);
      if (shoreAt(SHORE_79, a.x, a.z).s > 0) { sMouth = s; break; }
    }
    for (let s = sMouth - 300; s <= sMouth - 30; s += 15) {
      const a = pointAlong(river.pts, s);
      const rv = riverAt(river, a.x, a.z);
      // The north bank: the side whose normal points to -z.
      const nx = a.tz, nz = -a.tx; // left of westward travel is north
      const side = nz < 0 ? 1 : -1;
      quay.push(r1(a.x + nx * side * (rv.halfW + 1)), r1(a.z + nz * side * (rv.halfW + 1)));
    }
    for (let k = 0; k < 4; k++) {
      const s = sMouth - 280 + k * 62;
      const a = pointAlong(river.pts, s);
      const rv = riverAt(river, a.x, a.z);
      const nx = a.tz, nz = -a.tx, side = nz < 0 ? 1 : -1;
      const off = rv.halfW + 1 + 10 + 7;
      buildings.push({ name: k === 1 ? "Horrea at the Sarno mouth" : `Warehouse ${k + 1} at the harbour`, kind: "warehouse", x: r1(a.x + nx * side * off), z: r1(a.z + nz * side * off), w: 44, d: 14, rot: Math.atan2(a.tz, a.tx), fx: -nx * side, fz: -nz * side, inferred: true });
      // A boat moored at the quay in front of each.
      const bo = rv.halfW - 4.5;
      boats.push({ x: r1(a.x + nx * side * bo), z: r1(a.z + nz * side * bo), rot: Math.atan2(a.tz, a.tx) + (k % 2 ? Math.PI : 0), len: 10 + 4 * hash(k, 9), beached: false });
    }
    // Two fishing boats drawn up on the beach north of the mouth.
    for (let k = 0; k < 2; k++) {
      const z = 980 + k * 45;
      // Find the beach at this z: 14 m inland of the shore.
      let x = -1300;
      for (let q = -1300; q > -1800; q -= 2) { if (shoreAt(SHORE_79, q, z).s < 14) { x = q; break; } }
      boats.push({ x: r1(x), z, rot: Math.PI * 0.08 + k * 0.3, len: 6.5, beached: true });
    }
  }

  // --- tombs ---
  const tombs: SuburbTomb[] = [];
  const inTown = (x: number, z: number, pad: number): boolean => pointInRing(inp.wall, x, z) || distToRingEdge(inp.wall, x, z) < pad;
  const nearBuilding = (x: number, z: number, pad: number): boolean => buildings.some((b) => {
    const c = Math.cos(b.rot), s = Math.sin(b.rot), dx = x - b.x, dz = z - b.z;
    return Math.abs(dx * c + dz * s) < b.w / 2 + pad && Math.abs(-dx * s + dz * c) < b.d / 2 + pad;
  });
  const roadsOnly = roads.filter((r) => r.tombM > 0);
  for (let k = 0; k < inp.osmTombs.length; k++) {
    const t = inp.osmTombs[k];
    // The nearest tomb road.
    let bi = -1, bn: ReturnType<typeof nearestOn> | null = null;
    for (let r = 0; r < roads.length; r++) {
      if (roads[r].tombM <= 0) continue;
      const n = nearestOn(roads[r].pts, t.x, t.z);
      if (!bn || n.d < bn.d) { bn = n; bi = r; }
    }
    if (!bn || bn.d > 80) continue;
    const seed = hash(k, 77);
    const kind = tombKind(t.tag, t.name, seed);
    const fx = bn.cross >= 0 ? bn.tz : -bn.tz, fz = bn.cross >= 0 ? -bn.tx : bn.tx;
    // Footprint: the OSM outline's extent along and across the road, else the type's size.
    let [w, d] = TOMB_SIZE[kind];
    let cx = t.x, cz = t.z;
    if (t.ring && t.ring.length >= 6) {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < t.ring.length; i += 2) {
        const u = t.ring[i] * bn.tx + t.ring[i + 1] * bn.tz, v = -t.ring[i] * bn.tz + t.ring[i + 1] * bn.tx;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      w = Math.max(2.2, Math.min(14, u1 - u0)); d = Math.max(2, Math.min(12, v1 - v0));
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      cx = um * bn.tx - vm * bn.tz; cz = um * bn.tz + vm * bn.tx;
    }
    // Keep a footprint off the carriageway: some OSM outlines lap it.
    const clear = roads[bi].widthM / 2 + 1.2 + d / 2 - nearestOn(roads[bi].pts, cx, cz).d;
    if (clear > 0) { cx -= fx * clear; cz -= fz * clear; }
    tombs.push({ name: t.name, kind, x: r1(cx), z: r1(cz), w: r1(w), d: r1(d), rot: Math.atan2(bn.tz, bn.tx), fx: r1(fx * 100) / 100, fz: r1(fz * 100) / 100, road: bi, inferred: false });
  }
  // Fill each tomb road out to its documented reach with tombs of the same
  // types at the spacing the excavated stretches show (a plot every 8 to 14
  // m, with gaps for gardens and ustrina), where OSM has none.
  const KINDS: [TombKind, number][] = [["altar", 0.24], ["aedicula", 0.2], ["enclosure", 0.2], ["tower", 0.12], ["niche", 0.1], ["schola", 0.08], ["tholos", 0.06]];
  roadsOnly.forEach((rd) => {
    const r = roads.indexOf(rd);
    let slot = 0;
    for (const side of [1, -1]) {
      for (let s = 12; s < rd.tombM; s += 11) {
        slot++;
        const h = hash(r * 997 + slot, side + 5);
        if (h < 0.3) continue;
        let kind: TombKind = "altar";
        let acc = 0;
        const hk = hash(r, slot, 31);
        for (const [k, p] of KINDS) { acc += p; if (hk < acc) { kind = k; break; } }
        const [w, d] = TOMB_SIZE[kind];
        const a = pointAlong(rd.pts, s + (hash(r, slot, 3) - 0.5) * 4);
        const nx = -a.tz * side, nz = a.tx * side;
        const off = rd.widthM / 2 + 1.4 + d / 2;
        const x = a.x + nx * off, z = a.z + nz * off;
        if (inTown(x, z, 10)) continue;
        if (tombs.some((t) => Math.hypot(t.x - x, t.z - z) < Math.max(t.w, t.d) / 2 + w / 2 + 1.5)) continue;
        if (nearBuilding(x, z, 3)) continue;
        if (roads.some((o, oi) => oi !== r && nearestOn(o.pts, x, z).d < o.widthM / 2 + d / 2 + 2)) continue;
        if (riverAt(river, x, z).d < 40) continue;
        tombs.push({ name: "", kind, x: r1(x), z: r1(z), w, d, rot: Math.atan2(a.tz, a.tx), fx: r1(-nx * 100) / 100, fz: r1(-nz * 100) / 100, road: r, inferred: true });
      }
    }
  });
  // The tomb of Marcus Venerius Secundio, found in 2021 in the Porta Sarno
  // necropolis: a walled precinct with a painted front, about 100 m out.
  {
    const rS = ri("Road to Sarnum");
    const a = pointAlong(roads[rS].pts, 62);
    const nx = a.tz, nz = -a.tx; // north side
    const x = a.x + nx * 7.5, z = a.z + nz * 7.5;
    const clash = tombs.findIndex((t) => Math.hypot(t.x - x, t.z - z) < 7);
    if (clash >= 0) tombs.splice(clash, 1);
    tombs.push({ name: "Tomba di Marcus Venerius Secundio", kind: "enclosure", x: r1(x), z: r1(z), w: 8, d: 7, rot: Math.atan2(a.tz, a.tx), fx: -nx, fz: -nz, road: rS, inferred: true });
  }

  // --- shrines along the roads, and the farm villas in the country ---
  roads.forEach((rd, r) => {
    const L = lengthOf(rd.pts);
    if (L < 600) return;
    for (let s = Math.max(rd.tombM + 120, 380); s < L - 100; s += 650 + 200 * hash(r, Math.floor(s))) {
      const side = hash(r, Math.floor(s), 2) < 0.5 ? 1 : -1;
      const a = pointAlong(rd.pts, s);
      if (riverAt(river, a.x, a.z).d < 50 || shoreAt(SHORE_79, a.x, a.z).s < 60) continue;
      roadside("Roadside shrine", "shrine", r, s, side, 2.2, 1.6, 1.2);
    }
  });
  {
    // Villa Regina at Boscoreale, the excavated wine farm (approximate
    // position), then villae rusticae on a jittered grid through the
    // vineyard band, nearer a road than not, off the river and the shore.
    const [vx, vz] = P(40.7686, 14.486);
    const farms: [number, number, string, boolean][] = [[vx, vz, "Villa Regina (Boscoreale)", true]];
    const cell = 620;
    for (let gzi = -6; gzi <= 6; gzi++) for (let gxi = -6; gxi <= 6; gxi++) {
      const x = gxi * cell + (hash(gxi, gzi, 1) - 0.5) * cell * 0.7, z = -200 + gzi * cell + (hash(gxi, gzi, 2) - 0.5) * cell * 0.7;
      const r = Math.hypot(x, z + 200);
      if (r < 1000 || r > 3700) continue;
      if (hash(gxi, gzi, 3) < 0.42) continue;
      if (distToRingEdge(inp.wall, x, z) < 700) continue;
      if (shoreAt(SHORE_79, x, z).s < 400 || riverAt(river, x, z).d < 140) continue;
      const dRoad = Math.min(...roads.map((rd) => nearestOn(rd.pts, x, z).d));
      if (dRoad < 70 || dRoad > 700) continue;
      if (farms.some((f) => Math.hypot(f[0] - x, f[1] - z) < 500)) continue;
      farms.push([x, z, "Villa rustica", true]);
    }
    for (let k = 0; k < farms.length && k < 16; k++) {
      const [x, z, name, inferred] = farms[k];
      // Turned to face the nearest road.
      let best: ReturnType<typeof nearestOn> | null = null;
      for (const rd of roads) { const n = nearestOn(rd.pts, x, z); if (!best || n.d < best.d) best = n; }
      const fx = best!.cross >= 0 ? best!.tz : -best!.tz, fz = best!.cross >= 0 ? -best!.tx : best!.tx;
      buildings.push({ name, kind: "farm", x: r1(x), z: r1(z), w: 36, d: 32, rot: Math.atan2(best!.tz, best!.tx), fx, fz, inferred });
    }
  }

  return { roads, tombs, buildings, shore: SHORE_79, river, quay, boats, bridges };
}

/** Tomb-lined gate roads and their tomb counts, for the gate and the mission list. */
export function tombsByGate(sub: PompeiiSuburbs): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of sub.tombs) { const g = sub.roads[t.road].gate; m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}

// --- land use: the gradient out from the walls ---------------------------------------------

export const enum Land {
  Town = 0,
  /** Verges among the tombs: trodden earth, dry grass, the odd cypress. */
  Tombs = 1,
  /** Round the gate suburbs: house gardens and yards. */
  Suburb = 2,
  /** Market gardens (horti): small irrigated plots of greens. */
  Garden = 3,
  Vineyard = 4,
  Olive = 5,
  /** The open country: grain, pasture, the centuriation mix. */
  Fields = 6,
  Sea = 7,
  Beach = 8,
  Dunes = 9,
  River = 10,
  /** Reeds, willows and wet meadow on the river banks. */
  Banks = 11,
  Road = 12,
}

/** Classes that are fields in the sense the gate means: crops in parcels, not gardens. */
export const FIELD_CLASSES: readonly Land[] = [Land.Vineyard, Land.Olive, Land.Fields];

/**
 * A distance raster round the town (10 m cells, 8 km square), so classing a
 * drape pixel is a few array reads: the drape repaint asks millions of times.
 */
export class LandGrid {
  static readonly CELL = 10;
  static readonly HALF = 4000;
  readonly n = (LandGrid.HALF * 2) / LandGrid.CELL;
  /** Metres to the nearest tomb, road, wall, river edge, farm villa; capped at 65 km by the storage. */
  readonly dTomb: Uint16Array;
  readonly dRoad: Uint16Array;
  readonly dWall: Uint16Array;
  readonly dFarm: Uint16Array;
  /** Metres to the river's centreline: the exact (slow) river test runs only near it. */
  readonly dRiver: Uint16Array;
  readonly inside: Uint8Array;
  static readonly SHORE_HALF = 16000;
  static readonly SHORE_N = 801;
  readonly shoreS: Float32Array;
  readonly shoreW: Float32Array;

  /** shoreAt, read off the lattice (exact past its edge). */
  shore(x: number, z: number): { s: number; w: number } {
    const m = LandGrid.SHORE_N, H = LandGrid.SHORE_HALF, c = (H * 2) / (m - 1);
    const fx = (x + H) / c, fz = (z + H) / c;
    if (fx < 0 || fz < 0 || fx >= m - 1 || fz >= m - 1) return shoreAt(this.sub.shore, x, z);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * m + i;
    const bl = (a: Float32Array): number => (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - tz) + (a[k + m] * (1 - tx) + a[k + m + 1] * tx) * tz;
    return { s: bl(this.shoreS), w: bl(this.shoreW) };
  }

  constructor(readonly sub: PompeiiSuburbs, readonly wall: Ring, readonly gradient = true) {
    const n = this.n, C = LandGrid.CELL, H = LandGrid.HALF;
    const N = n * n;
    const tmp = new Float32Array(N);
    const seedPoints = (pts: [number, number][]): Uint16Array => {
      tmp.fill(1e9);
      for (const [x, z] of pts) {
        const i = Math.floor((x + H) / C), j = Math.floor((z + H) / C);
        if (i >= 0 && j >= 0 && i < n && j < n) tmp[j * n + i] = 0;
      }
      return chamfer(tmp, n, C);
    };
    const polyPts = (p: number[], step: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i + 3 < p.length; i += 2) {
        const L = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        for (let s = 0; s <= L; s += step) out.push([p[i] + ((p[i + 2] - p[i]) * s) / L, p[i + 1] + ((p[i + 3] - p[i + 1]) * s) / L]);
      }
      return out;
    };
    this.dTomb = seedPoints(sub.tombs.map((t) => [t.x, t.z]));
    this.dRoad = seedPoints(sub.roads.flatMap((r) => polyPts(r.pts, C / 2)));
    const ringPts = polyPts([...wall, wall[0], wall[1]], C / 2);
    this.dWall = seedPoints(ringPts);
    this.dFarm = seedPoints(sub.buildings.filter((b) => b.kind === "farm").map((b) => [b.x, b.z]));
    this.dRiver = seedPoints(polyPts(sub.river.pts, C / 2));
    // The shore's signed distance on a 40 m lattice over the drape's reach,
    // read bilinearly: a distance field interpolates almost exactly, and the
    // drape asks for millions of pixels, most of them outside the 8 km grid.
    {
      const m = LandGrid.SHORE_N, c = (LandGrid.SHORE_HALF * 2) / (m - 1);
      this.shoreS = new Float32Array(m * m);
      this.shoreW = new Float32Array(m * m);
      for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
        const r = shoreAt(sub.shore, -LandGrid.SHORE_HALF + i * c, -LandGrid.SHORE_HALF + j * c);
        this.shoreS[j * m + i] = r.s; this.shoreW[j * m + i] = r.w;
      }
    }
    this.inside = new Uint8Array(N);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < wall.length; i += 2) { x0 = Math.min(x0, wall[i]); x1 = Math.max(x1, wall[i]); z0 = Math.min(z0, wall[i + 1]); z1 = Math.max(z1, wall[i + 1]); }
    for (let j = Math.max(0, Math.floor((z0 + H) / C)); j < Math.min(n, Math.ceil((z1 + H) / C)); j++) {
      for (let i = Math.max(0, Math.floor((x0 + H) / C)); i < Math.min(n, Math.ceil((x1 + H) / C)); i++) {
        if (pointInRing(wall, -H + (i + 0.5) * C, -H + (j + 0.5) * C)) this.inside[j * n + i] = 1;
      }
    }
  }

  /**
   * What the ground is at x,z (pack metres). `parcel` is the centuriation
   * parcel's crop there (render/pompeii.ts cropAt: 2 olive, 4 orchard), which
   * picks olive or vine in the vineyard band.
   */
  at(x: number, z: number, parcel = -1): Land {
    const crop = (): Land => Land.Fields;
    const sh = this.shore(x, z);
    if (sh.w > 0.5) {
      if (sh.s < 0) return Land.Sea;
      if (this.sub.cliff) {
        // The beach runs to the cliff foot; above it is the terrace and the town.
        if (sh.s < 26) return Land.Beach;
      } else {
        if (sh.s < 40) return Land.Beach;
        if (sh.s < 170) return Land.Dunes;
      }
    }
    const n = this.n, C = LandGrid.CELL, H = LandGrid.HALF;
    const i = Math.floor((x + H) / C), j = Math.floor((z + H) / C);
    if (i < 0 || j < 0 || i >= n || j >= n) return crop();
    const k = j * n + i;
    if (this.dRiver[k] < 80) {
      const rv = riverAt(this.sub.river, x, z);
      if (rv.d < rv.halfW) return Land.River;
      if (rv.d < rv.halfW + 35) return Land.Banks;
    }
    if (this.inside[k]) return Land.Town;
    if (!this.gradient) return crop();
    const dR = this.dRoad[k], dT = this.dTomb[k], dW = this.dWall[k], dF = this.dFarm[k];
    if (dR < 4) return Land.Road;
    // Organic edges: each zone boundary moves by up to +-70 m on a 160 m noise.
    const j1 = (vnoise(x / 160, z / 160) - 0.5) * 140;
    if (dT < 38) return Land.Tombs;
    if (dT < 165 || dW < 150 + j1 || (dR < 40 && dW < 700 + j1)) return Land.Suburb;
    if (dW < 520 + j1 * 2 || dT < 330 + j1) return Land.Garden;
    if (dF < 170) return Land.Vineyard;
    if (dW < 1700 + j1 * 3) return parcel === 2 || parcel === 4 ? Land.Olive : Land.Vineyard;
    return crop();
  }
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, 11), b = hash(xi + 1, yi, 11), c = hash(xi, yi + 1, 11), d = hash(xi + 1, yi + 1, 11);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Two-pass 3-4 chamfer distance, metres, into Uint16. */
function chamfer(d: Float32Array, n: number, C: number): Uint16Array {
  const a = C, b = C * Math.SQRT2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a);
    if (j > 0) {
      v = Math.min(v, d[k - n] + a);
      if (i > 0) v = Math.min(v, d[k - n - 1] + b);
      if (i < n - 1) v = Math.min(v, d[k - n + 1] + b);
    }
    d[k] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = j * n + i;
    let v = d[k];
    if (i < n - 1) v = Math.min(v, d[k + 1] + a);
    if (j < n - 1) {
      v = Math.min(v, d[k + n] + a);
      if (i < n - 1) v = Math.min(v, d[k + n + 1] + b);
      if (i > 0) v = Math.min(v, d[k + n - 1] + b);
    }
    d[k] = v;
  }
  const out = new Uint16Array(n * n);
  for (let k = 0; k < n * n; k++) out[k] = Math.min(65535, Math.round(d[k]));
  return out;
}

/**
 * The ground the 79 AD coast and river leave, from today's DEM height `g` at
 * x,z: the plain run down to a beach and dunes along the old shore and the
 * sea floor beyond it; the Sarno's channel cut below its water with low banks.
 * Returns g where neither applies.
 */
/**
 * The lowest dry ground the coast edit leaves: with no landcover pack, the
 * terrain shader takes ground under 3.5 m for water (render/terrain.ts,
 * byElevation), and the plain behind the old shore and today's Sarno flats
 * are lower than that in the DEM. The 79 AD surface lies a few metres under
 * the eruption's deposits anyway, so this is a rendering floor, not a survey.
 */
export const LAND_MIN = 4.2;

export function coastGround(sub: PompeiiSuburbs, x: number, z: number, g: number): number {
  let h = g;
  const sh = shoreAt(sub.shore, x, z);
  if (sh.w > 0) {
    const s = sh.s;
    let p: number;
    if (s < 0) p = Math.min(g, Math.max(-14, -0.5 + s * 0.012));
    // The swash zone is short: the terrain shades anything under 3.5 m as
    // water (LAND_MIN), so the dry beach is the shelf above it.
    else if (s < 12) p = 0.2 + (s / 12) * 3.4;
    else if (s < 40) p = 3.6 + ((s - 12) / 28) * 0.4;
    else if (s < 170) {
      // Dunes: a ridge or two a few metres high, broken by hollows.
      const t = (s - 40) / 130;
      const ridge = Math.sin(t * Math.PI) * (2.6 + 1.6 * vnoise(z / 90, x / 90));
      p = LAND_MIN - 0.4 + ridge + 0.6 * (vnoise(x / 35, z / 35) - 0.5);
    } else if (s < 900) {
      const t = (s - 170) / 730;
      const e = t * t * (3 - 2 * t);
      p = Math.max(LAND_MIN, LAND_MIN + (g - LAND_MIN) * e);
    } else p = Math.max(g, LAND_MIN);
    h = g + (p - g) * sh.w;
  }
  const rv = riverAt(sub.river, x, z);
  const reach = rv.halfW + 45;
  // Not out at sea: the banks there would rise as a spit off the mouth.
  if (rv.d < reach && (sh.s > 0 || sh.w < 0.5)) {
    const bed = rv.level - 1.6;
    if (rv.d < rv.halfW) {
      const q = rv.d / rv.halfW;
      h = Math.min(h, bed + q * q * 1.3);
    } else {
      // The bank: from just above the water up to the plain, never below the water's edge.
      const t = (rv.d - rv.halfW) / 45;
      const e = t * t * (3 - 2 * t);
      const bank = rv.level + 0.5 + (h - rv.level - 0.5) * e;
      h = Math.max(rv.level + 0.35, LAND_MIN, Math.min(h, bank));
    }
  }
  return h;
}

/**
 * Edit the DEM fields in place to the 79 AD coast and river (coastGround),
 * the way restoreVesuvius puts the old cone back: every consumer of the
 * terrain (the meshes, the water, the walker, the trees' dry test) then sees
 * one ground. Returns the cells changed.
 */
export function restoreCoast79(
  fields: { bbox: { west: number; east: number; south: number; north: number }; w: number; h: number; data: Float32Array }[],
  sub: PompeiiSuburbs, lat0: number, lon0: number,
): number {
  const p = (lat0 * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
  // Only round the old shore and river: beyond this box nothing changes.
  const X0 = -6000, X1 = 4000, Z0 = -2500, Z1 = 6200;
  let changed = 0;
  for (const f of fields) {
    const { west, east, south, north } = f.bbox;
    for (let j = 0; j < f.h; j++) {
      const lat = north - ((north - south) * j) / (f.h - 1);
      const z = (lat0 - lat) * mLat;
      if (z < Z0 || z > Z1) continue;
      for (let i = 0; i < f.w; i++) {
        const x = (west + ((east - west) * i) / (f.w - 1) - lon0) * mLon;
        if (x < X0 || x > X1) continue;
        const k = j * f.w + i;
        const h = coastGround(sub, x, z, f.data[k]);
        if (h !== f.data[k]) { f.data[k] = h; changed++; }
      }
    }
  }
  return changed;
}
