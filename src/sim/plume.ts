// The eruption column as plume physics: how wide, how fast and how far the
// cloud over Vesuvius is at a given height and age, from the column height
// the timeline in sim/eruption.ts gives. The volume renderer
// (render/eruptionvolume.ts) evaluates the same functions in GLSL, generated
// from the constants here so the two cannot drift.
//
// Sources: Morton, Taylor and Turner (1956) for the entraining plume and its
// overshoot; Wilson and Walker (1987) and Sparks et al. (1997, "Volcanic
// Plumes") for height against mass flux, the gas-thrust region and exit
// speeds; Woods and Kienle (1994) and Suzuki and Koyaguchi (2009) for the
// umbrella spreading as a gravity current, R ~ t^(2/3), and its stall upwind.
//
// Pure (no THREE, no DOM): test/eruption.check.ts drives it under Bun.

/** Wilson and Walker (1987): H km = 0.236 Q^(1/4), Q the mass eruption rate in kg/s. */
export const WW_K = 0.236;
/** Top-hat entrainment coefficient of a buoyant plume (MTT; 0.09 to 0.12 measured, the top of the range for a hot, particle-laden column). */
export const ENTRAIN_ALPHA = 0.12;
/** Radius growth per metre of height for a plume entraining at ENTRAIN_ALPHA: 6/5 alpha. */
export const SPREAD = 1.2 * ENTRAIN_ALPHA;
/** Neutral buoyancy level as a share of the top: MTT's overshoot puts the top at about 1.3 times it. */
export const NBL_FRACTION = 0.77;
/** Brunt-Vaisala frequency of the troposphere and lower stratosphere, 1/s. */
export const N_BV = 0.02;
/** Gravity-current shape factor of the umbrella (Suzuki and Koyaguchi 2009). */
export const LAMBDA_U = 0.2;
/**
 * Volume flux into the umbrella, q = C Q^(3/4) N^(-5/4), m^3/s. C is set so
 * Pinatubo (Q 1.6e9 kg/s) spreads to about 230 km radius in three hours, as the
 * satellite images measured it.
 */
export const UMBRELLA_C = 50;
/** Wind at the umbrella's height, m/s, toward the south-east: 90 km/h, the deposit's axis. */
export const WIND_UMBRELLA_MS = 25;
/** Exit speed of the jet at the vent, m/s (Plinian vents run 150 to 400). */
export const EXIT_SPEED_MS = 260;
/** Rise speed scale of the buoyant column at the top of the gas-thrust region, m/s. */
export const BUOYANT_W_MS = 125;
/** The widest the umbrella spreads either side of its axis, m. */
export const UMBRELLA_MAX_HALF_M = 45000;
/** Downwind lean of the column top, as a share of its height (a strong column bends little in a 25 m/s wind). */
export const LEAN = 0.1;
/** Top of the gas-thrust region above the vent, as a share of the column height. */
export const GAS_THRUST_FRACTION = 0.1;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Mass eruption rate for a column `km` high, kg/s. */
export function massFluxKgS(km: number): number {
  return km <= 0 ? 0 : Math.pow(km / WW_K, 4);
}

/** Column height for a mass eruption rate, km: the inverse of massFluxKgS. */
export function heightKmForFlux(q: number): number {
  return WW_K * Math.pow(Math.max(0, q), 0.25);
}

/** Vent radius, m: the bulk mixture (about 5 kg/m^3 at 3 wt% gas) leaving at EXIT_SPEED_MS. */
export function ventRadiusM(q: number): number {
  return Math.max(60, Math.sqrt(q / (Math.PI * 5 * EXIT_SPEED_MS)));
}

/**
 * An overpressured jet decompresses to the air's pressure within a few vent
 * diameters and widens as it does (Woods and Bower 1995): the column's
 * effective source is about this many vent radii across.
 */
export const DECOMPRESSION = 3;

export interface PlumeShape {
  /** Column top above the vent, m. */
  topM: number;
  /** Below the height its flux would hold it at: the head is still climbing. */
  rising: boolean;
  /** Neutral buoyancy level above the vent, m: where the umbrella spreads. */
  nblM: number;
  /** Mass eruption rate, kg/s. */
  qKgS: number;
  /** The column's source radius once the jet has decompressed, m. */
  ventRM: number;
  /** Top of the gas-thrust region above the vent, m. */
  jetM: number;
  /** Umbrella radius in still air at this age, m. */
  spreadM: number;
  /** How far upwind of the vent the umbrella stands, m. */
  upwindM: number;
  /** How far downwind it has been carried, m. */
  reachM: number;
  /** Umbrella thickness over the vent, m. */
  thickM: number;
  /** Gravity-current constant c in R = c t^(2/3). */
  c: number;
}

/** Gravity-current constant c of R = c t^(2/3) for a column fed at q kg/s. */
export function spreadConst(q: number): number {
  const qv = UMBRELLA_C * Math.pow(q, 0.75) * Math.pow(N_BV, -1.25);
  return Math.cbrt((3 * LAMBDA_U * N_BV * qv) / (2 * Math.PI));
}

