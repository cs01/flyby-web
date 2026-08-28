// The rooftops, as a height field the flight model can ask about.
//
// The aircraft's floor used to be the TERRAIN, which over Manhattan meant it
// flew through the Empire State Building without noticing. This is the coarse
// answer to "how high is the tallest thing under me", so the floor can be the
// rooftop where there is one and the ground where there is not.
//
// It is a GRID rather than the polygons, and a deliberately coarse one. A
// building has to be a solid the aeroplane cannot enter, and it does NOT have
// to be the exact solid: the aeroplane is 11 m across, it is following a floor
// with 25 m of clearance over it, and nobody flying this can tell a 32 m cell
// from a true footprint. What they can tell is the frame rate, and a polygon
// test against 187,000 buildings every frame would cost it.
//
// Each building is stamped as its BOUNDING BOX, which over-covers slightly.
// That is the right direction to be wrong in: a floor that is a little too
// generous stops you clipping a corner you could not see coming, whereas one
// that is a little too tight lets you through the wall of a tower.

import type { CityPack } from "../data/citypack";

/** Metres per cell. About a building wide, which is the resolution that keeps
 *  a street a street instead of filling it in. */
const CELL = 32;

/** Returned where nothing is built, so max() against the terrain is a no-op. */
const NOTHING = -1e9;

export class Skyline {
  private grid: Float32Array;
  private n = 0;
  private extent = 0;

  constructor(pack: CityPack | null, groundAt: (x: number, z: number) => number) {
    if (!pack || pack.buildings.length === 0) {
      this.grid = new Float32Array(0);
      return;
    }
    this.extent = Math.max(500, pack.radiusM);
    this.n = Math.max(1, Math.ceil((this.extent * 2) / CELL));
    this.grid = new Float32Array(this.n * this.n).fill(NOTHING);

    for (const b of pack.buildings) {
      // One ground sample per building, at its centre, rather than the lowest
      // under the footprint the renderer uses. The two differ by a few metres
      // on a hillside, which is nothing against 25 m of clearance, and it is
      // the difference between one lookup per building and one per vertex.
      const top = groundAt(b.cx, b.cz) + b.topM;
      if (!Number.isFinite(top)) continue;

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < b.ring.length; i += 2) {
        const x = b.ring[i];
        const z = b.ring[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

      const x0 = this.index(minX);
      const x1 = this.index(maxX);
      const z0 = this.index(minZ);
      const z1 = this.index(maxZ);
      if (x1 < 0 || z1 < 0 || x0 >= this.n || z0 >= this.n) continue;

      for (let gz = Math.max(0, z0); gz <= Math.min(this.n - 1, z1); gz++) {
        const row = gz * this.n;
        for (let gx = Math.max(0, x0); gx <= Math.min(this.n - 1, x1); gx++) {
          if (top > this.grid[row + gx]) this.grid[row + gx] = top;
        }
      }
    }
  }

  private index(w: number): number {
    return Math.floor((w + this.extent) / CELL);
  }

  /**
   * Highest rooftop over the cell containing this point, in world metres, or a
   * very negative number where nothing is built. Callers max() it against the
   * terrain, so "nothing here" has to lose that comparison rather than being a
   * separate case every caller remembers to handle.
   */
  topAt(x: number, z: number): number {
    if (this.n === 0) return NOTHING;
    const gx = this.index(x);
    const gz = this.index(z);
    if (gx < 0 || gz < 0 || gx >= this.n || gz >= this.n) return NOTHING;
    return this.grid[gz * this.n + gx];
  }
}
