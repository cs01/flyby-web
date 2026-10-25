// Trains and boats, placed: where every vehicle in a transit pack is at a time,
// from the live feeds where there is one and the timetable where there is not.
//
// Every vehicle is a point at arc length `s` on its pattern's shape.
//
//   LIVE TRAINS (MTA, BART). The feed is a list of predicted stop times, not a
//   position, so the train is interpolated: between the last stop it left and
//   the next it reaches, with a trapezoid speed profile (accelerate at
//   ACCEL, cruise, brake at ACCEL) that covers the gap in exactly the
//   predicted time. A linear interpolation glides through stations at speed
//   and never stops at them.
//   The MTA drops a stop from a trip once the train has left it, so the stop
//   before the first listed one is taken from the pattern, and the time it was
//   left is estimated from the distance at the line's mean running speed.
//
//   LIVE BOATS (NYC Ferry). The feed has GPS positions; each is projected onto
//   the trip's own route shape and carried forward along it at the reported
//   speed. The shapes are what keep a dead-reckoned ferry off the piers: a
//   straight-line prediction from a ferry turning out of a slip runs ashore.
//
//   SCHEDULED (CTA, SF Bay Ferry, Golden Gate Ferry, Staten Island Ferry, and
//   any live agency whose feed is unreachable). The baked timetable, run
//   through the same stop-to-stop profile.
//
// A new answer moves the prediction; the drawn vehicle does not jump, the
// difference is eased out the way data/livetraffic.ts eases an aircraft, at a
// rate capped so a train is never seen sliding.
//
// Pure: no THREE, no DOM, no clock. Time is epoch ms in and out.

import {
  activeServices,
  localTime,
  previousDay,
  sampleShape,
  Level,
  type PackPattern,
  type PackShape,
  type ShapeSample,
  type TransitPack,
} from "./transitpack";
import type { FeedMsg, TripUpdateMsg, VehiclePositionMsg } from "./gtfsrt";
import type { Origin } from "../geo";

/** Service acceleration and braking, m/s^2: R160 and BART both rate ~1.1. */
export const ACCEL = 1.0;
/** Mean speeds stop to stop, m/s, for estimating a dropped previous departure. */
const MEAN_SPEED: Record<string, number> = { subway: 9, rail: 17, ferry: 9 };
/** A train at its origin terminal shows this long before it leaves. */
const LAYOVER_S = 240;
/** And stays this long at the end of the line. */
const ARRIVED_S = 60;
/** The fastest the drawn vehicle is pulled toward a corrected prediction. */
export const MAX_CORRECTION_MS = 4;
const MIN_BLEND_S = 2;
/** A correction this big is a different train or a feed glitch: snap. */
const SNAP_M = 1500;
/** Dropped when no answer has listed it for this long. */
const STALE_S = 120;
/** A boat position is carried forward at most this long. */
const BOAT_HORIZON_S = 90;

export interface TimedStop {
  /** Index in pack.stops. */
  stop: number;
  s: number;
  /** Epoch seconds. */
  arr: number;
  dep: number;
}

/**
 * Arc length covered after `tau` seconds of a run of `D` metres that takes
 * `T` seconds from stand to stand: trapezoidal, or triangular when the run is
 * too short to reach cruise, or linear when the time is too short even for that
 * (a feed that predicts the impossible still gets a train that arrives on time).
 */
export function runS(D: number, T: number, tau: number, a = ACCEL): number {
  if (tau <= 0) return 0;
  if (tau >= T) return D;
  if (D <= 0) return 0;
  const disc = a * a * T * T - 4 * a * D;
  if (disc < 0) return (D * tau) / T;
  const v = (a * T - Math.sqrt(disc)) / 2;
  const ta = v / a;
  if (tau < ta) return 0.5 * a * tau * tau;
  if (tau > T - ta) {
    const r = T - tau;
    return D - 0.5 * a * r * r;
  }
  return 0.5 * a * ta * ta + v * (tau - ta);
}

/**
 * Where on its timeline a vehicle is at epoch seconds `t`: its arc length and
 * the index of the next stop, or null before it appears and after it is gone.
 */
