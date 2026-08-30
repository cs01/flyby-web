// Where the trees go: coverage in, instance transforms out.
//
// WHY THIS IS A SEPARATE, PURE FILE. The whole point of splitting the tree and
// herbaceous channels out of the landcover mask was to be able to place canopy
// from measured data. That placement is the part that can be WRONG in ways a
// screenshot will not settle -- a tree standing in the Bay, a tree in the
// middle of the Bayshore Freeway, a tree that moves every time the camera
// crosses a tile boundary -- so it lives here with no THREE, no DOM and no
// fetch, and test/trees.check.ts runs it under Bun against the real committed
// packs. src/render/trees.ts is the half that owns buffers and shaders.
//
// THREE INVARIANTS CARRY EVERYTHING.
//
// **The lattice is absolute.** A candidate belongs to the cell
// `(floor(x / spacing), floor(z / spacing))` about the WORLD origin, and its
// jitter never takes it outside its own cell. Nothing about a tree depends on
// which region asked for it, so the field can be rebuilt around a moving camera
// tile by tile and no tree ever moves, appears twice or pops. That is also why
// the check can assert that placing a box in one call equals placing its four
// quadrants and taking the union.
//
// **Density IS the coverage.** A cell yields a tree with probability equal to
// the tree coverage sampled at the candidate's own position, so a closed canopy
// at 0.9 is nine cells in ten and scattered scrub at 0.2 is one in five. No
// curve, no tuning constant between the measurement and the count, which is
// what makes "the count tracks the coverage" an assertion rather than a wish.
//
// **Rejection is by evidence, never by taste.** Water and built come from the
// same measured mask; the carriageway comes from the .roads centrelines with a
// clearance derived from the same roadWidthM() the renderer draws with, so a
// tree cannot end up on a road surface that a later width change moves.

import { sampleMaskBilinear } from "./landmask";
import { roadWidthM, type Road } from "./roadpack";

/**
 * Lattice pitch in metres: one tree per cell at full canopy.
 *
 * 16 m is well above the ~5 m spacing of a real closed-canopy stand, and that
 * is deliberate. The crown radius below grows with local coverage so canopies
 * still overlap and read as continuous, and the instance count is what the
 * vertex cost of four passes (main frame, three shadow cascades) is linear in.
 * Halving this quadruples that cost to close a gap the crown radius already
 * closes.
 */
export const TREE_SPACING_M = 16;

/** Side of one placement tile, in metres. A multiple of the spacing, so a tile
 *  boundary never splits a lattice cell and the tile cache can be a plain
 *  union. */
export const TREE_TILE_M = 256;

/** Coverage above which a candidate is treated as standing in water. */
export const TREE_MAX_WATER = 0.12;
/**
 * Coverage above which a candidate is treated as standing on a building.
 *
 * Permissive on purpose. The mask is ONE-HOT per 10 m texel, so built and tree
 * only mix where the bilinear filter straddles the boundary between a built
 * texel and a tree texel -- which is exactly where a street tree stands. A
 * tight threshold here removes Manhattan's street trees, which are the ones the
 * city most obviously lacks. Actual rooftops are excluded by FootprintMask,
 * which knows where the walls are; this is the fallback for the 26 cities that
 * have a .land pack and no .city pack.
 */
export const TREE_MAX_BUILT = 0.85;

/** Verge beyond the kerb, in metres, for a class measured in lanes. */
export const TREE_CARRIAGEWAY_VERGE_M = 4.0;
/** Verge beyond the edge, in metres, for a footway, cycleway or track. A crown
 *  overhanging a pavement is correct; a trunk in the middle of one is not. */
export const TREE_PATH_VERGE_M = 1.5;
/**
 * Floor on the clearance from a carriageway centreline, in metres.
 *
 * `lanes` is tagged on ~15% of ways, and where it IS tagged a motorway slip or
 * a one-way primary can carry `lanes=1`, which roadWidthM turns into 3.5 m and
 * a width-derived clearance into 5.75 m. A motorway is a motorway whatever one
 * mapper wrote, so the width rule has a floor under it.
 */
