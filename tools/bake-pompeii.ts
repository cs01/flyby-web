// Bakes Pompeii's walled town into public/landmarks/pompeii.json.
//
//   bun tools/fetch-pompeii.ts      (once: the raw Overpass answer, cached)
//   bun tools/bake-pompeii.ts [--debug out.ppm]
//
// OSM maps the excavation well (the streets by name, the city wall, every gate,
// thousands of room walls, the public buildings) but it does not map INSULAE,
// the blocks between the streets, and those are what the town is built from.
// They are recovered here by rasterising: the walled area minus the streets at
// their real widths, labelled into connected blocks, each block traced back
// into a polygon. A raster is the robust way to do it: the street ways do not
// always share nodes, and a vector face-walk over a graph that is not quite
// planar falls apart where a raster just closes the gap.
//
// The unexcavated third (regio V north, III/IV, the east of I and IX) has a few
// projected streets in OSM and otherwise none; blocks there that come out far
// larger than any excavated insula are cut by INFERRED vicoli on the grid the
// excavated blocks follow (about 35 m by 100 m in regio I and IX). Every such
// street and block is flagged `inferred` in the pack.

import { readFileSync, writeFileSync } from "node:fs";
import { Origin } from "../src/geo";
import {
  plainName, pointInRing, polylineLength, ringArea, ringCentroid,
  type PompeiiData, type PompeiiInsula, type PompeiiPlace, type PompeiiPublic, type PompeiiStreet, type PublicKind, type Ring,
} from "../src/data/pompeii";

const RAW = new URL("./.cache/pompeii/raw.json", import.meta.url).pathname;
const OUT = new URL("../public/landmarks/pompeii.json", import.meta.url).pathname;
/** The pack origin, which is also the City entry's lat/lon. */
const LAT0 = 40.7490;
const LON0 = 14.4880;
/** Raster cell, metres. Half a metre keeps a 2.4 m vicolo five cells wide. */
const CELL = 0.5;

interface El { type: string; id: number; tags?: Record<string, string>; nodes?: number[]; lat?: number; lon?: number; members?: { type: string; ref: number; role: string }[] }

const raw = JSON.parse(readFileSync(RAW, "utf8")) as { elements: El[] };
const origin = new Origin(LAT0, LON0);
const nodes = new Map<number, [number, number]>();
const ways = new Map<number, El>();
for (const e of raw.elements) {
  if (e.type === "node" && e.lat !== undefined) {
    const w = origin.toWorld(e.lat, e.lon!);
    nodes.set(e.id, [w.x, w.z]);
  } else if (e.type === "way") ways.set(e.id, e);
}
const r1 = (v: number): number => Math.round(v * 10) / 10;
const wayPts = (w: El): number[] => {
  const out: number[] = [];
  for (const id of w.nodes ?? []) { const p = nodes.get(id); if (p) out.push(p[0], p[1]); }
  return out;
};
/** Outer ring of a closed way or a multipolygon relation (outer members joined). */
function outerRing(e: El): Ring | null {
  if (e.type === "way") {
    const p = wayPts(e);
    if (p.length < 8 || e.nodes![0] !== e.nodes![e.nodes!.length - 1]) return null;
    return p.slice(0, -2);
  }
  // Relation: chain the outer ways end to end.
  const segs = (e.members ?? []).filter((m) => m.type === "way" && m.role === "outer").map((m) => ways.get(m.ref)?.nodes ?? []).filter((n) => n.length > 1);
  if (!segs.length) return null;
  const chain = [...segs.shift()!];
  while (segs.length) {
    const tail = chain[chain.length - 1];
    let k = segs.findIndex((s) => s[0] === tail || s[s.length - 1] === tail);
    if (k < 0) break;
    const s = segs.splice(k, 1)[0];
    chain.push(...(s[0] === tail ? s.slice(1) : [...s].reverse().slice(1)));
  }
  const out: number[] = [];
  for (const id of chain) { const p = nodes.get(id); if (p) out.push(p[0], p[1]); }
  if (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out.length >= 6 ? out : null;
}

// --- the wall -----------------------------------------------------------------
const wallWay = [...ways.values()].find((w) => w.tags?.barrier === "city_wall" || w.tags?.historic === "citywalls");
if (!wallWay) throw new Error("no city wall in the raw OSM");
const wall = outerRing(wallWay)!;
if (ringArea(wall) < 0) reverseRing(wall);
function reverseRing(r: Ring): void {
  const n = r.length / 2;
  for (let i = 0; i < n / 2; i++) {
    const j = n - 1 - i;
    [r[i * 2], r[j * 2]] = [r[j * 2], r[i * 2]];
    [r[i * 2 + 1], r[j * 2 + 1]] = [r[j * 2 + 1], r[i * 2 + 1]];
  }
}
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < wall.length; i += 2) {
  minX = Math.min(minX, wall[i]); maxX = Math.max(maxX, wall[i]);
  minZ = Math.min(minZ, wall[i + 1]); maxZ = Math.max(maxZ, wall[i + 1]);
}
const inWall = (x: number, z: number): boolean => pointInRing(wall, x, z);

