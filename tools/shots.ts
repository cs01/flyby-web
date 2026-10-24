// Fixed-pose screenshots, so a change to the renderer can be judged instead of
// argued about.
//
// The problem this solves: "does the city look better now" is not answerable by
// flying around, because no two flights ever put the lens in the same place, at
// the same time of day, under the same weather, at the same render scale. Every
// one of those is pinned here through query parameters the app reads
// (`?cam=`, `?t=`, `?wx=`, `?scale=`, `?shot`), so the ONLY thing that differs
// between a before and an after set is the code.
//
// Determinism comes from four places and all four are needed:
//   * `?cam=` overrides the flight model, so nothing integrates.
//   * `?t=` freezes the scene clock, so the sun does not move.
//   * `?wx=` pins the cloud decks, so today's weather is not in the picture.
//   * `?scale=` pins the adaptive resolution controller, which would otherwise
//     react to frame time and quietly change the resolution under you.
//
// The animation clock is held at zero in `?shot` mode for the same reason.
//
// Tile data is cached in a PERSISTENT Chrome profile. The first run of a pose
// downloads its DEM and imagery; every run after that reads IndexedDB, which is
// both much faster and the thing that makes two runs agree -- a re-fetched
// imagery tile can come back from a different server in the CDN pool.
//
//   bun tools/shots.ts --out shots/before
//   bun tools/shots.ts --out shots/after --only chicago-loop-night
//   bun tools/shots.ts --out shots/repeat --repeat      (determinism check)

import { mkdirSync, writeFileSync } from "node:fs";
import { Cdp } from "./cdp";

const WIDTH = 1280;
const HEIGHT = 720;

/** Clear sky, every deck at zero. Weather is not what is under test here. */
const CLEAR = "low:0:900:2100,mid:0:3800:5000,high:0:8500:9400,precip:0";

export interface Pose {
  name: string;
  /** A curated city id, or "" when the pose flies a bare coordinate. */
  city: string;
  /**
   * `lat,lon` for a place with no curated entry, written to `?at=`.
   *
   * The whole point of the live path is that a place needs no entry in
   * src/cities.ts to have buildings, so the harness has to be able to point at
   * one that has none. `?at=` outranks `?city=` in main.ts, the same way the
   * geolocation card writes it.
   */
  at?: string;
  /** Metres AMSL, not above ground: a terrain lookup would move the shot. */
  lat: number;
  lon: number;
  altM: number;
  hdgDeg: number;
  pitchDeg: number;
  /** Unix seconds. */
  t: number;
  wx: string;
  what: string;
  /**
   * An extra condition to wait for before capturing, as a JS expression.
   *
   * A pose over an unbaked place is not worth a screenshot until something has
   * actually streamed in: the frame counter says the renderer is running, not
   * that the city has arrived. Without this the harness would faithfully
   * capture an empty field and report it as the live path working.
   */
  waitFor?: { expr: string; timeoutMs: number; why: string };
}

const D = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

