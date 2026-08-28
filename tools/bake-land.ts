// Bakes ESA WorldCover 10 m landcover into a compact binary `.land` pack, one
// per city, mirroring the `.city` packs next to them.
//
// Source: ESA WorldCover v200 (2021), public on S3, no key, CORS-open:
//   .../v200/2021/map/ESA_WorldCover_10m_2021_v200_{TILE}_Map.tif
// {TILE} names a 3-degree sheet by its SOUTH-WEST corner (N36W123, S34E018);
// the raster's own top-left is therefore the sheet's NORTH-WEST corner. Each
// sheet is a ~87 MB classic little-endian GeoTIFF, Deflate-compressed, tiled
// 1024x1024, with an overview pyramid that halves 36000 -> 18000 -> 9000 -> ...
// all at the same tiling. Nothing here downloads a whole sheet: the first 64 KB
// carries the header, every IFD and both tile-offset arrays, which is enough to
// plan every subsequent byte range.
//
//   bun tools/bake-land.ts --city sf
//   bun tools/bake-land.ts --all [--force]
//
// The projection comes from ../src/geo, and the grid indexing convention from
// ../src/render/urbanmask.ts. Re-deriving either here would put the landcover
// beside the terrain instead of on it.

import { CITIES, cityById, type City } from "../src/cities";
import { Origin } from "../src/geo";
import { LAND_MAGIC, LAND_CLASS_NAMES, LandClass } from "../src/data/landcover";
// Bun.inflateSync FAILS on these payloads with "invalid stored block lengths",
// on tiles node:zlib decodes correctly (a 64385-byte payload inflates to
// exactly 1048576 bytes). Do not "simplify" this back to the Bun builtin.
import { inflateSync } from "node:zlib";
import { readdirSync } from "node:fs";

/** Repo root, with a trailing slash. Derived from this file's own URL so the
 *  script works from any cwd. */
const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);

// --- tunables -------------------------------------------------------------

const CACHE_DIR = `${ROOT}tools/.cache/land`;
const BASE_URL =
  "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map";

/** One 3-degree sheet, 36000 px across at full resolution. */
const SHEET_DEG = 3;
const SHEET_PX = 36000;

/** The header, every IFD and both u32 offset arrays fit inside this. Verified
 *  against the live files; a sheet that does not is a format change, not a
 *  tuning problem, so it throws rather than reading further. */
const HEADER_READ_BYTES = 65536;

const POLITE_DELAY_MS = 100; // S3, not a volunteer Overpass instance
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;

/** Near field then far field, the same split src/data/dem.ts makes: 10 m per
 *  texel over 12 km, then ~137 m per texel out to the horizon. */
const LEVELS: { extentM: number; n: number }[] = [
  { extentM: 6000, n: 1200 },
  { extentM: 70000, n: 1024 },
];

/**
 * Absence and nodata both become water. This is an ASSUMPTION about the
 * dataset, not a property of the format: WorldCover ships no sheet where there
 * is no land, and its nodata inside a sheet sits over open water, so the only
 * thing a hole can reasonably be is sea. Anywhere else it would be wrong.
 */
const ABSENT = LandClass.Water;

// --- TIFF -----------------------------------------------------------------

const TAG_WIDTH = 256;
const TAG_HEIGHT = 257;
const TAG_COMPRESSION = 259;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_PREDICTOR = 317;

const COMPRESSION_ADOBE_DEFLATE = 8;
const COMPRESSION_DEFLATE = 32946;

interface Ifd {
  width: number;
  height: number;
  tileWidth: number;
  tileLength: number;
  tilesAcross: number;
  offsets: number[];
  byteCounts: number[];
}

/** What one source sheet's 64 KB header read boils down to. `missing` records a
 *  404 so an offline re-bake does not re-ask for a sheet that does not exist. */
interface Sheet {
  missing: boolean;
  ifds: Ifd[];
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

/** TIFF stores a field inline in the entry when its payload fits in 4 bytes and
 *  out of line otherwise; getting that backwards reads the offset as data. */
function readField(dv: DataView, entryOff: number, type: number, count: number): number[] {
  const size = TYPE_SIZE[type];
  if (size === undefined) throw new Error(`unsupported TIFF field type ${type}`);
  const total = size * count;
  const base = total <= 4 ? entryOff + 8 : dv.getUint32(entryOff + 8, true);
  if (base + total > dv.byteLength) {
    throw new Error(`TIFF field at ${base}+${total} is past the ${dv.byteLength}-byte header read`);
  }
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = base + i * size;
    switch (type) {
      case 1:
      case 2:
        out[i] = dv.getUint8(o);
        break;
      case 3:
        out[i] = dv.getUint16(o, true);
        break;
      case 4:
        out[i] = dv.getUint32(o, true);
        break;
      default:
        out[i] = dv.getFloat64(o, true);
        break;
    }
  }
  return out;
}

