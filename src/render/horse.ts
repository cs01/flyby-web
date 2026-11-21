// A horse as smooth lofted geometry with a 16-bone rig, and the gaits that
// pose it. Pure (no THREE) so test/pompeii.check.ts can measure it under Bun;
// render/pompeii.ts skins it in the vertex shader for the cart and builds
// the Forum's bronze riders from the same mesh in a held pose.
//
// Proportions are a light Roman draught horse, about 1.45 m at the withers
// (14 hands; the horses on Roman reliefs and the skeletons from Herculaneum
// run 1.3-1.5 m). +z forward, y up, the hooves on y = 0.
//
// Bones: 0 body, 1 neck, 2 head, 3 tail, then three per leg (upper, cannon,
// pastern and hoof) for the left fore, right fore, left hind, right hind.

export const HORSE_BONES = 16;
/** Withers height of the rest pose, metres. */
export const HORSE_WITHERS_M = 1.47;

export interface HorseMesh {
  position: Float32Array;
  normal: Int8Array;
  colour: Uint8Array;
  surf: Uint8Array;
  wall: Float32Array;
  /** bone a, bone b, weight of b (0..255), unused. */
  skin: Uint8Array;
  index: Uint32Array;
  triangles: number;
}

type V3 = [number, number, number];
type RGB = [number, number, number];

const COAT: RGB = [0.33, 0.15, 0.07];
const POINTS: RGB = [0.07, 0.055, 0.045];
const MUZZLE: RGB = [0.16, 0.11, 0.08];
const HOOF: RGB = [0.16, 0.14, 0.12];

/** The four legs' joints in the rest pose: top pivot (shoulder or hip), knee or hock, fetlock, toe. */
export const LEGS: { x: number; pivot: V3; mid: V3; fet: V3; toe: V3; fore: boolean }[] = [];
for (const fore of [true, false]) for (const s of [1, -1]) {
  const x = s * (fore ? 0.17 : 0.18);
  LEGS.push(fore
    ? { x, pivot: [x, 1.12, 0.6], mid: [x, 0.49, 0.52], fet: [x, 0.19, 0.53], toe: [x, 0, 0.61], fore }
    : { x, pivot: [x, 1.16, -0.5], mid: [x, 0.54, -0.66], fet: [x, 0.19, -0.6], toe: [x, 0, -0.52], fore });
}

