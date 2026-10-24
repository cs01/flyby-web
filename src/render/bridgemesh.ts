// The meshes of the landmark bridges, built parametrically from
// data/landmarks.ts. Pure: no THREE and no DOM, so test/bridge.check.ts can
// build a bridge under Bun and measure it.
//
// THREE BUCKETS, because the things a bridge is made of are seen at very
// different ranges:
//
//   * FAR: towers, piers, anchorages, deck, truss chords. These ARE the bridge
//     from 10 km and are always drawn, and they cast sun shadows.
//   * NEAR: railings, posts, floor beams, lateral bracing, lamp posts: under a
//     pixel past a couple of kilometres, so drawn only inside NEAR_M.
//   * LINES: cables, suspenders, stays. A Golden Gate suspender is 68 mm
//     across, a quarter of a pixel at 300 m. Drawn as their real radius they
//     fall between pixel centres and break into dotted lines, which is the
//     single loudest tell of a CG bridge. So a line vertex carries its
//     centreline and its radius, and the shader widens it to a minimum
//     fraction of a pixel; MSAA does the rest. See render/bridges.ts.
//
// Every vertex carries its own albedo, gloss and emissive kind, so a whole
// bridge is three draw calls whatever it is made of.

import { deckYAt, type Deck } from "../data/bridgedeck";
import { ROAD_BRIDGE, roadWidthM, type RoadPack } from "../data/roadpack";
import { isDriveable } from "../data/roadgraph";
import {
  axisOf,
  landmarkOwnsRoad,
  profileY,
  worldAt,
  type Landmark,
  type LandmarkSpec,
} from "../data/landmarks";

export type V3 = [number, number, number];

/** Emissive kinds, read by the fragment shader. */
export const EMIT_NONE = 0;
/** Aviation obstruction red, steady, night only. */
export const EMIT_AVIATION = 1;
/** Sodium-warm roadway lamp heads. */
export const EMIT_DECK = 2;
/** White LEDs: the Bay Lights on the west span's suspenders, the SAS cable. */
export const EMIT_LED = 3;

export interface MeshData {
  position: Float32Array;
  normal: Float32Array;
  /** Linear albedo. */
  colour: Float32Array;
  /** x gloss 0..1, y emissive kind, z line radius in metres (0: not a line). */
  surf: Float32Array;
  index: Uint32Array;
  triangles: number;
}

export interface BridgeMesh {
  far: MeshData;
  near: MeshData;
  lines: MeshData;
  /** World-space bounds, for the near-bucket distance test. */
  min: V3;
  max: V3;
  /** Measured as built, for the gate. */
  stats: BridgeBuildStats;
}

export interface BridgeBuildStats {
  /** Highest point of each tower, metres above sea level. */
  towerTopsM: number[];
  /** Main-span cable sag over span, per main span. */
  sagRatios: number[];
  /** Lowest point of the main cable over each main span. */
  cableLowM: number[];
  /** Deck height at mid main span, metres above sea level. */
  midDeckM: number[];
  /** Tower centres, world xz, so the gate can measure them against the road. */
  towers: { x: number; z: number }[];
}

/** Where a deck actually is, read off the pack's solved decks. */
export interface DeckSampler {
  /** The roadway at (x, z), upper or lower level, or null when no bridge way
   *  of this landmark is within reach. */
  at(x: number, z: number, level: "upper" | "lower"): number | null;
  /** The bridge ways this landmark carries, as polylines with their solved
   *  heights at every vertex, for viaducts that follow the road. */
  ways: { pts: Float32Array; y: Float32Array; widthM: number; drives: boolean }[];
}

/**
 * Where each landmark's deck is, read off the solved decks of the ways it
 * carries.
 *
 * WHY NOT THE PROFILE. Inside the pinned zone the two agree to the
 * millimetre, but outside it (the approaches, every Chicago bascule) the
 * ribbon is drawn from the solve, and a structure drawn from anything else
 * would stand off the road it carries.
 */
export function deckSampler(l: Landmark, pack: RoadPack, decks: readonly (Deck | null)[]): DeckSampler {
  const ways: DeckSampler["ways"] = [];
  const segs: { ax: number; az: number; bx: number; bz: number; ya: number; yb: number }[] = [];
  for (let i = 0; i < pack.roads.length; i++) {
    const r = pack.roads[i];
    if ((r.flags & ROAD_BRIDGE) === 0) continue;
    const d = decks[i];
    if (!d || !landmarkOwnsRoad(l, r)) continue;
    const y = new Float32Array(r.pts.length / 2);
    let s = 0;
    for (let k = 0; k < r.pts.length; k += 2) {
      if (k) s += Math.hypot(r.pts[k] - r.pts[k - 2], r.pts[k + 1] - r.pts[k - 1]);
      y[k / 2] = deckYAt(d, s);
    }
    ways.push({ pts: r.pts, y, widthM: roadWidthM(r.cls, r.lanes, r.flags), drives: isDriveable(r) });
    for (let k = 2; k < r.pts.length; k += 2) {
      segs.push({ ax: r.pts[k - 2], az: r.pts[k - 1], bx: r.pts[k], bz: r.pts[k + 1], ya: y[k / 2 - 1], yb: y[k / 2] });
    }
  }
  return {
    ways,
    at(x, z, level) {
      let best: number | null = null;
      for (const g of segs) {
        const dx = g.bx - g.ax;
        const dz = g.bz - g.az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - g.ax) * dx + (z - g.az) * dz) / l2)) : 0;
        const d = Math.hypot(g.ax + dx * t - x, g.az + dz * t - z);
        if (d > 30) continue;
        const y = g.ya + (g.yb - g.ya) * t;
        if (best === null || (level === "upper" ? y > best : y < best)) best = y;
      }
      return best;
    },
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function srgbHexToLinear(hex: string): V3 {
  const v = parseInt(hex.replace("#", ""), 16);
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [f((v >> 16) & 255), f((v >> 8) & 255), f(v & 255)];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? scl(a, 1 / l) : [0, 1, 0];
};

