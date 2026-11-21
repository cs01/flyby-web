// Where Pompeii's oil lamps burned on a night in 79 AD, and when each one was
// put out. Pure (no DOM, no THREE), so test/pompeiilamps.check.ts runs it.
//
// There was no street lighting. Light came from the lamps people kept: a
// terracotta lucerna on a shop counter or in the lararium niche, a bronze
// lamp hung in a doorway or a tavern front, tall bronze candelabra in the
// atria of the rich, a few in the Forum's colonnade. Shops closed early,
// households went to bed soon after, and the taverns stayed open last.

import { pointInRing, ringArea, ringCentroid, type PompeiiData } from "./pompeii";

/** Where the lamps can go, as the town was built (render/pompeiimesh.ts). Local metres. */
export interface LampSites {
  /** x,z the middle of the opening on the facade line, o outward, e along it, g the floor. */
  openings: { x: number; z: number; g: number; ox: number; oz: number; ex: number; ez: number; w: number; h: number; depth: number; kind: "shop" | "door"; counter: boolean }[];
  /** A court's 4-corner ring and floor: an atrium's light well or a peristyle garden. */
  courts: { ring: number[]; g: number; garden: boolean }[];
}

export const enum LampKind {
  /** Terracotta lucerna: one nozzle, ring handle, a sunk discus with a filling hole. */
  Lucerna = 0,
  /** Bronze lamp of two nozzles on three chains from a hook. */
  Hanging = 1,
  /** Bronze candelabrum: lion-paw tripod, fluted shaft, a disc on top with its lamp. */
  Candelabrum = 2,
  /** A bronze youth on a plinth holding up a lamp tray (the lampadophoros). */
  Lampbearer = 3,
  /** A lararium: the painted shrine's shelf on the wall with a small lamp on it. */
  Lararium = 4,
}
export const LAMP_KINDS = 5;

export type LampRole = "shop" | "tavern" | "doorway" | "lararium" | "atrium" | "peristyle" | "forum";

export interface Lamp {
  kind: LampKind;
  role: LampRole;
  /** The fitting's foot (stand, plinth, shelf, lamp base) or a hanging lamp's hook, local metres. */
  x: number;
  y: number;
  z: number;
  /** Which way the nozzles point, radians about +y (0 toward +x). */
  yaw: number;
  /** Which way the fitting's open side is (the street, the court's middle), radians like yaw. */
  face: number;
  /** Lit nozzles: each is a flame. */
  nozzles: number;
  /** Light per nozzle, in the town shader's lamp units. */
  power: number;
  /** Local hour it is put out; past 24 is after midnight. */
  outH: number;
  /** 0..1, for flicker phase and the order lamps are lit at dusk. */
  seed: number;
  /** In a named house (rich), for the stands and the gate. */
  rich: boolean;
}

/** Flame positions in the fitting's own frame (+x along yaw, y up), metres. */
export function flameOffsets(kind: LampKind, nozzles: number): [number, number, number][] {
  switch (kind) {
    case LampKind.Lucerna: return nozzles > 1 ? [[0.088, 0.046, -0.025], [0.088, 0.046, 0.025]] : [[0.088, 0.046, 0]];
    // Hook at the origin; the lamp hangs 0.72 m below on its chains.
    case LampKind.Hanging: return [[0.11, -0.68, 0], [-0.11, -0.68, 0]].slice(0, Math.max(1, nozzles)) as [number, number, number][];
    case LampKind.Candelabrum: return [[0.088, 1.424, 0]];
    case LampKind.Lampbearer: return [[0.248, 1.993, -0.39], [0.248, 1.993, -0.49]].slice(0, Math.max(1, nozzles)) as [number, number, number][];
    case LampKind.Lararium: return [[0.068, 0.046, 0]];
  }
}

/** Local hour of the scene, 0..24, to the shifted hour lampLevel reads: noon to noon. */
export function nightHour(h: number): number {
  const m = ((h % 24) + 24) % 24;
  return m < 12 ? m + 24 : m;
}