// --- streets ------------------------------------------------------------------
// The decumani and cardines: wide, with deep kerbs, lined with tabernae.
const MAIN = /^(Via dell'Abbondanza|Via Stabiana|Via di Stabia|Via Nola|Via di Nola|Via della Fortuna|Via Consolare|Via di Mercurio|Via del Vesuvio|Via Marina|Via di Nocera|Via Nocera|Via delle Terme|Via del Foro)$/;
const DROP_HW = new Set(["steps", "motorway", "motorway_link", "primary", "construction", "cycleway", "service", "residential", "tertiary", "unclassified"]);

function straightness(p: number[]): number {
  const chord = Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]);
  return chord / Math.max(1e-6, polylineLength(p));
}
const streets: PompeiiStreet[] = [];
for (const w of ways.values()) {
  const t = w.tags;
  if (!t?.highway || DROP_HW.has(t.highway) || t.area === "yes") continue;
  const p = wayPts(w);
  if (p.length < 4) continue;
  // Inside the walls: most of the way's vertices, not just one end, so the
  // modern roads along the outside of the circuit stay out.
  let inside = 0;
  for (let i = 0; i < p.length; i += 2) if (inWall(p[i], p[i + 1])) inside++;
  // Named streets at 40%: Via Marina runs on out through its gate to the sea.
  if (inside < (p.length / 2) * (/^(Via|Vicolo)\b/.test(t.name ?? "") ? 0.4 : 0.6)) continue;
  const name = t.name ?? "";
  const named = /^(Via|Vicolo|Strada)\b/.test(name);
  const len = polylineLength(p);
  // Unnamed paths: the visitor routes through the park and the paths inside
  // houses are curvy or short; an ancient street is a straight line.
  if (!named && !/^projected vicolo/i.test(name) && (len < 35 || straightness(p) < 0.97)) continue;
  const main = MAIN.test(name);
  const vicolo = name.startsWith("Vicolo") || !named;
  streets.push({
    name: named ? name : "",
    main,
    carriageM: main ? 4.6 : vicolo ? 2.6 : 3.6,
    sidewalkM: main ? 2.1 : vicolo ? 0.8 : 1.4,
    inferred: /^projected/i.test(name),
    pts: p.map(r1),
  });
}

// --- publics --------------------------------------------------------------------
const PUBLIC_RULES: [RegExp, PublicKind][] = [
  [/^Foro di Pompei/, "forum"],
  [/^Tempi/, "temple"],
  [/^Basilica/, "basilica"],
  [/^(Macellum|Granai del Foro)/, "hall"],
  [/^Terme /, "baths"],
  [/^Teatro Grande/, "theatre"],
  [/^Teatro Piccolo/, "odeon"],
  [/^(Quadriportico|Foro Triangolare|Palestra Sannitica)/, "portico"],
  [/^Palestra Grande/, "palestra"],
];
const publics: PompeiiPublic[] = [];
let amphiRing: Ring | null = null;
for (const e of raw.elements) {
  const name = e.tags?.name;
  if (!name || (e.type !== "way" && e.type !== "relation")) continue;
  if (/^Anfiteatro/.test(name)) { amphiRing = outerRing(e); continue; }
  const rule = PUBLIC_RULES.find(([re]) => re.test(name));
  if (!rule) continue;
  const ring = outerRing(e);
  if (!ring) continue;
  const [cx, cz] = ringCentroid(ring);
  if (!inWall(cx, cz)) continue;
  if (ringArea(ring) < 0) reverseRing(ring);
  publics.push({ name: plainName(name), kind: rule[1], ring: ring.map(r1) });
}
if (!amphiRing) throw new Error("no amphitheatre outline");
const amphitheatre = fitEllipse(amphiRing);
{
  // The visitor paths across the arena are not streets.
  const a = amphitheatre;
  const inAmphi = (x: number, z: number): boolean => {
    const dx = x - a.cx, dz = z - a.cz;
    const u = dx * Math.cos(a.rot) + dz * Math.sin(a.rot), v = -dx * Math.sin(a.rot) + dz * Math.cos(a.rot);
    return (u / a.a) ** 2 + (v / a.b) ** 2 <= 1;
  };
  for (let i = streets.length - 1; i >= 0; i--) {
    const p = streets[i].pts;
    // Sampled along the line, not at its vertices: a two-node path straight
    // across the arena has none inside.
    let n = 0, m = 0;
    for (let k = 2; k < p.length; k += 2) {
      const L = Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
      for (let s = 0; s < L; s += 2, m++) if (inAmphi(p[k - 2] + ((p[k] - p[k - 2]) * s) / L, p[k - 1] + ((p[k + 1] - p[k - 1]) * s) / L)) n++;
    }
    if (m && n / m > 0.3) streets.splice(i, 1);
  }
}

