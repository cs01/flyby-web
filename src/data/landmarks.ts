// The landmark bridges: where they are and how big, from surveys rather than
// from OSM's idea of a bridge.
//
// WHY THEY ARE HAND-BUILT. OSM describes a bridge as a road with `bridge=yes`
// on it, plus, if somebody was thorough, a few `building:part`s for the towers.
// Drawn from that, the Golden Gate was two grey extrusions and a stripe, and
// the Bay Bridge a flat ribbon with a box on it: the tags carry where a bridge
// goes and nothing of what makes it that bridge. So the structure is modelled
// here by hand, parametrically, from published dimensions, and placed at the
// surveyed positions of its towers. Pure data and pure maths, no THREE and no
// DOM, so test/bridge.check.ts can hold every number to its source under Bun.
//
// WHAT OSM STILL DECIDES. Where the road is. Every structure here is anchored
// on OSM nodes (the tower `building:part`s and `bridge:support=pylon` ways,
// queried 2026-10-24 and listed per bridge below) and the roads that cross it
// are the pack's own ways, so traffic, the ribbon and the steel are one thing.
// The check measures how far each tower sits from its road.
//
// WHAT THIS FILE DECIDES. Three things the rest of the app reads:
//
//   * a PIN (data/bridgedeck.ts) giving the real roadway height over a span, so
//     the ribbon and the cars ride at 75 m over the Golden Gate instead of on a
//     chord between two hillsides;
//   * a DENSIFY step, so a 3.2 km way with three vertices can follow a deck's
//     vertical curve at all;
//   * a SUPPRESSION zone, so the OSM building parts a structure replaces are
//     not drawn through it.
//
// Sources for every figure are on the spec; reference photographs are listed
// in docs/bridges.md.

import type { Building } from "./citypack";
import { ROAD_BRIDGE, ROAD_TUNNEL, type Road } from "./roadpack";
import type { Origin } from "../geo";

export type BridgeFamily =
  | "goldengate"
  | "baywest"
  | "sas"
  | "skyway"
  | "brooklyn"
  | "manhattanbr"
  | "williamsburg"
  | "queensboro"
  | "bascule";

export interface LandmarkSpec {
  id: string;
  name: string;
  city: string;
  family: BridgeFamily;
  /**
   * The axis, as two surveyed points. `t` is metres along it from `a` toward
   * `b`, and every station below is a `t`. For a suspension bridge these are
   * its two main towers, so `t = 0` and `t = span` ARE the towers and the
   * span is measured rather than typed.
   */
  a: [number, number];
  b: [number, number];
  /**
   * The `t` range over which the deck is pinned to `profile`. Absent for a
   * bridge whose deck is just the road at street level (Chicago), where the
   * solve is already right.
   */
  zone?: [number, number];
  /** Half width of the pinned corridor and of the suppression zone, metres. */
  halfWidthM: number;
  /**
   * Upper roadway surface along the axis, as (t, metres above sea level).
   * Interpolated smoothly (Catmull-Rom) so a suspended deck has a vertical
   * curve rather than a polyline of kinks at the stations.
   */
  profile?: [number, number][];
  /** Per-layer offsets from the upper road, for double decks. A road whose
   *  layer is not listed rides the upper level. */
  layerDy?: { layer: number; dy: number }[];
  /** Per-class offsets, for a promenade raised over the roadway. */
  classDy?: { cls: number; dy: number }[];
  /**
   * `t` range where ordinary (non-tunnel) roads inside the corridor are really
   * on the structure and are promoted to bridge ways, so the deck solve
   * reaches them.
   */
  promote?: [number, number];
  /** `t` range where OSM buildings inside the corridor are replaced. */
  suppress?: [number, number];
  /** Surveyed supports between the axis ends (towers, anchorages), placed on
   *  the axis at load as `Landmark.stationT`. */
  stations?: [number, number][];
  /** Free parameters the mesh builder reads, all in metres unless named. */
  p: Record<string, number>;
  /** Base colour, linear-ish sRGB hex as published or photographed. */
  colour: string;
  sources: string[];
}

