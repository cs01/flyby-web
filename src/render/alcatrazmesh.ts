// Alcatraz's structures as plain vertex arrays, from the baked OSM outlines
// plus a table of what OSM does not say: true heights, roof forms, window
// pattern and paint. No THREE here so the gate can build it under Bun; the
// renderer (render/alcatraz.ts) wraps the arrays and shades them.
//
// The window rows are not geometry. Each wall vertex carries where it sits on
// its facade (metres along, metres up, facade length) and a style id, and the
// fragment shader lays the bays, bars and rust out from that. A barred window
// as geometry is a few hundred triangles; the cellhouse alone has ~150 of them.

import { triangulate, signedArea } from "./earcut";
import type { AlcatrazFeature } from "../data/alcatraz";

/** Window and surface pattern, read by the fragment shader as aSurf.z. */
export const enum Style {
  Plain = 0,
  /** Cellhouse: tall barred two-storey windows in 4 m bays. */
  Cellhouse = 1,
  /** Ordinary storeys of sash windows. */
  Office = 2,
  /** Roofless shell: the same windows, cut through (the shader discards them). */
  Ruin = 3,
  /** Wide multi-pane factory windows. */
  Industrial = 4,
  /** Lighthouse shaft: a few small windows up one side. */
  Lighthouse = 5,
  /** Painted steel tank or stack: no windows, heavier rust. */
  Steel = 6,
  Roof = 7,
  /** Lantern glazing. */
  Glass = 8,
  /** Guard tower: glazed band at the top only. */
  Guard = 9,
  /** Steel kept painted (the water tower since its 2012 repaint): rust only in specks and runs. */
  PaintedSteel = 10,
}

/**
 * Lettering painted on the structures, one row of the shader's text atlas
 * each. `group` says which surface carries it (aDecal on the vertices); u and
 * v are the centre in that surface's facade metres, w and h the painted size.
 * The two famous pieces, both from the 1969-71 occupation and kept by the
 * Park Service: the wall at the dock and the water tower.
 */
export interface Decal {
  group: number;
  text: string;
  u: number;
  v: number;
  w: number;
  h: number;
}

export const enum DecalGroup {
  None = 0,
  DockWall = 1,
  WaterTower = 2,
}

/** The atlas rows, in order. Sizes from the photographs: letters about 1 m high on the dock wall. */
export const DECAL_TEXT: readonly { group: DecalGroup; text: string; w: number; h: number }[] = [
  { group: DecalGroup.DockWall, text: "INDIANS", w: 4.4, h: 1.4 },
  { group: DecalGroup.DockWall, text: "WELCOME", w: 5.8, h: 1.4 },
  { group: DecalGroup.DockWall, text: "INDIAN LAND", w: 8.6, h: 2.4 },
  { group: DecalGroup.WaterTower, text: "PEACE AND FREEDOM   WELCOME", w: 13.0, h: 0.9 },
  { group: DecalGroup.WaterTower, text: "HOME OF THE FREE  INDIAN LAND", w: 13.5, h: 1.3 },
];

/** aSurf.y: what may glow at night. */
export const enum Glow {
  None = 0,
  Lantern = 1,
  /** Windows that may show a lit room. */
  Rooms = 2,
}

export interface AlcatrazMeshData {
  position: Float32Array;
  normal: Float32Array;
  colour: Float32Array;
  /** x gloss, y Glow, z Style. */
  surf: Float32Array;
  /** DecalGroup of the surface the vertex is on. */
  decal: Float32Array;
  /** u metres along the facade, v metres above its ground line, facade length, facade height. */
  wall: Float32Array;
  index: Uint32Array;
  triangles: number;
}

export interface Modelled {
  id: number;
  name: string;
  kind: "building" | "ruin" | "lighthouse" | "water_tower" | "chimney" | "guard_tower" | "wall" | "pier";
  /** Footprint centroid, world metres. */
  cx: number;
  cz: number;
  groundY: number;
  topY: number;
}

type Rgb = [number, number, number];

interface Spec {
  h: number;
  style: Style;
  colour: Rgb;
  roof?: "flat" | "gable" | "hip" | "none";
  glow?: Glow;
  /**
   * Which ground the height counts from. "min" for a building that stands
   * on the dock and backs into the slope: its median ground is the hillside
   * behind it, which put Building 64's roof 8 m too low against the photos.
   */
  base?: "min";
}

// Paint: the island's buildings are cast concrete and stucco painted a pale
// cream, faded and salt-stained. Matched against the 2012-2022 reference
// photographs (overcast and low sun, sRGB ~215,205,180 on a lit cellhouse
// wall), kept near grey in chroma: the earlier buff read orange under the
// warm overcast sky.
const BUFF: Rgb = [0.7, 0.66, 0.57];
const PALE: Rgb = [0.78, 0.75, 0.66];
const WHITE: Rgb = [0.82, 0.81, 0.77];
const CONCRETE: Rgb = [0.57, 0.56, 0.52];
const OCHRE: Rgb = [0.62, 0.53, 0.42];

/**
 * Heights from the National Park Service's historic structure reports and
 * photographs, where OSM has none: the cellhouse is three tiers of cells
 * under a roof about 14 m up; Building 64 is a gallery storey and three of
 * barracks over the dock, its eaves near 24 m above the water.
 */
const BY_NAME: Record<string, Spec> = {
  "Main Prison": { h: 14, style: Style.Cellhouse, colour: PALE },
  "Dining Hall": { h: 12, style: Style.Cellhouse, colour: PALE },
  "Administration Block": { h: 13, style: Style.Office, colour: PALE, glow: Glow.Rooms },
  "Building 64": { h: 20, style: Style.Office, colour: [0.8, 0.78, 0.69], glow: Glow.Rooms, roof: "hip", base: "min" },
  "New Industries Building": { h: 9, style: Style.Industrial, colour: [0.58, 0.55, 0.5] },
  "Model Industries Building": { h: 11, style: Style.Industrial, colour: [0.55, 0.53, 0.49] },
  "Powerhouse": { h: 10, style: Style.Industrial, colour: CONCRETE },
  "Quartermaster": { h: 7, style: Style.Office, colour: WHITE, roof: "gable" },
  "Former Military Chapel": { h: 8, style: Style.Office, colour: BUFF, roof: "gable", glow: Glow.Rooms },
  "Sally Port": { h: 7, style: Style.Office, colour: OCHRE },
  "Electric Shop": { h: 5, style: Style.Industrial, colour: BUFF },
  "Morgue": { h: 3.5, style: Style.Plain, colour: CONCRETE },
  "Restrooms": { h: 3.5, style: Style.Plain, colour: BUFF },
  "Warden's House": { h: 10, style: Style.Ruin, colour: [0.6, 0.55, 0.47], roof: "none" },
  "Post Exchange & Officers' Club": { h: 7, style: Style.Ruin, colour: [0.58, 0.54, 0.48], roof: "none" },
};

