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
}

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
  roof?: "flat" | "gable" | "none";
  glow?: Glow;
}

// Paint: the island's buildings are cast concrete and stucco painted a pale
// buff, long faded and salt-stained. Measured off the drape's sunlit walls
// (sRGB ~200,190,170) and taken a little darker, because the drape's walls
// are seen at grazing sun.
const BUFF: Rgb = [0.66, 0.6, 0.5];
const PALE: Rgb = [0.78, 0.74, 0.64];
const WHITE: Rgb = [0.8, 0.79, 0.75];
const CONCRETE: Rgb = [0.55, 0.53, 0.5];
const OCHRE: Rgb = [0.6, 0.47, 0.34];

/**
 * Heights from the National Park Service's historic structure reports and
 * photographs, where OSM has none: the cellhouse is three tiers of cells
 * under a roof about 14 m up; Building 64 is four storeys standing on the dock.
 */
const BY_NAME: Record<string, Spec> = {
  "Main Prison": { h: 14, style: Style.Cellhouse, colour: PALE },
  "Dining Hall": { h: 12, style: Style.Cellhouse, colour: PALE },
  "Administration Block": { h: 13, style: Style.Office, colour: PALE, glow: Glow.Rooms },
  "Building 64": { h: 14, style: Style.Office, colour: BUFF, glow: Glow.Rooms },
  "New Industries Building": { h: 9, style: Style.Industrial, colour: [0.62, 0.5, 0.38] },
  "Model Industries Building": { h: 8, style: Style.Industrial, colour: BUFF },
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
const GUARD_TOWER_H = 12;
/** The recreation yard's walls; every other free-standing wall is a parapet or a garden wall. */
const YARD_WALL_H = 6.5;
const WALL_H = 2.2;
const RETAINING_H = 1.0;

class Builder {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  s: number[] = [];
  w: number[] = [];
  i: number[] = [];
  /** Height of the facade being built above its ground line; the shader stops the window rows short of it. 0: unlimited. */
  facadeH = 0;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, col: Rgb, surf: [number, number, number], u: number, v: number, len: number): number {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.c.push(col[0], col[1], col[2]);
    this.s.push(surf[0], surf[1], surf[2]);
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
    surf: [number, number, number], ref: number, capTop: boolean, capBottom = false): void {
    const circ = 2 * Math.PI * Math.max(r0, r1);
    const slope = (r0 - r1) / Math.max(1e-3, y1 - y0);
    const base = this.p.length / 3;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
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

function pointInRing(x: number, z: number, ring: Float32Array): boolean {
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
}

export function buildAlcatrazModel(input: BuildInput): AlcatrazModel {
  const b = new Builder();
  const modelled: Modelled[] = [];
  const footprints: Float32Array[] = [];
  let lantern: LanternAt | null = null;
  const { features, toWorld, groundAt } = input;

  const yardF = features.find((f) => f.tags["name"] === "Recreation Yard");
  const yard = yardF ? ringOf(yardF, toWorld) : null;

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
      waterTower(b, cx, cz, radiusOf(ring), g.min);
      modelled.push({ id: f.id, name, kind: "water_tower", cx, cz, groundY: g.min, topY: g.min + WATER_TOWER_H });
      continue;
    }
    if (t["man_made"] === "chimney") {
      const r = Math.max(1.2, radiusOf(ring));
      const top = g.min + CHIMNEY_H;
      b.cylinder(cx, cz, g.min - 1, top - 1.5, r, r * 0.72, 16, [0.5, 0.42, 0.36], [0.05, 0, Style.Steel], g.min, false);
      b.cylinder(cx, cz, top - 1.5, top, r * 0.78, r * 0.76, 16, [0.16, 0.14, 0.13], [0.05, 0, Style.Steel], g.min, true);
      modelled.push({ id: f.id, name: name || "Smokestack", kind: "chimney", cx, cz, groundY: g.min, topY: top });
      continue;
    }
    if (t["man_made"] === "tower") {
      const top = g.med + GUARD_TOWER_H;
      b.facadeH = GUARD_TOWER_H;
      b.ringWalls(ring, g.min - 0.5, top, CONCRETE, [0.05, 0, Style.Guard], g.med);
      const eave = offsetRing(ring, 0.6);
      b.ringWalls(eave, top, top + 0.35, [0.25, 0.24, 0.22], [0.05, 0, Style.Plain], top);
      b.cap(eave, top + 0.35, true, [0.3, 0.29, 0.27], [0.1, 0, Style.Roof]);
      b.cap(eave, top, false, [0.3, 0.29, 0.27], [0.1, 0, Style.Roof]);
      modelled.push({ id: f.id, name: name || "Guard Tower", kind: "guard_tower", cx, cz, groundY: g.med, topY: top });
      continue;
    }

    const ruinTag = t["building"] === "ruins";
    const spec: Spec = BY_NAME[name] ?? (ruinTag
      ? { h: 3, style: Style.Ruin, colour: [0.56, 0.52, 0.46], roof: "none" }
      : { h: t["height"] ? Number(t["height"]) : t["building:levels"] ? Number(t["building:levels"]) * 3.3 + 1 : 4.5, style: Style.Office, colour: BUFF });
    const h = t["height"] && BY_NAME[name] === undefined ? Number(t["height"]) : spec.h;
    const top = g.med + h;
    const surf: [number, number, number] = [0.05, spec.glow ?? Glow.None, spec.style];
    b.facadeH = h;
    const roof = spec.roof ?? "flat";

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

    b.ringWalls(ring, g.min - 0.5, top, spec.colour, surf, g.med);
    let peak = top;
    if (roof === "gable") {
      peak = gableRoof(b, ring, top, [0.42, 0.24, 0.18], spec.colour, spec.style, g.med);
    } else {
      // A cornice lip, then the roof: a dark tar deck inside a parapet band.
      const lip = offsetRing(ring, 0.25);
      const band: Rgb = [spec.colour[0] * 0.92, spec.colour[1] * 0.92, spec.colour[2] * 0.92];
      b.ringWalls(lip, top - 0.45, top + 0.15, band, [0.05, 0, Style.Plain], top);
      b.cap(lip, top - 0.45, false, band, [0.05, 0, Style.Plain]);
      b.cap(lip, top + 0.15, true, name === "Main Prison" || name === "Dining Hall" ? [0.5, 0.51, 0.52] : [0.52, 0.5, 0.47], [0.2, 0, Style.Roof]);
      peak = top + 0.15;
    }
    modelled.push({ id: f.id, name, kind: "building", cx, cz, groundY: g.med, topY: peak });
  }

  return { mesh: b.finish(), modelled, lantern, footprints };
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
 * The 1940 water tower: a riveted steel tank with a conical roof on six legs
 * with two rings of struts. Footprint radius is the leg circle.
 */
function waterTower(b: Builder, cx: number, cz: number, footR: number, g: number): void {
  const legR = Math.max(4, Math.min(7, footR));
  const tankR = legR * 0.95;
  const tank0 = g + WATER_TOWER_H - 11.5;
  const tank1 = g + WATER_TOWER_H - 3;
  const steel: Rgb = [0.3, 0.24, 0.2];
  const paint: Rgb = [0.78, 0.76, 0.7];
  const legs = 6;
  const at = (k: number, y: number, r: number): [number, number, number] => {
    const a = (k / legs) * Math.PI * 2 + 0.3;
    return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
  };
  for (let k = 0; k < legs; k++) {
    // Battered legs: wider at the foot, plumb under the tank's rim.
    b.strut(at(k, g - 0.5, legR * 1.12), at(k, tank0 + 0.5, tankR * 0.92), 0.22, steel, [0.2, 0, Style.Steel]);
    for (const f of [0.35, 0.7]) {
      const y = g + (tank0 - g) * f;
      const r = legR * 1.12 + (tankR * 0.92 - legR * 1.12) * f;
      b.strut(at(k, y, r), at(k + 1, y, r), 0.09, steel, [0.2, 0, Style.Steel]);
    }
    // One diagonal per bay, the cross bracing a photo reads as an X.
    b.strut(at(k, g + 0.3, legR * 1.1), at(k + 1, g + (tank0 - g) * 0.35, legR * 1.1 + (tankR * 0.92 - legR * 1.12) * 0.35), 0.05, steel, [0.2, 0, Style.Steel]);
    b.strut(at(k + 1, g + 0.3, legR * 1.1), at(k, g + (tank0 - g) * 0.35, legR * 1.1 + (tankR * 0.92 - legR * 1.12) * 0.35), 0.05, steel, [0.2, 0, Style.Steel]);
  }
  // Tank: a shallow dished bottom, the shell, the roof cone and its finial.
  b.cylinder(cx, cz, tank0 - 1.2, tank0, 0.6, tankR, 24, paint, [0.15, 0, Style.Steel], g, false);
  b.cylinder(cx, cz, tank0, tank1, tankR, tankR, 24, paint, [0.15, 0, Style.Steel], g, false);
  b.cylinder(cx, cz, tank1, tank1 + 0.2, tankR + 0.15, tankR + 0.15, 24, paint, [0.15, 0, Style.Steel], g, false);
  b.cylinder(cx, cz, tank1 + 0.2, g + WATER_TOWER_H - 0.4, tankR + 0.15, 0.4, 24, paint, [0.15, 0, Style.Steel], g, false);
  b.cylinder(cx, cz, g + WATER_TOWER_H - 0.4, g + WATER_TOWER_H, 0.4, 0.15, 8, paint, [0.15, 0, Style.Steel], g, true);
}
