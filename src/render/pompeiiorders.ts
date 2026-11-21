// The classical orders and the small modelled things of the town: Doric,
// Ionic and Corinthian columns to Vitruvius's proportions, statues, the
// bakeries' lava mills and ovens, a thermopolium's counter. Pure geometry
// (no THREE), written into any vertex store with the town's layout, so the
// gate can measure it under Bun.
//
// Columns are built in units of the lower diameter D and scaled per
// instance by render/pompeii.ts; a far column is the plain tapered prism
// pompeiimesh.ts leaves in the town mesh, hidden inside this one up close.

import { buildStatue, emitStatue } from "./statues";

export type V3 = [number, number, number];
export type RGB = [number, number, number];

/** What the props write into: render/pompeiimesh.ts's Store. */
export interface Sink {
  n: number;
  vert(p: V3, n: V3, c: RGB, seed: number, s: number, p1: number, p2: number, w: [number, number, number, number]): number;
  tri(a: number, b: number, c: number): void;
}

export const enum Order { Doric = 0, Ionic = 1, Corinthian = 2 }

/**
 * Vitruvius, De architectura III.3 and IV.1-3, with D the lower diameter:
 * the Doric column, capital included, 7 D and no base (IV.3.4: fourteen
 * modules of D/2); the Ionic 9 D with an Attic base of D/2 and a capital
 * about D/3 to the volutes' foot (IV.1.8, III.5); the Corinthian the Ionic
 * shaft and base under a capital a full D high (IV.1.11), so 10 D. The shaft
 * diminishes to 5/6 D at the top for columns up to fifteen feet (III.3.12).
 */
export const ORDERS = [
  { name: "doric", height: 7, base: 0, capital: 0.5, flutes: 20, fillets: false },
  { name: "ionic", height: 9, base: 0.5, capital: 0.36, flutes: 24, fillets: true },
  { name: "corinthian", height: 10, base: 0.5, capital: 1, flutes: 24, fillets: true },
] as const;
export const TOP_DIAMETER = 5 / 6;

const SURF_STUCCO = 4, SURF_COLUMN = 15;

/** A surface of revolution about the y axis: profile (radius, y) pairs, smooth normals. */
export function lathe(st: Sink, cx: number, cy: number, cz: number, prof: [number, number][], sides: number, c: RGB, seed: number, style: number, p1 = 0, p2 = 0, H = 0, wobble?: (a: number, t: number) => number): void {
  const base = st.n;
  for (let k = 0; k < prof.length; k++) {
    const [r, y] = prof[k];
    // Profile slope for the normal.
    const a = prof[Math.max(0, k - 1)], b = prof[Math.min(prof.length - 1, k + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    for (let j = 0; j <= sides; j++) {
      const t = (j / sides) * Math.PI * 2;
      const rr = r * (wobble ? wobble(t, k / Math.max(1, prof.length - 1)) : 1);
      const ca = Math.cos(t), sa = Math.sin(t);
      // Outward normal: perpendicular to the profile's tangent (dr, dy).
      let nx = dy * ca, ny = -dr, nz = dy * sa;
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      st.vert([cx + ca * rr, cy + y, cz + sa * rr], [nx, ny, nz], c, seed, style, p1, p2, [j / sides, y, 0, H]);
    }
  }
  for (let k = 0; k + 1 < prof.length; k++) for (let j = 0; j < sides; j++) {
    const a = base + k * (sides + 1) + j, b = a + 1, d = a + sides + 1, e = d + 1;
    st.tri(a, d, b); st.tri(b, d, e);
  }
}

/** An axis-aligned box, outward faces. */
export function cube(st: Sink, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB, seed: number, style: number): void {
  const faces: [V3, V3[]][] = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]],
    [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
  ];
  for (const [n, q] of faces) {
    const b = st.n;
    q.forEach((p) => st.vert(p, n, c, seed, style, 0, 0, [p[0] + p[2], p[1], 0, 0]));
    st.tri(b, b + 1, b + 2); st.tri(b, b + 2, b + 3);
  }
}

