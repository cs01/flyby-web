// Streaming a city that nobody baked.
//
// Terrain, imagery, weather and landmarks have always worked for any coordinate
// on Earth, because all four are fetched at runtime BY COORDINATE. Buildings,
// roads and canopy did not, because the only code that could turn OSM into them
// lived in tools/ where a browser could not reach it. It now lives in
// src/data/osm*.ts, and this file is the part that decides WHEN to ask, WHAT to
// do with the answer, and what to tell the reader about it.
//
// Three rules shape everything here:
//
//   1. THE FLIGHT NEVER WAITS. Nothing in this file is awaited by the load. A
//      tile that is slow, refused or broken means that patch of ground has no
//      buildings yet, which is what most of the planet looks like in this app
//      already. It must never mean a load that failed.
//   2. ONE TILE AT A TIME, NEAREST FIRST. src/data/overpass.ts holds the rate
//      limit and the session budget; this holds the ordering, so when the
//      budget runs out it has been spent on the ground under the aeroplane.
//   3. WHAT ARRIVES IS DRAWN BY THE SAME CODE AS A BAKED PACK. Each tile builds
//      a Buildings and a Roads from in-memory records shaped exactly like a
//      parsed .city / .roads, and the canopy goes into the coverage grid the
//      existing tree field already plants from. There is no second renderer.

import * as THREE from "three";
import { Origin } from "../geo";
import { Buildings } from "../render/buildings";
import { Roads } from "../render/roads";
import type { Budget } from "../render/budget";
import type { SunShadowUniforms } from "../render/sunshadow";
import { unpackBuildings, type Building, type CityPack } from "../data/citypack";
import { unpackRoads, type RoadPack } from "../data/roadpack";
import { buildingsFromOsm, isBuildingElement } from "../data/osmbuildings";
import { isRoadElement, roadsFromOsm } from "../data/osmroads";
import { LiveVegetation } from "../data/osmveg";
import { Overpass } from "../data/overpass";
import {
  liveTileQuery,
  tilesAround,
  LIVE_WORLD_RADIUS_M,
  type BakedCoverage,
} from "../data/livetiles";
import type { OsmElement, OverpassResponse } from "../data/osm";
import { fetchJson, TTL_STATIC } from "../data/cache";
import { CITIES } from "../cities";
import {
  CompositeRoadIndex,
  FootprintMask,
  RoadIndex,
  treeRoadClearanceM,
} from "../data/trees";

/**
 * How far from the camera tiles are wanted, in metres.
 *
 * Two tiles' reach. Further would look better and would spend the session
 * budget on ground the aeroplane leaves before the answer lands; a flight at a
 * hundred knots crosses this in about a minute, which is roughly how long a
 * tile takes to arrive and build.
 */
const WANT_RADIUS_M = 4000;

/**
 * Tiles whose geometry is kept resident. Past this the scheduler stops asking.
 *
 * Not a politeness limit -- src/data/overpass.ts owns that -- but a memory one.
 * Twenty-four tiles of a dense city is on the order of a baked Manhattan, which
 * is the largest thing this renderer is known to hold.
 */
const MAX_TILES = 24;

/** How far the camera must move before the tile list is recomputed, in metres. */
const RESCAN_M = 250;

/**
 * Half-width of the live coverage grid and footprint mask, in metres.
 *
 * Comfortably past WANT_RADIUS_M plus a tile, because the tree field clamps
 * itself to the mask extent: a grid that ended at the streaming radius would
 * stop the canopy dead at a circle in the middle of the view. It is also what
 * the footprint bitset spans, at 2 MB packed.
 */
export const LIVE_EXTENT_M = 8000;

type TileState = "wanted" | "loading" | "done" | "empty" | "failed";

export interface LiveStats {
  /** Tiles whose geometry is in the scene. */
  tiles: number;
  /** Tiles that were asked for and produced nothing at all. */
  empty: number;
  /** Tiles that were asked for and failed. */
  failed: number;
  buildings: number;
  roads: number;
  /** Canopy polygons and individually mapped tree nodes rasterised. */
  vegPolygons: number;
  vegNodes: number;
  /** Triangles the streamed geometry adds to the frame. */
  triangles: number;
  /** True while a request is outstanding. */
  fetching: boolean;
}

export interface LiveWorldOptions {
  origin: Origin;
  scene: THREE.Scene;
  heightAt: (x: number, z: number) => number;
  shadow: SunShadowUniforms;
  budget: Budget;
  /** Ground a baked pack already covers, which is never asked for. */
  packs: readonly BakedCoverage[];
  /** Null where a .land pack is the better canopy source and already loaded. */
  vegetation: LiveVegetation | null;
  footprints: FootprintMask;
  roadBlockers: CompositeRoadIndex;
  /**
   * The frame loop's own uniform lists, appended to as tiles arrive.
   *
   * Handed in rather than owned here so main.ts walks ONE array per material
   * kind whether the geometry came from a pack or off the wire, instead of
   * growing a second copy of every per-frame uniform assignment.
   */
  buildingUniforms: Buildings["uniforms"][];
  roadUniforms: Roads["uniforms"][];
  /** Called when the canopy grid has changed and the tree field is stale. */
  onVegetation: () => void;
  /**
   * The client to ask through. Injected rather than built here so the caller
   * owns the endpoint list and the pacing, and so the gate can drive the whole
   * scheduler without waiting out the real two-second gap for every tile.
   */
  overpass: Overpass;
}

