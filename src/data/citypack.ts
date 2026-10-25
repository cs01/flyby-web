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
/**
 * 2 adds a variable tail to every record: a flag byte, then the fields it
 * names (see encodeTail). Version 1 packs (the cities nobody has re-baked)
 * still parse; they simply have no tail.
 */
export const CITY_VERSION = 2;
const CITY_HEADER_BYTES = 32;
const CITY_RECORD_BYTES = 20;

// --- the version 2 record tail ------------------------------------------------
//
// building:part massing and the OSM evidence the archetype assignment reads.
// A flag byte per record and nothing else for the ~93% that carry none of it,
// so the tail costs about one byte a building.

export const TAIL_GROUP = 1;
export const TAIL_MATERIAL = 2;
export const TAIL_COLOUR = 4;
export const TAIL_ROOF_COLOUR = 8;
export const TAIL_ROOF_MATERIAL = 16;
export const TAIL_YEAR = 32;
export const TAIL_LEVELS = 64;
export const TAIL_ROOF_HEIGHT = 128;

/**
 * building:material values a pack can carry, by code. A value not in this
 * table is dropped by the converter on BOTH paths (see materialTags), so a live
 * city and a baked one hold the same evidence. Covers every key the archetype
 * table reads plus the common spellings mappers use beside them.
 */
export const MATERIAL_CODES = [
  "brick", "stone", "limestone", "sandstone", "granite", "concrete", "plaster", "stucco",
  "wood", "timber_framing", "glass", "metal", "steel", "terracotta", "marble", "cement_block",
  "masonry", "mirror", "tiles", "panels", "reinforced_concrete", "vinyl", "aluminium",
] as const;
/** roof:material values, likewise. Every key of facade.ts ROOF_TAG is here. */
export const ROOF_MATERIAL_CODES = [
  "tar_paper", "asphalt", "roofing_felt", "gravel", "concrete", "grass", "plants", "metal",
  "copper", "roof_tiles", "tile", "slate", "wood", "eternit", "glass", "stone", "thatch",
  "asbestos", "plastic", "metal_sheet", "pebblestone",
] as const;