export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private srf: number[] = [];
  private idx: number[] = [];
  colour: V3 = [0.5, 0.5, 0.5];
  gloss = 0.25;
  emit = EMIT_NONE;

  set(colour: V3, gloss = 0.25, emit = EMIT_NONE): this {
    this.colour = colour;
    this.gloss = gloss;
    this.emit = emit;
    return this;
  }

  private vert(p: V3, n: V3, radius = 0): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(this.colour[0], this.colour[1], this.colour[2]);
    this.srf.push(this.gloss, this.emit, radius);
    return i;
  }

  /** A flat quad, wound so it faces `n`. */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3): void {
    const facing = dot(cross(sub(b, a), sub(c, a)), n);
    const i0 = this.vert(a, n);
    const i1 = this.vert(b, n);
    const i2 = this.vert(c, n);
    const i3 = this.vert(d, n);
    if (facing >= 0) this.idx.push(i0, i1, i2, i0, i2, i3);
    else this.idx.push(i0, i2, i1, i0, i3, i2);
  }

  /**
   * A box from its centre and three orthogonal half-extent vectors.
   * `skip` drops faces nobody can see (a bottom on the sea bed, a top under a
   * deck), by axis: "-y" and the like, in the box's own frame.
   */
  box(c: V3, ex: V3, ey: V3, ez: V3, skip = ""): void {
    const axes: [V3, V3, V3, string][] = [
      [ex, ey, ez, "x"],
      [ey, ez, ex, "y"],
      [ez, ex, ey, "z"],
    ];
    for (const [n, u, v, name] of axes) {
      for (const sgn of [1, -1]) {
        if (skip.includes((sgn > 0 ? "+" : "-") + name)) continue;
        const fc = add(c, scl(n, sgn));
        const nn = norm(scl(n, sgn));
        this.quad(
          sub(sub(fc, u), v), add(sub(fc, v), u), add(add(fc, u), v), add(sub(fc, u), v), nn,
        );
      }
    }
  }

  /** An axis-aligned-in-y box in a landmark frame: centre (t, s, y), half
   *  extents along, across and up. */
  frameBox(l: Landmark, t: number, s: number, y: number, ht: number, hs: number, hy: number, skip = ""): void {
    const p = worldAt(l, t, s);
    this.box([p.x, y, p.z], [l.ux * ht, 0, l.uz * ht], [0, hy, 0], [l.vx * hs, 0, l.vz * hs], skip);
  }

  /**
   * A rectangular member from a to b, `w` wide and `h` deep. `up` picks which
   * way `h` points; it is made orthogonal to the member.
   */
  beam(a: V3, b: V3, w: number, h: number, up: V3 = [0, 1, 0]): void {
    const d = sub(b, a);
    const L = len(d);
    if (L < 1e-4) return;
    const u = scl(d, 1 / L);
    let side = cross(u, up);
    if (len(side) < 1e-4) side = cross(u, [1, 0, 0]);
    side = norm(side);
    const upv = norm(cross(side, u));
    this.box(scl(add(a, b), 0.5), scl(u, L / 2), scl(upv, h / 2), scl(side, w / 2));
  }

  /**
   * A line: a tube along a polyline whose vertices sit ON the centreline and
   * carry their radius, so the shader can widen it to a minimum on-screen
   * width. `sides` 4 is a diamond, which at a pixel or two is all a cable is.
   */
  line(points: V3[], radius: number, sides = 4): void {
    if (points.length < 2) return;
    const rings: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const t = norm(sub(next, prev));
      let a = cross(t, [0, 1, 0]);
      if (len(a) < 1e-4) a = cross(t, [1, 0, 0]);
      a = norm(a);
      const b = norm(cross(a, t));
      rings.push(this.pos.length / 3);
      for (let k = 0; k < sides; k++) {
        const th = (k / sides) * Math.PI * 2;
        const n = add(scl(a, Math.cos(th)), scl(b, Math.sin(th)));
        this.vert(points[i], n, radius);
      }
    }
    for (let i = 1; i < rings.length; i++) {
      const r0 = rings[i - 1];
      const r1 = rings[i];
      for (let k = 0; k < sides; k++) {
        const k1 = (k + 1) % sides;
        this.idx.push(r0 + k, r1 + k, r1 + k1, r0 + k, r1 + k1, r0 + k1);
      }
    }
  }

  /** A point light: an octahedron on the line path, so it never shrinks
   *  under a couple of pixels and the bloom can find it from 10 km. */
  light(p: V3, radius: number): void {
    const dirs: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const base = this.pos.length / 3;
    for (const d of dirs) this.vert(p, d, radius);
    const f = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
    for (const [a, b, c] of f) this.idx.push(base + a, base + b, base + c);
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  finish(): MeshData {
    return {
      position: Float32Array.from(this.pos),
      normal: Float32Array.from(this.nrm),
      colour: Float32Array.from(this.col),
      surf: Float32Array.from(this.srf),
      index: Uint32Array.from(this.idx),
      triangles: this.idx.length / 3,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared parts
// ---------------------------------------------------------------------------

/** A frame point as a V3. */
function P(l: Landmark, t: number, s: number, y: number): V3 {
  const w = worldAt(l, t, s);
  return [w.x, y, w.z];
}

const CONCRETE: V3 = srgbHexToLinear("#B4AEA2");
const GRANITE: V3 = srgbHexToLinear("#A89A82");
const ASPHALT: V3 = srgbHexToLinear("#3A3A3C");
const CABLE_GREY: V3 = srgbHexToLinear("#8C9094");
const LAMP_HEAD: V3 = [0.9, 0.7, 0.4];
const RED_LIGHT: V3 = [1, 0.05, 0.02];
const WHITE_LIGHT: V3 = [1, 1, 1];

/**
 * A parabolic cable between two saddles, `sag` below the chord at mid-span.
 * The exact catenary differs from the parabola by under 1 % of the sag at
 * these ratios, and the parabola is what a uniformly loaded deck hangs as.
 */
function cableY(y0: number, y1: number, sag: number, u: number): number {
  return y0 + (y1 - y0) * u - 4 * sag * u * (1 - u);
}

interface Span {
  t0: number;
  t1: number;
  y0: number;
  y1: number;
  sag: number;
}

/** Cable polylines for a run of spans at lateral offset s, sampled every
 *  `stepM`. Returns the points. */
function cablePoints(l: Landmark, s: number, spans: Span[], stepM = 12): V3[] {
  const out: V3[] = [];
  for (const sp of spans) {
    const n = Math.max(2, Math.ceil(Math.abs(sp.t1 - sp.t0) / stepM));
    for (let k = out.length ? 1 : 0; k <= n; k++) {
      const u = k / n;
      out.push(P(l, sp.t0 + (sp.t1 - sp.t0) * u, s, cableY(sp.y0, sp.y1, sp.sag, u)));
    }
  }
  return out;
}

function cableAt(sp: Span, t: number): number {
  return cableY(sp.y0, sp.y1, sp.sag, (t - sp.t0) / (sp.t1 - sp.t0));
}

/** Vertical suspenders from a span's cable to `deckTop(t)`, every `stepM`,
 *  starting `stepM` in from each end. */
function suspenders(
  m: MeshBuilder, l: Landmark, s: number, sp: Span, stepM: number,
  deckTop: (t: number) => number, radius: number, pair = 0,
): number {
  let n = 0;
  const a = Math.min(sp.t0, sp.t1);
  const b = Math.max(sp.t0, sp.t1);
  const count = Math.floor((b - a) / stepM);
  const pad = (b - a - count * stepM) / 2;
  for (let k = 1; k < count + (pad > stepM * 0.4 ? 1 : 0); k++) {
    const t = a + pad + k * stepM;
    const top = cableAt(sp, t);
    const bot = deckTop(t);
    if (top - bot < 0.8) continue;
    for (const d of pair > 0 ? [-pair, pair] : [0]) {
      m.line([P(l, t + d, s, top), P(l, t + d, s, bot)], radius, 4);
    }
    n++;
  }
  return n;
}

/**
 * A Warren truss with verticals in the plane at lateral offset `s`, from t0 to
 * t1, its top chord `topBelow` under `deckY(t)` and `depth` deep.
 */
function truss(
  far: MeshBuilder, _near: MeshBuilder, l: Landmark, s: number, t0: number, t1: number,
  deckY: (t: number) => number, topBelow: number, depth: number, panel: number,
  chord: [number, number], web: number,
): void {
  const n = Math.max(1, Math.round((t1 - t0) / panel));
  const dt = (t1 - t0) / n;
  const top = (t: number): number => deckY(t) - topBelow;
  for (let k = 0; k < n; k++) {
    const ta = t0 + k * dt;
    const tb = ta + dt;
    far.beam(P(l, ta, s, top(ta)), P(l, tb, s, top(tb)), chord[0], chord[1]);
    far.beam(P(l, ta, s, top(ta) - depth), P(l, tb, s, top(tb) - depth), chord[0], chord[1]);
    far.beam(P(l, ta, s, top(ta) - depth), P(l, ta, s, top(ta)), web, web);
    if (k % 2 === 0) far.beam(P(l, ta, s, top(ta) - depth), P(l, tb, s, top(tb)), web, web);
    else far.beam(P(l, ta, s, top(ta)), P(l, tb, s, top(tb) - depth), web, web);
  }
}

/** Concrete deck slab, the walkways and the railings, along the axis. The
 *  slab top sits `under` below the roadway so the ribbon, not the slab, is
 *  the surface you see and drive. */
function deckSlab(
  far: MeshBuilder, near: MeshBuilder, l: Landmark, t0: number, t1: number,
  deckY: (t: number) => number, halfW: number, roadHalfW: number, opts: {
    under?: number; thick?: number; rail?: V3; railH?: number; postEvery?: number;
    lampEvery?: number; lampH?: number; walkUp?: number; fascia?: V3; slab?: V3;
  } = {},
): void {
  const under = opts.under ?? 0.12;
  const thick = opts.thick ?? 0.9;
  const step = 10;
  const n = Math.max(1, Math.ceil((t1 - t0) / step));
  const dt = (t1 - t0) / n;
  const slabCol = opts.slab ?? ASPHALT;
  const fascia = opts.fascia ?? slabCol;
  const walkUp = opts.walkUp ?? 0.2;
  for (let k = 0; k < n; k++) {
    const ta = t0 + k * dt;
    const tb = ta + dt;
    const ya = deckY(ta) - under;
    const yb = deckY(tb) - under;
    far.set(slabCol, 0.15);
    // Top of the slab across the full width, under the ribbon.
    far.quad(P(l, ta, -halfW, ya), P(l, tb, -halfW, yb), P(l, tb, halfW, yb), P(l, ta, halfW, ya), [0, 1, 0]);
    // Soffit.
    far.quad(P(l, ta, -halfW, ya - thick), P(l, ta, halfW, ya - thick), P(l, tb, halfW, yb - thick), P(l, tb, -halfW, yb - thick), [0, -1, 0]);
    // Fascia, both edges.
    far.set(fascia, 0.3);
    for (const sg of [-1, 1]) {
      const n3: V3 = [l.vx * sg, 0, l.vz * sg];
      far.quad(P(l, ta, sg * halfW, ya + walkUp), P(l, tb, sg * halfW, yb + walkUp), P(l, tb, sg * halfW, yb - thick), P(l, ta, sg * halfW, ya - thick), n3);
      // The walkway, raised over the roadway outside the curb.
      if (halfW - roadHalfW > 0.5) {
        far.set(CONCRETE, 0.1);
        far.quad(P(l, ta, sg * roadHalfW, ya + walkUp), P(l, tb, sg * roadHalfW, yb + walkUp), P(l, tb, sg * halfW, yb + walkUp), P(l, ta, sg * halfW, ya + walkUp), [0, 1, 0]);
        // Curb face.
        far.quad(P(l, ta, sg * roadHalfW, ya), P(l, tb, sg * roadHalfW, yb), P(l, tb, sg * roadHalfW, yb + walkUp), P(l, ta, sg * roadHalfW, ya + walkUp), [-l.vx * sg, 0, -l.vz * sg]);
        far.set(fascia, 0.3);
      }
    }
  }
  // Railings: a top rail in the far bucket, the posts near.
  const railH = opts.railH ?? 1.2;
  const rail = opts.rail ?? fascia;
  for (const sg of [-1, 1]) {
    const s = sg * (halfW - 0.1);
    far.set(rail, 0.35);
    near.set(rail, 0.35);
    for (let k = 0; k < n; k++) {
      const ta = t0 + k * dt;
      const tb = ta + dt;
      far.beam(P(l, ta, s, deckY(ta) - under + walkUp + railH), P(l, tb, s, deckY(tb) - under + walkUp + railH), 0.12, 0.12);
      near.beam(P(l, ta, s, deckY(ta) - under + walkUp + 0.15), P(l, tb, s, deckY(tb) - under + walkUp + 0.15), 0.08, 0.08);
    }
    const every = opts.postEvery ?? 1.8;
    for (let t = t0; t <= t1; t += every) {
      const y = deckY(t) - under + walkUp;
      near.beam(P(l, t, s, y), P(l, t, s, y + railH), 0.06, 0.06, [l.ux, 0, l.uz]);
    }
    if (opts.lampEvery) {
      for (let t = t0 + opts.lampEvery / 2; t <= t1; t += opts.lampEvery) {
        const y = deckY(t) - under + walkUp;
        const h = opts.lampH ?? 9;
        near.set(rail, 0.35);
        near.beam(P(l, t, s, y), P(l, t, s, y + h), 0.18, 0.18, [l.ux, 0, l.uz]);
        near.beam(P(l, t, s, y + h), P(l, t, s - sg * 1.6, y + h + 0.3), 0.12, 0.12);
        far.set(LAMP_HEAD, 0.2, EMIT_DECK);
        far.light(P(l, t, s - sg * 1.6, y + h + 0.1), 0.35);
      }
    }
  }
}

/** A pier from below the water line (or ground) up to `top`. */
function pier(m: MeshBuilder, l: Landmark, t: number, s: number, ground: number, top: number, ht: number, hs: number, col: V3): void {
  const bot = Math.min(ground, 0) - 3;
  m.set(col, 0.08);
  m.frameBox(l, t, s, (bot + top) / 2, ht, hs, (top - bot) / 2, "-y");
}

/**
 * Viaducts that carry this landmark's road ways where its own structure does
 * not: the approaches. Follows every way, so a curve in the road is a curve in
 * the viaduct, and reads the SOLVED deck at every vertex, so the ribbon lies
 * on it exactly. `skip(x, z)` is true over the stretch the hand-built
 * structure already covers.
 */
function viaducts(
  far: MeshBuilder, near: MeshBuilder, deck: DeckSampler, groundAt: (x: number, z: number) => number,
  skip: (x: number, z: number) => boolean, col: V3, opts: { girder?: number; pierEvery?: number; minClear?: number } = {},
): void {
  const girder = opts.girder ?? 2.2;
  const every = opts.pierEvery ?? 48;
  const minClear = opts.minClear ?? 3.5;
  for (const w of deck.ways) {
    const p = w.pts;
    const half = w.widthM / 2 + 0.6;
    let sinceP = every / 2;
    for (let k = 2; k < p.length; k += 2) {
      const ax = p[k - 2], az = p[k - 1], bx = p[k], bz = p[k + 1];
      if (skip((ax + bx) / 2, (az + bz) / 2)) continue;
      const ya = w.y[k / 2 - 1] - 0.12;
      const yb = w.y[k / 2] - 0.12;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-3) continue;
      const nx = -(bz - az) / L;
      const nz = (bx - ax) / L;
      const A = (s: number, y: number): V3 => [ax + nx * s, y, az + nz * s];
      const B = (s: number, y: number): V3 => [bx + nx * s, y, bz + nz * s];
      far.set(col, 0.15);
      far.quad(A(-half, ya), B(-half, yb), B(half, yb), A(half, ya), [0, 1, 0]);
      far.quad(A(-half, ya - girder), A(half, ya - girder), B(half, yb - girder), B(-half, yb - girder), [0, -1, 0]);
      for (const sg of [-1, 1]) {
        far.quad(A(sg * half, ya + 0.9), B(sg * half, yb + 0.9), B(sg * half, yb - girder), A(sg * half, ya - girder), [nx * sg, 0, nz * sg]);
        // Parapet top, so the edge reads as a wall rather than as a card.
        far.quad(A(sg * half, ya + 0.9), B(sg * half, yb + 0.9), B(sg * (half - 0.3), yb + 0.9), A(sg * (half - 0.3), ya + 0.9), [0, 1, 0]);
        near.set(col, 0.15);
        near.quad(A(sg * (half - 0.3), ya + 0.9), B(sg * (half - 0.3), yb + 0.9), B(sg * (half - 0.3), yb), A(sg * (half - 0.3), ya), [-nx * sg, 0, -nz * sg]);
      }
      // Piers, on the ground under the deck where it clears it.
      sinceP += L;
      while (sinceP >= every) {
        sinceP -= every;
        const u = 1 - sinceP / L;
        if (u < 0 || u > 1) continue;
        const px = ax + (bx - ax) * u;
        const pz = az + (bz - az) * u;
        const y = ya + (yb - ya) * u - girder;
        const g = groundAt(px, pz);
        if (y - g < minClear) continue;
        far.set(CONCRETE, 0.08);
        far.box([px, (y + Math.min(g, 0) - 2) / 2, pz], [(bx - ax) / L * 1.4, 0, (bz - az) / L * 1.4], [0, (y - Math.min(g, 0) + 2) / 2, 0], [nx * Math.min(half * 0.6, 4), 0, nz * Math.min(half * 0.6, 4)], "-y");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

export interface BuildContext {
  groundAt: (x: number, z: number) => number;
  deck: DeckSampler;
}

/** The upper roadway along the axis: the surveyed profile inside the pinned
 *  zone, the solved deck outside it. */
function roadwayY(l: Landmark, ctx: BuildContext, level: "upper" | "lower" = "upper"): (t: number) => number {
  const spec = l.spec;
  return (t) => {
    const z = spec.zone;
    if (z && spec.profile && t >= z[0] && t <= z[1]) {
      const base = profileY(spec, t);
      return level === "lower" ? base + (spec.layerDy?.find((d) => d.dy < 0)?.dy ?? -8) : base;
    }
    const p = worldAt(l, t, 0);
    return ctx.deck.at(p.x, p.z, level) ?? profileY(spec, t);
  };
}

/** The ribbon's own height at axis station t, for the stats: the gate measures
 *  the deck a car drives, not the profile the structure was drawn from. */
function ribbonAt(l: Landmark, ctx: BuildContext, t: number): number | null {
  const p = worldAt(l, t, 0);
  return ctx.deck.at(p.x, p.z, "upper");
}

function goldenGate(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder, lines: MeshBuilder, st: BridgeBuildStats): void {
  const sp = l.spec.p;
  const orange = srgbHexToLinear(l.spec.colour);
  const L = l.lengthM;
  const deck = roadwayY(l, ctx);
  const cs = sp.legHalfSpacingM;
  const side = sp.sideSpanM;
  const saddle = sp.saddleM;

  // --- towers ---------------------------------------------------------------
  // Legs from OSM's own tiers: bases 21/74/123/162/195, tops to 225, each
  // setting back. Across x along, metres, against the published 10 x 16 m base
  // and the 4 x 8 m the parts end at.
  const tiers: [number, number, number, number][] = [
    [21, 74, 10.0, 16.0],
    [74, 123, 9.4, 13.6],
    [123, 162, 8.8, 11.6],
    [162, 195, 8.0, 10.4],
    [195, 225, 7.0, 9.0],
  ];
  // Portal struts above the deck, metres: published elevations put four over
  // the roadway, the top one capping the legs.
  const struts: [number, number][] = [[112, 123], [151, 162], [186, 195], [216, 225]];
  for (const tt of [0, L]) {
    const w = worldAt(l, tt, 0);
    st.towers.push({ x: w.x, z: w.z });
    const g = ctx.groundAt(w.x, w.z);
    pier(far, l, tt, 0, g, sp.pierTopM, 22, 32, CONCRETE);
    // The fender ring round the south pier, a low concrete oval at the water.
    if (tt === 0) {
      far.set(CONCRETE, 0.08);
      for (let k = 0; k < 24; k++) {
        const a0 = (k / 24) * Math.PI * 2;
        const a1 = ((k + 1) / 24) * Math.PI * 2;
        far.beam(P(l, tt + Math.cos(a0) * 55, Math.sin(a0) * 38, 4), P(l, tt + Math.cos(a1) * 55, Math.sin(a1) * 38, 4), 3, 9);
      }
    }
    far.set(orange, 0.35);
    for (const sg of [-1, 1]) {
      const s = sg * cs;
      for (const [y0, y1, across, along] of tiers) {
        far.frameBox(l, tt, s, (y0 + y1) / 2, along / 2, across / 2, (y1 - y0) / 2, y0 > 21 ? "-y" : "");
        // The recessed panels: pilasters 0.5 m proud at both corners of each
        // face, stopping short of the tier top so every setback reads as a
        // step. From the deck the faces read as fluted, which they are.
        const pil = 1.1;
        for (const sa of [-1, 1]) {
          far.frameBox(l, tt + sa * (along / 2 - pil / 2), s + (across / 2 + 0.25) * 0, (y0 + y1) / 2 - 1.5, pil / 2, across / 2 + 0.5, (y1 - y0) / 2 - 1.5, "-y");
          far.frameBox(l, tt, s + sa * (across / 2 - pil / 2), (y0 + y1) / 2 - 1.5, along / 2 + 0.5, pil / 2, (y1 - y0) / 2 - 1.5, "-y");
        }
      }
      // Saddle housing, which is what stands at 227 m.
      far.frameBox(l, tt, s, 226, 4.6, 3.6, 1.0, "-y");
      st.towerTopsM.push(227);
      far.set(RED_LIGHT, 0.2, EMIT_AVIATION);
      far.light(P(l, tt, s, 228.0), 0.6);
      // Mid-height obstruction lights on the outer faces.
      far.light(P(l, tt, s + sg * 5.2, 150), 0.45);
      far.set(orange, 0.35);
    }
    // Portal struts between the legs, with the vertical ribs that make their
    // faces read as the Art Deco panels they are.
    for (const [y0, y1] of struts) {
      const inner = cs - 4;
      far.frameBox(l, tt, 0, (y0 + y1) / 2, 3.4, inner, (y1 - y0) / 2);
      for (let r = -3; r <= 3; r++) {
        for (const sa of [-1, 1]) {
          far.frameBox(l, tt + sa * 3.6, r * (inner / 3.6), (y0 + y1) / 2, 0.25, 0.55, (y1 - y0) / 2 - 0.8, "-y");
        }
      }
    }
    // Under the deck: X bracing between the legs, two panels.
    const yDeck = deck(tt) - sp.trussDepthM - 1;
    const yA = sp.pierTopM + 2;
    const yM = (yA + yDeck) / 2;
    for (const [ya, yb] of [[yA, yM], [yM, yDeck]]) {
      far.beam(P(l, tt, -cs, ya), P(l, tt, cs, yb), 2.4, 2.8, [l.ux, 0, l.uz]);
      far.beam(P(l, tt, cs, ya), P(l, tt, -cs, yb), 2.4, 2.8, [l.ux, 0, l.uz]);
      far.frameBox(l, tt, 0, yb, 2.4, cs, 1.6);
    }
  }

  // --- cables ---------------------------------------------------------------
  const sAnch = -side;
  const nAnch = L + side;
  const mainSpan: Span = { t0: 0, t1: L, y0: saddle, y1: saddle, sag: sp.sagM };
  // Side spans are suspended too: from the saddle to the end pylon just over
  // the deck, sagging ~1/30 of their length below the chord.
  const southSide: Span = { t0: sAnch, t1: 0, y0: deck(sAnch) + 6, y1: saddle, sag: side / 30 };
  const northSide: Span = { t0: L, t1: nAnch, y0: saddle, y1: deck(nAnch) + 6, sag: side / 30 };
  const sag = mainSpan.sag;
  st.sagRatios.push(sag / L);
  st.cableLowM.push(cableAt(mainSpan, L / 2));
  st.midDeckM.push(ribbonAt(l, ctx, L / 2) ?? deck(L / 2));
  for (const sg of [-1, 1]) {
    const s = sg * cs;
    lines.set(orange, 0.45);
    const pts = cablePoints(l, s, [southSide, mainSpan, northSide]);
    // Down from the end pylons into the anchorages, 60 m on, below the deck.
    pts.unshift(P(l, sAnch - 60, s, deck(sAnch - 60) - 8));
    pts.push(P(l, nAnch + 60, s, deck(nAnch + 60) - 8));
    lines.line(pts, sp.cableR, 6);
    // Suspenders, in pairs half a metre apart, every 50 ft.
    const top = (t: number): number => deck(t) + 0.3;
    for (const span of [southSide, mainSpan, northSide]) suspenders(lines, l, s, span, sp.suspenderM, top, 0.034, 0.3);
  }

  // --- deck, truss --------------------------------------------------------
  const halfW = sp.deckWidthM / 2;
  deckSlab(far, near, l, sAnch, nAnch, deck, halfW, sp.roadWidthM / 2, {
    rail: orange, fascia: orange, slab: ASPHALT, lampEvery: 50, lampH: 8.5, railH: 1.3, thick: 0.8,
  });
  far.set(orange, 0.3);
  near.set(orange, 0.3);
  for (const sg of [-1, 1]) {
    truss(far, near, l, sg * cs, sAnch, nAnch, deck, 0.9, sp.trussDepthM, 7.62, [0.7, 0.9], 0.45);
  }
  // Floor beams and bottom lateral bracing, from below and up close only.
  for (let t = sAnch; t <= nAnch; t += 15.24) {
    const yb = deck(t) - 0.9 - sp.trussDepthM;
    near.beam(P(l, t, -cs, yb), P(l, t, cs, yb), 0.5, 0.8, [l.ux, 0, l.uz]);
    near.beam(P(l, t, -cs, yb), P(l, t + 15.24, cs, deck(t + 15.24) - 0.9 - sp.trussDepthM), 0.35, 0.35);
  }

  // --- end pylons and anchorages -----------------------------------------
  for (const [ta, dir] of [[sAnch, -1], [nAnch, 1]] as [number, number][]) {
    const yd = deck(ta);
    for (const sg of [-1, 1]) {
      const w = worldAt(l, ta, sg * (halfW + 4));
      const g = ctx.groundAt(w.x, w.z);
      // Art Deco concrete pylons standing over the deck, stepped at the top.
      far.set(CONCRETE, 0.1);
      far.frameBox(l, ta, sg * (halfW + 4), (g + yd + 10) / 2, 5, 3.5, (yd + 10 - g) / 2);
      far.frameBox(l, ta, sg * (halfW + 4), yd + 12, 4, 2.8, 2);
      far.frameBox(l, ta, sg * (halfW + 4), yd + 15, 2.8, 2, 1);
    }
    // Anchorage block 60 m behind the pylon, where the cables go in.
    const tb = ta + dir * 60;
    const w = worldAt(l, tb, 0);
    const g = ctx.groundAt(w.x, w.z);
    far.set(CONCRETE, 0.08);
    far.frameBox(l, tb, 0, (Math.min(g, 0) - 2 + deck(tb) - 2) / 2, 24, halfW + 8, (deck(tb) - 2 - Math.min(g, 0) + 2) / 2, "-y");
  }

  // --- the Fort Point arch ------------------------------------------------
  // 98 m steel arch over the fort, between the south pylon and the next pier
  // south. Two ribs, spandrel posts to the deck every 7.6 m.
  const a0 = sAnch - 60 - sp.fortPointArchM;
  const a1 = sAnch - 60;
  for (const sg of [-1, 1]) {
    const s = sg * (cs - 2);
    const spring = (t: number): number => {
      const w = worldAt(l, t, s);
      return ctx.groundAt(w.x, w.z) + 1;
    };
    const ys0 = spring(a0);
    const ys1 = spring(a1);
    const crown = deck((a0 + a1) / 2) - 4;
    far.set(orange, 0.3);
    let prev: V3 | null = null;
    for (let k = 0; k <= 16; k++) {
      const u = k / 16;
      const t = a0 + (a1 - a0) * u;
      const y = ys0 + (ys1 - ys0) * u + (crown - (ys0 + ys1) / 2) * 4 * u * (1 - u);
      const p = P(l, t, s, y);
      if (prev) far.beam(prev, p, 1.6, 2.6);
      if (k % 2 === 0 && k > 0 && k < 16) near.set(orange, 0.3), near.beam(p, P(l, t, s, deck(t) - 1.5), 0.6, 0.6);
      prev = p;
    }
  }
  deckSlab(far, near, l, a0 - 20, sAnch - 60, deck, halfW, sp.roadWidthM / 2, { rail: orange, fascia: orange, thick: 2.5 });

  // --- the approaches, along the road -------------------------------------
  viaducts(far, near, ctx.deck, ctx.groundAt, (x, z) => {
    const { t, s } = axisOf(l, x, z);
    return t > a0 - 20 && t < nAnch + 60 && Math.abs(s) < halfW + 6;
  }, CONCRETE);
}

function bayWest(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder, lines: MeshBuilder, st: BridgeBuildStats): void {
  const sp = l.spec.p;
  const steel = srgbHexToLinear(l.spec.colour);
  const L = l.lengthM;
  const upper = roadwayY(l, ctx, "upper");
  const cs = sp.legHalfSpacingM;
  const side = sp.sideSpanM;
  // W2, W3 | centre anchorage | W5, W6, from the OSM pylons projected on the
  // axis. Each main span keeps the published sag ratio for its own length.
  const [w3, ca, w5] = l.stationT;
  const towers = [0, w3, w5, L];
  const spans: Span[][] = [
    [
      { t0: -side, t1: 0, y0: upper(-side) + 4, y1: sp.saddleM, sag: side / 28 },
      { t0: 0, t1: w3, y0: sp.saddleM, y1: sp.saddleM, sag: sp.sagM * (w3 / 704) },
      { t0: w3, t1: ca, y0: sp.saddleM, y1: upper(ca) + 4, sag: (ca - w3) / 28 },
    ],
    [
      { t0: ca, t1: w5, y0: upper(ca) + 4, y1: sp.saddleM, sag: (w5 - ca) / 28 },
      { t0: w5, t1: L, y0: sp.saddleM, y1: sp.saddleM, sag: sp.sagM * ((L - w5) / 704) },
      { t0: L, t1: L + side, y0: sp.saddleM, y1: upper(L + side) + 4, sag: side / 28 },
    ],
  ];
  const truss0 = -side;
  const truss1 = L + side;
  const depth = sp.trussDepthM;
  // The truss: upper deck on the top chord, lower deck on the bottom chord.
  const topChord = (t: number): number => upper(t) - 0.4;

  for (const tt of towers) {
    const w = worldAt(l, tt, 0);
    st.towers.push({ x: w.x, z: w.z });
    const g = ctx.groundAt(w.x, w.z);
    pier(far, l, tt, 0, g, 8, 22, 40, srgbHexToLinear("#7E7A72"));
    far.set(steel, 0.35);
    // Each cable plane carries a braced frame of two columns ~18 m apart
    // along the bridge, which is why every broadside photograph shows the
    // tower as a ladder of diamonds; seen down the roadway it is a portal of
    // two such frames. Columns taper from 5 x 4.5 m to 3.5 x 3.5 m.
    const colT = (y: number): number => 9.5 - 3 * (y / sp.towerTopM);
    for (const sg of [-1, 1]) {
      for (const ct of [-1, 1]) {
        const n = 8;
        for (let k = 0; k < n; k++) {
          const y0 = 8 + ((sp.towerTopM - 8) * k) / n;
          const y1 = 8 + ((sp.towerTopM - 8) * (k + 1)) / n;
          const f = (k + 0.5) / n;
          far.frameBox(l, tt + ct * colT((y0 + y1) / 2), sg * cs, (y0 + y1) / 2, 2.5 - 0.7 * f, 2.25 - 0.5 * f, (y1 - y0) / 2, k ? "-y" : "");
        }
      }
      st.towerTopsM.push(sp.towerTopM);
      far.set(RED_LIGHT, 0.2, EMIT_AVIATION);
      far.light(P(l, tt, sg * cs, sp.towerTopM + 1.2), 0.6);
      far.set(steel, 0.35);
      // The diamonds, in this plane: X panels between the two columns the
      // full height, a strut at every panel point.
      const levels = [10, 31, 52, upper(tt) - depth - 2, upper(tt) + 2, 100, 121, 141, sp.towerTopM - 2];
      for (let k = 1; k < levels.length; k++) {
        const ya = levels[k - 1];
        const yb = levels[k];
        if (yb - ya < 5) continue;
        far.beam(P(l, tt - colT(ya), sg * cs, ya), P(l, tt + colT(yb), sg * cs, yb), 1.3, 1.2, [l.vx, 0, l.vz]);
        far.beam(P(l, tt + colT(ya), sg * cs, ya), P(l, tt - colT(yb), sg * cs, yb), 1.3, 1.2, [l.vx, 0, l.vz]);
        far.frameBox(l, tt, sg * cs, yb, colT(yb), 1.0, 0.9);
      }
    }
    // Across the roadway: struts tying the two frames at the top, under the
    // lower deck and twice in between.
    for (const y of [upper(tt) - depth - 3, 112, 136]) {
      for (const ct of [-1, 1]) far.frameBox(l, tt + ct * colT(y), 0, y, 1.6, cs, 1.4);
    }    far.frameBox(l, tt, 0, sp.towerTopM - 1.5, colT(sp.towerTopM) + 2, cs + 3, 1.5);
  }

  // Cables, two planes.
  for (const group of spans) {
    const main = group[1];
    st.sagRatios.push(main.sag / (main.t1 - main.t0));
    st.cableLowM.push(cableAt(main, (main.t0 + main.t1) / 2));
    st.midDeckM.push(ribbonAt(l, ctx, (main.t0 + main.t1) / 2) ?? upper((main.t0 + main.t1) / 2));
    for (const sg of [-1, 1]) {
      lines.set(steel, 0.45);
      lines.line(cablePoints(l, sg * cs, group), sp.cableR, 6);
      for (const span of group) suspenders(lines, l, sg * cs, span, sp.suspenderM, (t) => topChord(t) + 0.3, 0.03, 0.25);
    }
  }
  // The Bay Lights: 25,000 white LEDs on the north-facing suspenders since
  // 2013. One per suspender pair here, at three heights, twinkling at night.
  lines.set(WHITE_LIGHT, 0.2, EMIT_LED);
  for (const group of spans) {
    const main = group[1];
    for (let t = main.t0 + 30; t < main.t1 - 15; t += sp.suspenderM * 2) {
      const top = cableAt(main, t);
      for (const f of [0.25, 0.55, 0.85]) {
        const y = topChord(t) + (top - topChord(t)) * f;
        if (top - topChord(t) > 3) lines.light(P(l, t, cs, y), 0.12);
      }
    }
  }

  // Double-deck truss over the whole suspended length.
  far.set(steel, 0.3);
  for (const sg of [-1, 1]) truss(far, near, l, sg * (cs - 1), truss0, truss1, upper, 0.4, depth, 9.0, [0.8, 1.0], 0.5);
  // The two roadway slabs.
  const halfW = cs - 1;
  deckSlab(far, near, l, truss0, truss1, upper, halfW, halfW, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.1, railH: 1.0, lampEvery: 60, lampH: 7 });
  const lower = (t: number): number => upper(t) - 9.5;
  deckSlab(far, near, l, truss0, truss1, lower, halfW, halfW, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.1, railH: 1.0 });

  // The centre anchorage: concrete, 67 m to the top, the deck passing over.
  {
    const w = worldAt(l, ca, 0);
    const g = ctx.groundAt(w.x, w.z);
    far.set(srgbHexToLinear("#A9A397"), 0.08);
    far.frameBox(l, ca, 0, (Math.min(g, 0) - 3 + upper(ca) - depth - 1) / 2, 30, 28, (upper(ca) - depth - 1 - Math.min(g, 0) + 3) / 2, "-y");
    far.frameBox(l, ca, 0, upper(ca) + 4, 9, cs + 2, 4);
  }
  // Anchorage piers at both ends.
  for (const ta of [-side, L + side]) {
    const w = worldAt(l, ta, 0);
    pier(far, l, ta, 0, ctx.groundAt(w.x, w.z), upper(ta) - depth - 1, 18, 24, srgbHexToLinear("#A9A397"));
  }
  viaducts(far, near, ctx.deck, ctx.groundAt, (x, z) => {
    const { t, s } = axisOf(l, x, z);
    return t > -side - 5 && t < L + side + 5 && Math.abs(s) < cs + 4;
  }, CONCRETE);
}

function sas(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder, lines: MeshBuilder, st: BridgeBuildStats): void {
  const sp = l.spec.p;
  const white = srgbHexToLinear(l.spec.colour);
  const L = l.lengthM;
  const deck = roadwayY(l, ctx);
  const tt = sp.towerT;
  const gap = sp.deckGapM;
  const dw = sp.deckWidthM;
  const outer = gap / 2 + dw;
  // Two orthotropic box girders either side of the tower, 5.5 m deep.
  for (const sg of [-1, 1]) {
    const c = sg * (gap / 2 + dw / 2);
    far.set(white, 0.35);
    for (let t = 0; t < L; t += 10) {
      const t1 = Math.min(L, t + 10);
      const ya = deck(t) - 0.15;
      const yb = deck(t1) - 0.15;
      const box = (yt: number, yb2: number, s0: number, s1: number): void => {
        far.quad(P(l, t, s0, yt), P(l, t1, s0, yb2), P(l, t1, s1, yb2), P(l, t, s1, yt), [0, 1, 0]);
      };
      box(ya, yb, c - dw / 2, c + dw / 2);
      // Sloped soffit: the girder is a trapezoid, 5.5 m deep at the middle.
      far.quad(P(l, t, c - dw / 2, ya), P(l, t1, c - dw / 2, yb), P(l, t1, c - dw / 2 + 3, yb - 5.5), P(l, t, c - dw / 2 + 3, ya - 5.5), [l.vx * -1, -0.5, l.vz * -1]);
      far.quad(P(l, t, c + dw / 2, ya), P(l, t1, c + dw / 2, yb), P(l, t1, c + dw / 2 - 3, yb - 5.5), P(l, t, c + dw / 2 - 3, ya - 5.5), [l.vx, -0.5, l.vz]);
      far.quad(P(l, t, c - dw / 2 + 3, ya - 5.5), P(l, t1, c - dw / 2 + 3, yb - 5.5), P(l, t1, c + dw / 2 - 3, yb - 5.5), P(l, t, c + dw / 2 - 3, ya - 5.5), [0, -1, 0]);
    }
    deckSlab(far, near, l, 0, L, deck, 0.01, 0, { rail: white, fascia: white, thick: 0.01, walkUp: 0, railH: 1.1, postEvery: 2.5 });
  }
  // Cross beams between the girders every 30 m.
  for (let t = 15; t < L; t += 30) far.frameBox(l, t, 0, deck(t) - 3, 1.2, gap / 2, 1.8);
  // The tower: four pentagonal legs (drawn as tapered boxes) joined by shear
  // links, 160 m, white.
  {
    const w = worldAt(l, tt, 0);
    st.towers.push({ x: w.x, z: w.z });
    const g = ctx.groundAt(w.x, w.z);
    pier(far, l, tt, 0, g, 6, 20, gap / 2 + 4, CONCRETE);
    far.set(white, 0.4);
    const n = 10;
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      for (let k = 0; k < n; k++) {
        const y0 = 6 + ((sp.towerTopM - 6) * k) / n;
        const y1 = 6 + ((sp.towerTopM - 6) * (k + 1)) / n;
        const f = (k + 0.5) / n;
        const off = 3.8 - 1.2 * f;
        far.frameBox(l, tt + a * off, b * off, (y0 + y1) / 2, 2.9 - 0.9 * f, 2.9 - 0.9 * f, (y1 - y0) / 2, k ? "-y" : "");
      }
    }
    for (let y = 30; y < sp.towerTopM - 5; y += 18) {
      far.frameBox(l, tt, 0, y, 0.8, 3.2, 1.0);
      far.frameBox(l, tt, 0, y + 9, 3.2, 0.8, 1.0);
    }
    st.towerTopsM.push(sp.towerTopM);
    far.frameBox(l, tt, 0, sp.towerTopM - 2, 3.5, 3.5, 2);
    far.set(RED_LIGHT, 0.2, EMIT_AVIATION);
    far.light(P(l, tt, 0, sp.towerTopM + 1), 0.6);
  }
  // The single cable, looped: up from the east end of the deck at its outer
  // edges, over the tower top, down the main span to the west end, round it
  // and back on the other side. Two inclined planes converging on the saddle.
  const top = sp.towerTopM - 3;
  const mainSpan: Span = { t0: tt, t1: L, y0: top, y1: deck(L) + 2, sag: (L - tt) / 9.5 };
  const backSpan: Span = { t0: 0, t1: tt, y0: deck(0) + 2, y1: top, sag: tt / 14 };
  st.sagRatios.push(mainSpan.sag / (L - tt));
  st.cableLowM.push(cableAt(mainSpan, (tt + L) / 2));
  st.midDeckM.push(deck((tt + L) / 2));
  for (const sg of [-1, 1]) {
    const pts: V3[] = [];
    for (const span of [backSpan, mainSpan]) {
      const n = 40;
      for (let k = pts.length ? 1 : 0; k <= n; k++) {
        const u = k / n;
        const t = span.t0 + (span.t1 - span.t0) * u;
        // The planes lean in: at the deck the cable is at the outer edge, at
        // the saddle it is a metre and a half off the axis.
        const y = cableAt(span, t);
        const lean = (y - deck(t)) / (top - deck(t) + 1e-3);
        const s = sg * (outer - 1 + (1.5 - (outer - 1)) * Math.max(0, Math.min(1, lean)));
        pts.push(P(l, t, s, y));
      }
    }
    lines.set(white, 0.5);
    lines.line(pts, sp.cableR, 6);
    // Suspenders from the cable down to the girder's outer edge, inclined.
    for (const span of [backSpan, mainSpan]) {
      for (let t = span.t0 + 10; t < span.t1 - 6; t += 10) {
        const y = cableAt(span, t);
        if (y - deck(t) < 2) continue;
        const lean = (y - deck(t)) / (top - deck(t) + 1e-3);
        const s = sg * (outer - 1 + (1.5 - (outer - 1)) * Math.max(0, Math.min(1, lean)));
        lines.set(white, 0.4);
        lines.line([P(l, t, s, y), P(l, t, sg * (outer - 0.5), deck(t) + 0.5)], 0.06, 4);
      }
    }
    lines.set(WHITE_LIGHT, 0.2, EMIT_LED);
    for (let k = 4; k < pts.length - 4; k += 4) lines.light(pts[k], 0.15);
  }
}

function skyway(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder): void {
  const sp = l.spec.p;
  const col = srgbHexToLinear(l.spec.colour);
  viaducts(far, near, ctx.deck, ctx.groundAt, () => false, col, { girder: sp.girderDepthM, pierEvery: sp.pierSpacingM });
}

/** A suspension bridge whose towers are steel portals (Manhattan) or lattice
 *  frames (Williamsburg), with four cables in two pairs and a deep truss. */
function steelSuspension(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder, lines: MeshBuilder, st: BridgeBuildStats, lattice: boolean): void {
  const sp = l.spec.p;
  const steel = srgbHexToLinear(l.spec.colour);
  const L = l.lengthM;
  const deck = roadwayY(l, ctx);
  const cs = sp.legHalfSpacingM;
  const side = sp.sideSpanM;
  const saddle = sp.towerTopM - 3;
  const depth = sp.trussDepthM;
  for (const tt of [0, L]) {
    const w = worldAt(l, tt, 0);
    st.towers.push({ x: w.x, z: w.z });
    const g = ctx.groundAt(w.x, w.z);
    pier(far, l, tt, 0, g, 10, 14, cs + 6, GRANITE);
    far.set(steel, 0.35);
    for (const sg of [-1, 1]) {
      if (lattice) {
        // Four posts per side frame, X-braced on every face.
        const posts: [number, number][] = [[-3, -2.5], [3, -2.5], [-3, 2.5], [3, 2.5]];
        for (const [dt, ds] of posts) far.beam(P(l, tt + dt * 1.6, sg * cs + ds * 1.4, 10), P(l, tt + dt, sg * cs + ds, sp.towerTopM), 1.1, 1.1);
        for (let y = 10; y < sp.towerTopM - 8; y += 9) {
          for (const ds of [-2.5, 2.5]) {
            near.set(steel, 0.35);
            near.beam(P(l, tt - 4, sg * cs + ds, y), P(l, tt + 4, sg * cs + ds, y + 9), 0.4, 0.4);
            near.beam(P(l, tt + 4, sg * cs + ds, y), P(l, tt - 4, sg * cs + ds, y + 9), 0.4, 0.4);
          }
          far.frameBox(l, tt, sg * cs, y, 4.5, 3.5, 0.35);
        }
      } else {
        // A tapered steel leg, 6 x 4 m at the base.
        const n = 6;
        for (let k = 0; k < n; k++) {
          const y0 = 10 + ((sp.towerTopM - 10) * k) / n;
          const y1 = 10 + ((sp.towerTopM - 10) * (k + 1)) / n;
          const f = (k + 0.5) / n;
          far.frameBox(l, tt, sg * cs, (y0 + y1) / 2, 3.2 - f, 2.2 - 0.5 * f, (y1 - y0) / 2, k ? "-y" : "");
        }
      }
      st.towerTopsM.push(sp.towerTopM);
      far.set(RED_LIGHT, 0.2, EMIT_AVIATION);
      far.light(P(l, tt, sg * cs, sp.towerTopM + 1), 0.5);
      far.set(steel, 0.35);
    }
    // Portal bracing: an arched head over the deck, cross struts below it.
    const yd = deck(tt);
    far.frameBox(l, tt, 0, sp.towerTopM - 2, 2.2, cs, 2);
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI;
      const a1 = ((k + 1) / 8) * Math.PI;
      if (k < 8) far.beam(P(l, tt, -cs * Math.cos(a), sp.towerTopM - 16 + 9 * Math.sin(a)), P(l, tt, -cs * Math.cos(a1), sp.towerTopM - 16 + 9 * Math.sin(a1)), 1.6, 1.4, [l.ux, 0, l.uz]);
    }
    far.frameBox(l, tt, 0, yd - depth - 2, 2, cs, 1.4);
    far.beam(P(l, tt, -cs, 14), P(l, tt, cs, yd - depth - 3), 1.2, 1.2, [l.ux, 0, l.uz]);
    far.beam(P(l, tt, cs, 14), P(l, tt, -cs, yd - depth - 3), 1.2, 1.2, [l.ux, 0, l.uz]);
  }
  // Four cables, in pairs 1.5 m apart, at the two tower legs.
  const mainSpan: Span = { t0: 0, t1: L, y0: saddle, y1: saddle, sag: sp.sagM };
  // Williamsburg's side spans are trusses on piers and its backstays run
  // straight; Manhattan's side spans hang.
  const sideSag = lattice ? 0 : side / 30;
  const s0: Span = { t0: -side, t1: 0, y0: deck(-side) + 3, y1: saddle, sag: sideSag };
  const s1: Span = { t0: L, t1: L + side, y0: saddle, y1: deck(L + side) + 3, sag: sideSag };
  st.sagRatios.push(sp.sagM / L);
  st.cableLowM.push(cableAt(mainSpan, L / 2));
  st.midDeckM.push(ribbonAt(l, ctx, L / 2) ?? deck(L / 2));
  for (const sg of [-1, 1]) for (const d of [-0.9, 0.9]) {
    const s = sg * cs + d;
    lines.set(steel, 0.45);
    lines.line(cablePoints(l, s, [s0, mainSpan, s1]), sp.cableR, 6);
  }
  for (const sg of [-1, 1]) {
    const spans = lattice ? [mainSpan] : [s0, mainSpan, s1];
    for (const span of spans) suspenders(lines, l, sg * cs, span, sp.suspenderM, (t) => deck(t) + 1, 0.04, 0.9);
  }
  // Deep stiffening truss, the full length, both decks inside it.
  far.set(steel, 0.3);
  for (const sg of [-1, 1]) truss(far, near, l, sg * (cs - 1), -side, L + side, (t) => deck(t) + (lattice ? 2.5 : 1.0), 0, depth, depth, [0.8, 1.0], 0.5);
  deckSlab(far, near, l, -side, L + side, deck, cs - 1, cs - 1, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.1, lampEvery: 50, lampH: 7 });
  if (l.spec.layerDy?.length) {
    const lower = (t: number): number => deck(t) + (l.spec.layerDy![0].dy);
    deckSlab(far, near, l, -side, L + side, lower, cs - 1, cs - 1, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.1 });
  }
  // Side-span piers.
  for (const ta of [-side, L + side]) {
    const w = worldAt(l, ta, 0);
    pier(far, l, ta, 0, ctx.groundAt(w.x, w.z), deck(ta) - depth, 14, cs + 2, GRANITE);
  }
  viaducts(far, near, ctx.deck, ctx.groundAt, (x, z) => {
    const { t, s } = axisOf(l, x, z);
    return t > -side - 5 && t < L + side + 5 && Math.abs(s) < cs + 4;
  }, CONCRETE);
}