export const POSES: Pose[] = [
  {
    name: "sf-vanness",
    city: "sf",
    // Van Ness Avenue at Pine, looking north up the avenue toward Russian Hill.
    lat: 37.7885, lon: -122.4222, altM: 105, hdgDeg: 5, pitchDeg: -3,
    t: D("2025-06-22T02:10:00Z"), // 19:10 PDT: low evening sun across the facades
    wx: CLEAR,
    what: "SF low over Van Ness, evening sun",
  },
  {
    name: "manhattan-7th",
    city: "manhattan",
    // Seventh Avenue in the thirties, looking south down the canyon.
    lat: 40.7530, lon: -73.9905, altM: 65, hdgDeg: 209, pitchDeg: 7,
    t: D("2025-06-21T15:00:00Z"), // 11:00 EDT: high sun, one wall lit one not
    wx: CLEAR,
    what: "Manhattan in the 7th Ave canyon, late morning",
  },
  {
    name: "chicago-loop-night",
    city: "chicago",
    // Over the river north of the Loop, looking south into it.
    lat: 41.8935, lon: -87.6290, altM: 420, hdgDeg: 178, pitchDeg: -9,
    t: D("2025-06-21T03:30:00Z"), // 22:30 CDT: night, and the city still awake
    wx: CLEAR,
    what: "Chicago Loop at night",
  },
  {
    name: "sf-residential",
    city: "sf",
    // Pacific Heights and the Marina: block after block of three-storey
    // Victorians, which is the case a facade model gets wrong by repeating.
    lat: 37.7955, lon: -122.4340, altM: 175, hdgDeg: 285, pitchDeg: -14,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT
    wx: CLEAR,
    what: "SF residential district by day",
  },
  {
    name: "manhattan-rooftops",
    city: "manhattan",
    // Chelsea rooftops, low and shallow: the roofs fill the lower frame.
    lat: 40.7455, lon: -73.9975, altM: 95, hdgDeg: 60, pitchDeg: -11,
    t: D("2025-06-21T21:40:00Z"), // 17:40 EDT: raking light across the roofs
    wx: CLEAR,
    what: "Manhattan rooftop-level pass",
  },
  {
    name: "chicago-loop-late",
    city: "chicago",
    // The same viewpoint at half past midnight: the hour the old per-cell hash
    // looked worst, and the one the owner was looking at.
    lat: 41.8935, lon: -87.6290, altM: 420, hdgDeg: 178, pitchDeg: -9,
    t: D("2025-06-21T05:30:00Z"), // 00:30 CDT
    wx: CLEAR,
    what: "Chicago Loop, half past midnight",
  },
  {
    name: "emeraldhills-canopy",
    city: "emeraldhills",
    // Over Emerald Lake looking west at the wooded ridge behind Cañada College.
    // WorldCover measures this box at 55.1% tree, the highest of any city here,
    // and no other pose covers it: it is the vegetation case, and before the
    // trees existed it rendered as bare hillside under a green drape.
    lat: 37.4650, lon: -122.2650, altM: 340, hdgDeg: 250, pitchDeg: -8,
    t: D("2025-06-22T01:30:00Z"), // 18:30 PDT: raking light down the ridge
    wx: CLEAR,
    what: "Emerald Hills wooded ridge, evening",
  },
  {
    name: "emeraldhills-treetops",
    city: "emeraldhills",
    // Fifty-five metres over the wooded ridge, looking south-west at ground
    // that rises to Cañada College. Every other pose here is 300 m or higher,
    // where a whole tree is a dozen pixels and a canopy is a texture; this is
    // the only frame in the set where an individual crown is big enough to
    // judge its silhouette, its shading and its colour separately. Ground is
    // 209 m AMSL at this point (measured through terrain.heightAt), so the
    // altitude below is deliberately AGL-derived even though the field is AMSL.
    lat: 37.4630, lon: -122.2760, altM: 264, hdgDeg: 215, pitchDeg: -6,
    t: D("2025-06-22T01:30:00Z"), // 18:30 PDT, the same raking light as the ridge pose
    wx: CLEAR,
    what: "Emerald Hills treetops, 55 m above the canopy",
  },
  {
    name: "sf-street",
    city: "sf",
    // Van Ness Avenue at Pine, from the driver's seat, looking north up the
    // avenue: the same view as `sf-vanness` above from 48 m, taken from 2 m.
    //
    // Ground here measures 56.78 m AMSL through terrain.heightAt, and the field
    // below is AMSL, so 58.8 m is the carriageway plus about two metres. This
    // is the only pose in the set at eye height, and it is the one that says
    // what the ground, the kerb line and the near facades look like from a car
    // rather than from the air.
    lat: 37.7885, lon: -122.4222, altM: 58.8, hdgDeg: 5, pitchDeg: -2,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT: the noon case, not the hero hour
    wx: CLEAR,
    what: "SF street level on Van Ness, two metres up",
  },
  {
    // Van Ness again, from the same two metres as `sf-street` but looking SOUTH
    // down the avenue instead of north across the junction.
    //
    // `sf-street` is the regression check for near-field ground and it stays
    // exactly where it is; what it is not is a picture of a street, because the
    // building on the corner fills half of it and everything beyond is the far
    // side of a wide crossroads. This one points down the carriageway: the kerb
    // line, the columns, the parked row and the traffic are all in it, and it
    // is the pose to put `?nostreet` against.
    name: "sf-van-ness-kerb",
    city: "sf",
    lat: 37.7885, lon: -122.4222, altM: 58.8, hdgDeg: 185, pitchDeg: -3,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT, the same clock as sf-street
    wx: CLEAR,
    what: "SF down Van Ness from the kerb, two metres up",
  },
  {
    // A PARKED CAR, FROM SIX METRES, AT THE HEIGHT OF ITS ROOF.
    //
    // This pose exists because a car's wheels were invisible in every other
    // pose in this file and nobody could tell. `sf-street` and
    // `sf-van-ness-kerb` both look ALONG a carriageway across a raised
    // pavement, which hides the bottom third of every vehicle beyond it, so a
    // mesh whose wheels stood one centimetre proud of a solid flank -- no arch,
    // nothing to see -- photographed identically to one with real arches. A
    // pose set that cannot see the thing being worked on is a pose set that
    // reports every version of it as fine.
    //
    // Computed rather than eyeballed: addParked over the committed sf pack puts
    // a saloon at 37.788502,-122.422147 facing 189 degrees, and this stands on
    // the carriageway 6.5 m off its road-facing flank. 58.4 m AMSL is 1.6 m
    // over a road that measures 56.8 m, which is a person's eye and not a
    // camera on a tripod.
    name: "sf-parked-car",
    city: "sf",
    lat: 37.788447, lon: -122.422169, altM: 58.4, hdgDeg: 17, pitchDeg: -6,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT, the same clock as sf-street
    wx: CLEAR,
    what: "a parked saloon on Van Ness from six metres",
  },
  {
    // SF FROM ALTITUDE, WHICH IS WHERE THE GROUND COLOUR GOES WRONG.
    //
    // Every other San Francisco pose is at 48 m or below, and the landcover
    // tint is a wash over the whole landmass: at street level you are inside
    // one class of it and cannot see that the city is the wrong colour. From
    // 1,100 m the peninsula is in one frame, and a cast over all of it is
    // obvious and measurable. Reported from the app as "a strange green look".
    name: "sf-peninsula",
    city: "sf",
    lat: 37.7620, lon: -122.4400, altM: 1100, hdgDeg: 20, pitchDeg: -22,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT, the same clock as the others
    wx: CLEAR,
    what: "the San Francisco peninsula from 1,100 m",
  },
  {
    // STRAIGHT DOWN OVER A KNOWN TILE. A calibration pose, not a picture.
    //
    // "Is the ground the right colour" cannot be answered from an oblique
    // frame: what you sample is a mix of neighbourhoods at a mix of distances,
    // and comparing that against a source tile is comparing two different
    // places. Looking down from 900 m puts one patch of ground in the middle
    // of the frame, and the Esri tile covering it can be fetched and measured
    // directly, so the drape has an oracle instead of an opinion.
    //
    // 37.762,-122.440 is the Sunset: dense low residential with no water, no
    // park and no downtown towers in it, which is what makes it a usable
    // reference rather than a picture of one bright thing.
    name: "sf-nadir",
    city: "sf",
    lat: 37.7620, lon: -122.4400, altM: 900, hdgDeg: 0, pitchDeg: -89,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT, the same clock as the others
    wx: CLEAR,
    what: "straight down over the Sunset, for drape colour",
  },
  {
    // CENTRAL PARK FROM A FOOTPATH, which is the only place in the set where
    // grass fills the frame.
    //
    // Every other ground-level pose is on a carriageway between buildings, so
    // the vegetation material was never once photographed at the range it
    // exists for -- and from two metres the drape is a satellite photo at
    // several metres a pixel, which is a smear of green and orange blobs a
    // metre across. That is what this watches.
    name: "central-park-path",
    city: "manhattan",
    lat: 40.7712, lon: -73.9740, altM: 34, hdgDeg: 340, pitchDeg: -6,
    t: D("2025-06-21T15:00:00Z"), // 11:00 EDT
    wx: CLEAR,
    what: "Central Park from a path, two metres up",
  },
  {
    // MANHATTAN UNDER A DECK, PITCHED DOWN, WHICH IS WHERE THE SKY BREAKS.
    //
    // Every other pose either has a clear sky or looks level, and the cloud
    // march is only wrong at a GRAZING elevation: its step size grows with
    // distance, so a ray a few degrees above the horizon runs out of its step
    // budget a few hundred metres into a deck that is a kilometre thick, and
    // the transmittance it never spent shows through as bare lit horizon under
    // an overcast. Nose down at 700 m puts the horizon in the top fifth of the
    // frame, so every visible pixel of sky is inside six degrees of it -- which
    // is the whole of the failure and none of the rest of the sky.
    //
    // 48% at 1494 m is the reported weather from the report this came from, not
    // a number chosen to break it.
    name: "manhattan-overcast-horizon",
    city: "manhattan",
    lat: 40.7580, lon: -73.9855, altM: 709, hdgDeg: 190, pitchDeg: -7,
    t: D("2025-06-21T17:20:00Z"), // 13:20 EDT
    wx: "low:0.48:1494:2466,mid:0:3800:5000,high:0:8500:9400,precip:0",
    what: "Manhattan nose-down under a low deck, for the horizon band",
  },
  {
    // THE SHADOWED CITY, from altitude. Over the Upper East Side looking down
    // the island with the evening sun 15 degrees up and square off the right
    // wing, so every shadow falls across the view rather than behind its
    // tower. 800 m up and 30 degrees nose-down puts ground in frame from 0.9 km
    // to the horizon: both cascade edges (1.4 km on a phone, 6 km on a
    // desktop) and the 2 to 5 km annulus tools/verify-shadow.ts measures.
    // Before the city-wide map, shadows here ended in a circle at the last
    // cascade and the rest of Midtown stood in full sun.
    name: "manhattan-high-shadow",
    city: "manhattan",
    lat: 40.7780, lon: -73.9520, altM: 900, hdgDeg: 200, pitchDeg: -45,
    t: D("2025-06-21T23:00:00Z"), // 19:00 EDT: sun 14.7 degrees up at 288
    wx: CLEAR,
    what: "Manhattan from 900 m, low evening sun, across the phone's cascade edge",
  },
  {
    name: "manhattan-higher-shadow",
    city: "manhattan",
    lat: 40.7780, lon: -73.9520, altM: 3500, hdgDeg: 200, pitchDeg: -45,
    t: D("2025-06-21T23:00:00Z"),
    wx: CLEAR,
    what: "Manhattan from 3.5 km, low evening sun, across the desktop's cascade edge",
  },
  {
    // THE GOLDEN GATE DECK, from the Marin side at deck height.
    //
    // The one pose where a bridge fills the frame. Every other San Francisco
    // pose is in the city, where a bridge is a stripe in the distance and an
    // abutment step of six metres is invisible; here the deck runs away from
    // the camera for two kilometres and both its ends are in shot.
    name: "sf-golden-gate",
    city: "sf",
    lat: 37.8210, lon: -122.4930, altM: 210, hdgDeg: 95, pitchDeg: -6,
    t: D("2025-06-21T18:00:00Z"), // 11:00 PDT
    wx: CLEAR,
    what: "the Golden Gate broadside, deck and towers in one frame",
  },
  // THE LANDMARK BRIDGES, one near pose (300 m off, 80 m up) and one far pose
  // (2 km) each, so render/bridges.ts can be judged at the range that shows
  // suspenders and railings and at the range that shows only towers and cables.
  {
    name: "bridge-gg-near",
    city: "sf",
    lat: 37.81676, lon: -122.48160, altM: 80, hdgDeg: 85, pitchDeg: -1.0,
    t: D("2025-06-21T23:00:00Z"), // 16:00 PDT: the westerly sun on the bay faces
    wx: CLEAR,
    what: "the Golden Gate south of mid-span from 300 m on the ocean side, at deck height: suspenders, truss, railings",
  },
  {
    name: "bridge-gg-far",
    city: "sf",
    lat: 37.81361, lon: -122.49997, altM: 160, hdgDeg: 70, pitchDeg: -2.0,
    t: D("2025-06-21T23:00:00Z"), // 16:00 PDT: the westerly sun on the bay faces
    wx: CLEAR,
    what: "the Golden Gate from 2 km out on the ocean side: both towers, the cables, the deck",
  },
  {
    name: "bridge-gg-night",
    city: "sf",
    lat: 37.81361, lon: -122.49997, altM: 160, hdgDeg: 70, pitchDeg: -2.0,
    t: D("2025-06-22T05:30:00Z"), // 22:30 PDT
    wx: CLEAR,
    what: "the Golden Gate at night: aviation lights on the towers, the deck lit",
  },
  {
    name: "bridge-baywest-near",
    city: "sf",
    lat: 37.80270, lon: -122.37749, altM: 80, hdgDeg: 135, pitchDeg: -1.0,
    t: D("2025-06-21T23:00:00Z"), // 16:00 PDT: the westerly sun on the bay faces
    wx: CLEAR,
    what: "the Bay Bridge west span at tower W5 from 300 m: double deck, cables, bracing",
  },
  {
    name: "bridge-baywest-far",
    city: "sf",
    lat: 37.80975, lon: -122.39530, altM: 160, hdgDeg: 130, pitchDeg: -2.3,
    t: D("2025-06-21T23:00:00Z"), // 16:00 PDT: the westerly sun on the bay faces
    wx: CLEAR,
    what: "the Bay Bridge west span from 2 km: both suspension spans and the centre anchorage",
  },
  {
    name: "bridge-sas-near",
    city: "sf",
    lat: 37.81761, lon: -122.36022, altM: 80, hdgDeg: 150, pitchDeg: -1.9,
    t: D("2025-06-21T23:00:00Z"), // 16:00 PDT: the westerly sun on the bay faces
    wx: CLEAR,
    what: "the Bay Bridge self-anchored span from 300 m: the white tower and the single cable",
  },
  {
    name: "bridge-sas-far",
    city: "sf",
    lat: 37.82978, lon: -122.36964, altM: 160, hdgDeg: 140, pitchDeg: -2.6,
    t: D("2025-06-21T23:00:00Z"), // 16:00 PDT: the westerly sun on the bay faces
    wx: CLEAR,
    what: "the Bay Bridge east span from 2 km: Yerba Buena, the SAS tower and the skyway",
  },
  {
    name: "bridge-brooklyn-near",
    city: "manhattan",
    lat: 40.70388, lon: -73.99898, altM: 80, hdgDeg: 48, pitchDeg: -7.6,
    t: D("2025-06-21T21:00:00Z"), // 17:00 EDT
    wx: CLEAR,
    what: "the Brooklyn Bridge from 300 m: granite towers, cables and the stay web",
  },
  {
    name: "bridge-brooklyn-far",
    city: "manhattan",
    lat: 40.69096, lon: -74.00995, altM: 160, hdgDeg: 35, pitchDeg: -3.4,
    t: D("2025-06-21T21:00:00Z"), // 17:00 EDT
    wx: CLEAR,
    what: "the Brooklyn and Manhattan bridges from 2 km down the East River",
  },
  {
    name: "bridge-manhattanbr-near",
    city: "manhattan",
    lat: 40.70605, lon: -73.99381, altM: 80, hdgDeg: 70, pitchDeg: -6.7,
    t: D("2025-06-21T21:00:00Z"), // 17:00 EDT
    wx: CLEAR,
    what: "the Manhattan Bridge from 300 m: steel towers and the two decks",
  },
  {
    name: "bridge-williamsburg-near",
    city: "manhattan",
    lat: 40.71108, lon: -73.97347, altM: 80, hdgDeg: 22, pitchDeg: -6.7,
    t: D("2025-06-21T21:00:00Z"), // 17:00 EDT
    wx: CLEAR,
    what: "the Williamsburg Bridge from 300 m: lattice towers and the truss",
  },
  {
    name: "bridge-queensboro-near",
    city: "manhattan",
    lat: 40.75450, lon: -73.95622, altM: 80, hdgDeg: 30, pitchDeg: -6.7,
    t: D("2025-06-21T21:00:00Z"), // 17:00 EDT
    wx: CLEAR,
    what: "the Queensboro Bridge from 300 m: the cantilever truss over Roosevelt Island",
  },
  {
    name: "bridge-queensboro-far",
    city: "manhattan",
    lat: 40.74211, lon: -73.96806, altM: 160, hdgDeg: 35, pitchDeg: -3.3,
    t: D("2025-06-21T21:00:00Z"), // 17:00 EDT
    wx: CLEAR,
    what: "the Queensboro Bridge from 2 km up the East River",
  },
  {
    name: "bridge-chicago-dusable-near",
    city: "chicago",
    // Chicago's river is at 177 m above sea level, and altM is AMSL.
    lat: 41.88885, lon: -87.62077, altM: 257, hdgDeg: 270, pitchDeg: -14.0,
    t: D("2025-06-21T14:00:00Z"), // 09:00 CDT: the morning sun straight down the river from the lake
    wx: CLEAR,
    what: "the DuSable (Michigan Avenue) bridge from 300 m east: bascule leaves and bridge houses",
  },
  {
    name: "bridge-chicago-river-far",
    city: "chicago",
    lat: 41.88850, lon: -87.60010, altM: 330, hdgDeg: 270, pitchDeg: -4.5,
    t: D("2025-06-21T14:00:00Z"), // 09:00 CDT: the morning sun straight down the river from the lake
    wx: CLEAR,
    what: "the main stem of the Chicago River from 2 km: the run of bascule bridges",
  },
  {
    name: "chicago-lasalle-kerb",
    city: "chicago",
    // LaSalle Street between Madison and Monroe, from the kerb, looking north up
    // the canyon: forty-storey walls on both sides of a 24 m street.
    //
    // THE POSE THE STREET BOUNCE NEEDS, and the reason it exists is that no
    // other frame in this set can see the defect. sf-street is a wide avenue in
    // full sun, so a carriageway there is lit by the beam and a bounce term is
    // correctly worth nothing; manhattan-7th is pointed at facades and has
    // almost no road in frame. A shadowed canyon floor under lit walls is the
    // one case where the bounce is most of the light, and it is what a user
    // reported as "the street is super dark, even in daytime".
    //
    // Ground is 179 m AMSL here and the field below is AMSL, so this is the
    // carriageway plus about two metres.
    lat: 41.8810, lon: -87.6325, altM: 190, hdgDeg: 2, pitchDeg: -1,
    t: D("2025-06-21T16:39:00Z"), // 11:39 CDT, the hour in the report: high sun,
                                  // and the canyon floor still in shadow
    wx: CLEAR,
    what: "Chicago LaSalle Street canyon from the kerb, late morning",
  },
  {
    name: "chicago-loop-day",
    city: "chicago",
    // The same Loop as the night pose, in daylight: the pair isolates what is
    // a lighting change and what is a material change.
    lat: 41.8935, lon: -87.6290, altM: 420, hdgDeg: 178, pitchDeg: -9,
    t: D("2025-06-21T16:00:00Z"), // 11:00 CDT
    wx: CLEAR,
    what: "Chicago Loop by day",
  },
  {
    // THE CHICAGO RIVER FROM THE KERB, LOOKING ALONG IT.
    //
    // Reported from the app: at street level beside the main branch the river
    // was a single flat blown-out slab, the same value from one bank to the
    // other. Every other water pose in this set is AERIAL, and from 420 m the
    // view vector barely changes across the surface, so a water model with one
    // normal for the whole river photographs almost correctly. It is only from
    // a kerb, looking ALONG the water at a grazing angle, that the flat normal
    // shows: the Fresnel factor pins near 1 over the entire visible surface and
    // there is nothing left to vary.
    //
    // The parapet at the Michigan Avenue bridge, looking west up the main
    // branch past Wabash and State toward Wolf Point. The river surface is Lake
    // Michigan's, 176 m AMSL, and the field below is AMSL, so this is the
    // fourteen metres from the water to the upper deck: a person on the bridge,
    // not a camera in the air. Pitch is shallow on purpose, because it is the
    // GRAZING part of the surface this pose exists to photograph -- and it is
    // enough to put the river across 39.5% of the frame, measured by
    // tools/verify-water.ts through the terrainDebug=7 water mask.
    name: "chicago-river-kerb",
    city: "chicago",
    lat: 41.8888, lon: -87.6248, altM: 190, hdgDeg: 261, pitchDeg: -7,
    t: D("2025-06-21T23:00:00Z"), // 18:00 CDT: low sun down the river, which is
                                  // when a glitter path exists to be got wrong
    wx: CLEAR,
    what: "the Chicago river from the kerb, two metres up",
  },
  {
    // Sydney, over the harbour with the bridge and the Opera House ahead.
    //
    // The only pose where water is most of the frame, which is deliberate: the
    // harbour is where a flat grey sea is least forgivable, and it is the
    // regression check for anything that touches the water term.
    name: "sydney-harbour",
    city: "sydney",
    lat: -33.8640, lon: 151.2100, altM: 420, hdgDeg: 28, pitchDeg: -10,
    t: D("2025-11-15T23:10:00Z"), // 10:10 AEDT
    wx: CLEAR,
    what: "Sydney over the harbour",
  },
  {
    // San Francisco Bay on a summer afternoon: the westerly that blows in
    // through the Gate most days, pinned at 11 m/s (Beaufort 6), low over the
    // water off Aquatic Park looking west into a low sun.
    //
    // The sea-state pose. Every other water pose runs the harness's 4 m/s,
    // where by design nothing breaks, so whitecaps, the glow through a
    // backlit crest and a wind-driven glitter path have no frame without it.
    name: "sf-bay-windy",
    city: "sf",
    lat: 37.8125, lon: -122.4300, altM: 60, hdgDeg: 275, pitchDeg: -9,
    t: D("2025-06-22T01:00:00Z"), // 18:00 PDT: sun low in the west
    wx: `${CLEAR},wind:11:265`,
    what: "SF bay in an afternoon westerly",
  },
  {
    // Hong Kong, over Victoria Harbour looking at the Central towers.
    //
    // The densest vertical city in the set and the one with the most glass, so
    // it is the pose that will show a facade-material or reflection change
    // first. Steep terrain right behind the towers, which nothing else here
    // has: a skyline against a mountain rather than against sky.
    name: "hongkong-central",
    city: "hongkong",
    lat: 22.2960, lon: 114.1660, altM: 500, hdgDeg: 205, pitchDeg: -12,
    t: D("2025-11-15T08:30:00Z"), // 16:30 HKT, low sun on the towers
    wx: CLEAR,
    what: "Hong Kong over Victoria Harbour",
  },
  {
    // Paris, over the Seine looking east toward the Ile de la Cite.
    //
    // The best-mapped city in the set and the one with the most to lose from a
    // bad facade rule: 181,205 footprints averaging 11.8 vertices each, 46% of
    // them with ten or more corners, and 73.7% carrying a real height (almost
    // all from building:levels, which for uniform-storey Haussmann blocks is
    // close to exact). If a change makes courtyard blocks read wrong, it shows
    // here first.
    name: "paris-seine",
    city: "paris",
    lat: 48.8520, lon: 2.3320, altM: 330, hdgDeg: 72, pitchDeg: -11,
    t: D("2025-09-21T16:20:00Z"), // 18:20 CEST, low sun down the river
    wx: CLEAR,
    what: "Paris over the Seine",
  },
  {
    // THE MARIN HEADLANDS FROM 120 M OVER THE RIDGE, looking north-west along
    // the coast toward Point Bonita: chaparral, grass, bare cut slopes and sea
    // cliffs, with no buildings and no canopy to hide the ground. The ground
    // material case: every other low pose is a city or a park lawn.
    //
    // 7.5 km from the SF scene centre on purpose, past the 6 km ring, the
    // near landcover level and the trees: this is the ground that rendered as
    // flat facets under a smear (see the 10 km ring in render/budget.ts).
    name: "marin-headlands",
    city: "sf",
    lat: 37.8270, lon: -122.4930, altM: 330, hdgDeg: 285, pitchDeg: -14,
    t: D("2025-06-21T18:00:00Z"), // 11:00 PDT, the Golden Gate pose's clock
    wx: CLEAR,
    what: "the Marin Headlands from just over the ridge",
  },
  {
    // OCEAN BEACH TO LANDS END, from 60 m off the surf line looking north
    // along the sand to the Cliff House and the cliffs behind it: the one
    // frame in the set with a beach and a sea cliff in it. Both are past the
    // near landcover level (8.8 km from the scene centre), which is the case
    // the far-level shore and cliff rules in render/terrain.ts exist for.
    name: "sf-ocean-beach",
    city: "sf",
    lat: 37.7640, lon: -122.5150, altM: 60, hdgDeg: 12, pitchDeg: -8,
    t: D("2025-06-21T22:00:00Z"), // 15:00 PDT, sun over the sea
    wx: CLEAR,
    what: "Ocean Beach and the Lands End cliffs from just off the surf",
  },
  {
    // Mount Fuji, from the north with the cone filling the frame.
    //
    // A terrain pose, deliberately: every other pose in this set is a city, so
    // nothing here would catch a regression in the heightfield, the ring plan
    // or the aerial perspective over open country. The cone is also the most
    // unforgiving subject for the imagery ring seams, which is how the 6000 m
    // step from zoom 15 to zoom 13 was found: it drew a sharpness boundary
    // straight across the mountain until the city centre was moved in to 4 km.
    name: "fuji-cone",
    city: "fuji",
    lat: 35.4340, lon: 138.7290, altM: 1500, hdgDeg: 183, pitchDeg: -7,
    t: D("2025-10-12T21:30:00Z"), // 06:30 JST, low sun raking the flank
    wx: CLEAR,
    what: "Mount Fuji from the north",
  },
  {
    // Santa Rosa, California. Nobody has baked this and nobody is going to:
    // the point is that a place with no pack now has buildings, roads and
    // trees, fetched from OpenStreetMap while the aeroplane is in the air.
    //
    // Low and looking north up Santa Rosa Avenue into the downtown blocks, in
    // late afternoon sun so the boxes have a readable light side and a shadow
    // side rather than the flat noon wash the roadmap warns about.
    name: "santa-rosa-live",
    city: "",
    at: "38.4405,-122.7141",
    lat: 38.4330, lon: -122.7145, altM: 260, hdgDeg: 2, pitchDeg: -6,
    t: D("2025-06-22T01:40:00Z"), // 18:40 PDT
    wx: CLEAR,
    what: "Santa Rosa CA, no baked pack, streamed live from OSM",
    // The scheduler running dry, not the first tile landing: a frame captured
    // as soon as something appears is a picture of one square of a city, and
    // would look identical however much more had been on its way.
    waitFor: {
      expr: "window.flybyShot.liveBuildings > 500 && window.flybyShot.liveIdle",
      timeoutMs: 420_000,
      why: "the live OSM scheduler to run dry",
    },
  },
  ...cloudPoses(),
];