/**
 * The ellipse with the outline's AREA moments. The outline's extremes are the
 * external stair blocks, which stand proud of the wall and put a max-extent fit
 * at 145 x 126 m; a filled ellipse's second moments are pi a^3 b / 4 about its
 * minor axis, so a = 2 sqrt(I/A) recovers the wall itself and lets the stairs
 * average out.
 */
function fitEllipse(r: Ring): PompeiiData["amphitheatre"] {
  const n = r.length / 2;
  let A = 0, cx = 0, cz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const c = r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
    A += c; cx += (r[j * 2] + r[i * 2]) * c; cz += (r[j * 2 + 1] + r[i * 2 + 1]) * c;
  }
  A /= 2; cx /= 6 * A; cz /= 6 * A;
  // Second moments about the centroid, by Green's theorem.
  let ixx = 0, izz = 0, ixz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x0 = r[j * 2] - cx, z0 = r[j * 2 + 1] - cz, x1 = r[i * 2] - cx, z1 = r[i * 2 + 1] - cz;
    const c = x0 * z1 - x1 * z0;
    ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c;
    izz += (z0 * z0 + z0 * z1 + z1 * z1) * c;
    ixz += (x0 * z1 + 2 * x0 * z0 + 2 * x1 * z1 + x1 * z0) * c;
  }
  ixx /= 12; izz /= 12; ixz /= 24;
  const s = Math.sign(A);
  ixx *= s; izz *= s; ixz *= s;
  const area = Math.abs(A);
  const rot = 0.5 * Math.atan2(2 * ixz, ixx - izz);
  const c = Math.cos(rot), sn = Math.sin(rot);
  const iu = ixx * c * c + 2 * ixz * c * sn + izz * sn * sn;
  const iv = ixx * sn * sn - 2 * ixz * c * sn + izz * c * c;
  const a = 2 * Math.sqrt(iu / area), b = 2 * Math.sqrt(iv / area);
  return { cx: r1(cx), cz: r1(cz), a: r1(a), b: r1(b), rot: Math.round(rot * 1e4) / 1e4 };
}

// --- the raster -----------------------------------------------------------------
const PAD = 4;
const gx0 = minX - PAD, gz0 = minZ - PAD;
const W = Math.ceil((maxX - minX + 2 * PAD) / CELL);
const H = Math.ceil((maxZ - minZ + 2 * PAD) / CELL);
const N = W * H;
const cellX = (i: number): number => gx0 + (i + 0.5) * CELL;
const cellZ = (j: number): number => gz0 + (j + 0.5) * CELL;

/** Scanline fill of a ring into `grid` with value v. */
function fillRing(grid: Uint8Array | Int32Array, r: Ring, v: number): void {
  const n = r.length / 2;
  const xs: number[] = [];
  for (let j = 0; j < H; j++) {
    const z = cellZ(j);
    xs.length = 0;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const za = r[a * 2 + 1], zb = r[b * 2 + 1];
      if (za > z !== zb > z) xs.push(r[a * 2] + ((z - za) / (zb - za)) * (r[b * 2] - r[a * 2]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - gx0) / CELL - 0.5));
      const i1 = Math.min(W - 1, Math.floor((xs[k + 1] - gx0) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) grid[j * W + i] = v;
    }
  }
}
/** Stamp a thick polyline. */
function stampLine(grid: Uint8Array, p: number[], halfW: number, v: number): void {
  const rc = Math.ceil(halfW / CELL) + 1;
  for (let s = 2; s < p.length; s += 2) {
    const ax = p[s - 2], az = p[s - 1], bx = p[s], bz = p[s + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - gx0) / CELL) - rc);
    const i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) - gx0) / CELL) + rc);
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - gz0) / CELL) - rc);
    const j1 = Math.min(H - 1, Math.ceil((Math.max(az, bz) - gz0) / CELL) + rc);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = cellX(i), z = cellZ(j);
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= halfW) grid[j * W + i] = v;
      }
    }
  }
}