const LIGHTHOUSE_H = 26;
const WATER_TOWER_H = 28;
const CHIMNEY_H = 30;
const GUARD_TOWER_H = 15;
/** The recreation yard's walls; every other free-standing wall is a parapet or a garden wall. */
const YARD_WALL_H = 6.5;
const WALL_H = 2.2;
const RETAINING_H = 1.0;

class Builder {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  s: number[] = [];
  d: number[] = [];
  /** DecalGroup stamped on every vertex made while it is set. */
  decal = 0;
  w: number[] = [];
  i: number[] = [];
  /** Height of the facade being built above its ground line; the shader stops the window rows short of it. 0: unlimited. */
  facadeH = 0;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, col: Rgb, surf: [number, number, number], u: number, v: number, len: number): number {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.c.push(col[0], col[1], col[2]);
    this.s.push(surf[0], surf[1], surf[2]);
    this.d.push(this.decal);
    this.w.push(u, v, len, this.facadeH);
    return this.p.length / 3 - 1;
  }

  /**
   * One vertical wall quad from (ax,az) to (bx,bz), bottom and top heights
   * given per end so a garden wall follows the slope. `u0` is where the quad
   * starts along its facade and `len` that facade's length; `ref` is the
   * facade's ground line, which the window rows count up from.
   */
  wallQuad(ax: number, az: number, bx: number, bz: number, ya0: number, ya1: number, yb0: number, yb1: number,
    col: Rgb, surf: [number, number, number], u0: number, len: number, ref: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    const nx = dz / l;
    const nz = -dx / l;
    const a = this.vert(ax, ya0, az, nx, 0, nz, col, surf, u0, ya0 - ref, len);
    const b = this.vert(bx, yb0, bz, nx, 0, nz, col, surf, u0 + l, yb0 - ref, len);
    const c = this.vert(bx, yb1, bz, nx, 0, nz, col, surf, u0 + l, yb1 - ref, len);
    const d = this.vert(ax, ya1, az, nx, 0, nz, col, surf, u0, ya1 - ref, len);
    this.i.push(a, b, c, a, c, d);
  }

  /** A horizontal polygon (CCW ring) at height y, facing up or down. */
  cap(ring: Float32Array, y: number, up: boolean, col: Rgb, surf: [number, number, number]): void {
    const tri = triangulate(ring);
    const base = this.p.length / 3;
    for (let k = 0; k < ring.length / 2; k++) {
      this.vert(ring[k * 2], y, ring[k * 2 + 1], 0, up ? 1 : -1, 0, col, surf, ring[k * 2], ring[k * 2 + 1], 0);
    }
    for (let t = 0; t < tri.length; t += 3) {
      if (up) this.i.push(base + tri[t], base + tri[t + 2], base + tri[t + 1]);
      else this.i.push(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
    }
  }

  /** Every edge of a closed ring as walls, u running continuously round it. */
  ringWalls(ring: Float32Array, y0: number, y1: number, col: Rgb, surf: [number, number, number], ref: number): void {
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const ax = ring[k * 2], az = ring[k * 2 + 1];
      const bx = ring[j * 2], bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      this.wallQuad(ax, az, bx, bz, y0, y1, y0, y1, col, surf, 0, len, ref);
    }
  }

  /** A tapered prism or cylinder about a vertical axis; `n` 8 is the lighthouse's octagon. */
  cylinder(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n: number, col: Rgb,
    surf: [number, number, number], ref: number, capTop: boolean, capBottom = false, a0 = 0): void {
    const circ = 2 * Math.PI * Math.max(r0, r1);
    const slope = (r0 - r1) / Math.max(1e-3, y1 - y0);
    const base = this.p.length / 3;
    for (let k = 0; k <= n; k++) {
      // `a0` sets where the facade's u starts, so lettering can sit mid-u
      // facing any way without wrapping across the seam.
      const a = a0 + (k / n) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ny = slope / Math.hypot(1, slope);
      const nh = 1 / Math.hypot(1, slope);
      const u = (k / n) * circ;
      this.vert(cx + ca * r0, y0, cz + sa * r0, ca * nh, ny, sa * nh, col, surf, u, y0 - ref, circ);
      this.vert(cx + ca * r1, y1, cz + sa * r1, ca * nh, ny, sa * nh, col, surf, u, y1 - ref, circ);
    }
    for (let k = 0; k < n; k++) {
      const a = base + k * 2;
      this.i.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
    const disc = (y: number, r: number, up: boolean): void => {
      const ring = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        ring[k * 2] = cx + Math.cos(a) * r;
        ring[k * 2 + 1] = cz + Math.sin(a) * r;
      }
      if (signedArea(ring) < 0) reverse(ring);
      this.cap(ring, y, up, col, [surf[0], surf[1], Style.Roof]);
    };
    if (capTop && r1 > 0.01) disc(y1, r1, true);
    if (capBottom && r0 > 0.01) disc(y0, r0, false);
  }

  /** A square-section strut between two points: legs and braces. */
  strut(a: [number, number, number], b: [number, number, number], r: number, col: Rgb, surf: [number, number, number]): void {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    const t = [d[0] / L, d[1] / L, d[2] / L];
    // Any vector not parallel to the strut, then two perpendiculars.
    const up = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let s = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]];
    const sl = Math.hypot(s[0], s[1], s[2]);
    s = [s[0] / sl, s[1] / sl, s[2] / sl];
    const q = [t[1] * s[2] - t[2] * s[1], t[2] * s[0] - t[0] * s[2], t[0] * s[1] - t[1] * s[0]];
    const dirs = [s, q, [-s[0], -s[1], -s[2]], [-q[0], -q[1], -q[2]]];
    for (let k = 0; k < 4; k++) {
      const m = dirs[k];
      const o = dirs[(k + 1) % 4];
      const nx = (m[0] + o[0]) / Math.SQRT2, ny = (m[1] + o[1]) / Math.SQRT2, nz = (m[2] + o[2]) / Math.SQRT2;
      // A square prism with its corners on the four perpendiculars; each face
      // spans two neighbouring corners and faces halfway between them.
      const c0 = [m[0] * r, m[1] * r, m[2] * r];
      const c1 = [o[0] * r, o[1] * r, o[2] * r];
      const v0 = this.vert(a[0] + c0[0], a[1] + c0[1], a[2] + c0[2], nx, ny, nz, col, surf, 0, 0, 0);
      const v1 = this.vert(a[0] + c1[0], a[1] + c1[1], a[2] + c1[2], nx, ny, nz, col, surf, 0, 0, 0);
      const v2 = this.vert(b[0] + c1[0], b[1] + c1[1], b[2] + c1[2], nx, ny, nz, col, surf, 0, L, 0);
      const v3 = this.vert(b[0] + c0[0], b[1] + c0[1], b[2] + c0[2], nx, ny, nz, col, surf, 0, L, 0);
      this.i.push(v0, v1, v2, v0, v2, v3);
    }
  }

  finish(): AlcatrazMeshData {
    return {
      position: new Float32Array(this.p),
      normal: new Float32Array(this.n),
      colour: new Float32Array(this.c),
      surf: new Float32Array(this.s),
      decal: new Float32Array(this.d),
      wall: new Float32Array(this.w),
      index: new Uint32Array(this.i),
      triangles: this.i.length / 3,
    };
  }
}

