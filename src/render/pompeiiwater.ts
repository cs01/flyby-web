// Water in Pompeii: the baths built room by room (data/pompeiibaths.ts), the
// street fountains with their spout heads, jets, splashes and overflow, the
// water towers and the Castellum Aquae (data/pompeiiwater.ts), and rims round
// the atrium pools (whose water the town shader draws, style 8).
//
// Three kinds of draw:
//  - the stonework, in the town's own vertex format and material
//    (render/pompeii.ts), so it takes the same sun, shadows, lamps and
//    pumice as every other wall. The bath rooms are its style 20: a room
//    keeps most of the sky light out, so the sun through an oculus or a
//    window is what lights it by day.
//  - still and running water, one shader: fresnel between the sky (or, in
//    a roofed pool, the room, with the sky only where the reflected ray
//    leaves through the oculus) and the pool's floor seen through tinted
//    water, ripples from a height field (wind outdoors, rings where a jet
//    lands, slow swirls in a hot pool), a sun glint, and the oil lamps.
//    No refraction target: the floor is the lining's colour lit as the pool
//    is, which is all a pool a metre deep needs.
//  - jets, splashes and steam: static tubes with scrolling streaks, and
//    instanced sprites animated wholly in the vertex shader from a seed and
//    the clock, so nothing is uploaded per frame.
//
// Cost (gate test/pompeiiwater.check.ts): about 60k triangles of stone and a
// few thousand of water, three small draws for the jets and sprites; on a
// phone (lean) a third of the sprites and one ripple octave.
// Kill switch `?off=pompeiiwater` (main.ts).

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER } from "./sunshadow";
import { SH_GLSL } from "./sh";
import { AO_GLSL } from "./ao";
import { TOWN_LAMPS_GLSL } from "./oillight";
import { pompeiiMaterial, type PompeiiUniforms } from "./pompeii";
import { pointInRing, ringArea, type PompeiiData } from "../data/pompeii";
import { LampKind, type Lamp } from "../data/pompeiilamps";
import {
  apseCentre, apseOffset, bathLamps, bathSites, roomOutline, steamSources, toWorld,
  type BathSite, type DoorPlan, type RoomPlan, type Side, type SteamSource,
} from "../data/pompeiibaths";
import {
  BASIN, Head, IMPLUVIUM_RIM, IMPLUVIUM_RIM_W, SPOUT, SPOUT_SPEED, TOWER, UPRIGHT,
  fountainToWorld, placeCastellum, placeFountains, placeTowers,
  type Castellum, type Fountain, type WaterSites, type WaterTower,
} from "../data/pompeiiwater";

type V3 = [number, number, number];
type W4 = [number, number, number, number];
type RGB = [number, number, number];

/** The town shader's surface styles used here (render/pompeiimesh.ts Surf, and 20 for a bath's rooms). */
const S = { plaster: 0, tile: 1, kerb: 3, stucco: 4, wood: 7, sand: 9, masonry: 10, marble: 11, bath: 20 } as const;
/** Style 20's finishes (p1). */
const F = { painted: 0, marble: 1, vault: 2, stars: 3, signinum: 4, boiler: 5, niches: 6 } as const;

/** Per tier: sprites for steam per hot pool, droplets per jet. */
export const WATER_TIERS = {
  full: { steam: 40, drops: 14 },
  lean: { steam: 12, drops: 5 },
} as const;

interface Mat { rgb: RGB; style: number; p1: number; p2: number; seed: number }

// =====================================================================================
// Geometry in the town's vertex format.
// =====================================================================================

class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  surf: number[] = [];
  wall: number[] = [];

  get triangles(): number { return this.pos.length / 9; }

  private vert(p: V3, n: V3, m: Mat, w: W4): void {
    this.pos.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.nrm.push(Math.round((n[0] / l) * 127), Math.round((n[1] / l) * 127), Math.round((n[2] / l) * 127), 0);
    this.col.push(Math.round(Math.min(1, m.rgb[0]) * 255), Math.round(Math.min(1, m.rgb[1]) * 255), Math.round(Math.min(1, m.rgb[2]) * 255), Math.round(m.seed * 255));
    this.surf.push(m.style, Math.max(0, Math.min(255, Math.round(m.p1))), Math.max(0, Math.min(255, Math.round(m.p2))), 0);
    this.wall.push(w[0], w[1], w[2], w[3]);
  }

  /** One triangle, wound so its front faces along the normals given. */
  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, m: Mat, wa: W4, wb: W4, wc: W4): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const nx = na[0] + nb[0] + nc[0], ny = na[1] + nb[1] + nc[1], nz = na[2] + nb[2] + nc[2];
    if (cx * nx + cy * ny + cz * nz < 0) { this.vert(a, na, m, wa); this.vert(c, nc, m, wc); this.vert(b, nb, m, wb); }
    else { this.vert(a, na, m, wa); this.vert(b, nb, m, wb); this.vert(c, nc, m, wc); }
  }

  quad(a: V3, b: V3, c: V3, d: V3, n: V3, m: Mat, w: [W4, W4, W4, W4] = [Z4, Z4, Z4, Z4]): void {
    this.tri(a, b, c, n, n, n, m, w[0], w[1], w[2]);
    this.tri(a, c, d, n, n, n, m, w[0], w[2], w[3]);
  }

  /**
   * A planar face from a 2D outline with holes: o the origin, eu and ev the
   * plane's axes (world), n its front. `wallOf` gives the shader's wall
   * coordinates for a (u, v) point.
   */
  face(o: V3, eu: V3, ev: V3, outline: [number, number][], holes: [number, number][][], n: V3, m: Mat, wallOf: (u: number, v: number) => W4): void {
    const pts = [...outline, ...holes.flat()];
    const tris = THREE.ShapeUtils.triangulateShape(outline.map(([u, v]) => new THREE.Vector2(u, v)), holes.map((h) => h.map(([u, v]) => new THREE.Vector2(u, v))));
    const P = (k: number): V3 => {
      const [u, v] = pts[k];
      return [o[0] + eu[0] * u + ev[0] * v, o[1] + eu[1] * u + ev[1] * v, o[2] + eu[2] * u + ev[2] * v];
    };
    for (const [i, j, k] of tris) this.tri(P(i), P(j), P(k), n, n, n, m, wallOf(...pts[i]), wallOf(...pts[j]), wallOf(...pts[k]));
  }

  /** A THREE geometry, transformed, its own normals kept. */
  mesh(g: THREE.BufferGeometry, mx: THREE.Matrix4, m: Mat, wallOf: (p: V3) => W4 = () => Z4): void {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.getAttribute("normal")) ng.computeVertexNormals();
    const P = ng.getAttribute("position"), N = ng.getAttribute("normal");
    const nm = new THREE.Matrix3().getNormalMatrix(mx);
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    const p: V3[] = [], n: V3[] = [];
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(mx);
      w.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      p.push([v.x, v.y, v.z]); n.push([w.x, w.y, w.z]);
      if (p.length === 3) {
        this.tri(p[0], p[1], p[2], n[0], n[1], n[2], m, wallOf(p[0]), wallOf(p[1]), wallOf(p[2]));
        p.length = 0; n.length = 0;
      }
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("aNormal", new THREE.BufferAttribute(new Int8Array(this.nrm), 4, true));
    g.setAttribute("aColour", new THREE.BufferAttribute(new Uint8Array(this.col), 4, true));
    g.setAttribute("aSurf", new THREE.BufferAttribute(new Uint8Array(this.surf), 4, false));
    g.setAttribute("aWall", new THREE.BufferAttribute(new Float32Array(this.wall), 4));
    g.computeBoundingSphere();
    return g;
  }

  get bytes(): number { return this.pos.length * 4 + this.nrm.length + this.col.length + this.surf.length + this.wall.length * 4; }
}

const Z4: W4 = [0, 0, 0, 0];

// =====================================================================================
// Water surfaces, jets and sprites: their own small vertex formats.
// =====================================================================================

/** Water kinds (aPool.x). */
const enum WK { Still = 0, Basin = 1, Film = 2, Hot = 3, Labrum = 4 }

class WaterGeo {
  pos: number[] = [];
  open: number[] = [];
  pool: number[] = [];
  tint: number[] = [];
  /**
   * open: the opening the pool sees the sky through, (cx, cz, height, radius):
   * radius 0 open sky, -1 a closed room. Film: (along m, across -1..1, 0, -2).
   * pool: (kind, depth m, jet x, jet z), or for a film (kind, depth, flow x, flow z).
   * tint: the lining's colour, and how shut in the room is.
   */
  tri(a: V3, b: V3, c: V3, open: W4[], pool: W4, tint: W4): void {
    // Up-facing: wind so (b-a)x(c-a) has +y.
    const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const order = cy >= 0 ? [0, 1, 2] : [0, 2, 1];
    const P = [a, b, c];
    for (const k of order) {
      this.pos.push(...P[k]);
      this.open.push(...open[k]);
      this.pool.push(...pool);
      this.tint.push(...tint);
    }
  }
  /** A flat polygon (convex or not) at height y. */
  poly(ring: number[], y: number, open: W4, pool: W4, tint: W4): void {
    const pts = [];
    for (let i = 0; i < ring.length; i += 2) pts.push(new THREE.Vector2(ring[i], ring[i + 1]));
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      this.tri([pts[i].x, y, pts[i].y], [pts[j].x, y, pts[j].y], [pts[k].x, y, pts[k].y], [open, open, open], pool, tint);
    }
  }
  get triangles(): number { return this.pos.length / 9; }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("aOpen", new THREE.BufferAttribute(new Float32Array(this.open), 4));
    g.setAttribute("aPool", new THREE.BufferAttribute(new Float32Array(this.pool), 4));
    g.setAttribute("aTint", new THREE.BufferAttribute(new Float32Array(this.tint), 4));
    g.computeBoundingSphere();
    return g;
  }
  get bytes(): number { return (this.pos.length + this.open.length + this.pool.length + this.tint.length) * 4; }
}

/** A jet as a tube along a path: (s along 0..1, seed, kind, shut). */
class JetGeo {
  pos: number[] = [];
  nrm: number[] = [];
  jet: number[] = [];
  /** A tube through `path`, radius r(s), `rw` stretching it sideways (a sheet over a lip). */
  tube(path: V3[], r: (s: number) => number, seed: number, kind: number, shut: number, side: V3 | null = null, rw = 1): void {
    const sides = 6;
    const rings: { p: V3; n: V3 }[][] = [];
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      const s0 = side ? new THREE.Vector3(...side) : new THREE.Vector3(0, 1, 0).cross(t);
      if (s0.lengthSq() < 1e-6) s0.set(1, 0, 0);
      s0.normalize();
      const s1 = new THREE.Vector3().crossVectors(t, s0).normalize();
      const rr = r(i / (path.length - 1));
      const ring: { p: V3; n: V3 }[] = [];
      for (let k = 0; k < sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        const c = Math.cos(ang), sn = Math.sin(ang);
        const nx = s0.x * c * rw + s1.x * sn, ny = s0.y * c * rw + s1.y * sn, nz = s0.z * c * rw + s1.z * sn;
        ring.push({ p: [path[i][0] + nx * rr, path[i][1] + ny * rr, path[i][2] + nz * rr], n: [s0.x * c + s1.x * sn * rw, s0.y * c + s1.y * sn * rw, s0.z * c + s1.z * sn * rw] });
      }
      rings.push(ring);
    }
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let k = 0; k < sides; k++) {
        const a = rings[i][k], b = rings[i][(k + 1) % sides], c = rings[i + 1][(k + 1) % sides], d = rings[i + 1][k];
        const s0 = i / (rings.length - 1), s1 = (i + 1) / (rings.length - 1);
        const v = (q: { p: V3; n: V3 }, s: number): void => { this.pos.push(...q.p); this.nrm.push(...q.n); this.jet.push(s, seed, kind, shut); };
        v(a, s0); v(b, s0); v(c, s1);
        v(a, s0); v(c, s1); v(d, s1);
      }
    }
  }
  get triangles(): number { return this.pos.length / 9; }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute("aJet", new THREE.BufferAttribute(new Float32Array(this.jet), 4));
    g.computeBoundingSphere();
    return g;
  }
  get bytes(): number { return (this.pos.length + this.nrm.length + this.jet.length) * 4; }
}

/** The path of a free jet: from p at velocity v until it falls to y1. */
export function jetPath(p: V3, v: V3, y1: number, steps = 10): V3[] {
  // Time to come down to y1: y = p.y + v.y t - g/2 t^2.
  const g = 9.81;
  const disc = v[1] * v[1] + 2 * g * (p[1] - y1);
  const T = (v[1] + Math.sqrt(Math.max(0, disc))) / g;
  const out: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (T * i) / steps;
    out.push([p[0] + v[0] * t, p[1] + v[1] * t - 0.5 * g * t * t, p[2] + v[2] * t]);
  }
  return out;
}

// =====================================================================================
// The build: everything as arrays, so the gate can measure it under Bun.
// =====================================================================================

export interface WaterReport {
  baths: { name: string; rooms: string[]; frigidariumRound: boolean; oculus: boolean; labra: number; natatio: boolean; pools: number; outside: string[] }[];
  /** Per fountain: triangles of spout head and pipe, of jet, and droplets placed. */
  fountains: { head: Head; spoutTris: number; jetTris: number; drops: number; basinWater: number; rim: number }[];
  towers: number;
  castellum: boolean;
  /** Per atrium pool: water level and rim top. */
  impluvia: { water: number; rim: number }[];
  steamSprites: number;
  stoneTris: number;
  waterTris: number;
  jetTris: number;
  bytes: number;
}

export interface WaterBuild {
  stone: Geo;
  water: WaterGeo;
  film: WaterGeo;
  jets: JetGeo;
  /** Droplet emitters: x, y, z, seed; and (spread m/s, up m/s, rate /s, size m). */
  drops: number[][];
  steam: SteamSource[];
  sites: BathSite[];
  fountains: Fountain[];
  towers: WaterTower[];
  castellum: Castellum | null;
  lamps: Lamp[];
  report: WaterReport;
}