const inside = new Uint8Array(N);
fillRing(inside, wall, 1);
// The wall itself and its inner pomerium strip are not building land.
const wallBand = new Uint8Array(N);
stampLine(wallBand, [...wall, wall[0], wall[1]], 7, 1);

const street = new Uint8Array(N);
const carriage = new Uint8Array(N);
function stampStreets(list: PompeiiStreet[]): void {
  for (const s of list) {
    stampLine(street, s.pts, s.carriageM / 2 + s.sidewalkM, 1);
    stampLine(carriage, s.pts, s.carriageM / 2, 1);
  }
}
/**
 * Join street ends onto the network, so the cart's graph is connected and the
 * raster has no gap for two insulae to leak into each other through. An end
 * within 6 m of another street snaps onto it; an end that stops short (OSM's
 * vicoli often end a few metres before the street they meet) is pushed on
 * along its own direction up to 25 m to the first street it crosses. Either
 * way the other street gets a vertex at the join.
 */
function connectStreets(list: PompeiiStreet[], all: PompeiiStreet[]): number {
  let joined = 0;
  const join = (s: PompeiiStreet, end: number, o: PompeiiStreet, seg: number, px: number, pz: number): void => {
    px = r1(px); pz = r1(pz);
    if (end === 0) { s.pts[0] = px; s.pts[1] = pz; } else { s.pts[end] = px; s.pts[end + 1] = pz; }
    let has = false;
    for (let k = 0; k < o.pts.length; k += 2) if (Math.hypot(o.pts[k] - px, o.pts[k + 1] - pz) < 0.05) has = true;
    if (!has) o.pts.splice(seg, 0, px, pz);
    joined++;
  };
  for (const s of list) {
    for (const atStart of [true, false]) {
      const end = atStart ? 0 : s.pts.length - 2;
      const x = s.pts[end], z = s.pts[end + 1];
      let best: { o: PompeiiStreet; seg: number; px: number; pz: number; d: number } | null = null;
      for (const o of all) {
        if (o === s) continue;
        for (let k = 2; k < o.pts.length; k += 2) {
          const ax = o.pts[k - 2], az = o.pts[k - 1], dx = o.pts[k] - ax, dz = o.pts[k + 1] - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
          const px = ax + t * dx, pz = az + t * dz, d = Math.hypot(x - px, z - pz);
          if (d < 9 && (!best || d < best.d)) best = { o, seg: k, px, pz, d };
        }
      }
      if (best) {
        if (best.d > 0.01) join(s, end, best.o, best.seg, best.px, best.pz);
        continue;
      }
      // Push on: the ray from the second-to-last vertex through the end.
      const ix = atStart ? s.pts[2] : s.pts[end - 2], iz = atStart ? s.pts[3] : s.pts[end - 1];
      const L = Math.hypot(x - ix, z - iz) || 1;
      const rx = (x - ix) / L, rz = (z - iz) / L;
      let hit: { o: PompeiiStreet; seg: number; t: number } | null = null;
      for (const o of all) {
        if (o === s) continue;
        for (let k = 2; k < o.pts.length; k += 2) {
          const ax = o.pts[k - 2], az = o.pts[k - 1], ex = o.pts[k] - ax, ez = o.pts[k + 1] - az;
          const den = rx * ez - rz * ex;
          if (Math.abs(den) < 1e-6) continue;
          const t = ((ax - x) * ez - (az - z) * ex) / den;
          const u = ((ax - x) * rz - (az - z) * rx) / den;
          if (t > 0 && t < 30 && u >= 0 && u <= 1 && (!hit || t < hit.t)) hit = { o, seg: k, t };
        }
      }
      if (hit) {
        if (!atStart) { s.pts.push(r1(x + rx * hit.t), r1(z + rz * hit.t)); join(s, s.pts.length - 2, hit.o, hit.seg, x + rx * hit.t, z + rz * hit.t); }
        else { s.pts.unshift(r1(x + rx * hit.t), r1(z + rz * hit.t)); join(s, 0, hit.o, hit.seg, x + rx * hit.t, z + rz * hit.t); }
        continue;
      }
      // Nothing to meet: a vicolo that stops short of the wall (regio VI's run
      // up to the north wall, with unbuilt ground between) is carried on to the
      // wall's inner strip, or the blocks either side of it leak into one.
      const n = wall.length / 2;
      let tw = Infinity;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ax = wall[b * 2], az = wall[b * 2 + 1], ex = wall[a * 2] - ax, ez = wall[a * 2 + 1] - az;
        const den = rx * ez - rz * ex;
        if (Math.abs(den) < 1e-6) continue;
        const t = ((ax - x) * ez - (az - z) * ex) / den;
        const u = ((ax - x) * rz - (az - z) * rx) / den;
        if (t > 0 && u >= 0 && u <= 1) tw = Math.min(tw, t);
      }
      if (tw < 60 && tw > 6) {
        const px = r1(x + rx * (tw - 5)), pz = r1(z + rz * (tw - 5));
        if (atStart) s.pts.unshift(px, pz); else s.pts.push(px, pz);
      }
    }
  }
  return joined;
}
console.log(`joined ${connectStreets(streets, streets)} street ends onto the network`);
stampStreets(streets);