function reverse(ring: Float32Array): void {
  const n = ring.length / 2;
  for (let k = 0; k < n >> 1; k++) {
    const j = n - 1 - k;
    const x = ring[k * 2], z = ring[k * 2 + 1];
    ring[k * 2] = ring[j * 2];
    ring[k * 2 + 1] = ring[j * 2 + 1];
    ring[j * 2] = x;
    ring[j * 2 + 1] = z;
  }
}

/** Grow (d > 0) or shrink a CCW ring by d metres along its edge normals, mitred and clamped. */
export function offsetRing(ring: Float32Array, d: number): Float32Array {
  const n = ring.length / 2;
  const out = new Float32Array(ring.length);
  for (let k = 0; k < n; k++) {
    const p = (k + n - 1) % n;
    const q = (k + 1) % n;
    const ex1 = ring[k * 2] - ring[p * 2], ez1 = ring[k * 2 + 1] - ring[p * 2 + 1];
    const ex2 = ring[q * 2] - ring[k * 2], ez2 = ring[q * 2 + 1] - ring[k * 2 + 1];
    const l1 = Math.hypot(ex1, ez1) || 1;
    const l2 = Math.hypot(ex2, ez2) || 1;
    const n1x = ez1 / l1, n1z = -ex1 / l1;
    const n2x = ez2 / l2, n2z = -ex2 / l2;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const cos = mx * n1x + mz * n1z;
    const s = d / Math.max(0.35, cos);
    out[k * 2] = ring[k * 2] + mx * s;
    out[k * 2 + 1] = ring[k * 2 + 1] + mz * s;
  }
  return out;
}

/** Minimum-area rectangle of a ring, tested along each edge's direction. */
function orientedBox(ring: Float32Array): { cx: number; cz: number; ax: number; az: number; hl: number; hw: number } {
  const n = ring.length / 2;
  let best = { area: Infinity, cx: 0, cz: 0, ax: 1, az: 0, hl: 0, hw: 0 };
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    let ax = ring[j * 2] - ring[k * 2];
    let az = ring[j * 2 + 1] - ring[k * 2 + 1];
    const l = Math.hypot(ax, az);
    if (l < 0.5) continue;
    ax /= l;
    az /= l;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (let m = 0; m < n; m++) {
      const x = ring[m * 2], z = ring[m * 2 + 1];
      const s = x * ax + z * az;
      const t = -x * az + z * ax;
      s0 = Math.min(s0, s); s1 = Math.max(s1, s);
      t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area < best.area) {
      const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2;
      best = { area, cx: sm * ax - tm * az, cz: sm * az + tm * ax, ax, az, hl: (s1 - s0) / 2, hw: (t1 - t0) / 2 };
    }
  }
  // Long axis first.
  if (best.hw > best.hl) best = { ...best, ax: -best.az, az: best.ax, hl: best.hw, hw: best.hl };
  return best;
}

function gableRoof(b: Builder, ring: Float32Array, eave: number, col: Rgb, wallCol: Rgb, wallStyle: Style, ref: number): number {
  const o = orientedBox(ring);
  const over = 0.35;
  const hl = o.hl + over, hw = o.hw + over;
  const rise = o.hw * Math.tan((32 * Math.PI) / 180);
  const P = (s: number, t: number): [number, number] => [o.cx + s * o.ax - t * o.az, o.cz + s * o.az + t * o.ax];
  const ridgeY = eave + rise;
  const roofSurf: [number, number, number] = [0.15, 0, Style.Roof];
  const slope = (t: number): void => {
    const [ax, az] = P(-hl, t), [bx, bz] = P(hl, t), [cx, cz] = P(hl, 0), [dx, dz] = P(-hl, 0);
    const sgn = Math.sign(t);
    // Normal: across the ridge, tilted up by the pitch.
    const nx = -o.az * sgn, nz = o.ax * sgn;
    const k = rise / o.hw;
    const nl = Math.hypot(1, k);
    const N: [number, number, number] = [(nx * k) / nl, 1 / nl, (nz * k) / nl];
    const y0 = eave - over * k;
    const v0 = b.vert(ax, y0, az, ...N, col, roofSurf, ax, az, 0);
    const v1 = b.vert(bx, y0, bz, ...N, col, roofSurf, bx, bz, 0);
    const v2 = b.vert(cx, ridgeY, cz, ...N, col, roofSurf, cx, cz, 0);
    const v3 = b.vert(dx, ridgeY, dz, ...N, col, roofSurf, dx, dz, 0);
    b.i.push(v0, v1, v2, v0, v2, v3);
  };
  slope(hw);
  slope(-hw);
  // The gable ends: wall-coloured triangles over the short sides.
  for (const s of [-o.hl, o.hl]) {
    const [ax, az] = P(s, -o.hw), [bx, bz] = P(s, o.hw), [cx, cz] = P(s, 0);
    const nx = o.ax * Math.sign(s), nz = o.az * Math.sign(s);
    const surf: [number, number, number] = [0.05, 0, wallStyle === Style.Office ? Style.Plain : wallStyle];
    const v0 = b.vert(ax, eave, az, nx, 0, nz, wallCol, surf, 0, eave - ref, 2 * o.hw);
    const v1 = b.vert(bx, eave, bz, nx, 0, nz, wallCol, surf, 2 * o.hw, eave - ref, 2 * o.hw);
    const v2 = b.vert(cx, ridgeY, cz, nx, 0, nz, wallCol, surf, o.hw, ridgeY - ref, 2 * o.hw);
    b.i.push(v0, v1, v2);
  }
  return ridgeY;
}

