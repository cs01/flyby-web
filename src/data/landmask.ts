// Turns a .land level's categorical class codes into the four coverage
// fractions the terrain shader actually wants, packed RGBA8.
//
//   R  water        (80, plus 0/nodata: the baker documents holes as open sea)
//   G  built        (50)
//   B  vegetation   (10 tree, 20 shrub, 30 grass, 40 crop, 90 wetland,
//                    95 mangrove, 100 moss)
//   A  bare or snow (60, 70)
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
  [LandClass.Shrub]: 2,
  [LandClass.Grass]: 2,
  [LandClass.Crop]: 2,
  [LandClass.Wetland]: 2,
  [LandClass.Mangrove]: 2,
  [LandClass.Moss]: 2,
  [LandClass.Bare]: 3,
  [LandClass.Snow]: 3,
};

export interface MaskSample {
  water: number;
  built: number;
  veg: number;
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
    // would silently flood a city; call it bare, which is inert.
    const ch = CHANNEL_OF_CLASS[cls[t]] ?? 3;
    rgba[t * 4 + ch] = 255;
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

  return { water: out[0], built: out[1], veg: out[2], bare: out[3] };
}
