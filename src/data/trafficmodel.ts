// How much traffic is on the road right now, and how fast it is going.
//
// WHY THIS IS A MODULATION AND NOT A PLACEMENT. render/traffic.ts caches the
// placed instance buffer per 400 m tile and only re-places when the camera
// crosses a tile boundary. The clock, though, can be dragged continuously by
// the scrubber and runs at 600x in timelapse, so anything that made the number
// of cars a function of time would re-place the whole ring every frame. The
// placement therefore stands at the BUSIEST hour -- which is exactly what the
// TRAFFIC_PER_KM_LANE docstring already claims its figures are -- and this file
// only ever says what fraction of that peak is currently out and how much of
// free-flow speed it is doing. Both are uniforms. Nothing here can move a car
// to a different street.
//
// WHAT THAT CEILING COSTS. A real jam is bumper-to-bumper at about six metres
// of headway, or ~150 cars per kilometre per lane; the placement runs at a
// two-second free-flow headway, which is 34 on a primary. Drawing a true jam
// would be roughly four times the instance budget, so we do not: the model caps
// at the placed free-flow density and expresses congestion by SLOWING the
// stream instead. From the 120 m the renderer is usually flown at, a dense slow
// stream reads as heavy traffic and the missing headway does not.
//
// WEATHER THINS NOTHING. Rain and snow change the speed here and not the count.
// Real wet-weather volume effects are small and mostly a shift in departure
// time, while the speed effect is large and immediate; and a shower that made
// a third of the cars fade out would read as a bug rather than as weather.

import { RoadClass } from "./roadpack";
import type { Weather } from "./weather";

/** Number of RoadClass entries, so nothing downstream hardcodes 14. */
export const CLASS_COUNT = RoadClass.Track + 1;

/** Per-road-class traffic state at an instant. Index by RoadClass. */
export interface TrafficState {
  /** Fraction of the placed (peak) cars that are on the road, 0..1. */
  frac: number[];
  /** Multiplier on free-flow speed, 0..1. */
  speed: number[];
}

/**
 * Hourly share of the day's traffic, normalised so the busiest hour is 1.
 *
 * Shape taken from the FHWA/HPMS hourly distribution factors published with the
 * Highway Performance Monitoring System field manual (the same K-factor tables
 * a state DOT uses to turn an AADT into a design-hour volume): an urban weekday
 * is twin-peaked at about 08:00 and 17:00 with a midday plateau at roughly two
 * thirds of the peak and a trough near 03:00 at five per cent of it.
 *
 * TWO WEEKDAY CURVES, not one. An arterial's day is a commuter's day and shows
 * both peaks hard; a residential street carries local trips all day and its
 * curve is a plateau with bumps on it. The classes in between are a blend, and
 * the blend weight is the only place road class enters the SHAPE.
 */
const WEEKDAY_ARTERIAL = [
  0.10, 0.06, 0.05, 0.05, 0.08, 0.19, 0.45, 0.78,
  0.97, 0.70, 0.60, 0.62, 0.68, 0.68, 0.74, 0.86,
  0.97, 1.00, 0.82, 0.58, 0.44, 0.34, 0.24, 0.15,
];
const WEEKDAY_LOCAL = [
  0.12, 0.08, 0.06, 0.06, 0.09, 0.18, 0.36, 0.60,
  0.74, 0.72, 0.74, 0.78, 0.84, 0.84, 0.86, 0.90,
  0.96, 1.00, 0.94, 0.80, 0.66, 0.52, 0.36, 0.20,
];

/**
 * The weekend, which is one hump and not two.
 *
 * Same source. The commute is gone, so the arterial and the local curve very
 * nearly coincide: everybody is doing the same errands at the same time of day,
 * the morning starts two to three hours later, and the evening decays slowly
 * instead of collapsing after the homebound peak.
 */
const WEEKEND_ARTERIAL = [
  0.22, 0.14, 0.10, 0.07, 0.06, 0.08, 0.15, 0.26,
  0.40, 0.56, 0.72, 0.84, 0.92, 0.96, 1.00, 0.98,
  0.94, 0.90, 0.80, 0.68, 0.58, 0.50, 0.42, 0.32,
];
const WEEKEND_LOCAL = [
  0.20, 0.13, 0.09, 0.07, 0.06, 0.08, 0.14, 0.24,
  0.38, 0.54, 0.70, 0.82, 0.90, 0.94, 0.98, 1.00,
  0.96, 0.92, 0.84, 0.72, 0.62, 0.52, 0.42, 0.30,
];

