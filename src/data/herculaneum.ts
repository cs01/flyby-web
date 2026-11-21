// Herculaneum (Ercolano) on the eve of the eruption: what the town has that
// Pompeii's pack format does not carry, and the 79 AD ground it stood on.
// tools/bake-pompeii.ts lays it out (`bun tools/bake-pompeii.ts herculaneum`),
// render/herculaneummesh.ts builds it, test/herculaneum.check.ts gates it.
//
// The town sat on a tuff promontory between two streams, its sea front a
// terrace over the beach. The excavation is a pit about 20 m deep in modern
// Ercolano and the beach of 79 lies some 400 m inland of today's coast, so
// neither the DEM nor today's shoreline is the ground of 79: HerculaneumField
// answers that ground analytically round the town and defers to the DEM
// beyond. Everything here not read off OSM is an estimate and says so.
//
// Coordinates: pack metres (x east, z south) about the City entry's point,
// and a grid frame (t along the decumani toward the south-east, n inland
// toward the north-east, from the face of the boat sheds) the bake fitted to
// OSM's cardines and decumani.
//
// Pure: no DOM, no THREE.

import { pointInRing, type Ring } from "./pompeii";
import { nearestOn, riverAt, type PompeiiSuburbs } from "./pompeiisuburbs";

export const HERC_LAT0 = 40.8059;
export const HERC_LON0 = 14.3479;

/** The grid frame: origin at the boat sheds' face, t unit along the decumani (south-east), n unit inland (north-east). */
export interface HercFrame { ox: number; oz: number; tx: number; tz: number }

/** One of the vaulted boat sheds (fornici) under the terrace, opening onto the beach. */
export interface Fornix {
  /** Middle of the opening on the face, the way into the vault (fx, fz: out, toward the sea). */
  x: number; z: number; fx: number; fz: number;
  /** Opening width, vault depth and crown height, metres. */
  w: number; d: number; h: number;
}

export interface HerculaneumExtras {
  frame: HercFrame;
  /**
   * Levels, metres above the sea: the beach, the terrace over the sheds, and
   * the town's rise per metre inland from the terrace. Estimates: the
   * excavated beach and the terrace walls give the step (about 8 m), the
   * cardines the slope.
   */
  levels: { beach: number; terrace: number; slope: number };
  /** The face of the sea wall and sheds, north-west to south-east (sea on the right). */
  cliff: number[];
  fornici: Fornix[];
  /** Skeletons found in the sheds and on the beach since 1980 (about 300). */
  victims: number;
  /** The open terrace over the sheds: the Sacred Area and Balbus's terrace. */
  terrace: Ring;
  /** The two small temples of the Sacred Area (OSM marks one, "Tempio di Venere"). */
  temples: { name: string; x: number; z: number; fx: number; fz: number }[];
  /** The funerary altar and statue of Marcus Nonius Balbus on his terrace (OSM point). */
  balbus: { x: number; z: number; fx: number; fz: number };
  /** The Villa of the Papyri's great peristyle and its long pool, on the villa's own axis. */
  papyri: { peristyle: Ring; pool: Ring; belvedere: { x: number; z: number } };
  /** Where Neptune and Amphitrite are, on the nymphaeum wall of their house (OSM point). */
  neptune: { x: number; z: number };
  /** The Trellis House: two storeys, its upper floor timber framed (opus craticium). */
  trellis: string;
}

// --- the frame --------------------------------------------------------------------

export function frameFwd(f: HercFrame, t: number, n: number): [number, number] {
  // n's unit is t's turned toward the north-east: (tz, -tx).
  return [f.ox + f.tx * t + f.tz * n, f.oz + f.tz * t - f.tx * n];
}

export function frameInv(f: HercFrame, x: number, z: number): [number, number] {
  const dx = x - f.ox, dz = z - f.oz;
  return [dx * f.tx + dz * f.tz, dx * f.tz - dz * f.tx];
}

/**
 * Where the cliff stands, n at t. Straight under the town; north-west of the
 * sheds it swings 50 m seaward round the Villa of the Papyri, whose outline
 * reaches past the line the town's front follows (an estimate: the villa's
 * lowest terrace is known to have stood over the sea).
 */