/** Where a spec landed in the world. */
export interface Landmark {
  spec: LandmarkSpec;
  /** World position of `a` (y = 0). */
  ox: number;
  oz: number;
  /** Unit vector along the axis, and its lateral to the right of travel. */
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  /** |b - a| in metres. */
  lengthM: number;
  /** `spec.stations` projected onto the axis, metres. */
  stationT: number[];
}

// ---------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------

const GG_SOURCES = [
  "Golden Gate Bridge Highway & Transportation District, Design & Construction Stats, goldengate.org/bridge/history-research/statistics-data/design-construction-stats/: main span 4,200 ft (1,280 m), side spans 1,125 ft (343 m), towers 746 ft (227 m) above water and 500 ft (152 m) above the roadway, legs 33 x 54 ft (10 x 16 m) at the base, main cable 36 3/8 in (0.92 m), suspenders every 50 ft (15.2 m), roadway 62 ft (19 m) between curbs, sidewalks 10 ft (3 m), overall width 90 ft (27 m), clearance 220 ft (67 m) at mean higher high water",
  "HAER CA-31 (Golden Gate Bridge): main cable sag 470 ft (143 m), cable spacing 90 ft (27.4 m), stiffening truss 25 ft (7.6 m) deep, Fort Point arch 320 ft (98 m)",
  "International Orange, the Bridge District's published approximation: CMYK 0/69/100/6, sRGB #C0362C",
  "OSM building:part ways for the tower legs (bases 21/74/123/162/195 m, tops 74/123/162/195/225 m), centroids 37.81402,-122.47790 (south) and 37.82550,-122.47924 (north)",
];

const BAY_SOURCES = [
  "Caltrans / Wikipedia, San Francisco-Oakland Bay Bridge: west span two main spans of 2,310 ft (704 m), towers 526 ft (160 m), clearance 220 ft (67 m), five lanes per deck, westbound upper and eastbound lower",
  "OSM bridge:support=pylon ways 432712476..432712479 (towers W2, W3, W5, W6, height=160) and 236374789 (Center Anchorage, height=67), queried 2026-10-24",
  "Caltrans, Self-Anchored Suspension Span: single tower 525 ft (160 m), main span 1,263 ft (385 m), back span 591 ft (180 m), clearance 190 ft (58 m); OSM way 237735191 (tower, height=160)",
];

const NY_SOURCES = {
  brooklyn: [
    "NYC DOT / Wikipedia, Brooklyn Bridge: main span 1,595.5 ft (486.3 m), side spans 930 ft (283.5 m), towers 276.5 ft (84.3 m) above high water, deck 85 ft (26 m) wide, clearance 135 ft (41 m), four main cables 15.75 in (0.40 m), elevated promenade",
    "OSM bridge:support=pylon ways 317352708 and 1255363983 (stone, height=82.9)",
  ],
  manhattanbr: [
    "NYC DOT / Wikipedia, Manhattan Bridge: main span 1,470 ft (448 m), side spans 725 ft (221 m), towers 336 ft (102 m), clearance 135 ft (41 m), two decks, four cables",
    "OSM ways 317352033 and 1255353996 (pylon, steel, height=102, colour=#8eb4d2)",
  ],
  williamsburg: [
    "NYC DOT / Wikipedia, Williamsburg Bridge: main span 1,600 ft (488 m), side spans 596 ft (182 m) on trusses, towers 335 ft (102 m) above water, clearance 135 ft (41 m), stiffening truss 40 ft (12 m) deep",
    "OSM ways 1016434034 and 1016434035 (pylon, metal, height=94)",
  ],
  queensboro: [
    "NYC DOT / Wikipedia, Queensboro Bridge: cantilever spans 1,182 ft (360 m) and 984 ft (300 m), Roosevelt Island span 630 ft (192 m), clearance 135 ft (41 m), two decks",
    "OSM ways 1016487159, 1016487155, 1016487154, 1016487157 (pylon, metal, height=110)",
  ],
};

