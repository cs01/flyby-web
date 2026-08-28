// The gate on the sun and moon.
//
// Ephemeris code fails silently. A moon 30 degrees from where it belongs still
// draws a moon, a phase computed off the wrong angle still draws a crescent,
// and the picture looks fine until someone who knows the sky looks at it. So
// the checks here are DIFFERENTIAL where they can be: the phase is computed
// from ecliptic longitudes and the direction vectors are computed from right
// ascension and declination through a horizontal conversion, which are two
// separate paths through the file, and they have to agree about the sun-moon
// elongation. A transcription error in either one breaks that agreement.
//
// Every bound below has been watched to fail, by perturbing the constant it
// guards: the sign of the azimuth numerator, the observer's latitude, the
// obliquity, the moon's mean-longitude rate, its equation of centre, its node
// rate and its latitude amplitude.
//
// What this file does NOT resolve, stated so nobody reads a green run as more
// than it is. Rate errors under about half a percent (the moon's mean
// longitude, its anomaly) pass: they take years to move the moon as far as the
// truncated series is wrong anyway, which is the accuracy this app asked for.
// A wrong answer here is a moon a fraction of a degree out of place, not a
// moon in the wrong part of the sky.

import { solarState } from "../src/data/solar";

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function near(name: string, v: number, want: number, tol: number, unit: string): void {
  check(name, Math.abs(v - want) <= tol, `${v.toFixed(3)} ${unit} (want ${want} +-${tol})`);
}

function between(name: string, v: number, lo: number, hi: number, unit: string): void {
  check(name, v >= lo && hi >= v, `${v.toFixed(3)} ${unit} (want ${lo}..${hi})`);
}

const D2R = Math.PI / 180;

// --- The sun, against places and instants with a known answer --------------

// Local solar noon at Greenwich on the equinox: the sun is within a degree of
// overhead at the equator and due south from anywhere north of it.
{
  const s = solarState(new Date("2026-03-20T12:07:00Z"), 0, 0);
  between("equinox noon, sun altitude at 0N/0E", s.sun.altitude, 87, 90, "deg");
  near("equinox noon, daylight", s.daylight, 1, 0.001, "");
}

// Midsummer midnight inside the Arctic circle: the sun does not set.
{
  const s = solarState(new Date("2026-06-21T00:00:00Z"), 71.0, 25.8);
  check("midnight sun at 71N on the solstice", s.sun.altitude > 0, `${s.sun.altitude.toFixed(2)} deg`);
}

// Southern hemisphere, southern winter: the noon sun is in the NORTH. This is
// the check that catches a hemisphere sign error, which nothing else does --
// every altitude stays plausible when the azimuth is mirrored.
{
  const s = solarState(new Date("2026-06-21T02:00:00Z"), -33.87, 151.21);
  const az = s.sun.azimuth;
  check("Sydney midwinter noon sun is north", az < 45 || az > 315, `azimuth ${az.toFixed(1)} deg`);
  between("Sydney midwinter noon altitude", s.sun.altitude, 30, 35, "deg");
}

// East in the morning, west in the afternoon.
//
// This is the check that catches a SIGN on the azimuth's numerator, and it is
// the only one that can: the equinox and the Sydney cases both put the sun on
// or near the meridian, and a mirrored azimuth is its own reflection there.
// Every altitude in the file stays correct under that flip, because altitude
// does not depend on it -- so the sky would be lit from the wrong side all day
// and nothing else here would notice.
{
  const morning = solarState(new Date("2026-06-21T05:00:00Z"), 51.5, -0.12);
  between("London 06:00 BST, sun in the east", morning.sun.azimuth, 45, 90, "deg");
  const evening = solarState(new Date("2026-06-21T17:00:00Z"), 51.5, -0.12);
  between("London 18:00 BST, sun in the west", evening.sun.azimuth, 270, 315, "deg");
}

