// Which patches of ground the live path may ask Overpass about, and in what
// order. Pure maths: no fetch, no cache, no DOM.
//
// THE GRID IS GEOGRAPHIC, NOT SCENE-LOCAL. A tile is a Web Mercator slippy tile
// at one fixed zoom, exactly as src/data/dem.ts and src/data/imagery.ts already
// address the planet. That is what makes a tile key STABLE: the same patch of
// Santa Rosa is `14/2632/6330` whether you arrived from the search box, from a
// shared `?at=` link or from a different scene origin two kilometres away, so
// the cached answer from the first visit is the answer the second visit reads.
// A grid anchored on the scene origin would give the same ground a different
// key every flight and re-ask a volunteer server the same question forever.

import { haversine, tileBounds, tileFor, tileKey, type Tile } from "../geo";
import type { Origin } from "../geo";
import type { OsmBbox } from "./osm";
import { buildingsStatements } from "./osmbuildings";
import { roadsStatements } from "./osmroads";
import { vegetationStatements } from "./osmveg";

/**
 * Zoom of the live grid: ~1.9 km on a side at 38 degrees north.
 *
 * Measured against the live endpoint, a box that size answers a buildings query
 * in about 4-5 seconds and a roads query in about 2. One zoom finer would
 * quarter the wait but quadruple the number of requests for the same ground,
 * and the number of requests is the thing this app has to be careful with.
 */
export const LIVE_ZOOM = 14;

/**
 * Radius from the loaded pack origin within which live geometry is kept, in
 * metres. Beyond this the converters drop a footprint anyway, so it is also the
 * radius handed to them.
 */
export const LIVE_WORLD_RADIUS_M = 20000;

/** A baked pack's footprint on the ground, for the "is this already covered" test. */
export interface BakedCoverage {
  lat: number;
  lon: number;
  radiusM: number;
}

export interface LiveTile {
  tile: Tile;
  key: string;
  /** The query box, in Overpass's own order. */
  bbox: OsmBbox;
  /** Scene metres from the camera to the nearest point of the tile. */
  distM: number;
}

/**
 * Buildings, roads and vegetation for one tile, in ONE request.
 *
 * Three separate queries would each be simpler and would each arrive sooner,
 * and it is still the wrong shape: the number of REQUESTS is what a public
 * Overpass instance rate-limits on and what got this project blocked once
 * already, so asking three times for the same 1.9 km square is three times the
 * harm for the same data. The union is built from the same statement fragments
 * the three individual queries use, so what the live path asks for and what the
 * baker asks for cannot drift apart.
 *
 * The timeout is the SERVER's, and it is generous because this box is answered
 * once and then cached forever: a slow answer costs one reader a few seconds,
 * while a timed-out answer costs the server the whole query again.
 */
export function liveTileQuery(b: OsmBbox, timeoutS = 180): string {
  return `[out:json][timeout:${timeoutS}];
(${buildingsStatements(b)}
 ${roadsStatements(b)}
 ${vegetationStatements(b)});
out geom;`;
}

/** The box a tile covers, as Overpass wants it written. */
export function tileBbox(t: Tile): OsmBbox {
  const b = tileBounds(t);
  return { s: b.south, w: b.west, n: b.north, e: b.east };
}

/** Geodetic centre of a tile. */
export function tileCentre(t: Tile): { lat: number; lon: number } {
  const b = tileBounds(t);
  return { lat: (b.north + b.south) / 2, lon: (b.east + b.west) / 2 };
}

/**
 * True when a baked pack already covers every corner of this tile.
 *
 * Every corner and not the centre: a tile half inside a pack would be fetched
 * on the strength of its outer half and then drawn on top of baked geometry for
 * its inner half, which is a doubled city rather than a bigger one. Refusing
 * the whole tile leaves a seam at the pack boundary, which is honest, cheap,
 * and what the pack radius already looks like today.
 */
export function tileCoveredByPack(t: Tile, packs: readonly BakedCoverage[]): boolean {
  if (packs.length === 0) return false;
  const b = tileBounds(t);
  const corners = [
    { lat: b.north, lon: b.west },
    { lat: b.north, lon: b.east },
    { lat: b.south, lon: b.west },
    { lat: b.south, lon: b.east },
  ];
  for (const p of packs) {
    let all = true;
    for (const c of corners) {
      if (haversine({ lat: p.lat, lon: p.lon }, c) > p.radiusM) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Every tile whose nearest point is within `radiusM` of the camera, nearest
 * first, minus anything a baked pack already covers.
 *
 * Nearest first because the budget is finite: when a flight runs out of
 * requests it should have spent them on the ground under the aeroplane rather
 * than on an arbitrary slice of the ring.
 */
export function tilesAround(
  origin: Origin,
  camX: number,
  camZ: number,
  radiusM: number,
  packs: readonly BakedCoverage[] = [],
  zoom = LIVE_ZOOM,
): LiveTile[] {
  const here = origin.toLatLon(camX, camZ);
  const centre = tileFor(here.lat, here.lon, zoom);
  // One tile is ~1.9 km at this latitude and the radius is a few km, so the
  // search window is small; deriving it from the tile's own size keeps it
  // correct at any latitude, where a fixed span would not.
  const cb = tileBounds(centre);
  const tileWidthM = Math.max(
    1,
    haversine({ lat: cb.north, lon: cb.west }, { lat: cb.north, lon: cb.east }),
  );
  const tileHeightM = Math.max(
    1,
    haversine({ lat: cb.north, lon: cb.west }, { lat: cb.south, lon: cb.west }),
  );
  const spanX = Math.ceil(radiusM / tileWidthM) + 1;
  const spanY = Math.ceil(radiusM / tileHeightM) + 1;

  const out: LiveTile[] = [];
  const n = 2 ** zoom;
  for (let dy = -spanY; dy <= spanY; dy++) {
    for (let dx = -spanX; dx <= spanX; dx++) {
      const y = centre.y + dy;
      if (y < 0 || y >= n) continue;
      const t: Tile = { z: zoom, x: ((centre.x + dx) % n + n) % n, y };
      const b = tileBounds(t);
      // The tile in SCENE metres, so the distance test is the same metric the
      // renderer culls with.
      const nw = origin.toWorld(b.north, b.west);
      const se = origin.toWorld(b.south, b.east);
      const x0 = Math.min(nw.x, se.x), x1 = Math.max(nw.x, se.x);
      const z0 = Math.min(nw.z, se.z), z1 = Math.max(nw.z, se.z);
      const ddx = Math.max(0, Math.max(x0 - camX, camX - x1));
      const ddz = Math.max(0, Math.max(z0 - camZ, camZ - z1));
      const distM = Math.hypot(ddx, ddz);
      if (distM > radiusM) continue;
      if (tileCoveredByPack(t, packs)) continue;
      out.push({ tile: t, key: tileKey(t), bbox: tileBbox(t), distM });
    }
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}
