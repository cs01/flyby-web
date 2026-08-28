// Reader for the binary .land landcover packs produced by tools/bake-land.ts.
//
// The source is ESA WorldCover 10 m (v200, 2021), a global categorical raster
// shipped as ~87 MB Deflate-tiled GeoTIFFs on S3. Nothing about that shape can
// sit in a page load: the pyramid is not a slippy tile scheme, the payloads are
// zlib rather than an image codec the browser can decode, and one 3-degree
// sheet is bigger than the whole rest of the app. So the classes are resampled
// once, offline, onto the scene's own local grid and shipped as raw bytes.
//
// Two levels per pack, for the same reason src/data/dem.ts builds a near field
// and a far field: one grid fine enough to see the park you are flying over and
// wide enough to put a coastline on the horizon would be tens of megabytes and
// pointless, because the far field is never seen at close range.
//
// The format is defined once, here and in the baker, and the two must agree
// byte for byte. Every field is little-endian and written back to back with no
// alignment padding.
//
//   u32  magic 0x4C414E44 ("LAND")
//   u32  version 1
//   f64  lat0, f64 lon0        scene origin the grids are centred on
//   u8   levelCount
//   per level:
//     f32  extentM             half-width in metres about (lat0, lon0)
//     u16  n                   grid is n x n
//     u8   class[n*n]          index [k * n + i]
//
// This file is deliberately PURE: no fetch, no cache, no DOM. The bake verifier
// runs it under Bun with no DOM lib at all, which is what lets the same parser
// that the browser uses be the thing that gates a bake. A reader that only ran
// in a browser could not be the oracle for the writer.

export const LAND_MAGIC = 0x4c414e44;

/** ESA WorldCover class codes, verbatim. They are sparse and non-sequential
 *  (95 sits between 90 and 100) because they are the published codes, not an
 *  index; renumbering them would silently diverge from every other tool that
 *  reads this dataset. */
export enum LandClass {
  NoData = 0,
  Tree = 10,
  Shrub = 20,
  Grass = 30,
  Crop = 40,
  Built = 50,
  Bare = 60,
  Snow = 70,
  Water = 80,
  Wetland = 90,
  Mangrove = 95,
  Moss = 100,
}

/** Every legal byte value in a pack payload. Anything else means a decode bug
 *  in the baker, not an exotic class. */
export const LAND_CLASS_CODES: readonly LandClass[] = [
  LandClass.NoData, LandClass.Tree, LandClass.Shrub, LandClass.Grass,
  LandClass.Crop, LandClass.Built, LandClass.Bare, LandClass.Snow,
  LandClass.Water, LandClass.Wetland, LandClass.Mangrove, LandClass.Moss,
];

export const LAND_CLASS_NAMES: Readonly<Record<number, string>> = {
  0: "nodata", 10: "tree", 20: "shrub", 30: "grass", 40: "crop", 50: "built",
  60: "bare", 70: "snow", 80: "water", 90: "wetland", 95: "mangrove", 100: "moss",
};

export interface LandLevel {
  /** Half-width in metres the grid spans about the pack origin. */
  extentM: number;
  /** Side length in texels; the grid is n x n. */
  n: number;
  /** Class code per texel, indexed `[k * n + i]`. */
  cls: Uint8Array;
}

export interface LandPack {
  lat0: number;
  lon0: number;
  /** Finest first. */
  levels: LandLevel[];
}

/**
 * Class at a point in local ENU metres, clamp-to-edge outside the grid.
 *
 * The `k * n + i` / `(z + extent) / cell` convention here is the same one
 * src/render/urbanmask.ts uses for its own grid, deliberately: both end up as
 * textures over the scene origin, so sharing the convention means one set of UV
 * maths in the shader can sample either.
 */
export function sampleLand(level: LandLevel, x: number, z: number): LandClass {
  const { extentM, n, cls } = level;
  const cell = (extentM * 2) / n;
  let i = Math.floor((x + extentM) / cell);
  let k = Math.floor((z + extentM) / cell);
  if (i < 0) i = 0; else if (i >= n) i = n - 1;
  if (k < 0) k = 0; else if (k >= n) k = n - 1;
  return cls[k * n + i] as LandClass;
}

export function parseLandPack(buf: ArrayBuffer): LandPack {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;

  const magic = dv.getUint32(o, true); o += 4;
  if (magic !== LAND_MAGIC) {
    throw new Error(`not a .land pack (magic 0x${magic.toString(16)})`);
  }
  const version = dv.getUint32(o, true); o += 4;
  if (version !== 1) throw new Error(`unsupported .land version ${version}`);

  const lat0 = dv.getFloat64(o, true); o += 8;
  const lon0 = dv.getFloat64(o, true); o += 8;
  const levelCount = dv.getUint8(o); o += 1;

  const levels: LandLevel[] = new Array(levelCount);
  for (let l = 0; l < levelCount; l++) {
    const extentM = dv.getFloat32(o, true); o += 4;
    const n = dv.getUint16(o, true); o += 2;
    const count = n * n;
    if (o + count > bytes.length) {
      throw new Error(`level ${l} wants ${count} bytes, ${bytes.length - o} left`);
    }
    // Copied, not a view: the payload must outlive the ArrayBuffer the caller
    // handed in, and a detached-transferable view would be a nasty surprise.
    levels[l] = { extentM, n, cls: bytes.slice(o, o + count) };
    o += count;
  }

  return { lat0, lon0, levels };
}