export interface WaterOptions {
  data: PompeiiData;
  sites: WaterSites;
  groundAt: (x: number, z: number) => number;
  lean?: boolean;
  /** Probe for the gate: leave out the spout heads and jets, the frigidarium dome, the rims. */
  probe?: { noSpouts?: boolean; noJets?: boolean; squareFrigidarium?: boolean; noRims?: boolean; noLabra?: boolean; noTowers?: boolean };
}

const WALL_T = 0.45;
const ROOF_PITCH = Math.tan((30 * Math.PI) / 180);
const tileC: RGB = [0.62, 0.3, 0.2];
const creamC: RGB = [0.86, 0.8, 0.66];
const lavaC: RGB = [0.31, 0.3, 0.29];
const leadC: RGB = [0.44, 0.45, 0.47];
const stoneC: RGB = [0.5, 0.47, 0.42];

export function buildWater(opts: WaterOptions): WaterBuild {
  const { data, groundAt } = opts;
  const probe = opts.probe ?? {};
  const tier = opts.lean ? WATER_TIERS.lean : WATER_TIERS.full;
  const G = new Geo(), Wt = new WaterGeo(), Fm = new WaterGeo(), J = new JetGeo();
  const drops: number[][] = [];
  const lamps: Lamp[] = [];
  const report: WaterReport = { baths: [], fountains: [], towers: 0, castellum: false, impluvia: [], steamSprites: 0, stoneTris: 0, waterTris: 0, jetTris: 0, bytes: 0 };

  // --- baths ------------------------------------------------------------------------
  const floors = new Map(opts.sites.baths.map((b) => [b.name, { ring: b.ring, g: b.g }]));
  // Terraced: the Stabian footprint falls 2.4 m across, so one floor level
  // would stand its low side a storey over the street. Each room is level on
  // the highest ground under it (the steps between are at the doors), the
  // court follows the ground, and a court pool is level on its own patch.
  const sites = bathSites(data, floors).map((s): BathSite => {
    const levels: Record<string, number> = {};
    for (const r of s.plan.rooms) levels[r.id] = Math.max(s.g, highGround(roomOutline(s.frame, r), groundAt) + 0.05);
    for (const p of s.plan.pools) {
      if (p.room || !p.rect) continue;
      const [e0, e1, n0, n1] = p.rect;
      const m = 0.6;
      levels[p.id] = highGround([...toWorld(s.frame, e0 - m, n0 - m), ...toWorld(s.frame, e1 + m, n0 - m), ...toWorld(s.frame, e1 + m, n1 + m), ...toWorld(s.frame, e0 - m, n1 + m)], groundAt) + 0.05;
    }
    return { ...s, levels };
  });
  const steam: SteamSource[] = [];
  for (const site of sites) {
    const r = buildBath(site, G, Wt, J, drops, probe, groundAt);
    report.baths.push(r);
    steam.push(...steamSources(site));
    let li = 0;
    for (const l of bathLamps(site)) {
      lamps.push({
        kind: l.hanging ? LampKind.Hanging : LampKind.Lucerna, role: "baths", x: l.x, y: l.y, z: l.z, yaw: l.yaw, face: l.yaw,
        nozzles: l.hanging ? 2 : 1, power: l.hanging ? 1.2 : 1, outH: 22 + ((li * 0.37) % 1), seed: (li * 0.618) % 1, rich: false,
      });
      li++;
    }
  }
  report.steamSprites = steam.reduce((s, q) => s + Math.round(tier.steam * q.rate), 0);

  // --- fountains ---------------------------------------------------------------------
  const fountains = placeFountains(data, opts.sites, groundAt);
  fountains.forEach((f, i) => {
    const t0 = G.triangles;
    const r = buildFountain(f, i, G, Wt, Fm, J, drops, tier.drops, probe, groundAt);
    report.fountains.push({ ...r, head: f.head });
    void t0;
  });

  // --- towers and the castellum ---------------------------------------------------------
  const towers = probe.noTowers ? [] : placeTowers(data, fountains);
  for (const t of towers) buildTower(t, G);
  report.towers = towers.length;
  const castellum = placeCastellum(data, groundAt);
  if (castellum) { buildCastellum(castellum, G); report.castellum = true; }

  // --- atrium pool rims -------------------------------------------------------------------
  for (const p of opts.sites.impluvia) {
    const rimTop = p.water + (probe.noRims ? -0.04 : IMPLUVIUM_RIM);
    report.impluvia.push({ water: p.water, rim: rimTop });
    if (probe.noRims) continue;
    impluviumRim(p.ring, p.floor, rimTop, G);
  }

  report.stoneTris = G.triangles;
  report.waterTris = Wt.triangles + Fm.triangles;
  report.jetTris = J.triangles;
  report.bytes = G.bytes + Wt.bytes + Fm.bytes + J.bytes + drops.length * 32 + report.steamSprites * 48;
  return { stone: G, water: Wt, film: Fm, jets: J, drops, steam, sites, fountains, towers, castellum, lamps, report };
}

// =====================================================================================
// A bath, room by room.
// =====================================================================================

interface PlaneWall { a: [number, number]; b: [number, number]; inE: number; inN: number }

function sideOf(rect: [number, number, number, number], s: Side): PlaneWall {
  const [e0, e1, n0, n1] = rect;
  switch (s) {
    case "e0": return { a: [e0, n0], b: [e0, n1], inE: 1, inN: 0 };
    case "e1": return { a: [e1, n0], b: [e1, n1], inE: -1, inN: 0 };
    case "n0": return { a: [e0, n0], b: [e1, n0], inE: 0, inN: 1 };
    default: return { a: [e0, n1], b: [e1, n1], inE: 0, inN: -1 };
  }
}

const SIDES: Side[] = ["e0", "e1", "n0", "n1"];

/** The highest ground inside a ring, sampled every 2 m and at its corners. */
function highGround(ring: number[], groundAt: (x: number, z: number) => number): number {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]);
    top = Math.max(top, groundAt(ring[i], ring[i + 1]));
  }
  for (let x = x0; x <= x1; x += 2) for (let z = z0; z <= z1; z += 2) if (pointInRing(ring, x, z)) top = Math.max(top, groundAt(x, z));
  return top;
}

function roomFinish(r: RoomPlan): { wall: number; floor: number; shut: number } {
  switch (r.kind) {
    case "apodyterium": return { wall: r.niches ? F.niches : F.painted, floor: F.marble, shut: 0.6 };
    case "frigidarium": return { wall: F.painted, floor: F.marble, shut: 0.72 };
    case "laconicum": return { wall: F.painted, floor: F.marble, shut: 0.72 };
    case "tepidarium": return { wall: F.painted, floor: F.marble, shut: 0.66 };
    case "caldarium": return { wall: F.painted, floor: F.marble, shut: 0.5 };
    case "praefurnium": return { wall: F.signinum, floor: F.signinum, shut: 0.75 };
    default: return { wall: F.painted, floor: F.signinum, shut: 0.66 };
  }
}

/** Segmental barrel vault: rise a quarter of the span. Height over the springline at s (-W/2..W/2). */
function vaultRise(W: number, s: number): number {
  const rise = W * 0.25;
  const R = (W * W / 4 + rise * rise) / (2 * rise);
  return rise - R + Math.sqrt(Math.max(0, R * R - s * s));
}

