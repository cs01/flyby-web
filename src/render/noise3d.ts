// The two 3D noise volumes the cloud march samples, baked on the CPU at start.
//
// Why baked rather than evaluated in the shader. The march calls the density
// function once per step and three more times per light step, so a procedural
// fbm is the innermost loop of the innermost loop: every octave costs eight
// hashes and a trilinear blend, per sample, per pixel, forever. A texture fetch
// costs one filtered read and the hardware does the trilinear blend in silicon.
// The bake is paid once, in milliseconds, at load.
//
// Why Perlin-WORLEY rather than plain fbm. Value or Perlin noise is a field of
// smooth blobs with no billow to it; a cloud's silhouette is made of packed
// rounded lumps, which is exactly what inverted Worley (cellular) noise is.
// Remapping Perlin by a Worley fbm keeps Perlin's large-scale wandering and
// gives its inside the cauliflower structure. This is Schneider's Nubis
// formulation, and the combine itself lives in the shader.
//
// Everything here is TILEABLE over the unit cube, because the shader wraps the
// volume across kilometres of sky. A seam would be a straight line in the
// clouds, which is the one thing a sky never has.
//
// Cost: both volumes together bake in ~194 ms on an M-series laptop, measured
// and logged at every start as "[flyby] cloud noise baked in N ms". It runs
// inside the "building world" phase of a load that already spends seconds on
// terrain tiles, so it is not a stall anyone can see. It is the Worley that
// costs: 64^3 voxels x 3 frequencies x a 27-cell neighbourhood is 21 million
// distance tests and no arrangement of the loops avoids them.

import * as THREE from "three";

/** Deterministic, so the sky is the same shape on every machine and reload. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The 12 edge-midpoint gradients of Perlin's improved noise. They are all the
// same length, which is what keeps the field free of the directional bias a
// set of random gradients would leave.
const GRAD = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

function permutation(rand: () => number): Uint8Array {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  p.copyWithin(256, 0, 256);
  return p;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Perlin noise that repeats every `period` cells on each axis.
 *
 * Tiling is the whole reason the lattice coordinates are taken modulo the
 * period before they are hashed: the corner at x = period must hash to the same
 * gradient as the corner at x = 0 or the volume does not join up with itself.
 */
function perlin(x: number, y: number, z: number, period: number, p: Uint8Array): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const z0 = ((zi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const z1 = (z0 + 1) % period;

  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);

  const dot = (hx: number, hy: number, hz: number, dx: number, dy: number, dz: number): number => {
    const g = (p[p[p[hx] + hy] + hz] % 12) * 3;
    return GRAD[g] * dx + GRAD[g + 1] * dy + GRAD[g + 2] * dz;
  };

  const n000 = dot(x0, y0, z0, fx, fy, fz);
  const n100 = dot(x1, y0, z0, fx - 1, fy, fz);
  const n010 = dot(x0, y1, z0, fx, fy - 1, fz);
  const n110 = dot(x1, y1, z0, fx - 1, fy - 1, fz);
  const n001 = dot(x0, y0, z1, fx, fy, fz - 1);
  const n101 = dot(x1, y0, z1, fx - 1, fy, fz - 1);
  const n011 = dot(x0, y1, z1, fx, fy - 1, fz - 1);
  const n111 = dot(x1, y1, z1, fx - 1, fy - 1, fz - 1);

  const a = n000 + u * (n100 - n000);
  const b = n010 + u * (n110 - n010);
  const c = n001 + u * (n101 - n001);
  const d = n011 + u * (n111 - n011);
  const e = a + v * (b - a);
  const f = c + v * (d - c);
  return e + w * (f - e);
}

/** One jittered feature point per cell of a `cells^3` grid, as flat xyz. */
function featurePoints(cells: number, rand: () => number): Float32Array {
  const pts = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = rand();
  return pts;
}

/**
 * Inverted Worley: 1 at a cell's feature point, falling to 0 between them, so
 * it reads as packed billows rather than as a net of cracks.
 *
 * Distances are measured in CELL units and the 3x3x3 neighbourhood wraps, which
 * is what makes the field tile. Clamping at one cell is safe because a point in
 * the central cell can never be further than that from the nearest of 27
 * candidates.
 */
