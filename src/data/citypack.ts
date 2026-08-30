// Reader for the binary .city building packs produced by tools/bake-city.ts.
//
// Buildings are baked rather than fetched at runtime because OSM's own vector
// tiles stop at zoom 14 and carry no height attribute at all (verified against
// the live endpoint). Only Overpass exposes `height` / `building:levels`, and
// Overpass is far too slow and too rate-limited to sit in a page load. So the
// heights are resolved once, offline, and shipped as a few megabytes of packed
// i16 that parses in a couple of milliseconds.
//
// The format is defined once, here and in the baker, and the two must agree
// byte for byte. Every field is little-endian and written back to back with no
// alignment padding.
//
// This file is deliberately PURE: no fetch, no cache, no DOM. The bake
// verifier runs it under Bun with no DOM lib at all, which is what lets the
// same parser that the browser uses be the thing that gates a bake. A reader
// that only ran in a browser could not be the oracle for the writer.


export const CITY_MAGIC = 0x43495459;
const CITY_VERSION = 1;
const CITY_HEADER_BYTES = 32;
const CITY_RECORD_BYTES = 20;

/** Quarter-metre fixed point for footprint vertices, relative to the centroid. */
const VERT_SCALE = 0.25;

export enum BuildingKind {
  Generic = 0,
  Residential = 1,
  Commercial = 2,
  Industrial = 3,
  Retail = 4,
  Civic = 5,
  Tower = 6,
}

export enum RoofShape {
  Flat = 0,
  Pitched = 1,
  Dome = 2,
  Pyramid = 3,
  Tapered = 4,
}

export interface Building {
  cx: number;
  cz: number;
  baseM: number;
  topM: number;
  kind: BuildingKind;
  roof: RoofShape;
  /** Ring vertices in local ENU metres, absolute (centroid already added). */
  ring: Float32Array;
}

export interface CityPack {
  lat0: number;
  lon0: number;
  radiusM: number;
  buildings: Building[];
}

/**
 * A building as it sits IN the pack: geometry still quantised to i16 quarter-
 * metre offsets from the centroid, before a reader adds the centroid back.
 *
 * The converter in src/data/osmbuildings.ts produces these and the writer below
 * consumes them, so the quantisation happens exactly once and in one place. A
 * runtime path that skipped it would build a subtly different city from the
 * same OSM data than the baked pack does, which is precisely the drift this
 * shared core exists to make impossible.
 */
export interface PackedBuilding {
  cx: number;
  cz: number;
  baseM: number;
  topM: number;
  kind: BuildingKind;
  roof: RoofShape;
  /** i16 units of VERT_SCALE metres, offsets from the centroid. */
  dx: Int16Array;
  dz: Int16Array;
}

/**
 * Write a .city pack. The inverse of parseCityPack, and it lives beside it
 * because a format defined in two files is a format that eventually disagrees
 * with itself.
 */
export function encodeCityPack(
  buildings: readonly PackedBuilding[],
  lat0: number,
  lon0: number,
  radiusM: number,
): Uint8Array {
  let size = CITY_HEADER_BYTES;
  for (const b of buildings) size += CITY_RECORD_BYTES + 4 * b.dx.length;

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, CITY_MAGIC, true); o += 4;
  dv.setUint32(o, CITY_VERSION, true); o += 4;
  dv.setFloat64(o, lat0, true); o += 8;
  dv.setFloat64(o, lon0, true); o += 8;
  dv.setFloat32(o, radiusM, true); o += 4;
  dv.setUint32(o, buildings.length, true); o += 4;

  for (const b of buildings) {
    dv.setFloat32(o, b.cx, true); o += 4;
    dv.setFloat32(o, b.cz, true); o += 4;
    dv.setFloat32(o, b.baseM, true); o += 4;
    dv.setFloat32(o, b.topM, true); o += 4;
    dv.setUint8(o, b.kind); o += 1;
    dv.setUint8(o, b.roof); o += 1;
    dv.setUint16(o, b.dx.length, true); o += 2;
    for (let i = 0; i < b.dx.length; i++) {
      dv.setInt16(o, b.dx[i], true); o += 2;
      dv.setInt16(o, b.dz[i], true); o += 2;
    }
  }
  return new Uint8Array(buf);
}

/**
 * Packed records to the records a reader hands the renderer, WITHOUT going
 * through a file.
 *
 * `Math.fround` is not decoration. Every scalar in the format is an f32, so a
 * pack that has been written and read back carries f32 values, and a runtime
 * path that kept the f64 the arithmetic produced would place its buildings a
 * few micrometres off the baked ones and stop being comparable. Rounding here
 * is what makes "the live path and the pack agree exactly" an assertion the
 * gate can make.
 */
