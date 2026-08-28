// What is actually down there, for a place the curated list never heard of.
//
// The twenty-nine hand-written cities carry five landmarks each. Everywhere
// else -- a searched city, a geolocated fix, any of the other several million
// places this app can already fly -- had none, so the landmark layer was a
// switch with nothing behind it.
//
// Wikipedia's geosearch answers "what is within N metres of here", keyless and
// CORS-open (with origin=*), and what it returns is exactly the right SHAPE of
// thing: the places somebody thought were worth writing about. That is a much
// better filter for "worth flying to" than any tag in a map database, which
// would hand back every bus shelter with equal enthusiasm.
//
// It is one request per flight, cached like everything else, and a failure is
// silent: the flight is the point and the labels are a bonus.

import { fetchJson } from "./cache";

/** The API's own ceiling. Asking for more is an error, not a bigger answer. */
const MAX_RADIUS_M = 10000;

/** Cached for a day. What is notable near a coordinate is not hourly news. */
const TTL_NEARBY = 24 * 3600 * 1000;

export interface NearbyPlace {
  name: string;
  lat: number;
  lon: number;
  /** Metres from the query point, as the API measured it. */
  distance: number;
}

interface GeoSearchResponse {
  query?: { geosearch?: { title: string; lat: number; lon: number; dist: number }[] };
}

export async function fetchNearby(
  lat: number,
  lon: number,
  radiusM = MAX_RADIUS_M,
  limit = 40,
): Promise<NearbyPlace[]> {
  const r = Math.min(MAX_RADIUS_M, Math.max(100, Math.round(radiusM)));
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=geosearch` +
    `&gscoord=${lat.toFixed(4)}%7C${lon.toFixed(4)}&gsradius=${r}&gslimit=${limit}` +
    `&format=json&origin=*`;
  try {
    const j = await fetchJson<GeoSearchResponse>(url, TTL_NEARBY);
    const hits = j.query?.geosearch ?? [];
    return hits
      // "Jefferson Apartment Building (Niagara Falls, New York)" is a
      // Wikipedia article title solving Wikipedia's problem, which is that two
      // articles cannot share a name. On a label over the thing itself the
      // parenthetical is the part you can already see out of the window.
      .map((h) => ({
        name: h.title.replace(/\s*\([^)]*\)\s*$/, "").trim() || h.title,
        lat: h.lat,
        lon: h.lon,
        distance: h.dist,
      }))
      // Nearest first, which is the order a list of places to fly to wants to
      // be in: the interesting question is what is close, not what is famous.
      .sort((a, b) => a.distance - b.distance);
  } catch {
    return [];
  }
}
