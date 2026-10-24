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