/** A low hipped roof over the footprint's oriented box: Building 64's long grey roof. */
function hipRoof(b: Builder, ring: Float32Array, eave: number, col: Rgb): number {
  const o = orientedBox(ring);
  const over = 0.5;
  const hl = o.hl + over, hw = o.hw + over;
  const rise = hw * Math.tan((20 * Math.PI) / 180);
  const ridgeHalf = Math.max(0, hl - hw);
  const P = (s: number, t: number, y: number): [number, number, number] => [o.cx + s * o.ax - t * o.az, y, o.cz + s * o.az + t * o.ax];
  const surf: [number, number, number] = [0.15, 0, Style.Roof];
  const face = (pts: [number, number, number][]): void => {
    // Normal from the first three corners, turned up.
    const [a, c1, c2] = pts;
    const ux = c1[0] - a[0], uy = c1[1] - a[1], uz = c1[2] - a[2];
    const vx = c2[0] - a[0], vy = c2[1] - a[1], vz = c2[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const base = b.p.length / 3;
    for (const p of pts) b.vert(p[0], p[1], p[2], nx / l, ny / l, nz / l, col, surf, p[0], p[2], 0);
    for (let k = 1; k + 1 < pts.length; k++) b.i.push(base, base + k, base + k + 1);
  };
  const y0 = eave, y1 = eave + rise;
  face([P(-hl, -hw, y0), P(hl, -hw, y0), P(ridgeHalf, 0, y1), P(-ridgeHalf, 0, y1)]);
  face([P(hl, hw, y0), P(-hl, hw, y0), P(-ridgeHalf, 0, y1), P(ridgeHalf, 0, y1)]);
  face([P(hl, -hw, y0), P(hl, hw, y0), P(ridgeHalf, 0, y1)]);
  face([P(-hl, hw, y0), P(-hl, -hw, y0), P(-ridgeHalf, 0, y1)]);
  return y1;
}

/**
 * Building 64's dock-side gallery: a deck slab on posts along the long
 * facade, a storey up, with a solid rail band. The photographs read it as a
 * deep shadowed arcade under a white rail, which a flat wall cannot give.
 */
function gallery(b: Builder, ax: number, az: number, bx: number, bz: number, nx: number, nz: number, base: number, deckH: number, col: Rgb): void {
  const depth = 2.6;
  const surf: [number, number, number] = [0.05, 0, Style.Plain];
  const ox = nx * depth, oz = nz * depth;
  const y = base + deckH;
  const L = Math.hypot(bx - ax, bz - az);
  const ring = new Float32Array([ax, az, bx, bz, bx + ox, bz + oz, ax + ox, az + oz]);
  if (signedArea(ring) < 0) reverse(ring);
  // Slab top and underside, the rail band on the outer edge, and its inner face.
  b.cap(ring, y + 0.25, true, col, surf);
  b.cap(ring, y, false, [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8], surf);
  b.wallQuad(ax + ox, az + oz, bx + ox, bz + oz, y, y + 1.15, y, y + 1.15, col, surf, 0, L, y);
  b.wallQuad(bx + ox * 0.95, bz + oz * 0.95, ax + ox * 0.95, az + oz * 0.95, y + 0.25, y + 1.15, y + 0.25, y + 1.15, col, surf, 0, L, y);
  // Posts every 4 m down to the dock.
  const n = Math.max(1, Math.round(L / 4));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const px = ax + (bx - ax) * t + ox * 0.9, pz = az + (bz - az) * t + oz * 0.9;
    b.strut([px, base - 0.5, pz], [px, y, pz], 0.18, col, surf);
  }
}

/** Painted lettering placed on a surface, in that surface's facade metres. */
export interface PlacedDecal {
  row: number;
  group: DecalGroup;
  /** Centre u, centre v, signed width (negative when the facade's u runs right to left as seen from outside), height. */
  rect: [number, number, number, number];
}

export interface BuildInput {
  features: AlcatrazFeature[];
  toWorld: (lat: number, lon: number) => { x: number; z: number };
  groundAt: (x: number, z: number) => number;
}

function ringOf(f: AlcatrazFeature, toWorld: BuildInput["toWorld"]): Float32Array {
  const pts: number[] = [];
  for (let k = 0; k < f.ll.length; k += 2) {
    const p = toWorld(f.ll[k], f.ll[k + 1]);
    pts.push(p.x, p.z);
  }
  // OSM closes a ring by repeating the first node.
  const n = pts.length / 2;
  if (n > 1 && Math.hypot(pts[0] - pts[(n - 1) * 2], pts[1] - pts[(n - 1) * 2 + 1]) < 0.01) pts.length -= 2;
  return new Float32Array(pts);
}

function centroid(ring: Float32Array): [number, number] {
  let x = 0, z = 0;
  const n = ring.length / 2;
  for (let k = 0; k < n; k++) { x += ring[k * 2]; z += ring[k * 2 + 1]; }
  return [x / n, z / n];
}

/** Ground under a footprint: the minimum (so no wall floats) and the median (the floor line). */
function groundOf(ring: Float32Array, groundAt: BuildInput["groundAt"]): { min: number; med: number } {
  const hs: number[] = [];
  const n = ring.length / 2;
  const [cx, cz] = centroid(ring);
  for (let k = 0; k < n; k++) {
    const x = ring[k * 2], z = ring[k * 2 + 1];
    hs.push(groundAt(x, z));
    hs.push(groundAt((x + cx) / 2, (z + cz) / 2));
  }
  hs.push(groundAt(cx, cz));
  hs.sort((a, b) => a - b);
  return { min: hs[0], med: hs[hs.length >> 1] };
}

