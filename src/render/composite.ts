// The final pass: volumetric clouds raymarched against the scene, then tone
// mapping and output encoding.
//
// Clouds have to happen HERE rather than as another object in the scene,
// because an aircraft flies through them. Drawing them as a shell behind
// everything makes them scenery you can never reach; compositing them against
// the depth buffer makes them weather you fly into, which is the entire point
// of reading a live cloud base.
//
// The three decks come straight from the observation:
//   LOW   base = the lifted condensation level from temperature/dewpoint,
//         coverage = reported low cloud. This is the deck you fly through.
//   MID   altocumulus, a thinner slab.
//   HIGH  cirrus, drawn as a thin fibrous veil rather than a volume: it is
//         ice, it has no visible body, and marching it as a slab wastes steps
//         on something that should read as a smear of white.
//
// What the density IS lives in clouds.glsl.ts (weather map, type profiles,
// Perlin-Worley erosion). This file is how it is marched, lit and paid for:
//
//   * QUARTER-RATE MARCH. Each frame marches one pixel of every 2x2 block of
//     the half-resolution cloud buffer, in a four-frame rotation, and a
//     reconstruct pass fills the other three from last frame's buffer,
//     reprojected through the cloud's own depth. A still camera therefore
//     converges in four frames to exactly the buffer a full half-res march
//     would give, for a quarter of the cost per frame.
//   * LIGHT: Beer's law along a growing light march, the multiple-scattering
//     octaves of Wrenninge (as Hillaire uses them in Frostbite), a two-lobe
//     phase for the silver lining, a powder term on the side away from the
//     sun, and ambient between the sky probe's up and down irradiance.
//   * AERIAL PERSPECTIVE: the cloud's light is carried through the same
//     atmosphere integral the sky uses, to the cloud's mean depth, so a deck
//     60 km out dissolves into the horizon haze instead of being pasted on it.
//   * SHADOWS: a sun-space transmittance map of the decks, drawn here and read
//     by every lit surface through SUN_SHADOW_GLSL.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SKYGLOW_UNIFORMS } from "./skyglow";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import { CLOUD_GLSL } from "./clouds.glsl";
import { makeShapeNoise, makeDetailNoise } from "./noise3d";
import { makeWeatherMap } from "./cloudmap";
import { shIrradiance, type SH9 } from "./sh";
import type { Weather } from "../data/weather";
import type { SceneLighting } from "./lighting";
import type { SunShadowUniforms } from "./sunshadow";

const VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 1.0, 1.0);
}
`;

/** Ray direction for a uv, shared by the march and the reconstruct. */
const RAY_GLSL = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uInvView;
vec3 rayFor(vec2 uv) {
  vec4 view = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(mat3(uInvView) * (view.xyz / view.w));
}
`;

const MARCH_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;

${ATMOSPHERE_GLSL}
${CLOUD_GLSL}
${RAY_GLSL}

uniform sampler2D uDepth;
uniform vec3  uCameraPos;
uniform vec2  uHalfSize;
uniform ivec2 uPhase;
// The sun as the CLOUDS see it, which is the beam above the decks: see update().
uniform vec3  uCloudSun;
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform float uHighCover;
uniform float uHighBase;

/**
 * Where the ray crosses a shell at height h, as (near, far). (-1, -1) misses.
 *
 * A SHELL AND NOT A PLANE, and that is the whole of the horizon fix. A plane
 * above the camera is only ever reached by a ray going UP, so a deck drawn as
 * a flat slab stops dead at eye level and the bright clear-sky haze shows
 * through underneath it as a cream stripe. On a round planet every ray between
 * the geometric horizon and level climbs into the deck somewhere between 130
 * and 500 km out. R_GROUND is the atmosphere's, so the clouds sit on the same
 * planet the sky is integrated over.
 */
vec2 shellHits(vec3 rd, float h) {
  float r = R_GROUND + h;
  float ro = R_GROUND + uCameraPos.y;
  float b = ro * rd.y;
  float c = ro * ro - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float sq = sqrt(disc);
  return vec2(-b - sq, -b + sq);
}

// Two lobes: a strong forward one for the silver lining looking toward the
// sun, and a weak backward one so the far side is not dead flat. 'k' shrinks
// both for the higher scattering octaves, which are more isotropic.
float cloudPhase(float c, float k) {
  return mix(miePhase(c, 0.80 * k), miePhase(c, -0.30 * k), 0.35);
}

// Extinction toward the sun per unit density. The same as the view's: what
// keeps sunlit tops bright and deep bases dark is not a cheaper sigma, it is
// the octaves below.
const float SIGMA_LIGHT = SIGMA_VIEW;
const float LIGHT_STEP0 = 40.0;
const float MARCH_FAR = 120000.0;

/**
 * Sun light scattered toward the eye at a sample, for optical depth 'od'
 * toward the sun. Three octaves, each with half the energy, a quarter of the
 * extinction and a flatter phase than the last: the cheap stand-in for the
 * light that has scattered more than once, which is most of what lights the
 * inside and the underside of a real cloud. Single-scatter Beer alone makes a
 * deck's base black under any deck thicker than a few hundred metres, which is
 * the flat dark smear an overcast used to be.
 */
float sunScatter(float od, float cosSun) {
  float s = 0.0;
  float a = 0.57;
  float b = 1.0;
  float k = 1.0;
  if (uCloudFlags.w < 0.5) {
    // The previous octaves, kept only as tools/verify-clouds.ts's probe.
    for (int i = 0; i < 3; i++) {
      s += a * (cloudPhase(cosSun, k) * 4.0 + 0.5) * exp(-SIGMA_LIGHT * b * od);
      a *= 0.5;
      b *= 0.22;
      k *= 0.6;
    }
    return s;
  }
  // BACKLIT, A CUMULUS IS DARK WITH A SILVER RIM. Each octave above is two
  // things: the phase-shaped part (light still travelling roughly along the
  // beam) and the 0.5 isotropic floor (light scattered so often it has
  // forgotten the beam). With both keeping 0.22 of the last octave's
  // extinction, the third octave's FORWARD part still got e^-0.4 of the beam
  // through a 1 km cumulus core, and looking toward a golden-hour sun that
  // part is 3x the floor: the core glowed orange from inside and read as
  // muddy brown. Light that has crossed a kilometre of cloud has no direction
  // left, so for a cumulus the forward part keeps only 0.34 per octave and
  // dies in the core, leaving the sky-lit blue-grey of a backlit photograph,
  // while the thin edge still transmits the beam through the forward lobe as
  // the rim. The isotropic floor keeps 0.22: it is what lights a sunlit
  // cumulus's sides and an overcast's base, and neither of those was wrong.
  float bf = 1.0;
  float kf = mix(0.22, 0.4, uLow.w);
  float kb = mix(0.22, 0.36, uLow.w);
  for (int i = 0; i < 3; i++) {
    s += a * (cloudPhase(cosSun, k) * 4.0 * exp(-SIGMA_LIGHT * bf * od) + 0.5 * exp(-SIGMA_LIGHT * b * od));
    a *= 0.5;
    b *= kb;
    bf *= kf;
    k *= 0.6;
  }
  return s;
}