const CHI_SOURCES = [
  "Chicago Department of Transportation / Historic American Engineering Record IL-150 et seq.: Chicago-type trunnion bascules, main stem spans 210 to 260 ft (64 to 79 m) between trunnions, DuSable (Michigan Avenue) bridge 1920, double deck, four limestone bridge houses",
  "OSM man_made=bridge outlines and bridge:movable=bascule ways along the main stem, queried 2026-10-24",
];

/** A Chicago main-stem bascule. Its deck is the street, so no pin. */
function bascule(
  id: string,
  name: string,
  centre: [number, number],
  p: Record<string, number> = {},
  colour = "#3E4A47",
): LandmarkSpec {
  // The axis runs north-south across the river through the bridge's centre;
  // the mesh builder snaps it onto the pack's own way at load (see snapAxis).
  return {
    id, name, city: "chicago", family: "bascule",
    a: [centre[0] - 0.0004, centre[1]], b: [centre[0] + 0.0004, centre[1]],
    halfWidthM: 14,
    p: { spanM: 74, widthM: 20, houses: 2, upperTruss: 0, ...p },
    colour,
    sources: CHI_SOURCES,
  };
}

export const LANDMARKS: LandmarkSpec[] = [
  {
    id: "goldengate",
    name: "Golden Gate Bridge",
    city: "sf",
    family: "goldengate",
    a: [37.81402, -122.47790],
    b: [37.82550, -122.47924],
    // Pinned from the south anchorage to the north one. Past those the
    // approaches are viaducts the solve ramps down to the toll plaza and to
    // Vista Point.
    zone: [-343, 1623],
    halfWidthM: 22,
    // 227 m tower tops less 152 m to the road puts the road at 75 m at the
    // towers; 67 m clearance under a 7.6 m truss puts it at ~75.5 m at
    // mid-span, a gentle crown. The side spans fall 1.3 % to the anchorages.
    profile: [[-343, 70.6], [0, 75.0], [640, 75.8], [1280, 75.0], [1623, 70.6]],
    suppress: [-400, 1680],
    p: {
      towerTopM: 227, saddleM: 225.5, legHalfSpacingM: 13.7, sagM: 143,
      sideSpanM: 343, suspenderM: 15.24, trussDepthM: 7.6, deckWidthM: 27.4,
      roadWidthM: 19, cableR: 0.46, pierTopM: 21, fortPointArchM: 98,
    },
    colour: "#C0362C",
    sources: GG_SOURCES,
  },
  {
    id: "baywest",
    name: "San Francisco-Oakland Bay Bridge, west span",
    city: "sf",
    family: "baywest",
    // W2 to W6, the two outer towers of the twin suspension spans.
    a: [37.79075, -122.38582],
    b: [37.80562, -122.36990],
    // From the Rincon Hill anchorage pier to the Yerba Buena tunnel portals at
    // t = 2650. Pinned right up to the portals because the DEM there (33.6 m,
    // a 30 m posting of a cliff) is not where the decks go in: solved against
    // it, the lower deck dropped 26 m in its last 120 m.
    zone: [-345, 2655],
    // The last 120 m of the lower deck before the tunnel is mapped as plain
    // road (ways 37632/37635), but it is on the structure, not on the hill.
    promote: [2440, 2655],
    halfWidthM: 22,
    // Upper deck (westbound). Clearance 67 m under the LOWER deck's steel at
    // mid-span, so the lower road is ~68.5 m there and the upper one 9.5 m
    // above it; the decks fall toward the towers and anchorages.
    profile: [
      [-345, 66.5], [0, 74.0], [352, 78.0], [704, 74.0], [1083, 72.5],
      [1461, 74.0], [1813, 78.0], [2166, 74.0], [2470, 70.0], [2655, 68.5],
    ],
    // Upper deck is layer 2 in the pack; the lower deck and the plain-road
    // stretch of it promoted at Yerba Buena are layers 1 and 0.
    layerDy: [{ layer: 1, dy: -9.5 }, { layer: 0, dy: -9.5 }],
    suppress: [-360, 2500],
    // W3, the centre anchorage and W5, from OSM: the two spans are not quite
    // symmetric about the anchorage (W5 sits 50 m further out than W3).
    stations: [[37.79559, -122.3808], [37.79819, -122.37786], [37.80079, -122.37508]],
    p: {
      towerTopM: 160, saddleM: 158, legHalfSpacingM: 14.5, sagM: 74,
      sideSpanM: 354, suspenderM: 15.24, trussDepthM: 9.5, deckWidthM: 20,
      cableR: 0.36,
    },
    colour: "#9EA6AC",
    sources: BAY_SOURCES,
  },
  {
    id: "sas",
    name: "San Francisco-Oakland Bay Bridge, self-anchored span",
    city: "sf",
    family: "sas",
    // From the Yerba Buena end of the suspended deck to pier E2, where the
    // skyway starts. Measured on the pack's eastbound way: 565 m, against the
    // published 385 + 180 m.
    a: [37.81441, -122.36034],
    b: [37.81745, -122.35509],
    zone: [0, 565],
    halfWidthM: 40,
    // 58 m clearance under a 5.5 m box girder; falling east to the skyway.
    profile: [[0, 64.5], [185, 64.0], [565, 60.0]],
    suppress: [-20, 585],
    p: { towerT: 185, towerTopM: 160, deckGapM: 16, deckWidthM: 25, cableR: 0.39 },
    colour: "#E8E8E2",
    sources: BAY_SOURCES,
  },
  {
    id: "skyway",
    name: "San Francisco-Oakland Bay Bridge, skyway",
    city: "sf",
    family: "skyway",
    // E2 to where the pack's radius clips the skyway, 2.0 km on.
    a: [37.81745, -122.35509],
    b: [37.82176, -122.33209],
    zone: [0, 2080],
    halfWidthM: 40,
    // Falling from the SAS toward the Oakland touchdown, ~3.2 km from E2.
    profile: [[0, 60.0], [1000, 45.0], [2080, 29.0]],
    p: { pierSpacingM: 160, girderDepthM: 5.5 },
    colour: "#B9B5AC",
    sources: BAY_SOURCES,
  },
  {
    id: "brooklyn",
    name: "Brooklyn Bridge",
    city: "manhattan",
    family: "brooklyn",
    a: [40.70410, -73.99435],
    b: [40.70727, -73.99833],
    zone: [-284, 770],
    halfWidthM: 18,
    // Road ~38 m through the tower arches, cresting near 43 m (41 m clearance
    // under the 5 m deck) at mid-span, down to ~31 m over the anchorages.
    profile: [[-284, 31.0], [0, 38.0], [243, 43.0], [486, 38.0], [770, 31.0]],
    // The promenade rides 5.5 m over the roadways (its ways are layer 4).
    layerDy: [{ layer: 4, dy: 5.5 }],
    suppress: [-300, 790],
    p: {
      towerTopM: 84.3, towerWidthM: 41, towerDepthM: 18, archTopM: 66, archWidthM: 10.2,
      sagM: 39, sideSpanM: 284, cableR: 0.2, deckWidthM: 26, suspenderM: 2.3, stayEveryM: 4.6,
      anchorageTopM: 31,
    },
    colour: "#B7A78A",
    sources: NY_SOURCES.brooklyn,
  },
  {
    id: "manhattanbr",
    name: "Manhattan Bridge",
    city: "manhattan",
    family: "manhattanbr",
    a: [40.70512, -73.98944],
    b: [40.70881, -73.99149],
    zone: [-222, 670],
    halfWidthM: 22,
    profile: [[-222, 39.0], [0, 46.5], [224, 49.0], [448, 46.5], [670, 39.0]],
    layerDy: [{ layer: 1, dy: -7.5 }],
    suppress: [-240, 690],
    p: { towerTopM: 102, legHalfSpacingM: 14, sagM: 45, sideSpanM: 222, cableR: 0.3, deckWidthM: 37, trussDepthM: 7.3, suspenderM: 6 },
    colour: "#8EB4D2",
    sources: NY_SOURCES.manhattanbr,
  },
  {
    id: "williamsburg",
    name: "Williamsburg Bridge",
    city: "manhattan",
    family: "williamsburg",
    a: [40.71439, -73.97482],
    b: [40.71276, -73.96946],
    zone: [-182, 670],
    halfWidthM: 22,
    profile: [[-182, 38.0], [0, 44.0], [244, 46.0], [488, 44.0], [670, 38.0]],
    suppress: [-200, 690],
    p: { towerTopM: 102, legHalfSpacingM: 15, sagM: 50, sideSpanM: 182, cableR: 0.3, deckWidthM: 36, trussDepthM: 12, suspenderM: 6 },
    colour: "#62686B",
    sources: NY_SOURCES.williamsburg,
  },
  {
    id: "queensboro",
    name: "Queensboro Bridge",
    city: "manhattan",
    family: "queensboro",
    // Manhattan pier to Queens pier; Roosevelt Island's two piers between.
    a: [40.75888, -73.95913],
    b: [40.75507, -73.95036],
    zone: [-140, 990],
    halfWidthM: 22,
    profile: [[-140, 40.0], [0, 44.0], [180, 46.0], [360, 44.0], [552, 44.0], [702, 46.0], [852, 44.0], [990, 40.0]],
    // The upper level carries layer 3 in the pack, the lower layers 1 and 2.
    layerDy: [{ layer: 2, dy: -8.5 }, { layer: 1, dy: -8.5 }],
    suppress: [-160, 1010],
    p: { pier1T: 360, pier2T: 552, pierTopM: 110, trussWidthM: 30, armM: 140 },
    colour: "#BCA98A",
    sources: NY_SOURCES.queensboro,
  },
  bascule("chi-columbus", "Columbus Drive Bridge", [41.88857, -87.62058], { spanM: 82, widthM: 33, houses: 2 }, "#4A5355"),
  bascule("chi-dusable", "DuSable Bridge (Michigan Avenue)", [41.88885, -87.62439], { spanM: 78, widthM: 28, houses: 4, doubleDeck: 1 }, "#6B3530"),
  bascule("chi-wabash", "Irv Kupcinet Bridge (Wabash Avenue)", [41.88789, -87.62686], { spanM: 82, widthM: 22, houses: 2 }),
  bascule("chi-state", "Bataan-Corregidor Memorial Bridge (State Street)", [41.88754, -87.62802], { spanM: 64, widthM: 22, houses: 2 }),
  bascule("chi-dearborn", "Dearborn Street Bridge", [41.8875, -87.62954], { spanM: 64, widthM: 20, houses: 2 }),
  bascule("chi-clark", "Clark Street Bridge", [41.88748, -87.63103], { spanM: 66, widthM: 20, houses: 2 }),
  bascule("chi-lasalle", "Marshall Suloway Bridge (LaSalle Street)", [41.88749, -87.63251], { spanM: 64, widthM: 22, houses: 2 }),
  bascule("chi-wells", "Wells Street Bridge", [41.88753, -87.63399], { spanM: 82, widthM: 22, houses: 2, upperTruss: 1 }, "#3B4F46"),
  bascule("chi-franklin", "Franklin-Orleans Street Bridge", [41.88737, -87.63581], { spanM: 74, widthM: 20, houses: 2 }),
];

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export function landmarksFor(cityId: string, origin: Origin): Landmark[] {
  return LANDMARKS.filter((s) => s.city === cityId).map((spec) => placeLandmark(spec, origin));
}

