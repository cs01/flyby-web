// Imperial or metric, for the numbers a passenger reads.
//
// Imperial by default, which is a choice about the audience rather than about
// the units: the app is in English, most of its readers are American, and the
// number they want is the one they can feel without converting.
//
// The INSTRUMENTS are deliberately not part of this. Airspeed is in knots and
// altitude in feet on every aeroplane in the world including metric ones, and
// an altimeter reading metres would be wrong in both systems rather than right
// in one. What switches is the prose: temperature and ground distance.
//
// localStorage rather than the URL: it is a property of the reader, not of the
// flight, and a shared link should show the recipient THEIR units. Every
// access is wrapped, because a browser with site data blocked throws on the
// accessor itself rather than returning null.

export type Units = "imperial" | "metric";

const KEY = "flyby.units";

let cached: Units | null = null;

export function getUnits(): Units {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    // "c" and "f" are what this key held when it was a temperature-only
    // preference. Reading them rather than discarding them means nobody who
    // already chose Celsius has to choose it again.
    cached = raw === "metric" || raw === "c" ? "metric" : "imperial";
  } catch {
    cached = "imperial";
  }
  return cached;
}

export function setUnits(u: Units): void {
  cached = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    // A preference that cannot be saved still holds for this session.
  }
}

/** "81°F" or "27°C". Whole degrees: nobody flies on a tenth of one. */
export function formatTemp(celsius: number): string {
  return getUnits() === "imperial"
    ? `${Math.round(celsius * 1.8 + 32)}°F`
    : `${Math.round(celsius)}°C`;
}

/**
 * "3.2 mi" or "5.1 km", and one decimal only while that decimal means
 * something. Past ten of either unit it is changing every frame for no reason.
 */
export function formatDistance(metres: number): string {
  if (getUnits() === "imperial") {
    const mi = metres / 1609.344;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