void main() {
  // The half-res pixel this quarter-rate fragment stands for this frame.
  ivec2 hp = ivec2(gl_FragCoord.xy) * 2 + uPhase;
  vec2 uv = (vec2(hp) + 0.5) / uHalfSize;
  vec3 rd = rayFor(uv);

  vec3 scattered = vec3(0.0);
  float through = 1.0;
  // Transmittance-weighted depth: the reprojection depth and the distance the
  // aerial perspective is carried to.
  float dSum = 0.0;
  float wSum = 0.0;
  float firstAlt = 0.0;

  // The FARTHEST of the four full-res depths under this half-res pixel. A
  // pixel straddling a skyline then marches as sky, which is the side the
  // eye notices: the present pass hands each full-res pixel only samples
  // marched at its own distance, and a skyline whose sky pixels had no sky
  // sample nearby fell back to a terrain one and showed the bare horizon
  // glow as a dashed white line along every ridge.
  ivec2 fp = hp * 2;
  ivec2 fmax = textureSize(uDepth, 0) - 1;
  float d = max(
    max(texelFetch(uDepth, min(fp, fmax), 0).r, texelFetch(uDepth, min(fp + ivec2(1, 0), fmax), 0).r),
    max(texelFetch(uDepth, min(fp + ivec2(0, 1), fmax), 0).r, texelFetch(uDepth, min(fp + ivec2(1, 1), fmax), 0).r));
  float sceneDist = 1.0e9;
  if (d < 1.0) {
    vec4 view = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    sceneDist = length(view.xyz / view.w);
  }

  float lowCover = uLow.x;
  float midCover = uMid.x;
  float cosSun = dot(rd, uSunDir);
  // The beam reaching the decks has crossed the air to them: this is what
  // turns a cumulus gold at the end of the day. One transmittance at the low
  // deck's base serves the whole pixel.
  vec3 cloudSun = uCloudSun * sunTransmittance(atmoOrigin(max(uLow.y, 300.0)), uSunDir, uTurbidity);

  if (lowCover > 0.03 || midCover > 0.03) {
    // Only the decks that are actually there, widened downward by what a
    // stratiform base may sag (clouds.glsl.ts, 6% of the deck).
    float slabLo = 1.0e9;
    float slabHi = -1.0e9;
    if (lowCover > 0.03) { slabLo = min(slabLo, uLow.y - 0.1 * (uLow.z - uLow.y)); slabHi = max(slabHi, uLow.z); }
    if (midCover > 0.03) { slabLo = min(slabLo, uMid.y - 0.1 * (uMid.z - uMid.y)); slabHi = max(slabHi, uMid.z); }

    // The crossing is the part of the ray inside the OUTER shell and outside
    // the inner one, whether the camera is under the deck, in it, or over it.
    // Where a downward ray leaves the deck and re-enters it further on, only
    // the first span is taken: the second is on the far side of the planet.
    vec2 hitLo = shellHits(rd, slabLo);
    vec2 hitHi = shellHits(rd, slabHi);
    float sEnter = 0.0;
    float sExit = 0.0;
    if (hitHi.y > 0.0) {
      float aHi = max(0.0, hitHi.x);
      float bHi = hitHi.y;
      if (hitLo.y > 0.0) {
        float aLo = max(0.0, hitLo.x);
        if (aLo <= aHi) { sEnter = max(aHi, hitLo.y); sExit = bHi; }
        else            { sEnter = aHi; sExit = min(bHi, aLo); }
      } else {
        sEnter = aHi;
        sExit = bHi;
      }
    }
    sExit = min(sExit, sceneDist);
    sEnter = min(sEnter, sExit);

    float t0 = sEnter;
    float t1 = min(sExit, MARCH_FAR);
    float marchedTo = t0;
    float thick = slabHi - slabLo;
    float hdScale = 1.0 / max(thick, 1.0);

    if (t1 > t0) {
      // The step size is a function of distance and of nothing else: tied to
      // the slab crossing it became a function of elevation, and every
      // discrete event in the integral drew an iso-elevation terrace across
      // the sky. Near the camera it is 25 to 70 m, which is what lets the
      // inside of a cloud be fog and not a slab.
      float dt0 = clamp(thick / 28.0, 25.0, 70.0);
      float dt = dt0 * max(1.0, t0 / 4000.0);

      // Stratified start offset, keyed to the HALF-RES pixel so it is the same
      // pattern a full half-res march had. A 2x2 ordered matrix picks the
      // quarter of the step and interleaved gradient noise a place inside it;
      // the present pass's tent weights land 4/16 on each of the four phases,
      // so the ordered part cancels exactly and the remainder is fine grain.
      ivec2 px = hp & 1;
      const float BAYER[4] = float[4](0.0, 2.0, 3.0, 1.0);
      float ign = fract(52.9829189 * fract(dot(vec2(hp) + 0.5, vec2(0.06711056, 0.00583715))));
      float t = t0 + dt * (BAYER[px.y * 2 + px.x] + ign) * 0.25;

      // Empty-space skipping. A broken deck is mostly gaps; while the last
      // sample was empty the march strides three steps, and the step that
      // finds cloud backs up two to enter the edge at full resolution, or the
      // leading edge of every cloud is quantised to the coarse stride.
      bool coarse = true;
      int empties = 0;

      for (int i = 0; i < CLOUD_STEPS; i++) {
        if (t > t1 || through < 0.01) break;
        dt = dt0 * max(1.0, t / 4000.0);
        vec3 p = uCameraPos + rd * t;
        // Weather map level: a 94 m texel is a half-res pixel at ~27 km.
        float lod = max(0.0, log2(t * 0.0035 / 94.0));
        float dens = cloudDensity(p, lod, false);

        if (dens <= 0.001) {
          empties++;
          if (empties > 4) coarse = true;
          t += coarse ? 3.0 * dt : dt;
          continue;
        }
        empties = 0;
        if (coarse) {
          coarse = false;
          t = max(t0, t - 2.0 * dt);
          continue;
        }

        // Light march toward the sun, steps doubling from 40 m: 1.2 km of
        // reach in five cheap samples (no detail erosion: an edge wisp does
        // not shade anything).
        float od = 0.0;
        float lt = 0.0;
        float ls = LIGHT_STEP0;
        for (int j = 0; j < LIGHT_STEPS; j++) {
          od += cloudDensity(p + uSunDir * (lt + ls * 0.5), lod, true) * ls;
          lt += ls;
          ls *= 2.0;
        }
        // Whatever of a STRATIFORM low deck is left above the light march's
        // reach, at its mean density. A cumulus top is clear sky; a stratus
        // deck 1.3 km thick is not, and without this the base of an overcast
        // was lit as if the deck ended a kilometre up.
        if (p.y < uLow.z) {
          float above = max(0.0, uLow.z - (p.y + uSunDir.y * lt)) / max(uSunDir.y, 0.1);
          od += min(above, 6000.0) * 0.3 * uLow.x * (1.0 - uLow.w);
        }

        // Powder: the dark rims of a cloud seen with the sun BEHIND you, where
        // light has entered the surface but not yet scattered out toward the
        // eye. Looking into the sun the rims are the silver lining instead, so
        // the term fades out on that side.
        float powder = 1.0 - 0.6 * exp(-dens * 12.0) * sat(-cosSun * 0.5 + 0.5);

        float hd = sat((p.y - slabLo) * hdScale);
        vec3 amb = mix(uAmbBottom, uAmbTop, hd) * mix(0.6, 1.0, hd);
        vec3 lum = cloudSun * sunScatter(od, cosSun) * powder + amb;
        // Rain shafts read as darker cloud bases.
        lum *= 1.0 - 0.35 * uPrecip * smoothstep(uLow.z, uLow.y, p.y);

        float stepT = exp(-dens * SIGMA_VIEW * dt);
        float w = through * (1.0 - stepT);
        scattered += lum * w;
        dSum += w * t;
        wSum += w;
        through *= stepT;
        if (firstAlt == 0.0 && through < 0.8) firstAlt = p.y;
        t += dt;
      }
      marchedTo = t;
    }

    // --- THE HORIZON, WHICH IS NOT MARCHED --------------------------------
    // Everything past the march's 120 km limit or its step budget. Closed with
    // the deck's own expectation: over tens of kilometres the noise averages
    // and cannot do anything else, and neighbouring pixels then get the same
    // answer, which is what keeps the band free of speckle. Ramped in by how
    // much path is left, because over a short path a broken deck is its own
    // structure and not its average.
    float restStart = max(marchedTo, sEnter);
    float rest = sExit - restStart;
    // The sliver between level and the geometric horizon, from under the
    // deck, never meets the shell: the ray turns down before it gets there.
    // The sky pass draws clear-sky glow in it, which under any deck was the
    // cream line along the horizon. What is really there is the far underside
    // of the same deck seen past the curve of the earth, so it is closed the
    // same way as the band just above it.
    if (sEnter >= sExit && sceneDist > 1.0e8 && uCameraPos.y < slabLo && rd.y < 0.0) {
      restStart = 0.0;
      rest = 40000.0;
      sExit = 40000.0;
    }
    if (through > 0.01 && rest > 0.0) {
      float meanDens = 0.0;
      if (lowCover > 0.03) meanDens += lowCover * 0.3 * (1.0 + uPrecip * 0.6);
      if (midCover > 0.03) meanDens += midCover * 0.3 * 0.6;
      vec3 lumH = cloudSun * sunScatter(250.0, cosSun) + mix(uAmbBottom, uAmbTop, 0.5);
      float od = meanDens * SIGMA_VIEW * rest * smoothstep(2000.0, 20000.0, rest);
      float restT = exp(-od);
      float w = through * (1.0 - restT);
      scattered += lumH * w;
      dSum += w * (restStart + 0.5 * min(rest, 60000.0));
      wSum += w;
      through *= restT;
    }
  }

  // --- AERIAL PERSPECTIVE ---------------------------------------------------
  // The cloud's light crosses the same air as everything else on its way to
  // the eye. Without this a deck 60 km out keeps the contrast of one 2 km
  // out and sits on the horizon like a sticker; with it, it fades into the
  // haze the sky pass draws, because it is the same integral.
  float dMean = wSum > 1e-5 ? dSum / wSum : 1.0e5;
  float alpha = 1.0 - through;
  if (alpha > 0.002) {
    vec3 airT;
    vec3 air = atmosphere(atmoOrigin(uCameraPos.y), rd, dMean, airT);
    scattered = scattered * airT + air * alpha;
  }

  // --- High cirrus ----------------------------------------------------------
  // A veil on the ray's crossing of one shell, not a march: cirrus is a
  // two-dimensional smear of ice. Combed out along the wind (the fibres are
  // ten times longer downwind than across), patchy at the weather-map scale,
  // and lit mostly forward: cirrus is brightest around the sun.
  if (uHighCover > 0.01) {
    vec2 hh = shellHits(rd, uHighBase);
    float th = uCameraPos.y < uHighBase ? hh.y : (hh.x > 0.0 ? hh.x : -1.0);
    if (th > 0.0 && th < sceneDist) {
      vec3 p = uCameraPos + rd * th;
      vec2 xz = p.xz - uWind * uTime * 2.5;
      vec2 wd = uWind / max(length(uWind), 0.1);
      if (length(uWind) < 0.1) wd = vec2(1.0, 0.0);
      vec2 r = vec2(dot(xz, wd), dot(xz, vec2(-wd.y, wd.x)));
      float patchy = textureLod(uWeather, xz * WM_SCALE * 0.7 + 0.31, 0.0).a;
      float n = perlinWorley(vec3(r.x * 0.00004, r.y * 0.0004, 0.37));
      float fib = texture(uDetail, vec3(r.x * 0.00008, r.y * 0.0012, 0.61)).r;
      float cov = sat(remap(patchy, 1.0 - min(1.0, uHighCover * 1.3), 1.0, 0.0, 1.0));
      float veil = sat(remap(n * 0.7 + fib * 0.3, 1.0 - cov, 1.0, 0.0, 1.0));
      // Thins toward the horizon, where a real sheet of cirrus is lost in the
      // haze long before its crossing distance runs out.
      veil *= smoothstep(-0.01, 0.12, rd.y);
      vec3 lit = cloudSun * (0.7 + 6.0 * miePhase(cosSun, 0.6)) + uAmbTop * 1.2;
      float a = veil * 0.5 * uHighCover;
      scattered += through * lit * a;
      through *= 1.0 - a;
    }
  }

  // rgb: light added by cloud. a: fraction of the world still visible.
  outColor = vec4(scattered, through);
  // z: log2 of the scene distance this sample was marched against, for the
  // present pass's depth-aware upsample.
  outAux = vec4(dMean, firstAlt, sceneDist > 1.0e8 ? 30.0 : log2(max(sceneDist, 1.0)), 1.0);
}
`;

/**
 * Builds the half-res cloud buffer from this frame's quarter-rate march and
 * last frame's buffer.
 *
 * The pixel marched this frame is taken as it is. The other three are last
 * frame's value at the place the cloud was: the ray through this pixel, out to
 * the cloud's depth, projected through LAST frame's camera. With the camera
 * still that lands back on this pixel, and it is then copied with texelFetch,
 * not filtered: a bilinear tap at a position a rounding error off the centre
 * would blur the buffer a little more every frame until the march came round
 * again, and the picture would depend on which of the four frames the
 * screenshot happened to land on. Copying is what keeps `?shot` byte-exact.
 *
 * Moving, the history is clamped to the box of the current march around it
 * (the standard TAA defence against ghosting): a cloud can only show what
 * this frame's samples say could be there.
 */
const RECON_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;
${RAY_GLSL}
uniform sampler2D uCurr;
uniform sampler2D uCurrAux;
uniform sampler2D uHist;
uniform sampler2D uHistAux;
uniform mat4  uPrevViewProj;
uniform vec3  uCameraPos;
uniform vec2  uHalfSize;
uniform ivec2 uPhase;
uniform float uHistValid;

void main() {
  ivec2 hp = ivec2(gl_FragCoord.xy);
  ivec2 qmax = textureSize(uCurr, 0) - 1;
  ivec2 qp = min(hp / 2, qmax);
  if ((hp & 1) == uPhase) {
    outColor = texelFetch(uCurr, qp, 0);
    outAux = texelFetch(uCurrAux, qp, 0);
    return;
  }
  vec2 uv = (vec2(hp) + 0.5) / uHalfSize;
  vec4 cur = texture(uCurr, uv);
  vec4 curAux = texelFetch(uCurrAux, qp, 0);
  if (uHistValid < 0.5) {
    outColor = cur;
    outAux = curAux;
    return;
  }
  vec3 P = uCameraPos + rayFor(uv) * curAux.x;
  vec4 prev = uPrevViewProj * vec4(P, 1.0);
  vec2 puv = prev.xy / prev.w * 0.5 + 0.5;
  if (prev.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) {
    outColor = cur;
    outAux = curAux;
    return;
  }
  vec2 delta = puv * uHalfSize - 0.5 - vec2(hp);
  if (dot(delta, delta) < 1e-4) {
    outColor = texelFetch(uHist, hp, 0);
    outAux = texelFetch(uHistAux, hp, 0);
    return;
  }
  vec4 h = texture(uHist, puv);
  vec4 lo = vec4(1e9);
  vec4 hi = vec4(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec4 c = texelFetch(uCurr, clamp(qp + ivec2(x, y), ivec2(0), qmax), 0);
      lo = min(lo, c);
      hi = max(hi, c);
    }
  }
  outColor = clamp(h, lo, hi);
  outAux = texture(uHistAux, puv);
}
`;

