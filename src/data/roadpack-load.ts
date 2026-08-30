// Browser-side loading for .roads packs. Split from the parser so that
// roadpack.ts stays free of DOM and fetch, and can therefore run under Bun as
// the oracle for tools/verify-roads.ts and test/ribbon.check.ts.

import { fetchBytes, evict } from "./cache";
import { parseRoadPack, type RoadPack } from "./roadpack";

/**
 * Load a baked road pack, or null when the city has no pack yet.
 *
 * A missing pack is not an error -- the city still flies, its streets are just
 * whatever the satellite drape shows -- but the REASON must reach the console,
 * or a 404 and a corrupt file look identical to a city nobody has baked.
 */
export async function loadRoadPack(cityId: string): Promise<RoadPack | null> {
  const url = `${import.meta.env.BASE_URL}cities/${cityId}.roads`;
  let buf: ArrayBuffer;
  try {
    buf = await fetchBytes(url);
  } catch (err) {
    console.warn(`[flyby] no road pack at ${url}:`, err);
    return null;
  }
  try {
    return parseRoadPack(buf);
  } catch (err) {
    console.error(`[flyby] road pack at ${url} is unreadable (${buf.byteLength} bytes):`, err);
    // Whatever is cached under this URL is not a pack. Drop it so the next
    // load refetches rather than failing identically for the next 30 days.
    void evict(url);
    return null;
  }
}