export class LiveWorld {
  readonly overpass: Overpass;
  readonly stats: LiveStats = {
    tiles: 0,
    empty: 0,
    failed: 0,
    buildings: 0,
    roads: 0,
    vegPolygons: 0,
    vegNodes: 0,
    triangles: 0,
    fetching: false,
  };

  private readonly opts: LiveWorldOptions;
  private readonly state = new Map<string, TileState>();
  /**
   * OSM ids already turned into geometry.
   *
   * `out geom` returns a way WHOLE whenever it touches the box, so a building
   * on a tile boundary comes back in both tiles. Without this it would be
   * extruded twice, and two coplanar copies of the same wall is z-fighting that
   * looks like a shader bug.
   */
  private readonly seen = new Set<string>();
  private queue: { key: string; bbox: ReturnType<typeof tilesAround>[number]["bbox"] }[] = [];
  private scannedX = Infinity;
  private scannedZ = Infinity;
  private busy = false;
  /** Triangle budget one tile may spend; see the note in `build`. */
  private readonly tileBudget: Budget;

  constructor(opts: LiveWorldOptions) {
    this.opts = opts;
    this.overpass = opts.overpass;
    // A share each, so N tiles together stay inside the budget the device was
    // given rather than N times it. Handing every tile the whole budget is the
    // obvious thing to write and it silently multiplies the frame cost by the
    // number of tiles that happen to have loaded.
    this.tileBudget = {
      ...opts.budget,
      buildingTriangleBudget: Math.round(opts.budget.buildingTriangleBudget / MAX_TILES),
      roadTriangleBudget: Math.round(opts.budget.roadTriangleBudget / MAX_TILES),
    };
  }

  /**
   * Called every frame. Cheap: it only rescans when the camera has moved, and
   * it starts at most one fetch.
   */
  update(camX: number, camZ: number): void {
    if (Math.hypot(camX - this.scannedX, camZ - this.scannedZ) > RESCAN_M) {
      this.scannedX = camX;
      this.scannedZ = camZ;
      this.rescan(camX, camZ);
    }
    if (!this.busy) void this.pump();
  }

  private rescan(camX: number, camZ: number): void {
    const wanted = tilesAround(this.opts.origin, camX, camZ, WANT_RADIUS_M, this.opts.packs);
    this.queue = [];
    for (const t of wanted) {
      const s = this.state.get(t.key);
      // "empty" and "failed" are both final for the session, and so is "done".
      // Re-asking for a square of desert on every rescan is exactly the
      // behaviour that gets an instance to start refusing.
      //
      // "wanted" is NOT final and has to be re-queued: the queue is rebuilt
      // from scratch here, so a tile that was still waiting its turn would
      // otherwise be marked as spoken for and never asked about again.
      if (s !== undefined && s !== "wanted") continue;
      this.state.set(t.key, "wanted");
      this.queue.push({ key: t.key, bbox: t.bbox });
    }
  }

  private async pump(): Promise<void> {
    // The cap is checked BEFORE the queue is touched. Shifting first and then
    // returning would drop the tile on the floor with its state still saying
    // somebody was dealing with it, and it would never be asked about again.
    if (this.stats.tiles >= MAX_TILES) return;
    const next = this.queue.shift();
    if (!next) return;

    this.busy = true;
    this.stats.fetching = true;
    this.state.set(next.key, "loading");
    try {
      const body = await this.overpass.json<OverpassResponse>(liveTileQuery(next.bbox));
      if (body === null) {
        this.state.set(next.key, "failed");
        this.stats.failed++;
        return;
      }
      const elements = body.elements ?? [];
      // A well-formed answer with nothing in it is the correct answer for open
      // country, and it is a SUCCESS: it just describes ground with no city on
      // it. Counted apart from a failure so the panel can tell them apart.
      const built = this.build(next.key, elements);
      this.state.set(next.key, built ? "done" : "empty");
      if (!built) this.stats.empty++;
    } catch (err) {
      // Nothing above is expected to throw, and the whole point of this file is
      // that a flight never stops because a volunteer server had a bad minute.
      console.warn(`[flyby] live tile ${next.key} failed to build:`, err);
      this.state.set(next.key, "failed");
      this.stats.failed++;
    } finally {
      this.busy = false;
      this.stats.fetching = false;
      // Straight on to the next one; the rate limiter decides the pace.
      if (this.queue.length > 0) void this.pump();
    }
  }