function buildBath(site: BathSite, G: Geo, Wt: WaterGeo, J: JetGeo, drops: number[][], probe: NonNullable<WaterOptions["probe"]>, groundAt: (x: number, z: number) => number): WaterReport["baths"][number] {
  const { plan, frame: f, g } = site;
  const W = (e: number, n: number): [number, number] => toWorld(f, e, n);
  const W3 = (e: number, n: number, y: number): V3 => { const [x, z] = W(e, n); return [x, y, z]; };
  const dirW = (de: number, dn: number): V3 => [de * f.ex + dn * f.nx, 0, de * f.ez + dn * f.nz];
  const seed = 0.37;
  const mat = (rgb: RGB, style: number, p1 = 0, p2 = 0): Mat => ({ rgb, style, p1, p2, seed });
  const rooms = plan.rooms.map((r) => probe.squareFrigidarium && r.round ? { ...r, round: undefined, rect: [r.round.e - r.round.r, r.round.e + r.round.r, r.round.n - r.round.r, r.round.n + r.round.r] as [number, number, number, number], oculus: undefined } : r);
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const dry = !!plan.dry;

  // Is (e, n) inside some room other than `skip` (walls included)?
  const inRoom = (e: number, n: number, skip: RoomPlan | null): RoomPlan | null => {
    for (const r of rooms) {
      if (r === skip) continue;
      if (r.rect) {
        const [e0, e1, n0, n1] = r.rect;
        if (e >= e0 - WALL_T && e <= e1 + WALL_T && n >= n0 - WALL_T && n <= n1 + WALL_T) return r;
      } else if (r.round && Math.hypot(e - r.round.e, n - r.round.n) <= r.round.r + WALL_T + 0.1) return r;
    }
    return null;
  };
  // Each room's (and court pool's) own level: data/pompeiibaths.ts BathSite.levels.
  const lv = (id: string): number => site.levels?.[id] ?? g;
  const floorOf = (r: RoomPlan): number => lv(r.id) + r.floor;
  const eaveOf = (r: RoomPlan): number => floorOf(r) + r.spring + (r.round ? 0.9 : 0.6);
  const toPlan = (x: number, z: number): [number, number] => [(x - f.cx) * f.ex + (z - f.cz) * f.ez, (x - f.cx) * f.nx + (z - f.cz) * f.nz];
  /** Lowest ground under a room's corners: where its outside walls start. */
  const footOf = (r: RoomPlan): number => {
    const o = roomOutline(f, r, 8);
    let m = Infinity;
    for (let i = 0; i < o.length; i += 2) m = Math.min(m, groundAt(o[i], o[i + 1]));
    return Math.min(m, lv(r.id)) - 0.2;
  };

  // --- the court: sand following the ground, in 2 m cells, round the rooms and court pools ---
  {
    const ring = site.ring;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
    const C = 2;
    const sandM = mat([0.72, 0.64, 0.5], S.sand);
    const inCourtPool = (e: number, n: number): boolean => plan.pools.some((p) => !p.room && p.rect && e > p.rect[0] - 0.4 && e < p.rect[1] + 0.4 && n > p.rect[2] - 0.4 && n < p.rect[3] + 0.4);
    const yAt = (x: number, z: number): number => groundAt(x, z) + 0.08;
    for (let x = x0; x < x1; x += C) for (let z = z0; z < z1; z += C) {
      const cx = x + C / 2, cz = z + C / 2;
      if (!pointInRing(ring, cx, cz)) continue;
      const [e, n] = toPlan(cx, cz);
      if (inRoom(e, n, null) || inCourtPool(e, n)) continue;
      G.quad([x, yAt(x, z), z], [x + C, yAt(x + C, z), z], [x + C, yAt(x + C, z + C), z + C], [x, yAt(x, z + C), z + C], [0, 1, 0], sandM, [[x, z, 0, 0], [x + C, z, 0, 0], [x + C, z + C, 0, 0], [x, z + C, 0, 0]]);
    }
  }

  // --- the outer wall on the footprint, cut where a door or the entrance goes through ---
  {
    const ring = site.ring;
    const n = ring.length / 2;
    const ccw = ringArea(ring) > 0;
    const H = 6.2;
    // Gaps: each door whose line runs out to the ring within 3.5 m, and the palaestra entrance.
    const gaps: { x: number; z: number; w: number; h: number }[] = [];
    for (const d of plan.doors) {
      for (const sgn of [1, -1]) {
        for (let t = 0.2; t < 3.6; t += 0.2) {
          const [x, z] = W(d.e + (d.axis === "e" ? sgn * t : 0), d.n + (d.axis === "n" ? sgn * t : 0));
          if (!pointInRing(ring, x, z)) { gaps.push({ x, z, w: d.w, h: d.h }); break; }
        }
      }
    }
    if (plan.court) {
      // The palaestra's entrance from the street on its low-n side.
      const [ce0, ce1, cn0] = plan.court;
      for (let t = 0; t < 12; t += 0.25) {
        const [x, z] = W((ce0 + ce1) / 2 + 4, cn0 - t);
        if (!pointInRing(ring, x, z)) { gaps.push({ x, z, w: 2.6, h: 3.4 }); break; }
      }
    }
    for (let i = 0; i < n; i++) {
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[((i + 1) % n) * 2], bz = ring[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      // Outward normal: right of a->b for a counter-clockwise ring in x,z with +z south.
      let ox = tz, oz = -tx;
      if (!ccw) { ox = -ox; oz = -oz; }
      const doors: { u0: number; u1: number; h: number }[] = [];
      for (const q of gaps) {
        const u = (q.x - ax) * tx + (q.z - az) * tz, d = Math.abs((q.x - ax) * ox + (q.z - az) * oz);
        if (d < 1.2 && u > q.w / 2 + 0.1 && u < L - q.w / 2 - 0.1) doors.push({ u0: u - q.w / 2, u1: u + q.w / 2, h: q.h });
      }
      // Each stretch from below the street to a top 6 m over its higher end.
      const ga = groundAt(ax, az), gb = groundAt(bx, bz);
      const low = Math.min(ga, gb) - 0.3, top = Math.max(ga, gb) + H;
      const lift = Math.max(ga, gb) - low;
      const cuts = doors.map((q) => ({ ...q, h: q.h + lift }));
      wallFace(G, [ax, az], [bx, bz], low, top, [ox, oz], { doors: cuts, m: mat(creamC, S.plaster, 60, 1), floorY: low, H: top - low });
      const ix = -ox * 0.5, iz = -oz * 0.5;
      wallFace(G, [ax + ix, az + iz], [bx + ix, bz + iz], low, top, [-ox, -oz], { doors: cuts, m: mat(creamC, S.plaster, 60, 255), floorY: low, H: top - low });
      // The top of the wall, and the jambs of the gaps through it.
      G.quad([ax, top, az], [bx, top, bz], [bx + ix, top, bz + iz], [ax + ix, top, az + iz], [0, 1, 0], mat(creamC, S.plaster, 60, 255));
      for (const d of cuts) for (const u of [d.u0, d.u1]) {
        const px = ax + tx * u, pz = az + tz * u, s = u === d.u0 ? 1 : -1;
        G.quad([px, low, pz], [px + ix, low, pz + iz], [px + ix, low + d.h, pz + iz], [px, low + d.h, pz], [tx * s, 0, tz * s], mat(creamC, S.plaster, 60, 255));
      }
    }
  }

  // --- rooms ---
  const roomsBuilt: string[] = [];
  let frigRound = false, oculus = false;
  for (const r of rooms) {
    roomsBuilt.push(r.kind);
    const fin = roomFinish(r);
    const fy = floorOf(r);
    const foot = footOf(r);
    const shut = Math.round(fin.shut * 255);
    const wallM = mat([0.78, 0.6, 0.3], S.bath, fin.wall, shut);
    const vaultM = mat([0.88, 0.86, 0.8], S.bath, F.vault, shut);
    const floorM = mat(fin.floor === F.marble ? [0.9, 0.84, 0.74] : [0.62, 0.36, 0.28], S.bath, fin.floor, shut);
    const eave = eaveOf(r);
    if (r.round) {
      frigRound = frigRound || r.kind === "frigidarium";
      if (r.oculus) oculus = true;
      roundRoom(G, r, W3, fy, foot, eave, shut, mat, plan.pools.find((p) => p.room === r.id && p.round)?.round?.r ?? 0);
    } else {
      rectRoom(G, r, plan.doors, W, W3, dirW, fy, foot, eave, wallM, vaultM, floorM, mat, inRoom, eaveOf, floorOf, plan.pools.filter((p) => p.room === r.id && p.rect));
      if (r.niches) {
        // The masonry bench along the long walls.
        const [e0, e1, n0, n1] = r.rect!;
        const long: Side[] = e1 - e0 >= n1 - n0 ? ["n0", "n1"] : ["e0", "e1"];
        for (const s of long) {
          const w = sideOf(r.rect!, s);
          const a = w.a, b = w.b;
          const ie = w.inE * 0.45, inn = w.inN * 0.45;
          const top = fy + 0.45;
          const benchM = mat([0.84, 0.8, 0.72], S.bath, F.marble, shut);
          const p0 = W3(a[0] + ie, a[1] + inn, top), p1 = W3(b[0] + ie, b[1] + inn, top);
          G.quad(W3(a[0], a[1], top), W3(b[0], b[1], top), p1, p0, [0, 1, 0], benchM);
          G.quad(p0, p1, W3(b[0] + ie, b[1] + inn, fy), W3(a[0] + ie, a[1] + inn, fy), dirW(w.inE, w.inN), benchM);
        }
      }
    }
    if (r.kind === "praefurnium" && !dry) {
      // The boiler: a bronze drum on its masonry stove, between the two caldaria.
      const [e0, e1, n0, n1] = r.rect!;
      const [x, z] = W(e1 - 3, (n0 + n1) / 2);
      const m = new THREE.Matrix4().makeTranslation(x, fy + 0.6 + 0.75, z);
      G.mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.5, 14), m, mat([0.45, 0.3, 0.16], S.bath, F.boiler, shut));
      G.mesh(new THREE.BoxGeometry(1.6, 0.6, 1.6), new THREE.Matrix4().makeTranslation(x, fy + 0.3, z), mat([0.5, 0.3, 0.22], S.bath, F.signinum, shut));
      void e0;
    }
  }

  // --- pools ---
  let pools = 0, natatio = false;
  for (const p of plan.pools) {
    const room = p.room ? roomById.get(p.room) ?? null : null;
    const shut = room ? Math.round(roomFinish(room).shut * 255) : 0;
    // A pool's levels are over its room's base, or a court pool's own patch of ground.
    const base = room ? lv(room.id) : lv(p.id);
    const roomFloor = room ? floorOf(room) : Math.min(base, ...(p.rect ? [groundAt(...W(p.rect[0], p.rect[2])), groundAt(...W(p.rect[1], p.rect[3]))] : [])) - 0.1;
    const lining: RGB = p.kind === "natatio" ? [0.55, 0.62, 0.62] : p.hot ? [0.8, 0.78, 0.72] : [0.75, 0.8, 0.8];
    const liningM = mat(p.kind === "natatio" ? [0.62, 0.4, 0.32] : [0.86, 0.84, 0.8], S.bath, p.kind === "natatio" ? F.signinum : F.marble, shut);
    const rimM = mat([0.88, 0.86, 0.8], S.bath, F.marble, shut);
    pools++;
    if (p.kind === "natatio") natatio = true;
    // The opening over the water: the oculus, open sky, or a closed room.
    let open: W4 = [0, 0, 0, 0];
    if (room?.round && room.oculus) {
      const [cx, cz] = W(room.round.e, room.round.n);
      open = [cx, cz, room.spring + room.floor + domeRise(room) - p.water, room.oculus];
    } else if (room) open = [0, 0, 0, -1];
    const kind = p.hot ? WK.Hot : WK.Still;
    if (p.round) {
      const { e, n, r } = p.round;
      roundPool(G, W3, e, n, r, base + p.rim, roomFloor, base + p.bottom, rimM, liningM);
      if (!dry) {
        const ring: number[] = [];
        for (let k = 0; k < 28; k++) { const a = (k / 28) * Math.PI * 2; ring.push(...W(e + Math.cos(a) * r, n + Math.sin(a) * r)); }
        Wt.poly(ring, base + p.water, open, [kind, p.water - p.bottom, 0, 0], [...lining, shut / 255]);
      }
    } else {
      const [e0, e1, n0, n1] = p.rect!;
      rectPool(G, W3, dirW, p.rect!, base + p.rim, roomFloor, base + p.bottom, rimM, liningM, p.kind);
      if (!dry) {
        const ring = [...W(e0, n0), ...W(e1, n0), ...W(e1, n1), ...W(e0, n1)];
        Wt.poly(ring, base + p.water, open, [kind, p.water - p.bottom, 0, 0], [...lining, shut / 255]);
      }
    }
  }

  // --- labra: the marble basin on its foot, a jet in the middle ---
  let labra = 0;
  if (!probe.noLabra) for (const l of plan.labra) {
    const room = roomById.get(l.room);
    if (!room) continue;
    const fy = floorOf(room);
    const shut = Math.round(roomFinish(room).shut * 255);
    const [x, z] = W(l.e, l.n);
    const rimY = lv(room.id) + l.rim;
    const R = l.r;
    // Lathe profile from the floor up: plinth, foot, stem, the bowl's underside, its lip, and the inside.
    const prof: [number, number][] = [
      [0.42, 0], [0.42, 0.12], [0.3, 0.14], [0.2, 0.22], [0.16, 0.45], [0.18, rimY - fy - 0.38], [0.3, rimY - fy - 0.22],
      [R * 0.7, rimY - fy - 0.1], [R, rimY - fy - 0.02], [R + 0.03, rimY - fy], [R - 0.04, rimY - fy + 0.005], [R * 0.75, rimY - fy - 0.09], [0.001, rimY - fy - 0.14],
    ];
    G.mesh(new THREE.LatheGeometry(prof.map(([a, b]) => new THREE.Vector2(a, b)), 24), new THREE.Matrix4().makeTranslation(x, fy, z), mat([0.9, 0.88, 0.84], S.bath, F.marble, shut));
    if (!dry) {
      const ring: number[] = [];
      for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; ring.push(x + Math.cos(a) * (R - 0.04), z + Math.sin(a) * (R - 0.04)); }
      const wy = rimY - 0.035;
      Wt.poly(ring, wy, [0, 0, 0, -1], [WK.Labrum, 0.1, x, z], [0.9, 0.9, 0.86, shut / 255]);
      // The jet: straight up from a bronze nozzle, falling back as a crown.
      const v0 = Math.sqrt(2 * 9.81 * l.jet);
      J.tube([[x, wy, z], [x, wy + l.jet * 0.5, z], [x, wy + l.jet, z]], (s) => 0.012 - 0.006 * s, 0.11, 1, shut / 255);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.3;
        J.tube(jetPath([x, wy + l.jet, z], [Math.cos(a) * 0.45, 0.15, Math.sin(a) * 0.45], wy, 8), (s) => 0.006 + 0.003 * s, k * 0.13, 1, shut / 255);
        const land = jetPath([x, wy + l.jet, z], [Math.cos(a) * 0.45, 0.15, Math.sin(a) * 0.45], wy, 8).at(-1)!;
        drops.push([land[0], wy, land[2], k / 6, 0.35, 0.5, 2.6, 0.006]);
      }
      void v0;
    }
    labra++;
  }

  // --- porticos round the palaestra ---
  for (const pc of plan.porticos) {
    const [ae, an] = pc.a, [be, bn] = pc.b;
    const L = Math.hypot(be - ae, bn - an);
    const te = (be - ae) / L, tn = (bn - an) / L;
    const le = -tn * pc.toward, ln = te * pc.toward;
    const cnt = Math.max(2, Math.round(L / pc.spacing));
    // One level for the entablature, from the line's highest ground; each column stands on its own.
    let pg = g;
    for (let k = 0; k <= cnt; k++) pg = Math.max(pg, groundAt(...W(ae + te * (L * k) / cnt, an + tn * (L * k) / cnt)) + 0.08);
    for (let k = 0; k <= cnt; k++) {
      const e = ae + te * (L * k) / cnt, n = an + tn * (L * k) / cnt;
      const [x, z] = W(e, n);
      const y0 = groundAt(x, z) + 0.05;
      column(G, x, y0, z, pg + pc.h - y0, 0.26, seed);
    }
    const top = pg + pc.h + 0.45, back = pg + pc.h + 0.45 + pc.depth * 0.32;
    const a0 = W3(ae, an, top), b0 = W3(be, bn, top);
    const a1 = W3(ae + le * pc.depth, an + ln * pc.depth, back), b1 = W3(be + le * pc.depth, bn + ln * pc.depth, back);
    // The entablature: a beam along the column tops.
    const beam = (y0: number, y1: number, o: number): void => {
      const p0 = W3(ae - le * o, an - ln * o, y0), p1 = W3(be - le * o, bn - ln * o, y0);
      const q0 = W3(ae - le * o, an - ln * o, y1), q1 = W3(be - le * o, bn - ln * o, y1);
      G.quad(p0, p1, q1, q0, dirW(-le, -ln), mat([0.88, 0.84, 0.76], S.stucco), [[0, 0, L, 1], [L, 0, L, 1], [L, 1, L, 1], [0, 1, L, 1]]);
    };
    beam(pg + pc.h, top, 0.3);
    const up = dirW(-le, -ln);
    G.quad(a0, b0, b1, a1, [up[0] * 0.5, 1, up[2] * 0.5], mat(tileC, S.tile), [[0, pc.depth, L, pc.depth], [L, pc.depth, L, pc.depth], [L, 0, L, pc.depth], [0, 0, L, pc.depth]]);
    G.quad(a0, b0, b1, a1, [-up[0] * 0.5, -1, -up[2] * 0.5], mat([0.42, 0.3, 0.2], S.wood));
  }

  return { name: plan.name, rooms: roomsBuilt, frigidariumRound: frigRound, oculus, labra, natatio, pools, outside: [] };
}

function domeRise(r: RoomPlan): number {
  return r.round ? r.round.r * 1.15 : 0;
}

interface WallOpts {
  doors?: { u0: number; u1: number; h: number }[];
  windows?: { u0: number; u1: number; y0: number; y1: number }[];
  /** Top edge height over y1 at u (a lunette under a vault). */
  top?: (u: number) => number;
  /** An arched opening from the floor: the apse's mouth. */
  arch?: { u0: number; u1: number; spring: number };
  m: Mat;
  floorY: number;
  H: number;
}

/**
 * A vertical wall face from a to b (world x,z), y0..y1, front toward `n`,
 * with door notches, an arch, windows as holes and an optional curved top.
 */
function wallFace(G: Geo, a: [number, number], b: [number, number], y0: number, y1: number, n: [number, number], o: WallOpts): void {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 0.05 || y1 - y0 < 0.02) return;
  const eu: V3 = [(b[0] - a[0]) / L, 0, (b[1] - a[1]) / L];
  const out: [number, number][] = [[0, 0]];
  const cuts = [...(o.doors ?? []).map((d) => ({ ...d, arch: false })), ...(o.arch ? [{ u0: o.arch.u0, u1: o.arch.u1, h: o.arch.spring - y0, arch: true }] : [])]
    .filter((d) => d.u0 > 0.02 && d.u1 < L - 0.02).sort((p, q) => p.u0 - q.u0);
  let last = 0;
  for (const d of cuts) {
    if (d.u0 < last + 0.05) continue;
    const h = Math.min(d.h, y1 - y0 - 0.05);
    out.push([d.u0, 0], [d.u0, h]);
    if (d.arch) {
      const r = (d.u1 - d.u0) / 2, c = (d.u0 + d.u1) / 2;
      const hh = Math.min(h + r, y1 - y0 - 0.05);
      for (let k = 1; k < 10; k++) { const t = Math.PI - (k / 10) * Math.PI; out.push([c + Math.cos(t) * r, Math.min(hh, h + Math.sin(t) * r)]); }
    }
    out.push([d.u1, h], [d.u1, 0]);
    last = d.u1;
  }
  out.push([L, 0], [L, y1 - y0]);
  if (o.top) {
    for (let k = 1; k < 12; k++) { const u = L - (L * k) / 12; out.push([u, y1 - y0 + o.top(u)]); }
  }
  out.push([0, y1 - y0]);
  const holes = (o.windows ?? []).filter((w) => w.u0 > 0.1 && w.u1 < L - 0.1).map((w): [number, number][] => [[w.u0, w.y0 - y0], [w.u1, w.y0 - y0], [w.u1, w.y1 - y0], [w.u0, w.y1 - y0]]);
  G.face([a[0], y0, a[1]], eu, [0, 1, 0], out, holes, [n[0], 0, n[1]], o.m, (u, v) => [u, v + y0 - o.floorY, L, o.H]);
}