function brooklyn(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder, lines: MeshBuilder, st: BridgeBuildStats): void {
  const sp = l.spec.p;
  const steel = srgbHexToLinear(l.spec.colour);
  const L = l.lengthM;
  const deck = roadwayY(l, ctx);
  const side = sp.sideSpanM;
  const halfW = sp.deckWidthM / 2;
  const tw = sp.towerWidthM / 2;
  const td = sp.towerDepthM / 2;
  const archHalf = sp.archWidthM / 2;
  // Cable planes: two outer at the deck edges, two inner either side of the
  // promenade.
  const cables = [-halfW + 0.5, -4.3, 4.3, halfW - 0.5];
  for (const tt of [0, L]) {
    const w = worldAt(l, tt, 0);
    st.towers.push({ x: w.x, z: w.z });
    far.set(GRANITE, 0.08);
    // Three granite piers, the two Gothic arches between them. The piers are
    // solid from the water to the cornice; the arches open from the deck up
    // to the pointed head at archTopM.
    const yd = deck(tt) - 3;
    const archTop = sp.archTopM;
    // Openings are centred at s = +/- (archHalf + 3.5).
    const oc = archHalf + 3.6;
    const solids: [number, number][] = [[-tw, -oc - archHalf], [-oc + archHalf, oc - archHalf], [oc + archHalf, tw]];
    for (const [s0, s1] of solids) far.frameBox(l, tt, (s0 + s1) / 2, (-3 + sp.towerTopM) / 2, td, (s1 - s0) / 2, (sp.towerTopM + 3) / 2, "-y");
    // Below the deck and above the arch heads the tower is solid across.
    far.frameBox(l, tt, 0, (-3 + yd) / 2, td, tw, (yd + 3) / 2, "-y");
    far.frameBox(l, tt, 0, (archTop + sp.towerTopM) / 2, td, tw, (sp.towerTopM - archTop) / 2, "-y");
    // The pointed arch heads: stepped corbels closing each opening.
    for (const sg of [-1, 1]) {
      const c = sg * oc;
      const steps = 6;
      const spring = archTop - archHalf * 1.6;
      for (let k = 0; k < steps; k++) {
        const y0 = spring + ((archTop - spring) * k) / steps;
        const y1 = spring + ((archTop - spring) * (k + 1)) / steps;
        const open = archHalf * Math.sqrt(1 - Math.pow((k + 1) / steps, 2));
        for (const sa of [-1, 1]) far.frameBox(l, tt, c + sa * (open + (archHalf - open) / 2), (y0 + y1) / 2, td, (archHalf - open) / 2 + 0.01, (y1 - y0) / 2);
      }
      // Recessed panel: the arch reveal, a little inset strip each side.
      far.frameBox(l, tt + td + 0.3, c - archHalf - 0.6, (yd + archTop) / 2, 0.3, 0.6, (archTop - yd) / 2);
      far.frameBox(l, tt + td + 0.3, c + archHalf + 0.6, (yd + archTop) / 2, 0.3, 0.6, (archTop - yd) / 2);
    }
    // The end faces, which are what a broadside view sees: two buttress
    // strips and a band at the deck, so 18 m of granite is not one flat card.
    for (const sg of [-1, 1]) {
      for (const sa of [-1, 1]) far.frameBox(l, tt + sa * (td - 1.6), sg * (tw + 0.35), (yd + sp.towerTopM) / 2 - 2, 1.4, 0.35, (sp.towerTopM - yd) / 2 - 2);
      far.frameBox(l, tt, sg * (tw + 0.25), yd + 1.5, td + 0.2, 0.25, 1.2);
    }
    // Cornice and the top course.
    far.frameBox(l, tt, 0, sp.towerTopM - 3, td + 0.8, tw + 0.8, 0.8);
    far.frameBox(l, tt, 0, sp.towerTopM - 0.6, td + 0.3, tw + 0.3, 0.6);
    st.towerTopsM.push(sp.towerTopM);
    far.set(RED_LIGHT, 0.2, EMIT_AVIATION);
    for (const sg of [-1, 1]) far.light(P(l, tt, sg * (tw - 1), sp.towerTopM + 0.8), 0.45);
  }
  // Anchorages, granite blocks the deck runs over.
  for (const ta of [-side, L + side]) {
    const w = worldAt(l, ta, 0);
    const g = ctx.groundAt(w.x, w.z);
    far.set(GRANITE, 0.08);
    far.frameBox(l, ta + Math.sign(ta) * 20, 0, (g - 2 + sp.anchorageTopM) / 2, 40, halfW + 5, (sp.anchorageTopM - g + 2) / 2, "-y");
  }
  const saddle = sp.towerTopM - 2;
  const mainSpan: Span = { t0: 0, t1: L, y0: saddle, y1: saddle, sag: sp.sagM };
  const s0: Span = { t0: -side, t1: 0, y0: sp.anchorageTopM - 1, y1: saddle, sag: side / 25 };
  const s1: Span = { t0: L, t1: L + side, y0: saddle, y1: sp.anchorageTopM - 1, sag: side / 25 };
  st.sagRatios.push(sp.sagM / L);
  st.cableLowM.push(cableAt(mainSpan, L / 2));
  st.midDeckM.push(ribbonAt(l, ctx, L / 2) ?? deck(L / 2));
  lines.set(steel, 0.4);
  for (const s of cables) {
    lines.line(cablePoints(l, s, [s0, mainSpan, s1]), sp.cableR, 6);
    // Vertical suspenders. The real ones are 1.5 m apart, which at any range
    // this is seen from is a texture rather than lines; every fourth reads as
    // the same web without the moire.
    for (const span of [s0, mainSpan, s1]) suspenders(lines, l, s, span, sp.suspenderM * 4, (t) => deck(t) + 0.5, 0.025);
    // The diagonal stays radiating from the tower tops, the web every
    // photograph of the bridge is about: out to about a third of each span.
    for (const tt of [0, L]) {
      for (const dir of [-1, 1]) {
        for (let k = 1; k <= 9; k++) {
          const t = tt + dir * k * sp.stayEveryM * 4;
          if (t < -side + 10 || t > L + side - 10) continue;
          lines.line([P(l, tt + dir * 2, s, saddle - 4), P(l, t, s, deck(t) + 0.6)], 0.035, 4);
        }
      }
    }
  }
  // Deck: roadways on a shallow truss, the promenade raised on the centre line.
  far.set(steel, 0.3);
  for (const s of cables) truss(far, near, l, s, -side, L + side, deck, 0.2, 5, 5, [0.4, 0.6], 0.25);
  deckSlab(far, near, l, -side, L + side, deck, halfW, halfW, { rail: steel, fascia: steel, thick: 0.5, walkUp: 0.1, lampEvery: 40, lampH: 6 });
  const prom = (t: number): number => deck(t) + 5.5;
  near.set(steel, 0.3);
  for (let t = -side; t < L + side; t += 9) {
    for (const s of [-4.3, 4.3]) near.beam(P(l, t, s, deck(t)), P(l, t, s, prom(t) - 0.3), 0.3, 0.3);
  }
  far.set(srgbHexToLinear("#8B6F4E"), 0.15);
  deckSlab(far, near, l, -side, L + side, prom, 4.6, 4.6, { rail: steel, fascia: steel, thick: 0.4, walkUp: 0, railH: 1.1, slab: srgbHexToLinear("#8B6F4E") });
  viaducts(far, near, ctx.deck, ctx.groundAt, (x, z) => {
    const { t, s } = axisOf(l, x, z);
    return t > -side - 5 && t < L + side + 5 && Math.abs(s) < halfW + 4;
  }, GRANITE);
}

