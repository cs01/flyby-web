# Aircraft model credits

`c182.glb`, `c182-default.png`, `c182-lights.png` and `c182-propblur.png` are
derived from the FlightGear **Cessna 182S** aircraft by HHS81 and contributors.

- Upstream: <https://github.com/HHS81/c182s>
- Pinned commit: `1359d63393c7fc9145953b081d151d93627e791a`
- Licence: **GPL-2.0**

## What was changed

The upstream model ships as AC3D (`c182s.ac`) plus PNG atlases. It was converted
to glTF 2.0 by `tools/ac3d-to-glb.ts` in this repo, which:

- triangulates the AC3D polygons and computes normals with the model's own
  80-degree crease angle (AC3D stores no normals),
- rotates from the AC3D frame (nose -X, up +Y, span Z) into the app frame
  (forward -Z, up +Y, right +X) and re-centres X and Z about the origin,
- drops ground-service and clutter objects (tie-downs, chocks, safety cones,
  winter kit, drain/checklist `.cs` hotspots),
- downsamples `Default.png` from 4096x2048 to 2048x1024 and `Lights.png` from
  1024x1024 to 512x512.

Geometry and texture content are otherwise unmodified. Object names are
preserved verbatim so the app can find animated parts by name.

## Licence of the derived asset

The converted `.glb` and the resized textures are a derived work of a GPL-2.0
model and are distributed under the **same licence, GPL-2.0**. The unmodified
AC3D source and original textures are retained in `assets-src/c182s/` alongside
the upstream `LICENSE`, so the "preferred form for modification" ships with the
derived asset as GPL-2.0 requires.

# Live-traffic models (`traffic/`)

Every `traffic/*.glb` and `traffic/*.webp` is derived from the FlightGear
**fgdata** AI aircraft collection, distributed under **GPL-2.0** (fgdata's
`LICENSE.md`).

- Upstream: <https://gitlab.com/flightgear/fgdata>, `AI/Aircraft/`
- Pinned commit: `624f6be5f09ac5b1727d4e03c17c8f327aaa41fc`
- Licence: **GPL-2.0**

| family | upstream model | author (from the model's `-main.xml`) | liveries (upstream `Textures/` dir -> file code) |
|---|---|---|---|
| `a320` | `A320/Models/A320.ac` | Brett Harrison | Default, Delta (DAL), UnitedAirlines (UAL), American (AAL), JetBlue (JBU), AlaskaAirlines (ASA), AirCanada (ACA), BritishAirways (BAW) |
| `a321` | `A321/Models/A321.ac` | Brett Harrison | Default, Delta, American, JetBlue, AlaskaAirlines, Hawaiian (HAL) |
| `b738` | `738/Models/737-800.ac` | Brett Harrison | Default, Delta, UnitedAirlines, AmericanAirlines, AlaskaAirlines, Westjet (WJA), CopaAirlines (CMP) |
| `b789` | `787/Models/789.ac` | Brett Harrison | Default, UnitedAirlines, American, BritishAirways, VirginAtlantic (VIR) |
| `b77w` | `777/Models/77W.ac` | Brett Harrison | Default, UnitedAirlines, American, BritishAirways, AirFrance (AFR), Emirates (UAE) |
| `a333` | `A333/Models/A333.ac` | Brett Harrison | Default, Delta, AerLingus (EIN), Turkish (THY) |
| `a359` | `A350/Models/359.ac` | Brett Harrison | Default, Delta, Lufthansa (DLH), Qatar (QTR) |
| `b763` | `767/Models/763.ac` | Brett Harrison | Default, Delta, UnitedAirlines |
| `b752` | `757/Models/757-200.ac` | Brett Harrison | Default, Delta, UnitedAirlines, American, FedEx (FDX), UPS (UPS) |
| `e175` | `E70/Models/ERJ175.ac` | Brett Harrison | Default, Delta, United, American, AlaskaAirlines |
| `crj7` | `CR7/Models/CR7.ac` | Brett Harrison | Default, American, Delta, United |
| `e145` | `ERJ145/Models/ERJ-145.ac` | Brett Harrison | Default, United, AmericanEagle (AAL) |
| `dh8d` | `DH4/Models/DH4.ac` | Brett Harrison | Default, AlaskaAirlines |
| `pa28` | `pa-28/Models/pa-28.ac` | FlightGear contributors | Default |
| `cl60` | `Bombardier-Challenger/Models/chal604.ac` | FlightGear contributors | Default |

The helicopter and the airport service van are built from primitives in
`src/render/airtraffic.ts` and are not derived from anything.

## What was changed

`tools/ai-aircraft.ts` converts each model with the same AC3D parser and
crease-angle smoothing as the Cessna (`tools/ac3d.ts`) and:

- merges every object into two meshes, `body` and `gear`, so the gear can be
  drawn only when it is down,
- drops light geometry, light cones, prop-blur discs and cockpit switches
  (the app draws its own lights),
- rotates into the app frame and re-centres X and Z on the airframe,
- stores the AC3D material colour per vertex, normals as int8
  (`KHR_mesh_quantization`), and no materials or images,
- re-encodes each livery atlas from PNG (or SGI `.rgb`, for the Challenger)
  to WebP at quality 72, at the source's 1024 px.

Shapes and paint are otherwise unmodified.

## Licence of the derived assets

The `.glb` files and `.webp` liveries are derived works of GPL-2.0 models and
are distributed under the same licence, **GPL-2.0**. The unmodified `.ac`
sources and livery PNGs are kept in `assets-src/fgdata-ai/`, mirroring the
upstream paths, as the preferred form for modification.

## Photos

The tap-to-expand card shows a photo from planespotters.net through
`/planes/api/photo`, credited to its photographer with a link back, as the
planespotters API terms require. Nothing from it is stored in this repo.
