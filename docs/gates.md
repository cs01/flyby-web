# Gates

Every check this repo has, what each one claims, and how to run them all.
The rules they follow are in [roadmap.md, Gate discipline](roadmap.md#gate-discipline):
bounds are literals measured on both sides before they were written down, and
every assertion has a vacuity probe, the old behaviour in the same binary, that
must FAIL it.

## Running them

    bun run gates                        # check, then every rendered gate, serially
    bun run gates --only glass,bounce    # a subset, in the order given
    bun run gates --skip perf

`tools/gates.ts` runs each gate with one vite port (5211), one Chrome debug
port (9581) and one Chrome profile (`/tmp/flyby-gates-profile`), so the tile
cache is filled once and reused. Serial is the only order that measures
anything: every rendered gate starts its own vite and headless Chrome, and two
at once share the GPU. It prints a table and writes each gate's full output to
`shots/gates/<gate>.log`:

    gate        result         checks ok/fail  probes failed-as-they-must/passed  seconds

A gate is reported as

- `ok`: exit 0, no failed check, every probe failed as it must;
- `FAIL`: a check failed (the picture or the frame cost moved);
- `PROBE PASSED`: a vacuity probe passed, so that claim measures nothing any
  more. This is a broken gate, not a passing one;
- `EMPTY`: a rendered gate exited 0 having printed no check at all. A gate
  whose output stopped matching would otherwise read green forever;
- `INCONCLUSIVE`: exit 2, which only `perf` uses, when another browser is
  using the GPU and the bounds cannot be measured.

The whole set takes about 30 minutes on the M4 Air. Each gate also runs on its
own with `bun run <name>` and takes `--port`, `--debug-port` and `--profile`.

## What runs where

CI (`.github/workflows/ci.yml`) runs `bun run check` and `vite build` on every
pull request. Everything else needs a GPU, a browser and a vite server, so it
runs locally, and before a deploy that touched what it measures.

## The gates

| gate | script | claims | probes |
| --- | --- | --- | --- |
| check | `bun run check` | typecheck (app and tools); the offline suites in `test/*.check.ts` (solar, touch, flight, drone, roof, facade, archetype, sh, gtao, budget, quality, collision, landmask, roadmask, ribbon, trees, shrubs, car, carmesh, lighting, live, zoning, pavement, street, streetsign, bridge, trafficmodel, junction, livetraffic, spotting, transit, pack); the glsl, pack, land, road and aircraft verifiers | per suite, printed as `ok vacuity:` |
| water | `bun run water` | water has texture up close, stays sub-pixel far off, mirrors the sky at grazing, carries the skyline (SSR), whitecaps in wind and none in calm, foam is white | `?flatwater`, `?nossr`, and each ceiling measured on a frame that must exceed it |
| ground | `bun run ground` | the ground detail layer adds local contrast near, keeps the photograph's block colour, adds nothing aliased from altitude | `?nodetail`, `?detailtint`, `?detailalias` |
| shadow | `bun run shadow` | the static city shadow map carries shadow past the cascades with no edge at the last cascade, at both quality tiers | `?nocityshadow` |
| clouds | `bun run clouds` | cumulus cluster, share a flat base, cover lands in its band, cloud time is smooth, outlines billow, rims are backlit, stratocumulus breaks; `?shot` is byte-identical across runs | `?cloudwm=0`, `?cloudflatbase=0`, `?cloudprobe=oldshape/oldlight`, the other cover's frame |
| night | `bun run night` | from the driver's seat at dusk and at night the road ahead is readable, and the simulated cars keep to their lanes | `noheadlights+nolamplight`; every car displaced 1 m |
| buildings | `bun run buildings` | street-level facade material, no shimmer from altitude, lit night windows that do not twinkle, roofs differ, setback silhouettes, shopfronts at night | `?flatfacade`, `?nomip`, `?oneroof`, `?flatparts`, `?flatshop` |
| skyglow | `bun run skyglow` | the sky over a city glows, sodium-warm, as a dome, washes out the stars, lights an overcast deck from below | `?noskyglow`, a rural sky |
| farcolour | `bun run farcolour` | the far field of a city has a city's spread of colours, teal glass and red brick | `?onepalette` |
| glass | `bun run glass` | window reveals: head and jamb contrast at grazing on 7th Avenue, sub-pixel at 500 m over Hong Kong; reflection is directional, square-on glass gains on grazing, masonry did not move | `?flatglass`, `?flatrefl`, and each ceiling measured on a frame that must exceed it |
| bounce | `bun run bounce` | a shadowed canyon street is lit by the walls over it: carriageway and footway above a floor and not black, one to two stops under the sunlit road; nothing moves on a sunlit avenue or at night | `?flatbounce`, the canyon's own gain on the no-change ceilings |
| perf | `bun run perf` | the fastest 1 s window of each reference pose is under its regression bound (25% over what it measured) | `?perfprobe=heavy`, which draws the world twice more |

## Audit, 2026-10-25

Every gate was run on main (df8b3e1) and every probe checked to still fail.
Four were not ok:

| gate | before | cause | after |
| --- | --- | --- | --- |
| buildings | manhattan-7th `?flatfacade` probe passed (relLC 0.1339 against a 0.1 floor); manhattan-rooftops shimmer 0.0900 over 0.090 | f04430c (the version 2 pack rewrite) and 2d047fd (below) re-rolled 7th Avenue's facades; its near walls came up curtain wall, and the city reflected in them was most of the local contrast, flat facade or not. The rooftop shimmer was the same re-roll | facade seeds fixed (below); the street-level claim measured with `?nossr=1` (0.0909 against flat 0.0666, floor 0.080); rooftops 0.0815 |
| glass | three manhattan-7th probes passed (`?flatglass` head 4.713, jamb 4.753; `?flatrefl` 1.3518) | 2d047fd filtered the landmark bridges' OSM parts out of the pack, which shifted every later building's index, and the index seeded its facade: every Midtown facade re-rolled. Separately, the archetype frames and sills lifted the flat facade over the 08-31 floors | facades seeded by their index as loaded (`Building.seed`); floors re-measured between flat and recessed |
| bounce | `?flatbounce` passed the shadowed-ground floor (21.69 against 10) and the near-black ceiling (0.252 against 0.50) | c2bc47c turned the satellite drape the right way up; the shadowed lot in the LaSalle frame became a pale roof photograph, and both claims were means over the drape's albedo | both claims taken over carriageway and footway (`?groundDebug=2` and `=3`), which read the same either side of c2bc47c |
| farcolour | ok on main; failed after the seed fix (teal and red 0.0391 under 0.040) | the floor was set on one deal of the facade hash; seven deals of the same code measure 0.0302 to 0.0440 | floors between `?onepalette` and the lowest deal: 0.16 and 0.025 |
| perf | inconclusive | another browser held the GPU (Brave at 599% CPU) | not a gate defect; it also leaked its headless Chrome on that path, now fixed |

### Deals of the facade hash

Which archetype and palette a building gets is a hash of its record index.
Until this audit the index was taken AFTER the landmark filter, so adding a
bridge re-dealt every facade after it; it is now taken as the pack loads
(`Building.seed` in `src/data/citypack.ts`), so only a pack re-bake re-deals.
A claim about a few named walls is a claim about the deal those walls got.
Measured over four deals (the seed offset by 0 to 3), recessed beats flat on
every deal for glass head, jamb and direction and for the buildings
street-level claim, but only the glass directional floor (1.46) and the
far-colour floors hold on every deal. The glass head and jamb floors and the
buildings 7th Avenue floor hold on the current deal: when the Manhattan pack is
re-baked, re-measure them between the numbers each run prints.

Also found: `test/pack.check.ts` was in no script, printed `FAIL` for 181
Fremont on every run and exited 0. Its landmark point was 600 m off and its
search disc reached the Salesforce Tower. It is now in `check` and can fail.