/**
 * The sky poses: each cloud regime over Manhattan and San Francisco, plus the
 * four frames tools/verify-clouds.ts measures. Every deck is pinned with
 * `?wx=`, so these are pictures of a cloud model and not of today's weather.
 */
function cloudPoses(): Pose[] {
  const none = "mid:0:3800:5000,high:0:8500:9400,precip:0";
  const cumulus = `low:0.3:1400:2300,${none}`;
  const out: Pose[] = [];
  const sites = [
    {
      city: "manhattan",
      morning: { lat: 40.7040, lon: -74.0170, hdg: 10, t: D("2025-06-21T12:30:00Z") }, // 08:30 EDT
      golden: { lat: 40.7600, lon: -73.9700, hdg: 290, t: D("2025-06-21T23:45:00Z") }, // 19:45 EDT, sun ~6 deg up at 297
      noon: { lat: 40.7000, lon: -74.0200, hdg: 30, t: D("2025-06-21T17:00:00Z") },
    },
    {
      city: "sf",
      morning: { lat: 37.8000, lon: -122.4650, hdg: 110, t: D("2025-06-21T15:30:00Z") }, // 08:30 PDT, toward the sun
      golden: { lat: 37.7900, lon: -122.4000, hdg: 285, t: D("2025-06-22T02:50:00Z") }, // 19:50 PDT
      noon: { lat: 37.7600, lon: -122.4200, hdg: 0, t: D("2025-06-21T19:30:00Z") },
    },
  ];
  for (const s of sites) {
    const c = s.city;
    out.push(
      {
        name: `clouds-${c}-cumulus-morning`, city: c,
        lat: s.morning.lat, lon: s.morning.lon, altM: 500, hdgDeg: s.morning.hdg, pitchDeg: 8,
        t: s.morning.t, wx: cumulus, what: `${c}: fair-weather cumulus, morning`,
      },
      {
        name: `clouds-${c}-cumulus-golden`, city: c,
        lat: s.golden.lat, lon: s.golden.lon, altM: 450, hdgDeg: s.golden.hdg, pitchDeg: 5,
        t: s.golden.t, wx: cumulus, what: `${c}: fair-weather cumulus, golden hour into the sun`,
      },
      {
        name: `clouds-${c}-stratocumulus`, city: c,
        lat: s.noon.lat, lon: s.noon.lon, altM: 400, hdgDeg: s.noon.hdg, pitchDeg: 6,
        t: s.noon.t, wx: `low:0.7:1000:1900,${none}`, what: `${c}: broken stratocumulus`,
      },
      {
        name: `clouds-${c}-overcast`, city: c,
        lat: s.noon.lat, lon: s.noon.lon, altM: 380, hdgDeg: s.noon.hdg, pitchDeg: 4,
        t: s.noon.t, wx: `low:0.97:750:2100,${none}`, what: `${c}: overcast stratus deck`,
      },
      {
        name: `clouds-${c}-incloud`, city: c,
        lat: s.noon.lat, lon: s.noon.lon, altM: 1450, hdgDeg: s.noon.hdg, pitchDeg: 0,
        t: s.noon.t, wx: `low:0.85:1000:2000,${none}`, what: `${c}: flying inside the low deck`,
      },
    );
  }
  // The gate frames. Midtown at 13:00 EDT, sun high, so the measurements are
  // about the cloud field and not about a sunset.
  const gate = { city: "manhattan", lat: 40.7580, lon: -73.9855, t: D("2025-06-21T17:00:00Z") };
  out.push(
    { ...gate, name: "clouds-gate-up30", altM: 600, hdgDeg: 0, pitchDeg: 30, wx: cumulus,
      what: "gate: fair-weather cumulus at 30 degrees up, for clustering" },
    { ...gate, name: "clouds-gate-cover20", altM: 600, hdgDeg: 90, pitchDeg: 45,
      wx: `low:0.2:1400:2300,${none}`, what: "gate: 20% low cover" },
    { ...gate, name: "clouds-gate-cover80", altM: 600, hdgDeg: 90, pitchDeg: 45,
      wx: `low:0.8:1400:2300,${none}`, what: "gate: 80% low cover" },
    { ...gate, name: "clouds-gate-side", altM: 500, hdgDeg: 0, pitchDeg: 3, wx: cumulus,
      what: "gate: cumulus bases side-on, for the flat base" },
  );
  return out;
}

