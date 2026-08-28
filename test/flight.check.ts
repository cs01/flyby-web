// The gate on the flight model.
//
// A flight model is the one part of this app with no visual tell when it goes
// wrong by a factor of two: an aeroplane that takes thirty seconds to come
// round instead of eleven still looks like an aeroplane in a screenshot, and
// the only way to notice is to fly it and be vaguely dissatisfied. So the
// numbers that define the FEEL -- cruise and slow speed, time for a full turn,
// roll response, climb rate, altitude hold -- are asserted here with bounds
// tight enough to catch a regression and loose enough to survive tuning.
//
// Every bound has been watched to fail, by perturbing the constant it guards.
// A check nobody has seen fail is not a check.

import { Aircraft, DEFAULT_CONFIG } from "../src/sim/aircraft";
import type { AircraftInput } from "../src/sim/aircraft";
import { fallbackWeather, type Weather } from "../src/data/weather";

const DT = 1 / 60;

const NEUTRAL: AircraftInput = { throttle: 0, roll: 0, yaw: 0, lift: 0, boost: 0 };

function air(windSpeed: number, windDir = 270): Weather {
  // Gust equal to the mean wind switches turbulence off, so a run is
  // reproducible; the gust response is exercised by eye, not by this file.
  return { ...fallbackWeather(), windSpeed, gust: windSpeed, windDir };
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function between(name: string, v: number, lo: number, hi: number, unit: string): void {
  check(name, v >= lo && hi >= v, `${v.toFixed(2)} ${unit} (want ${lo}..${hi})`);
}

/** Run `seconds` of simulation with a fixed input, over flat ground at y=0. */
function fly(a: Aircraft, input: Partial<AircraftInput>, seconds: number, wx: Weather): void {
  const full: AircraftInput = { ...NEUTRAL, ...input };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    a.setWeather(wx, a.position.y);
    a.update(full, DT, 0);
  }
}

function fresh(alt = 400, hdg = 0): Aircraft {
  const a = new Aircraft();
  a.reset(0, alt, 0, hdg);
  return a;
}

// --- Speed ----------------------------------------------------------------
// The throttle commands a speed rather than a power, so the top and bottom of
// its range are directly assertable. Density at 400 m knocks a few percent off
// both, which is why the bounds are not the config numbers exactly.
{
  const fast = fresh();
  fly(fast, { throttle: 1 }, 25, air(0));
  between("full throttle airspeed", fast.airspeed, 55, 65, "m/s");

  const slow = fresh();
  fly(slow, { throttle: -1 }, 25, air(0));
  between("closed throttle airspeed", slow.airspeed, 16, 26, "m/s");
  check("slow flight still flies", slow.position.y > 380, `${slow.position.y.toFixed(0)} m`);
}

// --- Turn -----------------------------------------------------------------
// The complaint that started all of this was that a turn took forever. A full
// circle at full bank is the number that says whether it still does; the old
// fixed-wing model took 33 seconds here.
{
  const a = fresh();
  const wx = air(0);
  let t = 0;
  let turned = 0;
  let last = a.headingDeg;
  while (t < 60 && turned < 360) {
    a.setWeather(wx, a.position.y);
    a.update({ ...NEUTRAL, roll: 1 }, DT, 0);
    let d = a.headingDeg - last;
    while (d < -180) d += 360;
    while (d > 180) d -= 360;
    turned += d;
    last = a.headingDeg;
    t += DT;
  }
  between("time for a full circle", t, 7, 16, "s at full bank");
  check("turns the way it banks", turned > 0, `${turned.toFixed(0)} deg to the right`);
  between("bank reached", a.rollDeg, DEFAULT_CONFIG.maxBank - 2, DEFAULT_CONFIG.maxBank + 0.5, "deg");
}

// --- Roll response --------------------------------------------------------
// How long full stick takes to become full bank. This is the number that reads
// as "responsive" or "mushy" and nothing else in the model compensates for it.
{
  const a = fresh();
  const wx = air(0);
  let t = 0;
  const target = DEFAULT_CONFIG.maxBank * 0.9;
  while (t < 3 && a.bankDeg < target) {
    a.setWeather(wx, a.position.y);
    a.update({ ...NEUTRAL, roll: 1 }, DT, 0);
    t += DT;
  }
  between("roll to 90% of full bank", t, 0.15, 0.65, "s");
}