export function timelineS(tl: TimedStop[], t: number): { s: number; next: number; speed: number } | null {
  if (!tl.length) return null;
  const first = tl[0];
  if (t < first.dep) return t >= first.dep - LAYOVER_S ? { s: first.s, next: 0, speed: 0 } : null;
  const last = tl[tl.length - 1];
  if (t >= last.arr) return t <= last.arr + ARRIVED_S ? { s: last.s, next: tl.length - 1, speed: 0 } : null;
  for (let i = 0; i + 1 < tl.length; i++) {
    const a = tl[i];
    const b = tl[i + 1];
    if (t < a.dep) return { s: a.s, next: i, speed: 0 };
    if (t < b.arr) {
      const D = b.s - a.s;
      const T = Math.max(1, b.arr - a.dep);
      const s = a.s + runS(D, T, t - a.dep);
      const s2 = a.s + runS(D, T, t + 0.5 - a.dep);
      return { s, next: i + 1, speed: (s2 - s) * 2 };
    }
  }
  return { s: last.s, next: tl.length - 1, speed: 0 };
}

// --- vehicles ----------------------------------------------------------------

export interface Vehicle {
  key: string;
  agency: number;
  pattern: number;
  route: number;
  /** Arc length drawn this frame. */
  s: number;
  /** m/s along the shape, for wakes and the card. */
  speed: number;
  live: boolean;
  headsign: string;
  timeline: TimedStop[];
  /** Index into timeline of the next stop. */
  next: number;
  /** Boats only: the measured position the prediction runs from. */
  fix: { s: number; t: number; speed: number } | null;
  /** Eased correction, metres of s, and its ease. */
  off: number;
  offT: number;
  blendS: number;
  /** Epoch ms an answer last listed it. */
  seen: number;
}

/**
 * The stop list a live trip update gives, matched to a baked pattern: the one
 * of the trip's route (any route of the agency when the feed gives none, as
 * BART's does not) that contains the most of the trip's remaining stops, in
 * order, ending where the trip ends.
 */
export function matchPattern(pack: TransitPack, agency: number, routeId: string, stopIds: string[], byStop: Map<string, number>): number {
  const want = stopIds.map((id) => byStop.get(`${agency}:${id}`)).filter((x): x is number => x !== undefined);
  if (want.length < 1) return -1;
  const lastStop = want[want.length - 1];
  let best = -1;
  let bestScore = -1;
  let bestLen = Infinity;
  pack.patterns.forEach((p, pi) => {
    const r = pack.routes[p.route];
    if (r.agency !== agency) return;
    if (routeId && r.id !== routeId && r.id !== routeId.replace(/X$/, "")) return;
    let k = 0;
    let hit = 0;
    for (const st of want) {
      const j = p.stops.indexOf(st, k);
      if (j >= 0) {
        hit++;
        k = j + 1;
      }
    }
    const endsRight = p.stops.lastIndexOf(lastStop) >= 0 ? 1 : 0;
    const score = hit * 2 + endsRight;
    if (score > bestScore || (score === bestScore && p.stops.length < bestLen)) {
      best = pi;
      bestScore = score;
      bestLen = p.stops.length;
    }
  });
  return bestScore >= Math.min(3, want.length * 2) ? best : -1;
}

/**
 * A trip update's stops onto its pattern: times from the feed, arc lengths
 * from the pattern, and the dropped previous stop put back.
 */
export function liveTimeline(p: PackPattern, tu: TripUpdateMsg, agency: number, byStop: Map<string, number>, meanSpeed: number): TimedStop[] {
  const tl: TimedStop[] = [];
  let k = 0;
  for (const u of tu.stops) {
    if (u.rel === 1) continue; // skipped
    const si = byStop.get(`${agency}:${u.stopId}`);
    if (si === undefined) continue;
    const j = p.stops.indexOf(si, k);
    if (j < 0) continue;
    const arr = u.arrival ?? u.departure;
    const dep = u.departure ?? u.arrival;
    if (arr === null || dep === null) continue;
    // A stop the feed lists at the same second as arrival and departure is a
    // pass-through prediction; give it the dwell real trains take, out of
    // the run before it, so the train is seen standing at the platform.
    tl.push({ stop: si, s: p.ss[j], arr, dep: Math.max(dep, arr) });
    k = j + 1;
  }
  if (!tl.length) return tl;
  const firstIdx = p.stops.indexOf(tl[0].stop);
  if (firstIdx > 0) {
    const prevS = p.ss[firstIdx - 1];
    const D = tl[0].s - prevS;
    const t = tl[0].arr - Math.max(30, D / meanSpeed);
    tl.unshift({ stop: p.stops[firstIdx - 1], s: prevS, arr: t - 20, dep: t });
  }
  for (let i = 1; i < tl.length; i++) {
    const a = tl[i - 1];
    const b = tl[i];
    if (b.arr === b.dep && b.arr - a.dep > 60) b.arr -= Math.min(20, (b.arr - a.dep) * 0.15);
    if (b.s < a.s) b.s = a.s;
  }
  return tl;
}