/**
 * 0..1, how lit a lamp is: lit one by one as the dark comes on (`night`, the
 * scene's 0..1 darkness), out at its own hour, all out by dawn.
 */
export function lampLevel(l: Lamp, hour: number, night: number): number {
  const on = clamp01((night - (0.25 + 0.45 * l.seed)) / 0.12);
  const out = 1 - clamp01((nightHour(hour) - l.outH) / 0.15);
  return on * out;
}

/** Flicker 0.8..1.0: two octaves of value noise, so a flame wavers rather than pulses. */
export function flicker(t: number, seed: number): number {
  return 0.8 + 0.2 * (0.65 * vnoise1(t * 7.0 + seed * 113) + 0.35 * vnoise1(t * 17.0 + seed * 71));
}

/** A flame's sideways wander, metres, each axis within +-FLAME_JITTER_M. */
export const FLAME_JITTER_M = 0.006;
export function jitter(t: number, seed: number, axis: number): number {
  return FLAME_JITTER_M * (2 * vnoise1(t * 5.0 + seed * 37 + axis * 19) - 1);
}

export interface PlaceOptions {
  /** Ground height at a local point (for the Forum, which has no built floor). */
  groundAt: (x: number, z: number) => number;
  /** Probe: every lamp a plain lucerna, for the gate's vacuity check. */
  plain?: boolean;
}

/**
 * Where the lampbearer stood: the bronze Apollo lampadophoros found in 1977
 * in the House of Julius Polybius (IX.13), on Via dell'Abbondanza. The pack's
 * outline for that house spans four blocks and the builder leaves it to the
 * rules, so the statue goes in the atrium nearest the house's door, here.
 * (The ephebe lampbearer's own house, I.7.11, is not in the pack.)
 */
export const LAMPBEARER_AT: [number, number] = [200, -226];

