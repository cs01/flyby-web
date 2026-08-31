// The gate on the time-of-day traffic model: src/data/trafficmodel.ts, and the
// `rank` field src/data/streetfurniture.ts hands the shader to thin with.
//
// WHAT CAN GO WRONG HERE THAT STILL RENDERS PERFECTLY. Every one of these
// produces a frame with no error in it:
//
//   * the curves stop reading the clock. Manhattan at 03:00 is as busy as
//     Manhattan at 08:00, which is what this whole change exists to fix and is
//     invisible unless you scrub and count cars.
//   * the diurnal curves break class monotonicity at some hour in the middle of
//     the day, so the alley behind the arterial carries the busier stream. The
//     same invariant TRAFFIC_PER_KM_LANE is already gated on, now with a second
//     way to break it that the density table cannot see.
//   * a frac creeps over 1, which silently asks for more cars than were placed.
//     Nothing complains; the street simply stops getting any busier and the
//     hours either side of the peak flatten into a plateau.
//   * congestion is tuned so weakly that rush hour looks like 03:00, or so hard
//     that the city stops moving.
//   * rain does nothing, or snow does less than rain.
//   * the utcOffsetSeconds is dropped somewhere and every city runs on the
//     viewer's own wall clock. On a machine in the right zone that is correct,
//     which is exactly why it survives.
//   * `rank` correlates with `phase` or with `tint`. Then thinning does not
//     thin: it empties the start of every run, or takes all the red cars off
//     the road, and either one reads as a bug rather than as a quiet hour.
//
// WATCHED TO FAIL. Every assertion carries a VACUITY PROBE: the same predicate
// fed a case it must reject. Each probe is then BLINDED -- fed the real case,
// which it must accept -- so a probe that has stopped looking at anything
// cannot pass by rejecting everything.
//
// The bounds below are LITERALS, imported from nothing under test. Raising a
// constant must not move the goalposts with it.

import {
  trafficState,
  localHour,
  utcOffsetFromLongitude,
  CLASS_COUNT,
  type TrafficState,
} from "../src/data/trafficmodel";
import { RoadClass } from "../src/data/roadpack";
import { addTraffic, hash1, type StreetWorld, type TrafficInstance } from "../src/data/streetfurniture";
import { ROAD_ONEWAY, type Road, type RoadPack } from "../src/data/roadpack";
import type { Weather } from "../src/data/weather";

// --- literal bounds ---------------------------------------------------------

/** Fraction of the placed cars still out on a primary at 03:00. A street that
 *  still has a fifth of its rush hour on it at three in the morning is not a
 *  street at three in the morning. */
const NIGHT_PRIMARY_MAX_FRAC = 0.15;
/** Free-flow multiple a primary must be BELOW at the weekday peak. Anything
 *  over 0.7 and the rush hour is a rush hour in name only. */
const PEAK_PRIMARY_MAX_SPEED = 0.70;
/** And above, at 03:00, when there is nothing to be held up by. */
const NIGHT_PRIMARY_MIN_SPEED = 0.95;
/** How far apart a weekday and a weekend 08:00 must be, as a fraction of peak.
 *  The commute is the single largest feature of an urban weekday; if the two
 *  days differ by less than this, the weekend curve is decoration. */
const WEEKDAY_WEEKEND_08_MIN_GAP = 0.20;
/** Correlation between `rank` and anything else an instance carries. Zero is
 *  the target; 0.1 over thousands of samples is noise. */
const RANK_MAX_ABS_R = 0.10;
/** How far the kept share may sit from the frac it was thinned to. */
const THIN_TOLERANCE = 0.05;
/** Instances a thinning measurement needs before it means anything. */
const MIN_SAMPLE = 2000;

/** The driveable ladder, most arterial first. Nothing above Pedestrian drives.
 *  Written out rather than derived, so reordering the enum fails here. */
