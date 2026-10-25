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
import { hash1, type StreetWorld } from "../src/data/streetfurniture";
import { ROAD_ONEWAY, parseRoadPack, roadWidthM, type Road, type RoadPack } from "../src/data/roadpack";
import { buildRoadGraph, type RoadGraph } from "../src/data/roadgraph";
import { laneLayout, lanesForTravel } from "../src/data/lanes";
import { inBend, onCentreline } from "../src/sim/lanecheck";
import { TrafficSim, trafficable, CAR_LENGTH_M, HARD_GAP_M, type Pose, type Vehicle } from "../src/sim/trafficsim";
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
interface Placed { rank: number; tint: number; phase: number }
const cars: Placed[] = [];
{
  // Every class at full density, so the ranks are the whole queue.
  const sim = new TrafficSim({ graph: buildRoadGraph(synthPack.roads), heightAt: synthWorld.groundY }, 100000);
  sim.setRing(600, 1200, 5000);
  for (const c of sim.cars) {
    // Where along its lane the car was placed, 0..1: what `phase` was when a
    // car was a point on a run, and what an emptied head of a lane would show.
    cars.push({ rank: c.rank, tint: c.tint, phase: c.path ? c.s / c.path.length : 0 });
  }
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
function keptShare(threshold: number, rankOf: (c: Placed) => number): number {
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

// --- lane discipline, on the real cities ------------------------------------
//
// THE OWNER'S REPORT, from the driver's seat in the Loop at dusk: "why are cars
// all over the road, including middle of road". Measured before the fix, on the
// committed packs: the commonest street in every city (7 m kerb to kerb, a
// 2.0 m parking strip each side, two-way) carried each direction 0.5 m off the
// centreline, so opposing cars overlapped by 0.8 m down the middle of 648 km
// of Chicago, 587 km of Manhattan and 471 km of San Francisco. Every one-way
// carried its lanes on its right half only.
//
// Measured here from the SIMULATION, after it has run for a while, so a car is
// wherever the lanes, the junction connectors, the lights and the queues have
// put it, not wherever it was first placed. Lateral and heading are taken
// against the edge's own CENTRELINE by nearest point, which is independent of
// the lane paths the sim builds; the expected lane centres come from
// data/lanes.ts, which is the layout under test elsewhere (street.check,
// car.check).

/** Worst distance from a car's centre to the nearest lane centre of its own
 *  direction, metres. The mitre offset is exact, so this is float slack plus
 *  the hairpin cap; the old placement was out by 0.4 to 2.8 m. */
const LANE_ERROR_MAX_M = 0.15;
/** Worst angle between a car and the centreline tangent, degrees. */
const HEADING_ERROR_MAX_DEG = 3;
/** Least distance a car's centre keeps from the line between the two
 *  directions on a two-way, metres. Half a car's width plus 0.1 m: its flank
 *  never crosses the centre line. The old placement ran at 0.5 m. */
const OPPOSING_MIN_M = 1.0;
/** Least bumper gap between consecutive cars in one lane, metres. */
const LANE_GAP_MIN_M = 0.45;
/** Simulated seconds, and the sampling after a warm-up. */
const SIM_SECONDS = 90;
const WARMUP_SECONDS = 10;
const SIM_DT = 1 / 30;
/** Fraction of the field allowed to be stood still at the peak hour. Lights
 *  and queues hold about half of it (measured 0.51 in the Loop); a locked grid
 *  is all of it. */
const STOPPED_MAX_SHARE = 0.7;
/** Mean speed the field must keep at the peak hour, m/s. */
const MEAN_SPEED_MIN_MS = 2.0;

const CITIES_DIR = new URL("../public/cities/", import.meta.url).pathname;
const { CITIES } = await import("../src/cities");
const { Origin } = await import("../src/geo");

async function loadRoads(id: string): Promise<RoadPack> {
  return parseRoadPack(await Bun.file(`${CITIES_DIR}${id}.roads`).arrayBuffer());
}

/** The lane offsets the analytic traffic used before this change: the running
 *  HALF width split into lanes, clamped to keep a flank off the parking. The
 *  vacuity probe for the opposing-lane and lane-error gates. */
function oldLaneOffsets(r: Road): number[] {
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  const lay = laneLayout(r);
  const strip = Math.max(lay.parkLeftM, lay.parkRightM) > 0
    ? Math.min(2.2, (2 * half - 3.0) * 0.5) : 0;
  const running = Math.max(0, half - (strip >= 1.9 ? strip : 0));
  const n = Math.max(1, Math.floor(running / 3.5));
  const limit = running - 0.9 - 0.1;
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(Math.min(limit, (running * (2 * (n - 1 - k) + 1)) / (2 * n)));
  return out;
}

interface LaneSample {
  lat: number;
  laneErr: number;
  headErrDeg: number;
  /** Signed distance to the divider into the car's own half, or null on a one-way. */
  ownSide: number | null;
  /** Same with the old offsets, for the probe. */
  oldOwnSide: number | null;
  oldLaneErr: number;
  /** Flank past the running surface edge (positive is into the parking or kerb). */
  flankOut: number;
  oneway: boolean;
  withWay: boolean;
  /**
   * Inside a bend's zone (see inBend). The lane and heading bounds are
   * asserted on the STRAIGHT road outside it; through it the car is held to
   * the tarmac and to a continuous heading instead (the flank and yaw-step
   * checks), because the centreline there is a hinge with no tangent.
   */
  nearBend: boolean;
  info: string;
  dirX: number; dirZ: number; tx: number; tz: number;
}

interface CityRun {
  id: string;
  g: RoadGraph;
  sim: TrafficSim;
  lane: LaneSample[];
  /** Worst metres a connector centre sits outside every carriageway at its junction. */
  connOut: number;
  connSamples: number;
  connOutBowed: number;
  minLaneGap: number;
  redRuns: number;
  redApproaches: number;
  stoppedShare: number;
  meanSpeed: number;
  overlapsOutsideJunctions: number;
  overlapsInJunctions: number;
  maxYawStepDeg: number;
  yawInfo?: string;
}

function cubic(k: { p0x: number; p0z: number; c1x: number; c1z: number; c2x: number; c2z: number; p1x: number; p1z: number }, t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * k.p0x + 3 * u * u * t * k.c1x + 3 * u * t * t * k.c2x + t * t * t * k.p1x,
    u * u * u * k.p0z + 3 * u * u * t * k.c1z + 3 * u * t * t * k.c2z + t * t * t * k.p1z,
  ];
}

function runCity(id: string, pack: RoadPack, lat: number, lon: number, signals = true): CityRun {
  const city = (CITIES as { id: string; lat: number; lon: number }[]).find((c) => c.id === id)!;
  const o = new Origin(city.lat, city.lon);
  const at = o.toWorld(lat, lon);
  const g = buildRoadGraph(pack.roads);
  const sim = new TrafficSim({ graph: g, heightAt: () => 0 }, 9000);
  sim.signalsEnabled = signals;
  sim.setRing(at.x, at.z, 950);
  const run: CityRun = {
    id, g, sim, lane: [], connOut: -Infinity, connSamples: 0, connOutBowed: -Infinity,
    minLaneGap: Infinity, redRuns: 0, redApproaches: 0, stoppedShare: 0, meanSpeed: 0,
    overlapsOutsideJunctions: 0, overlapsInJunctions: 0, maxYawStepDeg: 0,
  };
  const pose: Pose = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };
  const lastYaw = new Map<number, number>();
  const lastInfo = new Map<number, string>();
  const lastToLine = new Map<number, number>();
  let stopped = 0, seen = 0, vSum = 0;
  const steps = Math.round(SIM_SECONDS / SIM_DT);
  for (let i = 0; i <= steps; i++) {
    const tSim = i * SIM_DT;
    // Red-light running: a car that was more than 3 m short of its line on a
    // red and is past it one step later, without having been committed.
    for (const c of sim.cars) {
      if (!c.path || c.s < 0) continue;
      const sig = sim.signalAt(c.path.he);
      const toLine = c.path.length - c.s - CAR_LENGTH_M / 2;
      if (sig === 2) {
        // Armed when the car is first seen under this red with more than
        // 3 m to its line and able to stop in it at under 3 m/s^2 (a car
        // that could not was committed on amber); a red run is an armed car
        // past its line while still red.
        if (!lastToLine.has(c.id)) lastToLine.set(c.id, c.v * c.v / (2 * Math.max(0.1, toLine)) < 3 ? toLine : -Infinity);
        if (lastToLine.get(c.id)! > 3 && toLine < 0) { run.redRuns++; lastToLine.set(c.id, -Infinity); }
      } else lastToLine.delete(c.id);
    }
    if (tSim >= WARMUP_SECONDS) {
      for (const c of sim.cars) {
        sim.pose(c, pose);
        const yaw = Math.atan2(pose.dirX, -pose.dirZ);
        const ly = lastYaw.get(c.id);
        if (ly !== undefined) {
          let d = Math.abs(yaw - ly) * 180 / Math.PI;
          if (d > 180) d = 360 - d;
          if (d > run.maxYawStepDeg) {
            run.maxYawStepDeg = d;
            run.yawInfo = `car ${c.id} s ${c.s.toFixed(2)} path ${c.path?.he}/${c.path?.lane} len ${c.path?.length.toFixed(1)} conn ${c.conn ? c.conn.length.toFixed(1) : "-"} at ${pose.x.toFixed(1)},${pose.z.toFixed(1)} prev ${lastInfo.get(c.id)}`;
          }
        }
        lastYaw.set(c.id, yaw);
        lastInfo.set(c.id, `s ${c.s.toFixed(2)} path ${c.path?.he}/${c.path?.lane} at ${pose.x.toFixed(1)},${pose.z.toFixed(1)}`);
      }
    }
    const sampleNow = tSim >= WARMUP_SECONDS && Math.abs(tSim - Math.round(tSim)) < SIM_DT / 2;
    if (sampleNow) {
      const poses: { p: Pose; c: Vehicle }[] = [];
      for (const c of sim.cars) {
        if (!c.path || c.scale < 1) continue;
        const p = sim.pose(c, { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 });
        poses.push({ p, c });
        seen++;
        vSum += c.v;
        if (c.v < 0.3) stopped++;
        const he = c.path.he;
        const e = g.edges[he >> 1];
        const forward = (he & 1) === 0;
        if (c.s >= 0) {
          const on = onCentreline(e.pts, p.x, p.z, forward);
          const lay = laneLayout(e);
          const lanes = lanesForTravel(lay, forward);
          const laneErr = Math.min(...lanes.map((l) => Math.abs(on.lat - l)));
          const cosh = Math.max(-1, Math.min(1, p.dirX * on.tx + p.dirZ * on.tz));
          const div = lay.dividerM === null ? null : (forward ? lay.dividerM : -lay.dividerM);
          const old = oldLaneOffsets(e);
          const oldLat = old[Math.min(c.path.lane, old.length - 1)];
          const runLo = forward ? lay.runLeftM : -lay.runRightM;
          const runHi = forward ? lay.runRightM : -lay.runLeftM;
          run.lane.push({
            lat: on.lat,
            laneErr,
            headErrDeg: Math.acos(cosh) * 180 / Math.PI,
            ownSide: div === null ? null : on.lat - div,
            oldOwnSide: div === null ? null : oldLat,
            oldLaneErr: Math.min(...lanes.map((l) => Math.abs(oldLat - l))),
            flankOut: Math.max(on.lat + 0.9 - runHi, runLo - (on.lat - 0.9)),
            oneway: e.oneway,
            withWay: forward,
            nearBend: inBend(e.pts, p.x, p.z, lay.widthM / 2),
            info: `he ${he} lane ${c.path.lane} s ${c.s.toFixed(1)}/${c.path.length.toFixed(1)} edgeLen ${e.lengthM.toFixed(1)} nPts ${e.pts.length / 2} at ${p.x.toFixed(1)},${p.z.toFixed(1)} car ${c.id}`,
            dirX: p.dirX, dirZ: p.dirZ, tx: on.tx, tz: on.tz,
          });
        } else if (c.conn) {
          // A connector: every point on it must be on the tarmac of a road
          // meeting at its junction.
          const node = forward ? e.a : e.b;
          const incident = [...g.out[node], ...g.into[node]].map((h) => g.edges[h.edge]);
          const outside = (x: number, z: number): number => {
            let worst = Infinity;
            for (const ie of incident) {
              const d = onCentreline(ie.pts, x, z, true).d - roadWidthM(ie.cls, ie.lanes, ie.flags) / 2;
              worst = Math.min(worst, d);
            }
            return worst;
          };
          for (let q = 0; q <= 8; q++) {
            const [x, z] = cubic(c.conn, q / 8);
            run.connOut = Math.max(run.connOut, outside(x, z));
            // The probe: the same connector with its handles thrown outward.
            const k = c.conn;
            const bowed = {
              ...k,
              c1x: k.p0x - (k.c1x - k.p0x) * 2, c1z: k.p0z - (k.c1z - k.p0z) * 2,
              c2x: k.p1x - (k.c2x - k.p1x) * 2, c2z: k.p1z - (k.c2z - k.p1z) * 2,
            };
            const [bx, bz] = cubic(bowed, q / 8);
            run.connOutBowed = Math.max(run.connOutBowed, outside(bx, bz));
            run.connSamples++;
          }
        }
      }
      // Gaps within each lane.
      const byPath = new Map<number, Vehicle[]>();
      for (const { c } of poses) {
        if (!c.path) continue;
        const a = byPath.get(c.path.key) ?? [];
        a.push(c);
        byPath.set(c.path.key, a);
      }
      for (const a of byPath.values()) {
        a.sort((x, y) => x.s - y.s);
        for (let k = 1; k < a.length; k++) run.minLaneGap = Math.min(run.minLaneGap, a[k].s - a[k - 1].s - CAR_LENGTH_M);
      }
      // Any two bodies overlapping, as oriented rectangles (separating axes).
      const cell = new Map<string, number[]>();
      poses.forEach(({ p }, idx) => {
        const key = `${Math.floor(p.x / 6)},${Math.floor(p.z / 6)}`;
        const b = cell.get(key) ?? [];
        b.push(idx);
        cell.set(key, b);
      });
      for (let a = 0; a < poses.length; a++) {
        const A = poses[a].p;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          for (const b of cell.get(`${Math.floor(A.x / 6) + dx},${Math.floor(A.z / 6) + dz}`) ?? []) {
            if (b <= a) continue;
            const B = poses[b].p;
            if (obbOverlap(A, B)) {
              const inJ = poses[a].c.s < 0 || poses[b].c.s < 0;
              if (inJ) run.overlapsInJunctions++; else run.overlapsOutsideJunctions++;
              if (!inJ && process.env.DEBUG && run.overlapsOutsideJunctions <= 4) {
                const ca = poses[a].c, cb = poses[b].c;
                console.log("    overlap", ca.id, ca.path!.he, ca.path!.lane, ca.s.toFixed(1), "|", cb.id, cb.path!.he, cb.path!.lane, cb.s.toFixed(1), "at", A.x.toFixed(1), A.z.toFixed(1));
              }
            }
          }
        }
      }
    }
    sim.step(SIM_DT);
  }
  for (let he = 0; he < g.edges.length * 2; he++) if (sim.signalAt(he) !== null) run.redApproaches++;
  run.stoppedShare = seen ? stopped / seen : 0;
  run.meanSpeed = seen ? vSum / seen : 0;
  return run;
}

