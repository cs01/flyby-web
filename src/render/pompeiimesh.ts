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
import { KERB_M, pointInRing, ringArea, ringCentroid, villaFloorPoint } from "../data/pompeii";
import { ART_INDEX, ART_WORKS, ATRIUM_SCHEMES, GARDEN_SCHEMES } from "../data/pompeiiart";
import { ORDERS, Order, TOP_DIAMETER, lathe, mill, oven, tube, type Sink } from "./pompeiiorders";
import { faunStatue, forumStatue, placeTownStatues } from "./statues";
import { buildSuburbs, type SuburbStats } from "./pompeiisuburbs";
import type { LampSites } from "../data/pompeiilamps";
import { roofFailDepthM, roofTag } from "../sim/eruption";
import type { WaterSites } from "../data/pompeiiwater";
import { hasBathPlan } from "../data/pompeiibaths";
import { townDef } from "../data/towns";
import { buildHerculaneum, type HercStats } from "./herculaneummesh";
import { CeilingKind, FloorKind, arca, brazier, cartibulum, chest, lararium, lectus, loom, puteal, spout, tripodTable } from "./pompeiiinterior";

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
  /** A column shaft from render/pompeiiorders.ts: fluted in the shader. */
  Column = 15,
  /** A tile of the art atlas (data/pompeiiart.ts): p1 the tile, p2 bit 0 repeat along the wall, bit 1 indoors. */
  Art = 16,
  // 17 bronze (render/pompeiilamps.ts) and 20 baths (render/pompeiiwater.ts) are drawn by other builders.
  /**
   * Glass-paste wall mosaic (Herculaneum's Neptune and Amphitrite): drawn
   * in the shader from u, v on the panel (vWall.zw its size); p1 the design.
   */
  Mosaic = 21,
  /** Opus craticium: a timber frame with rubble and plaster between the posts and braces. */
  Craticium = 22,
  // 23 the townsfolk (render/pompeiifolk.ts).
  /** A ceiling (render/pompeiiinterior.ts ceilingPaint): wall.xy metres along it, p1 a CeilingKind. */
  Ceiling = 18,
  /** A room's floor (render/pompeiiinterior.ts floorPaint): wall.xy metres from its corner, zw its size, p1 a FloorKind. */
  Floor = 24,
}

export const ROOF_PITCH_DEG = 22;
const TAN_PITCH = Math.tan((ROOF_PITCH_DEG * Math.PI) / 180);
/** How far in from a wall or court a surveyed house's roof keeps rising. */
const ROOF_RANGE_M = 8;

export { KERB_M } from "../data/pompeii";

/**
 * A shop counter, metres from the facade line and the shop floor: the top a
 * metre up (the oil lamp stands on it, data/pompeiilamps.ts), the long arm
 * 0.6 m deep behind the sill, the short arm reaching back into the shop.
 */
export const COUNTER = { topM: 1.0, frontV: 0.15, backV: 0.75, returnV: 1.9 };
/** How far a street eave reaches past the wall, metres. */
export const EAVE_M = 0.5;

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
export class Store {
  n = 0;
  cap = 4096;
  pos = new Float32Array(this.cap * 3);
  nrm = new Int8Array(this.cap * 4);
  col = new Uint8Array(this.cap * 4);
  surf = new Uint8Array(this.cap * 4);
  wall = new Float32Array(this.cap * 4);
  idx: Uint32Array = new Uint32Array(8192);
  ni = 0;
  /**
   * Written to surf.w of every vertex emitted while set: the roof-failure byte
   * (sim/eruption.ts roofTag) of the building being built, 0 elsewhere. Only
   * tile and timber faces act on it in the shader, so walls stay standing.
   */
  tag = 0;

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
    this.surf[i * 4 + 3] = this.tag;
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

/** One building's roof, for the collapse (sim/eruption.ts roofFailDepthM). */
export interface RoofInfo {
  /** Centre of the footprint and the roof's top, world metres. */
  x: number; z: number; y: number;
  /** Clear span the beams carry, metres. */
  spanM: number;
  /** Depth of pumice that brings it down, metres; its vertices carry roofTag(failM). */
  failM: number;
  /** The footprint, x,z pairs: the escape asks whether you stand under it. */
  ring: number[];
}

/** A column standing in the town: the detailed order is drawn over its plain prism near the camera. */
export interface ColumnInstance {
  x: number; y0: number; z: number;
  /** Height to the top of the capital, metres. */
  h: number;
  /** Lower diameter, metres: h over the order's height in diameters. */
  d: number;
  order: Order;
  /** Lower third stuccoed red, as in the house peristyles. */
  red: boolean;
}

/** A room built inside a house: where to stand (x, z, floor y) and the point to look at. */
export interface InteriorView {
  kind: "atrium" | "fauces" | "tablinum" | "cubiculum" | "peristyle";
  house: string;
  /** Rule-built (no survey) or a surveyed house's. */
  surveyed: boolean;
  x: number; z: number; y: number;
  lookX: number; lookZ: number;
  /** Pieces of furniture and fittings it holds. */
  furniture: number;
}

/** A work of art as placed: which house took it and where it is. */
export interface ArtPlaced {
  id: string; house: string; x: number; y: number; z: number;
  /** Where to stand to see it, when that is not obvious (the shot poses use it). */
  view?: [number, number];
}

export interface PompeiiModel {
  /** Every column with its order, for the detailed near copies. */
  orders: ColumnInstance[];
  /** Named works placed in their houses (empty with art off). */
  art: ArtPlaced[];
  /** Rooms built inside the houses (full build), with a place to stand and where to look: the poses and the gate read them. */
  interiors: InteriorView[];
  /** Pedestals built empty for a statue (the garden statuary): top centre and the way the figure faces. */
  statueBases: { x: number; y: number; z: number; yaw: number; what: "garden" }[];
  /** What was modelled at the mapped sites. */
  sites: { mills: { x: number; z: number; site: string }[]; ovens: string[]; thermopolia: number; statues: string[]; shrines: number; stalls: number };
  /** The town: buildings, kerbs, landmarks, walls. Single-sided. */
  mesh: PompeiiMeshData;
  /** The open ground inside the walls, drawn with a depth bias over the terrain. */
  floor: PompeiiMeshData;
  /** The basalt carriageways, biased over the floor. */
  streets: PompeiiMeshData;
  solids: Solid[];
  lots: LotInfo[];
  /** Where the lamps can go: render/pompeiilamps.ts. */
  lampSites: LampSites;
  /** Every roof that can fall in under the pumice, with the depth that brings it down. */
  roofs: RoofInfo[];
  /** Fountains, impluvia and the planned baths, built by render/pompeiiwater.ts. */
  waterSites: WaterSites;
  /** Counts the gate reads. */
  stats: {
    lots: number; domus: number; tabernae: number; compluvia: number; fountains: number;
    steppingStones: number; columns: number; towers: number; roofTriangles: number; flatRoofs: number;
    plasterTriangles: number; buildMs: number;
    /** Metres of wall built round the unbuilt frontage (the plots). */
    plotWallM: number;
    /** Named houses built on their OSM outline with courts. */
    surveyedHouses: number;
    /** Upper floors with their timber (Herculaneum's; 0 in Pompeii). */
    timberFloors: number;
  };
  /** Surveyed houses given an upper storey, by name (Herculaneum's). */
  upperHouses: { name: string; storeys: number; craticium: boolean; y0: number; y1: number; x: number; z: number }[];
  /** The sea front, sheds, Sacred Area and villa (render/herculaneummesh.ts), null for Pompeii. */
  herc: HercStats | null;
  /** What was built outside the walls (render/pompeiisuburbs.ts), null for a pack without suburbs. */
  suburbs: SuburbStats | null;
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
  /** Probe: the kerb and floor faces as they were before the z-fight fix, for the gate's vacuity check. */
  probeCoplanar?: boolean;
  /** Probe: no plot walls along the unbuilt frontage, for the gate's vacuity check. */
  probeNoPlotWalls?: boolean;
  /** Probe: rule-built peristyles not held inside their block, for the gate's vacuity check. */
  probePorticoOut?: boolean;
  /** Probe: beams and slabs left open underneath, as before the undersides, for the gate's vacuity check. */
  probeOpenBeams?: boolean;
  /** The art atlas's paintings and mosaics (kill switch `?off=pompeiiart`); on unless false. */
  art?: boolean;
  /** The tomb streets, suburbs, river and harbour outside the walls; on unless false. */
  suburbs?: boolean;
}

/** A room built off a court: its middle, t along the court edge, i back out into the court, its size and floor. */
interface RoomFrame { cx: number; cz: number; tx: number; tz: number; ix: number; iz: number; w: number; depth: number; g: number }
/** A facade's frame: origin on its wall line, e along it, o out to the street. */
interface Frame { ax: number; az: number; ex: number; ez: number; ox: number; oz: number }
/** Faces of an fbox to leave out. */
const enum FB { Front = 1, Back = 2, End0 = 4, End1 = 8, Top = 16 }

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
  const town = townDef(data.town);
  const lean = !!opts.lean;
  const grey = !!opts.greyBoxes;
  const S = new Store();
  const F = new Store();
  const R = new Store();
  const solids: Solid[] = [];
  const lots: LotInfo[] = [];
  const lampSites: LampSites = { openings: [], courts: [] };
  const roofs: RoofInfo[] = [];
  /**
   * Tag everything the building emits from here with its roof's failure
   * byte. The caller clears the tag after the building, so an early return
   * cannot leak it onto whatever is built next.
   */
  const roofBegin = (ring: number[], y: number, spanM: number, seed: number): void => {
    if (grey) return;
    const failM = roofFailDepthM(spanM, hash(seed * 1e6, 97));
    const [x, z] = ringCentroid(ring);
    roofs.push({ x, z, y, spanM, failM, ring: [...ring] });
    S.tag = roofTag(failM);
  };
  const waterSites: WaterSites = { fountains: [], impluvia: [], baths: [] };
  /** Record an atrium pool for its rim; returns the town shader's p1, p2 for the sky in it. */
  function impluvium(pool: V3[], cx: number, cz: number, floor: number, openY: number, openR: number): [number, number] {
    const water = pool[0][1];
    waterSites.impluvia.push({ ring: pool.flatMap((p) => [p[0], p[2]]), water, floor, open: { cx, cz, y: openY, r: openR } });
    return [Math.min(255, Math.max(1, Math.round((openY - water) * 10))), Math.min(255, Math.round(openR * 10))];
  }
  const stats = {
    lots: 0, domus: 0, tabernae: 0, compluvia: 0, fountains: 0, steppingStones: 0, columns: 0,
    towers: 0, roofTriangles: 0, flatRoofs: 0, plasterTriangles: 0, buildMs: 0, surveyedHouses: 0, timberFloors: 0, plotWallM: 0,
  };
  const upperHouses: PompeiiModel["upperHouses"] = [];
  const art = opts.art !== false && !grey;
  const orders: ColumnInstance[] = [];
  const artPlaced: ArtPlaced[] = [];
  const interiors: InteriorView[] = [];
  const statueBases: PompeiiModel["statueBases"] = [];
  const siteInfo: PompeiiModel["sites"] = { mills: [], ovens: [], thermopolia: 0, statues: [], shrines: 0, stalls: 0 };
  /** Shop counters, emitted at the end so the mapped thermopolia can claim theirs. */
  const counters: { F: Frame; u0: number; w: number; g: number; seed: number }[] = [];
  const sitesOf = (kind: "bakery" | "thermopolium" | "artwork"): { name: string; x: number; z: number }[] => (data.sites ?? []).filter((s) => s.kind === kind);

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
   * A room's floor or ceiling over the quad pts, carrying metres from its
   * first corner along its first side and across it, and its size, so the
   * shader can lay a border and a pattern square to the walls.
   */
  function roomQuad(pts: V3[], facing: V3, c: RGB, seed: number, s: Surf, p1: number, p2 = 0): void {
    const [a, b] = pts;
    let ex = b[0] - a[0], ez = b[2] - a[2];
    const L = Math.hypot(ex, ez) || 1;
    ex /= L; ez /= L;
    const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length, cz = pts.reduce((t, p) => t + p[2], 0) / pts.length;
    let wx = -ez, wz = ex;
    if ((cx - a[0]) * wx + (cz - a[2]) * wz < 0) { wx = -wx; wz = -wz; }
    const uv = pts.map((p) => [(p[0] - a[0]) * ex + (p[2] - a[2]) * ez, (p[0] - a[0]) * wx + (p[2] - a[2]) * wz]);
    const u0 = Math.min(...uv.map((q) => q[0])), v0 = Math.min(...uv.map((q) => q[1]));
    const W = Math.max(...uv.map((q) => q[0])) - u0, D = Math.max(...uv.map((q) => q[1])) - v0;
    poly(S, pts, facing, c, seed, s, p1, p2, uv.map((q): [number, number, number, number] => [q[0] - u0, q[1] - v0, W, D]));
  }

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
  /**
   * `bottom` closes the underside: by default whenever the box stands clear
   * of the ground (a beam, a lintel, a balcony floor), since from below an
   * open one is a hollow shell.
   */
  function box(q: number[], y0: number, y1: number, c: RGB, seed: number, s: Surf, top: Surf = s, topC: RGB = c, bottom?: boolean): void {
    const n = q.length / 2;
    const [cx, cz] = ringCentroid(q);
    if (!opts.probeOpenBeams && (bottom ?? y0 > ground(cx, cz) + 1.8)) {

      const under: V3[] = [];
      for (let i = 0; i < n; i++) under.push([q[i * 2], y0, q[i * 2 + 1]]);
      poly(S, under, [0, -1, 0], c, seed, s, 0, 0, under.map((p) => [p[0], p[2], 0, 0]));
    }
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
  function column(x: number, z: number, y0: number, h: number, r: number, c: RGB, seed: number, sides = 8, red = false, order?: Order): void {
    // With an order the diameter follows from the height (Vitruvius's
    // proportions, pompeiiorders.ts): the prism here is the far view, a hair
    // inside the detailed column's shaft so the near copy hides it entirely.
    let rTop = r;
    if (order !== undefined) {
      const d = h / ORDERS[order].height;
      orders.push({ x, y0, z, h, d, order, red });
      r = d * 0.5 * 0.93;
      rTop = r * TOP_DIAMETER;
    }
    stats.columns++;
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      poly(S, [[x + c0 * r, y0, z + s0 * r], [x + c1 * r, y0, z + s1 * r], [x + c1 * rTop, y0 + h, z + s1 * rTop], [x + c0 * rTop, y0 + h, z + s0 * rTop]],
        [Math.cos(am), 0, Math.sin(am)], c, seed, Surf.Stucco, red ? 1 : 0, 0, [[0, 0, 0, h], [0, 0, 0, h], [0, h, 0, h], [0, h, 0, h]]);
    }
  }
  /** One atlas tile on a quad: corners top-left, top-right, bottom-right, bottom-left as seen. */
  function artQuad(pts: V3[], facing: V3, tile: number, indoors: boolean): void {
    poly(S, pts, facing, ART_WORKS[tile].ground, 0.5, Surf.Art, tile, indoors ? 2 : 0, [[0, 0, 0, 0], [1, 0, 0, 0], [1, 1, 0, 0], [0, 1, 0, 0]]);
  }
  /** A peristyle's order: Doric or Ionic, by the house. */
  const houseOrder = (seed: number): Order => (hash(seed * 1e6, 23) < 0.6 ? Order.Doric : Order.Ionic);