function queensboro(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder, _lines: MeshBuilder, st: BridgeBuildStats): void {
  const sp = l.spec.p;
  const steel = srgbHexToLinear(l.spec.colour);
  const L = l.lengthM;
  const deck = roadwayY(l, ctx);
  const piers = [0, sp.pier1T, sp.pier2T, L];
  const half = sp.trussWidthM / 2;
  const arm = sp.armM;
  const t0 = -arm;
  const t1 = L + arm;
  // Truss top chord: rises to the pier towers, dips to ~14 m over the deck in
  // the middle of each span and at the shore ends.
  const bottom = (t: number): number => deck(t) - 10;
  const top = (t: number): number => {
    let d = Infinity;
    for (const p of piers) d = Math.min(d, Math.abs(t - p));
    const near = Math.max(0, 1 - d / 120);
    return deck(t) + 6 + (sp.pierTopM - 18 - deck(t) - 6) * near * near;
  };
  for (const p of piers) {
    const w = worldAt(l, p, 0);
    st.towers.push({ x: w.x, z: w.z });
    const g = ctx.groundAt(w.x, w.z);
    // Granite pier with its arched opening, up to the bottom chord.
    far.set(GRANITE, 0.08);
    for (const sg of [-1, 1]) far.frameBox(l, p, sg * (half - 3), (Math.min(g, 0) - 2 + bottom(p)) / 2, 9, 4, (bottom(p) - Math.min(g, 0) + 2) / 2, "-y");
    far.frameBox(l, p, 0, bottom(p) - 4, 9, half, 4);
    st.towerTopsM.push(sp.pierTopM);
    // The finials: steel pinnacles on top of each pier tower.
    far.set(steel, 0.35);
    for (const sg of [-1, 1]) {
      // A stepped steel spire, 3 m square at the chord tapering to a point.
      const y0 = top(p);
      for (let k = 0; k < 4; k++) {
        const ya = y0 + ((sp.pierTopM - y0) * k) / 4;
        const yb = y0 + ((sp.pierTopM - y0) * (k + 1)) / 4;
        const hw = 1.6 * (1 - k / 4) + 0.2;
        far.frameBox(l, p, sg * half, (ya + yb) / 2, hw, hw, (yb - ya) / 2, "-y");
      }
      far.set(RED_LIGHT, 0.2, EMIT_AVIATION);
      far.light(P(l, p, sg * half, sp.pierTopM + 0.6), 0.4);
      far.set(steel, 0.35);
    }
  }
  st.sagRatios.push(0);
  st.cableLowM.push(0);
  st.midDeckM.push(deck(sp.pier1T / 2));
  // The cantilever trusses: K-ish panels, verticals and diagonals, both
  // faces, the full length.
  far.set(steel, 0.3);
  near.set(steel, 0.3);
  const panel = 10;
  for (const sg of [-1, 1]) {
    const s = sg * half;
    for (let t = t0; t < t1; t += panel) {
      const ta = t;
      const tb = Math.min(t1, t + panel);
      far.beam(P(l, ta, s, top(ta)), P(l, tb, s, top(tb)), 0.9, 1.2);
      far.beam(P(l, ta, s, bottom(ta)), P(l, tb, s, bottom(tb)), 0.9, 1.2);
      far.beam(P(l, ta, s, bottom(ta)), P(l, ta, s, top(ta)), 0.6, 0.6);
      const k = Math.round((ta - t0) / panel);
      if (k % 2 === 0) far.beam(P(l, ta, s, bottom(ta)), P(l, tb, s, top(tb)), 0.5, 0.5);
      else far.beam(P(l, ta, s, top(ta)), P(l, tb, s, bottom(tb)), 0.5, 0.5);
      // Lattice in the tall panels near the piers.
      if (top(ta) - bottom(ta) > 30) {
        near.beam(P(l, ta, s, (top(ta) + bottom(ta)) / 2), P(l, tb, s, (top(tb) + bottom(tb)) / 2), 0.4, 0.4);
      }
    }
    // Two inner trusses as well: the bridge is four trusses wide.
    for (let t = t0; t < t1; t += panel) {
      near.beam(P(l, t, s * 0.35, bottom(t)), P(l, t + panel, s * 0.35, bottom(t + panel)), 0.7, 1.0);
      near.beam(P(l, t, s * 0.35, deck(t) + 6), P(l, t + panel, s * 0.35, deck(t + panel) + 6), 0.6, 0.6);
    }
  }
  // Top lateral bracing between the faces.
  for (let t = t0; t < t1; t += panel * 2) far.beam(P(l, t, -half, top(t)), P(l, t, half, top(t)), 0.5, 0.5, [l.ux, 0, l.uz]);
  deckSlab(far, near, l, t0, t1, deck, half - 1, half - 1, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.1, lampEvery: 45, lampH: 6 });
  const lower = (t: number): number => deck(t) - 8.5;
  deckSlab(far, near, l, t0, t1, lower, half - 1, half - 1, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.1 });
  viaducts(far, near, ctx.deck, ctx.groundAt, (x, z) => {
    const { t, s } = axisOf(l, x, z);
    return t > t0 - 5 && t < t1 + 5 && Math.abs(s) < half + 4;
  }, GRANITE);
}

