// Pompeii rebuilt from the baked layout (data/pompeii.ts) as plain vertex
// arrays: the domus, tabernae and their roofs, the streets with their kerbs,
// stepping stones and fountains, the forum, temples, theatres, amphitheatre
// and the walls. No THREE here, so test/pompeii.check.ts can build the whole
// town under Bun and probe the rules it is built by; render/pompeii.ts wraps
// the arrays and shades them.
//
// Everything a reconstruction drawing shows that OSM does not say (heights,
// roof pitch, the atrium plan, the plaster scheme, where the shops are) comes
// from rules here, seeded per lot so the town is the same on every load:
//
//   * an insula's perimeter is cut into lots along each street frontage, each
//     lot running back from the street to a depth that leaves the middle of
//     the block for gardens and peristyles;
//   * a domus is three bands deep: shops and the entrance at the street, the
//     atrium with its roof sloping in to an open compluvium over the
//     impluvium, then the tablinum and back rooms;
//   * main-street frontages are mostly tabernae: wide openings, a counter,
//     the dark shop behind;
//   * roofs are low-pitched terracotta (22 degrees, the Roman pitch), walls
//     are plastered with a dark socle, a coloured lower band and pale upper
//     wall, and that scheme is a shader pattern keyed by the surface id here.
//
// Vertex layout (40 bytes): position f32x3, normal i8x4, colour u8x4 (rgb +
// a per-lot seed), surf u8x4 (style, two style parameters, flags), and wall
// f32x4 (u metres along, v metres up, facade length, facade height).

import type { PompeiiData, PompeiiInsula, PompeiiPublic, Ring } from "../data/pompeii";
import { KERB_M, pointInRing, ringArea, ringCentroid } from "../data/pompeii";
import type { LampSites } from "../data/pompeiilamps";

/** What the fragment shader draws on a surface. */
export const enum Surf {
  Plaster = 0,
  Tile = 1,
  Basalt = 2,
  Kerb = 3,
  Stucco = 4,
  Garden = 5,
  Interior = 6,
  Wood = 7,
  Water = 8,
  Sand = 9,
  Masonry = 10,
  Marble = 11,
  Fresco = 12,
  Pavement = 13,
  Hide = 14,
}

export const ROOF_PITCH_DEG = 22;
const TAN_PITCH = Math.tan((ROOF_PITCH_DEG * Math.PI) / 180);
/** How far in from a wall or court a surveyed house's roof keeps rising. */
const ROOF_RANGE_M = 8;

export { KERB_M } from "../data/pompeii";

/**
 * The amphitheatre as modelled. The OSM outline fits an ellipse of about
 * 148 x 113 m, which is the wall plus the external stair blocks and the
 * embankment terrace round it; the documented wall is 135 x 104 m and the
 * arena 66.8 x 34.5 m, which the OSM inner ring matches. Centre and axis come
 * from OSM, the sizes from the survey literature.
 */
export const AMPHI = { a: 67.5, b: 52, arenaA: 33.4, arenaB: 17.25, podium: 2.2, top: 13, tiers: 26, dig: 6 };

type V3 = [number, number, number];
type RGB = [number, number, number];

/** Growable typed vertex store. */
class Store {
  n = 0;
  cap = 4096;
  pos = new Float32Array(this.cap * 3);
  nrm = new Int8Array(this.cap * 4);
  col = new Uint8Array(this.cap * 4);
  surf = new Uint8Array(this.cap * 4);
  wall = new Float32Array(this.cap * 4);
  idx: Uint32Array = new Uint32Array(8192);
  ni = 0;

  grow(): void {
    this.cap *= 2;
    const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, k: number): T => {
      const b = new (a.constructor as new (n: number) => T)(this.cap * k);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 4); this.col = g(this.col, 4);
    this.surf = g(this.surf, 4); this.wall = g(this.wall, 4);
  }

  vert(p: V3, n: V3, c: RGB, seed: number, s: Surf, p1: number, p2: number, w: [number, number, number, number]): number {
    if (this.n >= this.cap) this.grow();
    const i = this.n++;
    this.pos[i * 3] = p[0]; this.pos[i * 3 + 1] = p[1]; this.pos[i * 3 + 2] = p[2];
    this.nrm[i * 4] = Math.round(n[0] * 127); this.nrm[i * 4 + 1] = Math.round(n[1] * 127); this.nrm[i * 4 + 2] = Math.round(n[2] * 127);
    this.col[i * 4] = Math.round(Math.min(1, c[0]) * 255); this.col[i * 4 + 1] = Math.round(Math.min(1, c[1]) * 255);
    this.col[i * 4 + 2] = Math.round(Math.min(1, c[2]) * 255); this.col[i * 4 + 3] = Math.round(seed * 255);
    this.surf[i * 4] = s; this.surf[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, p1))); this.surf[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, p2)));
    this.wall.set(w, i * 4);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const b2 = new Uint32Array(this.idx.length * 2);
      b2.set(this.idx);
      this.idx = b2;
    }
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
}

export interface PompeiiMeshData {
  position: Float32Array;
  normal: Int8Array;
  colour: Uint8Array;
  surf: Uint8Array;
  wall: Float32Array;
  index: Uint32Array;
  triangles: number;
}

/** A building's footprint for the collider and the skyline. */
export interface Solid {
  ring: number[];
  baseY: number;
  topY: number;
}

export interface LotInfo {
  kind: "domus" | "taberna" | "house" | "garden";
  /** Frontage, metres. */
  width: number;
  depth: number;
  storeys: number;
  main: boolean;
  /** Atrium band with an open compluvium. */
  compluvium: boolean;
  inferred: boolean;
}

export interface PompeiiModel {
  /** The town: buildings, kerbs, landmarks, walls. Single-sided. */
  mesh: PompeiiMeshData;
  /** The open ground inside the walls, drawn with a depth bias over the terrain. */
  floor: PompeiiMeshData;
  /** The basalt carriageways, biased over the floor. */
  streets: PompeiiMeshData;
  solids: Solid[];
  lots: LotInfo[];
  /** Where the lamps can go: render/pompeiilamps.ts. */
  sites: LampSites;
  /** Counts the gate reads. */
  stats: {
    lots: number; domus: number; tabernae: number; compluvia: number; fountains: number;
    steppingStones: number; columns: number; towers: number; roofTriangles: number; flatRoofs: number;
    plasterTriangles: number; buildMs: number;
    /** Named houses built on their OSM outline with courts. */
    surveyedHouses: number;
  };
  /** Where the amphitheatre was put, for the gate. */
  amphitheatre: { cx: number; cz: number; a: number; b: number; rot: number; floorY: number; rimY: number };
}

export interface BuildOptions {
  data: PompeiiData;
  groundAt: (x: number, z: number) => number;
  /** Drop the small things (stepping stones, counters, merlons) on a phone. */
  lean?: boolean;
  /** Probe: every building a flat grey box, for the gate's vacuity check. */
  greyBoxes?: boolean;
}

// --- deterministic noise ---------------------------------------------------------
function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// --- palette ----------------------------------------------------------------------
// Measured off the surviving street facades and the standard reconstruction
// plates: Pompeian red, yellow ochre, a pale cream, and the darker red and
// black of the socle below.
const LOWER: RGB[] = [
  [0.56, 0.13, 0.08], [0.62, 0.17, 0.1], [0.78, 0.55, 0.22], [0.82, 0.62, 0.3],
  [0.88, 0.84, 0.74], [0.85, 0.78, 0.64], [0.5, 0.14, 0.1], [0.72, 0.42, 0.2],
];
const GREY: RGB = [0.55, 0.55, 0.55];