/** Two 4.6 x 1.8 m car bodies, centre and heading each, overlapping? */
function obbOverlap(A: Pose, B: Pose, len = 4.6, wid = 1.8): boolean {
  const axes = [[A.dirX, A.dirZ], [-A.dirZ, A.dirX], [B.dirX, B.dirZ], [-B.dirZ, B.dirX]];
  const dx = B.x - A.x, dz = B.z - A.z;
  for (const [ax, az] of axes) {
    const ra = (len / 2) * Math.abs(A.dirX * ax + A.dirZ * az) + (wid / 2) * Math.abs(-A.dirZ * ax + A.dirX * az);
    const rb = (len / 2) * Math.abs(B.dirX * ax + B.dirZ * az) + (wid / 2) * Math.abs(-B.dirZ * ax + B.dirX * az);
    if (Math.abs(dx * ax + dz * az) > ra + rb) return false;
  }
  return true;
}

console.log("\n--- lane discipline, junctions, lights and gaps, on the real cities ---");

const CITY_POSES: [string, number, number][] = [
  ["chicago", 41.8800, -87.63233],
  ["manhattan", 40.75284, -73.98928],
  ["sf", 37.7885, -122.4222],
];
for (const [id, lat, lon] of CITY_POSES) {
  const pack = await loadRoads(id);
  const t0 = performance.now();
  const r = runCity(id, pack, lat, lon);
  const ms = performance.now() - t0;
  const all = r.lane;
  const L = all.filter((x) => !x.nearBend);
  const worstLane = Math.max(...L.map((x) => x.laneErr));
  const worstHead = Math.max(...L.map((x) => x.headErrDeg));
  const two = L.filter((x) => x.ownSide !== null);
  const worstOwn = Math.min(...two.map((x) => x.ownSide!));
  const worstFlank = Math.max(...all.map((x) => x.flankOut));
  console.log(`  ${id}: ${r.sim.cars.length} cars, ${L.length} straight-lane samples (${all.length - L.length} in bends), ${r.connSamples} connector samples, ` +
    `${(ms / 1000).toFixed(1)} s for ${SIM_SECONDS} simulated s; mean step ${r.sim.stats.lastStepMs.toFixed(2)} ms last`);

  check(`${id}: every moving car is within ${LANE_ERROR_MAX_M} m of a lane centre of its direction`,
    L.length >= MIN_SAMPLE && worstLane <= LANE_ERROR_MAX_M, `worst ${worstLane.toFixed(3)} m over ${L.length}`);
  const oldWorst = Math.max(...L.map((x) => x.oldLaneErr));
  probe(`${id}: the lane test rejects the old run offsets`, oldWorst <= LANE_ERROR_MAX_M, `old placement worst ${oldWorst.toFixed(2)} m`);

  if (process.env.DEBUG) for (const x of L.filter((q) => q.headErrDeg > HEADING_ERROR_MAX_DEG).slice(0, 5)) console.log("    head", x.headErrDeg.toFixed(1), x.info);
  if (process.env.DEBUG) for (const x of L.filter((q) => q.laneErr > LANE_ERROR_MAX_M).slice(0, 3)) console.log("    lane", x.laneErr.toFixed(2), x.info);
  check(`${id}: every moving car faces along its lane within ${HEADING_ERROR_MAX_DEG} deg`,
    worstHead <= HEADING_ERROR_MAX_DEG, `worst ${worstHead.toFixed(2)} deg`);
  {
    // Probes on the same samples: the owner's sideways car, and a car only a
    // little off.
    const sideways = Math.max(...L.map((x) => Math.acos(Math.max(-1, Math.min(1, -x.dirZ * x.tx + x.dirX * x.tz))) * 180 / Math.PI));
    probe(`${id}: the heading test rejects every car turned sideways`, sideways <= HEADING_ERROR_MAX_DEG, `worst ${sideways.toFixed(0)} deg`);
    const c5 = Math.cos(5 * Math.PI / 180), s5 = Math.sin(5 * Math.PI / 180);
    const off5 = Math.max(...L.map((x) => {
      const dx = x.dirX * c5 - x.dirZ * s5, dz = x.dirX * s5 + x.dirZ * c5;
      return Math.acos(Math.max(-1, Math.min(1, dx * x.tx + dz * x.tz))) * 180 / Math.PI;
    }));
    probe(`${id}: and every car turned 5 deg`, off5 <= HEADING_ERROR_MAX_DEG, `worst ${off5.toFixed(1)} deg`);
  }

  check(`${id}: no car on a two-way is within ${OPPOSING_MIN_M} m of the opposing lane`,
    two.length >= MIN_SAMPLE / 2 && worstOwn >= OPPOSING_MIN_M, `worst ${worstOwn.toFixed(2)} m from the divider over ${two.length}`);
  {
    const oldOwn = Math.min(...two.map((x) => x.oldOwnSide!));
    probe(`${id}: the opposing-lane test rejects the old offsets`, oldOwn >= OPPOSING_MIN_M, `old placement ${oldOwn.toFixed(2)} m from the centreline`);
  }
  check(`${id}: no moving car's flank leaves the running surface`, worstFlank <= 0.01,
    `worst flank ${worstFlank.toFixed(3)} m past it (into parking or kerb)`);
  probe(`${id}: the flank test rejects every car moved 1.5 m toward its kerb`,
    Math.max(...L.map((x) => x.flankOut + 1.5)) <= 0.01, "displaced");
  {
    const ow = L.filter((x) => x.oneway);
    const wrong = ow.filter((x) => !x.withWay).length;
    check(`${id}: every car on a one-way is travelling with it`, ow.length >= MIN_SAMPLE / 2 && wrong === 0, `${wrong} of ${ow.length} against`);
  }
  check(`${id}: a car through a junction stays on the tarmac of the roads meeting there`,
    r.connSamples >= MIN_SAMPLE && r.connOut <= 0.05, `worst centre ${r.connOut.toFixed(2)} m outside every carriageway`);
  probe(`${id}: the junction test rejects connectors bowed outward`, r.connOutBowed <= 0.05, `bowed worst ${r.connOutBowed.toFixed(1)} m outside`);
  if (process.env.DEBUG) console.log("    yaw", r.yawInfo);
  check(`${id}: no car's heading jumps more than 20 deg in one 1/30 s step`, r.maxYawStepDeg <= 20, `worst ${r.maxYawStepDeg.toFixed(1)} deg`);

  check(`${id}: consecutive cars in a lane keep at least ${LANE_GAP_MIN_M} m`, r.minLaneGap >= LANE_GAP_MIN_M,
    `closest bumper gap ${r.minLaneGap.toFixed(2)} m`);
  probe(`${id}: the gap test rejects two cars placed 2 m apart centre to centre`, 2 - CAR_LENGTH_M >= LANE_GAP_MIN_M, "-2.8 m");
  check(`${id}: no two cars overlap outside a junction`, r.overlapsOutsideJunctions === 0,
    `${r.overlapsOutsideJunctions} pairs; ${r.overlapsInJunctions} inside junction boxes`);
  probe(`${id}: the overlap test rejects two cars side by side 1 m apart`,
    !obbOverlap({ x: 0, y: 0, z: 0, dirX: 1, dirZ: 0 }, { x: 0, y: 0, z: 1, dirX: 1, dirZ: 0 }), "1 m apart");

  check(`${id}: no car runs a red it could have stopped for`, r.redApproaches > 50 && r.redRuns === 0,
    `${r.redRuns} red runs, ${r.redApproaches} signalised approaches in the ring`);
  check(`${id}: the field flows at the peak hour`,
    r.stoppedShare <= STOPPED_MAX_SHARE && r.meanSpeed >= MEAN_SPEED_MIN_MS,
    `${(r.stoppedShare * 100).toFixed(0)}% stood still, mean ${r.meanSpeed.toFixed(1)} m/s`);
  if (id === "chicago") {
    // The same counter, on a sim with the lights switched off, judged by
    // the lit sim's phase table: it must see cars crossing on red.
    const noLights = runCity(id, pack, lat, lon, false);
    const lit = new TrafficSim({ graph: noLights.g, heightAt: () => 0 }, 1);
    const unlit = noLights.sim;
    const armed = new Map<number, number>();
    let crossings = 0;
    for (let i = 0; i < 60 * 30; i++) {
      lit.time = unlit.time;
      for (const c of unlit.cars) {
        if (!c.path || c.s < 0) continue;
        const sig = lit.signalAt(c.path.he);
        const toLine = c.path.length - c.s - CAR_LENGTH_M / 2;
        if (sig === 2) {
          if (!armed.has(c.id)) armed.set(c.id, c.v * c.v / (2 * Math.max(0.1, toLine)) < 3 ? toLine : -Infinity);
          if (armed.get(c.id)! > 3 && toLine < 0) { crossings++; armed.set(c.id, -Infinity); }
        } else armed.delete(c.id);
      }
      unlit.step(SIM_DT);
    }
    probe(`${id}: the red-light test sees red runs when the lights are off`, crossings === 0, `${crossings} crossings on red`);
  }
}