const srgbByteToLinear = (q: number): number => {
  const v = q / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const linearToSrgbByte = (c: number): number => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

/**
 * A linear colour snapped to the sRGB byte the pack stores. The converter
 * applies it, so a colour that has been through a pack and one that has not
 * are the same float (a byte -> linear -> byte round trip is exact).
 */
export function quantiseColour(c: readonly [number, number, number]): [number, number, number] {
  return [
    srgbByteToLinear(linearToSrgbByte(c[0])),
    srgbByteToLinear(linearToSrgbByte(c[1])),
    srgbByteToLinear(linearToSrgbByte(c[2])),
  ];
}
/** building:levels as the pack stores it: half-storey steps, at most 127.5. */
export const quantiseLevels = (l: number): number => Math.round(Math.min(127.5, l) * 2) / 2;
/** roof:height as the pack stores it: decimetres, at most 6553.5 m. */
export const quantiseRoofHeight = (m: number): number => Math.round(Math.min(6553.5, m) * 10) / 10;

/** Bytes the tail of one record takes. verify-packs re-derives this on its own. */
export function tailBytes(b: { group?: number; roofM?: number; tags?: BuildingTags }): number {
  const t = b.tags;
  return 1 + (b.group !== undefined ? 4 : 0) + (t?.material !== undefined ? 1 : 0)
    + (t?.colour ? 3 : 0) + (t?.roofColour ? 3 : 0) + (t?.roofMaterial !== undefined ? 1 : 0)
    + (t?.year !== undefined ? 2 : 0) + (t?.levels !== undefined ? 1 : 0) + (b.roofM !== undefined ? 2 : 0);
}

function encodeTail(dv: DataView, o: number, b: PackedBuilding): number {
  const t = b.tags;
  const mat = t?.material !== undefined ? MATERIAL_CODES.indexOf(t.material as (typeof MATERIAL_CODES)[number]) : -1;
  const rmat = t?.roofMaterial !== undefined
    ? ROOF_MATERIAL_CODES.indexOf(t.roofMaterial as (typeof ROOF_MATERIAL_CODES)[number]) : -1;
  if (t?.material !== undefined && mat < 0) throw new Error(`material "${t.material}" has no code`);
  if (t?.roofMaterial !== undefined && rmat < 0) throw new Error(`roof material "${t.roofMaterial}" has no code`);
  const flags = (b.group !== undefined ? TAIL_GROUP : 0) | (mat >= 0 ? TAIL_MATERIAL : 0)
    | (t?.colour ? TAIL_COLOUR : 0) | (t?.roofColour ? TAIL_ROOF_COLOUR : 0)
    | (rmat >= 0 ? TAIL_ROOF_MATERIAL : 0) | (t?.year !== undefined ? TAIL_YEAR : 0)
    | (t?.levels !== undefined ? TAIL_LEVELS : 0) | (b.roofM !== undefined ? TAIL_ROOF_HEIGHT : 0);
  dv.setUint8(o, flags); o += 1;
  if (b.group !== undefined) { dv.setUint32(o, b.group, true); o += 4; }
  if (mat >= 0) { dv.setUint8(o, mat); o += 1; }
  for (const c of [t?.colour, t?.roofColour]) {
    if (!c) continue;
    for (let k = 0; k < 3; k++) { dv.setUint8(o, linearToSrgbByte(c[k])); o += 1; }
  }
  if (rmat >= 0) { dv.setUint8(o, rmat); o += 1; }
  if (t?.year !== undefined) { dv.setUint16(o, t.year, true); o += 2; }
  if (t?.levels !== undefined) { dv.setUint8(o, Math.round(t.levels * 2)); o += 1; }
  if (b.roofM !== undefined) { dv.setUint16(o, Math.round(b.roofM * 10), true); o += 2; }
  return o;
}

interface Tail { group?: number; roofM?: number; tags?: BuildingTags }

function decodeTail(dv: DataView, o: number, out: Tail): number {
  const flags = dv.getUint8(o); o += 1;
  if (flags & TAIL_GROUP) { out.group = dv.getUint32(o, true); o += 4; }
  const tags: BuildingTags = {};
  if (flags & TAIL_MATERIAL) {
    const m = MATERIAL_CODES[dv.getUint8(o)]; o += 1;
    if (m === undefined) throw new Error("material code out of range");
    tags.material = m;
  }
  const rgb = (): [number, number, number] => {
    const c: [number, number, number] = [
      srgbByteToLinear(dv.getUint8(o)), srgbByteToLinear(dv.getUint8(o + 1)), srgbByteToLinear(dv.getUint8(o + 2)),
    ];
    o += 3;
    return c;
  };
  if (flags & TAIL_COLOUR) tags.colour = rgb();
  if (flags & TAIL_ROOF_COLOUR) tags.roofColour = rgb();
  if (flags & TAIL_ROOF_MATERIAL) {
    const m = ROOF_MATERIAL_CODES[dv.getUint8(o)]; o += 1;
    if (m === undefined) throw new Error("roof material code out of range");
    tags.roofMaterial = m;
  }
  if (flags & TAIL_YEAR) { tags.year = dv.getUint16(o, true); o += 2; }
  if (flags & TAIL_LEVELS) { tags.levels = dv.getUint8(o) / 2; o += 1; }
  if (flags & TAIL_ROOF_HEIGHT) { out.roofM = dv.getUint16(o, true) / 10; o += 2; }
  if (Object.keys(tags).length) out.tags = tags;
  return o;
}

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

/**
 * The OSM evidence about what a building is made of, when a record carries it.
 * Only the live path has it (a baked pack stores geometry and kind, nothing
 * else), and even there most records have none: of 1627 buildings in a Chelsea
 * query, 77 carried building:material. render/archetype.ts reads it.
 */
export interface BuildingTags {
  /** building:material, lower case: brick, stone, glass, concrete, wood, plaster, metal... */
  material?: string;
  /** building:colour, as linear rgb already parsed. */
  colour?: [number, number, number];
  /** roof:colour, linear rgb. */
  roofColour?: [number, number, number];
  /** roof:material, lower case: tar_paper, gravel, concrete, metal, copper, roof_tiles, slate, grass... */
  roofMaterial?: string;
  /** start_date's year. */
  year?: number;
  /** building:levels. */
  levels?: number;
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
  tags?: BuildingTags;
  /**
   * building:part massing. Every record cut from one OSM outline (its parts,
   * and the podium left of the outline when the parts do not cover it) shares
   * this id, so the renderer can draw them as ONE building: one archetype, one
   * palette draw, one storey grid. An id, not an index, because the loader
   * filters records (masts) and an index would point at the wrong one after.
   */
  group?: number;
  /**
   * The record's index in the pack as loaded (after the mast filter), which
   * seeds its archetype and palette draw. Set by citypack-load.ts so that a
   * record dropped LATER (a landmark bridge's tower parts, ?flatparts) does
   * not re-roll every building after it: the Brooklyn and Queensboro towers
   * going in 2d047fd moved every Midtown facade along by a few indices and
   * changed what the glass gate's 7th Avenue pose is looking at. Absent on a
   * pack from the pure parser, where the array index is the same number.
   */
  seed?: number;
  /** roof:height, metres: how much of the record's height is its roof. */
  roofM?: number;
  /**
   * True when `kind` is Residential because osmbuildings.ts inferResidential
   * said so from the footprints, not because a mapper tagged it. Version 2
   * carries it in the top bit of the kind byte, so test/zoning.check.ts can
   * take a re-baked pack's inference back out and still score the rule
   * against what mappers actually wrote.
   */
  inferredKind?: boolean;
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
  /** Written to the version 2 tail; see Building. */
  tags?: BuildingTags;
  group?: number;
  roofM?: number;
  inferredKind?: boolean;
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
  for (const b of buildings) size += CITY_RECORD_BYTES + 4 * b.dx.length + tailBytes(b);

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
    // Version 2: the top bit of the kind byte is inferredKind.
    dv.setUint8(o, b.kind | (b.inferredKind ? 0x80 : 0)); o += 1;
    dv.setUint8(o, b.roof); o += 1;
    dv.setUint16(o, b.dx.length, true); o += 2;
    for (let i = 0; i < b.dx.length; i++) {
      dv.setInt16(o, b.dx[i], true); o += 2;
      dv.setInt16(o, b.dz[i], true); o += 2;
    }
    o = encodeTail(dv, o, b);
  }
  if (o !== size) throw new Error(`encoder wrote ${o} of ${size} bytes`);
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
      ...(p.tags ? { tags: p.tags } : {}),
      ...(p.group !== undefined ? { group: p.group } : {}),
      ...(p.roofM !== undefined ? { roofM: p.roofM } : {}),
      ...(p.inferredKind ? { inferredKind: true } : {}),
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
  if (version !== 1 && version !== CITY_VERSION) throw new Error(`unsupported .city version ${version}`);

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
    const b: Building = { cx, cz, baseM, topM, kind: kind & 0x7f, roof, ring };
    if (version >= 2 && kind & 0x80) b.inferredKind = true;
    if (version >= 2) o = decodeTail(dv, o, b);
    buildings[i] = b;
  }
  if (o !== buf.byteLength) throw new Error(`trailing bytes: read ${o} of ${buf.byteLength}`);

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

