// Pompeii outside the walls (data/pompeiisuburbs.ts) as vertex arrays: the
// gate roads, the tombs that line them, the suburban villas, inns, stables
// and workshops, the terraces over the west wall, the Sarno with its bridge,
// quay, warehouses and boats, roadside shrines and the farm villas in the
// vineyards. buildPompeii calls this with its own emitters, so the suburbs
// share the town's vertex layout, shader and draw calls.
//
// Tombs were stuccoed white over tuff or brick, with a marble inscription
// panel on the face to the road (the Marble surface with p2 set draws its
// lettering). The five types modelled are the ones the necropoleis show:
// altar on a podium, aedicula with statues, the semicircular schola bench,
// tower tombs in stages, and walled enclosures with their columellae.

import type { PompeiiSuburbs, SuburbBuilding, SuburbTomb } from "../data/pompeiisuburbs";
import { lengthOf, pointAlong, riverAt, shoreAt } from "../data/pompeiisuburbs";
import { Order, figure, lathe, tube, type RGB, type V3 } from "./pompeiiorders";
import type { Solid, Store } from "./pompeiimesh";
import { Surf } from "./pompeiimesh";

type UV = [number, number, number, number];

/** The emitters buildPompeii lends: the same closures it draws the town with. */
export interface SuburbKit {
  S: Store;
  F: Store;
  R: Store;
  poly(st: Store, pts: V3[], facing: V3, c: RGB, seed: number, s: Surf, p1: number, p2: number, uvs: UV[]): void;
  wall(ax: number, az: number, bx: number, bz: number, yBotA: number, yBotB: number, yTopA: number, yTopB: number,
    outX: number, outZ: number, c: RGB, seed: number, s: Surf, p1: number, p2: number, u0: number, facadeLen: number, groundRef: number, facadeH: number): void;
  box(q: number[], y0: number, y1: number, c: RGB, seed: number, s: Surf, top?: Surf, topC?: RGB): void;
  column(x: number, z: number, y0: number, h: number, r: number, c: RGB, seed: number, sides?: number, red?: boolean, order?: Order): void;
  ground(x: number, z: number): number;
  solids: Solid[];
  lean: boolean;
}

export interface SuburbStats {
  tombs: number;
  /** Tombs built along each gate's road, by gate name. */
  tombsByGate: Record<string, number>;
  /** Named villas built (the Villa dei Misteri is the town's). */
  villas: string[];
  buildings: number;
  farms: number;
  boats: number;
  roadKm: number;
  /** Index of the first suburb solid in the model's list: the town's come before it. */
  solidsFrom: number;
}

const WHITE: RGB = [0.9, 0.88, 0.83];
const TUFF: RGB = [0.62, 0.58, 0.5];
const TILE: RGB = [0.62, 0.31, 0.2];
const WOOD: RGB = [0.42, 0.3, 0.2];
const DARK: RGB = [0.12, 0.1, 0.09];
const WASH: RGB[] = [[0.82, 0.66, 0.4], [0.62, 0.2, 0.12], [0.86, 0.8, 0.68], [0.78, 0.56, 0.32], [0.7, 0.3, 0.18]];
const NO: UV = [0, 0, 0, 0];

function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** A footprint's local frame: u along `rot`, v from the front (v = -d/2) to the back. */
interface Frame { P(u: number, v: number): [number, number]; ux: number; uz: number; bx: number; bz: number }
function frameOf(x: number, z: number, rot: number, fx: number, fz: number): Frame {
  const ux = Math.cos(rot), uz = Math.sin(rot), bx = -fx, bz = -fz;
  return { P: (u, v) => [x + ux * u + bx * v, z + uz * u + bz * v], ux, uz, bx, bz };
}