/** A tapered tube between two points (limbs, levers), capped. */
export function tube(st: Sink, a: V3, b: V3, ra: number, rb: number, sides: number, c: RGB, seed: number, style: number, p1 = 0): void {
  const ax: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...ax) || 1;
  const d: V3 = [ax[0] / L, ax[1] / L, ax[2] / L];
  const ref: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: V3 = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
  const ul = Math.hypot(...u); u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const base = st.n;
  for (const [p, r] of [[a, ra], [b, rb]] as const) for (let j = 0; j <= sides; j++) {
    const t = (j / sides) * Math.PI * 2, ca = Math.cos(t), sa = Math.sin(t);
    const n: V3 = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
    st.vert([p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r], n, c, seed, style, p1, 0, [j / sides, 0, 0, 0]);
  }
  for (let j = 0; j < sides; j++) {
    const i0 = base + j, i1 = i0 + 1, k0 = i0 + sides + 1, k1 = k0 + 1;
    st.tri(i0, i1, k0); st.tri(i1, k1, k0);
  }
  for (const [p, r, n, off] of [[a, ra, [-d[0], -d[1], -d[2]], 0], [b, rb, d, sides + 1]] as const) {
    if (r < 0.01) continue;
    const ci = st.vert(p, n as V3, c, seed, style, p1, 0, [0, 0, 0, 0]);
    void r;
    for (let j = 0; j < sides; j++) {
      if (off === 0) st.tri(ci, base + j + 1, base + j); else st.tri(ci, base + off + j, base + off + j + 1);
    }
  }
}

/** A sphere-ish lump (heads, the oven dome), latitude bands from lat0 to lat1. */
export function dome(st: Sink, c: V3, rx: number, ry: number, rz: number, col: RGB, seed: number, style: number, lat0 = -Math.PI / 2, lat1 = Math.PI / 2, sides = 10, bands = 6, p1 = 0): void {
  const prof: [number, number][] = [];
  for (let k = 0; k <= bands; k++) {
    const a = lat0 + ((lat1 - lat0) * k) / bands;
    prof.push([Math.max(1e-3, Math.cos(a)), Math.sin(a)]);
  }
  const base = st.n;
  lathe(st, 0, 0, 0, prof, sides, col, seed, style, p1);
  // Scale the unit lathe into the ellipsoid in place.
  void base;
  const s = st as unknown as { pos: Float32Array };
  if (s.pos) for (let i = base; i < st.n; i++) {
    s.pos[i * 3] = c[0] + s.pos[i * 3] * rx; s.pos[i * 3 + 1] = c[1] + s.pos[i * 3 + 1] * ry; s.pos[i * 3 + 2] = c[2] + s.pos[i * 3 + 2] * rz;
  }
}

// =====================================================================================
// Columns.
// =====================================================================================

/** Shaft radius at height fraction t: straight taper to 5/6 with a slight entasis swell. */
export function shaftRadius(t: number): number {
  return 0.5 * (1 - (1 - TOP_DIAMETER) * t) + 0.008 * Math.sin(Math.PI * t);
}