export function cliffN(t: number): number {
  const k = Math.max(0, Math.min(1, (-45 - t) / 80));
  return -52 * k * k * (3 - 2 * k);
}

/** The terrace's inland edge: the sea wall the town front stands on. */
export const TERRACE_DEPTH_M = 20;
/** Where the ground rises inside the built terrace, behind the sheds' back walls. */
const CLIFF_FOOT_M = 16;
/** The beach, cliff face to the water's edge (estimate). */
export const BEACH_M = 32;

/**
 * The ground of 79 at x,z, given today's DEM there. Sea, beach, the sea wall
 * up to the terrace, the town rising inland, then a blend back to the DEM less
 * the 15-20 m of deposits the eruption laid, which thin away from the town.
 * `w` is how much the estimate governs: 0 past the blend, where the DEM is
 * left as it is.
 */
export function hercGround(h: HerculaneumExtras, river: PompeiiSuburbs["river"] | null, x: number, z: number, dem: number): number {
  const [t, n0] = frameInv(h.frame, x, z);
  const n = n0 - cliffN(t);
  const { beach, terrace, slope } = h.levels;
  let y: number;
  // The terrain's finest triangles are about 6 m: each step in this profile
  // sits a triangle or two away from anything that must stay flat, or the
  // mesh smears it there (the sea over the beach, a mound inside the sheds).
  if (n < -BEACH_M) {
    // The shelf off the beach: down to 14 m within a few hundred metres.
    y = Math.max(-14, -0.5 + (n + BEACH_M) * 0.05);
  } else if (n < -BEACH_M + 6) {
    // Swash: the terrain shades ground under 3.5 m as water.
    y = 0.2 + ((n + BEACH_M) / 6) * 3.9;
  } else if (n < CLIFF_FOOT_M) {
    // The beach, rising gently to the cliff and running on in under the
    // sheds' vaults to their back walls.
    y = 4.1 + ((n + BEACH_M - 6) / (BEACH_M - 6 + CLIFF_FOOT_M)) * (beach - 4.1);
  } else if (n < TERRACE_DEPTH_M - 1) {
    // Behind the vaults: the cliff, hidden inside the built terrace.
    const k = (n - CLIFF_FOOT_M) / (TERRACE_DEPTH_M - 1 - CLIFF_FOOT_M);
    y = beach + (terrace - beach) * k;
  } else {
    y = terrace + slope * Math.max(0, n - TERRACE_DEPTH_M);
  }
  // The eastern stream's ravine (data/herculaneum.ts layout), down to its water.
  if (river) {
    const rv = riverAt(river, x, z);
    const reach = rv.halfW + 30;
    if (rv.d < reach && n > -BEACH_M + 2) {
      const q = Math.min(1, rv.d / reach);
      const bed = rv.level - 1.2;
      y = Math.min(y, bed + (Math.max(y, bed) - bed) * q * q);
    }
  }
  // Inland and along the coast the estimate hands back to the DEM.
  const inland = smooth01((n - 350) / 600);
  const along = smooth01((Math.abs(t - 40) - 700) / 600);
  const deposit = 16 * (1 - smooth01((n - 900) / 500));
  const far = Math.max(LAND_FLOOR, dem - deposit);
  const wIn = 1 - inland;
  y = y * wIn + far * (1 - wIn);
  // Past the ends of the coast the modern shore returns: the estimate fades out.
  return y * (1 - along) + dem * along;
}

const LAND_FLOOR = 4.2;
function smooth01(x: number): number {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
}

/** Half the field's square: the estimate is handed back to the DEM well inside it. */
export const HERC_FIELD_HALF_M = 1800;

/** Is x,z on the beach of 79 (between the water's edge and the cliff foot)? */
export function onBeach(h: HerculaneumExtras, x: number, z: number): boolean {
  const [t, n0] = frameInv(h.frame, x, z);
  const n = n0 - cliffN(t);
  return n > -BEACH_M && n < 0;
}

/** Distance from the cliff face, positive inland, measured on the cliff polyline. */
export function cliffDist(h: HerculaneumExtras, x: number, z: number): number {
  const q = nearestOn(h.cliff, x, z);
  return q.cross >= 0 ? -q.d : q.d;
}