  /** Turn one tile's elements into scene geometry. Returns false for nothing. */
  private build(key: string, elements: readonly OsmElement[]): boolean {
    const { origin, scene, heightAt, shadow, vegetation, footprints, roadBlockers } = this.opts;

    // One combined answer carries all three subjects, so each converter is
    // handed exactly the elements its own query would have returned. The
    // predicates live beside the query fragments they mirror.
    const fresh: OsmElement[] = [];
    for (const el of elements) {
      const id = `${el.type}/${el.id}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      fresh.push(el);
    }

    let any = false;

    const buildingEls = fresh.filter(isBuildingElement);
    let buildings: Building[] = [];
    if (buildingEls.length > 0) {
      const conv = buildingsFromOsm(buildingEls, origin, LIVE_WORLD_RADIUS_M);
      buildings = unpackBuildings(conv.buildings);
      if (buildings.length > 0) {
        // Shaped exactly like a parsed .city, because that is what it is: the
        // same converter, the same quantisation, the same f32 rounding.
        const pack: CityPack = {
          lat0: origin.lat,
          lon0: origin.lon,
          radiusM: LIVE_WORLD_RADIUS_M,
          buildings,
        };
        const b = new Buildings(pack, heightAt, shadow, this.tileBudget);
        scene.add(b.group);
        this.opts.buildingUniforms.push(b.uniforms);
        this.stats.buildings += buildings.length;
        this.stats.triangles += b.stats.triangles;
        // Trees must not grow out of roofs that only exist because this tile
        // arrived, so the mask learns about them before the canopy is replanted.
        footprints.add(buildings);
        any = true;
      }
    }

    const roadEls = fresh.filter(isRoadElement);
    if (roadEls.length > 0) {
      const conv = roadsFromOsm(roadEls, origin, LIVE_WORLD_RADIUS_M);
      const roads = unpackRoads(conv.ways);
      if (roads.length > 0) {
        const pack: RoadPack = {
          lat0: origin.lat,
          lon0: origin.lon,
          radiusM: LIVE_WORLD_RADIUS_M,
          roads,
        };
        const r = new Roads(pack, heightAt, shadow, this.tileBudget);
        scene.add(r.group);
        this.opts.roadUniforms.push(r.uniforms);
        this.stats.roads += roads.length;
        this.stats.triangles += r.stats.triangles;
        roadBlockers.add(new RoadIndex(roads, treeRoadClearanceM));
        any = true;
      }
    }

    if (vegetation) {
      const veg = vegetation.add(fresh, origin);
      this.stats.vegPolygons += veg.polygons;
      this.stats.vegNodes += veg.nodes;
      // Replant only when the grid actually changed. A tile of bare farmland
      // raises nothing, and re-placing every tree in the field to add none of
      // them is the sort of cost that only shows up as a stutter.
      if (veg.cells > 0) {
        this.opts.onVegetation();
        any = true;
      }
    } else if (buildings.length > 0) {
      // The .land pack still plants the trees, but it did not know where these
      // roofs were until now, so the field has to be replanted around them.
      this.opts.onVegetation();
    }

    if (any) this.stats.tiles++;
    else console.info(`[flyby] live tile ${key}: nothing mapped here`);
    return any;
  }

  /**
   * Tiles still queued to ask about.
   *
   * Zero AND nothing in flight is the only honest "this is everything there is
   * to show here" signal, and the screenshot harness waits on it: a frame taken
   * as soon as the first tile lands is a picture of one square of a city.
   */
  get pending(): number {
    return this.queue.length;
  }

  /** Latency of the successful requests so far, in milliseconds. */
  latency(): { n: number; median: number; max: number } {
    const a = [...this.overpass.stats.latencyMs].sort((x, y) => x - y);
    if (a.length === 0) return { n: 0, median: 0, max: 0 };
    return { n: a.length, median: a[a.length >> 1], max: a[a.length - 1] };
  }
}

/**
 * The curated cities that actually have a baked .city pack, as ground the live
 * path must not ask about.
 *
 * Read from the generated index rather than from CITIES, because CITIES lists
 * places worth flying and only seven of them have been baked. Failure gives an
 * empty list, which is the safe direction: the worst case is asking Overpass
 * for a square that a pack would have covered, not drawing a city twice, since
 * a scene showing a baked pack does not run the live path at all.
 */
export async function bakedCityCoverage(): Promise<BakedCoverage[]> {
  try {
    const ids = await fetchJson<string[]>(
      `${import.meta.env.BASE_URL}cities/index.json`,
      TTL_STATIC,
    );
    const have = new Set(ids);
    return CITIES.filter((c) => have.has(c.id)).map((c) => ({
      lat: c.lat,
      lon: c.lon,
      radiusM: c.radius,
    }));
  } catch {
    return [];
  }
}