export function placeLandmark(spec: LandmarkSpec, origin: Origin): Landmark {
  const a = origin.toWorld(spec.a[0], spec.a[1]);
  const b = origin.toWorld(spec.b[0], spec.b[1]);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  // Right of travel in a y-up world with z south: (-uz, ux) turned the other
  // way. Only its consistency matters; nothing here is handed.
  const stationT = (spec.stations ?? []).map(([lat, lon]) => {
    const p = origin.toWorld(lat, lon);
    return (p.x - a.x) * ux + (p.z - a.z) * uz;
  });
  return { spec, ox: a.x, oz: a.z, ux, uz, vx: -uz, vz: ux, lengthM: len, stationT };
}

/**
 * Turn each axis-less landmark (a bascule, placed by its centre) onto the
 * bridge way nearest its centre, so its leaves lie along the street. Chicago's
 * river is not straight and neither are its crossings: Franklin-Orleans meets
 * it 14 m off a north-south line.
 */
export function snapLandmarkAxes(ls: Landmark[], roads: readonly Road[]): void {
  for (const l of ls) {
    if (l.spec.zone) continue;
    const cx = l.ox + l.ux * l.lengthM * 0.5;
    const cz = l.oz + l.uz * l.lengthM * 0.5;
    let best = Infinity;
    let dir: [number, number] | null = null;
    for (const r of roads) {
      if ((r.flags & ROAD_BRIDGE) === 0) continue;
      const p = r.pts;
      for (let k = 2; k < p.length; k += 2) {
        const ax = p[k - 2], az = p[k - 1], bx = p[k], bz = p[k + 1];
        const dx = bx - ax, dz = bz - az;
        const L2 = dx * dx + dz * dz;
        if (L2 < 25) continue;
        const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / L2));
        const d = Math.hypot(ax + dx * t - cx, az + dz * t - cz);
        if (d < best) { best = d; const L = Math.sqrt(L2); dir = [dx / L, dz / L]; }
      }
    }
    if (!dir || best > 25) continue;
    // Keep the axis pointing the way it did, so `a` stays the south bank.
    if (dir[0] * l.ux + dir[1] * l.uz < 0) dir = [-dir[0], -dir[1]];
    l.ux = dir[0];
    l.uz = dir[1];
    l.vx = -dir[1];
    l.vz = dir[0];
    l.ox = cx - l.ux * l.lengthM * 0.5;
    l.oz = cz - l.uz * l.lengthM * 0.5;
  }
}

