// Roads: OSM centrelines drawn as draped ribbons with procedural asphalt.
//
// WHY THIS EXISTS. The best satellite ring is zoom 18, about 0.47 m per pixel,
// so from a few hundred feet a lane line is one texel and a street is a row of
// blurred squares. A centreline plus a width is resolution-independent: the
// carriageway, the kerb and the paint stay crisp however low you get. Near
// field is vector, far field is the drape, and the two are cross-faded over
// 400-800 m so you never see the seam or the misregistration between them.
//
// Four decisions carry the quality.
//
// **Everything is parameterised by (u, v) from src/data/ribbon.ts** -- u in
// real metres along the centreline, v across the carriageway. Dashes, edge
// lines, wheel polish, expansion joints and the lamp spacing all fall out of
// that in the units they are actually specified in.
//
// **Blotches, not asphalt.** Uniform asphalt is the single thing that reads as
// CG. Real road surface is a quilt of repairs of different ages, and the
// low-frequency hard-edged patch layer below does more for the look than the
// aggregate, the cracks and the paint put together.
//
// **The fade is also the budget.** The fragment shader is expensive (noise,
// cracks, paint, atmosphere), so the first thing it does is compute the
// distance fade and discards when it is nil. Past ~800 m a road ribbon costs a
// vertex transform and a rasterised, immediately-killed fragment, which is what
// makes it affordable to keep the whole city's geometry resident.
//
// **Ordering is by width.** Wider classes are drawn first and narrower ones on
// top, so a service road reads as joining a boulevard rather than being cut in
// half by it. Tunnels are dropped outright: a tunnel painted on the surface is
// a road drawn over whatever is actually above it.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import type { Budget } from "./budget";
import { SUN_SHADOW_GLSL, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL, shHemispherical } from "./sh";
import { AO_GLSL, aoUniforms, type AoUniforms } from "./ao";
import { addRibbon, emptyRibbon, ribbonTriangleCost, type RibbonScratch } from "../data/ribbon";
// The lamp spacing table, and the GLSL copy of it that this shader indexes. It
// is GENERATED from the same array render/streetlamps.ts places columns from,
// so a post cannot end up between two pools.
import { LAMP_GLSL } from "../data/streetfurniture";
import {
  roadWidthM,
  roadLiftM,
  ROAD_BRIDGE,
  ROAD_TUNNEL,
  type Road,
  type RoadClass,
  type RoadPack,
} from "../data/roadpack";

/** Merge cell size, matching buildings.ts: big enough that draw calls stay in
 *  the low hundreds, small enough that frustum culling means something. */
const CELL_M = 1500;

/**
 * Draw order, coarsest carriageway first. Lower rank is drawn earlier and so
 * lies UNDER the ranks after it. Junction geometry is what this is for: two
 * ribbons crossing are two opaque quads, and whichever is drawn last wins, so
 * a footpath must win over a service road and a service road over a motorway.
 */
const CLASS_RANK: number[] = [
  0, // motorway
  0, // trunk
  1, // primary
  1, // secondary
  2, // tertiary
  2, // residential
  2, // unclassified
  3, // service
  2, // living_street
  2, // busway
  3, // pedestrian
  4, // footway
  4, // cycleway
  3, // track
];
/** Bridges draw after every surface class, so a deck covers what runs under it
 *  rather than being painted over by it. depthWrite is off everywhere (see the
 *  material below), so draw order is the only thing that decides this. */
const BRIDGE_RANK = 5;

/**
 * How far from the city centre each class is kept, in metres, before the LOD
 * solver scales it.
 *
 * Distance alone is the wrong cut and class alone is the wrong cut. A motorway
 * 20 km out is still the shape of the region; a footpath 3 km out is a hairline
 * nobody will ever fly low enough to see. Manhattan bakes 113k ways of which
 * 79k are footways, so this table is most of what makes that city affordable.
 */
const CLASS_RANGE_M: number[] = [
  40000, // motorway
  40000, // trunk
  40000, // primary
  40000, // secondary
  30000, // tertiary
  25000, // residential
  25000, // unclassified
  12000, // service
  15000, // living_street
  25000, // busway
  12000, // pedestrian
  8000,  // footway
  12000, // cycleway
  10000, // track
];