class Builder {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; surf: number[] = []; wall: number[] = []; skin: number[] = [];
  idx: number[] = [];
  vert(p: V3, c: RGB, hair: number, b0: number, b1: number, w: number, u = 0, v = 0): number {
    const i = this.pos.length / 3;
    this.pos.push(...p); this.nrm.push(0, 0, 0); this.col.push(...c);
    this.surf.push(14, hair, 0, 0); this.wall.push(u, v, 0, 0); this.skin.push(b0, b1, Math.round(w * 255), 0);
    return i;
  }
  /** A grid of rings: ring k, vertex j; closed round, optionally capped. */
  loft(rings: { pts: V3[]; c: RGB[]; b0: number; b1: number; w: number }[], capStart: boolean, capEnd: boolean, hair = 0): void {
    const m = rings[0].pts.length;
    const base = this.pos.length / 3;
    rings.forEach((r, k) => r.pts.forEach((p, j) => this.vert(p, r.c[j], hair, r.b0, r.b1, r.w, j / m, k / (rings.length - 1))));
    for (let k = 0; k + 1 < rings.length; k++) for (let j = 0; j < m; j++) {
      const a = base + k * m + j, b = base + k * m + ((j + 1) % m), c = a + m, d = b + m;
      this.idx.push(a, c, b, b, c, d);
    }
    const cap = (k: number, flip: boolean): void => {
      const r = rings[k];
      const cx = r.pts.reduce((s, p) => s + p[0], 0) / m, cy = r.pts.reduce((s, p) => s + p[1], 0) / m, cz = r.pts.reduce((s, p) => s + p[2], 0) / m;
      const ci = this.vert([cx, cy, cz], r.c[0], hair, r.b0, r.b1, r.w);
      for (let j = 0; j < m; j++) {
        const a = base + k * m + j, b = base + k * m + ((j + 1) % m);
        if (flip) this.idx.push(ci, b, a); else this.idx.push(ci, a, b);
      }
    };
    if (capStart) cap(0, false);
    if (capEnd) cap(rings.length - 1, true);
  }
  /** Double-sided strip (mane, forelock): rows of [left, right] points. */
  card(rows: [V3, V3][], c: RGB, b0: number[], b1: number[], w: number[]): void {
    for (const side of [0, 1]) {
      const base = this.pos.length / 3;
      rows.forEach(([l, r], k) => {
        this.vert(l, c, 1, b0[k], b1[k], w[k], 0, k);
        this.vert(r, c, 1, b0[k], b1[k], w[k], 1, k);
      });
      for (let k = 0; k + 1 < rows.length; k++) {
        const a = base + k * 2, b = a + 1, cc = a + 2, d = a + 3;
        if (side === 0) this.idx.push(a, cc, b, b, cc, d); else this.idx.push(a, b, cc, b, d, cc);
      }
    }
  }
  finish(): HorseMesh {
    const n = this.pos.length / 3;
    const N = new Float32Array(n * 3);
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t], b = this.idx[t + 1], c = this.idx[t + 2];
      const ux = this.pos[b * 3] - this.pos[a * 3], uy = this.pos[b * 3 + 1] - this.pos[a * 3 + 1], uz = this.pos[b * 3 + 2] - this.pos[a * 3 + 2];
      const vx = this.pos[c * 3] - this.pos[a * 3], vy = this.pos[c * 3 + 1] - this.pos[a * 3 + 1], vz = this.pos[c * 3 + 2] - this.pos[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz; }
    }
    const normal = new Int8Array(n * 4), colour = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const L = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
      for (let k = 0; k < 3; k++) normal[i * 4 + k] = Math.round((N[i * 3 + k] / L) * 127);
      for (let k = 0; k < 3; k++) colour[i * 4 + k] = Math.round(Math.min(1, this.col[i * 3 + k]) * 255);
      colour[i * 4 + 3] = 128;
    }
    return {
      position: new Float32Array(this.pos), normal, colour, surf: new Uint8Array(this.surf), wall: new Float32Array(this.wall),
      skin: new Uint8Array(this.skin), index: new Uint32Array(this.idx), triangles: this.idx.length / 3,
    };
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);
/** Catmull-Rom through a list of rows of numbers, at s in [0, rows-1]. */
function spline(rows: number[][], s: number): number[] {
  const i = Math.max(0, Math.min(rows.length - 2, Math.floor(s))), t = s - i;
  const p0 = rows[Math.max(0, i - 1)], p1 = rows[i], p2 = rows[i + 1], p3 = rows[Math.min(rows.length - 1, i + 2)];
  return p1.map((_, k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t));
}

// The barrel, from the buttock to the point of the chest: z, centre height,
// half width, half height above and below the centre. The back line (cy +
// up) gives croup 1.42, a slight dip behind the withers, withers 1.47; the
// belly line (cy - down) 0.73 at the girth. A draught type: barrel about
// 0.65 m across, the chest a hand narrower, the quarters as wide as the barrel.
const BODY = [
  [-0.87, 1.19, 0.06, 0.07, 0.08],
  [-0.81, 1.2, 0.19, 0.18, 0.25],
  [-0.68, 1.19, 0.29, 0.23, 0.38],
  [-0.5, 1.16, 0.31, 0.26, 0.41],
  [-0.3, 1.13, 0.31, 0.29, 0.39],
  [-0.05, 1.11, 0.325, 0.31, 0.39],
  [0.2, 1.12, 0.32, 0.33, 0.4],
  [0.4, 1.16, 0.28, 0.31, 0.4],
  [0.58, 1.17, 0.24, 0.27, 0.37],
  [0.73, 1.14, 0.19, 0.2, 0.28],
  [0.82, 1.12, 0.07, 0.09, 0.12],
];