/** Axis coordinates of a world point: `t` along, `s` lateral. */
export function axisOf(l: Landmark, x: number, z: number): { t: number; s: number } {
  const dx = x - l.ox;
  const dz = z - l.oz;
  return { t: dx * l.ux + dz * l.uz, s: dx * l.vx + dz * l.vz };
}

/** World point at axis coordinates. */
export function worldAt(l: Landmark, t: number, s: number): { x: number; z: number } {
  return { x: l.ox + l.ux * t + l.vx * s, z: l.oz + l.uz * t + l.vz * s };
}

/**
 * The upper roadway at `t`, metres above sea level.
 *
 * Catmull-Rom through the stations, clamped flat past either end. Smooth
 * because a ribbon densified to 20 m shows every kink a polyline profile
 * would put in it, and a suspended deck has none.
 */
export function profileY(spec: LandmarkSpec, t: number): number {
  const p = spec.profile;
  if (!p || p.length === 0) return 0;
  if (t <= p[0][0]) return p[0][1];
  const n = p.length;
  if (t >= p[n - 1][0]) return p[n - 1][1];
  let i = 0;
  while (i < n - 2 && t > p[i + 1][0]) i++;
  const p0 = p[Math.max(0, i - 1)];
  const p1 = p[i];
  const p2 = p[i + 1];
  const p3 = p[Math.min(n - 1, i + 2)];
  const u = (t - p1[0]) / (p2[0] - p1[0]);
  // Tangents scaled to each interval so uneven station spacing does not
  // overshoot: the finite difference across the neighbours, in y per metre,
  // times this interval's length.
  const span = p2[0] - p1[0];
  const m1 = ((p2[1] - p0[1]) / Math.max(1e-6, p2[0] - p0[0])) * span;
  const m2 = ((p3[1] - p1[1]) / Math.max(1e-6, p3[0] - p1[0])) * span;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2;
}

