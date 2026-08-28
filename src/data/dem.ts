// Terrain elevation from AWS Terrain Tiles (NASA SRTM + friends), "terrarium"
// encoding, keyless and CORS-open.
//
//   elevation_m = (R * 256 + G + B / 256) - 32768
//
// The encoding is exact for integer metres and has 1/256 m of headroom below
// that, so there is no reason to smooth it on decode; what looks like terracing
// in the result is real SRTM quantisation, not a decode bug.
//
// Two fields get built per scene rather than one. A single field big enough to
// put mountains on the horizon (150 km) and fine enough to shape a hill under
// the aircraft (30 m) would be 5000^2 samples, which is 100 MB and pointless:
// the far field is never seen at close range. So the near field is high zoom
// over a small box, the far field is low zoom over a large one, and the mesher
// asks whichever one covers the point it needs.

import { fetchImage } from "./cache";
import { latToTileY, lonToTileX, tileYToLat, tileXToLon, clamp } from "../geo";

const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE_PX = 256;

/** Terrarium's void marker decodes to this; it sits over open ocean. */
const SEA = 0;

export interface Bbox {
  west: number;
  east: number;
  south: number;
  north: number;
}

/**
 * A regular lat/lon grid of elevations. Sampling is bilinear in geodetic space,
 * which is a small shear against the Mercator source but is under a metre over
 * a city-sized box and keeps the sampler independent of tile layout.
 */
export class Heightfield {
  readonly bbox: Bbox;
  readonly w: number;
  readonly h: number;
  readonly data: Float32Array;
  /** Set once every contributing tile resolved, successfully or not. */
  loaded = false;

  constructor(bbox: Bbox, w: number, h: number) {
    this.bbox = bbox;
    this.w = w;
    this.h = h;
    this.data = new Float32Array(w * h);
  }

  /** Elevation in metres at a geodetic point, clamped to the field's edge. */
  sample(lat: number, lon: number): number {
    const { west, east, south, north } = this.bbox;
    const fx = clamp(((lon - west) / (east - west)) * (this.w - 1), 0, this.w - 1);
    const fy = clamp(((north - lat) / (north - south)) * (this.h - 1), 0, this.h - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.w - 1);
    const y1 = Math.min(y0 + 1, this.h - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const d = this.data;
    const a = d[y0 * this.w + x0];
    const b = d[y0 * this.w + x1];
    const c = d[y1 * this.w + x0];
    const e = d[y1 * this.w + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }

  contains(lat: number, lon: number): boolean {
    const b = this.bbox;
    return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  }
}

function decodeTerrarium(bmp: ImageBitmap): Float32Array {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Float32Array(bmp.width * bmp.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    // Terrarium carries BATHYMETRY below zero. Rendering it gives an ocean
    // made of sea floor, with seamounts standing out of the water. Clamping at
    // sea level costs the handful of genuinely below-sea-level land areas a few
    // metres of depth (New Orleans, the Netherlands) and is invisible there,
    // while making every coastline correct.
    const e = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
    out[i] = e < 0 ? 0 : e;
  }
  bmp.close();
  return out;
}

/**
 * Build a heightfield covering `bbox` at slippy zoom `z`.
 *
 * Resolves as soon as the grid is allocated so a caller can mesh a flat world
 * immediately; `field.loaded` flips and `onTile` fires as tiles land, which is
 * what lets the terrain pop in rather than blocking the first frame.
 */
export async function loadHeightfield(
  bbox: Bbox,
  z: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Heightfield> {
  const x0 = Math.floor(lonToTileX(bbox.west, z));
  const x1 = Math.floor(lonToTileX(bbox.east, z));
  const y0 = Math.floor(latToTileY(bbox.north, z));
  const y1 = Math.floor(latToTileY(bbox.south, z));

  // Snap the field to whole tiles: sampling then never interpolates across a
  // boundary it has no data for, and the seam artefacts that causes disappear.
  const snapped: Bbox = {
    west: tileXToLon(x0, z),
    east: tileXToLon(x1 + 1, z),
    north: tileYToLat(y0, z),
    south: tileYToLat(y1 + 1, z),
  };

  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;
  const field = new Heightfield(snapped, nx * TILE_PX, ny * TILE_PX);

  const jobs: Promise<void>[] = [];
  let done = 0;
  const total = nx * ny;

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const n = 2 ** z;
      const wx = ((tx % n) + n) % n;
      const url = `${TERRARIUM}/${z}/${wx}/${ty}.png`;
      const ox = (tx - x0) * TILE_PX;
      const oy = (ty - y0) * TILE_PX;
      jobs.push(
        fetchImage(url)
          .then((bmp) => {
            const t = decodeTerrarium(bmp);
            for (let r = 0; r < TILE_PX; r++) {
              field.data.set(
                t.subarray(r * TILE_PX, (r + 1) * TILE_PX),
                (oy + r) * field.w + ox,
              );
            }
          })
          .catch(() => {
            // A 404 here is ocean or a gap in coverage, not a failure worth
            // aborting the flight over. Leave it at sea level.
            for (let r = 0; r < TILE_PX; r++) {
              field.data.fill(SEA, (oy + r) * field.w + ox, (oy + r) * field.w + ox + TILE_PX);
            }
          })
          .finally(() => onProgress?.(++done, total)),
      );
    }
  }

  await Promise.all(jobs);
  despike(field);
  field.loaded = true;
  return field;
}

/**
 * Remove isolated needles from a heightfield.
 *
 * SRTM has a well-known speckle artefact over water and low-contrast terrain:
 * single postings hundreds of metres above everything touching them. Rendered
 * as a heightfield they become sharp cones standing out of the sea, which is
 * the single most obviously-fake thing in the frame.
 *
 * Isolation is the discriminator, not height. A real cliff, ridge or summit
 * always has at least one neighbour near its own elevation, because terrain is
 * continuous at a 30 m posting. A sample that towers over ALL FOUR neighbours
 * is not a landform. That keeps El Capitan and deletes the speckle, where a
 * plain median or smoothing pass would soften every real cliff in the scene.
 */
function despike(f: Heightfield, threshold = 55): void {
  const { w, h, data } = f;
  // Collect first, then write: patching in place would let a repaired sample
  // become the "neighbour" that hides the next spike along.
  const fixes: [number, number][] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i];
      const n = [data[i - 1], data[i + 1], data[i - w], data[i + w]];
      let maxN = -Infinity;
      for (const t of n) if (t > maxN) maxN = t;
      if (v - maxN <= threshold) continue;
      n.sort((a, b) => a - b);
      fixes.push([i, (n[1] + n[2]) / 2]);
    }
  }
  for (const [i, v] of fixes) data[i] = v;
}

/** Widen a point into a square bbox of `radiusM` metres. */
export function bboxAround(lat: number, lon: number, radiusM: number): Bbox {
  const dLat = radiusM / 111132;
  const dLon = radiusM / (111412 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
}
