// Coordinate systems. Three of them meet here and mixing them up is the single
// most expensive mistake available in this codebase, so they get one file.
//
//   geodetic  — lat/lon degrees, WGS84. What every data source speaks.
//   tile      — Web Mercator slippy tile (z, x, y). What every tile URL speaks.
//   world     — local ENU metres about a scene origin. What the renderer speaks:
//               +x east, +y up, +z SOUTH. (+z south, not north, because three.js
//               is right-handed with the camera looking down -z, so a camera at
//               default orientation faces north, which is what a map reader
//               expects.)
//
// Everything is metres. There is no "unit scale" knob anywhere; a metre in the
// data is a metre in the scene, so altitudes, fog distances and cloud bases can
// be lifted straight out of a weather report without a conversion step to get
// wrong.

export const EARTH_RADIUS = 6378137;
const D2R = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Metres per degree of latitude at `lat` (WGS84 meridional arc, series form). */
export function metresPerDegLat(lat: number): number {
  const p = lat * D2R;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

/** Metres per degree of longitude at `lat`. Collapses to 0 at the poles. */
export function metresPerDegLon(lat: number): number {
  const p = lat * D2R;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}

/**
 * A scene's local tangent plane. Built once per city and then threaded
 * everywhere, because a second origin computed elsewhere would drift by metres
 * and put the buildings beside the terrain rather than on it.
 */
export class Origin {
  readonly lat: number;
  readonly lon: number;
  readonly mPerLat: number;
  readonly mPerLon: number;

  constructor(lat: number, lon: number) {
    this.lat = lat;
    this.lon = lon;
    this.mPerLat = metresPerDegLat(lat);
    this.mPerLon = metresPerDegLon(lat);
  }

  /** geodetic -> world metres. Returns east/south, caller supplies up. */
  toWorld(lat: number, lon: number): { x: number; z: number } {
    return {
      x: (lon - this.lon) * this.mPerLon,
      z: -(lat - this.lat) * this.mPerLat,
    };
  }

  /** world metres -> geodetic. */
  toLatLon(x: number, z: number): LatLon {
    return {
      lat: this.lat - z / this.mPerLat,
      lon: this.lon + x / this.mPerLon,
    };
  }
}

// --- Web Mercator slippy tiles -------------------------------------------

export interface Tile {
  z: number;
  x: number;
  y: number;
}

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const p = lat * D2R;
  return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * (y / 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function tileFor(lat: number, lon: number, z: number): Tile {
  return { z, x: Math.floor(lonToTileX(lon, z)), y: Math.floor(latToTileY(lat, z)) };
}

/** Ground resolution in metres per pixel for a 256 px tile at this zoom/lat. */
export function tileResolution(lat: number, z: number, tileSize = 256): number {
  return (Math.cos(lat * D2R) * 2 * Math.PI * EARTH_RADIUS) / (tileSize * 2 ** z);
}

export function tileBounds(t: Tile): { west: number; east: number; north: number; south: number } {
  return {
    west: tileXToLon(t.x, t.z),
    east: tileXToLon(t.x + 1, t.z),
    north: tileYToLat(t.y, t.z),
    south: tileYToLat(t.y + 1, t.z),
  };
}

export function tileKey(t: Tile): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/** Wrap x, clamp y — the slippy convention. Off-world y has no tile at all. */
export function normaliseTile(t: Tile): Tile | null {
  const n = 2 ** t.z;
  if (t.y < 0 || t.y >= n) return null;
  return { z: t.z, x: ((t.x % n) + n) % n, y: t.y };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Great-circle distance in metres. Used for landmark reach tests. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}
