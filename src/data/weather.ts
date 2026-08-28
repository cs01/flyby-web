// The weather that is actually happening over the city, at page load.
//
// Two feeds, both keyless and CORS-open, both verified against a live request
// before this file was written:
//
//   Open-Meteo  — the numbers. Temperature, dewpoint, wind, visibility,
//                 pressure, precipitation, and cloud cover split into LOW /
//                 MID / HIGH decks. The deck split is what makes this feed
//                 worth using over a single-station METAR: three coverage
//                 numbers drive three cloud layers, and a scattered cumulus
//                 day stops looking like an overcast one.
//   RainViewer  — where the rain is, as a radar mosaic, so precipitation has a
//                 position on the map instead of falling uniformly everywhere.
//
// Deliberately fetched ONCE per session and cached for ten minutes. A flight
// is a few minutes long; a sky that re-rendered itself mid-flight because an
// observation ticked over would be a bug, not a feature.
//
// What is measured and what is invented, because the difference is the whole
// point of doing this instead of picking a pretty preset:
//   MEASURED   temperature, dewpoint, wind, pressure, visibility, precip rate,
//              cloud cover per deck, radar reflectivity position.
//   DERIVED    cloud BASE, from the spread between temperature and dewpoint
//              (the LCL; ~125 m per degree C, the standard field rule).
//   INVENTED   cloud top and the shape of any individual cloud. There is no
//              free feed for either. They are named here so nothing downstream
//              can mistake them for observations.

import { fetchJson, TTL_WEATHER } from "./cache";

export interface CloudDeck {
  /** 0..1 sky covered by this deck. */
  cover: number;
  /** Metres AMSL. */
  base: number;
  top: number;
}

export interface Weather {
  time: Date;
  /** True if this came off the wire; false means every field below is a guess. */
  live: boolean;
  tempC: number;
  dewC: number;
  humidity: number;
  pressureHpa: number;
  /** Metres per second. */
  windSpeed: number;
  /** Degrees, meteorological (direction the wind comes FROM). */
  windDir: number;
  gust: number;
  /** Metres. Open-Meteo caps this at 24 km. */
  visibility: number;
  /** mm/h. */
  precip: number;
  precipKind: "none" | "rain" | "snow";
  wmoCode: number;
  isDay: boolean;
  low: CloudDeck;
  mid: CloudDeck;
  high: CloudDeck;
  /** Total sky cover 0..1, as reported rather than composed from the decks. */
  totalCover: number;
  /**
   * How much the cloud actually blocks the SUN, 0..1 — which is a different
   * quantity from how much of the sky it covers, and conflating the two is the
   * single biggest error available in a weather-driven renderer.
   *
   * An overcast of low stratus takes the beam away completely: no shadows, flat
   * grey light. A 100%-covered sky of high cirrus barely dims it: you still get
   * shadows, just softened, and the day still reads as sunny. Both report
   * `cloud_cover: 100`. Weighting the decks by their real optical thickness is
   * what separates them.
   */
  opacity: number;
  /** Human summary for the HUD, from the WMO code. */
  summary: string;
}

/**
 * Lifted condensation level: the height a surface parcel must rise to condense,
 * and therefore the base of any convective cloud. 125 m per degree C of
 * temperature/dewpoint spread is the standard field approximation and is good
 * to a couple of hundred metres, which is well inside what a viewer can judge.
 */
export function lclMetres(tempC: number, dewC: number): number {
  return 125 * Math.max(0, tempC - dewC);
}

