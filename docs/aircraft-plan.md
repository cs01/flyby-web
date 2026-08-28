# Photorealistic aircraft plan

Goal: the chase-cam aircraft reads as a photo of a white/navy Cessna 182
(see the two reference photos: white base, navy swoosh sweeping up from the
nose to the tail, N-number on the aft fuselage, wheel pants, 3-blade prop).

Why it looks like a cartoon today, by visual weight:
1. Silhouette: capsule + boxes. Slab wing, no wheel pants, no cowl, no fairings.
2. Shading: Lambert + camera-space Phong. No Fresnel, no sky/ground
   reflection, no self-shadow, no AO.
3. Edges: HDR target has no MSAA (canvas antialias is irrelevant offscreen).
4. Surface: flat colour, orange stripe, no livery.

## Steps, one commit each

0. Dev loop. `?pose=plane` freezes sim, fixes sun (afternoon, clear) and chase
   offset. Screenshot key writes a PNG. Before/after pairs in docs/. On-screen
   ms/frame. Gate: each step ships a pair and a frame time.
1. MSAA on the HDR target (`samples: 4`). Verify r180 resolves the depth
   texture for the cloud pass; if not, FXAA in the present pass instead.
   samples drop to 2 when AdaptiveQuality scale < 0.8.
2. PBR in aircraftmodel.ts, still RawShaderMaterial, still linear HDR:
   GGX + Schlick, per-part roughness/F0. Sky+terrain CubeCamera (128px,
   mipmapped) at the aircraft, refreshed every 10 frames (30 on low tier),
   sampled with textureLod by roughness. Ambient from the blurriest mip.
3. Self-shadow: ortho depth from sun dir, 12 m box, 1024 (512 low tier),
   3x3 PCF in the aircraft shader. Aircraft only.
4. Geometry: CC-BY/CC0 Cessna 172/182 glTF in public/aircraft/cessna.glb,
   GLTFLoader + Draco/meshopt. Discard its materials; assign shader by node
   name (paint/glass/rubber/chrome). Map prop, ailerons, elevator to nodes so
   update(dt, throttle, roll, pitch) and main.ts are unchanged. Scale to
   11.0 m span. Attribution in README and menu.
   Asset requirements: glTF/glb, < 100k tris, separate nodes for prop,
   ailerons, elevator, glass. Wheel pants preferred.
5. Livery: runtime CanvasTexture 2048^2 in the asset's UV space. White base,
   navy swoosh, N-number, black anti-glare on cowl top, faint panel lines,
   red/white tail tip. Match the photos.
6. Glass: dark tinted interior, strong Fresnel cube reflection. Simple
   interior (panel, two seat backs, yoke) so the cabin is not a black void.
7. Prop: blurred 3-blade disc texture with bright tip ring, alpha ~0.2,
   rotating. Cross-fade to modelled blades below ~30 % throttle.
8. Details: per-vertex AO baked by a tools/ script against the glb; fin
   strobe (1 Hz double flash) and red beacon; longer chase distance /
   narrower FOV so the 62 deg lens stops bloating the nose.

## Perf
No fixed budget. Each new pass has a low-tier setting (above) so the
adaptive scaler gets cheaper work instead of fewer pixels. Step 0's frame
time readout is the gate; a step that costs more than ~1.5 ms at scale 1
gets its low-tier setting made the default.

## Blocked on user
Step 4 needs the glb downloaded (Sketchfab requires a login). Steps 0-3
and 7 proceed on the current primitives.