/** A superellipse ring about (0, cy, z) in the x,y plane, top and bottom extents apart. */
function bodyRing(z: number, cy: number, hw: number, up: number, down: number, m: number, e: number): V3[] {
  const out: V3[] = [];
  for (let j = 0; j < m; j++) {
    const a = (j / m) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const x = hw * Math.sign(c) * Math.abs(c) ** (2 / e);
    const y = cy + (s > 0 ? up : down) * Math.sign(s) * Math.abs(s) ** (2 / e);
    out.push([x, y, z]);
  }
  return out;
}

/** A ring round an axis point, in the frame (side, up) normal to the axis. */
function ringAt(c: V3, side: V3, up: V3, rx: number, ryUp: number, ryDown: number, m: number, e = 2, shift = 0): V3[] {
  const out: V3[] = [];
  for (let j = 0; j < m; j++) {
    const a = (j / m) * Math.PI * 2;
    const cc = Math.cos(a), s = Math.sin(a);
    const x = rx * Math.sign(cc) * Math.abs(cc) ** (2 / e);
    const y = (s > 0 ? ryUp : ryDown) * Math.sign(s) * Math.abs(s) ** (2 / e) + shift;
    out.push([c[0] + side[0] * x + up[0] * y, c[1] + side[1] * x + up[1] * y, c[2] + side[2] * x + up[2] * y]);
  }
  return out;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const bez = (a: V3, b: V3, c: V3, t: number): V3 => [0, 1, 2].map((k) => (1 - t) * (1 - t) * a[k] + 2 * (1 - t) * t * b[k] + t * t * c[k]) as V3;

/** The neck's centreline: from inside the chest up over the arch to the poll. */
export const NECK = { base: [0, 1.28, 0.5] as V3, ctrl: [0, 1.82, 0.78] as V3, poll: [0, 1.93, 1.0] as V3 };
/** The head's line, poll to the end of the muzzle. */
export const HEAD = { poll: NECK.poll, muzzle: [0, 1.47, 1.4] as V3 };

export function buildHorse(lean = false, harness = false): HorseMesh {
  const B = new Builder();
  const m = lean ? 10 : 22;
  // --- the barrel ---
  {
    const n = lean ? 7 : 22;
    const rings = [];
    for (let k = 0; k <= n; k++) {
      const [z, cy, hw, up, down] = spline(BODY, (k / n) * (BODY.length - 1));
      const pts = bodyRing(z, cy, hw, up, down, m, 2.3);
      rings.push({ pts, c: pts.map((): RGB => COAT), b0: 0, b1: 0, w: 0 });
    }
    B.loft(rings, true, true);
  }
  // --- neck: deep at the base, the crest arched, the throat straighter ---
  {
    const n = lean ? 6 : 16;
    const rings = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const c = bez(NECK.base, NECK.ctrl, NECK.poll, t);
      const tan = norm(sub(bez(NECK.base, NECK.ctrl, NECK.poll, Math.min(1, t + 0.01)), bez(NECK.base, NECK.ctrl, NECK.poll, Math.max(0, t - 0.01))));
      const side: V3 = [1, 0, 0];
      const up = norm(cross(tan, side));
      const hw = lerp(0.23, 0.1, smooth(t)), dUp = lerp(0.22, 0.11, t), dDown = lerp(0.38, 0.13, smooth(t));
      // Blend body -> neck over the lower third, so the nod bends the neck, not the chest.
      const w = Math.min(1, t / 0.35);
      const pts = ringAt(c, side, up, hw, dUp, dDown, m, 2.2);
      rings.push({ pts, c: pts.map((): RGB => COAT), b0: 0, b1: 1, w });
    }
    B.loft(rings, false, false);
  }
  // --- head: broad flat forehead and jowl, tapering to the muzzle ---
  {
    const n = lean ? 5 : 14;
    const ax = norm(sub(HEAD.muzzle, HEAD.poll));
    const side: V3 = [1, 0, 0];
    // Dorsal is the forehead side: the axis turned up toward +y.
    const up = norm(cross(ax, side));
    const len = Math.hypot(...sub(HEAD.muzzle, HEAD.poll));
    // t, half width, up, down (jowl), ventral shift.
    const prof = [[-0.06, 0.08, 0.09, 0.11], [0.12, 0.1, 0.1, 0.17], [0.3, 0.095, 0.085, 0.14], [0.55, 0.075, 0.075, 0.095], [0.8, 0.068, 0.072, 0.085], [0.95, 0.066, 0.07, 0.08], [1.02, 0.045, 0.045, 0.05]];
    const rings = [];
    for (let k = 0; k <= n; k++) {
      const [t, hw, u, d] = spline(prof, (k / n) * (prof.length - 1));
      const c: V3 = [HEAD.poll[0] + ax[0] * t * len, HEAD.poll[1] + ax[1] * t * len, HEAD.poll[2] + ax[2] * t * len];
      const pts = ringAt(c, side, up, hw, u, d, m, 2.4);
      const col = t > 0.75 ? MUZZLE : COAT;
      rings.push({ pts, c: pts.map((): RGB => col), b0: 2, b1: 2, w: 0 });
    }
    B.loft(rings, true, true);
    // Ears: small cones at the poll, pricked forward.
    for (const s of [-1, 1]) {
      const root: V3 = [s * 0.06, HEAD.poll[1] + 0.06, HEAD.poll[2] - 0.01];
      const tip: V3 = [s * 0.085, root[1] + 0.16, root[2] + 0.04];
      const ea = norm(sub(tip, root));
      const es = norm(cross([0, 0, 1], ea));
      const eu = norm(cross(ea, es));
      const er = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        const c: V3 = [root[0] + (tip[0] - root[0]) * t, root[1] + (tip[1] - root[1]) * t, root[2] + (tip[2] - root[2]) * t];
        const r = 0.035 * Math.sin(Math.PI * Math.min(0.95, 0.15 + t * 0.85)) + 0.004;
        const pts = ringAt(c, es, eu, r, r * 0.6, r * 0.6, lean ? 4 : 6);
        er.push({ pts, c: pts.map((): RGB => (t > 0.7 ? POINTS : COAT)), b0: 2, b1: 2, w: 0 });
      }
      B.loft(er, false, true);
    }
    // Eyes: dark discs set into the head's sides.
    if (!lean) for (const s of [-1, 1]) {
      const c: V3 = [HEAD.poll[0] + ax[0] * 0.2 * len + s * 0.098, HEAD.poll[1] + ax[1] * 0.2 * len + up[1] * 0.04, HEAD.poll[2] + ax[2] * 0.2 * len + up[2] * 0.04];
      const pts = ringAt(c, [0, 0, 1], [0, 1, 0], 0.022, 0.018, 0.018, 6);
      B.loft([{ pts, c: pts.map((): RGB => [0.03, 0.025, 0.02]), b0: 2, b1: 2, w: 0 }, { pts: pts.map((p): V3 => [p[0] + s * 0.004, p[1], p[2]]), c: pts.map((): RGB => [0.03, 0.025, 0.02]), b0: 2, b1: 2, w: 0 }], false, true);
    }
  }
  // --- mane: cards falling off the crest to the right, and the forelock ---
  {
    const n = lean ? 5 : 12;
    const rows: [V3, V3][] = [], b0: number[] = [], b1: number[] = [], w: number[] = [];
    for (let k = 0; k <= n; k++) {
      const t = 0.08 + (k / n) * 0.9;
      const c = bez(NECK.base, NECK.ctrl, NECK.poll, t);
      const tan = norm(sub(bez(NECK.base, NECK.ctrl, NECK.poll, Math.min(1, t + 0.01)), bez(NECK.base, NECK.ctrl, NECK.poll, t - 0.01)));
      const up = norm(cross(tan, [1, 0, 0]));
      const top: V3 = [c[0], c[1] + up[1] * (lerp(0.22, 0.11, t) + 0.025), c[2] + up[2] * (lerp(0.22, 0.11, t) + 0.025)];
      const len = 0.2 + 0.05 * Math.sin(k * 2.3);
      const hw = lerp(0.23, 0.1, smooth(t));
      const bot: V3 = [hw + 0.025, top[1] - len, top[2] - 0.02];
      rows.push([[top[0] - 0.01, top[1], top[2]], bot]);
      b0.push(0); b1.push(1); w.push(Math.min(1, t / 0.35));
    }
    B.card(rows, POINTS, b0, b1, w);
  }
  // --- tail: the dock, then the hair falling to the hocks ---
  {
    const root: V3 = [0, 1.36, -0.83];
    const path: V3[] = [root, [0, 1.3, -0.92], [0, 1.12, -0.97], [0, 0.9, -0.98], [0, 0.68, -0.95], [0, 0.55, -0.92]];
    const radius = [0.055, 0.05, 0.075, 0.085, 0.07, 0.03];
    const rings = [];
    for (let k = 0; k < path.length; k++) {
      const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k + 1)];
      const tan = norm(sub(b, a));
      const side: V3 = [1, 0, 0];
      const up = norm(cross(tan, side));
      const pts = ringAt(path[k], side, up, radius[k] * (k >= 2 ? 1.3 : 1), radius[k] * 0.8, radius[k] * 0.8, lean ? 6 : 10);
      rings.push({ pts, c: pts.map((): RGB => (k === 0 ? COAT : POINTS)), b0: 3, b1: 3, w: 0 });
    }
    B.loft(rings, false, true, 1);
  }
  // --- legs: lofted along the joint chain, knee, cannon and fetlock in profile ---
  LEGS.forEach((L, li) => {
    const bone = 4 + li * 3;
    const mm = lean ? 5 : 10;
    // Stations along the chain: segment (0 upper, 1 cannon, 2 pastern),
    // t along it, half width, front, back (from the bone line).
    const fore: number[][] = [
      [0, -0.25, 0.125, 0.13, 0.13], [0, 0.15, 0.115, 0.13, 0.12], [0, 0.45, 0.08, 0.085, 0.08], [0, 0.8, 0.055, 0.055, 0.05], [0, 0.97, 0.058, 0.06, 0.055],
      [1, 0.1, 0.045, 0.04, 0.05], [1, 0.5, 0.04, 0.032, 0.06], [1, 0.9, 0.045, 0.04, 0.06],
      [2, 0.1, 0.05, 0.045, 0.055], [2, 0.45, 0.038, 0.035, 0.04], [2, 0.68, 0.045, 0.045, 0.045], [2, 0.8, 0.058, 0.06, 0.05], [2, 1.0, 0.064, 0.07, 0.055],
    ];
    const hind: number[][] = [
      [0, -0.2, 0.15, 0.15, 0.2], [0, 0.15, 0.14, 0.13, 0.19], [0, 0.45, 0.095, 0.085, 0.12], [0, 0.7, 0.065, 0.055, 0.085], [0, 0.85, 0.05, 0.045, 0.07], [0, 0.97, 0.055, 0.045, 0.085],
      [1, 0.1, 0.045, 0.04, 0.06], [1, 0.5, 0.04, 0.032, 0.06], [1, 0.9, 0.045, 0.04, 0.06],
      [2, 0.1, 0.05, 0.045, 0.055], [2, 0.45, 0.038, 0.035, 0.04], [2, 0.68, 0.045, 0.045, 0.045], [2, 0.8, 0.058, 0.06, 0.05], [2, 1.0, 0.064, 0.07, 0.055],
    ];
    const joints = [L.pivot, L.mid, L.fet, L.toe];
    const rings = [];
    for (const [seg, t, hw, front, back] of L.fore ? fore : hind) {
      const a = joints[seg], b = joints[seg + 1];
      const c: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const ax = norm(sub(b, a));
      const side: V3 = [1, 0, 0];
      // "Up" in the ring's frame is forward (+z side of the leg).
      const fwd = norm(cross(side, ax));
      const pts = ringAt(c, side, fwd, hw, front, back, mm, 2.2);
      // Skin weights: blend into the next segment across each joint.
      let b0 = bone + seg, b1 = b0, w = 0;
      if (t > 0.8 && seg < 2) { b1 = b0 + 1; w = (t - 0.8) / 0.4; }
      if (t < 0.2 && seg > 0) { b1 = b0; b0 = b0 - 1; w = 0.5 + t / 0.4; }
      const low = seg > 0 || t > 0.85;
      const hoof = seg === 2 && t > 0.75;
      const col: RGB = hoof ? HOOF : low ? POINTS : t > 0.55 ? [lerp(COAT[0], POINTS[0], 0.5), lerp(COAT[1], POINTS[1], 0.5), lerp(COAT[2], POINTS[2], 0.5)] : COAT;
      rings.push({ pts, c: pts.map((): RGB => col), b0, b1, w });
    }
    // Flat sole on the ground.
    const last = rings[rings.length - 1];
    last.pts = last.pts.map((p): V3 => [p[0], 0, p[2]]);
    B.loft(rings, false, true);
  });
  if (harness) buildHarness(B, lean);
  return B.finish();
}

