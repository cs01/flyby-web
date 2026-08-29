// Browser-side loading for .land landcover packs. Split from the parser so
// that landcover.ts stays free of DOM and fetch, and can therefore run under
// Bun as the oracle for tools/verify-land.ts and test/landmask.check.ts.

import { fetchBytes, fetchJson, evict } from "./cache";
import { parseLandPack, type LandPack } from "./landcover";

/** Cities that actually have a pack. Fetched once; a failure here is not fatal,
 *  it just means the pack fetch below finds out about a 404 the slow way. */
let indexPromise: Promise<Set<string> | null> | null = null;

function landIndex(): Promise<Set<string> | null> {
  if (!indexPromise) {
    const url = `${import.meta.env.BASE_URL}cities/land-index.json`;
    indexPromise = fetchJson<string[]>(url)
      .then((ids) => new Set(ids))
      .catch((err) => {
        console.warn(`[flyby] no landcover index at ${url}:`, err);
        return null;
      });
  }
  return indexPromise;
}

/**
 * Load a baked landcover pack, or null when the city has no pack yet.
 *
 * A missing pack is not an error -- the city still flies, its water is just
 * identified by the old elevation heuristic -- but the REASON must reach the
 * console, or a 404 and a corrupt file look identical to a city nobody baked.
 */
export async function loadLandPack(cityId: string): Promise<LandPack | null> {
  const url = `${import.meta.env.BASE_URL}cities/${cityId}.land`;

  // Skip a request that is known to 404. This is an optimisation only: if the
  // index is missing, stale, or unreadable, the fetch below still runs and
  // still degrades cleanly, because the index is a hint and not the truth.
  const index = await landIndex();
  if (index && !index.has(cityId)) {
    console.info(`[flyby] no landcover pack for ${cityId}; run: bun tools/bake-land.ts --city ${cityId}`);
    return null;
  }

  let buf: ArrayBuffer;
  try {
    buf = await fetchBytes(url);
  } catch (err) {
    console.warn(`[flyby] no landcover pack at ${url}:`, err);
    return null;
  }
  try {
    return parseLandPack(buf);
  } catch (err) {
    console.error(`[flyby] landcover pack at ${url} is unreadable (${buf.byteLength} bytes):`, err);
    // Whatever is cached under this URL is not a pack. Drop it so the next
    // load refetches rather than failing identically for the next 30 days.
    void evict(url);
    return null;
  }
}