/** Dewpoint from temperature and RH (Magnus, coefficients for water). */
export function dewpoint(tempC: number, rh: number): number {
  const a = 17.625;
  const b = 243.04;
  const r = Math.max(1, Math.min(100, rh)) / 100;
  const g = Math.log(r) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

const WMO: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

/**
 * Beam attenuation from the three decks, combined as independent layers.
 *
 * Weights are optical depth per unit coverage, low to high. Low cloud is water
 * droplets and nearly opaque; cirrus is thin ice crystals that scatter forward
 * and pass most of the beam. Measured against the obvious sanity check: a
 * cirrus-only overcast must still cast shadows on the ground.
 */
function beamOpacity(low: number, mid: number, high: number): number {
  return 1 - (1 - 0.92 * low) * (1 - 0.60 * mid) * (1 - 0.28 * high);
}

function precipKindFor(code: number, tempC: number): "none" | "rain" | "snow" {
  if (code >= 71 && code <= 77) return "snow";
  if (code === 85 || code === 86) return "snow";
  if (code >= 51 && code <= 82) return tempC < 0.5 ? "snow" : "rain";
  if (code >= 95) return "rain";
  return "none";
}

interface OpenMeteoCurrent {
  time: string;
  temperature_2m: number;
  relative_humidity_2m: number;
  dew_point_2m: number;
  surface_pressure: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  wind_gusts_10m: number;
  visibility: number;
  precipitation: number;
  weather_code: number;
  is_day: number;
  cloud_cover: number;
  cloud_cover_low: number;
  cloud_cover_mid: number;
  cloud_cover_high: number;
}

const CURRENT_FIELDS = [
  "temperature_2m",
  "relative_humidity_2m",
  "dew_point_2m",
  "surface_pressure",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "visibility",
  "precipitation",
  "weather_code",
  "is_day",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
].join(",");

/** A believable sky for when the network is gone. Flagged `live: false`. */
export function fallbackWeather(): Weather {
  const t = 18;
  const d = 10;
  const base = lclMetres(t, d);
  return {
    time: new Date(),
    live: false,
    tempC: t,
    dewC: d,
    humidity: 60,
    pressureHpa: 1013.25,
    windSpeed: 4,
    windDir: 270,
    gust: 6,
    visibility: 20000,
    precip: 0,
    precipKind: "none",
    wmoCode: 2,
    isDay: true,
    low: { cover: 0.25, base, top: base + 900 },
    mid: { cover: 0.1, base: 4200, top: 5400 },
    high: { cover: 0.15, base: 9000, top: 10500 },
    totalCover: 0.3,
    opacity: beamOpacity(0.25, 0.1, 0.15),
    summary: "Partly cloudy",
  };
}

export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lon.toFixed(4)}&current=${CURRENT_FIELDS}` +
    `&wind_speed_unit=ms&timezone=UTC`;

  let cur: OpenMeteoCurrent;
  try {
    const j = await fetchJson<{ current: OpenMeteoCurrent }>(url, TTL_WEATHER);
    cur = j.current;
  } catch {
    return fallbackWeather();
  }

  const tempC = cur.temperature_2m;
  const dewC = cur.dew_point_2m ?? dewpoint(tempC, cur.relative_humidity_2m);
  const code = cur.weather_code | 0;

  // Deck geometry. The LOW base is the LCL, which is measured input; MID and
  // HIGH bases are climatological standoffs, because nothing in a free feed
  // reports them. Thickness scales with coverage: an overcast deck is a solid
  // slab, a few-eighths deck is thin puffs.
  const lowBase = Math.max(120, lclMetres(tempC, dewC));
  const lowCover = cur.cloud_cover_low / 100;
  const midCover = cur.cloud_cover_mid / 100;
  const highCover = cur.cloud_cover_high / 100;

  return {
    time: new Date(cur.time + "Z"),
    live: true,
    tempC,
    dewC,
    humidity: cur.relative_humidity_2m,
    pressureHpa: cur.surface_pressure,
    windSpeed: cur.wind_speed_10m,
    windDir: cur.wind_direction_10m,
    gust: cur.wind_gusts_10m ?? cur.wind_speed_10m,
    // Open-Meteo reports visibility in metres and tops out at 24 km. Treat the
    // cap as "unlimited" rather than as a wall of haze at 24 km.
    visibility: cur.visibility >= 24000 ? 60000 : cur.visibility,
    precip: cur.precipitation,
    precipKind: precipKindFor(code, tempC),
    wmoCode: code,
    isDay: cur.is_day === 1,
    low: { cover: lowCover, base: lowBase, top: lowBase + 300 + 1400 * lowCover },
    mid: { cover: midCover, base: 3800, top: 3800 + 600 + 1800 * midCover },
    high: { cover: highCover, base: 8500, top: 8500 + 900 + 1500 * highCover },
    totalCover: cur.cloud_cover / 100,
    opacity: beamOpacity(lowCover, midCover, highCover),
    summary: WMO[code] ?? "Unknown",
  };
}

// --- Radar ----------------------------------------------------------------

export interface RadarFrame {
  /** Full tile URL template with {z}/{x}/{y} still to substitute. */
  template: string;
  time: Date;
}

interface RainViewerIndex {
  host: string;
  radar: { past: { time: number; path: string }[] };
}

/**
 * Most recent RainViewer radar mosaic. Returns null when there is no radar at
 * all, which is most of the planet outside the US/EU/JP/AU — the renderer must
 * treat radar as an optional garnish, never as the precipitation source.
 */
export async function fetchRadar(): Promise<RadarFrame | null> {
  try {
    const idx = await fetchJson<RainViewerIndex>(
      "https://api.rainviewer.com/public/weather-maps.json",
      TTL_WEATHER,
    );
    const past = idx.radar?.past;
    if (!past?.length) return null;
    const last = past[past.length - 1];
    // 512 px tiles, colour scheme 4 (universal blue), smoothed, no snow mask.
    return {
      template: `${idx.host}${last.path}/512/{z}/{x}/{y}/4/1_0.png`,
      time: new Date(last.time * 1000),
    };
  } catch {
    return null;
  }
}
