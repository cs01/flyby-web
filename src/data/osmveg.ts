// Where the trees are, from OpenStreetMap rather than from a landcover raster.
//
// WHY NOT WORLDCOVER. The .land packs are the better source and stay the better
// source: ESA WorldCover is a measured 10 m raster and OSM landuse is a human
// drawing a boundary. But WorldCover ships as ~87 MB Deflate-tiled GeoTIFFs on
// an S3 bucket that sends NO CORS HEADERS, so a browser cannot read one byte of
// it. Measured, not assumed. That leaves exactly one canopy source a page can
// reach for an arbitrary point on Earth, and it is the one this file reads.
//
// WHAT THIS PRODUCES IS A COVERAGE GRID, NOT TREES. It writes the same RGBA
// channel layout src/data/landmask.ts packs a .land level into, so the output
// is a drop-in for the mask src/data/trees.ts already plants from and
// src/render/trees.ts already draws. There is one tree system in this app and
// this does not add a second one: it adds a second way of filling in the ONE
// input that system takes.
//
// The cost of that choice, stated plainly: an individually mapped `natural=tree`
// node stamps its own cell rather than placing a trunk at its exact coordinate,
// so the tree ends up on the lattice within about a cell of where the mapper
// put it. Placing it exactly would mean a second placement path with its own
// jitter, its own road and roof rejection and its own tiling rules, and a tree
// twelve metres from where OSM says it is is not worth that.
//
// PURE: no fetch, no cache, no DOM.

import { Origin } from "../geo";
import { bboxFilter, type OsmBbox, type OsmElement, type OsmPt } from "./osm";

/**
 * Grid pitch in metres.
 *
 * Just over the 16 m tree lattice, so one mapped tree node lands in one cell
 * and yields about one tree. Finer would cost memory quadratically for a
 * precision the lattice cannot use; coarser would merge a street's worth of
 * individual trees into a single cell.
 */
export const VEG_CELL_M = 20;

/**
 * Canopy fraction by tag, which is also the probability a lattice cell inside
 * one of these polygons yields a tree (see the density rule in trees.ts).
 *
 * These are estimates of how much of the ground under the polygon is actually
 * under a crown, not preferences. A wood is nearly closed; a municipal park is
 * grass with trees around the edges and along the paths; a pitch has none.
 * They are the one place in this file where a number is a judgement, so they
 * are together and named.
 */
export const CANOPY_BY_TAG: Readonly<Record<string, number>> = {
  "natural=wood": 0.85,
  "landuse=forest": 0.85,
  "landuse=orchard": 0.70,
  "natural=scrub": 0.35,
  "leisure=nature_reserve": 0.35,
  "landuse=cemetery": 0.30,
  "leisure=park": 0.30,
  "leisure=garden": 0.25,
  "landuse=village_green": 0.20,
  "landuse=recreation_ground": 0.15,
  "leisure=golf_course": 0.12,
  "landuse=meadow": 0.05,
  "landuse=grass": 0.05,
};

/** Polygons that are water, and therefore keep trees out rather than putting
 *  them in. A lake inside a wood has to win over the wood. */
export const WATER_TAGS: readonly string[] = [
  "natural=water",
  "natural=wetland",
  "landuse=reservoir",
  "landuse=basin",
  "waterway=riverbank",
];

/** A single mapped tree fills its own cell. */
const NODE_CANOPY = 1.0;

/** Everything the query asks for, in one request. */
export function vegetationStatements(b: OsmBbox): string {
  const box = bboxFilter(b);
  return `way["natural"~"^(wood|scrub|water|wetland)$"](${box});
 way["landuse"~"^(forest|orchard|meadow|grass|village_green|recreation_ground|cemetery|reservoir|basin)$"](${box});
 way["leisure"~"^(park|garden|golf_course|nature_reserve)$"](${box});
 way["waterway"="riverbank"](${box});
 relation["natural"~"^(wood|scrub|water|wetland)$"](${box});
 relation["landuse"~"^(forest|orchard|cemetery)$"](${box});
 relation["leisure"~"^(park|garden|nature_reserve)$"](${box});
 node["natural"="tree"](${box});`;
}

export function vegetationQuery(b: OsmBbox, timeoutS = 90): string {
  return `[out:json][timeout:${timeoutS}];
(${vegetationStatements(b)});
out geom;`;
}

/** Which of the tables above a tagged element falls into, if any. */
function canopyOf(tags: Record<string, string>): { canopy: number; water: boolean } | null {
  for (const key of WATER_TAGS) {
    const eq = key.indexOf("=");
    if (tags[key.slice(0, eq)] === key.slice(eq + 1)) return { canopy: 0, water: true };
  }
  for (const key of Object.keys(CANOPY_BY_TAG)) {
    const eq = key.indexOf("=");
    if (tags[key.slice(0, eq)] === key.slice(eq + 1)) {
      return { canopy: CANOPY_BY_TAG[key], water: false };
    }
  }
  return null;
}

export interface VegetationAdded {
  polygons: number;
  nodes: number;
  /** Grid cells this call raised above what they were. */
  cells: number;
}