/** Umbrella radius in still air t seconds after it began to spread, m. */
export function umbrellaRadiusM(tSec: number, q: number): number {
  return tSec <= 0 ? 0 : spreadConst(q) * Math.pow(tSec, 2 / 3);
}

/**
 * Where the upwind front stalls: the front slows as dR/dt = (2/3) c^(3/2) R^(-1/2)
 * and stops once that is the wind's speed.
 */
export function upwindStallM(q: number, windMs = WIND_UMBRELLA_MS): number {
  const c = spreadConst(q);
  return Math.pow((2 / 3) * Math.pow(c, 1.5) / windMs, 2);
}

/**
 * Half-width of the umbrella `xM` downwind of the vent, m: the gravity current
 * keeps spreading sideways while the wind carries it, for the time the wind
 * took to bring it there; never wider than it could spread in its own age.
 */
export function umbrellaHalfWidthM(xM: number, s: PlumeShape): number {
  const tau = Math.max(0, xM + s.upwindM) / WIND_UMBRELLA_MS;
  return Math.min(s.spreadM, s.c * Math.pow(tau, 2 / 3), UMBRELLA_MAX_HALF_M) + 0.5 * columnRadiusM(s.nblM, s);
}

/** Radius of the column at height z above the vent, m: entrainment from the vent up. */
export function columnRadiusM(z: number, s: Pick<PlumeShape, "ventRM">): number {
  return s.ventRM + SPREAD * Math.max(0, z);
}

/**
 * Where the column stops hiding the sky, as a multiple of the top-hat radius.
 * The concentration falls off as a Gaussian exp(-2 r^2 / b^2) and at 1.4 b is
 * still 2% of the axis; a column whose axis takes kilometres of tephra-laden
 * air per metre of light is opaque there across a chord of a kilometre.
 */
export const VISIBLE_EDGE = 1.4;

/** The column's visible radius at height z above the vent, m. */
export function visibleRadiusM(z: number, s: Pick<PlumeShape, "ventRM">): number {
  return VISIBLE_EDGE * columnRadiusM(z, s);
}

/**
 * Rise speed on the column's axis at height z, m/s. A momentum jet out of the
 * vent decelerating as it entrains (w ~ 1/b), then the buoyant plume (w ~ z^(-1/3)),
 * both going to nothing at the top of the overshoot.
 */
export function riseSpeedMS(z: number, s: Pick<PlumeShape, "ventRM" | "topM" | "jetM">): number {
  if (z >= s.topM || s.topM <= 0) return 0;
  const zz = Math.max(0, z);
  const jet = EXIT_SPEED_MS * s.ventRM / columnRadiusM(zz, s);
  const buoy = BUOYANT_W_MS * Math.pow(Math.max(zz, s.jetM) / Math.max(s.jetM, 1), -1 / 3);
  return Math.max(jet, buoy) * Math.sqrt(1 - (zz / s.topM) ** 2);
}

/**
 * The plume with its top at `km` and fed at the flux that holds a column at
 * `steadyKm` (both above sea level, as sim/eruption.ts gives them), the vent
 * `ventKm` above sea level, `ageS` seconds after the column rose.
 */
export function plumeShape(km: number, steadyKm: number, ventKm: number, ageS: number): PlumeShape {
  const topM = Math.max(0, km - ventKm) * 1000;
  const steadyM = Math.max(0, steadyKm - ventKm) * 1000;
  const q = massFluxKgS(steadyKm);
  const ventRM = DECOMPRESSION * ventRadiusM(q);
  const rising = topM < 0.98 * steadyM;
  // A climbing head domes over from about four fifths of its height.
  const nblM = Math.min(NBL_FRACTION * steadyM, 0.8 * topM);
  const c = spreadConst(q);
  // The umbrella only spreads once the column has a neutral level to spread
  // at; in the first minutes the rising head is the whole cloud.
  const spreadM = rising ? 0 : umbrellaRadiusM(ageS, q);
  const upwindM = Math.min(spreadM, upwindStallM(q));
  const reachM = Math.max(spreadM, Math.min(120000, WIND_UMBRELLA_MS * ageS));
  return {
    topM, rising, nblM, qKgS: q, ventRM, jetM: GAS_THRUST_FRACTION * topM, spreadM, upwindM, reachM, c,
    // From a little under the neutral level to near the overshoot top over
    // the vent: about 1.3 times the overshoot, Pinatubo's 10 km at 35 km.
    thickM: 1.3 * (topM - nblM),
  };
}

/**
 * Albedo of the plume at height fraction f, 0 vent .. 1 top. Fine ash alone
 * scatters 0.3 to 0.5 of what it meets; the lower third carries the coarse
 * tephra and lithics that the umbrella has dropped by the time it spreads, and
 * reads near black-brown.
 */
export function ashAlbedo(f: number): number {
  const t = clamp01(f / 0.45);
  return 0.14 + 0.24 * t * t * (3 - 2 * t);
}
