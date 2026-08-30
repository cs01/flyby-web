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

## Order of work

1. **Lighting and grading root-cause.** Daytime frames are flat pastel: shadows
   barely darker than sunlit faces. The knobs are all in one place
   (`lighting.ts` sun intensity, ambient scale, sun colour; `tonemap.glsl.ts`).
   This improves EVERY frame in EVERY city including the zero-data suburb, which
   nothing else on this list does. Tune against real photograph references
   through `tools/shots.ts`.
2. **Pitched roofs.** `RoofShape` is already baked into every pack
   (`citypack.ts`) and `buildings.ts` never reads it. But the baked flag is
   itself mostly a fallback, because `classifyRoof` keys on OSM `roof:shape`
   which is tagged on 2-14% of buildings: even the suburb comes out 87.6% Flat.
   So rendering the flag is not enough. **Infer** gables from footprint size and
   building kind at bake time. This transforms exactly the places where OSM
   height data is worst.
3. **Drape-sampled roof colours.** Average the Esri pixels inside each footprint
   to get that building's real roof colour. Free, no new source, per-building.
   Caveats that must be handled: tall footprints sample parallax-leaned facades
   and photographed shadow, so use a robust median, taper trust with height, and
   normalise for capture-time sun. Done naively, towers go muddy brown.
4. **Trees.** Before cars. Trees help the zero-heights suburb (WorldCover says
   55% tree cover there) and SF residential is block after block of bare boxes.
   Individually mapped OSM nodes where they exist (Paris 3,564 per 1.7x2.5 km
   box, Manhattan 833, a suburb 2), procedural fallback seeded by WorldCover
   coverage elsewhere.
5. **Near-field ground.** Pavements, kerbs, lots, entrances. Today everything
   between the kerb and the wall is blurred orthophoto carrying photographed
   shadows that contradict the scene's own sun, and ground floors are a `win *=
   0.35` dimming hack. This is a hard prerequisite for walk mode, not an
   optional polish item.
6. **Interior mapping.** Procedural rooms behind the glass, no textures needed,
   fits the existing `FACADE_GLSL` path. Pays within ~50 m and at night.
7. **Cars.** Parked along kerbs first: 80% of the read for a tenth of the work
   of traffic simulation. CC0 archetypes (sedan/SUV/van/bus/taxi) with
   per-instance colour. Real makes and models are trademarked and correctly
   licensed models do not exist; do not ship rips.

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
- **The mint-green cast on `sf-residential`.** One reading is pale rooftops,
  another is a ground-plane colour bug predating the sky probe. Settle it before
  the lighting work, since it is the same subsystem.
