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

export function parseCityPack(buf: ArrayBuffer): CityPack {
  const dv = new DataView(buf);
  let o = 0;

  const magic = dv.getUint32(o, true); o += 4;
  if (magic !== CITY_MAGIC) {
    throw new Error(`not a .city pack (magic 0x${magic.toString(16)})`);
  }
  const version = dv.getUint32(o, true); o += 4;
  if (version !== 1) throw new Error(`unsupported .city version ${version}`);

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