function worley(
  fx: number, fy: number, fz: number,
  cells: number, pts: Float32Array,
): number {
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  let best = 4;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = iz + dz;
    const wz = ((cz % cells) + cells) % cells;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = iy + dy;
      const wy = ((cy % cells) + cells) % cells;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx;
        const wx = ((cx % cells) + cells) % cells;
        const o = ((wz * cells + wy) * cells + wx) * 3;
        const ox = cx + pts[o] - fx;
        const oy = cy + pts[o + 1] - fy;
        const oz = cz + pts[o + 2] - fz;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 < best) best = d2;
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

function worleyFbm(
  x: number, y: number, z: number,
  cells: number, a: Float32Array, b: Float32Array, c: Float32Array,
): [number, number, number] {
  return [
    worley(x * cells, y * cells, z * cells, cells, a),
    worley(x * cells * 2, y * cells * 2, z * cells * 2, cells * 2, b),
    worley(x * cells * 4, y * cells * 4, z * cells * 4, cells * 4, c),
  ];
}

function volume(size: number, data: Uint8Array): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // All three axes repeat: the shader wraps this volume across the whole sky.
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const SHAPE_SIZE = 64;
const DETAIL_SIZE = 32;

/**
 * The cloud's silhouette. 64^3 RGBA8: R is a 3-octave tileable Perlin, GBA are
 * inverted Worley at one, two and four times the base cell frequency, which the
 * shader folds into a Worley fbm to erode the Perlin with.
 */
export function makeShapeNoise(): THREE.Data3DTexture {
  const rand = mulberry32(0x5eed10);
  const perm = permutation(rand);
  const CELLS = 4;
  const w1 = featurePoints(CELLS, rand);
  const w2 = featurePoints(CELLS * 2, rand);
  const w4 = featurePoints(CELLS * 4, rand);

  const n = SHAPE_SIZE;
  const data = new Uint8Array(n * n * n * 4);
  const inv = 1 / n;
  for (let z = 0; z < n; z++) {
    const fz = z * inv;
    for (let y = 0; y < n; y++) {
      const fy = y * inv;
      for (let x = 0; x < n; x++) {
        const fx = x * inv;
        // Three octaves, each with double the period, so every one of them
        // tiles over the same unit cube.
        let s = 0;
        s += 0.5 * perlin(fx * 4, fy * 4, fz * 4, 4, perm);
        s += 0.25 * perlin(fx * 8, fy * 8, fz * 8, 8, perm);
        s += 0.125 * perlin(fx * 16, fy * 16, fz * 16, 16, perm);
        // Perlin lands in roughly +-0.7 of its amplitude sum; this maps it to
        // 0..1 with the mean at 0.5, which is what the coverage threshold in
        // the shader assumes.
        const p = Math.max(0, Math.min(1, s / (0.875 * 1.4) + 0.5));

        const [a, b, c] = worleyFbm(fx, fy, fz, CELLS, w1, w2, w4);
        const i = ((z * n + y) * n + x) * 4;
        data[i] = (p * 255) | 0;
        data[i + 1] = (a * 255) | 0;
        data[i + 2] = (b * 255) | 0;
        data[i + 3] = (c * 255) | 0;
      }
    }
  }
  return volume(n, data);
}

/**
 * The erosion detail, sampled only at the edges of a cloud. 32^3 with inverted
 * Worley at three frequencies in RGB.
 *
 * RGBA rather than the RGB this only needs: three.js dropped RGBFormat, and an
 * unsized three-component upload is a row-alignment trap for no saving worth
 * having on 32 KB.
 */
export function makeDetailNoise(): THREE.Data3DTexture {
  const rand = mulberry32(0xd37a11);
  const CELLS = 2;
  const w1 = featurePoints(CELLS, rand);
  const w2 = featurePoints(CELLS * 2, rand);
  const w4 = featurePoints(CELLS * 4, rand);

  const n = DETAIL_SIZE;
  const data = new Uint8Array(n * n * n * 4);
  const inv = 1 / n;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const [a, b, c] = worleyFbm(x * inv, y * inv, z * inv, CELLS, w1, w2, w4);
        const i = ((z * n + y) * n + x) * 4;
        data[i] = (a * 255) | 0;
        data[i + 1] = (b * 255) | 0;
        data[i + 2] = (c * 255) | 0;
        data[i + 3] = 255;
      }
    }
  }
  return volume(n, data);
}
