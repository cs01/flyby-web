// Browser-side loading for .street packs. Split from the parser for the same
// reason roadpack-load.ts is: streetpack.ts stays free of DOM and fetch so it
// can run under Bun as the oracle for the baker.

import { fetchBytes, evict } from "./cache";
import { parseStreetPack, type StreetPack } from "./streetpack";

/**
 * Load a city's surveyed street furniture, or null when it has none.
 *
 * A missing pack is the COMMON case and must stay quiet in the console: only a
 * well-mapped city has furniture nodes at all, most cities with a .roads pack
 * have no .street sibling, and the renderer's answer to that is to place
 * procedurally. So a 404 is logged at debug volume and a CORRUPT file is
 * logged loudly, because those two are the same fetch failure and only one of
 * them is news.
 */
export async function loadStreetPack(cityId: string): Promise<StreetPack | null> {
  const url = `${import.meta.env.BASE_URL}cities/${cityId}.street`;
  let buf: ArrayBuffer;
  try {
    buf = await fetchBytes(url);
  } catch {
    return null;
  }
  try {
    return parseStreetPack(buf);
  } catch (err) {
    console.error(`[flyby] street pack at ${url} is unreadable (${buf.byteLength} bytes):`, err);
    // Whatever is cached under this URL is not a pack; drop it so the next load
    // refetches rather than failing identically for the next thirty days.
    void evict(url);
    return null;
  }
}
