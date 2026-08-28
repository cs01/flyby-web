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
the clock so a screenshot can be reproduced under an identical sun.

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
src/data/               cache, DEM, imagery, weather, solar, city packs
src/render/             atmosphere, sky, terrain, buildings, clouds, tone mapping
src/sim/                flight model, input, chase camera, tour
tools/bake-city.ts      Overpass -> .city pack
tools/city-index.ts     regenerates public/cities/index.json
```

Add a city to `src/cities.ts`, then:

```bash
bun tools/bake-city.ts --city <id>   # Overpass -> public/cities/<id>.city
bun tools/city-index.ts              # regenerate the menu's index
bun run verify                       # parse every pack, cross-check the index
```

`bun run check` runs both typechecks and the pack verifier.

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

## Attribution

Terrain: NASA SRTM via AWS Terrain Tiles. Imagery: Esri World Imagery.
Buildings: © OpenStreetMap contributors (ODbL). Weather: Open-Meteo.