/**
 * The cloud shadow map: for each texel of a square on the plane of the lowest
 * cloud base, the sun's transmittance up through the decks along the sun ray.
 *
 * On that plane because every lit surface is under it: a point at any height
 * below the deck finds its texel by sliding along the sun ray to the plane,
 * which is exact, where a map indexed by ground position would need the sun
 * ray's crossing of the deck all over again per fragment.
 *
 * The extinction is half the view's: light under a cloud is not only the
 * beam that got through unscattered, it is the forward-scattered part of what
 * did not, and a shadow at single-scatter Beer is black-holed.
 */
const SHADOW_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
out vec4 fragColor;
${ATMOSPHERE_GLSL}
${CLOUD_GLSL}
uniform vec4 uMapRect;   // x0, z0, extent (m), size (texels)
uniform vec2 uMapSlab;   // lowest base, highest top
void main() {
  vec2 uv = gl_FragCoord.xy / uMapRect.w;
  vec3 p0 = vec3(uMapRect.x + uv.x * uMapRect.z, uMapSlab.x, uMapRect.y + uv.y * uMapRect.z);
  vec3 sd = uSunDir.y > 0.08 ? uSunDir : normalize(vec3(uSunDir.x, 0.08, uSunDir.z));
  float len = min((uMapSlab.y - uMapSlab.x) / sd.y, 12000.0);
  float ds = len / float(SHADOW_STEPS);
  float od = 0.0;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    od += cloudDensity(p0 + sd * (ds * (float(i) + 0.5)), 1.0, true) * ds;
  }
  float tr = exp(-od * SIGMA_VIEW * 0.5);
  fragColor = vec4(tr, tr, tr, 1.0);
}
`;

/**
 * Bloom, in three quarter-resolution passes: a bright pass, then one blur
 * across and one down.
 *
 * What it is for is the night city. A lit window is a small, very bright
 * source behind glass, and every photograph of one has a halo round it --
 * partly the lens, mostly the atmosphere between it and you. Without that halo
 * a night skyline reads as a diagram of where the windows are; with it, it
 * reads as a photograph. It is the cheapest single thing that separates the
 * two.
 *
 * The threshold and the strength both move with `uNight` rather than being
 * fixed. In daylight the brightest thing in frame is the sky, which covers half
 * the picture, and a threshold low enough to catch a lit window would bloom the
 * whole of it into mush. So by day the threshold sits above anything but a
 * specular glint and the strength is a tenth of what it is at night.
 */
const BLOOM_TERMS_GLSL = /* glsl */ `
uniform float uNight;
float bloomThreshold() { return mix(1.15, 0.085, uNight); }
float bloomStrength()  { return mix(0.10, 0.55, uNight); }
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform float uExposure;
${BLOOM_TERMS_GLSL}

