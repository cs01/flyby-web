# Cloud rendering plan

Target: an overcast low deck seen from underneath. Today it renders as a flat
grey ceiling with terraced ripples, a row of beads along the horizon, and a
yellow line where the deck ends. All of it is in `src/render/composite.ts`.

## Diagnosis (what each defect IS, so the fix is not a guess)

1. Terraced ripples across the sky. They are iso-elevation arcs (constant
   `rd.y`). The 32 geometric steps are normalised to span the slab crossing
   `t0..t1`, and that crossing is `thickness / rd.y`, so step size is a smooth
   function of pixel elevation. The integral has discrete events (which step
   lands in the 120 m base ramp; when `through.g < 0.02` fires) and each event
   moves one step earlier as elevation changes: one band per event. The 2x2
   dither jitters within one step and cannot hide a band that is a whole
   step count wide. `composite.ts` GROWTH/norm/dt block.
2. Flat plaster ceiling. With cover near 1, `threshold = 0` and
   `smoothstep(0, 0.14, n)` is 1 nearly everywhere: uniform density, a
   mathematically flat base plane. `slabDensity`.
3. Beads along the horizon. Value-noise lattice (1.8 km cells at scale
   0.00055) seen at grazing angle with one sample per cell. Value noise is
   axis-aligned by construction.
4. Yellow line at the horizon. The range fade `smoothstep(400000, 200000, t)`
   thins the deck to transparent, so bare horizon sky shows through.

## Steps, in order. Each is one commit and each is visible on its own.

### 1. Repro and gate (first; nothing below is verifiable without it)

- `?wx=` URL override in `src/main.ts`, applied where `wx` is chosen
  (the `next = ...` line in the per-frame weather block AND the initial
  `let wx = observed`). Format:
  `?wx=low:0.95:900:2100,mid:0:3800:5000,high:0:8500:9400,precip:0`
  Each deck `cover:base:top`. Parse into a `Weather` by cloning `observed`
  and overwriting `low/mid/high/precip/totalCover/opacity`
  (`opacity` via the existing `beamOpacity`; export it from `weather.ts`).
  `source: "simulated"`. When `?wx` is present the timeline is ignored for
  cloud fields. Sun: `?at=` already exists; do not add a sun override.
- Band metric. In `src/render/composite.ts` add
  `measureBanding(renderer): { rows: number; cols: number; ratio: number }`
  that reads back the half-res cloud target (`readRenderTargetPixels`,
  HalfFloat: use `Float32Array` or convert), takes rows above the horizon
  (`cloud.a < 0.5` region, i.e. where cloud dominates), box-filters luminance
  at 8 half-res px, and returns mean |d/dy| (rows), mean |d/dx| (cols), and
  `rows / cols`. Cloud texture is roughly isotropic; terraces are row-aligned,
  so `ratio` well above 1 means banding. Expose as `window.__cloudMetric()`
  in `main.ts` (only when `?fps` is set) and print it in the perf panel row
  (`hud.setPerf` gets one extra arg: `banding: number`).
- Screenshot the repro URL BEFORE changing the shader, save to
  `docs/clouds-before.png`, and record `__cloudMetric()` and frame ms in the
  commit message. This number is the gate for steps 2 to 5.

### 2. Baked 3D noise textures instead of per-sample hash fbm

- New file `src/render/noise3d.ts`:
  `export function makeShapeNoise(): THREE.Data3DTexture` (64^3 RGBA8:
  R = 3-octave perlin, G/B/A = inverted worley at 1x/2x/4x cell frequency,
  all tileable) and `export function makeDetailNoise(): THREE.Data3DTexture`
  (32^3 RGB8, inverted worley at 3 frequencies, tileable). Generated on the
  CPU at construction, deterministic seed, `LinearFilter`, `RepeatWrapping`
  on all three axes, `needsUpdate = true`. Budget: under 30 ms total on a
  laptop; measure and put the number in a comment.
- Uniforms `uShape: sampler3D`, `uDetail: sampler3D` on the cloud material.
  `precision highp sampler3D;` in the fragment shader.
- `fbm()` and `valueNoise()`/`hash13()` are removed from the cloud pass once
  nothing references them. The cirrus veil keeps using a 2D slice of
  `uShape` (fixed z) instead of `fbm`.
- Perlin-Worley combine in GLSL:
  `float shape = remap(tex.r, -(1.0 - wfbm), 1.0, 0.0, 1.0)` where
  `wfbm = tex.g*0.625 + tex.b*0.25 + tex.a*0.125` (the Nubis/Schneider
  formulation). `remap(v, lo, hi, nlo, nhi)` helper.