// =====================================================================================
export function buildPompeii(opts: BuildOptions): PompeiiModel {
  const t0 = performance.now();
  const { data, groundAt } = opts;
  const lean = !!opts.lean;
  const grey = !!opts.greyBoxes;
  const S = new Store();
  const F = new Store();
  const R = new Store();
  const solids: Solid[] = [];
  const lots: LotInfo[] = [];
  const lampSites: LampSites = { openings: [], courts: [] };
  const stats = {
    lots: 0, domus: 0, tabernae: 0, compluvia: 0, fountains: 0, steppingStones: 0, columns: 0,
    towers: 0, roofTriangles: 0, flatRoofs: 0, plasterTriangles: 0, buildMs: 0, surveyedHouses: 0,
  };

  // --- emitters ------------------------------------------------------------------
  /**
   * A planar convex polygon. The winding is fixed to match `facing` (the side
   * it is seen from), since the town draws single-sided.
   */
  function poly(st: Store, pts: V3[], facing: V3, c: RGB, seed: number, s: Surf, p1: number, p2: number, uvs: [number, number, number, number][]): void {
    if (grey && st === S) { c = GREY; s = Surf.Stucco; }
    // Face normal from the first non-degenerate fan triangle.
    let nx = 0, ny = 0, nz = 0;
    for (let k = 1; k + 1 < pts.length && nx * nx + ny * ny + nz * nz < 1e-12; k++) {
      const a = pts[0], b = pts[k], d = pts[k + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
    }
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;
    nx /= L; ny /= L; nz /= L;
    const flip = nx * facing[0] + ny * facing[1] + nz * facing[2] < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const base = st.n;
    for (let k = 0; k < pts.length; k++) st.vert(pts[k], [nx, ny, nz], c, seed, s, p1, p2, uvs[k]);
    for (let k = 1; k + 1 < pts.length; k++) {
      if (flip) st.tri(base, base + k + 1, base + k); else st.tri(base, base + k, base + k + 1);
    }
    const tris = pts.length - 2;
    if (st === S) {
      if (s === Surf.Tile) stats.roofTriangles += tris;
      if (s === Surf.Plaster) stats.plasterTriangles += tris;
    }
  }
  const NO_UV: [number, number, number, number] = [0, 0, 0, 0];
  const uv4 = (): [number, number, number, number][] => [NO_UV, NO_UV, NO_UV, NO_UV];

  /**
   * A vertical wall from a to b, ground to `top`, seen from the side `out`
   * points to (unit, horizontal). `u0` is where on its facade a starts.
   */
  function wall(ax: number, az: number, bx: number, bz: number, yBotA: number, yBotB: number, yTopA: number, yTopB: number,
    outX: number, outZ: number, c: RGB, seed: number, s: Surf, p1: number, p2: number, u0: number, facadeLen: number, groundRef: number, facadeH: number): void {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) return;
    poly(S, [[ax, yBotA, az], [bx, yBotB, bz], [bx, yTopB, bz], [ax, yTopA, az]], [outX, 0, outZ], c, seed, s, p1, p2, [
      [u0, yBotA - groundRef, facadeLen, facadeH], [u0 + L, yBotB - groundRef, facadeLen, facadeH],
      [u0 + L, yTopB - groundRef, facadeLen, facadeH], [u0, yTopA - groundRef, facadeLen, facadeH],
    ]);
  }

  /** An axis-free box: footprint quad (CCW or CW), from y0 to y1. */
  function box(q: number[], y0: number, y1: number, c: RGB, seed: number, s: Surf, top: Surf = s, topC: RGB = c): void {
    const n = q.length / 2;
    const [cx, cz] = ringCentroid(q);
    for (let i = 0; i < n; i++) {
      const ax = q[i * 2], az = q[i * 2 + 1], bx = q[((i + 1) % n) * 2], bz = q[((i + 1) % n) * 2 + 1];
      const mx = (ax + bx) / 2 - cx, mz = (az + bz) / 2 - cz;
      let ox = bz - az, oz = -(bx - ax);
      if (ox * mx + oz * mz < 0) { ox = -ox; oz = -oz; }
      const L = Math.hypot(ox, oz) || 1;
      wall(ax, az, bx, bz, y0, y0, y1, y1, ox / L, oz / L, c, seed, s, 0, 0, 0, y0, 0, 0);
    }
    const pts: V3[] = [];
    for (let i = 0; i < n; i++) pts.push([q[i * 2], y1, q[i * 2 + 1]]);
    poly(S, pts, [0, 1, 0], topC, seed, top, 0, 0, pts.map((p) => [p[0], p[2], 0, 0]));
  }

  /** A prism column, `sides` faced, base at y0. Pompeian columns: stuccoed, red lower third. */
  function column(x: number, z: number, y0: number, h: number, r: number, c: RGB, seed: number, sides = 8, red = false): void {
    stats.columns++;
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const ax = x + Math.cos(a0) * r, az = z + Math.sin(a0) * r, bx = x + Math.cos(a1) * r, bz = z + Math.sin(a1) * r;
      wall(ax, az, bx, bz, y0, y0, y0 + h, y0 + h, Math.cos(am), Math.sin(am), c, seed, Surf.Stucco, red ? 1 : 0, 0, 0, 0, y0, h);
    }
  }

  const ground = (x: number, z: number): number => groundAt(x, z);

  // =====================================================================================
  // Streets: the carriageway floor across the whole walled town, and the
  // kerbed pavements as the raised outline of each insula.
  // =====================================================================================
  const wallRing = data.wall;
  const amph = data.amphitheatre;
  const inAmph = (x: number, z: number, pad: number): boolean => {
    const dx = x - amph.cx, dz = z - amph.cz;
    const u = dx * Math.cos(amph.rot) + dz * Math.sin(amph.rot), v = -dx * Math.sin(amph.rot) + dz * Math.cos(amph.rot);
    return (u / (AMPHI.a + pad)) ** 2 + (v / (AMPHI.b + pad)) ** 2 <= 1;
  };
  {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < wallRing.length; i += 2) {
      x0 = Math.min(x0, wallRing[i]); x1 = Math.max(x1, wallRing[i]);
      z0 = Math.min(z0, wallRing[i + 1]); z1 = Math.max(z1, wallRing[i + 1]);
    }
    const cell = lean ? 8 : 5;
    const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
    const vid = new Int32Array(nx * nz).fill(-1);
    const pid = new Int32Array(nx * nz).fill(-1);
    // Beaten earth wherever nothing else is built: the open ground round the
    // amphitheatre, the pomerium inside the walls. The streets are ribbons on it.
    const v = (i: number, j: number): number => {
      const k = j * nx + i;
      if (vid[k] >= 0) return vid[k];
      const x = x0 + i * cell, z = z0 + j * cell;
      vid[k] = F.vert([x, ground(x, z) + 0.05, z], [0, 1, 0], [0.46, 0.4, 0.3], hash(i, j), Surf.Garden, 0, 0, [x, z, 0, 0]);
      return vid[k];
    };
    // The forum's travertine is this same terrain-following sheet, a kerb
    // higher. A flat slab at the forum's lowest corner was buried under the
    // terrain and this earth wherever the square rises to the north, which
    // is most of it, and the forum read as a dark dirt yard.
    const forumRing = data.publics.find((p) => p.kind === "forum")?.ring ?? null;
    const pv = (i: number, j: number): number => {
      const k = j * nx + i;
      if (pid[k] >= 0) return pid[k];
      const x = x0 + i * cell, z = z0 + j * cell;
      pid[k] = F.vert([x, ground(x, z) + KERB_M + 0.05, z], [0, 1, 0], [0.86, 0.83, 0.75], hash(i, j, 5), Surf.Marble, 0, 0, [x, z, 0, 0]);
      return pid[k];
    };
    for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
      const cx = x0 + (i + 0.5) * cell, cz = z0 + (j + 0.5) * cell;
      if (!pointInRing(wallRing, cx, cz) || inAmph(cx, cz, -2)) continue;
      const paved = !!forumRing && pointInRing(forumRing, cx, cz);
      const vv = paved ? pv : v;
      const a = vv(i, j), b = vv(i + 1, j), c = vv(i, j + 1), d = vv(i + 1, j + 1);
      // Up-facing with +z south: (a, c, b) winds counter-clockwise seen from above.
      F.tri(a, c, b); F.tri(b, c, d);
    }
  }
  // The carriageways: basalt ribbons down each street's centreline, a little
  // wider than the gap between the kerbs so their edges tuck under them.
  for (const s of data.streets) {
    const p = s.pts, n = p.length / 2;
    if (n < 2) continue;
    const half = s.carriageM / 2 + 0.2;
    // Mitred offsets at each vertex.
    const off: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = 0, tz = 0;
      if (i > 0) { const dx = p[i * 2] - p[a * 2], dz = p[i * 2 + 1] - p[a * 2 + 1], L = Math.hypot(dx, dz) || 1; tx += dx / L; tz += dz / L; }
      if (i < n - 1) { const dx = p[b * 2] - p[i * 2], dz = p[b * 2 + 1] - p[i * 2 + 1], L = Math.hypot(dx, dz) || 1; tx += dx / L; tz += dz / L; }
      const L = Math.hypot(tx, tz) || 1;
      off.push([-tz / L, tx / L]);
    }
    for (let i = 0; i + 1 < n; i++) {
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az);
      const pieces = Math.max(1, Math.ceil(L / 6));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces, t1 = (k + 1) / pieces;
        const o0 = [lerp(off[i][0], off[i + 1][0], t0), lerp(off[i][1], off[i + 1][1], t0)];
        const o1 = [lerp(off[i][0], off[i + 1][0], t1), lerp(off[i][1], off[i + 1][1], t1)];
        const cx0 = lerp(ax, bx, t0), cz0 = lerp(az, bz, t0), cx1 = lerp(ax, bx, t1), cz1 = lerp(az, bz, t1);
        const q: [number, number][] = [[cx0 - o0[0] * half, cz0 - o0[1] * half], [cx1 - o1[0] * half, cz1 - o1[1] * half], [cx1 + o1[0] * half, cz1 + o1[1] * half], [cx0 + o0[0] * half, cz0 + o0[1] * half]];
        const base = R.n;
        // wall.zw: signed metres across from the centreline and the half width, for the ruts.
        q.forEach(([x, z], k) => R.vert([x, ground(x, z) + 0.08, z], [0, 1, 0], [0.24, 0.23, 0.22], 0.5, Surf.Basalt, 0, 0, [x, z, k < 2 ? -half : half, half]));
        // q runs right side forward, left side back: counter-clockwise in
        // (x, z), which faces down in this y-up, z-south frame, so reversed.
        R.tri(base, base + 2, base + 1); R.tri(base, base + 3, base + 2);
      }
    }
  }

  /** Raised slab over a ring: kerb faces round it, a top following the ground. */
  function slab(r: Ring, lift: number, side: Surf, sideC: RGB, top: Surf, topC: RGB, seed: number): void {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      // Interior is left of a positive-area ring; out is the right normal.
      const ox = (bz - az) / L, oz = -(bx - ax) / L;
      const ga = ground(ax, az), gb = ground(bx, bz);
      wall(ax, az, bx, bz, ga - 0.3, gb - 0.3, ga + lift, gb + lift, ox, oz, sideC, seed, side, 0, 0, 0, L, ga, lift);
    }
    const f = new Float32Array(r);
    const tri = triangulateRing(f);
    const base = S.n;
    for (let i = 0; i < n; i++) {
      const x = r[i * 2], z = r[i * 2 + 1];
      S.vert([x, ground(x, z) + lift, z], [0, 1, 0], grey ? GREY : topC, seed, grey ? Surf.Stucco : top, 0, 0, [x, z, 0, 0]);
    }
    for (let k = 0; k < tri.length; k += 3) S.tri(base + tri[k], base + tri[k + 2], base + tri[k + 1]);
  }

  for (let ii = 0; ii < data.insulae.length; ii++) {
    const ins = data.insulae[ii];
    slab(ins.kerb, KERB_M, Surf.Kerb, [0.62, 0.6, 0.55], Surf.Pavement, [0.43, 0.35, 0.26], hash(ii, 7));
    // The block's own ground, a step up from the pavement: the garden and the
    // peristyles wherever the lots leave it open.
    slab(ins.ring, KERB_M + 0.06, Surf.Kerb, [0.55, 0.5, 0.44], Surf.Garden, [0.3, 0.38, 0.17], hash(ii, 8));
  }

  // --- stepping stones and fountains ---------------------------------------------------
  const junctions: [number, number, boolean][] = [];
  {
    const ends = new Map<string, number>();
    const key = (x: number, z: number): string => `${Math.round(x)},${Math.round(z)}`;
    for (const s of data.streets) for (let k = 0; k < s.pts.length; k += 2) {
      const kk = key(s.pts[k], s.pts[k + 1]);
      ends.set(kk, (ends.get(kk) ?? 0) + (s.main ? 2 : 1));
    }
    const seen = new Set<string>();
    for (const s of data.streets) for (let k = 0; k < s.pts.length; k += 2) {
      const kk = key(s.pts[k], s.pts[k + 1]);
      const n = ends.get(kk) ?? 0;
      if (n >= 3 && !seen.has(kk)) { seen.add(kk); junctions.push([s.pts[k], s.pts[k + 1], n >= 4]); }
    }
  }
  const stoneC: RGB = [0.3, 0.29, 0.28];
  for (let si = 0; si < data.streets.length; si++) {
    const s = data.streets[si];
    if (lean || s.carriageM < 2.5) continue;
    // Stones a few metres back from each end, and every 50 m along a main
    // street: what a pedestrian crossed on when the street was running wet.
    let total = 0;
    const segs: [number, number, number, number, number][] = [];
    for (let k = 2; k < s.pts.length; k += 2) {
      const L = Math.hypot(s.pts[k] - s.pts[k - 2], s.pts[k + 1] - s.pts[k - 1]);
      segs.push([s.pts[k - 2], s.pts[k - 1], s.pts[k], s.pts[k + 1], total]);
      total += L;
    }
    if (total < 18) continue;
    const at: number[] = [7, total - 7];
    if (s.main) for (let d = 55; d < total - 30; d += 55) at.push(d);
    for (const d of at) {
      const sg = segs.find((g) => {
        const L = Math.hypot(g[2] - g[0], g[3] - g[1]);
        return d >= g[4] && d <= g[4] + L;
      });
      if (!sg) continue;
      const L = Math.hypot(sg[2] - sg[0], sg[3] - sg[1]) || 1;
      const tx = (sg[2] - sg[0]) / L, tz = (sg[3] - sg[1]) / L;
      const px = sg[0] + tx * (d - sg[4]), pz = sg[1] + tz * (d - sg[4]);
      const count = s.main ? 3 : s.carriageM > 3 ? 2 : 1;
      const gap = s.carriageM / count;
      for (let c = 0; c < count; c++) {
        const off = -s.carriageM / 2 + gap * (c + 0.5);
        const cx = px - tz * off, cz = pz + tx * off;
        // Long axis along the street, so the wheels pass between them.
        // Big rounded ovals of lava, as the surviving stones are.
        const hl = 0.62, hw = 0.4;
        const q: number[] = [];
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const lx = Math.cos(a) * hl, lw = Math.sin(a) * hw;
          q.push(cx + tx * lx - tz * lw, cz + tz * lx + tx * lw);
        }
        const g = ground(cx, cz);
        box(q, g - 0.2, g + KERB_M - 0.02, stoneC, hash(si, c), Surf.Kerb, Surf.Kerb, [0.36, 0.35, 0.33]);
        stats.steppingStones++;
      }
    }
  }
  // Public fountains: about forty in the town, nearly all on a street
  // corner. The ones the excavation keeps are where OSM maps them; the rest
  // go to junctions, main-street crossings first, never two within 40 m.
  const FOUNTAINS = 40;
  const sites: [number, number][] = [];
  for (const f of data.fountains ?? []) {
    let best: [number, number] | null = null, bd = 25;
    for (const [jx, jz] of junctions) {
      const d = Math.hypot(jx - f.x, jz - f.z);
      if (d < bd) { bd = d; best = [jx, jz]; }
    }
    const p = best ?? [f.x, f.z];
    if (!sites.some((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) < 15)) sites.push(p);
  }
  const order = junctions.map((j, ji) => ({ j, k: (j[2] ? 0 : 1) + hash(ji, 31) })).sort((a, b) => a.k - b.k);
  for (const { j } of order) {
    if (sites.length >= FOUNTAINS) break;
    if (!sites.some((s) => Math.hypot(s[0] - j[0], s[1] - j[1]) < 40)) sites.push([j[0], j[1]]);
  }
  for (let ji = 0; ji < sites.length; ji++) {
    const [jx, jz] = sites[ji];
    // On the pavement at a corner: the nearest kerb ring vertex to the junction.
    let best: [number, number] | null = null, bd = 14;
    for (const ins of data.insulae) {
      const r = ins.kerb;
      for (let i = 0; i < r.length; i += 2) {
        const d = Math.hypot(r[i] - jx, r[i + 1] - jz);
        if (d < bd) { bd = d; best = [r[i], r[i + 1]]; }
      }
    }
    if (!best) continue;
    // Out onto the carriageway's edge, in front of the corner.
    const dx = jx - best[0], dz = jz - best[1], dl = Math.hypot(dx, dz) || 1;
    const fx = best[0] + (dx / dl) * 1.3, fz = best[1] + (dz / dl) * 1.3;
    const ang = Math.atan2(dz, dx);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const q: number[] = [];
    for (const [u, w] of [[-0.75, -1.05], [0.75, -1.05], [0.75, 1.05], [-0.75, 1.05]]) q.push(fx + ca * u - sa * w, fz + sa * u + ca * w);
    const g = ground(fx, fz);
    // Four lava slabs and the water inside them.
    box(q, g - 0.2, g + 0.85, [0.33, 0.31, 0.29], hash(ji), Surf.Kerb, Surf.Water, [0.2, 0.3, 0.32]);
    const pq: number[] = [];
    for (const [u, w] of [[-0.95, -0.25], [-0.75, -0.25], [-0.75, 0.25], [-0.95, 0.25]]) pq.push(fx + ca * u - sa * w, fz + sa * u + ca * w);
    box(pq, g, g + 1.5, [0.7, 0.68, 0.62], hash(ji, 2), Surf.Stucco);
    stats.fountains++;
  }

  // =====================================================================================
  // Insulae: lots round the perimeter, a domus/taberna/house in each.
  // =====================================================================================
  const publicRings = data.publics.map((p) => p.ring);

  // =====================================================================================
  // Surveyed houses: the 114 named outlines OSM maps (Casa del Fauno, dei
  // Vettii, ...) built on their real footprints, with the open courts the
  // bake found in their room walls. The rule-built lots give way round them.
  // =====================================================================================
  interface House { ring: Ring; courts: Ring[]; surveyed: boolean; x0: number; x1: number; z0: number; z1: number; seed: number }
  const houses: House[] = [];
  for (let di = 0; di < data.domus.length; di++) {
    const d = data.domus[di];
    let ring = cleanRing(d.ring);
    if (!ring || ringArea(ring) < 40) continue;
    const [cx, cz] = ringCentroid(ring);
    // OSM draws many outlines a metre or two shy of the street (the survey
    // follows the wall's inner face, the insula the back of the pavement):
    // pulled out onto the frontage, or a strip of the block's garden shows
    // between the pavement and the house.
    const ins = blockOf(ring);
    // An outline that runs across a street is not a house plan (Casa di
    // Giulio Polibio's spans four blocks): those are left to the rules.
    if (!ins || shareInside(ring, ins.ring) < 0.85) continue;
    {
      const r = [...ring];
      for (let i = 0; i < r.length; i += 2) {
        if (distToRing(ins.ring, r[i], r[i + 1]) < 5) [r[i], r[i + 1]] = nearestOnRing(ins.ring, r[i], r[i + 1]);
      }
      ring = cleanRing(r) ?? ring;
    }
    if (publicRings.some((pr) => pointInRing(pr, cx, cz))) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
    // A court must sit inside its house with room for the walls round it.
    const courts = (d.courts ?? []).filter((c) => {
      for (let k = 0; k < 8; k += 2) if (!pointInRing(ring, c[k], c[k + 1])) return false;
      return true;
    });
    houses.push({ ring, courts, surveyed: courts.length > 0, x0, x1, z0, z1, seed: hash(di, 991) });
  }
  const houseAt = (x: number, z: number): boolean =>
    houses.some((h) => x >= h.x0 && x <= h.x1 && z >= h.z0 && z <= h.z1 && pointInRing(h.ring, x, z));
  /**
   * How far back from its street front a lot quad (fa, fb front; ba, bb
   * back) is clear of every surveyed house, 0..1 of its depth: 1 untouched,
   * 0 when the house reaches the front row.
   */
  function lotFreeDepth(fa: [number, number], fb: [number, number], bb: [number, number], ba: [number, number]): number {
    if (!houses.length) return 1;
    const rows = [0.08, 0.3, 0.55, 0.8, 0.97];
    for (let r = 0; r < rows.length; r++) {
      const t = rows[r];
      for (const s of [0.08, 0.35, 0.65, 0.92]) {
        const x = lerp(lerp(fa[0], fb[0], s), lerp(ba[0], bb[0], s), t), z = lerp(lerp(fa[1], fb[1], s), lerp(ba[1], bb[1], s), t);
        if (houseAt(x, z)) return r === 0 ? 0 : Math.max(0, rows[r - 1] + 0.05);
      }
    }
    return 1;
  }
  const mainStreets = data.streets.filter((s) => s.main);
  /**
   * The insula a house belongs to: the one holding most of its corners. Not
   * the one holding its centroid: a fifth of the outlines overhang their
   * block's traced edge and an L-shaped house's centroid can miss it.
   */
  /** Share of a ring's area, sampled on a 1.5 m lattice, that lies inside `outer`. */
  function shareInside(ring: Ring, outer: Ring): number {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
    let n = 0, k = 0;
    for (let x = x0 + 0.75; x < x1; x += 1.5) for (let z = z0 + 0.75; z < z1; z += 1.5) {
      if (!pointInRing(ring, x, z)) continue;
      n++;
      if (pointInRing(outer, x, z)) k++;
    }
    return n ? k / n : 0;
  }
  function blockOf(ring: Ring): PompeiiInsula | undefined {
    let best: PompeiiInsula | undefined, bn = 0;
    for (const ins of data.insulae) {
      let k = 0;
      for (let i = 0; i < ring.length; i += 2) if (pointInRing(ins.ring, ring[i], ring[i + 1])) k++;
      if (k > bn) { bn = k; best = ins; }
    }
    return best;
  }
  for (const h of houses) buildHouse(h);

  function buildHouse(hs: House): void {
    const { ring, seed } = hs;
    const n = ring.length / 2;
    const area = ringArea(ring);
    const ins = blockOf(ring);
    let gMin = Infinity;
    for (let i = 0; i < n; i++) gMin = Math.min(gMin, ground(ring[i * 2], ring[i * 2 + 1]));
    const yBot = gMin - 0.3;
    const storeyH = 4.9 + hash(seed * 1e6, 3) * 0.7;
    const col = LOWER[Math.floor(hash(seed * 1e6, 4) * LOWER.length)];
    const bandTop = 2.0 + hash(seed * 1e6, 5) * 1.2;
    const p1 = Math.round(bandTop * 40);
    const tileC: RGB = [0.6 + hash(seed * 1e6, 7) * 0.12, 0.29 + hash(seed * 1e6, 8) * 0.06, 0.18 + hash(seed * 1e6, 9) * 0.05];
    const sideC: RGB = [col[0] * 0.5 + 0.43, col[1] * 0.5 + 0.4, col[2] * 0.5 + 0.34];

    // Street edges: those running along the insula's frontage line.
    const edges = [];
    for (let i = 0; i < n; i++) {
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[((i + 1) % n) * 2], bz = ring[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const street = L >= 2.5 && !!ins && distToRing(ins.ring, mx, mz) < 1.8;
      const main = street && mainStreets.some((s) => distToPolyline(s.pts, mx, mz) < s.carriageM / 2 + s.sidewalkM + 2.5);
      edges.push({ ax, az, bx, bz, L, ox: (bz - az) / L, oz: -(bx - ax) / L, street, main });
    }
    // The front: the longest street edge, else the longest edge.
    let fi = 0;
    for (let i = 1; i < n; i++) {
      const a = edges[i], b = edges[fi];
      if ((a.street && !b.street) || (a.street === b.street && a.L > b.L)) fi = i;
    }
    const F = edges[fi];
    const ux = (F.bx - F.ax) / F.L, uz = (F.bz - F.az) / F.L;
    // v runs into the house from its front.
    const vx = -F.ox, vz = -F.oz;
    // The floor is level with the pavement at the front door: the plaster
    // scheme (socle, dado, window heights) is measured from it, and from the
    // centroid it stood a metre over the street on a slope.
    const g = ground((F.ax + F.bx) / 2, (F.az + F.bz) / 2) + KERB_M + 0.06;
    const top = g + storeyH;

    // No survey inside: an atrium behind the fauces and, in a deep house, a
    // peristyle garden behind the tablinum, on the house's own axis.
    let courts = hs.courts;
    if (!courts.length) {
      const fmx = (F.ax + F.bx) / 2, fmz = (F.az + F.bz) / 2;
      const depth = rayToRing(ring, fmx + vx * 0.1, fmz + vz * 0.1, vx, vz);
      const rect = (cu: number, v0: number, hw: number, dv: number): Ring => {
        const P = (u: number, v: number): number[] => [fmx + ux * u + vx * v, fmz + uz * u + vz * v];
        return [...P(cu - hw, v0), ...P(cu + hw, v0), ...P(cu + hw, v0 + dv), ...P(cu - hw, v0 + dv)];
      };
      const fits = (r: Ring): boolean => {
        for (let k = 0; k < 8; k += 2) if (!pointInRing(ring, r[k], r[k + 1]) || distToRing(ring, r[k], r[k + 1]) < 2.4) return false;
        return true;
      };
      const out: Ring[] = [];
      if (depth >= 13 && F.L >= 9) {
        const v0 = Math.min(6, depth * 0.3), dv = Math.min(9, Math.max(4, depth * 0.3));
        const a = rect(0, v0, Math.min(5, F.L * 0.2), dv);
        if (fits(a)) out.push(a);
        if (depth > 26) {
          const p0 = v0 + dv + 5;
          const p = rect(0, p0, Math.min(10, F.L * 0.32), Math.min(18, depth - p0 - 4));
          if (depth - p0 - 4 >= 6 && fits(p)) out.push(p);
        }
      }
      courts = out;
    }
    // Rooms ran at most a range or two deep from a wall or a court; ground
    // farther in than that was a garden or yard. Wherever the plan still
    // leaves a point that far from every edge, open a court there, so no
    // roof has to rise more than a range's pitch.
    courts = [...courts];
    for (let pass = 0; pass < 4; pass++) {
      // The farthest point from every edge, on a 2 m lattice.
      let bx = 0, bz = 0, bd = 0;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < n; i++) { x0 = Math.min(x0, ring[i * 2]); x1 = Math.max(x1, ring[i * 2]); z0 = Math.min(z0, ring[i * 2 + 1]); z1 = Math.max(z1, ring[i * 2 + 1]); }
      for (let x = x0 + 1; x < x1; x += 2) for (let z = z0 + 1; z < z1; z += 2) {
        if (!pointInRing(ring, x, z) || courts.some((c) => pointInRing(c, x, z))) continue;
        let d = distToRing(ring, x, z);
        for (const c of courts) d = Math.min(d, distToRing(c, x, z));
        if (d > bd) { bd = d; bx = x; bz = z; }
      }
      if (bd < ROOF_RANGE_M) break;
      // Corners stay a range in from the walls: the diagonal is the short way.
      const s = Math.max(2.5, (bd - 5) / 1.45);
      const c: Ring = [];
      for (const [a, b] of [[-s, -s], [s, -s], [s, s], [-s, s]]) c.push(bx + ux * a + vx * b, bz + uz * a + vz * b);
      courts.push(c);
    }
    const kind: LotInfo["kind"] = courts.length ? "domus" : "house";
    stats.lots++;
    if (kind === "domus") { stats.domus++; stats.compluvia++; stats.surveyedHouses++; }
    lots.push({ kind, width: F.L, depth: Math.sqrt(area), storeys: 1, main: F.main, compluvium: courts.length > 0, inferred: false });

    // --- outer walls, the street front with its door and shops ---
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (!e.street || grey) {
        wall(e.ax, e.az, e.bx, e.bz, yBot, yBot, top, top, e.ox, e.oz, sideC, seed, Surf.Plaster, p1, 255, 0, e.L, g, top - g);
        continue;
      }
      const openings: Opening[] = [];
      if (i === fi) openings.push({ u0: e.L / 2 - 0.95, u1: e.L / 2 + 0.95, h: 3.4, kind: "door" });
      if (e.main) {
        // Shops along a main-street front, either side of the door.
        for (let u = 0.8; u + 4.2 < e.L - 0.6; u += 5.2) {
          if (openings.some((o) => u < o.u1 + 0.6 && u + 4.2 > o.u0 - 0.6)) continue;
          openings.push({ u0: u, u1: u + 4.2, h: 3.1, kind: "shop" });
        }
      }
      if (openings.length) facade([e.ax, e.az], [e.bx, e.bz], g, yBot, top, e.ox, e.oz, col, seed, p1, 0, openings, 5);
      else wall(e.ax, e.az, e.bx, e.bz, yBot, yBot, top, top, e.ox, e.oz, col, seed, Surf.Plaster, p1, 0, 0, e.L, g, top - g);
    }

    // --- the courts: walls round each looking in, the floor, pool or garden ---
    const areas = courts.map((c) => Math.abs(ringArea(c)));
    const biggest = areas.reduce((m, a, k) => (a > areas[m] ? k : m), 0);
    courts.forEach((c, k) => {
      const garden = areas[k] >= 150 && k === biggest;
      const [ccx, ccz] = ringCentroid(c);
      for (let e = 0; e < 4; e++) {
        const ax = c[e * 2], az = c[e * 2 + 1], bx = c[((e + 1) % 4) * 2], bz = c[((e + 1) % 4) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        let ix = ccx - (ax + bx) / 2, iz = ccz - (az + bz) / 2;
        const il = Math.hypot(ix, iz) || 1;
        ix /= il; iz /= il;
        wall(ax, az, bx, bz, g - 0.1, g - 0.1, top, top, ix, iz, garden ? [0.86, 0.8, 0.68] : [0.55, 0.12, 0.08], seed, garden ? Surf.Plaster : Surf.Fresco, garden ? 100 : 0, 255, 0, L, g, top - g);
        if (garden && !lean && !grey) {
          // The peristyle: columns a portico's depth in from the walls.
          const m = Math.max(1, Math.round((L - 4) / 3));
          for (let q = 0; q <= m; q++) {
            const t = 2 + ((L - 4) * q) / m;
            column(ax + ((bx - ax) * t) / L + ix * 2.4, az + ((bz - az) * t) / L + iz * 2.4, g, storeyH - 1.4, 0.2, [0.86, 0.82, 0.74], seed, 6, hash(seed * 1e6, 21) < 0.7);
          }
        }
      }
      const fp: V3[] = [0, 1, 2, 3].map((q): V3 => [c[q * 2], g + 0.02, c[q * 2 + 1]]);
      lampSites.courts.push({ ring: c.slice(0, 8), g, garden });
      poly(S, fp, [0, 1, 0], garden ? [0.3, 0.4, 0.18] : [0.55, 0.38, 0.3], seed, garden ? Surf.Garden : Surf.Pavement, 0, 0, fp.map((p) => [p[0], p[2], 0, 0]));
      if (garden && !lean && !grey) {
        // The portico roof inside the colonnade: a lean-to from the court walls.
        const inner = [0, 1, 2, 3].map((q): [number, number] => {
          const x = c[q * 2], z = c[q * 2 + 1];
          const dx = ccx - x, dz = ccz - z, dl = Math.hypot(dx, dz) || 1;
          return [x + (dx / dl) * 3.4, z + (dz / dl) * 3.4];
        });
        for (let e = 0; e < 4; e++) {
          const p: V3 = [c[e * 2], top - 0.2, c[e * 2 + 1]], q: V3 = [c[((e + 1) % 4) * 2], top - 0.2, c[((e + 1) % 4) * 2 + 1]];
          const qi: V3 = [inner[(e + 1) % 4][0], g + storeyH - 1.2, inner[(e + 1) % 4][1]], pi: V3 = [inner[e][0], g + storeyH - 1.2, inner[e][1]];
          const L = Math.hypot(q[0] - p[0], q[2] - p[2]);
          poly(S, [p, q, qi, pi], [ccx - (p[0] + q[0]) / 2, 2, ccz - (p[2] + q[2]) / 2], tileC, seed, Surf.Tile, 0, 0, [[0, 3.4, L, 3.4], [L, 3.4, L, 3.4], [L, 0, L, 3.4], [0, 0, L, 3.4]]);
        }
      } else if (!garden) {
        const pool = fp.map((p): V3 => [ccx + (p[0] - ccx) * 0.45, g + 0.07, ccz + (p[2] - ccz) * 0.45]);
        poly(S, pool, [0, 1, 0], [0.2, 0.32, 0.34], seed, Surf.Water, 0, 0, pool.map((p) => [p[0], p[2], 0, 0]));
      }
    });

    // --- the roof: one hipped heightfield over the house ---
    // Every point rises from the nearest eave, outer wall or court edge, at
    // the Roman pitch, so ranges of rooms get hipped roofs that drain both
    // to the street and into the atrium and peristyle, whatever the plan's
    // shape. Sampled on a grid along the house's axis; vertices that fall
    // outside the outline or inside a court are pulled onto its edge, so
    // the eaves follow the real walls.
    const cell = lean ? 2 : 1.25;
    const CAP = ROOF_RANGE_M + 1;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const u = ring[i * 2] * ux + ring[i * 2 + 1] * uz, v = ring[i * 2] * vx + ring[i * 2 + 1] * vz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    // The (u, v) frame has to keep the (x, z) handedness, or every triangle
    // below winds the wrong way and the roof is culled from above.
    const flipV = ux * vz - uz * vx < 0 ? -1 : 1;
    const nu = Math.ceil((u1 - u0) / cell) + 1, nv = Math.ceil((v1 - v0) / cell) + 1;
    const XZ = (i: number, j: number): [number, number] => {
      const u = u0 + i * cell, v = v0 + j * cell;
      return [u * ux + v * vx, u * uz + v * vz];
    };
    const inCourt = (x: number, z: number): number => courts.findIndex((c) => pointInRing(c, x, z));
    const vid = new Int32Array(nu * nv).fill(-1);
    const hgt = new Float32Array(nu * nv);
    const vert = (i: number, j: number): number => {
      const k = j * nu + i;
      if (vid[k] >= 0) return vid[k];
      const [gx0, gz0] = XZ(i, j);
      let x = gx0, z = gz0;
      if (!pointInRing(ring, x, z)) [x, z] = nearestOnRing(ring, x, z);
      const ci = inCourt(x, z);
      if (ci >= 0) [x, z] = nearestOnRing(courts[ci], x, z);
      // Distance to the nearest edge and the way out to it.
      let [nx, nz] = nearestOnRing(ring, x, z);
      let d = Math.hypot(x - nx, z - nz);
      for (const c of courts) {
        const [cx, cz] = nearestOnRing(c, x, z);
        const dc = Math.hypot(x - cx, z - cz);
        if (dc < d) { d = dc; nx = cx; nz = cz; }
      }
      const capped = d >= CAP;
      const dd = Math.min(d, CAP);
      // On an edge the slope runs in from where the grid point was pulled from.
      const sl = Math.hypot(x - gx0, z - gz0);
      const gx = d > 1e-3 ? (x - nx) / d : sl > 1e-3 ? (x - gx0) / sl : 0, gz = d > 1e-3 ? (z - nz) / d : sl > 1e-3 ? (z - gz0) / sl : 0;
      const y = top + dd * TAN_PITCH;
      const nrm: V3 = capped ? [0, 1, 0] : [-gx * TAN_PITCH, 1, -gz * TAN_PITCH];
      const nl = Math.hypot(nrm[0], nrm[1], nrm[2]);
      hgt[k] = y;
      vid[k] = S.vert([x, y, z], [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl], grey ? GREY : tileC, seed, grey ? Surf.Stucco : Surf.Tile, 0, grey ? 0 : 1, [0, dd / Math.cos(Math.atan(TAN_PITCH)), 0, 0]);
      return vid[k];
    };
    let roofTris = 0;
    for (let j = 0; j + 1 < nv; j++) for (let i = 0; i + 1 < nu; i++) {
      const [cx, cz] = XZ(i + 0.5, j + 0.5);
      if (!pointInRing(ring, cx, cz) || inCourt(cx, cz) >= 0) continue;
      const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), dd = vert(i + 1, j + 1);
      const ha = hgt[j * nu + i], hb = hgt[j * nu + i + 1], hc = hgt[(j + 1) * nu + i], hd = hgt[(j + 1) * nu + i + 1];
      // Split along the higher diagonal: the roof is a lower envelope of
      // planes, so that diagonal follows the ridge or hip rather than
      // cutting a notch across it.
      const tris: [number, number, number][] = ha + hd >= hb + hc ? [[a, c, dd], [a, dd, b]] : [[a, c, b], [b, c, dd]];
      for (const [p, q, r] of tris) {
        if (flipV > 0) S.tri(p, q, r); else S.tri(p, r, q);
        roofTris++;
      }
    }
    if (!grey) stats.roofTriangles += roofTris;
    else stats.flatRoofs++;
    solids.push({ ring: [...ring], baseY: yBot, topY: top + Math.min(CAP, 4) * TAN_PITCH });
  }

  for (let ii = 0; ii < data.insulae.length; ii++) buildInsula(data.insulae[ii], ii);

  function buildInsula(ins: PompeiiInsula, ii: number): void {
    const ring = cleanRing(ins.ring);
    if (!ring) return;
    const n = ring.length / 2;
    const P = (i: number): [number, number] => [ring[(((i % n) + n) % n) * 2], ring[(((i % n) + n) % n) * 2 + 1]];
    const area = ringArea(ring);
    if (ins.garden) {
      buildGarden(ring, ii);
      return;
    }
    const mainSet = new Set<number>();
    // mainEdges index the baked ring; re-find them on the cleaned one by midpoint.
    for (const e of ins.mainEdges) {
      const r0 = ins.ring, m = r0.length / 2;
      const mx = (r0[e * 2] + r0[((e + 1) % m) * 2]) / 2, mz = (r0[e * 2 + 1] + r0[((e + 1) % m) * 2 + 1]) / 2;
      let best = -1, bd = 4;
      for (let i = 0; i < n; i++) {
        const [ax, az] = P(i), [bx, bz] = P(i + 1);
        const d = distSeg(mx, mz, ax, az, bx, bz);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) mainSet.add(best);
    }
    // Per-edge geometry.
    const E = [];
    for (let i = 0; i < n; i++) {
      const [ax, az] = P(i), [bx, bz] = P(i + 1);
      const L = Math.hypot(bx - ax, bz - az);
      const ex = (bx - ax) / L, ez = (bz - az) / L;
      const nx = -ez, nz = ex;
      const w = rayToRing(ring, (ax + bx) / 2 + nx * 0.05, (az + bz) / 2 + nz * 0.05, nx, nz);
      const main = mainSet.has(i);
      const target = (main ? 17 : 14) + hash(ii, i, 3) * 6;
      let d = Math.min(target, w / 2);
      if (w < 2 * target && w < 30) d = w / 2;
      E.push({ ax, az, bx, bz, L, ex, ez, nx, nz, d: Math.max(3, d), main, use: L >= 5 && d >= 3 });
    }
    // Cut lines at each end: [px, pz, dx, dz] lines.
    type Line = [number, number, number, number];
    const cutStart: (Line | null)[] = new Array(n).fill(null);
    const cutEnd: (Line | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const a = E[i], b = E[(i + 1) % n];
      const [vx, vz] = P(i + 1);
      const turn = a.ex * b.ez - a.ez * b.ex;
      if (turn > 0.02) {
        // Convex: the longer (or main) frontage owns the corner.
        const aOwns = (a.main && !b.main) || (a.main === b.main && a.L >= b.L) || !b.use;
        if (aOwns) {
          cutEnd[i] = [vx, vz, b.ex, b.ez];
          cutStart[(i + 1) % n] = [vx + a.nx * a.d, vz + a.nz * a.d, a.ex, a.ez];
        } else {
          cutEnd[i] = [vx + b.nx * b.d, vz + b.nz * b.d, b.ex, b.ez];
          cutStart[(i + 1) % n] = [vx, vz, a.ex, a.ez];
        }
      } else {
        // Reflex or straight: both cut on the bisector of the two inward normals.
        let bx = a.nx + b.nx, bz = a.nz + b.nz;
        const bl = Math.hypot(bx, bz);
        if (bl < 1e-3) { bx = a.nx; bz = a.nz; } else { bx /= bl; bz /= bl; }
        cutEnd[i] = [vx, vz, bx, bz];
        cutStart[(i + 1) % n] = [vx, vz, bx, bz];
      }
    }
    let lotIx = 0;
    for (let i = 0; i < n; i++) {
      const e = E[i];
      if (!e.use) continue;
      const cs = cutStart[i]!, ce = cutEnd[i]!;
      // Parameters along the edge of the four strip corners.
      const tf0 = lineParam(e.ax, e.az, e.ex, e.ez, cs), tf1 = lineParam(e.ax, e.az, e.ex, e.ez, ce);
      const bxp = e.ax + e.nx * e.d, bzp = e.az + e.nz * e.d;
      const tb0 = lineParam(bxp, bzp, e.ex, e.ez, cs), tb1 = lineParam(bxp, bzp, e.ex, e.ez, ce);
      if (!isFinite(tf0) || !isFinite(tf1) || !isFinite(tb0) || !isFinite(tb1)) continue;
      if (tf1 - tf0 < 3 || tb1 - tb0 < 1) continue;
      // Split the frontage into lots.
      const widths: { w: number; kind: LotInfo["kind"] }[] = [];
      let used = 0;
      const span = tf1 - tf0;
      let k = 0;
      while (used < span - 0.01) {
        const r = hash(ii, i * 97 + k, 11);
        let kind: LotInfo["kind"], w: number;
        const deepEnough = e.d >= 11;
        if (e.main) {
          if (r < 0.32 && deepEnough) { kind = "domus"; w = 11 + hash(ii, i, k) * 7; }
          else if (r < 0.85) { kind = "taberna"; w = 4.2 + hash(ii, k, i) * 2.2; }
          else { kind = "house"; w = 7 + hash(k, i, ii) * 3; }
        } else if (r < 0.45 && deepEnough) { kind = "domus"; w = 10 + hash(ii, i, k) * 8; }
        else if (r < 0.85) { kind = "house"; w = 6 + hash(k, ii, i) * 4; }
        else { kind = "taberna"; w = 4.5 + hash(i, k, ii) * 2; }
        if (span - used - w < 3.5) w = span - used;
        widths.push({ w, kind });
        used += w;
        k++;
      }
      let t = tf0;
      for (let li = 0; li < widths.length; li++) {
        const { w, kind } = widths[li];
        const ta = t, tb = t + w;
        t = tb;
        const first = li === 0, last = li === widths.length - 1;
        const fa: [number, number] = [e.ax + e.ex * ta, e.az + e.ez * ta];
        const fb: [number, number] = [e.ax + e.ex * tb, e.az + e.ez * tb];
        const ba0 = first ? tb0 : Math.min(Math.max(ta, tb0), tb1);
        const bb0 = last ? tb1 : Math.min(Math.max(tb, tb0), tb1);
        if (bb0 - ba0 < 0.8) continue;
        const ba: [number, number] = [bxp + e.ex * ba0, bzp + e.ez * ba0];
        const bb: [number, number] = [bxp + e.ex * bb0, bzp + e.ez * bb0];
        // A lot poking into a public building is somebody else's ground.
        const mx = (fa[0] + fb[0] + ba[0] + bb[0]) / 4, mz = (fa[1] + fb[1] + ba[1] + bb[1]) / 4;
        if (publicRings.some((pr) => pointInRing(pr, mx, mz))) continue;
        // Two nearly parallel cut lines meet far off: at the block by Porta
        // Marina a lot's back corners landed 80 m out past the town wall,
        // the long bar that stuck out west of the gate.
        if ([fa, fb, bb, ba].some(([x, z]) => !pointInRing(ring, x, z) && distToRing(ring, x, z) > 2)) continue;
        // A lot on a surveyed house's ground gives way to it: dropped when
        // the house reaches the street front, else cut back to stop short of it.
        const free = lotFreeDepth(fa, fb, bb, ba);
        if (free <= 0) continue;
        if (free < 1) {
          const cb: [number, number] = [lerp(fb[0], bb[0], free), lerp(fb[1], bb[1], free)];
          const ca: [number, number] = [lerp(fa[0], ba[0], free), lerp(fa[1], ba[1], free)];
          buildLot(fa, fb, cb, ca, e.nx, e.nz, kind, e.main, ins.inferred, hash(ii, i * 31 + li, 5), e.d * free);
        } else buildLot(fa, fb, bb, ba, e.nx, e.nz, kind, e.main, ins.inferred, hash(ii, i * 31 + li, 5), e.d);
        lotIx++;
      }
    }
    // A big block (the terraces on the south and west edges) gets courtyard
    // houses in its middle too, on a grid along its longest edge.
    if (area > 5000) fillCore(ring, E, ii);
  }

  function fillCore(ring: Ring, E: { L: number; ex: number; ez: number; d: number }[], ii: number): void {
    let best = 0;
    for (let i = 1; i < E.length; i++) if (E[i].L > E[best].L) best = i;
    const ex = E[best].ex, ez = E[best].ez, nx = -ez, nz = ex;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      const u = ring[i] * ex + ring[i + 1] * ez, v = ring[i] * nx + ring[i + 1] * nz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const W = 17, D = 22, gap = 9;
    let k = 0;
    for (let u = u0 + 24; u + W < u1 - 24; u += W + gap) {
      for (let v = v0 + 24; v + D < v1 - 24; v += D + gap) {
        const c = [[u, v], [u + W, v], [u + W, v + D], [u, v + D]].map(([a, b]) => [a * ex + b * nx, a * ez + b * nz]);
        if (!c.every(([x, z]) => pointInRing(ring, x, z) && distToRing(ring, x, z) > 18)) continue;
        if (lotFreeDepth([c[0][0], c[0][1]], [c[1][0], c[1][1]], [c[2][0], c[2][1]], [c[3][0], c[3][1]]) < 1) continue;
        if (publicRings.some((pr) => c.some(([x, z]) => pointInRing(pr, x, z)))) continue;
        // Front on the u0 side, facing a lane between the houses.
        buildLot([c[0][0], c[0][1]], [c[1][0], c[1][1]], [c[2][0], c[2][1]], [c[3][0], c[3][1]], nx, nz, "domus", false, true, hash(ii, k++, 41), D);
      }
    }
  }

  function buildGarden(ring: Ring, ii: number): void {
    // A walled vineyard: a low wall round the block and rows of vines inside.
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[((i + 1) % n) * 2], bz = ring[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      const ox = (bz - az) / L, oz = -(bx - ax) / L;
      const ga = ground(ax, az) + KERB_M, gb = ground(bx, bz) + KERB_M;
      wall(ax, az, bx, bz, ga - 0.3, gb - 0.3, ga + 2.2, gb + 2.2, ox, oz, [0.86, 0.8, 0.68], hash(ii, i), Surf.Plaster, 0, 255, 0, L, ga, 2.2);
      wall(bx, bz, ax, az, ga - 0.3, gb - 0.3, ga + 2.2, gb + 2.2, -ox, -oz, [0.86, 0.8, 0.68], hash(ii, i), Surf.Plaster, 0, 255, 0, L, ga, 2.2);
    }
    if (lean) return;
    // Vine rows: low green hedges 1.4 m tall on 2.5 m centres.
    const e0x = ring[2] - ring[0], e0z = ring[3] - ring[1], L0 = Math.hypot(e0x, e0z) || 1;
    const ex = e0x / L0, ez = e0z / L0, nx = -ez, nz = ex;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      const u = ring[i] * ex + ring[i + 1] * ez, v = ring[i] * nx + ring[i + 1] * nz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    for (let v = v0 + 3; v < v1 - 3; v += 2.6) {
      // Longest inside run along u at this v.
      let a: number | null = null;
      for (let u = u0; u <= u1 + 1; u += 1) {
        const x = u * ex + v * nx, z = u * ez + v * nz;
        const inside = u <= u1 && pointInRing(ring, x, z) && distToRing(ring, x, z) > 2.5;
        if (inside && a === null) a = u;
        if ((!inside || u > u1) && a !== null) {
          if (u - a > 4) {
            const q = [[a, v - 0.35], [u - 1, v - 0.35], [u - 1, v + 0.35], [a, v + 0.35]].flatMap(([p, w]) => [p * ex + w * nx, p * ez + w * nz]);
            const g = ground(q[0], q[1]) + KERB_M;
            box(q, g, g + 1.5, [0.2, 0.32, 0.1], hash(ii, v | 0), Surf.Garden, Surf.Garden, [0.24, 0.38, 0.12]);
          }
          a = null;
        }
      }
    }
  }

  /**
   * One lot: quad fa,fb (street frontage) to bb,ba (back), inward normal n.
   * Bands front to back; each band walls, roof, and its street facade.
   */
  function buildLot(fa: [number, number], fb: [number, number], bb: [number, number], ba: [number, number],
    _nx: number, _nz: number, kind: LotInfo["kind"], main: boolean, inferred: boolean, seed: number, _depth: number): void {
    const width = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]);
    const d = Math.min(Math.hypot(ba[0] - fa[0], ba[1] - fa[1]), Math.hypot(bb[0] - fb[0], bb[1] - fb[1]));
    if (width < 2.5 || d < 2.5) return;
    stats.lots++;
    if (kind === "domus" && (d < 13 || width < 9)) kind = "house";
    const twoStorey = hash(seed * 1e6, 2) < (main ? 0.5 : kind === "taberna" ? 0.4 : 0.28);
    const storeyH = 4.8 + hash(seed * 1e6, 3) * 0.8;
    const Hf = twoStorey ? storeyH + 3.4 : storeyH;
    const col = LOWER[Math.floor(hash(seed * 1e6, 4) * LOWER.length)];
    const bandTop = 2.0 + hash(seed * 1e6, 5) * 1.2;
    // Some facades carry the colour full height; most are pale above the band.
    const fullColour = hash(seed * 1e6, 6) < 0.25;
    const tileC: RGB = [0.6 + hash(seed * 1e6, 7) * 0.12, 0.29 + hash(seed * 1e6, 8) * 0.06, 0.18 + hash(seed * 1e6, 9) * 0.05];
    const g = Math.max(ground(fa[0], fa[1]), ground(fb[0], fb[1])) + KERB_M;
    const gMin = Math.min(ground(fa[0], fa[1]), ground(fb[0], fb[1]), ground(ba[0], ba[1]), ground(bb[0], bb[1]));
    const yBot = gMin;
    const at = (t: number): [[number, number], [number, number]] => [
      [lerp(fa[0], ba[0], t), lerp(fa[1], ba[1], t)], [lerp(fb[0], bb[0], t), lerp(fb[1], bb[1], t)],
    ];
    const info: LotInfo = { kind, width, depth: d, storeys: twoStorey ? 2 : 1, main, compluvium: false, inferred };
    lots.push(info);
    if (kind === "taberna") stats.tabernae++;
    if (kind === "domus") stats.domus++;
    const p1 = Math.round(bandTop * 40);
    const p2 = fullColour ? 255 : 0;

    if (kind === "domus") {
      const fDepth = Math.min(6, d * 0.3);
      const aDepth = Math.min(11, Math.max(7, d * 0.4));
      const t1 = fDepth / d, t2 = Math.min(0.92, (fDepth + aDepth) / d);
      const [q0, q1] = at(0), [q2a, q2b] = at(t1), [q3a, q3b] = at(t2), [q4a, q4b] = at(1);
      // Front band: shops either side of the fauces on a main street.
      const openings: Opening[] = [];
      const doorW = 1.9;
      const mid = width / 2;
      openings.push({ u0: mid - doorW / 2, u1: mid + doorW / 2, h: 3.4, kind: "door" });
      if (main && width >= 12) {
        openings.push({ u0: 0.7, u1: mid - doorW / 2 - 0.7, h: 3.1, kind: "shop" });
        openings.push({ u0: mid + doorW / 2 + 0.7, u1: width - 0.7, h: 3.1, kind: "shop" });
      }
      band(q0, q1, q2b, q2a, g, yBot, Hf, "gable", col, tileC, seed, p1, p2, openings, true);
      // Atrium band, its roof sloping in to the compluvium.
      band(q2a, q2b, q3b, q3a, g, yBot, storeyH + 0.6, "compluvium", col, tileC, seed, p1, p2, [], false);
      info.compluvium = true;
      stats.compluvia++;
      // Back band: tablinum and rooms, a portico onto the garden behind.
      band(q3a, q3b, q4b, q4a, g, yBot, storeyH, "gable", col, tileC, seed, p1, p2, [], false, true);
      solids.push({ ring: [fa[0], fa[1], fb[0], fb[1], bb[0], bb[1], ba[0], ba[1]], baseY: yBot, topY: g + Hf + 1.5 });
    } else {
      const openings: Opening[] = [];
      if (kind === "taberna") openings.push({ u0: 0.55, u1: width - 0.55, h: 3.1, kind: "shop" });
      else openings.push({ u0: width * 0.5 - 0.8, u1: width * 0.5 + 0.8, h: 3.0, kind: "door" });
      const deep = Math.min(d, kind === "taberna" ? 9 : 14);
      const [q0, q1] = at(0), [qa, qb] = at(deep / d);
      band(q0, q1, qb, qa, g, yBot, Hf, kind === "taberna" && !twoStorey && hash(seed * 1e6, 12) < 0.4 ? "lean" : "gable", col, tileC, seed, p1, p2, openings, true);
      if (deep < d - 3) {
        // The rest of a deep plot is the yard behind: a lower outbuilding.
        const [qc, qd] = at(Math.min(1, (deep + Math.min(6, d - deep)) / d));
        band(qa, qb, qd, qc, g, yBot, 3.6, "lean", col, tileC, seed, p1, p2, [], false);
      }
      solids.push({ ring: [fa[0], fa[1], fb[0], fb[1], qb[0], qb[1], qa[0], qa[1]], baseY: yBot, topY: g + Hf + 1.5 });
    }
  }

  interface Opening { u0: number; u1: number; h: number; kind: "shop" | "door" }

  /**
   * A band of a lot: quad a,b (front) to c,d (back). Walls from the ground to
   * `H` above the floor `g`, a roof of the given form, the street facade with
   * its openings when `street`.
   */
  function band(a: [number, number], b: [number, number], c: [number, number], d: [number, number], g: number, yBot: number, H: number,
    roof: "gable" | "compluvium" | "lean" | "flat", col: RGB, tileC: RGB, seed: number, p1: number, p2: number, openings: Opening[], street: boolean, portico = false): void {
    const top = g + H;
    const fl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const depth = (Math.hypot(d[0] - a[0], d[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2;
    const fx = (b[0] - a[0]) / fl, fz = (b[1] - a[1]) / fl;
    // Outward from the street side.
    let ox = fz, oz = -fx;
    const mx = (a[0] + b[0] + c[0] + d[0]) / 4, mz = (a[1] + b[1] + c[1] + d[1]) / 4;
    if ((a[0] - mx) * ox + (a[1] - mz) * oz < 0) { ox = -ox; oz = -oz; }
    const rise = Math.min(3.2, (depth / 2) * TAN_PITCH);
    const s = seed;
    const wallTop = roof === "compluvium" ? top + rise : top;
    // Front facade.
    if (street && openings.length && !grey) facade(a, b, g, yBot, wallTop, ox, oz, col, s, p1, p2, openings, depth);
    // An upper floor on the street often had a timber balcony (maenianum)
    // over the pavement, under its own pent roof: the Casa del Balcone
    // Pensile is named for one.
    if (street && !grey && !lean && H > 7 && fl > 5 && hash(s * 1e6, 33) < 0.4) {
      const fx = (b[0] - a[0]) / fl, fz = (b[1] - a[1]) / fl;
      const y0 = g + H - 3.3, P = 1.05;
      const e0: [number, number] = [a[0] + fx * 0.5, a[1] + fz * 0.5], e1: [number, number] = [b[0] - fx * 0.5, b[1] - fz * 0.5];
      const q = [e0[0], e0[1], e1[0], e1[1], e1[0] + ox * P, e1[1] + oz * P, e0[0] + ox * P, e0[1] + oz * P];
      box(q, y0 - 0.2, y0, [0.4, 0.27, 0.15], s, Surf.Wood);
      // Parapet, plastered like the wall behind it.
      wall(e0[0] + ox * P, e0[1] + oz * P, e1[0] + ox * P, e1[1] + oz * P, y0, y0, y0 + 1.0, y0 + 1.0, ox, oz, col, s, Surf.Plaster, 0, 255, 0, fl, y0, 1.0);
      wall(e1[0] + ox * P, e1[1] + oz * P, e0[0] + ox * P, e0[1] + oz * P, y0, y0, y0 + 1.0, y0 + 1.0, -ox, -oz, col, s, Surf.Plaster, 0, 255, 0, fl, y0, 1.0);
      // Posts and the pent roof.
      const L = fl - 1;
      for (let k = 0; k <= Math.max(1, Math.round(L / 2.5)); k++) {
        const t = (L * k) / Math.max(1, Math.round(L / 2.5));
        column(e0[0] + fx * t + ox * (P - 0.08), e0[1] + fz * t + oz * (P - 0.08), y0 + 1.0, 1.9, 0.07, [0.36, 0.24, 0.13], s, 4);
      }
      const ry0 = y0 + 3.0, ry1 = y0 + 2.55;
      poly(S, [[e0[0], ry0, e0[1]], [e1[0], ry0, e1[1]], [e1[0] + ox * (P + 0.3), ry1, e1[1] + oz * (P + 0.3)], [e0[0] + ox * (P + 0.3), ry1, e0[1] + oz * (P + 0.3)]],
        [ox, 1, oz], [0.62, 0.31, 0.2], s, Surf.Tile, 0, 0, [[0, P, L, P], [L, P, L, P], [L, 0, L, P], [0, 0, L, P]]);
      poly(S, [[e0[0], ry0, e0[1]], [e1[0], ry0, e1[1]], [e1[0] + ox * (P + 0.3), ry1, e1[1] + oz * (P + 0.3)], [e0[0] + ox * (P + 0.3), ry1, e0[1] + oz * (P + 0.3)]],
        [ox * 0.2, -1, oz * 0.2], [0.38, 0.26, 0.15], s, Surf.Wood, 0, 0, uv4());
    }
    // The plain front only where facade() did not draw one: chained as an else
    // to the balcony it also walled over every shop and door without a balcony.
    if (!(street && openings.length && !grey)) wall(a[0], a[1], b[0], b[1], yBot, yBot, wallTop, wallTop, ox, oz, col, s, Surf.Plaster, p1, p2, 0, fl, g, wallTop - g);
    // Back and sides, all plastered (seen across gardens and over lower roofs).
    const sideC: RGB = [col[0] * 0.5 + 0.43, col[1] * 0.5 + 0.4, col[2] * 0.5 + 0.34];
    const bl = Math.hypot(c[0] - d[0], c[1] - d[1]);
    wall(c[0], c[1], d[0], d[1], yBot, yBot, wallTop, wallTop, -ox, -oz, sideC, s, Surf.Plaster, p1, 255, 0, bl, g, wallTop - g);
    const sideOut = (p: [number, number], q: [number, number]): [number, number] => {
      const ex = q[0] - p[0], ez = q[1] - p[1], L = Math.hypot(ex, ez) || 1;
      let sx = ez / L, sz = -ex / L;
      if ((p[0] + q[0]) / 2 * sx + (p[1] + q[1]) / 2 * sz - (mx * sx + mz * sz) < 0) { sx = -sx; sz = -sz; }
      return [sx, sz];
    };
    const [s1x, s1z] = sideOut(b, c), [s2x, s2z] = sideOut(d, a);
    wall(b[0], b[1], c[0], c[1], yBot, yBot, wallTop, wallTop, s1x, s1z, sideC, s, Surf.Plaster, p1, 255, 0, depth, g, wallTop - g);
    wall(d[0], d[1], a[0], a[1], yBot, yBot, wallTop, wallTop, s2x, s2z, sideC, s, Surf.Plaster, p1, 255, 0, depth, g, wallTop - g);

    if (grey || roof === "flat") {
      stats.flatRoofs++;
      poly(S, [[a[0], wallTop, a[1]], [b[0], wallTop, b[1]], [c[0], wallTop, c[1]], [d[0], wallTop, d[1]]], [0, 1, 0], col, s, Surf.Stucco, 0, 0, uv4());
      return;
    }
    const OH = 0.45;
    const eave = (p: [number, number], k: number): V3 => [p[0] + ox * OH * k, top - OH * TAN_PITCH, p[1] + oz * OH * k];
    if (roof === "gable") {
      // Ridge parallel to the street at mid-depth.
      const r0: V3 = [(a[0] + d[0]) / 2, top + rise, (a[1] + d[1]) / 2];
      const r1: V3 = [(b[0] + c[0]) / 2, top + rise, (b[1] + c[1]) / 2];
      const ea = eave(a, 1), eb = eave(b, 1), ec = eave(c, -1), ed = eave(d, -1);
      const halfD = depth / 2 + OH;
      poly(S, [ea, eb, r1, r0], [ox, 1, oz], tileC, s, Surf.Tile, 0, 0, [[0, 0, fl, halfD], [fl, 0, fl, halfD], [fl, halfD, fl, halfD], [0, halfD, fl, halfD]]);
      poly(S, [ec, ed, r0, r1], [-ox, 1, -oz], tileC, s, Surf.Tile, 0, 0, [[0, 0, fl, halfD], [fl, 0, fl, halfD], [fl, halfD, fl, halfD], [0, halfD, fl, halfD]]);
      // The underside of the street eave: from the pavement the roof is a
      // dark timber overhang along the top of the wall, not a sharp edge.
      if (street && !lean) {
        poly(S, [ea, eb, [b[0], top, b[1]], [a[0], top, a[1]]], [ox * 0.3, -1, oz * 0.3], [0.32, 0.22, 0.14], s, Surf.Wood, 0, 0, uv4());
        // The tile ends along the eave, as a thin fascia.
        poly(S, [ea, eb, [eb[0], eb[1] - 0.12, eb[2]], [ea[0], ea[1] - 0.12, ea[2]]], [ox, 0, oz], [0.5, 0.27, 0.17], s, Surf.Wood, 0, 0, uv4());
      }
      // Gable ends, plastered.
      poly(S, [[b[0], top, b[1]], [c[0], top, c[1]], r1], [s1x, 0, s1z], sideC, s, Surf.Plaster, p1, 255, [[0, H, depth, H + rise], [depth, H, depth, H + rise], [depth / 2, H + rise, depth, H + rise]]);
      poly(S, [[d[0], top, d[1]], [a[0], top, a[1]], r0], [s2x, 0, s2z], sideC, s, Surf.Plaster, p1, 255, [[0, H, depth, H + rise], [depth, H, depth, H + rise], [depth / 2, H + rise, depth, H + rise]]);
      if (portico && !lean) porticoBehind(c, d, g, top, -ox, -oz, tileC, s);
    } else if (roof === "lean") {
      // Mono-pitch falling to the street.
      const hb = top + Math.min(2.2, depth * TAN_PITCH * 0.6);
      const ea = eave(a, 1), eb = eave(b, 1);
      poly(S, [ea, eb, [c[0], hb, c[1]], [d[0], hb, d[1]]], [ox, 1, oz], tileC, s, Surf.Tile, 0, 0, [[0, 0, fl, depth], [fl, 0, fl, depth], [fl, depth, fl, depth], [0, depth, fl, depth]]);
      wall(c[0], c[1], d[0], d[1], top, top, hb, hb, -ox, -oz, sideC, s, Surf.Plaster, p1, 255, 0, bl, g, hb - g);
      poly(S, [[b[0], top, b[1]], [c[0], top, c[1]], [c[0], hb, c[1]]], [s1x, 0, s1z], sideC, s, Surf.Plaster, p1, 255, uv4());
      poly(S, [[d[0], top, d[1]], [a[0], top, a[1]], [d[0], hb, d[1]]], [s2x, 0, s2z], sideC, s, Surf.Plaster, p1, 255, uv4());
    } else {
      // Compluviate: four tiled slopes falling inward to an open rectangle,
      // the impluvium on the floor below it.
      // Inset the same distance on every side, so the four slopes share one
      // pitch and meet on true hips; a scaled-down copy of the quad gave the
      // long sides of a wide atrium a slope of a few degrees.
      const outer = [a, b, c, d];
      const inset = Math.min(depth, fl) * 0.32;
      const inner = outer.map((p, i): [number, number] => {
        const nx1 = outer[(i + 1) % 4], pv = outer[(i + 3) % 4];
        const l1 = Math.hypot(nx1[0] - p[0], nx1[1] - p[1]) || 1, l2 = Math.hypot(pv[0] - p[0], pv[1] - p[1]) || 1;
        return [p[0] + ((nx1[0] - p[0]) / l1 + (pv[0] - p[0]) / l2) * inset, p[1] + ((nx1[1] - p[1]) / l1 + (pv[1] - p[1]) / l2) * inset];
      });
      const hi = wallTop, lo = wallTop - inset * TAN_PITCH;
      for (let e = 0; e < 4; e++) {
        const p = outer[e], q = outer[(e + 1) % 4], pi = inner[e], qi = inner[(e + 1) % 4];
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const inx = (pi[0] + qi[0]) / 2 - (p[0] + q[0]) / 2, inz = (pi[1] + qi[1]) / 2 - (p[1] + q[1]) / 2;
        const il = Math.hypot(inx, inz) || 1;
        poly(S, [[p[0], hi, p[1]], [q[0], hi, q[1]], [qi[0], lo, qi[1]], [pi[0], lo, pi[1]]], [inx / il, 1, inz / il], tileC, s, Surf.Tile, 0, 0,
          [[0, il, L, il], [L, il, L, il], [L, 0, L, il], [0, 0, L, il]]);
        // The light well: the atrium's walls seen through the opening.
        const wl = Math.hypot(qi[0] - pi[0], qi[1] - pi[1]);
        wall(pi[0], pi[1], qi[0], qi[1], g, g, lo, lo, -inx / il, -inz / il, [0.55, 0.12, 0.08], s, Surf.Fresco, 0, 0, 0, wl, g, lo - g);
      }
      poly(S, inner.map((p): V3 => [p[0], g + 0.02, p[1]]), [0, 1, 0], [0.55, 0.38, 0.3], s, Surf.Pavement, 0, 0, inner.map((p) => [p[0], p[1], 0, 0]));
      lampSites.courts.push({ ring: inner.flat(), g, garden: false });
      const pool = inner.map((p): V3 => [mx + (p[0] - mx) * 0.6, g + 0.06, mz + (p[1] - mz) * 0.6]);
      poly(S, pool, [0, 1, 0], [0.2, 0.32, 0.34], s, Surf.Water, 0, 0, pool.map((p) => [p[0], p[2], 0, 0]));
    }
  }

  /** A peristyle walk along the back of a domus: columns and a lean-to roof. */
  function porticoBehind(c: [number, number], d: [number, number], g: number, top: number, ox: number, oz: number, tileC: RGB, seed: number): void {
    const L = Math.hypot(c[0] - d[0], c[1] - d[1]);
    if (L < 6) return;
    // Only where the garden is there to walk round: test a point out in it.
    const mx = (c[0] + d[0]) / 2 + ox * 6, mz = (c[1] + d[1]) / 2 + oz * 6;
    const insideOk = data.insulae.some((ins) => pointInRing(ins.ring, mx, mz));
    if (!insideOk) return;
    const W = 2.6, colH = 3.4;
    const tx = (c[0] - d[0]) / L, tz = (c[1] - d[1]) / L;
    const n = Math.max(2, Math.round(L / 2.8));
    for (let i = 0; i <= n; i++) {
      const t = 0.6 + ((L - 1.2) * i) / n;
      column(d[0] + tx * t + ox * W, d[1] + tz * t + oz * W, g, colH, 0.2, [0.86, 0.82, 0.74], seed, 6, hash(seed * 1e6, 21) < 0.7);
    }
    const y0 = Math.min(top - 0.3, g + colH + 1.3), y1 = g + colH + 0.25;
    const p0: V3 = [d[0], y0, d[1]], p1: V3 = [c[0], y0, c[1]];
    const p2: V3 = [c[0] + ox * (W + 0.4), y1, c[1] + oz * (W + 0.4)], p3: V3 = [d[0] + ox * (W + 0.4), y1, d[1] + oz * (W + 0.4)];
    poly(S, [p0, p1, p2, p3], [ox, 1, oz], tileC, seed, Surf.Tile, 0, 0, [[0, W, L, W], [L, W, L, W], [L, 0, L, W], [0, 0, L, W]]);
    poly(S, [p3, p2, [p2[0], y1 - 0.4, p2[2]], [p3[0], y1 - 0.4, p3[2]]], [ox, 0, oz], [0.86, 0.82, 0.74], seed, Surf.Stucco, 0, 0, uv4());
  }

  /**
   * A street facade with its openings: piers, lintels, and behind each
   * opening a recess (a shop's dark room with its counter, or a doorway with
   * the wooden door set back).
   */
  function facade(a: [number, number], b: [number, number], g: number, yBot: number, top: number, ox: number, oz: number,
    col: RGB, seed: number, p1: number, p2: number, openings: Opening[], depth: number): void {
    const fl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ex = (b[0] - a[0]) / fl, ez = (b[1] - a[1]) / fl;
    const P = (u: number): [number, number] => [a[0] + ex * u, a[1] + ez * u];
    const H = top - g;
    const sorted = [...openings].sort((p, q) => p.u0 - q.u0);
    let u = 0;
    for (const o of sorted) {
      if (o.u0 > u + 0.01) {
        const [x0, z0] = P(u), [x1, z1] = P(o.u0);
        wall(x0, z0, x1, z1, yBot, yBot, top, top, ox, oz, col, seed, Surf.Plaster, p1, p2, u, fl, g, H);
      }
      const [x0, z0] = P(o.u0), [x1, z1] = P(o.u1);
      // Lintel over the opening.
      wall(x0, z0, x1, z1, g + o.h, g + o.h, top, top, ox, oz, col, seed, Surf.Plaster, p1, p2, o.u0, fl, g, H);
      const rd = o.kind === "shop" ? Math.min(3.6, depth - 0.6) : 0.55;
      const ix = -ox * rd, iz = -oz * rd;
      const w = o.u1 - o.u0;
      const inC: RGB = o.kind === "shop" ? [0.62, 0.52, 0.4] : [0.6, 0.5, 0.42];
      lampSites.openings.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, g, ox, oz, ex, ez, w, h: o.h, depth: rd, kind: o.kind, counter: o.kind === "shop" && !lean });
      // Reveals, back, ceiling, floor.
      wall(x0, z0, x0 + ix, z0 + iz, g, g, g + o.h, g + o.h, ex, ez, inC, seed, Surf.Interior, 0, 0, 0, rd, g, o.h);
      wall(x1 + ix, z1 + iz, x1, z1, g, g, g + o.h, g + o.h, -ex, -ez, inC, seed, Surf.Interior, 0, 0, 0, rd, g, o.h);
      if (o.kind === "shop") {
        wall(x0 + ix, z0 + iz, x1 + ix, z1 + iz, g, g, g + o.h, g + o.h, ox, oz, inC, seed, Surf.Interior, 1, 0, 0, w, g, o.h);
        poly(S, [[x0, g + o.h, z0], [x1, g + o.h, z1], [x1 + ix, g + o.h, z1 + iz], [x0 + ix, g + o.h, z0 + iz]], [0, -1, 0], [0.4, 0.3, 0.22], seed, Surf.Wood, 0, 0, uv4());
        if (!lean) {
          // The masonry counter across part of the threshold, marble on top.
          const c0 = o.u0 + 0.15, c1 = o.u0 + w * 0.62;
          const [cx0, cz0] = P(c0), [cx1, cz1] = P(c1);
          const q = [cx0 - ox * 0.12, cz0 - oz * 0.12, cx1 - ox * 0.12, cz1 - oz * 0.12, cx1 - ox * 0.75, cz1 - oz * 0.75, cx0 - ox * 0.75, cz0 - oz * 0.75];
          box(q, g, g + 1.0, [0.7, 0.64, 0.56], seed, Surf.Marble, Surf.Marble, [0.85, 0.83, 0.78]);
        }
      } else {
        wall(x0 + ix, z0 + iz, x1 + ix, z1 + iz, g, g, g + o.h, g + o.h, ox, oz, [0.42, 0.27, 0.15], seed, Surf.Wood, 0, 0, 0, w, g, o.h);
        poly(S, [[x0, g + o.h, z0], [x1, g + o.h, z1], [x1 + ix, g + o.h, z1 + iz], [x0 + ix, g + o.h, z0 + iz]], [0, -1, 0], inC, seed, Surf.Interior, 0, 0, uv4());
      }
      poly(S, [[x0, g + 0.01, z0], [x1, g + 0.01, z1], [x1 + ix, g + 0.01, z1 + iz], [x0 + ix, g + 0.01, z0 + iz]], [0, 1, 0], [0.5, 0.45, 0.4], seed, Surf.Pavement, 0, 0, uv4());
      u = o.u1;
    }
    if (u < fl - 0.01) {
      const [x0, z0] = P(u);
      wall(x0, z0, b[0], b[1], yBot, yBot, top, top, ox, oz, col, seed, Surf.Plaster, p1, p2, u, fl, g, H);
    }
  }

  // =====================================================================================
  // Public buildings.
  // =====================================================================================
  const forum = data.publics.find((p) => p.kind === "forum");
  const forumC = forum ? ringCentroid(forum.ring) : null;
  for (let pi = 0; pi < data.publics.length; pi++) buildPublic(data.publics[pi], pi);

  function buildPublic(p: PompeiiPublic, pi: number): void {
    const r = cleanRing(p.ring) ?? p.ring;
    const seed = hash(pi, 77);
    const g = groundMin(r) + KERB_M;
    switch (p.kind) {
      case "forum": buildForum(r, g, seed); break;
      case "temple": buildTemple(p, r, seed); break;
      case "basilica": buildHall(r, g, 12, seed, true); break;
      case "hall": case "baths": buildCourtBuilding(r, g, p.kind === "baths" ? 9 : 8, seed); break;
      case "portico": case "palestra": buildPortico(r, g, seed, p.kind === "palestra"); break;
      case "theatre": buildTheatre(r, seed); break;
      case "odeon": buildHall(r, g, 12, seed, false); break;
      default: break;
    }
  }

  function groundMin(r: Ring): number {
    let m = Infinity;
    for (let i = 0; i < r.length; i += 2) m = Math.min(m, ground(r[i], r[i + 1]));
    return m;
  }

  /** Oriented box of a ring: centre, unit long axis, half extents. */
  function obb(r: Ring): { cx: number; cz: number; ux: number; uz: number; hu: number; hv: number } {
    let best: { cx: number; cz: number; ux: number; uz: number; hu: number; hv: number } | null = null;
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ex = r[((i + 1) % n) * 2] - r[i * 2], ez = r[((i + 1) % n) * 2 + 1] - r[i * 2 + 1];
      const L = Math.hypot(ex, ez);
      if (L < 1) continue;
      const ux = ex / L, uz = ez / L;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const u = r[k * 2] * ux + r[k * 2 + 1] * uz, v = -r[k * 2] * uz + r[k * 2 + 1] * ux;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const area = (u1 - u0) * (v1 - v0);
      if (!best || area < best.hu * best.hv * 4) {
        const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
        let o = { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2 };
        if (o.hv > o.hu) o = { cx: o.cx, cz: o.cz, ux: -uz, uz: ux, hu: o.hv, hv: o.hu };
        best = o;
      }
    }
    return best!;
  }
  function obbCorners(o: ReturnType<typeof obb>, hu = o.hu, hv = o.hv): number[] {
    const vx = -o.uz, vz = o.ux;
    const c = (u: number, v: number): [number, number] => [o.cx + o.ux * u + vx * v, o.cz + o.uz * u + vz * v];
    return [...c(-hu, -hv), ...c(hu, -hv), ...c(hu, hv), ...c(-hu, hv)];
  }

  /** A colonnade along a line, with an entablature and a lean-to roof back to `backY` on the outer side. */
  function colonnade(ax: number, az: number, bx: number, bz: number, y0: number, h: number, r: number, spacing: number,
    roofOutX: number, roofOutZ: number, roofW: number, backY: number, seed: number, c: RGB = [0.9, 0.87, 0.8], skip?: (x: number, z: number) => boolean): void {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 3) return;
    const tx = (bx - ax) / L, tz = (bz - az) / L;
    const n = Math.max(1, Math.round(L / spacing));
    for (let i = 0; i <= n; i++) {
      const x = ax + tx * (L * i) / n, z = az + tz * (L * i) / n;
      if (skip?.(x, z)) continue;
      column(x, z, y0, h, r, c, seed, lean ? 6 : 10);
    }
    // Entablature.
    const e0 = y0 + h, e1 = e0 + Math.max(0.6, h * 0.12);
    const q = [ax - roofOutX * 0.4, az - roofOutZ * 0.4, bx - roofOutX * 0.4, bz - roofOutZ * 0.4, bx + roofOutX * 0.4, bz + roofOutZ * 0.4, ax + roofOutX * 0.4, az + roofOutZ * 0.4];
    box(q, e0, e1, [0.88, 0.85, 0.78], seed, Surf.Stucco);
    if (roofW > 0) {
      const p0: V3 = [ax, e1, az], p1: V3 = [bx, e1, bz];
      const p2: V3 = [bx + roofOutX * roofW, backY, bz + roofOutZ * roofW], p3: V3 = [ax + roofOutX * roofW, backY, az + roofOutZ * roofW];
      poly(S, [p0, p1, p2, p3], [-roofOutX, 1, -roofOutZ], [0.62, 0.31, 0.2], seed, Surf.Tile, 0, 0, [[0, 0, L, roofW], [L, 0, L, roofW], [L, roofW, L, roofW], [0, roofW, L, roofW]]);
      poly(S, [p0, p1, p2, p3], [roofOutX * 0.2, -1, roofOutZ * 0.2], [0.45, 0.36, 0.28], seed, Surf.Wood, 0, 0, uv4());
    }
  }

  function buildForum(r: Ring, g: number, seed: number): void {
    // The travertine paving is drawn with the open ground (see the floor
    // grid), following the terrain, so everything standing on it takes its
    // height from the ground where it stands rather than the square's lowest
    // corner. Two-storey colonnade round the edges, set in 4 m, except where
    // the temples stand at the ends.
    void g;
    const temples = data.publics.filter((q) => q.kind === "temple").map((q) => q.ring);
    const inTemple = (x: number, z: number): boolean => temples.some((t) => pointInRing(t, x, z) || distToRing(t, x, z) < 4);
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 10) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      const ins = 5.5;
      const x0 = ax + nx * ins + tx * ins, z0 = az + nz * ins + tz * ins, x1 = bx + nx * ins - tx * ins, z1 = bz + nz * ins - tz * ins;
      const g = Math.min(ground(x0, z0), ground(x1, z1)) + KERB_M;
      colonnade(x0, z0, x1, z1, g, 6.2, 0.42, 3.2, -nx, -nz, ins, g + 9.5, seed, [0.9, 0.87, 0.8], inTemple);
      if (!lean) colonnade(x0, z0, x1, z1, g + 6.95, 4.4, 0.3, 3.2, -nx, -nz, ins, g + 13.4, seed, [0.9, 0.87, 0.8], inTemple);
      // The back wall the portico roofs lean on.
      wall(ax, az, bx, bz, g - 0.4, g - 0.4, g + 13.4, g + 13.4, nx, nz, [0.88, 0.84, 0.74], seed, Surf.Stucco, 0, 0, 0, L, g, 13.4);
    }
    // Statue bases down the long axis.
    if (!lean) {
      const o = obb(r);
      for (let k = -3; k <= 3; k++) {
        if (k === 0) continue;
        const x = o.cx + o.ux * k * (o.hu / 4.5) - o.uz * (o.hv * 0.55), z = o.cz + o.uz * k * (o.hu / 4.5) + o.ux * (o.hv * 0.55);
        const q = [x - 0.9, z - 0.7, x + 0.9, z - 0.7, x + 0.9, z + 0.7, x - 0.9, z + 0.7];
        const g = ground(x, z) + KERB_M;
        box(q, g - 0.3, g + 2.2, [0.86, 0.84, 0.8], seed, Surf.Marble);
        // A bronze figure on the base: a draped body and a head.
        column(x, z, g + 2.2, 1.55, 0.3, [0.24, 0.2, 0.14], seed, 8);
        column(x, z, g + 3.75, 0.3, 0.13, [0.24, 0.2, 0.14], seed, 6);
      }
    }
  }

  function buildTemple(p: PompeiiPublic, r: Ring, seed: number): void {
    const area = ringArea(r);
    const o = obb(r);
    const g = groundMin(r) + KERB_M;
    // Which end is the front: towards the forum when it is near, else south.
    let front = 1;
    if (forumC && Math.hypot(forumC[0] - o.cx, forumC[1] - o.cz) < 150) {
      front = (forumC[0] - o.cx) * o.ux + (forumC[1] - o.cz) * o.uz > 0 ? 1 : -1;
      // The temple of Jupiter stands at the forum's north end facing down it;
      // inside the forum the near end is the back, which the rule gets right.
    } else front = o.uz > 0 ? 1 : -1;
    let t = o;
    if (area > 900) {
      // A sanctuary (Apollo): portico round the precinct, the temple inside.
      buildPortico(r, g, seed, false);
      t = { ...o, hu: Math.min(o.hu * 0.45, 17), hv: Math.min(o.hv * 0.38, 9) };
    }
    const podium = p.name.includes("Giove") ? 3.2 : 2.2;
    const H = p.name.includes("Giove") ? 12 : 9;
    const fx = t.ux * front, fz = t.uz * front;
    // Podium.
    box(obbCorners(t), g - 0.5, g + podium, [0.85, 0.82, 0.75], seed, Surf.Stucco, Surf.Marble, [0.86, 0.84, 0.8]);
    // Steps on the front, half the width.
    const steps = Math.ceil(podium / 0.3);
    for (let k = 0; k < steps; k++) {
      const du = t.hu + (steps - k) * 0.35;
      const q = obbCorners({ ...t, cx: t.cx + fx * (du - 0.35 / 2), cz: t.cz + fz * (du - 0.35 / 2), hu: 0.18 + 0.01 }, 0.18, t.hv * 0.62);
      box(q, g - 0.5, g + (k + 1) * (podium / steps), [0.86, 0.84, 0.78], seed, Surf.Marble);
    }
    // Cella in the back 58%, a gable roof running the long axis with a pediment front.
    const cellaHu = t.hu * 0.58;
    const cc = { ...t, cx: t.cx - fx * (t.hu - cellaHu), cz: t.cz - fz * (t.hu - cellaHu), hu: cellaHu - 0.3, hv: t.hv - 0.8 };
    const cq = obbCorners(cc);
    const y0 = g + podium;
    box(cq, y0, y0 + H, [0.88, 0.85, 0.78], seed, Surf.Stucco);
    // Columns across the pronaos: 6 across the front, 2 deep.
    const across = 6;
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < across; k++) {
        if (row > 0 && k > 0 && k < across - 1) continue;
        const v = -t.hv + 0.9 + ((2 * t.hv - 1.8) * k) / (across - 1);
        const u = t.hu - 0.9 - row * ((t.hu - cellaHu * 2 + 0.4) / 2 + 1.2);
        column(t.cx + fx * u - t.uz * v * 1, t.cz + fz * u + t.ux * v * 1, y0, H, Math.min(0.55, t.hv * 0.07), [0.9, 0.88, 0.82], seed, lean ? 8 : 12);
      }
    }
    // Roof over cella and pronaos.
    const rise = t.hv * 0.42;
    const top = y0 + H + 0.9;
    box(obbCorners(t, t.hu, t.hv), y0 + H, top, [0.88, 0.85, 0.78], seed, Surf.Stucco);
    const vx = -t.uz, vz = t.ux;
    const pt = (u: number, v: number, y: number): V3 => [t.cx + t.ux * u + vx * v, y, t.cz + t.uz * u + vz * v];
    const hu = t.hu + 0.4, hv = t.hv + 0.4;
    poly(S, [pt(-hu, -hv, top), pt(hu, -hv, top), pt(hu, 0, top + rise), pt(-hu, 0, top + rise)], [-vx, 1, -vz], [0.64, 0.32, 0.2], seed, Surf.Tile, 0, 0,
      [[0, 0, 2 * hu, hv], [2 * hu, 0, 2 * hu, hv], [2 * hu, hv, 2 * hu, hv], [0, hv, 2 * hu, hv]]);
    poly(S, [pt(-hu, hv, top), pt(hu, hv, top), pt(hu, 0, top + rise), pt(-hu, 0, top + rise)], [vx, 1, vz], [0.64, 0.32, 0.2], seed, Surf.Tile, 0, 0,
      [[0, 0, 2 * hu, hv], [2 * hu, 0, 2 * hu, hv], [2 * hu, hv, 2 * hu, hv], [0, hv, 2 * hu, hv]]);
    for (const s of [1, -1]) {
      poly(S, [pt(s * t.hu, -t.hv, top), pt(s * t.hu, t.hv, top), pt(s * t.hu, 0, top + rise)], [t.ux * s, 0, t.uz * s], [0.9, 0.87, 0.8], seed, Surf.Stucco, 0, 0, uv4());
    }
    solids.push({ ring: obbCorners(t), baseY: g - 0.5, topY: top + rise });
  }

  /** A roofed hall on the outline's oriented box (basilica, odeon). */
  function buildHall(r: Ring, g: number, H: number, seed: number, porch: boolean): void {
    const o = obb(r);
    const q = obbCorners(o, o.hu - 0.5, o.hv - 0.5);
    box(q, g - 0.5, g + H, [0.87, 0.84, 0.76], seed, Surf.Stucco);
    const rise = Math.min(5, o.hv * TAN_PITCH);
    const vx = -o.uz, vz = o.ux;
    const top = g + H;
    const pt = (u: number, v: number, y: number): V3 => [o.cx + o.ux * u + vx * v, y, o.cz + o.uz * u + vz * v];
    const hu = o.hu, hv = o.hv;
    poly(S, [pt(-hu, -hv, top), pt(hu, -hv, top), pt(hu, 0, top + rise), pt(-hu, 0, top + rise)], [-vx, 1, -vz], [0.63, 0.31, 0.2], seed, Surf.Tile, 0, 0,
      [[0, 0, 2 * hu, hv], [2 * hu, 0, 2 * hu, hv], [2 * hu, hv, 2 * hu, hv], [0, hv, 2 * hu, hv]]);
    poly(S, [pt(-hu, hv, top), pt(hu, hv, top), pt(hu, 0, top + rise), pt(-hu, 0, top + rise)], [vx, 1, vz], [0.63, 0.31, 0.2], seed, Surf.Tile, 0, 0,
      [[0, 0, 2 * hu, hv], [2 * hu, 0, 2 * hu, hv], [2 * hu, hv, 2 * hu, hv], [0, hv, 2 * hu, hv]]);
    for (const s of [1, -1]) {
      poly(S, [pt(s * (hu - 0.5), -hv + 0.5, top), pt(s * (hu - 0.5), hv - 0.5, top), pt(s * (hu - 0.5), 0, top + rise)], [o.ux * s, 0, o.uz * s], [0.88, 0.85, 0.78], seed, Surf.Stucco, 0, 0, uv4());
    }
    if (porch && forumC) {
      // Columns across the end that faces the forum.
      const s = (forumC[0] - o.cx) * o.ux + (forumC[1] - o.cz) * o.uz > 0 ? 1 : -1;
      for (let k = 0; k < 5; k++) {
        const v = -o.hv + 2 + ((2 * o.hv - 4) * k) / 4;
        const p = pt(s * (o.hu + 1.2), v, 0);
        column(p[0], p[2], g, 8, 0.5, [0.9, 0.88, 0.82], seed);
      }
    }
    solids.push({ ring: q, baseY: g - 0.5, topY: top + rise });
  }

  /** Ranges of rooms round an open court: baths, the macellum, the granaries. */
  function buildCourtBuilding(r: Ring, g: number, H: number, seed: number): void {
    const ring = cleanRing(r);
    if (!ring) return;
    const n = ring.length / 2;
    const o = obb(ring);
    const D = Math.min(11, Math.min(o.hu, o.hv) * 0.4);
    // One range per OBB side, as four lots.
    const c = obbCorners(o, o.hu - 0.3, o.hv - 0.3);
    const cc = [c.slice(0, 2), c.slice(2, 4), c.slice(4, 6), c.slice(6, 8)] as [number, number][];
    const inner = obbCorners(o, o.hu - 0.3 - D, o.hv - 0.3 - D);
    const ic = [inner.slice(0, 2), inner.slice(2, 4), inner.slice(4, 6), inner.slice(6, 8)] as [number, number][];
    const col: RGB = [0.86, 0.8, 0.66];
    const tileC: RGB = [0.62, 0.3, 0.2];
    for (let e = 0; e < 4; e++) {
      let a = cc[e], b = cc[(e + 1) % 4];
      const bi = ic[(e + 1) % 4], ai = ic[e];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (e % 2 === 1) {
        // The short ranges run between the long ones: trimmed by their depth.
        const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
        a = [a[0] + tx * D, a[1] + tz * D];
        b = [b[0] - tx * D, b[1] - tz * D];
      }
      const Lb = Math.hypot(b[0] - a[0], b[1] - a[1]);
      band(a, b, bi, ai, g, g - 0.5, e % 2 ? H - 1 : H, "gable", col, tileC, seed, 100, 255,
        e % 2 ? [] : [{ u0: Lb / 2 - 1.2, u1: Lb / 2 + 1.2, h: 4, kind: "door" }], e % 2 === 0);
    }
    // The court: beaten earth with a basin, or the palaestra's sand.
    const ip = ic.map((p): V3 => [p[0], g + 0.03, p[1]]);
    poly(S, ip, [0, 1, 0], [0.7, 0.6, 0.45], seed, Surf.Sand, 0, 0, ip.map((p) => [p[0], p[2], 0, 0]));
    void n;
    solids.push({ ring: c, baseY: g - 0.5, topY: g + H + 2 });
  }

  /** An open court with a colonnade round it: palaestra, Foro Triangolare, the quadriporticus. */
  function buildPortico(r: Ring, g: number, seed: number, pool: boolean): void {
    const ring = cleanRing(r) ?? r;
    const n = ring.length / 2;
    const tri = triangulateRing(new Float32Array(ring));
    const base = S.n;
    for (let i = 0; i < ring.length; i += 2) S.vert([ring[i], g + 0.04, ring[i + 1]], [0, 1, 0], pool ? [0.34, 0.4, 0.2] : [0.72, 0.64, 0.5], seed, pool ? Surf.Garden : Surf.Sand, 0, 0, [ring[i], ring[i + 1], 0, 0]);
    for (let k = 0; k < tri.length; k += 3) S.tri(base + tri[k], base + tri[k + 2], base + tri[k + 1]);
    for (let i = 0; i < n; i++) {
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[((i + 1) % n) * 2], bz = ring[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 6) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L, tx = (bx - ax) / L, tz = (bz - az) / L;
      const ins = 5;
      colonnade(ax + nx * ins + tx * ins, az + nz * ins + tz * ins, bx + nx * ins - tx * ins, bz + nz * ins - tz * ins, g, 5.2, 0.32, 3.4, -nx, -nz, ins, g + 7.6, seed);
      wall(ax, az, bx, bz, g - 0.4, g - 0.4, g + 7.8, g + 7.8, -nx, -nz, [0.86, 0.8, 0.68], seed, Surf.Plaster, 100, 255, 0, L, g, 7.8);
      wall(bx, bz, ax, az, g - 0.4, g - 0.4, g + 7.8, g + 7.8, nx, nz, [0.86, 0.8, 0.68], seed, Surf.Plaster, 100, 255, 0, L, g, 7.8);
    }
    if (pool) {
      // The Palestra Grande's swimming pool, 35 x 22 m, in the middle.
      const o = obb(ring);
      const q = obbCorners(o, 17.5, 11);
      const pts = [0, 1, 2, 3].map((k): V3 => [q[k * 2], g + 0.08, q[k * 2 + 1]]);
      poly(S, pts, [0, 1, 0], [0.18, 0.34, 0.38], seed, Surf.Water, 0, 0, pts.map((p) => [p[0], p[2], 0, 0]));
    }
  }

  function buildTheatre(r: Ring, seed: number): void {
    // The cavea opens to the south, with the stage building along its chord.
    const o = obb(r);
    // Chord along whichever OBB axis is more east-west; the bowl is north of it.
    let ax = o.ux, az = o.uz;
    if (Math.abs(az) > Math.abs(ax)) { ax = -o.uz; az = o.ux; }
    if (ax < 0) { ax = -ax; az = -az; }
    let nx = -az, nz = ax;
    if (nz > 0) { nx = -nx; nz = -nz; }
    const R = Math.max(o.hu, o.hv) * 0.98;
    const cx = o.cx - nx * (R * 0.35), cz = o.cz - nz * (R * 0.35);
    const g0 = ground(cx, cz) + KERB_M;
    const orch = R * 0.3;
    const rows = lean ? 10 : 22;
    const segs = lean ? 16 : 28;
    const topY = g0 + 12;
    for (let k = 0; k < rows; k++) {
      const r0 = orch + ((R - orch) * k) / rows, r1 = orch + ((R - orch) * (k + 1)) / rows;
      const y = g0 + 1 + ((topY - g0 - 1) * (k + 1)) / rows, yPrev = g0 + 1 + ((topY - g0 - 1) * k) / rows;
      for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * Math.PI, a1 = ((s + 1) / segs) * Math.PI;
        const P = (rad: number, a: number, yy: number): V3 => [cx + (ax * Math.cos(a) + nx * Math.sin(a)) * rad, yy, cz + (az * Math.cos(a) + nz * Math.sin(a)) * rad];
        poly(S, [P(r0, a0, y), P(r1, a0, y), P(r1, a1, y), P(r0, a1, y)], [0, 1, 0], [0.8, 0.76, 0.66], seed, Surf.Marble, 0, 0, uv4());
        const am = (a0 + a1) / 2;
        poly(S, [P(r0, a0, yPrev), P(r0, a1, yPrev), P(r0, a1, y), P(r0, a0, y)], [-(ax * Math.cos(am) + nx * Math.sin(am)), 0, -(az * Math.cos(am) + nz * Math.sin(am))], [0.7, 0.66, 0.58], seed, Surf.Marble, 0, 0, uv4());
      }
    }
    // Outer wall round the bowl.
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI, a1 = ((s + 1) / segs) * Math.PI, am = (a0 + a1) / 2;
      const P = (a: number): [number, number] => [cx + (ax * Math.cos(a) + nx * Math.sin(a)) * R, cz + (az * Math.cos(a) + nz * Math.sin(a)) * R];
      const [x0, z0] = P(a0), [x1, z1] = P(a1);
      const ux = ax * Math.cos(am) + nx * Math.sin(am), uz = az * Math.cos(am) + nz * Math.sin(am);
      wall(x0, z0, x1, z1, g0 - 2, g0 - 2, topY + 1.5, topY + 1.5, ux, uz, [0.78, 0.72, 0.6], seed, Surf.Masonry, 0, 0, (s * R * Math.PI) / segs, R * Math.PI, g0, topY + 1.5 - g0);
    }
    // Orchestra and the stage building with its two-storey columned front.
    const op: V3[] = [];
    for (let s = 0; s <= 12; s++) {
      const a = (s / 12) * Math.PI;
      op.push([cx + (ax * Math.cos(a) + nx * Math.sin(a)) * orch, g0 + 0.05, cz + (az * Math.cos(a) + nz * Math.sin(a)) * orch]);
    }
    poly(S, op, [0, 1, 0], [0.82, 0.8, 0.74], seed, Surf.Marble, 0, 0, op.map((p) => [p[0], p[2], 0, 0]));
    const stage = [cx - ax * R * 0.95, cz - az * R * 0.95, cx + ax * R * 0.95, cz + az * R * 0.95,
      cx + ax * R * 0.95 - nx * 9, cz + az * R * 0.95 - nz * 9, cx - ax * R * 0.95 - nx * 9, cz - az * R * 0.95 - nz * 9];
    box([stage[0] - nx * 1, stage[1] - nz * 1, stage[2] - nx * 1, stage[3] - nz * 1, stage[4] + nx * 0, stage[5], stage[6], stage[7]], g0, g0 + 1.5, [0.5, 0.36, 0.24], seed, Surf.Wood);
    const sb = [stage[0] - nx * 4, stage[1] - nz * 4, stage[2] - nx * 4, stage[3] - nz * 4, stage[4], stage[5], stage[6], stage[7]];
    box(sb, g0, topY + 2, [0.86, 0.82, 0.72], seed, Surf.Stucco);
    colonnade(stage[0] - nx * 3, stage[1] - nz * 3, stage[2] - nx * 3, stage[3] - nz * 3, g0 + 1.5, 5.5, 0.35, 3, -nx, -nz, 0, 0, seed);
    if (!lean) colonnade(stage[0] - nx * 3, stage[1] - nz * 3, stage[2] - nx * 3, stage[3] - nz * 3, g0 + 7.7, 4.5, 0.3, 3, -nx, -nz, 0, 0, seed);
    solids.push({ ring: sb, baseY: g0, topY: topY + 2 });
  }

  let amphY = { floor: 0, rim: 0 };
  // --- the amphitheatre ----------------------------------------------------------------
  {
    const a = amph;
    const ux = Math.cos(a.rot), uz = Math.sin(a.rot), vx = -uz, vz = ux;
    const E = (ka: number, kb: number, t: number): [number, number] => [a.cx + ux * Math.cos(t) * ka + vx * Math.sin(t) * kb, a.cz + uz * Math.cos(t) * ka + vz * Math.sin(t) * kb];
    // The arena floor is dug AMPHI.dig below the ground round the building
    // (digAmphitheatre lowers the terrain to match), so the lower cavea sits
    // in the ground and the outer wall stands only 8 m over the street. The
    // rim is measured outside the wall, where the terrain was left alone.
    let rim = 0;
    for (let k = 0; k < 16; k++) {
      const [x, z] = E(AMPHI.a + 6, AMPHI.b + 6, (k / 16) * Math.PI * 2);
      rim += ground(x, z) / 16;
    }
    const g0 = rim - AMPHI.dig;
    amphY = { floor: g0, rim };
    const segs = lean ? 40 : 72;
    const seed = 0.37;
    // Arena sand.
    const ap: V3[] = [];
    for (let s = 0; s < segs; s++) {
      const [x, z] = E(AMPHI.arenaA, AMPHI.arenaB, (s / segs) * Math.PI * 2);
      ap.push([x, g0, z]);
    }
    poly(S, ap, [0, 1, 0], [0.78, 0.66, 0.46], seed, Surf.Sand, 0, 0, ap.map((p) => [p[0], p[2], 0, 0]));
    // Podium wall, painted.
    for (let s = 0; s < segs; s++) {
      const t0 = (s / segs) * Math.PI * 2, t1 = ((s + 1) / segs) * Math.PI * 2;
      const [x0, z0] = E(AMPHI.arenaA, AMPHI.arenaB, t0), [x1, z1] = E(AMPHI.arenaA, AMPHI.arenaB, t1);
      const tm = (t0 + t1) / 2;
      const [mx, mz] = E(AMPHI.arenaA, AMPHI.arenaB, tm);
      const inx = a.cx - mx, inz = a.cz - mz, il = Math.hypot(inx, inz);
      wall(x0, z0, x1, z1, g0 - 0.2, g0 - 0.2, g0 + AMPHI.podium, g0 + AMPHI.podium, inx / il, inz / il, [0.84, 0.8, 0.7], seed, Surf.Fresco, 0, 0, s * 3, segs * 3, g0, AMPHI.podium);
    }
    // The cavea: tiers stepping from the podium to the top.
    const tiers = lean ? 13 : AMPHI.tiers;
    const y0 = g0 + AMPHI.podium, y1 = g0 + AMPHI.top;
    for (let k = 0; k < tiers; k++) {
      const f0 = k / tiers, f1 = (k + 1) / tiers;
      const ka0 = lerp(AMPHI.arenaA, AMPHI.a - 1.5, f0), kb0 = lerp(AMPHI.arenaB, AMPHI.b - 1.5, f0);
      const ka1 = lerp(AMPHI.arenaA, AMPHI.a - 1.5, f1), kb1 = lerp(AMPHI.arenaB, AMPHI.b - 1.5, f1);
      const yt = lerp(y0, y1, f1), yp = lerp(y0, y1, f0);
      for (let s = 0; s < segs; s++) {
        const t0 = (s / segs) * Math.PI * 2, t1 = ((s + 1) / segs) * Math.PI * 2;
        const [ax0, az0] = E(ka0, kb0, t0), [ax1, az1] = E(ka0, kb0, t1), [bx0, bz0] = E(ka1, kb1, t0), [bx1, bz1] = E(ka1, kb1, t1);
        // Every eighth tier a little darker: the praecinctio gangways. Every
        // ninth wedge a stair aisle (scalaria) in the paler limestone.
        const shade = k % 8 === 7 ? 0.82 : 1;
        const aisle = s % 9 === 0;
        const top: RGB = aisle ? [0.84, 0.8, 0.7] : [0.76 * shade, 0.68 * shade, 0.55 * shade];
        // Tread coordinates (u round the ring, v back from the nosing) so the
        // shader can draw the shadow line under each step edge.
        const tl = Math.hypot(ax1 - ax0, az1 - az0), td = Math.hypot(bx0 - ax0, bz0 - az0);
        poly(S, [[ax0, yt, az0], [ax1, yt, az1], [bx1, yt, bz1], [bx0, yt, bz0]], [0, 1, 0], top, seed, Surf.Kerb, 0, 0,
          [[s * tl, 0, tl, td], [(s + 1) * tl, 0, tl, td], [(s + 1) * tl, td, tl, td], [s * tl, td, tl, td]]);
        const tm = (t0 + t1) / 2;
        const [mx, mz] = E(ka0, kb0, tm);
        const inx = a.cx - mx, inz = a.cz - mz, il = Math.hypot(inx, inz);
        poly(S, [[ax0, yp, az0], [ax1, yp, az1], [ax1, yt, az1], [ax0, yt, az0]], [inx / il, 0, inz / il], aisle ? [0.7, 0.66, 0.58] : [0.55, 0.48, 0.38], seed, Surf.Kerb, 0, 0, uv4());
      }
    }
    // Outer facade: blind arcades in the shader, a parapet on top.
    for (let s = 0; s < segs; s++) {
      const t0 = (s / segs) * Math.PI * 2, t1 = ((s + 1) / segs) * Math.PI * 2;
      const [x0, z0] = E(AMPHI.a, AMPHI.b, t0), [x1, z1] = E(AMPHI.a, AMPHI.b, t1);
      const [mx, mz] = E(AMPHI.a, AMPHI.b, (t0 + t1) / 2);
      const ox = mx - a.cx, oz = mz - a.cz, ol = Math.hypot(ox, oz);
      const L = Math.hypot(x1 - x0, z1 - z0);
      const gg = Math.min(ground(x0, z0), ground(x1, z1));
      wall(x0, z0, x1, z1, gg - 0.5, gg - 0.5, y1 + 1.2, y1 + 1.2, ox / ol, oz / ol, [0.76, 0.7, 0.58], seed, Surf.Masonry, 1, 0, s * L, segs * L, gg, y1 + 1.2 - gg);
      // The walk round the top, from the last tier out to the parapet.
      const [ix0, iz0] = E(AMPHI.a - 1.5, AMPHI.b - 1.5, t0), [ix1, iz1] = E(AMPHI.a - 1.5, AMPHI.b - 1.5, t1);
      poly(S, [[ix0, y1, iz0], [ix1, y1, iz1], [x1, y1, z1], [x0, y1, z0]], [0, 1, 0], [0.7, 0.66, 0.56], seed, Surf.Marble, 0, 0, uv4());
      wall(ix1, iz1, ix0, iz0, y1, y1, y1 + 1.2, y1 + 1.2, -ox / ol, -oz / ol, [0.74, 0.68, 0.56], seed, Surf.Masonry, 0, 0, 0, L, y1, 1.2);
    }
    // The external stairs: paired ramps up the west face, and one pair at
    // each end of the long axis, as on the surviving building.
    for (const t of [Math.PI * 0.75, Math.PI * 1.25, Math.PI * 0.5, Math.PI * 1.5]) {
      const [px, pz] = E(AMPHI.a, AMPHI.b, t);
      const [qx, qz] = E(AMPHI.a, AMPHI.b, t + 0.001);
      const tx = qx - px, tz = qz - pz, tl = Math.hypot(tx, tz);
      const dx = tx / tl, dz = tz / tl;
      const ox = -dz, oz = dx;
      // Outward is away from the centre.
      const sgn = (px - a.cx) * ox + (pz - a.cz) * oz > 0 ? 1 : -1;
      const nox = ox * sgn, noz = oz * sgn;
      for (const dir of [1, -1]) {
        const run = 20, w = 3.2;
        const sx = px + dx * dir * 2, sz = pz + dz * dir * 2;
        const ex = sx + dx * dir * run, ez = sz + dz * dir * run;
        const gs = ground(sx, sz);
        // A sloped block: top rising from the ground at the far end to the
        // walk at the facade, on its own retaining wall.
        if (lean) {
          const q: V3[] = [[ex, gs, ez], [ex + nox * w, gs, ez + noz * w], [sx + nox * w, y1, sz + noz * w], [sx, y1, sz]];
          poly(S, q, [0, 1, 0], [0.7, 0.66, 0.56], seed, Surf.Marble, 0, 0, uv4());
        } else {
          // Steps a third of a metre high, each a block down to the ground.
          const N = Math.max(4, Math.round((y1 - gs) / 0.34));
          for (let k = 0; k < N; k++) {
            const d0 = (run * k) / N, d1 = (run * (k + 1)) / N;
            const p0x = ex - dx * dir * d0, p0z = ez - dz * dir * d0, p1x = ex - dx * dir * d1, p1z = ez - dz * dir * d1;
            box([p0x, p0z, p1x, p1z, p1x + nox * w, p1z + noz * w, p0x + nox * w, p0z + noz * w], gs - 0.5, gs + ((y1 - gs) * (k + 1)) / N,
              [0.72, 0.66, 0.55], seed, Surf.Kerb, Surf.Kerb, [0.74, 0.7, 0.6]);
          }
        }
        wall(ex + nox * w, ez + noz * w, sx + nox * w, sz + noz * w, gs - 0.5, gs - 0.5, gs, y1, nox, noz, [0.72, 0.66, 0.55], seed, Surf.Masonry, 0, 0, 0, run, gs, y1 - gs);
        poly(S, [[sx, gs - 0.5, sz], [sx + nox * w, gs - 0.5, sz + noz * w], [sx + nox * w, y1, sz + noz * w], [sx, y1, sz]], [dx * dir, 0, dz * dir], [0.72, 0.66, 0.55], seed, Surf.Masonry, 0, 0, uv4());
      }
    }
    solids.push({ ring: Array.from({ length: 24 }, (_, i) => E(AMPHI.a, AMPHI.b, (i / 24) * Math.PI * 2)).flat(), baseY: g0 - 1, topY: y1 + 1.2 });
  }

  // =====================================================================================
  // The walls, their towers and gates.
  // =====================================================================================
  {
    const r = wallRing;
    const n = r.length / 2;
    const [wcx, wcz] = ringCentroid(r);
    const gates = data.gates;
    const WALL_H = 8.5, HALF_T = 2.2;
    const nearGate = (x: number, z: number): boolean => gates.some((gt) => Math.hypot(gt.x - x, gt.z - z) < 7);
    const wc: RGB = [0.7, 0.64, 0.52];
    let along = 0;
    for (let i = 0; i < n; i++) {
      const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.2) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      // Out of the town: right of a positive-area ring.
      const ox = tz, oz = -tx;
      // Walk the edge in ~6 m pieces so a gate can open a gap in it.
      const pieces = Math.max(1, Math.ceil(L / 6));
      for (let k = 0; k < pieces; k++) {
        const s0 = (L * k) / pieces, s1 = (L * (k + 1)) / pieces;
        const x0 = ax + tx * s0, z0 = az + tz * s0, x1 = ax + tx * s1, z1 = az + tz * s1;
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        if (nearGate(mx, mz)) continue;
        const g0 = ground(x0, z0), g1 = ground(x1, z1);
        // Outer face (tuff blocks), inner face, and the wall walk.
        wall(x0 + ox * HALF_T, z0 + oz * HALF_T, x1 + ox * HALF_T, z1 + oz * HALF_T, g0 - 4, g1 - 4, g0 + WALL_H, g1 + WALL_H, ox, oz, wc, 0.5, Surf.Masonry, 2, 0, along + s0, 1e4, Math.min(g0, g1) - 4, WALL_H + 4);
        wall(x1 - ox * HALF_T, z1 - oz * HALF_T, x0 - ox * HALF_T, z0 - oz * HALF_T, g1 - 1, g0 - 1, g1 + WALL_H - 1.2, g0 + WALL_H - 1.2, -ox, -oz, wc, 0.5, Surf.Masonry, 2, 0, along + s0, 1e4, Math.min(g0, g1), WALL_H);
        poly(S, [[x0 + ox * HALF_T, g0 + WALL_H - 1.2, z0 + oz * HALF_T], [x1 + ox * HALF_T, g1 + WALL_H - 1.2, z1 + oz * HALF_T], [x1 - ox * HALF_T, g1 + WALL_H - 1.2, z1 - oz * HALF_T], [x0 - ox * HALF_T, g0 + WALL_H - 1.2, z0 - oz * HALF_T]],
          [0, 1, 0], [0.6, 0.56, 0.48], 0.5, Surf.Kerb, 0, 0, uv4());
        // Merlons along the outer edge.
        if (!lean) {
          for (let s = s0 + 1; s < s1 - 0.5; s += 2.6) {
            const mx0 = ax + tx * s + ox * (HALF_T - 0.6), mz0 = az + tz * s + oz * (HALF_T - 0.6);
            const q = [mx0, mz0, mx0 + tx * 1.3, mz0 + tz * 1.3, mx0 + tx * 1.3 + ox * 0.6, mz0 + tz * 1.3 + oz * 0.6, mx0 + ox * 0.6, mz0 + oz * 0.6];
            const gm = ground(mx0, mz0);
            box(q, gm + WALL_H - 1.2, gm + WALL_H + 0.6, wc, 0.5, Surf.Masonry);
          }
        }
      }
      along += L;
    }
    // Towers: the twelve the survey numbers (Torre I to XII, from the
    // south-east round by the east and north to the Porta di Ercolano), each
    // on the wall line nearest its mapped outline. A pack without them gets
    // twelve spread along the north and east, where the walls faced the open
    // approach.
    const towerAt: [number, number, number][] = [];
    if (data.towers?.length) {
      for (const t of data.towers) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < n; i++) {
          const d = distSeg(t.x, t.z, r[i * 2], r[i * 2 + 1], r[((i + 1) % n) * 2], r[((i + 1) % n) * 2 + 1]);
          if (d < bd) { bd = d; best = i; }
        }
        const ax = r[best * 2], az = r[best * 2 + 1], bx = r[((best + 1) % n) * 2], bz = r[((best + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az) || 1;
        const s = Math.max(0, Math.min(L, ((t.x - ax) * (bx - ax) + (t.z - az) * (bz - az)) / L));
        towerAt.push([best, s, L]);
      }
    } else {
      let perim = 0;
      for (let i = 0; i < n; i++) perim += Math.hypot(r[((i + 1) % n) * 2] - r[i * 2], r[((i + 1) % n) * 2 + 1] - r[i * 2 + 1]);
      let acc = 0, next = 60;
      for (let i = 0; i < n && towerAt.length < 12; i++) {
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        while (acc + L >= next && towerAt.length < 12) {
          const s = next - acc;
          next += perim / 24;
          const x = ax + ((bx - ax) * s) / L, z = az + ((bz - az) * s) / L;
          if ((z < wcz - 60 || x > wcx + 350) && !gates.some((gt) => Math.hypot(gt.x - x, gt.z - z) < 25)) towerAt.push([i, s, L]);
        }
        acc += L;
      }
    }
    for (const [i, s, L] of towerAt) {
      const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
      {
        const x = ax + ((bx - ax) * s) / L, z = az + ((bz - az) * s) / L;
        const tx = (bx - ax) / L, tz = (bz - az) / L, ox = tz, oz = -tx;
        const q = [x - tx * 4 - ox * 4, z - tz * 4 - oz * 4, x + tx * 4 - ox * 4, z + tz * 4 - oz * 4, x + tx * 4 + ox * 6, z + tz * 4 + oz * 6, x - tx * 4 + ox * 6, z - tz * 4 + oz * 6];
        const gt = ground(x, z);
        box(q, gt - 4, gt + 14, [0.72, 0.66, 0.54], 0.6, Surf.Masonry, Surf.Kerb, [0.6, 0.56, 0.48]);
        // A tiled pyramid cap.
        const top = gt + 14;
        const apex: V3 = [x + ox * 1, top + 2.4, z + oz * 1];
        for (let e = 0; e < 4; e++) {
          const p = [q[e * 2], q[e * 2 + 1]], qq = [q[((e + 1) % 4) * 2], q[((e + 1) % 4) * 2 + 1]];
          const mx = (p[0] + qq[0]) / 2 - apex[0], mz = (p[1] + qq[1]) / 2 - apex[2];
          poly(S, [[p[0], top, p[1]], [qq[0], top, qq[1]], apex], [mx, 2, mz], [0.6, 0.3, 0.19], 0.6, Surf.Tile, 0, 0, [[0, 0, 8, 4], [8, 0, 8, 4], [4, 4, 8, 4]]);
        }
        solids.push({ ring: q, baseY: gt - 4, topY: top + 2.4 });
        stats.towers++;
      }
    }
    // Gates: two piers and a vault over the road.
    for (const gt of gates) {
      // The wall's direction at the gate.
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = distSeg(gt.x, gt.z, r[i * 2], r[i * 2 + 1], r[((i + 1) % n) * 2], r[((i + 1) % n) * 2 + 1]);
        if (d < bd) { bd = d; best = i; }
      }
      const ax = r[best * 2], az = r[best * 2 + 1], bx = r[((best + 1) % n) * 2], bz = r[((best + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const tx = (bx - ax) / L, tz = (bz - az) / L, ox = tz, oz = -tx;
      const g = ground(gt.x, gt.z);
      const D = 7;
      for (const side of [-1, 1]) {
        const c0 = side * 2.4, c1 = side * 7;
        const q = [gt.x + tx * c0 - ox * D, gt.z + tz * c0 - oz * D, gt.x + tx * c1 - ox * D, gt.z + tz * c1 - oz * D, gt.x + tx * c1 + ox * D, gt.z + tz * c1 + oz * D, gt.x + tx * c0 + ox * D, gt.z + tz * c0 + oz * D];
        box(q, g - 2, g + WALL_H + 1.5, [0.74, 0.68, 0.56], 0.55, Surf.Masonry, Surf.Kerb, [0.6, 0.56, 0.48]);
        solids.push({ ring: q, baseY: g - 2, topY: g + WALL_H + 1.5 });
      }
      const q = [gt.x - tx * 2.4 - ox * D, gt.z - tz * 2.4 - oz * D, gt.x + tx * 2.4 - ox * D, gt.z + tz * 2.4 - oz * D, gt.x + tx * 2.4 + ox * D, gt.z + tz * 2.4 + oz * D, gt.x - tx * 2.4 + ox * D, gt.z - tz * 2.4 + oz * D];
      box(q, g + 5.2, g + WALL_H + 1.5, [0.74, 0.68, 0.56], 0.55, Surf.Masonry, Surf.Kerb, [0.6, 0.56, 0.48]);
      // The vault's soffit, seen from the road below.
      poly(S, [0, 1, 2, 3].map((k): V3 => [q[k * 2], g + 5.2, q[k * 2 + 1]]), [0, -1, 0], [0.5, 0.46, 0.4], 0.55, Surf.Masonry, 0, 0, uv4());
    }
  }

  const pack = (st: Store): PompeiiMeshData => ({
    position: st.pos.slice(0, st.n * 3),
    normal: st.nrm.slice(0, st.n * 4),
    colour: st.col.slice(0, st.n * 4),
    surf: st.surf.slice(0, st.n * 4),
    wall: st.wall.slice(0, st.n * 4),
    index: st.idx.slice(0, st.ni),
    triangles: st.ni / 3,
  });
  stats.buildMs = performance.now() - t0;
  return {
    mesh: pack(S),
    floor: pack(F),
    streets: pack(R),
    solids,
    lots,
    sites: lampSites,
    stats,
    amphitheatre: { cx: amph.cx, cz: amph.cz, a: AMPHI.a, b: AMPHI.b, rot: amph.rot, floorY: amphY.floor, rimY: amphY.rim },
  };
}