/** Every lamp in the town, by the rules in the file comment. Deterministic. */
export function placeLamps(data: PompeiiData, sites: LampSites, opts: PlaceOptions): Lamp[] {
  const lamps: Lamp[] = [];
  const plain = !!opts.plain;
  // Named houses: the rich. Their rings, with a quick box test in front.
  const named = data.domus.map((d) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < d.ring.length; i += 2) { x0 = Math.min(x0, d.ring[i]); x1 = Math.max(x1, d.ring[i]); z0 = Math.min(z0, d.ring[i + 1]); z1 = Math.max(z1, d.ring[i + 1]); }
    // Polybius's outline crosses streets: not a house to test points against.
    const area = Math.abs(ringArea(d.ring));
    return { name: d.name, ring: d.ring, x0, x1, z0, z1, ok: area < 4000 };
  }).filter((h) => h.ok);
  const houseOf = (x: number, z: number): string | null => {
    for (const h of named) if (x >= h.x0 - 3 && x <= h.x1 + 3 && z >= h.z0 - 3 && z <= h.z1 + 3 && pointInRing(h.ring, x, z)) return h.name;
    return null;
  };
  // On a main street: the same test the builder uses for its shopfronts.
  const mains = data.streets.filter((s) => s.main);
  const onMain = (x: number, z: number): boolean => mains.some((s) => distToPolyline(s.pts, x, z) < s.carriageM / 2 + s.sidewalkM + 2.5);
  const tavernName = (n: string | null): boolean => !!n && /caupona|thermopol|lupanar|popina|hospitium/i.test(n);
  const push = (p: Omit<Lamp, "face"> & { face?: number }): void => {
    const l: Lamp = { ...p, face: p.face ?? p.yaw };
    lamps.push(plain ? { ...l, kind: LampKind.Lucerna, nozzles: 1 } : l);
  };

  sites.openings.forEach((o, i) => {
    const r = hash(i, 11), r2 = hash(i, 12), r3 = hash(i, 13);
    const yawOut = Math.atan2(o.oz, o.ox);
    // 1.5 m in from the facade: whose premises this opening belongs to.
    const owner = houseOf(o.x - o.ox * 1.5, o.z - o.oz * 1.5);
    if (o.kind === "shop") {
      // A shop in a named caupona is a tavern; so are about one in seven of
      // the rest on the main streets, the thermopolia and popinae that lined
      // them, and fewer down the side streets, where most shops shut at dusk.
      const main = onMain(o.x, o.z);
      const tavern = tavernName(owner) || r < (main ? 0.14 : 0.04);
      if (!tavern && r2 > (main ? 0.62 : 0.3)) return;
      const outH = tavern ? 24.0 + 2.5 * r3 : 21.0 + 2.0 * r3;
      const role: LampRole = tavern ? "tavern" : "shop";
      if (o.counter) {
        // On the counter's marble top, toward its middle, nozzle to the street.
        const along = 0.075 - 0.19 * o.w;
        push({ kind: LampKind.Lucerna, role, x: o.x + o.ex * along - o.ox * 0.42, y: o.g + 1.0, z: o.z + o.ez * along - o.oz * 0.42,
          yaw: yawOut + (r2 - 0.5) * 0.8, face: yawOut, nozzles: 1, power: tavern ? 1.5 : 1.0, outH, seed: hash(i, 14), rich: false });
      }
      if (tavern || !o.counter) {
        // Hung from the lintel just inside the front: what lights the street.
        const along = o.counter ? 0.22 * o.w : 0;
        push({ kind: LampKind.Hanging, role, x: o.x + o.ex * along - o.ox * 0.45, y: o.g + o.h, z: o.z + o.ez * along - o.oz * 0.45,
          yaw: Math.atan2(o.ez, o.ex), face: yawOut, nozzles: 2, power: tavern ? 1.3 : 1.0, outH: outH + 0.1, seed: hash(i, 15), rich: false });
      }
    } else {
      // A lamp hung in the doorway of a named house, and of a few others.
      const rich = owner !== null;
      if (!(rich ? r < 0.7 : r < 0.07)) return;
      push({ kind: LampKind.Hanging, role: tavernName(owner) ? "tavern" : "doorway", x: o.x - o.ox * 0.2, y: o.g + o.h, z: o.z - o.oz * 0.2,
        yaw: Math.atan2(o.ez, o.ex), face: yawOut, nozzles: rich ? 2 : 1, power: 0.9, outH: tavernName(owner) ? 24.5 + 1.5 * r3 : 21.5 + 1.5 * r3, seed: hash(i, 16), rich });
    }
  });

  // The atrium the lampbearer stands in: the one nearest his house's door.
  let bearer = -1, bd = 45;
  sites.courts.forEach((c, k) => {
    if (c.garden) return;
    const [cx, cz] = ringCentroid(c.ring);
    const d = Math.hypot(cx - LAMPBEARER_AT[0], cz - LAMPBEARER_AT[1]);
    if (d < bd) { bd = d; bearer = k; }
  });

  sites.courts.forEach((c, k) => {
    const [cx, cz] = ringCentroid(c.ring);
    const area = Math.abs(ringArea(c.ring));
    const owner = houseOf(cx, cz);
    // Rich: a named house, or an atrium big enough to be a grand one.
    const rich = owner !== null || area >= 70;
    const r = hash(k, 21), r3 = hash(k, 23);
    // A point `inset` metres in from corner q, toward the court's middle.
    const corner = (q: number, inset: number): [number, number] => {
      const x = c.ring[q * 2], z = c.ring[q * 2 + 1];
      const dx = cx - x, dz = cz - z, dl = Math.hypot(dx, dz) || 1;
      return [x + (dx / dl) * inset * 1.41, z + (dz / dl) * inset * 1.41];
    };
    if (c.garden) {
      // Two stands under the peristyle's portico, at opposite corners.
      for (const q of [0, 2]) {
        const [x, z] = corner(q, 1.6);
        push({ kind: LampKind.Candelabrum, role: "peristyle", x, y: c.g, z, yaw: Math.atan2(cz - z, cx - x), nozzles: 1, power: 1.2,
          outH: 21.8 + 1.5 * hash(k, 24 + q), seed: hash(k, 26 + q), rich: true });
      }
      return;
    }
    // The lararium on the light well's wall: nearly every house kept one lit.
    if (r < 0.8) {
      const e = Math.floor(hash(k, 22) * 4);
      const ax = c.ring[e * 2], az = c.ring[e * 2 + 1], bx = c.ring[((e + 1) % 4) * 2], bz = c.ring[((e + 1) % 4) * 2 + 1];
      let ix = cx - (ax + bx) / 2, iz = cz - (az + bz) / 2;
      const il = Math.hypot(ix, iz) || 1;
      ix /= il; iz /= il;
      const t = Math.min(0.8, Math.max(0.2, 0.5 + (hash(k, 25) - 0.5) * 0.4));
      const x = ax + (bx - ax) * t + ix * 0.16, z = az + (bz - az) * t + iz * 0.16;
      // A sliver of a court can leave the point outside it: no shrine there.
      if (pointInRing(c.ring, x, z)) push({ kind: LampKind.Lararium, role: "lararium", x, y: c.g + 1.45, z, yaw: Math.atan2(iz, ix), nozzles: 1, power: 0.55,
        outH: 21.0 + 2.0 * r3, seed: hash(k, 27), rich });
    }
    if (k === bearer) {
      const [x, z] = corner(1, 1.0);
      push({ kind: LampKind.Lampbearer, role: "atrium", x, y: c.g, z, yaw: Math.atan2(cz - z, cx - x), nozzles: 2, power: 1.3,
        outH: 23.2, seed: hash(k, 28), rich: true });
    } else if (rich) {
      const [x, z] = corner(Math.floor(hash(k, 29) * 4), 0.75);
      push({ kind: LampKind.Candelabrum, role: "atrium", x, y: c.g, z, yaw: Math.atan2(cz - z, cx - x), nozzles: 1, power: 1.2,
        outH: 21.5 + 2.0 * hash(k, 30), seed: hash(k, 31), rich: true });
    }
  });

  // The Forum's colonnade: a few stands along the long sides, a lamp at the
  // foot of a column where the porticoes were. Most of the square stays dark.
  for (const p of data.publics) {
    if (p.kind !== "forum") continue;
    const n = p.ring.length / 2;
    const [cx, cz] = ringCentroid(p.ring);
    for (let e = 0; e < n; e++) {
      const ax = p.ring[e * 2], az = p.ring[e * 2 + 1], bx = p.ring[((e + 1) % n) * 2], bz = p.ring[((e + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 60) continue;
      let ix = cx - (ax + bx) / 2, iz = cz - (az + bz) / 2;
      const il = Math.hypot(ix, iz) || 1;
      ix /= il; iz /= il;
      const m = Math.round(L / 26);
      for (let q = 1; q < m; q++) {
        const t = q / m;
        const x = ax + (bx - ax) * t + ix * 3.2, z = az + (bz - az) * t + iz * 3.2;
        push({ kind: LampKind.Candelabrum, role: "forum", x, y: opts.groundAt(x, z), z, yaw: Math.atan2(iz, ix), nozzles: 1, power: 1.4,
          outH: 21.6 + 1.0 * hash(e * 31 + q, 41), seed: hash(e * 31 + q, 42), rich: false });
      }
    }
  }
  return lamps;
}

/** Counts by role and by kind, for the console and the gate. */
export function lampCensus(lamps: Lamp[]): { byRole: Record<LampRole, number>; byKind: number[] } {
  const byRole: Record<LampRole, number> = { shop: 0, tavern: 0, doorway: 0, lararium: 0, atrium: 0, peristyle: 0, forum: 0 };
  const byKind = new Array<number>(LAMP_KINDS).fill(0);
  for (const l of lamps) { byRole[l.role]++; byKind[l.kind]++; }
  return { byRole, byKind };
}

// --- tiny deterministic helpers ---------------------------------------------

function distToPolyline(p: number[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function vnoise1(x: number): number {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i, 7) * (1 - u) + hash(i + 1, 7) * u;
}
