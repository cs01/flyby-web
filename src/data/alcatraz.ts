// Alcatraz Island: the baked asset's format and the height patch built from it.
//
// The city DEM is SRTM at ~30 m, which turns a 41 m island with sheer cliffs
// into a smooth lump and smears it a hundred metres out over the bay (the grey
// "water hill" beside the island). The bake (tools/bake-alcatraz.ts) stores
// USGS 3DEP lidar at 1e-5 degrees (~0.9 x 1.1 m) over a box around the island.
//
// At runtime the patch does two jobs, kept apart on purpose:
//   * `heightAt` (walking, docking, building bases, trees) gets the TRUE lidar
//     height, so a person stands on the real ground.
//   * the city's terrain rings get an ERODED copy: each sample is the minimum
//     of the lidar within the coarsest ring cell that covers the island. A
//     ring triangle then lies at or below the lidar everywhere inside it, so
//     the coarse surface cannot poke up through the fine island mesh drawn on
//     top of it. Plain sampling would: a ring vertex at a cliff foot sits on
//     the water while its neighbour sits on the cliff top, and the triangle
//     between them cuts straight through the cliff face.
//
// Pure: no THREE, no DOM, so test/alcatraz.check.ts runs it under Bun.

/** Same shape as data/dem.ts Bbox, restated so the bake tool can import this
 * module without pulling the browser-only DEM loader into its build. */
export interface Bbox {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** The lidar box: 900 x 540 cells of ALCATRAZ_CELL_DEG, about 790 x 600 m. */
export const ALCATRAZ_BBOX: Bbox = { west: -122.4275, east: -122.4185, south: 37.824, north: 37.8294 };
export const ALCATRAZ_CELL_DEG = 1e-5;

/** Over this many metres in from the box edge the patch hands back to the city DEM. */
export const ALCATRAZ_BLEND_M = 60;

/** One OSM way as baked: tags trimmed to what the modeller reads, ring as lat,lon pairs. */
export interface AlcatrazFeature {
  id: number;
  tags: Record<string, string>;
  /** lat0, lon0, lat1, lon1, ... */
  ll: number[];
}

export interface AlcatrazMeta {
  version: 1;
  bbox: Bbox;
  w: number;
  h: number;
  drape: {
    /** What the drape image covers: the land plus a margin, not the whole lidar box. */
    bbox: Bbox;
    size: [number, number];
    small: [number, number];
  };
  features: AlcatrazFeature[];
  sources: string;
}

// --- the height encoding -------------------------------------------------------
//
// Centimetres as uint16, with every run of zero (open water, two thirds of the
// box) written as a 0 followed by its length. 486k cells come to ~230 kB with
// no compressor on either end: the browser cannot be relied on to be served a
// gzipped .bin, and the Bun gate has to read the same bytes without a PNG
// decoder.

export function encodeHeights(h: Float32Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < h.length; ) {
    const cm = Math.max(0, Math.min(65535, Math.round(h[i] * 100)));
    if (cm === 0) {
      let run = 0;
      while (i < h.length && run < 65535 && Math.round(h[i] * 100) <= 0) { run++; i++; }
      out.push(0, run);
    } else {
      out.push(cm);
      i++;
    }
  }
  return new Uint8Array(new Uint16Array(out).buffer);
}

export function decodeHeights(bytes: Uint8Array, n: number): Float32Array {
  const src = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const out = new Float32Array(n);
  let o = 0;
  for (let i = 0; i < src.length && o < n; i++) {
    const v = src[i];
    if (v === 0) o += src[++i];
    else out[o++] = v / 100;
  }
  if (o !== n) throw new Error(`alcatraz heights: decoded ${o} cells, expected ${n}`);
  return out;
}

// --- the patch -----------------------------------------------------------------

/**
 * Running minimum over a window of 2r+1 along one axis (van Herk / Gil-Werman:
 * two passes of block prefix and suffix minima, O(n) whatever r is).
 */
function minFilter1d(src: Float32Array, dst: Float32Array, n: number, stride: number, base: number, r: number,
  pre: Float32Array, suf: Float32Array): void {
  const k = 2 * r + 1;
  for (let i = 0; i < n; i++) {
    const v = src[base + i * stride];
    pre[i] = i % k === 0 ? v : Math.min(pre[i - 1], v);
  }
  for (let i = n - 1; i >= 0; i--) {
    const v = src[base + i * stride];
    suf[i] = i % k === k - 1 || i === n - 1 ? v : Math.min(suf[i + 1], v);
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    dst[base + i * stride] = Math.min(suf[lo], pre[hi]);
  }
}

export function minFilter(src: Float32Array, w: number, h: number, rx: number, ry: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const pre = new Float32Array(Math.max(w, h));
  const suf = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) minFilter1d(src, tmp, w, 1, y * w, rx, pre, suf);
  for (let x = 0; x < w; x++) minFilter1d(tmp, out, h, w, x, ry, pre, suf);
  return out;
}

const M_PER_DEG_LAT = 111_132;
const mPerDegLon = (lat: number): number => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

export class AlcatrazPatch {
  readonly bbox: Bbox;
  readonly w: number;
  readonly h: number;
  /** Lidar metres above the sea surface, row 0 north. */
  readonly heights: Float32Array;
  /** Cell size in metres, east-west and north-south. */
  readonly cellX: number;
  readonly cellZ: number;
  private eroded: Float32Array | null = null;