/** A scheduled trip's timeline on a service day starting at epoch second `day0`. */
export function scheduledTimeline(p: PackPattern, trip: number, day0: number): TimedStop[] {
  const start = p.trips[trip * 3 + 1];
  const tm = p.timings[p.trips[trip * 3 + 2]];
  const tl: TimedStop[] = [];
  for (let i = 0; i < p.stops.length; i++) {
    tl.push({ stop: p.stops[i], s: p.ss[i], arr: day0 + start + tm[i * 2], dep: day0 + start + tm[i * 2 + 1] });
  }
  return tl;
}

/**
 * Epoch seconds of local midnight on yyyymmdd `date` in `tz`. GTFS times are
 * seconds after "noon minus 12 h", which is local midnight except on the two
 * DST days, where an hour off for one night is accepted.
 */
export function serviceDayStart(date: number, tz: string): number {
  const y = Math.floor(date / 10000), m = Math.floor(date / 100) % 100, d = date % 100;
  const noonUtc = Date.UTC(y, m - 1, d, 12) / 1000;
  const lt = localTime(noonUtc * 1000, tz);
  return noonUtc - lt.sec + (lt.date !== date ? (lt.date > date ? -86400 : 86400) : 0);
}

export interface TransitOptions {
  /** Which agencies are being fed live right now; the rest run on the timetable. */
  liveAgencies?: Set<number>;
}

export class TransitModel {
  readonly vehicles = new Map<string, Vehicle>();
  /** "agency:stopId" to pack.stops index. */
  readonly byStop = new Map<string, number>();
  /** "agency:tripId" to [pattern, trip]. */
  private byTrip = new Map<string, [number, number]>();
  /** Agencies currently driven by a feed, so their timetable is not drawn too. */
  liveAgencies = new Set<number>();
  private schedAt = -Infinity;
  private boatArrivals: FeedMsg | null = null;
  private schedList: { pattern: number; trip: number; day0: number }[] = [];
  private tmp: ShapeSample = { x: 0, z: 0, dx: 0, dz: 0, lvl: 0, run: 0, seg: 0, u: 0 };

  constructor(readonly pack: TransitPack, readonly origin: Origin) {
    pack.stops.forEach((s, i) => this.byStop.set(`${s.agency}:${s.id}`, i));
    pack.patterns.forEach((p, pi) => {
      const a = pack.routes[p.route].agency;
      p.tripIds?.forEach((id, k) => this.byTrip.set(`${a}:${id}`, [pi, k]));
    });
  }

  agencyIndex(live: string): number {
    return this.pack.agencies.findIndex((a) => a.live === live);
  }

  private upsert(key: string, agency: number, pattern: number, tl: TimedStop[], live: boolean, now: number, fix: Vehicle["fix"] = null): void {
    const p = this.pack.patterns[pattern];
    const v = this.vehicles.get(key);
    const pred = this.predict({ timeline: tl, fix, agency } as Vehicle, now / 1000);
    if (!v) {
      this.vehicles.set(key, {
        key, agency, pattern, route: p.route, s: pred?.s ?? (tl[0]?.s ?? 0), speed: 0, live, headsign: headsignOf(this.pack, p, tl),
        timeline: tl, next: pred?.next ?? 0, fix, off: 0, offT: now, blendS: MIN_BLEND_S, seen: now,
      });
      return;
    }
    const sameShape = this.pack.patterns[v.pattern].shape === p.shape;
    const seenS = v.s;
    v.pattern = pattern;
    v.route = p.route;
    v.timeline = tl;
    v.fix = fix;
    v.live = live;
    v.headsign = headsignOf(this.pack, p, tl);
    v.seen = now;
    const d = pred ? seenS - pred.s : 0;
    if (!sameShape || !pred || Math.abs(d) > SNAP_M) {
      v.off = 0;
      v.blendS = MIN_BLEND_S;
    } else {
      v.off = d;
      // Smoothstep peaks at 1.5x its mean slope; stretched so the peak is the cap.
      v.blendS = Math.max(MIN_BLEND_S, (1.5 * Math.abs(d)) / MAX_CORRECTION_MS);
    }
    v.offT = now;
  }

