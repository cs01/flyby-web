// Turns a .land level's categorical class codes into the four coverage
// fractions the terrain shader actually wants, packed RGBA8.
//
//   R  water        (80, plus 0/nodata: the baker documents holes as open sea)
//   G  built        (50)
//   B  tree         (10 tree, 95 mangrove)
//   A  herbaceous   (20 shrub, 30 grass, 40 crop, 90 wetland, 100 moss)
//
// Bare and snow (60, 70) are NOT given a channel: the packing is one-hot, so
// they are exactly `1 - (R+G+B+A)` and cost nothing to carry implicitly.
//
// Tree used to share a channel with grass and crop, which threw away the one
// distinction the vegetation data exists to make. A forest and a lawn need
// different geometry (canopies versus a ground material), and no amount of
// shader work recovers the difference once it has been averaged into a single
// coverage number. WorldCover measured it; collapsing it here was discarding
// the measurement.
//
// The classes are collapsed here rather than in the shader because a GPU cannot
// filter a categorical raster: linear interpolation between class code 50 and
// class code 80 is 65, which is not a class at all. Interpolating COVERAGE is
// meaningful, so the reduction to fractions has to happen before the texture.
//
// Pure on purpose, exactly like citypack.ts: no THREE, no DOM, no fetch. That
// is what lets test/landmask.check.ts run the same maths under Bun that the GPU
// runs in the browser, and therefore be an oracle rather than a second opinion.

import { LandClass, type LandLevel } from "./landcover";

/** Channel each class contributes to, indexed by the raw WorldCover code. */
const CHANNEL_OF_CLASS: Readonly<Record<number, number>> = {
  [LandClass.NoData]: 0,
  [LandClass.Water]: 0,
  [LandClass.Built]: 1,
  [LandClass.Tree]: 2,
  [LandClass.Mangrove]: 2,
  [LandClass.Shrub]: 3,
  [LandClass.Grass]: 3,
  [LandClass.Crop]: 3,
  [LandClass.Wetland]: 3,
  [LandClass.Moss]: 3,
  // Bare and snow deliberately have no channel; see the header. -1 means "no
  // channel", which the writer skips, leaving the texel summing to under one.
  [LandClass.Bare]: -1,
  [LandClass.Snow]: -1,
};

export interface MaskSample {
  water: number;
  built: number;
  /** Canopy: tree and mangrove. Drives where trees get planted. */
  tree: number;
  /** Grass, shrub, crop, wetland, moss. Drives ground material, not geometry. */
  herb: number;
  /** Derived, not stored: bare and snow are whatever the others are not. */
  bare: number;
}

/**
 * RGBA8 coverage at the level's own resolution, one-hot per texel.
 *
 * Deliberately NOT blurred, and the instinct to add a blur "like urbanmask
 * does" is wrong here. urbanmask blurs an 85 m grid of building footprints
 * because street lighting genuinely spills past a block boundary. This grid is
 * a 10 m posting of a measured raster, and the GPU's own linear filter already
 * spreads a shoreline across one texel, which is the correct softness for
 * 10 m data. A 3x3 pre-blur on top would smear every coast by ~30 m and turn
 * the near-shore water into a half-lit band.
 */
export function buildLandMaskRGBA(level: LandLevel): Uint8Array {
  const { n, cls } = level;
  const rgba = new Uint8Array(n * n * 4);
  for (let t = 0; t < cls.length; t++) {
    // An unknown code would be a decode bug in the baker, and calling it water
    // would silently flood a city; leave it bare, which is inert and is also
    // what an absent channel means.
    //
    // -1 is bare/snow, which is carried as the remainder rather than stored.
    // Writing it would index t*4 - 1, i.e. the PREVIOUS texel's alpha, so the
    // guard is not defensive padding: without it, every bare texel corrupts its
    // neighbour.
    const ch = CHANNEL_OF_CLASS[cls[t]] ?? -1;
    if (ch >= 0) rgba[t * 4 + ch] = 255;
  }
  return rgba;
}

/**
 * The bilinear filter the GPU will run, in JS: same texel centres, same
 * clamp-to-edge, same weights.
 *
 * This is the whole reason the check can gate on geography. If it were a
 * nearest-neighbour lookup, or sampled at texel corners, it would disagree with
 * the shader by half a texel at every edge and stop being an oracle.
 */