export const TREE_MIN_CARRIAGEWAY_CLEARANCE_M = 6.5;

/** First road class that is not measured in lanes; see roadpack's FIXED_WIDTH_M. */
const FIRST_PATH_CLASS = 10;

/**
 * How far a tree must be from a road centreline, in metres.
 *
 * Derived from roadWidthM rather than tabulated, so the renderer's carriageway
 * and this clearance cannot disagree about how wide a road is: change the lane
 * width and the trees move with the tarmac.
 */
export function treeRoadClearanceM(r: Road): number {
  const half = roadWidthM(r.cls, r.lanes, r.flags) * 0.5;
  if (r.cls >= FIRST_PATH_CLASS) return half + TREE_PATH_VERGE_M;
  return Math.max(TREE_MIN_CARRIAGEWAY_CLEARANCE_M, half + TREE_CARRIAGEWAY_VERGE_M);
}

/**
 * The shapes. Height and crown ratio decide the silhouette; `conifer` is the
 * one number the vertex shader needs, because a spire and a dome are the same
 * mesh with the rings pulled in differently.
 */
export interface TreeSpecies {
  name: string;
  minHeightM: number;
  maxHeightM: number;
  /** Crown radius as a fraction of total height. */
  crownRatio: number;
  /** 0 a broadleaf dome, 1 a conifer spire. */
  conifer: number;
  /** Where in the shader's green ramp this species sits, 0..1. */
  tint: number;
}

/**
 * Four archetypes, not a botanical survey. What has to vary for a stand to stop
 * reading as one asset repeated is silhouette height, crown width and colour,
 * and four of each interpolated by the per-instance jitter covers that.
 *
 * The crown ratios are narrower than a first pass at them, and it is a picture
 * decision rather than a placement one: at 0.46 a broadleaf's crown was wider
 * than the tree was tall once the coverage widening below was applied, and from
 * 55 m up a stand of them read as green mounds on the ground with no stem. None
 * of the assertions in test/trees.check.ts reads this number -- it changes what
 * a tree looks like, not where one goes.
 */
export const TREE_SPECIES: readonly TreeSpecies[] = [
  { name: "broadleaf", minHeightM: 9, maxHeightM: 19, crownRatio: 0.38, conifer: 0.0, tint: 0.30 },
  { name: "street", minHeightM: 6, maxHeightM: 12, crownRatio: 0.34, conifer: 0.1, tint: 0.62 },
  { name: "conifer", minHeightM: 12, maxHeightM: 28, crownRatio: 0.24, conifer: 1.0, tint: 0.08 },
  { name: "scrub", minHeightM: 3, maxHeightM: 7, crownRatio: 0.50, conifer: 0.0, tint: 0.85 },
];

export interface TreeInstance {
  /** World ENU metres. y is the terrain surface the trunk stands on. */
  x: number;
  y: number;
  z: number;
  /** Trunk base to crown top, metres. */
  heightM: number;
  /** Crown half-width, metres. */
  radiusM: number;
  /** Yaw, radians. */
  yaw: number;
  /** Index into TREE_SPECIES. */
  species: number;
  /** 0..1, the hash that drives colour and shape jitter in the shader. */
  tint: number;
}

/** The finest level of a .land pack, already packed to coverage by buildLandMaskRGBA. */
export interface TreeMask {
  rgba: Uint8Array;
  n: number;
  extentM: number;
}

/**
 * One 32-bit integer hash of a lattice cell and a salt, as a 0..1 float.
 *
 * Every random-looking quantity about a tree comes from this and from nothing
 * else. Math.random() would put a tree somewhere different on every reload and
 * make the whole gate below meaningless; a hash of the CELL rather than of a
 * running counter is what additionally makes the answer independent of the
 * order and the extent of the region that asked.
 */
