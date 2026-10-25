// Real aircraft, from ADS-B, moving smoothly through the scene.
//
// The feed is /planes/api/planes on the same host: adsb.fi or adsb.lol slimmed
// to ~20 fields per aircraft. The server answers each 0.05 degree cell from a
// cache that upstream refills about ONCE A MINUTE (FRESH_MS in
// ~/git/digitalocean/planes/app/app.milo; measured 2026-10-24: four polls 6 s
// apart all carried the same `now`, and the oldest `seen` in the cell was
// 53 s). So between answers there is up to a minute of nothing, and every
// aircraft is drawn from a PREDICTION:
//
//   1. Dead reckoning from the report: the position at report time, carried
//      along the current turn at the reported ground speed and vertical rate.
//      The turn rate comes from the change in track between two reports.
//   2. When a new report lands, the prediction jumps to wherever the aircraft
//      really is. The drawn aircraft does not: the difference is kept as an
//      OFFSET and eased to zero, over a time set by how big it is, so the
//      correction never moves the aircraft faster than MAX_CORRECTION_MS on top
//      of its own motion. A fixed 2 s ease turned a 1 km turn-prediction miss
//      into a 500 m/s slide; capping the rate is what keeps it looking flown.
//
// Pure TypeScript: no three.js, no DOM, no clock. Time comes in as an argument
// in epoch milliseconds so test/livetraffic.check.ts can drive it.

import { Origin } from "../geo";

export const FT = 0.3048;
export const KT = 0.514444;
export const FPM = FT / 60;
const D2R = Math.PI / 180;
const G = 9.81;

/** One aircraft as the server slims it. Nullable fields are absent upstream. */
export interface PlaneReport {
  hex: string;
  flight: string;
  reg: string;
  type: string;
  desc: string;
  cat: string;
  lat: number;
  lon: number;
  /** Feet: geometric (ellipsoid) when the transponder sends it, else baro. */
  alt: number | null;
  baro: number | null;
  qnh: number | null;
  gs: number | null;
  track: number | null;
  vr: number | null;
  /** Seconds between the position and `now`. */
  seen: number | null;
  sq?: string;
  ground: boolean;
  /** The server's dbFlags military bit. */
  mil?: boolean;
}

export interface PlaneFeed {
  ac: PlaneReport[];
  /** Server epoch ms when upstream answered. */
  now: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Validates and normalises a feed body. Returns null for anything that is not one. */
export function parseFeed(body: unknown): PlaneFeed | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { ac?: unknown; now?: unknown };
  const now = num(b.now);
  if (!Array.isArray(b.ac) || now === null) return null;
  const ac: PlaneReport[] = [];
  for (const raw of b.ac) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const lat = num(r.lat);
    const lon = num(r.lon);
    const hex = str(r.hex);
    if (lat === null || lon === null || !hex) continue;
    ac.push({
      hex,
      flight: str(r.flight),
      reg: str(r.reg),
      type: str(r.type),
      desc: str(r.desc),
      cat: str(r.cat),
      lat,
      lon,
      alt: num(r.alt),
      baro: num(r.baro),
      qnh: num(r.qnh),
      gs: num(r.gs),
      track: num(r.track),
      vr: num(r.vr),
      seen: num(r.seen),
      sq: str(r.sq),
      ground: r.ground === true,
      mil: r.mil === true,
    });
  }
  return { ac, now };
}

// --- altitude ---------------------------------------------------------------

/**
 * Geoid height (ellipsoid minus mean sea level), metres, for turning ADS-B
 * geometric altitude into the scene's AMSL. Coarse on purpose: it only matters
 * at cruise, because below ALT_BARO_BELOW_FT the baro path is used instead.
 * -30 m across the contiguous US is within ~20 m of EGM96 everywhere a listed
 * US city is (New York -33, San Francisco -32, Chicago -34); 0 elsewhere is
 * wrong by up to 100 m (south India), which at 35,000 ft is a pixel.
 */
export function geoidM(lat: number, lon: number): number {
  return lat > 24 && lat < 50 && lon > -125 && lon < -66 ? -30 : 0;
}

