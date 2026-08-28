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

Set `uDebug` on the terrain material (`flyby.tune('uDebug', n)` in the console)
to isolate a term: 1 albedo, 2 direct, 3 ambient, 4 inscatter, 5 lit,
6 transmittance, 7 water mask, 8 elevation.

## Attribution

Terrain: NASA SRTM via AWS Terrain Tiles. Imagery: Esri World Imagery.
Buildings: © OpenStreetMap contributors (ODbL). Weather: Open-Meteo.
