// The ground: nested LOD rings meshed from the heightfield and draped with
// satellite imagery.
//
// Three concentric rings rather than a quadtree. The scene is bounded (a city
// and its surroundings, not a planet), so LOD can be decided ONCE at load from
// distance-to-centre instead of re-evaluated per frame against the camera. That
// removes the entire class of bugs where a quadtree re-splits mid-flight and
// pops, and it costs nothing: the rings total ~140k vertices, which a phone
// draws without noticing.
//
// Ring boundaries crack, because the coarse side samples the height field at a
// different rate than the fine side. The fix is skirts: every ring edge drops a
// vertical curtain 400 m straight down. It is invisible from above (the drape
// continues over it) and it is the standard fix precisely because trying to
// stitch matching edge vertices between levels is a nightmare that fails the
// moment either level changes.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import type { Heightfield } from "../data/dem";
import type { StitchedImage } from "../data/imagery";
import { Origin } from "../geo";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
import { GROUND_BOUNCE_GLSL, groundBounceUniforms, type GroundBounceUniforms } from "./groundbounce";
import { SH_GLSL, shHemispherical } from "./sh";
import { AO_GLSL, aoUniforms, type AoUniforms } from "./ao";
// The ring plan and the choice between plans live in render/budget.ts, with
// every other number the device tier decides.
import { CITY_RINGS, type TerrainRing } from "./budget";
import { WATER_SSR_GLSL, WATER_SSR_UNIFORMS, type WaterSsrUniforms } from "./waterssr";

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
in vec3 normal;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec3 uCameraPos;
out vec2 vUv;
out vec3 vNormal;
out vec3 vWorld;
out float vViewDist;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vWorld = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * The fixed wave set the water sums, as GLSL constant arrays.
 *
 * Fixed because a wavelength that varied with the local fetch shears the
 * phase (see THE WAVES ARE FIXED in the shader), and generated here rather
 * than derived per pixel because every term in it is a constant. Computing
 * them in the shader (a sin, cos, pow, sqrt and three hashes per wave per
 * water pixel) measured 12.03 ms mean on sydney-harbour with the scene
 * reflection off; this table measured 10.73 ms on the same frame.
 *
 * Geometric from 60 m down by 0.74 a step, jittered +-14% so no two are
 * harmonics: an exact ratio lines the crests up every few periods and the sum
 * shows as a regular lattice, which is what exact steps looked like from the
 * Chicago kerb. Long waves run with the wind and short ones spread round it,
 * which is what a real directional spread does and what keeps the chop from
 * reading as corduroy; signs are random rather than alternating, because two
 * waves at +a and -a sum to a diamond lattice.
 */
export const WAVE_N = 24;
function waveTableGlsl(): string {
  // mulberry32: deterministic, so the sea is the same sea on every build.
  let a = 0x2f6b9e1d;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const lnLam0: string[] = [];
  const k: string[] = [];
  const omega: string[] = [];
  const rot: string[] = [];
  const phase: string[] = [];
  for (let i = 0; i < WAVE_N; i++) {
    const lam0 = 60 * Math.pow(0.74, i);
    const lam = lam0 * (0.86 + 0.28 * rnd());
    const spread = (rnd() * 2 - 1) * (0.25 + (1.25 * i) / WAVE_N);
    const kk = (2 * Math.PI) / lam;
    lnLam0.push(Math.log(lam0).toFixed(6));
    k.push(kk.toFixed(6));
    omega.push(Math.sqrt(9.81 * kk).toFixed(6));
    rot.push(`vec2(${Math.cos(spread).toFixed(6)}, ${Math.sin(spread).toFixed(6)})`);
    phase.push((2 * Math.PI * rnd()).toFixed(6));
  }
  const arr = (type: string, name: string, v: string[]): string =>
    `const ${type} ${name}[${WAVE_N}] = ${type}[${WAVE_N}](${v.join(", ")});`;
  return [
    `#define WAVE_N ${WAVE_N}`,
    arr("float", "WAVE_LNLAM0", lnLam0),
    arr("float", "WAVE_K", k),
    arr("float", "WAVE_OMEGA", omega),
    arr("vec2", "WAVE_ROT", rot),
    arr("float", "WAVE_PHASE", phase),
  ].join("\n");
}

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vNormal;
in vec3 vWorld;
in float vViewDist;
out vec4 fragColor;

// Aerial perspective only: a shorter march than the sky uses. See the note in
// atmosphere.glsl.ts -- this is per-fragment with overdraw, and it is smooth.
#define ATMO_STEPS 7
#define ATMO_SUN_STEPS 2
${ATMOSPHERE_GLSL}
${TONEMAP_GLSL}
${SUN_SHADOW_GLSL}
${GROUND_BOUNCE_GLSL}
${SH_GLSL}
${AO_GLSL}
${WATER_SSR_GLSL}
${waveTableGlsl()}

uniform sampler2D uDrape;
uniform vec3  uCameraPos;
uniform vec3  uAmbient;
uniform float uWetness;
uniform float uSnow;
uniform float uNight;
uniform float uSunSurface;
uniform float uDebug;
uniform vec3 uNightGlow;
uniform vec3 uMoonDir;
// Moon colour * intensity, in the same units as uSunColor * uSunIntensity, so
// it converts to surface irradiance through the same uSunSurface.
uniform vec3 uMoonLight;
// Baked ESA WorldCover coverage: R water, G built, B tree, A herbaceous.
// Two levels, for the same reason the terrain has rings: 10 m over the city,
// ~137 m out to the horizon.
uniform sampler2D uLandNear;
uniform sampler2D uLandFar;
uniform float uLandNearExtent;
uniform float uLandFarExtent;
uniform float uHasLand;
// Distance from water to the nearest land, sqrt-encoded against 4 km (near) and
// 40 km (far); see encodeShoreDistance in data/landmask.ts.
uniform sampler2D uShoreNear;
uniform sampler2D uShoreFar;
// Coverage grid over the baked road centrelines; see render/roadmask.ts.
uniform sampler2D uRoadMask;
uniform float uRoadMaskExtent;
uniform float uHasRoadMask;
// Scene clock, seconds. Held at zero in shot mode, which is what keeps a
// screenshot of moving water reproducible.
uniform float uTime;
// Wind at 10 m, metres/second, as (east, south) -- the same convention and the
// same observation render/composite.ts drifts the clouds with. The waves take
// both their steepness and their drift from it.
uniform vec2 uWind;
// 1 restores the pre-wave water: terrain normal, constant ambient reflection,
// no glint. It exists so tools/verify-water.ts can run the OLD behaviour in the
// SAME binary and prove its assertions can fail.
uniform float uFlatWater;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Bilinear value noise on the world's own metre grid. */
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

/**
 * GGX specular on water, returned as the factor a light's surface irradiance is
 * multiplied by. Fresnel is INSIDE it (F0 = 0.02, water), so the caller must not
 * apply the sheet Fresnel to it again.
 *
 * Why a microfacet lobe and not the Blinn power this replaces: a glitter path
 * is a strip of surface whose facets happen to be tilted toward the sun, and
 * its WIDTH is set by how steep the chop is. GGX takes that steepness as its
 * roughness and gets both the width and the long tail right; a fixed exponent
 * has one width forever, so it draws the same small hard dot on a millpond and
 * in a gale.
 */
float waterGGX(vec3 nrm, vec3 v, vec3 l, float alpha) {
  float nl = dot(nrm, l);
  if (nl <= 0.0) return 0.0;
  vec3 h = normalize(v + l);
  float nh = max(dot(nrm, h), 0.0);
  float nv = max(dot(nrm, v), 1e-3);
  float a2 = alpha * alpha;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * d * d + 1e-8);
  float k = alpha * 0.5;
  float G = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  // Clamped, because D goes to a2 / (PI * a2 * a2) as alpha shrinks: a near
  // mirror puts thousands of units of radiance into one pixel and the bloom
  // pass spreads that firefly across a quarter of the frame.
  return min(D * G * F / (4.0 * nv), 40.0);
}

