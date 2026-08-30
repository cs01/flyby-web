// The shapes an Overpass answer arrives in, and the bookkeeping every OSM
// converter needs. Nothing here knows about buildings or roads.
//
// This file is deliberately PURE: no fetch, no cache, no DOM, no Bun. That is
// the whole reason it exists. The OSM-to-geometry logic used to live inside
// tools/bake-city.ts and tools/bake-roads.ts, where the browser could not
// reach it, so a city could only have buildings if somebody had baked a pack
// for it. The same rule that makes citypack.ts an oracle for the baker applies
// here: one converter, used by the offline bake AND by the runtime path, so
// the two cannot drift into producing different cities from the same data.

/** A point as Overpass writes it in `out geom`. */
export interface OsmPt {
  lat: number;
  lon: number;
}

export interface OsmMember {
  type: string;
  ref: number;
  role?: string;
  geometry?: OsmPt[];
}

export interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  /** Present on ways and on `node` elements only as absent; nodes carry lat/lon. */
  geometry?: OsmPt[];
  members?: OsmMember[];
  /** Nodes only. */
  lat?: number;
  lon?: number;
}

export interface OverpassResponse {
  elements?: OsmElement[];
}

/**
 * A query box in degrees, in Overpass's own south, west, north, east order.
 *
 * Named apart from src/data/dem.ts's `Bbox`, which spells the same rectangle
 * `{west, east, south, north}`. Two conventions for one concept in one codebase
 * is a bug waiting to be written, so the OSM one carries the OSM name.
 */
export interface OsmBbox {
  s: number;
  w: number;
  n: number;
  e: number;
}

/** Format a box the way Overpass wants it inside a filter. */
export function bboxFilter(b: OsmBbox): string {
  return `${b.s.toFixed(7)},${b.w.toFixed(7)},${b.n.toFixed(7)},${b.e.toFixed(7)}`;
}

/**
 * Why an element was dropped, counted by reason.
 *
 * A bake that silently discarded 645 relations is how this got written: a total
 * tells you something went wrong, and only a reason tells you what.
 */
export class Skips {
  private readonly counts = new Map<string, number>();
  add(reason: string, n = 1): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + n);
  }
  total(): number {
    let t = 0;
    for (const v of this.counts.values()) t += v;
    return t;
  }
  entries(): [string, number][] {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
  }
}

/** True for an OSM value that means yes. `no`, `false`, `0` and empty are not. */
export function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.toLowerCase();
  return s !== "" && s !== "no" && s !== "false" && s !== "0";
}
