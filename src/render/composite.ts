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
//   HIGH  cirrus, drawn as a thin fibrous veil rather than a volume -- it is
//         ice, it has no visible body, and marching it as a slab wastes steps
//         on something that should read as a smear of white.
//
// Cost control: the march terminates on transmittance, steps are spaced by
// deck thickness, and the whole pass is skipped for a deck with no coverage. A
// clear day costs almost nothing, which is the common case.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import { makeShapeNoise, makeDetailNoise } from "./noise3d";
import type { Weather } from "../data/weather";
import type { SceneLighting } from "./lighting";

const VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
out vec3 vRayDir;
uniform mat4 uInvProj;
uniform mat4 uInvView;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  vec4 view = uInvProj * vec4(p, 1.0, 1.0);
  // Unnormalised, as in the sky pass: normalising per-vertex and interpolating
  // skews the ray across a triangle this large.
  vRayDir = mat3(uInvView) * (view.xyz / view.w);
  gl_Position = vec4(p, 1.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
in vec3 vRayDir;
out vec4 fragColor;

${ATMOSPHERE_GLSL}
${TONEMAP_GLSL}

uniform sampler2D uDepth;
uniform float uSunSurfaceCloud;
uniform mat4  uInvProj2;
uniform vec3  uCameraPos;
uniform vec3  uAmbient;
uniform float uNear;
uniform float uFar;
uniform float uTime;

// Per-deck: x = coverage 0..1, y = base (m AMSL), z = top (m AMSL)
uniform vec3 uLow;
uniform vec3 uMid;
uniform float uHighCover;
uniform float uHighBase;
uniform vec2  uWind;        // metres/second, (east, south)
uniform float uPrecip;      // mm/h, darkens and thickens the low deck

// Baked, tileable, and sampled with hardware trilinear filtering. See
// noise3d.ts for what is in each channel and why it is baked rather than
// evaluated per sample here.
uniform sampler3D uShape;   // rgba: perlin, then worley at 1x / 2x / 4x
uniform sampler3D uDetail;  // rgb: worley at three frequencies

float remap(float v, float lo, float hi, float nlo, float nhi) {
  return nlo + (v - lo) / (hi - lo) * (nhi - nlo);
}

/**
 * The Perlin-Worley combine, one texture fetch.
 *
 * Perlin alone is a field of smooth blobs and reads as fog rather than as
 * cloud. The Worley fbm enters as the LOW END of a remap rather than as a
 * multiplier, which keeps Perlin's large-scale wandering while giving the
 * inside of it the packed-billow silhouette a cumulus actually has.
 */
float perlinWorley(vec3 p) {
  vec4 t = texture(uShape, p);
  float wfbm = t.g * 0.625 + t.b * 0.25 + t.a * 0.125;
  return clamp(remap(t.r, -(1.0 - wfbm), 1.0, 0.0, 1.0), 0.0, 1.0);
}

/**
 * Density of a cloud slab at a world point.
 *
 * Coverage enters as a THRESHOLD on the noise, not as a multiplier. That
 * distinction is what makes 30% coverage look like scattered cumulus with blue
 * between them rather than a uniform grey haze at 30% opacity -- which is what
 * a multiplier gives, and it looks nothing like a real sky.
 */
float slabDensity(vec3 p, float cover, float base, float top, float scale) {
  if (cover <= 0.01) return 0.0;
  float thickness = max(top - base, 1.0);

  // The WEATHER field: one low-frequency tap at a fixed depth, so it varies
  // over kilometres of ground and not at all with height. It is what stops a
  // full overcast being a plane. The reported coverage is the average over the
  // sky, so letting it vary about that average is not inventing weather, it is
  // declining to pretend the deck is uniform.
  float w = texture(uShape, vec3(p.xz * scale * 0.25, 0.37)).r;

  float localCover = clamp(cover * (0.8 + 0.4 * w), 0.0, 1.0);
  // The base and the top are surfaces, not altitudes. A real stratocumulus
  // base sags and lifts by a good fraction of the deck's own depth, and the top
  // moves further than the base because that is where the convection is.
  float localBase = base + 0.15 * thickness * (w - 0.5);
  float localTop  = top  + 0.25 * thickness * (w - 0.5);

  float h = (p.y - localBase) / max(localTop - localBase, 1.0);
  if (h < 0.0 || h > 1.0) return 0.0;

  // Round the top, flatten the bottom: cumulus grow upward from a flat base.
  // Both ends are a FRACTION of the deck's thickness. As a fixed 120 m the ramp
  // was a hard event at one altitude, and the march crossed it at a different
  // step for every screen row, which is one of the things the terracing was.
  float profile = smoothstep(0.0, 0.2, h) * smoothstep(1.0, 0.6, h);

  vec3 q = p;
  q.xz += uWind * uTime;
  float shape = perlinWorley(q * scale);

  // The threshold is a REMAP rather than a smoothstep, which is what makes it
  // survive full coverage. smoothstep(0, 0.14, n) is 1 almost everywhere, so a
  // 100% deck came out as a constant: a mathematically flat plane of plaster.
  // The remap hands back the noise itself at localCover 1, so an overcast still
  // has thick and thin parts for the light to find.
  float d = clamp(remap(shape, 1.0 - localCover, 1.0, 0.0, 1.0), 0.0, 1.0) * profile;

  // Erosion, at the edges only, where it is the entire difference between a
  // cloud and a blob. The interior is opaque and nothing about it is visible,
  // so it does not pay for the second fetch. The detail rides the same wind as
  // the shape, or it would crawl across a moving cloud.
  if (d > 0.0 && d < 0.3) {
    vec3 t = texture(uDetail, q * scale * 6.0).rgb;
    float detail = t.r * 0.625 + t.g * 0.25 + t.b * 0.125;
    d = clamp(remap(d, detail * 0.35, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return d;
}

float cloudDensity(vec3 p) {
  float d = slabDensity(p, uLow.x, uLow.y, uLow.z, 0.00055) * (1.0 + uPrecip * 0.6);
  d += slabDensity(p, uMid.x, uMid.y, uMid.z, 0.00030) * 0.75;
  return d;
}

void main() {
  vec3 rd = normalize(vRayDir);
  // Accumulated in-scatter, and how much of the world survives through it.
  vec3 scattered = vec3(0.0);
  vec3 through = vec3(1.0);

  // Scene distance from the depth buffer, so clouds occlude and are occluded.
  float d = texture(uDepth, vUv).r;
  float sceneDist = 1.0e9;
  if (d < 1.0) {
    vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 view = uInvProj2 * clip;
    sceneDist = length(view.xyz / view.w);
  }

  float lowCover = uLow.x;
  float midCover = uMid.x;

  // Below this there is nothing to see and the march is pure waste. The old
  // 0.01 gate meant a 3% sky paid the full 32-step price for a few wisps.
  if (lowCover > 0.06 || midCover > 0.06) {
    float slabLo = min(uLow.y, uMid.y);
    float slabHi = max(uLow.z, uMid.z);

    // Clip the march to the span of sky that can hold cloud at all.
    float t0 = 0.0;
    // Far enough that a near-horizontal ray still reaches an overcast deck.
    // The world is a flat plane, so an overcast seen from underneath runs to
    // the horizon and must not END anywhere a pixel can see: at 90 km, and
    // still at 170 km, the march ran out and drew a hard bright line across
    // the sky under the deck -- bare horizon sky showing through where the
    // cloud simply stopped. Everything past ~100 km compresses into the last
    // few pixels above the horizon, so the extra range is nearly free, and it
    // is entirely free in steps because they grow geometrically.
    float t1 = min(sceneDist, 400000.0);
    if (abs(rd.y) > 1e-4) {
      float ta = (slabLo - uCameraPos.y) / rd.y;
      float tb = (slabHi - uCameraPos.y) / rd.y;
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    } else if (uCameraPos.y < slabLo || uCameraPos.y > slabHi) {
      t1 = t0;  // horizontal ray outside the slab: nothing to march
    }

    if (t1 > t0) {
      // 32 steps, not 56. The march is the single most expensive thing in the
      // frame -- steps x (2 slab evaluations + 4 light steps) x a 4-octave fbm
      // is roughly 18k hash evaluations per pixel, and at full resolution that
      // is what took Istanbul to half a frame per second.
      const int STEPS = 32;

      // GEOMETRIC steps, not uniform ones. The slab clip bounds the march for
      // a ray that crosses the deck, but a ray that runs ALONG it -- the
      // camera inside or just under an overcast, looking at the horizon --
      // spans the full 170 km, and 32 uniform steps of that is a 5 km step.
      // No dither hides a 5 km step: it arrives as the horizontal banding that
      // striped the deck near the horizon.
      //
      // A step proportional to distance is the right shape, because that is
      // what keeps a sample's SCREEN size constant: near cloud is resolved and
      // far cloud, which the range fade is thinning out anyway, is not. The
      // growth is normalised so the same 32 steps still span exactly t0..t1,
      // so a short march (looking down through a deck) is unaffected.
      const float GROWTH = 1.12;
      float norm = (pow(GROWTH, float(STEPS)) - 1.0) / (GROWTH - 1.0);
      float dt = (t1 - t0) / norm;
      // Dither the start offset, or the fixed step size shows as concentric
      // banding. A per-pixel HASH decorrelates but is spatially incoherent, and
      // this pass runs at HALF resolution, so the upsample magnified every
      // speck into a 2x2 block: television static.
      //
      // A 2x2 ordered matrix, not the 4x4 this used to use, and the size is the
      // whole point. The present pass reconstructs the march by averaging a
      // 3x3 half-res neighbourhood with tent weights [1 2 1; 2 4 2; 1 2 1]/16,
      // and over a period-2 pattern those weights land 4/16 on EVERY phase --
      // an exact average of all four offsets, so the dither cancels completely
      // rather than being smeared. A 4x4 pattern has sixteen phases and no
      // small kernel can average them evenly, which is why it survived the
      // upsample as the visible cross-hatch it was drawing across the sky.
      // STRATIFIED, not merely ordered. The 2x2 matrix says which QUARTER of
      // the step this pixel samples, and interleaved gradient noise picks a
      // position inside that quarter. The ordered part is what the tent
      // cancels exactly; the noise is what turns the leftover into fine grain
      // instead of the concentric rings a purely ordered pattern leaves, which
      // is what four fixed offsets over a kilometre-long step looked like.
      ivec2 px = ivec2(gl_FragCoord.xy) & 1;
      const float BAYER[4] = float[4](0.0, 2.0, 3.0, 1.0);
      float ign = fract(52.9829189 *
        fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float jitter = (BAYER[px.y * 2 + px.x] + ign) * 0.25;
      float t = t0 + dt * jitter;

      float cosSun = dot(rd, uSunDir);
      // Two lobes: a strong forward one for the silver lining looking toward
      // the sun, and a weak backward one so the far side is not dead flat.
      float ph = mix(miePhase(cosSun, 0.80), miePhase(cosSun, -0.30), 0.35);

      for (int i = 0; i < STEPS; i++) {
        if (t > t1) break;
        if (through.g < 0.02) break;

        vec3 p = uCameraPos + rd * t;
        // Fade the deck out toward the march limit by thinning it, NOT by
        // dimming it. Dimming the light while leaving the opacity alone turned
        // distant cloud BLACK and drew a hard dark line across the sky where
        // the march ended -- the deck was still fully opaque, just unlit.
        float dens = cloudDensity(p) * smoothstep(400000.0, 200000.0, t);

        if (dens > 0.001) {
          // Light march toward the sun: how deep is this sample buried?
          //
          // The two extinction coefficients below are not free. A sunlit cloud
          // top is the BRIGHTEST thing in a daytime frame -- brighter than lit
          // ground, because cloud albedo is ~0.9 against a city's ~0.2. Setting
          // the light-march extinction too high buries the tops in their own
          // shadow and the whole deck turns dirty grey, which is what happened.
          // These values put a cloud top near transmittance 0.8 and a deep base
          // near 0.3, which is the range that reads as a cloud.
          const float LIGHT_STEP = 120.0;
          const float SIGMA_LIGHT = 0.004;
          const float SIGMA_VIEW = 0.012;

          float shadow = 0.0;
          for (int j = 0; j < 3; j++) {
            vec3 sp = p + uSunDir * (LIGHT_STEP * (float(j) + 0.5));
            shadow += cloudDensity(sp);
          }
          float sunT = exp(-shadow * LIGHT_STEP * SIGMA_LIGHT * (4.0 / 3.0));

          // Powder: the dark cores of a cloud seen against the light. Without
          // it clouds look like cotton wool with no interior.
          float powder = 1.0 - exp(-dens * 8.0);

          float sigma = dens * SIGMA_VIEW;
          vec3 stepT = exp(-vec3(sigma) * dt);

          vec3 sunColour = uSunColor * uSunIntensity * uSunSurfaceCloud;
          vec3 lum = sunColour * (ph * 4.0 + 0.5) * sunT * mix(0.35, 1.0, powder)
                   + uAmbient * 0.9;

          // Rain shafts read as darker cloud bases.
          lum *= 1.0 - 0.35 * uPrecip * smoothstep(uLow.z, uLow.y, p.y);

          scattered += through * lum * (1.0 - stepT.g);
          through *= stepT;
        }
        t += dt;
        dt *= GROWTH;
      }

    }
  }

  // --- High cirrus -------------------------------------------------------
  // Drawn analytically as a veil on the ray's intersection with one altitude,
  // not marched. Cirrus is a two-dimensional smear of ice; giving it volume
  // costs steps and makes it look like a low deck in the wrong place.
  if (uHighCover > 0.01 && rd.y > 0.02) {
    float th = (uHighBase - uCameraPos.y) / rd.y;
    if (th > 0.0 && th < sceneDist) {
      vec3 p = uCameraPos + rd * th;
      vec2 q = (p.xz + uWind * uTime * 2.5) * 0.00016;
      // Stretch the noise along one axis: cirrus is combed out by the wind. One
      // fixed slice of the shape volume, because cirrus has no depth to sample.
      float n = perlinWorley(vec3(q.x * 0.35, q.y * 2.4, 0.37));
      float veil = smoothstep(1.0 - uHighCover, 1.0 - uHighCover * 0.35, n);
      veil *= smoothstep(0.02, 0.25, rd.y);
      vec3 lit = uSunColor * uSunIntensity * uSunSurfaceCloud * 2.2 + uAmbient * 1.2;
      float a = veil * 0.55 * uHighCover;
      scattered = scattered * (1.0 - a) + lit * a;
      through *= (1.0 - a);
    }
  }

  // rgb: light added by cloud. a: fraction of the world still visible.
  fragColor = vec4(scattered, through.g);
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
uniform sampler2D uBloom;
${BLOOM_TERMS_GLSL}

void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  // Upsample of the half-resolution cloud buffer, and it is a TENT rather than
  // the single bilinear tap it used to be. Four taps half a texel off the
  // centre sum to weights [1 2 1; 2 4 2; 1 2 1]/16 over a 3x3 half-res
  // neighbourhood, which puts exactly 4/16 on each of the march's four dither
  // phases: the ray-start jitter averages out to nothing instead of arriving
  // on screen as a cross-hatch. Clouds are soft and low-frequency, so the two
  // full-res pixels of extra blur cost nothing that was really there.
  vec2 texel = 1.0 / vec2(textureSize(uCloud, 0));
  vec4 cloud = 0.25 * (
      texture(uCloud, vUv + vec2(-0.5, -0.5) * texel)
    + texture(uCloud, vUv + vec2( 0.5, -0.5) * texel)
    + texture(uCloud, vUv + vec2(-0.5,  0.5) * texel)
    + texture(uCloud, vUv + vec2( 0.5,  0.5) * texel));
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
  uInvProj2: THREE.IUniform<THREE.Matrix4>;
  uInvView: THREE.IUniform<THREE.Matrix4>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uNear: THREE.IUniform<number>;
  uFar: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uLow: THREE.IUniform<THREE.Vector3>;
  uMid: THREE.IUniform<THREE.Vector3>;
  uHighCover: THREE.IUniform<number>;
  uHighBase: THREE.IUniform<number>;
  uWind: THREE.IUniform<THREE.Vector2>;
  uPrecip: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uSunSurfaceCloud: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
  uShape: THREE.IUniform<THREE.Data3DTexture>;
  uDetail: THREE.IUniform<THREE.Data3DTexture>;
}

function fullscreenGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

/**
 * Two passes: clouds raymarched at HALF resolution, then a full-resolution
 * present that folds them over the scene and applies the tone curve.
 *
 * Splitting them is what makes the cloud cost affordable. Marched at full
 * resolution the pass dominated the frame regardless of how much cloud there
 * actually was; at half resolution it costs a quarter as many pixels, and
 * clouds are soft enough that the upsample is invisible.
 */
export class Composite {
  readonly scene = new THREE.Scene();
  readonly presentScene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly uniforms: CompositeUniforms;
  readonly presentUniforms: {
    uScene: THREE.IUniform<THREE.Texture | null>;
    uCloud: THREE.IUniform<THREE.Texture | null>;
    uBloom: THREE.IUniform<THREE.Texture | null>;
    uExposure: THREE.IUniform<number>;
    uNight: THREE.IUniform<number>;
  };
  readonly brightUniforms: {
    uScene: THREE.IUniform<THREE.Texture | null>;
    uExposure: THREE.IUniform<number>;
    uNight: THREE.IUniform<number>;
  };

  private readonly brightScene = new THREE.Scene();
  private readonly blurScene = new THREE.Scene();
  private readonly blurUniforms: {
    uSource: THREE.IUniform<THREE.Texture | null>;
    uDirection: THREE.IUniform<THREE.Vector2>;
  };
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;

  private cloudTarget: THREE.WebGLRenderTarget;
  private readonly shapeNoise: THREE.Data3DTexture;
  private readonly detailNoise: THREE.Data3DTexture;
  // Kept across calls so the metric does not allocate a megabyte per sample.
  private readback: Uint16Array | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    const bakeStart = performance.now();
    this.shapeNoise = makeShapeNoise();
    this.detailNoise = makeDetailNoise();
    console.log(`[flyby] cloud noise baked in ${(performance.now() - bakeStart).toFixed(0)} ms`);

    this.uniforms = {
      uDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uInvProj2: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
      uNear: { value: 2 },
      uFar: { value: 200000 },
      uTime: { value: 0 },
      uLow: { value: new THREE.Vector3(0, 800, 1800) },
      uMid: { value: new THREE.Vector3(0, 3800, 5000) },
      uHighCover: { value: 0 },
      uHighBase: { value: 9000 },
      uWind: { value: new THREE.Vector2() },
      uPrecip: { value: 0 },
      uExposure: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 16 },
      uSunSurfaceCloud: { value: 0.105 },
      uMieG: { value: 0.76 },
      uTurbidity: { value: 1 },
      uCamAltitude: { value: 100 },
      uMultiScatter: { value: 0.055 },
      uShape: { value: this.shapeNoise },
      uDetail: { value: this.detailNoise },
    };

    const cloudMat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    const cloudMesh = new THREE.Mesh(fullscreenGeometry(), cloudMat);
    cloudMesh.frustumCulled = false;
    this.scene.add(cloudMesh);

    this.presentUniforms = {
      uScene: { value: null },
      uCloud: { value: null },
      uBloom: { value: null },
      uExposure: { value: 1 },
      uNight: { value: 0 },
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
    const presentMat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: PRESENT_FRAG,
      uniforms: this.presentUniforms as unknown as Record<string, THREE.IUniform>,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    const presentMesh = new THREE.Mesh(fullscreenGeometry(), presentMat);
    presentMesh.frustumCulled = false;
    this.presentScene.add(presentMesh);

    const addPass = (scene: THREE.Scene, frag: string, uniforms: Record<string, THREE.IUniform>) => {
      const mesh = new THREE.Mesh(
        fullscreenGeometry(),
        new THREE.RawShaderMaterial({
          vertexShader: VERT,
          fragmentShader: frag,
          uniforms,
          glslVersion: THREE.GLSL3,
          depthTest: false,
          depthWrite: false,
        }),
      );
      mesh.frustumCulled = false;
      scene.add(mesh);
    };
    addPass(this.brightScene, BRIGHT_FRAG, this.brightUniforms as unknown as Record<string, THREE.IUniform>);
    addPass(this.blurScene, BLUR_FRAG, this.blurUniforms as unknown as Record<string, THREE.IUniform>);

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
    const bw = Math.max(1, Math.floor(size.x / 4));
    const bh = Math.max(1, Math.floor(size.y / 4));
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, bloomOpts);
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, bloomOpts);

    this.cloudTarget = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(size.x / 2)),
      Math.max(1, Math.floor(size.y / 2)),
      {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      },
    );
  }

  resize(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.cloudTarget.setSize(Math.max(1, Math.floor(size.x / 2)), Math.max(1, Math.floor(size.y / 2)));
    const bw = Math.max(1, Math.floor(size.x / 4));
    const bh = Math.max(1, Math.floor(size.y / 4));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
  }

  /** Cloud pass into the half-res target, then present to the screen. */
  render(renderer: THREE.WebGLRenderer, sceneColour: THREE.Texture, depth: THREE.Texture | null): void {
    this.uniforms.uDepth.value = depth;
    renderer.setRenderTarget(this.cloudTarget);
    renderer.render(this.scene, this.camera);

    // Bright pass, then one blur across and one down.
    this.brightUniforms.uScene.value = sceneColour;
    renderer.setRenderTarget(this.bloomA);
    renderer.render(this.brightScene, this.camera);

    this.blurUniforms.uSource.value = this.bloomA.texture;
    this.blurUniforms.uDirection.value.set(1, 0);
    renderer.setRenderTarget(this.bloomB);
    renderer.render(this.blurScene, this.camera);

    this.blurUniforms.uSource.value = this.bloomB.texture;
    this.blurUniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(this.bloomA);
    renderer.render(this.blurScene, this.camera);

    this.presentUniforms.uScene.value = sceneColour;
    this.presentUniforms.uCloud.value = this.cloudTarget.texture;
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
    const w = this.cloudTarget.width;
    const h = this.cloudTarget.height;
    const need = w * h * 4;
    if (!this.readback || this.readback.length !== need) this.readback = new Uint16Array(need);
    const buf = this.readback;
    // The target is HalfFloat, so readPixels wants a Uint16Array and every
    // component has to be decoded before it means anything.
    renderer.readRenderTargetPixels(this.cloudTarget, 0, 0, w, h, buf);

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

  update(camera: THREE.PerspectiveCamera, wx: Weather, light: SceneLighting, timeSec: number): void {
    const u = this.uniforms;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uInvProj2.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
    u.uCameraPos.value.copy(camera.position);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uTime.value = timeSec;

    u.uLow.value.set(wx.low.cover, wx.low.base, wx.low.top);
    u.uMid.value.set(wx.mid.cover, wx.mid.base, wx.mid.top);
    u.uHighCover.value = wx.high.cover;
    u.uHighBase.value = wx.high.base;

    // Meteorological wind direction is where it comes FROM; the drift vector is
    // where the air is going. In world axes that is (+x east, +z south).
    const to = ((wx.windDir + 180) * Math.PI) / 180;
    u.uWind.value.set(Math.sin(to) * wx.windSpeed, -Math.cos(to) * wx.windSpeed);
    u.uPrecip.value = Math.min(1, wx.precip * 1.2);

    u.uAmbient.value.copy(light.ambient);
    u.uSunDir.value.copy(light.sunDir);
    u.uSunColor.value.copy(light.sunColor);
    u.uSunIntensity.value = light.sunIntensity;
    u.uMieG.value = light.mieG;
    u.uTurbidity.value = light.turbidity;
    u.uCamAltitude.value = camera.position.y;
  }
}