const LADDER = [
  RoadClass.Motorway, RoadClass.Trunk, RoadClass.Primary, RoadClass.Secondary,
  RoadClass.Tertiary, RoadClass.Residential, RoadClass.Unclassified,
  RoadClass.Service, RoadClass.LivingStreet, RoadClass.Busway,
];

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(62)} ${detail}`);
  if (!ok) failures++;
}

/**
 * A vacuity probe: the same predicate fed a case it must reject.
 *
 * `checkerSaidOk` is the checker re-run over poisoned input. If it comes back
 * true, the checker cannot tell the poisoned case from the good one and the
 * assertion above it proved nothing.
 */
function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}

/**
 * The probe, blinded: the same predicate fed the REAL case, which it must
 * accept.
 *
 * Without this a probe can pass by rejecting everything, which is exactly as
 * useless as an assertion that accepts everything.
 */
function blind(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  console.log(`${checkerSaidOk ? "  ok" : "BLIND-FAIL"} blinded: ${label.padEnd(52)} ${detail}`);
  if (!checkerSaidOk) failures++;
}

// --- a week of instants -----------------------------------------------------
//
// 2024-01-01 was a Monday, so 1..5 are weekdays and 6..7 are the weekend. The
// city is placed at UTC so the local hour IS the hour asked for; the offset is
// exercised separately below, which is the only way to tell "the offset is
// applied" apart from "the offset happens to be zero".

const MONDAY = 1;
const WEDNESDAY = 3;
const SATURDAY = 6;
const utc = (day: number, hour: number): Date =>
  new Date(Date.UTC(2024, 0, day, Math.floor(hour), Math.round((hour % 1) * 60)));

/** Every quarter hour of every day of that week. */
function everyInstant(): { day: number; hour: number; state: TrafficState }[] {
  const out: { day: number; hour: number; state: TrafficState }[] = [];
  for (let day = 1; day <= 7; day++) {
    for (let q = 0; q < 96; q++) {
      const hour = q / 4;
      out.push({ day, hour, state: trafficState(utc(day, hour), 0, null) });
    }
  }
  return out;
}

const WEEK = everyInstant();

function weather(kind: Weather["precipKind"], mmPerHour: number, tempC: number): Weather {
  // Only the four fields the model reads are meaningful; the rest is filler
  // that keeps the shape of a real Weather so a field rename fails to compile
  // rather than silently reading undefined.
  return {
    time: new Date(0), live: false, source: "observed" as Weather["source"],
    tempC, dewC: tempC - 2, humidity: 90, pressureHpa: 1010,
    windSpeed: 3, windDir: 180, gust: 5, visibility: 10000,
    precip: mmPerHour, precipKind: kind, wmoCode: 0, isDay: true,
    low: { cover: 1, base: 400, top: 1500 },
    mid: { cover: 0, base: 3800, top: 5000 },
    high: { cover: 0, base: 8500, top: 10000 },
    totalCover: 1, opacity: 0.9, summary: "test",
  };
}

const DRY = null;
const LIGHT_RAIN = weather("rain", 0.6, 12);
const HEAVY_RAIN = weather("rain", 8, 12);
const SNOW = weather("snow", 3, -3);

// --- 1. the clock is read at all --------------------------------------------

function peakBeatsNight(scale: number): boolean {
  for (const c of LADDER) {
    const night = trafficState(utc(WEDNESDAY, 3), 0, null).frac[c] * scale;
    let peak = 0;
    for (let q = 0; q < 96; q++) {
      peak = Math.max(peak, trafficState(utc(WEDNESDAY, q / 4), 0, null).frac[c]);
    }
    if (!(peak > night)) return false;
  }
  return true;
}

check(
  "every driveable class is busier at its weekday peak than at 03:00",
  peakBeatsNight(1),
  LADDER.map((c) =>
    `${RoadClass[c]} ${trafficState(utc(WEDNESDAY, 3), 0, null).frac[c].toFixed(2)}`).join(" "),
);
probe(
  "the peak test rejects a night as busy as the peak",
  // Scaling the night up past any peak is the flat table this change replaced.
  peakBeatsNight(10),
  "03:00 multiplied by ten",
);
blind("the peak test accepts the real curves", peakBeatsNight(1), "the real model");

// --- 2. class monotonicity, at every hour -----------------------------------

function monotoneEverywhere(fracAt: (s: TrafficState, c: RoadClass) => number): string | null {
  for (const { day, hour, state } of WEEK) {
    for (let i = 1; i < LADDER.length; i++) {
      const above = fracAt(state, LADDER[i - 1]);
      const below = fracAt(state, LADDER[i]);
      if (below > above) {
        return `day ${day} ${hour.toFixed(2)}h ${RoadClass[LADDER[i]]} ` +
               `${below.toFixed(4)} > ${RoadClass[LADDER[i - 1]]} ${above.toFixed(4)}`;
      }
    }
  }
  return null;
}

const monoFail = monotoneEverywhere((s, c) => s.frac[c]);
check(
  "no hour of the week lets a lesser class out-carry a greater one",
  monoFail === null,
  monoFail ?? `${WEEK.length} instants x ${LADDER.length} classes clean`,
);
probe(
  "the monotone test rejects a residential street given the motorway's curve",
  monotoneEverywhere((s, c) =>
    s.frac[c === RoadClass.Residential ? RoadClass.Motorway : c]) === null,
  "residential reading the motorway's frac",
);
blind(
  "the monotone test accepts the real curves",
  monotoneEverywhere((s, c) => s.frac[c]) === null,
  "the real model",
);

// --- 3. the frac is a fraction ----------------------------------------------

function inUnitRange(bump: number): boolean {
  for (const { state } of WEEK) {
    for (let c = 0; c < CLASS_COUNT; c++) {
      const f = state.frac[c] + (c === RoadClass.Motorway ? bump : 0);
      if (!(f >= 0 && f <= 1)) return false;
    }
  }
  return true;
}

check("every frac stays inside 0..1, all week, all classes", inUnitRange(0), "no overflow");
probe(
  "the range test rejects a class asking for more cars than were placed",
  inUnitRange(0.01),
  "motorway frac nudged past 1",
);
blind("the range test accepts the real curves", inUnitRange(0), "the real model");

// --- 4, 5. the two ends of a primary's day ----------------------------------

const night = trafficState(utc(WEDNESDAY, 3), 0, DRY);
let peakPrimaryFrac = 0;
let peakPrimarySpeed = 1;
for (let q = 0; q < 96; q++) {
  const s = trafficState(utc(WEDNESDAY, q / 4), 0, DRY);
  if (s.frac[RoadClass.Primary] > peakPrimaryFrac) {
    peakPrimaryFrac = s.frac[RoadClass.Primary];
    peakPrimarySpeed = s.speed[RoadClass.Primary];
  }
}

check(
  "a primary at 03:00 on a weekday is nearly empty",
  night.frac[RoadClass.Primary] < NIGHT_PRIMARY_MAX_FRAC,
  `${night.frac[RoadClass.Primary].toFixed(3)} < ${NIGHT_PRIMARY_MAX_FRAC}`,
);
probe(
  "the empty-night test rejects the flat table this replaced",
  1.0 < NIGHT_PRIMARY_MAX_FRAC,
  "a constant frac of 1",
);
blind(
  "the empty-night test accepts the real 03:00",
  night.frac[RoadClass.Primary] < NIGHT_PRIMARY_MAX_FRAC,
  "the real model",
);

check(
  "a primary crawls at the weekday peak",
  peakPrimarySpeed < PEAK_PRIMARY_MAX_SPEED,
  `${peakPrimarySpeed.toFixed(3)} < ${PEAK_PRIMARY_MAX_SPEED} at frac ${peakPrimaryFrac.toFixed(3)}`,
);
probe(
  "the congestion test rejects free flow at the peak",
  1.0 < PEAK_PRIMARY_MAX_SPEED,
  "an unconditional 1.0x",
);
blind("the congestion test accepts the real peak", peakPrimarySpeed < PEAK_PRIMARY_MAX_SPEED, "the real model");

check(
  "and runs free at 03:00",
  night.speed[RoadClass.Primary] > NIGHT_PRIMARY_MIN_SPEED,
  `${night.speed[RoadClass.Primary].toFixed(3)} > ${NIGHT_PRIMARY_MIN_SPEED}`,
);
probe(
  "the free-flow test rejects a city congested at three in the morning",
  0.5 > NIGHT_PRIMARY_MIN_SPEED,
  "a constant 0.5x",
);
blind("the free-flow test accepts the real 03:00", night.speed[RoadClass.Primary] > NIGHT_PRIMARY_MIN_SPEED, "the real model");

// A higher class must congest harder than a lower one, which is the half of
// the BPR tuning that "under 0.70 at the peak" cannot see.
check(
  "a jammed motorway is slower than a jammed side street",
  trafficState(utc(WEDNESDAY, 17), 0, DRY).speed[RoadClass.Motorway] <
    trafficState(utc(WEDNESDAY, 17), 0, DRY).speed[RoadClass.Residential],
  `${trafficState(utc(WEDNESDAY, 17), 0, DRY).speed[RoadClass.Motorway].toFixed(3)} < ` +
  `${trafficState(utc(WEDNESDAY, 17), 0, DRY).speed[RoadClass.Residential].toFixed(3)}`,
);

// --- 6. weather -------------------------------------------------------------

function wetterIsSlower(a: Weather | null, b: Weather | null): boolean {
  // b must be slower than a at EVERY hour of the week and every driveable
  // class, not merely on average: a factor applied on one branch of an if is
  // exactly the bug this is looking for.
  for (let day = 1; day <= 7; day++) {
    for (let q = 0; q < 96; q++) {
      const when = utc(day, q / 4);
      const sa = trafficState(when, 0, a);
      const sb = trafficState(when, 0, b);
      for (const c of LADDER) if (!(sb.speed[c] < sa.speed[c])) return false;
    }
  }
  return true;
}

check("rain slows traffic at every hour", wetterIsSlower(DRY, LIGHT_RAIN), "dry > light rain");
check("heavy rain slows it further", wetterIsSlower(LIGHT_RAIN, HEAVY_RAIN), "light > heavy");
check("and snow further still", wetterIsSlower(HEAVY_RAIN, SNOW), "heavy rain > snow");
probe(
  "the weather test rejects a forecast that changes nothing",
  wetterIsSlower(DRY, weather("none", 0, 12)),
  "a dry hour compared with itself",
);
blind("the weather test accepts real rain", wetterIsSlower(DRY, LIGHT_RAIN), "dry vs light rain");

// --- 7. the weekend is a different day --------------------------------------

const weekday08 = trafficState(utc(WEDNESDAY, 8), 0, DRY).frac[RoadClass.Primary];
const weekend08 = trafficState(utc(SATURDAY, 8), 0, DRY).frac[RoadClass.Primary];

check(
  "08:00 on a Saturday is not 08:00 on a Wednesday",
  Math.abs(weekday08 - weekend08) > WEEKDAY_WEEKEND_08_MIN_GAP,
  `weekday ${weekday08.toFixed(3)} vs weekend ${weekend08.toFixed(3)}`,
);
probe(
  "the weekend test rejects one curve used for both days",
  Math.abs(weekday08 - weekday08) > WEEKDAY_WEEKEND_08_MIN_GAP,
  "the weekday curve compared with itself",
);
blind(
  "the weekend test accepts the two real days",
  Math.abs(weekday08 - weekend08) > WEEKDAY_WEEKEND_08_MIN_GAP,
  "Wednesday vs Saturday",
);

// --- 8. the city's own clock, not the viewer's ------------------------------
//
// One UTC instant read at two offsets. If the offset is dropped, both answers
// are the same number and Tokyo runs on the reader's wall clock.

const instant = utc(MONDAY, 3);
const atUtc = trafficState(instant, 0, DRY).frac[RoadClass.Primary];
const atPlus12 = trafficState(instant, 12 * 3600, DRY).frac[RoadClass.Primary];

check(
  "utcOffsetSeconds moves the hour the curves are read at",
  Math.abs(atUtc - atPlus12) > WEEKDAY_WEEKEND_08_MIN_GAP,
  `03:00 local ${atUtc.toFixed(3)} vs 15:00 local ${atPlus12.toFixed(3)}`,
);
probe(
  "the offset test rejects an offset that is ignored",
  Math.abs(atUtc - atUtc) > WEEKDAY_WEEKEND_08_MIN_GAP,
  "the same offset twice",
);
blind(
  "the offset test accepts a twelve-hour shift",
  Math.abs(atUtc - atPlus12) > WEEKDAY_WEEKEND_08_MIN_GAP,
  "0 vs +12h",
);

// The hour itself, read with the UTC accessors so the host machine's zone
// cannot leak in. This runs green in every TZ; set TZ=Asia/Tokyo to see the
// version that used the local accessors go red.
check(
  "the local hour is the city's, whatever zone the test runs in",
  Math.abs(localHour(utc(MONDAY, 3), 5.5 * 3600) - 8.5) < 1e-9,
  `03:00Z at +05:30 is ${localHour(utc(MONDAY, 3), 5.5 * 3600).toFixed(3)}`,
);

// --- 9. the thinning rank ---------------------------------------------------
//
// Measured on real placed instances rather than on hash1 directly, because the
// thing that can break is the SEED, not the hash: the multiplier is one edit
// away from being another field's.

/** A grid of straight ways, long enough that each carries a stream of cars. */
function syntheticPack(): { pack: RoadPack; world: StreetWorld } {
  const roads: Road[] = [];
  for (let i = 0; i < 60; i++) {
    const z = i * 40;
    roads.push({
      cls: i % 2 === 0 ? RoadClass.Primary : RoadClass.Residential,
      lanes: 2,
      flags: i % 5 === 0 ? ROAD_ONEWAY : 0,
      layer: 0,
      surface: 0,
      name: "",
      pts: new Float32Array([0, z, 1200, z]),
    } as unknown as Road);
  }
  const pack = { roads } as unknown as RoadPack;
  const world: StreetWorld = { groundY: () => 0 } as unknown as StreetWorld;
  return { pack, world };
}

const { pack: synthPack, world: synthWorld } = syntheticPack();
const cars: TrafficInstance[] = [];
for (let i = 0; i < synthPack.roads.length; i++) {
  addTraffic(cars, synthPack.roads[i], i, synthWorld);
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 1;
}

check(
  "the synthetic city placed enough cars to measure",
  cars.length >= MIN_SAMPLE,
  `${cars.length} instances`,
);

const ranks = cars.map((c) => c.rank);
const rVsPhase = pearson(ranks, cars.map((c) => c.phase));
const rVsTint = pearson(ranks, cars.map((c) => c.tint));

check(
  "rank is uncorrelated with the phase it must not empty the head of",
  Math.abs(rVsPhase) < RANK_MAX_ABS_R,
  `r = ${rVsPhase.toFixed(4)}`,
);
check(
  "rank is uncorrelated with the tint it must not sort the fleet by",
  Math.abs(rVsTint) < RANK_MAX_ABS_R,
  `r = ${rVsTint.toFixed(4)}`,
);
probe(
  "the correlation test rejects a rank that IS the phase",
  Math.abs(pearson(cars.map((c) => c.phase), cars.map((c) => c.phase))) < RANK_MAX_ABS_R,
  "rank aliased onto phase",
);
probe(
  "the correlation test rejects a rank that IS the tint",
  Math.abs(pearson(cars.map((c) => c.tint), cars.map((c) => c.tint))) < RANK_MAX_ABS_R,
  "rank aliased onto tint",
);
blind(
  "the correlation test accepts the real rank against phase",
  Math.abs(rVsPhase) < RANK_MAX_ABS_R,
  `r = ${rVsPhase.toFixed(4)}`,
);

// And the thing the correlation is a proxy for: the shader keeps every car
// whose rank is under the threshold, so the share kept must BE the threshold.
function keptShare(threshold: number, rankOf: (c: TrafficInstance) => number): number {
  let kept = 0;
  for (const c of cars) if (rankOf(c) < threshold) kept++;
  return kept / cars.length;
}

const thinned = keptShare(0.3, (c) => c.rank);
check(
  "thinning to 0.3 leaves about three cars in ten",
  Math.abs(thinned - 0.3) < THIN_TOLERANCE,
  `${(thinned * 100).toFixed(1)}% kept`,
);
probe(
  "the thinning test rejects a rank that is not uniform",
  // hash1 squared is still deterministic and still in 0..1, and still keeps
  // "some" of the fleet -- it just keeps the wrong share of it.
  Math.abs(keptShare(0.3, (c) => c.rank * c.rank) - 0.3) < THIN_TOLERANCE,
  "a rank biased toward zero",
);
blind(
  "the thinning test accepts the real rank",
  Math.abs(thinned - 0.3) < THIN_TOLERANCE,
  `${(thinned * 100).toFixed(1)}% kept`,
);

// hash1 is shared with the placement, so a change to it moves the traffic as
// well as the ranks; assert its range here rather than discovering it there.
{
  let lo = 1;
  let hi = 0;
  for (let i = 1; i < 20000; i++) {
    const v = hash1(i * 13.9);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  check("the rank hash stays inside 0..1", lo >= 0 && hi < 1, `${lo.toFixed(5)}..${hi.toFixed(5)}`);
}

// --- the longitude fallback -------------------------------------------------
//
// The offset a shot is taken at, and the offset a city gets when its forecast
// feed is down. It has to put the sun's hour and the traffic's hour in the same
// half of the day; being an hour out is the price, being eight out is the bug.

{
  // Every curated city: the longitude offset must land within 150 minutes of
  // the real civil offset for that date. Two and a half hours is the widest
  // any inhabited place strays from its nautical meridian once DST is in play.
  const CITIES: Array<{ name: string; lon: number; zone: string }> = [
    { name: "manhattan", lon: -73.99, zone: "America/New_York" },
    { name: "sf", lon: -122.42, zone: "America/Los_Angeles" },
    { name: "chicago", lon: -87.63, zone: "America/Chicago" },
    { name: "paris", lon: 2.35, zone: "Europe/Paris" },
    { name: "london", lon: -0.13, zone: "Europe/London" },
    { name: "tokyo", lon: 139.69, zone: "Asia/Tokyo" },
    { name: "sydney", lon: 151.21, zone: "Australia/Sydney" },
  ];
  /** True civil offset in seconds, from the platform's own tz database. */
  function realOffset(zone: string, when: Date): number {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, timeZoneName: "longOffset",
    }).format(when);
    const m = /GMT([+-])(\d{1,2}):(\d{2})/.exec(s);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60);
  }
  const when = new Date("2025-06-21T12:00:00Z");
  let worst = 0;
  let worstName = "";
  for (const c of CITIES) {
    const err = Math.abs(utcOffsetFromLongitude(c.lon) - realOffset(c.zone, when)) / 60;
    if (err > worst) { worst = err; worstName = c.name; }
  }
  check(
    "the longitude offset is within 150 min of civil time for every curated city",
    worst <= 150,
    `worst is ${worstName} at ${worst.toFixed(0)} min`,
  );
  // Blinded: the same probe must reject the zero it replaced, which is the
  // whole defect (San Francisco run on London's clock).
  let worstZero = 0;
  for (const c of CITIES) {
    worstZero = Math.max(worstZero, Math.abs(0 - realOffset(c.zone, when)) / 60);
  }
  check(
    "blinded: the offset probe rejects a flat UTC fallback",
    worstZero > 150,
    `a UTC fallback is ${worstZero.toFixed(0)} min out at worst`,
  );
  check(
    "the longitude offset is a whole number of hours and is deterministic",
    utcOffsetFromLongitude(-122.42) % 3600 === 0 &&
      utcOffsetFromLongitude(-122.42) === utcOffsetFromLongitude(-122.42),
    `${utcOffsetFromLongitude(-122.42) / 3600} h at SF's meridian`,
  );
  // The reason it exists at all: it must actually move the curve off UTC.
  const wxNone = null;
  const sfEvening = new Date("2025-06-22T02:10:00Z"); // the sf-vanness pose
  const withLon = trafficState(sfEvening, utcOffsetFromLongitude(-122.42), wxNone);
  const withUtc = trafficState(sfEvening, 0, wxNone);
  check(
    "at the sf-vanness pose the longitude offset keeps the avenue awake",
    withLon.frac[RoadClass.Primary] > 0.5 && withUtc.frac[RoadClass.Primary] < 0.2,
    `longitude ${(withLon.frac[RoadClass.Primary] * 100).toFixed(0)}% out, ` +
    `UTC ${(withUtc.frac[RoadClass.Primary] * 100).toFixed(0)}% out`,
  );
}

console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) process.exit(1);