void main() {
  // Thresholded in EXPOSED linear, not in raw radiance. Exposure moves by
  // nearly three stops between noon and midnight, so a threshold in raw
  // radiance would mean something different at every hour of the day.
  vec3 c = texture(uScene, vUv).rgb * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float t = bloomThreshold();
  // Soft knee: a hard cut makes the bloom pop on as a surface crosses the
  // threshold, which on a facade of windows is a flicker.
  float w = smoothstep(t, t * 2.0, l);
  fragColor = vec4(c * w, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uDirection;   // (1,0) then (0,1), in texels

void main() {
  // Nine-tap Gaussian as five bilinear fetches: the offsets sit between texels
  // so the hardware filter does half the summing.
  vec2 texel = uDirection / vec2(textureSize(uSource, 0));
  vec3 c = texture(uSource, vUv).rgb * 0.2270270270;
  c += (texture(uSource, vUv + texel * 1.3846153846).rgb
      + texture(uSource, vUv - texel * 1.3846153846).rgb) * 0.3162162162;
  c += (texture(uSource, vUv + texel * 3.2307692308).rgb
      + texture(uSource, vUv - texel * 3.2307692308).rgb) * 0.0702702703;
  fragColor = vec4(c, 1.0);
}
`;

const PRESENT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;

${TONEMAP_GLSL}

uniform sampler2D uScene;
uniform sampler2D uCloud;
uniform sampler2D uCloudAux;
uniform sampler2D uBloom;
uniform sampler2D uDepth;
uniform mat4 uInvProj;
// 1: tools/verify-clouds.ts's measurement frame; see Composite.
uniform float uDebug;

float logSceneDist(vec2 uv) {
  float d = texture(uDepth, uv).r;
  if (d >= 1.0) return 30.0;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return log2(max(length(v.xyz / v.w), 1.0));
}
${BLOOM_TERMS_GLSL}

void main() {
  if (uDebug > 0.5) {
    // Raw, unfiltered and untone-mapped: R the cloud's opacity, G and B the
    // altitude where the ray's opacity first passed 0.2, as 16 bits over 8 km.
    ivec2 hp = min(ivec2(vUv * vec2(textureSize(uCloud, 0))), textureSize(uCloud, 0) - 1);
    vec4 c = texelFetch(uCloud, hp, 0);
    float a16 = floor(clamp(texelFetch(uCloudAux, hp, 0).y / 8000.0, 0.0, 1.0) * 65535.0 + 0.5);
    float hi = floor(a16 / 256.0);
    fragColor = vec4(1.0 - c.a, hi / 255.0, (a16 - hi * 256.0) / 255.0, 1.0);
    return;
  }
  vec3 scene = texture(uScene, vUv).rgb;
  // Upsample of the half-resolution cloud buffer, and it is a TENT rather than
  // the single bilinear tap it used to be. Four taps half a texel off the
  // centre sum to weights [1 2 1; 2 4 2; 1 2 1]/16 over a 3x3 half-res
  // neighbourhood, which puts exactly 4/16 on each of the march's four dither
  // phases: the ray-start jitter averages out to nothing instead of arriving
  // on screen as a cross-hatch. Clouds are soft and low-frequency, so the two
  // full-res pixels of extra blur cost nothing that was really there.
  //
  // DEPTH-AWARE, because a half-res texel straddling a ridge or a tower's
  // edge holds one answer for two worlds: a sample marched against the hill,
  // with no cloud in front of it, bilinearly spread onto the sky pixels just
  // above, let the bright horizon glow through the deck as a cream line
  // along every skyline. Each of the tent's sixteen bilinear contributions
  // is dropped if the scene distance it was marched against is not within a
  // factor 1.4 of this pixel's. Where nothing is dropped the weights are the
  // tent's exactly, so the dither still cancels.
  vec2 size = vec2(textureSize(uCloud, 0));
  ivec2 imax = textureSize(uCloud, 0) - 1;
  float zf = logSceneDist(vUv);
  vec4 plain = vec4(0.0);
  vec4 kept = vec4(0.0);
  float keptW = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(k & 1, k >> 1) - 0.5;
    vec2 p = vUv * size + o - 0.5;
    vec2 fl = floor(p);
    vec2 f = p - fl;
    ivec2 i0 = ivec2(fl);
    for (int j = 0; j < 4; j++) {
      ivec2 e = ivec2(j & 1, j >> 1);
      ivec2 ij = clamp(i0 + e, ivec2(0), imax);
      vec2 bw2 = mix(1.0 - f, f, vec2(e));
      float bw = bw2.x * bw2.y * 0.25;
      vec4 c = texelFetch(uCloud, ij, 0);
      plain += c * bw;
      float m = abs(texelFetch(uCloudAux, ij, 0).z - zf) < 0.5 ? 1.0 : 0.0;
      kept += c * bw * m;
      keptW += bw * m;
    }
  }
  vec4 cloud = keptW > 0.02 ? kept / keptW : plain;
  // Bloom is added AFTER the clouds and BEFORE the tone curve, and both halves
  // of that matter: a halo that ignored the cloud in front of it would glow
  // through an overcast, and one added after the curve would be a flat wash on
  // top of the picture rather than light.
  //
  // Divided by the exposure because the bright pass multiplied by it: present()
  // is about to apply it again, and applying it twice would make the halo grow
  // three stops between noon and midnight all by itself.
  vec3 bloom = texture(uBloom, vUv).rgb * (bloomStrength() / max(uExposure, 1e-4));
  fragColor = vec4(present(scene * cloud.a + cloud.rgb + bloom * cloud.a), 1.0);
}
`;

export interface CompositeUniforms extends Record<string, THREE.IUniform> {
  uDepth: THREE.IUniform<THREE.Texture | null>;
  uInvProj: THREE.IUniform<THREE.Matrix4>;
  uInvView: THREE.IUniform<THREE.Matrix4>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uHalfSize: THREE.IUniform<THREE.Vector2>;
  uPhase: THREE.IUniform<THREE.Vector2>;
  uAmbTop: THREE.IUniform<THREE.Color>;
  uAmbBottom: THREE.IUniform<THREE.Color>;
  uCloudSun: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
  uLow: THREE.IUniform<THREE.Vector4>;
  uMid: THREE.IUniform<THREE.Vector4>;
  uHighCover: THREE.IUniform<number>;
  uHighBase: THREE.IUniform<number>;
  uWind: THREE.IUniform<THREE.Vector2>;
  uPrecip: THREE.IUniform<number>;
  uCloudFlags: THREE.IUniform<THREE.Vector4>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
  uShape: THREE.IUniform<THREE.Data3DTexture>;
  uDetail: THREE.IUniform<THREE.Data3DTexture>;
  uWeather: THREE.IUniform<THREE.DataTexture>;
}

export interface CompositeOptions {
  tier: "full" | "reduced";
  /** `?clouddebug=1`: present the measurement frame; see PRESENT_FRAG. */
  debug?: boolean;
  /**
   * `?cloudbench=N`: draw the cloud passes N extra times a frame, so their
   * cost stands out of a frame time that other GPU users make noisy:
   * (ms(N) - ms(0)) / N is the cost of one frame's march and shadow map
   * (the reconstruct, a half-res copy, is left out: it would read the
   * buffer it writes).
   */
  benchRepeats?: number;
  /** `?cloudwm=0`: uniform coverage instead of the weather map (a gate probe). */
  uniformCoverage?: boolean;
  /** `?cloudflatbase=0`: the old wandering base profile (a gate probe). */
  oldBase?: boolean;
  /**
   * `?cloudprobe=a,b`: restore one piece of the previous model so
   * tools/verify-clouds.ts can show its measure fails without the change.
   * noshadow: no cloud shadow on the ground. oldshape: the previous erosion
   * and streaky stratocumulus. oldlight: the previous scattering octaves.
   */
  probe?: string;
}

function fullscreenGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

function pass(frag: string, uniforms: Record<string, THREE.IUniform>, defines = ""): THREE.Scene {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(
    fullscreenGeometry(),
    new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: defines + frag,
      uniforms,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
    }),
  );
  mesh.frustumCulled = false;
  scene.add(mesh);
  return scene;
}