function parseIfds(bytes: Uint8Array): Ifd[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== 0x49 || dv.getUint8(1) !== 0x49) {
    throw new Error("not a little-endian TIFF");
  }
  if (dv.getUint16(2, true) !== 42) throw new Error("not a classic TIFF (BigTIFF?)");

  const ifds: Ifd[] = [];
  let next = dv.getUint32(4, true);
  while (next !== 0) {
    if (next + 2 > bytes.length) {
      throw new Error(`IFD at ${next} is past the ${bytes.length}-byte header read`);
    }
    const entries = dv.getUint16(next, true);
    const fields = new Map<number, number[]>();
    for (let e = 0; e < entries; e++) {
      const off = next + 2 + e * 12;
      const tag = dv.getUint16(off, true);
      const type = dv.getUint16(off + 2, true);
      const count = dv.getUint32(off + 4, true);
      switch (tag) {
        case TAG_WIDTH:
        case TAG_HEIGHT:
        case TAG_COMPRESSION:
        case TAG_PREDICTOR:
        case TAG_TILE_WIDTH:
        case TAG_TILE_LENGTH:
        case TAG_TILE_OFFSETS:
        case TAG_TILE_BYTE_COUNTS:
          fields.set(tag, readField(dv, off, type, count));
          break;
        default:
          break;
      }
    }
    next = dv.getUint32(next + 2 + entries * 12, true);

    const one = (tag: number, what: string): number => {
      const v = fields.get(tag);
      if (!v || v.length === 0) throw new Error(`IFD has no ${what}`);
      return v[0];
    };
    const compression = one(TAG_COMPRESSION, "Compression");
    if (compression !== COMPRESSION_ADOBE_DEFLATE && compression !== COMPRESSION_DEFLATE) {
      throw new Error(`unexpected Compression ${compression}`);
    }
    const predictor = fields.get(TAG_PREDICTOR)?.[0] ?? 1;
    // Predictor 2 would mean horizontal differencing, which the sample loop
    // below does not undo. It is 1 in this dataset; assert rather than silently
    // decode garbage if that ever changes.
    if (predictor !== 1) throw new Error(`unexpected Predictor ${predictor}`);

    const width = one(TAG_WIDTH, "ImageWidth");
    const tileWidth = one(TAG_TILE_WIDTH, "TileWidth");
    const offsets = fields.get(TAG_TILE_OFFSETS);
    const byteCounts = fields.get(TAG_TILE_BYTE_COUNTS);
    if (!offsets || !byteCounts) throw new Error("IFD is not tiled");
    ifds.push({
      width,
      height: one(TAG_HEIGHT, "ImageLength"),
      tileWidth,
      tileLength: one(TAG_TILE_LENGTH, "TileLength"),
      tilesAcross: Math.ceil(width / tileWidth),
      offsets,
      byteCounts,
    });
  }
  return ifds;
}

// --- fetching -------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastRequestAt = 0;

