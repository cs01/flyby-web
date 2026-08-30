# Roadmap: what we are actually chasing

Written after an adversarial review of an earlier plan that was wrong about its
own goal. Read this before proposing renderer work.

## The target is not photorealism

`docs/manhattan-golden-hour.jpg` already wows, and it is nowhere near photoreal.
That single fact reframes everything: what reads as impressive here is
**cinematic light plus a city that looks alive**, not a photo-scan.

This renders ANY city on Earth from open data in about ten seconds in a browser
tab, with no server. Photo-scan fidelity comes from artists authoring every
material and hand-placing every prop over months. That is a different problem
and no amount of shader work substitutes for it. Film-still is reachable.
Photo-scan is not, and a plan that half-believes otherwise produces vague items.

**Tier the ambition by data quality.** Real building heights, measured:

| city | real heights | guessed |
| --- | --- | --- |
| Manhattan | 88.7% | 11.3% |
| SF | 79.2% | 20.8% |
| Paris | 73.7% | 26.3% |
| Chicago | 47.6% | 52.4% |
| Redwood City | **0.0%** | **100%** |

Hero cities can chase near-photoreal. Everywhere else the honest target is
"convincing from 200 m up". Chasing per-pane realism in a suburb where every
height is a 9 m fallback is incoherent; chasing plausibility there is cheap.
Say which one you are doing.

## Where the frames actually sit

`docs/manhattan-golden-hour.jpg` is this renderer's own output with the HUD in
it. It wows because a 10 degree sun does the work: long shadows, warm/cool
split, aerial perspective hiding the far field. It is not evidence that the
day frames are close. `shots/03-gtao/chicago-loop-day.png` and
`manhattan-7th.png` are the real baseline: uniform blue-grey, no readable sun
direction, no ground shadows at 11:00 under a 70 degree sun, window grid
blurred to mush at 65 m. Judge against noon, not against the hero frame.

The console-generation scale used below: the day frames are PS2-PS3 (extruded
boxes, flat light, no temporal stability). Roofs, ground and props alone get to
PS3-PS4. The PS5-PS6 tier is built on four things the earlier plan did not
list: correct sun:sky contrast WITH bounce, temporal stability, silhouettes
that are not extrusions, and motion.

## Order of work

1. **The "white ground over SF" is exposure, not a data bug.** Measured on
   `sf-residential` through the terrain debug views (`?terrainDebug=N`, now
   reachable from the harness with `--query`): the stitched Esri drape is a
   normal grey-green (mean sRGB 118,127,112), snow and wetness are zero, the
   ambient term is small, and the direct term alone lifts that 18% grey to
   sRGB ~181 where middle grey should land near 118. So a diffuse horizontal
   at noon is ~1.3 stops hot, every pale roof or street clips toward white,
   and the Esri SF capture's +9 green cast comes through as mint. Halving
   `exposure` puts the ground at 120-130 and leaves the hue, which confirms
   both halves. The `SUN_SURFACE` comment in `terrain.ts` claims it "makes a
   mid-albedo surface land in the middle of the curve"; it does not, and that
   claim is exactly what the gate in item 2 exists to check. Separately,
   neutralise the drape's colour cast per city at stitch time: grey-world on
   the landcover `built` pixels only (vegetation is allowed to be green), so a
   green or magenta capture does not tint a whole city.
2. **One sun constant, then a lighting gate, then tune.** `SUN_SURFACE = 0.105`
   is hardcoded in six files (`buildings.ts`, `terrain.ts`, `roads.ts`,
   `aircraftmodel.ts`, `composite.ts`, `skyprobe.ts`) and the skyprobe comment
   admits they must agree by hand. `AMBIENT_SCALE = 0.34` in `lighting.ts` and
   the `x *= 0.6` inside `tonemapACES` are two more exposure knobs that agree
   by accident. Unify the constant, fold the 0.6 into `exposure`, then write
   `test/lighting.check.ts`: evaluate the probe SH at (0,1,0) and the direct
   term at solar noon, clear, and assert sun:sky on a horizontal in `[4, 9]`
   (physics: ~900 W/m2 direct normal against ~100-150 diffuse) and sunlit
   wall : shaded wall in `[2.5, 6]`, from literals. Prove it goes red with
   `AMBIENT_SCALE = 1`. Add a night pose to the same gate (lit window : facade
   ratio). Only then move the values.
3. **Bounce, shipped together with the contrast.** Once sun:sky is right the
   shade goes blue-black and reads CG, because the probe's lower hemisphere is
   a flat plane and no wall sees the sunlit wall opposite. Add a bounce term to
   the building shader: mean city albedo times the horizontal direct term,
   tinted by `sunColor * sunT`, weighted by `(1 - skyOcc)`, the canyon
   occlusion already computed, inverted: the less sky a wall sees, the more lit
   wall it sees. Do not ship contrast without this; the intermediate state is
   worse than today.