  private predict(v: Pick<Vehicle, "timeline" | "fix" | "agency">, t: number): { s: number; next: number; speed: number } | null {
    if (v.fix) {
      const tau = Math.max(0, Math.min(BOAT_HORIZON_S, t - v.fix.t));
      let s = v.fix.s + v.fix.speed * tau;
      // Never past the next landing: a ferry slowing into a slip is still
      // reporting cruise speed in the last fix before it.
      let next = v.timeline.findIndex((x) => x.s > v.fix!.s + 5);
      if (next >= 0) s = Math.min(s, v.timeline[next].s);
      else next = v.timeline.length - 1;
      return { s, next: Math.max(0, next), speed: v.fix.speed };
    }
    return timelineS(v.timeline, t);
  }

  /** Feeds a decoded answer from one of an agency's feeds, received at local epoch ms `now`. */
  ingest(live: "mta" | "bart" | "nycferry", msg: FeedMsg, now: number): number {
    const agency = this.agencyIndex(live);
    if (agency < 0) return 0;
    this.liveAgencies.add(agency);
    const meanSpeed = MEAN_SPEED[this.pack.agencies[agency].kind] ?? 9;
    let n = 0;
    if (live === "nycferry") {
      // Positions and arrivals are two feeds; the latest arrivals are kept
      // for the positions that come after them.
      if (msg.tripUpdates.length) this.boatArrivals = msg;
      for (const vp of msg.vehicles) if (this.ingestBoat(agency, vp, this.boatArrivals, now)) n++;
      return n;
    }
    for (const tu of msg.tripUpdates) {
      if (tu.stops.length === 0) continue;
      const pi = matchPattern(this.pack, agency, tu.trip.routeId, tu.stops.map((s) => s.stopId), this.byStop);
      if (pi < 0) continue;
      const tl = liveTimeline(this.pack.patterns[pi], tu, agency, this.byStop, meanSpeed);
      if (tl.length < 2) continue;
      this.upsert(`${agency}:${tu.trip.tripId}`, agency, pi, tl, true, now);
      n++;
    }
    return n;
  }

  private ingestBoat(agency: number, vp: VehiclePositionMsg, arrivals: FeedMsg | null, now: number): boolean {
    if (vp.lat === null || vp.lon === null || !vp.trip) return false;
    const hit = this.byTrip.get(`${agency}:${vp.trip.tripId}`);
    if (!hit) return false;
    const [pi, trip] = hit;
    const p = this.pack.patterns[pi];
    const sh = this.pack.shapes[p.shape];
    const w = this.origin.toWorld(vp.lat, vp.lon);
    const s = projectOnShape(sh, w.x, w.z);
    if (s === null) return false;
    // The timetable's own stop times, for the card, on today's service day.
    const lt = localTime(now, this.pack.tz);
    const tl = scheduledTimeline(p, trip, serviceDayStart(lt.date, this.pack.tz));
    // Arrivals the trip-update feed predicts replace the timetable's.
    const tu = arrivals?.tripUpdates.find((u) => u.trip.tripId === vp.trip!.tripId);
    if (tu) {
      for (const u of tu.stops) {
        const si = this.byStop.get(`${agency}:${u.stopId}`);
        const e = tl.find((x) => x.stop === si);
        if (e && (u.arrival ?? u.departure)) {
          e.arr = (u.arrival ?? u.departure)!;
          e.dep = Math.max(e.arr, u.departure ?? e.arr);
        }
      }
    }
    const fixT = vp.timestamp ?? now / 1000;
    const moving = vp.status !== 1 && (vp.speed ?? 0) > 0.5;
    this.upsert(`${agency}:${vp.vehicleId || vp.trip.tripId}`, agency, pi, tl, true, now, { s, t: fixT, speed: moving ? vp.speed! : 0 });
    return true;
  }