// The direction vector has to agree with the altitude it was built from, or
// every shader gets a light pointing somewhere the HUD does not admit to.
{
  const s = solarState(new Date("2026-08-28T15:00:00Z"), 51.5, -0.12);
  near("sun dir.y equals sin(altitude)", s.sun.dir.y, Math.sin(s.sun.altitude * D2R), 1e-9, "");
  const len = Math.hypot(s.sun.dir.x, s.sun.dir.y, s.sun.dir.z);
  near("sun dir is a unit vector", len, 1, 1e-9, "");
}

// --- The moon --------------------------------------------------------------

// Phase against position, through two independent code paths. The phase comes
// from the difference of two ecliptic longitudes; the directions come from RA
// and Dec via the horizontal conversion. cos(elongation) has to be the dot
// product of the two directions.
{
  let worst = 0;
  let worstAt = "";
  // A full synodic month at six-hour steps, from a fixed epoch so a failure is
  // reproducible.
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let h = 0; h < 30 * 24; h += 6) {
    const d = new Date(t0 + h * 3600_000);
    const s = solarState(d, 20, 0);
    const dot =
      s.sun.dir.x * s.moon.dir.x + s.sun.dir.y * s.moon.dir.y + s.sun.dir.z * s.moon.dir.z;
    const err = Math.abs(dot - Math.cos(s.moonElongation * D2R));
    if (err > worst) {
      worst = err;
      worstAt = d.toISOString();
    }
  }
  // The two paths use different truncations of the same series (the positional
  // one carries the latitude term, the longitude difference does not), so they
  // agree to about a degree rather than exactly. Anything past that is a bug,
  // not a truncation.
  check(
    "moon phase agrees with moon position",
    worst < 0.02,
    `worst |cos(elong) - dot| = ${worst.toFixed(5)} at ${worstAt}`,
  );
}

// The synodic month falls out of the phase, and it is a number with an exact
// known value. This catches a wrong rate constant in either the moon's or the
// sun's mean longitude, which nothing above can see.
{
  const t0 = Date.UTC(2026, 0, 1);
  const newMoons: number[] = [];
  let prev = solarState(new Date(t0), 0, 0).moonPhase;
  for (let h = 1; h < 200 * 24; h++) {
    const ph = solarState(new Date(t0 + h * 3600_000), 0, 0).moonPhase;
    // Phase wraps 1 -> 0 at new moon.
    if (ph < prev) newMoons.push(h);
    prev = ph;
  }
  const gaps: number[] = [];
  for (let i = 1; i < newMoons.length; i++) gaps.push((newMoons[i] - newMoons[i - 1]) / 24);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  check("found ~7 new moons in 200 days", gaps.length >= 5, `${gaps.length} intervals`);
  near("synodic month", mean, 29.53, 0.25, "days");
}

// Illuminated fraction is the cosine of the phase angle, not the phase itself.
// Treating the phase as a brightness is the specific error this guards: it
// makes a first-quarter moon half as bright as a full one when it is a
// quarter, and every crescent night far too light.
{
  const s = solarState(new Date("2026-01-01T00:00:00Z"), 0, 0);
  near("illumination matches elongation", s.moonIllum, (1 - Math.cos(s.moonElongation * D2R)) / 2, 1e-12, "");
  between("illumination is a fraction", s.moonIllum, 0, 1, "");
}

// A full moon is opposite the sun: it rises as the sun sets and it is up all
// night. This is the property the night lighting leans on, so it is asserted
// rather than assumed.
{
  const t0 = Date.UTC(2026, 0, 1);
  let bestPhase = 0;
  let bestAt = t0;
  for (let h = 0; h < 40 * 24; h++) {
    const s = solarState(new Date(t0 + h * 3600_000), 0, 0);
    if (s.moonIllum > bestPhase) {
      bestPhase = s.moonIllum;
      bestAt = t0 + h * 3600_000;
    }
  }
  const s = solarState(new Date(bestAt), 45, 0);
  const dot =
    s.sun.dir.x * s.moon.dir.x + s.sun.dir.y * s.moon.dir.y + s.sun.dir.z * s.moon.dir.z;
  check("full moon is opposite the sun", dot < -0.985, `dot = ${dot.toFixed(4)}`);
  check(
    "full moon is up while the sun is down",
    Math.sign(s.moon.altitude) === -Math.sign(s.sun.altitude),
    `sun ${s.sun.altitude.toFixed(1)} deg, moon ${s.moon.altitude.toFixed(1)} deg`,
  );
}