/**
 * A Chicago trunnion bascule: two leaves meeting mid-river, the counterweight
 * pits in the banks, a girder fascia with the arched knee bracing every
 * photograph of the river shows, and bridge houses on the corners.
 */
function bascule(l: Landmark, ctx: BuildContext, far: MeshBuilder, near: MeshBuilder, st: BridgeBuildStats): void {
  const sp = l.spec.p;
  const steel = srgbHexToLinear(l.spec.colour);
  const half = sp.spanM / 2;
  const hw = sp.widthM / 2;
  const mid = l.lengthM / 2;
  const deckAt = (t: number): number => {
    const w = worldAt(l, t, 0);
    return ctx.deck.at(w.x, w.z, "upper") ?? ctx.groundAt(w.x, w.z) + 0.35;
  };
  const t0 = mid - half;
  const t1 = mid + half;
  const w = worldAt(l, mid, 0);
  st.towers.push({ x: w.x, z: w.z });
  st.towerTopsM.push(deckAt(mid));
  st.midDeckM.push(deckAt(mid));
  // Fascia girders, 2.4 m deep at mid-river growing to 5 m at the trunnions,
  // with the arched openings of the knee bracing.
  far.set(steel, 0.3);
  near.set(steel, 0.3);
  for (const sg of [-1, 1]) {
    const s = sg * hw;
    // The fascia deepens toward the trunnions, but never into the river: on
    // SRTM the Loop's streets stand barely a metre over the water it draws,
    // and a 5 m girder hung from that dams the river from bank to bank, which
    // also blanked the skyline's reflection in tools/verify-water.ts.
    const water = Math.min(ctx.groundAt(w.x, w.z), deckAt(mid) - 1.6);
    const depth = (t: number): number => Math.max(0.6, Math.min(2.4 + 2.6 * Math.pow(Math.abs(t - mid) / half, 2), deckAt(t) - water - 1.0));
    for (let t = t0; t < t1; t += 4) {
      const ta = t;
      const tb = Math.min(t1, t + 4);
      far.beam(P(l, ta, s, deckAt(ta) - 0.3), P(l, tb, s, deckAt(tb) - 0.3), 0.5, 0.9);
      far.beam(P(l, ta, s, deckAt(ta) - depth(ta)), P(l, tb, s, deckAt(tb) - depth(tb)), 0.5, 0.7);
      near.beam(P(l, ta, s, deckAt(ta) - depth(ta)), P(l, ta, s, deckAt(ta) - 0.3), 0.3, 0.3);
      // The knee arch: a short brace from the bottom chord up to mid-panel.
      far.beam(P(l, ta, s, deckAt(ta) - depth(ta) + 0.3), P(l, ta + 2, s, deckAt(ta) - 0.9), 0.35, 0.35);
      far.beam(P(l, tb, s, deckAt(tb) - depth(tb) + 0.3), P(l, ta + 2, s, deckAt(ta) - 0.9), 0.35, 0.35);
    }
    if (sp.upperTruss) {
      // Wells Street: the 'L' runs on an upper deck carried by a through truss.
      for (let t = t0; t < t1; t += 6) {
        far.beam(P(l, t, s, deckAt(t) + 8), P(l, t + 6, s, deckAt(t + 6) + 8), 0.5, 0.7);
        far.beam(P(l, t, s, deckAt(t)), P(l, t, s, deckAt(t) + 8), 0.35, 0.35);
        far.beam(P(l, t, s, deckAt(t)), P(l, t + 6, s, deckAt(t + 6) + 8), 0.3, 0.3);
      }
    }
  }
  deckSlab(far, near, l, t0, t1, deckAt, hw, hw - 3, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.15, railH: 1.1, postEvery: 0.9, lampEvery: 24, lampH: 6.5 });
  if (sp.doubleDeck) deckSlab(far, near, l, t0, t1, (t) => deckAt(t) - 6, hw, hw - 3, { rail: steel, fascia: steel, thick: 0.6, walkUp: 0.15 });
  // Bridge houses at the trunnions: limestone Beaux-Arts on the DuSable,
  // smaller tender houses elsewhere.
  const stone = srgbHexToLinear("#C8BFAE");
  const corners: [number, number][] = sp.houses >= 4
    ? [[t0, -1], [t0, 1], [t1, -1], [t1, 1]]
    : [[t0, -1], [t1, 1]];
  // The river, as the lowest ground under the span: a house stands on the
  // bank, so each one walks out from its trunnion until the ground is a metre
  // over that. Placed at a fixed 5 m past the trunnion instead, the tender
  // houses of the narrower crossings stood in the water and walled off the
  // far bank (the skyline reflection in tools/verify-water.ts fell from 0.20
  // to 0.14 over the Wabash crossing).
  let river = Infinity;
  for (let t = t0; t <= t1; t += 4) {
    const p = worldAt(l, t, 0);
    river = Math.min(river, ctx.groundAt(p.x, p.z));
  }
  for (const [t, sg] of corners) {
    const out = t < mid ? -1 : 1;
    let ta = t + out * 5;
    for (let k = 0; k < 15; k++) {
      const p = worldAt(l, ta, sg * (hw + 5));
      if (ctx.groundAt(p.x, p.z) >= river + 1) break;
      ta += out * 2;
    }
    ta += out * 4;
    const ww = worldAt(l, ta, sg * (hw + 5));
    const g = ctx.groundAt(ww.x, ww.z) - 6;
    const h = sp.houses >= 4 ? 16 : 7;
    const yd = deckAt(t);
    far.set(stone, 0.12);
    far.frameBox(l, ta, sg * (hw + 5), (g + yd + h) / 2, 5, 4, (yd + h - g) / 2, "-y");
    far.frameBox(l, ta, sg * (hw + 5), yd + h + 0.5, 5.6, 4.6, 0.5);
    if (sp.houses >= 4) far.frameBox(l, ta, sg * (hw + 5), yd + h + 3, 2, 2, 2);
  }
}

