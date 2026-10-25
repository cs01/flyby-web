// The baked transit pack: what tools/bake-transit.ts writes to
// public/transit/<city>.json and the app reads back.
//
// Static GTFS is the timetable and the track; GTFS-realtime only says when a
// trip reaches which stop. Placing a train needs the line it runs on and where
// each stop sits along it, so that much of the static feed is baked into the
// app, clipped to the city, and never fetched from the agency at runtime.
//
// LAYOUT. Shapes are polylines in world metres, quantised to QUANT and delta
// coded, cut into RUNS where they leave the clip circle: a shape keeps its
// full-length arc coordinate `s` (each run carries its starting s), so a stop
// 30 km out at the end of the line still has an s and a train between it and
// the city interpolates correctly. Patterns are distinct (route, shape, stop
// list) tuples; their trips share one of a few timing variants and carry only
// a service, a start time and the variant.
//
// Pure: no THREE, no DOM, no fetch.

export const QUANT = 0.25;

/** Vertical class of a stretch of track. */
export const Level = { Tunnel: 0, Grade: 1, Elevated: 2 } as const;

export type TransitKind = "subway" | "rail" | "ferry";

export interface PackAgency {
  id: string;
  name: string;
  kind: TransitKind;
  /** Which live adapter drives it, or "" for the timetable alone. */
  live: "" | "mta" | "bart" | "nycferry";
  /** Top-of-rail height of its elevated structure above the ground, metres. */
  elevatedM: number;
}

export interface PackRoute {
  agency: number;
  id: string;
  short: string;
  long: string;
  color: string;
  text: string;
}

export interface PackStop {
  agency: number;
  id: string;
  name: string;
  x: number;
  z: number;
}

export interface PackRun {
  s0: number;
  /** Flat x,z pairs in world metres, decoded. */
  pts: Float32Array;
  /** Arc length at every point. */
  s: Float32Array;
  /** Level per point. */
  lvl: Uint8Array;
}

export interface PackShape {
  len: number;
  runs: PackRun[];
}

export interface PackPattern {
  route: number;
  shape: number;
  headsign: string;
  stops: number[];
  /** Arc length of each stop along the shape. */
  ss: number[];
  /** Timing variants: [arr0, dep0, arr1, dep1, ...] seconds after the first departure. */
  timings: number[][];
  /** Flat [service, startSec, variant] triples. */
  trips: number[];
  /** Agency trip ids for each trip, for feeds that report positions by trip. */
  tripIds?: string[];
}

export interface PackService {
  agency: number;
  id: string;
  /** Bit 0 Monday .. bit 6 Sunday. */
  days: number;
  from: number;
  to: number;
  add: number[];
  remove: number[];
}

export interface TransitPack {
  city: string;
  tz: string;
  agencies: PackAgency[];
  routes: PackRoute[];
  stops: PackStop[];
  shapes: PackShape[];
  patterns: PackPattern[];
  services: PackService[];
  /** Elevated track OSM maps, for drawing the structure: flat x,z per way. */
  structures: Float32Array[];
}

/** What the JSON holds before decoding. */
export interface RawPack {
  v: 1;
  city: string;
  tz: string;
  q: number;
  agencies: PackAgency[];
  routes: [number, string, string, string, string, string][];
  stops: [number, string, string, number, number][];
  shapes: { len: number; runs: [number, number[], number[]][] }[];
  patterns: {
    r: number; sh: number; hs: string; st: number[]; ss: number[]; tm: number[][]; tr: number[]; tid?: string[];
  }[];
  services: [number, string, number, number, number, number[], number[]][];
  structures: number[][];
}

/** Running sum: the baked timings are successive differences. */
function undiff(d: number[]): number[] {
  const out = new Array<number>(d.length);
  let acc = 0;
  for (let i = 0; i < d.length; i++) out[i] = acc += d[i];
  return out;
}

/** Delta-decodes a quantised x,z list. */
export function undelta(d: number[], q: number): Float32Array {
  const out = new Float32Array(d.length);
  let x = 0;
  let z = 0;
  for (let i = 0; i < d.length; i += 2) {
    x += d[i];
    z += d[i + 1];
    out[i] = x * q;
    out[i + 1] = z * q;
  }
  return out;
}

/** Delta-encodes x,z pairs already on the QUANT grid. */
export function delta(pts: number[], q: number): number[] {
  const out: number[] = [];
  let px = 0;
  let pz = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const x = Math.round(pts[i] / q);
    const z = Math.round(pts[i + 1] / q);
    out.push(x - px, z - pz);
    px = x;
    pz = z;
  }
  return out;
}

/** Run-length levels: [count, level, count, level...] to one byte a point. */
export function unrle(r: number[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < r.length; i += 2) for (let j = 0; j < r[i] && k < n; j++) out[k++] = r[i + 1];
  return out;
}

export function rle(lv: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < lv.length; ) {
    let j = i;
    while (j < lv.length && lv[j] === lv[i]) j++;
    out.push(j - i, lv[i]);
    i = j;
  }
  return out;
}