// --- polygon helpers ------------------------------------------------------------------

/** Merge near-duplicate and near-collinear vertices; positive area out. */
export function cleanRing(r: Ring): Ring | null {
  let pts: [number, number][] = [];
  for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
  for (let pass = 0; pass < 4; pass++) {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i - 1 + pts.length) % pts.length], q = pts[i], s = pts[(i + 1) % pts.length];
      const d1 = Math.hypot(q[0] - p[0], q[1] - p[1]), d2 = Math.hypot(s[0] - q[0], s[1] - q[1]);
      if (d1 < 0.3) continue;
      const cross = (q[0] - p[0]) * (s[1] - q[1]) - (q[1] - p[1]) * (s[0] - q[0]);
      if (Math.abs(cross) / (d1 * d2 || 1) < 0.1) continue;
      out.push(q);
    }
    if (out.length === pts.length) break;
    pts = out;
    if (pts.length < 3) return null;
  }
  // Short jogs (under 4 m) collapse into the intersection of their neighbours.
  for (let pass = 0; pass < 8 && pts.length > 4; pass++) {
    let changed = false;
    for (let i = 0; i < pts.length && pts.length > 4; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 4) continue;
      const p = pts[(i - 1 + pts.length) % pts.length], s = pts[(i + 2) % pts.length];
      const d1x = a[0] - p[0], d1z = a[1] - p[1], d2x = s[0] - b[0], d2z = s[1] - b[1];
      const den = d1x * d2z - d1z * d2x;
      let m: [number, number];
      if (Math.abs(den) < 1e-6) m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      else {
        const t = ((b[0] - p[0]) * d2z - (b[1] - p[1]) * d2x) / den;
        m = [p[0] + d1x * t, p[1] + d1z * t];
        if (Math.hypot(m[0] - a[0], m[1] - a[1]) > 6) m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      }
      pts.splice(i, 2, m);
      if (i + 1 > pts.length) pts.unshift(pts.pop()!);
      changed = true;
    }
    if (!changed) break;
  }
  if (pts.length < 3) return null;
  const out = pts.flat();
  if (ringArea(out) < 0) {
    const rev: number[] = [];
    for (let i = pts.length - 1; i >= 0; i--) rev.push(pts[i][0], pts[i][1]);
    return rev;
  }
  return out;
}