/** A point on the barrel's surface at height angle phi (0 the side, +pi/2 the back), pushed out by `out`. */
function bodyPoint(z: number, phi: number, side: number, out: number): V3 {
  // Invert the spline's z by bisection: the stations are not evenly spaced.
  let lo = 0, hi = BODY.length - 1;
  for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (spline(BODY, mid)[0] < z) lo = mid; else hi = mid; }
  const [, cy, hw, up, down] = spline(BODY, lo);
  const c = Math.cos(phi), s = Math.sin(phi), e = 2.3;
  const x = side * (hw + out) * Math.abs(c) ** (2 / e);
  const y = cy + (s > 0 ? up + out : down + out) * Math.sign(s) * Math.abs(s) ** (2 / e);
  return [x, y, z];
}

/**
 * The cart harness as the Romans drove a single horse in shafts: a breast
 * strap round the chest (no rigid collar: that is medieval), a girth and a
 * pad over the withers carrying the shaft loops, the breeching round the
 * quarters, and a bridle with a noseband.
 */
function buildHarness(B: Builder, lean: boolean): void {
  const LEATHER: RGB = [0.17, 0.1, 0.06];
  const ribbon = (pts: V3[], outs: V3[], halfW: number, bone: number): void => {
    const rows: [V3, V3][] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const w = norm(cross(norm(sub(b, a)), outs[k]));
      rows.push([[pts[k][0] - w[0] * halfW, pts[k][1] - w[1] * halfW, pts[k][2] - w[2] * halfW], [pts[k][0] + w[0] * halfW, pts[k][1] + w[1] * halfW, pts[k][2] + w[2] * halfW]]);
    }
    B.card(rows, LEATHER, rows.map(() => bone), rows.map(() => bone), rows.map(() => 0));
  };
  const n = lean ? 6 : 14;
  // Breast strap: round the front of the chest at the point of the shoulder.
  {
    const pts: V3[] = [], outs: V3[] = [];
    for (let k = 0; k <= n * 2; k++) {
      const t = k / (n * 2);
      const side = t < 0.5 ? -1 : 1;
      const z = 0.8 - Math.abs(t - 0.5) * 2 * 0.55;
      const p = bodyPoint(z, -0.25, side, 0.012);
      pts.push(p);
      outs.push(norm([p[0], 0, 0.3]));
    }
    ribbon(pts, outs, 0.035, 0);
  }
  // Girth (a hoop round the barrel behind the elbow) and the breeching
  // (round the quarters below the point of the buttock), each side.
  for (const [z, phi0, phi1, w] of [[0.3, -1.5, 1.5, 0.04], [-0.7, -0.5, 0.35, 0.03]] as const) {
    for (const side of [-1, 1]) {
      const pts: V3[] = [], outs: V3[] = [];
      for (let k = 0; k <= n; k++) {
        const phi = phi0 + ((phi1 - phi0) * k) / n;
        const p = bodyPoint(z, phi, side, 0.012);
        pts.push(p);
        outs.push(norm([p[0], p[1] - 1.15, 0]));
      }
      ribbon(pts, outs, w, 0);
    }
  }
  // The pad on the withers, a saddle-cloth the shaft loops hang from.
  {
    const rings = [];
    for (let k = 0; k <= 3; k++) {
      const z = 0.2 + k * 0.08;
      const pts: V3[] = [];
      const arc = (side: number, out: number): void => {
        for (let j = 0; j <= 5; j++) pts.push(bodyPoint(z, 0.7 + (j / 5) * (Math.PI / 2 - 0.7), side, out));
      };
      // Over the top and back under, as a closed section.
      arc(1, 0.04);
      for (let j = 5; j >= 0; j--) pts.push(bodyPoint(z, 0.7 + (j / 5) * (Math.PI / 2 - 0.7), -1, 0.04));
      for (let j = 0; j <= 5; j++) pts.push(bodyPoint(z, 0.7 + (j / 5) * (Math.PI / 2 - 0.7), -1, 0.01));
      for (let j = 5; j >= 0; j--) pts.push(bodyPoint(z, 0.7 + (j / 5) * (Math.PI / 2 - 0.7), 1, 0.01));
      rings.push({ pts, c: pts.map((): RGB => [0.42, 0.16, 0.1]), b0: 0, b1: 0, w: 0 });
    }
    B.loft(rings, true, true);
  }
  // Bridle: a headpiece behind the ears and a noseband.
  const ax = norm(sub(HEAD.muzzle, HEAD.poll)), up = norm(cross(ax, [1, 0, 0]));
  const len = Math.hypot(...sub(HEAD.muzzle, HEAD.poll));
  for (const [t, hw, u, d] of [[0.03, 0.09, 0.098, 0.125], [0.66, 0.079, 0.079, 0.097]]) {
    const c: V3 = [HEAD.poll[0] + ax[0] * t * len, HEAD.poll[1] + ax[1] * t * len, HEAD.poll[2] + ax[2] * t * len];
    const a = ringAt(c, [1, 0, 0], up, hw, u, d, lean ? 8 : 14, 2.4);
    const b = a.map((p): V3 => [p[0] + ax[0] * 0.04, p[1] + ax[1] * 0.04, p[2] + ax[2] * 0.04]);
    B.loft([{ pts: a, c: a.map((): RGB => LEATHER), b0: 2, b1: 2, w: 0 }, { pts: b, c: b.map((): RGB => LEATHER), b0: 2, b1: 2, w: 0 }], false, false);
  }
}