/** Extra query parameters appended to every pose, e.g. `--query terrainDebug=3`. */
let extraQuery = "";

function url(base: string, p: Pose): string {
  const q = new URLSearchParams({
    ...(p.at ? { at: p.at } : { city: p.city }),
    cam: `${p.lat},${p.lon},${p.altM},${p.hdgDeg},${p.pitchDeg}`,
    t: String(p.t),
    wx: p.wx,
    scale: "1",
    shot: "1",
    // The forecast timeline is a network fetch whose only job here would be to
    // be overridden by `?wx`, and the landmark discovery calls Wikipedia. Both
    // are left alone: they cannot change a pixel, and blocking them would be
    // one more way the harness stops resembling the app.
  });
  return `${base}/?${q.toString()}${extraQuery ? "&" + extraQuery : ""}`;
}

interface Shot {
  pose: Pose;
  file: string;
  frameMs: { mean: number; p99: number };
  triangles: number;
  trees: number;
  shrubs: number;
  treeLods: number[];
  treeTriangles: number;
  lod: number;
  pavementTriangles: number;
  /** The street: columns, moving cars, parked cars, and what they cost. */
  lamps: number;
  lampsMeasured: number;
  cars: number;
  parkedCars: number;
  streetTriangles: number;
  streetClipped: number;
  /** Times the detail ring restitched before the frame was taken. */
  drapeMoves: number;
  signature: number[];
  /**
   * The camera that drew the frame, so a measurement can put a pixel back in
   * the world: position, matrixWorld and projectionMatrixInverse, column-major.
   * Null for a build from before the page exposed `window.flyby`.
   */
  view: { pos: number[]; world: number[]; projInv: number[] } | null;
}

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** Log lines that mean the frame about to be captured is not worth capturing. */
const FATAL = [/Shader Error/i, /not compiled/i, /program not valid/i, /Uncaught/i];

