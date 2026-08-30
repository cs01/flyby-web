// Keeping the sharp ground under a vehicle that moves along the ground.
//
// THE PROBLEM THIS EXISTS FOR. render/budget.ts plans a 400 m detail ring at
// zoom 18, and its own comment says why it is only 400 m: drape cost grows as
// (extent x zoom)^2, so 400 m at zoom 18 is 64 tiles and 17 MB while the same
// zoom over the 2.2 km ring would be 1,760 tiles and 460 MB. That trade is
// right, and it makes the ring a BUBBLE round the spawn point that an aircraft
// leaves in seconds. From an aeroplane that is fine, because the pixellation it
// fixes is a low-and-slow problem. From a car it is fatal: you are out of the
// bubble in twenty seconds and everything past it is 1.9 m per pixel, which at
// an eye height of a metre and a half is mush.
//
// So the bubble follows. This file owns WHEN it moves and the fetch that makes
// that possible; render/terrain.ts owns the geometry swap.
//
// WHY IT DOES NOT HITCH. Three things, and all three are needed.
//
//   * The stitch is asynchronous and off the frame. It is a few dozen HTTP
//     requests the first time and an IndexedDB read every time after, because
//     data/cache.ts is a permanent budgeted cache built for exactly this.
//   * The swap is atomic. The old drape and the old geometry stay on screen,
//     correct, until the new pair is complete; then both are assigned in one
//     pass. Nothing renders half-swapped, so there is no flash.
//   * The rings under it are RE-INDEXED, not rebuilt. Moving the square means a
//     different set of quads is skipped, and that is an index buffer, not fifty
//     thousand height lookups. See RingGrid in render/terrain.ts.
//
// The one cost that cannot be moved off the frame is the texture upload: a
// 2048 px RGBA canvas with mipmaps is about 22 MB going to the GPU, and the
// driver does that on the first draw after the swap.

import type { Origin } from "../geo";
import type { Terrain } from "./terrain";
import type { TerrainRing } from "./budget";
import { stitchImagery } from "../data/imagery";
import { bboxAround } from "../data/dem";

/**
 * How far the camera may drift from the ring centre before a move is asked
 * for, in metres.
 *
 * With a 400 m half-extent this leaves at least 260 m of sharp ground in the
 * worst direction while the next stitch runs, which at the car's top speed of
 * 22 m/s is nearly twelve seconds. A tighter trigger would restitch more often
 * for no visible gain; a looser one runs the bubble's edge into the windscreen.
 */
const TRIGGER_M = 140;

/**
 * Seconds of velocity the new centre is placed AHEAD of the camera.
 *
 * A car spends its whole life driving into ground it has not seen, so centring
 * the bubble on where it is wastes half of it on the road behind. Four seconds
 * at 22 m/s is 88 m of bias, which is a fifth of the ring: enough to matter and
 * far short of putting the camera near the trailing edge.
 */
const LOOKAHEAD_S = 4;

/**
 * Grid the new centre is snapped to, in metres.
 *
 * Two reasons. It stops a camera hovering near the trigger radius from asking
 * for a new stitch every frame at a slightly different centre, and it makes the
 * tile set repeat between sessions, so the second drive down a street is served
 * entirely from IndexedDB.
 */
const SNAP_M = 32;

/** Imagery is stitched over a bbox 5% larger than the ring; see main.ts. */
const MARGIN = 1.05;

export interface DetailRingStats {
  /** Swaps completed. */
  moves: number;
  /** Milliseconds the last stitch took, fetch included. */
  lastStitchMs: number;
  /** Milliseconds the last geometry-and-upload swap took on the frame. */
  lastApplyMs: number;
  /** Worst apply seen, which is the number that says whether it hitches. */
  worstApplyMs: number;
  /** True while a stitch is in flight. */
  pending: boolean;
  /** Tiles the last stitch could not get at its own zoom. */
  lastMissing: number;
  lastCoarse: number;
}

export class DetailRing {
  readonly stats: DetailRingStats = {
    moves: 0,
    lastStitchMs: 0,
    lastApplyMs: 0,
    worstApplyMs: 0,
    pending: false,
    lastMissing: 0,
    lastCoarse: 0,
  };

  private readonly origin: Origin;
  private readonly terrain: Terrain;
  private readonly ring: TerrainRing;
  private inFlight = false;

  constructor(origin: Origin, terrain: Terrain, ring: TerrainRing) {
    this.origin = origin;
    this.terrain = terrain;
    this.ring = ring;
  }

  /**
   * Follow a camera. Safe to call every frame; it does nothing until the
   * camera has actually left the bubble.
   *
   * `vx`/`vz` are metres per second, used only to bias the new centre forward.
   */
  follow(x: number, z: number, vx: number, vz: number): void {
    if (this.inFlight) return;
    const centre = this.terrain.detailCentre;
    if (Math.hypot(x - centre.x, z - centre.z) <= TRIGGER_M) return;

    const tx = Math.round((x + vx * LOOKAHEAD_S) / SNAP_M) * SNAP_M;
    const tz = Math.round((z + vz * LOOKAHEAD_S) / SNAP_M) * SNAP_M;
    // Snapping can land back on the square that is already up, which would be a
    // fetch and a swap that changed nothing.
    if (tx === centre.x && tz === centre.z) return;

    this.inFlight = true;
    this.stats.pending = true;
    void this.move(tx, tz);
  }

  private async move(x: number, z: number): Promise<void> {
    const t0 = performance.now();
    try {
      const ll = this.origin.toLatLon(x, z);
      const drape = await stitchImagery(
        bboxAround(ll.lat, ll.lon, this.ring.extent * MARGIN),
        this.ring.imageryZoom,
      );
      this.stats.lastStitchMs = performance.now() - t0;
      this.stats.lastMissing = drape.missing;
      this.stats.lastCoarse = drape.coarse;

      const t1 = performance.now();
      this.terrain.recentreDetail(x, z, drape);
      this.stats.lastApplyMs = performance.now() - t1;
      this.stats.worstApplyMs = Math.max(this.stats.worstApplyMs, this.stats.lastApplyMs);
      this.stats.moves++;
    } catch (err) {
      // A failed stitch leaves the ring exactly where it was, which is a
      // slightly stale bubble rather than a hole in the world. Worth one line
      // in the log and nothing more.
      console.warn("[flyby] detail ring restitch failed, keeping the old drape", err);
    } finally {
      this.inFlight = false;
      this.stats.pending = false;
    }
  }
}