4. **Shadows from altitude.** `CASCADE_FAR = [350, 1400, 6000]` at 2048 puts
   the whole city in cascade 2 at ~3 m per texel from 420 m, and ground
   shadows are the primary aerial depth cue. Drive the splits by altitude, not
   fixed distance. Cloud shadows on the ground come from one 2D noise lookup in
   the terrain `sunVis` and sell scale for nearly nothing.
5. **Temporal gate, then temporal stability.** Every shot is a single frozen
   frame, so the harness is blind to the loudest PS2 tell: shimmer. The window
   grid is at the mip boundary and `fwidth` prefiltering covers the grid lines,
   not per-pane brightness and occupancy; MSAA does nothing for shader
   aliasing. Gate: render each pose twice with the camera moved 0.3 m and
   assert the mean absolute difference over the building mask is under a
   literal. Then fix it: prefiltered occupancy at minimum, TAA with a history
   buffer if the budget allows.
6. **`building:part` merging for hero cities.** `bake-city.ts` bakes parts and
   outlines as unrelated boxes, so a setback tower is either a stack of
   independent slabs or an outline extruded to full height with the parts
   inside it. Parts should suppress the outline footprint they cover and share
   its facade seed. Manhattan and Chicago have this data already fetched; it is
   worth more than any roof colour there.
7. **Water.** Every hero city is on water and the Hudson renders flat grey. A
   normal-mapped wave field with sun glitter off the existing probe is in a
   large fraction of the pixels of any Manhattan flight.
8. **Traffic, then the night pass.** Moving cars beat parked ones from the
   aircraft camera: a parked car is 2 px at 300 m, a headlight stream is the
   single biggest "alive" signal in `chicago-loop-night`. Road centrelines are
   already ribbons, so traffic is a vertex-shader particle system (route
   parameter plus a time uniform, no per-instance matrices). Night today is
   mid-grey facades with a random dot pattern and a hard orange horizon band;
   `nightGlow` should fall off with height above street, the skyglow dome
   should be smooth, and lights need bloom.
9. **Pitched roofs.** `RoofShape` is already baked into every pack
   (`citypack.ts`) and `buildings.ts` never reads it. But the baked flag is
   itself mostly a fallback, because `classifyRoof` keys on OSM `roof:shape`
   which is tagged on 2-14% of buildings: even the suburb comes out 87.6% Flat.
   So rendering the flag is not enough. **Infer** gables from footprint size and
   building kind at bake time. This transforms exactly the places where OSM
   height data is worst.
10. **Drape-sampled roof colours.** Average the Esri pixels inside each
    footprint to get that building's real roof colour. Free, no new source,
    per-building. Caveats that must be handled: tall footprints sample
    parallax-leaned facades and photographed shadow, so use a robust median,
    taper trust with height, and normalise for capture-time sun. Done naively,
    towers go muddy brown.
11. **Trees.** Trees help the zero-heights suburb (WorldCover says 55% tree
    cover there) and SF residential is block after block of bare boxes.
    Individually mapped OSM nodes where they exist (Paris 3,564 per 1.7x2.5 km
    box, Manhattan 833, a suburb 2), procedural fallback seeded by WorldCover
    coverage elsewhere.