export function unpackBuildings(packed: readonly PackedBuilding[]): Building[] {
  const out: Building[] = new Array(packed.length);
  for (let i = 0; i < packed.length; i++) {
    const p = packed[i];
    const cx = Math.fround(p.cx);
    const cz = Math.fround(p.cz);
    const n = p.dx.length;
    const ring = new Float32Array(n * 2);
    for (let v = 0; v < n; v++) {
      ring[v * 2] = cx + p.dx[v] * VERT_SCALE;
      ring[v * 2 + 1] = cz + p.dz[v] * VERT_SCALE;
    }
    out[i] = {
      cx,
      cz,
      baseM: Math.fround(p.baseM),
      topM: Math.fround(p.topM),
      kind: p.kind,
      roof: p.roof,
      ring,
    };
  }
  return out;
}

export function parseCityPack(buf: ArrayBuffer): CityPack {
  const dv = new DataView(buf);
  let o = 0;

  const magic = dv.getUint32(o, true); o += 4;
  if (magic !== CITY_MAGIC) {
    throw new Error(`not a .city pack (magic 0x${magic.toString(16)})`);
  }
  const version = dv.getUint32(o, true); o += 4;
  if (version !== CITY_VERSION) throw new Error(`unsupported .city version ${version}`);

  const lat0 = dv.getFloat64(o, true); o += 8;
  const lon0 = dv.getFloat64(o, true); o += 8;
  const radiusM = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;

  const buildings: Building[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const cx = dv.getFloat32(o, true); o += 4;
    const cz = dv.getFloat32(o, true); o += 4;
    const baseM = dv.getFloat32(o, true); o += 4;
    const topM = dv.getFloat32(o, true); o += 4;
    const kind = dv.getUint8(o); o += 1;
    const roof = dv.getUint8(o); o += 1;
    const n = dv.getUint16(o, true); o += 2;

    const ring = new Float32Array(n * 2);
    for (let v = 0; v < n; v++) {
      ring[v * 2] = cx + dv.getInt16(o, true) * VERT_SCALE; o += 2;
      ring[v * 2 + 1] = cz + dv.getInt16(o, true) * VERT_SCALE; o += 2;
    }
    buildings[i] = { cx, cz, baseM, topM, kind, roof, ring };
  }

  return { lat0, lon0, radiusM, buildings };
}

// --- needles ----------------------------------------------------------------

/**
 * OSM tags masts, spires, flagpoles and antennae as `building` or
 * `building:part` often enough that a city pack picks up hundreds of them, and
 * they carry a real height on a footprint a few metres across. Extruded, they
 * come out as black needles standing among the towers: at night, over
 * Manhattan, one of them is 471 m tall on an 11 m footprint, and two stand
 * within 200 m of the scene origin.
 *
 * The height alone cannot be the test, because genuinely slender skyscrapers
 * exist and are the ones worth seeing. Steinway Tower is 435 m on an 18 m base
 * (ratio 24) and 432 Park is 426 m on 28 m (ratio 15), so both thresholds here
 * are set to keep them and drop the masts, which run past ratio 50.
 */
export const NEEDLE_MIN_DIM_M = 12;
export const NEEDLE_MIN_HEIGHT_M = 100;
export const NEEDLE_MAX_RATIO = 30;

export function isNeedle(heightM: number, minFootprintM: number): boolean {
  if (minFootprintM < NEEDLE_MIN_DIM_M && heightM > NEEDLE_MIN_HEIGHT_M) return true;
  return heightM / Math.max(1, minFootprintM) > NEEDLE_MAX_RATIO;
}

/** Shorter side of the footprint's bounding box, in metres. */
export function footprintMinDim(ring: Float32Array): number {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], z = ring[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return Math.min(maxX - minX, maxZ - minZ);
}

/** True when this baked building is a mast rather than a building. */
export function buildingIsNeedle(b: Building): boolean {
  return isNeedle(b.topM - b.baseM, footprintMinDim(b.ring));
}

/**
 * The ground a building stands on: the LOWEST terrain sample under its
 * footprint, in absolute world metres.
 *
 * Not the centroid. A footprint on a hillside spans several metres of slope,
 * and anchoring it at the centre leaves the downhill half hanging in the air --
 * San Francisco is nothing but slope. The renderer buries the base at this
 * height (see addBuilding) and the drone's collider raises its roof from it,
 * and the two have to be the SAME number: a collider that sits a metre off the
 * geometry means bouncing off nothing and sinking through walls.
 */
export function footprintGroundY(b: Building, heightAt: (x: number, z: number) => number): number {
  let lowest = Infinity;
  for (let v = 0; v < b.ring.length; v += 2) {
    const g = heightAt(b.ring[v], b.ring[v + 1]);
    if (g < lowest) lowest = g;
  }
  return Number.isFinite(lowest) ? lowest : heightAt(b.cx, b.cz);
}
