// Buildings the drone cannot fly through.
//
// The city pack is geometry, not a physics world: 187,000 footprints with no
// collision data of any kind. `Skyline` already answers "how high is the
// tallest thing under me" for the aeroplane, but a coarse 32 m height grid is
// exactly wrong for a machine whose whole purpose is to fly BETWEEN the
// buildings -- it would fill the streets in. So this is the polygon-accurate
// version, and it has to be fast enough to run every frame.
//
// Three things carry it.
//
// **A uniform grid built once.** Testing 187k polygons per frame is not a
// budget question, it is three orders of magnitude out. The grid turns it into
// "which of the four cells around me" and the answer is a couple of dozen
// candidates.
//
// **Flat typed arrays, no objects.** The obvious `Map<string, number[]>` costs
// a string key per bucket, an array header per bucket and a pointer chase per
// candidate, and it allocates while you fly. Everything here is one Int32Array
// of building indices with a per-cell start offset, and the footprints are
// copied into a single Float32Array so a narrowphase test touches two
// contiguous runs of memory instead of dereferencing a Building and then its
// own ring.
//
// **Minimum-translation push-out, then SLIDE.** The velocity loses only the
// component going into the surface. Zeroing the whole velocity on contact is
// the single easiest way to make this feel wrong: skimming a facade at 40 m/s
// is the shot the drone exists for, and a machine that stops dead every time
// it brushes a wall feels like it is flying through glue.
//
// Heights come from the same place the RENDERER gets them -- the lowest
// terrain sample under the footprint -- because a collider that disagrees with
// what is drawn is worse than no collider: you bounce off nothing and sink
// through walls.

import type * as THREE from "three";
import { footprintGroundY, type CityPack } from "../data/citypack";

/**
 * Broadphase cell size.
 *
 * The median footprint is 18 m across and the 99th percentile is 92 m, so 64 m
 * keeps almost every building in one or two cells while still holding the cell
 * count for a 16 km pack down to 250 x 250. Smaller cells would cut the
 * candidate list but multiply the buckets a big footprint has to be stamped
 * into; larger ones hand the narrowphase a whole city block.
 */
const CELL_M = 64;

/**
 * Passes over the whole contact set, re-detecting each time.
 *
 * One pass cannot be enough in a corner. Pushing out of the wall you hit moves
 * you into the building next door, and until you have stood in that new place
 * and looked, its wall is not a contact and nothing is holding you out of it.
 * Manhattan is built on party walls, so this is not a rare shape.
 *
 * Measured against 4000 one-frame penetrations of a real footprint: one pass
 * leaves 1.90% of them still inside something, two leaves 0.85%, three leaves
 * 0.65%, and four and six are no better than three. Past three the residue is
 * gaps too narrow for a 2.4 m drone to occupy at all, which no number of passes
 * can fix because there is nowhere for it to go.
 */
const ITERATIONS = 3;

/**
 * Footprints this flat and this large are not buildings.
 *
 * OSM tags rail yards, pier decks and station train sheds as buildings, and
 * the renderer drops them for looking like dark plates lying in the water (see
 * buildings.ts). They must be dropped here too, or the drone bounces off a
 * hundred thousand square metres of nothing out in the Hudson.
 */
export const SLAB_MAX_HEIGHT_M = 8;
export const SLAB_MIN_AREA_M2 = 20000;

/** Shorter than this and the renderer does not extrude it either. */
export const MIN_HEIGHT_M = 0.5;

/**
 * Narrowest footprint the drone can be pushed out of coherently, in metres.
 *
 * OSM carries a scattering of footprints under a metre wide and fifteen long:
 * a party wall, a canopy or a fence that someone tagged as a building. They are
 * invisible in the render and they are a trap for any local solver -- a drone
 * 2.4 m across that ends a frame inside one has both its faces pushing back at
 * it, and it shuttles between them. Dropping them costs 93 of Manhattan's
 * 186,891 footprints, and every one of those 93 is something the renderer draws
 * as a sliver you would never aim at.
 *
 * Measured as 4 x area / perimeter, which is the width of a long thin rectangle.
 */
