// Airports to watch from: a drone parked beside the runway in use, looking
// down it, with the live traffic taxiing out and taking off in front of you.
//
// Runway ends are OurAirports' (public domain, davidmegginson.github.io/
// ourairports-data/runways.csv, fetched 2026-10-24), main runways only.
// Which end is in use comes from the wind: aircraft take off and land into
// it, so the active end is the one whose heading is closest to where the
// wind is coming FROM. That is the rule a tower applies first, and it is
// right far more often than any guess that ignores the weather.

export interface RunwayEnd {
  id: string;
  lat: number;
  lon: number;
}

export interface Airport {
  id: string;
  icao: string;
  name: string;
  /** The listed city whose sky it shares, for the menu. */
  city: string;
  /**
   * The baked city a spot loads into. Its land pack's coarse level reaches
   * 70 km, which is what keeps a runway at 2 m above sea level from being
   * drawn as water: a flight centred on the airport itself has no land pack
   * and the sea-level heuristic floods LaGuardia.
   */
  cityId: string;
  lat: number;
  lon: number;
  /** Each runway as its two thresholds. */
  runways: [RunwayEnd, RunwayEnd][];
}

const rw = (a: string, alat: number, alon: number, b: string, blat: number, blon: number): [RunwayEnd, RunwayEnd] => [
  { id: a, lat: alat, lon: alon },
  { id: b, lat: blat, lon: blon },
];

export const AIRPORTS: Airport[] = [
  {
    id: "lga", cityId: "manhattan", icao: "KLGA", name: "LaGuardia", city: "New York", lat: 40.7769, lon: -73.874,
    runways: [
      rw("04", 40.76919937, -73.88410187, "22", 40.78540039, -73.87069702),
      rw("13", 40.78229904, -73.87850189, "31", 40.77209854, -73.85710144),
    ],
  },
  {
    id: "jfk", cityId: "manhattan", icao: "KJFK", name: "John F. Kennedy", city: "New York", lat: 40.6413, lon: -73.7781,
    runways: [
      rw("04L", 40.622002, -73.785599, "22R", 40.6488, -73.764702),
      rw("04R", 40.62540054, -73.77030182, "22L", 40.64519882, -73.75489808),
      rw("13L", 40.657799, -73.790199, "31R", 40.6437, -73.7593),
      rw("13R", 40.648399, -73.816704, "31L", 40.627899, -73.771599),
    ],
  },
  {
    id: "sfo", cityId: "sf", icao: "KSFO", name: "San Francisco International", city: "San Francisco", lat: 37.6189, lon: -122.375,
    runways: [
      rw("10L", 37.628742, -122.39341, "28R", 37.613538, -122.35716),
      rw("10R", 37.626298, -122.393124, "28L", 37.61172, -122.358367),
      rw("01L", 37.607898, -122.38295, "19R", 37.626476, -122.37063),
      rw("01R", 37.606333, -122.381061, "19L", 37.627346, -122.367124),
    ],
  },
  {
    id: "oak", cityId: "sf", icao: "KOAK", name: "Oakland", city: "San Francisco", lat: 37.7213, lon: -122.2208,
    runways: [
      rw("12", 37.71910095, -122.2409973, "30", 37.70149994, -122.2139969),
      rw("10R", 37.72869873, -122.22599792, "28L", 37.72230148, -122.20600128),
    ],
  },
  {
    id: "ord", cityId: "chicago", icao: "KORD", name: "O'Hare", city: "Chicago", lat: 41.9786, lon: -87.9048,
    runways: [
      rw("10C", 41.96569824, -87.9315033, "28C", 41.96569824, -87.89179993),
      rw("10L", 41.96900177, -87.93150329, "28R", 41.96910095, -87.8836975),
      rw("09R", 41.98389816, -87.91835022, "27L", 41.98389816, -87.88905334),
      rw("04R", 41.95330048, -87.8993988, "22L", 41.96989822, -87.87979889),
    ],
  },
  {
    id: "mdw", cityId: "chicago", icao: "KMDW", name: "Midway", city: "Chicago", lat: 41.7868, lon: -87.7522,
    runways: [
      rw("04R", 41.77920151, -87.75930023, "22L", 41.79199982, -87.74310303),
      rw("13L", 41.791599, -87.761101, "31R", 41.779202, -87.743698),
    ],
  },
];

export function airportById(id: string): Airport | undefined {
  return AIRPORTS.find((a) => a.id === id.toLowerCase());
}

const D2R = Math.PI / 180;

/** Initial compass bearing from a to b, degrees true. */
export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}

/** Signed smallest difference a - b in degrees. */
function angDiff(a: number, b: number): number {
  return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

export interface SpotPose {
  lat: number;
  lon: number;
  /** Height above the threshold, metres. */
  aglM: number;
  hdgDeg: number;
  pitchDeg: number;
  /** The runway end in use, e.g. "22". */
  runway: string;
  /** Its threshold and the far end, for sampling the runway's height. */
  threshold: RunwayEnd;
  far: RunwayEnd;
}

/** Metres to the right of the centreline: off the runway and its safety area. */
export const SPOT_SIDE_M = 110;
/** Hover height: low enough to look up at a departure, high enough to clear the fence. */
export const SPOT_AGL_M = 30;

/**
 * Where to hover to watch `a` with the wind from `windFromDeg`.
 *
 * Beside the threshold of the landing end, offset to the right of the
 * centreline (`side` -1 for the left) and looking down the runway: arrivals cross the threshold just
 * past your shoulder and touch down in front of you, and departures from the
 * same end roll out away from you and rotate in view.
 */
export function spotPose(a: Airport, windFromDeg: number, side: 1 | -1 = 1): SpotPose {
  let best: { from: RunwayEnd; to: RunwayEnd; hdg: number; score: number } | null = null;
  for (const [e1, e2] of a.runways) {
    for (const [from, to] of [[e1, e2], [e2, e1]] as const) {
      const hdg = bearingDeg(from, to);
      const score = Math.abs(angDiff(hdg, windFromDeg));
      // Ties (and calm wind, which callers pass as the prevailing direction)
      // go to the first runway listed, which is the airport's busiest.
      if (!best || score < best.score - 1) best = { from, to, hdg, score };
    }
  }
  const b = best!;
  const mLat = 111132.9;
  const mLon = 111412.8 * Math.cos(b.from.lat * D2R);
  const right = (b.hdg + 90 * side) * D2R;
  return {
    lat: b.from.lat + (Math.cos(right) * SPOT_SIDE_M) / mLat,
    lon: b.from.lon + (Math.sin(right) * SPOT_SIDE_M) / mLon,
    aglM: SPOT_AGL_M,
    // Angled 12 degrees in toward the centreline, so the runway runs across
    // the middle of the frame rather than up its right edge.
    hdgDeg: (b.hdg - 12 * side + 360) % 360,
    pitchDeg: -4,
    runway: b.from.id,
    threshold: b.from,
    far: b.to,
  };
}