/** One column of an order, lower diameter 1, standing on y = 0. Stucco white; the shaft fluted in the shader. */
export function columnTemplate(st: Sink, order: Order, lean: boolean): void {
  const O = ORDERS[order];
  const W: RGB = [0.9, 0.87, 0.8];
  const sides = lean ? 12 : 24;
  const shaft0 = O.base, shaft1 = O.height - O.capital;
  const Hs = shaft1 - shaft0;
  // --- base ---
  if (O.base > 0) {
    // Attic base: plinth, lower torus, scotia, upper torus (III.5.1-2).
    cube(st, -0.69, 0, -0.69, 0.69, 0.17, 0.69, W, 0.5, SURF_STUCCO);
    const prof: [number, number][] = [];
    const tor = (r0: number, y0: number, h: number, bulge: number, n: number): void => {
      for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI; prof.push([r0 + bulge * Math.sin(a), y0 + (h * (1 - Math.cos(a))) / 2]); }
    };
    tor(0.6, 0.17, 0.12, 0.07, lean ? 3 : 6);
    prof.push([0.53, 0.31], [0.5, 0.35], [0.53, 0.39]);
    tor(0.55, 0.39, 0.09, 0.05, lean ? 3 : 5);
    prof.push([0.51, 0.49], [0.5, 0.5]);
    lathe(st, 0, 0, 0, prof, sides, W, 0.5, SURF_STUCCO);
  }
  // --- shaft ---
  {
    const rings = lean ? 4 : 8;
    const prof: [number, number][] = [];
    for (let k = 0; k <= rings; k++) { const t = k / rings; prof.push([shaftRadius(t), shaft0 + Hs * t]); }
    // aWall.w carries the shaft's height so the shader's red lower third and flutes find their extent.
    lathe(st, 0, 0, 0, prof, sides, W, 0.5, SURF_COLUMN, O.flutes, O.fillets ? 1 : 0, shaft1);
  }
  const rTop = shaftRadius(1);
  const y = shaft1;
  if (order === Order.Doric) {
    // Necking and three annulets, the echinus a stiff quarter curve out to
    // the abacus, a square slab 2 1/6 modules across (IV.3.4).
    const prof: [number, number][] = [[rTop, y], [rTop + 0.02, y + 0.02], [rTop, y + 0.04], [rTop + 0.02, y + 0.06], [rTop, y + 0.08], [rTop, y + 0.17]];
    const n = lean ? 3 : 6;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      prof.push([rTop + (0.54 - rTop) * Math.sin((t * Math.PI) / 2) ** 0.8, y + 0.17 + 0.16 * t]);
    }
    prof.push([0.3, y + 0.335]);
    lathe(st, 0, 0, 0, prof, sides, W, 0.5, SURF_STUCCO);
    cube(st, -0.54, y + 0.333, -0.54, 0.54, y + 0.5, 0.54, W, 0.5, SURF_STUCCO);
  } else if (order === Order.Ionic) {
    // Echinus with its egg-and-dart (a scalloped ring), the cushion running
    // across between the two volutes, a thin abacus.
    lathe(st, 0, 0, 0, [[rTop, y], [rTop + 0.06, y + 0.07], [rTop + 0.04, y + 0.15], [0.2, y + 0.16]], sides, W, 0.5, SURF_STUCCO, 0, 0, 0,
      lean ? undefined : (a, t) => 1 + (t > 0.2 && t < 0.8 ? 0.05 * Math.max(0, Math.cos(a * 12)) : 0));
    // The cushion: a cylinder along x under the abacus, pinched at its middle (the balteus).
    const cr = 0.13, cy = y + 0.2;
    const cush: [number, number][] = [];
    for (let k = 0; k <= 6; k++) { const t = k / 6; cush.push([cr * (1 - 0.25 * Math.sin(Math.PI * t)), -0.5 + t]); }
    const before = st.n;
    lathe(st, 0, 0, 0, cush, lean ? 8 : 12, W, 0.5, SURF_STUCCO);
    rotateRange(st, before, (p) => [p[1], cy + p[0], p[2]]);
    // The volutes: a spiral of 2 1/2 turns on each face of each end.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) spiral(st, [sx * 0.5, cy, sz * 0.14], sz, 0.17, lean ? 10 : 18, W);
    cube(st, -0.55, y + 0.32, -0.32, 0.55, y + 0.36, 0.32, W, 0.5, SURF_STUCCO);
  } else {
    // Corinthian: the bell (kalathos), two rows of eight acanthus leaves
    // curling out at the tips, the caulicoli and corner volutes, and the
    // abacus with its concave sides (IV.1.11-12).
    const H = O.capital;
    lathe(st, 0, 0, 0, [[rTop, y], [rTop + 0.02, y + 0.04], [0.44, y + 0.3], [0.49, y + 0.7 * H], [0.53, y + 0.82 * H]], sides, W, 0.5, SURF_STUCCO);
    for (let row = 0; row < 2; row++) {
      const n = 8, h = row === 0 ? H * 0.36 : H * 0.6, phase = row === 0 ? 0 : Math.PI / 8;
      for (let k = 0; k < n; k++) leaf(st, phase + (k / n) * Math.PI * 2, y + 0.03, h, row === 0 ? rTop + 0.02 : rTop - 0.01, lean ? 3 : 6, W);
    }
    // Corner volutes, rolled out under the abacus's horns.
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const cxz: V3 = [Math.cos(a) * 0.6, y + 0.82 * H, Math.sin(a) * 0.6];
      const before = st.n;
      spiral(st, [0, 0, 0], 1, 0.1, lean ? 8 : 14, W);
      // Face the spiral outward along the diagonal.
      rotateRange(st, before, (p) => [cxz[0] + p[0] * Math.sin(a) + p[2] * Math.cos(a), cxz[1] + p[1], cxz[2] - p[0] * Math.cos(a) + p[2] * Math.sin(a)]);
    }
    // Abacus: an octagon with the four sides drawn in, a slab H/7 deep.
    const ab: [number, number][] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + Math.PI / 4;
      const horn = k % 4 === 0;
      const r = horn ? 0.82 : k % 2 === 0 ? 0.62 : 0.68;
      ab.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    prism(st, ab, y + 0.86 * H, y + H, W);
  }
}