export const MIN_THICKNESS_M = 1.5;

export interface CollisionStats {
  /** Footprints actually indexed, after the degenerate and slab drops. */
  buildings: number;
  cells: number;
  maxPerCell: number;
  /** Total size of the index, so a regression in memory is visible too. */
  bytes: number;
}

export function ringPerimeter(ring: Float32Array): number {
  let p = 0;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1]);
  }
  return p;
}

export function ringArea(ring: Float32Array): number {
  let a = 0;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return a * 0.5;
}

export class CityCollision {
  /** minX, minZ, maxX, maxZ per indexed building. */
  private readonly aabb: Float32Array;
  /** baseY, topY per indexed building, absolute world metres. */
  private readonly span: Float32Array;
  /** Start vertex of building i in `verts`; `ringOff[i + 1]` is its end. */
  private readonly ringOff: Int32Array;
  /** Every footprint's x,z pairs, back to back. */
  private readonly verts: Float32Array;

  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly gw: number;
  private readonly gh: number;

  private readonly count: number;

  /** Dedupe for the gather: a building straddling two queried cells is one
   *  candidate, not two. Stamped with a generation so it never needs clearing. */
  private readonly stamp: Int32Array;
  private gen = 0;
  private cand: Int32Array;
  private order: Int32Array;
  private depth: Float64Array;

  /** Push direction from the last `contact()`. Fields, not a returned vector,
   *  because `resolve` runs every frame and must not allocate. */
  private nx = 0;
  private ny = 0;
  private nz = 0;

  readonly stats: CollisionStats;

  constructor(pack: CityPack, heightAt: (x: number, z: number) => number) {
    const all = pack.buildings;
    const cap = all.length;

    const aabb = new Float32Array(cap * 4);
    const span = new Float32Array(cap * 2);
    const ringOff = new Int32Array(cap + 1);
    const src: Float32Array[] = [];

    let n = 0;
    let vTotal = 0;
    let minXAll = Infinity, minZAll = Infinity, maxXAll = -Infinity, maxZAll = -Infinity;

    for (let i = 0; i < cap; i++) {
      const b = all[i];
      const nv = b.ring.length / 2;
      // Same bail as addBuilding: a ring with fewer than three vertices has no
      // interior, and every inside/outside test below would divide by zero
      // working that out.
      if (nv < 3) continue;
      const h = b.topM - b.baseM;
      if (h <= MIN_HEIGHT_M) continue;
      const area = Math.abs(ringArea(b.ring));
      if (h < SLAB_MAX_HEIGHT_M && area > SLAB_MIN_AREA_M2) continue;
      const perimeter = ringPerimeter(b.ring);
      if (perimeter < 1e-6 || (4 * area) / perimeter < MIN_THICKNESS_M) continue;

      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let v = 0; v < b.ring.length; v += 2) {
        const x = b.ring[v], z = b.ring[v + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minZ)) continue;

      // The terrain is sampled ONCE per building, here. Doing it per frame per
      // candidate would put a DEM lookup and a lat/lon conversion inside the
      // narrowphase, which is the most expensive thing in this file by an
      // order of magnitude and cannot change between frames anyway.
      const groundY = footprintGroundY(b, heightAt);
      if (!Number.isFinite(groundY)) continue;

      aabb[n * 4] = minX;
      aabb[n * 4 + 1] = minZ;
      aabb[n * 4 + 2] = maxX;
      aabb[n * 4 + 3] = maxZ;
      span[n * 2] = groundY + b.baseM;
      span[n * 2 + 1] = groundY + b.topM;
      ringOff[n] = vTotal;
      src.push(b.ring);
      vTotal += nv;
      n++;

      if (minX < minXAll) minXAll = minX;
      if (minZ < minZAll) minZAll = minZ;
      if (maxX > maxXAll) maxXAll = maxX;
      if (maxZ > maxZAll) maxZAll = maxZ;
    }
    ringOff[n] = vTotal;

