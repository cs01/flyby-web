// Turning coordinates into a place name, in both directions.
//
// FORWARD (search) is Open-Meteo's geocoder, which the app already depends on
// for weather: keyless, CORS-open, and it answers with the coordinates, the
// country and the admin region in one call.
//
// REVERSE is BigDataCloud's client endpoint, which exists precisely for a
// browser asking "where am I" and needs no key either. It is the one service
// here that is not already carrying something else, and it is used exactly
// once per session, only after the reader has pressed the location button.
// The fix is rounded before it is sent, for the same reason it is rounded
// before it goes in the URL.
//
// Both degrade to null. A flight with an unnamed place on the panel is a
// flight; a flight that failed to start because a name lookup timed out is
// not.

export interface Place {
  name: string;
  /** State, province or region. Empty where the country has no useful one. */
  region: string;
  country: string;
}

/** "Brooklyn, New York, USA" -- trimmed of whatever is missing or repeated. */
export function placeLabel(p: Place): string {
  const parts = [p.name, p.region, p.country].filter((x) => x && x.length > 0);
  // A city that IS its region ("Singapore, Singapore, Singapore") should say
  // it once.
  return parts.filter((x, i) => parts.indexOf(x) === i).join(", ");
}

interface OMGeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  population?: number;
}

export interface SearchHit extends Place {
  lat: number;
  lon: number;
  population: number;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}` +
    `&count=8&language=en&format=json`;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit", signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { results?: OMGeoResult[] };
    return (j.results ?? []).map((r) => ({
      name: r.name,
      region: r.admin1 ?? "",
      country: r.country ?? r.country_code ?? "",
      lat: r.latitude,
      lon: r.longitude,
      population: r.population ?? 0,
    }));
  } catch {
    // An aborted request is the common case here, not an error: every
    // keystroke cancels the one before it.
    return [];
  }
}

interface BDCResult {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  countryName?: string;
}

export async function reverseGeocode(lat: number, lon: number): Promise<Place | null> {
  const url =
    `https://api.bigdatacloud.net/data/reverse-geocode-client` +
    `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&localityLanguage=en`;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const j = (await res.json()) as BDCResult;
    const name = j.city || j.locality || j.principalSubdivision || "";
    if (!name) return null;
    return {
      name,
      region: j.principalSubdivision && j.principalSubdivision !== name ? j.principalSubdivision : "",
      country: j.countryName ?? "",
    };
  } catch {
    return null;
  }
}