/**
 * Cumulus 1 to stratus 0, from how much of the sky a deck covers.
 *
 * The feed has no cloud type, but coverage is a good proxy for the low deck:
 * a few eighths is convective (fair-weather cumulus over thermals), five to
 * seven eighths is stratocumulus, and a full low deck is stratus. Rain pushes
 * toward nimbostratus, a stratiform deck.
 */
export function deckType(cover: number, precip: number): number {
  const t = Math.max(0, Math.min(1, 1 - (cover - 0.35) / 0.55));
  return t * (1 - 0.7 * Math.min(1, precip));
}

// The four half-res pixels of a 2x2 block, in the order the march visits them.
// Diagonal first, so two frames already cover the block in a checkerboard.
const PHASES: readonly [number, number][] = [[0, 0], [1, 1], [1, 0], [0, 1]];

/**
 * Clouds marched at a quarter of the half-res pixels per frame, reconstructed
 * to half res, then a full-resolution present that folds them over the scene
 * and applies the tone curve.
 */
export class Composite {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly uniforms: CompositeUniforms;
  readonly presentUniforms: {
    uScene: THREE.IUniform<THREE.Texture | null>;
    uCloud: THREE.IUniform<THREE.Texture | null>;
    uCloudAux: THREE.IUniform<THREE.Texture | null>;
    uBloom: THREE.IUniform<THREE.Texture | null>;
    uExposure: THREE.IUniform<number>;
    uNight: THREE.IUniform<number>;
    uDebug: THREE.IUniform<number>;
    uDepth: THREE.IUniform<THREE.Texture | null>;
    uInvProj: THREE.IUniform<THREE.Matrix4>;
  };
  readonly brightUniforms: {
    uScene: THREE.IUniform<THREE.Texture | null>;
    uExposure: THREE.IUniform<number>;
    uNight: THREE.IUniform<number>;
  };
  /**
   * Seconds added to the animation clock for the clouds only. The screenshot
   * harness holds the clock at zero; tools/verify-clouds.ts moves this to ask
   * what one frame of cloud time does to the picture.
   */
  timeOffset = 0;