async function capture(cdp: Cdp, base: string, p: Pose, outDir: string, tag: string): Promise<Shot | null> {
  cdp.problems.length = 0;
  await cdp.goto(url(base, p));
  // Two waits, not one. The first is the load (tiles, packs, shader compiles),
  // which can be a minute cold and a second warm. The second lets the frame
  // settle: the first few frames after the loop starts still have textures
  // uploading and the sun shadow cascades filling in.
  await cdp.waitFor("window.flybyShot", 240_000, `${p.name} to load`);
  await cdp.waitFor("window.flybyShot.frames > 60", 60_000, `${p.name} to settle`);
  // A street-level pose recentres the detail drape onto itself, asynchronously.
  // Capturing before that lands photographs the drape it is about to replace,
  // which is both the wrong picture and not reproducible between runs.
  // `!== true` rather than `=== false` on purpose: a build from before the
  // detail ring existed has no such field, and this harness has to be able to
  // capture the BEFORE half of a before/after pair.
  await cdp.waitFor(
    "window.flybyShot.drapePending !== true",
    120_000,
    `${p.name} detail drape`,
  );

  // A live-fetched pose additionally waits on its own condition: streamed
  // tiles arrive over the network, so there is nothing to photograph until the
  // scheduler says the ground is populated.
  //
  // That wait is allowed to FAIL without taking the run with it. Overpass is
  // volunteer infrastructure and has been refusing this machine's connections
  // for hours at a time; a pose that depends on a third party being up must not
  // be able to stop the other nine from being captured. It is skipped loudly
  // and counted, never skipped quietly, because a harness that silently drops a
  // pose reports a clean run over a hole.
  if (p.waitFor) {
    try {
      await cdp.waitFor(p.waitFor.expr, p.waitFor.timeoutMs, p.waitFor.why);
    } catch {
      console.log(
        `SKIP ${p.name.padEnd(24)} ${p.waitFor.why} never happened; ` +
          `the source it needs is unreachable from here`,
      );
      return null;
    }
  }

  await cdp.eval("window.flybyShot.resetTiming()");
  await cdp.waitFor("window.flybyShot.timed > 240", 60_000, `${p.name} timing sample`);
  const frameMs = await cdp.eval<{ mean: number; p99: number }>("window.flybyShot.frameMs()");
  const triangles = await cdp.eval<number>("window.flybyShot.triangles");
  const trees = await cdp.eval<number>("window.flybyShot.trees ?? 0");
  const shrubs = await cdp.eval<number>("window.flybyShot.shrubs ?? 0");
  const treeLods = await cdp.eval<number[]>("window.flybyShot.treeLods ?? []");
  const treeTriangles = await cdp.eval<number>("window.flybyShot.treeTriangles ?? 0");
  const lod = await cdp.eval<number>("window.flybyShot.lod");
  const pavementTriangles = await cdp.eval<number>("window.flybyShot.pavementTriangles ?? 0");
  const lamps = await cdp.eval<number>("window.flybyShot.lamps ?? 0");
  const lampsMeasured = await cdp.eval<number>("window.flybyShot.lampsMeasured ?? 0");
  const cars = await cdp.eval<number>("window.flybyShot.cars ?? 0");
  const parkedCars = await cdp.eval<number>("window.flybyShot.parkedCars ?? 0");
  const streetTriangles = await cdp.eval<number>("window.flybyShot.streetTriangles ?? 0");
  const streetClipped = await cdp.eval<number>("window.flybyShot.streetClipped ?? 0");
  const drapeMoves = await cdp.eval<number>("window.flybyShot.drapeMoves ?? 0");
  const signature = await cdp.eval<number[]>("window.flybyShot.signature(48)");
  const view = await cdp.eval<Shot["view"]>(
    "(() => { const c = window.flyby && window.flyby.camera; return c ? " +
      "{ pos: c.position.toArray(), world: c.matrixWorld.elements.slice(), " +
      "projInv: c.projectionMatrixInverse.elements.slice() } : null; })()",
  );

  const bad = cdp.problems.filter((m) => FATAL.some((r) => r.test(m)));
  if (bad.length) {
    throw new Error(`${p.name}: the page is broken, refusing to screenshot it\n  ${bad[0]}`);
  }

  const dataUrl = await cdp.eval<string>("window.flybyShot.capture()");
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const file = `${outDir}/${p.name}${tag}.png`;
  writeFileSync(file, png);

  return {
    pose: p, file, frameMs, triangles, trees, shrubs, treeLods, treeTriangles, lod,
    pavementTriangles, lamps, lampsMeasured, cars, parkedCars, streetTriangles,
    streetClipped, drapeMoves, signature, view,
  };
}

