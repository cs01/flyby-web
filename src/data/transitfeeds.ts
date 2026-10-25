// The key-free GTFS-realtime feeds, per city, and where the browser reaches
// them.
//
// None of the upstreams sends CORS headers, so the app asks the same origin:
// chadsmith.dev proxies /flyby-feeds/... (deploy/nginx-flyby-feeds.conf) and
// the vite dev server does the same (vite.config.ts). The path is
// /flyby-feeds/<agency>/<feed>, which is what both proxies map.

export interface FeedSpec {
  /** File name in a fixture, and the stable id in diagnostics. */
  key: string;
  /** Same-origin path, absolute. */
  path: string;
  upstream: string;
  agency: "mta" | "bart" | "nycferry";
  /** Lines the feed carries, for the diagnostics line only. */
  what: string;
}

const MTA = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";

function mta(feed: string, what: string): FeedSpec {
  return { key: `mta-${feed}`, path: `/flyby-feeds/mta/${feed}`, upstream: `${MTA}${feed}`, agency: "mta", what };
}

export const FEEDS: Record<string, FeedSpec[]> = {
  // gtfs-si is left out: the Staten Island Railway never comes within the
  // 12 km the Manhattan pack keeps.
  manhattan: [
    mta("gtfs", "1 2 3 4 5 6 7 S"),
    mta("gtfs-ace", "A C E"),
    mta("gtfs-bdfm", "B D F M"),
    mta("gtfs-g", "G"),
    mta("gtfs-jz", "J Z"),
    mta("gtfs-nqrw", "N Q R W"),
    mta("gtfs-l", "L"),
    // Arrivals before positions: a position is matched to the arrivals
    // already held for its trip (data/transit.ts ingestBoat).
    {
      key: "nycferry-tripupdate", path: "/flyby-feeds/nycferry/tripupdate",
      upstream: "http://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx/tripupdate",
      agency: "nycferry", what: "NYC Ferry arrivals",
    },
    {
      key: "nycferry-vehicleposition", path: "/flyby-feeds/nycferry/vehicleposition",
      upstream: "http://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx/vehicleposition",
      agency: "nycferry", what: "NYC Ferry positions",
    },
  ],
  sf: [
    {
      key: "bart-tripupdate", path: "/flyby-feeds/bart/tripupdate",
      upstream: "https://api.bart.gov/gtfsrt/tripupdate.aspx",
      agency: "bart", what: "BART",
    },
  ],
};
