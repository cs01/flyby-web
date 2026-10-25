# Buildings that pass for real: the archetype plan

Owner's bar (2026-10-24): nobody should be able to tell a building is not the
real one unless they pull up a photo of that exact address and compare. Not a
replica of each building: a city where every building looks like A building,
of the right kind, in the right place, built from real materials.

The current facade system (src/render/facade.ts) has five procedural families
(glass, brick, stucco, concrete, stone) with flat colours and a window grid.
That reads as a model, not a city. The gap is not the grid logic, it is that
nothing on the wall was ever photographed.

## The approach

1. **Survey real archetypes, per city.** About 25 to 30, each written down
   from reference photos with measured proportions (storey height, window
   width/height/spacing, sill and head depth, spandrel height, cornice depth,
   base height) and a palette sampled from photos, not picked by eye. Examples:
   - New York: pre-war brick walk-up with fire escapes and a cornice; brownstone
     row house with stoop; pre-war limestone/brick apartment tower with
     setbacks; Art Deco setback tower in buff brick and terracotta; 1960s
     International Style glass-and-spandrel slab; post-1990 blue/green curtain
     wall; SoHo cast-iron loft; rooftop water tanks on 6 to 20 storey buildings.
   - San Francisco: Victorian and Edwardian timber row houses with bay windows
     in a wide painted palette; 1920s stucco Mediterranean apartments; Marina
     stucco over garage; downtown terracotta/granite pre-war office; Financial
     District glass towers; SoMa concrete/brick warehouses.
   - Chicago: Chicago School terracotta with Chicago windows; Miesian black
     steel and bronze glass; Art Deco limestone; 1970s concrete; red brick
     courtyard apartments and two-flats in the neighbourhoods.
2. **Real materials.** CC0 photographed PBR sets (ambientCG, Poly Haven) for
   every wall material: several bricks (red, brown, buff, painted), limestone,
   granite, terracotta, concrete board-formed and precast, stucco, painted
   wood siding, metal panel. Packed into a texture array with albedo, normal,
   roughness. Hue-shifted per building inside the measured palette so two
   neighbours never match. Stochastic tiling so a 100 m wall does not repeat.
3. **Windows you can see into.** Interior mapping (parallax room cubes from an
   atlas of a few dozen room interiors: offices, apartments, blinds and
   curtains at varying heights), real frame profiles and mullion widths per
   archetype, glass reflecting the sky probe and the city.
4. **Relief where it shows in silhouette.** Window reveals and sills, belt
   courses and cornices as geometry or parallax, setbacks on tall pre-war and
   Deco towers, rooftop clutter (water tanks, HVAC, bulkheads, antennas),
   fire escapes on walk-ups, bay windows on SF row houses, storefronts with
   awnings and signs at grade.
5. **Weathering.** Rain streaks below sills and cornices, grime darkening
   toward the base and under overhangs, soot on older masonry, patchy
   repointing. Age comes from the archetype.
6. **Assignment that follows the city.** Archetype chosen from OSM tags when
   present (building, building:material, building:colour, roof:colour,
   start_date, building:levels), else from height, footprint size and shape,
   district (downtown core, residential grid, industrial), and neighbour
   coherence: a block of row houses shares an archetype and varies its colour,
   it does not alternate glass and brick.

## Gates

- A distribution gate: per city, the archetype mix in each district matches
  what the survey says (no glass towers in the Mission, no Victorians in the
  Loop), and neighbour coherence is measured.
- A rendered-frame gate in the verify-water.ts discipline: material
  high-frequency detail at street level over a `?flatfacade=1` probe, no
  aliasing ceiling regression from altitude, frame-time budget on full and
  reduced tiers.
- Side-by-side frames against reference photos of the same street, judged
  by the owner.

## The number: a Turing test for buildings

The owner's framing: pass the Turing test for buildings. Make that literal.
Pair each fixed-pose render with a real photo of a similar street (same city,
same kind of block, similar light), crop both to the same framing, and ask a
blind judge (a vision model given only the two images, order randomised) which
one is the photograph. The score is the fraction of pairs where the judge
picks wrong or says it cannot tell. 0% today; 50% is indistinguishable. Run it
per archetype so the number points at which buildings give the game away, and
keep the judge's stated reason, because "the windows have no depth" is the
work list.

## Shipped, 2026-10-24

