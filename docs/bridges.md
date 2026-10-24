# Landmark bridges

Hand-built, parametric, placed on surveyed OSM nodes. Specs and per-figure
sources: `src/data/landmarks.ts`. Geometry: `src/render/bridgemesh.ts`.
Rendering: `src/render/bridges.ts`. Gates: `test/bridge.check.ts`.

## What OSM decides and what the spec decides

OSM decides where the road is and where the towers stand: every axis is two
OSM tower nodes, and the gate measures each tower against the pack's own
bridge ways (worst 5.8 m, Williamsburg). The spec decides how high the road
is over a span (a deck PIN, see `data/bridgedeck.ts`), what the structure
looks like, and which OSM building parts it replaces (towers only: anything
30 m or taller or off the ground inside the corridor; Fort Point stays).

## Bridges

| bridge | family | towers from | key figures |
| --- | --- | --- | --- |
| Golden Gate | suspension, Art Deco steel towers | OSM building:part legs | 1280 m span, 227 m towers, road 75 m, sag 143 m (1:8.95), #C0362C |
| Bay Bridge west span | twin suspension, braced towers | OSM pylons W2, W3, W5, W6, centre anchorage | 704 m spans, 160 m towers, double deck 9.5 m apart, Bay Lights |
| Bay Bridge SAS | self-anchored, single tower | OSM way 237735191 | 385 + 180 m, 160 m tower, looped cable |
| Bay Bridge skyway | concrete box girder viaduct | the pack's ways | follows the road to the pack edge |
| Brooklyn | suspension, granite Gothic towers | OSM pylons 317352708, 1255363983 | 486 m span, 84.3 m towers, 4 cables, stays, raised promenade |
| Manhattan | suspension, steel portal towers | OSM pylons 317352033, 1255353996 | 448 m span, 102 m, two decks, #8EB4D2 (OSM colour tag) |
| Williamsburg | suspension, lattice towers | OSM pylons 1016434034/5 | 488 m span, deep truss, straight backstays |
| Queensboro | cantilever truss | OSM pylons 1016487154/5/7/9 | 360 / 192 / 300 m spans, spires at 110 m |
| Chicago main stem (9) | trunnion bascule | OSM bridge ways, axis snapped to the road | DuSable double deck with four bridge houses, Wells with the L truss |

## Published sources

- Golden Gate Bridge Highway & Transportation District, Design & Construction
  Stats: goldengate.org/bridge/history-research/statistics-data/design-construction-stats/
- HAER CA-31, Golden Gate Bridge (cable sag, cable spacing, truss depth, Fort
  Point arch)
- Wikipedia, San Francisco-Oakland Bay Bridge (spans, tower heights,
  clearances, deck arrangement); Caltrans SAS fact sheets
- NYC DOT bridge pages and Wikipedia for Brooklyn, Manhattan, Williamsburg and
  Queensboro bridges
- CDOT / HAER IL series for the Chicago bascules
- OpenStreetMap (Overpass, queried 2026-10-24) for every tower and pier node

## Reference photographs (Wikimedia Commons)

- https://commons.wikimedia.org/wiki/File:Golden_Gate_Bridge,_detail_South_tower.jpg
- https://commons.wikimedia.org/wiki/File:Golden_Gate_Bridge_at_sunset_1.jpg
- https://commons.wikimedia.org/wiki/File:SF_Bay_Bridge_western_tower.JPG
- https://commons.wikimedia.org/wiki/File:Bay_Bridge_from_Coit_Tower.jpg
- https://commons.wikimedia.org/wiki/File:Tower_and_self-anchoring_suspension_cables,_eastern_span,_San_Francisco_Bay_Bridge._(9674254510).jpg
- https://commons.wikimedia.org/wiki/File:Brooklyn-side_tower_of_the_Brooklyn_Bridge_from_Brooklyn_Bridge_Park,_New_York_City.jpg
- https://commons.wikimedia.org/wiki/File:Manhattan_Bridge_tower,_Dumbo,_Brooklyn,_New_York.jpg
- https://commons.wikimedia.org/wiki/File:Williamsburg_Bridge_NY1.jpg
- https://commons.wikimedia.org/wiki/File:Queensboro_Bridge_from_the_south_(41939).jpg
- https://commons.wikimedia.org/wiki/File:DuSable_Bridge,_aka_Michigan_Avenue_Bridge,_Chicago.jpg

## Known gaps

- The Bay Bridge's SoMa approach: OSM maps the ramps at First and Fremont as
  ordinary road, so the solve meets them at street height and the lower deck
  climbs ~50 m in the last 320 m before the Rincon Hill anchorage.
- Chicago's streets stand about a metre over the river on SRTM, so every
  bascule is too low over the water; its girders are clamped to stay out of it.
- No floodlighting of the towers at night; only aviation red, deck lamps and
  the Bay Lights.
- Brooklyn's suspenders are drawn at a quarter of their real density to keep
  the web from moire.
