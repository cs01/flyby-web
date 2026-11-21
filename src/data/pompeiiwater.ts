// Pompeii's running water, as placed: the street fountains with their carved
// spout heads, the water towers (castella secondaria) that fed them, the
// Castellum Aquae by Porta Vesuvio where the Serino aqueduct came in, and the
// atrium pools. render/pompeiimesh.ts records where the fountains and pools
// are (WaterSites); this decides what each one is; render/pompeiiwater.ts
// draws them; test/pompeiiwater.check.ts holds them to the excavation.
//
// The water came in at the town's high point, the castellum, split three
// ways, and ran down lead pipes to about a dozen towers on the street
// corners: a pillar 6 m high with a lead tank on top, so the pressure in
// the pipes below it was only that head. Each tower fed the fountains and
// houses round it. The fountains ran day and night and overflowed into the
// street, which is why the streets have stepping stones.
//
// Pure (no DOM, no THREE).

import { pointInRing, type PompeiiData, type Ring } from "./pompeii";

/** What render/pompeiimesh.ts records for render/pompeiiwater.ts to build. */
export interface WaterSites {
  /** Fountain middle on the carriageway edge, the ground there, and +u (toward the junction) as an angle. */
  fountains: { x: number; z: number; g: number; ang: number }[];
  /** Atrium pools: the water's ring (4 corners), its level, the court floor, and the compluvium above. */
  impluvia: { ring: number[]; water: number; floor: number; open: { cx: number; cz: number; y: number; r: number } }[];
  /** The baths data/pompeiibaths.ts has plans for, with the builder's floor level. */
  baths: { name: string; ring: Ring; g: number }[];
}

/** The spout head carved on the fountain's upright: the four the town has most of. */
export const enum Head { Lion = 0, Mercury = 1, Medusa = 2, Cockerel = 3 }
export const HEADS = 4;

// --- the fountain's own dimensions, in its frame (u toward the street, w along the kerb) ---
/** Basin outer half-sizes, slab thickness, rim height over the street: four lava slabs. */
export const BASIN = { hu: 0.75, hw: 1.05, slab: 0.18, rim: 0.85 } as const;
/** Water stands this far under the rim: the overflow notch is cut that deep. */
export const BASIN_FREEBOARD = 0.12;
/** The upright with the head: behind the basin (−u), its top over the street. */
export const UPRIGHT = { u0: -0.98, u1: -0.75, hw: 0.28, top: 1.35 } as const;
/** The spout: out of the head's mouth, over the back slab. */
export const SPOUT = { u: -0.64, y: 1.0 } as const;
/** Exit speed of the jet, m/s: a lead pipe of a few cm under a 6 m tower's head, throttled by the spout. */
export const SPOUT_SPEED = 1.1;

export interface Fountain {
  x: number; z: number;
  /** Street level at the fountain. */
  g: number;
  /** +u as an angle (radians from +x), and its cos/sin. */
  ang: number;
  head: Head;
  /** World: spout mouth, the jet's landing in the basin, and the water level. */
  spout: [number, number, number];
  impact: [number, number, number];
  water: number;
  /** World points of the overflow down the street from the notch, metres apart. */
  overflow: number[];
}

/** Where the free jet from (y0) at `speed` horizontal lands at height y1: the distance out. */
export function jetReach(y0: number, y1: number, speed: number): number {
  const t = Math.sqrt((2 * Math.max(0, y0 - y1)) / 9.81);
  return speed * t;
}

function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Within the basin and its upright, with a hand's margin. */
function inBasin(f: { x: number; z: number; ang: number }, x: number, z: number): boolean {
  const c = Math.cos(f.ang), s = Math.sin(f.ang), dx = x - f.x, dz = z - f.z;
  const u = dx * c + dz * s, w = -dx * s + dz * c;
  return u > UPRIGHT.u0 - 0.1 && u < BASIN.hu + 0.1 && Math.abs(w) < BASIN.hw + 0.1;
}

