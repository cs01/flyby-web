// Get-there missions: reach a real place across the city by any ground means,
// walking, driving, or riding the real timetabled bus, train or ferry.
//
// The timetable is the level design. A mission is only a destination and a
// clock; whether the 3:50 ferry is still in the slip is decided by the real
// schedule, so the same mission is a different puzzle every hour. Flying is
// the one thing that does not count: from the air every mission is a straight
// line, so taking off voids the run.
//
// Pure (no THREE, no DOM) so test/mission.check.ts can drive it.

export type Leg = "walk" | "car" | "ride" | "plane" | "drone";

export interface Dest {
  name: string;
  x: number;
  z: number;
}

export interface MissionSpec {
  dest: Dest;
  startX: number;
  startZ: number;
  distM: number;
  /** Target time, seconds: three stars at or under it. */
  parS: number;
}

export const MIN_MISSION_M = 1200;
export const MAX_MISSION_M = 6000;
/** Close enough to count as there: a stop's platform or a landmark's forecourt. */
export const ARRIVE_M = 45;

/**
 * Par assumes a mix of walking to a stop and riding: about 4.5 m/s door to
 * door over straight-line distance, plus two minutes of waiting. Pure walking
 * (1.4 m/s) misses it on anything over a kilometre or so, which is the point:
 * the fast answer is to catch the right vehicle.
 */
export function parFor(distM: number): number {
  return Math.round(distM / 4.5 + 120);
}

/** A destination between MIN and MAX away, or null when nothing qualifies. */
export function pickMission(
  dests: readonly Dest[],
  x: number,
  z: number,
  rand: () => number,
  standable: (x: number, z: number) => boolean = () => true,
): MissionSpec | null {
  const ok = dests.filter((d) => {
    const r = Math.hypot(d.x - x, d.z - z);
    return r >= MIN_MISSION_M && r <= MAX_MISSION_M && standable(d.x, d.z);
  });
  if (!ok.length) return null;
  const dest = ok[Math.min(ok.length - 1, Math.floor(rand() * ok.length))];
  const distM = Math.hypot(dest.x - x, dest.z - z);
  return { dest, startX: x, startZ: z, distM, parS: parFor(distM) };
}

export function stars(elapsedS: number, parS: number): number {
  return elapsedS <= parS ? 3 : elapsedS <= parS * 1.5 ? 2 : 1;
}

export type MissionState = "running" | "arrived" | "void";

export class Mission {
  elapsedS = 0;
  state: MissionState = "running";
  /** Seconds spent per mode, in the order first used. */
  readonly legs = new Map<Leg, number>();

  constructor(readonly spec: MissionSpec) {}

  distanceTo(x: number, z: number): number {
    return Math.hypot(this.spec.dest.x - x, this.spec.dest.z - z);
  }

  update(dt: number, leg: Leg, x: number, z: number): MissionState {
    if (this.state !== "running") return this.state;
    if (leg === "plane" || leg === "drone") {
      this.state = "void";
      return this.state;
    }
    this.elapsedS += dt;
    this.legs.set(leg, (this.legs.get(leg) ?? 0) + dt);
    if (this.distanceTo(x, z) <= ARRIVE_M) this.state = "arrived";
    return this.state;
  }
}
