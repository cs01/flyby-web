// The public baths of Pompeii as rooms: the Stabian baths (VII.1.8), the
// Forum baths (VII.5) and the Central baths (IX.4), each laid out inside its
// surveyed footprint from the excavation plans. Read by render/pompeiiwater.ts,
// which builds them, and by test/pompeiiwater.check.ts.
//
// A plan is written in metres in the footprint's own frame: `e` toward the
// street the bath block backs onto (Via Stabiana, Via del Foro), `n` along it
// toward Vesuvius. The OSM ring's corners are not square to anything, so the
// frame comes from that street rather than from the ring, and the gate holds
// every room inside the ring as surveyed.
//
// The sequence is the Roman one: apodyterium (undress, the clothes niches),
// frigidarium (the round cold plunge under a cone with an oculus), tepidarium,
// caldarium (the hot pool, alveus, at one end and the labrum, a marble basin
// with a jet, in the apse at the other), the furnace between the men's and the
// women's caldaria, and at the Stabian baths the palaestra with its swimming
// pool. The heated rooms stand on a hypocaust: their floor is half a metre up
// on brick piers, which shows as the step at their doors.
//
// The Central baths were still being built in 79 AD: their pools are dry.
//
// Pure (no DOM, no THREE).

import { pointInRing, type PompeiiData, type Ring } from "./pompeii";

export type RoomKind =
  | "apodyterium" | "frigidarium" | "tepidarium" | "caldarium" | "laconicum"
  | "praefurnium" | "destrictarium" | "service";
export type Section = "men" | "women" | "common";
/** A side of a rectangular room: its low-e, high-e, low-n or high-n wall. */
export type Side = "e0" | "e1" | "n0" | "n1";

/** The inside of the room's walls, metres in the plan frame. */
export interface RoomPlan {
  id: string;
  kind: RoomKind;
  section: Section;
  /** e0, e1, n0, n1. Round rooms have `round` instead. */
  rect?: [number, number, number, number];
  round?: { e: number; n: number; r: number };
  /** Floor above the bath's ground level: 0.5 on a hypocaust. */
  floor: number;
  /** Springline of the vault above the floor. */
  spring: number;
  /** A half-round apse off one side: the caldarium's labrum stands in it. */
  apse?: { side: Side; r: number };
  /** Open to the sky in the crown (frigidarium), radius m. */
  oculus?: number;
  /** Sides with a window in the lunette or high in the wall. */
  windows?: Side[];
  /** Niches for clothes on the walls and a bench (apodyteria). */
  niches?: boolean;
}

export type PoolKind = "alveus" | "frigida" | "natatio" | "plunge" | "basin";
export interface PoolPlan {
  id: string;
  kind: PoolKind;
  /** The room it is in, or "" for the open court. */
  room: string;
  /** Inside of the rim. */
  rect?: [number, number, number, number];
  round?: { e: number; n: number; r: number };
  /** Above the bath's ground level: rim top, water, pool floor. */
  rim: number;
  water: number;
  bottom: number;
  hot: boolean;
}

export interface LabrumPlan { room: string; e: number; n: number; r: number; rim: number; jet: number }
/** A doorway in a wall: at (e,n), `axis` the direction one walks through it. */
export interface DoorPlan { e: number; n: number; axis: "e" | "n"; w: number; h: number }
/** Columns from a to b with a lean-to roof back to the wall `depth` away on `toward` (+1 left of a->b, -1 right). */
export interface PorticoPlan { a: [number, number]; b: [number, number]; depth: number; toward: 1 | -1; h: number; spacing: number }

export interface BathPlan {
  /** As OSM names the footprint (data/pompeii.ts publics). */
  name: string;
  /** Display name and the address. */
  title: string;
  /** The street the bath block backs onto: the plan frame's +e. */
  street: string;
  /** Still being built in 79 AD: no water, no fires, no lamps. */
  dry?: boolean;
  rooms: RoomPlan[];
  pools: PoolPlan[];
  labra: LabrumPlan[];
  doors: DoorPlan[];
  porticos: PorticoPlan[];
  /** The palaestra's open court, for the shots and the gate. */
  court?: [number, number, number, number];
}

const HOT = 0.5; // hypocaust floor height

