# FLYBY

Fly over real cities, under the weather that is actually happening there.

A standalone web app. No backend, no API keys, no build-time assets beyond the
baked city packs: terrain, imagery and weather are all fetched at runtime from
keyless, CORS-open public sources.

## Run

```bash
bun install
bun run dev
```

`?city=<id>` picks a place (see `src/cities.ts`). `?t=<epoch seconds>` freezes
the clock so a screenshot can be reproduced under an identical sun. `?easy`
flies a gentler aeroplane.

## Flying it

| | |
|---|---|
| `W` / `S` | throttle: **W is forward** |
| `A` / `D` | roll, and a banked aeroplane turns |
| `Space` / `Ctrl` | climb / descend |
| `Q` / `E` | rudder |
| `Shift` | more power and more bank |
| drag | stick: sideways rolls, back climbs |
| `C` · `B` | camera · look back |
| `,` `.` · `0` · `T` | clock back/forward · back to now · timelapse |
| `P` | pause |

It is a high-wing light single flown arcade: no stall, no spin, nothing to
manage, and no way to break it. Three things are assisted on purpose, and they
are what stop it feeling like the sluggish fixed-wing model it replaced:

- **The throttle commands a SPEED, not a power.** Closing it actively slows the
  aeroplane instead of waiting for drag, so `S` is a brake and `W` is a
  go-pedal.
- **Altitude hold.** With no vertical input it holds its height, including
  through a turn. A pitch axis that self-centres cannot hold a climb, and one
  that does not needs trimming; a vertical-speed command needs neither.
- **The turn rate is scaled 2.4x** off the real `g·tan(bank)/V`. Truthfully,
  55 degrees of bank at 100 kt is a 30-second circle, and a 30-second circle
  over Manhattan is not flying, it is waiting. The relation is scaled rather
  than replaced, so a slow aeroplane still comes round tighter than a fast one.

`bun run flight` asserts all of it -- cruise and slow speed, time for a full
circle, roll response, climb rate, altitude hold, and that wind moves the track
without moving the airspeed indicator. Those numbers have no visual tell when
they drift: an aeroplane that takes thirty seconds to come round still looks
like an aeroplane in a screenshot.

## Moving the clock

The scrubber under the frame counter moves the scene clock, and the scene clock
drives **both** the sun and the weather -- solar position computed locally and
exactly, weather from Open-Meteo's hourly forecast, interpolated. Answering only
one of them would be worse than answering neither: a dawn sky under this
afternoon's cloud is a picture of a moment that will never exist.

The coloured band under the slider paints each of the next 60 hours as the
colour of its sky, so a clear dawn or an incoming front is something you can see
and click on rather than something you have to find by scrubbing blind.

The weather badge changes with it. An observation is `LIVE`, a prediction is
`FORECAST +11H`, and no feed at all is `simulated` -- a forecast came off the
wire exactly as much as the current observation did, so "live" cannot be the
distinction, and a panel that said LIVE over a prediction would be the one
dishonesty this app is built to avoid.

## Instruments

Attitude, heading ribbon and vertical speed, in SVG, plus the numbers. The mark
worth knowing about is the **flight path marker** on the attitude ball: it sits
where the aeroplane is actually going, as opposed to where its nose is pointing.
In still air it sits on the reference; in a crosswind it slides off by exactly
the drift angle. It is the most legible evidence in the app that the weather is
real rather than decorative.

## Data

| Layer | Source | Notes |
|---|---|---|
| Elevation | AWS Terrain Tiles (NASA SRTM et al), terrarium encoding | keyless, global |
| Imagery | Esri World Imagery | keyless |
| Buildings | OpenStreetMap via Overpass, baked to `.city` packs | ODbL, attribution required |
| Weather | Open-Meteo `current` | keyless, cached 10 min |
| Radar | RainViewer | keyless, US/EU/JP/AU only |

Buildings are baked rather than fetched live because OSM's own vector tiles cap
at zoom 14 and carry **no height attribute** — verified against the live
endpoint. A city skyline without heights is not worth rendering, and only
Overpass exposes `height` / `building:levels`.

## Layout