function rectRoom(
  G: Geo, r: RoomPlan, doors: DoorPlan[],
  W: (e: number, n: number) => [number, number], W3: (e: number, n: number, y: number) => V3, dirW: (de: number, dn: number) => V3,
  fy: number, g: number /* the foot of its outside walls */, eave: number, wallM: Mat, vaultM: Mat, floorM: Mat, mat: (rgb: RGB, s: number, p1?: number, p2?: number) => Mat,
  inRoom: (e: number, n: number, skip: RoomPlan | null) => RoomPlan | null, eaveOf: (r: RoomPlan) => number, floorOf: (r: RoomPlan) => number,
  pools: { rect?: [number, number, number, number] }[],
): void {
  const rect = r.rect!;
  const [e0, e1, n0, n1] = rect;
  const alongE = e1 - e0 >= n1 - n0;
  const span = alongE ? n1 - n0 : e1 - e0;
  const spring = fy + r.spring;
  const H = r.spring + span * 0.25;
  for (const s of SIDES) {
    const w = sideOf(rect, s);
    const isEnd = alongE ? s === "e0" || s === "e1" : s === "n0" || s === "n1";
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    // Doors in this wall: on its line, within its length.
    const mine = doors.filter((d) => {
      const onLine = (s === "e0" || s === "e1") ? d.axis === "e" && Math.abs(d.e - w.a[0]) < 0.5 : d.axis === "n" && Math.abs(d.n - w.a[1]) < 0.5;
      const t = (s === "e0" || s === "e1") ? d.n - w.a[1] : d.e - w.a[0];
      return onLine && t > d.w / 2 && t < L - d.w / 2;
    }).map((d) => {
      const t = (s === "e0" || s === "e1") ? d.n - w.a[1] : d.e - w.a[0];
      // The door's sill: the higher of the two floors it joins.
      const other = inRoom(d.e + w.inE * -0.8, d.n + w.inN * -0.8, r);
      const sill = Math.max(fy, other ? floorOf(other) : fy);
      return { u0: t - d.w / 2, u1: t + d.w / 2, h: sill - fy + d.h, d, sill };
    });
    const windows: { u0: number; u1: number; y0: number; y1: number }[] = [];
    if (r.windows?.includes(s)) {
      if (isEnd) windows.push({ u0: L / 2 - 0.75, u1: L / 2 + 0.75, y0: spring + 0.15, y1: spring + span * 0.25 * 0.72 });
      else windows.push({ u0: L / 2 - 0.7, u1: L / 2 + 0.7, y0: spring - 1.3, y1: spring - 0.3 });
    }
    const arch = r.apse?.side === s ? { u0: L / 2 - r.apse.r, u1: L / 2 + r.apse.r, spring: spring - 0.3 } : undefined;
    const top = isEnd ? (u: number) => vaultRise(span, u - span / 2) : undefined;
    wallFace(G, W(...w.a), W(...w.b), fy, spring, [dirW(w.inE, w.inN)[0], dirW(w.inE, w.inN)[2]], { doors: mine, windows, top, arch, m: wallM, floorY: fy, H });
    // The outside of the wall, where no room stands against it.
    const oe = -w.inE * WALL_T, on = -w.inN * WALL_T;
    const ext = (t: number): [number, number] => {
      const e = w.a[0] + (w.b[0] - w.a[0]) * t, n = w.a[1] + (w.b[1] - w.a[1]) * t;
      return [e + oe * 1.8, n + on * 1.8];
    };
    let nb: RoomPlan | null = null;
    for (const t of [0.15, 0.5, 0.85]) nb = nb ?? inRoom(...ext(t), r);
    const xa: [number, number] = [w.a[0] + oe - (w.b[0] - w.a[0]) / L * WALL_T, w.a[1] + on - (w.b[1] - w.a[1]) / L * WALL_T];
    const xb: [number, number] = [w.b[0] + oe + (w.b[0] - w.a[0]) / L * WALL_T, w.b[1] + on + (w.b[1] - w.a[1]) / L * WALL_T];
    const outN = dirW(-w.inE, -w.inN);
    const exM = mat(creamC, S.plaster, 60, 255);
    const shift = <Q extends { u0: number; u1: number }>(q: Q): Q => ({ ...q, u0: q.u0 + WALL_T, u1: q.u1 + WALL_T });
    if (!nb) {
      wallFace(G, W(...xa), W(...xb), g, eave, [outN[0], outN[2]], {
        doors: mine.map((q) => ({ ...shift(q), h: q.sill - g + q.d.h })), windows: windows.map(shift),
        arch: arch ? { u0: arch.u0 + WALL_T, u1: arch.u1 + WALL_T, spring: arch.spring } : undefined, m: exM, floorY: g, H: eave - g,
      });
    } else {
      const ne = eaveOf(nb) + 0.4;
      if (ne < eave) wallFace(G, W(...xa), W(...xb), ne, eave, [outN[0], outN[2]], { m: exM, floorY: g, H: eave - g });
    }
    // Reveals of the doors and windows through the wall's thickness.
    const rev = (u0: number, u1: number, ya: number, yb: number, depth: number, bottom: boolean): void => {
      const P = (u: number, d: number, y: number): V3 => {
        const t = u / L;
        return W3(w.a[0] + (w.b[0] - w.a[0]) * t - w.inE * d, w.a[1] + (w.b[1] - w.a[1]) * t - w.inN * d, y);
      };
      const tu = dirW((w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L);
      G.quad(P(u0, 0, ya), P(u0, depth, ya), P(u0, depth, yb), P(u0, 0, yb), tu, wallM, [[0, ya - fy, 1, 3], [0, ya - fy, 1, 3], [0, yb - fy, 1, 3], [0, yb - fy, 1, 3]]);
      G.quad(P(u1, 0, ya), P(u1, depth, ya), P(u1, depth, yb), P(u1, 0, yb), [-tu[0], 0, -tu[2]], wallM, [[0, ya - fy, 1, 3], [0, ya - fy, 1, 3], [0, yb - fy, 1, 3], [0, yb - fy, 1, 3]]);
      G.quad(P(u0, 0, yb), P(u1, 0, yb), P(u1, depth, yb), P(u0, depth, yb), [0, -1, 0], wallM);
      if (bottom) G.quad(P(u0, 0, ya), P(u1, 0, ya), P(u1, depth, ya), P(u0, depth, ya), [0, 1, 0], wallM);
    };
    // Half the gap to the next room (doors between rooms), or the wall's thickness.
    for (const q of mine) {
      const other = inRoom(q.d.e - w.inE * 0.8, q.d.n - w.inN * 0.8, r);
      const depth = other ? 0.3 : WALL_T;
      rev(q.u0, q.u1, q.sill, q.sill + q.d.h, depth, false);
      G.quad(...([[q.u0, 0], [q.u1, 0], [q.u1, depth], [q.u0, depth]].map(([u, d]) => {
        const t = u / L;
        return W3(w.a[0] + (w.b[0] - w.a[0]) * t - w.inE * d, w.a[1] + (w.b[1] - w.a[1]) * t - w.inN * d, q.sill);
      }) as [V3, V3, V3, V3]), [0, 1, 0], floorM);
      // The step up onto a hypocaust floor, seen from the lower room.
      if (q.sill > fy + 0.02) {
        const P = (u: number, y: number): V3 => { const t = u / L; return W3(w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t, y); };
        G.quad(P(q.u0, fy), P(q.u1, fy), P(q.u1, q.sill), P(q.u0, q.sill), dirW(w.inE, w.inN), floorM);
      }
    }
    for (const q of windows) if (!nb) rev(q.u0, q.u1, q.y0, q.y1, WALL_T, true);
  }

  // --- the vault ---
  {
    const segs = 12;
    const a0 = alongE ? e0 : n0, a1 = alongE ? e1 : n1, c = alongE ? (n0 + n1) / 2 : (e0 + e1) / 2;
    const P = (s: number, along: number): V3 => {
      const y = spring + vaultRise(span, s);
      return alongE ? W3(along, c + s, y) : W3(c + s, along, y);
    };
    const rise = span * 0.25, R = (span * span / 4 + rise * rise) / (2 * rise);
    let arc = 0;
    for (let k = 0; k < segs; k++) {
      const s0 = -span / 2 + (span * k) / segs, s1 = -span / 2 + (span * (k + 1)) / segs;
      const yc = spring + rise - R;
      const nrm = (s: number): V3 => {
        const y = spring + vaultRise(span, s);
        const ds = -s, dy = yc - y;
        return alongE ? [ds * dirW(0, 1)[0] + 0, dy, ds * dirW(0, 1)[2]] : [ds * dirW(1, 0)[0], dy, ds * dirW(1, 0)[2]];
      };
      const da = Math.hypot(s1 - s0, vaultRise(span, s1) - vaultRise(span, s0));
      const w0: W4 = [arc, 0, span, H], w1: W4 = [arc + da, 0, span, H], w2: W4 = [arc + da, a1 - a0, span, H], w3: W4 = [arc, a1 - a0, span, H];
      const pa = P(s0, a0), pb = P(s1, a0), pc = P(s1, a1), pd = P(s0, a1);
      G.tri(pa, pb, pc, nrm(s0), nrm(s1), nrm(s1), vaultM, w0, w1, w2);
      G.tri(pa, pc, pd, nrm(s0), nrm(s1), nrm(s0), vaultM, w0, w2, w3);
      arc += da;
    }
  }

  // --- the floor, less the pools sunk into it ---
  {
    let regions: [number, number, number, number][] = [[e0, e1, n0, n1]];
    for (const p of pools) {
      const [pe0, pe1, pn0, pn1] = p.rect!;
      const m = 0.3;
      const h: [number, number, number, number] = [pe0 - m, pe1 + m, pn0 - m, pn1 + m];
      regions = regions.flatMap((q) => subtractRect(q, h));
    }
    for (const [a, b, c, d] of regions) {
      G.quad(W3(a, c, fy), W3(b, c, fy), W3(b, d, fy), W3(a, d, fy), [0, 1, 0], floorM, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    }
  }

  // --- the apse: a half-round wall and its semi-dome ---
  if (r.apse) {
    const [ce, cn] = apseCentre(r);
    const ar = r.apse.r;
    const top = spring - 0.3;
    const segs = 12;
    for (let k = 0; k < segs; k++) {
      const t0 = (k / segs) * Math.PI, t1 = ((k + 1) / segs) * Math.PI;
      const [d0e, d0n] = apseOffset(r.apse.side, t0, ar), [d1e, d1n] = apseOffset(r.apse.side, t1, ar);
      const n0v = dirW(-d0e, -d0n), n1v = dirW(-d1e, -d1n);
      const u0 = t0 * ar, u1 = t1 * ar;
      const a = W3(ce + d0e, cn + d0n, fy), b = W3(ce + d1e, cn + d1n, fy), c = W3(ce + d1e, cn + d1n, top), d = W3(ce + d0e, cn + d0n, top);
      G.tri(a, b, c, n0v, n1v, n1v, wallM, [u0, 0, ar * Math.PI, H], [u1, 0, ar * Math.PI, H], [u1, top - fy, ar * Math.PI, H]);
      G.tri(a, c, d, n0v, n1v, n0v, wallM, [u0, 0, ar * Math.PI, H], [u1, top - fy, ar * Math.PI, H], [u0, top - fy, ar * Math.PI, H]);
      // Floor wedge.
      G.tri(W3(ce, cn, fy), a, b, [0, 1, 0], [0, 1, 0], [0, 1, 0], floorM, Z4, Z4, Z4);
      // Semi-dome: quarter sphere, rings of latitude.
      for (let j = 0; j < 6; j++) {
        const p0 = (j / 6) * Math.PI / 2, p1 = ((j + 1) / 6) * Math.PI / 2;
        const S3 = (t: number, p: number): V3 => { const [de, dn] = apseOffset(r.apse!.side, t, ar * Math.cos(p)); return W3(ce + de, cn + dn, top + ar * Math.sin(p)); };
        const N3 = (t: number, p: number): V3 => { const [de, dn] = apseOffset(r.apse!.side, t, Math.cos(p)); const v = dirW(-de, -dn); return [v[0], -Math.sin(p), v[2]]; };
        G.tri(S3(t0, p0), S3(t1, p0), S3(t1, p1), N3(t0, p0), N3(t1, p0), N3(t1, p1), vaultM, [u0, p0, 1, 1], [u1, p0, 1, 1], [u1, p1, 1, 1]);
        G.tri(S3(t0, p0), S3(t1, p1), S3(t0, p1), N3(t0, p0), N3(t1, p1), N3(t0, p1), vaultM, [u0, p0, 1, 1], [u1, p1, 1, 1], [u0, p1, 1, 1]);
      }
      // Outside: the apse wall and a half-cone roof.
      const R2 = ar + WALL_T;
      const [o0e, o0n] = apseOffset(r.apse.side, t0, R2), [o1e, o1n] = apseOffset(r.apse.side, t1, R2);
      const oa = W3(ce + o0e, cn + o0n, g), ob = W3(ce + o1e, cn + o1n, g), oc = W3(ce + o1e, cn + o1n, eave - 0.6), od = W3(ce + o0e, cn + o0n, eave - 0.6);
      const exM = mat(creamC, S.plaster, 60, 255);
      G.tri(oa, ob, oc, [-n0v[0], 0, -n0v[2]], [-n1v[0], 0, -n1v[2]], [-n1v[0], 0, -n1v[2]], exM, [u0, 0, 9, eave - g], [u1, 0, 9, eave - g], [u1, eave - g, 9, eave - g]);
      G.tri(oa, oc, od, [-n0v[0], 0, -n0v[2]], [-n1v[0], 0, -n1v[2]], [-n0v[0], 0, -n0v[2]], exM, [u0, 0, 9, eave - g], [u1, eave - g, 9, eave - g], [u0, eave - g, 9, eave - g]);
      const apex = W3(ce, cn, eave - 0.6 + (R2 + 0.2) * ROOF_PITCH);
      const [r0e, r0n] = apseOffset(r.apse.side, t0, R2 + 0.2), [r1e, r1n] = apseOffset(r.apse.side, t1, R2 + 0.2);
      G.tri(W3(ce + r0e, cn + r0n, eave - 0.6), W3(ce + r1e, cn + r1n, eave - 0.6), apex, [-n0v[0], 1.5, -n0v[2]], [-n1v[0], 1.5, -n1v[2]], [0, 1, 0], mat(tileC, S.tile), [u0, 0, 9, 3], [u1, 0, 9, 3], [(u0 + u1) / 2, R2, 9, 3]);
    }
  }

  // --- the roof: a gable over the vault, ridge along it ---
  {
    const o = WALL_T + 0.15;
    const [a0, a1] = alongE ? [e0 - o, e1 + o] : [n0 - o, n1 + o];
    const [s0, s1] = alongE ? [n0 - o, n1 + o] : [e0 - o, e1 + o];
    const half = (s1 - s0) / 2, mid = (s0 + s1) / 2;
    const ridge = eave + half * ROOF_PITCH;
    const P = (along: number, s: number, y: number): V3 => (alongE ? W3(along, s, y) : W3(s, along, y));
    const L = a1 - a0, slope = half / Math.cos(Math.atan(ROOF_PITCH));
    const sideN = (sg: number): V3 => { const d = alongE ? dirW(0, sg) : dirW(sg, 0); return [d[0] * ROOF_PITCH, 1, d[2] * ROOF_PITCH]; };
    const tw: [W4, W4, W4, W4] = [[0, 0, L, slope], [L, 0, L, slope], [L, slope, L, slope], [0, slope, L, slope]];
    G.quad(P(a0, s0, eave), P(a1, s0, eave), P(a1, mid, ridge), P(a0, mid, ridge), sideN(-1), mat(tileC, S.tile), tw);
    G.quad(P(a0, s1, eave), P(a1, s1, eave), P(a1, mid, ridge), P(a0, mid, ridge), sideN(1), mat(tileC, S.tile), tw);
    // Gable ends, plastered.
    for (const [a, sg] of [[a0 + 0.15, -1], [a1 - 0.15, 1]] as const) {
      const n = alongE ? dirW(sg, 0) : dirW(0, sg);
      G.tri(P(a, s0 + 0.15, eave), P(a, s1 - 0.15, eave), P(a, mid, ridge - 0.08), n, n, n, mat(creamC, S.plaster, 60, 255), [0, eave - g, half * 2, ridge - g], [half * 2, eave - g, half * 2, ridge - g], [half, ridge - g, half * 2, ridge - g]);
    }
  }
}

/** Pieces of rectangle a left after cutting out b (all as e0, e1, n0, n1). */
function subtractRect(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number][] {
  const [ae0, ae1, an0, an1] = a;
  const be0 = Math.max(ae0, b[0]), be1 = Math.min(ae1, b[1]), bn0 = Math.max(an0, b[2]), bn1 = Math.min(an1, b[3]);
  if (be0 >= be1 || bn0 >= bn1) return [a];
  const out: [number, number, number, number][] = [];
  if (an0 < bn0) out.push([ae0, ae1, an0, bn0]);
  if (bn1 < an1) out.push([ae0, ae1, bn1, an1]);
  if (ae0 < be0) out.push([ae0, be0, bn0, bn1]);
  if (be1 < ae1) out.push([be1, ae1, bn0, bn1]);
  return out;
}

/** The round room: niches in the wall, the cone with its oculus, and a cone of tiles outside. */
function roundRoom(G: Geo, r: RoomPlan, W3: (e: number, n: number, y: number) => V3, fy: number, foot: number, eave: number, shut: number,
  mat: (rgb: RGB, s: number, p1?: number, p2?: number) => Mat, poolR: number): void {
  const { e, n, r: R } = r.round!;
  const spring = fy + r.spring;
  const segs = 40;
  const crown = spring + domeRise(r);
  const oc = r.oculus ?? 0;
  const wallM = mat([0.3, 0.5, 0.42], S.bath, F.painted, shut);
  const domeM = mat([0.16, 0.26, 0.5], S.bath, r.kind === "frigidarium" ? F.stars : F.vault, shut);
  const floorM = mat([0.86, 0.84, 0.79], S.bath, F.marble, shut);
  const H = crown - fy;
  // Four niches, between the doors' quarters.
  const NICHE = { r: 0.55, y0: 0.5, y1: 1.9 };
  const nicheAt = (t: number): number => {
    for (let q = 0; q < 4; q++) {
      const c = (q / 4) * Math.PI * 2 + Math.PI / 4;
      let d = Math.abs(t - c); d = Math.min(d, Math.PI * 2 - d);
      const x = d * R;
      if (x < NICHE.r) return x;
    }
    return -1;
  };
  for (let k = 0; k < segs; k++) {
    const t0 = (k / segs) * Math.PI * 2, t1 = ((k + 1) / segs) * Math.PI * 2;
    const tm = (t0 + t1) / 2;
    const P = (t: number, y: number, rr = R): V3 => W3(e + Math.cos(t) * rr, n + Math.sin(t) * rr, y);
    const N = (t: number): V3 => { const a = W3(e, n, 0), b = W3(e + Math.cos(t), n + Math.sin(t), 0); return [a[0] - b[0], 0, a[2] - b[2]]; };
    const u0 = t0 * R, u1 = t1 * R;
    const band = (ya: number, yb: number, rr = R, m = wallM): void => {
      G.tri(P(t0, ya, rr), P(t1, ya, rr), P(t1, yb, rr), N(t0), N(t1), N(t1), m, [u0, ya - fy, 2 * Math.PI * R, H], [u1, ya - fy, 2 * Math.PI * R, H], [u1, yb - fy, 2 * Math.PI * R, H]);
      G.tri(P(t0, ya, rr), P(t1, yb, rr), P(t0, yb, rr), N(t0), N(t1), N(t0), m, [u0, ya - fy, 2 * Math.PI * R, H], [u1, yb - fy, 2 * Math.PI * R, H], [u0, yb - fy, 2 * Math.PI * R, H]);
    };
    const x = nicheAt(tm);
    // A door on the side toward the apodyterium (+e) and none elsewhere: the gap is the doorway.
    let dt = Math.abs(tm); dt = Math.min(dt, Math.PI * 2 - dt);
    const door = dt * R < 0.55;
    // The side of a niche or the doorway, through to `back`, facing along +t (s 1) or -t.
    const jamb = (t: number, ya: number, yb: number, back: number, s: number): void => {
      const a = P(t, 0, R), b = P(t + 0.01, 0, R);
      const tn: V3 = [(b[0] - a[0]) * s, 0, (b[2] - a[2]) * s];
      G.quad(P(t, ya, R), P(t, ya, back), P(t, yb, back), P(t, yb, R), tn, wallM);
    };
    const step = (Math.PI * 2) / segs;
    const isDoor = (t: number): boolean => { let q = Math.abs(t); q = Math.min(q, Math.PI * 2 - q); return q * R < 0.55; };
    if (door) {
      band(fy + 2.3, spring);
      const back = R + WALL_T + 0.1;
      if (!isDoor(tm - step)) jamb(t0, fy, fy + 2.3, back, 1);
      if (!isDoor(tm + step)) jamb(t1, fy, fy + 2.3, back, -1);
      G.quad(P(t0, fy + 2.3, R), P(t1, fy + 2.3, R), P(t1, fy + 2.3, back), P(t0, fy + 2.3, back), [0, -1, 0], wallM);
      G.quad(P(t0, fy, R), P(t1, fy, R), P(t1, fy, back), P(t0, fy, back), [0, 1, 0], floorM);
    } else if (x >= 0) {
      const top = fy + NICHE.y1 + Math.sqrt(Math.max(0, NICHE.r * NICHE.r - x * x));
      band(fy, fy + NICHE.y0);
      band(top, spring);
      // The niche's back, a little deeper, its sill and head, and its sides.
      const back = R + 0.45;
      band(fy + NICHE.y0, top, back);
      G.quad(P(t0, fy + NICHE.y0, R), P(t1, fy + NICHE.y0, R), P(t1, fy + NICHE.y0, back), P(t0, fy + NICHE.y0, back), [0, 1, 0], floorM);
      G.quad(P(t0, top, R), P(t1, top, R), P(t1, top, back), P(t0, top, back), [0, -1, 0], wallM);
      // Where the next segment's head is lower, the step between them.
      for (const [t, nb, s] of [[t0, tm - step, 1], [t1, tm + step, -1]] as const) {
        const xn = nicheAt(nb);
        if (xn < 0) jamb(t, fy + NICHE.y0, top, back, s);
        else {
          const topN = fy + NICHE.y1 + Math.sqrt(Math.max(0, NICHE.r * NICHE.r - xn * xn));
          if (topN < top) jamb(t, topN, top, back, s);
        }
      }
    } else band(fy, spring);
    // The floor ring round the pool.
    const pr = poolR > 0 ? poolR + 0.3 : 0;
    G.quad(P(t0, fy, pr), P(t1, fy, pr), P(t1, fy, R), P(t0, fy, R), [0, 1, 0], floorM);
    // The cone: from the springline to the oculus, slightly swelling.
    const rings = 7;
    for (let j = 0; j < rings; j++) {
      const s0 = j / rings, s1 = (j + 1) / rings;
      const rad = (s: number): number => R + (oc - R) * Math.pow(s, 1.25);
      const yy = (s: number): number => spring + (crown - spring) * s;
      const DN = (s: number, t: number): V3 => { const nn = N(t); return [nn[0], -0.9 * (1 - s * 0.3), nn[2]]; };
      G.tri(P(t0, yy(s0), rad(s0)), P(t1, yy(s0), rad(s0)), P(t1, yy(s1), rad(s1)), DN(s0, t0), DN(s0, t1), DN(s1, t1), domeM, [u0, yy(s0) - fy, 1, 1], [u1, yy(s0) - fy, 1, 1], [u1, yy(s1) - fy, 1, 1]);
      G.tri(P(t0, yy(s0), rad(s0)), P(t1, yy(s1), rad(s1)), P(t0, yy(s1), rad(s1)), DN(s0, t0), DN(s1, t1), DN(s1, t0), domeM, [u0, yy(s0) - fy, 1, 1], [u1, yy(s1) - fy, 1, 1], [u0, yy(s1) - fy, 1, 1]);
    }
    // Outside: the drum and the tiled cone, open at the oculus.
    const Ro = R + WALL_T + 0.1;
    const exM = mat(creamC, S.plaster, 60, 255);
    const g0 = foot;
    const On = (t: number): V3 => { const nn = N(t); return [-nn[0], 0, -nn[2]]; };
    G.tri(P(t0, g0, Ro), P(t1, g0, Ro), P(t1, eave, Ro), On(t0), On(t1), On(t1), exM, [u0, 0, 30, eave - g0], [u1, 0, 30, eave - g0], [u1, eave - g0, 30, eave - g0]);
    G.tri(P(t0, g0, Ro), P(t1, eave, Ro), P(t0, eave, Ro), On(t0), On(t1), On(t0), exM, [u0, 0, 30, eave - g0], [u1, eave - g0, 30, eave - g0], [u0, eave - g0, 30, eave - g0]);
    const ctop = crown + 0.25;
    const tn = (t: number): V3 => { const nn = On(t); return [nn[0], (Ro - oc) / (ctop - eave), nn[2]]; };
    G.tri(P(t0, eave, Ro + 0.15), P(t1, eave, Ro + 0.15), P(t1, ctop, oc), tn(t0), tn(t1), tn(t1), mat(tileC, S.tile), [u0, 0, 9, 4], [u1, 0, 9, 4], [u1, 4, 9, 4]);
    G.tri(P(t0, eave, Ro + 0.15), P(t1, ctop, oc), P(t0, ctop, oc), tn(t0), tn(t1), tn(t0), mat(tileC, S.tile), [u0, 0, 9, 4], [u1, 4, 9, 4], [u0, 4, 9, 4]);
    if (oc > 0) {
      // The oculus's throat, from the painted cone up through the roof.
      const inN = N(t0), inN1 = N(t1);
      G.tri(P(t0, crown, oc), P(t1, crown, oc), P(t1, ctop, oc), inN, inN1, inN1, wallM, Z4, Z4, Z4);
      G.tri(P(t0, crown, oc), P(t1, ctop, oc), P(t0, ctop, oc), inN, inN1, inN, wallM, Z4, Z4, Z4);
    }
  }
}

function rectPool(G: Geo, W3: (e: number, n: number, y: number) => V3, dirW: (de: number, dn: number) => V3, rect: [number, number, number, number],
  rimY: number, floorY: number, bottomY: number, rimM: Mat, liningM: Mat, kind: string): void {
  const [e0, e1, n0, n1] = rect;
  const m = 0.3;
  const outer: [number, number][] = [[e0 - m, n0 - m], [e1 + m, n0 - m], [e1 + m, n1 + m], [e0 - m, n1 + m]];
  const inner: [number, number][] = [[e0, n0], [e1, n0], [e1, n1], [e0, n1]];
  for (let k = 0; k < 4; k++) {
    const a = inner[k], b = inner[(k + 1) % 4], A = outer[k], B = outer[(k + 1) % 4];
    // Rim top.
    G.quad(W3(a[0], a[1], rimY), W3(b[0], b[1], rimY), W3(B[0], B[1], rimY), W3(A[0], A[1], rimY), [0, 1, 0], rimM);
    // Rim outside, from the floor (only where it stands above it).
    const ie = (a[0] + b[0]) / 2 - (A[0] + B[0]) / 2, inn = (a[1] + b[1]) / 2 - (A[1] + B[1]) / 2;
    const out = dirW(-ie, -inn);
    if (rimY > floorY + 0.01) G.quad(W3(A[0], A[1], floorY), W3(B[0], B[1], floorY), W3(B[0], B[1], rimY), W3(A[0], A[1], rimY), out, rimM);
    // Pool wall inside, rim to the bottom.
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    G.quad(W3(a[0], a[1], bottomY), W3(b[0], b[1], bottomY), W3(b[0], b[1], rimY), W3(a[0], a[1], rimY), dirW(ie, inn), liningM,
      [[0, 0, L, rimY - bottomY], [L, 0, L, rimY - bottomY], [L, rimY - bottomY, L, rimY - bottomY], [0, rimY - bottomY, L, rimY - bottomY]]);
  }
  G.quad(W3(e0, n0, bottomY), W3(e1, n0, bottomY), W3(e1, n1, bottomY), W3(e0, n1, bottomY), [0, 1, 0], liningM);
  // A seat along the long side inside a hot pool, steps down into the cold ones.
  const alongE = e1 - e0 >= n1 - n0;
  const steps = kind === "alveus" ? 1 : 3;
  for (let s = 0; s < steps; s++) {
    const d = (rimY - bottomY) * ((s + 1) / (steps + 1));
    const y = rimY - d;
    const w = 0.4 * (steps - s);
    const r: [number, number, number, number] = alongE ? [e0, e1, n0, n0 + w] : [e0, e0 + w, n0, n1];
    G.quad(W3(r[0], r[2], y), W3(r[1], r[2], y), W3(r[1], r[3], y), W3(r[0], r[3], y), [0, 1, 0], rimM);
    const front = alongE ? [[r[0], r[3]], [r[1], r[3]]] : [[r[1], r[2]], [r[1], r[3]]];
    G.quad(W3(front[0][0], front[0][1], bottomY), W3(front[1][0], front[1][1], bottomY), W3(front[1][0], front[1][1], y), W3(front[0][0], front[0][1], y), alongE ? dirW(0, 1) : dirW(1, 0), rimM);
  }
}

function roundPool(G: Geo, W3: (e: number, n: number, y: number) => V3, e: number, n: number, r: number, rimY: number, floorY: number, bottomY: number, rimM: Mat, liningM: Mat): void {
  const segs = 28;
  for (let k = 0; k < segs; k++) {
    const t0 = (k / segs) * Math.PI * 2, t1 = ((k + 1) / segs) * Math.PI * 2;
    const P = (t: number, rr: number, y: number): V3 => W3(e + Math.cos(t) * rr, n + Math.sin(t) * rr, y);
    const C = W3(e, n, 0);
    const inward = (t: number): V3 => { const p = P(t, 1, 0); return [C[0] - p[0], 0, C[2] - p[2]]; };
    const outward = (t: number): V3 => { const v = inward(t); return [-v[0], 0, -v[2]]; };
    const ro = r + 0.3;
    G.quad(P(t0, r, rimY), P(t1, r, rimY), P(t1, ro, rimY), P(t0, ro, rimY), [0, 1, 0], rimM);
    G.tri(P(t0, ro, floorY), P(t1, ro, floorY), P(t1, ro, rimY), outward(t0), outward(t1), outward(t1), rimM, Z4, Z4, Z4);
    G.tri(P(t0, ro, floorY), P(t1, ro, rimY), P(t0, ro, rimY), outward(t0), outward(t1), outward(t0), rimM, Z4, Z4, Z4);
    // The step ring half way down, and the walls above and below it.
    const ys = (rimY + bottomY) / 2, rs = r - 0.4;
    G.tri(P(t0, r, ys), P(t1, r, ys), P(t1, r, rimY), inward(t0), inward(t1), inward(t1), liningM, Z4, Z4, Z4);
    G.tri(P(t0, r, ys), P(t1, r, rimY), P(t0, r, rimY), inward(t0), inward(t1), inward(t0), liningM, Z4, Z4, Z4);
    G.quad(P(t0, rs, ys), P(t1, rs, ys), P(t1, r, ys), P(t0, r, ys), [0, 1, 0], rimM);
    G.tri(P(t0, rs, bottomY), P(t1, rs, bottomY), P(t1, rs, ys), inward(t0), inward(t1), inward(t1), liningM, Z4, Z4, Z4);
    G.tri(P(t0, rs, bottomY), P(t1, rs, ys), P(t0, rs, ys), inward(t0), inward(t1), inward(t0), liningM, Z4, Z4, Z4);
    G.tri(P(t0, rs, bottomY), P(t1, rs, bottomY), W3(e, n, bottomY), [0, 1, 0], [0, 1, 0], [0, 1, 0], liningM, Z4, Z4, Z4);
  }
}

/** A plain stuccoed column, red on its lower third, with a cushion capital. */
function column(G: Geo, x: number, y0: number, z: number, h: number, r: number, seed: number): void {
  const m: Mat = { rgb: [0.9, 0.87, 0.8], style: S.stucco, p1: 1, p2: 0, seed };
  const shaft = new THREE.CylinderGeometry(r * 0.86, r, h - 0.35, 12, 1, true);
  G.mesh(shaft, new THREE.Matrix4().makeTranslation(x, y0 + (h - 0.35) / 2, z), m, (p) => [0, p[1] - y0, 0, h]);
  G.mesh(new THREE.CylinderGeometry(r * 1.25, r * 0.88, 0.2, 12), new THREE.Matrix4().makeTranslation(x, y0 + h - 0.25, z), { ...m, p1: 0 });
  G.mesh(new THREE.BoxGeometry(r * 2.8, 0.15, r * 2.8), new THREE.Matrix4().makeTranslation(x, y0 + h - 0.075, z), { ...m, p1: 0 });
}

// =====================================================================================
// Fountains.
// =====================================================================================

function buildFountain(f: Fountain, i: number, G: Geo, Wt: WaterGeo, Fm: WaterGeo, J: JetGeo, drops: number[][], nDrops: number, probe: NonNullable<WaterOptions["probe"]>, groundAt: (x: number, z: number) => number): Omit<WaterReport["fountains"][number], "head"> {
  const seed = (i * 0.618) % 1;
  const lava: Mat = { rgb: lavaC, style: S.kerb, p1: 0, p2: 0, seed };
  const stone: Mat = { rgb: stoneC, style: S.marble, p1: 0, p2: 0, seed };
  const c = Math.cos(f.ang), s = Math.sin(f.ang);
  // Local (u, y, w) to world: the fountain's own frame on the street.
  const L = new THREE.Matrix4().set(c, 0, -s, f.x, 0, 1, 0, f.g, s, 0, c, f.z, 0, 0, 0, 1);
  const at = (u: number, y: number, w: number, sx: number, sy: number, sz: number, rot?: THREE.Matrix4): THREE.Matrix4 => {
    const m = new THREE.Matrix4().makeTranslation(u, y, w);
    if (rot) m.multiply(rot);
    return L.clone().multiply(m).multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
  };
  const { hu, hw, slab, rim } = BASIN;
  const box = (u0: number, u1: number, y0: number, y1: number, w0: number, w1: number, m: Mat): void => {
    G.mesh(new THREE.BoxGeometry(1, 1, 1), at((u0 + u1) / 2, (y0 + y1) / 2, (w0 + w1) / 2, u1 - u0, y1 - y0, w1 - w0), m, (p) => [p[0] + p[2], p[1] - f.g, 2, 1]);
  };
  // Four slabs on edge, clamped at the corners, on a slab floor.
  box(-hu, hu, -0.15, 0.1, -hw, hw, lava);
  box(-hu, -hu + slab, 0, rim, -hw, hw, lava);
  box(hu - slab, hu, 0, rim, -hw, hw, lava);
  box(-hu + slab, hu - slab, 0, rim, -hw, -hw + slab, lava);
  box(-hu + slab, hu - slab, 0, rim, hw - slab, hw, lava);
  // The notch the overflow runs out of, in the street-side slab: a dip in its top.
  box(hu - slab - 0.01, hu + 0.01, rim - 0.11, rim - 0.1, 0.45, 0.75, lava);
  // The upright with the carved head and the lead spout.
  box(UPRIGHT.u0, UPRIGHT.u1, -0.1, UPRIGHT.top, -UPRIGHT.hw, UPRIGHT.hw, lava);
  const t0 = G.triangles;
  if (!probe.noSpouts) {
    const face = UPRIGHT.u1;
    const hy = 1.12;
    const sph = (u: number, y: number, w: number, r: number, su = 1, sy = 1, sw = 1, m = stone): void =>
      G.mesh(new THREE.SphereGeometry(r, 10, 7), at(face + u, y, w, su, sy, sw), m);
    switch (f.head) {
      case Head.Lion:
        // Mane as a flattened disc, the face, the muzzle and two ears.
        sph(0.0, hy, 0, 0.17, 0.3, 1, 1);
        sph(0.05, hy, 0, 0.1, 0.7, 1, 1);
        sph(0.11, hy - 0.06, 0, 0.055, 0.8, 0.8, 1);
        sph(0.03, hy + 0.12, 0.08, 0.035, 0.6, 1, 1);
        sph(0.03, hy + 0.12, -0.08, 0.035, 0.6, 1, 1);
        break;
      case Head.Mercury: {
        // The face under a winged petasus.
        sph(0.04, hy - 0.02, 0, 0.1, 0.6, 1.15, 0.9);
        G.mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.025, 12), at(face + 0.03, hy + 0.1, 0, 0.45, 1, 1), stone);
        sph(0.03, hy + 0.12, 0, 0.085, 0.6, 0.7, 1);
        for (const sw of [1, -1]) G.mesh(new THREE.BoxGeometry(0.03, 0.09, 0.07), at(face + 0.03, hy + 0.15, sw * 0.12, 1, 1, 1, new THREE.Matrix4().makeRotationX(sw * 0.5)), stone);
        break;
      }
      case Head.Medusa: {
        // A round mask with the snakes standing out round it.
        sph(0.04, hy, 0, 0.11, 0.55, 1.05, 1);
        for (let k = 0; k < 9; k++) {
          const a = (k / 9) * Math.PI * 2;
          const r0 = 0.11, r1 = 0.19;
          const p0 = new THREE.Vector3(face + 0.03, hy + Math.sin(a) * r0, Math.cos(a) * r0), p1 = new THREE.Vector3(face + 0.02, hy + Math.sin(a + 0.35) * r1, Math.cos(a + 0.35) * r1);
          const d = p1.clone().sub(p0), len = d.length();
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
          const m = new THREE.Matrix4().compose(p0.clone().add(p1).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
          G.mesh(new THREE.CylinderGeometry(0.012, 0.018, len, 5), L.clone().multiply(m), stone);
        }
        break;
      }
      default:
        // The cockerel in profile: body, tail feathers, the head with its comb and beak.
        sph(0.03, hy - 0.03, 0, 0.1, 0.45, 0.8, 1.2);
        sph(0.035, hy + 0.09, 0.09, 0.045, 0.6, 1, 1);
        G.mesh(new THREE.BoxGeometry(0.03, 0.05, 0.05), at(face + 0.035, hy + 0.14, 0.09, 1, 1, 1), stone);
        G.mesh(new THREE.ConeGeometry(0.015, 0.05, 5), at(face + 0.035, hy + 0.09, 0.15, 1, 1, 1, new THREE.Matrix4().makeRotationX(-Math.PI / 2)), stone);
        for (const a of [-0.5, 0, 0.5]) G.mesh(new THREE.BoxGeometry(0.025, 0.14, 0.03), at(face + 0.03, hy + 0.02, -0.13, 1, 1, 1, new THREE.Matrix4().makeRotationX(0.9 + a)), stone);
        break;
    }
    // The lead pipe out of the mouth.
    G.mesh(new THREE.CylinderGeometry(0.02, 0.02, SPOUT.u - face + 0.03, 8, 1, false), at((face + SPOUT.u) / 2 + 0.01, SPOUT.y, 0, 1, 1, 1, new THREE.Matrix4().makeRotationZ(Math.PI / 2)), { rgb: leadC, style: S.kerb, p1: 0, p2: 0, seed });
  }
  const spoutTris = G.triangles - t0;

  // The water in the basin, rings where the jet lands.
  const inner = [[-hu + slab, -hw + slab], [hu - slab, -hw + slab], [hu - slab, hw - slab], [-hu + slab, hw - slab]].flatMap(([u, w]) => fountainToWorld(f, u, w));
  Wt.poly(inner, f.water, [0, 0, 0, 0], [WK.Basin, f.water - f.g - 0.1, f.impact[0], f.impact[2]], [0.3, 0.3, 0.3, 0]);

  // The jet from the spout, and the sheet over the notch.
  const j0 = J.triangles;
  if (!probe.noJets) {
    const dir: V3 = [c * SPOUT_SPEED, 0, s * SPOUT_SPEED];
    J.tube(jetPath(f.spout, dir, f.water, 10), (t) => 0.019 - 0.006 * t, seed, 0, 0);
    const [lx, lz] = fountainToWorld(f, hu + 0.01, 0.6);
    J.tube(jetPath([lx, f.water + 0.005, lz], [c * 0.35, 0, s * 0.35], f.g + 0.09, 8), (t) => 0.012 + 0.012 * t, seed + 0.5, 2, 0, [-s, 0, c], 5);
  }
  const jetTris = J.triangles - j0;
  let nd = 0;
  if (!probe.noJets) {
    for (let k = 0; k < nDrops; k++) { drops.push([f.impact[0], f.water, f.impact[2], (k + seed) / nDrops, 0.55, 0.75, 2.2, 0.014]); nd++; }
  }

  // The overflow down the street: a thin film along the path.
  const P = f.overflow;
  if (P.length >= 4) {
    let along = 0;
    const halfW = (k: number): number => 0.16 + Math.min(0.3, k * 0.04);
    for (let k = 0; k + 2 < P.length; k += 2) {
      const ax = P[k], az = P[k + 1], bx = P[k + 2], bz = P[k + 3];
      const l = Math.hypot(bx - ax, bz - az) || 1;
      const nx = -(bz - az) / l, nz = (bx - ax) / l;
      const wa = halfW(k / 2), wb = halfW(k / 2 + 1);
      const fx = (bx - ax) / l, fz = (bz - az) / l;
      const pa = [ax + nx * wa, az + nz * wa], pb = [ax - nx * wa, az - nz * wa], pc = [bx - nx * wb, bz - nz * wb], pd = [bx + nx * wb, bz + nz * wb];
      const ya = groundAt(ax, az) + 0.11, yb = groundAt(bx, bz) + 0.11;
      const o = (al: number, ac: number): W4 => [al, ac, 0, -2];
      const pool: W4 = [WK.Film, 0.01, fx, fz];
      const tint: W4 = [0.3, 0.29, 0.28, 0];
      Fm.tri([pa[0], ya, pa[1]], [pb[0], ya, pb[1]], [pc[0], yb, pc[1]], [o(along, 1), o(along, -1), o(along + l, -1)], pool, tint);
      Fm.tri([pa[0], ya, pa[1]], [pc[0], yb, pc[1]], [pd[0], yb, pd[1]], [o(along, 1), o(along + l, -1), o(along + l, 1)], pool, tint);
      along += l;
    }
  }
  return { spoutTris, jetTris, drops: nd, basinWater: f.water, rim: f.g + rim };
}

function buildTower(t: WaterTower, G: Geo): void {
  const c = Math.cos(t.ang), s = Math.sin(t.ang);
  const L = new THREE.Matrix4().set(c, 0, -s, t.x, 0, 1, 0, t.g, s, 0, c, t.z, 0, 0, 0, 1);
  const seed = 0.5;
  const brick: Mat = { rgb: [0.6, 0.36, 0.26], style: S.masonry, p1: 0, p2: 0, seed };
  const lead: Mat = { rgb: leadC, style: S.kerb, p1: 0, p2: 0, seed };
  const side = TOWER.side, h = t.h - TOWER.tank;
  G.mesh(new THREE.BoxGeometry(side, h, side), L.clone().multiply(new THREE.Matrix4().makeTranslation(0, h / 2, 0)), brick, (p) => [p[0] + p[2], p[1] - t.g, 2, h]);
  // The lead tank on a stone cap, its lid.
  G.mesh(new THREE.BoxGeometry(side + 0.2, 0.12, side + 0.2), L.clone().multiply(new THREE.Matrix4().makeTranslation(0, h + 0.06, 0)), { ...brick, rgb: stoneC, style: S.marble });
  G.mesh(new THREE.BoxGeometry(side - 0.05, TOWER.tank - 0.12, side - 0.05), L.clone().multiply(new THREE.Matrix4().makeTranslation(0, h + 0.12 + (TOWER.tank - 0.12) / 2, 0)), lead);
  // The pipes: the feed up one face in its groove, two supplies down another.
  for (const [u, w] of [[-side / 2 - 0.04, -0.25], [-side / 2 - 0.04, 0.25], [0.3, side / 2 + 0.04]]) {
    G.mesh(new THREE.CylinderGeometry(0.045, 0.045, t.h, 6), L.clone().multiply(new THREE.Matrix4().makeTranslation(u, t.h / 2, w)), lead);
  }
}

function buildCastellum(k: Castellum, G: Geo): void {
  const c = Math.cos(k.ang), s = Math.sin(k.ang);
  const L = new THREE.Matrix4().set(c, 0, -s, k.x, 0, 1, 0, k.g, s, 0, c, k.z, 0, 0, 0, 1);
  const brick: Mat = { rgb: [0.62, 0.38, 0.27], style: S.masonry, p1: 0, p2: 0, seed: 0.3 };
  const stone: Mat = { rgb: [0.8, 0.76, 0.68], style: S.marble, p1: 0, p2: 0, seed: 0.3 };
  // Facade toward +x (the street): a brick house with three blind arches and a door.
  G.mesh(new THREE.BoxGeometry(k.d, k.h, k.w), L.clone().multiply(new THREE.Matrix4().makeTranslation(0, k.h / 2, 0)), brick, (p) => [p[0] + p[2], p[1] - k.g, 6, k.h]);
  for (const w of [-k.w / 3, 0, k.w / 3]) {
    // Each arch: a recess with pilasters either side.
    G.mesh(new THREE.BoxGeometry(0.12, k.h * 0.62, k.w / 3 - 0.6), L.clone().multiply(new THREE.Matrix4().makeTranslation(k.d / 2 - 0.02, k.h * 0.36, w)), { ...brick, rgb: [0.5, 0.3, 0.22] });
    G.mesh(new THREE.CylinderGeometry((k.w / 3 - 0.6) / 2, (k.w / 3 - 0.6) / 2, 0.12, 12, 1, false, 0, Math.PI), L.clone().multiply(new THREE.Matrix4().makeTranslation(k.d / 2 - 0.02, k.h * 0.67, w)).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), { ...brick, rgb: [0.5, 0.3, 0.22] });
  }
  G.mesh(new THREE.BoxGeometry(k.d + 0.3, 0.25, k.w + 0.3), L.clone().multiply(new THREE.Matrix4().makeTranslation(0, k.h + 0.12, 0)), stone);
  // A low pitched roof.
  const roof = new THREE.CylinderGeometry(0.001, (k.w + 0.6) * 0.72, 1.3, 4, 1, false, Math.PI / 4);
  G.mesh(roof, L.clone().multiply(new THREE.Matrix4().makeTranslation(0, k.h + 0.25 + 0.65, 0)).multiply(new THREE.Matrix4().makeScale(k.d / k.w, 1, 1)), { rgb: tileC, style: S.tile, p1: 0, p2: 0, seed: 0.3 }, (p) => [p[0] + p[2], p[1], 6, 2]);
}