  constructor(meta: Pick<AlcatrazMeta, "bbox" | "w" | "h">, heights: Float32Array) {
    this.bbox = meta.bbox;
    this.w = meta.w;
    this.h = meta.h;
    this.heights = heights;
    const midLat = (meta.bbox.north + meta.bbox.south) / 2;
    this.cellX = ((meta.bbox.east - meta.bbox.west) / meta.w) * mPerDegLon(midLat);
    this.cellZ = ((meta.bbox.north - meta.bbox.south) / meta.h) * M_PER_DEG_LAT;
  }

  contains(lat: number, lon: number): boolean {
    const b = this.bbox;
    return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  }

  /**
   * 0 at the box edge, 1 from ALCATRAZ_BLEND_M inside it: how much of the
   * patch a point takes, against the city DEM, so the box has no step.
   */
  weight(lat: number, lon: number): number {
    const b = this.bbox;
    const dx = Math.min(lon - b.west, b.east - lon) * mPerDegLon(lat);
    const dz = Math.min(lat - b.south, b.north - lat) * M_PER_DEG_LAT;
    const t = Math.max(0, Math.min(1, Math.min(dx, dz) / ALCATRAZ_BLEND_M));
    return t * t * (3 - 2 * t);
  }

  private bilinear(field: Float32Array, lat: number, lon: number): number {
    const b = this.bbox;
    const fx = Math.max(0, Math.min(this.w - 1, ((lon - b.west) / (b.east - b.west)) * this.w - 0.5));
    const fy = Math.max(0, Math.min(this.h - 1, ((b.north - lat) / (b.north - b.south)) * this.h - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.w - 1);
    const y1 = Math.min(y0 + 1, this.h - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = field[y0 * this.w + x0];
    const c = field[y0 * this.w + x1];
    const d = field[y1 * this.w + x0];
    const e = field[y1 * this.w + x1];
    return (a * (1 - tx) + c * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }

  /** The lidar at a point, without the edge blend. */
  sample(lat: number, lon: number): number {
    return this.bilinear(this.heights, lat, lon);
  }

  /**
   * Build the eroded copy the terrain rings sample: the minimum over a square
   * of half-width `radiusM`, which must be at least the largest ring cell
   * that will ever be meshed over the island (see the module comment).
   */
  erode(radiusM: number): void {
    const rx = Math.ceil(radiusM / this.cellX);
    const rz = Math.ceil(radiusM / this.cellZ);
    this.eroded = minFilter(this.heights, this.w, this.h, rx, rz);
  }

  sampleEroded(lat: number, lon: number): number {
    if (!this.eroded) throw new Error("AlcatrazPatch.erode() first");
    return this.bilinear(this.eroded, lat, lon);
  }

  /** Highest lidar cell, metres. */
  maxHeight(): number {
    let m = 0;
    for (const v of this.heights) m = Math.max(m, v);
    return m;
  }
}

/**
 * The height the terrain rings mesh: the eroded lidar, blended to `base`
 * (what the rings sampled before) at the box edge. render/alcatraz.ts wraps it
 * as a Heightfield for the terrain's field list.
 */
export function ringHeight(patch: AlcatrazPatch, base: (lat: number, lon: number) => number) {
  return (lat: number, lon: number): number => {
    const w = patch.weight(lat, lon);
    const b = base(lat, lon);
    if (w <= 0) return b;
    // min(): inside the blend band the city DEM still carries SRTM's smear
    // of the cliffs, and the eroded lidar is the lower, truer of the two.
    return b + (Math.min(b, patch.sampleEroded(lat, lon)) - b) * w;
  };
}

/** The true ground for heightAt: lidar inside, blended to `base` at the box edge. */
export function patchedHeight(patch: AlcatrazPatch, base: (lat: number, lon: number) => number) {
  return (lat: number, lon: number): number => {
    if (!patch.contains(lat, lon)) return base(lat, lon);
    const w = patch.weight(lat, lon);
    if (w >= 1) return patch.sample(lat, lon);
    const b = base(lat, lon);
    return b + (patch.sample(lat, lon) - b) * w;
  };
}

/** Polygon area in m^2 (lat/lon ring, shoelace in local metres); used by the gate. */
export function ringAreaM2(ll: number[]): number {
  const lat0 = ll[0];
  const kx = mPerDegLon(lat0);
  let a = 0;
  const n = ll.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ll[i * 2 + 1] * kx;
    const z0 = ll[i * 2] * M_PER_DEG_LAT;
    const x1 = ll[j * 2 + 1] * kx;
    const z1 = ll[j * 2] * M_PER_DEG_LAT;
    a += x0 * z1 - x1 * z0;
  }
  return Math.abs(a) / 2;
}

/** Fetch and decode the baked asset. Null on any failure: a missing island must never fail the load. */
export async function loadAlcatraz(base = "landmarks"): Promise<{ meta: AlcatrazMeta; patch: AlcatrazPatch } | null> {
  try {
    const [mr, hr] = await Promise.all([fetch(`${base}/alcatraz.json`), fetch(`${base}/alcatraz.height`)]);
    if (!mr.ok || !hr.ok) return null;
    const meta = (await mr.json()) as AlcatrazMeta;
    const heights = decodeHeights(new Uint8Array(await hr.arrayBuffer()), meta.w * meta.h);
    return { meta, patch: new AlcatrazPatch(meta, heights) };
  } catch (err) {
    console.warn("[flyby] alcatraz asset failed to load", err);
    return null;
  }
}