function hashCell(i: number, k: number, salt: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(k, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Salts. Distinct constants rather than 0,1,2,... because the mix above is
// linear in the salt before the avalanche, and adjacent salts on adjacent cells
// would correlate position with species across the field.
const SALT_JITTER_X = 0x1f83d9ab;
const SALT_JITTER_Z = 0x5be0cd19;
const SALT_ACCEPT = 0x9b05688c;
const SALT_SPECIES = 0x510e527f;
const SALT_SIZE = 0xa54ff53a;
const SALT_YAW = 0x3c6ef372;
const SALT_TINT = 0xbb67ae85;

/**
 * How far off its cell centre a candidate is allowed to sit, as a fraction of
 * the cell. Strictly under 1, so a candidate NEVER leaves the cell that
 * generated it: that is what makes tiling exact rather than approximate.
 */
export const TREE_JITTER = 0.92;

/**
 * Uniform grid over road centreline segments.
 *
 * A segment is registered in every cell its bounding box GROWN BY ITS OWN PAD
 * touches, which is the whole trick: a query then only has to look in the one
 * cell containing the point. If the point is within `pad` of the segment it is
 * inside that grown box, so the segment is in that cell by construction. No
 * neighbourhood scan, no radius to get wrong.
 */
export class RoadIndex {
  private readonly ax: Float32Array;
  private readonly az: Float32Array;
  private readonly bx: Float32Array;
  private readonly bz: Float32Array;
  private readonly pad: Float32Array;
  private readonly cellM: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  /** CSR over cells: start[c]..start[c+1] indexes into `items`. */
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  readonly segments: number;

  /**
   * @param roads the ways to index; filter before calling to index a subset.
   * @param padOf how far beyond each centreline a query can reach, in metres.
   * @param cellM grid pitch. Bigger means fewer registrations and longer scans.
   */
  constructor(roads: readonly Road[], padOf: (r: Road) => number, cellM = 32) {
    this.cellM = cellM;

    let count = 0;
    for (const r of roads) count += r.pts.length / 2 - 1;
    this.segments = count;

    this.ax = new Float32Array(count);
    this.az = new Float32Array(count);
    this.bx = new Float32Array(count);
    this.bz = new Float32Array(count);
    this.pad = new Float32Array(count);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let s = 0;
    for (const r of roads) {
      const p = padOf(r);
      for (let v = 2; v < r.pts.length; v += 2) {
        const x0 = r.pts[v - 2], z0 = r.pts[v - 1];
        const x1 = r.pts[v], z1 = r.pts[v + 1];
        this.ax[s] = x0; this.az[s] = z0;
        this.bx[s] = x1; this.bz[s] = z1;
        this.pad[s] = p;
        s++;
        const lo = Math.min(x0, x1) - p, hi = Math.max(x0, x1) + p;
        const lz = Math.min(z0, z1) - p, hz = Math.max(z0, z1) + p;
        if (lo < minX) minX = lo;
        if (hi > maxX) maxX = hi;
        if (lz < minZ) minZ = lz;
        if (hz > maxZ) maxZ = hz;
      }
    }
    // An empty pack still has to produce a queryable index rather than NaN
    // bounds, or every city without roads throws on the first candidate.
    if (count === 0) { minX = 0; maxX = 0; minZ = 0; maxZ = 0; }

    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cellM) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cellM) + 1);

    // Two passes, counting then filling: a CSR costs one extra sweep and
    // avoids a million little arrays, which at Manhattan's 400k segments is
    // the difference between 5 MB and a garbage-collection stall.
    const cells = this.nx * this.nz;
    const counts = new Int32Array(cells + 1);
    const visit = (fn: (cell: number, seg: number) => void): void => {
      for (let i = 0; i < count; i++) {
        const p = this.pad[i];
        const cx0 = this.col(Math.min(this.ax[i], this.bx[i]) - p);
        const cx1 = this.col(Math.max(this.ax[i], this.bx[i]) + p);
        const cz0 = this.row(Math.min(this.az[i], this.bz[i]) - p);
        const cz1 = this.row(Math.max(this.az[i], this.bz[i]) + p);
        for (let cz = cz0; cz <= cz1; cz++) {
          for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.nx + cx, i);
        }
      }
    };
    visit((c) => { counts[c + 1]++; });
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.start = counts;
    this.items = new Int32Array(counts[cells]);
    const cursor = new Int32Array(cells);
    visit((c, i) => { this.items[this.start[c] + cursor[c]++] = i; });
  }

  private col(x: number): number {
    const c = Math.floor((x - this.minX) / this.cellM);
    return c < 0 ? 0 : c >= this.nx ? this.nx - 1 : c;
  }

  private row(z: number): number {
    const c = Math.floor((z - this.minZ) / this.cellM);
    return c < 0 ? 0 : c >= this.nz ? this.nz - 1 : c;
  }

  /** Squared distance from a point to a segment, the inner loop of both queries. */
  private distSq(i: number, x: number, z: number): number {
    const ax = this.ax[i], az = this.az[i];
    const dx = this.bx[i] - ax, dz = this.bz[i] - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (ax + t * dx), pz = z - (az + t * dz);
    return px * px + pz * pz;
  }

  /** True when the point is inside some segment's own clearance envelope. */
  blocked(x: number, z: number): boolean {
    const c = this.row(z) * this.nx + this.col(x);
    for (let e = this.start[c]; e < this.start[c + 1]; e++) {
      const i = this.items[e];
      const p = this.pad[i];
      if (this.distSq(i, x, z) <= p * p) return true;
    }
    return false;
  }

  /**
   * Distance in metres to the nearest indexed centreline, or Infinity when
   * nothing is within the pad the index was built with.
   *
   * Only exact out to that pad, by construction. Callers that need a real
   * answer (the check) build the index with the pad they intend to assert on.
   */
  nearest(x: number, z: number): number {
    const c = this.row(z) * this.nx + this.col(x);
    let best = Infinity;
    for (let e = this.start[c]; e < this.start[c + 1]; e++) {
      const d = this.distSq(i(this.items, e), x, z);
      if (d < best) best = d;
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  }
}