function impluviumRim(ring: number[], floor: number, top: number, G: Geo): void {
  const m: Mat = { rgb: [0.82, 0.78, 0.7], style: S.marble, p1: 0, p2: 0, seed: 0.4 };
  const n = ring.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[i * 2]; cz += ring[i * 2 + 1]; }
  cx /= n; cz /= n;
  const out = (i: number): [number, number] => {
    const x = ring[i * 2], z = ring[i * 2 + 1], dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1;
    return [x + (dx / l) * IMPLUVIUM_RIM_W * 1.41, z + (dz / l) * IMPLUVIUM_RIM_W * 1.41];
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a: V3 = [ring[i * 2], top, ring[i * 2 + 1]], b: V3 = [ring[j * 2], top, ring[j * 2 + 1]];
    const A = out(i), B = out(j);
    const mx = (a[0] + b[0]) / 2 - cx, mz = (a[2] + b[2]) / 2 - cz;
    G.quad(a, b, [B[0], top, B[1]], [A[0], top, A[1]], [0, 1, 0], m);
    G.quad([A[0], floor, A[1]], [B[0], floor, B[1]], [B[0], top, B[1]], [A[0], top, A[1]], [mx, 0, mz], m);
    // Inside face, down to the water (and a little under it).
    G.quad([a[0], top - IMPLUVIUM_RIM - 0.08, a[2]], [b[0], top - IMPLUVIUM_RIM - 0.08, b[2]], b, a, [-mx, 0, -mz], m);
  }
}