  // --- street furniture: things built square to a facade -------------------------------
  /** u runs along the facade from its origin, v out to the street (negative is indoors). */
  const fp = (F: Frame, u: number, v: number, y: number): V3 => [F.ax + F.ex * u + F.ox * v, y, F.az + F.ez * u + F.oz * v];
  /**
   * A box square to a facade, u0..u1 along it, v0..v1 out from it, y0..y1.
   * Each side face carries its own metres (u along it, h over `gref`), so the
   * plank, marble and plaster patterns sit on the box rather than on the
   * facade's coordinates. `flatU` holds u fixed: wood grain along a beam
   * instead of boards across it.
   */
  function fbox(F: Frame, u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, c: RGB, seed: number, s: Surf,
    o: { p1?: number; p2?: number; skip?: number; gref?: number; topS?: Surf; topC?: RGB; front?: [Surf, number, number, RGB]; bottom?: boolean; flatU?: boolean } = {}): void {
    const skip = o.skip ?? 0, gr = o.gref ?? y0, p1 = o.p1 ?? 0, p2 = o.p2 ?? 0;
    const h0 = y0 - gr, H = y1 - gr;
    const side = (ua: number, va: number, ub: number, vb: number, facing: V3, len: number, fs: Surf, f1: number, f2: number, fc: RGB): void => {
      const U0 = o.flatU ? 0.1 : 0, U1 = o.flatU ? 0.1 : len;
      poly(S, [fp(F, ua, va, y0), fp(F, ub, vb, y0), fp(F, ub, vb, y1), fp(F, ua, va, y1)], facing, fc, seed, fs, f1, f2,
        [[U0, h0, len, H], [U1, h0, len, H], [U1, H, len, H], [U0, H, len, H]]);
    };
    const fr = o.front ?? [s, p1, p2, c];
    if (!(skip & FB.Front)) side(u0, v1, u1, v1, [F.ox, 0, F.oz], u1 - u0, fr[0], fr[1], fr[2], fr[3]);
    if (!(skip & FB.Back)) side(u1, v0, u0, v0, [-F.ox, 0, -F.oz], u1 - u0, s, p1, p2, c);
    if (!(skip & FB.End0)) side(u0, v0, u0, v1, [-F.ex, 0, -F.ez], v1 - v0, s, p1, p2, c);
    if (!(skip & FB.End1)) side(u1, v1, u1, v0, [F.ex, 0, F.ez], v1 - v0, s, p1, p2, c);
    const flat = (y: number, up: number, fs: Surf, fc: RGB): void => {
      const pts = [fp(F, u0, v0, y), fp(F, u1, v0, y), fp(F, u1, v1, y), fp(F, u0, v1, y)];
      poly(S, pts, [0, up, 0], fc, seed, fs, 0, 0, pts.map((p): [number, number, number, number] => [p[0], p[2], 0, 0]));
    };
    if (!(skip & FB.Top)) flat(y1, 1, o.topS ?? s, o.topC ?? c);
    if (o.bottom) flat(y0, -1, s, c);
  }
  /**
   * The town store seen through a tilt: whatever is drawn into it about c
   * has its top leaned `ang` radians toward (dx, dz). For amphorae, which
   * have pointed toes and were stood leaning on a wall.
   */
  function leaning(c: V3, dx: number, dz: number, ang: number): Sink {
    const cs = Math.cos(ang), sn = Math.sin(ang);
    // Rodrigues about k = up x dir = (dz, 0, -dx), which turns up toward dir.
    const kx = dz, kz = -dx;
    const rot = (x: number, y: number, z: number): V3 => {
      const d = kx * x + kz * z;
      const cx = -kz * y, cy = kz * x - kx * z, cz = kx * y;
      return [x * cs + cx * sn + kx * d * (1 - cs), y * cs + cy * sn, z * cs + cz * sn + kz * d * (1 - cs)];
    };
    return {
      get n() { return S.n; },
      vert: (p, n, col, seed, s, p1, p2, w) => {
        const q = rot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
        return S.vert([q[0] + c[0], q[1] + c[1], q[2] + c[2]], rot(n[0], n[1], n[2]), col, seed, s, p1, p2, w);
      },
      tri: (a, b, d) => S.tri(a, b, d),
    };
  }
  const TERRACOTTA: RGB[] = [[0.66, 0.38, 0.24], [0.72, 0.5, 0.34], [0.58, 0.32, 0.22], [0.76, 0.58, 0.42]];
  /** A transport amphora, a metre tall at scale 1: toe, belly, shoulder, neck. */
  function amphora(st: Sink, x: number, y: number, z: number, scale: number, seed: number): void {
    const prof: [number, number][] = [[0.015, 0], [0.14, 0.36], [0.055, 0.74], [0.05, 0.95]];
    lathe(st, x, y, z, prof.map(([r, h]): [number, number] => [r * scale, h * scale]), 5, TERRACOTTA[Math.floor(seed * 4) % 4], seed, Surf.Pavement);
  }
  /** A small storage jar for a shelf. */
  function jar(x: number, y: number, z: number, scale: number, seed: number): void {
    lathe(S, x, y, z, [[0.05 * scale, 0], [0.1 * scale, 0.11 * scale], [0.035 * scale, 0.24 * scale]], 5, TERRACOTTA[Math.floor(seed * 4) % 4], seed, Surf.Pavement);
  }
  /** A wicker basket heaped with produce. */
  function basket(x: number, y: number, z: number, seed: number): void {
    lathe(S, x, y, z, [[0.16, 0], [0.21, 0.27], [0.2, 0.29]], 7, [0.62, 0.5, 0.3], seed, Surf.Wood, 1);
    const fill: RGB[] = [[0.55, 0.42, 0.16], [0.36, 0.42, 0.14], [0.5, 0.16, 0.1], [0.62, 0.52, 0.3]];
    lathe(S, x, y, z, [[0.2, 0.25], [0.12, 0.31], [0.001, 0.33]], 7, fill[Math.floor(seed * 4) % 4], seed, Surf.Garden);
  }
  /** An insula's ground slab under a point, for floors that must sit on it. */
  const insBounds = data.insulae.map((ins) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < ins.ring.length; i += 2) {
      x0 = Math.min(x0, ins.ring[i]); x1 = Math.max(x1, ins.ring[i]); z0 = Math.min(z0, ins.ring[i + 1]); z1 = Math.max(z1, ins.ring[i + 1]);
    }
    return [x0, x1, z0, z1];
  });
  function insAt(x: number, z: number): PompeiiInsula | undefined {
    for (let k = 0; k < data.insulae.length; k++) {
      const b = insBounds[k];
      if (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3] && pointInRing(data.insulae[k].ring, x, z)) return data.insulae[k];
    }
    return undefined;
  }
  /**
   * Width of the pavement in front of a facade point, out along (ox, oz) to
   * the kerb; 0 off any block. The walkers (data/pompeiilife.ts) keep to its
   * middle, so anything stood on it has to leave them that line.
   */
  function pavementAt(x: number, z: number, ox: number, oz: number): number {
    const ins = insAt(x - ox * 0.3, z - oz * 0.3);
    if (!ins) return 0;
    const d = rayToRing(ins.kerb, x + ox * 0.01, z + oz * 0.01, ox, oz);
    return Number.isFinite(d) ? d : 0;
  }
  /** Pavement wide enough for a bench, stock or a stall without blocking the walkers' line. */
  const WIDE_PAVEMENT_M = 1.8;
  /**
   * Whether a point keeps `r` metres off every walkers' line: the middle of
   * each pavement as data/pompeiilife.ts lays it, offset from the street's
   * centreline, which is not always where the kerb puts the middle.
   */
  function walkClear(x: number, z: number, r: number): boolean {
    for (const s of data.streets) {
      const off = s.carriageM / 2 + s.sidewalkM / 2;
      if (Math.abs(distToPolyline(s.pts, x, z) - off) < r) return false;
    }
    return true;
  }
  const clearAt = (F: Frame, pts: [number, number][], r = 0.3): boolean => pts.every(([u, v]) => { const p = fp(F, u, v, 0); return walkClear(p[0], p[2], r); });
  /**
   * A recess floor clear of the block's ground slab: the slab is drawn over
   * the whole insula a step above the pavement, and a floor at the
   * pavement's level was buried under it (the green garden showing in every
   * shop).
   */
  function floorOver(g: number, pts: [number, number][]): number {
    const [mx, mz] = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
    const ins = insAt(mx, mz);
    let y = g;
    // 3 cm over the slab: 1 cm was inside a phone's depth precision at street range.
    // Over the whole quad, not its corners: the slab bends across its own
    // triangles, and a floor level with the corners dipped under it between.
    if (ins && pts.length === 4) for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) {
      const s = i / 4, t = j / 2;
      const x = lerp(lerp(pts[0][0], pts[1][0], s), lerp(pts[3][0], pts[2][0], s), t), z = lerp(lerp(pts[0][1], pts[1][1], s), lerp(pts[3][1], pts[2][1], s), t);
      y = Math.max(y, slabTop(ins, x, z) + (opts.probeCoplanar ? 0.01 : 0.03));
    }
    return y;
  }

  const ground = (x: number, z: number): number => groundAt(x, z);

  // =====================================================================================
  // Streets: the carriageway floor across the whole walled town, and the
  // kerbed pavements as the raised outline of each insula.
  // =====================================================================================
  const wallRing = data.wall;
  // A town without an amphitheatre gets one far off the map, so every test
  // against its ellipse is simply false.
  const amph = data.amphitheatre ?? { cx: 1e7, cz: 1e7, a: 1, b: 1, rot: 0 };
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
      // A hand over the block slabs it laps onto at the edges: at 5 cm it sat 1 cm under their 6.
      pid[k] = F.vert([x, ground(x, z) + KERB_M + (opts.probeCoplanar ? 0.05 : 0.1), z], [0, 1, 0], [0.86, 0.83, 0.75], hash(i, j, 5), Surf.Marble, 0, 0, [x, z, 0, 0]);
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
  /**
   * Height of an insula's ground slab (below) at a point: the slab is one
   * triangulated polygon with the terrain's heights at its corners only, so
   * inside a long block on a slope it runs up to a metre over the terrain.
   * A house's floors are lifted clear of it or they are buried under it.
   */
  const slabTris = new Map<PompeiiInsula, number[]>();
  function slabTop(ins: PompeiiInsula, x: number, z: number): number {
    const r = ins.ring;
    let tri = slabTris.get(ins);
    if (!tri) { tri = triangulateRing(new Float32Array(r)); slabTris.set(ins, tri); }
    for (let k = 0; k < tri.length; k += 3) {
      const a = tri[k], b = tri[k + 1], c = tri[k + 2];
      const ax = r[a * 2], az = r[a * 2 + 1], bx = r[b * 2], bz = r[b * 2 + 1], cx = r[c * 2], cz = r[c * 2 + 1];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, wc = 1 - wa - wb;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      return wa * ground(ax, az) + wb * ground(bx, bz) + wc * ground(cx, cz) + KERB_M + 0.06;
    }
    return ground(x, z) + KERB_M + 0.06;
  }
  const kerbFaces: { ax: number; az: number; bx: number; bz: number; ox: number; oz: number; ga: number; gb: number; L: number; lift: number; sideC: RGB; seed: number; side: Surf }[] = [];
  function slab(r: Ring, lift: number, side: Surf, sideC: RGB, top: Surf, topC: RGB, seed: number, kerb?: Ring, block?: boolean, topP1 = 0): void {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      // Interior is left of a positive-area ring; out is the right normal.
      const ox = (bz - az) / L, oz = -(bx - ax) / L;
      const ga = ground(ax, az), gb = ground(bx, bz);
      // The block's step: two coplanar faces of different colour fight for
      // every pixel on a phone's depth buffer, and it had two such partners,
      // the kerb's own face where the block runs on the kerb line and every
      // house front, which stands on the same line from below the ground.
      // So it rises only from the kerb top (below that the kerb hides it)
      // and stands 3 cm proud of the line, a plinth at the walls' foot.
      if (kerb && !opts.probeCoplanar) {
        const e = 0.03;
        wall(ax + ox * e, az + oz * e, bx + ox * e, bz + oz * e, ga + KERB_M - 0.02, gb + KERB_M - 0.02, ga + lift, gb + lift, ox, oz, sideC, seed, side, 0, 0, 0, L, ga, lift);
        continue;
      }
      // A kerb face is drawn once the houses stand (kerbFaces below): where
      // one stands on the kerb line its front comes down past the kerb top
      // and the two must not share the plane.
      if (block && !opts.probeCoplanar) { kerbFaces.push({ ax, az, bx, bz, ox, oz, ga, gb, L, lift, sideC, seed, side }); continue; }
      wall(ax, az, bx, bz, ga - 0.3, gb - 0.3, ga + lift, gb + lift, ox, oz, sideC, seed, side, 0, 0, 0, L, ga, lift);
    }
    const f = new Float32Array(r);
    const tri = triangulateRing(f);
    const base = S.n;
    for (let i = 0; i < n; i++) {
      const x = r[i * 2], z = r[i * 2 + 1];
      S.vert([x, ground(x, z) + lift, z], [0, 1, 0], grey ? GREY : topC, seed, grey ? Surf.Stucco : top, topP1, 0, [x, z, 0, 0]);
    }
    for (let k = 0; k < tri.length; k += 3) S.tri(base + tri[k], base + tri[k + 2], base + tri[k + 1]);
  }

  for (let ii = 0; ii < data.insulae.length; ii++) {
    const ins = data.insulae[ii];
    slab(ins.kerb, KERB_M, Surf.Kerb, [0.62, 0.6, 0.55], Surf.Pavement, [0.43, 0.35, 0.26], hash(ii, 7), undefined, true);
    // The block's own ground, a step up from the pavement: the garden and the
    // peristyles wherever the lots leave it open.
    slab(ins.ring, KERB_M + 0.06, Surf.Kerb, [0.55, 0.5, 0.44], Surf.Garden, [0.3, 0.38, 0.17], hash(ii, 8), ins.kerb, false, 255);
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
    // The basin, spout stone and water are render/pompeiiwater.ts's.
    waterSites.fountains.push({ x: fx, z: fz, g: ground(fx, fz), ang });
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
  interface House { name: string; kind: "domus" | "villa" | "bakery"; ring: Ring; courts: Ring[]; surveyed: boolean; x0: number; x1: number; z0: number; z1: number; seed: number }
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
    houses.push({ name: d.name, kind: "domus", ring, courts, surveyed: courts.length > 0, x0, x1, z0, z1, seed: hash(di, 991) });
  }
  // The mapped bakeries: a yard 11 m along the street and 12 m deep at each,
  // turned to the nearest frontage, that the rule-built lots give way to.
  // One inside a surveyed house is that house's business and is skipped.
  for (const [bi, b] of sitesOf("bakery").entries()) {
    const ins = data.insulae.find((i) => pointInRing(i.ring, b.x, b.z));
    if (!ins || ins.garden || houses.some((h) => pointInRing(h.ring, b.x, b.z)) || publicRings.some((pr) => pointInRing(pr, b.x, b.z))) continue;
    const [fx, fz] = nearestOnRing(ins.ring, b.x, b.z);
    let vx = b.x - fx, vz = b.z - fz;
    const vl = Math.hypot(vx, vz);
    if (vl < 1e-3) continue;
    vx /= vl; vz /= vl;
    const ux = -vz, uz = vx;
    const P = (u: number, v: number): number[] => [fx + ux * u + vx * v, fz + uz * u + vz * v];
    const ring = [...P(-5.5, 0), ...P(5.5, 0), ...P(5.5, 12), ...P(-5.5, 12)];
    // Kept in front-left, front-right, back-right, back-left order whatever its winding: buildBakery reads the front off it.
    if ([0, 2, 4, 6].some((k) => !pointInRing(ins.ring, ring[k] + (b.x - ring[k]) * 0.05, ring[k + 1] + (b.z - ring[k + 1]) * 0.05))) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < 8; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
    houses.push({ name: b.name, kind: "bakery", ring, courts: [], surveyed: false, x0, x1, z0, z1, seed: hash(bi, 4441) });
  }
  if (data.villa) {
    const ring = cleanRing(data.villa.ring);
    if (ring) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
      // Room 5 is built round the park's marker for the frieze: a court the
      // survey found over that spot would put a garden through the room.
      const m5 = sitesOf("artwork").find((s) => /misteri/i.test(s.name));
      const courts = (data.villa.courts ?? []).filter((c) => [0, 2, 4, 6].every((k) => pointInRing(ring, c[k], c[k + 1]))
        && !(m5 && (pointInRing(c, m5.x, m5.z) || distToRing(c, m5.x, m5.z) < 5)));
      houses.push({ name: data.villa.name, kind: "villa", ring, courts, surveyed: true, x0, x1, z0, z1, seed: 0.37 });
    }
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
  for (const h of houses) {
    if (h.kind === "bakery") buildBakery(h); else buildHouse(h);
    S.tag = 0;
  }

  /**
   * A peristyle's garden as geometry over gardenPaint's plan (the full
   * build's): clipped box round the four beds, shrubs and a small tree or two
   * in them, a basin where the paths cross, and in a rich house statues on
   * pedestals at the paths' ends and oscilla (marble discs) hung between the
   * columns. c the court (4 corners), walk the colonnade's depth, colH its
   * columns' height.
   */
  function peristyleGarden(c: Ring, fl: (x: number, z: number) => number, seed: number, rich: boolean, walk: number, colH: number): void {
    const [ax, az] = [c[0], c[1]];
    let ex = c[2] - ax, ez = c[3] - az;
    const W = Math.hypot(ex, ez) || 1;
    ex /= W; ez /= W;
    const [cx0, cz0] = ringCentroid(c);
    let nx = -ez, nz = ex;
    if ((cx0 - ax) * nx + (cz0 - az) * nz < 0) { nx = -nx; nz = -nz; }
    const D = Math.abs((c[6] - ax) * nx + (c[7] - az) * nz);
    const P = (u: number, v: number): [number, number] => [ax + ex * u + nx * v, az + ez * u + nz * v];
    const F: Frame = { ax, az, ex, ez, ox: nx, oz: nz };
    const r = (k: number): number => hash(seed * 1e6, 300 + k);
    const box: RGB = [0.11, 0.2, 0.07], leaf: RGB = [0.16, 0.26, 0.1], bark: RGB = [0.3, 0.22, 0.15];
    const lo = walk + 0.7;
    const beds: [number, number, number, number][] = [];
    for (const [u0, u1] of [[lo, W / 2 - 0.45], [W / 2 + 0.45, W - lo]]) for (const [v0, v1] of [[lo, D / 2 - 0.45], [D / 2 + 0.45, D - lo]]) if (u1 - u0 > 1 && v1 - v0 > 1) beds.push([u0, u1, v0, v1]);
    let k = 0;
    for (const [u0, u1, v0, v1] of beds) {
      const [mx, mz] = P((u0 + u1) / 2, (v0 + v1) / 2);
      const y = fl(mx, mz) + 0.02;
      // The box hedge round the bed, knee high, as one ring of four pieces.
      const hb = 0.4, t = 0.22;
      fbox(F, u0, u1, v0, v0 + t, y, y + hb, box, seed, Surf.Sand, { skip: FB.End0 | FB.End1 });
      fbox(F, u0, u1, v1 - t, v1, y, y + hb, box, seed, Surf.Sand, { skip: FB.End0 | FB.End1 });
      fbox(F, u0, u0 + t, v0 + t, v1 - t, y, y + hb, box, seed, Surf.Sand, { skip: FB.Front | FB.Back });
      fbox(F, u1 - t, u1, v0 + t, v1 - t, y, y + hb, box, seed, Surf.Sand, { skip: FB.Front | FB.Back });
      // Shrubs, and in one bed a small tree (a bay, a lemon, a plane in a big garden).
      const n = Math.min(3, Math.floor(((u1 - u0) * (v1 - v0)) / 3));
      for (let i = 0; i < n; i++) {
        const [sx, sz] = P(u0 + 0.6 + (u1 - u0 - 1.2) * r(k * 7 + i), v0 + 0.6 + (v1 - v0 - 1.2) * r(k * 7 + i + 3));
        const s = 0.35 + 0.3 * r(k * 7 + i + 5);
        lathe(S, sx, y, sz, [[0.01, 0], [s, s * 0.6], [s * 0.85, s * 1.4], [0.01, s * 1.7]], 6, leaf, seed, Surf.Sand);
      }
      if (k === Math.floor(r(90) * beds.length) && (u1 - u0) > 2 && (v1 - v0) > 2) {
        const [tx, tz] = P((u0 + u1) / 2, (v0 + v1) / 2);
        tube(S, [tx, y, tz], [tx, y + 1.6, tz], 0.09, 0.07, 4, bark, seed, Surf.Wood);
        lathe(S, tx, y + 1.3, tz, [[0.01, 0], [1.0, 0.5], [1.15, 1.2], [0.7, 2.0], [0.01, 2.3]], 7, leaf, seed, Surf.Sand);
      }
      k++;
    }
    // The basin where the paths cross.
    if (beds.length === 4 && r(91) < 0.7) {
      const [mx, mz] = P(W / 2, D / 2);
      const y = fl(mx, mz) + 0.25;
      const hw = Math.min(1.1, W * 0.08), hd = Math.min(0.8, D * 0.08);
      const pool = [P(W / 2 - hw, D / 2 - hd), P(W / 2 + hw, D / 2 - hd), P(W / 2 + hw, D / 2 + hd), P(W / 2 - hw, D / 2 + hd)].map((p): V3 => [p[0], y, p[1]]);
      const op = impluvium(pool, mx, mz, y - 0.25, y + 40, 25);
      poly(S, pool, [0, 1, 0], [0.2, 0.32, 0.34], seed, Surf.Water, op[0], op[1], pool.map((p) => [p[0], p[2], mx, mz]));
    }
    if (!rich) return;
    // Pedestals at the ends of the cross path, for the statues (statueBases).
    for (const [u, v] of [[W / 2, lo - 0.3], [W / 2, D - lo + 0.3]]) {
      const [sx, sz] = P(u, v);
      const y = fl(sx, sz);
      fbox({ ...F, ax: sx, az: sz }, -0.22, 0.22, -0.22, 0.22, y, y + 0.9, [0.86, 0.84, 0.78], seed, Surf.Marble);
      // The statue on it is drawn by the statue builder from this list.
      statueBases.push({ x: sx, y: y + 0.9, z: sz, yaw: Math.atan2(nx, nz) + (v > D / 2 ? Math.PI : 0), what: "garden" });
    }
    // Oscilla: marble discs on a cord between the columns, two to a side.
    for (let e = 0; e < 4; e++) {
      const x0 = c[e * 2], z0 = c[e * 2 + 1], x1 = c[((e + 1) % 4) * 2], z1 = c[((e + 1) % 4) * 2 + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      let ix = cx0 - (x0 + x1) / 2, iz = cz0 - (z0 + z1) / 2;
      const il = Math.hypot(ix, iz) || 1;
      ix /= il; iz /= il;
      const m = Math.max(1, Math.round((L - 4) / 3));
      for (const q of [Math.floor(m / 3), Math.floor((2 * m) / 3)]) {
        const tt = 2 + ((L - 4) * (q + 0.5)) / m;
        const ox = x0 + ((x1 - x0) * tt) / L + ix * 2.4, oz = z0 + ((z1 - z0) * tt) / L + iz * 2.4;
        const y = fl(ox, oz) + colH;
        tube(S, [ox, y, oz], [ox, y - 0.55, oz], 0.006, 0.006, 3, [0.5, 0.42, 0.3], seed, Surf.Wood);
        const ca = Math.atan2(ix, iz);
        // The disc faces into the garden: a flat lathe turned upright.
        const before = S.n;
        lathe(S, 0, 0, 0, [[0.01, -0.02], [0.2, -0.02], [0.2, 0.02], [0.01, 0.02]], 8, [0.9, 0.88, 0.82], seed, Surf.Marble);
        for (let i = before; i < S.n; i++) {
          const px = S.pos[i * 3], py = S.pos[i * 3 + 1], pz = S.pos[i * 3 + 2];
          // Turned a quarter about x (the lathe axis to the garden), then about y and moved.
          const lx = px, ly = -pz, lz = py;
          S.pos[i * 3] = ox + lx * Math.cos(ca) + lz * Math.sin(ca); S.pos[i * 3 + 1] = y - 0.75 + ly; S.pos[i * 3 + 2] = oz - lx * Math.sin(ca) + lz * Math.cos(ca);
          const nx0 = S.nrm[i * 4] / 127, ny0 = S.nrm[i * 4 + 1] / 127, nz0 = S.nrm[i * 4 + 2] / 127;
          const mx = nx0, my = -nz0, mz = ny0;
          S.nrm[i * 4] = Math.round((mx * Math.cos(ca) + mz * Math.sin(ca)) * 127); S.nrm[i * 4 + 1] = Math.round(my * 127); S.nrm[i * 4 + 2] = Math.round((-mx * Math.sin(ca) + mz * Math.cos(ca)) * 127);
        }
      }
    }
  }

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
    // The villa's floor from the same point the walker's ground takes it (data/pompeiiroads.ts).
    const gAt = hs.kind === "villa" && data.villa ? villaFloorPoint(data.villa.ring) : [(F.ax + F.bx) / 2, (F.az + F.bz) / 2];
    // The house's level is its threshold's; the floors of its courts and
    // rooms (fl) step up with the block's ground slab where that rises
    // under the house, or a slope buries them under it.
    const gDoor = ground(gAt[0], gAt[1]) + KERB_M + 0.06;
    const g = gDoor;
    const fl = (x: number, z: number): number => (ins && hs.kind !== "villa" ? Math.max(g, slabTop(ins, x, z) + 0.01) : g);
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
    {
      // The clear span: about twice the room depth, which is what 4 x area / perimeter gives a range of rooms.
      let per = 0;
      for (let i = 0; i < n; i++) per += Math.hypot(ring[((i + 1) % n) * 2] - ring[i * 2], ring[((i + 1) % n) * 2 + 1] - ring[i * 2 + 1]);
      roofBegin(ring, top + Math.min(ROOF_RANGE_M + 1, 4) * TAN_PITCH, Math.min(2 * ROOF_RANGE_M, (4 * area) / Math.max(per, 1)), seed);
    }

    // --- the rooms the camera can see into ---
    // Gaps cut in the court walls, by court and edge, for the fauces and the
    // rooms opening off a court; each is filled by a little interior box.
    const gaps = new Map<string, { t0: number; t1: number; h: number }[]>();
    /** Footprints of the rooms built so far (and the fauces), so the next keeps clear of them. */
    const rooms: Ring[] = [];
    const addGap = (ci: number, e: number, t0: number, t1: number, h: number): void => {
      const k = `${ci}:${e}`;
      gaps.set(k, [...(gaps.get(k) ?? []), { t0, t1, h }]);
    };
    const areas = courts.map((c) => Math.abs(ringArea(c)));
    const biggest = areas.reduce((m, a, k) => (a > areas[m] ? k : m), 0);
    /** Court edge e of court ci: ends, length, unit tangent, unit normal into the court. */
    const cedge = (ci: number, e: number): { ax: number; az: number; bx: number; bz: number; L: number; tx: number; tz: number; ix: number; iz: number } => {
      const c = courts[ci];
      const [ccx, ccz] = ringCentroid(c);
      const ax = c[e * 2], az = c[e * 2 + 1], bx = c[((e + 1) % 4) * 2], bz = c[((e + 1) % 4) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      let ix = ccx - (ax + bx) / 2, iz = ccz - (az + bz) / 2;
      const il = Math.hypot(ix, iz) || 1;
      ix /= il; iz /= il;
      return { ax, az, bx, bz, L, tx: (bx - ax) / L, tz: (bz - az) / L, ix, iz };
    };
    // The Faun's walls were First Style (stucco blocks imitating marble),
    // which the atlas has no record of: they keep the plain painted scheme.
    const houseScheme = hs.name === "Casa dei Vettii" ? ART_INDEX["vettii-wall"] : hs.name === "Casa della Parete Nera" ? ART_INDEX["bronzi-fourth"]
      : hs.name === "Casa del Fauno" ? -1 : ATRIUM_SCHEMES[Math.floor(hash(seed * 1e6, 61) * ATRIUM_SCHEMES.length)];
    // The houses whose pictures survive, and half the other surveyed ones,
    // get the mosaic floors and coffered ceilings; the rest signinum and joists.
    const famous = /Fauno|Vettii|Poeta Tragico|Parete Nera|Menandro|Misteri/.test(hs.name);
    const rich = hs.kind === "villa" || famous || (hs.surveyed && hash(seed * 1e6, 71) < 0.5);
    // The Faun's walls were First Style: painted stucco blocks (paintedWall's code 200 and up).
    const wallCode = hs.name === "Casa del Fauno" ? 200 : 0;
    /**
     * A room opening off court ci through edge e, centred tc along it, w
     * wide and `depth` deep, its ceiling at H: floor, three walls painted
     * with `scheme`, a ceiling, an optional mosaic floor and picture on the
     * back wall.
     */
    const roomOff = (ci: number, e: number, tc: number, w: number, depth: number, H: number,
      opt: { scheme?: number; code?: number; floor?: number; back?: number; floorKind?: FloorKind; ceil?: CeilingKind; door?: number; doorH?: number; screen?: boolean }): RoomFrame => {
      const E = cedge(ci, e);
      tc = Math.max(w / 2 + 0.3, Math.min(E.L - w / 2 - 0.3, tc));
      // A narrow door into a wider room: the room's front wall either side of
      // it, a wooden frame round it on the court side.
      const door = opt.door !== undefined && opt.door < w - 0.4 ? opt.door : 0;
      const dh = Math.min(opt.doorH ?? H, H, top - g - 0.3);
      if (door) addGap(ci, e, tc - door / 2, tc + door / 2, dh);
      else addGap(ci, e, tc - w / 2, tc + w / 2, Math.min(H, top - g - 0.3));
      const o0: [number, number] = [E.ax + E.tx * (tc - w / 2), E.az + E.tz * (tc - w / 2)], o1: [number, number] = [E.ax + E.tx * (tc + w / 2), E.az + E.tz * (tc + w / 2)];
      const b0: [number, number] = [o0[0] - E.ix * depth, o0[1] - E.iz * depth], b1: [number, number] = [o1[0] - E.ix * depth, o1[1] - E.iz * depth];
      const sch = art && opt.code === undefined ? opt.scheme ?? houseScheme : -1;
      const paint = (p: [number, number], q: [number, number], fx: number, fz: number, len: number, u0 = 0, y0 = g - 0.1): void => {
        if (sch >= 0) wall(p[0], p[1], q[0], q[1], y0, y0, g + H, g + H, fx, fz, ART_WORKS[sch].ground, seed, Surf.Art, sch, 3, u0, len, g, H);
        else wall(p[0], p[1], q[0], q[1], y0, y0, g + H, g + H, fx, fz, [0.55, 0.12, 0.08], seed, Surf.Fresco, opt.code ?? 0, 0, u0, len, g, H);
      };
      rooms.push([...o0, ...o1, ...b1, ...b0]);
      paint(o0, b0, E.tx, E.tz, depth);
      paint(b1, o1, -E.tx, -E.tz, depth);
      // The tablinum's back: folding wooden doors onto the garden behind.
      if (opt.screen) wall(b0[0], b0[1], b1[0], b1[1], g - 0.1, g - 0.1, g + Math.min(H, 3.6), g + Math.min(H, 3.6), E.ix, E.iz, [0.4, 0.26, 0.14], seed, Surf.Wood, 0, 0, 0, w, g, Math.min(H, 3.6));
      if (opt.screen && H > 3.6) paint(b0, b1, E.ix, E.iz, w, 0, g + 3.6);
      if (!opt.screen) paint(b0, b1, E.ix, E.iz, w);
      if (door) {
        const d0 = w / 2 - door / 2, d1 = w / 2 + door / 2;
        const at = (t: number): [number, number] => [o0[0] + E.tx * t, o0[1] + E.tz * t];
        paint(at(w), at(d1), -E.ix, -E.iz, w, w - d1);
        paint(at(d0), at(0), -E.ix, -E.iz, w, w - d0);
        paint(at(d1), at(d0), -E.ix, -E.iz, w, w - d1, g + dh);
        if (!lean) {
          const Fr: Frame = { ax: o0[0], az: o0[1], ex: E.tx, ez: E.tz, ox: E.ix, oz: E.iz };
          const WOODC: RGB = [0.34, 0.22, 0.12];
          fbox(Fr, d0 - 0.12, d0, -0.08, 0.05, g, g + dh, WOODC, seed, Surf.Wood, { skip: FB.Top, flatU: true });
          fbox(Fr, d1, d1 + 0.12, -0.08, 0.05, g, g + dh, WOODC, seed, Surf.Wood, { skip: FB.Top, flatU: true });
          fbox(Fr, d0 - 0.16, d1 + 0.16, -0.08, 0.06, g + dh, g + dh + 0.16, WOODC, seed, Surf.Wood, { bottom: true });
        }
      }
      roomQuad([[o0[0], g + H, o0[1]], [o1[0], g + H, o1[1]], [b1[0], g + H, b1[1]], [b0[0], g + H, b0[1]]], [0, -1, 0], [0.4, 0.28, 0.18], seed, Surf.Ceiling, opt.ceil ?? CeilingKind.Painted);
      roomQuad([o0, o1, b1, b0].map((p): V3 => [p[0], fl(p[0], p[1]) + 0.02, p[1]]), [0, 1, 0], [0.55, 0.42, 0.34], seed, Surf.Floor, opt.floorKind ?? FloorKind.SigninumNet);
      const mx = (o0[0] + o1[0] + b0[0] + b1[0]) / 4, mz = (o0[1] + o1[1] + b0[1] + b1[1]) / 4;
      if (art && opt.floor !== undefined) {
        const [fw, fd] = ART_WORKS[opt.floor].sizeM;
        const sw = Math.min(fw, w - 0.3) / 2, sd = Math.min(fd, depth - 0.3) / 2;
        // Top of the picture toward the court: it is read from the doorway.
        const P = (a: number, b: number): V3 => { const x = mx + E.tx * a + E.ix * b, z = mz + E.tz * a + E.iz * b; return [x, fl(x, z) + 0.035, z]; };
        artQuad([P(-sw, sd), P(sw, sd), P(sw, -sd), P(-sw, -sd)], [0, 1, 0], opt.floor, true);
      }
      if (art && opt.back !== undefined) {
        const [pw, ph] = ART_WORKS[opt.back].sizeM;
        const cx = (b0[0] + b1[0]) / 2 + E.ix * 0.03, cz = (b0[1] + b1[1]) / 2 + E.iz * 0.03, y0 = g + 1.1;
        const P = (a: number, y: number): V3 => [cx - E.tx * a, y, cz - E.tz * a];
        artQuad([P(-pw / 2, y0 + ph), P(pw / 2, y0 + ph), P(pw / 2, y0), P(-pw / 2, y0)], [E.ix, 0, E.iz], opt.back, true);
      }
      return { cx: mx, cz: mz, tx: E.tx, tz: E.tz, ix: E.ix, iz: E.iz, w, depth, g: fl(mx, mz) + 0.02 };
    };
    /** The court edge nearest a point, and how far along it. */
    const nearestEdge = (x: number, z: number, only?: number): { ci: number; e: number; t: number; d: number } => {
      let best = { ci: 0, e: 0, t: 0, d: Infinity };
      courts.forEach((_, ci) => {
        if (only !== undefined && ci !== only) return;
        for (let e = 0; e < 4; e++) {
          const E = cedge(ci, e);
          const d = distSeg(x, z, E.ax, E.az, E.bx, E.bz);
          if (d < best.d) best = { ci, e, t: (x - E.ax) * E.tx + (z - E.az) * E.tz, d };
        }
      });
      return best;
    };
    /** Outward room depth available behind an edge before the outer wall. */
    const roomDepth = (ci: number, e: number, t: number): number => {
      const E = cedge(ci, e);
      return rayToRing(ring, E.ax + E.tx * t - E.ix * 0.1, E.az + E.tz * t - E.iz * 0.1, -E.ix, -E.iz);
    };

    // The fauces: the front door opened on a passage straight to the court
    // nearest the street, so the atrium is seen from the pavement.
    let doorU = F.L / 2;
    let fauces = 0;
    if (courts.length && !grey && hs.kind === "domus" && F.street) {
      let c0 = 0, bd = Infinity;
      courts.forEach((c, ci) => {
        const [cx, cz] = ringCentroid(c);
        const d = (cx - F.ax) * vx + (cz - F.az) * vz;
        if (d < bd && areas[ci] < 400) { bd = d; c0 = ci; }
      });
      const [cx, cz] = ringCentroid(courts[c0]);
      const u = Math.max(1.6, Math.min(F.L - 1.6, (cx - F.ax) * ux + (cz - F.az) * uz));
      const dx = F.ax + ux * u, dz = F.az + uz * u;
      const d = rayToRing(courts[c0], dx + vx * 0.05, dz + vz * 0.05, vx, vz);
      if (d > 1.2 && d < 16) {
        doorU = u;
        fauces = d;
        const hit = nearestEdge(dx + vx * d, dz + vz * d, c0);
        addGap(hit.ci, hit.e, hit.t - 0.8, hit.t + 0.8, 3.4);
        // Painted walls down the passage (the black-and-red dado most fauces had).
        const L0: [number, number] = [dx - ux * 0.95, dz - uz * 0.95], R0: [number, number] = [dx + ux * 0.95, dz + uz * 0.95];
        const L1: [number, number] = [L0[0] + vx * d, L0[1] + vz * d], R1: [number, number] = [R0[0] + vx * d, R0[1] + vz * d];
        rooms.push([...L0, ...R0, ...R1, ...L1]);
        wall(L0[0], L0[1], L1[0], L1[1], g - 0.1, g - 0.1, g + 3.4, g + 3.4, ux, uz, [0.55, 0.12, 0.08], seed, Surf.Fresco, wallCode, 0, 0, d, g, 3.4);
        wall(R1[0], R1[1], R0[0], R0[1], g - 0.1, g - 0.1, g + 3.4, g + 3.4, -ux, -uz, [0.55, 0.12, 0.08], seed, Surf.Fresco, wallCode, 0, 0, d, g, 3.4);
        roomQuad([[L1[0], g + 3.4, L1[1]], [L0[0], g + 3.4, L0[1]], [R0[0], g + 3.4, R0[1]], [R1[0], g + 3.4, R1[1]]], [0, -1, 0], [0.4, 0.28, 0.18], seed, Surf.Ceiling, rich ? CeilingKind.Coffers : CeilingKind.Joists);
        roomQuad([L1, L0, R0, R1].map((p): V3 => [p[0], fl(p[0], p[1]) + 0.02, p[1]]), [0, 1, 0], [0.62, 0.6, 0.56], seed, Surf.Floor, rich ? FloorKind.BlackWhite : FloorKind.SigninumMeander);
        if (art && hs.name === "Casa del Poeta Tragico") {
          // Cave Canem, inside the door, the dog toward the street.
          const [cw, cd] = ART_WORKS[ART_INDEX["cave-canem"]].sizeM;
          const s0 = Math.min(d - 0.1, cd + 0.4);
          const P = (a: number, b: number): V3 => { const x = dx + ux * a + vx * b, z = dz + uz * a + vz * b; return [x, fl(x, z) + 0.035, z]; };
          artQuad([P(-cw / 2, s0), P(cw / 2, s0), P(cw / 2, s0 - cd), P(-cw / 2, s0 - cd)], [0, 1, 0], ART_INDEX["cave-canem"], true);
          artPlaced.push({ id: "cave-canem", house: hs.name, x: dx + vx * (s0 - cd / 2), y: g, z: dz + vz * (s0 - cd / 2), view: [dx - vx * 2.4, dz - vz * 2.4] });
        }
        if (art && hs.name === "Casa del Fauno") {
          // HAVE, "welcome", on the pavement before the door.
          const [hw, hd] = ART_WORKS[ART_INDEX["faun-have"]].sizeM;
          const yp = ground(dx, dz) + KERB_M + 0.02;
          const P = (a: number, b: number): V3 => [dx + ux * a - vx * b, yp, dz + uz * a - vz * b];
          artQuad([P(hw / 2, 0.15 + hd), P(-hw / 2, 0.15 + hd), P(-hw / 2, 0.15), P(hw / 2, 0.15)], [0, 1, 0], ART_INDEX["faun-have"], false);
          artPlaced.push({ id: "faun-have", house: hs.name, x: dx - vx * 0.5, y: yp, z: dz - vz * 0.5, view: [dx + vx * (d - 0.4), dz + vz * (d - 0.4)] });
        }
      }
    }

    // The named rooms, where the house is one whose pictures survive.
    if (courts.length && !grey && art) {
      const sites = sitesOf("artwork");
      if (hs.name === "Casa del Fauno") {
        // The Alexander Mosaic lay in the exedra between the two peristyles,
        // opening onto the first; the park's marker is where it lay.
        const m = sites.find((s) => /Alexander/i.test(s.name));
        if (m) {
          const pick = nearestEdge(m.x, m.z);
          const dep = Math.max(3.6, Math.min(pick.d * 2 + 0.6, roomDepth(pick.ci, pick.e, pick.t) - 0.4));
          roomOff(pick.ci, pick.e, pick.t, 6.6, dep, 4.6, { floor: ART_INDEX["alexander"] });
          const E = cedge(pick.ci, pick.e);
          const ax = E.ax + E.tx * pick.t - E.ix * dep / 2, az = E.az + E.tz * pick.t - E.iz * dep / 2;
          artPlaced.push({ id: "alexander", house: hs.name, x: ax, y: g, z: az, view: [ax + E.ix * (dep / 2 + 4.5), az + E.iz * (dep / 2 + 4.5)] });
        }
        const f = sites.find((s) => /Faun|Fawn/i.test(s.name));
        if (f) {
          // The Dancing Faun on his base at the impluvium's edge (the bronze is
          // 71 cm high: modelled at that size, on a half-metre plinth).
          const fb = fl(f.x, f.z);
          faunStatue(S, f.x, fb, f.z, Math.atan2(-vx, -vz), lean, seed);
          siteInfo.statues.push("dancing faun");
          artPlaced.push({ id: "dancing-faun", house: hs.name, x: f.x, y: g + 0.5, z: f.z });
        }
      }
      if (hs.name === "Casa dei Vettii") {
        // Off the peristyle: the triclinium with the Punishment of Ixion on
        // its back wall, and the black oecus with the cupids' frieze.
        const pc = biggest;
        const depths = [0, 1, 2, 3].map((e) => roomDepth(pc, e, cedge(pc, e).L / 2));
        const order = [0, 1, 2, 3].sort((a, b) => depths[b] - depths[a]);
        const [e1, e2] = order;
        if (depths[e1] > 3.5) {
          const E = cedge(pc, e1), dep = Math.min(6, depths[e1] - 0.4);
          roomOff(pc, e1, E.L * 0.35, 4.6, dep, 4.6, { scheme: ART_INDEX["bronzi-fourth"], back: ART_INDEX["vettii-ixion"] });
          artPlaced.push({ id: "vettii-ixion", house: hs.name, x: E.ax + E.tx * E.L * 0.35 - E.ix * dep, y: g + 1.9, z: E.az + E.tz * E.L * 0.35 - E.iz * dep });
        }
        if (depths[e2] > 3.5) {
          const E = cedge(pc, e2), dep = Math.min(6.5, depths[e2] - 0.4);
          roomOff(pc, e2, E.L * 0.5, 5.2, dep, 4.6, { scheme: ART_INDEX["vettii-wall"] });
          artPlaced.push({ id: "vettii-wall", house: hs.name, x: E.ax + E.tx * E.L * 0.5 - E.ix * dep, y: g + 1.5, z: E.az + E.tz * E.L * 0.5 - E.iz * dep });
        }
      }
      if (hs.name === "Casa della Parete Nera") {
        const [cx, cz] = ringCentroid(courts[biggest]);
        artPlaced.push({ id: "bronzi-fourth", house: hs.name, x: cx, y: g + 2, z: cz });
      }
    }

    // --- the atrium's own rooms: the tablinum across the pool from the
    // fauces, a cubiculum off each side near the front. The full build's:
    // the phone sees the atrium from the street, not into its side rooms.
    const furnish: { x: number; z: number; y: number; tx: number; tz: number; ix: number; iz: number; what: "lectus" | "loom" | "chest" | "table" }[] = [];
    if (courts.length && !grey && !lean) {
      const fitsRoom = (q: [number, number][]): boolean => {
        const pts = [...q, [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2] as [number, number]];
        for (const [x, z] of pts) if (!pointInRing(ring, x, z) || distToRing(ring, x, z) < 0.25) return false;
        // The front corners lie on their own court's edge; the back ones must stay clear of every court.
        const back = [q[2], q[3], pts[4]];
        if (back.some(([x, z]) => courts.some((c) => pointInRing(c, x, z) || distToRing(c, x, z) < 0.3))) return false;
        return !rooms.some((r) => pts.some(([x, z]) => pointInRing(r, x, z)) || [0, 2, 4, 6].some((i) => pointInRing(q.flat(), r[i], r[i + 1])));
      };
      const plan = (ci: number, e: number, tc: number, w: number, dep: number): [number, number][] => {
        const E = cedge(ci, e);
        const a: [number, number] = [E.ax + E.tx * (tc - w / 2), E.az + E.tz * (tc - w / 2)], b: [number, number] = [E.ax + E.tx * (tc + w / 2), E.az + E.tz * (tc + w / 2)];
        return [a, b, [b[0] - E.ix * dep, b[1] - E.iz * dep], [a[0] - E.ix * dep, a[1] - E.iz * dep]];
      };
      const H = Math.min(top - g - 0.4, 4.6);
      courts.forEach((_, ci) => {
        if ((areas[ci] >= 150 && ci === biggest) || areas[ci] < 24) return;
        const es = [0, 1, 2, 3].map((e) => ({ e, E: cedge(ci, e) }));
        const along = (x: { E: ReturnType<typeof cedge> }): number => x.E.ix * vx + x.E.iz * vz;
        const back = es.reduce((m, x) => (along(x) < along(m) ? x : m));
        if (along(back) < -0.7 && back.E.L > 3.5) {
          const w = Math.min(5.2, back.E.L * 0.5), tc = back.E.L / 2;
          let dep = Math.min(5.5, roomDepth(ci, back.e, tc) - 0.4);
          while (dep >= 3 && !fitsRoom(plan(ci, back.e, tc, w, dep))) dep -= 0.5;
          if (dep >= 3) {
            const rf = roomOff(ci, back.e, tc, w, dep, H, { code: wallCode || 1 + Math.floor(hash(seed * 1e6, 81) * 200), floorKind: rich ? FloorKind.Sectile : FloorKind.SigninumMeander, ceil: rich ? CeilingKind.Coffers : CeilingKind.Painted, screen: true });
            furnish.push({ x: rf.cx - rf.ix * (dep / 2 - 0.9), z: rf.cz - rf.iz * (dep / 2 - 0.9), y: rf.g, tx: rf.tx, tz: rf.tz, ix: rf.ix, iz: rf.iz, what: hash(seed * 1e6, 82) < 0.5 ? "table" : "chest" });
            interiors.push({ kind: "tablinum", house: hs.name, surveyed: true, x: rf.cx + rf.ix * (dep / 2 + 2.6), z: rf.cz + rf.iz * (dep / 2 + 2.6), y: rf.g, lookX: rf.cx - rf.ix * dep / 2, lookZ: rf.cz - rf.iz * dep / 2, furniture: 1 });
          }
        }
        let n = 0;
        for (const s of es) {
          if (Math.abs(along(s)) > 0.5 || s.E.L < 5) continue;
          // The front end of the side: the one nearer the street.
          const frontAtA = (s.E.ax - s.E.bx) * vx + (s.E.az - s.E.bz) * vz < 0;
          const tc = frontAtA ? 1.9 : s.E.L - 1.9;
          let dep = Math.min(3.4, roomDepth(ci, s.e, tc) - 0.4);
          while (dep >= 2.4 && !fitsRoom(plan(ci, s.e, tc, 2.9, dep))) dep -= 0.4;
          if (dep < 2.4) continue;
          const rf = roomOff(ci, s.e, tc, 2.9, dep, Math.min(H, 3.6), { code: 1 + Math.floor(hash(seed * 1e6, 83 + n) * 200), floorKind: rich ? FloorKind.BlackWhite : FloorKind.SigninumNet, ceil: CeilingKind.Painted, door: 1.1, doorH: 2.5 });
          const loomHere = n === 0 && hash(seed * 1e6, 84) < 0.08;
          furnish.push({ x: rf.cx - rf.ix * (dep / 2 - 0.5), z: rf.cz - rf.iz * (dep / 2 - 0.5), y: rf.g, tx: rf.tx, tz: rf.tz, ix: rf.ix, iz: rf.iz, what: loomHere ? "loom" : "lectus" });
          interiors.push({ kind: "cubiculum", house: hs.name, surveyed: true, x: rf.cx + rf.ix * (dep / 2 + 1.3), z: rf.cz + rf.iz * (dep / 2 + 1.3), y: rf.g, lookX: rf.cx - rf.ix * dep / 2, lookZ: rf.cz - rf.iz * dep / 2, furniture: 1 });
          n++;
        }
      });
    }

    // --- outer walls, the street front with its door and shops ---
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (!e.street || grey) {
        wall(e.ax, e.az, e.bx, e.bz, yBot, yBot, top, top, e.ox, e.oz, sideC, seed, Surf.Plaster, p1, 255, 0, e.L, g, top - g);
        continue;
      }
      const openings: Opening[] = [];
      if (i === fi) openings.push({ u0: doorU - 0.95, u1: doorU + 0.95, h: 3.4, kind: fauces ? "open" : "door" });
      if (e.main) {
        // Shops along a main-street front, either side of the door.
        for (let u = 0.8; u + 4.2 < e.L - 0.6; u += 5.2) {
          if (openings.some((o) => u < o.u1 + 0.6 && u + 4.2 > o.u0 - 0.6)) continue;
          openings.push({ u0: u, u1: u + 4.2, h: 3.1, kind: "shop" });
        }
      }
      if (openings.length) facade([e.ax, e.az], [e.bx, e.bz], g, yBot, top, e.ox, e.oz, col, seed, p1, 0, openings, 5, {
        main: e.main, rich: hs.surveyed && !!hs.name, house: true,
        room: (x, z, ix, iz) => Math.min(rayToRing(ring, x + ix * 0.05, z + iz * 0.05, ix, iz), ...courts.map((c) => rayToRing(c, x + ix * 0.05, z + iz * 0.05, ix, iz) || Infinity)),
      });
      else wall(e.ax, e.az, e.bx, e.bz, yBot, yBot, top, top, e.ox, e.oz, col, seed, Surf.Plaster, p1, 0, 0, e.L, g, top - g);
    }
    // Herculaneum's houses kept their upper floors: a range of rooms over the
    // street front, reached by a stair from the shop or the atrium. The
    // Trellis House is the type: its whole upper storey timber framed and
    // jettied over Cardo IV.
    if (town.style.timber && !grey && hs.kind === "domus") {
      const trellis = hs.name === data.herc?.trellis;
      let added = 0;
      for (let i = 0; i < n; i++) {
        const e = edges[i];
        if (!e.street || e.L < 4 || (!trellis && hash(seed * 1e6, 40 + i) > 0.8)) continue;
        const mx = (e.ax + e.bx) / 2 - e.ox * 0.5, mz = (e.az + e.bz) / 2 - e.oz * 0.5;
        let D = 4.4;
        for (const c of courts) D = Math.min(D, distToRing(c, mx, mz) - 0.4);
        if (D < 2.5) continue;
        const ex = (e.bx - e.ax) / e.L, ez = (e.bz - e.az) / e.L;
        // In from each end, so two edges' storeys do not run through each other at a corner.
        const ax = e.ax + ex * 0.3, az = e.az + ez * 0.3, bx = e.bx - ex * 0.3, bz = e.bz - ez * 0.3;
        const craticium = trellis || hash(seed * 1e6, 60 + i) < 0.2;
        upperFloor(ax, az, bx, bz, ex, ez, e.ox, e.oz, top, top + 3.3, col, seed, { jetty: trellis || hash(seed * 1e6, 80 + i) < 0.35, craticium, roofed: true, p1, g, depth: D, jettyM: trellis ? 1.3 : undefined, posts: trellis });
        added++;
        if (added === 1) upperHouses.push({ name: hs.name, storeys: 2, craticium, y0: top, y1: top + 3.3, x: (ax + bx) / 2, z: (az + bz) / 2 });
      }
      if (added) lots[lots.length - 1].storeys = 2;
    }

    // --- the courts: walls round each looking in, the floor, pool or garden ---
    const atriumFloor = famous ? FloorKind.BlackField : rich ? FloorKind.BlackWhite : hash(seed * 1e6, 72) < 0.5 ? FloorKind.SigninumNet : FloorKind.SigninumMeander;
    const atria: { k: number; inner: [number, number][]; icx: number; icz: number }[] = [];
    courts.forEach((c, k) => {
      const garden = areas[k] >= 150 && k === biggest;
      const [ccx, ccz] = ringCentroid(c);
      const scheme = !art || hs.name === "Casa del Fauno" ? -1 : garden ? GARDEN_SCHEMES[Math.floor(hash(seed * 1e6, 62) * GARDEN_SCHEMES.length)] : houseScheme;
      for (let e = 0; e < 4; e++) {
        const E = cedge(k, e);
        const { ax, az, bx, bz, L, ix, iz } = E;
        // The wall in pieces round any doorways cut in it, a lintel over each.
        const cuts = (gaps.get(`${k}:${e}`) ?? []).map((q) => ({ ...q, t0: Math.max(0, q.t0), t1: Math.min(L, q.t1) })).sort((p, q) => p.t0 - q.t0);
        let t = 0;
        const piece = (t0: number, t1: number, y0: number): void => {
          if (t1 - t0 < 0.02) return;
          const pa = [ax + E.tx * t0, az + E.tz * t0], pb = [ax + E.tx * t1, az + E.tz * t1];
          if (scheme >= 0) wall(pa[0], pa[1], pb[0], pb[1], y0, y0, top, top, ix, iz, ART_WORKS[scheme].ground, seed, Surf.Art, scheme, 1, t0, L, g, top - g);
          else wall(pa[0], pa[1], pb[0], pb[1], y0, y0, top, top, ix, iz, garden ? [0.86, 0.8, 0.68] : [0.55, 0.12, 0.08], seed, garden ? Surf.Plaster : Surf.Fresco, garden ? 100 : wallCode, 255, t0, L, g, top - g);
        };
        for (const q of cuts) {
          piece(t, q.t0, g - 0.1);
          piece(q.t0, q.t1, g + q.h);
          t = q.t1;
        }
        piece(t, L, g - 0.1);
        if (garden && !lean && !grey) {
          // The peristyle: columns a portico's depth in from the walls.
          const m = Math.max(1, Math.round((L - 4) / 3));
          for (let q = 0; q <= m; q++) {
            const tt = 2 + ((L - 4) * q) / m;
            // Set a hand into the court floor (which steps up with the block's slab and bends between its corners), its capital level with the rest.
            const px = ax + ((bx - ax) * tt) / L + ix * 2.4, pz = az + ((bz - az) * tt) / L + iz * 2.4, py = fl(px, pz) - 0.13;
            column(px, pz, py, g + storeyH - 1.4 - py, 0.2, [0.86, 0.82, 0.74], seed, 6, hash(seed * 1e6, 21) < 0.7, houseOrder(seed));
          }
          // The architrave the capitals carry, a beam along the column line up
          // to the portico roof's underside over it.
          const cy = g + storeyH - 1.4, ry = g + storeyH - 0.2 - (1.0 * 2.4) / 3.4 + 0.03;
          const B = (t: number, v: number): number[] => [ax + ((bx - ax) * t) / L + ix * v, az + ((bz - az) * t) / L + iz * v];
          box([...B(1.8, 2.22), ...B(L - 1.8, 2.22), ...B(L - 1.8, 2.58), ...B(1.8, 2.58)], cy, ry, [0.88, 0.85, 0.78], seed, Surf.Stucco, Surf.Stucco, [0.88, 0.85, 0.78], !opts.probeOpenBeams);
        }
      }
      const fp: V3[] = [0, 1, 2, 3].map((q): V3 => [c[q * 2], fl(c[q * 2], c[q * 2 + 1]) + 0.02, c[q * 2 + 1]]);
      lampSites.courts.push({ ring: c.slice(0, 8), g, garden });
      if (garden && !lean && !grey) {
        // Under the colonnade at a corner, looking across the garden.
        const sx = c[0] + (ccx - c[0]) * 0.12, sz = c[1] + (ccz - c[1]) * 0.12;
        interiors.push({ kind: "peristyle", house: hs.name, surveyed: true, x: sx, z: sz, y: fl(sx, sz), lookX: ccx, lookZ: ccz, furniture: 0 });
      }
      // The garden's walk under the colonnade is floored like the atrium (gardenPaint).
      if (garden) roomQuad(fp, [0, 1, 0], [0.3, 0.4, 0.18], seed, Surf.Garden, lean ? 1 : 34, 1 + (rich ? FloorKind.BlackWhite : FloorKind.SigninumNet));
      else roomQuad(fp, [0, 1, 0], [0.55, 0.38, 0.3], seed, Surf.Floor, atriumFloor);
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
          // Its underside, seen from the walk and from the garden.
          roomQuad([p, q, qi, pi], [-(ccx - (p[0] + q[0]) / 2), -2, -(ccz - (p[2] + q[2]) / 2)], [0.42, 0.3, 0.2], seed, Surf.Ceiling, CeilingKind.Joists);
        }
        peristyleGarden(c, fl, seed, famous || rich, 3.4, storeyH - 1.4);
      } else if (!garden && (lean || grey)) {
        // Level with the court's highest corner: the court floor is a sloped quad and would cover a pool set at its middle.
        const pool = fp.map((p): V3 => [ccx + (p[0] - ccx) * 0.45, Math.max(...fp.map((q) => q[1])) + 0.05, ccz + (p[2] - ccz) * 0.45]);
        // The court is the opening: p1 its height over the water, p2 its radius, in decimetres.
        const op = impluvium(pool, ccx, ccz, fl(ccx, ccz), top, Math.sqrt(Math.abs(ringArea(c.slice(0, 8))) / Math.PI));
        poly(S, pool, [0, 1, 0], [0.2, 0.32, 0.34], seed, Surf.Water, op[0], op[1], pool.map((p) => [p[0], p[2], ccx, ccz]));
      } else if (!garden) {
        // The atrium: the court is the room, roofed round an opening over the
        // pool (the compluvium), its four slopes falling inward at the Roman
        // pitch to tile ends and spouts that drain into the impluvium. The
        // phone keeps the open court above.
        const outer = [0, 1, 2, 3].map((q): [number, number] => [c[q * 2], c[q * 2 + 1]]);
        const side = Math.min(...[0, 1, 2, 3].map((q) => cedge(k, q).L));
        const inset = Math.max(0.8, Math.min(side * 0.3, side / 2 - 1.2));
        const inner = outer.map((p, i): [number, number] => {
          const nx1 = outer[(i + 1) % 4], pv = outer[(i + 3) % 4];
          const l1 = Math.hypot(nx1[0] - p[0], nx1[1] - p[1]) || 1, l2 = Math.hypot(pv[0] - p[0], pv[1] - p[1]) || 1;
          return [p[0] + ((nx1[0] - p[0]) / l1 + (pv[0] - p[0]) / l2) * inset, p[1] + ((nx1[1] - p[1]) / l1 + (pv[1] - p[1]) / l2) * inset];
        });
        const hi = top, lo = top - inset * TAN_PITCH;
        for (let e = 0; e < 4; e++) {
          const p = outer[e], q = outer[(e + 1) % 4], pi = inner[e], qi = inner[(e + 1) % 4];
          const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const E = cedge(k, e);
          const quad: V3[] = [[p[0], hi, p[1]], [q[0], hi, q[1]], [qi[0], lo, qi[1]], [pi[0], lo, pi[1]]];
          const sl = inset / Math.cos(Math.atan(TAN_PITCH));
          poly(S, quad, [E.ix, 1, E.iz], tileC, seed, Surf.Tile, 0, 0, [[0, sl, L, sl], [L, sl, L, sl], [L, 0, L, sl], [0, 0, L, sl]]);
          roomQuad(quad, [-E.ix, -1, -E.iz], [0.36, 0.24, 0.14], seed, Surf.Ceiling, rich ? CeilingKind.Coffers : CeilingKind.Joists);
          // The tile ends along the opening, and a lion-head spout at each side's middle.
          const Li = Math.hypot(qi[0] - pi[0], qi[1] - pi[1]);
          poly(S, [[pi[0], lo, pi[1]], [qi[0], lo, qi[1]], [qi[0], lo - 0.14, qi[1]], [pi[0], lo - 0.14, pi[1]]], [E.ix, 0, E.iz], tileC, seed, Surf.Tile, 0, 0,
            [[0, 0.14, Li, 0.14], [Li, 0.14, Li, 0.14], [Li, 0, Li, 0.14], [0, 0, Li, 0.14]]);
          spout(S, (pi[0] + qi[0]) / 2, lo - 0.08, (pi[1] + qi[1]) / 2, E.ix, E.iz, [tileC[0] * 1.05, tileC[1] * 1.1, tileC[2] * 1.1], seed);
        }
        const icx = inner.reduce((s, p) => s + p[0] / 4, 0), icz = inner.reduce((s, p) => s + p[1] / 4, 0);
        const wy = Math.max(...fp.map((q) => q[1])) + 0.05;
        const pool = inner.map((p): V3 => [icx + (p[0] - icx) * 0.92, wy, icz + (p[1] - icz) * 0.92]);
        const op = impluvium(pool, icx, icz, fl(icx, icz), lo, Math.sqrt(Math.abs(ringArea(inner.flat())) / Math.PI));
        poly(S, pool, [0, 1, 0], [0.2, 0.32, 0.34], seed, Surf.Water, op[0], op[1], pool.map((p) => [p[0], p[2], icx, icz]));
        atria.push({ k, inner, icx, icz });
        if (hs.kind === "domus") interiors.push({ kind: "atrium", house: hs.name, surveyed: true, x: ccx - vx * 0.8 * Math.sqrt(areas[k]) / 2, z: ccz - vz * 0.8 * Math.sqrt(areas[k]) / 2, y: fl(ccx, ccz), lookX: ccx + vx * 4, lookZ: ccz + vz * 4, furniture: 0 });
      }
    });
    // --- the atrium's furniture: the puteal over the cistern beside the
    // pool, the marble table at its head, the household shrine and the
    // strongbox against the walls; the rooms' couches and tables.
    const yawAlong = (tx: number, tz: number): number => Math.atan2(-tz, tx);
    for (const a of atria) {
      const c = courts[a.k];
      let placedHere = 0;
      const opening = a.inner.flat();
      const clear = (x: number, z: number, r: number): boolean => pointInRing(c, x, z) && distToRing(c, x, z) > r
        && !pointInRing(opening, x, z) && distToRing(opening, x, z) > r * 0.6;
      let hd = 0, hw = 0;
      for (const p of a.inner) { hd = Math.max(hd, (p[0] - a.icx) * vx + (p[1] - a.icz) * vz); hw = Math.max(hw, (p[0] - a.icx) * ux + (p[1] - a.icz) * uz); }
      const P = (du: number, dv: number): [number, number] => [a.icx + ux * du + vx * dv, a.icz + uz * du + vz * dv];
      const [tx, tz] = P(0, hd + 0.75);
      if (clear(tx, tz, 0.5)) { cartibulum(S, tx, fl(tx, tz), tz, yawAlong(ux, uz), seed); placedHere++; }
      const [px, pz] = P(hw + 0.6, hd * 0.4);
      if (clear(px, pz, 0.45)) { puteal(S, px, fl(px, pz), pz, seed); placedHere++; }
      for (let e = 0; e < 4; e++) {
        const E = cedge(a.k, e);
        if (Math.abs(E.ix * vx + E.iz * vz) > 0.5 || E.L < 4) continue;
        const sideIsLeft = E.ix * ux + E.iz * uz > 0;
        // A lararium on one side wall near the back, the arca on the other.
        const what = sideIsLeft ? (hash(seed * 1e6, 91) < 0.55 ? "lararium" : "") : (hash(seed * 1e6, 92) < 0.45 ? "arca" : "");
        if (!what) continue;
        const backAtA = (E.ax - E.bx) * vx + (E.az - E.bz) * vz > 0;
        const t = backAtA ? E.L * 0.25 : E.L * 0.75;
        const cuts = gaps.get(`${a.k}:${e}`) ?? [];
        if (cuts.some((q) => t > q.t0 - 1 && t < q.t1 + 1)) continue;
        const x = E.ax + E.tx * t + E.ix * 0.02, z = E.az + E.tz * t + E.iz * 0.02;
        placedHere++;
        if (what === "lararium") lararium(S, x, fl(x, z), z, Math.atan2(E.ix, E.iz), seed);
        else arca(S, x + E.ix * 0.5, fl(x, z), z + E.iz * 0.5, yawAlong(E.tx, E.tz), seed);
      }
      if (hash(seed * 1e6, 93) < 0.35) {
        const [bx, bz] = P(-(hw + 0.7), -hd * 0.3);
        if (clear(bx, bz, 0.4)) { brazier(S, bx, fl(bx, bz), bz, seed); placedHere++; }
      }
      const view = interiors.find((iv) => iv.kind === "atrium" && iv.house === hs.name && pointInRing(c, iv.x, iv.z));
      if (view) view.furniture = placedHere;
    }
    for (const f of furnish) {
      const y = f.y;
      if (f.what === "lectus") lectus(S, f.x, y, f.z, yawAlong(f.tx, f.tz), seed);
      else if (f.what === "loom") loom(S, f.x, y, f.z, yawAlong(f.tx, f.tz), seed);
      else if (f.what === "chest") chest(S, f.x, y, f.z, yawAlong(f.tx, f.tz), seed);
      else tripodTable(S, f.x, y, f.z, seed);
    }
    // Herculaneum: the glass mosaic of Neptune and Amphitrite on the court
    // wall it is mapped on, and the nymphaeum's hunting scene round the corner.
    if (data.herc && hs.name === "Casa di Nettuno e Anfitrite" && courts.length && !grey) {
      const { x: nx0, z: nz0 } = data.herc.neptune;
      let best: { k: number; e: number; d: number } | null = null;
      courts.forEach((_, k) => {
        for (let e = 0; e < 4; e++) {
          const E = cedge(k, e);
          const d = distSeg(nx0, nz0, E.ax, E.az, E.bx, E.bz);
          if (!best || d < best.d) best = { k, e, d };
        }
      });
      const pick = best as { k: number; e: number; d: number } | null;
      if (pick) {
        const panel = (e: number, design: number, w: number): void => {
          const E = cedge(pick.k, e);
          const t = Math.max(w / 2 + 0.2, Math.min(E.L - w / 2 - 0.2, (nx0 - E.ax) * E.tx + (nz0 - E.az) * E.tz));
          const half = Math.min(w / 2, E.L / 2 - 0.2);
          const pa = [E.ax + E.tx * (t - half) + E.ix * 0.04, E.az + E.tz * (t - half) + E.iz * 0.04];
          const pb = [E.ax + E.tx * (t + half) + E.ix * 0.04, E.az + E.tz * (t + half) + E.iz * 0.04];
          const y0 = fl(nx0, nz0) + 0.45, y1 = Math.min(top - 0.3, y0 + 3.2);
          wall(pa[0], pa[1], pb[0], pb[1], y0, y0, y1, y1, E.ix, E.iz, [0.12, 0.25, 0.5], seed, Surf.Mosaic, design, 0, 0, half * 2, y0, y1 - y0);
          artPlaced.push({ id: design === 0 ? "neptune-amphitrite" : "nymphaeum-hunt", house: hs.name, x: (pa[0] + pb[0]) / 2, y: (y0 + y1) / 2, z: (pa[1] + pb[1]) / 2,
            view: [(pa[0] + pb[0]) / 2 + E.ix * 3.5, (pa[1] + pb[1]) / 2 + E.iz * 3.5] });
        };
        panel(pick.e, 0, 2.6);
        panel((pick.e + 1) % 4, 1, 3.4);
      }
    }


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
    // The heightfield stops at the walls; on the street the tiles run on
    // past the wall to an eave, the line that makes a front read as a house.
    if (!grey) for (const e of edges) {
      if (!e.street) continue;
      const ea: V3 = [e.ax + e.ox * EAVE_M, top - EAVE_M * TAN_PITCH, e.az + e.oz * EAVE_M], eb: V3 = [e.bx + e.ox * EAVE_M, top - EAVE_M * TAN_PITCH, e.bz + e.oz * EAVE_M];
      const s = EAVE_M / Math.cos(Math.atan(TAN_PITCH));
      poly(S, [ea, eb, [e.bx, top, e.bz], [e.ax, top, e.az]], [e.ox, 1, e.oz], tileC, seed, Surf.Tile, 0, 1, [[0, -s, 0, 0], [0, -s, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
      stats.roofTriangles += 2;
      eaveTrim([e.ax, e.az], [e.bx, e.bz], ea, eb, top, e.ox, e.oz, tileC, seed, e.main || (hs.surveyed && !!hs.name));
    }
    solids.push({ ring: [...ring], baseY: yBot, topY: top + Math.min(CAP, 4) * TAN_PITCH });
    if (hs.kind === "villa" && art) {
      const m = sitesOf("artwork").find((s) => /misteri/i.test(s.name));
      if (m) mysteriesRoom(m.x, m.z, ux, uz, g);
    }
  }

  /**
   * Room 5 of the Villa dei Misteri, round the park's marker for it: about
   * 7 x 5 m, the megalographia running round it on the red ground above a
   * dado, the figures life size. The frieze's two best-recorded walls hang
   * on the long back wall and one end; the rest of the room is the plain red
   * ground they stand on, with the doorway in the long front wall.
   */
  function mysteriesRoom(cx: number, cz: number, ux: number, uz: number, g: number): void {
    const vx = -uz, vz = ux;
    const hu = 3.5, hv = 2.5, H = 5;
    const P = (a: number, b: number): [number, number] => [cx + ux * a + vx * b, cz + uz * a + vz * b];
    const red: RGB = [0.55, 0.12, 0.08];
    const inner = (p: [number, number], q: [number, number], fx: number, fz: number, len: number): void =>
      wall(p[0], p[1], q[0], q[1], g - 0.1, g - 0.1, g + H, g + H, fx, fz, red, 0.4, Surf.Plaster, Math.round(0.9 * 40), 255, 0, len, g, H);
    // Back (+v), the end (+u), the other end (-u), the front (-v) with its doorway.
    inner(P(hu, hv), P(-hu, hv), -vx, -vz, 2 * hu);
    inner(P(hu, -hv), P(hu, hv), -ux, -uz, 2 * hv);
    inner(P(-hu, hv), P(-hu, -hv), ux, uz, 2 * hv);
    inner(P(-hu, -hv), P(-0.8, -hv), vx, vz, hu - 0.8);
    inner(P(0.8, -hv), P(hu, -hv), vx, vz, hu - 0.8);
    wall(P(-0.8, -hv)[0], P(-0.8, -hv)[1], P(0.8, -hv)[0], P(0.8, -hv)[1], g + 3.2, g + 3.2, g + H, g + H, vx, vz, red, 0.4, Surf.Plaster, 0, 255, 0, 1.6, g, H);
    const c = [P(-hu, -hv), P(hu, -hv), P(hu, hv), P(-hu, hv)];
    poly(S, c.map((p): V3 => [p[0], g + H, p[1]]), [0, -1, 0], [0.82, 0.78, 0.7], 0.4, Surf.Plaster, 0, 255, uv4());
    poly(S, c.map((p): V3 => [p[0], g + 0.02, p[1]]), [0, 1, 0], [0.6, 0.55, 0.5], 0.4, Surf.Marble, 0, 0, uv4());
    const y0 = g + 0.95;
    const north = ART_INDEX["misteri-north"], east = ART_INDEX["misteri-east"];
    const nh = ART_WORKS[north].sizeM[1], eh = ART_WORKS[east].sizeM[1];
    const B = (a: number, b: number, y: number): V3 => { const [x, z] = P(a, b); return [x, y, z]; };
    artQuad([B(hu - 0.05, hv - 0.03, y0 + nh), B(-hu + 0.05, hv - 0.03, y0 + nh), B(-hu + 0.05, hv - 0.03, y0), B(hu - 0.05, hv - 0.03, y0)], [-vx, 0, -vz], north, true);
    artQuad([B(hu - 0.03, -hv + 0.05, y0 + eh), B(hu - 0.03, hv - 0.05, y0 + eh), B(hu - 0.03, hv - 0.05, y0), B(hu - 0.03, -hv + 0.05, y0)], [-ux, 0, -uz], east, true);
    artPlaced.push({ id: "misteri-north", house: "Villa dei Misteri", x: P(0, hv)[0], y: y0 + 1.3, z: P(0, hv)[1] });
    artPlaced.push({ id: "misteri-east", house: "Villa dei Misteri", x: P(hu, 0)[0], y: y0 + 1.3, z: P(hu, 0)[1] });
  }

  /**
   * A bakery (pistrinum) on its yard: walls round it, a wide door on the
   * street, the lava mills in a row on the basalt floor where the donkeys
   * walked them round, the domed oven at the back under a lean-to roof.
   * Modestus's had three mills, Popidius Priscus's four; others two.
   */
  function buildBakery(hs: House): void {
    const r = hs.ring;
    const [fax, faz, fbx, fbz, , , bax, baz] = r;
    const fx = (fbx - fax) / 11, fz = (fbz - faz) / 11;
    const vx = (bax - fax) / 12, vz = (baz - faz) / 12;
    const g = ground((fax + fbx) / 2, (faz + fbz) / 2) + KERB_M + 0.06;
    const H = 4.6;
    const col: RGB = [0.8, 0.74, 0.62];
    const P = (a: number, b: number): [number, number] => [fax + fx * a + vx * b, faz + fz * a + vz * b];
    roofBegin([...r], g + H, 11, hs.seed);
    // Street front with a wide door; sides and back. Plaster both faces on the outside walls.
    const [cx, cz] = ringCentroid(r);
    const out = (p: [number, number], q: [number, number]): [number, number] => {
      let ox = q[1] - p[1], oz = -(q[0] - p[0]);
      const L = Math.hypot(ox, oz) || 1; ox /= L; oz /= L;
      if ((p[0] + q[0]) / 2 * ox + (p[1] + q[1]) / 2 * oz < cx * ox + cz * oz) { ox = -ox; oz = -oz; }
      return [ox, oz];
    };
    const both = (p: [number, number], q: [number, number], y0: number, y1: number, len: number, u0: number): void => {
      const [ox, oz] = out(p, q);
      wall(p[0], p[1], q[0], q[1], y0, y0, y1, y1, ox, oz, LOWER[Math.floor(hs.seed * LOWER.length)], hs.seed, Surf.Plaster, 100, 0, u0, 11, g, H);
      wall(q[0], q[1], p[0], p[1], y0, y0, y1, y1, -ox, -oz, col, hs.seed, Surf.Plaster, 100, 255, 0, len, g, H);
    };
    both(P(0, 0), P(3.6, 0), g - 0.4, g + H, 3.6, 0);
    both(P(7.4, 0), P(11, 0), g - 0.4, g + H, 3.6, 7.4);
    both(P(3.6, 0), P(7.4, 0), g + 3.3, g + H, 3.8, 3.6);
    both(P(11, 0), P(11, 12), g - 0.4, g + H, 12, 0);
    both(P(11, 12), P(0, 12), g - 0.4, g + H, 11, 0);
    both(P(0, 12), P(0, 0), g - 0.4, g + H, 12, 0);
    // The floor: lava slabs.
    // A hand's breadth up: the block's garden ground under it rises with the slope.
    const fl = [P(0, 0), P(11, 0), P(11, 12), P(0, 12)].map((p): V3 => [p[0], g + 0.12, p[1]]);
    poly(S, fl, [0, 1, 0], [0.3, 0.29, 0.28], hs.seed, Surf.Basalt, 0, 0, fl.map(() => [0, 0, 0, 0]));
    const nMills = /Modestus/.test(hs.name) ? 3 : /Popidius/.test(hs.name) ? 4 : 2;
    for (let k = 0; k < nMills; k++) {
      const [mx, mz] = P(1.9 + (k * 7.2) / (nMills - 1), k % 2 ? 6.2 : 4.4);
      mill(S, mx, g, mz, hash(k, hs.seed * 1e6) * Math.PI, hs.seed, lean);
      siteInfo.mills.push({ x: mx, z: mz, site: hs.name });
    }
    // The oven against the back wall, its mouth to the room.
    const [ox0, oz0] = P(5.5, 10.2);
    oven(S, ox0, g, oz0, Math.atan2(-vx, -vz), hs.seed);
    siteInfo.ovens.push(hs.name);
    // A lean-to over the back third, sloping to the yard.
    const rl = [P(0, 12), P(11, 12), P(11, 8.2), P(0, 8.2)];
    poly(S, [[rl[0][0], g + H, rl[0][1]], [rl[1][0], g + H, rl[1][1]], [rl[2][0], g + H - 1.2, rl[2][1]], [rl[3][0], g + H - 1.2, rl[3][1]]], [-vx, 3, -vz], [0.62, 0.3, 0.19], hs.seed, Surf.Tile, 0, 0, [[0, 3.8, 11, 3.8], [11, 3.8, 11, 3.8], [11, 0, 11, 3.8], [0, 0, 11, 3.8]]);
    poly(S, [[rl[0][0], g + H - 0.05, rl[0][1]], [rl[1][0], g + H - 0.05, rl[1][1]], [rl[2][0], g + H - 1.25, rl[2][1]], [rl[3][0], g + H - 1.25, rl[3][1]]], [vx, -3, vz], [0.4, 0.28, 0.18], hs.seed, Surf.Wood, 0, 0, uv4());
    lots.push({ kind: "taberna", width: 11, depth: 12, storeys: 1, main: false, compluvium: false, inferred: false });
    stats.lots++;
    solids.push({ ring: [...r], baseY: g - 0.4, topY: g + H });
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
        S.tag = 0;
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
        S.tag = 0;
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
    const twoStorey = hash(seed * 1e6, 2) < (main ? 0.5 : kind === "taberna" ? 0.4 : 0.28) + town.style.upperStorey;
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
    // A band's beams run front to back across the shorter of frontage and depth.
    roofBegin([fa[0], fa[1], fb[0], fb[1], bb[0], bb[1], ba[0], ba[1]], g + Hf + 1.5, Math.min(width, d, kind === "domus" ? 11 : 14), seed);
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
      // The full build opens the door on a fauces through to the atrium,
      // the tablinum across it; the phone keeps the closed door.
      const inside = !lean && !grey;
      openings.push({ u0: mid - doorW / 2, u1: mid + doorW / 2, h: 3.4, kind: inside ? "open" : "door" });
      if (main && width >= 12) {
        openings.push({ u0: 0.7, u1: mid - doorW / 2 - 0.7, h: 3.1, kind: "shop" });
        openings.push({ u0: mid + doorW / 2 + 0.7, u1: width - 0.7, h: 3.1, kind: "shop" });
      }
      const door: [number, number] = [mid - doorW / 2, mid + doorW / 2];
      const backD = d - fDepth - aDepth;
      const tw = Math.min(4.6, width * 0.42);
      const tab: [number, number] | null = inside && backD > 3.4 ? [mid - tw / 2, mid + tw / 2] : null;
      const tabH = Math.min(storeyH - 0.5, 4.2);
      const rich = hash(seed * 1e6, 73) < 0.25;
      band(q0, q1, q2b, q2a, g, yBot, Hf, "gable", col, tileC, seed, p1, p2, openings, true, false,
        { main, house: true, grand: true, gapBack: inside ? [door[0], door[1], 3.4] : undefined });
      // Atrium band, its roof sloping in to the compluvium.
      band(q2a, q2b, q3b, q3a, g, yBot, storeyH + 0.6, "compluvium", col, tileC, seed, p1, p2, [], false, false,
        inside ? { gapFront: [door[0], door[1], 3.4], gapBack: tab ? [tab[0], tab[1], tabH] : undefined, atrium: { door, tablinum: tab, rich } } : {});
      info.compluvium = true;
      stats.compluvia++;
      // Back band: tablinum and rooms, a portico onto the garden behind.
      band(q3a, q3b, q4b, q4a, g, yBot, storeyH, "gable", col, tileC, seed, p1, p2, [], false, true, tab ? { gapFront: [tab[0], tab[1], tabH] } : {});
      if (inside) {
        // The fauces: painted walls down the passage from the door to the
        // atrium, a boarded ceiling, a threshold mosaic or signinum floor.
        const fd = fDepth + 0.25;
        const il = Math.hypot(q2a[0] - q0[0], q2a[1] - q0[1]) || 1;
        const F0: Frame = { ax: q0[0], az: q0[1], ex: (q1[0] - q0[0]) / width, ez: (q1[1] - q0[1]) / width, ox: -(q2a[0] - q0[0]) / il, oz: -(q2a[1] - q0[1]) / il };
        const P = (u: number, v: number): [number, number] => [F0.ax + F0.ex * u - F0.ox * v, F0.az + F0.ez * u - F0.oz * v];
        const L0 = P(door[0], 0), L1 = P(door[0], fd), R0 = P(door[1], 0), R1 = P(door[1], fd);
        const gf = floorOver(g, [L0, R0, R1, L1]);
        const code = 1 + Math.floor(hash(seed * 1e6, 85) * 199);
        wall(L0[0], L0[1], L1[0], L1[1], gf - 0.1, gf - 0.1, gf + 3.4, gf + 3.4, F0.ex, F0.ez, [0.55, 0.12, 0.08], seed, Surf.Fresco, code, 0, 0, fd, gf, 3.4);
        wall(R1[0], R1[1], R0[0], R0[1], gf - 0.1, gf - 0.1, gf + 3.4, gf + 3.4, -F0.ex, -F0.ez, [0.55, 0.12, 0.08], seed, Surf.Fresco, code, 0, 0, fd, gf, 3.4);
        roomQuad([[L1[0], gf + 3.4, L1[1]], [L0[0], gf + 3.4, L0[1]], [R0[0], gf + 3.4, R0[1]], [R1[0], gf + 3.4, R1[1]]], [0, -1, 0], [0.4, 0.28, 0.18], seed, Surf.Ceiling, CeilingKind.Joists);
        roomQuad([L1, L0, R0, R1].map((p): V3 => [p[0], gf, p[1]]), [0, 1, 0], [0.6, 0.56, 0.5], seed, Surf.Floor, rich ? FloorKind.BlackWhite : FloorKind.SigninumMeander);
        interiors.push({ kind: "fauces", house: "", surveyed: false, x: (L0[0] + R0[0]) / 2 + F0.ox * 1.4, z: (L0[1] + R0[1]) / 2 + F0.oz * 1.4, y: gf, lookX: (L0[0] + R0[0]) / 2 - F0.ox * (fDepth + aDepth), lookZ: (L0[1] + R0[1]) / 2 - F0.oz * (fDepth + aDepth), furniture: 0 });
        if (tab) {
          // The tablinum: open to the atrium, painted, coffered in a rich
          // house, its back closed by folding wooden doors onto the garden.
          const t0 = fDepth + aDepth - 0.25, td = Math.min(4.2, backD - 0.6);
          const A0 = P(tab[0], t0), A1 = P(tab[0], fDepth + aDepth + td), B0 = P(tab[1], t0), B1 = P(tab[1], fDepth + aDepth + td);
          const tg = floorOver(g, [A0, B0, B1, A1]);
          const tcode = 1 + Math.floor(hash(seed * 1e6, 90) * 199);
          const L = td + 0.25;
          wall(A0[0], A0[1], A1[0], A1[1], tg - 0.1, tg - 0.1, tg + tabH, tg + tabH, F0.ex, F0.ez, [0.55, 0.12, 0.08], seed, Surf.Fresco, tcode, 0, 0, L, tg, tabH);
          wall(B1[0], B1[1], B0[0], B0[1], tg - 0.1, tg - 0.1, tg + tabH, tg + tabH, -F0.ex, -F0.ez, [0.55, 0.12, 0.08], seed, Surf.Fresco, tcode, 0, 0, L, tg, tabH);
          wall(A1[0], A1[1], B1[0], B1[1], tg - 0.1, tg - 0.1, tg + tabH, tg + tabH, F0.ox, F0.oz, [0.4, 0.26, 0.14], seed, Surf.Wood, 0, 0, 0, tw, tg, tabH);
          roomQuad([[A0[0], tg + tabH, A0[1]], [B0[0], tg + tabH, B0[1]], [B1[0], tg + tabH, B1[1]], [A1[0], tg + tabH, A1[1]]], [0, -1, 0], [0.4, 0.28, 0.18], seed, Surf.Ceiling, rich ? CeilingKind.Coffers : CeilingKind.Painted);
          roomQuad([A0, B0, B1, A1].map((p): V3 => [p[0], tg, p[1]]), [0, 1, 0], [0.55, 0.42, 0.34], seed, Surf.Floor, rich ? FloorKind.Sectile : FloorKind.SigninumNet);
          const [cx, cz] = P(width / 2, fDepth + aDepth + td - 0.9);
          if (hash(seed * 1e6, 82) < 0.5) tripodTable(S, cx, tg, cz, seed);
          else chest(S, cx, tg, cz, Math.atan2(-F0.ez, F0.ex), seed);
        }
      }
      solids.push({ ring: [fa[0], fa[1], fb[0], fb[1], bb[0], bb[1], ba[0], ba[1]], baseY: yBot, topY: g + Hf + 1.5 });
    } else {
      const openings: Opening[] = [];
      if (kind === "taberna") openings.push({ u0: 0.55, u1: width - 0.55, h: 3.1, kind: "shop" });
      else openings.push({ u0: width * 0.5 - 0.8, u1: width * 0.5 + 0.8, h: 3.0, kind: "door" });
      const deep = Math.min(d, kind === "taberna" ? 9 : 14);
      const [q0, q1] = at(0), [qa, qb] = at(deep / d);
      band(q0, q1, qb, qa, g, yBot, Hf, kind === "taberna" && !twoStorey && hash(seed * 1e6, 12) < 0.4 ? "lean" : "gable", col, tileC, seed, p1, p2, openings, true, false, { main, house: kind !== "taberna" });
      if (deep < d - 3) {
        // The rest of a deep plot is the yard behind: a lower outbuilding.
        const [qc, qd] = at(Math.min(1, (deep + Math.min(6, d - deep)) / d));
        band(qa, qb, qd, qc, g, yBot, 3.6, "lean", col, tileC, seed, p1, p2, [], false);
      }
      solids.push({ ring: [fa[0], fa[1], fb[0], fb[1], qb[0], qb[1], qa[0], qa[1]], baseY: yBot, topY: g + Hf + 1.5 });
    }
  }

  /**
   * An upper floor's timber at a street front, a to b (unit e along it, o
   * out to the street), from the floor at y0 to the eaves at y1: the floor
   * beam and joist ends along the facade, and optionally the floor jettied
   * out over the pavement on those joists, or its wall in opus craticium.
   * `roofed` builds the whole storey (walls, back and roof) as a strip over a
   * surveyed house, whose own walls stop at the ground floor's eaves.
   * Herculaneum keeps these in carbonised wood; Pompeii's burnt or rotted.
   */
  function upperFloor(ax: number, az: number, bx: number, bz: number, ex: number, ez: number, ox: number, oz: number, y0: number, y1: number,
    col: RGB, seed: number, o: { jetty: boolean; craticium: boolean; roofed: boolean; p1?: number; g?: number; depth?: number; jettyM?: number; posts?: boolean }): void {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 2) return;
    const WOOD: RGB = [0.24, 0.16, 0.1];
    const J = o.jetty ? (o.jettyM ?? 0.65) : 0;
    // A deep jetty stands on posts at the kerb (the Trellis House's on brick piers).
    if (o.posts && J > 0.9) {
      const gp = o.g ?? y0 - 4.8;
      const np = Math.max(2, Math.round(L / 3));
      for (let k = 0; k <= np; k++) {
        const u = 0.25 + ((L - 0.5) * k) / np;
        const cx = ax + ex * u + ox * (J - 0.2), cz = az + ez * u + oz * (J - 0.2);
        box([cx - 0.22, cz - 0.22, cx + 0.22, cz - 0.22, cx + 0.22, cz + 0.22, cx - 0.22, cz + 0.22], gp - 0.3, y0 - 0.05, [0.6, 0.32, 0.22], seed, Surf.Masonry, Surf.Masonry);
      }
    }
    const g = o.g ?? y0 - 4.8;
    const p1 = o.p1 ?? 100;
    const a: [number, number] = [ax + ox * J, az + oz * J], b: [number, number] = [bx + ox * J, bz + oz * J];
    const H = y1 - g;
    stats.timberFloors++;
    // The upper wall: plaster with the upstairs windows, or the timber frame.
    if (o.craticium) wall(a[0] + ox * 0.03, a[1] + oz * 0.03, b[0] + ox * 0.03, b[1] + oz * 0.03, y0 + 0.25, y0 + 0.25, y1, y1, ox, oz, [0.8, 0.74, 0.62], seed, Surf.Craticium, 0, 0, 0, L, y0 + 0.25, y1 - y0 - 0.25);
    else if (o.jetty || o.roofed) wall(a[0], a[1], b[0], b[1], y0, y0, y1, y1, ox, oz, col, seed, Surf.Plaster, p1, 0, 0, L, g, H);
    // The floor beam across the front, a little proud.
    const k = 0.08;
    wall(a[0] + ox * k, a[1] + oz * k, b[0] + ox * k, b[1] + oz * k, y0 - 0.05, y0 - 0.05, y0 + 0.25, y0 + 0.25, ox, oz, WOOD, seed, Surf.Wood, 0, 0, 0, L, y0, 0.3);
    if (o.jetty) {
      // The soffit under the jetty and the cheeks closing its ends.
      poly(S, [[ax, y0 - 0.05, az], [bx, y0 - 0.05, bz], [b[0], y0 - 0.05, b[1]], [a[0], y0 - 0.05, a[1]]], [0, -1, 0], WOOD, seed, Surf.Wood, 0, 0, uv4());
      wall(ax, az, a[0], a[1], y0 - 0.05, y0 - 0.05, y1, y1, -ex, -ez, WOOD, seed, Surf.Wood, 0, 0, 0, J, y0, y1 - y0);
      wall(b[0], b[1], bx, bz, y0 - 0.05, y0 - 0.05, y1, y1, ex, ez, WOOD, seed, Surf.Wood, 0, 0, 0, J, y0, y1 - y0);
    }
    // Joist ends under the floor beam, every 0.7 m.
    if (!lean) {
      for (let u = 0.35; u < L - 0.2; u += 0.7) {
        const cx = ax + ex * u + ox * (J + 0.08), cz = az + ez * u + oz * (J + 0.08);
        const q = [cx - ex * 0.08, cz - ez * 0.08, cx + ex * 0.08, cz + ez * 0.08, cx + ex * 0.08 + ox * 0.22, cz + ez * 0.08 + oz * 0.22, cx - ex * 0.08 + ox * 0.22, cz - ez * 0.08 + oz * 0.22];
        box(q, y0 - 0.3, y0 - 0.05, WOOD, seed, Surf.Wood);
      }
    }
    if (!o.roofed) return;
    // The storey as a strip over the house: back wall, ends, and a tiled roof
    // falling to the street and to the court behind.
    const D = o.depth ?? 4.4;
    const c: [number, number] = [bx - ox * D, bz - oz * D], d: [number, number] = [ax - ox * D, az - oz * D];
    const sideC: RGB = [col[0] * 0.5 + 0.43, col[1] * 0.5 + 0.4, col[2] * 0.5 + 0.34];
    wall(c[0], c[1], d[0], d[1], y0 - 1.2, y0 - 1.2, y1, y1, -ox, -oz, sideC, seed, Surf.Plaster, p1, 255, 0, L, g, H);
    wall(b[0], b[1], c[0], c[1], y0 - 1.2, y0 - 1.2, y1, y1, ex, ez, sideC, seed, Surf.Plaster, p1, 255, 0, D + J, g, H);
    wall(d[0], d[1], a[0], a[1], y0 - 1.2, y0 - 1.2, y1, y1, -ex, -ez, sideC, seed, Surf.Plaster, p1, 255, 0, D + J, g, H);
    const rise = ((D + J) / 2) * TAN_PITCH, OH = 0.4;
    const tileC: RGB = [0.6 + hash(seed * 1e6, 7) * 0.12, 0.29 + hash(seed * 1e6, 8) * 0.06, 0.18 + hash(seed * 1e6, 9) * 0.05];
    const r0: V3 = [(a[0] + d[0]) / 2, y1 + rise, (a[1] + d[1]) / 2], r1: V3 = [(b[0] + c[0]) / 2, y1 + rise, (b[1] + c[1]) / 2];
    const ea: V3 = [a[0] + ox * OH, y1 - OH * TAN_PITCH, a[1] + oz * OH], eb: V3 = [b[0] + ox * OH, y1 - OH * TAN_PITCH, b[1] + oz * OH];
    const ec: V3 = [c[0] - ox * OH, y1 - OH * TAN_PITCH, c[1] - oz * OH], ed: V3 = [d[0] - ox * OH, y1 - OH * TAN_PITCH, d[1] - oz * OH];
    const half = (D + J) / 2 + OH;
    poly(S, [ea, eb, r1, r0], [ox, 1, oz], tileC, seed, Surf.Tile, 0, 0, [[0, 0, L, half], [L, 0, L, half], [L, half, L, half], [0, half, L, half]]);
    poly(S, [ec, ed, r0, r1], [-ox, 1, -oz], tileC, seed, Surf.Tile, 0, 0, [[0, 0, L, half], [L, 0, L, half], [L, half, L, half], [0, half, L, half]]);
    poly(S, [[b[0], y1, b[1]], [c[0], y1, c[1]], r1], [ex, 0, ez], sideC, seed, Surf.Plaster, p1, 255, uv4());
    poly(S, [[d[0], y1, d[1]], [a[0], y1, a[1]], r0], [-ex, 0, -ez], sideC, seed, Surf.Plaster, p1, 255, uv4());
    poly(S, [ea, eb, [b[0], y1, b[1]], [a[0], y1, a[1]]], [ox * 0.3, -1, oz * 0.3], WOOD, seed, Surf.Wood, 0, 0, uv4());
  }

  /** "open": a doorway onto a fauces passage built by the house, no door in it. */
  interface Opening { u0: number; u1: number; h: number; kind: "shop" | "door" | "open" }

  /**
   * A band of a lot: quad a,b (front) to c,d (back). Walls from the ground to
   * `H` above the floor `g`, a roof of the given form, the street facade with
   * its openings when `street`.
   */
  function band(a: [number, number], b: [number, number], c: [number, number], d: [number, number], g: number, yBot: number, H: number,
    roof: "gable" | "compluvium" | "lean" | "flat", col: RGB, tileC: RGB, seed: number, p1: number, p2: number, openings: Opening[], street: boolean, portico = false, dress: Dress = {}): void {
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
    // An upper floor on the street often had a timber balcony (maenianum)
    // over the pavement, under its own pent roof: the Casa del Balcone
    // Pensile is named for one.
    const balcony = street && !grey && !lean && H > 7 && fl > 5 && hash(s * 1e6, 33) < town.style.balcony;
    // Front facade.
    if (street && openings.length && !grey) facade(a, b, g, yBot, wallTop, ox, oz, col, s, p1, p2, openings, depth, { ...dress, balcony, room: (x, z, ix, iz) => rayToRing([...a, ...b, ...c, ...d], x + ix * 0.05, z + iz * 0.05, ix, iz) });
    // Herculaneum's upper floors: timber, often jettied out over the street.
    if (street && !grey && H > 7 && fl > 3 && town.style.timber) {
      const fx = (b[0] - a[0]) / fl, fz = (b[1] - a[1]) / fl;
      upperFloor(a[0], a[1], b[0], b[1], fx, fz, ox, oz, g + H - 3.4, top, col, s, { jetty: !balcony && hash(s * 1e6, 34) < 0.5, craticium: hash(s * 1e6, 35) < 0.25, roofed: false, p1, g });
    }
    if (balcony) {
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
    // A wall p..q in up to three pieces round a doorway t0..t1 metres from p, h high.
    const gapped = (p: [number, number], q: [number, number], gap: [number, number, number] | undefined, draw: (x0: number, z0: number, x1: number, z1: number, y0: number, u0: number) => void): void => {
      if (!gap) { draw(p[0], p[1], q[0], q[1], yBot, 0); return; }
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const at = (t: number): [number, number] => [p[0] + ((q[0] - p[0]) * t) / L, p[1] + ((q[1] - p[1]) * t) / L];
      const [x0, z0] = at(gap[0]), [x1, z1] = at(gap[1]);
      draw(p[0], p[1], x0, z0, yBot, 0);
      draw(x0, z0, x1, z1, g + gap[2], gap[0]);
      draw(x1, z1, q[0], q[1], yBot, gap[1]);
    };
    if (!(street && openings.length && !grey)) gapped(a, b, dress.gapFront, (x0, z0, x1, z1, y0, u0) => wall(x0, z0, x1, z1, y0, y0, wallTop, wallTop, ox, oz, col, s, Surf.Plaster, p1, p2, u0, fl, g, wallTop - g));
    // Back and sides, all plastered (seen across gardens and over lower roofs).
    const sideC: RGB = [col[0] * 0.5 + 0.43, col[1] * 0.5 + 0.4, col[2] * 0.5 + 0.34];
    const bl = Math.hypot(c[0] - d[0], c[1] - d[1]);
    gapped(d, c, dress.gapBack, (x0, z0, x1, z1, y0, u0) => wall(x1, z1, x0, z0, y0, y0, wallTop, wallTop, -ox, -oz, sideC, s, Surf.Plaster, p1, 255, bl - u0 - Math.hypot(x1 - x0, z1 - z0), bl, g, wallTop - g));
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
    const OH = EAVE_M;
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
      if (street) eaveTrim(a, b, ea, eb, top, ox, oz, tileC, s, !!dress.main);
      // Gable ends, plastered.
      poly(S, [[b[0], top, b[1]], [c[0], top, c[1]], r1], [s1x, 0, s1z], sideC, s, Surf.Plaster, p1, 255, [[0, H, depth, H + rise], [depth, H, depth, H + rise], [depth / 2, H + rise, depth, H + rise]]);
      poly(S, [[d[0], top, d[1]], [a[0], top, a[1]], r0], [s2x, 0, s2z], sideC, s, Surf.Plaster, p1, 255, [[0, H, depth, H + rise], [depth, H, depth, H + rise], [depth / 2, H + rise, depth, H + rise]]);
      if (portico && !lean) porticoBehind(c, d, g, top, -ox, -oz, tileC, s);
    } else if (roof === "lean") {
      // Mono-pitch falling to the street.
      const hb = top + Math.min(2.2, depth * TAN_PITCH * 0.6);
      const ea = eave(a, 1), eb = eave(b, 1);
      poly(S, [ea, eb, [c[0], hb, c[1]], [d[0], hb, d[1]]], [ox, 1, oz], tileC, s, Surf.Tile, 0, 0, [[0, 0, fl, depth], [fl, 0, fl, depth], [fl, depth, fl, depth], [0, depth, fl, depth]]);
      if (street) eaveTrim(a, b, ea, eb, top, ox, oz, tileC, s, !!dress.main);
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
        if (dress.atrium) {
          // The room under it: the slope's boarded underside, the tile ends
          // and a spout over the opening; the walls stand at the band's edge.
          roomQuad([[p[0], hi, p[1]], [q[0], hi, q[1]], [qi[0], lo, qi[1]], [pi[0], lo, pi[1]]], [-inx / il, -1, -inz / il], [0.36, 0.24, 0.14], s, Surf.Ceiling, dress.atrium.rich ? CeilingKind.Coffers : CeilingKind.Joists);
          const Li = Math.hypot(qi[0] - pi[0], qi[1] - pi[1]);
          poly(S, [[pi[0], lo, pi[1]], [qi[0], lo, qi[1]], [qi[0], lo - 0.14, qi[1]], [pi[0], lo - 0.14, pi[1]]], [inx / il, 0, inz / il], tileC, s, Surf.Tile, 0, 0,
            [[0, 0.14, Li, 0.14], [Li, 0.14, Li, 0.14], [Li, 0, Li, 0.14], [0, 0, Li, 0.14]]);
          if (dress.atrium.rich) spout(S, (pi[0] + qi[0]) / 2, lo - 0.08, (pi[1] + qi[1]) / 2, inx / il, inz / il, [tileC[0] * 1.05, tileC[1] * 1.1, tileC[2] * 1.1], s);
          continue;
        }
        // The light well: the atrium's walls seen through the opening.
        const wl = Math.hypot(qi[0] - pi[0], qi[1] - pi[1]);
        // The light well: the atrium's walls seen through the opening, in one
        // of the restored wall schemes (the procedural one with the art off).
        if (art) {
          const sch = ATRIUM_SCHEMES[Math.floor(hash(s * 1e6, 61) * ATRIUM_SCHEMES.length)];
          wall(pi[0], pi[1], qi[0], qi[1], g, g, lo, lo, -inx / il, -inz / il, ART_WORKS[sch].ground, s, Surf.Art, sch, 1, 0, wl, g, lo - g);
        } else wall(pi[0], pi[1], qi[0], qi[1], g, g, lo, lo, -inx / il, -inz / il, [0.55, 0.12, 0.08], s, Surf.Fresco, 0, 0, 0, wl, g, lo - g);
      }
      const fk = hash(s * 1e6, 72) < 0.25 ? FloorKind.BlackField : hash(s * 1e6, 72) < 0.6 ? FloorKind.SigninumNet : FloorKind.SigninumMeander;
      if (!dress.atrium) {
        roomQuad(inner.map((p): V3 => [p[0], g + 0.02, p[1]]), [0, 1, 0], [0.55, 0.38, 0.3], s, Surf.Floor, fk);
        lampSites.courts.push({ ring: inner.flat(), g, garden: false });
        const pool = inner.map((p): V3 => [mx + (p[0] - mx) * 0.6, g + 0.06, mz + (p[1] - mz) * 0.6]);
        const op = impluvium(pool, mx, mz, g, lo, Math.sqrt(Math.abs(ringArea(inner.flat())) / Math.PI));
        poly(S, pool, [0, 1, 0], [0.2, 0.32, 0.34], s, Surf.Water, op[0], op[1], pool.map((p) => [p[0], p[2], mx, mz]));
        return;
      }
      // The atrium as a room: painted walls a wall's thickness in from the
      // band's edge, up to the roof's underside, with the fauces door and the
      // tablinum's opening cut in them; the floor over the whole of it; the
      // pool under the opening; the puteal and the table at its head.
      const at = dress.atrium;
      const T = 0.25;
      const room = outer.map((p, i): [number, number] => {
        const nx1 = outer[(i + 1) % 4], pv = outer[(i + 3) % 4];
        const l1 = Math.hypot(nx1[0] - p[0], nx1[1] - p[1]) || 1, l2 = Math.hypot(pv[0] - p[0], pv[1] - p[1]) || 1;
        return [p[0] + ((nx1[0] - p[0]) / l1 + (pv[0] - p[0]) / l2) * T, p[1] + ((nx1[1] - p[1]) / l1 + (pv[1] - p[1]) / l2) * T];
      });
      const gf = floorOver(g, room);
      const yTop = hi - T * TAN_PITCH;
      const code = 1 + Math.floor(hash(s * 1e6, 85) * 199);
      const sch = art && hash(s * 1e6, 86) < 0.35 ? ATRIUM_SCHEMES[Math.floor(hash(s * 1e6, 61) * ATRIUM_SCHEMES.length)] : -1;
      // Room corners: 0 front-left (a), 1 front-right (b), 2 back-right (c), 3 back-left (d).
      const side = (i: number, j: number, gap: [number, number] | null, gh: number): void => {
        const p = room[i], q = room[j];
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const fx = mx - (p[0] + q[0]) / 2, fz = mz - (p[1] + q[1]) / 2, fn = Math.hypot(fx, fz) || 1;
        const piece = (t0: number, t1: number, y0: number): void => {
          if (t1 - t0 < 0.02) return;
          const x0 = p[0] + ((q[0] - p[0]) * t0) / L, z0 = p[1] + ((q[1] - p[1]) * t0) / L, x1 = p[0] + ((q[0] - p[0]) * t1) / L, z1 = p[1] + ((q[1] - p[1]) * t1) / L;
          if (sch >= 0) wall(x0, z0, x1, z1, y0, y0, yTop, yTop, fx / fn, fz / fn, ART_WORKS[sch].ground, s, Surf.Art, sch, 1, t0, L, gf, yTop - gf);
          else wall(x0, z0, x1, z1, y0, y0, yTop, yTop, fx / fn, fz / fn, [0.55, 0.12, 0.08], s, Surf.Fresco, code, 0, t0, L, gf, yTop - gf);
        };
        if (!gap) { piece(0, L, gf - 0.1); return; }
        const g0 = Math.max(0, gap[0] - T), g1 = Math.min(L, gap[1] - T);
        piece(0, g0, gf - 0.1); piece(g0, g1, gf + gh); piece(g1, L, gf - 0.1);
      };
      side(0, 1, at.door, 3.4);
      side(1, 2, null, 0);
      // The back runs d to c here, as dress.atrium.tablinum is measured.
      side(3, 2, at.tablinum, Math.min(yTop - gf - 0.3, 4.2));
      side(3, 0, null, 0);
      roomQuad(room.map((p): V3 => [p[0], gf, p[1]]), [0, 1, 0], [0.55, 0.38, 0.3], s, Surf.Floor, at.rich ? FloorKind.BlackWhite : fk);
      lampSites.courts.push({ ring: inner.flat(), g: gf, garden: false });
      const pool = inner.map((p): V3 => [mx + (p[0] - mx) * 0.85, gf + 0.04, mz + (p[1] - mz) * 0.85]);
      const op = impluvium(pool, mx, mz, gf, lo, Math.sqrt(Math.abs(ringArea(inner.flat())) / Math.PI));
      poly(S, pool, [0, 1, 0], [0.2, 0.32, 0.34], s, Surf.Water, op[0], op[1], pool.map((p) => [p[0], p[2], mx, mz]));
      // The furniture: toward the back of the room (ox, oz is out to the street).
      let hd = 0, hw = 0;
      const ux = fx, uz = fz;
      for (const p of pool) { hd = Math.max(hd, -((p[0] - mx) * ox + (p[2] - mz) * oz)); hw = Math.max(hw, (p[0] - mx) * ux + (p[2] - mz) * uz); }
      const inRoom = (x: number, z: number, r: number): boolean => pointInRing(room.flat(), x, z) && distToRing(room.flat(), x, z) > r;
      const tx = mx - ox * (hd + 0.75), tz = mz - oz * (hd + 0.75);
      if (hash(s * 1e6, 87) < 0.35 && inRoom(tx, tz, 0.45)) cartibulum(S, tx, gf, tz, Math.atan2(-uz, ux), s);
      const px = mx + ux * (hw + 0.55), pz = mz + uz * (hw + 0.55);
      if (hash(s * 1e6, 88) < 0.45 && inRoom(px, pz, 0.4)) puteal(S, px, gf, pz, s);
      if (hash(s * 1e6, 89) < 0.4) {
        // The lararium against the left wall, two thirds of the way back.
        const p = room[0], q = room[3];
        const lx = p[0] + (q[0] - p[0]) * 0.66 + ux * 0.02, lz = p[1] + (q[1] - p[1]) * 0.66 + uz * 0.02;
        lararium(S, lx, gf, lz, Math.atan2(ux, uz), s);
      }
    }
  }

  /**
   * What the street sees of a roof that overhangs the wall a..b (top `top`)
   * out to the eave ea..eb: the boarded soffit, the tile ends along the edge,
   * rafter tails under it and an antefix over every other imbrex row.
   */
  function eaveTrim(a: [number, number], b: [number, number], ea: V3, eb: V3, top: number, ox: number, oz: number, tileC: RGB, seed: number, rafters: boolean): void {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.5) return;
    poly(S, [ea, eb, [b[0], top, b[1]], [a[0], top, a[1]]], [ox * 0.3, -1, oz * 0.3], [0.32, 0.22, 0.14], seed, Surf.Wood, 0, 0, uv4());
    // The tile ends: the terracotta shader's imbrex rows, run along the edge.
    const T = 0.12;
    poly(S, [ea, eb, [eb[0], eb[1] - T, eb[2]], [ea[0], ea[1] - T, ea[2]]], [ox, 0, oz], tileC, seed, Surf.Tile, 0, 0,
      [[0, T, L, T], [L, T, L, T], [L, 0, L, T], [0, 0, L, T]]);
    // The phone build stops at the soffit and the tile ends.
    if (lean) return;
    const F: Frame = { ax: a[0], az: a[1], ex: (b[0] - a[0]) / L, ez: (b[1] - a[1]) / L, ox, oz };
    const OH = (ea[0] - a[0]) * ox + (ea[2] - a[1]) * oz, slope = (top - ea[1]) / OH;
    const rafter: RGB = [0.3, 0.2, 0.12], ante: RGB = [tileC[0] * 1.08, tileC[1] * 1.1, tileC[2] * 1.1];
    // The main streets and the named houses get rafter tails and shaped
    // antefixes; the side streets plain ones further apart (a quarter of the
    // triangles, and seen only down a narrow lane).
    const ye = top - OH * slope - 0.02, ve = OH + 0.01;
    for (let u = 0.42; u < L - 0.15; u += rafters ? 0.84 : 1.26) {
      if (!rafters) {
        poly(S, [fp(F, u - 0.08, ve, ye), fp(F, u + 0.08, ve, ye), fp(F, u, ve, ye + 0.11)], [ox, 0, oz], ante, seed, Surf.Pavement, 0, 0, [NO_UV, NO_UV, NO_UV]);
        continue;
      }
      // A rafter tail: its top under the soffit, cut square at the end.
      const v1 = OH - 0.04, rh = 0.11, rw = 0.045;
      const y = (v: number): number => top - v * slope;
      const c = (du: number, v: number, dy: number): V3 => fp(F, u + du, v, y(v) - dy);
      poly(S, [c(-rw, 0, rh), c(rw, 0, rh), c(rw, v1, rh), c(-rw, v1, rh)], [0, -1, 0], rafter, seed, Surf.Wood, 0, 0, uv4());
      poly(S, [c(-rw, v1, 0), c(rw, v1, 0), c(rw, v1, rh), c(-rw, v1, rh)], [ox, 0, oz], rafter, seed, Surf.Wood, 0, 0, uv4());
      poly(S, [c(-rw, 0, 0), c(-rw, v1, 0), c(-rw, v1, rh), c(-rw, 0, rh)], [-F.ex, 0, -F.ez], rafter, seed, Surf.Wood, 0, 0, uv4());
      poly(S, [c(rw, 0, 0), c(rw, v1, 0), c(rw, v1, rh), c(rw, 0, rh)], [F.ex, 0, F.ez], rafter, seed, Surf.Wood, 0, 0, uv4());
      // An antefix standing on the eave over the imbrex row's end.
      poly(S, [fp(F, u - 0.08, ve, ye), fp(F, u + 0.08, ve, ye), fp(F, u + 0.065, ve, ye + 0.06), fp(F, u, ve, ye + 0.12), fp(F, u - 0.065, ve, ye + 0.06)],
        [ox, 0, oz], ante, seed, Surf.Pavement, 0, 0, [NO_UV, NO_UV, NO_UV, NO_UV, NO_UV]);
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
    // The walk and its roof stay inside the block, off its edge and off a
    // surveyed house: a lot whose back is near another street (a corner, a
    // shallow block) put its colonnade out on that street's pavement.
    const keep = (x: number, z: number): boolean => { const ins = insAt(x, z); return !!ins && distToRing(ins.ring, x, z) > 1.2 && !houseAt(x, z); };
    if (!opts.probePorticoOut) for (const p of [d, c]) if (!keep(p[0] + ox * (W + 0.4), p[1] + oz * (W + 0.4)) || !keep(p[0] + ox * 6, p[1] + oz * 6)) return;
    const tx = (c[0] - d[0]) / L, tz = (c[1] - d[1]) / L;
    const n = Math.max(2, Math.round(L / 2.8));
    if (!opts.probePorticoOut) for (let i = 0; i <= n; i++) { const t = 0.6 + ((L - 1.2) * i) / n; if (!keep(d[0] + tx * t + ox * W, d[1] + tz * t + oz * W)) return; }
    for (let i = 0; i <= n; i++) {
      const t = 0.6 + ((L - 1.2) * i) / n;
      column(d[0] + tx * t + ox * W, d[1] + tz * t + oz * W, g, colH, 0.2, [0.86, 0.82, 0.74], seed, 6, hash(seed * 1e6, 21) < 0.7, houseOrder(seed));
    }
    {
      // The beam over the capitals up to the roof, and the stylobate they stand on.
      const yr = Math.min(top - 0.3, g + colH + 1.3) + (0.25 - Math.min(top - 0.3, g + colH + 1.3) + g + colH) * (W / (W + 0.4)) + 0.03;
      const B = (t: number, v: number): number[] => [d[0] + tx * t + ox * v, d[1] + tz * t + oz * v];
      box([...B(0.3, W - 0.18), ...B(L - 0.3, W - 0.18), ...B(L - 0.3, W + 0.18), ...B(0.3, W + 0.18)], g + colH, yr, [0.86, 0.82, 0.74], seed, Surf.Stucco, Surf.Stucco, [0.86, 0.82, 0.74], !opts.probeOpenBeams);
      const gl = Math.min(ground(...(B(0.3, W) as [number, number])), ground(...(B(L - 0.3, W) as [number, number])));
      if (!opts.probeOpenBeams) box([...B(0.25, W - 0.3), ...B(L - 0.25, W - 0.3), ...B(L - 0.25, W + 0.3), ...B(0.25, W + 0.3)], gl - 0.2, g, [0.6, 0.56, 0.46], seed, Surf.Kerb, Surf.Kerb, [0.62, 0.58, 0.5], false);
    }
    const y0 = Math.min(top - 0.3, g + colH + 1.3), y1 = g + colH + 0.25;
    const p0: V3 = [d[0], y0, d[1]], p1: V3 = [c[0], y0, c[1]];
    const p2: V3 = [c[0] + ox * (W + 0.4), y1, c[1] + oz * (W + 0.4)], p3: V3 = [d[0] + ox * (W + 0.4), y1, d[1] + oz * (W + 0.4)];
    poly(S, [p0, p1, p2, p3], [ox, 1, oz], tileC, seed, Surf.Tile, 0, 0, [[0, W, L, W], [L, W, L, W], [L, 0, L, W], [0, 0, L, W]]);
    poly(S, [p3, p2, [p2[0], y1 - 0.4, p2[2]], [p3[0], y1 - 0.4, p3[2]]], [ox, 0, oz], [0.86, 0.82, 0.74], seed, Surf.Stucco, 0, 0, uv4());
  }

  /** What a street front is dressed with beyond its openings (full builds only). */
  interface Dress {
    /** On a main street: pent roofs and awnings over the shops, more wares outside. */
    main?: boolean;
    /** A named house: tuff pilasters with cubic capitals round the door. */
    rich?: boolean;
    /** A house front: sometimes a masonry bench by the door. */
    house?: boolean;
    /** An atrium house's front: sometimes pilasters round the door. */
    grand?: boolean;
    /** A balcony runs over this front, so no pent roof under it. */
    balcony?: boolean;
    /** How far in from a point on the front, along (ix, iz), the building goes: how deep a room behind an opening can be. */
    room?: (x: number, z: number, ix: number, iz: number) => number;
    /** A doorway through a band's plain front wall: metres from a along a..b, and its height (the atrium's fauces, the tablinum). */
    gapFront?: [number, number, number];
    /** The same through its back wall, metres from d along d..c. */
    gapBack?: [number, number, number];
    /** An atrium band built as a room (the full build): its door from the fauces and the tablinum's opening, metres from a and d. */
    atrium?: { door: [number, number]; tablinum: [number, number] | null; rich: boolean };
  }

  /**
   * A street facade with its openings: piers, lintels, and behind each
   * opening a recess (a shop's dark room with its counter, or a doorway with
   * the wooden door set back).
   */
  function facade(a: [number, number], b: [number, number], g: number, yBot: number, top: number, ox: number, oz: number,
    col: RGB, seed: number, p1: number, p2: number, openings: Opening[], depth: number, dress: Dress = {}): void {
    const fl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ex = (b[0] - a[0]) / fl, ez = (b[1] - a[1]) / fl;
    const F: Frame = { ax: a[0], az: a[1], ex, ez, ox, oz };
    const P = (u: number): [number, number] => [a[0] + ex * u, a[1] + ez * u];
    const H = top - g;
    const sorted = [...openings].sort((p, q) => p.u0 - q.u0);
    // The phone (lean) build keeps what reads from the street per triangle: door
    // leaves, beams, sills, counters, shutters and shop roofs; the jars,
    // stock, benches, pilasters and open doors are the full build's.
    const dressed = !grey, full = dressed && !lean;
    // Props are not roof: the collapse (surf.w) is only for the pent roofs.
    const tag = S.tag;
    let u = 0;
    sorted.forEach((o, oi) => {
      if (o.u0 > u + 0.01) {
        const [x0, z0] = P(u), [x1, z1] = P(o.u0);
        wall(x0, z0, x1, z1, yBot, yBot, top, top, ox, oz, col, seed, Surf.Plaster, p1, p2, u, fl, g, H);
      }
      const [x0, z0] = P(o.u0), [x1, z1] = P(o.u1);
      // Lintel over the opening.
      wall(x0, z0, x1, z1, g + o.h, g + o.h, top, top, ox, oz, col, seed, Surf.Plaster, p1, p2, o.u0, fl, g, H);
      u = o.u1;
      const r = (k: number): number => hash(seed * 1e6, 40 + oi * 7, k);
      const leftFree = o.u0 - (oi > 0 ? sorted[oi - 1].u1 : 0), rightFree = (oi + 1 < sorted.length ? sorted[oi + 1].u0 : fl) - o.u1;
      const pave = pavementAt((x0 + x1) / 2, (z0 + z1) / 2, ox, oz);
      if (full && o.kind !== "shop") {
        S.tag = 0;
        doorFrame(F, o, g, leftFree, rightFree, pave, dress, r);
        S.tag = tag;
      }
      if (o.kind === "open") {
        // An open fauces still had its lamp hung inside the door, as a closed door's recess does.
        if (dress.grand) lampSites.openings.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, g, ox, oz, ex, ez, w: o.u1 - o.u0, h: o.h, depth: 0.55, kind: "door", counter: false });
        return;
      }
      // The room behind, measured at both jambs: a skewed lot is shallower
      // at one end than its mean depth, and a recess cut to the mean came
      // out through the back wall onto the next street.
      const room = (uu: number): number => { const [px, pz] = P(uu); const t = dress.room ? dress.room(px, pz, -ox, -oz) : NaN; return Number.isFinite(t) && t > 0 ? t : depth; };
      const deep = Math.min(depth, room(o.u0), room(o.u1));
      const rd = o.kind === "shop" ? Math.max(0.8, Math.min(3.6, deep - 0.6)) : 0.55;
      const ix = -ox * rd, iz = -oz * rd;
      const w = o.u1 - o.u0;
      const inC: RGB = o.kind === "shop" ? [0.62, 0.52, 0.4] : [0.6, 0.5, 0.42];
      // An open door shows a passage behind it; there has to be room for one.
      const vd = o.kind === "door" && full && r(1) < 0.3 ? Math.min(3, deep - rd - 0.8) : 0;
      const reach = rd + Math.max(0, vd);
      const gf = floorOver(g, [[x0, z0], [x1, z1], [x1 - ox * reach, z1 - oz * reach], [x0 - ox * reach, z0 - oz * reach]]);
      lampSites.openings.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, g: gf, ox, oz, ex, ez, w, h: g + o.h - gf, depth: rd, kind: o.kind, counter: o.kind === "shop" && !grey });
      // Reveals, back, ceiling, floor.
      wall(x0, z0, x0 + ix, z0 + iz, g, g, g + o.h, g + o.h, ex, ez, inC, seed, Surf.Interior, 0, 0, 0, rd, g, o.h);
      wall(x1 + ix, z1 + iz, x1, z1, g, g, g + o.h, g + o.h, -ex, -ez, inC, seed, Surf.Interior, 0, 0, 0, rd, g, o.h);
      if (o.kind === "shop") {
        wall(x0 + ix, z0 + iz, x1 + ix, z1 + iz, g, g, g + o.h, g + o.h, ox, oz, inC, seed, Surf.Interior, 1, 0, 0, rd, g, o.h);
        poly(S, [[x0, g + o.h, z0], [x1, g + o.h, z1], [x1 + ix, g + o.h, z1 + iz], [x0 + ix, g + o.h, z0 + iz]], [0, -1, 0], [0.4, 0.3, 0.22], seed, Surf.Wood, 0, 0, uv4());
        if (!grey) counters.push({ F, u0: o.u0, w, g: gf, seed: r(0) });
        if (dressed) {
          S.tag = 0;
          shopDress(F, o, g, gf, rd, leftFree, rightFree, pave, !!dress.main, r);
          S.tag = tag;
          if (dress.main && !dress.balcony && !lean) shopRoof(F, o, g, fl, pave, r);
        }
      } else if (!dressed) {
        wall(x0 + ix, z0 + iz, x1 + ix, z1 + iz, g, g, g + o.h, g + o.h, ox, oz, [0.42, 0.27, 0.15], seed, Surf.Wood, 0, 0, 0, w, g, o.h);
      } else {
        S.tag = 0;
        doorLeaves(F, o, g, gf, rd, vd, seed, r);
        S.tag = tag;
      }
      if (o.kind !== "shop") poly(S, [[x0, g + o.h, z0], [x1, g + o.h, z1], [x1 + ix, g + o.h, z1 + iz], [x0 + ix, g + o.h, z0 + iz]], [0, -1, 0], inC, seed, Surf.Interior, 0, 0, uv4());
      if (dressed && o.kind === "door") {
        // A stone sill out to the pavement and the raised threshold the
        // leaves close against.
        fbox(F, o.u0, o.u1, -rd, 0.06, gf - 0.2, gf + 0.04, [0.54, 0.52, 0.48], seed, Surf.Kerb, { skip: FB.Back | FB.End0 | FB.End1 });
        fbox(F, o.u0, o.u1, -rd - 0.01, -rd + 0.14, gf + 0.04, gf + 0.13, [0.36, 0.34, 0.32], seed, Surf.Kerb, { skip: FB.Back | FB.End0 | FB.End1 });
      } else {
        // Behind the sill where there is one: under it the floor and the sunk groove were millimetres apart.
        // With no sill the floor runs 6 cm out past the facade line onto the
        // pavement with a step face: the lot fronts stand on the simplified
        // block outline, a few centimetres inside the block slab's, and the
        // green of the slab showed in that sliver at every threshold.
        if (dressed && o.kind === "shop") {
          const sx = -ox * 0.36, sz = -oz * 0.36;
          poly(S, [[x0 + sx, gf, z0 + sz], [x1 + sx, gf, z1 + sz], [x1 + ix, gf, z1 + iz], [x0 + ix, gf, z0 + iz]], [0, 1, 0], [0.5, 0.45, 0.4], seed, Surf.Pavement, 0, 0, uv4());
        } else fbox(F, o.u0, o.u1, -rd, 0.06, gf - 0.2, gf, [0.5, 0.45, 0.4], seed, Surf.Pavement, { skip: FB.Back | FB.End0 | FB.End1, front: [Surf.Kerb, 0, 0, [0.54, 0.52, 0.48]] });
      }
    });
    if (u < fl - 0.01) {
      const [x0, z0] = P(u);
      wall(x0, z0, b[0], b[1], yBot, yBot, top, top, ox, oz, col, seed, Surf.Plaster, p1, p2, u, fl, g, H);
    }
  }

  /** Pilasters round a house door, and a bench beside some. */
  function doorFrame(F: Frame, o: Opening, g: number, leftFree: number, rightFree: number, pave: number, dress: Dress, r: (k: number) => number): void {
    const seed = r(20);
    if ((dress.rich || (dress.grand && r(12) < 0.3)) && leftFree > 0.6 && rightFree > 0.6) {
      // Tuff pilasters with cubic capitals carrying the lintel, as on the
      // Casa del Fauno and the Casa di Pansa.
      // On a lane whose walkers pass close to the wall they stand flatter.
      const k = clearAt(F, [[o.u0 - 0.47, 0.2], [o.u1 + 0.47, 0.2]], 0.2) ? 1 : 0.45;
      const tuff: RGB = [0.6, 0.56, 0.46], cap: RGB = [0.68, 0.64, 0.54];
      for (const [pa, pb] of [[o.u0 - 0.42, o.u0 - 0.04], [o.u1 + 0.04, o.u1 + 0.42]]) {
        fbox(F, pa, pb, -0.02, 0.14 * k, g - 0.3, g + o.h - 0.02, tuff, seed, Surf.Kerb, { skip: FB.Back | FB.Top });
        fbox(F, pa - 0.05, pb + 0.05, -0.02, 0.2 * k, g - 0.3, g + 0.24, tuff, seed, Surf.Kerb, { skip: FB.Back });
        fbox(F, pa - 0.07, pb + 0.07, -0.02, 0.25, g + o.h - 0.02, g + o.h + 0.3, cap, seed, Surf.Kerb, { skip: FB.Back, bottom: true });
      }
    }
    if (dress.house && pave >= WIDE_PAVEMENT_M && r(13) < 0.35) {
      // A masonry bench against the front, for clients waiting on the patron.
      const L = 1.4 + r(14) * 0.6;
      let s0 = NaN;
      if (leftFree > L + 0.85) s0 = o.u0 - 0.6 - L;
      else if (rightFree > L + 0.85) s0 = o.u1 + 0.6;
      if (!Number.isNaN(s0) && clearAt(F, [[s0, 0.42], [s0 + L, 0.42]], 0.25)) {
        fbox(F, s0, s0 + L, -0.02, 0.42, g - 0.3, g + 0.45, [0.5, 0.2, 0.15], seed, Surf.Plaster, { p2: 255, gref: g, topS: Surf.Kerb, topC: [0.62, 0.6, 0.55] });
      }
    }
  }

  /** The timber, stone and stock that make an opening a shop. */
  function shopDress(F: Frame, o: Opening, g: number, gf: number, rd: number, leftFree: number, rightFree: number, pave: number, main: boolean, r: (k: number) => number): void {
    const seed = r(20);
    const u0 = o.u0, u1 = o.u1, w = u1 - u0;
    // The lintel: a timber beam over the opening, its ends bedded in the piers.
    fbox(F, u0 - 0.18, u1 + 0.18, -0.06, 0.06, g + o.h - 0.02, g + o.h + 0.22, [0.36, 0.25, 0.15], seed, Surf.Wood, { skip: FB.Back, bottom: true, flatU: true });
    // The sill: one stone across the opening with the groove the shutter boards stood in.
    // Its top in three strips, the groove sunk between them: a dark quad
    // laid on the stone 2 mm up fought it on a phone.
    const sillC: RGB = [0.54, 0.52, 0.48], gy = gf + 0.04;
    fbox(F, u0, u1, -0.36, 0.06, gf - 0.2, gy, sillC, seed, Surf.Kerb, { skip: FB.Back | FB.End0 | FB.End1 | FB.Top });
    const strip = (v0: number, v1: number, y: number, c: RGB): void => poly(S, [fp(F, u0, v0, y), fp(F, u1, v0, y), fp(F, u1, v1, y), fp(F, u0, v1, y)], [0, 1, 0], c, seed, Surf.Kerb, 0, 0, uv4());
    strip(-0.36, -0.1, gy, sillC);
    strip(-0.1, -0.06, gy - 0.025, [0.12, 0.11, 0.1]);
    strip(-0.06, 0.06, gy, sillC);
    const gap = counterGap(w);
    if (r(2) < 0.4) {
      // Part shut: boards slid along the groove in front of the counter, the doorway left open.
      const cov = (w - gap) * (0.35 + 0.6 * r(3));
      fbox(F, u0 + 0.04, u0 + 0.04 + cov, -0.1, -0.065, gy, g + o.h - 0.02, [0.42, 0.29, 0.17], seed, Surf.Wood, { skip: FB.End0 | FB.Top });
    }
    if (!lean && r(4) < 0.55) {
      // Shelves on the back wall with jars on them, at the heights the
      // shop-interior shader paints its shelves (render/pompeii.ts), so the
      // modelled ones stand on the painted ones.
      for (const [k, sy] of [[0, 1.35], [1, 1.95]] as const) {
        if (sy + 0.35 > o.h) continue;
        fbox(F, u0 + 0.25, u1 - 0.25, -rd, -rd + 0.32, g + sy - 0.04, g + sy, [0.4, 0.28, 0.17], seed, Surf.Wood, { skip: FB.Back | FB.End0 | FB.End1, flatU: true });
        for (let j = 0, ju = u0 + 0.45; ju < u1 - 0.4; j++, ju += 0.55) {
          const jr = r(30 + k * 16 + j);
          if (jr < 0.5) continue;
          const [jx, , jz] = fp(F, ju, -rd + 0.16, 0);
          jar(jx, g + sy, jz, 0.8 + 0.5 * jr, jr);
        }
      }
      // Amphorae leaning in the back corner, away from the counter's doorway.
      const na = 1 + Math.floor(r(5) * 2);
      for (let k = 0; k < na; k++) {
        const [ax, , az] = fp(F, u0 + 0.32 + k * 0.32, -rd + 0.3, 0);
        amphora(leaning([ax, gf, az], -F.ox, -F.oz, 0.2), ax, gf, az, 0.8 + 0.25 * r(6 + k), r(9 + k));
      }
      // A bench down the side wall at the back.
      if (rd > 3) fbox(F, u1 - 0.4, u1, -rd, -2.2, gf, gf + 0.45, [0.6, 0.55, 0.47], seed, Surf.Masonry, { skip: FB.Back | FB.End1, topS: Surf.Wood, topC: [0.4, 0.28, 0.17] });
    }
    // Stock out on the pavement against a pier: amphorae or baskets.
    if (!lean && pave >= WIDE_PAVEMENT_M && r(8) < (main ? 0.35 : 0.12)) {
      const room = rightFree > 1.2 ? 1 : leftFree > 1.2 ? -1 : 0;
      const at = (k: number): number => (room > 0 ? u1 + 0.3 + k * 0.32 : u0 - 0.3 - k * 0.32);
      if (room !== 0 && clearAt(F, [[at(0), 0.55], [at(1.4), 0.55]], 0.25)) {
        if (r(15) < 0.6) {
          for (let k = 0; k < 3; k++) {
            const [ax, , az] = fp(F, at(k), 0.22, 0);
            const y = ground(ax, az) + KERB_M;
            amphora(leaning([ax, y, az], -F.ox, -F.oz, 0.17), ax, y, az, 0.85 + 0.2 * r(16 + k), r(18 + k));
          }
        } else {
          for (let k = 0; k < 2; k++) {
            const [bx, , bz] = fp(F, at(k * 1.4), 0.32, 0);
            basket(bx, ground(bx, bz) + KERB_M, bz, r(21 + k));
          }
        }
      }
    }
  }

  /** The doorway left open between a counter's end and the far pier. */
  function counterGap(w: number): number { return Math.max(0.95, w * 0.28); }

  /**
   * Over a main-street shop: a pent roof of tiles on timber brackets, or a
   * cloth awning on two poles. Both stop short of the walkers' line down the
   * pavement's middle.
   */
  function shopRoof(F: Frame, o: Opening, g: number, fl: number, pave: number, r: (k: number) => number): void {
    const kind = r(11);
    if (kind > 0.75) return;
    const seed = r(20);
    const ua = Math.max(0, o.u0 - 0.25), ub = Math.min(fl, o.u1 + 0.25), L = ub - ua;
    const poles = (Pd: number): boolean => clearAt(F, [[ua + 0.08, Pd], [ub - 0.08, Pd]], 0.3);
    if (kind < 0.45 || pave < WIDE_PAVEMENT_M || !poles(Math.min(2, pave - 0.25))) {
      const Pd = 1.1, y0 = g + o.h + 0.72, y1 = y0 - Pd * TAN_PITCH;
      const q: V3[] = [fp(F, ua, 0, y0), fp(F, ub, 0, y0), fp(F, ub, Pd, y1), fp(F, ua, Pd, y1)];
      const tileC: RGB = [0.62 + r(22) * 0.08, 0.31, 0.2];
      poly(S, q, [F.ox, 1, F.oz], tileC, seed, Surf.Tile, 0, 0, [[0, Pd, L, Pd], [L, Pd, L, Pd], [L, 0, L, Pd], [0, 0, L, Pd]]);
      poly(S, q, [F.ox * 0.3, -1, F.oz * 0.3], [0.36, 0.25, 0.15], seed, Surf.Wood, 0, 0, uv4());
      // The tile ends along the front edge.
      poly(S, [q[3], q[2], [q[2][0], y1 - 0.09, q[2][2]], [q[3][0], y1 - 0.09, q[3][2]]], [F.ox, 0, F.oz], tileC, seed, Surf.Tile, 0, 0,
        [[0, 0, L, 0.1], [L, 0, L, 0.1], [L, 0.09, L, 0.1], [0, 0.09, L, 0.1]]);
      for (const bu of [ua + 0.3, ub - 0.3]) {
        tube(S, fp(F, bu, 0, g + o.h + 0.12), fp(F, bu, Pd - 0.12, y1 - 0.05), 0.045, 0.04, 4, [0.34, 0.23, 0.13], seed, Surf.Wood);
      }
      return;
    }
    // A sagging cloth on a bar, the bar on two poles at the pavement's edge side.
    const Pd = Math.min(2, pave - 0.25), y0 = g + o.h + 0.55, y1 = g + o.h + 0.02;
    const cloth: RGB[] = [[0.8, 0.74, 0.6], [0.62, 0.26, 0.18], [0.7, 0.6, 0.42], [0.45, 0.4, 0.32]];
    const cc = cloth[Math.floor(r(23) * cloth.length)];
    const vm = Pd * 0.55, ym = lerp(y0, y1, 0.55) - 0.14;
    const strips: [number, number, number, number][] = [[0, y0, vm, ym], [vm, ym, Pd, y1]];
    for (const [va, ya, vb, yb] of strips) {
      const q: V3[] = [fp(F, ua, va, ya), fp(F, ub, va, ya), fp(F, ub, vb, yb), fp(F, ua, vb, yb)];
      poly(S, q, [0, 1, 0], cc, seed, Surf.Stucco, 0, 0, uv4());
      poly(S, q, [0, -1, 0], [cc[0] * 0.85, cc[1] * 0.85, cc[2] * 0.85], seed, Surf.Stucco, 0, 0, uv4());
    }
    fbox(F, ua, ub, Pd - 0.04, Pd + 0.02, y1 - 0.08, y1 - 0.03, [0.36, 0.25, 0.15], seed, Surf.Wood, { flatU: true, bottom: true });
    for (const pu of [ua + 0.05, ub - 0.11]) {
      const [px, , pz] = fp(F, pu, Pd, 0);
      fbox(F, pu, pu + 0.06, Pd - 0.05, Pd + 0.01, ground(px, pz) + KERB_M, y1, [0.36, 0.25, 0.15], seed, Surf.Wood, { flatU: true, skip: FB.Top });
    }
  }

  /** Double plank doors: shut, or one leaf swung in on the passage behind. */
  function doorLeaves(F: Frame, o: Opening, g: number, gf: number, rd: number, vd: number, seed: number, r: (k: number) => number): void {
    const u0 = o.u0, u1 = o.u1, mid = (u0 + u1) / 2, hw = (u1 - u0) / 2;
    const y0 = gf + 0.13, y1 = g + o.h;
    const wood: RGB = [0.42 + r(24) * 0.08, 0.27 + r(25) * 0.05, 0.15];
    const leaf = (ua: number, ub: number, c: RGB): void => {
      const pa = fp(F, ua, -rd, 0), pb = fp(F, ub, -rd, 0);
      wall(pa[0], pa[2], pb[0], pb[2], y0, y0, y1, y1, F.ox, F.oz, c, seed, Surf.Wood, 0, 0, ua - u0, 2 * hw, y0, y1 - y0);
    };
    const rails = (ua: number, ub: number): void => {
      for (const ry of [0.75, 2.1]) fbox(F, ua + 0.06, ub - 0.06, -rd, -rd + 0.045, y0 + ry, y0 + ry + 0.11, [wood[0] * 0.8, wood[1] * 0.8, wood[2] * 0.8], seed, Surf.Wood, { skip: FB.Back | FB.End0 | FB.End1, flatU: true });
    };
    if (vd < 1.2) {
      leaf(u0, mid, wood);
      leaf(mid, u1, [wood[0] * 0.94, wood[1] * 0.94, wood[2] * 0.94]);
      rails(u0, u1);
      fbox(F, mid - 0.012, mid + 0.012, -rd, -rd + 0.006, y0, y1, [0.08, 0.06, 0.05], seed, Surf.Interior, { skip: FB.Back | FB.End0 | FB.End1 | FB.Top });
      return;
    }
    leaf(u0, mid, wood);
    rails(u0, mid);
    // The other leaf swung in against the passage wall.
    const sw = (70 * Math.PI) / 180;
    const h0 = fp(F, u1, -rd, 0), h1 = fp(F, u1 - hw * Math.cos(sw), -rd - hw * Math.sin(sw), 0);
    const lq: V3[] = [[h0[0], y0, h0[2]], [h1[0], y0, h1[2]], [h1[0], y1, h1[2]], [h0[0], y1, h0[2]]];
    const luv: [number, number, number, number][] = [[0, 0, hw, y1 - y0], [hw, 0, hw, y1 - y0], [hw, y1 - y0, hw, y1 - y0], [0, y1 - y0, hw, y1 - y0]];
    const nx = h1[2] - h0[2], nz = -(h1[0] - h0[0]);
    poly(S, lq, [nx, 0, nz], wood, seed, Surf.Wood, 0, 0, luv);
    poly(S, lq, [-nx, 0, -nz], [wood[0] * 0.8, wood[1] * 0.8, wood[2] * 0.8], seed, Surf.Wood, 0, 0, luv);
    // The passage: dim walls, a floor, a ceiling and a far wall, so the
    // open leaf shows a way in rather than the inside of a hollow block.
    const v0 = -rd, v1 = -rd - vd, ytop = g + o.h;
    const pass: RGB = [0.55, 0.3, 0.22];
    const A = fp(F, u0, v0, 0), B = fp(F, u0, v1, 0), C = fp(F, u1, v1, 0), D = fp(F, u1, v0, 0);
    wall(A[0], A[2], B[0], B[2], gf, gf, ytop, ytop, F.ex, F.ez, pass, seed, Surf.Interior, 0, 0, 0, vd, gf, ytop - gf);
    wall(C[0], C[2], D[0], D[2], gf, gf, ytop, ytop, -F.ex, -F.ez, pass, seed, Surf.Interior, 0, 0, 0, vd, gf, ytop - gf);
    wall(B[0], B[2], C[0], C[2], gf, gf, ytop, ytop, F.ox, F.oz, [0.6, 0.5, 0.42], seed, Surf.Interior, 0, 0, 0, 2 * hw, gf, ytop - gf);
    poly(S, [A, B, C, D].map((p): V3 => [p[0], ytop, p[2]]), [0, -1, 0], [0.4, 0.3, 0.22], seed, Surf.Interior, 0, 0, uv4());
    poly(S, [A, B, C, D].map((p): V3 => [p[0], gf, p[2]]), [0, 1, 0], [0.55, 0.5, 0.44], seed, Surf.Pavement, 0, 0, uv4());
  }

  // =====================================================================================
  // Public buildings.
  // =====================================================================================
  const forum = data.publics.find((p) => p.kind === "forum");
  const forumC = forum ? ringCentroid(forum.ring) : null;
  for (let pi = 0; pi < data.publics.length; pi++) { buildPublic(data.publics[pi], pi); S.tag = 0; }
  if (!grey) siteInfo.statues.push(...placeTownStatues(S, data, ground, KERB_M, lean, 0.5, statueBases).placed);

  function buildPublic(p: PompeiiPublic, pi: number): void {
    const r = cleanRing(p.ring) ?? p.ring;
    const seed = hash(pi, 77);
    const g = groundMin(r) + KERB_M;
    switch (p.kind) {
      case "forum": buildForum(r, g, seed); break;
      case "temple": buildTemple(p, r, seed); break;
      case "basilica": buildHall(r, g, 12, seed, true); break;
      case "baths":
        // A planned bath is built room by room by render/pompeiiwater.ts.
        if (hasBathPlan(p.name) && !grey) waterSites.baths.push({ name: p.name, ring: p.ring, g });
        else buildCourtBuilding(r, g, 9, seed);
        break;
      case "hall": buildCourtBuilding(r, g, 8, seed); break;
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
    roofOutX: number, roofOutZ: number, roofW: number, backY: number, seed: number, c: RGB = [0.9, 0.87, 0.8], skip?: (x: number, z: number) => boolean,
    order: Order = Order.Doric): number {
    const L = Math.hypot(bx - ax, bz - az);
    const D = h / ORDERS[order].height;
    // Architrave, frieze and cornice in modules of D (Vitruvius IV.3 for the
    // Doric: architrave one module, frieze one and a half, so D/2 and 3D/4;
    // the Ionic frieze lower and plain), the cornice projecting a third of D.
    const archH = D * 0.5, friezeH = order === Order.Doric ? D * 0.75 : D * 0.55, corH = D * 0.35;
    const e0 = y0 + h, e1 = e0 + archH, e2 = e1 + friezeH, e3 = e2 + corH;
    if (L < 3) return e3;
    void r;
    const tx = (bx - ax) / L, tz = (bz - az) / L;
    const n = Math.max(1, Math.round(L / spacing));
    for (let i = 0; i <= n; i++) {
      const x = ax + tx * (L * i) / n, z = az + tz * (L * i) / n;
      if (skip?.(x, z)) continue;
      column(x, z, y0, h, 0, c, seed, lean ? 6 : 10, false, order);
    }
    const band = (half: number, y0b: number, y1b: number, col: RGB, s: Surf = Surf.Stucco): void => {
      const q = [ax - roofOutX * half - tx * half, az - roofOutZ * half - tz * half, bx - roofOutX * half + tx * half, bz - roofOutZ * half + tz * half,
        bx + roofOutX * half + tx * half, bz + roofOutZ * half + tz * half, ax + roofOutX * half - tx * half, az + roofOutZ * half - tz * half];
      box(q, y0b, y1b, col, seed, s, s, col, false);
      // box() has sides and a top only. Under a portico the entablature is
      // seen from below, where an open box showed the sky and the backs of
      // the frieze plates through the beam the capitals should carry.
      if (!opts.probeOpenBeams) poly(S, [[q[0], y0b, q[1]], [q[2], y0b, q[3]], [q[4], y0b, q[5]], [q[6], y0b, q[7]]], [0, -1, 0], col, seed, s, 0, 0,
        [[0, 0, L, 2 * half], [L, 0, L, 2 * half], [L, 2 * half, L, 2 * half], [0, 2 * half, L, 2 * half]]);
    };
    band(D * 0.45, e0, e1, [0.9, 0.87, 0.8]);
    band(D * 0.42, e1, e2, [0.86, 0.83, 0.76]);
    band(D * 0.45 + D * 0.33, e2, e3, [0.92, 0.89, 0.82]);
    if (order === Order.Doric && !lean) {
      // Triglyphs over each column and each intercolumniation, proud of the frieze.
      for (let i = 0; i <= n * 2; i++) {
        const t = (L * i) / (n * 2);
        const cx = ax + tx * t - roofOutX * (D * 0.42 + 0.03), cz = az + tz * t - roofOutZ * (D * 0.42 + 0.03);
        const hw = D * 0.25;
        box([cx - tx * hw, cz - tz * hw, cx + tx * hw, cz + tz * hw, cx + tx * hw + roofOutX * 0.06, cz + tz * hw + roofOutZ * 0.06, cx - tx * hw + roofOutX * 0.06, cz - tz * hw + roofOutZ * 0.06],
          e1, e2, [0.78, 0.75, 0.68], seed, Surf.Stucco);
      }
    }
    const e1r = e3;
    if (roofW > 0) {
      const e1 = e1r;
      const p0: V3 = [ax, e1, az], p1: V3 = [bx, e1, bz];
      const flat = Number.isNaN(backY);
      if (flat) backY = e1;
      const p2: V3 = [bx + roofOutX * roofW, backY, bz + roofOutZ * roofW], p3: V3 = [ax + roofOutX * roofW, backY, az + roofOutZ * roofW];
      if (flat) poly(S, [p0, p1, p2, p3], [0, 1, 0], [0.5, 0.4, 0.3], seed, Surf.Wood, 0, 0, uv4());
      else poly(S, [p0, p1, p2, p3], [-roofOutX, 1, -roofOutZ], [0.62, 0.31, 0.2], seed, Surf.Tile, 0, 0, [[0, 0, L, roofW], [L, 0, L, roofW], [L, roofW, L, roofW], [0, roofW, L, roofW]]);
      poly(S, [p0, p1, p2, p3], [roofOutX * 0.2, -1, roofOutZ * 0.2], [0.45, 0.36, 0.28], seed, Surf.Wood, 0, 0, uv4());
    }
    return e3;
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
      // The portico of Popidius: Doric below, a lighter Ionic gallery over
      // it, the upper columns standing on the lower entablature.
      // With the gallery over it the lower storey carries a flat timber
      // floor back to the wall (backY NaN), not a lean-to roof: the upper
      // columns stood in front of a slope of tiles with nothing to stand on.
      const top0 = colonnade(x0, z0, x1, z1, g, 6.2, 0, 3.2, -nx, -nz, ins, lean ? g + 9.5 : NaN, seed, [0.9, 0.87, 0.8], inTemple, Order.Doric);
      if (!lean) colonnade(x0, z0, x1, z1, top0, 4.4, 0, 3.2, -nx, -nz, ins, g + 13.4, seed, [0.9, 0.87, 0.8], inTemple, Order.Ionic);
      // The back wall the portico roofs lean on.
      wall(ax, az, bx, bz, g - 0.4, g - 0.4, g + 13.4, g + 13.4, nx, nz, [0.88, 0.84, 0.74], seed, Surf.Stucco, 0, 0, 0, L, g, 13.4);
    }
    // Statue bases down the long axis.
    if (!lean) {
      const o = obb(r);
      // The bases face into the square; the two at the ends carry
      // equestrian bronzes (long bases, as the surviving ones on the west
      // side are), the rest togate magistrates.
      const bases: [number, number][] = [];
      for (let k = -3; k <= 3; k++) {
        if (k === 0) continue;
        const x = o.cx + o.ux * k * (o.hu / 4.5) - o.uz * (o.hv * 0.55), z = o.cz + o.uz * k * (o.hu / 4.5) + o.ux * (o.hv * 0.55);
        bases.push([x, z]);
        const rider = Math.abs(k) === 3;
        // The togati face across the square; the riders ride along it, toward the middle (render/statues.ts).
        forumStatue(S, x, ground(x, z) + KERB_M, z, o.ux, o.uz, k, rider, Math.atan2(-o.uz, o.ux), seed);
        siteInfo.statues.push(rider ? "equestrian" : "togate");
      }
      // Market stalls along the long sides, in front of the colonnade:
      // trestle tables under cloth roofs, with jars and baskets. Clear of
      // the statue bases and the temples at the ends.
      for (let i = 0; i < n; i++) {
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 40) continue;
        const nx = -(bz - az) / L, nz = (bx - ax) / L, tx = (bx - ax) / L, tz = (bz - az) / L;
        for (let k = 1; k <= 4; k++) {
          const t = (L * k) / 5 + (hash(seed * 1e6, i, k) - 0.5) * 4;
          const cx = ax + tx * t + nx * 7.4, cz = az + tz * t + nz * 7.4;
          if (inTemple(cx, cz) || !pointInRing(r, cx, cz) || bases.some(([x, z]) => Math.hypot(x - cx, z - cz) < 4.5)) continue;
          stall({ ax: cx, az: cz, ex: tx, ez: tz, ox: nx, oz: nz }, ground(cx, cz) + KERB_M + 0.05, hash(seed * 1e6, i, k + 10));
        }
      }
    }
  }

  /** A market stall: a trestle table under a cloth roof on four posts, wares on and beside it. */
  function stall(F: Frame, g: number, seed: number): void {
    const wood: RGB = [0.42, 0.3, 0.18];
    fbox(F, -0.95, 0.95, -0.42, 0.42, g + 0.78, g + 0.84, wood, seed, Surf.Wood, { bottom: true });
    for (const [pu, pv] of [[-0.98, -0.62], [0.92, -0.62], [-0.98, 0.56], [0.92, 0.56]]) {
      fbox(F, pu, pu + 0.06, pv, pv + 0.06, g, pv < 0 ? g + 2.35 : g + 2.0, wood, seed, Surf.Wood, { flatU: true, skip: FB.Top });
    }
    for (const [pu, pv] of [[-0.8, -0.3], [0.74, -0.3], [-0.8, 0.24], [0.74, 0.24]]) fbox(F, pu, pu + 0.06, pv, pv + 0.06, g, g + 0.78, wood, seed, Surf.Wood, { flatU: true, skip: FB.Top });
    const cloth: RGB[] = [[0.8, 0.74, 0.6], [0.62, 0.26, 0.18], [0.7, 0.6, 0.42], [0.5, 0.42, 0.3]];
    const cc = cloth[Math.floor(hash(seed * 1e6, 1) * cloth.length)];
    const q: V3[] = [fp(F, -1.15, -0.75, g + 2.4), fp(F, 1.1, -0.75, g + 2.4), fp(F, 1.1, 0.75, g + 1.98), fp(F, -1.15, 0.75, g + 1.98)];
    poly(S, q, [F.ox, 1, F.oz], cc, seed, Surf.Stucco, 0, 0, uv4());
    poly(S, q, [-F.ox * 0.3, -1, -F.oz * 0.3], [cc[0] * 0.8, cc[1] * 0.8, cc[2] * 0.8], seed, Surf.Stucco, 0, 0, uv4());
    // Wares: jars on the table, a basket or two at its foot.
    for (let k = 0; k < 3; k++) {
      const [x, , z] = fp(F, -0.6 + k * 0.6, -0.1 + 0.2 * hash(seed * 1e6, 2, k), 0);
      jar(x, g + 0.84, z, 1.0 + 0.4 * hash(seed * 1e6, 3, k), hash(seed * 1e6, 4, k));
    }
    const [bx, , bz] = fp(F, 1.3, 0.25, 0);
    basket(bx, g, bz, hash(seed * 1e6, 5));
    if (hash(seed * 1e6, 6) < 0.5) {
      const [x, , z] = fp(F, -1.35, -0.4, 0);
      amphora(leaning([x, g, z], F.ex, F.ez, -0.15), x, g, z, 0.9, hash(seed * 1e6, 7));
    }
    siteInfo.stalls++;
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
    box(cq, y0, y0 + H, [0.88, 0.85, 0.78], seed, Surf.Stucco, Surf.Stucco, [0.88, 0.85, 0.78], false);
    // Columns across the pronaos: 6 across the front, 2 deep.
    const across = 6;
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < across; k++) {
        if (row > 0 && k > 0 && k < across - 1) continue;
        const v = -t.hv + 0.9 + ((2 * t.hv - 1.8) * k) / (across - 1);
        const u = t.hu - 0.9 - row * ((t.hu - cellaHu * 2 + 0.4) / 2 + 1.2);
        column(t.cx + fx * u - t.uz * v * 1, t.cz + fz * u + t.ux * v * 1, y0, H, Math.min(0.55, t.hv * 0.07), [0.9, 0.88, 0.82], seed, lean ? 8 : 12, false, Order.Corinthian);
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
    // After the walls: only the roof and its timber carry the tag. The
    // basilica's 24 m span is the widest in the town and goes first.
    roofBegin(q, g + H + Math.min(5, o.hv * TAN_PITCH), 2 * o.hv, seed);
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
        column(p[0], p[2], g, 8, 0.5, [0.9, 0.88, 0.82], seed, 8, false, Order.Ionic);
      }
      // The entablature the porch columns carry, back to the hall's end wall.
      const ey = Math.max(top, g + 8.7);
      const ep = [pt(s * o.hu, -o.hv + 1.4, 0), pt(s * (o.hu + 1.6), -o.hv + 1.4, 0), pt(s * (o.hu + 1.6), o.hv - 1.4, 0), pt(s * o.hu, o.hv - 1.4, 0)].flatMap((p) => [p[0], p[2]]);
      box(ep, g + 8, ey, [0.9, 0.88, 0.82], seed, Surf.Stucco, Surf.Stucco, [0.9, 0.88, 0.82], !opts.probeOpenBeams);
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
    roofBegin(c, g + H + 2, D, seed);
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
    const ip = ic.map((p): V3 => [p[0], g + (opts.probeCoplanar ? 0.03 : 0.1), p[1]]);
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
    for (let i = 0; i < ring.length; i += 2) S.vert([ring[i], g + (opts.probeCoplanar ? 0.04 : 0.1), ring[i + 1]], [0, 1, 0], pool ? [0.34, 0.4, 0.2] : [0.72, 0.64, 0.5], seed, pool ? Surf.Garden : Surf.Sand, 0, 0, [ring[i], ring[i + 1], 0, 0]);
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
  if (data.amphitheatre) {
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
  if (town.walled) {
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
            box(q, gm + WALL_H - 1.2, gm + WALL_H + 0.6, wc, 0.5, Surf.Masonry, Surf.Masonry, wc, false);
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
      box(q, g + 5.2, g + WALL_H + 1.5, [0.74, 0.68, 0.56], 0.55, Surf.Masonry, Surf.Kerb, [0.6, 0.56, 0.48], false);
      // The vault's soffit, seen from the road below.
      poly(S, [0, 1, 2, 3].map((k): V3 => [q[k * 2], g + 5.2, q[k * 2 + 1]]), [0, -1, 0], [0.5, 0.46, 0.4], 0.55, Surf.Masonry, 0, 0, uv4());
    }
  }

  // --- the unbuilt frontage: plot walls ---
  // Ground a block's lots leave open at its street edge was a walled garden,
  // a vegetable plot or a vineyard (the Foro Boario inside the walls is
  // one): a plastered wall along the street, a wooden gate in a long one,
  // and where the kerb runs on the building line and the street has a
  // pavement elsewhere, the wall stands back by that pavement's width with
  // the strip in front paved. The ground behind is the block slab's own
  // (the shader's plots, Garden p1 255). The full build's; the phone keeps
  // the plots' ground alone.
  if (!lean && !grey && !opts.probeNoPlotWalls) {
    const CELL = 10;
    const sgrid = new Map<number, number[]>();
    const sb = solids.map((s) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < s.ring.length; i += 2) { x0 = Math.min(x0, s.ring[i]); x1 = Math.max(x1, s.ring[i]); z0 = Math.min(z0, s.ring[i + 1]); z1 = Math.max(z1, s.ring[i + 1]); }
      return [x0, x1, z0, z1];
    });
    sb.forEach((b, k) => {
      if (b[1] - b[0] > 400 || b[3] - b[2] > 400) return;
      for (let i = Math.floor(b[0] / CELL); i <= Math.floor(b[1] / CELL); i++) for (let j = Math.floor(b[2] / CELL); j <= Math.floor(b[3] / CELL); j++) {
        const key = i * 100003 + j;
        (sgrid.get(key) ?? sgrid.set(key, []).get(key)!).push(k);
      }
    });
    const built = (x: number, z: number): boolean =>
      (sgrid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) ?? []).some((k) => x >= sb[k][0] && x <= sb[k][1] && z >= sb[k][2] && z <= sb[k][3] && pointInRing(solids[k].ring, x, z))
      || publicRings.some((pr) => pointInRing(pr, x, z));
    const wallC: RGB = [0.84, 0.78, 0.66];
    const newSolids: Solid[] = [];
    for (let ii = 0; ii < data.insulae.length; ii++) {
      const ins = data.insulae[ii];
      if (ins.garden) continue;
      const r = ins.ring, n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 3) continue;
        const ex = (bx - ax) / L, ez = (bz - az) / L;
        let nx = -ez, nz = ex;
        if (!pointInRing(r, (ax + bx) / 2 + nx * 0.5, (az + bz) / 2 + nz * 0.5)) { nx = -nx; nz = -nz; }
        const free: boolean[] = [];
        // Unbuilt metre by metre: nothing standing within a metre of the line.
        for (let t = 0.5; t < L; t += 1) {
          const x = ax + ex * t + nx, z = az + ez * t + nz;
          free.push(pointInRing(r, x, z) && !built(x, z) && !built(x - nx * 0.5, z - nz * 0.5));
        }
        for (let k = 0; k < free.length;) {
          if (!free[k]) { k++; continue; }
          let k1 = k;
          while (k1 < free.length && free[k1]) k1++;
          const t0 = Math.max(0, k - 0.1), t1 = Math.min(L, k1 + 0.1);
          k = k1;
          if (t1 - t0 < 1.5) continue;
          const mxp = ax + ex * (t0 + t1) / 2, mzp = az + ez * (t0 + t1) / 2;
          let sw = 0, sd = Infinity;
          for (const s of data.streets) { const dd = distToPolyline(s.pts, mxp, mzp); if (dd < sd) { sd = dd; sw = s.sidewalkM; } }
          const onKerb = distToRing(ins.kerb, mxp, mzp) < 0.15;
          const back = onKerb && sw >= 0.8 ? Math.min(sw, 2.4) : 0;
          const T = 0.3, Hw = 2.1;
          const P = (t: number, v: number): [number, number] => [ax + ex * t + nx * v, az + ez * t + nz * v];
          const [x0, z0] = P(t0, back), [x1, z1] = P(t1, back), [x2, z2] = P(t1, back + T), [x3, z3] = P(t0, back + T);
          const y0 = slabTop(ins, x0, z0) - 0.12, y1 = slabTop(ins, x1, z1) - 0.12;
          const len = t1 - t0, sd2 = hash(ii, i * 131 + k, 17);
          wall(x0, z0, x1, z1, y0, y1, y0 + Hw + 0.12, y1 + Hw + 0.12, -nx, -nz, wallC, sd2, Surf.Plaster, Math.round(0.6 * 40), 0, 0, len, y0 + 0.12, Hw);
          wall(x2, z2, x3, z3, y1, y0, y1 + Hw + 0.12, y0 + Hw + 0.12, nx, nz, wallC, sd2, Surf.Plaster, 0, 255, 0, len, y0 + 0.12, Hw);
          poly(S, [[x0, y0 + Hw + 0.12, z0], [x1, y1 + Hw + 0.12, z1], [x2, y1 + Hw + 0.12, z2], [x3, y0 + Hw + 0.12, z3]], [0, 1, 0], [0.7, 0.62, 0.52], sd2, Surf.Kerb, 0, 0, uv4());
          if (len > 8) {
            // A plank gate in the middle, a hand proud of the plaster.
            const tm = (t0 + t1) / 2;
            const [g0x, g0z] = P(tm - 0.8, back - 0.02), [g1x, g1z] = P(tm + 0.8, back - 0.02);
            const yg = slabTop(ins, g0x, g0z) - 0.02;
            wall(g0x, g0z, g1x, g1z, yg, yg, yg + 1.9, yg + 1.9, -nx, -nz, [0.4, 0.27, 0.15], sd2, Surf.Wood, 0, 0, 0, 1.6, yg, 1.9);
          }
          if (back > 0) {
            // The pavement in front of it, a hand over the block's ground.
            const pts: V3[] = [P(t0, 0), P(t1, 0), P(t1, back), P(t0, back)].map((p): V3 => [p[0], slabTop(ins, p[0], p[1]) + 0.03, p[1]]);
            poly(S, pts, [0, 1, 0], [0.43, 0.35, 0.26], sd2, Surf.Pavement, 0, 0, pts.map((p) => [p[0], p[2], 0, 0]));
          }
          stats.plotWallM += len;
          newSolids.push({ ring: [x0, z0, x1, z1, x2, z2, x3, z3], baseY: Math.min(y0, y1), topY: Math.max(y0, y1) + Hw + 0.12 });
        }
      }
    }
    solids.push(...newSolids);
  }

  // --- shop counters, and the thermopolia's ---
  // Each mapped thermopolium claims the nearest counter within 12 m. Every
  // counter is an L of masonry standing on the shop floor behind the sill:
  // the long arm across the front, the short arm returning into the shop at
  // the doorway left between it and the far pier. A thermopolium's is faced
  // with offcuts of coloured marble, the mouths of the dolia that held the
  // food and wine set in its top, a stepped shelf for the jugs at the pier
  // end; some plain shops faced theirs the same way, most painted them.
  const claimed = new Set<number>();
  const counterMid = (c: (typeof counters)[number]): V3 => fp(c.F, c.u0 + c.w * 0.4, -0.45, c.g);
  if (!lean && !grey) for (const t of sitesOf("thermopolium")) {
    let best = -1, bd = 12;
    counters.forEach((c, i) => {
      if (claimed.has(i)) return;
      const m = counterMid(c);
      const d = Math.hypot(m[0] - t.x, m[2] - t.z);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) claimed.add(best);
  }
  counters.forEach((c, i) => {
    const { F, u0, w, g, seed } = c;
    const thermo = claimed.has(i);
    if (thermo) siteInfo.thermopolia++;
    const r = (k: number): number => hash(seed * 1e6, 77, k);
    const ua = u0 + 0.1, ub = w > 2.2 ? u0 + w - counterGap(w) : u0 + w * 0.55;
    const vb = -COUNTER.backV, vf = -COUNTER.frontV, top = g + COUNTER.topM, body = top - 0.05;
    const chips = thermo || r(1) < 0.12;
    const paint: RGB = LOWER[Math.floor(r(2) * 4)];
    // Front: marble chips, or a painted dado (plaster read from a metre up, so no socle band).
    const front: [Surf, number, number, RGB] = chips ? [Surf.Marble, 1, 0, [0.8, 0.76, 0.7]] : [Surf.Plaster, 80, 255, paint];
    const gref = chips ? g : g - 1;
    const slabC: RGB = [0.86, 0.84, 0.8];
    const arm = (u0a: number, u1a: number, v0: number, v1: number, skip: number): void => {
      fbox(F, u0a, u1a, v0, v1, g - 0.02, body, front[3], seed, front[0], { p1: front[1], p2: front[2], skip: skip | FB.Top, gref });
      // The marble top, a few centimetres proud of the masonry.
      fbox(F, u0a - 0.03, u1a + 0.03, v0 - 0.03, v1 + 0.03, body, top, slabC, seed, Surf.Marble, { skip: skip & ~(FB.End0 | FB.End1) });
    };
    // Long arm along the front; the short arm back into the shop at the doorway.
    arm(ua, ub, vb, vf, FB.End0);
    const retU = Math.min(0.55, (ub - ua) * 0.4), retV = -Math.min(COUNTER.returnV, 0.6 + w * 0.35);
    if (retV < vb - 0.3) arm(ub - retU, ub, retV, vb, FB.Front);
    const mouths: [number, number][] = [];
    const lampU = u0 + w * 0.31 + 0.075;
    if (thermo) {
      // The stepped shelf against the pier, three treads.
      for (let k = 1; k <= 3; k++) {
        const su = ua + 0.6 - k * 0.17;
        fbox(F, ua, su, vb, vf, top, top + k * 0.13, front[3], seed, front[0], { p1: front[1], p2: front[2], skip: FB.End0, gref, topS: Surf.Marble, topC: slabC });
      }
      for (let mu = ua + 0.95; mu < ub - 0.35; mu += 0.75) if (Math.abs(mu - lampU) > 0.35) mouths.push([mu, (vb + vf) / 2]);
      if (retV < vb - 0.6) mouths.push([ub - retU / 2, (retV + vb) / 2]);
    } else if (!lean && r(3) < 0.3) {
      const mu = ub - 0.4;
      if (mu > ua + 0.3 && Math.abs(mu - lampU) > 0.35) mouths.push([mu, (vb + vf) / 2]);
    }
    for (const [mu, mv] of mouths) {
      const [mx, , mz] = fp(F, mu, mv, 0);
      // The jar's rim proud of the counter top, and its dark mouth.
      // (A lathe profile faces outward and up when it runs outward going up, inward going across.)
      lathe(S, mx, top, mz, [[0.17, 0.0], [0.2, 0.03], [0.16, 0.035], [0.14, -0.05]], 8, [0.6, 0.36, 0.24], seed, Surf.Pavement);
      lathe(S, mx, top, mz, [[0.14, -0.02], [0.001, -0.02]], 8, [0.05, 0.04, 0.035], seed, Surf.Interior);
    }
  });


  // --- the kerbs' street faces ---
  // Where there is no pavement a house front, or the block's own edge, runs
  // on the kerb line and comes down past the kerb top: two faces of different
  // colour in one plane, which a phone's depth buffer shows as a stipple of
  // one through the other all down the street. There the kerb face is
  // left out and the front's own foot is what shows.
  {
    // Every front's edges, in 2 m cells: the kerb pass asks only what is within centimetres.
    const edges: number[] = [];
    const grid = new Map<number, number[]>();
    for (const r of [...solids.map((s) => s.ring), ...data.insulae.map((i) => i.ring), ...data.publics.map((p) => p.ring), ...data.domus.map((d) => d.ring)]) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
        const k = edges.length;
        edges.push(ax, az, bx, bz);
        for (let gi = Math.floor((Math.min(ax, bx) - 0.1) / 2); gi <= Math.floor((Math.max(ax, bx) + 0.1) / 2); gi++) for (let gj = Math.floor((Math.min(az, bz) - 0.1) / 2); gj <= Math.floor((Math.max(az, bz) + 0.1) / 2); gj++) {
          const key = gi * 100003 + gj;
          (grid.get(key) ?? grid.set(key, []).get(key)!).push(k);
        }
      }
    }
    // How far out along (ox, oz) the fronts within 8 cm of (x, z) stand: every one found, signed.
    const fronts = (x: number, z: number, ox: number, oz: number, out: number[]): void => {
      for (const k of grid.get(Math.floor(x / 2) * 100003 + Math.floor(z / 2)) ?? []) {
        const ax = edges[k], az = edges[k + 1], bx = edges[k + 2], bz = edges[k + 3];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        const nx = ax + dx * t, nz = az + dz * t;
        if (Math.hypot(nx - x, nz - z) < 0.08) out.push((nx - x) * ox + (nz - z) * oz);
      }
    };
    for (const k of kerbFaces) {
      const { ax, az, bx, bz, ox, oz, ga, gb, L, lift, sideC, seed, side } = k;
      // In pieces a few decimetres long, each left out where a front stands
      // within 3 cm of it: the front's own foot comes down past the kerb top
      // there and is the face that shows. A front can share part of a kerb
      // edge, or cross it at a shallow angle, so each piece is judged alone.
      const ns = Math.max(1, Math.ceil(L / 0.4));
      let run = -1;
      const emit = (i0: number, i1: number): void => {
        const t0 = i0 / ns, t1 = i1 / ns;
        wall(ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, lerp(ga, gb, t0) - 0.3, lerp(ga, gb, t1) - 0.3, lerp(ga, gb, t0) + lift, lerp(ga, gb, t1) + lift,
          ox, oz, sideC, seed, side, 0, 0, L * t0, L, ga, lift);
      };
      for (let i = 0; i < ns; i++) {
        const w: number[] = [];
        for (const t of [0.1, 0.5, 0.9]) fronts(ax + ((bx - ax) * (i + t)) / ns, az + ((bz - az) * (i + t)) / ns, ox, oz, w);
        const covered = w.some((v) => Math.abs(v) < 0.03);
        if (!covered && run < 0) run = i;
        if (covered && run >= 0) { emit(run, i); run = -1; }
      }
      if (run >= 0) emit(run, ns);
    }
  }

  // --- crossroads shrines ---
  // The Lares Compitales had a shrine at about one crossroads in three: a
  // masonry altar against the corner house, the gods painted on the wall
  // over it under a small tiled roof. Not at a fountain's corner, and
  // never across a doorway.
  if (!lean && !grey) junctions.forEach(([jx, jz], ji) => {
    if (hash(ji, 51) > 0.6) return;
    if (waterSites.fountains.some((f) => Math.hypot(f.x - jx, f.z - jz) < 14)) return;
    // The nearest building line, and a point on it 1.6 m along from the corner.
    let best: { ax: number; az: number; bx: number; bz: number; d: number } | null = null;
    for (const ins of data.insulae) {
      if (ins.garden || !pointInRing(data.wall, ins.ring[0], ins.ring[1])) continue;
      const r = ins.ring, n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
        const d = distSeg(jx, jz, ax, az, bx, bz);
        if (d < 14 && (!best || d < best.d) && Math.hypot(bx - ax, bz - az) > 5) best = { ax, az, bx, bz, d };
      }
    }
    if (!best) return;
    const { ax, az, bx, bz } = best;
    const L = Math.hypot(bx - ax, bz - az), ex = (bx - ax) / L, ez = (bz - az) / L;
    const t = Math.max(0, Math.min(L, (jx - ax) * ex + (jz - az) * ez));
    const tt = t < L / 2 ? Math.min(L / 2, t + 1.6) : Math.max(L / 2, t - 1.6);
    let ox = ez, oz = -ex;
    if ((jx - ax) * ox + (jz - az) * oz < 0) { ox = -ox; oz = -oz; }
    const F: Frame = { ax: ax + ex * tt, az: az + ez * tt, ex, ez, ox, oz };
    if (publicRings.some((pr) => distToRing(pr, F.ax, F.az) < 3) || pavementAt(F.ax, F.az, ox, oz) < 1.2 || !clearAt(F, [[-0.5, 0.46], [0.5, 0.46]], 0.2)) return;
    if (lampSites.openings.some((o) => Math.hypot(o.x - F.ax, o.z - F.az) < o.w / 2 + 1.1)) return;
    const g = ground(F.ax, F.az) + KERB_M, seed = hash(ji, 52);
    // Altar with its cornice, plastered white.
    fbox(F, -0.42, 0.42, -0.02, 0.38, g - 0.1, g + 0.92, [0.86, 0.82, 0.72], seed, Surf.Stucco, { skip: FB.Back | FB.Top });
    fbox(F, -0.5, 0.5, -0.02, 0.44, g + 0.92, g + 1.04, [0.9, 0.87, 0.8], seed, Surf.Marble, { skip: FB.Back });
    // The painting over it, and the little roof that kept the rain off it.
    const p0 = fp(F, -0.75, 0.012, 0), p1 = fp(F, 0.75, 0.012, 0);
    wall(p0[0], p0[2], p1[0], p1[2], g + 1.25, g + 1.25, g + 2.65, g + 2.65, ox, oz, [0.6, 0.14, 0.08], seed, Surf.Fresco, 0, 0, 0, 1.5, g + 0.3, 2.35);
    const q: V3[] = [fp(F, -0.9, 0, g + 3.0), fp(F, 0.9, 0, g + 3.0), fp(F, 0.9, 0.75, g + 2.7), fp(F, -0.9, 0.75, g + 2.7)];
    poly(S, q, [ox, 1, oz], [0.64, 0.32, 0.2], seed, Surf.Tile, 0, 0, [[0, 0.8, 1.8, 0.8], [1.8, 0.8, 1.8, 0.8], [1.8, 0, 1.8, 0.8], [0, 0, 1.8, 0.8]]);
    poly(S, q, [ox * 0.3, -1, oz * 0.3], [0.36, 0.25, 0.15], seed, Surf.Wood, 0, 0, uv4());
    for (const bu of [-0.7, 0.7]) tube(S, fp(F, bu, 0, g + 2.35), fp(F, bu, 0.62, g + 2.7), 0.035, 0.03, 4, [0.34, 0.23, 0.13], seed, Surf.Wood);
    siteInfo.shrines++;
  });
  // Outside the walls, drawn with the same emitters into the same stores.
  const suburbs = data.suburbs && opts.suburbs !== false
    ? buildSuburbs({ S, F, R, poly, wall, box, column, ground, solids, lean }, data.suburbs)
    : null;
  // Herculaneum's sea front, sheds and villa pool, and its Neptune mosaic.
  const herc = data.herc && !grey
    ? buildHerculaneum({ S, F, R, poly, wall, box, column, ground, solids, lean }, data.herc, { art, artPlaced, orders: (x, z, y0, h) => column(x, z, y0, h, 0.2, [0.88, 0.85, 0.78], 0.4, 8, false, Order.Ionic) })
    : null;

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
    orders,
    art: artPlaced,
    interiors,
    statueBases,
    sites: siteInfo,
    mesh: pack(S),
    floor: pack(F),
    streets: pack(R),
    solids,
    lots,
    lampSites,
    roofs,
    waterSites,
    stats,
    suburbs,
    upperHouses,
    herc,
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