/** Indirection so `nearest` reads the same way as `blocked`; see RoadIndex. */
function i(items: Int32Array, e: number): number {
  return items[e];
}

/** Metres per cell in the footprint bitset. Under the width of an alley, so a
 *  gap between two buildings survives the rasterisation. */
const FOOTPRINT_CELL_M = 4;

/**
 * Where buildings stand, as a bitset over a regular grid.
 *
 * The landcover's built class cannot do this job: it is a 10 m posting of LAND
 * USE, so a leafy suburb reads as a blend of built and tree over the whole
 * street and there is no texel that says "this square is a roof". The .city
 * pack has the actual rings, and a tree growing out of the middle of a roof is
 * the one placement failure a viewer notices immediately.
 *
 * A bitset rather than bytes because Manhattan's 8 km radius is 16 million
 * cells, which is 2 MB packed and 16 MB not, on a device where memory is the
 * ceiling.
 */
export class FootprintMask {
  private readonly bits: Uint32Array;
  private readonly n: number;
  private readonly extentM: number;

  constructor(buildings: readonly { ring: Float32Array }[], extentM: number) {
    this.extentM = extentM;
    this.n = Math.max(1, Math.ceil((extentM * 2) / FOOTPRINT_CELL_M));
    this.bits = new Uint32Array(Math.ceil((this.n * this.n) / 32));
    this.add(buildings);
  }

