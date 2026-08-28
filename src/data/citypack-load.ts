// Browser-side loading for .city packs. Split from the parser so that
// citypack.ts stays free of DOM and fetch, and can therefore run under Bun as
// the oracle for tools/verify-packs.ts.

import { fetchBytes, evict } from "./cache";
import { parseCityPack, type CityPack } from "./citypack";

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
    return parseCityPack(buf);
  } catch (err) {
    console.error(`[flyby] building pack at ${url} is unreadable (${buf.byteLength} bytes):`, err);
    // Whatever is cached under this URL is not a pack. Drop it so the next
    // load refetches rather than failing identically for the next 30 days.
    void evict(url);
    return null;
  }
}