  /** Rebuilds the list of timetabled trips near `t`; cheap enough every few seconds. */
  private scheduled(tMs: number): void {
    const pack = this.pack;
    const lt = localTime(tMs, pack.tz);
    const t = tMs / 1000;
    const days: { date: number; dow: number }[] = [{ date: lt.date, dow: lt.dow }, previousDay(lt.date, lt.dow)];
    this.schedList.length = 0;
    for (const d of days) {
      const on = activeServices(pack, d.date, d.dow);
      const day0 = serviceDayStart(d.date, pack.tz);
      pack.patterns.forEach((p, pi) => {
        if (this.liveAgencies.has(pack.routes[p.route].agency)) return;
        const tm = p.timings;
        for (let k = 0; k < p.trips.length / 3; k++) {
          if (!on.has(p.trips[k * 3])) continue;
          const start = day0 + p.trips[k * 3 + 1];
          const span = tm[p.trips[k * 3 + 2]];
          const end = start + span[span.length - 1];
          if (t < start - LAYOVER_S - 30 || t > end + ARRIVED_S + 30) continue;
          this.schedList.push({ pattern: pi, trip: k, day0 });
        }
      });
    }
  }

  /** Moves everything to local epoch ms `now`. */
  step(now: number): void {
    if (Math.abs(now - this.schedAt) > 5000) {
      this.schedAt = now;
      this.scheduled(now);
      const keep = new Set<string>();
      for (const e of this.schedList) {
        const key = `sched:${e.pattern}:${e.trip}:${e.day0}`;
        keep.add(key);
        if (!this.vehicles.has(key)) {
          const p = this.pack.patterns[e.pattern];
          this.upsert(key, this.pack.routes[p.route].agency, e.pattern, scheduledTimeline(p, e.trip, e.day0), false, now);
        } else this.vehicles.get(key)!.seen = now;
      }
      for (const k of this.vehicles.keys()) if (k.startsWith("sched:") && !keep.has(k)) this.vehicles.delete(k);
    }
    const t = now / 1000;
    for (const [k, v] of this.vehicles) {
      const pr = this.predict(v, t);
      if (!pr || (v.live && now - v.seen > STALE_S * 1000) || (!v.live && this.liveAgencies.has(v.agency))) {
        this.vehicles.delete(k);
        continue;
      }
      const u = Math.min(1, Math.max(0, (now - v.offT) / 1000 / v.blendS));
      const keepOff = 1 - u * u * (3 - 2 * u);
      v.s = pr.s + v.off * keepOff;
      v.speed = pr.speed;
      v.next = pr.next;
    }
  }

  /** Point and direction of arc length `s` on a vehicle's shape, or null outside the pack. */
  sample(v: Vehicle, s: number, out: ShapeSample = this.tmp): ShapeSample | null {
    return sampleShape(this.pack.shapes[this.pack.patterns[v.pattern].shape], s, out);
  }
}

function headsignOf(pack: TransitPack, p: PackPattern, tl: TimedStop[]): string {
  if (p.headsign) return p.headsign;
  const last = tl.length ? tl[tl.length - 1].stop : p.stops[p.stops.length - 1];
  return pack.stops[last]?.name ?? "";
}

/** Nearest arc length on a shape to a world point, within 300 m, else null. */
export function projectOnShape(sh: PackShape, x: number, z: number): number | null {
  let best = 300;
  let bestS: number | null = null;
  for (const run of sh.runs) {
    for (let i = 0; i + 1 < run.s.length; i++) {
      const ax = run.pts[i * 2], az = run.pts[i * 2 + 1], bx = run.pts[i * 2 + 2], bz = run.pts[i * 2 + 3];
      const vx = bx - ax, vz = bz - az;
      const L2 = vx * vx + vz * vz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2));
      const d = Math.hypot(ax + vx * u - x, az + vz * u - z);
      if (d < best) {
        best = d;
        bestS = run.s[i] + u * (run.s[i + 1] - run.s[i]);
      }
    }
  }
  return bestS;
}

// --- the vertical ----------------------------------------------------------------

/** Below the street this far, the top of a car is under the pavement. */
export const TUNNEL_DEPTH_M = 12;
/** Steepest a portal or el ramp climbs: NYC subway grades top out near 3.5%. */
export const RAMP_GRADE = 0.035;
/** Car roof above top of rail. */
export const CAR_HEIGHT_M = 3.7;