/** Remap the positions of vertices [from, st.n) (normals follow only roughly; these parts are small). */
function rotateRange(st: Sink, from: number, f: (p: V3) => V3): void {
  const s = st as unknown as { pos: Float32Array; nrm: Int8Array };
  for (let i = from; i < st.n; i++) {
    const p = f([s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]]);
    s.pos[i * 3] = p[0]; s.pos[i * 3 + 1] = p[1]; s.pos[i * 3 + 2] = p[2];
    const n = f([s.nrm[i * 4] / 127, s.nrm[i * 4 + 1] / 127, s.nrm[i * 4 + 2] / 127]);
    const o = f([0, 0, 0]);
    const nx = n[0] - o[0], ny = n[1] - o[1], nz = n[2] - o[2], L = Math.hypot(nx, ny, nz) || 1;
    s.nrm[i * 4] = Math.round((nx / L) * 127); s.nrm[i * 4 + 1] = Math.round((ny / L) * 127); s.nrm[i * 4 + 2] = Math.round((nz / L) * 127);
  }
}

/** A volute: an Archimedean spiral swept as a small tube, in the x-y plane at depth z, facing sz. */
function spiral(st: Sink, c: V3, sz: number, R: number, n: number, col: RGB): void {
  const turns = 2.5;
  let prev: V3 | null = null;
  for (let k = 0; k <= n; k++) {
    const t = k / n, a = t * turns * Math.PI * 2;
    const r = R * (1 - 0.85 * t);
    const p: V3 = [c[0] + Math.cos(a) * r * Math.sign(c[0] || 1), c[1] - Math.sin(a) * r, c[2] + sz * 0.01];
    if (prev) tube(st, prev, p, 0.022 * (1 - 0.5 * t), 0.022 * (1 - 0.5 * (t + 1 / n)), 4, col, 0.5, SURF_STUCCO);
    prev = p;
  }
}

/** One acanthus leaf: a ribbed strip up the bell, its tip bent out and down. */
function leaf(st: Sink, ang: number, y0: number, h: number, r0: number, n: number, col: RGB): void {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const base = st.n;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    // Out from the bell, curling over in the top quarter.
    const out = r0 + 0.04 + 0.08 * t * t + (t > 0.75 ? 0.12 * (t - 0.75) / 0.25 : 0);
    const y = y0 + h * (t < 0.85 ? t : 0.85 + (t - 0.85) * 0.3);
    const halfW = 0.13 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)) + 0.01;
    for (const s of [-1, 0, 1]) {
      // The midrib stands proud; the lobes either side lie back.
      const rr = out + (s === 0 ? 0.025 : -0.01);
      const tx = -sa * s * halfW, tz = ca * s * halfW;
      const nrm: V3 = [ca * 0.8 - sa * s * 0.5, 0.3, sa * 0.8 + ca * s * 0.5];
      st.vert([ca * rr + tx, y, sa * rr + tz], nrm, col, 0.5, SURF_STUCCO, 0, 0, [0, 0, 0, 0]);
    }
  }
  for (let k = 0; k < n; k++) for (let s = 0; s < 2; s++) {
    const a = base + k * 3 + s, b = a + 1, c = a + 3, d = c + 1;
    st.tri(a, c, b); st.tri(b, c, d);
  }
}

/** A vertical prism over an xz polygon (CCW seen from above), with top. */
function prism(st: Sink, poly: [number, number][], y0: number, y1: number, col: RGB): void {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % n];
    let nx = bz - az, nz = -(bx - ax);
    if (nx * (ax + bx) + nz * (az + bz) < 0) { nx = -nx; nz = -nz; }
    const L = Math.hypot(nx, nz) || 1;
    const b = st.n;
    for (const p of [[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]] as V3[]) st.vert(p, [nx / L, 0, nz / L], col, 0.5, SURF_STUCCO, 0, 0, [0, 0, 0, 0]);
    st.tri(b, b + 2, b + 1); st.tri(b, b + 3, b + 2);
  }
  const c = st.vert([0, y1, 0], [0, 1, 0], col, 0.5, SURF_STUCCO, 0, 0, [0, 0, 0, 0]);
  const b0 = st.n;
  for (const [x, z] of poly) st.vert([x, y1, z], [0, 1, 0], col, 0.5, SURF_STUCCO, 0, 0, [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) st.tri(c, b0 + ((i + 1) % n), b0 + i);
}

// =====================================================================================
// Figures: the togate statues of the tombs and of Herculaneum.
// =====================================================================================