    this.count = n;
    this.aabb = aabb;
    this.span = span;
    this.ringOff = ringOff;

    const verts = new Float32Array(vTotal * 2);
    for (let i = 0; i < n; i++) verts.set(src[i], ringOff[i] * 2);
    this.verts = verts;

    this.stamp = new Int32Array(n);
    this.cand = new Int32Array(256);
    this.order = new Int32Array(256);
    this.depth = new Float64Array(256);

    if (n === 0) {
      this.gx0 = this.gz0 = this.gw = this.gh = 0;
      this.cellStart = new Int32Array(1);
      this.cellItems = new Int32Array(0);
      this.stats = { buildings: 0, cells: 0, maxPerCell: 0, bytes: 0 };
      return;
    }

    // Cells are anchored to the world origin rather than to the pack's bounds,
    // so the index of a point is a floor() and never a subtraction that has to
    // agree with how the bounds were rounded.
    const gx0 = Math.floor(minXAll / CELL_M);
    const gz0 = Math.floor(minZAll / CELL_M);
    const gw = Math.floor(maxXAll / CELL_M) - gx0 + 1;
    const gh = Math.floor(maxZAll / CELL_M) - gz0 + 1;
    this.gx0 = gx0;
    this.gz0 = gz0;
    this.gw = gw;
    this.gh = gh;

