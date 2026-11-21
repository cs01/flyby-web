// Herculaneum's sea front (data/herculaneum.ts) as vertex arrays: the sea
// wall with the twelve vaulted boat sheds (fornici) opening onto the beach,
// the terrace over them with the Sacred Area's two temples and the altar and
// statue of Marcus Nonius Balbus, and at the Villa of the Papyri the long pool
// of its great peristyle with the bronzes round it and the belvedere.
// buildPompeii calls this with its own emitters, as it does the suburbs, so
// all of it shares the town's vertex layout, shader and draw calls.
//
// The scene is the morning before the eruption: the sheds hold boats' gear
// and amphorae, not the people who sheltered in them that night.

import type { HerculaneumExtras } from "../data/herculaneum";
import { cliffN, frameFwd, frameInv, TERRACE_DEPTH_M } from "../data/herculaneum";
import type { ArtPlaced } from "./pompeiimesh";
import { Surf } from "./pompeiimesh";
import type { SuburbKit } from "./pompeiisuburbs";
import { figure, lathe, type RGB, type V3 } from "./pompeiiorders";

export interface HercStats {
  fornici: number;
  /** Floor level inside each shed and the terrace level over them, for the gate. */
  shedFloorY: number[];
  terraceY: number;
  /** Metres of built sea wall. */
  seaWallM: number;
  temples: number;
  statues: number;
  /** Area of the Villa of the Papyri's pool as built, m2. */
  poolM2: number;
}

const TUFF: RGB = [0.5, 0.45, 0.38];
const DARK_TUFF: RGB = [0.34, 0.3, 0.26];
const MARBLE: RGB = [0.88, 0.86, 0.8];
const TILE: RGB = [0.62, 0.31, 0.2];
const BRONZE: RGB = [0.32, 0.25, 0.14];
const NO: [number, number, number, number] = [0, 0, 0, 0];

/** The built sea wall's reach along the front, t from the frame (the Suburban Baths stand below it past its south-east end). */
const WALL_T0 = -130, WALL_T1 = 52;