  private readonly marchScene: THREE.Scene;
  /**
   * The phone tier's march (fewer view and light steps) on a full-tier
   * device, for render/quality.ts to drop to; null on the reduced tier, which
   * has nothing lower. Compiled on the first frame rather than when it is
   * first needed, so stepping down does not itself cost a frame.
   */
  private readonly marchSceneLow: THREE.Scene | null;
  private lowCompiled = false;
  /** March with the cheaper scene, when there is one. */
  lowClouds = false;
  private readonly reconScene: THREE.Scene;
  private readonly shadowScene: THREE.Scene;
  private readonly presentScene: THREE.Scene;
  private readonly brightScene: THREE.Scene;
  private readonly blurScene: THREE.Scene;
  private readonly blurUniforms: {
    uSource: THREE.IUniform<THREE.Texture | null>;
    uDirection: THREE.IUniform<THREE.Vector2>;
  };
  private readonly reconUniforms: Record<string, THREE.IUniform>;
  private readonly shadowUniforms: Record<string, THREE.IUniform>;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;

  private march: THREE.WebGLRenderTarget;
  private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private historyValid = false;
  private frame = 0;
  private readonly viewProj = new THREE.Matrix4();
  private readonly prevViewProj = new THREE.Matrix4();
  private hasPrev = false;

  private readonly shadowMap: THREE.WebGLRenderTarget;
  private readonly shadowSize: number;
  /** Metres the cloud shadow map spans. */
  private readonly shadowExtent: number;
  private shadowOn = false;
  /** Stages left out, for tools/profile.ts: "clouds", "cloudshadow", "bloom". */
  skip: ReadonlySet<string> = new Set();
  private sunUniforms: SunShadowUniforms | null = null;

  private readonly benchRepeats: number;
  private readonly noShadow: boolean;
  private readonly shapeNoise: THREE.Data3DTexture;
  private readonly detailNoise: THREE.Data3DTexture;
  private readonly weatherMap: THREE.DataTexture;
  // Kept across calls so the metric does not allocate a megabyte per sample.
  private readback: Uint16Array | null = null;

  constructor(renderer: THREE.WebGLRenderer, opts: CompositeOptions = { tier: "full" }) {
    const bakeStart = performance.now();
    this.shapeNoise = makeShapeNoise();
    this.detailNoise = makeDetailNoise();
    this.weatherMap = makeWeatherMap();
    console.log(`[flyby] cloud noise baked in ${(performance.now() - bakeStart).toFixed(0)} ms`);

    const reduced = opts.tier === "reduced";
    this.benchRepeats = opts.benchRepeats ?? 0;
    const probes = new Set((opts.probe ?? "").split(",").filter(Boolean));
    this.noShadow = probes.has("noshadow");
    this.uniforms = {
      uDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      uHalfSize: { value: new THREE.Vector2(1, 1) },
      uPhase: { value: new THREE.Vector2() },
      uAmbTop: { value: new THREE.Color(0.2, 0.24, 0.3) },
      uAmbBottom: { value: new THREE.Color(0.06, 0.07, 0.08) },
      uCloudSun: { value: new THREE.Color(1, 1, 1) },
      uTime: { value: 0 },
      uLow: { value: new THREE.Vector4(0, 800, 1800, 1) },
      uMid: { value: new THREE.Vector4(0, 3800, 5000, 0.5) },
      uHighCover: { value: 0 },
      uHighBase: { value: 9000 },
      uWind: { value: new THREE.Vector2() },
      uPrecip: { value: 0 },
      uCloudFlags: { value: new THREE.Vector4(opts.uniformCoverage ? 0 : 1, opts.oldBase ? 0 : 1, probes.has("oldshape") ? 0 : 1, probes.has("oldlight") ? 0 : 1) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 16 },
      uMieG: { value: 0.76 },
      uTurbidity: { value: 1 },
      uCamAltitude: { value: 100 },
      uMultiScatter: { value: 0.055 },
      ...SKYGLOW_UNIFORMS,
      uShape: { value: this.shapeNoise },
      uDetail: { value: this.detailNoise },
      uWeather: { value: this.weatherMap },
    };

    // The phone tier: fewer view and light steps, and a coarser atmosphere
    // integral for the aerial perspective, which only has to get a haze
    // colour right, not a sky.
    const low = "#define CLOUD_STEPS 40\n#define LIGHT_STEPS 3\n#define ATMO_STEPS 6\n#define ATMO_SUN_STEPS 2\n#define SHADOW_STEPS 6\n";
    const defines = reduced
      ? low
      : "#define CLOUD_STEPS 64\n#define LIGHT_STEPS 5\n#define ATMO_STEPS 10\n#define ATMO_SUN_STEPS 3\n#define SHADOW_STEPS 10\n";
    this.marchScene = pass(MARCH_FRAG, this.uniforms, defines);
    this.marchSceneLow = reduced ? null : pass(MARCH_FRAG, this.uniforms, low);

    this.reconUniforms = {
      uInvProj: this.uniforms.uInvProj,
      uInvView: this.uniforms.uInvView,
      uCameraPos: this.uniforms.uCameraPos,
      uHalfSize: this.uniforms.uHalfSize,
      uPhase: this.uniforms.uPhase,
      uCurr: { value: null },
      uCurrAux: { value: null },
      uHist: { value: null },
      uHistAux: { value: null },
      uPrevViewProj: { value: this.prevViewProj },
      uHistValid: { value: 0 },
    };
    this.reconScene = pass(RECON_FRAG, this.reconUniforms);

    // 24 km at 94 m a texel on a desktop, 12 km on a phone: past that the
    // ground is far enough away that a cloud shadow is a tint in the haze.
    this.shadowSize = reduced ? 128 : 256;
    this.shadowExtent = reduced ? 12000 : 24000;
    this.shadowUniforms = {
      ...this.uniforms,
      uMapRect: { value: new THREE.Vector4(0, 0, this.shadowExtent, this.shadowSize) },
      uMapSlab: { value: new THREE.Vector2() },
    };
    this.shadowScene = pass(SHADOW_FRAG, this.shadowUniforms, defines);
    this.shadowMap = new THREE.WebGLRenderTarget(this.shadowSize, this.shadowSize, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      // The top mip is the map's mean, which is what cloudSunVisibility
      // normalises by; the GPU averages it for free when it builds the chain.
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.presentUniforms = {
      uScene: { value: null },
      uCloud: { value: null },
      uCloudAux: { value: null },
      uBloom: { value: null },
      uExposure: { value: 1 },
      uNight: { value: 0 },
      uDebug: { value: opts.debug ? 1 : 0 },
      uDepth: this.uniforms.uDepth,
      uInvProj: this.uniforms.uInvProj,
    };
    this.brightUniforms = {
      uScene: { value: null },
      uExposure: { value: 1 },
      uNight: { value: 0 },
    };
    this.blurUniforms = {
      uSource: { value: null },
      uDirection: { value: new THREE.Vector2(1, 0) },
    };
    this.presentScene = pass(PRESENT_FRAG, this.presentUniforms as unknown as Record<string, THREE.IUniform>);
    this.brightScene = pass(BRIGHT_FRAG, this.brightUniforms as unknown as Record<string, THREE.IUniform>);
    this.blurScene = pass(BLUR_FRAG, this.blurUniforms as unknown as Record<string, THREE.IUniform>);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const bloomOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    // Quarter resolution in each axis: a bloom is a low-frequency halo by
    // definition, and running it at full resolution would be paying sixteen
    // times over for detail the blur is about to destroy.
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, bloomOpts);
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, bloomOpts);