export function buildSuburbs(k: SuburbKit, sub: PompeiiSuburbs): SuburbStats {
  const { S, F, R, poly, wall, box, column, ground, lean } = k;
  const solidsFrom = k.solids.length;
  const stats: SuburbStats = { tombs: 0, tombsByGate: {}, villas: [], buildings: 0, farms: 0, boats: 0, roadKm: 0, solidsFrom };

  const rect = (f: Frame, u0: number, v0: number, u1: number, v1: number): number[] => [...f.P(u0, v0), ...f.P(u1, v0), ...f.P(u1, v1), ...f.P(u0, v1)];
  /** Lowest ground under a footprint: buildings sit down into a slope, never float off it. */
  const minGround = (q: number[]): number => {
    let g = Infinity;
    for (let i = 0; i < q.length; i += 2) g = Math.min(g, ground(q[i], q[i + 1]));
    return g;
  };
  const solid = (q: number[], y0: number, y1: number): void => { k.solids.push({ ring: q, baseY: y0, topY: y1 }); };

  /** Four plastered walls round a footprint, the facade pattern (band, windows, notices) laid along each. */
  function plastered(q: number[], y0: number, gRef: number, H: number, col: RGB, seed: number, band = 1.1, full = false): void {
    const n = q.length / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += q[i * 2]; cz += q[i * 2 + 1]; }
    cx /= n; cz /= n;
    for (let i = 0; i < n; i++) {
      const ax = q[i * 2], az = q[i * 2 + 1], bx = q[((i + 1) % n) * 2], bz = q[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      let ox = (bz - az) / L, oz = -(bx - ax) / L;
      if (ox * ((ax + bx) / 2 - cx) + oz * ((az + bz) / 2 - cz) < 0) { ox = -ox; oz = -oz; }
      wall(ax, az, bx, bz, y0, y0, gRef + H, gRef + H, ox, oz, col, seed, Surf.Plaster, Math.round(band * 40), full ? 255 : 0, 0, L, gRef, H);
    }
  }

  /** A pitched tile roof over a frame rectangle, ridge along u, gables at the u ends. */
  function gable(f: Frame, u0: number, v0: number, u1: number, v1: number, y: number, seed: number, gableCol: RGB, pitch = 0.4, over = 0.45): void {
    const rise = ((v1 - v0) / 2) * pitch;
    const vm = (v0 + v1) / 2;
    const p = (u: number, v: number, h: number): V3 => { const [x, z] = f.P(u, v); return [x, h, z]; };
    const a = p(u0 - over, v0 - over, y - over * pitch), b = p(u1 + over, v0 - over, y - over * pitch);
    const c = p(u1 + over, v1 + over, y - over * pitch), d = p(u0 - over, v1 + over, y - over * pitch);
    const ra = p(u0 - over, vm, y + rise), rb = p(u1 + over, vm, y + rise);
    const slope = Math.hypot((v1 - v0) / 2 + over, rise + over * pitch);
    const L = u1 - u0 + 2 * over;
    poly(S, [a, b, rb, ra], [-f.bx, 1.5, -f.bz], TILE, seed, Surf.Tile, 0, 0, [[0, 0, L, slope], [L, 0, L, slope], [L, slope, L, slope], [0, slope, L, slope]]);
    poly(S, [c, d, ra, rb], [f.bx, 1.5, f.bz], TILE, seed, Surf.Tile, 0, 0, [[L, 0, L, slope], [0, 0, L, slope], [0, slope, L, slope], [L, slope, L, slope]]);
    // The gable ends, plastered.
    const g0 = p(u0, v0, y), g1 = p(u0, v1, y), g2 = p(u0, vm, y + rise);
    const h0 = p(u1, v0, y), h1 = p(u1, v1, y), h2 = p(u1, vm, y + rise);
    poly(S, [g0, g1, g2], [-f.ux, 0, -f.uz], gableCol, seed, Surf.Stucco, 0, 0, [NO, NO, NO]);
    poly(S, [h0, h1, h2], [f.ux, 0, f.uz], gableCol, seed, Surf.Stucco, 0, 0, [NO, NO, NO]);
  }

  /** A single-pitch roof falling from the back (v1, at yHigh) to the front (v0, at yLow). */
  function leanTo(f: Frame, u0: number, v0: number, u1: number, v1: number, yLow: number, yHigh: number, seed: number): void {
    const p = (u: number, v: number, h: number): V3 => { const [x, z] = f.P(u, v); return [x, h, z]; };
    const L = u1 - u0, s = Math.hypot(v1 - v0, yHigh - yLow);
    poly(S, [p(u0, v0, yLow), p(u1, v0, yLow), p(u1, v1, yHigh), p(u0, v1, yHigh)], [-f.bx, 1.5, -f.bz], TILE, seed, Surf.Tile, 0, 0, [[0, 0, L, s], [L, 0, L, s], [L, s, L, s], [0, s, L, s]]);
    // Its underside, seen from under the portico.
    poly(S, [p(u0, v0, yLow - 0.08), p(u1, v0, yLow - 0.08), p(u1, v1, yHigh - 0.08), p(u0, v1, yHigh - 0.08)], [f.bx * 0.2, -1, f.bz * 0.2], WOOD, seed, Surf.Wood, 0, 0, [NO, NO, NO, NO]);
  }

  /** A dark opening (door, niche, window) on the front face of a frame at v, proud by a hair. */
  function opening(f: Frame, u: number, v: number, w: number, y0: number, h: number, seed: number, wood = false): void {
    const [ax, az] = f.P(u - w / 2, v - 0.03), [bx, bz] = f.P(u + w / 2, v - 0.03);
    poly(S, [[ax, y0, az], [bx, y0, bz], [bx, y0 + h, bz], [ax, y0 + h, az]], [-f.bx, 0, -f.bz], wood ? WOOD : DARK, seed, wood ? Surf.Wood : Surf.Interior, 0, 0,
      [[0, 0, w, h], [w, 0, w, h], [w, h, w, h], [0, h, w, h]]);
  }

  /** A marble panel with lettering cut in it, on the front face at v. */
  function plaque(f: Frame, u: number, v: number, w: number, y0: number, h: number, seed: number): void {
    const [ax, az] = f.P(u - w / 2, v - 0.04), [bx, bz] = f.P(u + w / 2, v - 0.04);
    poly(S, [[ax, y0, az], [bx, y0, bz], [bx, y0 + h, bz], [ax, y0 + h, az]], [-f.bx, 0, -f.bz], [0.9, 0.89, 0.86], seed, Surf.Marble, 0, 1,
      [[0, 0, w, h], [w, 0, w, h], [w, h, w, h], [0, h, w, h]]);
  }

  /** A box in frame coordinates. */
  const fbox = (f: Frame, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number, c: RGB, seed: number, s: Surf, top?: Surf, topC?: RGB): void =>
    box(rect(f, u0, v0, u1, v1), y0, y1, c, seed, s, top ?? s, topC ?? c);

  // =====================================================================================
  // Roads: basalt with raised kerbs out of the gates, beaten gravel beyond.
  // =====================================================================================
  const bridgeY = (x: number, z: number): number => {
    let y = -Infinity;
    for (const b of sub.bridges) {
      const ux = Math.cos(b.rot), uz = Math.sin(b.rot);
      const along = Math.abs((x - b.x) * ux + (z - b.z) * uz), across = Math.abs(-(x - b.x) * uz + (z - b.z) * ux);
      if (across > 8) continue;
      const ramp = Math.max(0, along - b.len / 2);
      if (ramp < 30) y = Math.max(y, b.deckY - (ramp / 30) * 3);
    }
    return y;
  };
  for (let ri = 0; ri < sub.roads.length; ri++) {
    const rd = sub.roads[ri];
    const L = lengthOf(rd.pts);
    stats.roadKm += L / 1000;
    const half = rd.widthM / 2;
    let s = 0;
    while (s < L) {
      // Short pieces near the town, where the camera is down among the tombs.
      const step = (s < 900 ? (lean ? 10 : 5) : lean ? 30 : 16);
      const s1 = Math.min(L, s + step);
      const a = pointAlong(rd.pts, s), b = pointAlong(rd.pts, s1);
      const na = [-a.tz, a.tx], nb = [-b.tz, b.tx];
      const paved = s < rd.pavedM;
      const ya = Math.max(ground(a.x, a.z) + 0.12, bridgeY(a.x, a.z)), yb = Math.max(ground(b.x, b.z) + 0.12, bridgeY(b.x, b.z));
      const col: RGB = paved ? [0.5, 0.5, 0.5] : [0.62, 0.54, 0.42];
      const surf = paved ? Surf.Basalt : Surf.Pavement;
      const pts: V3[] = [
        [a.x - na[0] * half, ya, a.z - na[1] * half], [a.x + na[0] * half, ya, a.z + na[1] * half],
        [b.x + nb[0] * half, yb, b.z + nb[1] * half], [b.x - nb[0] * half, yb, b.z - nb[1] * half],
      ];
      // Basalt reads vWall.z as metres across the street and .w as its half width, for the ruts.
      poly(R, pts, [0, 1, 0], col, hash(ri, Math.floor(s)), surf, 0, 0, [[s, 0, -half, half], [s, 0, half, half], [s1, 0, half, half], [s1, 0, -half, half]]);
      if (paved && !lean) {
        // The raised footways either side.
        for (const side of [-1, 1]) {
          const o0 = half, o1 = half + 1.3, y0a = ya + 0.32, y0b = yb + 0.32;
          const q: V3[] = [
            [a.x + na[0] * side * o0, y0a, a.z + na[1] * side * o0], [a.x + na[0] * side * o1, y0a, a.z + na[1] * side * o1],
            [b.x + nb[0] * side * o1, y0b, b.z + nb[1] * side * o1], [b.x + nb[0] * side * o0, y0b, b.z + nb[1] * side * o0],
          ];
          poly(R, q, [0, 1, 0], [0.6, 0.57, 0.5], 0.3, Surf.Pavement, 0, 0, [NO, NO, NO, NO]);
          // The kerb face down to the carriageway.
          poly(R, [[q[0][0], ya - 0.05, q[0][2]], [q[3][0], yb - 0.05, q[3][2]], q[3], q[0]], [-na[0] * side, 0, -na[1] * side], [0.56, 0.54, 0.5], 0.3, Surf.Kerb, 0, 0,
            [[s, 0, 0, 0.4], [s1, 0, 0, 0.4], [s1, 0.4, 0, 0.4], [s, 0.4, 0, 0.4]]);
        }
      }
      s = s1;
    }
  }
  // Bridges: a stone deck on arches over the water.
  for (const b of sub.bridges) {
    const f = frameOf(b.x, b.z, b.rot, -Math.sin(b.rot), Math.cos(b.rot));
    const rv = riverAt(sub.river, b.x, b.z);
    fbox(f, -b.len / 2, -3.6, b.len / 2, 3.6, b.deckY - 1.1, b.deckY + 0.1, TUFF, 0.4, Surf.Masonry, Surf.Pavement, [0.6, 0.54, 0.44]);
    // Parapets.
    for (const v of [-3.6, 3.3]) fbox(f, -b.len / 2, v, b.len / 2, v + 0.3, b.deckY + 0.1, b.deckY + 1.1, TUFF, 0.4, Surf.Masonry);
    // Piers down into the river.
    for (let u = -b.len / 2 + 4; u <= b.len / 2 - 4; u += (b.len - 8) / 3) fbox(f, u - 1.1, -3.4, u + 1.1, 3.4, rv.level - 2, b.deckY - 1.1, TUFF, 0.4, Surf.Masonry);
  }

  // =====================================================================================
  // The river: its water, the quay and warehouses at the mouth, the boats.
  // =====================================================================================
  {
    const r = sub.river, L = lengthOf(r.pts);
    const step = lean ? 40 : 20;
    for (let s = 0; s < L; s += step) {
      const s1 = Math.min(L, s + step);
      const a = pointAlong(r.pts, s), b = pointAlong(r.pts, s1);
      // Stop at the shore: the sea there is the terrain's water.
      if (shoreAt(sub.shore, b.x, b.z).s < -8) break;
      const ra = riverAt(r, a.x, a.z), rb = riverAt(r, b.x, b.z);
      const wa = ra.halfW + 2, wb = rb.halfW + 2;
      const pts: V3[] = [
        [a.x + a.tz * wa, ra.level, a.z - a.tx * wa], [a.x - a.tz * wa, ra.level, a.z + a.tx * wa],
        [b.x - b.tz * wb, rb.level, b.z + b.tx * wb], [b.x + b.tz * wb, rb.level, b.z - b.tx * wb],
      ];
      poly(F, pts, [0, 1, 0], [0.18, 0.26, 0.24], 0.5, Surf.Water, 0, 0, [NO, NO, NO, NO]);
    }
    // The quay: a masonry face along the north bank with a paved top.
    const q = sub.quay;
    for (let i = 0; i + 3 < q.length; i += 2) {
      const ax = q[i], az = q[i + 1], bx = q[i + 2], bz = q[i + 3];
      const ra = riverAt(r, ax, az);
      const L2 = Math.hypot(bx - ax, bz - az) || 1;
      // The river side: toward the centreline.
      let ox = (bz - az) / L2, oz = -(bx - ax) / L2;
      const c = pointAlong(r.pts, ra.s);
      if (ox * (c.x - ax) + oz * (c.z - az) < 0) { ox = -ox; oz = -oz; }
      const top = ra.level + 1.6;
      wall(ax, az, bx, bz, ra.level - 1.2, ra.level - 1.2, top, top, ox, oz, TUFF, 0.6, Surf.Masonry, 2, 0, i * 8, 1e4, ra.level - 1.2, 2.8);
      poly(S, [[ax, top, az], [bx, top, bz], [bx - ox * 6, top, bz - oz * 6], [ax - ox * 6, top, az - oz * 6]], [0, 1, 0], [0.6, 0.57, 0.5], 0.6, Surf.Kerb, 0, 0, [NO, NO, NO, NO]);
      // Mooring bollards.
      if (!lean && (i / 2) % 2 === 0) lathe(S, ax - ox * 0.6, top, az - oz * 0.6, [[0.22, 0], [0.22, 0.6], [0.28, 0.7], [0.01, 0.75]], 8, TUFF, 0.6, Surf.Masonry);
    }
    for (const bt of sub.boats) {
      const rv = riverAt(r, bt.x, bt.z);
      const y = bt.beached ? ground(bt.x, bt.z) + 0.35 : rv.level - 0.15;
      boat(bt.x, y, bt.z, bt.rot, bt.len, bt.beached);
      stats.boats++;
    }
  }

  /** An open wooden hull lofted from stations: gunwale, chine, keel. A mast on the bigger ones. */
  function boat(x: number, y: number, z: number, rot: number, len: number, beached: boolean): void {
    const ux = Math.cos(rot), uz = Math.sin(rot), vx = -uz, vz = ux;
    const beam = len * 0.28, depth = len * 0.11;
    const N = lean ? 6 : 10;
    const st: V3[][] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = (t - 0.5) * len;
      const w = beam / 2 * Math.pow(Math.sin(Math.PI * Math.min(0.98, Math.max(0.02, t))), 0.7);
      // Sheer: the ends rise.
      const sheer = y + depth * 0.6 + 0.35 * Math.pow(Math.abs(t - 0.5) * 2, 3) * depth * 3;
      const P = (lat: number, h: number): V3 => [x + ux * u + vx * lat, h, z + uz * u + vz * lat];
      st.push([P(-w, sheer), P(-w * 0.8, y - depth * 0.2), P(0, y - depth * 0.45), P(w * 0.8, y - depth * 0.2), P(w, sheer)]);
    }
    const hullC: RGB = [0.24, 0.17, 0.12];
    for (let i = 0; i < N; i++) for (let j = 0; j < 4; j++) {
      const q = [st[i][j], st[i + 1][j], st[i + 1][j + 1], st[i][j + 1]];
      const mid: V3 = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2, (q[0][2] + q[2][2]) / 2];
      const out: V3 = [mid[0] - x, (mid[1] - y) * 0.5 - 0.2, mid[2] - z];
      // The outside of the hull, pitch-black below the waterline paint line, and the inside planking.
      poly(S, q, [out[0], out[1], out[2]], hullC, 0.3, Surf.Wood, 0, 0, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
      poly(S, [q[0], q[3], q[2], q[1]], [-out[0], -out[1] + 1, -out[2]], [0.46, 0.34, 0.22], 0.3, Surf.Wood, 0, 0, [NO, NO, NO, NO]);
    }
    if (!beached && len > 11 && !lean) tube(S, [x, y, z], [x, y + len * 0.7, z], 0.1, 0.07, 6, WOOD, 0.3, Surf.Wood);
  }

  // =====================================================================================
  // Tombs.
  // =====================================================================================
  for (let ti = 0; ti < sub.tombs.length; ti++) {
    const t = sub.tombs[ti];
    tomb(t, ti);
    stats.tombs++;
    const g = sub.roads[t.road].gate;
    stats.tombsByGate[g] = (stats.tombsByGate[g] ?? 0) + 1;
  }

  function tomb(t: SuburbTomb, ti: number): void {
    const f = frameOf(t.x, t.z, t.rot, t.fx, t.fz);
    const hw = t.w / 2, hd = t.d / 2;
    const foot = rect(f, -hw, -hd, hw, hd);
    const g = minGround(foot);
    const seed = hash(ti, 17);
    // A little weathering in the white: some fresher than others.
    const W: RGB = [WHITE[0] - seed * 0.06, WHITE[1] - seed * 0.07, WHITE[2] - seed * 0.08];
    let top = g + 3;
    switch (t.kind) {
      case "altar": {
        // Podium with a moulded base and cornice, the altar on it with its bolsters.
        const ph = 1.9 + seed * 1.2;
        fbox(f, -hw, -hd, hw, hd, g - 0.6, g + 0.35, TUFF, seed, Surf.Masonry);
        fbox(f, -hw + 0.15, -hd + 0.15, hw - 0.15, hd - 0.15, g + 0.35, g + ph, W, seed, Surf.Stucco);
        fbox(f, -hw - 0.05, -hd - 0.05, hw + 0.05, hd + 0.05, g + ph, g + ph + 0.28, W, seed, Surf.Stucco);
        plaque(f, 0, -hd + 0.15, Math.min(2.2, t.w * 0.55), g + 0.8, 0.8, seed);
        const aw = hw * 0.62, ad = hd * 0.62, ab = g + ph + 0.28, ah = 1.4 + seed * 0.5;
        fbox(f, -aw, -ad, aw, ad, ab, ab + ah, W, seed, Surf.Stucco);
        fbox(f, -aw - 0.1, -ad - 0.1, aw + 0.1, ad + 0.1, ab + ah, ab + ah + 0.18, W, seed, Surf.Stucco);
        // The pulvini: two bolsters along the altar's top, front to back.
        for (const u of [-aw + 0.22, aw - 0.22]) {
          const [x0, z0] = f.P(u, -ad - 0.05), [x1, z1] = f.P(u, ad + 0.05);
          tube(S, [x0, ab + ah + 0.4, z0], [x1, ab + ah + 0.4, z1], 0.22, 0.22, 8, W, seed, Surf.Stucco);
        }
        top = ab + ah + 0.62;
        break;
      }
      case "aedicula": {
        // A tall podium, then a little open temple front with portrait statues in it.
        const ph = 2.4 + seed * 1.2;
        fbox(f, -hw, -hd, hw, hd, g - 0.6, g + ph, W, seed, Surf.Stucco);
        fbox(f, -hw - 0.1, -hd - 0.1, hw + 0.1, hd + 0.1, g + ph, g + ph + 0.25, W, seed, Surf.Stucco);
        plaque(f, 0, -hd, Math.min(2.4, t.w * 0.6), g + 0.9, 0.9, seed);
        const y0 = g + ph + 0.25, ch = 2.6 + seed * 0.6;
        // Back wall and side walls of the cella, open to the road.
        fbox(f, -hw + 0.2, hd - 0.6, hw - 0.2, hd - 0.2, y0, y0 + ch, W, seed, Surf.Stucco);
        for (const u of [-hw + 0.2, hw - 0.6]) fbox(f, u, -hd * 0.1, u + 0.4, hd - 0.2, y0, y0 + ch, W, seed, Surf.Stucco);
        for (const u of [-hw + 0.45, hw - 0.45]) {
          const [x, z] = f.P(u, -hd + 0.45);
          column(x, z, y0, ch, 0.18, W, seed, 8, false, lean ? undefined : Order.Ionic);
        }
        // Entablature and a stuccoed pediment roof.
        fbox(f, -hw - 0.05, -hd + 0.05, hw + 0.05, hd - 0.05, y0 + ch, y0 + ch + 0.45, W, seed, Surf.Stucco);
        const ry = y0 + ch + 0.45;
        const p = (u: number, v: number, h: number): V3 => { const [x, z] = f.P(u, v); return [x, h, z]; };
        const rise = hw * 0.35;
        poly(S, [p(-hw - 0.1, -hd, ry), p(-hw - 0.1, hd, ry), p(0, hd, ry + rise), p(0, -hd, ry + rise)], [-f.ux, 1, -f.uz], W, seed, Surf.Stucco, 0, 0, [NO, NO, NO, NO]);
        poly(S, [p(hw + 0.1, hd, ry), p(hw + 0.1, -hd, ry), p(0, -hd, ry + rise), p(0, hd, ry + rise)], [f.ux, 1, f.uz], W, seed, Surf.Stucco, 0, 0, [NO, NO, NO, NO]);
        poly(S, [p(-hw - 0.1, -hd, ry), p(0, -hd, ry + rise), p(hw + 0.1, -hd, ry)], [-f.bx, 0, -f.bz], W, seed, Surf.Stucco, 0, 0, [NO, NO, NO]);
        poly(S, [p(-hw - 0.1, hd, ry), p(hw + 0.1, hd, ry), p(0, hd, ry + rise)], [f.bx, 0, f.bz], W, seed, Surf.Stucco, 0, 0, [NO, NO, NO]);
        if (!lean) {
          // The deceased, togate, looking out over the road.
          const yaw = Math.atan2(-f.bx, -f.bz);
          for (const u of t.w > 4 && !t.inferred ? [-hw * 0.35, hw * 0.35] : [0]) {
            const [x, z] = f.P(u, hd * 0.25);
            figure(S, [x, y0 + 0.12, z], yaw, 0.95, "togate", [0.88, 0.86, 0.8], Surf.Stucco);
          }
        }
        top = ry + rise;
        break;
      }
      case "schola": {
        // The semicircular tuff bench with lion's-paw ends, open to the road,
        // where passers-by sat: Mamia's and Aulus Veius's at Porta Ercolano.
        const R = Math.min(hw, hd * 1.6);
        const [cx, cz] = f.P(0, -hd + 0.3);
        const segs = lean ? 7 : 12;
        for (let i = 0; i < segs; i++) {
          const a0 = (i / segs) * Math.PI, a1 = ((i + 1) / segs) * Math.PI;
          // Angles sweep round the back half: u = cos, v = sin.
          const at = (a: number, r: number): [number, number] => [cx + (f.ux * Math.cos(a) + f.bx * Math.sin(a)) * r, cz + (f.uz * Math.cos(a) + f.bz * Math.sin(a)) * r];
          const seat = [...at(a0, R - 0.75), ...at(a1, R - 0.75), ...at(a1, R - 0.25), ...at(a0, R - 0.25)];
          box(seat, g - 0.4, g + 0.5, TUFF, seed, Surf.Masonry, Surf.Kerb, TUFF);
          const back = [...at(a0, R - 0.25), ...at(a1, R - 0.25), ...at(a1, R + 0.1), ...at(a0, R + 0.1)];
          box(back, g - 0.4, g + 1.15, TUFF, seed, Surf.Masonry, Surf.Kerb, TUFF);
        }
        // Paw ends.
        for (const u of [-R + 0.5, R - 0.5]) fbox(f, u - 0.3, -hd + 0.1, u + 0.3, -hd + 0.9, g - 0.2, g + 0.75, W, seed, Surf.Stucco);
        // A column or altar for the honoured dead behind the bench.
        const [mx, mz] = f.P(0, -hd + 0.3 + R + 1.0);
        column(mx, mz, g, 2.6, 0.3, W, seed, 10);
        top = g + 2.6;
        break;
      }
      case "tower": {
        // Stages: a plain base, an arcaded middle, a round drum with a cone.
        const h1 = 2.6 + seed, h2 = 2.4;
        fbox(f, -hw, -hd, hw, hd, g - 0.6, g + h1, W, seed, Surf.Stucco);
        fbox(f, -hw - 0.1, -hd - 0.1, hw + 0.1, hd + 0.1, g + h1, g + h1 + 0.25, W, seed, Surf.Stucco);
        plaque(f, 0, -hd, Math.min(2, t.w * 0.5), g + 1.0, 0.7, seed);
        const k2 = 0.72;
        fbox(f, -hw * k2, -hd * k2, hw * k2, hd * k2, g + h1 + 0.25, g + h1 + 0.25 + h2, W, seed, Surf.Stucco);
        opening(f, 0, -hd * k2, hw * 0.6, g + h1 + 0.6, h2 * 0.7, seed);
        const [cx, cz] = f.P(0, 0);
        const r = Math.min(hw, hd) * 0.55, y2 = g + h1 + 0.25 + h2;
        lathe(S, cx, y2, cz, [[r + 0.1, 0], [r + 0.1, 0.2], [r, 0.25], [r, 1.6], [r + 0.1, 1.7], [0.02, 2.9]].reverse() as [number, number][], 12, W, seed, Surf.Stucco);
        top = y2 + 2.9;
        break;
      }
      case "tholos": {
        // A round shrine of columns on a podium, a cone of tiles over it.
        const ph = 2 + seed;
        fbox(f, -hw, -hd, hw, hd, g - 0.6, g + ph, W, seed, Surf.Stucco);
        plaque(f, 0, -hd, Math.min(2, t.w * 0.5), g + 0.7, 0.7, seed);
        const [cx, cz] = f.P(0, 0);
        const r = Math.min(hw, hd) - 0.5, y0 = g + ph, ch = 2.6;
        const n = lean ? 4 : 6;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          column(cx + Math.cos(a) * r, cz + Math.sin(a) * r, y0, ch, 0.16, W, seed, 8);
        }
        lathe(S, cx, y0, cz, [[0.01, 0], [r * 0.5, 0], [r * 0.5, 2.0], [0.01, 2.0]].reverse() as [number, number][], 10, W, seed, Surf.Stucco);
        lathe(S, cx, y0 + ch, cz, [[r + 0.3, 0], [r + 0.3, 0.3], [0.02, 1.6]].reverse() as [number, number][], 12, TILE, seed, Surf.Tile);
        top = y0 + ch + 1.6;
        break;
      }
      case "niche": {
        // A block with an arched niche for an urn or a portrait.
        const h = 2.6 + seed * 0.8;
        fbox(f, -hw, -hd, hw, hd, g - 0.6, g + h, W, seed, Surf.Stucco);
        fbox(f, -hw - 0.08, -hd - 0.08, hw + 0.08, hd + 0.08, g + h, g + h + 0.22, W, seed, Surf.Stucco);
        opening(f, 0, -hd, Math.min(1.4, t.w * 0.45), g + 0.9, 1.3, seed);
        plaque(f, 0, -hd, Math.min(1.6, t.w * 0.5), g + 0.25, 0.5, seed);
        top = g + h + 0.22;
        break;
      }
      case "enclosure": {
        // A walled plot, its front raised and lettered; columellae and urns inside.
        const h = 1.7 + seed * 0.5, ft = 0.45;
        fbox(f, -hw, -hd, hw, -hd + ft, g - 0.5, g + h + 0.9, W, seed, Surf.Stucco);
        fbox(f, -hw, hd - 0.35, hw, hd, g - 0.5, g + h, W, seed, Surf.Stucco);
        fbox(f, -hw, -hd + ft, -hw + 0.35, hd - 0.35, g - 0.5, g + h, W, seed, Surf.Stucco);
        fbox(f, hw - 0.35, -hd + ft, hw, hd - 0.35, g - 0.5, g + h, W, seed, Surf.Stucco);
        // Pediment-like crest on the front.
        fbox(f, -hw * 0.5, -hd, hw * 0.5, -hd + ft, g + h + 0.9, g + h + 1.4, W, seed, Surf.Stucco);
        plaque(f, 0, -hd, Math.min(2.6, t.w * 0.6), g + 0.9, 0.9, seed);
        if (!lean) {
          const n = 2 + Math.floor(seed * 4);
          for (let i = 0; i < n; i++) {
            const [x, z] = f.P(-hw + 1 + ((t.w - 2) * (i + 0.5)) / n, 0.3 * hd);
            // A columella: a stylised head on a stone post, the old Oscan marker.
            lathe(S, x, g, z, [[0.18, 0], [0.18, 0.55], [0.12, 0.6], [0.16, 0.75], [0.13, 0.88], [0.01, 0.92]].reverse() as [number, number][], 7, TUFF, seed, Surf.Masonry);
          }
        }
        top = g + h + 1.4;
        break;
      }
    }
    solid(foot, g - 0.6, top);
  }

  // =====================================================================================
  // Buildings.
  // =====================================================================================
  for (let bi = 0; bi < sub.buildings.length; bi++) {
    const b = sub.buildings[bi];
    building(b, bi);
    stats.buildings++;
    if (b.kind === "farm") stats.farms++;
    if (b.kind === "villa" || b.kind === "porticus" || (b.kind === "farm" && !b.name.startsWith("Villa rustica"))) stats.villas.push(b.name);
  }

  function building(b: SuburbBuilding, bi: number): void {
    const f = frameOf(b.x, b.z, b.rot, b.fx, b.fz);
    const hw = b.w / 2, hd = b.d / 2;
    const seed = hash(bi, 41);
    const col = WASH[Math.floor(seed * WASH.length)];
    /** A plastered range with a gable roof, solid for collisions. */
    const range = (u0: number, v0: number, u1: number, v1: number, H: number, c: RGB, sd: number, ridgeAlongU = true): number => {
      const q = rect(f, u0, v0, u1, v1);
      const g = minGround(q);
      const gc = ground(...f.P((u0 + u1) / 2, (v0 + v1) / 2));
      const top = Math.max(gc, g + 0.5) + H;
      plastered(q, g - 0.6, top - H, H, c, sd);
      if (ridgeAlongU) gable(f, u0, v0, u1, v1, top, sd, c);
      else gable(frameOf(...f.P((u0 + u1) / 2, (v0 + v1) / 2), b.rot + Math.PI / 2, f.ux, f.uz), -(v1 - v0) / 2, -(u1 - u0) / 2, (v1 - v0) / 2, (u1 - u0) / 2, top, sd, c);
      solid(q, g - 0.6, top + (Math.min(u1 - u0, v1 - v0) / 2) * 0.4);
      return top;
    };
    const gFront = ground(...f.P(0, -hd));
    switch (b.kind) {
      case "tabernae": {
        // A row of shops under a portico, rooms over them.
        const top = range(-hw, -hd + 3.2, hw, hd, 6.8, col, seed);
        for (let u = -hw + 2.5; u < hw - 2; u += 4.4) opening(f, u, -hd + 3.2, 2.6, gFront, 2.8, seed);
        const n = Math.max(2, Math.round(b.w / 3.4));
        for (let i = 0; i <= n; i++) {
          const [x, z] = f.P(-hw + (b.w * i) / n, -hd + 0.4);
          column(x, z, ground(x, z), 3.6, 0.22, [0.86, 0.84, 0.78], seed, 8, true);
        }
        leanTo(f, -hw, -hd, hw, -hd + 3.2, gFront + 3.6, Math.min(top - 1.2, gFront + 4.5), seed);
        break;
      }
      case "inn": {
        // An inn: two storeys on the road with a wide cart gate to the yard behind.
        const front = Math.min(b.d, 11);
        const top = range(-hw, -hd, hw, -hd + front, 7.2, col, seed);
        opening(f, -hw + 3, -hd, 3.2, gFront, 3.4, seed, true);
        for (let u = -hw + 7; u < hw - 2; u += 4.5) opening(f, u, -hd, 2.2, gFront, 2.6, seed);
        // The yard wall.
        if (b.d > front + 2) {
          const q = rect(f, -hw, -hd + front, hw, hd);
          const g = minGround(q);
          const n = q.length / 2;
          for (let i = 1; i < n; i++) {
            const ax = q[i * 2], az = q[i * 2 + 1], bx = q[((i + 1) % n) * 2], bz = q[((i + 1) % n) * 2 + 1];
            if (i === 0) continue;
            const L = Math.hypot(bx - ax, bz - az);
            const [cx, cz] = f.P(0, -hd + front + (b.d - front) / 2);
            let ox = (bz - az) / L, oz = -(bx - ax) / L;
            if (ox * ((ax + bx) / 2 - cx) + oz * ((az + bz) / 2 - cz) < 0) { ox = -ox; oz = -oz; }
            wall(ax, az, bx, bz, g - 0.5, g - 0.5, g + 2.4, g + 2.4, ox, oz, [0.8, 0.74, 0.62], seed, Surf.Plaster, 30, 255, 0, L, g, 2.4);
            wall(bx, bz, ax, az, g - 0.5, g - 0.5, g + 2.4, g + 2.4, -ox, -oz, [0.8, 0.74, 0.62], seed, Surf.Plaster, 30, 255, 0, L, g, 2.4);
          }
        }
        void top;
        break;
      }
      case "stable": {
        // A long low stable, wide doors to the yard, a trough.
        range(-hw, -hd, hw, hd, 4, [0.78, 0.7, 0.56], seed);
        for (let u = -hw + 3; u < hw - 2; u += 5) opening(f, u, -hd, 2.4, gFront, 2.6, seed, true);
        if (!lean) {
          const [x, z] = f.P(0, -hd - 1.4);
          const g = ground(x, z);
          box([...f.P(-2, -hd - 1.9), ...f.P(2, -hd - 1.9), ...f.P(2, -hd - 0.9), ...f.P(-2, -hd - 0.9)], g - 0.2, g + 0.7, TUFF, seed, Surf.Masonry, Surf.Water, [0.2, 0.26, 0.24]);
        }
        break;
      }
      case "workshop": {
        // A workshop: a range, its yard, and a kiln or vats out in it.
        range(-hw, -hd, hw, -hd + b.d * 0.55, 5, col, seed);
        opening(f, 0, -hd, 3, gFront, 3, seed, true);
        const [x, z] = f.P(-hw * 0.4, hd - 3);
        const g = ground(x, z);
        if (seed < 0.5) lathe(S, x, g, z, [[1.8, 0], [1.9, 1.4], [1.4, 2.6], [0.4, 3.2], [0.01, 3.25]].reverse() as [number, number][], 12, [0.6, 0.42, 0.3], seed, Surf.Masonry);
        else for (let i = 0; i < 3; i++) {
          const [vx, vz] = f.P(-hw * 0.6 + i * 2.4, hd - 3);
          lathe(S, vx, ground(vx, vz), vz, [[0.9, 0], [0.95, 0.9], [0.8, 0.95], [0.75, 0.2]], 10, TUFF, seed, Surf.Masonry);
        }
        break;
      }
      case "baths": {
        // The Terme Suburbane: a tall bath block, its big windows on the sea, and a lower wing.
        const top = range(-hw, -hd, hw * 0.25, hd, 9.5, [0.84, 0.76, 0.6], seed);
        range(hw * 0.25, -hd + 4, hw, hd, 5.5, [0.84, 0.76, 0.6], seed);
        for (let u = -hw + 3; u < hw * 0.25 - 2; u += 4) opening(f, u, -hd, 1.8, top - 5, 2.4, seed);
        opening(f, -hw + 4, -hd, 2.2, gFront, 3, seed, true);
        break;
      }
      case "warehouse": {
        // Horrea: one long storehouse with big doors.
        range(-hw, -hd, hw, hd, 6, [0.74, 0.66, 0.52], seed);
        for (let u = -hw + 4; u < hw - 3; u += 7) opening(f, u, -hd, 3, gFront, 3.4, seed, true);
        break;
      }
      case "shrine": {
        // A lararium at the roadside: a pedestal, a red niche, a little gable.
        const q = rect(f, -hw, -hd, hw, hd);
        const g = minGround(q);
        box(q, g - 0.3, g + 1.2, WHITE, seed, Surf.Stucco);
        fbox(f, -hw + 0.1, -hd + 0.1, hw - 0.1, hd - 0.1, g + 1.2, g + 2.4, [0.62, 0.18, 0.12], seed, Surf.Stucco);
        opening(f, 0, -hd + 0.1, hw, g + 1.45, 0.8, seed);
        gable(f, -hw, -hd, hw, hd, g + 2.4, seed, WHITE, 0.5, 0.15);
        solid(q, g - 0.3, g + 2.9);
        break;
      }
      case "villa": villa(f, b, seed); break;
      case "porticus": {
        // The Villa Imperiale: rooms against the wall, a long portico on the sea.
        const back = 8;
        range(-hw, hd - back, hw, hd, 6.4, [0.86, 0.8, 0.68], seed);
        const n = Math.round(b.w / 3.3);
        for (let i = 0; i <= n; i++) {
          const [x, z] = f.P(-hw + (b.w * i) / n, -hd + 0.5);
          column(x, z, ground(x, z) + 0.4, 4.2, 0.25, [0.88, 0.86, 0.8], seed, 8, true, lean ? undefined : Order.Doric);
        }
        // The portico's floor terrace and its roof.
        const q = rect(f, -hw, -hd, hw, hd - back);
        const g = minGround(q);
        box(q, g - 1.5, gFront + 0.4, TUFF, seed, Surf.Masonry, Surf.Pavement, [0.7, 0.62, 0.5]);
        leanTo(f, -hw, -hd, hw, hd - back, gFront + 4.6, gFront + 6.4, seed);
        // Painted panels on the back wall of the portico (the villa's red and yellow rooms behind).
        const [ax, az] = f.P(-hw, hd - back - 0.02), [bx, bz] = f.P(hw, hd - back - 0.02);
        wall(ax, az, bx, bz, gFront + 0.4, gFront + 0.4, gFront + 4.6, gFront + 4.6, -f.bx, -f.bz, [0.55, 0.12, 0.08], seed, Surf.Fresco, 0, 255, 0, b.w, gFront + 0.4, 4.2);
        break;
      }
      case "terrace": terrace(f, b, seed); break;
      case "farm": farm(f, b, seed); break;
    }
  }

  /** A suburban villa: the house round its atrium and peristyle at the road, and where there is room, a garden court behind with a portico and pool. */
  function villa(f: Frame, b: SuburbBuilding, seed: number): void {
    const hw = b.w / 2, hd = b.d / 2;
    const house = Math.min(b.d, 30);
    const v0 = -hd, v1 = -hd + house;
    const col = WASH[Math.floor(seed * 3)];
    // Four ranges round a court.
    const cw = Math.min(b.w - 14, 14), cd = Math.min(house - 14, 12);
    const cv = (v0 + v1) / 2;
    const rng = (u0: number, a: number, u1: number, c: number, H: number): void => {
      const q = rect(f, u0, a, u1, c);
      const g = minGround(q);
      const gc = ground(...f.P((u0 + u1) / 2, (a + c) / 2));
      plastered(q, g - 0.6, gc, H, col, seed);
      gable(f, u0, a, u1, c, gc + H, seed, col);
      solid(q, g - 0.6, gc + H + 2);
    };
    rng(-hw, v0, hw, cv - cd / 2, 7.4);
    rng(-hw, cv + cd / 2, hw, v1, 6.6);
    rng(-hw, cv - cd / 2, -cw / 2, cv + cd / 2, 5.6);
    rng(cw / 2, cv - cd / 2, hw, cv + cd / 2, 5.6);
    opening(f, 0, v0, 2.2, ground(...f.P(0, v0)), 3.4, seed, true);
    // The peristyle's columns, red lower thirds.
    const gC = ground(...f.P(0, cv));
    const n = 3;
    for (let i = 0; i <= n; i++) for (const v of [cv - cd / 2 + 1.2, cv + cd / 2 - 1.2]) {
      const [x, z] = f.P(-cw / 2 + 1.2 + ((cw - 2.4) * i) / n, v);
      column(x, z, gC, 3.8, 0.22, [0.88, 0.86, 0.8], seed, 8, true, lean ? undefined : Order.Doric);
    }
    box(rect(f, -cw / 2 + 2.4, cv - cd / 2 + 2.4, cw / 2 - 2.4, cv + cd / 2 - 2.4), gC - 0.3, gC + 0.15, [0.36, 0.44, 0.24], seed, Surf.Garden);
    if (b.d <= house + 6) return;
    // The garden court below the house: a portico round three sides, a pool, a pergola.
    const gv0 = v1, gv1 = hd;
    const q = rect(f, -hw, gv0, hw, gv1);
    const g = minGround(q);
    const gc = ground(...f.P(0, (gv0 + gv1) / 2));
    for (const [a, c] of [[f.P(-hw, gv0), f.P(-hw, gv1)], [f.P(-hw, gv1), f.P(hw, gv1)], [f.P(hw, gv1), f.P(hw, gv0)]] as [number, number][][]) {
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const [cx, cz] = f.P(0, (gv0 + gv1) / 2);
      let ox = (c[1] - a[1]) / L, oz = -(c[0] - a[0]) / L;
      if (ox * ((a[0] + c[0]) / 2 - cx) + oz * ((a[1] + c[1]) / 2 - cz) < 0) { ox = -ox; oz = -oz; }
      wall(a[0], a[1], c[0], c[1], g - 0.8, g - 0.8, gc + 4.6, gc + 4.6, ox, oz, col, seed, Surf.Plaster, 44, 255, 0, L, gc, 4.6);
      wall(c[0], c[1], a[0], a[1], g - 0.8, g - 0.8, gc + 4.6, gc + 4.6, -ox, -oz, [0.6, 0.16, 0.1], seed, Surf.Fresco, 0, 255, 0, L, gc, 4.6);
    }
    // The portico: a lean-to round the inside of the court, columns along its edge.
    leanTo(f, -hw, gv1 - 4, hw, gv1, gc + 3.4, gc + 4.6, seed);
    for (const side of [-1, 1]) leanTo(frameOf(...f.P(side * (hw - 2), (gv0 + gv1) / 2), b.rot + Math.PI / 2, -f.ux * side, -f.uz * side), -(gv1 - gv0) / 2, -2, (gv1 - gv0) / 2, 2, gc + 3.4, gc + 4.6, seed);
    const m = lean ? 4 : 7;
    for (let i = 0; i <= m; i++) {
      const [x, z] = f.P(-hw + 4 + ((b.w - 8) * i) / m, gv1 - 4);
      column(x, z, gc, 3.4, 0.2, [0.88, 0.86, 0.8], seed, 8, true);
    }
    box(rect(f, -hw + 4, gv0 + 1, hw - 4, gv1 - 4), g - 0.3, gc + 0.1, [0.36, 0.44, 0.24], seed, Surf.Garden);
    // The pool, and a pergola over it on six piers.
    const pq = rect(f, -4, (gv0 + gv1) / 2 - 3, 4, (gv0 + gv1) / 2 + 1);
    box(pq, gc - 0.4, gc + 0.3, WHITE, seed, Surf.Stucco, Surf.Water, [0.2, 0.3, 0.32]);
    if (!lean) for (const u of [-4.5, 0, 4.5]) for (const v of [-4, 2]) {
      const [x, z] = f.P(u, (gv0 + gv1) / 2 + v);
      column(x, z, gc, 2.8, 0.18, WHITE, seed, 6);
    }
  }

  /** Insula Occidentalis: three terraces stepping down outside the wall, a loggia on each. */
  function terrace(f: Frame, b: SuburbBuilding, seed: number): void {
    const hw = b.w / 2, hd = b.d / 2;
    const gTop = ground(...f.P(0, hd));
    const col: RGB = seed < 0.5 ? [0.66, 0.2, 0.12] : [0.82, 0.64, 0.36];
    const bands = 3, bd = b.d / bands;
    for (let k = 0; k < bands; k++) {
      // Band 0 at the back (on the wall line), the lowest out front.
      const vb = hd - k * bd, va = vb - bd;
      const q = rect(f, -hw, va, hw, vb);
      const g = Math.min(minGround(q), gTop) - 1;
      const top = gTop + 6.5 - k * 4.2;
      plastered(q, g - 1, top - 6, 6, col, seed + k, 1.2, true);
      if (k === 0) gable(f, -hw, va, hw, vb, top, seed, col);
      else {
        // A terrace floor with a parapet, the loggia's columns on its outer edge.
        box(rect(f, -hw, va, hw, vb), top - 0.3, top, [0.64, 0.42, 0.32], seed, Surf.Pavement);
        fbox(f, -hw, va, hw, va + 0.3, top, top + 1.0, col, seed, Surf.Stucco);
      }
      // A loggia under each roof, open to the sea.
      for (let u = -hw + 2.5; u < hw - 1; u += 3.6) opening(f, u, va, 2, top - 4.6, 3.2, seed);
      solid(q, g - 1, top + (k === 0 ? 2.4 : 1));
    }
  }

  /** A villa rustica: house, press room, store wing round a yard, the yard's dolia sunk in rows, a threshing floor. */
  function farm(f: Frame, b: SuburbBuilding, seed: number): void {
    const hw = b.w / 2, hd = b.d / 2;
    const wash: RGB = [0.8, 0.72, 0.58];
    const rng = (u0: number, v0: number, u1: number, v1: number, H: number, alongU: boolean): void => {
      const q = rect(f, u0, v0, u1, v1);
      const g = minGround(q);
      const gc = ground(...f.P((u0 + u1) / 2, (v0 + v1) / 2));
      plastered(q, g - 0.6, gc, H, wash, seed, 0.9);
      if (alongU) gable(f, u0, v0, u1, v1, gc + H, seed, wash);
      else gable(frameOf(...f.P((u0 + u1) / 2, (v0 + v1) / 2), b.rot + Math.PI / 2, f.ux, f.uz), -(v1 - v0) / 2, -(u1 - u0) / 2, (v1 - v0) / 2, (u1 - u0) / 2, gc + H, seed, wash);
      solid(q, g - 0.6, gc + H + 2);
    };
    // House along the back, press room and cella vinaria down the sides; the yard opens to the road.
    rng(-hw, hd - 10, hw, hd, 7, true);
    rng(-hw, -hd + 4, -hw + 9, hd - 10, 5, false);
    rng(hw - 9, -hd + 4, hw, hd - 10, 5, false);
    opening(f, 0, hd - 10, 2.4, ground(...f.P(0, hd - 10)), 3, seed, true);
    const gy = ground(...f.P(0, 0));
    // Yard wall across the front with a gate.
    for (const [u0, u1] of [[-hw + 9, -2.5], [2.5, hw - 9]]) fbox(f, u0, -hd + 4, u1, -hd + 4.5, gy - 0.5, gy + 2.2, wash, seed, Surf.Stucco);
    if (lean) return;
    // Dolia sunk to their shoulders in the yard: the cella vinaria's jars.
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      const [x, z] = f.P(-hw + 11.5 + i * 1.9, -hd + 8 + j * 1.9);
      lathe(S, x, gy, z, [[0.56, -0.05], [0.6, 0.12], [0.45, 0.28], [0.3, 0.33], [0.32, 0.38], [0.24, 0.39], [0.22, 0.2]], 10, [0.66, 0.4, 0.27], seed, Surf.Pavement);
    }
    // The threshing floor: a paved disc.
    const [tx, tz] = f.P(hw - 15, -hd + 10);
    lathe(S, tx, gy, tz, [[0.01, 0.12], [3.4, 0.12], [3.5, 0], [3.6, -0.3]].reverse() as [number, number][], 16, [0.7, 0.64, 0.52], seed, Surf.Pavement);
    // The press: its great beam out under a shed roof against the press room.
    const [p0x, p0z] = f.P(-hw + 9.2, 0), [p1x, p1z] = f.P(-hw + 9.2 + 7, 0);
    tube(S, [p0x, gy + 1.6, p0z], [p1x, gy + 1.1, p1z], 0.25, 0.2, 6, WOOD, seed, Surf.Wood);
    const [sx, sz] = f.P(-hw + 9.2 + 7, 0);
    tube(S, [sx, gy, sz], [sx, gy + 2.2, sz], 0.18, 0.18, 6, WOOD, seed, Surf.Wood);
    box([...f.P(-hw + 15.5, -1.2), ...f.P(-hw + 17, -1.2), ...f.P(-hw + 17, 1.2), ...f.P(-hw + 15.5, 1.2)], gy - 0.2, gy + 0.6, TUFF, seed, Surf.Masonry);
  }

  return stats;
}