/**
 * Below this the drawn height is pressure altitude corrected to the local QNH,
 * which is what puts an aircraft on its runway: the field elevation a pilot
 * reads on the ground IS baro + QNH correction. Above ALT_GEOM_ABOVE_FT the
 * geometric height wins (QNH is not set at cruise), and between the two they
 * are mixed linearly so nothing steps.
 */
const ALT_BARO_BELOW_FT = 10000;
const ALT_GEOM_ABOVE_FT = 14000;
/** Feet of altitude per hPa of QNH near sea level (the ICAO 27.3 ft/hPa). */
const FT_PER_HPA = 27.3;

/**
 * The area's QNH, from the altimeter settings the aircraft themselves report.
 * Median, because one aircraft that has not yet reset from 1013 on descent is
 * a common outlier. Null when nobody reports one.
 */
export function feedQnh(ac: PlaneReport[]): number | null {
  const v = ac
    .map((a) => a.qnh)
    .filter((q): q is number => q !== null && q > 940 && q < 1070)
    .sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
}

/** Height above mean sea level, metres, or null when the report has none. */
export function altitudeAmslM(r: PlaneReport, qnh: number | null, geoid: number): number | null {
  const geom = r.alt !== null && r.baro !== null && r.alt !== r.baro ? r.alt : null;
  const baroCorr = r.baro !== null && qnh !== null ? r.baro + (qnh - 1013.25) * FT_PER_HPA : null;
  const geomMsl = geom !== null ? geom - geoid / FT : null;
  let ft: number | null;
  if (baroCorr === null) ft = geomMsl ?? r.alt ?? r.baro;
  else if (geomMsl === null) ft = baroCorr;
  else {
    const t = Math.min(1, Math.max(0, (baroCorr - ALT_BARO_BELOW_FT) / (ALT_GEOM_ABOVE_FT - ALT_BARO_BELOW_FT)));
    ft = baroCorr + (geomMsl - baroCorr) * t;
  }
  return ft === null ? null : ft * FT;
}

// --- dead reckoning ---------------------------------------------------------

/** Longest a prediction is carried forward before the aircraft is held. */
export const HORIZON_S = 120;
/**
 * A turn is assumed to keep going for this long and then stop. Real turns in
 * terminal airspace are 20 to 60 s; carrying a turn rate measured a minute ago
 * for the whole minute flew aircraft in circles.
 */
const TURN_HOLD_S = 30;
/** Vertical rate is carried this long: climbs and descents level off. */
const CLIMB_HOLD_S = 40;
/** Standard-rate turn is 3 deg/s; anything faster is a track glitch. */
const MAX_TURN_DPS = 3.5;
/**
 * Taxiing aircraft turn onto taxiways every few hundred metres and their turns
 * are invisible to a minute-spaced feed, so a ground prediction runs only this
 * long before the aircraft waits for the next report.
 */
const GROUND_HORIZON_S = 20;

export interface Kinematics {
  /** World metres at the report instant. */
  x: number;
  y: number;
  z: number;
  /** Epoch ms of the position. */
  t: number;
  trackDeg: number;
  gsMs: number;
  vrMs: number;
  turnDps: number;
  ground: boolean;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
}

/** The predicted pose `k` reaches at epoch ms `t`. */
export function deadReckon(k: Kinematics, t: number, out: Pose): Pose {
  const tau = Math.max(0, Math.min((t - k.t) / 1000, k.ground ? GROUND_HORIZON_S : HORIZON_S));
  const v = k.gsMs;
  const turnS = Math.min(tau, TURN_HOLD_S);
  const w = k.ground ? 0 : k.turnDps * D2R;
  const p0 = k.trackDeg * D2R;
  let east: number;
  let north: number;
  if (Math.abs(w) < 1e-5) {
    east = v * tau * Math.sin(p0);
    north = v * tau * Math.cos(p0);
  } else {
    // Arc for the turning part, then straight along the exit heading.
    const p1 = p0 + w * turnS;
    east = (v / w) * (Math.cos(p0) - Math.cos(p1));
    north = (v / w) * (Math.sin(p1) - Math.sin(p0));
    const rest = tau - turnS;
    east += v * rest * Math.sin(p1);
    north += v * rest * Math.cos(p1);
  }
  out.x = k.x + east;
  out.z = k.z - north;
  out.y = k.y + k.vrMs * Math.min(tau, CLIMB_HOLD_S);
  const turning = tau < TURN_HOLD_S && !k.ground;
  out.headingDeg = wrap360(k.trackDeg + (k.ground ? 0 : k.turnDps * turnS));
  out.bankDeg = turning ? clamp((Math.atan((v * w) / G) * 180) / Math.PI, -30, 30) : 0;
  const climbing = tau < CLIMB_HOLD_S && !k.ground;
  out.pitchDeg = climbing ? clamp((Math.atan2(k.vrMs, Math.max(v, 30)) * 180) / Math.PI, -6, 15) + 2 : k.ground ? 0 : 2;
  return out;
}

