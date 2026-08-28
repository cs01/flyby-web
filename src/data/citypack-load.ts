// Browser-side loading for .city packs. Split from the parser so that
// citypack.ts stays free of DOM and fetch, and can therefore run under Bun as
// the oracle for tools/verify-packs.ts.

import { fetchBytes, evict } from "./cache";
import { buildingIsNeedle, parseCityPack, type CityPack } from "./citypack";

/**
 * Load a baked pack, or null when the city has no pack yet.
 *
 * A missing pack is not an error -- the city still flies, it just has no
 * skyline -- but the REASON must reach the console. Silently returning null
 * made a 404 and a corrupt file look identical to a city nobody has baked.
 */
export async function loadCityPack(cityId: string): Promise<CityPack | null> {
  const url = `${import.meta.env.BASE_URL}cities/${cityId}.city`;
  let buf: ArrayBuffer;
  try {
    buf = await fetchBytes(url);
  } catch (err) {
    console.warn(`[flyby] no building pack at ${url}:`, err);
    return null;
  }
  try {
    const pack = parseCityPack(buf);
    // Drop OSM masts and spires before anything sees them. This happens on the
    // LOAD path rather than in parseCityPack so that tools/verify-packs.ts,
    // which uses the pure parser, still counts what the bake actually wrote.
    // Packs baked before the filter existed are fixed here without a re-bake.
    const kept = pack.buildings.filter((b) => !buildingIsNeedle(b));
    const dropped = pack.buildings.length - kept.length;
    if (dropped > 0) {
      console.info(`[flyby] ${cityId}: dropped ${dropped} mast-shaped records of ${pack.buildings.length}`);
      pack.buildings = kept;
    }
    return pack;
  } catch (err) {
    console.error(`[flyby] building pack at ${url} is unreadable (${buf.byteLength} bytes):`, err);
    // Whatever is cached under this URL is not a pack. Drop it so the next
    // load refetches rather than failing identically for the next 30 days.
    void evict(url);
    return null;
  }
}