export function sampleMaskBilinear(
  rgba: Uint8Array,
  n: number,
  extentM: number,
  x: number,
  z: number,
): MaskSample {
  const cell = (extentM * 2) / n;
  // Texel centres sit at (i + 0.5) * cell, hence the half-texel shift.
  const fx = (x + extentM) / cell - 0.5;
  const fz = (z + extentM) / cell - 0.5;
  const i0 = Math.floor(fx);
  const k0 = Math.floor(fz);
  const tx = fx - i0;
  const tz = fz - k0;

  const clampI = (v: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const i0c = clampI(i0), i1c = clampI(i0 + 1);
  const k0c = clampI(k0), k1c = clampI(k0 + 1);

  const out = [0, 0, 0, 0];
  const corners: [number, number, number][] = [
    [i0c, k0c, (1 - tx) * (1 - tz)],
    [i1c, k0c, tx * (1 - tz)],
    [i0c, k1c, (1 - tx) * tz],
    [i1c, k1c, tx * tz],
  ];
  for (const [i, k, w] of corners) {
    const o = (k * n + i) * 4;
    for (let c = 0; c < 4; c++) out[c] += w * (rgba[o + c] / 255);
  }

  // Bare is the remainder, so a texel that is 100% bare reports every stored
  // channel at zero and bare at one, and the five always sum to one.
  const bare = Math.max(0, 1 - (out[0] + out[1] + out[2] + out[3]));
  return { water: out[0], built: out[1], tree: out[2], herb: out[3], bare };
}

/**
 * Distance in metres from each texel centre to the nearest LAND texel centre,
 * zero on land. Exact Euclidean (Felzenszwalb and Huttenlocher's two-pass
 * lower envelope), because a chamfer approximation is off by up to 8% along
 * diagonals and this number becomes a fetch, a foam band and a shallow tint.
 *
 * Water is what the R channel of buildLandMaskRGBA means: the water class and
 * nodata. Only land is a source, so the GRID EDGE is not a shore: a bay that
 * runs off the side of the near level reads as open water there, which is what
 * it is, rather than as a coast that does not exist.
 *
 * Why the water needs this at all: the waves on a 60 m river and on a 5 km bay
 * under the same wind differ by an order of magnitude in wavelength (the fetch
 * they have had to grow over), and the foam and the shallows live within
 * metres of a coast. The mask alone says "water"; it cannot say how much of it
 * there is around a pixel.
 */
export function shoreDistanceM(level: LandLevel): Float32Array {
  const { n, cls } = level;
  const cell = (level.extentM * 2) / n;
  const INF = 1e20;
  const f = new Float32Array(n * n);
  for (let t = 0; t < cls.length; t++) {
    f[t] = CHANNEL_OF_CLASS[cls[t]] === 0 ? INF : 0;
  }
  const line = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const edt1d = (): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const d = q - v[k];
      out[q] = d * d + line[v[k]];
    }
  };
  // Columns, then rows; squared distances in texels throughout.
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) line[k] = f[k * n + i];
    edt1d();
    for (let k = 0; k < n; k++) f[k * n + i] = out[k];
  }
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) line[i] = f[k * n + i];
    edt1d();
    for (let i = 0; i < n; i++) f[k * n + i] = out[i];
  }
  // A grid with no land at all is still INF everywhere: open sea, which the
  // encoder clamps.
  for (let t = 0; t < f.length; t++) f[t] = Math.sqrt(f[t]) * cell;
  return f;
}

/**
 * Shore distance packed for an 8-bit texture: sqrt(d / maxM), so the first few
 * metres off a coast (where the foam and the shallows live) get most of the
 * 256 codes and the open water past maxM saturates. A float texture would be
 * simpler and is exactly what the unresolved Android black-buildings report
 * suspects, so the ground stays on 8-bit.
 */
export function encodeShoreDistance(d: Float32Array, maxM: number): Uint8Array {
  const out = new Uint8Array(d.length);
  for (let t = 0; t < d.length; t++) {
    out[t] = Math.round(255 * Math.sqrt(Math.min(1, d[t] / maxM)));
  }
  return out;
}