// ---------------------------------------------------------------------------

/** The near bucket is drawn inside this range of the bridge's bounds. */
export const NEAR_M = 2500;

export function buildBridgeMesh(l: Landmark, ctx: BuildContext): BridgeMesh {
  const far = new MeshBuilder();
  const near = new MeshBuilder();
  const lines = new MeshBuilder();
  const st: BridgeBuildStats = { towerTopsM: [], sagRatios: [], cableLowM: [], midDeckM: [], towers: [] };
  switch (l.spec.family) {
    case "goldengate": goldenGate(l, ctx, far, near, lines, st); break;
    case "baywest": bayWest(l, ctx, far, near, lines, st); break;
    case "sas": sas(l, ctx, far, near, lines, st); break;
    case "skyway": skyway(l, ctx, far, near); break;
    case "brooklyn": brooklyn(l, ctx, far, near, lines, st); break;
    case "manhattanbr": steelSuspension(l, ctx, far, near, lines, st, false); break;
    case "williamsburg": steelSuspension(l, ctx, far, near, lines, st, true); break;
    case "queensboro": queensboro(l, ctx, far, near, lines, st); break;
    case "bascule": bascule(l, ctx, far, near, st); break;
  }
  const f = far.finish();
  const n = near.finish();
  const li = lines.finish();
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const m of [f, n, li]) {
    for (let i = 0; i < m.position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (m.position[i + k] < min[k]) min[k] = m.position[i + k];
        if (m.position[i + k] > max[k]) max[k] = m.position[i + k];
      }
    }
  }
  return { far: f, near: n, lines: li, min, max, stats: st };
}

export type { LandmarkSpec };
void CABLE_GREY;