/**
 * How arterial each class is, 0..1. The one knob road class turns.
 *
 * NON-INCREASING BY CLASS, AND EVERYTHING BELOW IS AN INCREASING FUNCTION OF
 * IT. That is what makes `frac` monotone in class at every hour of every day
 * type by construction rather than by luck, which is the invariant the
 * TRAFFIC_PER_KM_LANE docstring already protects: an arterial that empties
 * faster than the alley behind it reads as a particle system, not as a city.
 * test/trafficmodel.check.ts re-measures it at every hour anyway, because the
 * construction argument only holds while the coefficients below stay in the
 * band it was worked out over.
 *
 * The busway is at the bottom on purpose. Scheduled buses are the most
 * peak-concentrated traffic on any street and there is no such thing as a
 * 03:00 bus lane, so it thins harder than the service road it sits beside in
 * the enum. Its PLACED density is still high (TRAFFIC_PER_KM_LANE), which is
 * where a busway's daytime business shows up.
 */
const ARTERIALNESS: number[] = [
  1.00, // motorway
  0.93, // trunk
  0.85, // primary
  0.74, // secondary
  0.62, // tertiary
  0.46, // residential
  0.46, // unclassified
  0.34, // service
  0.32, // living_street
  0.30, // busway
  0, 0, 0, 0, // pedestrian and below never carry a car
];

/** Blend weight between the local and the arterial hourly curve. */
function shapeMix(a: number): number {
  // Deliberately narrow (0.55..1.00). A wider spread does make the motorway's
  // peaks sharper, but the local curve overtakes the arterial one between 19:00
  // and 21:00, and that crossing is precisely the class inversion the gate
  // forbids. Sharpness is bought only as far as monotonicity allows.
  return 0.55 + 0.45 * a;
}

/** Fraction of the placed cars out at this class's own busiest hour. */
function peakFrac(a: number): number {
  // Only a motorway ever reaches the placed density. A residential street's
  // busiest hour is a good deal quieter than the hour the whole network peaks
  // in, and letting its peak sit below 1 is what leaves room for the arterial
  // to stay above it while still having the sharper curve.
  return 0.86 + 0.14 * a;
}

/** Fraction of the placed cars still out in the small hours. */
function nightFrac(a: number): number {
  // A motorway keeps its freight overnight; a service road is empty. Measured
  // against the target that a 03:00 primary is under fifteen per cent of its
  // peak, which is what the FHWA trough of ~5% of AADT works out to once the
  // peak is normalised to 1.
  return 0.015 + 0.075 * a;
}

/**
 * Volume-to-capacity ratio this class reaches at frac 1.
 *
 * Above 1 on purpose: a peak-hour urban arterial IS oversaturated, which is the
 * whole reason it crawls. Higher classes run closer to and further past their
 * capacity than a residential street ever does, so they congest harder, and
 * that ordering is what makes a jammed motorway and a merely busy side street
 * look like different things from the air.
 */
function saturation(a: number): number {
  return 1.00 + 0.66 * a;
}

/** Standard BPR coefficients (Bureau of Public Roads, 1964), unchanged. */
const BPR_ALPHA = 0.15;
const BPR_BETA = 4;

/**
 * FHWA weather-impact factors on free-flow speed.
 *
 * From the FHWA Road Weather Management "How Do Weather Events Impact Roads"
 * summary: light rain costs 2-13% of free-flow speed, heavy rain 3-16%, and
 * snow 5-40%. The middles of those bands, rounded.
 */
const RAIN_LIGHT = 0.90;
const RAIN_HEAVY = 0.85;
const SNOW = 0.75;
/** mm/h above which rain counts as heavy. 2.5 mm/h is the standard boundary. */
const HEAVY_RAIN_MM_H = 2.5;

/** Sample an hourly curve at a FRACTIONAL hour, wrapping at midnight. */
function sampleHour(curve: readonly number[], hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const t = h - i;
  return curve[i] * (1 - t) + curve[(i + 1) % 24] * t;
}

/** Saturday and Sunday. Not universal, but it is the working week of every city
 *  this renderer ships a pack for. */
