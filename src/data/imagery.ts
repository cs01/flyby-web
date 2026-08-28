// Satellite imagery to drape over the terrain, stitched from ESRI's World
// Imagery service (keyless, CORS-open, verified live).
//
// Draped photography is doing something specific here that a procedural ground
// texture cannot: it puts the parks, the water colour, the runway paint and the
// street grid in the RIGHT PLACES, so the terrain under the extruded buildings
// reads as the same city the buildings came from. Without it you get accurate
// geometry standing on generic green, and the illusion dies at ground level.
//
// One stitched texture per LOD ring rather than per-tile textures: a ring is
// drawn as one mesh with one draw call, and 49 separate textures would mean 49.

import { fetchImage } from "./cache";
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from "../geo";
import type { Bbox } from "./dem";

const ESRI =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

/** ESRI serves 256 px tiles and orders the path as {z}/{y}/{x}, not {z}/{x}/{y}. */
const TILE_PX = 256;

export interface StitchedImage {
  canvas: OffscreenCanvas;
  /** The bbox actually covered, snapped out to whole tiles. */
  bbox: Bbox;
}

/**
 * Stitch every imagery tile overlapping `bbox` at zoom `z` into one canvas.
 *
 * Missing tiles are left as the ocean-blue fill rather than transparent: a hole
 * in the drape over water is invisible, while a transparent hole shows whatever
 * the clear colour is and reads as a rendering bug.
 */
export async function stitchImagery(bbox: Bbox, z: number): Promise<StitchedImage> {
  const x0 = Math.floor(lonToTileX(bbox.west, z));
  const x1 = Math.floor(lonToTileX(bbox.east, z));
  const y0 = Math.floor(latToTileY(bbox.north, z));
  const y1 = Math.floor(latToTileY(bbox.south, z));

  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;
  const canvas = new OffscreenCanvas(nx * TILE_PX, ny * TILE_PX);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#1b3a52";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const n = 2 ** z;
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      const url = `${ESRI}/${z}/${ty}/${wx}`;
      const dx = (tx - x0) * TILE_PX;
      const dy = (ty - y0) * TILE_PX;
      jobs.push(
        fetchImage(url)
          .then((bmp) => {
            ctx.drawImage(bmp, dx, dy, TILE_PX, TILE_PX);
            bmp.close();
          })
          .catch(() => {}),
      );
    }
  }
  await Promise.all(jobs);

  return {
    canvas,
    bbox: {
      west: tileXToLon(x0, z),
      east: tileXToLon(x1 + 1, z),
      north: tileYToLat(y0, z),
      south: tileYToLat(y1 + 1, z),
    },
  };
}