export const BATH_PLANS: BathPlan[] = [
  {
    // Stabian baths: palaestra in the middle, swimming pool on its west
    // side, the bath block along Via Stabiana with the men's rooms to the
    // south (entered off the palaestra) and the women's to the north, the
    // two caldaria back to back on one furnace.
    name: "Terme Stabiane",
    title: "Stabian baths (VII.1.8)",
    street: "Via Stabiana",
    court: [-12, 8, -16, 11],
    rooms: [
      { id: "m-apo", kind: "apodyterium", section: "men", rect: [15, 31, -21, -12.4], floor: 0.05, spring: 3.4, windows: ["e1"], niches: true },
      { id: "m-frig", kind: "frigidarium", section: "men", round: { e: 11.5, n: -16, r: 2.9 }, floor: 0.05, spring: 2.6, oculus: 0.5 },
      { id: "m-tep", kind: "tepidarium", section: "men", rect: [15, 31, -11.8, -4.8], floor: HOT, spring: 3.0, windows: ["e0"] },
      { id: "m-cal", kind: "caldarium", section: "men", rect: [15, 31, -4.2, 3.6], floor: HOT, spring: 3.2, apse: { side: "e0", r: 2.3 }, windows: ["e1"] },
      { id: "furnace", kind: "praefurnium", section: "common", rect: [15, 31, 4.2, 7.2], floor: 0.05, spring: 2.6 },
      { id: "w-cal", kind: "caldarium", section: "women", rect: [15, 31, 7.8, 14.6], floor: HOT, spring: 3.0, windows: ["e0"] },
      { id: "w-tep", kind: "tepidarium", section: "women", rect: [12.6, 22.4, 15.2, 23.4], floor: HOT, spring: 2.8 },
      { id: "w-apo", kind: "apodyterium", section: "women", rect: [0.6, 12, 15.2, 24.6], floor: 0.05, spring: 3.0, windows: ["n1"], niches: true },
      { id: "dest-s", kind: "destrictarium", section: "common", rect: [-16.6, -12.6, -15.4, -11.4], floor: 0.05, spring: 2.6 },
      { id: "dest-n", kind: "destrictarium", section: "common", rect: [-18.6, -12.6, 6.6, 12], floor: 0.05, spring: 2.6 },
      { id: "latrine", kind: "service", section: "common", rect: [-14, 0, 15.2, 23], floor: 0.05, spring: 2.6 },
    ],
    pools: [
      { id: "m-frig-pool", kind: "frigida", room: "m-frig", round: { e: 11.5, n: -16, r: 2.1 }, rim: 0.35, water: 0.2, bottom: -1.1, hot: false },
      { id: "m-alveus", kind: "alveus", room: "m-cal", rect: [27.2, 30.7, -3.9, 3.3], rim: HOT + 0.5, water: HOT + 0.38, bottom: 0.08, hot: true },
      { id: "w-alveus", kind: "alveus", room: "w-cal", rect: [27.4, 30.7, 8.1, 14.3], rim: HOT + 0.5, water: HOT + 0.38, bottom: 0.08, hot: true },
      { id: "w-plunge", kind: "plunge", room: "w-apo", rect: [1, 4.4, 20.6, 24.2], rim: 0.4, water: 0.25, bottom: -0.9, hot: false },
      { id: "natatio", kind: "natatio", room: "", rect: [-21, -14.6, -9.6, 4.4], rim: 0.25, water: 0.1, bottom: -1.4, hot: false },
    ],
    labra: [
      { room: "m-cal", e: 14.1, n: -0.3, r: 0.95, rim: HOT + 1.0, jet: 0.32 },
      { room: "w-cal", e: 16.4, n: 11.2, r: 0.75, rim: HOT + 0.95, jet: 0.25 },
    ],
    doors: [
      // Men: palaestra portico -> apodyterium -> frigidarium, tepidarium -> caldarium.
      { e: 15, n: -14, axis: "e", w: 1.4, h: 2.6 },
      { e: 14.6, n: -16, axis: "e", w: 1.1, h: 2.3 },
      { e: 27, n: -12.1, axis: "n", w: 1.2, h: 2.4 },
      { e: 20, n: -4.5, axis: "n", w: 1.2, h: 2.4 },
      // Via Stabiana entrance into the men's apodyterium.
      { e: 31, n: -17, axis: "e", w: 1.6, h: 2.8 },
      // Women: Via Stabiana side door, apodyterium -> tepidarium -> caldarium.
      { e: 6, n: 24.6, axis: "n", w: 1.4, h: 2.6 },
      { e: 12.3, n: 19, axis: "e", w: 1.1, h: 2.3 },
      { e: 20, n: 14.9, axis: "n", w: 1.1, h: 2.3 },
      // The furnace is stoked from the palaestra side.
      { e: 15, n: 5.7, axis: "e", w: 1.0, h: 2.0 },
      // Destrictaria open onto the pool walk; the latrine onto the north portico.
      { e: -12.6, n: -13.7, axis: "e", w: 1.4, h: 2.4 },
      { e: -12.6, n: 9.3, axis: "e", w: 1.6, h: 2.4 },
      { e: -7, n: 15.2, axis: "n", w: 1.2, h: 2.3 },
    ],
    porticos: [
      // East portico in front of the men's baths, north portico, and the
      // short south one along Via dell'Abbondanza.
      { a: [8, -16], b: [8, 11], depth: 7, toward: -1, h: 4.6, spacing: 2.7 },
      { a: [-12, 11], b: [8, 11], depth: 4.2, toward: 1, h: 4.6, spacing: 2.7 },
    ],
  },
  {
    // Forum baths, the men's block as the survey outlines it: apodyterium
    // with its bench and niches along Via delle Terme, the round frigidarium
    // off its corner, the tepidarium (the telamones), and the caldarium with
    // its labrum in the apse.
    name: "Terme del Foro",
    title: "Forum baths (VII.5)",
    street: "Via del Foro",
    rooms: [
      { id: "m-apo", kind: "apodyterium", section: "men", rect: [-10, 8.6, -5.4, 0.8], floor: 0.05, spring: 3.4, windows: ["e0"], niches: true },
      { id: "m-frig", kind: "frigidarium", section: "men", round: { e: -6, n: 4.4, r: 2.6 }, floor: 0.05, spring: 2.5, oculus: 0.45 },
      { id: "m-tep", kind: "tepidarium", section: "men", rect: [-1.2, 8.6, 1.4, 8.6], floor: HOT, spring: 3.2, windows: ["e1"] },
      { id: "m-cal", kind: "caldarium", section: "men", rect: [-7, 10.6, 9.2, 16.4], floor: HOT, spring: 3.4, apse: { side: "e0", r: 2.0 }, windows: ["n1"] },
      { id: "west", kind: "service", section: "common", rect: [-9.6, -5.8, -18.6, -6], floor: 0.05, spring: 2.6 },
    ],
    pools: [
      { id: "m-frig-pool", kind: "frigida", room: "m-frig", round: { e: -6, n: 4.4, r: 1.9 }, rim: 0.35, water: 0.2, bottom: -1.0, hot: false },
      { id: "m-alveus", kind: "alveus", room: "m-cal", rect: [6.8, 10.3, 9.5, 16.1], rim: HOT + 0.5, water: HOT + 0.38, bottom: 0.08, hot: true },
    ],
    labra: [{ room: "m-cal", e: -7.8, n: 12.8, r: 0.85, rim: HOT + 1.05, jet: 0.3 }],
    doors: [
      { e: -2, n: -5.4, axis: "n", w: 1.4, h: 2.7 },
      { e: -6, n: 1.5, axis: "n", w: 1.1, h: 2.3 },
      { e: 4, n: 1.1, axis: "n", w: 1.2, h: 2.4 },
      { e: 4, n: 8.9, axis: "n", w: 1.2, h: 2.4 },
      { e: -8, n: -5.7, axis: "n", w: 1.1, h: 2.4 },
    ],
    porticos: [],
  },
  {
    // Central baths: a new, larger palaestra and a row of big-windowed
    // rooms along Via Stabiana, with a round sweating room. Unfinished at
    // the eruption: the pipes were not laid and the pools were never filled.
    name: "Terme centrali di Pompei",
    title: "Central baths (IX.4), unfinished",
    street: "Via Stabiana",
    dry: true,
    court: [-33, 8, -20, 26],
    rooms: [
      { id: "apo", kind: "apodyterium", section: "common", rect: [10, 25.4, -14, -4.4], floor: 0.05, spring: 3.6, windows: ["e0"], niches: true },
      { id: "tep", kind: "tepidarium", section: "common", rect: [10, 25.4, -3.8, 4.4], floor: HOT, spring: 3.6, windows: ["e0"] },
      { id: "cal", kind: "caldarium", section: "common", rect: [10, 25.4, 5, 16.6], floor: HOT, spring: 3.8, apse: { side: "e0", r: 2.6 }, windows: ["e0", "n1"] },
      { id: "lac", kind: "laconicum", section: "common", round: { e: 16, n: 22.5, r: 3.2 }, floor: HOT, spring: 2.8, oculus: 0.4 },
    ],
    pools: [
      { id: "alveus", kind: "alveus", room: "cal", rect: [21.6, 25.1, 5.3, 16.3], rim: HOT + 0.5, water: HOT + 0.38, bottom: 0.08, hot: true },
      { id: "natatio", kind: "natatio", room: "", rect: [-30, -19, -10, 8], rim: 0.25, water: 0.1, bottom: -1.3, hot: false },
    ],
    labra: [],
    doors: [
      { e: 10, n: -9, axis: "e", w: 1.6, h: 2.8 },
      { e: 18, n: -4.1, axis: "n", w: 1.4, h: 2.6 },
      { e: 18, n: 4.7, axis: "n", w: 1.4, h: 2.6 },
      { e: 16, n: 17.5, axis: "n", w: 1.2, h: 2.4 },
    ],
    porticos: [{ a: [8, -20], b: [8, 26], depth: 2, toward: -1, h: 4.8, spacing: 3 }],
  },
];