  /**
   * Stamp more footprints into the same grid.
   *
   * The live path learns where the buildings are one streamed tile at a time,
   * and a mask rebuilt from scratch per tile would re-rasterise every footprint
   * already known. Stamping is idempotent -- a bit that is set stays set -- so
   * a footprint arriving twice costs time and changes nothing.
   */
  add(buildings: readonly { ring: Float32Array }[]): void {
    const extentM = this.extentM;
    for (const b of buildings) {
      const ring = b.ring;
      if (ring.length < 6) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let v = 0; v < ring.length; v += 2) {
        if (ring[v] < minX) minX = ring[v];
        if (ring[v] > maxX) maxX = ring[v];
        if (ring[v + 1] < minZ) minZ = ring[v + 1];
        if (ring[v + 1] > maxZ) maxZ = ring[v + 1];
      }
      const c0 = this.index(minX), c1 = this.index(maxX);
      const r0 = this.index(minZ), r1 = this.index(maxZ);
      if (c1 < 0 || r1 < 0 || c0 >= this.n || r0 >= this.n) continue;

      // The OUTLINE first, walked at half a cell so no cell the boundary passes
      // through is missed. Cell centres alone leave a ring of cells around the
      // edge of every building unstamped -- the cell is half inside the wall,
      // its centre is outside -- and that ring is exactly where the mask is
      // being asked the question, so a tree ended up half in the front wall of
      // one house in seventy. It also covers a building smaller than a cell,
      // which cell centres would round away entirely.
      for (let v = 0, w = ring.length - 2; v < ring.length; w = v, v += 2) {
        const dx = ring[v] - ring[w];
        const dz = ring[v + 1] - ring[w + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (FOOTPRINT_CELL_M * 0.5)));
        for (let t = 0; t <= steps; t++) {
          const c = this.index(ring[w] + (dx * t) / steps);
          const r = this.index(ring[w + 1] + (dz * t) / steps);
          if (c >= 0 && r >= 0 && c < this.n && r < this.n) this.set(c, r);
        }
      }
      for (let r = Math.max(0, r0); r <= Math.min(this.n - 1, r1); r++) {
        const z = -extentM + (r + 0.5) * FOOTPRINT_CELL_M;
        for (let c = Math.max(0, c0); c <= Math.min(this.n - 1, c1); c++) {
          const x = -extentM + (c + 0.5) * FOOTPRINT_CELL_M;
          if (pointInRing(ring, x, z)) this.set(c, r);
        }
      }
    }
  }

  private index(w: number): number {
    return Math.floor((w + this.extentM) / FOOTPRINT_CELL_M);
  }

  private set(c: number, r: number): void {
    const b = r * this.n + c;
    this.bits[b >>> 5] |= 1 << (b & 31);
  }

  occupied(x: number, z: number): boolean {
    const c = this.index(x);
    const r = this.index(z);
    if (c < 0 || r < 0 || c >= this.n || r >= this.n) return false;
    const b = r * this.n + c;
    return (this.bits[b >>> 5] & (1 << (b & 31))) !== 0;
  }
}

/** Crossing-number point-in-polygon over a flat x,z ring. */
function pointInRing(ring: Float32Array, x: number, z: number): boolean {
  let inside = false;
  for (let a = 0, b = ring.length - 2; a < ring.length; b = a, a += 2) {
    const zi = ring[a + 1], zj = ring[b + 1];
    if (zi > z !== zj > z) {
      const t = (z - zi) / (zj - zi);
      if (x < ring[a] + t * (ring[b] - ring[a])) inside = !inside;
    }
  }
  return inside;
}

/**
 * Anything that can say "a tree may not stand here because of tarmac".
 *
 * An interface rather than RoadIndex itself because the live path holds one
 * index per streamed tile: a single CSR index cannot grow, and rebuilding it
 * from every road so far on every tile is quadratic. See CompositeRoadIndex.
 */
export interface RoadBlocker {
  blocked(x: number, z: number): boolean;
}

