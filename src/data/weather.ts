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

export type WeatherSource = "observation" | "forecast" | "simulated";

export interface Weather {
  time: Date;
  /** True if this came off the wire; false means every field below is a guess. */
  live: boolean;
  /**
   * Where these numbers came from. `live` alone stopped being enough once the
   * clock could be moved: a forecast for 09:00 tomorrow IS off the wire, and
   * badging it "LIVE" would be the exact dishonesty the panel exists to avoid.
   */
  source: WeatherSource;
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
    source: "simulated",
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

  return composeWeather(cur, new Date(cur.time + "Z"), "observation");
}

/**
 * One field sample -> one `Weather`.
 *
 * Shared by the observation and the forecast so a forecast hour and the current
 * hour cannot disagree about how cloud decks are stacked or how visibility is
 * capped. Two copies of this arithmetic would drift, and the drift would show
 * up as the sky changing appearance the moment the clock moved off "now".
 */
function composeWeather(cur: OpenMeteoCurrent, time: Date, source: WeatherSource): Weather {
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
    time,
    live: true,
    source,
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

// --- Forecast timeline ----------------------------------------------------
//
// The observation answers "what is it doing now". Moving the clock asks a
// different question, and it has a different feed: Open-Meteo's HOURLY block,
// out to seven days, with exactly the fields the `current` block carries. So
// the same `composeWeather` builds both and the sky does not change character
// the instant you scrub off the present hour.
//
// Everything here is interpolated between the two bracketing hours except the
// two quantities that CANNOT be: the WMO code and the day/night flag are
// categorical, and the average of "light rain" and "overcast" is not a weather
// state. Those step at the nearest hour; the continuous fields glide.

const HOURLY_FIELDS = CURRENT_FIELDS;

interface OpenMeteoForecast {
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  hourly: Record<string, (number | null)[]> & { time: number[] };
}

export interface WeatherTimeline {
  /** IANA zone for the city, e.g. "America/New_York". Formats the wall clock. */
  timezone: string;
  /** Seconds to add to UTC for this city's wall clock, at the queried instant. */
  utcOffsetSeconds: number;
  /** Bounds of the forecast, UTC. Outside them `at` clamps to the end sample. */
  start: Date;
  end: Date;
  at(when: Date): Weather;
}

/** Shortest-arc interpolation between two compass bearings. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

/**
 * Hourly forecast for a place, as a function of time.
 *
 * Returns null rather than throwing when the feed is unreachable: the clock
 * still moves (the SUN is computed locally and needs no network), it just
 * carries the present weather with it, and the HUD says so.
 */
export async function fetchForecast(lat: number, lon: number): Promise<WeatherTimeline | null> {
  // `timezone=auto` is asked for to learn the city's IANA zone -- there is no
  // other keyless way to get a city's wall clock, and a hard-coded per-city
  // offset would be wrong twice a year.
  //
  // `timeformat=unixtime` is what makes that safe. With ISO stamps, asking for
  // a local timezone returns local wall-clock strings with no offset marker,
  // and every one of them then has to be converted back with an offset that is
  // itself only correct on one side of a DST change. Unix time is UTC by
  // definition, so the stamps are unambiguous and the zone is only ever used
  // for display.
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lon.toFixed(4)}&hourly=${HOURLY_FIELDS}` +
    `&wind_speed_unit=ms&timezone=auto&timeformat=unixtime&forecast_days=7&past_days=1`;

  let j: OpenMeteoForecast;
  try {
    j = await fetchJson<OpenMeteoForecast>(url, TTL_WEATHER);
  } catch {
    return null;
  }

  const times = j.hourly?.time ?? [];
  if (times.length < 2) return null;
  const stamps = times.map((t) => t * 1000);

  const col = (name: string): (number | null)[] => j.hourly[name] ?? [];
  const cols: Record<string, (number | null)[]> = {};
  for (const f of HOURLY_FIELDS.split(",")) cols[f] = col(f);

  // A gap in one field must not take the whole hour down: Open-Meteo returns
  // null for a variable a model does not carry (visibility, on some), and a
  // null read as 0 is a wall of fog rather than a missing number.
  const pick = (name: string, i: number, fallback: number): number => {
    const v = cols[name]?.[i];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };

  const sampleAt = (i: number): OpenMeteoCurrent => ({
    // `composeWeather` takes the instant as an argument; this field only exists
    // to satisfy the shape shared with the `current` block.
    time: "",
    temperature_2m: pick("temperature_2m", i, 15),
    relative_humidity_2m: pick("relative_humidity_2m", i, 60),
    dew_point_2m: pick("dew_point_2m", i, NaN),
    surface_pressure: pick("surface_pressure", i, 1013.25),
    wind_speed_10m: pick("wind_speed_10m", i, 3),
    wind_direction_10m: pick("wind_direction_10m", i, 270),
    wind_gusts_10m: pick("wind_gusts_10m", i, pick("wind_speed_10m", i, 3)),
    visibility: pick("visibility", i, 24000),
    precipitation: pick("precipitation", i, 0),
    weather_code: pick("weather_code", i, 2),
    is_day: pick("is_day", i, 1),
    cloud_cover: pick("cloud_cover", i, 0),
    cloud_cover_low: pick("cloud_cover_low", i, 0),
    cloud_cover_mid: pick("cloud_cover_mid", i, 0),
    cloud_cover_high: pick("cloud_cover_high", i, 0),
  });

  const at = (when: Date): Weather => {
    const ms = when.getTime();
    // The grid is exactly hourly, so the bracketing index is arithmetic rather
    // than a search.
    const step = stamps[1] - stamps[0];
    const raw = (ms - stamps[0]) / step;
    const i = Math.max(0, Math.min(stamps.length - 2, Math.floor(raw)));
    const f = Math.max(0, Math.min(1, raw - i));
    const a = sampleAt(i);
    const b = sampleAt(i + 1);

    const mix = (x: number, y: number) => x + (y - x) * f;
    const near = f < 0.5 ? a : b;

    const blended: OpenMeteoCurrent = {
      time: "",
      temperature_2m: mix(a.temperature_2m, b.temperature_2m),
      relative_humidity_2m: mix(a.relative_humidity_2m, b.relative_humidity_2m),
      dew_point_2m: mix(a.dew_point_2m, b.dew_point_2m),
      surface_pressure: mix(a.surface_pressure, b.surface_pressure),
      wind_speed_10m: mix(a.wind_speed_10m, b.wind_speed_10m),
      wind_direction_10m: lerpAngle(a.wind_direction_10m, b.wind_direction_10m, f),
      wind_gusts_10m: mix(a.wind_gusts_10m, b.wind_gusts_10m),
      visibility: mix(a.visibility, b.visibility),
      precipitation: mix(a.precipitation, b.precipitation),
      weather_code: near.weather_code,
      is_day: near.is_day,
      cloud_cover: mix(a.cloud_cover, b.cloud_cover),
      cloud_cover_low: mix(a.cloud_cover_low, b.cloud_cover_low),
      cloud_cover_mid: mix(a.cloud_cover_mid, b.cloud_cover_mid),
      cloud_cover_high: mix(a.cloud_cover_high, b.cloud_cover_high),
    };
    return composeWeather(blended, when, "forecast");
  };

  return {
    timezone: j.timezone ?? "UTC",
    utcOffsetSeconds: j.utc_offset_seconds ?? 0,
    start: new Date(stamps[0]),
    end: new Date(stamps[stamps.length - 1]),
    at,
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