/** Offset of this road's level from the upper roadway. */
export function levelDy(spec: LandmarkSpec, road: { layer: number; cls: number }): number {
  for (const c of spec.classDy ?? []) if (c.cls === road.cls) return c.dy;
  for (const l of spec.layerDy ?? []) if (l.layer === road.layer) return l.dy;
  return 0;
}

function inZone(l: Landmark, t: number, s: number): boolean {
  const z = l.spec.zone;
  return !!z && t >= z[0] && t <= z[1] && Math.abs(s) <= l.spec.halfWidthM;
}

/**
 * The deck pin for data/bridgedeck.ts: the surveyed roadway wherever a bridge
 * way lies inside a landmark's corridor, null everywhere else.
 */
/** Inside the corridor a landmark claims: its pinned zone, or for a bridge
 *  with no pin (a Chicago bascule) the stretch between its axis points. */
function inCorridor(l: Landmark, t: number, s: number): boolean {
  if (l.spec.zone) return inZone(l, t, s);
  return t >= -20 && t <= l.lengthM + 20 && Math.abs(s) <= l.spec.halfWidthM;
}

/**
 * True when `road` RUNS ALONG this landmark rather than merely crossing its
 * corridor.
 *
 * Crossing is not enough: the FDR Drive passes under the Brooklyn Bridge
 * inside its corridor, and pinning it lifted it 32 m onto the bridge deck.
 */