/** Several indexes queried as one. A point is blocked if any of them says so. */
export class CompositeRoadIndex implements RoadBlocker {
  private readonly parts: RoadBlocker[] = [];

  add(part: RoadBlocker): void {
    this.parts.push(part);
  }

  blocked(x: number, z: number): boolean {
    for (const p of this.parts) if (p.blocked(x, z)) return true;
    return false;
  }
}

export interface TreeField {
  mask: TreeMask;
  heightAt: (x: number, z: number) => number;
  roads?: RoadBlocker | null;
  footprints?: FootprintMask | null;
  /** Lattice pitch; defaults to TREE_SPACING_M. */
  spacingM?: number;
}

/**
 * Every tree whose lattice cell puts it inside [x0, x1) x [z0, z1).
 *
 * Half-open on purpose: abutting regions then partition the lattice exactly,
 * which is what lets the renderer build the field a tile at a time and what
 * test/trees.check.ts asserts by comparing one box against its four quadrants.
 */
export function placeTrees(
  field: TreeField,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  out: TreeInstance[] = [],
): TreeInstance[] {
  const spacing = field.spacingM ?? TREE_SPACING_M;
  const { mask, heightAt, roads, footprints } = field;

  // One cell either side: a cell whose centre is outside the box can still put
  // its jittered candidate inside it.
  const i0 = Math.floor(x0 / spacing) - 1;
  const i1 = Math.floor(x1 / spacing) + 1;
  const k0 = Math.floor(z0 / spacing) - 1;
  const k1 = Math.floor(z1 / spacing) + 1;

  for (let k = k0; k <= k1; k++) {
    for (let ic = i0; ic <= i1; ic++) {
      const x = (ic + 0.5 + (hashCell(ic, k, SALT_JITTER_X) - 0.5) * TREE_JITTER) * spacing;
      const z = (k + 0.5 + (hashCell(ic, k, SALT_JITTER_Z) - 0.5) * TREE_JITTER) * spacing;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;

      const s = sampleMaskBilinear(mask.rgba, mask.n, mask.extentM, x, z);
      if (s.water > TREE_MAX_WATER) continue;
      if (s.built > TREE_MAX_BUILT) continue;
      // The density rule, and the only place coverage turns into a count.
      if (hashCell(ic, k, SALT_ACCEPT) >= s.tree) continue;
      if (footprints && footprints.occupied(x, z)) continue;
      if (roads && roads.blocked(x, z)) continue;

      const sp = Math.min(
        TREE_SPECIES.length - 1,
        Math.floor(hashCell(ic, k, SALT_SPECIES) * TREE_SPECIES.length),
      );
      const spec = TREE_SPECIES[sp];
      const grow = hashCell(ic, k, SALT_SIZE);
      const heightM = spec.minHeightM + (spec.maxHeightM - spec.minHeightM) * grow;
      // Crown width grows with local coverage, which is what closes a canopy
      // without paying for more instances: a stand at 0.9 gets crowns that
      // overlap at the 16 m pitch, scattered scrub at 0.2 gets separate bushes.
      const radiusM = heightM * spec.crownRatio * (0.78 + 0.5 * s.tree);

      out.push({
        x,
        y: heightAt(x, z),
        z,
        heightM,
        radiusM,
        yaw: hashCell(ic, k, SALT_YAW) * Math.PI * 2,
        species: sp,
        tint: hashCell(ic, k, SALT_TINT),
      });
    }
  }
  return out;
}

/** Mean tree coverage over a box, on its own lattice: the count's oracle. */
export function meanTreeCoverage(
  mask: TreeMask,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  stepM: number,
): number {
  let sum = 0;
  let n = 0;
  for (let z = z0 + stepM * 0.5; z < z1; z += stepM) {
    for (let x = x0 + stepM * 0.5; x < x1; x += stepM) {
      sum += sampleMaskBilinear(mask.rgba, mask.n, mask.extentM, x, z).tree;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}