const special = new Uint8Array(N);
for (const p of publics) fillRing(special, p.ring, 1);
{
  // The amphitheatre as its ellipse, a few metres out for the external stairs.
  const a = amphitheatre;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const dx = cellX(i) - a.cx, dz = cellZ(j) - a.cz;
    const u = dx * Math.cos(a.rot) + dz * Math.sin(a.rot), v = -dx * Math.sin(a.rot) + dz * Math.cos(a.rot);
    if ((u / (a.a + 6)) ** 2 + (v / (a.b + 6)) ** 2 <= 1) special[j * W + i] = 1;
  }
}

// Room walls: where the excavation is. Counted per cell within 2 m of a wall.
const walls = new Uint8Array(N);
let roomWalls = 0;
for (const w of ways.values()) {
  if (w.tags?.barrier !== "wall") continue;
  const p = wayPts(w);
  if (p.length < 4) continue;
  roomWalls++;
  stampLine(walls, p, 2, 1);
}

// Vineyards and gardens mapped inside the walls.
const garden = new Uint8Array(N);
for (const w of ways.values()) {
  const lu = w.tags?.landuse;
  if (lu !== "vineyard" && lu !== "orchard" && w.tags?.leisure !== "garden") continue;
  const r = outerRing(w);
  if (r) fillRing(garden, r, 1);
}

// --- label the blocks -------------------------------------------------------------
function label(): { lab: Int32Array; sizes: number[] } {
  const lab = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let k = 0; k < N; k++) {
    if (lab[k] >= 0 || !inside[k] || street[k] || special[k] || wallBand[k]) continue;
    const id = sizes.length;
    let size = 0;
    lab[k] = id;
    stack.push(k);
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const i = c % W, j = (c - i) / W;
      const nb = [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, j > 0 ? c - W : -1, j < H - 1 ? c + W : -1];
      for (const q of nb) {
        if (q < 0 || lab[q] >= 0 || !inside[q] || street[q] || special[q] || wallBand[q]) continue;
        lab[q] = id;
        stack.push(q);
      }
    }
    sizes.push(size);
  }
  return { lab, sizes };
}

/** Fraction of a block's cells near a surveyed room wall. */
function wallDensity(lab: Int32Array, id: number): number {
  let n = 0, w = 0;
  for (let k = 0; k < N; k++) if (lab[k] === id) { n++; if (walls[k]) w++; }
  return n ? w / n : 0;
}

/** Principal axes of a block's cells. */
function blockAxes(lab: Int32Array, id: number): { cx: number; cz: number; ux: number; uz: number; minU: number; maxU: number; minV: number; maxV: number } {
  let n = 0, sx = 0, sz = 0;
  for (let k = 0; k < N; k++) if (lab[k] === id) { n++; sx += cellX(k % W); sz += cellZ(Math.floor(k / W)); }
  const cx = sx / n, cz = sz / n;
  let xx = 0, zz = 0, xz = 0;
  for (let k = 0; k < N; k++) if (lab[k] === id) {
    const dx = cellX(k % W) - cx, dz = cellZ(Math.floor(k / W)) - cz;
    xx += dx * dx; zz += dz * dz; xz += dx * dz;
  }
  const rot = 0.5 * Math.atan2(2 * xz, xx - zz);
  const ux = Math.cos(rot), uz = Math.sin(rot);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let k = 0; k < N; k++) if (lab[k] === id) {
    const dx = cellX(k % W) - cx, dz = cellZ(Math.floor(k / W)) - cz;
    const u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  return { cx, cz, ux, uz, minU, maxU, minV, maxV };
}