// =====================================================================================
// Shaders.
// =====================================================================================

const SHARED_HEAD = /* glsl */ `
#define ATMO_STEPS 3
#define ATMO_SUN_STEPS 1
${ATMOSPHERE_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}
${TOWN_LAMPS_GLSL}
uniform vec3  uCameraPos;
uniform float uSunSurface;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uNight;
uniform float uTime;
float wh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wh(i), wh(i + vec2(1, 0)), f.x), mix(wh(i + vec2(0, 1)), wh(i + vec2(1, 1)), f.x), f.y);
}
vec3 sunAt(vec3 p) {
  return uSunColor * uSunIntensity * uSunSurface * sunTransmittance(atmoOrigin(max(0.0, p.y)), uSunDir, uTurbidity);
}
vec3 fogged(vec3 c, vec3 p, float dist) {
  vec3 trans;
  vec3 ins = atmosphere(atmoOrigin(uCamAltitude), normalize(p - uCameraPos), dist, trans);
  return c * trans + ins;
}
`;

const WATER_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aOpen;
in vec4 aPool;
in vec4 aTint;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
out vec3 vWorld;
out vec4 vOpen;
out vec4 vPool;
out vec4 vTint;
out float vViewDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 off = vec2(modelMatrix[3][0], modelMatrix[3][2]);
  vWorld = w.xyz;
  vOpen = aOpen;
  if (aOpen.w > 0.0) vOpen.xy += off;
  vPool = aPool;
  if (aPool.x > 0.5 && aPool.x < 1.5 || aPool.x > 3.5) vPool.zw += off;
  vTint = aTint;
  vViewDist = distance(w.xyz, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec4 vOpen;
in vec4 vPool;
in vec4 vTint;
in float vViewDist;
out vec4 fragColor;
${SHARED_HEAD}
// The surface's height, metres, about its rest level.
float surf(vec2 p) {
  float k = vPool.x, t = uTime;
  float h = 0.0;
  if (k > 1.5 && k < 2.5) {
    // A film running down the street: ridges carried along the flow.
    vec2 f = vPool.zw;
    vec2 q = vec2(dot(p, f), dot(p, vec2(-f.y, f.x)));
    h = (wn(vec2(q.x * 5.0 - t * 4.0, q.y * 9.0)) - 0.5) * 0.004;
#ifndef LEAN
    h += (wn(vec2(q.x * 13.0 - t * 6.5, q.y * 21.0)) - 0.5) * 0.0015;
#endif
    return h;
  }
  // Wind on the open pools, a stir of air in the rooms.
  float wind = vOpen.w == 0.0 ? 1.0 : 0.2;
  h += (wn(p * 2.6 + vec2(t * 0.31, t * 0.17)) - 0.5) * 0.006 * wind;
#ifndef LEAN
  h += (wn(p * 6.3 - vec2(t * 0.47, -t * 0.29)) - 0.5) * 0.0025 * wind;
#endif
  if (k > 0.5 && k < 1.5 || k > 3.5) {
    // Rings out from where a jet comes down.
    float d = length(p - vPool.zw);
    float ring = k > 3.5 ? 0.0012 : 0.0028;
    h += sin(d * 70.0 - t * 16.0) * ring * exp(-d * 3.5);
#ifndef LEAN
    h += sin(d * 41.0 - t * 9.0 + 1.3) * ring * 0.7 * exp(-d * 2.2);
#endif
  }
  if (k > 2.5 && k < 3.5) {
    // A hot pool: slow swirls from the heat coming up through its floor.
    h += (wn(p * 1.3 + vec2(sin(t * 0.13), cos(t * 0.11)) * 2.0) - 0.5) * 0.004;
  }
  return h;
}
void main() {
  float e = 0.02;
  vec2 p = vWorld.xz;
  float h0 = surf(p);
  vec2 grad = vec2(surf(p + vec2(e, 0.0)) - h0, surf(p + vec2(0.0, e)) - h0) / e;
  // Ripples fade out with distance before they can alias.
  grad *= 1.0 - smoothstep(25.0, 70.0, vViewDist);
  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
  vec3 v = normalize(uCameraPos - vWorld);
  float ndv = max(dot(n, v), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 r = reflect(-v, n);
  r.y = abs(r.y);
  float shut = vTint.a;
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 sunE = sunAt(vWorld);
  float sv = sunVisibility(vWorld, up, uSunDir, vViewDist);
  vec3 amb = occludedSkyIrradiance(up) * (1.0 - 0.9 * shut) * (1.0 - 0.65 * uLampNight * uNight);
  vec3 lamps = townLamps(vWorld, up);
  // What the surface mirrors: the sky, or in a room its walls, with the sky
  // only where the reflected ray goes out through the oculus.
  vec3 sky = shIrradiance(r) * 0.35;
  vec3 room = vec3(0.75, 0.66, 0.52) * (amb + lamps) * 0.8;
  vec3 refl = sky;
  if (vOpen.w > 0.0) {
    vec2 hit = vWorld.xz + r.xz * vOpen.z / max(r.y, 0.05);
    float open = 1.0 - smoothstep(vOpen.w * 0.8, vOpen.w * 1.05, length(hit - vOpen.xy));
    refl = mix(room, sky * 1.6, open);
  } else if (vOpen.w < -0.5 && vOpen.w > -1.5) refl = room;
  // The floor through the water: the lining, lit as the pool is (with the
  // sun's caustics on it), dimmed and blued by the path through the water.
  float depth = max(0.02, vPool.y);
  vec3 rt = refract(-v, n, 0.75);
  float path = depth / max(0.15, -rt.y);
  vec2 fp = vWorld.xz + rt.xz * path;
  float caus = 0.55 + 0.9 * pow(wn(fp * 4.0 + uTime * 0.3) * wn(fp * 3.1 - uTime * 0.23), 0.7);
  vec3 floorLit = amb + sunE * max(0.0, uSunDir.y) * sv * caus + lamps;
  vec3 absorb = vec3(0.42, 0.075, 0.045);
  vec3 T = exp(-absorb * path);
  vec3 scatter = vec3(0.012, 0.045, 0.05) * (amb + sunE * max(0.0, uSunDir.y) * sv * 0.4 + lamps);
  vec3 body = vTint.rgb * floorLit * T + scatter * (1.0 - T.g);
  float k = vPool.x;
  float alpha = 1.0;
  if (k > 1.5 && k < 2.5) {
    // A film on the paving: mostly the sky, dark wet stone through it.
    body = vTint.rgb * 0.5 * (amb + sunE * max(0.0, uSunDir.y) * sv + lamps);
    float across = abs(vOpen.y);
    alpha = (1.0 - smoothstep(0.55, 1.0, across)) * (1.0 - smoothstep(8.0, 14.0, vOpen.x)) * 0.9;
  }
  vec3 col = mix(body, refl, fres);
  col += sunE * pow(max(0.0, dot(r, uSunDir)), 900.0) * 9.0 * sv;
  col += townLampSpec(vWorld, n, v) * 1.5;
  if (k > 2.5 && k < 3.5) col = mix(col, vec3(0.75, 0.75, 0.72) * (amb + lamps) * 0.6, 0.08);
  fragColor = vec4(fogged(col, vWorld, vViewDist), alpha);
}
`;

const JET_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec4 aJet;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vJet;
out float vViewDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normal;
  vJet = aJet;
  vViewDist = distance(w.xyz, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * w;
  // A jet a pixel wide past 90 m is shimmer, not water.
  if (vViewDist > 90.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;

const JET_FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vJet;
in float vViewDist;
out vec4 fragColor;
${SHARED_HEAD}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCameraPos - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float fres = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(n, v)), 4.0);
  vec3 up = vec3(0.0, 1.0, 0.0);
  float shut = vJet.w;
  vec3 amb = occludedSkyIrradiance(up) * (1.0 - 0.9 * shut) * (1.0 - 0.65 * uLampNight * uNight);
  vec3 lamps = townLamps(vWorld, n);
  vec3 sunE = sunAt(vWorld);
  float sv = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 sky = shIrradiance(reflect(-v, n)) * 0.35 * (1.0 - 0.8 * shut) + lamps * 0.3;
  // Streaks carried down the jet: the water breaking up as it falls.
  float s = vJet.x;
  float streak = wn(vec2(s * 18.0 - uTime * 11.0, vJet.y * 37.0 + atan(n.z, n.x) * 2.0));
  vec3 body = vec3(0.55, 0.65, 0.66) * (amb + sunE * 0.25 * sv) * 0.35;
  vec3 col = mix(body, sky, fres) * (0.8 + 0.5 * streak);
  vec3 hh = normalize(uSunDir + v);
  col += sunE * pow(max(0.0, dot(n, hh)), 120.0) * 2.5 * sv;
  col += townLampSpec(vWorld, n, v);
  float alpha = clamp(0.3 + 0.55 * fres + 0.25 * streak, 0.0, 0.92);
  // The sheet over the notch is thin: mostly the stone behind it, glinting.
  if (vJet.z > 1.5) alpha = clamp(0.08 + 0.5 * fres + 0.35 * streak * streak, 0.0, 0.7);
  fragColor = vec4(fogged(col, vWorld, vViewDist), alpha);
}
`;

/** Droplets: (x, y, z, seed) and (spread, up, rate, size). Each loops a short hop. */
const DROP_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aAt;
in vec4 aHop;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform float uTime;
out vec2 vUv;
out float vFade;
out vec3 vWorld;
float dh(float x) { return fract(sin(x * 91.7) * 43758.5453); }
void main() {
  float cyc = uTime * aHop.z + aAt.w * 17.0;
  float ph = fract(cyc), id = floor(cyc) + aAt.w * 131.0;
  float a = dh(id) * 6.2832;
  float sp = aHop.x * (0.3 + 0.7 * dh(id + 3.1));
  float up = aHop.y * (0.5 + 0.5 * dh(id + 7.7));
  float T = 2.0 * up / 9.81;
  float t = ph * T;
  vec3 c = vec3(cos(a) * sp * t, up * t - 4.905 * t * t, sin(a) * sp * t);
  vec4 w = modelMatrix * vec4(aAt.xyz + c, 1.0);
  vWorld = w.xyz;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 upv = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float d = distance(w.xyz, uCameraPos);
  float size = aHop.w * (1.0 + d * 0.01);
  w.xyz += (right * position.x + upv * position.y) * size;
  vUv = position.xy;
  vFade = (1.0 - ph) * (1.0 - smoothstep(25.0, 40.0, d));
  gl_Position = projectionMatrix * viewMatrix * w;
  if (d > 40.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;

const DROP_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vFade;
in vec3 vWorld;
out vec4 fragColor;
${SHARED_HEAD}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  vec3 amb = shIrradiance(vec3(0.0, 1.0, 0.0)) * 0.3 * (1.0 - 0.65 * uLampNight * uNight) + townLamps(vWorld, vec3(0.0, 1.0, 0.0)) * 0.5;
  vec3 c = amb * (0.7 + 0.6 * (1.0 - r)) + sunAt(vWorld) * 0.08;
  fragColor = vec4(c, vFade * (1.0 - r * r) * 0.75);
}
`;

/** Steam: (x, y, z, seed), (half u, half v, u x, u z), rate. */
const STEAM_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aSrc;
in vec4 aArea;
in float aRate;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform float uTime;
uniform float uSteam;
out vec2 vUv;
out float vFade;
out vec3 vWorld;
out float vSeed;
float sh(float x) { return fract(sin(x * 78.233) * 43758.5453); }
void main() {
  float sd = aSrc.w;
  float ph = fract(uTime * 0.055 * (0.75 + 0.5 * sh(sd)) + sd * 7.13);
  float id = floor(uTime * 0.055 * (0.75 + 0.5 * sh(sd)) + sd * 7.13);
  vec2 o = vec2(sh(sd + id * 0.71) - 0.5, sh(sd * 3.3 + id * 1.3) - 0.5) * 2.0;
  vec2 ue = aArea.zw, ve = vec2(-aArea.w, aArea.z);
  vec2 xz = aSrc.xz + ue * o.x * aArea.x * 0.85 + ve * o.y * aArea.y * 0.85;
  float rise = ph * 1.9;
  xz += vec2(sin(ph * 3.0 + sd * 10.0), cos(ph * 2.3 + sd * 7.0)) * 0.25 * ph;
  vec4 w = modelMatrix * vec4(xz.x, aSrc.y + 0.05 + rise, xz.y, 1.0);
  vWorld = w.xyz;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 upv = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float size = 0.35 + ph * 0.95;
  w.xyz += (right * position.x + upv * position.y) * size;
  vUv = position.xy;
  float d = distance(w.xyz, uCameraPos);
  // Fades in off the water, out as it rises; out near the eye so a sprite never fills the screen.
  vFade = smoothstep(0.0, 0.18, ph) * pow(1.0 - ph, 1.6) * smoothstep(0.8, 2.6, d) * (1.0 - smoothstep(45.0, 70.0, d)) * uSteam;
  vSeed = sd;
  gl_Position = projectionMatrix * viewMatrix * w;
  if (d > 70.0 || uSteam <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;

const STEAM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vFade;
in vec3 vWorld;
in float vSeed;
out vec4 fragColor;
${SHARED_HEAD}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float puff = wn(vUv * 2.2 + vSeed * 40.0 + uTime * 0.05) * 0.6 + wn(vUv * 4.7 - vSeed * 13.0) * 0.4;
  float a = (1.0 - smoothstep(0.2, 1.0, r)) * (0.55 + 0.6 * puff) * vFade * 0.6;
  vec3 up = vec3(0.0, 1.0, 0.0);
  // Lit as the room is: a little sky, the sun where the shaft crosses it, the lamps.
  vec3 amb = shIrradiance(up) * 0.3 * (1.0 - 0.65 * uLampNight * uNight);
#ifdef LEAN
  float sv = 0.0;
#else
  float sv = sunVisibility(vWorld, up, uSunDir, distance(vWorld, uCameraPos));
#endif
  vec3 c = vec3(0.9) * (amb + sunAt(vWorld) * sv * 0.35 + townLamps(vWorld, up) * 0.8);
  fragColor = vec4(c, a);
}
`;

// =====================================================================================
// In the scene.
// =====================================================================================

export interface WaterFrame { t: number; camera: THREE.Vector3; night: number }

export class PompeiiWater {
  readonly group = new THREE.Group();
  /** The stonework: give it to the shadow casters with the town. */
  readonly stone: THREE.Mesh;
  readonly build: WaterBuild;
  readonly lamps: Lamp[];
  private readonly time: { value: number };
  private readonly steamOn: { value: number };
  private readonly townTime: { value: number };
  private readonly steamMesh: THREE.Mesh | null;

  constructor(opts: { data: PompeiiData; model: { waterSites: WaterSites }; uniforms: PompeiiUniforms; groundAt: (x: number, z: number) => number; offX: number; offZ: number; lean: boolean }) {
    const { offX, offZ, lean } = opts;
    this.group.name = "pompeii-water";
    this.group.position.set(offX, 0, offZ);
    const t0 = performance.now();
    this.build = buildWater({ data: opts.data, sites: opts.model.waterSites, groundAt: (x, z) => opts.groundAt(x + offX, z + offZ), lean });
    this.lamps = this.build.lamps;
    this.townTime = opts.uniforms.uWaterTime;
    this.time = { value: 0 };
    this.steamOn = { value: 1 };
    const u = { ...opts.uniforms, uTime: this.time, uSteam: this.steamOn } as unknown as Record<string, THREE.IUniform>;
    const defines: Record<string, number> = lean ? { LEAN: 1 } : {};

    this.stone = new THREE.Mesh(this.build.stone.build(), pompeiiMaterial(opts.uniforms));
    this.stone.name = "pompeii-water-stone";
    this.stone.layers.enable(SHADOW_CASTER_LAYER);

    const waterMat = new THREE.RawShaderMaterial({ vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: u, defines, glslVersion: THREE.GLSL3 });
    const water = new THREE.Mesh(this.build.water.build(), waterMat);
    water.name = "pompeii-water-pools";
    const filmMat = new THREE.RawShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: u, defines, glslVersion: THREE.GLSL3,
      transparent: true, depthWrite: false,
    });
    const film = new THREE.Mesh(this.build.film.build(), filmMat);
    film.name = "pompeii-water-film";
    film.renderOrder = 7;
    const jetMat = new THREE.RawShaderMaterial({ vertexShader: JET_VERT, fragmentShader: JET_FRAG, uniforms: u, defines, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const jets = new THREE.Mesh(this.build.jets.build(), jetMat);
    jets.name = "pompeii-water-jets";
    jets.renderOrder = 21;
    this.group.add(this.stone, water, film, jets);

    // Droplets: one instanced quad per emitter.
    const quad = (): THREE.InstancedBufferGeometry => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      return g;
    };
    const D = this.build.drops;
    if (D.length) {
      const g = quad();
      g.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(D.flatMap((d) => d.slice(0, 4))), 4));
      g.setAttribute("aHop", new THREE.InstancedBufferAttribute(new Float32Array(D.flatMap((d) => d.slice(4, 8))), 4));
      g.instanceCount = D.length;
      const m = new THREE.Mesh(g, new THREE.RawShaderMaterial({ vertexShader: DROP_VERT, fragmentShader: DROP_FRAG, uniforms: u, defines, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false }));
      m.frustumCulled = false;
      m.name = "pompeii-water-drops";
      m.renderOrder = 22;
      this.group.add(m);
    }
    // Steam: N sprites per source by its rate.
    const tier = lean ? WATER_TIERS.lean : WATER_TIERS.full;
    const src: number[] = [], area: number[] = [], rate: number[] = [];
    this.build.steam.forEach((q, i) => {
      const n = Math.round(tier.steam * q.rate);
      for (let k = 0; k < n; k++) { src.push(q.x, q.y, q.z, (i * 0.37 + k / n) % 1); area.push(q.hu, q.hv, q.ux, q.uz); rate.push(q.rate); }
    });
    if (rate.length) {
      const g = quad();
      g.setAttribute("aSrc", new THREE.InstancedBufferAttribute(new Float32Array(src), 4));
      g.setAttribute("aArea", new THREE.InstancedBufferAttribute(new Float32Array(area), 4));
      g.setAttribute("aRate", new THREE.InstancedBufferAttribute(new Float32Array(rate), 1));
      g.instanceCount = rate.length;
      const m = new THREE.Mesh(g, new THREE.RawShaderMaterial({ vertexShader: STEAM_VERT, fragmentShader: STEAM_FRAG, uniforms: u, defines, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false }));
      m.frustumCulled = false;
      m.name = "pompeii-water-steam";
      m.renderOrder = 24;
      this.group.add(m);
      this.steamMesh = m;
    } else this.steamMesh = null;

    const r = this.build.report;
    console.log(`[flyby] pompeii water: ${r.baths.length} baths (${r.baths.map((b) => b.rooms.length).join("+")} rooms), ${r.fountains.length} fountains, ${r.towers} towers, ` +
      `${r.impluvia.length} impluvia, ${r.steamSprites} steam, ${r.stoneTris + r.waterTris + r.jetTris} tris, ${(r.bytes / 1048576).toFixed(1)} MB, ${(performance.now() - t0).toFixed(0)} ms`);
  }

  /** Per frame: the clock for ripples, jets and steam. The pools never stop. */
  update(f: WaterFrame): void {
    // Wrapped so the shaders' float time keeps its precision over a long session.
    const t = f.t % 3600;
    this.time.value = t;
    this.townTime.value = t;
    this.steamOn.value = 1;
    void this.steamMesh;
  }
}

/** Stats for the HUD and the profile pose. */
export function waterSummary(w: PompeiiWater): string {
  const r = w.build.report;
  return `${r.fountains.length} fountains, ${r.towers} towers, ${r.baths.length} baths`;
}