/** Local (u, w) to world (x, z) in a fountain's frame. */
export function fountainToWorld(f: { x: number; z: number; ang: number }, u: number, w: number): [number, number] {
  const c = Math.cos(f.ang), s = Math.sin(f.ang);
  return [f.x + c * u - s * w, f.z + s * u + c * w];
}

/**
 * The fountains as built: a head each (mixed through the town so no street
 * has four lions in a row), the jet's arc from the spout, and the overflow
 * from the notch on the street side, run downhill along the carriageway.
 */
export function placeFountains(data: PompeiiData, sites: WaterSites, groundAt: (x: number, z: number) => number): Fountain[] {
  const kerbs = data.insulae.map((i) => i.kerb);
  const onStreet = (x: number, z: number): boolean => !kerbs.some((k) => pointInRing(k, x, z));
  return sites.fountains.map((s, i) => {
    const head = Math.floor(hash(i, 5) * HEADS) as Head;
    const water = s.g + BASIN.rim - BASIN_FREEBOARD;
    const [sx, sz] = fountainToWorld(s, SPOUT.u, 0);
    const reach = jetReach(s.g + SPOUT.y, water, SPOUT_SPEED);
    const [ix, iz] = fountainToWorld(s, SPOUT.u + reach, 0);
    // The overflow: out of the notch at +u, then the steepest way down that
    // stays on the street, re-chosen every metre so it follows the camber.
    const [nx, nz] = fountainToWorld(s, BASIN.hu + 0.05, 0.6);
    const flow: number[] = [nx, nz];
    let px = nx, pz = nz, dx = Math.cos(s.ang), dz = Math.sin(s.ang);
    for (let k = 0; k < 14; k++) {
      let best: [number, number] | null = null, bd = Infinity;
      // The first step may go any way off the notch (a narrow vicolo can
      // face it with a kerb); after that at most 40 degrees a step, or 80
      // where the street turns harder. A fountain the survey put on the
      // pavement (one does) runs across it to the street first.
      for (const span of k === 0 ? [18] : [4, 8]) {
        for (let a = -span; a <= span; a++) {
          // Prefer down, then straight on; never back across the basin.
          const t = (a * Math.PI) / 18;
          const cx = dx * Math.cos(t) - dz * Math.sin(t), cz = dx * Math.sin(t) + dz * Math.cos(t);
          const qx = px + cx, qz = pz + cz;
          if (inBasin(s, qx, qz)) continue;
          const kerb = !onStreet(qx, qz);
          if (kerb && (k > 3 || onStreet(px, pz))) continue;
          const score = groundAt(qx, qz) - groundAt(px, pz) + Math.abs(a) * 0.004 * (k === 0 ? 0.3 : 1) + (kerb ? 1 : 0);
          if (score < bd) { bd = score; best = [cx, cz]; }
        }
        if (best) break;
      }
      if (!best) break;
      dx = best[0]; dz = best[1];
      px += dx; pz += dz;
      flow.push(px, pz);
    }
    return { x: s.x, z: s.z, g: s.g, ang: s.ang, head, spout: [sx, s.g + SPOUT.y, sz], impact: [ix, water, iz], water, overflow: flow };
  });
}

/** A water tower: the pillar's foot (world), its height to the top of the tank, and the side the pipes run down. */
export interface WaterTower { x: number; z: number; g: number; h: number; ang: number; fountain: number }

/** Pillar plan size and the tank on top. */
export const TOWER = { side: 1.1, h: 6.2, tank: 0.55 } as const;

/**
 * About a dozen towers, on the main streets' corners beside a fountain (as
 * the one by the Holconius arch at Via Stabiana and Via dell'Abbondanza),
 * at least 110 m apart, standing on the pavement clear of the houses.
 */