// --- the plan frame --------------------------------------------------------------

export interface BathFrame {
  /** Origin: the mean of the footprint's corners. */
  cx: number; cz: number;
  /** +e and +n as unit x,z vectors. */
  ex: number; ez: number; nx: number; nz: number;
}

export function toWorld(f: BathFrame, e: number, n: number): [number, number] {
  return [f.cx + e * f.ex + n * f.nx, f.cz + e * f.ez + n * f.nz];
}

/**
 * +e toward the nearest point of the plan's street, +n square to it and
 * toward the mountain (-z). Null when the street is missing from the pack.
 */
export function bathFrame(data: PompeiiData, ring: Ring, street: string): BathFrame | null {
  const n = ring.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[i * 2]; cz += ring[i * 2 + 1]; }
  cx /= n; cz /= n;
  let best: [number, number] | null = null, bd = Infinity;
  for (const s of data.streets) {
    if (s.name !== street) continue;
    for (let i = 2; i < s.pts.length; i += 2) {
      const ax = s.pts[i - 2], az = s.pts[i - 1], dx = s.pts[i] - ax, dz = s.pts[i + 1] - az;
      const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / (dx * dx + dz * dz || 1)));
      const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - cx, pz - cz);
      if (d < bd) { bd = d; best = [px, pz]; }
    }
  }
  if (!best || bd > 80) return null;
  const ex = (best[0] - cx) / bd, ez = (best[1] - cz) / bd;
  let nx = ez, nz = -ex;
  if (nz > 0) { nx = -nx; nz = -nz; }
  return { cx, cz, ex, ez, nx, nz };
}