/**
 * Top-of-rail height at every point of every run of a shape, metres AMSL.
 *
 * Grade track sits on the terrain; tunnel is TUNNEL_DEPTH_M under it; elevated
 * is `elevatedM` over it, or on a landmark bridge's own surveyed deck where
 * `deckAt` says so. Grade and deck are FIXED: everything else ramps at
 * RAMP_GRADE to meet them, so a portal is a ramp down from the street and the
 * Manhattan Bridge's approach viaduct climbs from Canal Street to the 39 m
 * deck end instead of stepping 30 m at the anchorage.
 */
export function trackHeights(
  sh: PackShape,
  groundAt: (x: number, z: number) => number,
  elevatedM: number,
  deckAt: (x: number, z: number) => number | null,
): Float32Array[] {
  return sh.runs.map((run) => {
    const n = run.s.length;
    const y = new Float32Array(n);
    const g = new Float32Array(n);
    const fixed = new Uint8Array(n);
    const deck = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = run.pts[i * 2], z = run.pts[i * 2 + 1];
      g[i] = groundAt(x, z);
      const lv = run.lvl[i];
      const d = lv === Level.Elevated ? deckAt(x, z) : null;
      if (d !== null) deck[i] = 1;
      fixed[i] = lv === Level.Grade || d !== null ? 1 : 0;
      y[i] = lv === Level.Tunnel ? g[i] - TUNNEL_DEPTH_M : lv === Level.Elevated ? (d ?? g[i] + elevatedM) : g[i];
    }
    // Within RAMP_GRADE of every fixed point, both ways.
    const lo = new Float32Array(n).fill(-Infinity);
    const hi = new Float32Array(n).fill(Infinity);
    for (let pass = 0; pass < 2; pass++) {
      let l = -Infinity, h = Infinity;
      for (let k = 0; k < n; k++) {
        const i = pass === 0 ? k : n - 1 - k;
        const prev = pass === 0 ? i - 1 : i + 1;
        if (prev >= 0 && prev < n) {
          const ds = Math.abs(run.s[i] - run.s[prev]);
          l -= RAMP_GRADE * ds;
          h += RAMP_GRADE * ds;
        }
        if (fixed[i]) {
          l = y[i];
          h = y[i];
        }
        lo[i] = Math.max(lo[i], l);
        hi[i] = Math.min(hi[i], h);
      }
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      y[i] = Math.min(hi[i], Math.max(lo[i], y[i]));
      if (run.lvl[i] === Level.Tunnel) y[i] = Math.min(y[i], g[i]);
    }
    // A tunnel meeting an el with no grade between: the tunnel rises to the
    // street and the el comes down to it.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < n; k++) {
        const i = pass === 0 ? k : n - 1 - k;
        const j = pass === 0 ? i - 1 : i + 1;
        if (j < 0 || j >= n || run.lvl[i] !== Level.Tunnel) continue;
        const ds = Math.abs(run.s[i] - run.s[j]);
        const ref = run.lvl[j] === Level.Tunnel ? y[j] : Math.min(y[j], g[j]);
        y[i] = Math.min(g[i], Math.max(y[i], ref - RAMP_GRADE * ds));
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < n; k++) {
        const i = pass === 0 ? k : n - 1 - k;
        const j = pass === 0 ? i - 1 : i + 1;
        if (j < 0 || j >= n || run.lvl[i] !== Level.Elevated || deck[i]) continue;
        const ds = Math.abs(run.s[i] - run.s[j]);
        y[i] = Math.min(y[i], Math.max(y[j], g[j]) + RAMP_GRADE * ds);
      }
    }
    return y;
  });
}

/** Height on a run at a sample, by the same linear rule the shape uses for x/z. */
export function heightAtSample(heights: Float32Array[], smp: ShapeSample): number {
  const y = heights[smp.run];
  const a = y[smp.seg];
  const b = y[Math.min(y.length - 1, smp.seg + 1)];
  return a + (b - a) * smp.u;
}

/** Whether a car whose rail is at `railY` is wholly below the ground at `groundY`. */
export function carUnderground(railY: number, groundY: number): boolean {
  return railY + CAR_HEIGHT_M < groundY - 0.3;
}

// --- consists and hulls ------------------------------------------------------------