/** Mean absolute channel difference between two frame fingerprints, 0..255. */
function signatureDiff(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots")!;
  const only = arg("only");
  const port = Number(arg("port", "5177"));
  const debugPort = Number(arg("debug-port", "9411"));
  const profileDir = arg("profile", "/tmp/flyby-shots-profile")!;
  const repeat = has("repeat");
  extraQuery = arg("query", "") ?? "";

  mkdirSync(outDir, { recursive: true });
  const poses = only ? POSES.filter((p) => only.split(",").includes(p.name)) : POSES;
  if (!poses.length) throw new Error(`no pose matches --only ${only}`);

  // Refuse to run if something else already holds the port.
  //
  // vite exits on a --strictPort collision, and the harness then happily
  // screenshots whatever ELSE is serving there and reports plausible numbers
  // for the wrong build. That is the worst possible failure for a tool whose
  // entire job is before/after comparison: it does not error, it lies. It has
  // already cost one bogus before/after pair, when another worktree's dev
  // server was holding the default port.
  try {
    const probe = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    throw new Error(
      `port ${port} is already serving (HTTP ${probe.status}). Something else is ` +
        `running there, and screenshotting it would silently measure the wrong ` +
        `build. Use --port with a free port, or stop the other server.`,
    );
  } catch (err) {
    // A connection failure is the GOOD case: nothing is listening.
    if (err instanceof Error && err.message.startsWith(`port ${port} is already`)) throw err;
  }

  const vite = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      // Still starting.
    }
    await Bun.sleep(100);
  }

  const cdp = await Cdp.launch({
    port: debugPort,
    width: WIDTH,
    height: HEIGHT,
    profileDir,
    uncapped: true,
  });

  const shots: Shot[] = [];
  let skipped = 0;
  try {
    for (const p of poses) {
      const s = await capture(cdp, base, p, outDir, "");
      // A skipped pose is already reported by capture. Counting it here keeps
      // the summary honest about how many of the set actually landed.
      if (!s) {
        skipped++;
        continue;
      }
      shots.push(s);
      console.log(
        `${s.file.padEnd(44)} ${s.frameMs.mean.toFixed(2)} ms mean  ${s.frameMs.p99.toFixed(2)} p99  ` +
        `${(s.triangles / 1000).toFixed(0)}k tris  lod ${s.lod}  drape ${s.drapeMoves}  ` +
        `pave ${(s.pavementTriangles / 1000).toFixed(0)}k  ` +
        `trees ${s.trees} (${s.treeLods.join("/")}) ${(s.treeTriangles / 1000).toFixed(0)}k tris  ` +
        `shrubs ${s.shrubs}  ` +
        `street ${s.lamps} lamps (${s.lampsMeasured} surveyed) ${s.cars} moving ` +
        `${s.parkedCars} parked ${(s.streetTriangles / 1000).toFixed(0)}k tris` +
        (s.streetClipped ? `  CLIPPED ${s.streetClipped}` : ""),
      );
      if (repeat) {
        const again = await capture(cdp, base, p, outDir, "-repeat");
        // A pose that skipped once can skip again; there is nothing to compare.
        if (!again) continue;
        const a = Bun.file(s.file);
        const b = Bun.file(again.file);
        const identical = Buffer.from(await a.arrayBuffer()).equals(
          Buffer.from(await b.arrayBuffer()),
        );
        const diff = signatureDiff(s.signature, again.signature);
        console.log(
          `  repeat: ${identical ? "BYTE-IDENTICAL" : "differs"}, ` +
          `fingerprint delta ${diff.toFixed(3)}/255`,
        );
      }
    }
  } finally {
    cdp.close();
    vite.kill();
  }

  writeFileSync(
    `${outDir}/shots.json`,
    JSON.stringify(
      shots.map((s) => ({
        name: s.pose.name,
        what: s.pose.what,
        file: s.file,
        frameMs: s.frameMs,
        triangles: s.triangles,
        trees: s.trees,
        shrubs: s.shrubs,
        treeLods: s.treeLods,
        treeTriangles: s.treeTriangles,
        lod: s.lod,
        pavementTriangles: s.pavementTriangles,
        lamps: s.lamps,
        lampsMeasured: s.lampsMeasured,
        cars: s.cars,
        parkedCars: s.parkedCars,
        streetTriangles: s.streetTriangles,
        streetClipped: s.streetClipped,
        drapeMoves: s.drapeMoves,
        view: s.view,
      })),
      null,
      2,
    ),
  );
  console.log(
    `\n${shots.length} pose(s) -> ${outDir}` +
      (skipped ? `, ${skipped} SKIPPED for an unreachable source` : ""),
  );
}

await main();