function distSeg(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

export function distToRing(r: Ring, x: number, z: number): number {
  const n = r.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) best = Math.min(best, distSeg(x, z, r[i * 2], r[i * 2 + 1], r[((i + 1) % n) * 2], r[((i + 1) % n) * 2 + 1]));
  return best;
}

/** Distance from (x,z) along (dx,dz) to the ring's boundary. */
function rayToRing(r: Ring, x: number, z: number, dx: number, dz: number): number {
  const n = r.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = r[i * 2], az = r[i * 2 + 1], ex = r[((i + 1) % n) * 2] - ax, ez = r[((i + 1) % n) * 2 + 1] - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den;
    const u = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 0.01 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best === Infinity ? 0 : best;
}

/** Where the line p + e t meets the cut line [px, pz, dx, dz], as t. */
function lineParam(px: number, pz: number, ex: number, ez: number, cut: [number, number, number, number]): number {
  const [qx, qz, dx, dz] = cut;
  const den = ex * dz - ez * dx;
  if (Math.abs(den) < 1e-6) return NaN;
  return ((qx - px) * dz - (qz - pz) * dx) / den;
}

/** Ear clipping, either winding in. */
function triangulateRing(f: Float32Array): number[] {
  const n = f.length / 2;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += f[j * 2] * f[i * 2 + 1] - f[i * 2] * f[j * 2 + 1];
  if (area < 0) idx.reverse();
  const out: number[] = [];
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const ax = f[i0 * 2], az = f[i0 * 2 + 1], bx = f[i1 * 2], bz = f[i1 * 2 + 1], cx = f[i2 * 2], cz = f[i2 * 2 + 1];
      const cr = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (cr <= 1e-9) continue;
      let ear = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const px = f[j * 2], pz = f[j * 2 + 1];
        const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
        const d2 = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx);
        const d3 = (ax - cx) * (pz - cz) - (az - cz) * (px - cx);
        if (d1 >= 0 && d2 >= 0 && d3 >= 0) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(i0, i1, i2);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** The nearest point on a ring's boundary. */
export function nearestOnRing(r: Ring, x: number, z: number): [number, number] {
  const n = r.length / 2;
  let best = Infinity, px = x, pz = z;
  for (let i = 0; i < n; i++) {
    const ax = r[i * 2], az = r[i * 2 + 1], dx = r[((i + 1) % n) * 2] - ax, dz = r[((i + 1) % n) * 2 + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
    const qx = ax + t * dx, qz = az + t * dz, d = Math.hypot(x - qx, z - qz);
    if (d < best) { best = d; px = qx; pz = qz; }
  }
  return [px, pz];
}

function distToPolyline(p: number[], x: number, z: number): number {
  let best = Infinity;
  for (let s = 2; s < p.length; s += 2) best = Math.min(best, distSeg(x, z, p[s - 2], p[s - 1], p[s], p[s + 1]));
  return best;
}