export interface Rolling {
  /** Car length over couplers, metres; a boat's length overall. */
  len: number;
  width: number;
  cars: number;
}

/** What a route runs: car length and count, from the agencies' fleet sheets. */
export function rollingFor(agency: string, routeId: string): Rolling {
  if (agency === "mta") {
    // A Division (numbered lines) runs 51 ft cars ten to a train; B Division
    // 60 ft cars, ten to a 600 ft train, fewer where the platforms are short.
    if (/^(\d|\dX|GS)$/.test(routeId)) return { len: 15.6, width: 2.67, cars: routeId === "GS" ? 6 : 10 };
    const cars: Record<string, number> = { G: 5, L: 8, J: 8, Z: 8, M: 8, FS: 2, H: 4 };
    return { len: 18.4, width: 3.05, cars: cars[routeId] ?? 10 };
  }
  if (agency === "bart") return { len: 21.3, width: 3.2, cars: 8 };
  if (agency === "cta") {
    const cars: Record<string, number> = { Red: 8, Blue: 8, Brn: 8, P: 8, G: 6, Org: 6, Pink: 6, Y: 2 };
    return { len: 14.6, width: 2.84, cars: cars[routeId] ?? 6 };
  }
  // Hulls: the Staten Island Ferry's Ollis class is 94 m; NYC Ferry's
  // 150-seat boats 26 m; the Bay Ferry's and Golden Gate's 40 and 50 m.
  if (agency === "siferry") return { len: 94, width: 21, cars: 1 };
  if (agency === "nycferry") return { len: 26, width: 8.5, cars: 1 };
  if (agency === "sfbayferry") return { len: 40, width: 10, cars: 1 };
  return { len: 50, width: 11, cars: 1 };
}

export interface CarPose {
  x: number;
  y: number;
  z: number;
  /** Radians about +y, the three.js yaw that turns a -z nose onto the track. */
  yaw: number;
  pitch: number;
  hidden: boolean;
}

const smpA: ShapeSample = { x: 0, z: 0, dx: 0, dz: 0, lvl: 0, run: 0, seg: 0, u: 0 };
const smpB: ShapeSample = { x: 0, z: 0, dx: 0, dz: 0, lvl: 0, run: 0, seg: 0, u: 0 };

/**
 * Car `i` (0 at the head) of a train whose head is at arc length `s`, its
 * trucks at 0.35 of a car either side of its centre so it chords a curve the
 * way a real car does. Null where any of it is outside the pack.
 */
export function carPose(
  sh: PackShape,
  heights: Float32Array[],
  s: number,
  i: number,
  car: Rolling,
  groundAt: (x: number, z: number) => number,
  out: CarPose,
): CarPose | null {
  const c = s - (i + 0.5) * car.len;
  const a = sampleShape(sh, c + car.len * 0.35, smpA);
  const b = a && sampleShape(sh, c - car.len * 0.35, smpB);
  if (!a || !b) return null;
  const ya = heightAtSample(heights, a);
  const yb = heightAtSample(heights, b);
  const dx = a.x - b.x, dz = a.z - b.z;
  const h = Math.hypot(dx, dz) || 1;
  out.x = (a.x + b.x) / 2;
  out.z = (a.z + b.z) / 2;
  out.y = (ya + yb) / 2;
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(ya - yb, h);
  out.hidden = carUnderground(Math.max(ya, yb), groundAt(out.x, out.z));
  return out;
}

/** A hull on the water at the head's arc length: bow forward, on the surface. */
export function boatPose(sh: PackShape, s: number, boat: Rolling, waterY: number, out: CarPose): CarPose | null {
  // The centre half a length behind the shape point, so the BOW is where the
  // timetable says the boat is: berthed bow-in rather than half on the slip.
  const a = sampleShape(sh, s, smpA);
  const b = a && sampleShape(sh, Math.max(0, s - boat.len), smpB);
  if (!a) return null;
  const dx = b ? a.x - b.x : a.dx, dz = b ? a.z - b.z : a.dz;
  const L = Math.hypot(dx, dz) || 1;
  out.x = a.x - (dx / L) * boat.len * 0.5;
  out.z = a.z - (dz / L) * boat.len * 0.5;
  out.y = waterY;
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = 0;
  out.hidden = false;
  return out;
}