/** Ways shorter than this are digitising noise at any altitude worth flying. */
const MIN_LENGTH_M = 6;


function classRange(cls: RoadClass, k: number): number {
  return (CLASS_RANGE_M[cls] ?? 4000) / k;
}

/** True if this way should be drawn at all at this LOD aggression. */
function keep(r: Road, dist: number, k: number): boolean {
  return dist <= classRange(r.cls, k);
}

/**
 * Smallest LOD aggression that fits the budget. Coarse steps, because the
 * difference between k=1 and k=1.4 is invisible and the loop runs over every
 * way in the pack.
 */
function solveLod(pack: RoadPack, dists: Float64Array, triangleBudget: number): number {
  for (const k of [1, 1.3, 1.8, 2.5, 3.5, 5, 8, 13, 22]) {
    let tris = 0;
    for (let i = 0; i < pack.roads.length; i++) {
      const r = pack.roads[i];
      if ((r.flags & ROAD_TUNNEL) !== 0) continue;
      if (!keep(r, dists[i], k)) continue;
      tris += ribbonTriangleCost(r.pts.length / 2);
      if (tris > triangleBudget) break;
    }
    if (tris <= triangleBudget) return k;
  }
  return 22;
}

// --- shaders ----------------------------------------------------------------

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;    // x: metres along the centreline, y: 0..1 across the carriageway
in vec4 info;  // class, surface kind, carriageway width in metres, bridge flag

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec4 vInfo;
out float vViewDist;

