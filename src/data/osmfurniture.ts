// OpenStreetMap nodes to street furniture. The one copy.
//
// The counterpart of osmroads.ts for the things that stand BESIDE a road rather
// than being one. Same contract: pure, no fetch, no cache, no Bun, so the
// offline bake and any future runtime path come through here and a live lamp
// and a baked lamp are the same lamp.
//
// WHY THE QUERY RIDES WITH THE ROADS. Public Overpass instances rate-limit on
// REQUESTS, not on bytes, and this project has already been shed by them for
// over-fetching. Furniture nodes are in the same cells as the roads and are a
// rounding error next to the way geometry, so they are unioned into the road
// query rather than sent as a second one. The cost of the whole feature at bake
// time is therefore zero extra requests.
//
// A CONSEQUENCE WORTH KNOWING. The bake cache is keyed by city and cell and NOT
// by the query text, deliberately (an Overpass answer for a fixed box is
// immutable, so there is no TTL). Adding statements to the query therefore does
// NOT invalidate the cache: a cell fetched before this file existed will parse
// cleanly and yield zero furniture. That is the right trade -- it costs nobody
// a re-fetch of a 2 MB cell to gain nothing -- but it means a pack baked from
// an old cache reports zero measured nodes, and tools/bake-roads.ts says so out
// loud rather than letting it read as a city with no lamps.

import { Origin } from "../geo";
import { bboxFilter, Skips, type OsmBbox, type OsmElement } from "./osm";
import { FurnitureKind, type Furniture } from "./streetpack";

/**
 * The tags asked for, and what each becomes.
 *
 * Deliberately short. Every entry here is something that stands at a known
 * point, is the same object everywhere on Earth, and is worth about fifty
 * triangles. Anything whose appearance depends on a photograph (a shop sign, a
 * bus shelter's advertising) is not on this list and will not be.
 */
const NODE_KIND: [string, string, FurnitureKind][] = [
  ["highway", "street_lamp", FurnitureKind.StreetLamp],
  ["highway", "traffic_signals", FurnitureKind.TrafficSignal],
  ["amenity", "bench", FurnitureKind.Bench],
  ["amenity", "waste_basket", FurnitureKind.WasteBasket],
  ["emergency", "fire_hydrant", FurnitureKind.FireHydrant],
];

/** The Overpass statements, for the union in osmroads.roadsQuery. */
export function furnitureStatements(b: OsmBbox): string {
  const box = bboxFilter(b);
  return NODE_KIND.map(([k, v]) => `node["${k}"="${v}"](${box});`).join("\n");
}

/** True for the elements furnitureStatements asks for. */
export function isFurnitureElement(el: OsmElement): boolean {
  if (el.type !== "node") return false;
  const tags = el.tags ?? {};
  return NODE_KIND.some(([k, v]) => tags[k] === v);
}

/**
 * OSM `direction` is free text: a bearing, a compass point, or a description.
 *
 * Only the plain bearing is taken. `direction=forward` on a node means "along
 * the way this node is part of", which needs the way, and guessing north for it
 * would point every unmapped bench the same way, which is the one outcome worse
 * than admitting the bearing is unknown.
 */
export function parseDirection(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return ((v % 360) + 360) % 360;
}

export interface FurnitureConversion {
  items: Furniture[];
  skips: Skips;
}

/**
 * Project the nodes into the scene, dropping everything outside the circle.
 *
 * Clipped to the CIRCLE and not the box, for the same reason the roads are: the
 * cell grid is a rectangle around a round city and the corners of it are places
 * the renderer has no terrain for.
 */
export function furnitureFromOsm(
  elements: readonly OsmElement[],
  origin: Origin,
  radiusM: number,
): FurnitureConversion {
  const skips = new Skips();
  const items: Furniture[] = [];
  const seen = new Set<number>();

  for (const el of elements) {
    if (el.type !== "node") continue;
    const tags = el.tags ?? {};
    const hit = NODE_KIND.find(([k, v]) => tags[k] === v);
    if (!hit) {
      skips.add("a node with none of the furniture tags");
      continue;
    }
    if (el.lat === undefined || el.lon === undefined) {
      skips.add("a node with no coordinates");
      continue;
    }
    // Cells overlap at their edges and `out` returns whole nodes, so the same
    // node arrives from two cells; the id is the only thing that says so.
    if (seen.has(el.id)) continue;
    seen.add(el.id);

    const w = origin.toWorld(el.lat, el.lon);
    if (!Number.isFinite(w.x) || !Number.isFinite(w.z)) {
      skips.add("a node that did not project");
      continue;
    }
    if (Math.hypot(w.x, w.z) > radiusM) {
      skips.add("outside the scene circle");
      continue;
    }
    items.push({
      kind: hit[2],
      directionDeg: parseDirection(tags["direction"]),
      x: w.x,
      z: w.z,
    });
  }
  return { items, skips };
}