12. **Street level, only if walk mode is real.** Near-field ground (pavements,
    kerbs, lots, entrances: today everything between the kerb and the wall is
    blurred orthophoto carrying photographed shadows that contradict the
    scene's own sun, and ground floors are a `win *= 0.35` dimming hack),
    interior mapping behind the glass, and parked cars along kerbs (CC0
    archetypes with per-instance colour; real makes are trademarked, do not
    ship rips). All three pay within 50 m and nowhere else.

## Quality is a profile, not a phone veto

"Mobile memory is the ceiling" and "PS6" contradict each other. `quality.ts`
only scales resolution; feature toggles are ad hoc (`main.ts` turns AO off on
a coarse pointer). Make an explicit profile (`{ao, cascades, probeRes,
traffic, taa}`) chosen by device. Desktop gets everything. A phone corrupting
at 213 MB is a reason for the phone tier to drop a target, not a reason the
desktop tier never gets one.

## Cut, and why

- **Tiled PBR texture pipeline.** `facade.ts` is built around per-building
  parameters with statistical gates; an atlas throws that away, tiling
  repetition reads as CG faster than clean procedural does, mobile already
  corrupted once at 213 MB of texture, and KTX2 drags in a transcoder against
  the no-runtime-dependencies line.
- **Parallax occlusion mapping.** Depends on the texture pipeline.
- **SSR.** Narrow payoff (street level, night, rain) against real cost in a
  budget already dominated by per-fragment work, and `skyprobe.ts` already feeds
  wet-road reflections.

## Live OSM: what is measured about the sources

Buildings, roads and canopy are no longer bake-only. Where a place has no
`.city` pack the app streams OSM around the camera (`src/app/live.ts`), through
the same converters the bakers use (`src/data/osm*.ts`). The numbers that
decided the design, all measured rather than assumed:

- **Seven cities have a `.city` pack and four have `.roads`**, not thirty-seven.
  Thirty-six have `.land`. So "the baked cities" is a much smaller set than the
  menu suggests, and everywhere else was bare boxes-free ground.
- **A browser has very few Overpass endpoints.** `overpass.kumi.systems` and
  `overpass.private.coffee` answer the baker and send no
  `Access-Control-Allow-Origin`, so a page cannot read them at all.
  `overpass.osm.ch` DOES send it and is useless anyway: it carries Switzerland
  only and answers everywhere else with an empty element list, which reads as a
  place with no buildings rather than as an error.
- **WorldCover cannot stream.** The `.land` source is 87 MB Deflate-tiled COGs
  on an S3 bucket with no CORS headers. Runtime canopy therefore comes from OSM
  landuse polygons and `natural=tree` nodes (`src/data/osmveg.ts`), rasterised
  into the same coverage grid `src/data/trees.ts` already plants from. Where a
  `.land` pack exists it stays the better source and wins.
- **One request per tile, not three.** Requests are what a public instance
  rate-limits on, so buildings, roads and vegetation share one union query built
  from the same statement fragments the three bake queries use.
- **Cache hit rate on a second visit is 100%.** Measured over Santa Rosa: 23
  requests on the first load, 0 on the second, because an answer for a fixed
  bbox is immutable and the IndexedDB entries have no TTL.

`tools/overpass-replay.ts` serves cached real answers on a local port so the
screenshot harness can capture an unbaked place without asking a volunteer
server the same question on every run. `?nolive` turns the whole path off.

## Constraints that decide designs

- **Per-fragment work is the scarce resource, geometry is not.** Measured: the
  atmosphere march dominates at ~5 ms while 1.4M triangles of skyline costs
  ~0.26 ms. Alpha-tested foliage overdraw plus a second draw into the shadow
  cascades is per-fragment work twice over. Budget it before building it.
- **Mobile memory is the ceiling.** A phone corrupted at 213 MB of drape.
  Every render target counts: scene target, three shadow cascades, bloom, the
  sky probe, and now the GTAO target.
- **No instancing infrastructure exists.** Zero `InstancedMesh` in the repo.
  With `RawShaderMaterial` you must hand-declare `in mat4 instanceMatrix` and
  drive it yourself. For cars, put motion in the vertex shader (route parameter
  plus a time uniform) rather than updating thousands of matrices per frame.
- **Overpass is volunteer infrastructure.** This project got itself rate-limited
  by over-fetching. The bake cache now lives OUTSIDE the checkout
  (`~/.cache/flyby-web-bake`, override with `FLYBY_CACHE`) with no TTL, because
  it used to sit in `tools/.cache` per worktree and removing a worktree deleted
  everything it had fetched.

## Gate discipline

This repo has produced **three** gates that could never fail. Assume you will
write a fourth unless you actively hunt for it.

1. A mitre-spike test whose bound was `MITRE_LIMIT`, the constant under test, so
   raising the constant moved the goalposts with it. Reported `ok` at a 490 m
   spike.
2. A shader check that searched the whole GLSL for a symbol another function
   also mentioned, so deleting the gated code still passed.
3. A frame-time p99 that recorded `Math.min(0.05, dt)`, the simulation's
   stability clamp, so it reported exactly 50.00 forever and could never see a
   stall. This one was added specifically to catch a stall the median had hidden.

Rules that follow: take bounds from **literals**, never from the constant under
test; assert the constant is itself within the literal bound; slice the exact
function under test before searching it; and add a **vacuity probe** for every
assertion, feeding it a case it must reject, then prove the probe itself can go
red. Break every assertion's subject, watch it fail, restore, watch it pass.

`test/` is currently type-checked by **neither** tsconfig, so `noUnusedLocals`
has never seen a single check file. Mixing `bun-types` with the DOM lib
conflicts on event signatures; this needs a proper pass, not a quick one.

## Unresolved

- **Android black buildings and aircraft.** Buildings and the aircraft go black
  on the owner's phone while desktop is fine, and the mobile code path forced on
  desktop renders correctly. Leading suspicion is float texture support: both
  use float textures (`buildFacadeTexture` RGBA32F, the aircraft cubemap probe)
  and terrain does not. `?diag=1` reports the device's GL capabilities.
- **The mint-green cast on `sf-residential`.** Resolved by measurement: see
  item 1 of the order of work. Ground overexposure plus the imagery's green
  cast, not a ground-plane bug and not the landcover channels.