    // Two attachments: colour (rgb in-scatter, a transmittance) and aux (x the
    // cloud's depth, for reprojection; y the first-hit altitude, for the gate).
    const cloudOpts = { ...bloomOpts, count: 2 };
    this.march = new THREE.WebGLRenderTarget(1, 1, { ...cloudOpts, minFilter: THREE.LinearFilter });
    this.history = [
      new THREE.WebGLRenderTarget(1, 1, cloudOpts),
      new THREE.WebGLRenderTarget(1, 1, cloudOpts),
    ];
    this.setSizes(size);
  }

  private setSizes(size: THREE.Vector2): void {
    const hw = Math.max(1, Math.floor(size.x / 2));
    const hh = Math.max(1, Math.floor(size.y / 2));
    this.march.setSize(Math.ceil(hw / 2), Math.ceil(hh / 2));
    this.history[0].setSize(hw, hh);
    this.history[1].setSize(hw, hh);
    this.uniforms.uHalfSize.value.set(hw, hh);
    this.bloomA.setSize(Math.max(1, Math.floor(size.x / 4)), Math.max(1, Math.floor(size.y / 4)));
    this.bloomB.setSize(Math.max(1, Math.floor(size.x / 4)), Math.max(1, Math.floor(size.y / 4)));
    this.historyValid = false;
  }

  resize(renderer: THREE.WebGLRenderer): void {
    this.setSizes(renderer.getDrawingBufferSize(new THREE.Vector2()));
  }

  /**
   * Hand the cloud shadow map to every lit surface. The uniform objects are
   * the shared ones every scene material spread in, so setting their values
   * here reaches all of them.
   */
  attachShadow(u: SunShadowUniforms): void {
    this.sunUniforms = u;
    u.uCloudShadowMap.value = this.shadowMap.texture;
  }

  /** Clouds, then present to the screen. */
  render(renderer: THREE.WebGLRenderer, sceneColour: THREE.Texture, depth: THREE.Texture | null): void {
    const [px, py] = PHASES[this.frame % 4];
    this.frame++;
    this.uniforms.uPhase.value.set(px, py);
    this.uniforms.uDepth.value = depth;
    const clouds = !this.skip.has("clouds");
    if (this.marchSceneLow && !this.lowCompiled) {
      renderer.compile(this.marchSceneLow, this.camera);
      this.lowCompiled = true;
    }
    const march = this.lowClouds && this.marchSceneLow ? this.marchSceneLow : this.marchScene;
    renderer.setRenderTarget(this.march);
    if (clouds) renderer.render(march, this.camera);
    for (let i = 0; i < this.benchRepeats; i++) {
      renderer.render(this.marchScene, this.camera);
      if (this.shadowOn) {
        renderer.setRenderTarget(this.shadowMap);
        renderer.render(this.shadowScene, this.camera);
      }
      renderer.setRenderTarget(this.march);
    }

    const [read, write] = this.history;
    const ru = this.reconUniforms;
    ru.uCurr.value = this.march.textures[0];
    ru.uCurrAux.value = this.march.textures[1];
    ru.uHist.value = read.textures[0];
    ru.uHistAux.value = read.textures[1];
    ru.uHistValid.value = this.historyValid && this.hasPrev ? 1 : 0;
    renderer.setRenderTarget(write);
    if (clouds) renderer.render(this.reconScene, this.camera);
    this.history = [write, read];
    this.historyValid = true;

    // Drawn after this frame's scene, so the ground reads last frame's map:
    // a frame of lag on something that moves at the wind's speed.
    if (this.shadowOn && !this.skip.has("cloudshadow")) {
      renderer.setRenderTarget(this.shadowMap);
      renderer.render(this.shadowScene, this.camera);
    }

    // Bright pass, then one blur across and one down.
    this.brightUniforms.uScene.value = sceneColour;
    const bloom = !this.skip.has("bloom");
    renderer.setRenderTarget(this.bloomA);
    if (bloom) renderer.render(this.brightScene, this.camera);

    this.blurUniforms.uSource.value = this.bloomA.texture;
    this.blurUniforms.uDirection.value.set(1, 0);
    renderer.setRenderTarget(this.bloomB);
    if (bloom) renderer.render(this.blurScene, this.camera);

    this.blurUniforms.uSource.value = this.bloomB.texture;
    this.blurUniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(this.bloomA);
    if (bloom) renderer.render(this.blurScene, this.camera);

    this.presentUniforms.uScene.value = sceneColour;
    this.presentUniforms.uCloud.value = write.textures[0];
    this.presentUniforms.uCloudAux.value = write.textures[1];
    this.presentUniforms.uBloom.value = this.bloomA.texture;
    renderer.setRenderTarget(null);
    renderer.render(this.presentScene, this.camera);
  }

  /**
   * How row-aligned the cloud buffer is, which is the number that says whether
   * the march is terracing.
   *
   * The cloud texture is close to isotropic: a real cloud field has no
   * preferred screen axis, so the mean vertical and horizontal luminance
   * gradients should be about equal and the ratio should sit near 1. Terraces
   * are iso-elevation arcs, which are row-aligned by construction, so they show
   * up as vertical gradient with no horizontal partner and push the ratio well
   * above 1. Filtering at 8 half-res pixels first is what keeps the dither and
   * the cloud's own fine detail out of the measurement, since both are
   * isotropic and would only dilute the signal.
   *
   * Only blocks that are ENTIRELY cloud count (alpha, the fraction of the world
   * still visible, below 0.5 across the whole block). A block straddling the
   * edge of the deck carries the edge's own huge gradient, which has nothing to
   * do with banding.
   */
  measureBanding(renderer: THREE.WebGLRenderer): { rows: number; cols: number; ratio: number } {
    const target = this.history[0];
    const w = target.width;
    const h = target.height;
    const need = w * h * 4;
    if (!this.readback || this.readback.length !== need) this.readback = new Uint16Array(need);
    const buf = this.readback;
    // The target is HalfFloat, so readPixels wants a Uint16Array and every
    // component has to be decoded before it means anything.
    renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);

    const BLOCK = 8;
    const bw = Math.floor(w / BLOCK);
    const bh = Math.floor(h / BLOCK);
    if (bw < 2 || bh < 2) return { rows: 0, cols: 0, ratio: 0 };

    const lum = new Float32Array(bw * bh);
    const solid = new Uint8Array(bw * bh);
    const half = THREE.DataUtils.fromHalfFloat;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let sum = 0;
        let n = 0;
        for (let y = 0; y < BLOCK; y++) {
          const row = (by * BLOCK + y) * w;
          for (let x = 0; x < BLOCK; x++) {
            const i = (row + bx * BLOCK + x) * 4;
            if (half(buf[i + 3]) >= 0.5) continue;
            sum += 0.2126 * half(buf[i]) + 0.7152 * half(buf[i + 1]) + 0.0722 * half(buf[i + 2]);
            n++;
          }
        }
        if (n === BLOCK * BLOCK) {
          lum[by * bw + bx] = sum / n;
          solid[by * bw + bx] = 1;
        }
      }
    }

    let rowSum = 0;
    let rowN = 0;
    let colSum = 0;
    let colN = 0;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const i = by * bw + bx;
        if (!solid[i]) continue;
        if (by + 1 < bh && solid[i + bw]) {
          rowSum += Math.abs(lum[i + bw] - lum[i]);
          rowN++;
        }
        if (bx + 1 < bw && solid[i + 1]) {
          colSum += Math.abs(lum[i + 1] - lum[i]);
          colN++;
        }
      }
    }
    if (rowN === 0 || colN === 0) return { rows: 0, cols: 0, ratio: 0 };
    const rows = rowSum / rowN;
    const cols = colSum / colN;
    return { rows, cols, ratio: rows / Math.max(cols, 1e-9) };
  }

  update(
    camera: THREE.PerspectiveCamera,
    wx: Weather,
    light: SceneLighting,
    timeSec: number,
    sh: SH9 | null = null,
    cityUplight: THREE.Color | null = null,
  ): void {
    const u = this.uniforms;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
    u.uCameraPos.value.copy(camera.position);
    u.uTime.value = timeSec + this.timeOffset;

    // Last frame's camera, for the reconstruct. Taken before this frame's is
    // written over it.
    this.prevViewProj.copy(this.viewProj);
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.hasPrev) this.prevViewProj.copy(this.viewProj);
    this.hasPrev = true;

    u.uLow.value.set(wx.low.cover, wx.low.base, wx.low.top, deckType(wx.low.cover, wx.precip));
    // Altocumulus at most halfway to cumuliform: the mid deck is never a field
    // of towers in this model.
    u.uMid.value.set(wx.mid.cover, wx.mid.base, wx.mid.top, 0.5 * deckType(wx.mid.cover, wx.precip));
    u.uHighCover.value = wx.high.cover;
    u.uHighBase.value = wx.high.base;

    // Meteorological wind direction is where it comes FROM; the drift vector is
    // where the air is going. In world axes that is (+x east, +z south).
    const to = ((wx.windDir + 180) * Math.PI) / 180;
    u.uWind.value.set(Math.sin(to) * wx.windSpeed, -Math.cos(to) * wx.windSpeed);
    u.uPrecip.value = Math.min(1, wx.precip * 1.2);

    u.uSunDir.value.copy(light.sunDir);
    u.uSunColor.value.copy(light.sunColor);
    u.uSunIntensity.value = light.sunIntensity;
    u.uMieG.value = light.mieG;
    u.uTurbidity.value = light.turbidity;
    u.uCamAltitude.value = camera.position.y;

    // The clouds are lit by the beam ABOVE them. lighting.ts dims the sun by
    // every deck's opacity, which is right for the ground under an average sky
    // and wrong for the cloud doing the dimming: a sunlit cumulus top is the
    // brightest thing in a daytime frame. Undo the low and mid decks' share;
    // the cirrus's stays, it is above everything. The march's own light
    // transport does the dimming the decks owe, sample by sample. 0.105 is the
    // calibration the clouds have always used against the sky's units.
    const keep = 1 - 0.28 * wx.high.cover;
    const gain = keep / Math.max(1 - wx.opacity, 0.02);
    u.uCloudSun.value.copy(light.sunColor).multiplyScalar(light.sunIntensity * gain * 0.105);

    // Ambient from the sky probe: its zenith irradiance is anchored to the
    // lighting model's ambient (render/sh.ts), so the probe supplies the RATIO
    // of light from below to light from above, and the cloud base takes the
    // ground's colour and level from it rather than a guess.
    u.uAmbTop.value.copy(light.ambient);
    let downRatio = [0.3, 0.3, 0.3];
    if (sh) {
      const up = new Float32Array(3);
      const down = new Float32Array(3);
      shIrradiance(sh, 0, 1, 0, up);
      shIrradiance(sh, 0, -1, 0, down);
      downRatio = [0, 1, 2].map((c) =>
        up[c] > 1e-6 && Number.isFinite(down[c]) ? Math.max(0.05, Math.min(1, down[c] / up[c])) : 0.3,
      );
    }
    u.uAmbBottom.value.setRGB(
      light.ambient.r * downRatio[0],
      light.ambient.g * downRatio[1],
      light.ambient.b * downRatio[2],
    );
    // A cloud base over a city at night is lit from below by it
    // (render/skyglow.ts): the orange underside of a low overcast over
    // Manhattan is the brightest thing in its sky. The interior gets a third
    // of it, as light that has scattered up into the deck.
    if (cityUplight) {
      u.uAmbBottom.value.add(cityUplight);
      u.uAmbTop.value.r += cityUplight.r / 3;
      u.uAmbTop.value.g += cityUplight.g / 3;
      u.uAmbTop.value.b += cityUplight.b / 3;
    }

    // The cloud shadow map, centred on the camera and snapped to its texels so
    // a shadow does not crawl as the aircraft moves.
    const lowOn = wx.low.cover > 0.03;
    const midOn = wx.mid.cover > 0.03;
    this.shadowOn = (lowOn || midOn) && light.sunDir.y > 0.02;
    const su = this.sunUniforms;
    if (su) {
      su.uCloudShadow.value.set(this.shadowOn && this.historyValid && !this.noShadow ? 1 : 0, gain, 0, 0);
      if (this.shadowOn) {
        const lo = Math.min(lowOn ? wx.low.base - 0.1 * (wx.low.top - wx.low.base) : 1e9,
          midOn ? wx.mid.base - 0.1 * (wx.mid.top - wx.mid.base) : 1e9);
        const hi = Math.max(lowOn ? wx.low.top : -1e9, midOn ? wx.mid.top : -1e9);
        // Centre on where the sun ray from the camera's ground point meets
        // the plane, so the map covers the ground in view and not a patch
        // displaced downsun of it.
        const sd = light.sunDir;
        const s = (lo - 0) / Math.max(sd.y, 0.08);
        const texel = this.shadowExtent / this.shadowSize;
        const cx = Math.round((camera.position.x + sd.x * s) / texel) * texel;
        const cz = Math.round((camera.position.z + sd.z * s) / texel) * texel;
        const x0 = cx - this.shadowExtent / 2;
        const z0 = cz - this.shadowExtent / 2;
        (this.shadowUniforms.uMapRect.value as THREE.Vector4).set(x0, z0, this.shadowExtent, this.shadowSize);
        (this.shadowUniforms.uMapSlab.value as THREE.Vector2).set(lo, hi);
        su.uCloudShadowRect.value.set(x0, z0, 1 / this.shadowExtent, lo);
      }
    }
  }
}
