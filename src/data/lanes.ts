// Where the lanes are across a carriageway: the one answer the player's car,
// the moving traffic, the parked cars and the road paint all read.
//
// WHY THIS FILE EXISTS. Three copies of the answer had drifted apart, and the
// owner's report from the Loop at dusk ("why are cars all over the road,
// including the middle of the road") was all three of them disagreeing at once:
//
//   * moving traffic put every two-way street's lanes inside the running half
//     width, and on the commonest street in every pack (7 m kerb to kerb with
//     a 2.0 m parking strip each side) that left 1.5 m a side, so each
//     direction drove 0.5 m off the centreline. Two opposing 1.8 m cars with
//     centres 1.0 m apart overlap by 0.8 m: measured, 648 km of Chicago's
//     1,323 km of trafficked way, 587 km of Manhattan's and 471 km of San
//     Francisco's ran head-on traffic THROUGH itself down the middle.
//   * a one-way laid its lanes out over the right half only, so a four-lane
//     one-way carried two lanes of traffic on its right and none on its left,
//     and a two-lane one-way crowded its single lane onto the centreline.
//   * the player's car used a third formula (kerb lane centre, half a lane in
//     from the parking) that agreed with neither.
//
// THE RULES, decided once here.
//
//   one-way  parking on both sides as roadpack.ts says, and the lanes spread
//            evenly over the WHOLE running surface between them, all in the
//            way's own direction.
//   two-way  the running surface is split down its middle. Each direction
//            needs TWO_WAY_MIN_LANE_M to pass a car coming the other way; a
//            street that cannot give that with parking on both sides keeps
//            its parking on ONE side (the right of the way's vertex order),
//            and one that cannot give it with parking on one side has none.
//            On the 7 m street that is a 2.2 m strip on one side and two
//            2.4 m lanes, which is what a narrow Chicago side street with a
//            row of cars down one kerb actually is.
//
// The painted centre line follows: render/roads.ts paints the double yellow at
// `dividerM` on a two-way and paints none on a one-way, where a yellow line
// down the middle of Seventh Avenue was telling the driver that half of a
// one-way was oncoming traffic.
//
// Offsets are SIGNED, in metres to the RIGHT of the way's own vertex order,
// (-dirZ, dirX) for a unit direction (dirX, dirZ) in this renderer's x-east,
// z-south frame. That one frame is shared by every consumer, so a graph edge
// (which keeps its parent way's vertex order) gets the same lanes as the way.

import {
  MIN_PARKING_STRIP_M,
  PARKING_STRIP_M,
  parkingStripM,
  roadWidthM,
  ROAD_ONEWAY,
  type RoadClass,
} from "./roadpack";

/** Half the width of every car archetype, in metres. A real car is 1.8 wide. */
export const LANE_CAR_HALF_WIDTH_M = 0.9;

/**
 * Narrowest lane a two-way street gives each direction, in metres.
 *
 * A 1.8 m car with 0.3 m each side: two of them pass with 0.6 m between
 * mirrors, which is a slow, careful pass on a real side street and the least
 * room in which two cars do not visibly touch from the driver's seat.
 */
export const TWO_WAY_MIN_LANE_M = 2.4;

/**
 * Narrowest lane a multi-lane carriageway is divided into, in metres.
 *
 * Under roadpack's 3.5 m LANE_WIDTH_M on purpose: the width table counts 3.5 m lanes, and a
 * running surface of 6.1 m between two parking strips is two 3.05 m lanes in
 * any city, not one 6.1 m lane with a car wandering down its middle.
 */
export const MIN_LANE_M = 2.9;

export interface LaneLayout {
  /** Kerb to kerb, metres. */
  widthM: number;
  /** Parking strip on the right (+) and left (-) of the way's vertex order. */
  parkRightM: number;
  parkLeftM: number;
  /** Edges of the running surface, signed (left < right). */
  runLeftM: number;
  runRightM: number;
  /** Lane centres for travel ALONG the way, kerb lane first (most positive). */
  forward: number[];
  /** Lane centres for travel AGAINST it, kerb lane first (most negative).
   *  Empty on a one-way. */
  backward: number[];
  /** Where the two directions meet, signed; null on a one-way. */
  dividerM: number | null;
  /** Width of one lane, metres. */
  laneM: number;
}

interface LaneRoad {
  cls: RoadClass;
  lanes: number;
  flags: number;
}

function spread(from: number, to: number, n: number): number[] {
  // n lanes evenly over [to, from], the first centred nearest `from`.
  const w = (to - from) / n;
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(from + w * (k + 0.5));
  return out;
}

/** The lane layout of one way or graph edge. Pure, and cheap enough to call
 *  per edge per frame, but `laneLayoutCached` is there for the hot paths. */
export function laneLayout(r: LaneRoad): LaneLayout {
  const widthM = roadWidthM(r.cls, r.lanes, r.flags);
  const half = widthM * 0.5;
  const strip = parkingStripM(r);
  const oneway = (r.flags & ROAD_ONEWAY) !== 0;

  if (oneway) {
    const run = Math.max(0, widthM - 2 * strip);
    const n = Math.max(1, Math.floor(run / MIN_LANE_M + 1e-6));
    const right = half - strip;
    const left = -half + strip;
    return {
      widthM, parkRightM: strip, parkLeftM: strip,
      runLeftM: left, runRightM: right,
      forward: spread(right, left, n), backward: [], dividerM: null,
      laneM: run / n,
    };
  }

  let parkRight = strip;
  let parkLeft = strip;
  if (widthM - parkRight - parkLeft < 2 * TWO_WAY_MIN_LANE_M) {
    // One side only, and only if a real car still fits in the strip.
    const one = Math.min(PARKING_STRIP_M, widthM - 2 * TWO_WAY_MIN_LANE_M);
    parkRight = strip > 0 && one >= MIN_PARKING_STRIP_M ? one : 0;
    parkLeft = 0;
  }
  const right = half - parkRight;
  const left = -half + parkLeft;
  const divider = (left + right) * 0.5;
  const perDir = (right - left) * 0.5;
  const n = Math.max(1, Math.floor(perDir / MIN_LANE_M + 1e-6));
  return {
    widthM, parkRightM: parkRight, parkLeftM: parkLeft,
    runLeftM: left, runRightM: right,
    forward: spread(right, divider, n),
    backward: spread(left, divider, n),
    dividerM: divider,
    laneM: perDir / n,
  };
}

const cache = new WeakMap<object, LaneLayout>();

/** laneLayout, memoised on the road object. Roads are immutable once parsed. */
export function laneLayoutCached(r: LaneRoad): LaneLayout {
  let l = cache.get(r);
  if (!l) {
    l = laneLayout(r);
    cache.set(r, l);
  }
  return l;
}

/**
 * The lanes for one direction of travel, as offsets to the RIGHT OF TRAVEL,
 * kerb lane first. Travelling against the way flips the frame, which is what
 * lets a consumer that only knows "which way am I going" use one formula.
 */
export function lanesForTravel(l: LaneLayout, forward: boolean): number[] {
  return forward ? l.forward : l.backward.map((v) => -v);
}

/** Lateral room for a car's centre, right of travel: the running surface. */
export function runningRangeForTravel(l: LaneLayout, forward: boolean): { lo: number; hi: number } {
  const lo = (forward ? l.runLeftM : -l.runRightM) + LANE_CAR_HALF_WIDTH_M;
  const hi = (forward ? l.runRightM : -l.runLeftM) - LANE_CAR_HALF_WIDTH_M;
  return lo <= hi ? { lo, hi } : { lo: (lo + hi) / 2, hi: (lo + hi) / 2 };
}