```
src/geo.ts              three coordinate systems in one file (geodetic / tile / local ENU)
src/cities.ts           the curated places and their landmarks
src/data/               cache, DEM, imagery, weather + hourly forecast, solar, city packs
src/render/             atmosphere, sky, terrain, buildings, clouds, tone mapping, the aeroplane
src/sim/                flight model, input, chase camera, tour
src/app/                HUD, instruments, clock scrubber, start menu
tools/bake-city.ts      Overpass -> .city pack
tools/city-index.ts     regenerates public/cities/index.json
```

Add a city to `src/cities.ts`, then:

```bash
bun tools/bake-city.ts --city <id>   # Overpass -> public/cities/<id>.city
bun tools/city-index.ts              # regenerate the menu's index
bun run verify                       # parse every pack, cross-check the index
```

`bun run check` runs both typechecks, the flight-model gate and the pack verifier.

**The verifier is the gate on a bake, and it uses the app's own parser.** The
failure it exists to catch is a truncated pack from an interrupted bake: it is
large, it has a valid header, and it is on disk, so a size check and a directory
listing both wave it through. Only walking every record to the final byte proves
the file is whole. It also cross-checks `index.json` in both directions, because
the menu marks cities as having a skyline from that file, and an entry with no
readable pack is the menu promising something the renderer cannot deliver.

Both directions of that gate have been audited by injecting the failure and
confirming a non-zero exit -- a check nobody has watched fail is not a check.

## Rendering notes

Everything is one atmosphere: the same single+multiple scattering integral paints
the sky dome AND the air between the camera and every surface, so a distant ridge
is tinted by exactly the air the sky is made of.

Two things that are easy to get wrong here and were:

- **`RawShaderMaterial` gets no tone mapping or colour-space injection from
  three.js.** Shaders must call `present()` from `tonemap.glsl` themselves and
  decode sRGB textures with `srgbToLinear()`. `renderer.toneMappingExposure` does
  nothing for these materials.
- **Cloud COVERAGE is not cloud OPACITY.** 100% high cirrus and 100% low stratus
  both report `cloud_cover: 100`; only one of them takes the sun away. The decks
  are weighted separately in `beamOpacity()`.

Buildings are budgeted, not fixed: `solveLod` searches an LOD curve until the
skyline fits `TRIANGLE_BUDGET`. Cities differ in density by more than 5x (San
Francisco bakes to 62k buildings, Manhattan to 187k over a similar radius), so a
fixed curve is either wasteful or unaffordable depending on where you load.

Set `uDebug` on the terrain material (`flyby.tune('uDebug', n)` in the console)
to isolate a term: 1 albedo, 2 direct, 3 ambient, 4 inscatter, 5 lit,
6 transmittance, 7 water mask, 8 elevation.

## Gotchas worth keeping

- **A 200 is not proof the response is what you asked for.** A dev server (and
  most static hosts) answer a missing path with the app shell: 200, and HTML.
  Caching that poisons the entry for its whole TTL, so the asset stays broken
  long after it exists. `fetchBytes` rejects HTML for non-page requests.
- **Terrarium encodes bathymetry as negative elevation.** Rendered unclamped the
  ocean is sea floor, with seamounts standing out of the water.
- **SRTM has isolated spikes over water.** Height does not identify them;
  ISOLATION does, because real terrain is continuous at a 30 m posting.
- **Water is found by elevation, not colour.** Esri's ocean is a mid blue-grey,
  well above any darkness threshold that still excludes dark roofs.
- **Normalising a ray in a vertex shader and interpolating it is wrong.**
  Interpolation is linear in the vector, not the angle; on a fullscreen triangle
  whose corners sit outside the frustum it skews the whole sky.
- `.city` packs gzip to ~57%; static hosts compress them in transit, so they are
  stored raw.
- **Open-Meteo hourly stamps need `timeformat=unixtime`.** Asking for a local
  timezone (which is the only keyless way to learn a city's wall clock) returns
  local wall-clock strings with no offset marker, and converting them back needs
  an offset that is itself only right on one side of a daylight-saving change.
  Unix time is UTC by definition; the zone is then only ever used for display,
  via `Intl` rather than by adding seconds.

## Attribution

Terrain: NASA SRTM via AWS Terrain Tiles. Imagery: Esri World Imagery.
Buildings: © OpenStreetMap contributors (ODbL). Weather: Open-Meteo.