// The moon runs about 13.18 degrees a day eastward against the stars and the
// sun 0.99, so their elongation opens at 12.19 deg/day. That is the one number
// here that says the rate constants are RIGHT rather than merely
// self-consistent -- everything above would still pass with both of them wrong
// by the same factor.
//
// Averaged over a month, not sampled over a day. The equation of centre swings
// the day-to-day rate by more than a degree either side of the mean, so a
// single pair of samples has to be given a tolerance so wide it would not
// notice a 10% error in the constant it is guarding.
{
  const t0 = Date.UTC(2026, 4, 1);
  const days = 29;
  let total = 0;
  let prev = solarState(new Date(t0), 0, 0).moonElongation;
  for (let d = 1; d <= days; d++) {
    const e = solarState(new Date(t0 + d * 86400_000), 0, 0).moonElongation;
    total += (e - prev + 360) % 360;
    prev = e;
  }
  near("moon-sun elongation rate", total / days, 12.19, 0.1, "deg/day");
}

// The equation of centre, from the SWING in the elongation rate rather than
// from its mean.
//
// The mean rate above is blind to it: halving the 6.289 deg term leaves the
// month exactly the right length, because the term is a sine and averages to
// nothing. What it does change is the spread -- the moon runs from about 10.7
// to 13.6 degrees a day as it goes round a real ellipse, and a halved term
// makes that a nearly constant 12.2. That is the difference between a moon
// that keeps time and a moon that is in the right place.
{
  const t0 = Date.UTC(2026, 0, 1);
  let lo = 1e9;
  let hi = -1e9;
  let prev = solarState(new Date(t0), 0, 0).moonElongation;
  for (let d = 1; d <= 90; d++) {
    const e = solarState(new Date(t0 + d * 86400_000), 0, 0).moonElongation;
    const rate = (e - prev + 360) % 360;
    lo = Math.min(lo, rate);
    hi = Math.max(hi, rate);
    prev = e;
  }
  between("slowest daily elongation rate", lo, 10.4, 11.1, "deg/day");
  between("fastest daily elongation rate", hi, 13.3, 13.9, "deg/day");
}

// The moon's ecliptic latitude: a 5.13 degree swing with the DRACONIC period,
// 27.21 days.
//
// This is the only check on the argument of latitude. Everything else here
// works in longitude, where that term does not appear at all, so a wrong node
// rate puts the moon up to 10 degrees of declination away from where it
// belongs -- moonrise in the wrong place, moonlight from the wrong bearing --
// with every other bound in the file still green.
//
// Reconstructed from the published RA and Dec through the published obliquity,
// so it is testing the numbers the renderer actually receives.
{
  const t0 = Date.UTC(2026, 0, 1);
  const beta = (t: number): number => {
    const s = solarState(new Date(t), 0, 0);
    const e = s.obliquity * D2R;
    const dec = s.moon.dec * D2R;
    const ra = s.moon.ra * D2R;
    return Math.asin(Math.sin(dec) * Math.cos(e) - Math.cos(dec) * Math.sin(e) * Math.sin(ra)) / D2R;
  };
  let peak = 0;
  const crossings: number[] = [];
  const STEP_H = 1;
  let prev = beta(t0);
  for (let h = STEP_H; h < 300 * 24; h += STEP_H) {
    const b = beta(t0 + h * 3600_000);
    peak = Math.max(peak, Math.abs(b));
    if (prev < 0 && b >= 0) crossings.push(h);
    prev = b;
  }
  const gaps: number[] = [];
  for (let i = 1; i < crossings.length; i++) gaps.push((crossings[i] - crossings[i - 1]) / 24);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  near("moon ecliptic latitude amplitude", peak, 5.13, 0.2, "deg");
  check("found ~11 node crossings in 300 days", gaps.length >= 8, `${gaps.length} intervals`);
  near("draconic month", mean, 27.212, 0.1, "days");
}

// --- Report ----------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(44)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} solar checks passed`);
if (failed) process.exit(1);