### 3. Density with structure under 100% cover

`slabDensity(p, cover, base, top, scale)` becomes:

- Weather field `w = texture(uShape, vec3(p.xz * scale * 0.25, 0.37)).r`
  (one tap, low frequency, fixed y). Drives three things:
  - `localCover = cover * (0.8 + 0.4 * w)` clamped to 0..1
  - `localBase = base + 0.15 * thickness * (w - 0.5)`: the base is no longer
    a plane
  - `localTop = top + 0.25 * thickness * (w - 0.5)`
- `h = (p.y - localBase) / (localTop - localBase)`, reject outside 0..1.
- Height profile: base ramp is `smoothstep(0.0, 0.2, h)` (a fraction of
  thickness, not a fixed 120 m) times `smoothstep(1.0, 0.6, h)`.
- `shape` from the 3D texture at `(p + wind*time) * scale`, then
  `d = remap(shape, 1.0 - localCover, 1.0, 0.0, 1.0) * profile`.
- Edge erosion only where it shows: if `d < 0.3`, sample `uDetail` at
  `p * scale * 6.0` and `d = remap(d, detail * 0.35, 1.0, 0.0, 1.0)`. One
  extra tap, edges only.
- Coverage remains a THRESHOLD. Keep the existing comment explaining why.

### 4. March whose step size does not depend on elevation

Replace the GROWTH/norm block:

- `float thick = slabHi - slabLo; float dt0 = thick / 24.0;`
- Step size grows with distance from the camera only:
  `dt = dt0 * max(1.0, t / 6000.0)`. Never normalised to `t1 - t0`.
- `const int STEPS = 64;` early out on `through.g < 0.02` and `t > t1`.
  `t1 = min(sceneDist, 120000.0)`; distance fade now blends to haze
  (step 5) so the far clip is not visible.
- Empty-space skipping: while the last sample had `dens == 0`, advance by
  `3.0 * dt`; on the first non-zero sample, step back `2.0 * dt` and resume
  single steps. A thin `bool coarse` state in the loop. This is what keeps
  broken decks cheap.
- Keep the 2x2 Bayer + IGN start jitter and the tent upsample unchanged;
  keep the comments that explain them.
- Light march: keep 3 steps but grow them (`LIGHT_STEP * (1.5^j)`), and add
  the analytic thickness term in step 5.

### 5. Lighting of a deck seen from underneath

- Sun transmittance = light-march term * `exp(-SIGMA_LIGHT * dens * (localTop - p.y) * 0.5)`.
  The second factor makes base brightness track local thickness: thin spots
  glow, thick spots go dark. This is what makes an overcast mottled.
- Ambient with a vertical gradient:
  `vec3 amb = mix(uAmbient * 0.45, uAmbient * 1.1, h)` replaces the flat
  `uAmbient * 0.9`. Bases darker than tops.
- Distance: fold the cloud sample colour toward the horizon haze. Use the
  atmosphere GLSL already compiled in:
  once per pixel compute `vec3 hazeT; vec3 haze = atmosphere(atmoOrigin(uCamAltitude), rd, 1e9, hazeT)`
  (check the signature in `atmosphere.glsl.ts`; `rayGround` handles the
  below-horizon case). Then per sample
  `lum = mix(lum, haze, smoothstep(20000.0, 120000.0, t))`, and the density
  fade `smoothstep(400000, 200000, t)` is REMOVED: the deck no longer
  disappears, it dissolves into haze colour, which is what removes the
  yellow line.
- Powder term and phase function stay as they are.

### 6. Cost check

Half-res stays. On the overcast repro at 1080p, frame ms must not exceed
the pre-change number by more than 20%, and `AdaptiveQuality` must not
drop a tier that it did not drop before. Report both numbers.

## Verification, every step

- `bun run check` green.
- `bun run dev`, open `http://localhost:5173/?city=<x>&fps&wx=low:0.95:900:2100,mid:0:3800:5000,high:0:8500:9400`
  with the aircraft under the deck. Screenshot to `docs/clouds-after.png`.
- Record `__cloudMetric().ratio` and ms before and after. Also check a
  scattered sky (`low:0.4`) and a clear sky (`low:0`) for regressions:
  clear must still cost near zero.

## Non-goals

Temporal reprojection. Shipping baked noise as an asset. Any change to
`sky.ts`, `lighting.ts`, or the deck derivation in `weather.ts` beyond
exporting `beamOpacity`.