// --- tracks -------------------------------------------------------------------

/**
 * The fastest the drawn aircraft may be pulled toward a corrected prediction,
 * on top of its own motion. 60 m/s is a quarter of a jet's approach speed,
 * which reads as the aircraft having been a little further along, not as a
 * slide. Taxiing aircraft get 6 m/s, about walking pace on a 15 kn taxi.
 */
export const MAX_CORRECTION_MS = 60;
export const MAX_CORRECTION_GROUND_MS = 6;
/** The shortest ease, for small corrections. */
export const MIN_BLEND_S = 2;
/** A correction this big is a different aircraft or a feed glitch: snap. */
const SNAP_M = 15000;
/** Not listed in any answer for this long and it is gone. */
export const STALE_S = 60;

export interface TrackInfo {
  hex: string;
  flight: string;
  reg: string;
  type: string;
  desc: string;
  cat: string;
  /** Feet above mean sea level, for the tag. */
  altFt: number | null;
  gsKt: number | null;
  vrFpm: number | null;
  ground: boolean;
  mil: boolean;
}

export class Track {
  info: TrackInfo;
  k: Kinematics;
  /** The pose drawn this frame. */
  readonly pose: Pose = { x: 0, y: 0, z: 0, headingDeg: 0, pitchDeg: 0, bankDeg: 0 };
  /** Correction still being eased out, and the ease it started with. */
  private off = { x: 0, y: 0, z: 0, h: 0, p: 0, b: 0 };
  private offT = 0;
  private blendS = MIN_BLEND_S;
  private dr: Pose = { x: 0, y: 0, z: 0, headingDeg: 0, pitchDeg: 0, bankDeg: 0 };
  /** Local epoch ms of the last answer that listed this aircraft. */
  lastListed: number;
  /** Ground under the aircraft, metres AMSL, refreshed by step(). */
  groundY = 0;

  constructor(info: TrackInfo, k: Kinematics, now: number) {
    this.info = info;
    this.k = k;
    this.lastListed = now;
    deadReckon(k, now, this.pose);
  }

  /** Swap in a new report at local time `now`, keeping the drawn pose where it was. */
  correct(info: TrackInfo, k: Kinematics, now: number): void {
    // The pose drawn right now, offset and all, is where the eye last saw it.
    const seen = { ...this.pose };
    this.info = info;
    this.k = k;
    deadReckon(k, now, this.dr);
    const ox = seen.x - this.dr.x;
    const oy = seen.y - this.dr.y;
    const oz = seen.z - this.dr.z;
    const dist = Math.hypot(ox, oy, oz);
    if (dist > SNAP_M) {
      this.off = { x: 0, y: 0, z: 0, h: 0, p: 0, b: 0 };
      this.blendS = MIN_BLEND_S;
    } else {
      this.off = {
        x: ox, y: oy, z: oz,
        h: wrap180(seen.headingDeg - this.dr.headingDeg),
        p: seen.pitchDeg - this.dr.pitchDeg,
        b: seen.bankDeg - this.dr.bankDeg,
      };
      // Smoothstep's steepest slope is 1.5x its mean, so the ease is stretched
      // by 1.5 to keep the PEAK correction speed under the cap.
      const cap = k.ground ? MAX_CORRECTION_GROUND_MS : MAX_CORRECTION_MS;
      this.blendS = Math.max(MIN_BLEND_S, (1.5 * dist) / cap);
    }
    this.offT = now;
  }