export function landmarkOwnsRoad(l: Landmark, road: Road): boolean {
  let first = -1;
  let last = -1;
  const p = road.pts;
  for (let k = 0; k < p.length; k += 2) {
    const { t, s } = axisOf(l, p[k], p[k + 1]);
    if (inCorridor(l, t, s)) { if (first < 0) first = k; last = k; }
  }
  if (first < 0) return false;
  // A way with one vertex in the corridor is judged by its segments into it.
  const a = first === last ? Math.max(0, first - 2) : first;
  const b = first === last ? Math.min(p.length - 2, first + 2) : last;
  const dx = p[b] - p[a];
  const dz = p[b + 1] - p[a + 1];
  const len = Math.hypot(dx, dz);
  // cos 25 degrees: a ramp peeling off the deck still counts, a street
  // crossing underneath at any real angle does not.
  return len > 1e-3 && Math.abs(dx * l.ux + dz * l.uz) / len > 0.9;
}

/**
 * The deck pin for data/bridgedeck.ts: the surveyed roadway wherever a bridge
 * way that runs along a landmark lies inside its corridor, null everywhere
 * else.
 */
export function landmarkDeckPin(ls: readonly Landmark[]): (x: number, z: number, road: Road) => number | null {
  const pinned = ls.filter((l) => l.spec.zone && l.spec.profile);
  const owner = new WeakMap<Road, Landmark | null>();
  const ownerOf = (road: Road): Landmark | null => {
    let o = owner.get(road);
    if (o === undefined) {
      o = pinned.find((l) => landmarkOwnsRoad(l, road)) ?? null;
      owner.set(road, o);
    }
    return o;
  };
  return (x, z, road) => {
    if ((road.flags & ROAD_BRIDGE) === 0) return null;
    const l = ownerOf(road);
    if (!l) return null;
    const { t, s } = axisOf(l, x, z);
    return inZone(l, t, s) ? profileY(l.spec, t) + levelDy(l.spec, road) : null;
  };
}