export function parseTransitPack(raw: RawPack): TransitPack {
  if (raw.v !== 1) throw new Error(`transit pack v${String(raw.v)}`);
  const q = raw.q;
  return {
    city: raw.city,
    tz: raw.tz,
    agencies: raw.agencies,
    routes: raw.routes.map(([agency, id, short, long, color, text]) => ({ agency, id, short, long, color, text })),
    stops: raw.stops.map(([agency, id, name, x, z]) => ({ agency, id, name, x: x * q, z: z * q })),
    shapes: raw.shapes.map((sh) => ({
      len: sh.len,
      runs: sh.runs.map(([s0, d, lv]) => {
        const pts = undelta(d, q);
        const n = pts.length / 2;
        const s = new Float32Array(n);
        s[0] = s0;
        for (let i = 1; i < n; i++) {
          s[i] = s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
        }
        return { s0, pts, s, lvl: unrle(lv, n) };
      }),
    })),
    patterns: raw.patterns.map((p) => ({
      route: p.r, shape: p.sh, headsign: p.hs, stops: p.st, ss: p.ss, timings: p.tm.map(undiff), trips: p.tr, tripIds: p.tid,
    })),
    services: raw.services.map(([agency, id, days, from, to, add, remove]) => ({ agency, id, days, from, to, add, remove })),
    structures: raw.structures.map((d) => undelta(d, q)),
  };
}

// --- sampling a shape --------------------------------------------------------

export interface ShapeSample {
  x: number;
  z: number;
  /** Unit direction of travel, world x/z. */
  dx: number;
  dz: number;
  lvl: number;
  /** Index of the run and segment, for the height lookup. */
  run: number;
  seg: number;
  u: number;
}

/** The point at arc length `s`, or null where the shape is outside the clip. */
export function sampleShape(sh: PackShape, s: number, out: ShapeSample): ShapeSample | null {
  for (let r = 0; r < sh.runs.length; r++) {
    const run = sh.runs[r];
    const n = run.s.length;
    if (s < run.s[0] || s > run.s[n - 1]) continue;
    // Binary search for the segment.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (run.s[mid] <= s) lo = mid;
      else hi = mid;
    }
    const segLen = run.s[hi] - run.s[lo];
    const u = segLen > 1e-6 ? (s - run.s[lo]) / segLen : 0;
    const ax = run.pts[lo * 2], az = run.pts[lo * 2 + 1];
    const bx = run.pts[hi * 2], bz = run.pts[hi * 2 + 1];
    out.x = ax + (bx - ax) * u;
    out.z = az + (bz - az) * u;
    const l = Math.hypot(bx - ax, bz - az) || 1;
    out.dx = (bx - ax) / l;
    out.dz = (bz - az) / l;
    out.lvl = u < 0.5 ? run.lvl[lo] : run.lvl[hi];
    out.run = r;
    out.seg = lo;
    out.u = u;
    return out;
  }
  return null;
}

// --- service calendar ---------------------------------------------------------

export interface LocalTime {
  /** yyyymmdd of the local calendar date. */
  date: number;
  /** 0 Monday .. 6 Sunday. */
  dow: number;
  /** Seconds since local midnight. */
  sec: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock date and time in `tz` at epoch ms `t`. */
export function localTime(t: number, tz: string): LocalTime {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  return {
    date: Number(p.year) * 10000 + Number(p.month) * 100 + Number(p.day),
    dow,
    sec: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

/** The local date before `d` (yyyymmdd), and its weekday. */
export function previousDay(d: number, dow: number): { date: number; dow: number } {
  const y = Math.floor(d / 10000), m = Math.floor(d / 100) % 100, day = d % 100;
  const prev = new Date(Date.UTC(y, m - 1, day - 1));
  return {
    date: prev.getUTCFullYear() * 10000 + (prev.getUTCMonth() + 1) * 100 + prev.getUTCDate(),
    dow: (dow + 6) % 7,
  };
}

/**
 * Which services run on a date, per agency.
 *
 * A baked calendar goes stale: the MTA's ran to 2026-10-31 and the CTA's to
 * 2026-11-30 when this was written. Past the end, an agency with nothing in
 * date would show an empty city, so its services are matched by weekday alone,
 * which is what the next calendar almost always repeats.
 */
export function activeServices(pack: TransitPack, date: number, dow: number): Set<number> {
  const on = new Set<number>();
  const agencyHas = new Set<number>();
  const bit = 1 << dow;
  pack.services.forEach((s, i) => {
    if (s.remove.includes(date)) return;
    if (s.add.includes(date) || ((s.days & bit) !== 0 && date >= s.from && date <= s.to)) {
      on.add(i);
      agencyHas.add(s.agency);
    }
  });
  pack.services.forEach((s, i) => {
    if (!agencyHas.has(s.agency) && (s.days & bit) !== 0) on.add(i);
  });
  return on;
}