// --- laid out ------------------------------------------------------------------

export interface BathSite {
  plan: BathPlan;
  frame: BathFrame;
  /** The footprint as surveyed. */
  ring: Ring;
  /** Ground floor level, world y: the court's pavement. */
  g: number;
  /** Each room's (and each court pool's) own ground level by id, where the builder terraces; else g. */
  levels?: Record<string, number>;
}

/** Steam over a hot pool or a labrum, world metres. */
export interface SteamSource { x: number; y: number; z: number; /** half-size of the area it rises from */ hu: number; hv: number; /** along e as x,z */ ux: number; uz: number; rate: number }
/** A hanging lamp or a wall lamp in a room, world metres. */
export interface BathLamp { x: number; y: number; z: number; hanging: boolean; yaw: number }

export function hasBathPlan(name: string): boolean {
  return BATH_PLANS.some((p) => p.name === name);
}

/** Corners (world x,z) a room's walls take, round rooms as a 16-gon, apses included. */
export function roomOutline(f: BathFrame, r: RoomPlan, seg = 16): number[] {
  const out: number[] = [];
  if (r.round) {
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      out.push(...toWorld(f, r.round.e + Math.cos(a) * r.round.r, r.round.n + Math.sin(a) * r.round.r));
    }
    return out;
  }
  const [e0, e1, n0, n1] = r.rect!;
  for (const [e, n] of [[e0, n0], [e1, n0], [e1, n1], [e0, n1]]) out.push(...toWorld(f, e, n));
  if (r.apse) {
    const c = apseCentre(r);
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * Math.PI;
      const [de, dn] = apseOffset(r.apse.side, a, r.apse.r);
      out.push(...toWorld(f, c[0] + de, c[1] + dn));
    }
  }
  return out;
}

/** The middle of the side the apse opens off. */
export function apseCentre(r: RoomPlan): [number, number] {
  const [e0, e1, n0, n1] = r.rect!;
  switch (r.apse!.side) {
    case "e0": return [e0, (n0 + n1) / 2];
    case "e1": return [e1, (n0 + n1) / 2];
    case "n0": return [(e0 + e1) / 2, n0];
    default: return [(e0 + e1) / 2, n1];
  }
}