/**
 * The highest town ground at a point: the carriageway ribbon, the kerbed
 * pavement slab and the block's ground slab, each interpolated over its own
 * triangulation as buildPompeii draws it. A floor laid indoors over the town
 * (render/escaperoom.ts) has to clear all of them or they show through it.
 */
const slabCache = new WeakMap<Ring, number[]>();
export function townFloorAt(data: PompeiiData, groundAt: (x: number, z: number) => number, x: number, z: number): number {
  let y = groundAt(x, z) + 0.08;
  const over = (r: Ring, lift: number): void => {
    if (!pointInRing(r, x, z)) return;
    let tri = slabCache.get(r);
    if (!tri) { tri = triangulateRing(new Float32Array(r)); slabCache.set(r, tri); }
    for (let k = 0; k < tri.length; k += 3) {
      const a = tri[k], b = tri[k + 1], c = tri[k + 2];
      const ax = r[a * 2], az = r[a * 2 + 1], bx = r[b * 2], bz = r[b * 2 + 1], cx = r[c * 2], cz = r[c * 2 + 1];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, wc = 1 - wa - wb;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      y = Math.max(y, wa * groundAt(ax, az) + wb * groundAt(bx, bz) + wc * groundAt(cx, cz) + lift);
      return;
    }
    y = Math.max(y, groundAt(x, z) + lift);
  };
  for (const ins of data.insulae) {
    over(ins.kerb, KERB_M);
    over(ins.ring, KERB_M + 0.06);
  }
  return y;
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
