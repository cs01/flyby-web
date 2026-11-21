// The eruption of Vesuvius as seen from Pompeii, 24-25 August 79, as numbers.
//
// Sources: Pliny the Younger, Letters 6.16 and 6.20 (the column "about the
// seventh hour", the pine-tree shape, the darkness "like a closed room with
// the lamp out", the earthquakes, the sea drawn back); and the volcanology of
// Sigurdsson, Cashdollar and Sparks (1982), Sigurdsson et al. (1985) and
// Luongo et al. (2003): a Plinian column of about 15 km rising to 26 km in
// the white-pumice phase and 32 km in the grey, a fall at Pompeii of about
// 15 cm an hour that totals 2.5 to 3 m, roofs failing under the load, and
// the pyroclastic surges S1..S6 overnight and at dawn, S4 the first to enter
// the town.
//
// The clock is the town clock the app shows (Rome's local mean time, which is
// what the Europe/Rome zone gives for the year 79: UTC + 0:49:56), in hours
// from midnight on the day the column rose: 13.0 is 13:00 on the first day,
// 31.0 is 07:00 the next morning.
// Where the record gives a range, the middle of it is used and the range is
// what test/eruption.check.ts holds the numbers to.
//
// Pure (no THREE, no DOM): the gate drives it under Bun.

/** 0079-08-22 00:00 UTC, proleptic Gregorian: 24 August 79 in the Julian calendar (cities.ts). */
export const ERUPTION_DAY_UTC_MS = Date.parse("0079-08-22T00:00:00Z");

/**
 * UTC + 0:49:56: the offset the time bar and top bar display for Pompeii.
 * The town's own mean time is 8 minutes later; the story keeps to the clock the
 * player can see, or the card and the bar would disagree.
 */
export const POMPEII_LMT_OFFSET_H = 49 / 60 + 56 / 3600;

export function localHours(utcMs: number): number {
  return (utcMs - ERUPTION_DAY_UTC_MS) / 3.6e6 + POMPEII_LMT_OFFSET_H;
}

export function utcMsAt(h: number): number {
  return ERUPTION_DAY_UTC_MS + (h - POMPEII_LMT_OFFSET_H) * 3.6e6;
}

export const COLUMN_H = 13.0;
export const FALL_START_H = 13.5;
/** The fall reaches its steady rate half an hour after the first stones. */
const FALL_FULL_H = 14.0;
/** White pumice turns to grey as the column grows hotter and taller. */
export const GREY_H = 20.0;
const WHITE_RATE_CM_H = 15;
const GREY_RATE_CM_H = 17;

/** Roofs begin to give way under this much wet-free pumice (40-60 cm in the record). */
export const ROOF_FAIL_START_M = 0.45;
/** By this depth a sheltering family is under a roof that has failed. */
export const ROOF_LETHAL_M = 0.6;

/** Distance from the vent to the north wall of Pompeii, metres. */
export const VENT_TO_WALL_M = 9300;

export interface Surge {
  name: string;
  /** Local hour the front reaches `refM` from the vent. */
  atH: number;
  refM: number;
  /** Where the current stops, metres from the vent. */
  runoutM: number;
}

/**
 * The surges in order. S1-S3 stop short of Pompeii (S1 and S2 are the ones
 * that killed Herculaneum's shore); S4 enters the town; S5 and S6 run out
 * past it toward Stabiae. Front speed is a gameplay value at the low end of
 * the 25-100 km/h such currents reach on the plain.
 */