// --- Altitude hold --------------------------------------------------------
// A pitch axis that self-centres cannot hold a height, and one that does not
// needs trimming. A vertical-speed command needs neither, and this is the
// assertion that says the command is actually wired that way.
{
  const a = fresh();
  fly(a, {}, 40, air(0));
  check("holds altitude hands off", Math.abs(a.position.y - 400) < 3, `${(a.position.y - 400).toFixed(2)} m in 40 s`);

  const turning = fresh();
  fly(turning, { roll: 1 }, 30, air(0));
  check("holds altitude in a turn", Math.abs(turning.position.y - 400) < 6, `${(turning.position.y - 400).toFixed(2)} m`);
}

// --- Climb and descent ----------------------------------------------------
{
  const up = fresh();
  fly(up, { lift: 1, throttle: 1 }, 10, air(0));
  between("climb rate", up.verticalSpeed, 5, DEFAULT_CONFIG.climbRate + 0.5, "m/s");
  check("climb gains height", up.position.y - 400 > 45, `${(up.position.y - 400).toFixed(0)} m in 10 s`);

  const down = fresh(900);
  fly(down, { lift: -1 }, 10, air(0));
  check("descends when asked", down.position.y < 830, `${down.position.y.toFixed(0)} m`);

  // Energy, not an absolute number. The commanded speed itself falls with
  // density, so "faster than 50 m/s" would really be asserting the altitude the
  // test happens to run at; what the model owes us is that a descent is faster
  // than level flight at the same lever setting and the same air.
  const level = fresh(900);
  fly(level, {}, 10, air(0));
  check(
    "descent trades height for speed",
    down.airspeed > level.airspeed + 1.5,
    `${down.airspeed.toFixed(1)} descending vs ${level.airspeed.toFixed(1)} level`,
  );
}

// --- Rudder ---------------------------------------------------------------
{
  const a = fresh(400, 90);
  fly(a, { yaw: 1 }, 1, air(0));
  let turned = a.headingDeg - 90;
  while (turned < -180) turned += 360;
  between("rudder yaw rate", turned, DEFAULT_CONFIG.rudderRate - 6, DEFAULT_CONFIG.rudderRate + 6, "deg/s");
}

// --- Wind -----------------------------------------------------------------
// The airspeed indicator must not move when the wind does, and the track over
// the ground must. Adding the wind to the displayed velocity instead of to the
// integration is the mistake this catches: it would make both move together
// and there would be no drift at all.
{
  const still = fresh(400, 0);
  fly(still, {}, 25, air(0));
  const windy = fresh(400, 0);
  fly(windy, {}, 25, air(11, 270));

  check(
    "wind does not change airspeed",
    Math.abs(windy.airspeed - still.airspeed) < 0.5,
    `${windy.airspeed.toFixed(1)} vs ${still.airspeed.toFixed(1)} m/s`,
  );
  check(
    "wind does change the track",
    Math.abs(windy.groundSpeed - windy.airspeed) > 0.8,
    `gs ${windy.groundSpeed.toFixed(1)} vs ias ${windy.airspeed.toFixed(1)} m/s`,
  );
  // Flying north with a westerly, the aeroplane must be pushed east.
  check("blown downwind", windy.position.x > 150, `${windy.position.x.toFixed(0)} m east in 25 s`);
}

// --- Ground ---------------------------------------------------------------
{
  const a = fresh(120);
  fly(a, { lift: -1 }, 40, air(0));
  check("never sinks through the ground", a.position.y >= 25 - 1e-6, `y = ${a.position.y.toFixed(2)} m`);
}

// --- Numerical ------------------------------------------------------------
{
  const a = fresh();
  const wx = air(9);
  for (let i = 0; i < 6000; i++) {
    const phase = i / 60;
    a.setWeather(wx, a.position.y);
    a.update(
      {
        throttle: Math.sin(phase * 3.1),
        roll: Math.sin(phase * 4.7 + 1),
        yaw: Math.sin(phase * 2.3),
        lift: Math.sin(phase * 1.7),
        boost: phase % 2 < 1 ? 1 : 0,
      },
      DT,
      0,
    );
  }
  const finite =
    Number.isFinite(a.position.x) &&
    Number.isFinite(a.position.y) &&
    Number.isFinite(a.position.z) &&
    Number.isFinite(a.airspeed) &&
    Number.isFinite(a.groundSpeed);
  check("stays finite under abuse", finite, `pos ${a.position.toArray().map((v) => v.toFixed(0)).join(",")}`);
  check(
    "bank stays inside the limit",
    a.bankDeg <= DEFAULT_CONFIG.boostBank + 0.5,
    `${a.bankDeg.toFixed(1)} deg`,
  );
  check(
    "airspeed stays inside the envelope",
    a.airspeed > 5 && a.airspeed < DEFAULT_CONFIG.boostSpeed * 1.25,
    `${a.airspeed.toFixed(1)} m/s`,
  );
}

// --- Report ---------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(32)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} flight checks passed`);
if (failed) process.exit(1);