/** Returns null for 404, which for this dataset means "no land here". */
async function rangeGet(url: string, range: string): Promise<Uint8Array | null> {
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = POLITE_DELAY_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(url, {
        headers: { Range: range, "User-Agent": "flyby-web bake-land (https://github.com/cs01/flyby-web)" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      lastRequestAt = Date.now();
      if (res.status === 404) {
        await res.text().catch(() => "");
        return null;
      }
      // Only 206 is acceptable. A 200 means the server ignored Range and is
      // about to hand back 87 MB, which is exactly what this tool exists to
      // avoid; treat it as a failure rather than draining it.
      if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
      lastErr = `${res.status} ${res.statusText}`;
      await res.text().catch(() => "");
    } catch (e) {
      lastRequestAt = Date.now();
      lastErr = e instanceof Error ? e.message : String(e);
    }
    const backoff = Math.min(30_000, 1000 * 2 ** attempt);
    process.stdout.write(`    retry in ${(backoff / 1000).toFixed(0)}s (${lastErr})\n`);
    await sleep(backoff);
  }
  throw new Error(`range fetch failed after ${MAX_ATTEMPTS} attempts (${range} of ${url}): ${lastErr}`);
}

function sheetUrl(name: string): string {
  return `${BASE_URL}/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;
}

const sheets = new Map<string, Sheet>();

async function loadSheet(name: string, force: boolean): Promise<Sheet> {
  const have = sheets.get(name);
  if (have) return have;

  const cachePath = `${CACHE_DIR}/${name}.hdr.json`;
  let sheet: Sheet | null = null;
  if (!force) {
    try {
      sheet = JSON.parse(await Bun.file(cachePath).text()) as Sheet;
    } catch {
      sheet = null;
    }
  }
  if (sheet === null) {
    const bytes = await rangeGet(sheetUrl(name), `bytes=0-${HEADER_READ_BYTES - 1}`);
    sheet = bytes === null ? { missing: true, ifds: [] } : { missing: false, ifds: parseIfds(bytes) };
    await Bun.write(cachePath, JSON.stringify(sheet));
    process.stdout.write(
      `    sheet ${name} ${sheet.missing ? "404 (open water)" : `${sheet.ifds.length} IFDs`}\n`,
    );
  }
  sheets.set(name, sheet);
  return sheet;
}

/** Decoded 1024x1024 class bytes, keyed sheet|ifd|tile. null means unavailable. */
const images = new Map<string, Uint8Array | null>();

async function loadImageTile(
  name: string,
  ifdIndex: number,
  tileIndex: number,
  force: boolean,
): Promise<void> {
  const key = `${name}|${ifdIndex}|${tileIndex}`;
  if (images.has(key)) return;

  const sheet = sheets.get(name);
  if (!sheet || sheet.missing) {
    images.set(key, null);
    return;
  }
  const ifd = sheet.ifds[ifdIndex];
  const byteCount = ifd.byteCounts[tileIndex];
  if (byteCount === undefined || byteCount === 0) {
    images.set(key, null);
    return;
  }

  const cachePath = `${CACHE_DIR}/${name}-i${ifdIndex}-t${tileIndex}.z`;
  let raw: Uint8Array | null = null;
  if (!force) {
    try {
      const f = Bun.file(cachePath);
      if (await f.exists()) raw = new Uint8Array(await f.arrayBuffer());
    } catch {
      raw = null;
    }
  }
  if (raw === null) {
    const off = ifd.offsets[tileIndex];
    raw = await rangeGet(sheetUrl(name), `bytes=${off}-${off + byteCount - 1}`);
    if (raw === null) {
      images.set(key, null);
      return;
    }
    await Bun.write(cachePath, raw);
  }

  const flat = new Uint8Array(inflateSync(raw));
  const want = ifd.tileWidth * ifd.tileLength;
  if (flat.length !== want) {
    throw new Error(`${key} inflated to ${flat.length} bytes, expected ${want}`);
  }
  images.set(key, flat);
}

// --- the global source grid ------------------------------------------------

/** Sheet name from the sheet's south-west corner, the way ESA names them. */
function sheetName(latSW: number, lonSW: number): string {
  const ns = latSW < 0 ? "S" : "N";
  const ew = lonSW < 0 ? "W" : "E";
  const la = String(Math.abs(latSW)).padStart(2, "0");
  const lo = String(Math.abs(lonSW)).padStart(3, "0");
  return `${ns}${la}${ew}${lo}`;
}

/**
 * One worldwide pixel grid per pyramid level, so a window straddling two or
 * four sheets needs no stitching logic of its own: a global (gx, gy) resolves
 * to sheet, then to image tile, then to a byte. Column 0 is the antimeridian
 * and row 0 the north pole, matching the sheets' own north-west-origin rasters.
 */
class SourceGrid {
  readonly ifdIndex: number;
  /** Pixels per sheet, so also pixels per SHEET_DEG degrees. */
  readonly px: number;
  readonly cols: number;
  readonly rows: number;
  private lastKey = "";
  private lastBuf: Uint8Array | null = null;

  constructor(ifdIndex: number) {
    this.ifdIndex = ifdIndex;
    this.px = SHEET_PX >> ifdIndex;
    this.cols = (360 / SHEET_DEG) * this.px;
    this.rows = (180 / SHEET_DEG) * this.px;
  }

  lonToGx(lon: number): number {
    return ((lon + 180) / SHEET_DEG) * this.px;
  }
  latToGy(lat: number): number {
    return ((90 - lat) / SHEET_DEG) * this.px;
  }

  sheetAt(gx: number, gy: number): string {
    const col = Math.floor(gx / this.px);
    const row = Math.floor(gy / this.px);
    return sheetName(90 - (row + 1) * SHEET_DEG, -180 + col * SHEET_DEG);
  }

  classAt(gxRaw: number, gyRaw: number): number {
    // Wrap in longitude, clamp in latitude: the slippy convention, and the only
    // sane answer at the poles, where there is no next row.
    const gx = ((gxRaw % this.cols) + this.cols) % this.cols;
    const gy = gyRaw < 0 ? 0 : gyRaw >= this.rows ? this.rows - 1 : gyRaw;

    const col = Math.floor(gx / this.px);
    const row = Math.floor(gy / this.px);
    const name = sheetName(90 - (row + 1) * SHEET_DEG, -180 + col * SHEET_DEG);
    const sheet = sheets.get(name);
    if (!sheet || sheet.missing) return ABSENT;
    const ifd = sheet.ifds[this.ifdIndex];

    const lx = gx - col * this.px;
    const ly = gy - row * this.px;
    const tx = Math.floor(lx / ifd.tileWidth);
    const ty = Math.floor(ly / ifd.tileLength);
    const key = `${name}|${this.ifdIndex}|${ty * ifd.tilesAcross + tx}`;
    // Row-major scanning means consecutive samples almost always land in the
    // same 1 MB tile; the memo turns a Map lookup per pixel into one per tile.
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lastBuf = images.get(key) ?? null;
    }
    if (this.lastBuf === null) return ABSENT;
    const v = this.lastBuf[(ly % ifd.tileLength) * ifd.tileWidth + (lx % ifd.tileWidth)];
    return v === 0 ? ABSENT : v;
  }
}

// --- resampling ------------------------------------------------------------

/**
 * The coarsest overview whose pixels are still no bigger than one output texel.
 *
 * This choice comes before the majority filter and matters more than it: at
 * IFD0 a 137 m texel would sample ~15x15 source pixels, and nearest-neighbour
 * across that returns whichever single pixel the texel centre happens to hit,
 * which is speckle. Picking the level first makes every window a couple of
 * pixels across, where a mode is both cheap and meaningful.
 *
 * Sized against metres per degree of LATITUDE, the larger of the two scales, so
 * the pixel is within the texel on both axes rather than just the tight one.
 */
function chooseIfd(texelM: number, mPerLat: number): number {
  let k = 0;
  while (k + 1 < 12) {
    const px = SHEET_PX >> (k + 1);
    if (px < 1024) break;
    if ((SHEET_DEG / px) * mPerLat > texelM) break;
    k++;
  }
  return k;
}

interface LevelResult {
  extentM: number;
  n: number;
  cls: Uint8Array;
  ifdIndex: number;
  sheetNames: string[];
  imageTiles: number;
}

async function bakeLevel(
  origin: Origin,
  extentM: number,
  n: number,
  force: boolean,
): Promise<LevelResult> {
  const cell = (extentM * 2) / n;
  const grid = new SourceGrid(chooseIfd(cell, origin.mPerLat));

  // The ENU projection is affine and axis-aligned, so a texel's longitude span
  // depends only on its column and its latitude span only on its row. Hoisting
  // both out of the inner loop turns 1.4M trig-free conversions into 2 * n.
  const colLo = new Int32Array(n);
  const colHi = new Int32Array(n);
  const colMid = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const xl = -extentM + i * cell;
    const a = grid.lonToGx(origin.lon + xl / origin.mPerLon);
    const b = grid.lonToGx(origin.lon + (xl + cell) / origin.mPerLon);
    const mid = Math.floor((a + b) / 2);
    // Source pixels whose CENTRE falls inside the texel. With the IFD chosen
    // above that is normally one or two; when the texel is narrower than a
    // pixel it is none, and the pixel under the texel centre stands in.
    let lo = Math.ceil(a - 0.5);
    let hi = Math.floor(b - 0.5);
    if (hi < lo) { lo = mid; hi = mid; }
    colLo[i] = lo;
    colHi[i] = hi;
    colMid[i] = mid;
  }

  const rowLo = new Int32Array(n);
  const rowHi = new Int32Array(n);
  const rowMid = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    // +z is SOUTH (see src/geo), so increasing k means decreasing latitude,
    // which means increasing gy. The two orderings agree; do not "fix" one.
    const zt = -extentM + k * cell;
    const a = grid.latToGy(origin.lat - zt / origin.mPerLat);
    const b = grid.latToGy(origin.lat - (zt + cell) / origin.mPerLat);
    const mid = Math.floor((a + b) / 2);
    let lo = Math.ceil(a - 0.5);
    let hi = Math.floor(b - 0.5);
    if (hi < lo) { lo = mid; hi = mid; }
    rowLo[k] = lo;
    rowHi[k] = hi;
    rowMid[k] = mid;
  }

  // --- prefetch every sheet header and image tile the window touches --------
  const gx0 = colLo[0];
  const gx1 = colHi[n - 1];
  const gy0 = rowLo[0];
  const gy1 = rowHi[n - 1];

  // Every sheet lookup below assumes the window is one contiguous run of global
  // columns. A box crossing the antimeridian is not, and none of the cities do,
  // so say so rather than baking a silently wrapped grid.
  if (gx0 < 0 || gx1 >= grid.cols) {
    throw new Error(`window crosses the antimeridian (gx ${gx0}..${gx1} of ${grid.cols})`);
  }

  const sheetNames = new Set<string>();
  for (let gy = gy0; gy <= gy1; gy = Math.min(gy1, (Math.floor(gy / grid.px) + 1) * grid.px - 1) + 1) {
    for (let gx = gx0; gx <= gx1; gx = Math.min(gx1, (Math.floor(gx / grid.px) + 1) * grid.px - 1) + 1) {
      sheetNames.add(grid.sheetAt(gx, gy));
    }
  }
  for (const name of sheetNames) await loadSheet(name, force);

  let imageTiles = 0;
  for (const name of sheetNames) {
    const sheet = sheets.get(name);
    if (!sheet || sheet.missing) continue;
    const ifd = sheet.ifds[grid.ifdIndex];
    if (!ifd || ifd.width !== grid.px) {
      throw new Error(`${name} IFD ${grid.ifdIndex} is ${ifd?.width} px, expected ${grid.px}`);
    }
    // Which slice of this sheet the window actually covers.
    const [latSW, lonSW] = [
      Number(name.slice(1, 3)) * (name[0] === "S" ? -1 : 1),
      Number(name.slice(4)) * (name[3] === "W" ? -1 : 1),
    ];
    const baseGx = grid.lonToGx(lonSW);
    const baseGy = grid.latToGy(latSW + SHEET_DEG);
    const lx0 = Math.max(0, gx0 - baseGx);
    const lx1 = Math.min(grid.px - 1, gx1 - baseGx);
    const ly0 = Math.max(0, gy0 - baseGy);
    const ly1 = Math.min(grid.px - 1, gy1 - baseGy);
    for (let ty = Math.floor(ly0 / ifd.tileLength); ty <= Math.floor(ly1 / ifd.tileLength); ty++) {
      for (let tx = Math.floor(lx0 / ifd.tileWidth); tx <= Math.floor(lx1 / ifd.tileWidth); tx++) {
        await loadImageTile(name, grid.ifdIndex, ty * ifd.tilesAcross + tx, force);
        imageTiles++;
      }
    }
  }

  // --- majority filter -----------------------------------------------------
  const cls = new Uint8Array(n * n);
  const counts = new Int32Array(256); // indexed by raw class byte, not by ordinal
  const touched: number[] = [];
  for (let k = 0; k < n; k++) {
    const gyLo = rowLo[k];
    const gyHi = rowHi[k];
    for (let i = 0; i < n; i++) {
      const gxLo = colLo[i];
      const gxHi = colHi[i];
      let best = ABSENT as number;
      let bestN = 0;
      for (let gy = gyLo; gy <= gyHi; gy++) {
        for (let gx = gxLo; gx <= gxHi; gx++) {
          const c = grid.classAt(gx, gy);
          const nc = ++counts[c];
          if (nc === 1) touched.push(c);
          if (nc > bestN) {
            bestN = nc;
            best = c;
          }
        }
      }
      // A two- or four-sample window ties often. Break towards the pixel under
      // the texel centre, so the result degrades to nearest-neighbour rather
      // than to whichever corner the scan happened to visit first.
      const mid = grid.classAt(colMid[i], rowMid[k]);
      if (counts[mid] === bestN) best = mid;
      for (const c of touched) counts[c] = 0;
      touched.length = 0;
      cls[k * n + i] = best;
    }
  }

  return { extentM, n, cls, ifdIndex: grid.ifdIndex, sheetNames: [...sheetNames].sort(), imageTiles };
}

// --- serialise -------------------------------------------------------------

const VERSION = 1;
const HEADER_BYTES = 25; // magic+version (8) + lat0/lon0 (16) + levelCount (1)
const LEVEL_HEADER_BYTES = 6; // extentM (4) + n (2)

function encode(lat0: number, lon0: number, levels: LevelResult[]): Uint8Array {
  let size = HEADER_BYTES;
  for (const l of levels) size += LEVEL_HEADER_BYTES + l.n * l.n;

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  dv.setUint32(o, LAND_MAGIC, true); o += 4;
  dv.setUint32(o, VERSION, true); o += 4;
  dv.setFloat64(o, lat0, true); o += 8;
  dv.setFloat64(o, lon0, true); o += 8;
  dv.setUint8(o, levels.length); o += 1;
  for (const l of levels) {
    dv.setFloat32(o, l.extentM, true); o += 4;
    dv.setUint16(o, l.n, true); o += 2;
    bytes.set(l.cls, o); o += l.cls.length;
  }
  return bytes;
}

// --- reporting -------------------------------------------------------------

function histogram(cls: Uint8Array): [number, number][] {
  const counts = new Map<number, number>();
  for (const c of cls) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function histogramLine(cls: Uint8Array): string {
  return histogram(cls)
    .map(([c, k]) => `${LAND_CLASS_NAMES[c] ?? `?${c}`} ${((100 * k) / cls.length).toFixed(1)}%`)
    .join("  ");
}

// --- driver ----------------------------------------------------------------

async function bake(city: City, force: boolean): Promise<void> {
  console.log(`\n=== ${city.id}  (${city.lat}, ${city.lon}) ===`);
  const origin = new Origin(city.lat, city.lon);

  const levels: LevelResult[] = [];
  for (const spec of LEVELS) {
    const t0 = Date.now();
    const level = await bakeLevel(origin, spec.extentM, spec.n, force);
    levels.push(level);
    console.log(
      `  L${levels.length - 1}  ${spec.n}x${spec.n} over +-${spec.extentM} m ` +
        `(${((spec.extentM * 2) / spec.n).toFixed(1)} m/texel)  IFD${level.ifdIndex} ` +
        `(${(SHEET_DEG / (SHEET_PX >> level.ifdIndex) * origin.mPerLat).toFixed(1)} m/px)  ` +
        `${level.sheetNames.length} sheet(s) ${level.imageTiles} image tiles  ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    console.log(`      sheets: ${level.sheetNames.join(", ")}`);
    console.log(`      ${histogramLine(level.cls)}`);
  }

  const out = `${ROOT}public/cities/${city.id}.land`;
  await Bun.write(out, encode(city.lat, city.lon, levels));
  console.log(`  wrote ${out}  ${Bun.file(out).size} bytes`);
}