export const SURGES: Surge[] = [
  { name: "S1", atH: 25.0, refM: 7000, runoutM: 7300 },
  { name: "S2", atH: 26.0, refM: 7000, runoutM: 7600 },
  { name: "S3", atH: 30.5, refM: 8500, runoutM: 9000 },
  { name: "S4", atH: 31.0, refM: VENT_TO_WALL_M, runoutM: 11500 },
  { name: "S5", atH: 31.5, refM: VENT_TO_WALL_M, runoutM: 12000 },
  { name: "S6", atH: 32.0, refM: VENT_TO_WALL_M, runoutM: 13000 },
];
export const SURGE_SPEED_MS = 25;
/** The first surge to reach the town, the one the in-town ending waits for. */
export const S4 = SURGES[3];
/** After the last surge stops nothing more reaches the plain. */
export const SURGES_END_H = 32.5;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Exponential interpolation: light and visibility fall by ratios, not by steps. */
const elerp = (a: number, b: number, t: number) => a * Math.pow(b / a, clamp01(t));

/** Fall rate at Pompeii, cm per hour. */
export function fallRateCmH(h: number): number {
  if (h < FALL_START_H) return 0;
  if (h >= S4.atH) return 0;
  if (h < FALL_FULL_H) return WHITE_RATE_CM_H * (h - FALL_START_H) / (FALL_FULL_H - FALL_START_H);
  return h < GREY_H ? WHITE_RATE_CM_H : GREY_RATE_CM_H;
}

/** Pumice lying at Pompeii, metres: the closed-form integral of fallRateCmH. */
export function pumiceDepthM(h: number): number {
  let cm = 0;
  const ramp = FALL_FULL_H - FALL_START_H;
  if (h > FALL_START_H) {
    const t = Math.min(h, FALL_FULL_H) - FALL_START_H;
    cm += (WHITE_RATE_CM_H * t * t) / (2 * ramp);
  }
  if (h > FALL_FULL_H) cm += WHITE_RATE_CM_H * (Math.min(h, GREY_H) - FALL_FULL_H);
  if (h > GREY_H) cm += GREY_RATE_CM_H * (Math.min(h, S4.atH) - GREY_H);
  return cm / 100;
}

/** Height of the column's top, km. */
export function columnKm(h: number): number {
  if (h < COLUMN_H) return 0;
  if (h < 13.25) return 15 * smooth(COLUMN_H, 13.25, h);
  if (h < 17) return lerp(15, 26, (h - 13.25) / 3.75);
  if (h < GREY_H) return lerp(26, 32, (h - 17) / 3);
  // Unsteady overnight; the partial collapses that feed the surges pull it down.
  if (h < 30.5) return 32 + 1.5 * Math.sin(h * 2.3);
  if (h < 32) return lerp(32 + 1.5 * Math.sin(30.5 * 2.3), 21, (h - 30.5) / 1.5);
  return 21;
}

/**
 * Share of daylight reaching the streets, 0..1, on top of the sun's own
 * height: the umbrella cloud's shadow, then the fall itself. Never rises
 * through the afternoon; the faint grey at dawn is Pliny's "light, but dim".
 */
export function lightFactor(h: number): number {
  if (h < 13.1) return 1;
  if (h < 13.5) return lerp(1, 0.55, smooth(13.1, 13.5, h));
  if (h < 15.5) return elerp(0.55, 0.04, (h - 13.5) / 2);
  if (h < 17) return elerp(0.04, 0.02, (h - 15.5) / 1.5);
  if (h < 30) return 0.02;
  if (h < S4.atH) return lerp(0.02, 0.08, (h - 30) / (S4.atH - 30));
  // The surge cloud itself, then the slow clearing after S6.
  if (h < SURGES_END_H) return 0.01;
  return lerp(0.01, 0.05, clamp01((h - SURGES_END_H) / 2));
}

/** How far you can see through the fall, metres. */
export function visibilityM(h: number): number {
  if (h < FALL_START_H) return 40000;
  if (h < 14) return elerp(40000, 22000, (h - FALL_START_H) / 0.5);
  if (h < 15) return elerp(22000, 1500, h - 14);
  if (h < 16) return elerp(1500, 260, h - 15);
  if (h < 30) return 260;
  if (h < S4.atH) return lerp(260, 600, (h - 30) / (S4.atH - 30));
  if (h < SURGES_END_H) return 90;
  return 200;
}