    // Counting sort into one flat bucket array: pass one counts, prefix-sum
    // turns the counts into offsets, pass two fills. No per-cell array is ever
    // allocated.
    const nc = gw * gh;
    const cellStart = new Int32Array(nc + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const cx0 = Math.floor(aabb[i * 4] / CELL_M) - gx0;
      const cz0 = Math.floor(aabb[i * 4 + 1] / CELL_M) - gz0;
      const cx1 = Math.floor(aabb[i * 4 + 2] / CELL_M) - gx0;
      const cz1 = Math.floor(aabb[i * 4 + 3] / CELL_M) - gz0;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          cellStart[cz * gw + cx + 1]++;
          total++;
        }
      }
    }
    for (let c = 0; c < nc; c++) cellStart[c + 1] += cellStart[c];

    const cellItems = new Int32Array(total);
    const cursor = cellStart.slice(0, nc);
    for (let i = 0; i < n; i++) {
      const cx0 = Math.floor(aabb[i * 4] / CELL_M) - gx0;
      const cz0 = Math.floor(aabb[i * 4 + 1] / CELL_M) - gz0;
      const cx1 = Math.floor(aabb[i * 4 + 2] / CELL_M) - gx0;
      const cz1 = Math.floor(aabb[i * 4 + 3] / CELL_M) - gz0;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cz * gw + cx;
          cellItems[cursor[c]++] = i;
        }
      }
    }
    this.cellStart = cellStart;
    this.cellItems = cellItems;

    let maxPerCell = 0;
    for (let c = 0; c < nc; c++) {
      const k = cellStart[c + 1] - cellStart[c];
      if (k > maxPerCell) maxPerCell = k;
    }

    this.stats = {
      buildings: n,
      cells: nc,
      maxPerCell,
      bytes:
        aabb.byteLength + span.byteLength + ringOff.byteLength + verts.byteLength +
        cellStart.byteLength + cellItems.byteLength + this.stamp.byteLength,
    };
  }

  /**
   * Push `position` out of any building it has entered and remove the velocity
   * component going INTO the surface, leaving the tangential part. Mutates both.
   */
  resolve(position: THREE.Vector3, velocity: THREE.Vector3, radius: number): void {
    if (this.count === 0) return;
    const px0 = position.x, py0 = position.y, pz0 = position.z;
    // A NaN here would be stamped into the position permanently, and every
    // frame after it would be a NaN too. Bail rather than launder it.
    if (!Number.isFinite(px0) || !Number.isFinite(py0) || !Number.isFinite(pz0)) return;
    if (!(radius > 0)) return;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const m = this.gather(position.x, position.z, radius);
      if (m === 0) return;

      let hits = 0;
      for (let k = 0; k < m; k++) {
        const b = this.cand[k];
        const d = this.contact(b, position.x, position.y, position.z, radius);
        if (d > 0) {
          this.order[hits] = b;
          this.depth[hits] = d;
          hits++;
        }
      }
      if (hits === 0) return;

      // Deepest first. Insertion sort because `hits` is single digits in
      // practice -- even wedged into a corner it is three or four -- and a
      // comparator-based sort would allocate a closure every frame.
      for (let a = 1; a < hits; a++) {
        const bi = this.order[a], bd = this.depth[a];
        let j = a - 1;
        while (j >= 0 && this.depth[j] < bd) {
          this.depth[j + 1] = this.depth[j];
          this.order[j + 1] = this.order[j];
          j--;
        }
        this.depth[j + 1] = bd;
        this.order[j + 1] = bi;
      }

      for (let k = 0; k < hits; k++) {
        // Recomputed against the position as it is NOW, not as it was when the
        // list was sorted: an earlier push may already have cleared this one.
        const d = this.contact(this.order[k], position.x, position.y, position.z, radius);
        if (d <= 0) continue;
        const nx = this.nx, ny = this.ny, nz = this.nz;
        position.x += nx * d;
        position.y += ny * d;
        position.z += nz * d;
        // Slide. Only the into-the-surface part of the velocity is removed, so
        // speed along a facade survives contact with it.
        const vn = velocity.x * nx + velocity.y * ny + velocity.z * nz;
        if (vn < 0) {
          velocity.x -= nx * vn;
          velocity.y -= ny * vn;
          velocity.z -= nz * vn;
        }
      }
    }
  }

  /** Buildings whose cell the drone's circle touches, deduplicated. */
  private gather(px: number, pz: number, r: number): number {
    let cx0 = Math.floor((px - r) / CELL_M) - this.gx0;
    let cz0 = Math.floor((pz - r) / CELL_M) - this.gz0;
    let cx1 = Math.floor((px + r) / CELL_M) - this.gx0;
    let cz1 = Math.floor((pz + r) / CELL_M) - this.gz0;
    if (cx1 < 0 || cz1 < 0 || cx0 >= this.gw || cz0 >= this.gh) return 0;
    if (cx0 < 0) cx0 = 0;
    if (cz0 < 0) cz0 = 0;
    if (cx1 >= this.gw) cx1 = this.gw - 1;
    if (cz1 >= this.gh) cz1 = this.gh - 1;

    const g = ++this.gen;
    let m = 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * this.gw;
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = row + cx;
        const end = this.cellStart[c + 1];
        for (let k = this.cellStart[c]; k < end; k++) {
          const b = this.cellItems[k];
          if (this.stamp[b] === g) continue;
          this.stamp[b] = g;
          if (m === this.cand.length) this.grow();
          this.cand[m++] = b;
        }
      }
    }
    return m;
  }

  private grow(): void {
    const bigger = new Int32Array(this.cand.length * 2);
    bigger.set(this.cand);
    this.cand = bigger;
    this.order = new Int32Array(bigger.length);
    this.depth = new Float64Array(bigger.length);
  }

  /**
   * Penetration depth of the drone into building `i`, with the outward push
   * direction left in `nx/ny/nz`. Zero means no contact.
   *
   * The drone is a circle in plan with a vertical extent rather than a capsule.
   * At 1.2 m against buildings whose smallest feature is a metre of window
   * reveal, the difference between the two is not something anyone can fly.
   */
  private contact(i: number, px: number, py: number, pz: number, r: number): number {
    const a = i * 4;
    if (px < this.aabb[a] - r || px > this.aabb[a + 2] + r) return 0;
    if (pz < this.aabb[a + 1] - r || pz > this.aabb[a + 3] + r) return 0;

    // Vertical first, because it is two compares and it throws away most of
    // the city: from any altitude worth flying, the buildings are mostly under
    // you rather than beside you.
    //
    // It is an EARLY-OUT, not the thing that makes a roof passable. Above a
    // roof the minimum-translation below already comes out negative (the way
    // up is behind you), so removing these two lines costs frame time and
    // changes no answer. That is deliberate: correctness that depends on a
    // fast path is correctness that disappears the day someone tunes it.
    const baseY = this.span[i * 2];
    const topY = this.span[i * 2 + 1];
    if (py > topY + r || py < baseY - r) return 0;

    // Closest point on the footprint BOUNDARY, and whether the centre is
    // inside it, in one pass over the ring.
    const s = this.ringOff[i];
    const e = this.ringOff[i + 1];
    const v = this.verts;
    let bestD2 = Infinity, bx = 0, bz = 0;
    let inside = false;
    let jx = v[(e - 1) * 2], jz = v[(e - 1) * 2 + 1];
    for (let k = s; k < e; k++) {
      const vx = v[k * 2], vz = v[k * 2 + 1];

      // Ray crossing to the +x side.
      if ((vz > pz) !== (jz > pz)) {
        if (px < vx + ((pz - vz) / (jz - vz)) * (jx - vx)) inside = !inside;
      }

      const ex = vx - jx, ez = vz - jz;
      const l2 = ex * ex + ez * ez;
      // A zero-length edge (the packs do contain a few) would make t a NaN and
      // poison the whole closest-point search, so it collapses to the vertex.
      let t = l2 > 1e-12 ? ((px - jx) * ex + (pz - jz) * ez) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = jx + ex * t, cz = jz + ez * t;
      const dx = px - cx, dz = pz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bx = cx; bz = cz; }

      jx = vx; jz = vz;
    }

    const dist = Math.sqrt(bestD2);
    let depthH: number, hx: number, hz: number;
    if (inside) {
      depthH = dist + r;
      // Dead centre on the boundary has no direction; any is as good as any
      // other and the next iteration will have a real one.
      if (dist > 1e-6) { hx = (bx - px) / dist; hz = (bz - pz) / dist; }
      else { hx = 1; hz = 0; }
    } else {
      if (dist >= r) return 0;
      depthH = r - dist;
      if (dist > 1e-6) { hx = (px - bx) / dist; hz = (pz - bz) / dist; }
      else { hx = 1; hz = 0; }
    }

    // Minimum translation: out the side, or up onto the roof, or down out of
    // the soffit -- whichever is nearest.
    //
    // Getting this from the min is what makes a roof solid without a special
    // case for landing on one. Descending onto a roof, the distance up to
    // `topY + r` shrinks to nothing while the distance out to the nearest wall
    // is half a block, so the drone is pushed UP and settles on the roof; the
    // same drone at street level inside the same tower is a hundred metres
    // from the roof and two from the wall, so it is pushed out into the street.
    let best = depthH;
    this.nx = hx; this.ny = 0; this.nz = hz;

    const up = topY + r - py;
    if (up < best) { best = up; this.nx = 0; this.ny = 1; this.nz = 0; }

    // Downward escape only from genuinely UNDER the building. Without the
    // guard, a drone in a low building at street level finds `baseY - r` closer
    // than the wall and is pushed through the pavement, where the terrain
    // clamp shoves it straight back in.
    if (py < baseY) {
      const down = py - (baseY - r);
      if (down < best) { best = down; this.nx = 0; this.ny = -1; this.nz = 0; }
    }

    return best;
  }
}