// --- the layout the bake writes ------------------------------------------------------

export interface HercLayoutInput {
  frame: HercFrame;
  /** OSM's cardo and decumanus centrelines by name ("Cardo III Inferiore", "Decumano Massimo", ...). */
  osmStreets: Record<string, number[]>;
  /** Points OSM marks: the Sacred Area temple, Balbus's altar, the Neptune mosaic, the theatre. */
  temple: [number, number] | null;
  balbus: [number, number] | null;
  neptune: [number, number] | null;
  theatre: [number, number] | null;
  /** The Villa of the Papyri's outline. */
  villa: Ring | null;
}

export interface HercLayout {
  /** The town's ring: the bake's stand-in for Pompeii's wall circuit. */
  ring: Ring;
  streets: { name: string; main: boolean; carriageM: number; sidewalkM: number; inferred: boolean; pts: number[] }[];
  /** Kept out of the insulae: the terrace over the sheds, the theatre. */
  special: Ring[];
  theatre: Ring | null;
  extras: HerculaneumExtras;
  suburbs: PompeiiSuburbs;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Clip the line p + s*d (s in [s0, s1]) to a ring: the inside pieces' end parameters. */
function clipLine(ring: Ring, px: number, pz: number, dx: number, dz: number, s0: number, s1: number): [number, number][] {
  const out: [number, number][] = [];
  let a: number | null = null;
  for (let s = s0; s <= s1 + 0.5; s += 0.5) {
    const ins = s <= s1 && pointInRing(ring, px + dx * s, pz + dz * s);
    if (ins && a === null) a = s;
    if (!ins && a !== null) { if (s - 0.5 - a > 8) out.push([a, s - 0.5]); a = null; }
  }
  return out;
}

export function layoutHerculaneum(inp: HercLayoutInput): HercLayout {
  const f = inp.frame;
  const P = (t: number, n: number): [number, number] => frameFwd(f, t, n);
  // The town's extent (estimate): the excavated third, and the rest under
  // modern Ercolano as far as the theatre, about 20 ha in all.
  const ring = [[-110, TERRACE_DEPTH_M], [160, TERRACE_DEPTH_M], [160, 360], [-265, 360], [-265, 190]].flatMap(([t, n]) => P(t, n).map(r1));

  // --- streets ---
  // Each named street's line is OSM's, fitted in the frame (t for a cardo, n
  // for a decumanus); OSM maps only the excavated stretches, so each is
  // carried on across the town ring, the stretch past the excavation marked
  // inferred. Cardines I and II and the third decumanus are inferred
  // outright, on the spacing the excavated ones keep.
  const meanOf = (name: string, axis: 0 | 1): number | null => {
    const pts = Object.entries(inp.osmStreets).filter(([k]) => k.startsWith(name)).flatMap(([, v]) => v);
    if (pts.length < 4) return null;
    let s = 0;
    for (let i = 0; i < pts.length; i += 2) s += frameInv(f, pts[i], pts[i + 1])[axis];
    return s / (pts.length / 2);
  };
  // "Cardo I" would match "Cardo III" and "Cardo IV": the trailing space keeps them apart.
  const tIII = meanOf("Cardo III ", 0) ?? -56, tIV = meanOf("Cardo IV ", 0) ?? -8, tV = meanOf("Cardo V ", 0) ?? 40;
  const nInf = meanOf("Decumano Inferiore", 1) ?? 112, nMax = meanOf("Decumano Massimo", 1) ?? 203;
  const pitchT = (tV - tIII) / 2, pitchN = nMax - nInf;
  const streets: HercLayout["streets"] = [];
  /** The open excavation's reach along the streets. */
  const EXC_N = nMax + 12, EXC_T0 = tIII - pitchT * 1.1, EXC_T1 = 150;
  const seg = (name: string, main: boolean, carriageM: number, sidewalkM: number, inferred: boolean, a: [number, number], b: [number, number]): void => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 8) return;
    streets.push({ name, main, carriageM, sidewalkM, inferred, pts: [...a, ...b].map(r1) });
  };
  const cardo = (name: string, t: number, main: boolean, known: boolean): void => {
    const [ox, oz] = P(t, 0);
    const cw = main ? 4.2 : 3.6, sw = main ? 1.4 : 1.1;
    for (const [a, b] of clipLine(ring, ox, oz, f.tz, -f.tx, -50, 500)) {
      const cut = known ? Math.min(b, Math.max(a, EXC_N)) : a;
      seg(name, main, cw, sw, false, P(t, a), P(t, cut));
      seg(name, main, cw, sw, true, P(t, cut), P(t, b));
    }
  };
  const decumanus = (name: string, n: number, main: boolean, known: boolean, cw: number, sw: number): void => {
    const [ox, oz] = P(0, n);
    for (const [a, b] of clipLine(ring, ox, oz, f.tx, f.tz, -400, 400)) {
      if (!known) { seg(name, main, cw, sw, true, P(a, n), P(b, n)); continue; }
      const lo = Math.max(a, Math.min(b, EXC_T0)), hi = Math.max(lo, Math.min(b, EXC_T1));
      seg(name, main, cw, sw, true, P(a, n), P(lo, n));
      seg(name, main, cw, sw, false, P(lo, n), P(hi, n));
      seg(name, main, cw, sw, true, P(hi, n), P(b, n));
    }
  };
  cardo("Cardo III", tIII, false, true);
  cardo("Cardo IV", tIV, true, true);
  cardo("Cardo V", tV, true, true);
  cardo("Cardo II", tIII - pitchT, false, false);
  cardo("Cardo I", tIII - pitchT * 2, false, false);
  // The decumanus maximus was a broad paved square closed to wheels, the
  // town's forum in all but name: shops and the College of the Augustales
  // along it, the Basilica Noniana at its north-west end.
  decumanus("Decumano Massimo", nMax, true, true, 7.5, 2.2);
  decumanus("Decumano Inferiore", nInf, false, true, 3.6, 1.2);
  decumanus("Decumano Superiore", nMax + pitchN, false, false, 3.6, 1.2);
  // Every crossing as a vertex of both streets, on the quarter metre the
  // road graph matches nodes on, or the cart's graph is a heap of loose lines.
  const q4 = (v: number): number => Math.round(v * 4) / 4;
  for (const s of streets) for (let i = 0; i < s.pts.length; i++) s.pts[i] = q4(s.pts[i]);
  for (let a = 0; a < streets.length; a++) for (let b = a + 1; b < streets.length; b++) {
    const A = streets[a], B = streets[b];
    const [ax, az, bx, bz] = [A.pts[0], A.pts[1], A.pts[A.pts.length - 2], A.pts[A.pts.length - 1]];
    const [cx, cz, dx, dz] = [B.pts[0], B.pts[1], B.pts[B.pts.length - 2], B.pts[B.pts.length - 1]];
    const ex = bx - ax, ez = bz - az, fx = dx - cx, fz = dz - cz;
    const den = ex * fz - ez * fx;
    if (Math.abs(den) < 1e-6) continue;
    const u = ((cx - ax) * fz - (cz - az) * fx) / den, v = ((cx - ax) * ez - (cz - az) * ex) / den;
    if (u < -1e-3 || u > 1 + 1e-3 || v < -1e-3 || v > 1 + 1e-3) continue;
    const px = q4(ax + ex * u), pz = q4(az + ez * u);
    for (const S of [A, B]) {
      if (S.pts.some((_, k) => k % 2 === 0 && Math.hypot(S.pts[k] - px, S.pts[k + 1] - pz) < 0.3)) {
        // Already a vertex there (two pieces of one street meet at it): snap it exactly.
        for (let k = 0; k < S.pts.length; k += 2) if (Math.hypot(S.pts[k] - px, S.pts[k + 1] - pz) < 0.3) { S.pts[k] = px; S.pts[k + 1] = pz; }
        continue;
      }
      // Insert in order along the street (both are straight lines).
      const sx0 = S.pts[0], sz0 = S.pts[1];
      const d0 = Math.hypot(px - sx0, pz - sz0);
      let k = 2;
      while (k < S.pts.length && Math.hypot(S.pts[k] - sx0, S.pts[k + 1] - sz0) < d0) k += 2;
      S.pts.splice(k, 0, px, pz);
    }
  }

  // --- the sea front ---
  const L = { beach: 4.3, terrace: 12.8, slope: 0.045 };
  const cliff: number[] = [];
  for (let t = -420; t <= 420; t += 20) cliff.push(...P(t, cliffN(t)).map(r1));
  // Twelve sheds in the excavated face under the Sacred Area, each about 4 m
  // wide and 9 m deep (the published sizes); their spacing is read off the plan.
  const fornici: Fornix[] = [];
  const sx = -f.tz, sz = f.tx;
  for (let i = 0; i < 12; i++) {
    const [x, z] = P(-36 + i * 5.3, 0);
    fornici.push({ x: r1(x), z: r1(z), fx: sx, fz: sz, w: 4.1, d: 9.2, h: 5.3 });
  }
  const terrace = [[-48, 0], [52, 0], [52, 26], [-48, 26]].flatMap(([t, n]) => P(t, n).map(r1));
  const tp = inp.temple ? frameInv(f, inp.temple[0], inp.temple[1]) : [-6.5, 9];
  const onTerrace = (t: number, n: number): { x: number; z: number } => { const [x, z] = P(t, Math.min(10, n)); return { x: r1(x), z: r1(z) }; };
  const temples = [
    { name: "Tempio di Venere", ...onTerrace(tp[0], tp[1]), fx: sx, fz: sz },
    // Its neighbour, the temple of the Four Gods, is not in OSM: placed beside it.
    { name: "Tempio dei Quattro Dei", ...onTerrace(tp[0] - 13, tp[1]), fx: sx, fz: sz },
  ];
  const bal = inp.balbus ?? P(37, 19);
  const nep = inp.neptune ?? P(64, 85);

  // --- the Villa of the Papyri: its great peristyle and the long pool ---
  let papyri: HerculaneumExtras["papyri"] = { peristyle: [], pool: [], belvedere: { x: 0, z: 0 } };
  if (inp.villa) {
    const v = inp.villa, m = v.length / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < m; i++) { cx += v[i * 2]; cz += v[i * 2 + 1]; }
    cx /= m; cz /= m;
    let xx = 0, zz = 0, xz = 0;
    for (let i = 0; i < m; i++) { const dx = v[i * 2] - cx, dz = v[i * 2 + 1] - cz; xx += dx * dx; zz += dz * dz; xz += dx * dz; }
    const rot = 0.5 * Math.atan2(2 * xz, xx - zz);
    const ux = Math.cos(rot), uz = Math.sin(rot);
    let u0 = Infinity, u1 = -Infinity;
    for (let i = 0; i < m; i++) { const u = (v[i * 2] - cx) * ux + (v[i * 2 + 1] - cz) * uz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); }
    // Weber's survey of the 1750s tunnels puts the great peristyle, about
    // 100 by 37 m round a 66 m pool, at the villa's north-west end. OSM's
    // outline is narrower than that court, so the court here is cut down to
    // what fits inside it with walls round it (an estimate of its place).
    const Q = (u: number, w: number): number[] => [r1(cx + ux * u - uz * w), r1(cz + uz * u + ux * w)];
    const nwEnd = uz > 0 ? u0 : u1, dir = uz > 0 ? 1 : -1;
    const c = nwEnd + dir * (u1 - u0) * 0.3;
    const box = (hu: number, hw: number): number[] => [...Q(c - hu, -hw), ...Q(c + hu, -hw), ...Q(c + hu, hw), ...Q(c - hu, hw)];
    const [bxv, bzv] = Q(nwEnd + dir * 8, 0);
    papyri = { peristyle: box(Math.min(48, (u1 - u0) * 0.22), 10), pool: box(Math.min(33, (u1 - u0) * 0.15), 3.2), belvedere: { x: bxv, z: bzv } };
  }

  const extras: HerculaneumExtras = {
    frame: f, levels: L, cliff, fornici, victims: 300, terrace, temples,
    balbus: { x: r1(bal[0]), z: r1(bal[1]), fx: sx, fz: sz }, papyri,
    neptune: { x: r1(nep[0]), z: r1(nep[1]) }, trellis: "Casa a Graticcio",
  };

  // --- outside the town: the coast road, the eastern stream, boats, a few villas ---
  const shore: number[] = [];
  for (let t = -900; t <= 900; t += 30) shore.push(...P(t, cliffN(t) - BEACH_M).map(r1));
  // The stream east of the town (course and levels estimated): a ravine down
  // the slope to a mouth on the beach.
  const tS = 195;
  const rpts: number[] = [], level: number[] = [], halfW: number[] = [];
  for (const [n, lv, hw] of [[900, 40, 5], [600, 30, 5], [400, 22, 5.5], [250, 15, 6], [120, 9, 6.5], [40, 5.8, 7], [0, 4.4, 8], [-BEACH_M - 6, 0.3, 10]]) {
    rpts.push(...P(tS, n).map(r1)); level.push(lv); halfW.push(hw);
  }
  const roads: PompeiiSuburbs["roads"] = [];
  // The coast road between Neapolis and Pompeii, on the line of the
  // decumanus maximus through the town (an estimate).
  roads.push({ name: "Road to Neapolis", gate: "Decumano Massimo", pts: [...P(-265, nMax), ...P(-420, nMax + 30), ...P(-900, nMax + 120), ...P(-1600, nMax + 260)].map(r1), widthM: 5, pavedM: 200, tombM: 0 });
  roads.push({ name: "Road to Pompeii", gate: "Decumano Massimo", pts: [...P(160, nMax), ...P(320, nMax + 10), ...P(800, nMax + 60), ...P(1600, nMax + 140)].map(r1), widthM: 5, pavedM: 200, tombM: 0 });
  const [bx, bz] = P(tS, nMax + 14);
  const bridges = [{ x: r1(bx), z: r1(bz), rot: Math.atan2(f.tz, f.tx), len: 34, deckY: 23 }];
  // Hauled up on the beach in front of the sheds, bows to the land. One is
  // the 9 m boat found capsized on the beach in 1982.
  const boats: PompeiiSuburbs["boats"] = [];
  for (let k = 0; k < 7; k++) {
    const [x, z] = P(-60 + k * 17 + (k % 2) * 4, -9 - (k % 3) * 4);
    boats.push({ x: r1(x), z: r1(z), rot: Math.atan2(-f.tx, f.tz) + (k % 2 ? 0.2 : -0.15), len: k === 3 ? 9 : 5.5 + (k % 3), beached: true });
  }
  const buildings: PompeiiSuburbs["buildings"] = [];
  const add = (name: string, kind: PompeiiSuburbs["buildings"][number]["kind"], t: number, n: number, w: number, d: number): void => {
    const [x, z] = P(t, n);
    buildings.push({ name, kind, x: r1(x), z: r1(z), w, d, rot: Math.atan2(f.tz, f.tx), fx: sx, fz: sz, inferred: true });
  };
  // Seaside villas along the shore either side of the town, farms up the slope: all estimates.
  add("Villa marittima a levante", "villa", 330, 30, 46, 30);
  add("Villa marittima di ponente", "villa", -600, cliffN(-600) + 30, 40, 28);
  for (const [k, [t, n]] of [[-300, 520], [-80, 640], [120, 560], [380, 470], [560, 700], [-480, 780]].entries()) add(`Villa rustica ${k + 1}`, "farm", t, n, 34, 30);
  const suburbs: PompeiiSuburbs = { roads, tombs: [], buildings, shore, river: { pts: rpts, level, halfW }, quay: [], boats, bridges, cliff: true };

  let theatre: Ring | null = null;
  if (inp.theatre) {
    // Buried, and seen today only by tunnel; about 54 m across the cavea. A
    // square ring the theatre builder fits its bowl into.
    const [tx, tz] = inp.theatre, R = 27;
    theatre = [tx - R, tz - R, tx + R, tz - R, tx + R, tz + R, tx - R, tz + R].map(r1);
  }
  return { ring, streets, special: [terrace, ...(theatre ? [theatre] : [])], theatre, extras, suburbs };
}