/** The one figure type still placed through here; the rest are render/statues.ts's. */
export type Pose = "togate";

/**
 * A togate statue, sculpted (render/statues.ts) at its coarsest: these
 * stand on tombs and in Herculaneum in numbers. A figure 1.75 m tall at scale
 * 1, its front to (sin yaw, cos yaw). A pale `col` is painted marble or
 * stucco; Surf 14 (the old bronze) is bronze.
 */
export function figure(st: Sink, at: V3, yaw: number, scale: number, pose: Pose, col: RGB, style: number): void {
  void pose;
  const marble = style !== 14 && col[0] > 0.5;
  emitStatue(st, buildStatue("togate", true, { marble, tiny: true }), at, yaw, (scale * 1.75) / 1.7);
}

// =====================================================================================
// Bakery and thermopolium.
// =====================================================================================

/**
 * A Pompeian donkey mill: the fixed lower stone (meta), a cone on a
 * cylindrical base, and over it the hourglass upper stone (catillus) with
 * the square sockets for the wooden lever on its waist. Grey vesicular lava
 * from Orvieto or Roccamonfina; about 1.8 m high overall.
 */
export function mill(st: Sink, x: number, y: number, z: number, yaw: number, seed: number, lean: boolean): void {
  const lava: RGB = [0.33, 0.32, 0.31];
  const sides = lean ? 10 : 18;
  // Masonry base with its raised lip and the trough the flour fell into.
  lathe(st, x, y, z, [[0.01, 0.62], [0.86, 0.62], [0.86, 0.5], [0.8, 0.5], [0.8, 0], [0.01, 0]].reverse() as [number, number][], sides, [0.5, 0.45, 0.38], seed, 10);
  // Meta: the cone on its drum.
  lathe(st, x, y, z, [[0.5, 0.62], [0.5, 0.82], [0.44, 0.9], [0.06, 1.5], [0.01, 1.52]], sides, lava, seed, 2);
  // Catillus: two hollow cones apex to apex, the lower one sitting on the meta.
  lathe(st, x, y, z, [[0.56, 0.82], [0.5, 0.95], [0.3, 1.22], [0.27, 1.27], [0.3, 1.32], [0.5, 1.62], [0.56, 1.76], [0.5, 1.78], [0.3, 1.5]], sides, lava, seed, 2);
  // The lever: a beam through the waist sockets, sticking out both sides.
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  tube(st, [x - ca * 1.3, y + 1.27, z - sa * 1.3], [x + ca * 1.3, y + 1.27, z + sa * 1.3], 0.06, 0.06, 5, [0.36, 0.25, 0.15], seed, 7);
  cube(st, x - 0.12, y + 1.19, z - 0.12, x + 0.12, y + 1.35, z + 0.12, [0.36, 0.25, 0.15], seed, 7);
}

/**
 * The bakery's oven: a masonry block with a low dome over the baking
 * chamber, the arched mouth facing the room, a flue above it. The one in
 * Modestus's bakery held 81 loaves when it was dug out.
 */
export function oven(st: Sink, x: number, y: number, z: number, yaw: number, seed: number): void {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const brick: RGB = [0.58, 0.36, 0.26];
  const before = st.n;
  cube(st, -1.8, 0, -1.6, 1.8, 1.6, 1.6, [0.66, 0.6, 0.5], seed, 10);
  dome(st, [0, 1.6, -0.1], 1.45, 0.95, 1.35, brick, seed, 10, 0, Math.PI / 2, 14, 5);
  // The mouth: a dark arch on the front face, and the flue's chimney.
  cube(st, -0.42, 0.55, 1.6, 0.42, 1.35, 1.66, [0.05, 0.04, 0.04], seed, 6);
  cube(st, -0.5, 1.4, 1.2, 0.5, 2.8, 1.6, [0.62, 0.56, 0.46], seed, 10);
  const s = st as unknown as { pos: Float32Array; nrm: Int8Array };
  for (let i = before; i < st.n; i++) {
    const px = s.pos[i * 3], pz = s.pos[i * 3 + 2];
    s.pos[i * 3] = x + px * ca + pz * sa; s.pos[i * 3 + 1] += y; s.pos[i * 3 + 2] = z - px * sa + pz * ca;
    const nx = s.nrm[i * 4] / 127, nz = s.nrm[i * 4 + 2] / 127;
    s.nrm[i * 4] = Math.round((nx * ca + nz * sa) * 127); s.nrm[i * 4 + 2] = Math.round((-nx * sa + nz * ca) * 127);
  }
}