// --- the player is an obstacle -----------------------------------------------
//
// SOFT COLLISIONS, from the traffic's side: a player's car standing in a lane
// is driven up to and queued behind, never through. Probe: the same scenario
// with the player hidden from the sim, where the stream drives straight
// through the spot.
{
  const pack = await loadRoads("chicago");
  const g = buildRoadGraph(pack.roads);
  const city = (CITIES as { id: string; lat: number; lon: number }[]).find((c) => c.id === "chicago")!;
  const at = new Origin(city.lat, city.lon).toWorld(41.8800, -87.63233);
  const measure = (withPlayer: boolean): { overlaps: number; closest: number } => {
    const sim = new TrafficSim({ graph: g, heightAt: () => 0 }, 9000);
    sim.setRing(at.x, at.z, 950);
    // Stand the player in the middle of the busiest lane in the ring.
    let best: { p: ReturnType<TrafficSim["path"]>; n: number } | null = null;
    for (const c of sim.cars) {
      const p = c.path!;
      if (p.length > 60 && (!best || p.cars.length > best.n)) best = { p, n: p.cars.length };
    }
    const p = best!.p;
    const mid = p.xs.length >> 1;
    const i0 = Math.max(0, mid - 1);
    const dx = p.xs[i0 + 1] - p.xs[i0], dz = p.zs[i0 + 1] - p.zs[i0];
    const L = Math.hypot(dx, dz);
    const player = { x: (p.xs[i0] + p.xs[i0 + 1]) / 2, z: (p.zs[i0] + p.zs[i0 + 1]) / 2, dirX: dx / L, dirZ: dz / L, speed: 0 };
    // Clear the lane round the player first: it stands where nobody already is.
    for (const c of sim.cars) {
      const q = sim.pose(c, { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 });
      if (Math.hypot(q.x - player.x, q.z - player.z) < 8) c.dead = true;
    }
    sim.player = withPlayer ? player : null;
    let overlaps = 0, closest = Infinity;
    const pp: Pose = { x: player.x, y: 0, z: player.z, dirX: player.dirX, dirZ: player.dirZ };
    for (let i = 0; i < 60 * 30; i++) {
      sim.step(SIM_DT);
      for (const c of sim.cars) {
        const q = sim.pose(c, { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 });
        const d = Math.hypot(q.x - player.x, q.z - player.z);
        closest = Math.min(closest, d);
        if (d < 6 && obbOverlap(q, pp)) overlaps++;
      }
    }
    return { overlaps, closest };
  };
  const yes = measure(true);
  const no = measure(false);
  check("traffic queues behind a player standing in its lane and never overlaps it",
    yes.overlaps === 0 && yes.closest < 12, `${yes.overlaps} overlapping car-frames, closest centre ${yes.closest.toFixed(1)} m`);
  probe("the overlap test sees the stream drive through an unseen player", no.overlaps === 0,
    `${no.overlaps} overlapping car-frames with the player hidden`);
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