/** Earthquake strength, 0..1: a background rising through the night, in bursts. */
export function quake(h: number): number {
  if (h < COLUMN_H) return 0;
  const base = h < GREY_H ? lerp(0.12, 0.25, (h - COLUMN_H) / (GREY_H - COLUMN_H)) : h < 30 ? lerp(0.25, 0.45, (h - GREY_H) / 10) : 0.7;
  // Bursts about every eleven minutes of eruption time, each a few minutes long.
  const b = Math.max(0, Math.sin(h * Math.PI * 2 * 5.3)) * Math.max(0, Math.sin(h * Math.PI * 2 * 1.7 + 1));
  return clamp01(base * (0.25 + 2.2 * b * b));
}

/** The front of the surge moving now (or most recently), metres from the vent; null when none has started. */
export function surgeFront(h: number): { surge: Surge; frontM: number; moving: boolean } | null {
  let out: { surge: Surge; frontM: number; moving: boolean } | null = null;
  for (const s of SURGES) {
    const t0 = s.atH - s.refM / SURGE_SPEED_MS / 3600;
    if (h < t0) break;
    const d = (h - t0) * 3600 * SURGE_SPEED_MS;
    out = { surge: s, frontM: Math.min(d, s.runoutM), moving: d < s.runoutM };
  }
  return out;
}

/** Furthest any surge has reached from the vent by hour h, metres. */
export function surgeReachM(h: number): number {
  let r = 0;
  for (const s of SURGES) {
    const t0 = s.atH - s.refM / SURGE_SPEED_MS / 3600;
    if (h < t0) break;
    r = Math.max(r, Math.min((h - t0) * 3600 * SURGE_SPEED_MS, s.runoutM));
  }
  return r;
}

/** 0..1: how readily roofs are failing at this depth of pumice. */
export function roofFailure(depthM: number): number {
  return smooth(ROOF_FAIL_START_M, 1.2, depthM);
}

export type EruptionPhase = "before" | "white" | "grey" | "surges" | "after";

export interface EruptionState {
  h: number;
  phase: EruptionPhase;
  columnKm: number;
  /** The umbrella spreads at about four fifths of the column's height. */
  umbrellaKm: number;
  /** How far downwind the umbrella has spread from the vent, km. */
  umbrellaReachKm: number;
  fallRateCmH: number;
  pumiceM: number;
  /** Colour of the pumice on top: 1 white, 0 grey. */
  whiteness: number;
  light: number;
  visibilityM: number;
  quake: number;
  roofFailure: number;
  surge: { name: string; frontM: number; moving: boolean } | null;
}

export function eruptionAt(h: number): EruptionState {
  const col = columnKm(h);
  const depth = pumiceDepthM(h);
  const sf = surgeFront(h);
  const phase: EruptionPhase =
    h < COLUMN_H ? "before" : h < GREY_H ? "white" : h < S3StartH() ? "grey" : h < SURGES_END_H ? "surges" : "after";
  return {
    h,
    phase,
    columnKm: col,
    umbrellaKm: col * 0.8,
    // About 90 km/h downwind at that height, capped at the 100+ km of the deposit's axis.
    umbrellaReachKm: h < COLUMN_H ? 0 : Math.min(120, 90 * (h - COLUMN_H)),
    fallRateCmH: fallRateCmH(h),
    pumiceM: depth,
    whiteness: 1 - smooth(GREY_H - 0.5, GREY_H + 0.5, h),
    light: lightFactor(h),
    visibilityM: visibilityM(h),
    quake: quake(h),
    roofFailure: roofFailure(depth),
    surge: sf && (sf.surge.atH >= S4.atH - 1 || sf.moving) ? { name: sf.surge.name, frontM: sf.frontM, moving: sf.moving } : null,
  };
}

function S3StartH(): number {
  return SURGES[2].atH - SURGES[2].refM / SURGE_SPEED_MS / 3600;
}

// --- Time compression ------------------------------------------------------