function isWeekend(dayOfWeek: number): boolean {
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * How much of a weekend this instant is, 0..1, blended across midnight.
 *
 * A hard switch at 00:00 on Saturday would step the Friday curve (0.17 of peak)
 * onto the Saturday one (0.28) in a single frame, and the shader's duty gate
 * fades a car out over a four per cent band: an eleven per cent step pops.
 * Since the scrubber's range is +/-36 h it crosses a day boundary routinely, so
 * the boundary is an hour-wide crossfade instead of an edge.
 */
function weekendWeight(dayOfWeek: number, hour: number): number {
  const here = isWeekend(dayOfWeek) ? 1 : 0;
  if (hour < 1) {
    const before = isWeekend((dayOfWeek + 6) % 7) ? 1 : 0;
    const w = 0.5 + 0.5 * hour;
    return before * (1 - w) + here * w;
  }
  if (hour > 23) {
    const after = isWeekend((dayOfWeek + 1) % 7) ? 1 : 0;
    const w = 0.5 + 0.5 * (24 - hour);
    return after * (1 - w) + here * w;
  }
  return here;
}

/** Local fractional hour, 0..24, at a UTC instant and a city's offset. */
export function localHour(when: Date, utcOffsetSeconds: number): number {
  const d = new Date(when.getTime() + utcOffsetSeconds * 1000);
  // getUTC*, always. The shifted Date is a local wall clock wearing a UTC
  // label, so reading it with the plain accessors would add the HOST machine's
  // zone on top and put New York's rush hour wherever the viewer happens to be.
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/** Local day of week, 0 = Sunday, at a UTC instant and a city's offset. */
export function localDayOfWeek(when: Date, utcOffsetSeconds: number): number {
  return new Date(when.getTime() + utcOffsetSeconds * 1000).getUTCDay();
}

/** Multiplier the current precipitation puts on every class's speed. */
export function weatherSpeedScale(wx: Weather | null): number {
  if (!wx) return 1;
  if (wx.precipKind === "none" || !(wx.precip > 0)) return 1;
  // A feed that says "rain" at minus two degrees is reporting the phase aloft,
  // not what is on the tarmac, and what is on the tarmac is what slows a car.
  if (wx.precipKind === "snow" || wx.tempC <= 0.5) return SNOW;
  return wx.precip >= HEAVY_RAIN_MM_H ? RAIN_HEAVY : RAIN_LIGHT;
}

/**
 * Traffic volume and speed for every road class at one instant.
 *
 * Pure: no fetch, no DOM, no clock of its own. Cheap enough to call every
 * frame, which is what render/traffic.ts's per-tile placement cache requires of
 * anything time-varying.
 */
export function trafficState(
  when: Date,
  utcOffsetSeconds: number,
  wx: Weather | null,
): TrafficState {
  const hour = localHour(when, utcOffsetSeconds);
  const dow = localDayOfWeek(when, utcOffsetSeconds);
  const weekend = weekendWeight(dow, hour);
  const wet = weatherSpeedScale(wx);

  const arterial =
    sampleHour(WEEKDAY_ARTERIAL, hour) * (1 - weekend) +
    sampleHour(WEEKEND_ARTERIAL, hour) * weekend;
  const local =
    sampleHour(WEEKDAY_LOCAL, hour) * (1 - weekend) +
    sampleHour(WEEKEND_LOCAL, hour) * weekend;

  const frac: number[] = [];
  const speed: number[] = [];
  for (let c = 0; c < CLASS_COUNT; c++) {
    if (c >= RoadClass.Pedestrian) {
      // Nothing drives here, nothing is placed here, and the shader never
      // indexes these. Speed 1 rather than 0 so a stray reader cannot divide
      // by it or stop a clock with it.
      frac.push(0);
      speed.push(1);
      continue;
    }
    const a = ARTERIALNESS[c];
    const mix = shapeMix(a);
    const shape = local * (1 - mix) + arterial * mix;
    const lo = nightFrac(a);
    const hi = peakFrac(a);
    const f = Math.min(1, Math.max(0, lo + (hi - lo) * shape));
    const vc = f * saturation(a);
    frac.push(f);
    speed.push(wet / (1 + BPR_ALPHA * Math.pow(vc, BPR_BETA)));
  }
  return { frac, speed };
}