/**
 * footprintGroundY for every record, with each building:part group anchored at
 * ONE ground: the one under its biggest footprint. Each part sampled on its
 * own footprint sat its podium and its setbacks a metre or two apart on a
 * slope, which opens a crack between the stages of a tower and gives the
 * drone's collider overlapping volumes to be pushed back and forth between.
 * The renderer and the collider both read it, so they stay the same number.
 */
export function packGroundY(bs: readonly Building[], heightAt: (x: number, z: number) => number): Float64Array {
  const out = new Float64Array(bs.length);
  // The anchor is the ground under the group's BIGGEST footprint, its podium,
  // not the lowest under any record: on the Hudson and East River fronts one
  // part reaching over the water sampled the river bed, and the minimum sank
  // the whole tower 40 m.
  const anchor = new Map<number, { area: number; y: number }>();
  for (let i = 0; i < bs.length; i++) {
    out[i] = footprintGroundY(bs[i], heightAt);
    const g = bs[i].group;
    if (g === undefined) continue;
    let a2 = 0;
    const r = bs[i].ring, n = r.length / 2;
    for (let v = 0, w = n - 1; v < n; w = v++) a2 += r[w * 2] * r[v * 2 + 1] - r[v * 2] * r[w * 2 + 1];
    const area = Math.abs(a2);
    const cur = anchor.get(g);
    if (!cur || area > cur.area) anchor.set(g, { area, y: out[i] });
  }
  for (let i = 0; i < bs.length; i++) {
    const g = bs[i].group;
    if (g !== undefined) out[i] = anchor.get(g)!.y;
  }
  return out;
}
