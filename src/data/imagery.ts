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
  /** Tiles that never arrived, even after retries and the coarser fallback. */
  missing: number;
  /** Tiles filled from the parent zoom instead of their own level. */
  coarse: number;
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
  let missing = 0;
  let coarse = 0;

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      const dx = (tx - x0) * TILE_PX;
      const dy = (ty - y0) * TILE_PX;
      jobs.push(
        (async () => {
          // Two retries with backoff. ESRI rate-limits a burst, and a whole
          // ring is hundreds of tiles requested at once, so a handful of them
          // failing on the first attempt is the NORMAL case rather than the
          // exceptional one.
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const bmp = await fetchImage(`${ESRI}/${z}/${ty}/${wx}`);
              ctx.drawImage(bmp, dx, dy, TILE_PX, TILE_PX);
              bmp.close();
              return;
            } catch {
              if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1) ** 2));
            }
          }

          // Still nothing: draw the matching quarter of the PARENT tile,
          // upscaled. Half the resolution is invisible from the air; a flat
          // rectangle of fill colour with hard tile edges is not, and that is
          // what this used to leave behind -- silently, because the failure was
          // swallowed by an empty catch and never counted.
          if (z > 2) {
            try {
              const px = wx >> 1;
              const py = ty >> 1;
              const bmp = await fetchImage(`${ESRI}/${z - 1}/${py}/${px}`);
              const half = TILE_PX / 2;
              ctx.drawImage(
                bmp,
                (wx & 1) * half, (ty & 1) * half, half, half,
                dx, dy, TILE_PX, TILE_PX,
              );
              bmp.close();
              coarse++;
              return;
            } catch {
              // fall through
            }
          }
          missing++;
        })(),
      );
    }
  }
  await Promise.all(jobs);

  // Say so. A hole in the drape is a flat rectangle with hard tile edges, and
  // it reads as a rendering bug rather than as a download that did not finish.
  if (missing > 0 || coarse > 0) {
    const total = nx * ny;
    console.warn(
      `[flyby] imagery z${z}: ${missing}/${total} tiles missing, ${coarse} filled from z${z - 1}`,
    );
  }

  return {
    missing,
    coarse,
    canvas,
    bbox: {
      west: tileXToLon(x0, z),
      east: tileXToLon(x1 + 1, z),
      north: tileYToLat(y0, z),
      south: tileYToLat(y1 + 1, z),
    },
  };
}

/**
 * Pick the zoom whose ground resolution puts a `spanM`-wide box at roughly
 * `targetPx` across. Capped at 17: ESRI has imagery deeper than that but the
 * tile count grows as 4^z and the drape stops being the limiting detail once
 * buildings are on it.
 */
export function zoomForSpan(lat: number, spanM: number, targetPx = 2048): number {
  const worldM = 2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180);
  const z = Math.log2((worldM * targetPx) / (spanM * TILE_PX));
  return Math.max(2, Math.min(17, Math.round(z)));
}