// =====================================================================================
// Gaits.
// =====================================================================================

export type Gait = "walk" | "trot" | "stand";

/** Footfall phase of each leg in the cycle, LF RF LH RH. */
const FOOTFALL: Record<Exclude<Gait, "stand">, number[]> = {
  // The walk is four-beat, lateral sequence: left hind, left fore, right hind, right fore.
  walk: [0.25, 0.75, 0, 0.5],
  // The trot is two-beat on the diagonals.
  trot: [0, 0.5, 0.5, 0],
};
const STANCE = { walk: 0.62, trot: 0.42 };
/** Stride length, metres per cycle. */
export const STRIDE_M = { walk: 1.65, trot: 2.5 };

function rotX(a: number, px: number, py: number, pz: number): number[] {
  // Column-major T(p) Rx(a) T(-p).
  const c = Math.cos(a), s = Math.sin(a);
  void px;
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, py - (c * py - s * pz), pz - (s * py + c * pz), 1];
}
function mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

/**
 * Bone matrices (column-major, 16 per bone) for a gait at cycle phase `p`
 * (0..1). `out` is written in place.
 */
export function poseHorse(gait: Gait, p: number, out: Float32Array, strength = 1): void {
  const st = gait === "stand" ? 0 : strength;
  const g = gait === "stand" ? "walk" : gait;
  const cyc = ((p % 1) + 1) % 1;
  const trot = g === "trot";
  // The body rises and falls twice a stride, rolls once.
  const bob = st * (trot ? 0.035 : 0.012) * Math.cos(cyc * Math.PI * 4);
  const roll = st * (trot ? 0.012 : 0.02) * Math.sin(cyc * Math.PI * 2);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // Roll about the long axis at the barrel's centre (y 1.15).
  const root = [cr, sr, 0, 0, -sr, cr, 0, 0, 0, 0, 1, 0, 1.15 * sr, 1.15 - 1.15 * cr + bob, 0, 1];
  const set = (k: number, m: number[]): void => { for (let i = 0; i < 16; i++) out[k * 16 + i] = m[i]; };
  set(0, root);
  // The walk nods the head twice a stride, deepest as each fore lands.
  const nod = st * (trot ? 0.03 : 0.07) * Math.sin(cyc * Math.PI * 4 + 0.6);
  const neck = mul(root, rotX(nod, 0, NECK.base[1], NECK.base[2]));
  set(1, neck);
  set(2, mul(neck, rotX(nod * 0.6, 0, HEAD.poll[1], HEAD.poll[2])));
  set(3, mul(root, rotX(-0.05 + 0.04 * st * Math.sin(cyc * Math.PI * 2), 0, 1.36, -0.83)));
  const stance = STANCE[g];
  LEGS.forEach((L, li) => {
    const ph = (((cyc - FOOTFALL[g][li]) % 1) + 1) % 1;
    // Protraction-retraction about the shoulder or hip.
    const A = (trot ? 0.36 : 0.3) * st;
    let a: number, b = 0, c: number;
    if (ph < stance) {
      const u = ph / stance;
      a = lerp(-A, A, u);
      // The fetlock sinks under load mid-stance.
      c = -a + 0.12 * st * Math.sin(Math.PI * u);
    } else {
      const u = (ph - stance) / (1 - stance);
      a = lerp(A, -A, smooth(u));
      const flex = (L.fore ? (trot ? 1.35 : 1.0) : (trot ? 1.25 : 1.05)) * st;
      b = flex * Math.sin(Math.PI * Math.min(1, u * 1.15));
      c = -a - b * 0.35 + 0.6 * st * Math.sin(Math.PI * u);
    }
    // Knee and hock both fold the cannon back: the hoof lifts up behind.
    const bb = b;
    const mA = mul(root, rotX(a, L.x, L.pivot[1], L.pivot[2]));
    const mB = mul(mA, rotX(bb, L.x, L.mid[1], L.mid[2]));
    const mC = mul(mB, rotX(c, L.x, L.fet[1], L.fet[2]));
    set(4 + li * 3, mA);
    set(5 + li * 3, mB);
    set(6 + li * 3, mC);
  });
}

/** A pose's hoof soles in model space (for the gate: planted hooves stay near the ground). */
export function hoofPoints(bones: Float32Array): V3[] {
  return LEGS.map((L, li) => {
    const m = bones.subarray((6 + li * 3) * 16, (7 + li * 3) * 16);
    const [x, y, z] = L.toe;
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  });
}