export function buildHerculaneum(k: SuburbKit, h: HerculaneumExtras, o: {
  art: boolean;
  artPlaced: ArtPlaced[];
  /** A column with the town's Ionic order: x, z, base y, height. */
  orders(x: number, z: number, y0: number, h: number): void;
}): HercStats {
  const { S, F, poly, wall, box, ground, solids, lean } = k;
  const f = h.frame;
  const P = (t: number, n: number): [number, number] => frameFwd(f, t, n);
  const { beach, terrace } = h.levels;
  // Seaward and along, as unit vectors.
  const sx = -f.tz, sz = f.tx;
  const stats: HercStats = { fornici: 0, shedFloorY: [], terraceY: terrace, seaWallM: 0, temples: 0, statues: 0, poolM2: 0 };
  const top = terrace + 1.0;

  // =====================================================================================
  // The sea wall and the sheds in it.
  // =====================================================================================
  const sheds = h.fornici.map((q) => ({ ...q, t: frameInv(f, q.x, q.z)[0] }));
  const pitch = sheds.length > 1 ? sheds[1].t - sheds[0].t : 5.3;
  const shedT0 = sheds.length ? sheds[0].t - pitch / 2 : 0, shedT1 = sheds.length ? sheds[sheds.length - 1].t + pitch / 2 : 0;
  // The plain face either side of the row: opus incertum of grey tuff from the beach to the parapet.
  const STEP = 4;
  for (let t = WALL_T0; t < WALL_T1 - 1e-6; t += STEP) {
    const t1 = Math.min(WALL_T1, t + STEP);
    if (t1 > shedT0 && t < shedT1) {
      // Split round the row: only the parts outside it here.
      if (t < shedT0) faceStrip(t, shedT0);
      if (t1 > shedT1) faceStrip(shedT1, t1);
      continue;
    }
    faceStrip(t, t1);
  }
  function faceStrip(t0: number, t1: number): void {
    if (t1 - t0 < 0.05) return;
    const [ax, az] = P(t0, cliffN(t0)), [bx, bz] = P(t1, cliffN(t1));
    wall(ax, az, bx, bz, beach - 1.2, beach - 1.2, top, top, sx, sz, TUFF, 0.4, Surf.Masonry, 0, 0, t0, 1e4, beach, top - beach);
    stats.seaWallM += t1 - t0;
  }
  // The terrace: paved from the parapet back to the town front, over the
  // vaults and the cliff the terrain carries under it.
  {
    // In strips along the front, following the cliff where it bends; each
    // strip runs back to the town's ground (the slope rises inland of the terrace).
    for (let t = WALL_T0; t < WALL_T1 - 1e-6; t += STEP) {
      const t1 = Math.min(WALL_T1, t + STEP);
      const q: V3[] = [[...P(t, cliffN(t))], [...P(t1, cliffN(t1))], [...P(t1, cliffN(t1) + TERRACE_DEPTH_M + 0.5)], [...P(t, cliffN(t) + TERRACE_DEPTH_M + 0.5)]]
        .map(([x, z]): V3 => [x, terrace + 0.04, z]);
      poly(F, q, [0, 1, 0], [0.62, 0.5, 0.42], 0.3, Surf.Pavement, 0, 0, q.map((p) => [p[0], p[2], 0, 0]));
    }
    // The parapet along the edge.
    for (let t = WALL_T0; t < WALL_T1 - 0.5; t += STEP) {
      const t1 = Math.min(WALL_T1, t + STEP);
      const [ax, az] = P(t, cliffN(t) + 0.5), [bx, bz] = P(t1, cliffN(t1) + 0.5);
      wall(bx, bz, ax, az, terrace, terrace, top, top, -sx, -sz, [0.8, 0.76, 0.68], 0.4, Surf.Stucco, 0, 0, 0, STEP, terrace, 1);
      poly(S, [[ax + sx * 0.5, top, az + sz * 0.5], [bx + sx * 0.5, top, bz + sz * 0.5], [bx, top, bz], [ax, top, az]], [0, 1, 0], [0.7, 0.66, 0.58], 0.4, Surf.Kerb, 0, 0, [NO, NO, NO, NO]);
    }
    // The ends of the terrace down to the beach and the town's ground.
    for (const [t, sgn] of [[WALL_T0, -1], [WALL_T1, 1]] as const) {
      const [ax, az] = P(t, cliffN(t)), [bx, bz] = P(t, cliffN(t) + TERRACE_DEPTH_M + 0.5);
      wall(ax, az, bx, bz, beach - 1, beach - 1, top, top, f.tx * sgn, f.tz * sgn, TUFF, 0.4, Surf.Masonry, 0, 0, 0, 1e4, beach, top - beach);
    }
    // The terrace's body for the walker, except where the sheds open (their piers are their own).
    for (let t = WALL_T0; t < WALL_T1 - 1e-6; t += STEP) {
      const t1 = Math.min(WALL_T1, t + STEP);
      if (t1 > shedT0 && t < shedT1) continue;
      solids.push({ ring: [...P(t, cliffN(t)), ...P(t1, cliffN(t1)), ...P(t1, cliffN(t1) + 12), ...P(t, cliffN(t) + 12)], baseY: beach - 1, topY: top });
    }
  }

  // Each shed: an arched opening in the face, piers between, a barrel vault
  // running back into the cliff, and its back wall.
  for (const [si, q] of sheds.entries()) {
    const fl = Math.min(ground(q.x, q.z), ground(q.x - sx * q.d * 0.5, q.z - sz * q.d * 0.5));
    stats.shedFloorY.push(fl);
    stats.fornici++;
    const half = q.w / 2, spring = fl + q.h - half;
    const t0 = q.t - pitch / 2, t1 = q.t + pitch / 2;
    const face = (ta: number, tb: number, y0: number, y1: number): void => {
      const [ax, az] = P(ta, 0), [bx, bz] = P(tb, 0);
      wall(ax, az, bx, bz, y0, y0, y1, y1, sx, sz, TUFF, 0.4, Surf.Masonry, 0, 0, ta, 1e4, beach, top - beach);
    };
    // Piers either side of the opening, and the face over the crown.
    face(t0, q.t - half, beach - 1.2, top);
    face(q.t + half, t1, beach - 1.2, top);
    face(q.t - half, q.t + half, fl + q.h, top);
    stats.seaWallM += t1 - t0;
    // The spandrels: between the arch and the line of its crown.
    const N = lean ? 4 : 8;
    const arch = (a: number): [number, number] => [q.t - Math.cos(a) * half, spring + Math.sin(a) * half];
    for (let i = 0; i < N; i++) {
      const [ta, ya] = arch((i / N) * Math.PI), [tb, yb] = arch(((i + 1) / N) * Math.PI);
      const [ax, az] = P(ta, 0), [bx, bz] = P(tb, 0);
      poly(S, [[ax, ya, az], [bx, yb, bz], [bx, fl + q.h, bz], [ax, fl + q.h, az]], [sx, 0, sz], TUFF, 0.4, Surf.Masonry, 0, 0, [[ta, ya - beach, 1e4, top - beach], [tb, yb - beach, 1e4, top - beach], [tb, fl + q.h - beach, 1e4, top - beach], [ta, fl + q.h - beach, 1e4, top - beach]]);
      // The vault's soffit, back to the shed's end.
      const [cx, cz] = P(ta, 0), [dx, dz] = P(tb, 0);
      const back = (x: number, z: number): [number, number] => [x - sx * q.d, z - sz * q.d];
      const [ex2, ez2] = back(dx, dz), [fx2, fz2] = back(cx, cz);
      const am = ((i + 0.5) / N) * Math.PI;
      const inX = Math.cos(am) * f.tx, inZ = Math.cos(am) * f.tz;
      poly(S, [[cx, ya, cz], [dx, yb, dz], [ex2, yb, ez2], [fx2, ya, fz2]], [inX, -Math.sin(am), inZ], DARK_TUFF, 0.5, Surf.Interior, 0, 0, [NO, NO, NO, NO]);
    }
    // Side walls inside, up to the springing, and the back wall.
    const [la, lz] = P(q.t - half, 0), [ra, rz] = P(q.t + half, 0);
    const bk = (x: number, z: number): [number, number] => [x - sx * q.d, z - sz * q.d];
    const [lb, lbz] = bk(la, lz), [rb, rbz] = bk(ra, rz);
    wall(la, lz, lb, lbz, fl - 0.5, fl - 0.5, spring, spring, f.tx, f.tz, DARK_TUFF, 0.5, Surf.Interior, 0, 0, 0, q.d, fl, q.h);
    wall(rb, rbz, ra, rz, fl - 0.5, fl - 0.5, spring, spring, -f.tx, -f.tz, DARK_TUFF, 0.5, Surf.Interior, 0, 0, 0, q.d, fl, q.h);
    wall(lb, lbz, rb, rbz, fl - 0.5, fl - 0.5, fl + q.h, fl + q.h, sx, sz, DARK_TUFF, 0.5, Surf.Interior, 1, 0, 0, q.w, fl, q.h);
    // Each shed's piers as solids, so the walker goes in through the arch, not the wall.
    solids.push({ ring: [...P(t0, -0.3), ...P(q.t - half, -0.3), ...P(q.t - half, q.d), ...P(t0, q.d)], baseY: fl - 1, topY: top });
    // Gear left in the sheds: amphorae stood along the back wall, a coil of rope.
    if (!lean) {
      for (let j = 0; j < 3; j++) {
        if ((si + j) % 3 === 2) continue;
        const [ax, az] = P(q.t - half + 0.7 + j * 1.3, 0);
        const x = ax - sx * (q.d - 0.5), z = az - sz * (q.d - 0.5);
        lathe(S, x, fl, z, [[0.02, 0], [0.12, 0.2], [0.22, 0.55], [0.2, 0.85], [0.08, 0.95], [0.06, 1.1], [0.07, 1.12]], 8, [0.62, 0.38, 0.26], 0.4 + j * 0.1, Surf.Pavement);
      }
    }
  }

  // =====================================================================================
  // The Sacred Area: two small temples on the terrace, facing the sea.
  // =====================================================================================
  for (const [ti, tp] of h.temples.entries()) {
    const [t, n] = frameInv(f, tp.x, tp.z);
    // Front on the seaward side; the podium 6.5 m along the front, 10 m deep.
    const W = 6.5, D = 10, nF = Math.max(1.2, n - D / 2), nB = nF + D;
    const g = terrace + 0.04, pod = g + 1.5;
    const Q = (u: number, v: number): [number, number] => P(t + u, v);
    const rect = (u0: number, v0: number, u1: number, v1: number): number[] => [...Q(u0, v0), ...Q(u1, v0), ...Q(u1, v1), ...Q(u0, v1)];
    box(rect(-W / 2, nF, W / 2, nB), terrace - 0.5, pod, [0.74, 0.68, 0.58], 0.3 + ti * 0.1, Surf.Masonry, Surf.Marble, [0.82, 0.8, 0.74]);
    // The cella behind a porch of four columns.
    const cellaH = 5.2;
    box(rect(-W / 2 + 0.3, nF + 3, W / 2 - 0.3, nB - 0.3), pod, pod + cellaH, [0.86, 0.8, 0.68], 0.3 + ti * 0.1, Surf.Stucco);
    for (let c = 0; c < 4; c++) {
      const [x, z] = Q(-W / 2 + 0.6 + (c * (W - 1.2)) / 3, nF + 0.7);
      o.orders(x, z, pod, cellaH - 0.4);
    }
    // Gable roof, ridge front to back, and the pediment on the sea side.
    const rise = 1.6, yE = pod + cellaH;
    const [fl0x, fl0z] = Q(-W / 2, nF), [fr0x, fr0z] = Q(W / 2, nF), [bl0x, bl0z] = Q(-W / 2, nB), [br0x, br0z] = Q(W / 2, nB);
    const [rfx, rfz] = Q(0, nF), [rbx, rbz] = Q(0, nB);
    poly(S, [[fl0x, yE, fl0z], [bl0x, yE, bl0z], [rbx, yE + rise, rbz], [rfx, yE + rise, rfz]], [-f.tx, 1, -f.tz], TILE, 0.3, Surf.Tile, 0, 0, [[0, 0, D, W / 2], [D, 0, D, W / 2], [D, W / 2, D, W / 2], [0, W / 2, D, W / 2]]);
    poly(S, [[br0x, yE, br0z], [fr0x, yE, fr0z], [rfx, yE + rise, rfz], [rbx, yE + rise, rbz]], [f.tx, 1, f.tz], TILE, 0.3, Surf.Tile, 0, 0, [[0, 0, D, W / 2], [D, 0, D, W / 2], [D, W / 2, D, W / 2], [0, W / 2, D, W / 2]]);
    poly(S, [[fl0x, yE, fl0z], [fr0x, yE, fr0z], [rfx, yE + rise, rfz]], [sx, 0, sz], [0.86, 0.82, 0.72], 0.3, Surf.Stucco, 0, 0, [NO, NO, NO]);
    poly(S, [[br0x, yE, br0z], [bl0x, yE, bl0z], [rbx, yE + rise, rbz]], [-sx, 0, -sz], [0.86, 0.82, 0.72], 0.3, Surf.Stucco, 0, 0, [NO, NO, NO]);
    // The porch ceiling, seen from the steps.
    const [pr, prz] = Q(W / 2, nF + 3), [pl, plz] = Q(-W / 2, nF + 3);
    poly(S, [[fl0x, yE, fl0z], [fr0x, yE, fr0z], [pr, yE, prz], [pl, yE, plz]], [0, -1, 0], [0.5, 0.42, 0.34], 0.3, Surf.Wood, 0, 0, [NO, NO, NO, NO]);
    solids.push({ ring: rect(-W / 2, nF, W / 2, nB), baseY: terrace - 0.5, topY: yE + rise });
    stats.temples++;
  }

  // =====================================================================================
  // Marcus Nonius Balbus: his funerary altar and his statue on the terrace.
  // =====================================================================================
  {
    const b = h.balbus;
    const [t, n] = frameInv(f, b.x, b.z);
    const g = Math.max(terrace, ground(b.x, b.z)) + 0.04;
    const Q = (u: number, v: number): [number, number] => P(t + u, n + v);
    const rect = (u0: number, v0: number, u1: number, v1: number): number[] => [...Q(u0, v0), ...Q(u1, v0), ...Q(u1, v1), ...Q(u0, v1)];
    // The altar on its steps: marble, the inscription on the face to the sea.
    box(rect(-1.6, -1.2, 1.6, 1.2), g, g + 0.35, MARBLE, 0.6, Surf.Marble);
    box(rect(-1.0, -0.7, 1.0, 0.7), g + 0.35, g + 1.6, MARBLE, 0.6, Surf.Marble);
    box(rect(-1.15, -0.85, 1.15, 0.85), g + 1.6, g + 1.85, MARBLE, 0.6, Surf.Marble);
    const [fx, fz] = Q(0, -0.72);
    wall(fx + f.tx * -0.7, fz + f.tz * -0.7, fx + f.tx * 0.7, fz + f.tz * 0.7, g + 0.6, g + 0.6, g + 1.4, g + 1.4, sx, sz, MARBLE, 0.6, Surf.Marble, 0, 1, 0, 1.4, g + 0.6, 0.8);
    // The statue on its base behind the altar, in a cuirass, facing the sea.
    box(rect(-0.8, 2.2, 0.8, 3.6), g, g + 1.7, MARBLE, 0.62, Surf.Marble);
    const [mx, mz] = Q(0, 2.9);
    figure(S, [mx, g + 1.7, mz], Math.atan2(sx, sz), 1.12, "togate", [0.86, 0.84, 0.78], Surf.Stucco);
    stats.statues++;
    solids.push({ ring: rect(-1.6, -1.2, 1.6, 3.6), baseY: g, topY: g + 3.9 });
  }

  // =====================================================================================
  // The Villa of the Papyri: the pool of the great peristyle, its bronzes, the belvedere.
  // =====================================================================================
  if (h.papyri.pool.length === 8) {
    const pool = h.papyri.pool;
    const corners: [number, number][] = [0, 1, 2, 3].map((i) => [pool[i * 2], pool[i * 2 + 1]]);
    let gl = Infinity;
    for (const [x, z] of corners) gl = Math.min(gl, ground(x, z));
    const g = gl + 0.4;
    const water = g - 0.25;
    const pts: V3[] = corners.map(([x, z]): V3 => [x, water, z]);
    poly(S, pts, [0, 1, 0], [0.22, 0.34, 0.36], 0.5, Surf.Water, 1, 0, pts.map((p) => [p[0], p[2], 0, 0]));
    // Marble rim round it, a step up from the garden.
    for (let e = 0; e < 4; e++) {
      const [ax, az] = corners[e], [bx, bz] = corners[(e + 1) % 4];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      let nx = (bz - az) / L, nz = -(bx - ax) / L;
      const [cx, cz] = [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2];
      if ((ax + bx) / 2 * nx + (az + bz) / 2 * nz - (cx * nx + cz * nz) < 0) { nx = -nx; nz = -nz; }
      box([ax, az, bx, bz, bx + nx * 0.6, bz + nz * 0.6, ax + nx * 0.6, az + nz * 0.6], water - 0.6, g + 0.1, MARBLE, 0.55, Surf.Marble);
      // Its inner face, down to the water.
      wall(bx, bz, ax, az, water - 0.6, water - 0.6, g + 0.1, g + 0.1, -nx, -nz, [0.7, 0.72, 0.7], 0.55, Surf.Marble, 0, 0, 0, L, water, 0.6);
    }
    const area = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) * Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1]);
    stats.poolM2 = area;
    // The bronzes (the Runners, the Dancers, the Sleeping and Drunken Satyrs)
    // stood round the peristyle: a line each side of the pool.
    if (!lean) {
      const ux = corners[1][0] - corners[0][0], uz = corners[1][1] - corners[0][1], uL = Math.hypot(ux, uz) || 1;
      const vx = corners[3][0] - corners[0][0], vz = corners[3][1] - corners[0][1], vL = Math.hypot(vx, vz) || 1;
      for (let i = 0; i < 5; i++) for (const side of [-1, 1]) {
        const u = uL * (0.1 + 0.2 * i);
        const v = side < 0 ? -2.2 : vL + 2.2;
        const x = corners[0][0] + (ux / uL) * u + (vx / vL) * v, z = corners[0][1] + (uz / uL) * u + (vz / vL) * v;
        const gy = ground(x, z) + 0.4;
        box([x - 0.35, z - 0.35, x + 0.35, z - 0.35, x + 0.35, z + 0.35, x - 0.35, z + 0.35], gy - 0.2, gy + 0.9, MARBLE, 0.5, Surf.Marble);
        figure(S, [x, gy + 0.9, z], Math.atan2(-side * vx, -side * vz), 0.95, "togate", BRONZE, Surf.Hide);
        stats.statues++;
      }
    }
  }
  {
    // The belvedere: a round pavilion at the villa's sea end (an estimate of its place).
    const { x, z } = h.papyri.belvedere;
    if (x || z) {
      const g = ground(x, z) + 0.4;
      lathe(S, x, g - 1, z, [[5.2, 0], [5.2, 1.0], [5.0, 1.05], [0.01, 1.05]], lean ? 12 : 24, [0.8, 0.76, 0.68], 0.5, Surf.Marble);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        o.orders(x + Math.cos(a) * 4.4, z + Math.sin(a) * 4.4, g + 0.05, 4.6);
      }
      lathe(S, x, g + 4.6, z, [[4.9, 0], [4.9, 0.5], [4.6, 0.6], [3.2, 1.6], [1.2, 2.4], [0.01, 2.6]], lean ? 12 : 24, TILE, 0.5, Surf.Tile);
      solids.push({ ring: [x - 5, z - 5, x + 5, z - 5, x + 5, z + 5, x - 5, z + 5], baseY: g - 1, topY: g + 7.2 });
    }
  }
  return stats;
}
