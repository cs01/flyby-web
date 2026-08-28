// Where the sun and moon actually are, for a place and an instant.
//
// NOAA's solar position algorithm, which is accurate to about a hundredth of a
// degree over the years anyone will run this. That precision is not vanity: the
// difference between a sun 2 degrees above the horizon and 2 degrees below it is
// the difference between a lit city and a dark one, and a cheap approximation
// gets that boundary wrong by enough minutes to notice at golden hour.
//
// Time is a real Date. `?t=<epoch seconds>` freezes it, so a screenshot can be
// reproduced: without a freeze every capture lands under a slightly different
// sun and no two pictures can be compared.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface SkyBody {
  /** Degrees above the horizon; negative is below. */
  altitude: number;
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Unit vector in world space: +x east, +y up, +z south. */
  dir: { x: number; y: number; z: number };
}

export interface SolarState {
  sun: SkyBody;
  moon: SkyBody;
  /** 0 = new, 0.5 = full, approaching 1 = new again. */
  moonPhase: number;
  /** 0 fully night .. 1 fully day, smoothed across civil twilight. */
  daylight: number;
}

function julianDay(d: Date): number {
  return d.getTime() / 86400000 + 2440587.5;
}

function toDir(altDeg: number, azDeg: number): { x: number; y: number; z: number } {
  const a = altDeg * D2R;
  const z = azDeg * D2R;
  const horiz = Math.cos(a);
  // Azimuth 0 = north = -z in our frame; 90 = east = +x.
  return { x: horiz * Math.sin(z), y: Math.sin(a), z: -horiz * Math.cos(z) };
}

/** Shared equatorial -> horizontal conversion. */
function horizontal(ra: number, dec: number, gmst: number, lat: number, lon: number): SkyBody {
  const ha = (gmst + lon - ra * R2D) * D2R;
  const p = lat * D2R;
  const dr = dec * D2R;
  const sinAlt = Math.sin(p) * Math.sin(dr) + Math.cos(p) * Math.cos(dr) * Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(
    -Math.sin(ha) * Math.cos(dr),
    Math.cos(p) * Math.sin(dr) - Math.sin(p) * Math.cos(dr) * Math.cos(ha),
  );
  const altDeg = alt * R2D;
  const azDeg = (az * R2D + 360) % 360;
  return { altitude: altDeg, azimuth: azDeg, dir: toDir(altDeg, azDeg) };
}

export function solarState(date: Date, lat: number, lon: number): SolarState {
  const jd = julianDay(date);
  const n = jd - 2451545.0;
  const T = n / 36525;

  // Greenwich mean sidereal time, degrees.
  const gmst = (280.46061837 + 360.98564736629 * n + 0.000387933 * T * T) % 360;

  // --- Sun (NOAA) ---
  const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const Mr = M * D2R;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) +
    0.000289 * Math.sin(3 * Mr);
  const trueLon = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLon = (trueLon - 0.00569 - 0.00478 * Math.sin(omega * D2R)) * D2R;
  // Obliquity of the ecliptic, with the nutation term that matters at this scale.
  const e0 =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (e0 + 0.00256 * Math.cos(omega * D2R)) * D2R;

  const sunRa = Math.atan2(Math.cos(eps) * Math.sin(appLon), Math.cos(appLon));
  const sunDec = Math.asin(Math.sin(eps) * Math.sin(appLon)) * R2D;
  const sun = horizontal(sunRa, sunDec, gmst, lat, lon);

  // --- Moon (Meeus, truncated: good to ~0.3 deg, plenty for a light source) ---
  const Ld = (218.316 + 13.176396 * n) * D2R;
  const Mm = (134.963 + 13.064993 * n) * D2R;
  const F = (93.272 + 13.229350 * n) * D2R;
  const lam = Ld + 6.289 * D2R * Math.sin(Mm);
  const bet = 5.128 * D2R * Math.sin(F);
  const moonRa = Math.atan2(
    Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps),
    Math.cos(lam),
  );
  const moonDec =
    Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam)) * R2D;
  const moon = horizontal(moonRa, moonDec, gmst, lat, lon);

  // Phase from the sun-moon elongation in ecliptic longitude.
  const elong = ((lam - appLon) * R2D + 360) % 360;
  const moonPhase = elong / 360;

  // Civil twilight ramp. -6 deg is the standard "lights come on" threshold; the
  // extra 4 deg above it stops the transition being a visible switch.
  const daylight = Math.max(0, Math.min(1, (sun.altitude + 6) / 10));

  return { sun, moon, moonPhase, daylight };
}

/** Scene clock. Frozen by `?t=<epoch seconds>` so screenshots are comparable. */
export function sceneTime(): Date {
  const q = new URLSearchParams(location.search).get("t");
  if (q) {
    const v = Number(q);
    if (Number.isFinite(v)) return new Date(v * 1000);
  }
  return new Date();
}