/** A point on the apse's curve, a in 0..pi from one jamb to the other, as (de, dn). */
export function apseOffset(side: Side, a: number, r: number): [number, number] {
  const s = Math.sin(a) * r, c = Math.cos(a) * r;
  switch (side) {
    case "e0": return [-s, c];
    case "e1": return [s, -c];
    case "n0": return [-c, -s];
    default: return [c, s];
  }
}

/** Where the heat goes: steam over each hot pool and labrum (not at a dry bath). */
export function steamSources(site: BathSite): SteamSource[] {
  const { plan, frame: f } = site;
  const lv = (id: string): number => site.levels?.[id] ?? site.g;
  if (plan.dry) return [];
  const out: SteamSource[] = [];
  for (const p of plan.pools) {
    if (!p.hot || !p.rect) continue;
    const [e0, e1, n0, n1] = p.rect;
    const [x, z] = toWorld(f, (e0 + e1) / 2, (n0 + n1) / 2);
    out.push({ x, y: lv(p.room) + p.water, z, hu: (e1 - e0) / 2, hv: (n1 - n0) / 2, ux: f.ex, uz: f.ez, rate: 1 });
  }
  for (const l of plan.labra) {
    const [x, z] = toWorld(f, l.e, l.n);
    out.push({ x, y: lv(l.room) + l.rim, z, hu: l.r * 0.6, hv: l.r * 0.6, ux: f.ex, uz: f.ez, rate: 0.25 });
  }
  return out;
}

/**
 * Lamps: the Forum baths alone gave up over a thousand lucernae, so the
 * rooms were lit into the evening. A hanging lamp in the middle of each room
 * and lamps on the walls of the bigger ones, none at a dry bath.
 */
export function bathLamps(site: BathSite): BathLamp[] {
  const { plan, frame: f } = site;
  const lv = (id: string): number => site.levels?.[id] ?? site.g;
  if (plan.dry) return [];
  const out: BathLamp[] = [];
  const yawE = Math.atan2(f.ez, f.ex);
  for (const r of plan.rooms) {
    if (r.kind === "service" || r.kind === "praefurnium") continue;
    if (r.round) {
      // The frigidarium's lamps stand in two of its niches.
      for (const a of [Math.PI * 0.25, Math.PI * 1.25]) {
        const [x, z] = toWorld(f, r.round.e + Math.cos(a) * (r.round.r - 0.25), r.round.n + Math.sin(a) * (r.round.r - 0.25));
        out.push({ x, y: lv(r.id) + r.floor + 1.5, z, hanging: false, yaw: yawE + a + Math.PI });
      }
      continue;
    }
    const [e0, e1, n0, n1] = r.rect!;
    const L = e1 - e0;
    const k = L > 12 ? 2 : 1;
    for (let i = 0; i < k; i++) {
      const [x, z] = toWorld(f, e0 + (L * (i + 0.5)) / k, (n0 + n1) / 2);
      out.push({ x, y: lv(r.id) + r.floor + r.spring + 0.2, z, hanging: true, yaw: yawE });
    }
    if (r.niches) {
      for (const t of [0.25, 0.75]) {
        const [x, z] = toWorld(f, e0 + L * t, n0 + 0.2);
        out.push({ x, y: lv(r.id) + r.floor + 1.6, z, hanging: false, yaw: yawE + Math.PI / 2 });
      }
    }
  }
  return out;
}

/** Every bath with a plan whose street is in the pack. `g` is the builder's floor level for each. */
export function bathSites(data: PompeiiData, floors: Map<string, { ring: Ring; g: number }>): BathSite[] {
  const out: BathSite[] = [];
  for (const plan of BATH_PLANS) {
    const at = floors.get(plan.name);
    if (!at) continue;
    const frame = bathFrame(data, at.ring, plan.street);
    if (!frame) continue;
    out.push({ plan, frame, ring: at.ring, g: at.g });
  }
  return out;
}

/** Plan points of the room that fall outside the surveyed footprint (the gate wants none). */
export function roomsOutside(site: BathSite): string[] {
  const bad: string[] = [];
  for (const r of site.plan.rooms) {
    const o = roomOutline(site.frame, r);
    for (let i = 0; i < o.length; i += 2) {
      if (!pointInRing(site.ring, o[i], o[i + 1])) { bad.push(r.id); break; }
    }
  }
  return bad;
}