export function pointInRing(x: number, z: number, ring: Float32Array): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1], xj = ring[j * 2], zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(x: number, z: number, ring: Float32Array): number {
  let best = Infinity;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j * 2], az = ring[j * 2 + 1], bx = ring[i * 2], bz = ring[i * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/** Mean radius of a near-circular footprint (the water tower's legs, the stack). */
function radiusOf(ring: Float32Array): number {
  const [cx, cz] = centroid(ring);
  let r = 0;
  const n = ring.length / 2;
  for (let k = 0; k < n; k++) r += Math.hypot(ring[k * 2] - cx, ring[k * 2 + 1] - cz);
  return r / n;
}

/** Where the lighthouse lantern is, for the beam and the light. */
export interface LanternAt {
  x: number;
  y: number;
  z: number;
}

export interface AlcatrazModel {
  mesh: AlcatrazMeshData;
  modelled: Modelled[];
  lantern: LanternAt | null;
  /** World rings of every footprint modelled as a building, for replacing the city pack's boxes. */
  footprints: Float32Array[];
  /** The recreation yard's outline: bare concrete, where nothing may be planted. */
  yard: Float32Array | null;
  /** Every painted lettering row, placed on its surface. */
  decals: PlacedDecal[];
}

export function buildAlcatrazModel(input: BuildInput): AlcatrazModel {
  const b = new Builder();
  const modelled: Modelled[] = [];
  const footprints: Float32Array[] = [];
  const decals: PlacedDecal[] = [];
  let lantern: LanternAt | null = null;
  const { features, toWorld, groundAt } = input;

  const yardF = features.find((f) => f.tags["name"] === "Recreation Yard");
  const yard = yardF ? ringOf(yardF, toWorld) : null;
  if (yard) {
    // The yard floor is poured concrete; the drape there is a blur of the
    // walls' shadows and reads as grass. The yard falls two metres across,
    // so the slab is a 2 m grid laid on the lidar, not one flat cap.
    yardSlab(b, yard, groundAt);
  }

  for (const f of features) {
    const t = f.tags;
    b.facadeH = 0;
    const name = t["name"] ?? "";
    // Inside the cellhouse's own outline; drawing it would z-fight the cellhouse walls.
    if (t["building:part"]) continue;
    const ring = ringOf(f, toWorld);
    if (ring.length < 4) continue;
    const isClosed = f.ll.length >= 8 && f.ll[0] === f.ll[f.ll.length - 2] && f.ll[1] === f.ll[f.ll.length - 1];

    if (t["barrier"]) {
      const h = t["barrier"] === "retaining_wall" ? RETAINING_H
        : yard && centroidNear(ring, yard) ? YARD_WALL_H : WALL_H;
      wallRibbon(b, ring, isClosed, h, t["barrier"] === "retaining_wall" ? 0.5 : 0.45, groundAt);
      const [cx, cz] = centroid(ring);
      modelled.push({ id: f.id, name: name || t["barrier"], kind: "wall", cx, cz, groundY: groundAt(cx, cz), topY: groundAt(cx, cz) + h });
      continue;
    }
    if (!isClosed) continue;
    if (signedArea(ring) < 0) reverse(ring);
    const [cx, cz] = centroid(ring);
    const g = groundOf(ring, groundAt);

    if (t["man_made"] === "pier") {
      // The floating ferry landing: a deck a metre above the water.
      const top = 1.1;
      b.ringWalls(ring, top - 0.8, top, CONCRETE, [0.05, 0, Style.Plain], top - 0.8);
      b.cap(ring, top, true, [0.5, 0.49, 0.46], [0.05, 0, Style.Roof]);
      modelled.push({ id: f.id, name: name || "pier", kind: "pier", cx, cz, groundY: 0, topY: top });
      continue;
    }
    if (!t["building"] && t["man_made"] !== "lighthouse" && t["man_made"] !== "water_tower" && t["man_made"] !== "chimney") continue;
    footprints.push(ring);

    if (t["man_made"] === "lighthouse") {
      lantern = lighthouse(b, cx, cz, g.med);
      modelled.push({ id: f.id, name, kind: "lighthouse", cx, cz, groundY: g.med, topY: g.med + LIGHTHOUSE_H });
      continue;
    }
    if (t["man_made"] === "water_tower") {
      waterTower(b, cx, cz, radiusOf(ring), g.min, decals);
      modelled.push({ id: f.id, name, kind: "water_tower", cx, cz, groundY: g.min, topY: g.min + WATER_TOWER_H });
      continue;
    }
    if (t["man_made"] === "chimney") {
      const r = Math.max(1.2, radiusOf(ring));
      const top = g.min + CHIMNEY_H;
      b.cylinder(cx, cz, g.min - 1, top - 1.5, r, r * 0.72, 16, [0.62, 0.6, 0.55], [0.05, 0, Style.Plain], g.min, false);
      b.cylinder(cx, cz, top - 1.5, top, r * 0.78, r * 0.76, 16, [0.16, 0.14, 0.13], [0.05, 0, Style.Steel], g.min, true);
      modelled.push({ id: f.id, name: name || "Smokestack", kind: "chimney", cx, cz, groundY: g.min, topY: top });
      continue;
    }
    if (t["man_made"] === "tower") {
      // The dock tower is an open steel frame with a glazed cab on top and a
      // red pyramid roof (every dock photograph), not a solid shaft.
      const g0 = g.min;
      const cab0 = g0 + GUARD_TOWER_H - 3, top = g0 + GUARD_TOWER_H;
      const steel: Rgb = [0.12, 0.11, 0.1];
      const ss: [number, number, number] = [0.2, 0, Style.Steel];
      const foot = 2.6, head = 1.3;
      const at = (k: number, y: number, r: number): [number, number, number] => {
        const a = (k + 0.5) * (Math.PI / 2) + 0.6;
        return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      };
      for (let k = 0; k < 4; k++) {
        b.strut(at(k, g0 - 0.5, foot), at(k, cab0, head), 0.1, steel, ss);
        for (const fr of [0, 0.33, 0.66]) {
          const ya = g0 + (cab0 - g0) * fr, yb = g0 + (cab0 - g0) * (fr + 0.33);
          const ra = foot + (head - foot) * fr, rb = foot + (head - foot) * (fr + 0.33);
          b.strut(at(k, ya, ra), at(k + 1, ya, ra), 0.05, steel, ss);
          b.strut(at(k, ya, ra), at(k + 1, yb, rb), 0.035, steel, ss);
          b.strut(at(k + 1, ya, ra), at(k, yb, rb), 0.035, steel, ss);
        }
      }
      // The cab: a dark glazed band on a floor, under a red pyramid roof.
      b.facadeH = 3;
      b.cylinder(cx, cz, cab0, cab0 + 0.3, head * 1.6, head * 1.6, 4, steel, [0.1, 0, Style.Plain], cab0, true, true);
      b.cylinder(cx, cz, cab0 + 0.3, top - 0.4, head * 1.3, head * 1.3, 4, [0.55, 0.53, 0.5], [0.05, 0, Style.Guard], cab0 - 0.2, false);
      b.cylinder(cx, cz, top - 0.4, top + 0.9, head * 1.75, 0.05, 4, [0.45, 0.09, 0.06], [0.1, 0, Style.Roof], cab0, false, true);
      modelled.push({ id: f.id, name: name || "Guard Tower", kind: "guard_tower", cx, cz, groundY: g0, topY: top + 0.9 });
      continue;
    }

    const ruinTag = t["building"] === "ruins";
    const spec: Spec = BY_NAME[name] ?? (ruinTag
      ? { h: 3, style: Style.Ruin, colour: [0.56, 0.52, 0.46], roof: "none" }
      : { h: t["height"] ? Number(t["height"]) : t["building:levels"] ? Number(t["building:levels"]) * 3.3 + 1 : 4.5, style: Style.Office, colour: BUFF });
    const h = t["height"] && BY_NAME[name] === undefined ? Number(t["height"]) : spec.h;
    const floor = spec.base === "min" ? g.min : g.med;
    const top = floor + h;
    const surf: [number, number, number] = [0.05, spec.glow ?? Glow.None, spec.style];
    b.facadeH = h;
    const roof = spec.roof ?? "flat";

    if (name === "Building 64") {
      // Walls edge by edge, so the long dock facade can carry the painted
      // wall and the gallery; the rest as any other building.
      const n = ring.length / 2;
      let best = 0, bestLen = 0;
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        const l = Math.hypot(ring[j * 2] - ring[k * 2], ring[j * 2 + 1] - ring[k * 2 + 1]);
        if (l > bestLen) { bestLen = l; best = k; }
      }
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        const ax = ring[k * 2], az = ring[k * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        b.wallQuad(ax, az, bx, bz, g.min - 0.5, top, g.min - 0.5, top, spec.colour, surf, 0, len, floor);
      }
      const j = (best + 1) % n;
      const ax = ring[best * 2], az = ring[best * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const ex = (bx - ax) / bestLen, ez = (bz - az) / bestLen;
      // The painted block is at the south-east end, the one nearer the
      // ferry landing; u counts from `a`, so measure from whichever end that is.
      const seAtA = ax + az > bx + bz;
      const panelU = seAtA ? 7 : bestLen - 7;
      // The painted wall is its own windowless block standing proud of the
      // barracks front, whitewashed, with the occupation's sign board on it.
      // Its front face keeps the facade's u so the lettering rects line up.
      const nx = ez, nz = -ex;
      const bw = 9, bd = 3, bTop = floor + 11;
      const whitewash: Rgb = [0.86, 0.85, 0.81];
      const plain: [number, number, number] = [0.04, 0, Style.Plain];
      const P = (u: number, d: number): [number, number] => [ax + ex * u + nx * d, az + ez * u + nz * d];
      const [p0x, p0z] = P(panelU - bw / 2, 0), [p1x, p1z] = P(panelU + bw / 2, 0);
      const [q0x, q0z] = P(panelU - bw / 2, bd), [q1x, q1z] = P(panelU + bw / 2, bd);
      b.facadeH = 0;
      b.decal = DecalGroup.DockWall;
      b.wallQuad(q0x, q0z, q1x, q1z, g.min - 0.5, bTop, g.min - 0.5, bTop, whitewash, plain, panelU - bw / 2, bestLen, floor);
      b.decal = DecalGroup.None;
      b.wallQuad(p0x, p0z, q0x, q0z, g.min - 0.5, bTop, g.min - 0.5, bTop, whitewash, plain, 0, bd, floor);
      b.wallQuad(q1x, q1z, p1x, p1z, g.min - 0.5, bTop, g.min - 0.5, bTop, whitewash, plain, 0, bd, floor);
      const lid = new Float32Array([p0x, p0z, p1x, p1z, q1x, q1z, q0x, q0z]);
      if (signedArea(lid) < 0) reverse(lid);
      b.cap(lid, bTop, true, [0.45, 0.5, 0.46], [0.1, 0, Style.Roof]);
      // The board: white header over a yellow field, in a dark frame.
      const board = (u0: number, u1: number, y0: number, y1: number, col: Rgb, d: number): void => {
        const [a0x, a0z] = P(u0, bd + d), [a1x, a1z] = P(u1, bd + d);
        b.wallQuad(a0x, a0z, a1x, a1z, y0, y1, y0, y1, col, plain, 0, u1 - u0, y0);
      };
      board(panelU - 1.75, panelU + 1.75, floor + 3.9, floor + 7.0, [0.08, 0.08, 0.08], 0.05);
      board(panelU - 1.6, panelU + 1.6, floor + 4.05, floor + 6.0, [0.8, 0.6, 0.14], 0.08);
      board(panelU - 1.6, panelU + 1.6, floor + 6.0, floor + 6.85, [0.86, 0.85, 0.82], 0.08);
      b.facadeH = h;
      for (let r = 0; r < DECAL_TEXT.length; r++) {
        const d = DECAL_TEXT[r];
        if (d.group !== DecalGroup.DockWall) continue;
        const v = d.text === "INDIANS" ? 9.9 : d.text === "WELCOME" ? 8.4 : 2.9;
        decals.push({ row: r, group: d.group, rect: [panelU, v, -d.w, d.h] });
      }
      // The gallery stops short of the painted block, which stands proud of it.
      const gStart = seAtA ? 14 : 0, gEnd = seAtA ? bestLen : bestLen - 14;
      gallery(b, ax + ex * gStart, az + ez * gStart, ax + ex * gEnd, az + ez * gEnd, ez, -ex, floor, 4.6, spec.colour);
      const peak = hipRoof(b, ring, top, [0.6, 0.6, 0.58]);
      modelled.push({ id: f.id, name, kind: "building", cx, cz, groundY: floor, topY: peak });
      continue;
    }

    if (roof === "none") {
      // A roofless shell: outer and inner faces and a cap along the wall top,
      // so it reads as 40 cm of masonry and not a paper box.
      const inner = offsetRing(ring, -0.4);
      b.ringWalls(ring, g.min - 0.5, top, spec.colour, surf, g.med);
      b.ringWalls(inner, g.min - 0.5, top, spec.colour, surf, g.med);
      const n = ring.length / 2;
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        const v0 = b.vert(ring[k * 2], top, ring[k * 2 + 1], 0, 1, 0, spec.colour, [0.05, 0, Style.Plain], 0, h, 0);
        const v1 = b.vert(ring[j * 2], top, ring[j * 2 + 1], 0, 1, 0, spec.colour, [0.05, 0, Style.Plain], 0, h, 0);
        const v2 = b.vert(inner[j * 2], top, inner[j * 2 + 1], 0, 1, 0, spec.colour, [0.05, 0, Style.Plain], 0, h, 0);
        const v3 = b.vert(inner[k * 2], top, inner[k * 2 + 1], 0, 1, 0, spec.colour, [0.05, 0, Style.Plain], 0, h, 0);
        b.i.push(v0, v1, v2, v0, v2, v3);
      }
      modelled.push({ id: f.id, name, kind: "ruin", cx, cz, groundY: g.med, topY: top });
      continue;
    }

    b.ringWalls(ring, g.min - 0.5, top, spec.colour, surf, floor);
    let peak = top;
    if (roof === "gable") {
      peak = gableRoof(b, ring, top, [0.42, 0.24, 0.18], spec.colour, spec.style, floor);
    } else {
      // A cornice lip, then the roof: a dark tar deck inside a parapet band.
      const lip = offsetRing(ring, 0.25);
      const band: Rgb = [spec.colour[0] * 0.92, spec.colour[1] * 0.92, spec.colour[2] * 0.92];
      b.ringWalls(lip, top - 0.45, top + 0.15, band, [0.05, 0, Style.Plain], top);
      b.cap(lip, top - 0.45, false, band, [0.05, 0, Style.Plain]);
      b.cap(lip, top + 0.15, true, name === "Main Prison" || name === "Dining Hall" ? [0.5, 0.51, 0.52] : [0.52, 0.5, 0.47], [0.2, 0, Style.Roof]);
      peak = top + 0.15;
    }
    if (name === "Dining Hall" && yard) yardSteps(b, ring, yard, groundAt);
    modelled.push({ id: f.id, name, kind: "building", cx, cz, groundY: floor, topY: peak });
  }

  return { mesh: b.finish(), modelled, lantern, footprints, yard, decals };
}