/** public/cities/land-index.json: the ids that actually have a landcover pack.
 *  Generated, never hand-edited, and deliberately separate from index.json,
 *  which answers a different question (does this city have a skyline). */
async function writeIndex(): Promise<void> {
  const dir = `${ROOT}public/cities/`;
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".land"))
    .map((f) => f.replace(/\.land$/, ""))
    .sort();
  await Bun.write(`${dir}land-index.json`, JSON.stringify(ids));
  console.log(`\nland-index: ${ids.length} packs -> ${dir}land-index.json`);
  console.log(ids.join(", "));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, "");
    }
  }

  const force = flags.has("force");
  const jobs: City[] = [];
  if (flags.has("all")) {
    jobs.push(...CITIES);
  } else if (flags.has("city")) {
    const id = flags.get("city") ?? "";
    const c = cityById(id);
    if (!c) {
      console.error(`unknown city "${id}". known: ${CITIES.map((x) => x.id).join(", ")}`);
      process.exit(2);
    }
    jobs.push(c);
  } else {
    console.error(
      "usage: bun tools/bake-land.ts --city <id> [--force]\n" +
        "       bun tools/bake-land.ts --all [--force]",
    );
    process.exit(2);
  }

  for (const c of jobs) await bake(c, force);
  await writeIndex();
}

await main();