export function placeTowers(data: PompeiiData, fountains: Fountain[]): WaterTower[] {
  const mains = data.streets.filter((s) => s.main);
  const distMain = (x: number, z: number): number => {
    let best = Infinity;
    for (const s of mains) for (let i = 2; i < s.pts.length; i += 2) {
      const ax = s.pts[i - 2], az = s.pts[i - 1], dx = s.pts[i] - ax, dz = s.pts[i + 1] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
    return best;
  };
  const fronts = data.insulae.map((i) => i.ring);
  const kerbs = data.insulae.map((i) => i.kerb);
  const order = fountains.map((f, i) => ({ f, i, d: distMain(f.x, f.z) })).sort((a, b) => a.d - b.d || a.i - b.i);
  const out: WaterTower[] = [];
  for (const { f, i, d } of order) {
    if (out.length >= 13) break;
    if (d > 12) continue;
    if (out.some((t) => Math.hypot(t.x - f.x, t.z - f.z) < 110)) continue;
    // Beside the basin along the kerb, back toward the corner: on the
    // pavement (inside a kerb ring), clear of the frontage.
    for (const side of [1, -1]) {
      const [x, z] = fountainToWorld(f, -1.3, side * 2.1);
      if (fronts.some((r) => pointInRing(r, x, z))) continue;
      out.push({ x, z, g: f.g + (kerbs.some((k) => pointInRing(k, x, z)) ? 0.42 : 0), h: TOWER.h, ang: f.ang, fountain: i });
      break;
    }
  }
  return out;
}

/** The Castellum Aquae: its middle, floor, and the facade's outward angle. */
export interface Castellum { x: number; z: number; g: number; ang: number; w: number; d: number; h: number }

/**
 * Just inside Porta Vesuvio, the town's highest point (about 42 m over the
 * sea, 30 m over Porta di Stabia), on the west side of the road: a brick
 * house 6 x 6 m over the tank that split the aqueduct three ways.
 */
export function placeCastellum(data: PompeiiData, groundAt: (x: number, z: number) => number): Castellum | null {
  const gate = data.gates.find((g) => g.name === "Porta Vesuvio");
  if (!gate) return null;
  // The street that leaves the gate: its nearest end, and the way into town.
  let best: { x: number; z: number; tx: number; tz: number; half: number } | null = null, bd = 40;
  for (const s of data.streets) {
    const p = s.pts, L = p.length;
    for (const [i, j] of [[0, 2], [L - 2, L - 4]]) {
      if (j < 0 || j >= L) continue;
      const d = Math.hypot(p[i] - gate.x, p[i + 1] - gate.z);
      if (d < bd) {
        const l = Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]) || 1;
        bd = d; best = { x: p[i], z: p[i + 1], tx: (p[j] - p[i]) / l, tz: (p[j + 1] - p[i + 1]) / l, half: s.carriageM / 2 + s.sidewalkM };
      }
    }
  }
  if (!best) return null;
  const fronts = data.insulae.map((i) => i.ring);
  const W = 6.2, D = 5.8;
  // West of the road: the side whose normal has the more negative x.
  const sides = [[-best.tz, best.tx], [best.tz, -best.tx]].sort((a, b) => a[0] - b[0]);
  for (const [ox, oz] of sides) {
    // Clear of the gate: the passage through the wall runs some 15 m, and the castellum stands past its inner end.
    for (let along = 12; along <= 45; along += 3) {
      const off = best.half + D / 2 + 0.3;
      const x = best.x + best.tx * along + ox * off, z = best.z + best.tz * along + oz * off;
      if (fronts.some((r) => pointInRing(r, x, z))) continue;
      if (!pointInRing(data.wall, x, z) || ringDist(data.wall, x, z) < Math.hypot(W, D) / 2 + 1) continue;
      return { x, z, g: groundAt(x, z), ang: Math.atan2(-oz, -ox), w: W, d: D, h: 5.2 };
    }
  }
  return null;
}

function ringDist(r: Ring, x: number, z: number): number {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = r[i * 2], az = r[i * 2 + 1], dx = r[((i + 1) % n) * 2] - ax, dz = r[((i + 1) % n) * 2 + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/** Rim of an atrium pool over its water: the gate wants every pool's water below it. */
export const IMPLUVIUM_RIM = 0.14;
/** Rim width, metres: a tile or marble kerb round the pool. */
export const IMPLUVIUM_RIM_W = 0.2;