function yardSlab(b: Builder, yard: Float32Array, groundAt: BuildInput["groundAt"]): void {
  const cell = 2;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k < yard.length; k += 2) {
    x0 = Math.min(x0, yard[k]); x1 = Math.max(x1, yard[k]);
    z0 = Math.min(z0, yard[k + 1]); z1 = Math.max(z1, yard[k + 1]);
  }
  const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
  const id = new Int32Array(nx * nz).fill(-1);
  const col: Rgb = [0.23, 0.225, 0.21];
  const surf: [number, number, number] = [0.05, 0, Style.Roof];
  const inside = (i: number, j: number): boolean => pointInRing(x0 + i * cell, z0 + j * cell, yard);
  const v = (i: number, j: number): number => {
    const k = j * nx + i;
    if (id[k] < 0) {
      const x = x0 + i * cell, z = z0 + j * cell;
      id[k] = b.vert(x, groundAt(x, z) + 0.06, z, 0, 1, 0, col, surf, x, z, 0);
    }
    return id[k];
  };
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      if (!inside(i, j) || !inside(i + 1, j) || !inside(i, j + 1) || !inside(i + 1, j + 1)) continue;
      const a = v(i, j), c = v(i + 1, j), d = v(i, j + 1), e = v(i + 1, j + 1);
      b.i.push(a, d, c, c, d, e);
    }
  }
}

