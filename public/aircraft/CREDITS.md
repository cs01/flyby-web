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