  /** Where it is drawn at `now`. */
  step(now: number): Pose {
    deadReckon(this.k, now, this.dr);
    const u = Math.min(1, Math.max(0, (now - this.offT) / 1000 / this.blendS));
    const keep = 1 - u * u * (3 - 2 * u);
    const p = this.pose;
    p.x = this.dr.x + this.off.x * keep;
    p.y = this.dr.y + this.off.y * keep;
    p.z = this.dr.z + this.off.z * keep;
    p.headingDeg = wrap360(this.dr.headingDeg + this.off.h * keep);
    p.pitchDeg = this.dr.pitchDeg + this.off.p * keep;
    p.bankDeg = this.dr.bankDeg + this.off.b * keep;
    return p;
  }

  /** Seconds the current correction has left to run. Zero once settled. */
  blendLeft(now: number): number {
    return Math.max(0, this.blendS - (now - this.offT) / 1000);
  }
}

export interface LiveTrafficOptions {
  /** Terrain height under a world point, metres AMSL. */
  groundAt?: (x: number, z: number) => number;
}

/**
 * Every aircraft the feed has listed, keyed by ICAO hex.
 *
 * `ingest` takes an answer; `step` moves everything to a time. Both take time
 * as epoch ms on the LOCAL clock. A local clock running behind the server
 * would put every report in the future and freeze the traffic, so the largest
 * amount by which an answer's `now` has led the local clock is kept and added
 * back. A clock running ahead cannot be detected from the feed and is caught
 * by HORIZON_S instead.
 */
export class LiveTraffic {
  readonly tracks = new Map<string, Track>();
  private lastNow = -1;
  private skewMs = 0;
  private groundAt: (x: number, z: number) => number;

  constructor(readonly origin: Origin, opts: LiveTrafficOptions = {}) {
    this.groundAt = opts.groundAt ?? (() => 0);
  }

  /** Adds an answer. Returns how many aircraft it brought in or corrected. */
  ingest(feed: PlaneFeed, localNow: number): number {
    this.skewMs = Math.max(this.skewMs, feed.now - localNow);
    const now = localNow + this.skewMs;
    for (const r of feed.ac) {
      const t = this.tracks.get(r.hex);
      if (t) t.lastListed = now;
    }
    // A cached answer re-served carries the same `now` and nothing new.
    if (feed.now === this.lastNow) return 0;
    this.lastNow = feed.now;

    const qnh = feedQnh(feed.ac);
    const geoid = geoidM(this.origin.lat, this.origin.lon);
    let n = 0;
    for (const r of feed.ac) {
      const k = this.kinematics(r, feed.now, qnh, geoid);
      if (!k) continue;
      const info: TrackInfo = {
        hex: r.hex,
        flight: r.flight,
        reg: r.reg,
        type: r.type,
        desc: r.desc,
        cat: r.cat,
        // The QNH-corrected height, which is what the pilot's altimeter reads
        // below transition. Raw pressure altitude read -400 ft for a 737 on
        // short final at LGA on a 1033 hPa day.
        altFt: r.ground ? 0 : Math.round(k.y / FT),
        gsKt: r.gs,
        vrFpm: r.vr,
        ground: r.ground,
        mil: r.mil === true,
      };
      const prev = this.tracks.get(r.hex);
      // A parked aircraft reports no track. Keep the heading it last moved on
      // rather than swinging every one at the gates to face north.
      if (r.track === null && prev) k.trackDeg = prev.k.trackDeg;
      if (prev) {
        if (k.t <= prev.k.t) continue; // the same position, re-reported
        k.turnDps = turnRate(prev.k, k);
        prev.correct(info, k, now);
      } else {
        this.tracks.set(r.hex, new Track(info, k, now));
      }
      n++;
    }
    return n;
  }

  private kinematics(r: PlaneReport, feedNow: number, qnh: number | null, geoid: number): Kinematics | null {
    const w = this.origin.toWorld(r.lat, r.lon);
    const g = this.groundAt(w.x, w.z);
    let y: number;
    if (r.ground) y = g;
    else {
      const a = altitudeAmslM(r, qnh, geoid);
      if (a === null) return null;
      // Never below the terrain: a few metres of QNH error on short final
      // would otherwise put the wheels through the runway.
      y = Math.max(a, g);
    }
    return {
      x: w.x,
      y,
      z: w.z,
      t: feedNow - (r.seen ?? 0) * 1000,
      trackDeg: r.track ?? 0,
      gsMs: (r.gs ?? 0) * KT,
      vrMs: r.ground ? 0 : (r.vr ?? 0) * FPM,
      turnDps: 0,
      ground: r.ground,
    };
  }