void main() {
  vWorld = position;
  vNormal = normal;
  vUv = uv;
  vInfo = info;
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec4 vInfo;
in float vViewDist;
out vec4 fragColor;

// Aerial perspective only, same short march the terrain and buildings use.
#define ATMO_STEPS 7
#define ATMO_SUN_STEPS 2
${ATMOSPHERE_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}
${LAMP_GLSL}

uniform vec3  uCameraPos;
// The scene sky probe: what wet asphalt reflects.
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform float uWetness;
uniform float uSnow;
uniform float uNight;
uniform vec3  uNightGlow;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uSunSurface;
uniform float uFadeNear;
uniform float uFadeFar;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Value noise, smoothstep-interpolated. Cheap and, unlike gradient noise,
 *  it has usable low-frequency structure for the patch quilt. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** Soft band of half-width hw centred on c, antialiased by the pixel footprint
 *  aa. Returns 1 inside, 0 outside. */
float band(float x, float c, float hw, float aa) {
  return smoothstep(hw + aa, max(hw - aa, 0.0), abs(x - c));
}

void main() {
  // The fade, FIRST, and nothing else before it.
  //
  // Everything below is expensive, and the whole city's ribbons are resident so
  // that the near field can be complete. Past uFadeFar this shader must cost
  // one comparison, not a noise field and an atmosphere integral.
  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, vViewDist);
  if (fade < 0.004) discard;

  float cls    = vInfo.x;
  float surf   = vInfo.y;
  float width  = max(vInfo.z, 1.0);
  float bridge = vInfo.w;

  float u = vUv.x;
  float v = vUv.y;
  vec2  w = vWorld.xz;

  // A road ribbon is a surface with no inside, so it is drawn double-sided and
  // the winding decides nothing. The normal still has to point at the sky.
  vec3 n = normalize(vNormal);
  n *= sign(n.y + 1e-6);

  // Metres of world per pixel, for filtering every layer that has detail finer
  // than the screen can hold. Taken on the world position, not on any fract()ed
  // coordinate: fract has a derivative spike at every seam and fwidth of that
  // reads as an enormous footprint along a one-pixel line.
  float px = max(fwidth(w.x), fwidth(w.y)) + 1e-5;

  bool isConcrete = surf > 1.5 && surf < 2.5;
  bool isGravel   = surf > 3.5 && surf < 4.5;
  bool isDirt     = surf > 4.5 && surf < 5.5;
  bool isCobble   = surf > 5.5;
  // Track and (unsurfaced) path are unpaved whatever the surface tag says, and
  // the tag is missing far more often than not.
  bool isTrack    = cls > 12.5;
  bool unpaved    = isGravel || isDirt || (isTrack && surf < 0.5);

  // --- base surface -------------------------------------------------------
  // Linear albedos, measured-ish: asphalt really is about 0.06-0.08 and reads
  // as WRONG at the 0.2 a colour picker suggests, because a screenshot of a
  // road is a screenshot of a road under a tone curve.
  vec3 albedo = vec3(0.064, 0.063, 0.066);
  float roughness = 0.85;
  if (isConcrete)     { albedo = vec3(0.168, 0.166, 0.158); roughness = 0.80; }
  else if (isGravel)  { albedo = vec3(0.150, 0.133, 0.108); roughness = 0.97; }
  else if (isDirt)    { albedo = vec3(0.118, 0.088, 0.062); roughness = 0.99; }
  else if (isCobble)  { albedo = vec3(0.090, 0.086, 0.082); roughness = 0.78; }
  else if (isTrack)   { albedo = vec3(0.125, 0.100, 0.074); roughness = 0.98; }

  // --- aggregate: two octaves, ~0.05 m and ~0.4 m -------------------------
  // The fine octave is sub-pixel from any altitude worth flying, so it is
  // faded to its own mean by the pixel footprint rather than by distance: a
  // road seen edge-on needs the same convergence even when it is close.
  float fine   = 1.0 - smoothstep(0.03, 0.16, px);
  float medium = 1.0 - smoothstep(0.20, 1.10, px);
  float agg = mix(0.5, vnoise(w * 20.0), fine) * 0.45
            + mix(0.5, vnoise(w * 2.5 + 17.0), medium) * 0.55;
  albedo *= 1.0 + (agg - 0.5) * (unpaved ? 0.75 : 0.30);

  // --- patch quilt --------------------------------------------------------
  // The most important layer here. Two low frequencies summed and then
  // QUANTISED, so the boundaries are hard the way a saw-cut repair edge is, and
  // each band gets its own age. Fresh asphalt is nearly black, a twenty-year-old
  // patch is pale grey, and the +-8% between them is what stops a street from
  // reading as one flat swatch.
  float p1 = vnoise(w * 0.055 + 13.0);
  float p2 = vnoise(w * 0.019 + 71.0);
  float quilt = p1 * 0.62 + p2 * 0.38;
  float bandIdx = floor(quilt * 7.0);
  float age = hash11(bandIdx * 7.31 + 2.7);
  albedo *= 1.0 + (age - 0.5) * 0.26;
  // Slight warm/cool drift between patches: bitumen batches differ.
  albedo *= mix(vec3(1.02, 1.00, 0.97), vec3(0.98, 1.00, 1.03), hash11(bandIdx * 3.9 + 8.1));
  // An old patch is polished smooth by twenty years of traffic and a fresh one
  // is open-graded and coarse, so the AGGREGATE contrast varies by patch too.
  // That is what makes the boundary read as two different surfaces meeting
  // rather than as one surface with a brightness step painted across it.
  albedo *= 1.0 + (agg - 0.5) * (0.5 - age) * 0.30;

  // --- cracks -------------------------------------------------------------
  // Ridged value noise: the ridge lives on the contour where the noise crosses
  // its midpoint, which is a connected curve, so it reads as a crack rather
  // than as speckle. Masked to the OLDER patches, because a crack running
  // straight across a fresh repair is the thing that gives the trick away.
  // Only from LOW: a hairline crack is a centimetre wide, so past about 6 cm
  // per pixel it is not a crack any more, it is a smear. The first version
  // faded out at 0.35 m/px and drew half-metre-wide worms across every street
  // from 200 m up, which read as graffiti rather than as a road surface.
  float crackDetail = 1.0 - smoothstep(0.02, 0.09, px);
  if (crackDetail > 0.01 && !unpaved) {
    float c1 = vnoise(w * 1.9 + 40.0);
    float c2 = vnoise(w * 4.7 + 91.0);
    float ridge = max(1.0 - abs(c1 * 2.0 - 1.0), (1.0 - abs(c2 * 2.0 - 1.0)) * 0.85);
    float crack = smoothstep(0.962, 0.999, ridge) * smoothstep(0.42, 0.72, age);
    albedo *= 1.0 - 0.42 * crack * crackDetail;
  }

  // --- concrete slab joints ----------------------------------------------
  // Concrete carriageway is cast in bays, and the transverse joint every ~4.6 m
  // is the thing that says "concrete" before the colour does.
  if (isConcrete) {
    float jd = band(mod(u, 4.6), 0.0, 0.05, fwidth(u) * 0.5 + 0.01)
             + band(mod(u, 4.6), 4.6, 0.05, fwidth(u) * 0.5 + 0.01);
    albedo *= 1.0 - 0.35 * clamp(jd, 0.0, 1.0) * medium;
  }

  // --- cobbles ------------------------------------------------------------
  if (isCobble) {
    vec2 cg = w * 9.0;                       // ~11 cm setts
    float cell = hash21(floor(cg));
    vec2 cf = abs(fract(cg) - 0.5);
    float mortar = smoothstep(0.36, 0.48, max(cf.x, cf.y));
    albedo *= mix(0.80 + 0.55 * cell, 0.55, mortar * medium);
  }

  // --- wheel tracks -------------------------------------------------------
  // Two per lane, and the lane count comes from the width rather than from a
  // second table: a 14 m road is four lanes and its wear is four lanes' worth.
  // Polished, not just darker -- the point is that a wet road streaks along the
  // tracks instead of shining uniformly, which is most of what a night city
  // after rain looks like from the air.
  float lanes = max(1.0, floor(width / 3.5 + 0.5));
  float lv = fract(v * lanes);
  float t1 = exp(-pow((lv - 0.30) / 0.085, 2.0));
  float t2 = exp(-pow((lv - 0.70) / 0.085, 2.0));
  float wheel = clamp(t1 + t2, 0.0, 1.0) * (unpaved ? 0.55 : 1.0);
  albedo *= 1.0 - 0.10 * wheel;
  roughness -= 0.22 * wheel;

  // The drip line. Every lane has a dark stripe of oil and rubber down its
  // middle, laid there by the sumps of everything that has ever queued on it,
  // and it is one of the few road features that survives being resurfaced. It
  // is broken up by noise along the road so it is a stain and not a stripe.
  float drip = exp(-pow((lv - 0.5) / 0.11, 2.0))
             * smoothstep(0.25, 0.75, vnoise(vec2(u * 0.13, v) + 51.0));
  albedo *= 1.0 - 0.16 * drip * (unpaved ? 0.0 : 1.0);

  // --- markings -----------------------------------------------------------
  // Presence and colour by class. Most streets in most cities carry no paint at
  // all: an unmarked residential street is not a missing feature, it is what a
  // residential street looks like, and painting every one of them is what makes
  // a render read as a MAP rather than as a city.
  bool paved      = !unpaved && cls < 10.5;
  bool hasEdge    = paved && (cls < 4.5 || (cls > 8.5 && cls < 9.5) || lanes >= 4.0);
  bool hasCentre  = paved && cls < 6.5 && lanes >= 2.0;
  bool motorway   = cls < 1.5;
  float aaV = fwidth(v) * 0.6 + 1e-4;
  float aaU = fwidth(u) * 0.6 + 1e-4;

  // Paint is ~0.12 m wide; v is normalised, so convert.
  float pw = 0.06 / width;
  float edgeV = clamp(0.45 / width, 0.015, 0.16);

  float white = 0.0;
  float yellow = 0.0;

  if (hasEdge) {
    white += band(v, edgeV, pw, aaV) + band(v, 1.0 - edgeV, pw, aaV);
  }
  if (hasCentre) {
    // Dashed white between lanes within a carriageway, solid double yellow (or
    // a median on a motorway) down the middle.
    float dash = smoothstep(3.0 + aaU * 12.0, 3.0 - aaU * 12.0, mod(u, 12.0));
    for (float i = 1.0; i < 6.0; i += 1.0) {
      if (i >= lanes) break;
      float lb = i / lanes;
      if (abs(lb - 0.5) < 0.01) continue;   // the centre is the yellow's
      white += band(v, lb, pw, aaV) * dash;
    }
    // Double yellow down the middle: the American centre line. On a motorway
    // the ribbon spans both carriageways, so the pair is opened out to read as
    // the edges of a median rather than as a centre line nobody would paint on
    // a freeway.
    float o = (motorway ? 0.45 : 0.125) / width;
    yellow += band(v, 0.5 - o, pw, aaV) + band(v, 0.5 + o, pw, aaV);
  }
  white = clamp(white, 0.0, 1.0);
  yellow = clamp(yellow, 0.0, 1.0);

  // Wear. Paint is NEVER crisp on a real road: it is scrubbed thin under the
  // wheel tracks, patchy where a repair was laid over it, and repainted at
  // different times along the same street. Everything above is multiplied by
  // this, so no marking is ever a clean rectangle.
  float wearN = vnoise(vec2(u * 0.9, v * 3.0) + 88.0) * 0.6
              + vnoise(vec2(u * 4.5, v * 14.0) + 3.0) * 0.4;
  float wear = smoothstep(0.20, 0.68, wearN) * (1.0 - 0.55 * wheel);
  wear = mix(wear, 1.0, 0.25);                 // never fully gone
  float paintFade = 1.0 - smoothstep(0.10, 0.45, px);   // sub-pixel paint dissolves
  float paint = clamp(white + yellow, 0.0, 1.0) * wear * paintFade;
  vec3 paintCol = mix(vec3(0.60, 0.60, 0.57), vec3(0.52, 0.38, 0.055),
                      yellow > white ? 1.0 : 0.0);
  albedo = mix(albedo, paintCol, paint);

  // A bridge parapet: a dark kerb line at the very edge of the deck. Cheap, and
  // it is what separates a bridge from a stripe of tarmac lying on the water.
  if (bridge > 0.5) {
    float kerb = band(v, 0.0, 0.012, aaV) + band(v, 1.0, 0.012, aaV);
    albedo = mix(albedo, vec3(0.055, 0.055, 0.058), clamp(kerb, 0.0, 1.0) * medium);
  }

  // Ploughed, not buried: a road under snow is the one dark line left in a
  // white city, so it takes a fraction of what the terrain takes.
  albedo = mix(albedo, vec3(0.86, 0.88, 0.92), uSnow * 0.30);

  // Wet asphalt is much darker than dry asphalt, and the paint much less so.
  albedo *= 1.0 - 0.46 * uWetness * (1.0 - 0.6 * paint);

  // At night a dark-adapted eye takes almost no colour or texture off a road
  // surface, exactly as in the terrain shader. The PAINT is exempt: markings
  // are retroreflective and are the brightest thing on a lit street.
  if (uNight > 0.02) {
    float g = dot(albedo, vec3(0.299, 0.587, 0.114));
    vec3 flat_ = vec3(mix(0.035, g, 0.45));
    albedo = mix(mix(albedo, flat_, uNight * 0.85), albedo * 1.9, paint * uNight);
  }

  // --- lighting, matched to the ground the road sits on -------------------
  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl * sunVis;
  vec3 beam = direct + uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));
  // Sky irradiance from the scene probe, in place of the hemispherical constant
  // this used to run. A road is close to horizontal, so the diffuse change here
  // is small; what the probe buys on a road is the reflection below.
  // Screen-space sky occlusion on the sky term only, exactly as in terrain.ts.
  // A road is horizontal and open, so this is near 1 in the middle of a
  // carriageway and does its work at the kerb and under the buildings that
  // stand on it.
  vec3 ambient = occludedSkyIrradiance(n);
  vec3 lit = albedo * (beam + ambient);

  // Wet asphalt is a MIRROR, and a rainy city is mostly that: a bright sky
  // lying on a dark street. The sun glint below is one point of light, the
  // reflection is the whole sky, and it is the reflection that carries it.
  //
  // Gated on wetness, so the per-fragment cube fetch is paid for only on the
  // frames a road is actually wet. The mip comes from the SAME per-fragment
  // roughness the wheel tracks already modulate, so the reflection sharpens
  // down the two polished streaks and stays diffuse on the coarse tarmac
  // between them, which is what a wet carriageway looks like from the air.
  if (uWetness > 0.02) {
    vec3 vdir = normalize(uCameraPos - vWorld);
    vec3 refl = reflect(-vdir, n);
    vec3 env = textureLod(uEnv, refl, clamp(roughness, 0.0, 1.0) * uEnvMaxLod).rgb;
    // Schlick against the 2% normal reflectance of a water film.
    float f = pow(1.0 - clamp(dot(vdir, n), 0.0, 1.0), 5.0);
    lit = mix(lit, env, (0.02 + 0.98 * f) * uWetness);
  }

  // Specular. Dry asphalt is not matte -- a low sun sheets off it -- and wet
  // asphalt is a mirror. The wheel tracks are smoother than the rest, so the
  // highlight runs in two streaks down the carriageway rather than covering it.
  // The exponent matters more than the strength. At 28 the lobe is so broad
  // that a road seen along its length under a high sun is uniformly white --
  // measured, looking down Van Ness at midday -- because every fragment on a
  // flat surface is within the lobe at once. Dry asphalt has a wide but WEAK
  // sheen; a narrow bright one is what wet asphalt has.
  float gloss = clamp((1.0 - roughness) * 0.22 + uWetness * 0.9, 0.0, 1.0);
  if (gloss > 0.01) {
    vec3 vdir = normalize(uCameraPos - vWorld);
    float shine = mix(110.0, 220.0, uWetness);
    vec3 hv = normalize(vdir + uSunDir);
    lit += uSunColor * uSunIntensity * uSunSurface * sunT
         * pow(max(0.0, dot(n, hv)), shine) * gloss * 1.5 * sunVis;
    vec3 hm = normalize(vdir + uMoonDir);
    lit += uMoonLight * uSunSurface * pow(max(0.0, dot(n, hm)), shine) * gloss * 1.5;
  }

  // --- night ---------------------------------------------------------------
  // Roads ARE the night city from the air: the lit grid is the picture. The
  // terrain paints street lamps on a random lattice because it has no idea
  // where the streets are; here the geometry knows, so the lamps go where lamps
  // go -- along the kerb, evenly spaced, alternating sides.
  if (uNight > 0.02) {
    // Carriageways only. Lighting the pavements as well put three rows of lamps
    // down every street, and the pools merged into a continuous glowing tube:
    // the city read as a diagram of its own road network rather than as a place
    // with lamps in it. A street lamp lights the STREET.
    float spacing = lampSpacingM(cls);
    if (spacing > 0.0 && !isTrack) {
      float su = u / spacing;
      float idx = floor(su);
      // On the kerb, alternating sides, with the lantern arm reaching a little
      // over the carriageway. render/streetlamps.ts stands a column over every
      // one of these, at u = (idx + 0.5) * spacing and on the same side; the
      // spacing table it places from is the one this array was generated FROM.
      // Neither number exists twice. See data/streetfurniture.ts.
      float side = mod(idx, 2.0) < 1.0 ? LAMP_POOL_V : 1.0 - LAMP_POOL_V;
      float du = (fract(su) - 0.5) * spacing;
      float dv = (v - side) * width;
      float d2 = du * du + dv * dv;
      // ~5 m pool: tight enough that consecutive lamps do not run together, so
      // there is dark road between them the way there is on a real street.
      //
      // EVERY LAMP IS LIT, and it did not used to be: half the pools were
      // switched off by a hash. That was a good way to get
      // the ragged rhythm a real run of lamps has, and it stopped being
      // available the moment there were posts, because the post is placed in
      // TypeScript and cannot evaluate this hash. A post over a dark pool is a
      // broken lamp; half the posts over dark pools is a broken street. So the
      // rhythm comes from the brightness spread alone, which is wider now to
      // make up for it.
      // Mean 0.75 against the old population's effective 0.49, so a street with
      // every lamp working is about half a stop brighter than one with half of
      // them out, rather than twice as bright.
      float bright = 0.30 + 0.90 * hash11(idx * 3.3);
      float pool = exp(-d2 * 0.018) * bright;
      // Far away the pools are sub-pixel and must converge to their mean, or
      // the whole city crawls with aliasing as the camera moves.
      float lampDetail = smoothstep(1.6, 0.35, px);
      float meanPool = 0.75 * 3.14159265 / (0.018 * spacing * width);
      pool = mix(min(meanPool, 0.22), pool, lampDetail);
      vec3 lampCol = mix(vec3(0.85, 0.90, 1.0), vec3(1.0, 0.72, 0.36),
                         smoothstep(0.05, 0.6, hash11(idx * 9.1 + 2.0)));
      lampCol = mix(vec3(1.0, 0.80, 0.55), lampCol, lampDetail);
      // Wet tarmac throws the lamp back at you: this is the single strongest
      // cue that a night city has been rained on.
      lit += lampCol * pool * uNight * (1.0 + 2.2 * uWetness) * 0.19;
      // Retroreflective paint under the lamps.
      lit += vec3(1.0, 0.95, 0.85) * paint * pool * uNight * 0.32;
    }
    lit += albedo * uNightGlow * 0.9;
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);

  fragColor = vec4(lit * trans + inscatter, fade);
}
`;

export interface RoadUniforms extends SunShadowUniforms, AoUniforms {
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  /** Sky irradiance, 9 RGB coefficients; see render/sh.ts. */
  uSH: THREE.IUniform<Float32Array>;
  /** Prefiltered sky radiance for wet tarmac; see render/skyprobe.ts. */
  uEnv: THREE.IUniform<THREE.CubeTexture | null>;
  uEnvMaxLod: THREE.IUniform<number>;
  uWetness: THREE.IUniform<number>;
  uSnow: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
  uSunSurface: THREE.IUniform<number>;
  uFadeNear: THREE.IUniform<number>;
  uFadeFar: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
}

/**
 * `shadow` is spread in by REFERENCE, so the cascade matrices and maps the
 * SunShadow pass writes each frame are the same objects this material reads.
 */
export function makeRoadUniforms(shadow: SunShadowUniforms): RoadUniforms {
  return {
    ...shadow,
    ...aoUniforms(),
    uCameraPos: { value: new THREE.Vector3() },
    // The hemispherical ambient this shader ran before the probe existed, so a
    // frame drawn before the first capture is the old picture, not a black one.
    uSH: { value: shHemispherical([0.2, 0.24, 0.3], 0.55, 0.45) },
    uEnv: { value: null },
    uEnvMaxLod: { value: 6 },
    uWetness: { value: 0 },
    uSnow: { value: 0 },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonLight: { value: new THREE.Color(0, 0, 0) },
    uSunSurface: { value: 0.105 },
    uFadeNear: { value: 400 },
    uFadeFar: { value: 800 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSunIntensity: { value: 22 },
    uMieG: { value: 0.76 },
    uTurbidity: { value: 1 },
    uCamAltitude: { value: 100 },
    uMultiScatter: { value: 0.055 },
  };
}

/** One merge bucket: a rank within a cell, so both the draw order and the
 *  frustum culling survive the merge. */
interface Bucket {
  ribbon: RibbonScratch;
  /** y per vertex, filled in step with the ribbon's xz. */
  y: number[];
  info: number[];
  rank: number;
}

export interface RoadStats {
  drawn: number;
  skippedTunnel: number;
  skippedFar: number;
  skippedShort: number;
  bridges: number;
  triangles: number;
  meshes: number;
  /** LOD aggression the budget solver settled on; 1 means everything fits. */
  lod: number;
  buildMs: number;
}

export class Roads {
  readonly group = new THREE.Group();
  readonly uniforms: RoadUniforms;
  readonly stats: RoadStats;

  constructor(
    pack: RoadPack,
    groundAt: (x: number, z: number) => number,
    shadow: SunShadowUniforms,
    budget: Budget,
  ) {
    const t0 = performance.now();
    this.uniforms = makeRoadUniforms(shadow);

    const dists = new Float64Array(pack.roads.length);
    for (let i = 0; i < pack.roads.length; i++) {
      dists[i] = Math.hypot(pack.roads[i].cx, pack.roads[i].cz);
    }
    const lod = solveLod(pack, dists, budget.roadTriangleBudget);

    const buckets = new Map<string, Bucket>();
    let drawn = 0;
    let skippedTunnel = 0;
    let skippedFar = 0;
    let skippedShort = 0;
    let bridges = 0;

    for (let i = 0; i < pack.roads.length; i++) {
      const r = pack.roads[i];
      // A tunnel drawn on the surface is a road painted over whatever is
      // actually above it, which in Manhattan is most of Park Avenue.
      if ((r.flags & ROAD_TUNNEL) !== 0) { skippedTunnel++; continue; }
      if (!keep(r, dists[i], lod)) { skippedFar++; continue; }

      let len = 0;
      for (let p = 2; p < r.pts.length; p += 2) {
        len += Math.hypot(r.pts[p] - r.pts[p - 2], r.pts[p + 1] - r.pts[p - 1]);
      }
      if (len < MIN_LENGTH_M) { skippedShort++; continue; }

      const width = roadWidthM(r.cls, r.lanes, r.flags);
      const isBridge = (r.flags & ROAD_BRIDGE) !== 0;
      const rank = isBridge ? BRIDGE_RANK : (CLASS_RANK[r.cls] ?? 2);
      const key = `${rank}:${Math.floor(r.cx / CELL_M)},${Math.floor(r.cz / CELL_M)}`;
      let b = buckets.get(key);
      if (!b) { b = { ribbon: emptyRibbon(), y: [], info: [], rank }; buckets.set(key, b); }

      const v0 = b.ribbon.xz.length / 2;
      const tris = addRibbon(b.ribbon, r.pts, width);
      if (tris === 0) { skippedShort++; continue; }

      if (isBridge) bridges++;
      // The deck height is roadpack's, not this file's: a car drives on the
      // surface this ribbon draws, and two copies of the number would put it
      // under the bridge it is crossing.
      const lift = roadLiftM(r.flags, r.layer);

      // A bridge deck is FLAT, and the ground under it is a riverbed. Draping
      // it like a street would sag it into the water at midspan, which is
      // exactly what a bridge is built not to do, so the deck is interpolated
      // between the ground at its two ends by arc length instead.
      const nv = b.ribbon.xz.length / 2 - v0;
      let y0 = 0;
      let y1 = 0;
      let total = 1;
      if (isBridge) {
        y0 = groundAt(r.pts[0], r.pts[1]);
        y1 = groundAt(r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]);
        total = Math.max(1e-3, b.ribbon.uv[(v0 + nv - 1) * 2]);
      }
      for (let k = 0; k < nv; k++) {
        const x = b.ribbon.xz[(v0 + k) * 2];
        const z = b.ribbon.xz[(v0 + k) * 2 + 1];
        const g = isBridge
          ? y0 + (y1 - y0) * (b.ribbon.uv[(v0 + k) * 2] / total)
          : groundAt(x, z);
        b.y.push(g + lift);
        b.info.push(r.cls, r.surface, width, isBridge ? 1 : 0);
      }
      drawn++;
    }

    let triangles = 0;
    let meshes = 0;
    for (const b of buckets.values()) {
      if (!b.ribbon.idx.length) continue;
      const n = b.y.length;
      const pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        pos[k * 3] = b.ribbon.xz[k * 2];
        pos[k * 3 + 1] = b.y[k];
        pos[k * 3 + 2] = b.ribbon.xz[k * 2 + 1];
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(b.ribbon.uv, 2));
      geo.setAttribute("info", new THREE.Float32BufferAttribute(b.info, 4));
      geo.setIndex(n > 65535
        ? new THREE.Uint32BufferAttribute(b.ribbon.idx, 1)
        : new THREE.Uint16BufferAttribute(b.ribbon.idx, 1));
      // The drawn surface IS the ground here, so its own face normals are the
      // right ones -- no second sampling of the height field, and no
      // disagreement between the normal and the geometry it shades. No two
      // roads share a vertex, so nothing smooths across a junction.
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      const mat = new THREE.RawShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: this.uniforms,
        glslVersion: THREE.GLSL3,
        side: THREE.DoubleSide,
        transparent: true,
        // Depth-tested against the world but writing no depth of its own: the
        // ribbons are coplanar with each other at every junction, and letting
        // them fight over a depth buffer is how a crossroads starts to flicker.
        // Order alone decides which is on top, which is what CLASS_RANK is for.
        depthWrite: false,
        // The lift is deliberately small (see LIFT_M), so this is what actually
        // wins the depth test against the terrain. Offsetting in DEPTH UNITS is
        // also the only thing that scales correctly across a 2 m to 200 km
        // frustum, where a fixed metre lift is invisible near and useless far.
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -12,
      });

      const mesh = new THREE.Mesh(geo, mat);
      // Transparent objects are otherwise sorted back to front by distance,
      // which would let a nearby motorway paint over a footpath behind it.
      mesh.renderOrder = 10 + b.rank;
      this.group.add(mesh);
      triangles += b.ribbon.idx.length / 3;
      meshes++;
    }

    this.stats = {
      drawn, skippedTunnel, skippedFar, skippedShort, bridges,
      triangles, meshes, lod, buildMs: performance.now() - t0,
    };
  }

  /** Release the GPU memory this group holds; see Buildings.dispose. */
  dispose(): void {
    for (const child of this.group.children) {
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    this.group.clear();
  }
}