/**
 * The recreation yard's concrete bleachers against the dining-hall wall: the
 * one thing in every photograph of the yard. Nine steps of 45 cm by 90 cm
 * along the wall the yard touches, as stacked boxes.
 */
function yardSteps(b: Builder, ring: Float32Array, yard: Float32Array, groundAt: BuildInput["groundAt"]): void {
  const n = ring.length / 2;
  let best = -1, bestLen = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ax = ring[k * 2], az = ring[k * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
    const l = Math.hypot(bx - ax, bz - az);
    if (distToRing((ax + bx) / 2, (az + bz) / 2, yard) < 3 && l > bestLen) { bestLen = l; best = k; }
  }
  if (best < 0) return;
  const j = (best + 1) % n;
  const ax = ring[best * 2], az = ring[best * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
  const ex = (bx - ax) / bestLen, ez = (bz - az) / bestLen;
  // The outward normal of a CCW ring edge points into the yard.
  const nx = ez, nz = -ex;
  const w = Math.min(26, bestLen - 4);
  const s0 = (bestLen - w) / 2;
  const col: Rgb = [0.6, 0.58, 0.53];
  const surf: [number, number, number] = [0.03, 0, Style.Plain];
  const midX = ax + ex * (s0 + w / 2) + nx * 4, midZ = az + ez * (s0 + w / 2) + nz * 4;
  const g = groundAt(midX, midZ);
  const steps = 9, rise = 0.45, tread = 0.9;
  for (let k = 0; k < steps; k++) {
    const depth = (steps - k) * tread;
    const y0 = g + k * rise - (k === 0 ? 0.6 : 0), y1 = g + (k + 1) * rise;
    const p = (s: number, d: number): [number, number] => [ax + ex * s + nx * d, az + ez * s + nz * d];
    const [x0, z0] = p(s0, depth), [x1, z1] = p(s0 + w, depth);
    const [x2, z2] = p(s0 + w, 0), [x3, z3] = p(s0, 0);
    // Riser, the two ends, and the tread.
    b.wallQuad(x0, z0, x1, z1, y0, y1, y0, y1, col, surf, 0, w, g);
    b.wallQuad(x1, z1, x2, z2, y0, y1, y0, y1, col, surf, 0, depth, g);
    b.wallQuad(x3, z3, x0, z0, y0, y1, y0, y1, col, surf, 0, depth, g);
    const top = new Float32Array([x0, z0, x1, z1, x2, z2, x3, z3]);
    if (signedArea(top) < 0) reverse(top);
    b.cap(top, y1, true, col, [0.03, 0, Style.Roof]);
  }
}

function centroidNear(ring: Float32Array, yard: Float32Array): boolean {
  const n = ring.length / 2;
  let near = 0;
  for (let k = 0; k < n; k++) {
    const x = ring[k * 2], z = ring[k * 2 + 1];
    if (pointInRing(x, z, yard) || distToRing(x, z, yard) < 4) near++;
  }
  return near >= Math.ceil(n / 2);
}

/** A free-standing wall along a polyline, its top following the ground. */
function wallRibbon(b: Builder, line: Float32Array, closed: boolean, h: number, thick: number, groundAt: BuildInput["groundAt"]): void {
  const n = line.length / 2;
  const segs = closed ? n : n - 1;
  const col: Rgb = h > 4 ? [0.6, 0.57, 0.51] : [0.55, 0.53, 0.49];
  const surf: [number, number, number] = [0.04, 0, Style.Plain];
  for (let k = 0; k < segs; k++) {
    const j = (k + 1) % n;
    const ax = line[k * 2], az = line[k * 2 + 1], bx = line[j * 2], bz = line[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) continue;
    // Long segments are split so the top can follow a slope.
    const pieces = Math.max(1, Math.ceil(L / 4));
    const ox = ((bz - az) / L) * thick * 0.5, oz = (-(bx - ax) / L) * thick * 0.5;
    for (let p = 0; p < pieces; p++) {
      const t0 = p / pieces, t1 = (p + 1) / pieces;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0;
      const x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const g0 = groundAt(x0, z0), g1 = groundAt(x1, z1);
      b.wallQuad(x0 + ox, z0 + oz, x1 + ox, z1 + oz, g0 - 0.5, g0 + h, g1 - 0.5, g1 + h, col, surf, 0, 0, 0);
      b.wallQuad(x1 - ox, z1 - oz, x0 - ox, z0 - oz, g1 - 0.5, g1 + h, g0 - 0.5, g0 + h, col, surf, 0, 0, 0);
      const v0 = b.vert(x0 + ox, g0 + h, z0 + oz, 0, 1, 0, col, surf, 0, 0, 0);
      const v1 = b.vert(x1 + ox, g1 + h, z1 + oz, 0, 1, 0, col, surf, 0, 0, 0);
      const v2 = b.vert(x1 - ox, g1 + h, z1 - oz, 0, 1, 0, col, surf, 0, 0, 0);
      const v3 = b.vert(x0 - ox, g0 + h, z0 - oz, 0, 1, 0, col, surf, 0, 0, 0);
      b.i.push(v0, v1, v2, v0, v2, v3);
    }
  }
}

/**
 * The 1909 lighthouse: a tapering octagonal concrete shaft, an iron gallery,
 * a glazed lantern and a domed cap. 26 m to the top of the dome (OSM height).
 */
function lighthouse(b: Builder, cx: number, cz: number, g: number): LanternAt {
  const white: Rgb = [0.82, 0.81, 0.77];
  const iron: Rgb = [0.09, 0.09, 0.09];
  const shaftTop = g + 20.5;
  b.facadeH = 20.5;
  b.cylinder(cx, cz, g - 1, shaftTop, 2.7, 1.9, 8, white, [0.06, 0, Style.Lighthouse], g, false);
  // Corbelled gallery deck and its rail.
  b.cylinder(cx, cz, shaftTop, shaftTop + 0.45, 1.9, 2.6, 8, white, [0.06, 0, Style.Plain], g, true);
  b.cylinder(cx, cz, shaftTop + 0.45, shaftTop + 1.4, 2.55, 2.55, 16, iron, [0.3, 0, Style.Glass], g, false);
  // Lantern: a low iron base, the glazing, then the dome.
  b.cylinder(cx, cz, shaftTop + 0.45, shaftTop + 1.3, 1.5, 1.5, 10, iron, [0.3, 0, Style.Plain], g, false);
  b.cylinder(cx, cz, shaftTop + 1.3, shaftTop + 3.6, 1.45, 1.45, 10, [0.2, 0.22, 0.22], [0.9, Glow.Lantern, Style.Glass], g, false);
  b.cylinder(cx, cz, shaftTop + 3.6, shaftTop + 4.9, 1.65, 0.25, 10, iron, [0.3, 0, Style.Plain], g, false);
  b.cylinder(cx, cz, shaftTop + 4.9, shaftTop + 5.5, 0.12, 0.05, 6, iron, [0.3, 0, Style.Plain], g, true);
  return { x: cx, y: shaftTop + 2.4, z: cz };
}

/**
 * The 1940 water tower as repainted in 2012: a white riveted tank, a deep
 * bowl under it ringed by a catwalk, a shallow roof, on six white legs with
 * V bracing. The occupation's red lettering faces the dock (east), painted on
 * the shell through the decal atlas. Footprint radius is the leg circle.
 */
function waterTower(b: Builder, cx: number, cz: number, footR: number, g: number, decals: PlacedDecal[]): void {
  const legR = Math.max(4, Math.min(7, footR));
  const tankR = legR * 0.95;
  const top = g + WATER_TOWER_H;
  const tank1 = top - 2.4;
  const tank0 = tank1 - 6.2;
  const bowl = 0.75 * tankR;
  const paint: Rgb = [0.78, 0.8, 0.8];
  const legPaint: Rgb = [0.74, 0.76, 0.76];
  const ps: [number, number, number] = [0.15, 0, Style.PaintedSteel];
  const legs = 6;
  const at = (k: number, y: number, r: number): [number, number, number] => {
    const a = (k / legs) * Math.PI * 2 + 0.3;
    return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
  };
  const footRad = legR * 1.12, headRad = tankR * 0.97;
  const rAt = (y: number): number => footRad + (headRad - footRad) * ((y - g) / (tank0 - g));
  for (let k = 0; k < legs; k++) {
    // Battered legs: wider at the foot, meeting the tank at the catwalk.
    b.strut(at(k, g - 0.5, footRad), at(k, tank0, headRad), 0.24, legPaint, ps);
    // Two tiers of V bracing between neighbouring legs, and a tie at each tier.
    for (const [f0, f1] of [[0, 0.5], [0.5, 1]]) {
      const y0 = g + (tank0 - g) * f0, y1 = g + (tank0 - g) * f1;
      const ym = (y0 + y1) / 2;
      const mid = (a: number, c: number): [number, number, number] => {
        const p = at(a, ym, rAt(ym)), q = at(c, ym, rAt(ym));
        return [(p[0] + q[0]) / 2, ym - (y1 - y0) / 2, (p[2] + q[2]) / 2];
      };
      b.strut(at(k, y1, rAt(y1)), mid(k, k + 1), 0.07, legPaint, ps);
      b.strut(at(k + 1, y1, rAt(y1)), mid(k, k + 1), 0.07, legPaint, ps);
      b.strut(at(k, y0, rAt(y0)), at(k + 1, y0, rAt(y0)), 0.08, legPaint, ps);
    }
  }
  // The bowl: an ellipsoid in five bands down to a short riser pipe.
  const bands = [0, 0.45, 0.72, 0.9, 1];
  for (let k = 0; k + 1 < bands.length; k++) {
    const d0 = bands[k], d1 = bands[k + 1];
    const r0 = tankR * Math.sqrt(1 - d1 * d1), r1 = tankR * Math.sqrt(1 - d0 * d0);
    b.cylinder(cx, cz, tank0 - bowl * d1, tank0 - bowl * d0, Math.max(0.3, r0), r1, 24, paint, ps, g, false);
  }
  b.cylinder(cx, cz, g + 2, tank0 - bowl, 0.35, 0.35, 8, legPaint, ps, g, false);
  // The shell, carrying the lettering; u starts on the west side so the east
  // face is mid-u.
  b.decal = DecalGroup.WaterTower;
  b.cylinder(cx, cz, tank0, tank1, tankR, tankR, 32, paint, ps, tank0, false, false, Math.PI);
  b.decal = DecalGroup.None;
  // Roof: a rolled eave then a shallow cone, and the vent on top.
  b.cylinder(cx, cz, tank1, tank1 + 0.35, tankR, tankR + 0.2, 24, paint, ps, g, false);
  b.cylinder(cx, cz, tank1 + 0.35, top - 0.3, tankR + 0.2, 0.5, 24, paint, ps, g, false);
  b.cylinder(cx, cz, top - 0.3, top, 0.45, 0.4, 8, paint, ps, g, true);
  // The catwalk round the bowl's rim and its rail.
  const deck = tank0 - 0.15;
  b.cylinder(cx, cz, deck - 0.12, deck, tankR + 1.0, tankR + 1.0, 24, legPaint, ps, g, true, true);
  // Hand rail and knee rail only: the balusters are too fine to be anything
  // but a grey haze at the distances the tower is seen from.
  for (const y of [0.5, 1.0]) {
    b.cylinder(cx, cz, deck + y, deck + y + 0.07, tankR + 0.95, tankR + 0.95, 24, legPaint, [0.15, 0, Style.Plain], g, false);
  }
  const circ = 2 * Math.PI * tankR;
  // Lettering rows, from the 2022 photograph: the small line above the large.
  for (let r = 0; r < DECAL_TEXT.length; r++) {
    const d = DECAL_TEXT[r];
    if (d.group !== DecalGroup.WaterTower) continue;
    const v = d.h < 1 ? 4.0 : 2.5;
    decals.push({ row: r, group: d.group, rect: [circ / 2, v, -d.w, d.h] });
  }
}