What exists now, so the next pass starts from it rather than from the plan.

- **The library** (`src/render/archetype.ts`): 31 archetypes. New York 10
  (walk-up, brownstone, pre-war apartment, cast-iron loft, Deco tower, pre-war
  office, 1960s slab, white-brick tower, public housing, outer-borough house),
  San Francisco 8 (Victorian, Edwardian, 1920s stucco, Marina, post-war box,
  west-side house, downtown terracotta, SoMa warehouse), Chicago 7 (Chicago
  School, Miesian, Deco, 1970s concrete, courtyard, two-flat, cottage), and 6
  shared (glass tower, mid-rise office, condo tower, warehouse, retail strip,
  civic). Each has storey height, column pitch, window rectangle, sash style,
  frame width, cornice, sill band, interior, roof survey, weathering, palette.
  Cities with no survey keep the five families, now laid in photographed scans.
- **Assignment**: district from the area-weighted mean height of the 300 m
  around each building; neighbourhood zones for the types that cluster
  (brownstones in Park Slope and Harlem, cast iron in SoHo, Marina stucco);
  one draw per party-wall cluster. OSM `building:material`, `start_date`,
  `building:colour`, `roof:colour`, `roof:material` and `building:levels`
  override the guess on the live path; the baked packs carry none of them (a
  Chelsea query found 4.7% with a material, 7.6% with a date), so they were not
  re-baked.
- **Palettes**: written from the survey of each type and checked against
  reference photographs rather than sampled pixel by pixel from a set; the one
  measured cross-check so far is San Francisco siding (a yellow Pacific
  Heights front at sRGB 185,164,131 and a green one at 52,68,62 in overcast
  shade, Wikimedia Commons "San Francisco architecture (46674074822).jpg", CC
  BY 2.0). Sampling a palette per type from a photo set is still open.
- **Materials**: 16 CC0 ambientCG scans (`public/materials/CREDITS.md`), sized
  from the measured brick course or board width, hex-tiled, 3.35 MB full tier
  and 0.90 MB reduced.
- **Gates**: `test/archetype.check.ts` (library ranges, district mix per city,
  coherence 0.66-0.77 against 0.22-0.40 drawn per building, the bake, the byte
  block, tag overrides) and `tools/verify-buildings.ts` (street detail, shimmer
  under a 0.3 m camera move, night lit-window share, roof spread top-down),
  every bound with a probe that runs the old behaviour and fails.

## Second pass, 2026-10-24

- **Massing.** The parts were always in the packs; the outline standing over
  them was the box. `.city` version 2 (src/data/citypack.ts) adds a record
  tail: a building:part group id, roof:height, and the OSM material, colour,
  roof colour, roof material, start_date and levels; the top bit of the kind
  byte marks a kind inferResidential wrote. osmbuildings.ts `resolveParts`
  drops an outline its ground-standing parts cover (80%) and otherwise cuts
  it to the podium under its lowest raised part. A group is one building to
  the renderer (one archetype, palette and storey grid measured from the
  ground, one ground anchor shared with the collider). Spires, crown
  pyramids and domes are geometry. Chicago and San Francisco are re-baked
  from Overpass; see the bake report in the commit for Manhattan.
- **Detail layer round the camera** (buildings.ts `updateDetail`), rebuilt
  every 200 m in 3 ms slices: awnings (700 m), projecting cornices and San
  Francisco bay windows (900 m), fire escapes as steel (380 m), full water
  tanks (1.2 km; a 32-triangle far tank stands on every tank roof in the
  pack). Only on open walls, never in a party wall.
- **Shopfronts**: a retail room behind the glass, a trade sign per unit from
  a per-city lettering atlas (render/signs.ts), shutters on closed units at
  night. **Windows**: air conditioners by archetype, plants, raised sashes.
- **Night**: floodlit crowns and spires past 150 m, red obstruction lights,
  street lamps and headlights on facades.
- **Glass** reflects the city within 900 m through the water's SSR history.
- **Gates**: verify-buildings adds the setback silhouette (skyline steps
  over the Empire State, ?flatparts=1 probe) and the night shopfront
  (ground-storey contrast, ?flatshop=1 probe).

Not done: the blind Turing score; ground floors of residential walk-ups are
still a plinth and a door (no stoops); fire escapes have no drop ladder; the
detail layer is not built on live-streamed tiles.