void main() {
  vec3 albedo = srgbToLinear(texture(uDrape, vUv).rgb);
  vec3 n = normalize(vNormal);

  // Landcover, sampled once and used by both the water term and the night
  // lighting. Near level inside its own extent, far level outside, crossfaded
  // over the last tenth of the near extent: a hard switch would draw the near
  // grid's 12 km square onto the ground as a visible edge, since the two levels
  // disagree by a texel or two along any coastline they share.
  vec2 lcUvN = vWorld.xz / (2.0 * uLandNearExtent) + 0.5;
  vec2 lcUvF = vWorld.xz / (2.0 * uLandFarExtent) + 0.5;
  // Chebyshev distance, not Euclidean: the near grid is a SQUARE, so this is
  // the distance to the edge that actually runs out of data.
  float lcR = max(abs(vWorld.x), abs(vWorld.z)) / max(1.0, uLandNearExtent);
  vec4 lc = mix(texture(uLandNear, lcUvN), texture(uLandFar, lcUvF),
                smoothstep(0.9, 1.0, lcR));
  float lcWater = lc.r;
  float lcBuilt = lc.g;
  // Roads, which the landcover cannot see. WorldCover is a 10 m posting and a
  // suburban street plus its verges is one texel of it, classified by whatever
  // dominates: in a leafy suburb that is lawn, so the measurement paints grass
  // over the tarmac and up to and over the kerb. The road pack knows where the
  // carriageway is to within a metre, so it vetoes the herbaceous channel.
  //
  // Herbaceous ONLY. Canopy still applies over a road (a street under trees is
  // shaded by them), water still applies (a road on a causeway does not drain
  // the bay), and built is what a road is.
  vec2 rmUv = vWorld.xz / (2.0 * uRoadMaskExtent) + 0.5;
  // The same guard the urban mask uses: clamp-to-edge would smear the border
  // texel, and roads reach the edge of the pack, so the border texel is not
  // zero and the smear would be a stripe of dead grass out to the horizon.
  float roadCov = texture(uRoadMask, rmUv).r * uHasRoadMask
                * step(0.0, rmUv.x) * step(rmUv.x, 1.0)
                * step(0.0, rmUv.y) * step(rmUv.y, 1.0);

  // Ground vegetation, from the two channels that exist to describe it. This
  // is what stops Central Park being green paint: the drape carries the right
  // large-scale pattern (mown against rough, the shadow of a stand of trees)
  // but at 0.47 m per pixel at its very best it is a blur with no material in
  // it, and every earlier attempt at "make the parks greener" was a uniform
  // tint that made a car park green too.
  //
  // It MODULATES the drape rather than replacing it. Luminance is kept, so a
  // lawn in the sun stays brighter than one in a photographed shadow, and only
  // the chroma and the fine structure come from here.
  float herb = lc.a * uHasLand * (1.0 - roadCov);
  float canopy = lc.b * uHasLand;
  float veg = clamp(herb + canopy, 0.0, 1.0);
  if (veg > 0.004) {
    // Two distance gates, and the tighter one matters more than it looks.
    //
    // A procedural noise has no mip chain, so every octave aliases the moment
    // its period drops under a pixel. The first version of this ran a 0.8 m
    // octave out to a kilometre and turned a Californian hillside into
    // high-contrast leopard print: from 200 m up, that period is two pixels.
    // So the fine octave only exists within a couple of hundred metres, where
    // it has pixels to be made of, and the coarse one carries everything else.
    float detail = smoothstep(2600.0, 700.0, vViewDist);
    float closeUp = smoothstep(300.0, 80.0, vViewDist);

    // Clumps at ~8 m, which is what you actually see of rough grass from the
    // air, and blade-cluster texture at ~1.6 m for the last few hundred feet.
    //
    // TWO octaves for the clump, not one, and the second is not a harmonic of
    // the first. A single value noise is built on a square lattice and at 12%
    // amplitude it reads as a regular field of DOTS, which is worse than the
    // blur it replaced; an incommensurate second octave breaks the lattice up
    // for one extra lookup.
    float clump = vnoise2(vWorld.xz * 0.13) * 0.60
                + vnoise2(vWorld.xz * 0.047 + vec2(17.3, 5.1)) * 0.40;
    float fine = closeUp > 0.0 ? vnoise2(vWorld.xz * 0.62) : 0.5;
    float tuft = mix(mix(0.5, clump, detail * 0.8), fine, closeUp * 0.35);

    // SATURATE the drape's own colour; do not replace it. The satellite carries
    // the season and this mask does not: WorldCover calls a Californian hill
    // "grass" in June when it is straw gold, and an earlier version of this
    // block that mixed toward chlorophyll painted the whole peninsula spring
    // green. So the measurement decides how much MATERIAL a texel has and the
    // drape decides what colour it is.
    float lum = dot(albedo, vec3(0.299, 0.587, 0.114));
    vec3 vegCol = vec3(lum) + (albedo - vec3(lum)) * (1.0 + 0.75 * veg);
    // Clump variation, mostly in value with a little hue wobble, so a lawn is
    // not one flat colour. This is the part the drape genuinely cannot supply:
    // at 0.47 m a pixel it has no structure below a couple of metres.
    vegCol *= 0.91 + 0.18 * tuft;
    vegCol.g *= 1.0 + (tuft - 0.5) * 0.10 * veg;
    albedo = mix(albedo, vegCol, veg * (0.45 + 0.40 * detail));

    // --- and WITHIN A FEW METRES, stop showing a photograph of grass ------
    //
    // Everything above modulates the drape, which is the right answer from the
    // air and the wrong one from a footpath. The imagery is 0.47 m a pixel at
    // its very best and several metres a pixel away from the start point, so
    // standing on a lawn you are looking at a photo with nothing in it: a
    // smear of green and orange blobs a metre across. No amount of saturating
    // that makes it grass, because the structure is not there to saturate.
    //
    // So inside grassNear the drape stops deciding the colour and starts
    // deciding only the TONE. Chlorophyll green, mixed by how much herbaceous
    // cover the measurement says is there, modulated by the drape's own
    // luminance so a mown strip stays lighter than the rough beside it and a
    // photographed shadow stays a shadow. That is the part of the imagery that
    // survives at this range; the hue is not.
    //
    // This is deliberately NOT what the block above does, and the distinction
    // is the whole reason both exist. Mixing toward chlorophyll at ALL
    // distances is what once painted the entire peninsula spring green, since
    // WorldCover calls a Californian hill "grass" in June when it is straw
    // gold. From two metres that failure cannot happen: you can see what is
    // under your feet, and it is either grass or it is not.
    // TWO TIERS, and they are not the same job.
    //
    // The HUE has to reach much further than the structure does. A lawn two
    // hundred metres off is still unmistakably green, but the 9 cm blade noise
    // that makes it read as grass at arm's length has no pixels to live in out
    // there and would alias into a shimmering rash. So the colour runs out to
    // a couple of hundred metres and the blades stop at seventy, which is what
    // removes the band of orange smear that a single gate leaves across the
    // middle of a park.
    float grassFar = smoothstep(260.0, 60.0, vViewDist);
    float grassNear = smoothstep(70.0, 14.0, vViewDist);
    if (grassFar > 0.001 && herb > 0.05) {
      // Blades at ~9 cm and clumps at ~45 cm. Two scales, because a lawn read
      // from a metre away has both and one alone reads as noise. The blade
      // octave is faded out with the near gate rather than switched off, so it
      // dissolves instead of ending on a line.
      float blade = grassNear > 0.0 ? vnoise2(vWorld.xz * 11.0) : 0.5;
      float clod  = vnoise2(vWorld.xz * 2.2 + vec2(4.7, 9.1));
      float g = mix(clod, 0.62 * blade + 0.38 * clod, grassNear);

      // A real lawn is not one green. It runs from a yellow-green in the sun
      // to a blue-green in the thatch, and that spread is most of what makes
      // it read as living material rather than as paint.
      vec3 dry  = vec3(0.145, 0.132, 0.052);
      vec3 lush = vec3(0.048, 0.098, 0.032);
      vec3 grass = mix(dry, lush, smoothstep(0.25, 0.80, clod));
      grass *= 0.72 + 0.56 * g;

      // Keep the drape's tone: lum is its luminance before any of this, so a
      // path worn through the grass, a shadow and a bare patch all survive.
      float shade = clamp(lum / 0.16, 0.45, 1.7);
      grass *= shade;

      albedo = mix(albedo, grass, herb * min(0.88, 0.52 * grassFar + 0.36 * grassNear));

      // And it has to catch the light like grass, not like tarmac painted
      // green. The normal wobble is small on purpose: at 9 cm a strong one is
      // a field of hard dots the moment the period drops under a pixel.
      if (grassNear > 0.0) {
        const float GE = 0.06;
        float gx = vnoise2((vWorld.xz + vec2(GE, 0.0)) * 11.0)
                 - vnoise2((vWorld.xz - vec2(GE, 0.0)) * 11.0);
        float gz = vnoise2((vWorld.xz + vec2(0.0, GE)) * 11.0)
                 - vnoise2((vWorld.xz - vec2(0.0, GE)) * 11.0);
        n = normalize(n + vec3(-gx, 0.0, -gz) * 0.55 * herb * grassNear);
      }
    }

    // Under a canopy the floor is genuinely dark, and the dapple stands in for
    // the crown shadows the instanced trees stop drawing past their own fade.
    // The handoff between the two is what keeps a forest reading as a forest
    // all the way to the horizon instead of ending in a ring.
    albedo *= 1.0 - canopy * (0.26 + 0.24 * (1.0 - tuft) * detail);

    // A detail normal, so grass catches the sun rather than being a flat
    // surface with a green photograph on it. Central differences of the same
    // fine octave: four more lookups, on the same tight gate, for the same
    // reason. A bump whose period is under a pixel is not texture, it is noise
    // that swims when the camera moves.
    if (closeUp > 0.0 && herb > 0.03) {
      const float E = 0.55;
      float hx = vnoise2((vWorld.xz + vec2(E, 0.0)) * 0.62)
               - vnoise2((vWorld.xz - vec2(E, 0.0)) * 0.62);
      float hz = vnoise2((vWorld.xz + vec2(0.0, E)) * 0.62)
               - vnoise2((vWorld.xz - vec2(0.0, E)) * 0.62);
      // 0.12, and the number matters more than it looks. hx and hz are the
      // difference of two noise samples about a metre apart, so they reach
      // ~0.6; at 0.55 that tilts the ground by nearly twenty degrees and under
      // a low sun the hillside came out as a field of hard dark dots. This is
      // a few degrees of shading variation, which is what grass actually is.
      n = normalize(n + vec3(-hx, 0.0, -hz) * 0.12 * herb * closeUp);
    }
  }

  // Snow settles on flat ground and slides off anything steep. The slope test
  // is what keeps a snowy city from looking like it was dipped in paint.
  float flat_ = smoothstep(0.55, 0.85, n.y);
  albedo = mix(albedo, vec3(0.92, 0.94, 0.98), uSnow * flat_);

  // Wet ground is darker and shinier. Both, or it reads as mud.
  albedo *= (1.0 - 0.42 * uWetness);

  // Night flattening applies to ALL ground, not just built-up ground.
  //
  // This used to live down in the skyglow block, multiplied by the urban mask,
  // which conflated two different things: light a city ADDS to its surroundings
  // is genuinely urban-only, but a dark-adapted eye taking almost no colour or
  // texture off a surface is a property of the eye and applies everywhere.
  //
  // The visible result was San Francisco at night with the Presidio and the
  // western hills glowing sand-tan, brighter than the lit city beside them:
  // unbuilt ground kept its full daytime drape albedo, and moonlight on a
  // bright hillside beat street lighting. It read as a desert.
  float nightGrey = dot(albedo, vec3(0.299, 0.587, 0.114));
  nightGrey = mix(0.30, nightGrey, 0.40);
  albedo = mix(albedo, mix(vec3(nightGrey), albedo, 0.12), uNight);

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  // uSunIntensity is the scale the ATMOSPHERE integral wants: it gets multiplied
  // by scattering coefficients of order 1e-5, so it is ~16 and that is correct
  // there. uSunSurface converts it to the irradiance a surface receives.
  //
  // It is not 1/PI. A true 1/PI puts direct at ~4.3, which saturates the tone
  // curve to flat white on its own -- measured, by rendering the direct term by
  // itself. The value below is what makes a mid-albedo surface land in the
  // middle of the curve while leaving inscatter at the level the same
  // atmosphere produces, so aerial perspective stays proportionate.
  // Cascaded shadow map, on the DIRECT beam only. The ambient sky term below is
  // deliberately untouched: ground in the shadow of a tower is still under the
  // whole sky dome, and zeroing that is what turns a shadow into a black hole.
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl * sunVis;

  // Moonlight. The one thing that makes a night flight over open country
  // something other than a black frame: the street-lamp mask only covers
  // built-up ground, so without this a coastline, a river or a ridge line
  // outside the city simply is not there.
  float mndl = max(0.0, dot(n, uMoonDir));
  vec3 moonBeam = uMoonLight * uSunSurface * mndl;
  vec3 beam = direct + moonBeam;

  // Sky irradiance, from the scene probe. This is the whole reason a valley
  // floor is darker than a ridge and, more than that, the reason a slope facing
  // the sunset is warm while the one behind it is blue: the nine coefficients
  // carry the sky's actual distribution, which the hemispherical constant this
  // replaces could not express at all -- it had no azimuth in it.
  // Screen-space sky occlusion, on the SKY term alone. The bent normal is
  // what makes it read as enclosure rather than as dirt: ground at the foot of
  // a tower gets the light from the strip of sky it can actually see instead
  // of a dimmed average of the whole dome. The direct beam above is untouched
  // -- multiplying sunlight by a screen-space term is what produces dark
  // smears that swim with the camera.
  vec3 ambient = occludedSkyIrradiance(n);

  // BOUNCE OFF THE WALLS. Most of the black canyon floor a user reported is
  // this shader, not the carriageway: the drape covers everything either side
  // of the tarmac and the kerbs, and it lost the sky to the same towers. The
  // term and its two weights live in render/groundbounce.ts, shared with
  // render/roads.ts and render/pavement.ts.
  //
  // The built-ness weight is the union the night lighting below already uses:
  // footprints where a .city pack has them, WorldCover's built class
  // everywhere else. That is what confines this to streets -- a ridge line and
  // a forest cast a shadow too, and neither is a sunlit wall.
  vec3 bounce = canyonBounce(uSunColor * uSunIntensity * uSunSurface * sunT, ambient, sunVis,
                             uSunDir, max(builtness(vWorld), lcBuilt * uHasLand));

  vec3 lit = albedo * (beam + ambient + bounce);

  // Specular sheen on wet ground, and always on water (which the drape shows
  // as dark blue; using luminance as a water proxy is crude but it is right
  // far more often than it is wrong, and it costs one texture read).
  // Water is identified by ELEVATION, not by colour.
  //
  // The obvious test -- "this pixel is dark, so it is water" -- does not work
  // on real satellite imagery: Esri's ocean is a mid blue-grey well above any
  // threshold that excludes dark roofs and shadowed streets, so the test never
  // fired and the sea rendered as flat lit ground. Elevation is unambiguous
  // here because the DEM decoder clamps everything below sea level to exactly
  // zero, which makes open water a plateau at 0 m. The soft ramp gives a
  // natural shoreline, since a 30 m DEM posting interpolates across the coast.
  // Water: elevation FIRST, appearance as a backstop.
  //
  // Elevation alone is not enough. The DEM carries small positive values in
  // patches out on open water, and where that lifted a patch above the
  // threshold it was shaded as LAND -- using the drape's near-black water
  // pixels, which lights to roughly a tenth of the Fresnel water all around it.
  // The result was dark angular holes lying in the middle of the Hudson.
  //
  // So a second test runs alongside: ground that is BOTH low and dark in the
  // imagery is water too. Neither test alone is reliable (open water is not
  // always exactly zero, and dark low ground is sometimes a car park), but a
  // patch has to fail both to be mistaken for land.
  //
  // ALL OF THAT IS NOW THE FALLBACK. Both tests are anchored to SEA LEVEL, so
  // any water above it is invisible to them: Lake Michigan's surface is at
  // 176 m, and Chicago's entire lakefront shaded as lit land. Where a .land
  // pack exists the measured landcover REPLACES the heuristic outright rather
  // than joining it, because a union can only ever add water, and half the
  // gain here is removing the heuristic's false positives (a dark car park, a
  // shadowed street) that no amount of extra evidence could take back.
  float lumA = dot(albedo, vec3(0.299, 0.587, 0.114));
  float byElevation = smoothstep(3.5, 0.4, vWorld.y);
  float byAppearance = smoothstep(0.26, 0.07, lumA) * smoothstep(7.0, 1.0, vWorld.y);
  float heur = clamp(max(byElevation, byAppearance), 0.0, 1.0);
  float water = mix(heur, lcWater, uHasLand);
  vec3 v = normalize(uCameraPos - vWorld);

  // --- THE SURFACE OF THE WATER -------------------------------------------
  //
  // The Fresnel term below needs a normal that is not the terrain's. Over water
  // the heightfield is a plateau, so every pixel of a river shares ONE normal
  // and therefore one Fresnel factor: standing on the kerb beside the Chicago
  // river that factor is ~1 across the whole surface, and the river renders as
  // a single blown-out slab of paper. Water reads as water because its normal
  // varies from facet to facet, and nothing else in this shader supplies that.
  //
  // A SEA STATE, not a texture. A directional sum of travelling waves whose
  // longest wavelength, slope budget and direction come from the wind and the
  // fetch, each moving at its own deep-water speed (omega = sqrt(g k)), so a
  // long wave overtakes the chop riding on it the way it does on real water.
  // Isotropic noise scrolled downwind, which this replaces, has no wavelength
  // and no direction: it reads as a texture sliding over a plane at every
  // range, which is exactly the "flat glassy gradient" it was reported as.
  vec3 wn = n;
  float waveAlpha = 0.0;
  // How much of the frame's whitecap is foam (0..1), and how far up a crest
  // this pixel sits in units of the resolved sea's rms (for the subsurface
  // glow). Both stay at their calm values under ?flatwater.
  float foam = 0.0;
  float crestN = 0.0;
  float waveRes = 0.0;
  // Rms slope the waves left UNRESOLVED at this pixel, along one direction.
  float sigV = 0.0;
  float waterSure = 0.0;
  float shoreD = 1e4;
  float dbgSsr = 0.0;
  float fetchM = 1e4;
  float lamP = 1.0;
  // Derivatives OUTSIDE the branch: inside non-uniform control flow they are
  // undefined, and on the GPUs where that bites the waves go to static along
  // the water's edge, exactly where the branch changes from pixel to pixel.
  vec2 wdx = dFdx(vWorld.xz);
  vec2 wdy = dFdy(vWorld.xz);
  float pxFoot = max(length(wdx), length(wdy)) + 1e-4;
  vec2 duvx = dFdx(vUv);
  vec2 duvy = dFdy(vUv);
  if (water > 0.01 && uFlatWater < 0.5) {
    // Fetch, from the distance to the nearest coast. The fetch that matters is
    // the upwind one, which one distance cannot give; four times the nearest
    // coast is about what a point in a round bay sees across it, and the 200 m
    // floor is the channel a river or a harbour arm has along its own length.
    float sN = texture(uShoreNear, lcUvN).r;
    float sF = texture(uShoreFar, lcUvF).r;
    shoreD = mix(sN * sN * 4000.0, sF * sF * 40000.0, smoothstep(0.9, 1.0, lcR));
    // No pack: no measurement, so assume a harbour rather than a river or an
    // ocean, the middle of what the elevation heuristic finds.
    shoreD = mix(400.0, shoreD, uHasLand);
    fetchM = 4.0 * shoreD + 200.0;

    // Wind at 10 m, clamped below at half a metre a second: a true calm is a
    // mirror, and there is always some air moving over a city.
    float U = clamp(length(uWind), 0.5, 25.0);
    vec2 wdir = length(uWind) > 0.01 ? normalize(uWind) : vec2(1.0, 0.0);

    // GUSTS AND SLICKS. From a few hundred metres up every wind wave is
    // sub-pixel, and what is left to see on real water is that the roughness
    // is not uniform: cat's paws where a gust touches down, glassy slicks
    // between, all streaked along the wind. That is what gives open water its
    // scale from the air, and it is low-frequency, so it cannot alias. The
    // finer octave fades with the footprint for the same reason every wave
    // below does.
    vec2 qa = vec2(dot(vWorld.xz, wdir), dot(vWorld.xz, vec2(-wdir.y, wdir.x)));
    float g1 = vnoise2((qa - vec2(U * 0.55 * uTime, 0.0)) / vec2(560.0, 190.0));
    float g2 = vnoise2((qa - vec2(U * 0.75 * uTime, 0.0)) / vec2(170.0, 55.0) + vec2(7.3, 2.1));
    float gust = g1 * 0.6 + mix(0.5, g2, smoothstep(14.0, 4.0, pxFoot)) * 0.4;
    // Slope VARIANCE multiplier, mean ~1: the patches run from about a third
    // of the mean to about twice it, which is the contrast a slick has.
    float rough = 0.30 + 1.40 * smoothstep(0.15, 0.85, gust);

    // Mean square slope, Cox and Munk's clean-surface fit (0.003 + 5.12e-3 U),
    // shortened by the fetch: a sheltered river under the same wind is far
    // calmer than the bay it runs into.
    float fetchK = fetchM / (fetchM + 800.0);
    float mss = (0.003 + 0.00512 * U) * (0.6 + 0.4 * fetchK) * rough;

    // Peak wavelength. JONSWAP's fetch-limited peak (omega_p = 22 (g^2 / U F)^1/3),
    // capped at Pierson-Moskowitz's fully developed one (omega_p = 0.877 g / U).
    // Measured against the formula at 4 m/s: a 60 m river gives ~0.65 m, the
    // middle of SF bay ~5 m, open ocean caps at ~13 m.
    float omegaP = max(22.0 * pow(96.24 / (U * fetchM), 1.0 / 3.0), 0.877 * 9.81 / U);
    lamP = 6.2832 * 9.81 / (omegaP * omegaP);

    // THE WAVES ARE FIXED; THE SPECTRUM OVER THEM IS NOT. Every pixel sums the
    // same 24 wavelengths, 60 m down to 4 cm, in the same directions, and only
    // their AMPLITUDES follow the local wind and fetch. The first version let
    // the wavelengths themselves follow the fetch, and a phase k(x) * x whose
    // k varies in space has a gradient of k + x dk/dx: kilometres from the
    // origin, every kink in the shore distance became a seam of compressed
    // waves, ruled across Sydney harbour as dotted lines.
    //
    // The shape is Pierson-Moskowitz's low-frequency cutoff, exp(-1.25 (lam /
    // lamP)^2) in wavelength, over a saturation range with equal mean square
    // slope per log-band (a k^-3 elevation spectrum), with JONSWAP's peak
    // (gamma 3.3) on top. The peak matters more than it looks: the longest
    // waves are the only ones a camera a few hundred metres up resolves, and
    // without it each carried a twentieth of the slope and the sea read as
    // glass from there. Two more shares stand for the capillaries under the
    // shortest wave, which only ever go to the roughness.
    float lnLamP = log(lamP);
    float wv[WAVE_N];
    float wsum = 2.0;
    for (int i = 0; i < WAVE_N; i++) {
      float d = WAVE_LNLAM0[i] - lnLamP;
      float x2 = exp(2.0 * d);
      float lp = d / 0.3;
      wv[i] = exp(-1.25 * x2) * (1.0 + 2.3 * exp(-0.5 * lp * lp));
      wsum += wv[i];
    }
    float share = mss / wsum;
    float lostVar = 2.0 * share;
    float keptVar = 0.0;
    vec2 slope = vec2(0.0);
    float jac = 0.0;
    // The same crest sum over the dominant waves alone (those within a factor
    // of three of the peak, and longer): it is THEY that break. A whitecap
    // picked from the full sum lands on the crest of a 30 cm ripple and is a
    // speck; on the peak waves it is a patch metres across, which is what a
    // Beaufort 6 sea is covered in.
    float jacP = 0.0;
    float varPKept = 0.0;
    float varPAll = 1e-9;
    // Horizontal displacement of the water by the longer waves, fed into the
    // phase of every shorter one. Chop rides on swell: a short wave's crests
    // are pushed together on the long wave's front and pulled apart behind
    // it. Without this the short waves are a fixed interference pattern
    // sliding over the long ones, and from the kerb that read as a checker.
    vec2 warp = vec2(0.0);
    for (int i = 0; i < WAVE_N; i++) {
      float var = share * wv[i];
      // Above the peak there is nearly nothing; skipping it is most of the
      // loop on a river.
      if (wv[i] < 0.002) continue;
      float k = WAVE_K[i];
      vec2 R = WAVE_ROT[i];
      vec2 D = vec2(wdir.x * R.x - wdir.y * R.y, wdir.x * R.y + wdir.y * R.x);
      // Phase change per pixel ALONG this wave's own direction. The footprint
      // on water at a grazing angle is long down-range and narrow across it,
      // so a wave travelling across the view stays resolved several times
      // further out than one travelling toward the camera. An isotropic fwidth
      // throws that away and goes glassy at a third of the range.
      float dph = k * max(abs(dot(D, wdx)), abs(dot(D, wdy)));
      // Kept above eight pixels a wavelength, gone below four: the shading is
      // not linear in the normal (Fresnel, the glint lobe), so a wave just
      // over Nyquist still aliases once lit; at six it drew moire rings on
      // the Chicago foreground. Faded, not cut: a hard cutoff draws a ring on
      // the water at whatever range it fires. Under 4 cm (k > 157) the phase
      // loses float precision a few km from the origin, so those always go to
      // the roughness.
      float keep = k > 157.0 ? 0.0 : smoothstep(1.57, 0.785, dph);
      lostVar += var * (1.0 - keep * keep);
      bool dominant = WAVE_LNLAM0[i] > lnLamP - 1.05;
      if (dominant) varPAll += var;
      if (keep <= 0.0) continue;
      if (dominant) varPKept += var * keep * keep;
      keptVar += var * keep * keep;
      float s = sqrt(2.0 * var);
      float th = k * dot(D, vWorld.xz + warp) - WAVE_OMEGA[i] * uTime + WAVE_PHASE[i];
      float sk = s * keep;
      float cth = cos(th);
      slope += D * (sk * cth);
      float sth = sin(th);
      jac += sk * sth;
      if (dominant) jacP += sk * sth;
      // Amplitude is s / k; three times the Gerstner displacement, because
      // at a true one the chop is moved by a few percent of its own length
      // and the lattice survives. The amplitude follows the local spectrum,
      // so this warp varies in space only as smoothly as the fetch does.
      warp -= D * (3.0 * sk / k) * cth;
    }

    // Water is LEVEL. The terrain normal under it is whatever the heightfield's
    // noise made of a flat plateau, so the waves are hung off vertical and only
    // blend back to the ground's own normal where the water mask fades out at a
    // shoreline.
    vec3 flatN = normalize(mix(n, vec3(0.0, 1.0, 0.0), water));
    // The Gerstner term in y (0.6 of full steepness) sharpens crests and
    // flattens troughs, which is the trochoid profile real wind waves have and
    // a pure sum of sines does not.
    // Only on water the mask is sure of. The far landcover level is ~137 m a
    // texel and along a coast its ramp gives a hillside a partial weight; a
    // phase-exact wave field on a slope draws contour rings up it (seen on
    // the Marin headland). The shoreline ramp of the near level is a few
    // metres and loses nothing visible.
    float sure = smoothstep(0.5, 0.95, water);
    waterSure = sure;
    slope *= sure;
    jac *= sure;
    wn = normalize(flatN + vec3(-slope.x, -0.6 * jac, -slope.y));

    // WHERE THE FADED-OUT DETAIL GOES, and it does not go in the bin. Every
    // wave dropped for being sub-pixel hands its slope variance to the GGX
    // roughness: the same energy spread over a wider lobe, one soft bright
    // band instead of ten thousand aliasing points. For a Beckmann-like lobe
    // alpha^2 is the mean square slope. 0.0016 is the floor, alpha 0.04, the
    // long swell nothing here models.
    waveAlpha = clamp(sqrt(0.0016 + lostVar), 0.04, 0.42);
    sigV = sqrt(0.5 * lostVar);

    // How far up a crest this pixel is, in rms of what is resolved here.
    crestN = jac / sqrt(max(keptVar, 1e-6));

    // WHITECAPS. Coverage from Monahan's fit, W = 3.84e-6 U^3.41: 0.04% at
    // 4 m/s, 1% at 10, 4% at 15. Tripled, because the residual foam a breaker
    // leaves streaming behind it covers more than the breaker does. Fetch-
    // limited too: a river does not break whatever the wind.
    float W = min(0.30, 3.0 * 3.84e-6 * pow(U, 3.41)) * smoothstep(300.0, 3000.0, fetchM);
    // Near: the dominant crests that are high enough, in the wave GROUPS that
    // are breaking. Waves arrive in groups, and only the tallest few in a
    // group break: picking crests by height alone put a whitecap on the same
    // phase of every dominant wave, a regular lattice of white dots across
    // the bay. The group field is a fixed 30 m noise (never scaled by the
    // local peak wavelength, which would shear its phase the way the waves
    // once did) drifting downwind, open over about a third of the water, so
    // the crest threshold is the Gaussian tail holding W / 0.33 of the area
    // (t ~ 0.77 sqrt(-2 ln p), within 0.25 of the exact quantile between
    // 0.1% and 10%).
    float group = smoothstep(0.50, 0.72, vnoise2((qa - vec2(U * 0.5 * uTime, 0.0)) / vec2(34.0, 22.0) + vec2(5.7, 1.3)));
    float t = 0.77 * sqrt(-2.0 * log(clamp(W / 0.33, 1e-6, 0.5)));
    float crestP = jacP / sqrt(max(varPKept, 1e-9));
    float lace = vnoise2(qa / vec2(3.2, 1.6) - vec2(uTime * 0.4, 0.0)) * 0.6
               + vnoise2(qa / 0.9 + vec2(3.1, 9.4)) * 0.4;
    // Which crest in a group breaks is not decided by height alone (the wind
    // gusts, the current shears), and with only the three or four dominant
    // waves in the sum, height alone picks the same phase of each: dots on a
    // lattice. A 7 m noise added to the crest height (sd ~0.35 against the
    // crest's 1) jumbles which crests clear the bar without moving the bar.
    float jumble = vnoise2(qa / vec2(7.0, 4.0) + vec2(13.1, 7.7)) - 0.5;
    float near_ = smoothstep(t - 0.5, t + 0.3, crestP + 2.4 * jumble) * group
                * smoothstep(0.2, 0.6, lace);
    // Far: once the dominant crests are not resolved the foam is not either,
    // and what a pixel sees is the coverage itself, as a brighter tint. Which
    // applies is how much of the dominant waves' slope is still resolved.
    float resolved = smoothstep(0.25, 0.75, keptVar / (keptVar + lostVar));
    float resolvedP = smoothstep(0.3, 0.8, varPKept / varPAll);
    waveRes = resolved;
    foam = mix(W * 0.8, near_, resolvedP) * rough;

    // THE SHORE. A foam line where waves arrive at a coast, sized by the waves
    // that are arriving: none on a river, a broken line round a bay, a wide
    // surf band on an ocean beach. It surges in and out at the peak period.
    // The band is ~12 m and the landcover posting is 10 m, so where a pixel is
    // wider than the band it fades out rather than crawl along the coast.
    float surf = clamp(lamP / 6.0, 0.0, 1.0) * smoothstep(2.0, 6.0, U);
    float surge = 3.0 * sin(omegaP * 0.5 * uTime);
    float band = smoothstep(16.0, 4.0, shoreD + surge) * smoothstep(0.2, 0.7, lace + 0.15);
    foam = max(foam, band * surf * smoothstep(12.0, 3.0, pxFoot) * uHasLand);
    foam = clamp(foam, 0.0, 1.0);
  }

  // Wet ground gets the Blinn lobe below; open water gets its own GGX on the
  // wave normal and must not be lit twice. Under the flat-water probe the old
  // shared lobe comes back, because that is the behaviour being measured.
  float gloss = max(uWetness, water * uFlatWater);
  if (gloss > 0.01) {
    float shine = mix(48.0, 320.0, water);
    vec3 hv = normalize(v + uSunDir);
    float spec = pow(max(0.0, dot(n, hv)), shine);
    lit += uSunColor * uSunIntensity * uSunSurface * sunT * spec * gloss * 1.6 * sunVis;
    // The moon's own glitter path. Water at night is otherwise the darkest
    // thing in the frame, and the moonglade is the only thing that says which
    // part of that darkness is sea.
    vec3 hm = normalize(v + uMoonDir);
    float specM = pow(max(0.0, dot(n, hm)), shine);
    lit += uMoonLight * uSunSurface * specM * gloss * 1.6;
  }

  // Grass at a grazing angle goes pale and silvery: the blades are near
  // vertical, so a low view direction sees their sides and the whole sward
  // scatters forward. One power of a dot product, and it is the difference
  // between a lawn and a green plane.
  if (herb > 0.02) {
    float sheen = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 4.0);
    lit += ambient * albedo * sheen * herb * 0.85;
  }

  // Open water is not a dark diffuse surface. Its colour is almost entirely
  // FRESNEL: looking straight down it is nearly black (you see the 0.02
  // reflectance and a little subsurface blue-green), and at a grazing angle it
  // becomes a mirror of the sky. That angular swing is what makes water read as
  // water, and no amount of tinting a diffuse albedo reproduces it.
  if (water > 0.01) {
    // FRESNEL OVER THE FACETS THIS PIXEL CANNOT SEE. Where the waves are
    // sub-pixel the pixel is still made of tilted facets, and at a grazing
    // view the ones tilted toward the camera are the ones it sees, so the
    // mean reflectance falls well below the smooth-surface value. This is
    // Bruneton, Neyret and Holzschuch's fit (2010) of Fresnel averaged over a
    // Gaussian slope distribution of rms sigV; at sigV = 0 it is Schlick
    // exactly, so ?flatwater and resolved waves are unchanged. It is what
    // makes a gust darker than the slick beside it from a few hundred metres
    // up: the rough patch reflects less of the bright low sky.
    float cosV = clamp(dot(v, wn), 0.0, 1.0);
    float f = pow(1.0 - cosV, 5.0 * exp(-2.69 * sigV)) / (1.0 + 22.7 * pow(sigV, 1.5));
    float fres = 0.02 + 0.98 * f;
    vec3 deep = vec3(0.004, 0.016, 0.030) * (beam + ambient);

    vec3 skyRefl;
    vec3 glint = vec3(0.0);
    vec3 sss = vec3(0.0);
    if (uFlatWater > 0.5) {
      skyRefl = uAmbient * 1.7
              + uSunColor * uSunIntensity * uSunSurface * sunT * 0.10
              + uMoonLight * uSunSurface * 0.10;
    } else {
      // THE WATER'S OWN COLOUR, from the place. What comes back up out of the
      // water body is set by what is in it: SF bay is a turbid grey-green, the
      // Chicago river is green, Sydney harbour is a deep navy, a reef lagoon
      // is turquoise. A constant cannot be all of those, and the satellite
      // drape has already photographed which one this is, so the body colour
      // is the drape's, blurred (a mip bias) so a boat or a wake in the photo
      // does not become a stain. Less blur within a hundred metres of a coast,
      // or the blur reaches onto land and rims every shore in land colour;
      // that same sharpness is what lets a sandbar or a reef flat the camera
      // photographed show through as shallows. Capped, because some captures
      // have the sun's own glitter photographed into them.
      // The blur radius is 0.4 of the distance to the coast, so it can never
      // reach land, converted to a mip level through the drape's own metres
      // per texel at this pixel.
      vec2 tsz = vec2(textureSize(uDrape, 0));
      float texPerPx = max(length(duvx * tsz), length(duvy * tsz));
      float mPerTex = pxFoot / max(texPerPx, 1e-6);
      float blurM = clamp(shoreD * 0.4, 1.0, 400.0);
      float lodB = log2(max(blurM / mPerTex, 1.0));
      vec3 photo = srgbToLinear(textureLod(uDrape, vUv, lodB).rgb);
      // Wakes, sandbars at low tide and photographed glitter are all brighter
      // than the water around them; past 0.05 linear (sRGB ~63) the photo is
      // not water colour any more, so it is scaled back to that luminance
      // rather than clipped per channel, which would bleach its hue.
      float pl = dot(photo, vec3(0.2126, 0.7152, 0.0722));
      photo *= min(1.0, 0.05 / max(pl, 1e-5));
      // The photograph is reflectance seen from orbit, which includes the 2%
      // of sky the surface itself reflected; 0.6 of it is what came up out of
      // the water. Never darker than the old constant, so a drape with black
      // water (night captures exist) cannot dig a hole.
      vec3 body = max(photo * 0.6, vec3(0.004, 0.016, 0.030));
      deep = body * (beam + ambient);

      // THE SKY ALONG THE REFLECTED RAY, from the same integral the dome and
      // the aerial perspective already use. A constant ambient cannot express
      // what a mirror actually shows: the horizon-to-zenith gradient, the warm
      // half of the sky at sunset, the bright band low down that is most of why
      // a river is legible at all.
      vec3 r = reflect(-v, wn);
      // A steep facet can tip the reflected ray under the horizon, where the
      // march hits the ground and returns near-black. That is a hole in the
      // water, not a reflection: what real water shows there is the back of the
      // next wave, which is lit by the sky just above the horizon.
      // Masking does the same to the direction: the facets a grazing view
      // can see face it, so on average they send the ray higher, into
      // darker sky, by about the unresolved slope.
      r = normalize(vec3(r.x, max(r.y, 0.004) + 0.7 * sigV, r.z));

      // AND THE CITY ALONG IT. Water beside a 200 m tower mirrors the tower;
      // a sky-only reflection paints the sky where the tower should be, which
      // is the single most obviously wrong thing about water in a city. See
      // render/waterssr.ts for why this marches the previous frame.
      // Same rule as the waves: a partial-water hillside marched against
      // itself and drew stepped contour bands down its own face.
      vec4 ssr = waterSure > 0.01 ? waterSSR(vWorld, r, vViewDist, waveAlpha, 2.0 * sigV) : vec4(0.0);
      ssr.a *= waterSure;
      dbgSsr = ssr.a;

      // The sky march is the most expensive thing in this shader (measured,
      // see the git history of this block: ~1.3 ms on the harbour pose), so
      // it is skipped where the scene reflection covers the pixel outright.
      skyRefl = vec3(0.0);
      if (ssr.a < 0.999) {
        vec3 refTrans;
        skyRefl = atmosphere(atmoOrigin(max(0.0, vWorld.y)), r, 1.0e7, refTrans);
        // The integral is driven by the sun and goes to zero after dark, so
        // without these two terms water becomes the one black hole in a
        // moonlit frame.
        skyRefl += uMoonLight * uSunSurface * 0.10 + uAmbient * uNight * 0.35;
      }
      skyRefl = mix(skyRefl, ssr.rgb, ssr.a);

      // Sun glint. This is the term that says "water" when the sun is low: a
      // glitter path is thousands of facets each catching the disc, and the
      // roughness the wave slope hands the lobe is what sets how far up the
      // river it runs. Fresnel is inside waterGGX, so it is not applied here.
      glint = uSunColor * uSunIntensity * uSunSurface * sunT * sunVis
                * waterGGX(wn, v, uSunDir, waveAlpha)
            + uMoonLight * uSunSurface * waterGGX(wn, v, uMoonDir, waveAlpha);

      // LIGHT THROUGH THE CREST. Looking toward a low sun, the thin top of a
      // wave is lit from behind and glows the body colour, much brighter and
      // more saturated than the face beneath it. It needs the sun behind the
      // wave (view and sun on the same azimuth), a crest (where the water is
      // thin), and a low sun (a high one goes straight down and out of sight).
      // Where crests are not resolved the glow is their average, so it does not
      // switch off with range; it becomes a band of colour under the glitter.
      vec2 vh = normalize(-v.xz + 1e-5);
      vec2 lh = normalize(uSunDir.xz + 1e-5);
      float behind = pow(clamp(dot(vh, lh), 0.0, 1.0), 3.0);
      float lowSun = smoothstep(0.0, 0.08, uSunDir.y) * (1.0 - smoothstep(0.35, 0.8, uSunDir.y));
      float crest = mix(0.25, smoothstep(0.3, 2.0, crestN), waveRes);
      // The glow is the body colour pushed toward its own hue: the scattering
      // that made it that colour is happening through a thinner sheet.
      // Pulled a little toward the blue-green that clear water transmits,
      // since a turbid bay's grey is mostly what it reflects, not what it
      // passes.
      vec3 glowTint = mix(body / max(max(body.r, max(body.g, body.b)), 1e-4),
                          vec3(0.25, 0.85, 0.70), 0.35);
      sss = glowTint * uSunColor * uSunIntensity * uSunSurface * sunT * sunVis
          * behind * lowSun * crest * 0.11;
    }
    vec3 surface = mix(deep, skyRefl, fres) + glint + sss * (1.0 - fres);

    // Foam is a rough white scatterer lying ON the water: it takes the light
    // the way a snowfield does and hides the reflection and the glint under it.
    vec3 foamCol = vec3(0.78, 0.80, 0.80) * (beam + ambient);
    surface = mix(surface, foamCol, foam);
    lit = mix(lit, surface, water);
  }

  // City lights at night, keyed to how built-up the drape looks. Grey, bright
  // and low-saturation pixels are roads and roofs; vegetation and water are not.
  if (uNight > 0.01) {
    // Street lighting, gated by the URBAN MASK -- a coverage grid built from the
    // actual building footprints, not inferred from the daylight drape. The
    // drape cannot answer "is this built up": it is bright and desaturated over
    // beach, bare hill and runway alike, so every threshold either lit the whole
    // map or none of it.
    float urban = builtness(vWorld);

    // Union with the landcover's built class. Only a handful of cities have a
    // .city pack, and the rest were getting emptyUrbanMask() and rendering
    // pitch black after dark. WorldCover's built class is coarser than a
    // footprint grid (it cannot tell a tower from a bungalow) but it covers
    // everywhere, so the union is "footprints where we have them, measured
    // land use everywhere else".
    urban = max(urban, lcBuilt * uHasLand);

    // Night from the air is DISCRETE LIGHTS with black between them, not a lit
    // surface. Speckled on a ~26 m lattice with only a fraction of cells lit, so
    // the peak reads as a lamp while the average stays near black. Far away the
    // speckle converges to its own mean, or it would alias into crawling noise.
    // Lamps are POINTS inside their cell, not the whole cell.
    //
    // Filling the cell made a lattice of glowing rectangles -- from the air it
    // read as luminous paving rather than street lighting. A soft dot at a
    // jittered position within each chosen cell reads as a light, and the
    // jitter stops the grid itself from being visible.
    const float LAMP_SPACING = 30.0;
    const float LAMP_FRACTION = 0.22;
    // How tight the dot is. exp(-k d^2) integrates to pi/k over the cell for
    // any k this large, which is what keeps the far-field mean honest below.
    //
    // It used to be 18, and 18 is a blob 12 m across: from the air the city
    // read as a field of soft orange smudges rather than as lights. A lamp is
    // a POINT with a hot core -- the peak is deliberately over 1.0 so the tone
    // curve clips it to white, because that is what a light source does and it
    // is the difference between a lamp and a glowing patch of ground.
    const float LAMP_SHARP = 55.0;
    const float LAMP_PEAK = 3.05;   // energy-matched to the old soft kernel
    const float LAMP_MEAN = LAMP_FRACTION * LAMP_PEAK * (3.14159265 / LAMP_SHARP);

    float detail = smoothstep(4500.0, 900.0, vViewDist);
    vec2 g = vWorld.xz * (1.0 / LAMP_SPACING);
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float pick = hash21(gi);
    float dot_ = 0.0;
    // Sodium against mercury and LED. A city is not one colour of light, and
    // a field of identically warm dots is most of what made this look
    // synthetic. Skewed warm, because most street lighting still is.
    vec3 tint = vec3(1.0, 0.78, 0.50);
    if (pick < LAMP_FRACTION) {
      vec2 jit = vec2(hash21(gi + 11.1), hash21(gi + 27.3));
      float d = length(gf - jit);
      // Per-lamp brightness, mean 1.0 so the far-field average is unchanged.
      float bright = 0.55 + 0.9 * hash21(gi + 41.7);
      dot_ = LAMP_PEAK * bright * exp(-d * d * LAMP_SHARP);
      float warmth = hash21(gi + 63.1);
      tint = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.70, 0.32),
                 smoothstep(0.05, 0.55, warmth));
    }
    float lamps = mix(LAMP_MEAN, dot_, detail);
    // Far away the individual tints have averaged out too, so the mean colour
    // is what the far field must use.
    vec3 lampColour = mix(vec3(1.0, 0.78, 0.50), tint, detail);

    // No street lamps on water.
    //
    // The urban mask is a blurred coverage grid, so it bleeds past a shoreline
    // by design (street lighting really does spill past the last building), and
    // a pier or a bridge approach carries footprints right up to the edge. The
    // result was rows of lamps standing out on the bay and down the middle of
    // rivers. The landcover water channel is a measurement rather than an
    // inference, so it is the right thing to veto with.
    float dryLand = 1.0 - clamp(water, 0.0, 1.0);
    lit += lampColour * lamps * urban * dryLand * uNight * 1.15;

    // Skyglow on the built-up ground only, and nearly monochrome: at this light
    // level the eye takes almost no colour off a surface, and carrying the
    // drape's daytime hue through is what made the city look like a dimmed
    // photograph rather than a dark place with lights in it.
    // Skyglow, which a city genuinely does add to its own surroundings, so
    // this one IS gated on the urban mask. The flattening it used to carry has
    // moved up to the albedo, where it belongs.
    lit += albedo * uNightGlow * urban * dryLand * 0.85;
  }

  // Aerial perspective: the same integral the sky uses, over the distance to
  // this fragment. This is what unifies ground and sky into one atmosphere.
  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  vec3 col = lit * trans + inscatter;

  // Term isolation. Chasing a too-bright image by arithmetic is slow and easy
  // to get wrong; showing one term at a time answers it in one look.
  //   1 albedo       2 direct        3 ambient      4 inscatter
  //   5 lit          6 transmittance 7 water        8 elevation/200
  //   9 landcover water          10 landcover built
  //  11 landcover false-colour: blue water, red built, green tree, white
  //     herbaceous. Black means no pack, which is the one thing the
  //     single-channel views cannot distinguish from "none of this class".
  //  12 landcover tree           13 landcover herbaceous (after the road veto)
  //  14 road coverage: white on a carriageway, ramping off across the verge.
  //     Black everywhere for a city with no road pack, which is most of them.
  //  15 water scene-reflection confidence (render/waterssr.ts)
  //  16 SSR history depth check: red |history depth - own depth| / 10 m,
  //     green own depth / 2 km, blue history depth / 2 km. Red must be ~0
  //     on water, or the history and the march disagree about the world.
  //  17 red shore distance / 500 m, green foam, blue wave roughness * 2
  //  18 foam mask, white where foam > 0.3; tools/verify-water.ts reads it
  if (uDebug > 0.5) {
    if (uDebug < 1.5)       col = albedo;
    else if (uDebug < 2.5)  col = beam;
    else if (uDebug < 3.5)  col = ambient;
    else if (uDebug < 4.5)  col = inscatter;
    else if (uDebug < 5.5)  col = lit;
    else if (uDebug < 6.5)  col = trans;
    else if (uDebug < 7.5)  col = vec3(water);
    else if (uDebug < 8.5)  col = vec3(vWorld.y / 200.0);
    else if (uDebug < 9.5)  col = vec3(lcWater * uHasLand);
    else if (uDebug < 10.5) col = vec3(lcBuilt * uHasLand);
    else if (uDebug < 11.5) col = (vec3(0.1, 0.3, 1.0) * lc.r + vec3(1.0, 0.15, 0.1) * lc.g
              + vec3(0.1, 0.8, 0.2) * lc.b + vec3(1.0) * lc.a) * uHasLand;
    else if (uDebug < 12.5) col = vec3(canopy);
    else if (uDebug < 13.5) col = vec3(herb);
    else if (uDebug < 14.5) col = vec3(roadCov);
    else if (uDebug < 15.5) col = vec3(dbgSsr);
    else if (uDebug < 16.5) {
      vec4 c0 = uSsrViewProj * vec4(vWorld, 1.0);
      vec2 u0 = c0.xy / c0.w * 0.5 + 0.5;
      float h0 = texelFetch(uSsrHistory, ivec2(u0 * uSsrSize), 0).a;
      col = vec3(abs(h0 - c0.w) / 10.0, c0.w / 2000.0, h0 / 2000.0);
    }
    else if (uDebug < 17.5) col = vec3(shoreD / 500.0, foam, waveAlpha * 2.0);
    else col = vec3(step(0.3, foam) * water);
  }

  // The ground/sun mask; see groundDebugColor in render/groundbounce.ts. Water
  // is excluded by hand: a shadowed river is not a street floor, and the street
  // assertions must not average one in.
  vec3 dbg;
  if (water < 0.5 && groundDebugColor(sunVis, GROUND_DRAPE, dbg)) col = dbg;

  fragColor = vec4(col, 1.0);
}
`;

export interface TerrainUniforms
  extends SunShadowUniforms, AoUniforms, GroundBounceUniforms, WaterSsrUniforms {
  uDrape: THREE.IUniform<THREE.Texture | null>;
  /** Sky irradiance, 9 RGB coefficients; see render/sh.ts. */
  uSH: THREE.IUniform<Float32Array>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uWetness: THREE.IUniform<number>;
  uSnow: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
  uLandNear: THREE.IUniform<THREE.Texture | null>;
  uLandFar: THREE.IUniform<THREE.Texture | null>;
  uLandNearExtent: THREE.IUniform<number>;
  uLandFarExtent: THREE.IUniform<number>;
  uHasLand: THREE.IUniform<number>;
  uShoreNear: THREE.IUniform<THREE.Texture | null>;
  uShoreFar: THREE.IUniform<THREE.Texture | null>;
  /** Scene clock in seconds; drives the wave drift. Zero in shot mode. */
  uTime: THREE.IUniform<number>;
  /** Observed 10 m wind in m/s as (east, south); sets wave steepness and drift. */
  uWind: THREE.IUniform<THREE.Vector2>;
  /** 1 restores the pre-wave flat water, for the vacuity probe in tools/verify-water.ts. */
  uFlatWater: THREE.IUniform<number>;
  uRoadMask: THREE.IUniform<THREE.Texture | null>;
  uRoadMaskExtent: THREE.IUniform<number>;
  uHasRoadMask: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uDebug: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
}

/**
 * `shadow` is spread in by REFERENCE: every ring shares the one set of cascade
 * uniforms the SunShadow pass writes, so a ring cannot fall a frame behind.
 */
export function makeTerrainUniforms(shadow: SunShadowUniforms): TerrainUniforms {
  return {
    ...shadow,
    ...aoUniforms(),
    ...groundBounceUniforms(),
    ...WATER_SSR_UNIFORMS,
    uDrape: { value: null },
    // Held at the hemispherical ambient the shader used before the probe
    // existed, so frame one shades correctly whatever happens to the probe.
    uSH: { value: shHemispherical([0.28, 0.36, 0.5], 0.55, 0.45) },
    uCameraPos: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Color(0.28, 0.36, 0.5) },
    uWetness: { value: 0 },
    uSnow: { value: 0 },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonLight: { value: new THREE.Color(0, 0, 0) },
    uLandNear: { value: null },
    uLandFar: { value: null },
    uLandNearExtent: { value: 1 },
    uLandFarExtent: { value: 1 },
    uHasLand: { value: 0 },
    uShoreNear: { value: null },
    uShoreFar: { value: null },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2() },
    uFlatWater: { value: 0 },
    uRoadMask: { value: null },
    uRoadMaskExtent: { value: 1 },
    uHasRoadMask: { value: 0 },
    uExposure: { value: 1 },
    uSunSurface: { value: 0.105 },
    uDebug: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSunIntensity: { value: 22 },
    uMieG: { value: 0.76 },
    uTurbidity: { value: 1 },
    uCamAltitude: { value: 100 },
    uMultiScatter: { value: 0.055 },
  };
}

/** The square hole a moving detail ring punches in the ring under it. */
export interface DetailHole {
  /** Centre in world metres. */
  x: number;
  z: number;
  /** Half-width in metres. */
  extent: number;
}

/**
 * One ring's vertex grid, kept so the hole can be RE-CUT without resampling
 * the height field.
 *
 * This is what makes a detail ring that follows the camera affordable. Moving
 * the detail square means the ring under it has to stop drawing a different set
 * of quads, and that is a change to the INDEX buffer alone: the positions, the
 * uvs and the normals are all still correct, because none of them depends on
 * where the hole is. Rebuilding the vertices instead would be 50,000 height
 * lookups per move on ring 1, which is a hitch you can feel; re-indexing is
 * integer work over the same 50,000 quads and is not.
 */
interface RingGrid {
  ring: TerrainRing;
  /** Half-width of the STATIC hole for the next ring in, 0 for the innermost. */
  inner: number;
  /** Ring centre in world metres. Zero for every ring except a moving detail one. */
  cx: number;
  cz: number;
  positions: Float32Array;
  uvs: Float32Array;
  /** Computed over EVERY quad, holes ignored; see buildRingGrid. */
  normals: Float32Array;
  /** Index of each grid vertex, and of the skirt vertices that follow them. */
  gridCount: number;
  skirtRing: number[];
}

/**
 * The vertex grid for one ring: every vertex, hole or no hole.
 *
 * Vertices inside the hole are KEPT and simply not referenced by any triangle.
 * That costs a ring 1 about 1,600 unused vertices out of 50,000 and is what
 * lets the hole move for the price of an index buffer.
 */
function buildRingGrid(
  ring: TerrainRing,
  inner: number,
  cx: number,
  cz: number,
  origin: Origin,
  height: (lat: number, lon: number) => number,
  drapeBbox: { west: number; east: number; south: number; north: number },
): RingGrid {
  const n = ring.segments;
  const step = (ring.extent * 2) / n;
  const gridCount = (n + 1) * (n + 1);

  // Grid, then the skirt vertices, in one buffer: the skirt hangs from the
  // outer edge and its positions never change either.
  const edge: number[] = [];
  for (let i = 0; i <= n; i++) edge.push(0 * (n + 1) + i);
  for (let j = 1; j <= n; j++) edge.push(j * (n + 1) + n);
  for (let i = n - 1; i >= 0; i--) edge.push(n * (n + 1) + i);
  for (let j = n - 1; j >= 1; j--) edge.push(j * (n + 1) + 0);

  const positions = new Float32Array((gridCount + edge.length) * 3);
  const uvs = new Float32Array((gridCount + edge.length) * 2);

  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = cx - ring.extent + i * step;
      const z = cz - ring.extent + j * step;
      const ll = origin.toLatLon(x, z);
      const v = j * (n + 1) + i;
      positions[v * 3] = x;
      positions[v * 3 + 1] = height(ll.lat, ll.lon);
      positions[v * 3 + 2] = z;
      uvs[v * 2] = (ll.lon - drapeBbox.west) / (drapeBbox.east - drapeBbox.west);
      uvs[v * 2 + 1] = (drapeBbox.north - ll.lat) / (drapeBbox.north - drapeBbox.south);
    }
  }

  // Skirt: a curtain hanging from the outer edge, hiding the crack against the
  // next ring out and the gap at the world edge.
  const SKIRT_DROP = 400;
  for (let k = 0; k < edge.length; k++) {
    const e = edge[k];
    const v = gridCount + k;
    positions[v * 3] = positions[e * 3];
    positions[v * 3 + 1] = positions[e * 3 + 1] - SKIRT_DROP;
    positions[v * 3 + 2] = positions[e * 3 + 2];
    uvs[v * 2] = uvs[e * 2];
    uvs[v * 2 + 1] = uvs[e * 2 + 1];
  }

  // Normals over the WHOLE grid, holes ignored.
  //
  // This is the other half of what makes a moving hole cheap, and it is the
  // half that is easy to miss. `computeVertexNormals` leaves a vertex that no
  // triangle referenced with a ZERO normal, and the moment the hole moves off
  // that vertex it is suddenly drawn, lit by a normal pointing nowhere. Seen:
  // a flat pale rectangle sitting exactly where the hole used to be, at the
  // spawn point, as soon as the detail ring moved away from it. Computing them
  // once over every quad costs nothing extra here and means re-indexing never
  // has to touch them.
  const bare: RingGrid = {
    ring, inner: 0, cx, cz, positions, uvs,
    normals: new Float32Array(0), gridCount, skirtRing: edge,
  };
  const full = new THREE.BufferGeometry();
  full.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  full.setIndex(buildRingIndices(bare, null));
  full.computeVertexNormals();
  const normals = (full.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array;
  full.dispose();

  return { ring, inner, cx, cz, positions, uvs, normals, gridCount, skirtRing: edge };
}

/**
 * Indices for a grid, with the static hole and an optional moving detail hole
 * cut out of it.
 *
 * A quad is dropped when ANY of its four corners is inside a hole, which is the
 * same rule the vertex-dropping version used and therefore leaves the same
 * boundary; the next ring in covers it, and the skirts cover the crack.
 */
function buildRingIndices(grid: RingGrid, detail: DetailHole | null): number[] {
  const n = grid.ring.segments;
  const step = (grid.ring.extent * 2) / n;
  const indices: number[] = [];

  const inHole = (v: number): boolean => {
    const x = grid.positions[v * 3];
    const z = grid.positions[v * 3 + 2];
    if (grid.inner > 0) {
      const lip = grid.inner - step;
      if (Math.abs(x - grid.cx) < lip && Math.abs(z - grid.cz) < lip) return true;
    }
    if (detail) {
      const lip = detail.extent - step;
      if (Math.abs(x - detail.x) < lip && Math.abs(z - detail.z) < lip) return true;
    }
    return false;
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = j * (n + 1) + i + 1;
      const c = (j + 1) * (n + 1) + i;
      const d = (j + 1) * (n + 1) + i + 1;
      if (inHole(a) || inHole(b) || inHole(c) || inHole(d)) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const ring = grid.skirtRing;
  for (let k = 0; k < ring.length - 1; k++) {
    indices.push(ring[k], grid.gridCount + k, ring[k + 1]);
    indices.push(ring[k + 1], grid.gridCount + k, grid.gridCount + k + 1);
  }
  return indices;
}

function geometryFor(grid: RingGrid, detail: DetailHole | null): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(grid.positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(grid.uvs, 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(grid.normals, 3));
  geo.setIndex(buildRingIndices(grid, detail));
  geo.computeBoundingSphere();
  return geo;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly uniforms: TerrainUniforms[] = [];

  /** Height above sea level at a world point, from the finest field that has it. */
  heightAt: (x: number, z: number) => number;

  private readonly origin: Origin;
  private readonly sample: (lat: number, lon: number) => number;
  private readonly grids: RingGrid[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly textures: THREE.Texture[] = [];
  /**
   * Where the innermost, finest ring currently sits.
   *
   * Never null, and that is the simplification the whole moving-ring design
   * rests on. Every other ring cuts THIS square out of itself rather than a
   * static hole of its own, so the ring plan reads the same whether the detail
   * ring is parked at the spawn point (where the square is exactly the hole it
   * always was) or two kilometres down a street in a different ring's
   * territory. There is no second code path to get wrong.
   */
  private detail: DetailHole;

  constructor(
    origin: Origin,
    fields: Heightfield[],
    drapes: StitchedImage[],
    shadow: SunShadowUniforms,
    rings: TerrainRing[] = CITY_RINGS,
  ) {
    this.origin = origin;
    // Finest-first lookup, so a point inside the near field uses the 30 m data
    // and a point out on the horizon falls through to the coarse one.
    const sample = (lat: number, lon: number): number => {
      for (const f of fields) if (f.contains(lat, lon)) return f.sample(lat, lon);
      const last = fields[fields.length - 1];
      return last ? last.sample(lat, lon) : 0;
    };
    this.sample = sample;

    this.heightAt = (x, z) => {
      const ll = origin.toLatLon(x, z);
      return sample(ll.lat, ll.lon);
    };

    this.detail = { x: 0, z: 0, extent: rings[0].extent };

    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      // Ring 1's hole is the DETAIL square, which starts life in exactly the
      // place its static hole used to be. Only rings 2 and out keep a static
      // one, because nothing moves through those.
      const inner = r >= 2 ? rings[r - 1].extent : 0;
      const drape = drapes[Math.min(r, drapes.length - 1)];
      const grid = buildRingGrid(ring, inner, 0, 0, origin, sample, drape.bbox);
      const geo = geometryFor(grid, r === 0 ? null : this.detail);

      const tex = drapeTexture(drape);

      const u = makeTerrainUniforms(shadow);
      u.uDrape.value = tex;
      this.uniforms.push(u);

      const mat = new THREE.RawShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: u,
        glslVersion: THREE.GLSL3,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = r;
      // Only the rings that a cascade can actually reach cast. The outer two
      // span 20 and 70 km and are never frustum-culled, so putting them in the
      // shadow pass would redraw 200k triangles three times a frame to occlude
      // ground that is already past the last cascade.
      if (ring.extent <= 6000) mesh.layers.enable(SHADOW_CASTER_LAYER);
      this.group.add(mesh);
      this.grids.push(grid);
      this.meshes.push(mesh);
      this.textures.push(tex);
    }
  }

  /** Where the detail ring is now, in world metres. */
  get detailCentre(): DetailHole {
    return this.detail;
  }

  /**
   * Move the innermost ring to `(x, z)` and hang `drape` on it.
   *
   * ATOMIC by construction: the new geometry and the new texture are built
   * complete and only then assigned, in one pass with nothing rendered in
   * between, so the old drape stays correct right up to the swap and the ground
   * never flashes. The caller does the slow part -- fetching and stitching the
   * imagery -- off the frame, and hands the finished canvas here.
   *
   * Every other ring is re-INDEXED, never rebuilt: see RingGrid. Only the rings
   * whose own area the square could have entered or left are touched.
   */
  recentreDetail(x: number, z: number, drape: StitchedImage): void {
    const before = this.detail;
    const after: DetailHole = { x, z, extent: this.grids[0].ring.extent };

    const grid = buildRingGrid(
      this.grids[0].ring, 0, x, z, this.origin, this.sample, drape.bbox,
    );
    const geo = geometryFor(grid, null);
    const tex = drapeTexture(drape);

    const oldGeo = this.meshes[0].geometry;
    const oldTex = this.textures[0];
    this.grids[0] = grid;
    this.meshes[0].geometry = geo;
    this.textures[0] = tex;
    this.uniforms[0].uDrape.value = tex;
    this.detail = after;
    oldGeo.dispose();
    oldTex.dispose();

    for (let r = 1; r < this.grids.length; r++) {
      if (!this.affected(r, before) && !this.affected(r, after)) continue;
      this.meshes[r].geometry.setIndex(buildRingIndices(this.grids[r], after));
      this.meshes[r].geometry.computeBoundingSphere();
    }
  }

  /** Whether a detail square can change ring `r`'s indices at all. */
  private affected(r: number, hole: DetailHole): boolean {
    const g = this.grids[r];
    const reach = g.ring.extent + hole.extent;
    if (Math.abs(hole.x) >= reach || Math.abs(hole.z) >= reach) return false;
    // Wholly inside the ring's own static hole: nothing of this ring is drawn
    // there in the first place.
    const swallowed = g.inner - hole.extent;
    return !(swallowed > 0 && Math.abs(hole.x) < swallowed && Math.abs(hole.z) < swallowed);
  }
}

/** A stitched canvas as a drape texture, with this renderer's sampling. */
function drapeTexture(drape: StitchedImage): THREE.Texture {
  const tex = new THREE.CanvasTexture(drape.canvas as unknown as HTMLCanvasElement);
  // Decoded in the shader by srgbToLinear(); tagging it sRGB here as well
  // would decode it twice.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 16;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}
