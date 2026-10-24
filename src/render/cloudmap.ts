// The cloud WEATHER MAP: a tileable 2D field over 48 km of sky that decides
// where cloud may exist before any 3D noise is consulted.
//
// Why this exists. Coverage used to be a threshold on the 3D shape noise alone,
// and that noise tiles every 1.8 km. The result was what the owner's phone
// showed: equal puffs spread evenly over the whole sky, a texture rather than a
// weather. A real fair-weather sky is CLUSTERED. Cumulus grow over the thermals
// a surface throws up, thermals organise at kilometre scales, and the sky is a
// few fields of cloud with wide blue lanes between them. That structure is a
// property of the map, not of the billows, so it lives in its own texture at
// its own scale (Schneider's Nubis weather map, generated rather than painted).
//
// Channels, all 0..1, all tileable over the unit square:
//   R  cell field: a cellular (one cumulus per cell) noise multiplied by a
//      regional field 6 to 16 km across, then HISTOGRAM-EQUALISED. Equalising
//      is what lets the shader read "cover" literally: thresholding a uniform
//      field at 1 - c selects a fraction c of the map, whatever the noise did.
//   G  type jitter, low frequency: some cells more cumuliform than the deck.
//   B  thickness/base undulation, low frequency.
//   A  a second, independent equalised cell field for the mid deck, so the
//      altocumulus does not sit as a copy above the cumulus.
//
// Cost: 512^2 texels, ~40 ms on an M-series laptop, logged with the 3D noise.

import * as THREE from "three";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lattice gradients for 2D Perlin, one random unit vector per cell, tileable by `period`. */
function gradients(period: number, rand: () => number): Float32Array {
  const g = new Float32Array(period * period * 2);
  for (let i = 0; i < period * period; i++) {
    const a = rand() * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 2D Perlin over [0,1)^2 with `period` cells, about -0.7..0.7. */
function perlin2(u: number, v: number, period: number, g: Float32Array): number {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const dot = (cx: number, cy: number, dx: number, dy: number): number => {
    const i = (cy * period + cx) * 2;
    return g[i] * dx + g[i + 1] * dy;
  };
  const a = dot(x0, y0, fx, fy);
  const b = dot(x1, y0, fx - 1, fy);
  const c = dot(x0, y1, fx, fy - 1);
  const d = dot(x1, y1, fx - 1, fy - 1);
  const su = fade(fx);
  const sv = fade(fy);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

/**
 * Inverted 2D Worley with `cells` per side: 1 at a feature point, 0 a cell
 * away. Each feature point is one cloud cell, so this is the field that makes
 * cumulus come one at a time instead of as a continuous froth.
 */
function worley2(u: number, v: number, cells: number, pts: Float32Array): number {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let best = 4;
  for (let dy = -1; dy <= 1; dy++) {
    const cy = iy + dy;
    const wy = ((cy % cells) + cells) % cells;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const wx = ((cx % cells) + cells) % cells;
      const o = (wy * cells + wx) * 2;
      const ox = cx + pts[o] - x;
      const oy = cy + pts[o + 1] - y;
      const d2 = ox * ox + oy * oy;
      if (d2 < best) best = d2;
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

function points(cells: number, rand: () => number): Float32Array {
  const p = new Float32Array(cells * cells * 2);
  for (let i = 0; i < p.length; i++) p[i] = rand();
  return p;
}

/** Rank-transform `f` in place to a uniform 0..1 distribution (4096-bin CDF). */
function equalise(f: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of f) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const BINS = 4096;
  const hist = new Float64Array(BINS + 1);
  const k = BINS / Math.max(hi - lo, 1e-9);
  for (const v of f) hist[Math.min(BINS - 1, ((v - lo) * k) | 0)]++;
  // Mid-bin CDF, so the value at a bin is the fraction strictly below it plus
  // half its own population: a threshold at 1 - c then selects c of the map.
  const cdf = new Float64Array(BINS);
  let acc = 0;
  for (let i = 0; i < BINS; i++) {
    cdf[i] = (acc + hist[i] * 0.5) / f.length;
    acc += hist[i];
  }
  for (let i = 0; i < f.length; i++) {
    const x = (f[i] - lo) * k;
    const b = Math.min(BINS - 1, x | 0);
    // Linear within the bin keeps the 8-bit result free of plateaus.
    const nb = Math.min(BINS - 1, b + 1);
    const t = x - b;
    f[i] = cdf[b] + (cdf[nb] - cdf[b]) * Math.min(1, Math.max(0, t));
  }
}

/** World metres one repeat of the weather map spans. */
export const WEATHER_MAP_METRES = 48000;
const SIZE = 512;

/** One equalised cell field: cells of ~`cellM` metres, clustered by a regional field. */
function cellField(rand: () => number, cellM: number): Float32Array {
  const cells = Math.round(WEATHER_MAP_METRES / cellM);
  const pA = points(cells, rand);
  const pB = points(cells * 2, rand);
  // Regional: 16 km and 8 km Perlin. These are the cloud FIELDS and the blue
  // lanes between them.
  const r1 = Math.round(WEATHER_MAP_METRES / 16000);
  const r2 = r1 * 2;
  const gR1 = gradients(r1, rand);
  const gR2 = gradients(r2, rand);
  // A small warp so cells are not Voronoi-regular.
  const wP = Math.round(WEATHER_MAP_METRES / 3000);
  const gW1 = gradients(wP, rand);
  const gW2 = gradients(wP, rand);

  const f = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE;
      const v = (y + 0.5) / SIZE;
      const wu = u + perlin2(u, v, wP, gW1) * (0.6 / cells);
      const wv = v + perlin2(u, v, wP, gW2) * (0.6 / cells);
      const cell = worley2(wu, wv, cells, pA) * 0.75 + worley2(wu, wv, cells * 2, pB) * 0.25;
      const reg = 0.5 + 0.9 * (perlin2(u, v, r1, gR1) + 0.5 * perlin2(u, v, r2, gR2));
      const regional = Math.min(1, Math.max(0, reg));
      // A PRODUCT, not a sum: where the region is unfavourable no cell can
      // win, which is what empties the lanes. 0.25 of the cell term survives
      // everywhere so an overcast threshold still finds cellular structure.
      f[y * SIZE + x] = cell * (0.25 + 0.75 * regional);
    }
  }
  equalise(f);
  return f;
}

export function makeWeatherMap(): THREE.DataTexture {
  const rand = mulberry32(0xc10d5);
  const low = cellField(rand, 1500);
  const mid = cellField(rand, 900);
  const tP = Math.round(WEATHER_MAP_METRES / 12000);
  const gT = gradients(tP, rand);
  const bP = Math.round(WEATHER_MAP_METRES / 6000);
  const gB1 = gradients(bP, rand);
  const gB2 = gradients(bP * 2, rand);

  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE;
      const v = (y + 0.5) / SIZE;
      const i = y * SIZE + x;
      const type = Math.min(1, Math.max(0, 0.5 + perlin2(u, v, tP, gT)));
      const thick = Math.min(1, Math.max(0, 0.5 + 0.8 * (perlin2(u, v, bP, gB1) + 0.5 * perlin2(u, v, bP * 2, gB2))));
      data[i * 4] = Math.round(low[i] * 255);
      data[i * 4 + 1] = Math.round(type * 255);
      data[i * 4 + 2] = Math.round(thick * 255);
      data[i * 4 + 3] = Math.round(mid[i] * 255);
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  // Mipmapped: past ~30 km a texel is smaller than a pixel and the shader asks
  // for a coarser level by distance (textureLod), or the far deck sparkles.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