export type ClockMode = "story" | "real";

/**
 * Eruption seconds per real second. The afternoon, when the choices are made,
 * runs at 40x so a walk across town costs an hour or two of daylight; the
 * night, when nothing changes but the depth, at 120x; the dawn at 40x again so
 * the surge is something you see coming.
 */
export function clockRate(h: number, mode: ClockMode): number {
  if (mode === "real") return 1;
  if (h >= GREY_H && h < 30) return 120;
  return 40;
}

/** Real seconds the story clock takes from h0 to h1. */
export function realSecondsBetween(h0: number, h1: number, mode: ClockMode): number {
  let s = 0;
  const step = 1 / 60;
  for (let h = h0; h < h1; h += step) s += (Math.min(step, h1 - h) * 3600) / clockRate(h, mode);
  return s;
}

// --- The escape's outcome --------------------------------------------------

export type RouteKind = "south" | "east" | "north" | "shore" | "coast";

export interface Route {
  kind: RouteKind;
  /** Where the road goes: "Stabiae", "Nuceria". */
  toward: string;
  /** Metres from the vent at the gate. */
  gateDistM: number;
  /** Metres the distance from the vent grows per metre walked (negative: toward it). */
  radial: number;
  /** Metres of road to the refuge at its end. */
  roadM: number;
}

export interface EscapeRun {
  /** Hour the lamp was picked up; null when never. */
  lampH: number | null;
  /** Hour the player went through a gate and kept going, and the road. */
  exit: { route: Route; h: number } | null;
  /** First hour the player was sheltering indoors under a failing roof; null when never. */
  roofH: number | null;
}

export type Ending = "survived" | "road" | "town" | "roof" | "north" | "shore";

export interface Outcome {
  ending: Ending;
  /** Hour the run ended: the surge, the roof, or arrival in safety. */
  h: number;
  /** Metres from the vent when it ended. */
  distM: number;
  /** Whether the refuge at the end of the road was reached. */
  arrived: boolean;
}

/**
 * Walking pace on the road, metres per hour. Daylight walking is 4 km/h; in
 * the dark it is a lamp's worth (people tied pillows on their heads and
 * carried torches, Pliny writes) or a stumble without one; deep loose pumice
 * slows every step.
 */
export function roadSpeedMH(h: number, lamp: boolean): number {
  const lit = lightFactor(h) > 0.3;
  const base = lit ? 4000 : lamp ? 2400 : 900;
  return base / (1 + 0.8 * pumiceDepthM(h));
}

/** Where the run ends: stepped a minute at a time from the gate to the last surge. */
export function resolveEscape(run: EscapeRun, runout: (h: number) => number = surgeReachM): Outcome {
  if (run.roofH !== null) return { ending: "roof", h: run.roofH, distM: VENT_TO_WALL_M, arrived: false };
  const dt = 1 / 60;
  if (!run.exit) {
    // In the town the first surge through the walls is the end.
    let h = S4.atH - 1;
    while (h < SURGES_END_H && runout(h) < VENT_TO_WALL_M + 500) h += dt;
    return { ending: "town", h, distM: VENT_TO_WALL_M + 500, arrived: false };
  }
  const { route, h: h0 } = run.exit;
  let d = route.gateDistM, walked = 0, h = h0;
  let arrived = route.roadM <= 0;
  for (; h < SURGES_END_H; h += dt) {
    if (runout(h) >= d) {
      const ending: Ending = route.kind === "north" ? "north" : route.kind === "shore" ? "shore" : "road";
      return { ending, h, distM: d, arrived };
    }
    if (!arrived) {
      const lamp = run.lampH !== null && run.lampH <= h;
      const step = Math.min(roadSpeedMH(h, lamp) * dt, route.roadM - walked);
      walked += step;
      d += step * route.radial;
      if (walked >= route.roadM - 1e-6) arrived = true;
    }
  }
  return { ending: "survived", h, distM: d, arrived };
}