/** Longest run of a block's cells along a line, as a street centreline. */
function cutLine(lab: Int32Array, id: number, ox: number, oz: number, dx: number, dz: number, reach: number): number[] | null {
  let best: [number, number] | null = null, run: number | null = null;
  const step = CELL * 0.5;
  for (let s = -reach; s <= reach + step; s += step) {
    const x = ox + dx * s, z = oz + dz * s;
    const i = Math.floor((x - gx0) / CELL), j = Math.floor((z - gz0) / CELL);
    const hit = s <= reach && i >= 0 && j >= 0 && i < W && j < H && lab[j * W + i] === id;
    if (hit && run === null) run = s;
    if (!hit && run !== null) {
      if (!best || s - run > best[1] - best[0]) best = [run, s];
      run = null;
    }
  }
  if (!best || best[1] - best[0] < 20) return null;
  // Out past the block to the centreline of the street it meets, so the
  // inferred vicolo joins the network.
  const a = best[0] - 4, b = best[1] + 4;
  return [r1(ox + dx * a), r1(oz + dz * a), r1(ox + dx * b), r1(oz + dz * b)];
}

let { lab, sizes } = label();
// Excavated insulae run to ~6,000 m2 in regio I and IX; Casa del Fauno's whole
// insula is about 3,000. A block of 9,000 m2 with no surveyed rooms in it is
// two or more insulae whose vicoli nobody has dug up.
const BIG_CELLS = 9000 / (CELL * CELL);
let inferredStreets = 0;
for (let pass = 0; pass < 3; pass++) {
  const cuts: PompeiiStreet[] = [];
  for (let id = 0; id < sizes.length; id++) {
    if (sizes[id] < BIG_CELLS || wallDensity(lab, id) > 0.12) continue;
    const ax = blockAxes(lab, id);
    const lenU = ax.maxU - ax.minU, lenV = ax.maxV - ax.minV;
    // Insulae in the unexcavated east are about 35 m across and 100-120 m long,
    // long axis along the cardines. Cut across the long axis every ~110 m and
    // along it every ~38 m, centred so the leftover blocks are even.
    const cutsAcross = Math.max(0, Math.round(lenU / 110) - 1);
    const cutsAlong = Math.max(0, Math.round(lenV / 40) - 1);
    const reach = Math.hypot(lenU, lenV);
    for (let k = 1; k <= cutsAcross; k++) {
      const u = ax.minU + (lenU * k) / (cutsAcross + 1);
      const ox = ax.cx + ax.ux * u, oz = ax.cz + ax.uz * u;
      const line = cutLine(lab, id, ox, oz, -ax.uz, ax.ux, reach);
      if (line) cuts.push({ name: "", main: false, carriageM: 2.6, sidewalkM: 0.8, inferred: true, pts: line });
    }
    for (let k = 1; k <= cutsAlong; k++) {
      const v = ax.minV + (lenV * k) / (cutsAlong + 1);
      const ox = ax.cx - ax.uz * v, oz = ax.cz + ax.ux * v;
      const line = cutLine(lab, id, ox, oz, ax.ux, ax.uz, reach);
      if (line) cuts.push({ name: "", main: false, carriageM: 2.6, sidewalkM: 0.8, inferred: true, pts: line });
    }
  }
  if (!cuts.length) break;
  inferredStreets += cuts.length;
  streets.push(...cuts);
  connectStreets(cuts, streets);
  stampStreets(cuts);
  ({ lab, sizes } = label());
}

// --- trace each block back into a polygon -----------------------------------------
/** Marching squares over one label; the longest loop, in world metres. */
function trace(mask: (i: number, j: number) => boolean): Ring | null {
  // Edges between corner points (i,j) on the cell-corner lattice, keyed by start.
  const next = new Map<number, number[]>();
  const key = (i: number, j: number): number => j * (W + 1) + i;
  const add = (a: number, b: number): void => {
    const l = next.get(a);
    if (l) l.push(b); else next.set(a, [b]);
  };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!mask(i, j)) continue;
    // Counter-clockwise in screen space (z down) around the cell's inside.
    if (j === 0 || !mask(i, j - 1)) add(key(i + 1, j), key(i, j));
    if (i === 0 || !mask(i - 1, j)) add(key(i, j), key(i, j + 1));
    if (j === H - 1 || !mask(i, j + 1)) add(key(i, j + 1), key(i + 1, j + 1));
    if (i === W - 1 || !mask(i + 1, j)) add(key(i + 1, j + 1), key(i + 1, j));
  }
  let best: number[] | null = null;
  const used = new Set<string>();
  for (const [start, outs] of next) {
    for (const first of outs) {
      if (used.has(`${start}>${first}`)) continue;
      const loop = [start];
      let a = start, b = first;
      for (let guard = 0; guard < 1e6; guard++) {
        used.add(`${a}>${b}`);
        if (b === start) break;
        loop.push(b);
        const cand = next.get(b)!;
        const nb = cand.find((c) => !used.has(`${b}>${c}`)) ?? cand[0];
        a = b; b = nb;
      }
      if (!best || loop.length > best.length) best = loop;
    }
  }
  if (!best) return null;
  const pts: number[] = [];
  for (const k of best) {
    const i = k % (W + 1), j = Math.floor(k / (W + 1));
    pts.push(gx0 + i * CELL, gz0 + j * CELL);
  }
  return simplify(pts, 0.7);
}

