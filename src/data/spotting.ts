// Plane spotting: the rules of the game, with no DOM and no three.js so
// test/spotting.check.ts can hold them.
//
// The game is a camera, not a gun. Find a real aircraft, get close, put it in
// the middle of the frame and hold it there for a second: that is a photo,
// and the airframe goes in the logbook. Each airframe (ICAO hex) counts once,
// ever; rarer types score more.

/** How long the target must stay framed to take the photo. */
export const HOLD_S = 1.0;
/**
 * A wobble shorter than this does not reset the hold. One thumb chasing a
 * helicopter crosses the frame edge for a frame or two at a time; resetting
 * on every one made a held shot impossible on a phone.
 */
export const GRACE_S = 0.25;
/** Base spotting range, metres, for an airliner-sized span (36 m). */
export const SPOT_RANGE_M = 1500;
/** Half-size of the centre box, in normalised device coordinates. */
export const CENTRE_NDC = 0.4;

export interface Framing {
  /** Camera to aircraft, metres. */
  distM: number;
  /** Wingspan (or rotor diameter), metres. */
  spanM: number;
  /** Projected position, -1..1 across the screen; z in -1..1 is in front. */
  ndcX: number;
  ndcY: number;
  ndcZ: number;
}

/**
 * The range a photo counts at. Scales with span, so a 65 m 777 can be spotted
 * from 2.7 km and a 10 m Cessna has to be closed to 1.5 km, the same apparent
 * size give or take; never under the base range, because a small aircraft at
 * 1.5 km is already a hard catch.
 */
export function spotRangeM(spanM: number): number {
  return SPOT_RANGE_M * Math.max(1, spanM / 36);
}

/** Whether this frame counts toward the photo. */
export function framed(f: Framing): boolean {
  return (
    f.ndcZ > -1 && f.ndcZ < 1 &&
    Math.abs(f.ndcX) < CENTRE_NDC && Math.abs(f.ndcY) < CENTRE_NDC &&
    f.distM <= spotRangeM(f.spanM)
  );
}

/** The one-second hold, with a grace for wobble. */
export class Hold {
  /** 0..1 toward the shutter. */
  progress = 0;
  private lost = 0;

  /** Advance by `dt`; returns true on the frame the photo is taken. */
  update(dt: number, ok: boolean): boolean {
    if (ok) {
      this.lost = 0;
      this.progress = Math.min(1, this.progress + dt / HOLD_S);
      if (this.progress >= 1) {
        this.progress = 0;
        return true;
      }
    } else {
      this.lost += dt;
      if (this.lost > GRACE_S) this.progress = 0;
    }
    return false;
  }

  reset(): void {
    this.progress = 0;
    this.lost = 0;
  }
}

// --- rarity -----------------------------------------------------------------

export type Tier = "common" | "uncommon" | "rare" | "legendary";
export const TIER_POINTS: Record<Tier, number> = { common: 10, uncommon: 25, rare: 60, legendary: 150 };

const LEGENDARY_TYPES = new Set(["A388", "B741", "B742", "B743", "B744", "B748", "B74S", "B74F", "B779", "B778", "A225", "AN22", "C5M", "B52", "CONC", "B29", "DC3", "DC6", "C47", "B17"]);
const RARE_TYPES = new Set(["A35K", "A346", "A345", "A343", "A342", "B77L", "B77F", "MD11", "B762", "B764", "B753", "A310", "A306", "A30B", "DC10", "C130", "C30J", "K35R", "KC46", "P8", "E3TF", "V22", "H47", "H53"]);
const UNCOMMON_TYPES = new Set(["B772", "B773", "B77W", "B788", "B789", "B78X", "A332", "A333", "A338", "A339", "A359", "B763", "B752", "DH8D", "AT72", "AT76", "C208", "PC12"]);

export interface Identity {
  hex: string;
  type: string;
  cat: string;
  reg: string;
  mil?: boolean;
}

/**
 * Rarity from what is in the feed. Famous registrations (the planes server's
 * /api/famous list) and military aircraft are legendary whatever their type;
 * helicopters and business jets are rare-ish because over a city they are
 * small, fast to leave and hard to frame.
 */
export function rarityOf(a: Identity, famous: ReadonlySet<string>): Tier {
  const t = a.type.toUpperCase();
  if (famous.has(a.reg.toUpperCase()) || a.mil || LEGENDARY_TYPES.has(t)) return "legendary";
  if (RARE_TYPES.has(t) || a.cat === "A7") return "rare";
  if (UNCOMMON_TYPES.has(t) || a.cat === "A2" || a.cat === "A5") return "uncommon";
  return "common";
}

// --- logbook ------------------------------------------------------------------

export interface Spot {
  hex: string;
  flight: string;
  reg: string;
  type: string;
  desc: string;
  /** ICAO airline prefix ("DAL"), or "private"/"military": the collection key. */
  airline: string;
  /** The airline's name when the route lookup knew it, for display. */
  airlineName?: string;
  route: string;
  altFt: number;
  distM: number;
  city: string;
  /** Epoch ms. */
  t: number;
  tier: Tier;
  points: number;
}

export interface SpotResult {
  /** False when this airframe was already in the book: nothing is added. */
  added: boolean;
  newType: boolean;
  newAirline: boolean;
  points: number;
}

/** The thing the logbook persists through: localStorage in the app, a Map in the check. */
export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const KEY = "flyby.logbook.v1";
/** First type and first airline each add a bonus: collecting is the point. */
export const NEW_TYPE_BONUS = 20;
export const NEW_AIRLINE_BONUS = 15;

export class Logbook {
  readonly spots: Spot[] = [];
  private hexes = new Set<string>();

  constructor(private store: Store | null) {
    if (!store) return;
    try {
      const raw = store.get(KEY);
      const list = raw ? (JSON.parse(raw) as Spot[]) : [];
      for (const s of list) {
        if (!s || typeof s.hex !== "string" || this.hexes.has(s.hex)) continue;
        this.hexes.add(s.hex);
        this.spots.push(s);
      }
    } catch {
      // A corrupt book starts empty rather than taking the game down.
    }
  }

  has(hex: string): boolean {
    return this.hexes.has(hex);
  }

  /** Adds `s` unless its airframe is already in the book. */
  add(s: Spot): SpotResult {
    if (this.hexes.has(s.hex)) return { added: false, newType: false, newAirline: false, points: 0 };
    const newType = !!s.type && !this.spots.some((o) => o.type === s.type);
    const newAirline = !!s.airline && !this.spots.some((o) => o.airline === s.airline);
    const points = TIER_POINTS[s.tier] + (newType ? NEW_TYPE_BONUS : 0) + (newAirline ? NEW_AIRLINE_BONUS : 0);
    s.points = points;
    this.hexes.add(s.hex);
    this.spots.unshift(s);
    try {
      this.store?.set(KEY, JSON.stringify(this.spots));
    } catch {
      // Storage full or blocked: the spot still counts for this session.
    }
    return { added: true, newType, newAirline, points };
  }

  get score(): number {
    return this.spots.reduce((a, s) => a + s.points, 0);
  }

  /** Counts per key, most first. */
  countBy(key: "type" | "airline"): [string, number][] {
    const m = new Map<string, number>();
    for (const s of this.spots) {
      const k = s[key] || "?";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]);
  }
}