  /** Moves every track to local epoch ms `localNow` and drops the stale ones. */
  step(localNow: number): void {
    const now = localNow + this.skewMs;
    for (const [hex, t] of this.tracks) {
      if (now - t.lastListed > STALE_S * 1000) {
        this.tracks.delete(hex);
        continue;
      }
      const p = t.step(now);
      t.groundY = this.groundAt(p.x, p.z);
      // Held on or above the ground through any blend, so a landing's last
      // correction cannot dip the aircraft into the runway.
      if (p.y < t.groundY || t.k.ground) {
        if (t.k.ground && t.blendLeft(now) === 0) p.y = t.groundY;
        else p.y = Math.max(p.y, t.groundY);
      }
    }
  }
}

/** Track change between two reports, deg/s, clamped to a plausible turn. */
export function turnRate(a: Kinematics, b: Kinematics): number {
  const dt = (b.t - a.t) / 1000;
  if (dt < 1 || dt > 90 || a.ground || b.ground || b.gsMs < 25) return 0;
  return clamp(wrap180(b.trackDeg - a.trackDeg) / dt, -MAX_TURN_DPS, MAX_TURN_DPS);
}

/** World pose back to lat/lon/feet, for the round-trip check and the card. */
export function worldToGeo(o: Origin, x: number, y: number, z: number): { lat: number; lon: number; altFt: number } {
  const ll = o.toLatLon(x, z);
  return { lat: ll.lat, lon: ll.lon, altFt: y / FT };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function wrap360(d: number): number {
  return ((d % 360) + 360) % 360;
}
function wrap180(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

// --- routes -------------------------------------------------------------------

export interface RouteEnd {
  city: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface Route {
  from: RouteEnd;
  to: RouteEnd;
  airline: string;
}

/** A /planes/api/route body, or null for `{}` and anything malformed. */
export function parseRoute(body: unknown): Route | null {
  const b = body as { from?: Partial<RouteEnd>; to?: Partial<RouteEnd>; airline?: unknown } | null;
  const end = (e: Partial<RouteEnd> | undefined): RouteEnd | null =>
    e && typeof e.code === "string" && num(e.lat) !== null && num(e.lon) !== null
      ? { city: str(e.city), code: e.code, name: str(e.name), lat: e.lat!, lon: e.lon! }
      : null;
  const from = end(b?.from);
  const to = end(b?.to);
  return from && to ? { from, to, airline: str(b?.airline) } : null;
}

/**
 * Whether an aircraft at lat/lon could be flying `r`.
 *
 * adsbdb's routes are keyed by callsign and go stale when an airline reuses a
 * flight number: on 2026-10-24 DAL964 over New Jersey came back as San Jose to
 * Atlanta. A tag saying so is worse than no route, so the route is shown only
 * if the aircraft is within 150 km of either end or of the great circle
 * between them, and not past either end of it.
 */
export function routePlausible(r: Route, lat: number, lon: number): boolean {
  const R = 6371000;
  const toV = (la: number, lo: number) => {
    const a = la * D2R, b = lo * D2R;
    return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
  };
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const A = toV(r.from.lat, r.from.lon), B = toV(r.to.lat, r.to.lon), P = toV(lat, lon);
  const ang = (u: number[], v: number[]) => Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  const NEAR = 150000;
  if (ang(A, P) * R < NEAR || ang(B, P) * R < NEAR) return true;
  const n = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl < 1e-9) return false;
  const cross = Math.abs(Math.asin(dot(n, P) / nl)) * R;
  // Along the path: the point's distance to each end must not exceed the
  // route's own length, or it is beyond one end.
  const len = ang(A, B);
  return cross < NEAR && ang(A, P) < len + 0.01 && ang(B, P) < len + 0.01;
}