/** Douglas-Peucker on a closed ring. */
function simplify(r: number[], tol: number): Ring {
  const n = r.length / 2;
  // Split at the two farthest-apart points so a closed ring simplifies well.
  let far = 0, fd = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(r[i * 2] - r[0], r[i * 2 + 1] - r[1]);
    if (d > fd) { fd = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const dp = (a: number, b: number): void => {
    // b may wrap past n.
    const ax = r[(a % n) * 2], az = r[(a % n) * 2 + 1], bx = r[(b % n) * 2], bz = r[(b % n) * 2 + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1e-9;
    let worst = -1, wd = tol;
    for (let k = a + 1; k < b; k++) {
      const px = r[(k % n) * 2], pz = r[(k % n) * 2 + 1];
      const d = Math.abs((px - ax) * dz - (pz - az) * dx) / L;
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst >= 0) { keep[worst % n] = 1; dp(a, worst); dp(worst, b); }
  };
  dp(0, far);
  dp(far, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r1(r[i * 2]), r1(r[i * 2 + 1]));
  return out;
}

const MIN_INSULA_M2 = 40;
const insulae: PompeiiInsula[] = [];
// The kerb block of each insula: its cells plus the pavement around it, out
// to the carriageway. Grown by breadth-first search through pavement cells.
const kerbLab = new Int32Array(N).fill(-1);
{
  const q: number[] = [];
  for (let k = 0; k < N; k++) if (lab[k] >= 0 && sizes[lab[k]] * CELL * CELL >= MIN_INSULA_M2) { kerbLab[k] = lab[k]; q.push(k); }
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const i = c % W, j = (c - i) / W;
    for (const nb of [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, j > 0 ? c - W : -1, j < H - 1 ? c + W : -1]) {
      if (nb < 0 || kerbLab[nb] >= 0 || carriage[nb] || !inside[nb] || special[nb] || wallBand[nb]) continue;
      if (!street[nb]) continue;
      kerbLab[nb] = kerbLab[c];
      q.push(nb);
    }
  }
}
let gardens = 0, inferredInsulae = 0;
for (let id = 0; id < sizes.length; id++) {
  if (sizes[id] * CELL * CELL < MIN_INSULA_M2) continue;
  const ring = trace((i, j) => lab[j * W + i] === id);
  const kerb = trace((i, j) => kerbLab[j * W + i] === id);
  if (!ring || ring.length < 6 || !kerb || kerb.length < 6) continue;
  if (ringArea(ring) < 0) reverseRing(ring);
  if (ringArea(kerb) < 0) reverseRing(kerb);
  let g = 0, n = 0;
  for (let k = 0; k < N; k++) if (lab[k] === id) { n++; if (garden[k]) g++; }
  const inferred = wallDensity(lab, id) < 0.05;
  const isGarden = g / n > 0.5;
  if (isGarden) gardens++;
  if (inferred) inferredInsulae++;
  // Edges whose midpoint is within reach of a main street's centreline.
  const mainEdges: number[] = [];
  const m = ring.length / 2;
  for (let e = 0; e < m; e++) {
    const ax = ring[e * 2], az = ring[e * 2 + 1], bx = ring[((e + 1) % m) * 2], bz = ring[((e + 1) % m) * 2 + 1];
    if (Math.hypot(bx - ax, bz - az) < 6) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    for (const s of streets) {
      if (!s.main) continue;
      if (distToPolyline(s.pts, mx, mz) < s.carriageM / 2 + s.sidewalkM + 1.5) { mainEdges.push(e); break; }
    }
  }
  insulae.push({ ring, kerb, inferred, garden: isGarden, mainEdges });
}
function distToPolyline(p: number[], x: number, z: number): number {
  let best = Infinity;
  for (let s = 2; s < p.length; s += 2) {
    const ax = p[s - 2], az = p[s - 1], dx = p[s] - ax, dz = p[s + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}


// --- names ---------------------------------------------------------------------------
const places: PompeiiPlace[] = [];
const domus: { name: string; ring: Ring }[] = [];
const seenPlace = new Set<string>();
for (const e of raw.elements) {
  const name = e.tags?.name;
  if (!name) continue;
  if (e.tags?.historic === "city_gate" && e.type === "node") {
    const p = nodes.get(e.id)!;
    if (!seenPlace.has(name)) { seenPlace.add(name); places.push({ name, x: r1(p[0]), z: r1(p[1]), kind: "gate" }); }
    continue;
  }
  if (!/^(Casa|Villa|Lupanare|Caupona)/.test(name) || /senza nome|con bottega|Airbnb|Maria|Myriam|B&b|Hotel/i.test(name)) continue;
  if (e.type !== "way" && e.type !== "relation") continue;
  const ring = outerRing(e);
  if (!ring) continue;
  const [cx, cz] = ringCentroid(ring);
  if (!inWall(cx, cz)) continue;
  const pn = plainName(name);
  if (ringArea(ring) < 0) reverseRing(ring);
  domus.push({ name: pn, ring: ring.map(r1) });
  if (!seenPlace.has(pn)) { seenPlace.add(pn); places.push({ name: pn, x: r1(cx), z: r1(cz), kind: "domus" }); }
}
for (const p of publics) {
  const [cx, cz] = ringCentroid(p.ring);
  if (!seenPlace.has(p.name)) { seenPlace.add(p.name); places.push({ name: p.name, x: r1(cx), z: r1(cz), kind: "public" }); }
}
places.push({ name: "Amphitheatre", x: amphitheatre.cx, z: amphitheatre.cz, kind: "public" });
const gates = places.filter((p) => p.kind === "gate").map((p) => ({ name: p.name, x: p.x, z: p.z }));

const streetM = streets.reduce((s, st) => s + polylineLength(st.pts), 0);
const stats = {
  rawElements: raw.elements.length,
  roomWalls,
  streets: streets.length,
  namedStreets: new Set(streets.filter((s) => s.name).map((s) => s.name)).size,
  mainStreets: streets.filter((s) => s.main).length,
  inferredStreets,
  streetKm: Math.round(streetM) / 1000,
  insulae: insulae.length,
  inferredInsulae,
  gardenInsulae: gardens,
  publics: publics.length,
  domusOutlines: domus.length,
  gates: gates.length,
  places: places.length,
};
const data: PompeiiData = {
  lat0: LAT0, lon0: LON0, wall: wall.map(r1), gates, streets, insulae, publics, amphitheatre, places, domus, stats,
};
writeFileSync(OUT, JSON.stringify(data));
console.log(JSON.stringify(stats, null, 1));
console.log(`amphitheatre ${(amphitheatre.a * 2).toFixed(1)} x ${(amphitheatre.b * 2).toFixed(1)} m`);
console.log(`publics: ${publics.map((p) => `${p.name} [${p.kind}]`).join(", ")}`);
console.log(`wrote ${OUT}: ${(JSON.stringify(data).length / 1024).toFixed(0)} kB`);

// --- debug raster ---------------------------------------------------------------------
const dbg = process.argv.indexOf("--debug");
if (dbg > 0) {
  const img = new Uint8Array(N * 3).fill(255);
  for (let k = 0; k < N; k++) {
    let c: [number, number, number] = [255, 255, 255];
    if (!inside[k]) c = [235, 235, 225];
    else if (carriage[k]) c = [60, 60, 70];
    else if (street[k]) c = [150, 150, 150];
    else if (special[k]) c = [230, 190, 60];
    else if (lab[k] >= 0) {
      const h = (lab[k] * 2654435761) >>> 0;
      c = [120 + (h & 0x7f), 80 + ((h >> 8) & 0x5f), 60 + ((h >> 16) & 0x5f)];
    }
    img.set(c, k * 3);
  }
  const plot = (x: number, z: number, c: number[]): void => {
    const i = Math.floor((x - gx0) / CELL), j = Math.floor((z - gz0) / CELL);
    if (i >= 0 && j >= 0 && i < W && j < H) img.set(c, (j * W + i) * 3);
  };
  for (const ins of insulae) {
    const r = ins.ring, n = r.length / 2;
    for (let e = 0; e < n; e++) {
      const ax = r[e * 2], az = r[e * 2 + 1], bx = r[((e + 1) % n) * 2], bz = r[((e + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const col = ins.mainEdges.includes(e) ? [255, 0, 0] : ins.inferred ? [0, 0, 255] : [0, 0, 0];
      for (let s = 0; s <= L; s += CELL / 2) plot(ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L, col);
    }
  }
  writeFileSync(process.argv[dbg + 1], Buffer.concat([Buffer.from(`P6 ${W} ${H} 255\n`), Buffer.from(img)]));
}