/**
 * Insert vertices into every bridge way that crosses a pinned corridor, at
 * most `stepM` apart inside it.
 *
 * The Bay Bridge west span is one 3,187 m way with THREE vertices. The ribbon
 * is linear between vertices, so however right the pin is at those three
 * points the deck in between is a chord, 4 m under the crest of each span.
 * New vertices are collinear with the old ones, so nothing that reads the
 * way's plan changes; only a deck now has somewhere to bend.
 *
 * Returns how many vertices it added.
 */
export function densifyLandmarkWays(roads: Road[], ls: readonly Landmark[], stepM = 20): number {
  const pinned = ls.filter((l) => l.spec.zone && l.spec.profile);
  if (!pinned.length) return 0;
  let added = 0;
  const inAny = (x: number, z: number): boolean =>
    pinned.some((l) => {
      const { t, s } = axisOf(l, x, z);
      return inZone(l, t, s);
    });
  for (const r of roads) {
    if ((r.flags & ROAD_BRIDGE) === 0) continue;
    const p = r.pts;
    let touches = false;
    for (let k = 0; k < p.length && !touches; k += 2) touches = inAny(p[k], p[k + 1]);
    // A long segment can cross a corridor with both ends outside it.
    for (let k = 2; k < p.length && !touches; k += 2) {
      touches = inAny((p[k] + p[k - 2]) * 0.5, (p[k + 1] + p[k - 1]) * 0.5);
    }
    if (!touches) continue;
    const out: number[] = [p[0], p[1]];
    for (let k = 2; k < p.length; k += 2) {
      const ax = p[k - 2], az = p[k - 1], bx = p[k], bz = p[k + 1];
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / stepM);
      for (let j = 1; j < n; j++) {
        out.push(ax + ((bx - ax) * j) / n, az + ((bz - az) * j) / n);
        added++;
      }
      out.push(bx, bz);
    }
    r.pts = Float32Array.from(out);
  }
  return added;
}

/**
 * Mark the roads a spec's `promote` range covers as bridge ways. Returns how
 * many it changed. Run before anything builds a graph or a deck.
 */
export function promoteLandmarkApproaches(roads: Road[], ls: readonly Landmark[]): number {
  let n = 0;
  for (const l of ls) {
    const pr = l.spec.promote;
    if (!pr) continue;
    for (const r of roads) {
      if ((r.flags & (ROAD_BRIDGE | ROAD_TUNNEL)) !== 0) continue;
      let all = true;
      for (let k = 0; k < r.pts.length && all; k += 2) {
        const { t, s } = axisOf(l, r.pts[k], r.pts[k + 1]);
        all = t >= pr[0] && t <= pr[1] && Math.abs(s) <= l.spec.halfWidthM;
      }
      if (all) { r.flags |= ROAD_BRIDGE; n++; }
    }
  }
  return n;
}

/**
 * True when a hand-built structure stands where this OSM building does.
 *
 * Only what is tall or off the ground: the tower legs, struts and saddles
 * (the Golden Gate's are 24 parts a tower). A low building with its base on
 * the ground in the corridor is something the bridge stands over, and Fort
 * Point is exactly that, 9 m tall under the south arch.
 */
export function landmarkSuppresses(ls: readonly Landmark[], b: Building): boolean {
  if (b.topM - b.baseM < 30 && b.baseM <= 0) return false;
  for (const l of ls) {
    const z = l.spec.suppress;
    if (!z) continue;
    const { t, s } = axisOf(l, b.cx, b.cz);
    if (t >= z[0] && t <= z[1] && Math.abs(s) <= l.spec.halfWidthM + 6) return true;
  }
  return false;
}