/**
 * A coverage grid that fills in as tiles arrive.
 *
 * Mutable and handed to the tree field BY REFERENCE, so a canopy that only
 * exists once the third tile lands does not need the field rebuilt from
 * scratch -- the renderer is told to re-place its tiles and reads the same
 * array. Everything starts at zero, which reads as "bare ground": no trees, no
 * water, nothing rejected. An empty grid is therefore the correct answer for
 * ground nobody has fetched yet, rather than a guess about it.
 */
export class LiveVegetation {
  readonly rgba: Uint8Array;
  readonly n: number;
  readonly extentM: number;
  private readonly cellM: number;

  constructor(extentM: number, cellM = VEG_CELL_M) {
    this.extentM = extentM;
    this.cellM = cellM;
    this.n = Math.max(1, Math.ceil((extentM * 2) / cellM));
    this.rgba = new Uint8Array(this.n * this.n * 4);
  }

  /** Grid column/row containing a world coordinate, unclamped. */
  private index(w: number): number {
    return Math.floor((w + this.extentM) / this.cellM);
  }

  /** Raise one channel of one cell, never lower it. */
  private raise(c: number, r: number, channel: number, value: number): boolean {
    if (c < 0 || r < 0 || c >= this.n || r >= this.n) return false;
    const o = (r * this.n + c) * 4 + channel;
    const v = Math.round(Math.max(0, Math.min(1, value)) * 255);
    if (this.rgba[o] >= v) return false;
    this.rgba[o] = v;
    return true;
  }

  /**
   * Rasterise one Overpass answer.
   *
   * Water is written after canopy within each element and wins on its own
   * channel, so a lake mapped inside a wood keeps its trees out even though the
   * wood was drawn first: the rejection in trees.ts is `water > 0.12`, and
   * raising water never lowers tree.
   */
  add(elements: readonly OsmElement[], origin: Origin): VegetationAdded {
    let polygons = 0;
    let nodes = 0;
    let cells = 0;

    for (const el of elements) {
      const tags = el.tags ?? {};

      // Nodes FIRST, and outside the polygon tables. `natural=tree` is not a
      // land cover and has no place in CANOPY_BY_TAG -- looking it up there was
      // this file's first bug, and it silently threw away every individually
      // mapped tree in Paris while every polygon still worked.
      if (el.type === "node") {
        if (tags["natural"] !== "tree") continue;
        if (!Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
        const w = origin.toWorld(el.lat as number, el.lon as number);
        if (this.raise(this.index(w.x), this.index(w.z), 2, NODE_CANOPY)) cells++;
        nodes++;
        continue;
      }

      const kind = canopyOf(tags);
      if (kind === null) continue;

      const rings: OsmPt[][] = [];
      if (el.type === "way" && el.geometry && el.geometry.length >= 3) {
        rings.push(el.geometry);
      } else if (el.type === "relation") {
        for (const m of el.members ?? []) {
          if (m.role !== "outer" || !m.geometry || m.geometry.length < 3) continue;
          rings.push(m.geometry);
        }
      }
      if (rings.length === 0) continue;
      polygons++;

      const channel = kind.water ? 0 : 2;
      const value = kind.water ? 1 : kind.canopy;
      for (const g of rings) cells += this.fill(g, origin, channel, value);
    }

    return { polygons, nodes, cells };
  }

  /** Stamp every cell whose centre is inside a projected ring. */
  private fill(g: readonly OsmPt[], origin: Origin, channel: number, value: number): number {
    const n = g.length;
    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const w = origin.toWorld(g[i].lat, g[i].lon);
      xs[i] = w.x;
      zs[i] = w.z;
      if (w.x < minX) minX = w.x;
      if (w.x > maxX) maxX = w.x;
      if (w.z < minZ) minZ = w.z;
      if (w.z > maxZ) maxZ = w.z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return 0;

    const c0 = Math.max(0, this.index(minX));
    const c1 = Math.min(this.n - 1, this.index(maxX));
    const r0 = Math.max(0, this.index(minZ));
    const r1 = Math.min(this.n - 1, this.index(maxZ));
    if (c1 < c0 || r1 < r0) return 0;

    let raised = 0;
    for (let r = r0; r <= r1; r++) {
      const z = -this.extentM + (r + 0.5) * this.cellM;
      for (let c = c0; c <= c1; c++) {
        const x = -this.extentM + (c + 0.5) * this.cellM;
        if (!pointInRing(xs, zs, x, z)) continue;
        if (this.raise(c, r, channel, value)) raised++;
      }
    }
    // A polygon smaller than one cell would otherwise stamp nothing at all: a
    // 15 m copse and a suburban garden are both under 400 m2. Its centroid cell
    // stands in for it, which is the same resolution compromise the lattice
    // itself already makes.
    if (raised === 0) {
      let sx = 0, sz = 0;
      for (let i = 0; i < n; i++) { sx += xs[i]; sz += zs[i]; }
      if (this.raise(this.index(sx / n), this.index(sz / n), channel, value)) raised++;
    }
    return raised;
  }
}

/** Crossing-number point-in-polygon over parallel coordinate arrays. */
function pointInRing(xs: Float64Array, zs: Float64Array, x: number, z: number): boolean {
  let inside = false;
  const n = xs.length;
  for (let a = 0, b = n - 1; a < n; b = a, a++) {
    const za = zs[a], zb = zs[b];
    if (za > z !== zb > z) {
      const t = (z - za) / (zb - za);
      if (x < xs[a] + t * (xs[b] - xs[a])) inside = !inside;
    }
  }
  return inside;
}
