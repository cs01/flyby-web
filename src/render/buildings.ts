// The skyline: OSM footprints extruded to their real heights, lit by the same
// atmosphere as everything else.
//
// Four decisions carry most of the quality here.
//
// **Chunked, not one mesh.** The buildings are merged into ~1.5 km cells rather
// than a single giant buffer. One mesh cannot be frustum-culled, so flying with
// the city behind you would still pay for every triangle in it. Cells give
// culling for free and still keep the draw call count near a hundred.
//
// **Distance filter by HEIGHT, not by distance alone.** Past a few kilometres a
// two-storey house is a sub-pixel speck that costs a draw and adds nothing, but
// a 300 m tower is the whole reason you look that way. So the far field keeps
// only the tall things, which is also what the eye actually resolves.
//
// **The base is buried at the footprint's LOWEST ground sample.** Placing a
// building at the terrain height of its centroid leaves half of it hanging in
// the air on any slope, and San Francisco is nothing but slope.
//
// **The facade is a lookup, not a formula.** Everything about what a building
// is made of comes out of render/facade.ts, once per building, on the CPU, and
// reaches the shader through a parameter texture. See that file for why: it is
// where the material families and the night occupancy model live, and it is
// pure so that test/facade.check.ts can gate both.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import type { Budget } from "./budget";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import { triangulate, signedArea } from "./earcut";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL, shHemispherical } from "./sh";
import { AO_GLSL, aoUniforms, type AoUniforms } from "./ao";
import {
  FACADE_FLOATS,
  FACADE_GLSL,
  facadeFor,
  hash3,
  packFacade,
  type FacadeParams,
} from "./facade";
import { footprintGroundY, type Building, type CityPack } from "../data/citypack";

const CELL_M = 1500;

/**
 * Graduated level of detail: the minimum height a building needs to be kept,
 * as a function of its distance from the city centre.
 *
 * A single radius with a hard height cut-off was wrong in a way that is obvious
 * in flight: the pack origin is one corner of the city, so everything more than
 * a few kilometres from it vanished, and half of San Francisco was missing
 * while you flew over it. A ramp keeps the core complete and thins the outskirts
 * gradually, which is both what the eye expects and what the triangle budget
 * wants -- a two-storey house at 8 km is a sub-pixel speck.
 */
function minHeightAt(distM: number, k: number): number {
  if (distM < FULL_DETAIL_M / k) return 0;
  const t = (distM - FULL_DETAIL_M / k) / (THIN_TO_M - FULL_DETAIL_M / k);
  return Math.min(1, Math.max(0, t)) * MAX_CUTOFF_M * k;
}

const FULL_DETAIL_M = 4200;
const THIN_TO_M = 9000;
const MAX_CUTOFF_M = 40;

/**
 * How far out roof detail survives.
 *
 * Both are INSIDE the distance at which whole buildings start being dropped
 * (FULL_DETAIL_M / k), and that ordering is the point: a parapet or an air
 * handler is a metre of relief on top of a thirty-metre box, so it stops being
 * resolvable long before the box does. Spending the budget on clutter out at
 * 6 km would be paying for sub-pixel geometry with buildings that are still
 * several pixels across.
 *
 * Boxes go first, parapets second, buildings last.
 */
const CLUTTER_M = 1200;
const PARAPET_M = 1600;

/** Triangles a footprint costs: two per wall segment, plus the roof fan. */
function triangleCost(vertCount: number): number {
  return vertCount * 2 + Math.max(0, vertCount - 2);
}

/**
 * What goes on the roof of one building, given how far out it is and how
 * aggressive the LOD solver had to be.
 *
 * Area and height are both gates because both matter: a parapet round a 30 m2
 * shed is invisible, and an air-handling plant on a two-storey house is wrong.
 */
export interface RoofExtras {
  parapet: boolean;
  /** Small plant boxes (air handlers, chillers, vents). */
  boxes: number;
  /** One larger box for the stair and lift overrun. */
  overrun: boolean;
}

const NO_EXTRAS: RoofExtras = { parapet: false, boxes: 0, overrun: false };

function roofExtras(distM: number, k: number, heightM: number, areaM2: number): RoofExtras {
  if (heightM < 6 || areaM2 < 120) return NO_EXTRAS;
  const parapet = distM < PARAPET_M / k;
  if (!parapet) return NO_EXTRAS;
  if (distM >= CLUTTER_M / k) return { parapet, boxes: 0, overrun: false };
  const boxes = Math.min(4, Math.floor(areaM2 / 900));
  const overrun = heightM >= 22 && areaM2 >= 350;
  return { parapet, boxes, overrun };
}

/** Triangles the roof extras add: the parapet's inner face, plus 10 per box. */
function extrasCost(vertCount: number, e: RoofExtras): number {
  return (e.parapet ? vertCount * 2 : 0) + (e.boxes + (e.overrun ? 1 : 0)) * 10;
}

/**
 * Find the smallest LOD aggression that fits the budget. Coarse steps, because
 * the difference between k=1 and k=1.5 is invisible and the loop is over every
 * building in the pack.
 *
 * Roof clutter is inside this sum, not bolted on after it. If it were not, the
 * budget would be a number about walls and the actual triangle count would be
 * whatever the clutter happened to add.
 */
function solveLod(pack: CityPack, triangleBudget: number): number {
  for (const k of [1, 1.4, 2, 3, 4.5, 7, 11, 18]) {
    let tris = 0;
    for (const b of pack.buildings) {
      const h = b.topM - b.baseM;
      const dist = Math.hypot(b.cx, b.cz);
      if (h < minHeightAt(dist, k)) continue;
      const n = b.ring.length / 2;
      tris += triangleCost(n);
      if (dist < PARAPET_M / k) {
        tris += extrasCost(n, roofExtras(dist, k, h, Math.abs(signedArea(b.ring))));
      }
      if (tris > triangleBudget) break;
    }
    if (tris <= triangleBudget) return k;
  }
  return 18;
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;        // x: metres along the wall, y: metres up the wall
in vec4 info;      // building index, building height, isRoof, part

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;

out vec3 vNormal;
out vec3 vWorld;
out vec2 vUv;
out vec4 vInfo;
out float vViewDist;

void main() {
  vNormal = normal;
  vWorld = position;
  vUv = uv;
  vInfo = info;
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** info.w: which piece of the building a fragment belongs to. */
const PART_WALL = 0;
const PART_ROOF = 1;
const PART_PARAPET = 2;
const PART_CLUTTER = 3;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUv;
in vec4 vInfo;
in float vViewDist;
out vec4 fragColor;

// Aerial perspective only: a shorter march than the sky uses. See the note in
// atmosphere.glsl.ts -- this is per-fragment with overdraw, and it is smooth.
#define ATMO_STEPS 7
#define ATMO_SUN_STEPS 2
${ATMOSPHERE_GLSL}
${TONEMAP_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}
${FACADE_GLSL}

uniform vec3  uCameraPos;
// The scene sky probe: prefiltered radiance for the glass, roughness to mip.
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform float uNight;
uniform vec3  uNightGlow;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uWetness;
uniform float uSunSurface;

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

/**
 * A narrow tent peaking at c. Used as the DERIVATIVE of the window mask: the
 * mask itself steps up at one edge and down at the other, so a spike at each
 * edge, positive then negative, is the slope of the surface a recessed window
 * actually has. Perturbing the normal by it is what turns a flat painted-on
 * window into one with a reveal that catches the light.
 */
float tent(float x, float c, float ew) {
  return smoothstep(c - ew, c, x) * smoothstep(c + ew, c, x);
}

/**
 * The coping on top of a parapet. Pale grey stone or concrete whatever the
 * wall below it is made of, which is exactly the line that makes a box read as
 * a building from the air.
 */
vec3 parapetColour(Facade p) {
  return mix(p.colour, vec3(0.42, 0.41, 0.39), 0.55 + 0.25 * hash11(p.seed * 31.0 + 5.0));
}

void main() {
  float bidx  = vInfo.x;
  float bldH  = vInfo.y;
  float isRoof = vInfo.z;
  float part  = vInfo.w;

  Facade fp = readFacade(bidx);

  vec3 n = normalize(vNormal);
  vec3 albedo = fp.colour;

  // A lit window EMITS. It was being added into the albedo, which then went
  // through the sun and ambient terms like everything else -- so a lit window
  // got dimmer at night, which is the one time it is supposed to be the
  // brightest thing on the building.
  vec3 emissive = vec3(0.0);

  // How much of this fragment behaves as glass rather than as wall. Drives the
  // Fresnel reflection and the sun glint, and nothing else.
  float glassMask = 0.0;

  // How much of the sky dome this fragment can see, beyond its own orientation.
  // 1.0 on a roof; less and less as you go down into a street canyon.
  float skyOcc = 1.0;

  if (part < 0.5) {
    // --- Facade ---------------------------------------------------------
    // Storey and column pitch are per BUILDING, out of the parameter texture.
    // A curtain wall's mullions are 1.6 m apart and a brick terrace's windows
    // are 3.3 m apart; sharing one grid between them is most of why a street
    // of these used to read as wallpaper.
    vec2 grid = vec2(vUv.x / fp.columnM, vUv.y / fp.storeyM);
    float floorIdx = floor(grid.y);
    float colIdx = floor(grid.x);
    vec2 cell = fract(grid);

    // How much of a window cell one pixel covers. Taken on the CONTINUOUS
    // grid coordinate, not on the fract()ed one: fract() has a derivative spike
    // at every seam, and fwidth of that reads as an enormous width along a
    // one-pixel line.
    vec2 w = max(fwidth(grid), vec2(1e-4));

    // Analytic filtering, not a distance fade.
    //
    // A 2.6 m window at 2 km is far smaller than a pixel, and point-sampling
    // it sparkles: the pattern aliases against the pixel grid and every frame
    // lands on different windows. The old answer was to cross-fade the whole
    // pattern to its mean between 4200 m and 900 m, which killed it while it
    // was still several pixels wide -- from 800 m up, most of the city was
    // past the fade, and a city of flat-shaded boxes is exactly what it looked
    // like.
    //
    // Widening each edge by the pixel footprint is what a correctly filtered
    // version does: the windows stay resolved for as long as the PIXELS can
    // hold them, and dissolve into their own mean exactly when they can't.
    // It is also per-pixel rather than per-vertex-distance, so a wall seen
    // edge-on -- where a pixel really does span many windows -- converges even
    // though it is close.
    float detail = 1.0 - clamp(max(w.x, w.y) * 1.6, 0.0, 1.0);
    float winMean = (fp.win.y - fp.win.x) * (fp.win.w - fp.win.z);

    // Window rectangle inside the cell, every edge softened by the pixel
    // footprint so it antialiases instead of stair-stepping.
    // The wall carries on past the roof slab to make the parapet, so the grid
    // has to STOP at the roof line -- otherwise the coping gets a row of
    // windows in it and the parapet reads as one more storey.
    float capped = step(vUv.y, bldH);
    float winPattern =
        smoothstep(fp.win.x - w.x, fp.win.x + w.x, cell.x)
      * smoothstep(fp.win.y + w.x, fp.win.y - w.x, cell.x)
      * smoothstep(fp.win.z - w.y, fp.win.z + w.y, cell.y)
      * smoothstep(fp.win.w + w.y, fp.win.w - w.y, cell.y);
    winPattern *= capped;
    float win = mix(winMean * capped, winPattern, detail);

    // Ground floor is taller and shopfront-like, not a repeated window.
    if (vUv.y < fp.storeyM * 1.15) win *= 0.35;

    glassMask = win * fp.glassFrac;

    vec3 glass = mix(vec3(0.075, 0.095, 0.125), vec3(0.15, 0.19, 0.24), hash11(fp.seed + 3.3));
    albedo = mix(albedo, glass, glassMask);

    // Horizontal banding between storeys: a thin darker line reads as a floor
    // slab and gives the facade its scale at distance.
    albedo *= 1.0 - 0.18 * detail * smoothstep(0.10 + w.y, 0.0, cell.y);

    // --- Relief ---------------------------------------------------------
    // Every facade used to be geometrically flat and lit as flat, which is a
    // thing no photograph of a building has ever been. The window edges get a
    // normal that tilts into the reveal, and the reveal itself is darkened,
    // so the wall has depth from any angle the sun is in.
    //
    // Scaled by detail like everything else here: at two kilometres a 100 mm
    // reveal is far under a pixel and perturbing the normal by it would just
    // make the wall sparkle.
    float ew = max(0.05, w.x * 2.0);
    float ewy = max(0.05, w.y * 2.0);
    float gx = tent(cell.x, fp.win.x, ew) - tent(cell.x, fp.win.y, ew);
    float gy = tent(cell.y, fp.win.z, ewy) - tent(cell.y, fp.win.w, ewy);
    float relief = fp.relief * detail;
    // The wall's own tangent frame: along the wall, and straight up.
    vec3 tang = normalize(vec3(n.z, 0.0, -n.x));
    // 0.22, not the 0.55 this started at. A reveal is 100-200 mm deep on a
    // 1.8 m window, so the surface it presents is a narrow chamfer, not a
    // 20-degree fold -- and at 0.55 every window grew a bright mullion round
    // it and a wall of them read as glazed tiles rather than as masonry.
    n = normalize(n + (tang * gx + vec3(0.0, 1.0, 0.0) * gy) * relief * 0.22);
    // Most of what a reveal actually does is cast a line of shadow, so the
    // darkening carries more of the effect than the normal does.
    albedo *= 1.0 - 0.38 * relief * (abs(gx) + abs(gy));

    // A cornice: the last metre below the parapet is a projecting band, so it
    // is brighter on top and casts a line of shadow under itself. On a stone
    // or brick building this is a real moulding; on a curtain wall the relief
    // parameter is near zero and it barely shows, which is also correct.
    float belowTop = bldH - vUv.y;
    albedo *= 1.0 - 0.45 * fp.relief * detail
                  * smoothstep(0.0, 1.4, belowTop) * smoothstep(2.6, 1.4, belowTop);

    // Ambient occlusion down the wall -- on the SKY term, not the albedo.
    //
    // A street is a canyon. A wall at pavement level sees a slot of sky; the
    // same wall thirty storeys up sees half a dome. That is an occlusion of
    // ambient light and of nothing else.
    //
    // This used to multiply albedo, and that is why it had to be kept weak:
    // scaling albedo also darkens the face the SUN is falling on, so stacking
    // it down every wall on the block turned the streets into black trenches
    // from the air, and it was backed off to 0.74 over 9 m. Against the sky
    // term alone it can be far stronger and go far deeper, because a sunlit
    // wall at street level keeps its whole beam and stays bright -- which is
    // what a photograph of a city at low sun actually looks like.
    //
    // The floor stays at 0.34 even though GTAO now measures contact occlusion
    // directly, because inside a canyon the two barely overlap. Measured on the
    // 7th Ave pose, the screen-space pass finds occlusion on 7% of its buffer
    // against 34% to 63% on the rooftop and residential poses: from a camera in
    // the street the far wall is most of a screen width away and the pavement
    // at the foot of this one is usually not in the frame at all, so there is
    // almost nothing for it to find. The overlap is a narrow band at the base
    // of a wall whose pavement happens to be visible, and there the extra
    // darkening is the right answer anyway.
    skyOcc = mix(0.34, 1.0, smoothstep(0.0, 48.0, vUv.y));

    // --- Lit windows at night -------------------------------------------
    if (uNight > 0.02) {
      // Upper floors empty first: the top of a tower is the executive floor
      // and the plant room, and neither is occupied at two in the morning.
      float heightFade = mix(1.0, 0.55, smoothstep(0.0, 120.0, vUv.y));
      // Correlated occupancy: cores, then floors, then tenancies, then the
      // individual window. See facade.ts -- an independent coin per cell is
      // exactly what produced a checkerboard.
      float litPattern = facadeLit(fp, colIdx, floorIdx, heightFade) * winPattern;
      float occ = facadeMeanOccupancy(fp, heightFade);
      // Same treatment as the window pattern: resolve individual lit windows
      // up close, converge to the average glow of a lit building far away.
      float lit = mix(occ * winMean, litPattern, detail);
      // A third of the windows cool. Offices are fluorescent and LED, homes
      // are warm, and a city that is entirely sodium-orange at night is a city
      // from before about 1995. Homes lean warm and offices lean cool, which
      // is why the mix is keyed on the occupancy group and not on a coin.
      float coolBias = fp.group < 0.5 ? 0.80 : 0.42;
      vec3 warm = mix(vec3(1.0, 0.74, 0.42), vec3(0.82, 0.88, 1.0),
                      step(coolBias, hash21(vec2(colIdx * 0.37 + fp.seed, floorIdx * 0.71))));
      // The number to watch is not the peak, it is the MEAN. Far away this
      // converges to occupancy x winMean x scale over the whole facade, and at
      // 0.2 that mean was about four times the wall's own night lighting: a
      // warm wash over every surface, which is what made the city read tan
      // however neutral the skyglow and the albedo were made. At 0.09 the mean
      // sits at roughly the wall, so a building is dark with lit windows in
      // it, and the peak is still 12x the wall up close where it should be.
      emissive += warm * lit * uNight * 0.09;
    }

    if (capped < 0.5) {
      albedo = parapetColour(fp);
      skyOcc = 0.9;
    }
  } else if (part < 1.5) {
    // --- Roof -----------------------------------------------------------
    // Roofs are dirtier and flatter than facades, and they are what you see
    // most of from an aircraft, so they get their own noise rather than the
    // facade colour applied upward.
    // Two octaves at scales with no common factor, the second one ROTATED.
    // Both on the same axis-aligned grid at 2:1 contrast came out as a
    // chessboard, which from directly above is the largest single surface in
    // the frame and the most obviously fake thing in it.
    vec2 rp = mat2(0.88, 0.47, -0.47, 0.88) * vWorld.xz;
    float g = hash21(floor(vWorld.xz * 0.33) + fp.seed * 97.0);
    // Real roofs are tar, black membrane and gravel: about 0.06-0.12 linear.
    // These were 0.26-0.42, two to three times too reflective, which made the
    // roof the BRIGHTEST surface in a top-down shot when in every aerial
    // photograph it is the darkest.
    albedo = mix(vec3(0.128, 0.128, 0.122), vec3(0.188, 0.183, 0.170), g);
    // Patchwork: membrane seams, ponding, a re-covered section. One more
    // octave, at a scale a roof actually varies over.
    float wear = hash21(floor(rp * 0.085) + fp.seed * 13.0);
    albedo *= 0.84 + 0.26 * wear;
  } else if (part < 2.5) {
    // --- Parapet --------------------------------------------------------
    // The low wall round the roof edge. Coped in stone or concrete whatever
    // the wall below is made of, so it is its own pale grey rather than the
    // facade colour carried upward -- which is exactly the line that makes a
    // box read as a building from the air.
    albedo = parapetColour(fp);
    // The inner face of the parapet is in permanent shade from the roof.
    albedo *= n.y < -0.01 ? 0.7 : 1.0;
    skyOcc = 0.85;
  } else {
    // --- Rooftop plant --------------------------------------------------
    // Air handlers, chillers, stair overruns, tanks. Galvanised and painted
    // metal, greyer and slightly glossier than the roof they stand on.
    float g = hash21(floor(vWorld.xz * 0.6) + fp.seed * 41.0);
    albedo = mix(vec3(0.30, 0.30, 0.31), vec3(0.46, 0.46, 0.45), g);
    if (isRoof > 0.5) albedo *= 0.86;   // the tops streak and collect dirt
    skyOcc = 0.8;
  }

  // At night a facade has no colour of its own. It is lit by skyglow and by
  // whatever is lit opposite it, and both are the same colour for every
  // building on the block -- so carrying the daytime brick, sandstone and
  // concrete palette through at full strength is what made a night city read
  // as a tan photograph with dots sprinkled over it. The windows keep their
  // colour, because they are the light source rather than a surface.
  if (uNight > 0.02) {
    float ng = dot(albedo, vec3(0.299, 0.587, 0.114));
    albedo = mix(albedo, vec3(ng * 0.55), uNight * 0.88);
  }

  albedo *= (1.0 - 0.35 * uWetness);

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  // Cascaded shadow map. It multiplies the DIRECT beam and the sun's specular
  // and nothing else: a wall in shadow is still lit by the sky above it and by
  // the light bouncing off everything opposite, which is why real city shadows
  // are blue rather than black.
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl * sunVis;
  // Moonlight, same units as the sun beam. Lit windows alone made a night city
  // read as a floating grid of dots with no buildings behind them; this is
  // what puts the facades back under the lights.
  vec3 beam = direct + uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));

  // Sky irradiance, from the scene probe. This used to be a hemispherical
  // constant in n.y with a hand-rolled fudge to make faces toward the sun a
  // little brighter; the probe measures that instead, and gets the sunset case
  // right for the same cost, because an SH evaluation IS nine multiply-adds.
  //
  // Two occlusions, at two scales, and they do not overlap.
  //
  //   skyOcc is the STREET CANYON: the building across the road, forty metres
  //   away and frequently outside the frame. Analytic, from the height up the
  //   wall, because no screen-space search can see it.
  //
  //   sampleSkyOcclusion is the CONTACT: the pavement at the foot of the wall,
  //   the inside corner where two wings meet, the parapet, the plant room. Six
  //   metres of measured geometry.
  //
  // The bent normal is what turns the second one into enclosure rather than
  // dirt in the corners. A wall in a canyon looks the sky up along the strip it
  // can actually see -- upward, and out along the street -- instead of getting
  // a uniformly dimmed sample of the whole dome.
  //
  // Both multiply the SKY term and neither touches the beam above. Skyglow is
  // left alone as well: it comes from the street, not from the dome, so a
  // hemisphere-shaped occlusion is the wrong instrument for it.
  vec3 ambient = occludedSkyIrradiance(n) * skyOcc
               + uNightGlow * (1.0 - 0.35 * n.y);

  vec3 lit = albedo * (beam + ambient) + emissive;

  vec3 v = normalize(uCameraPos - vWorld);

  // --- Glass ------------------------------------------------------------
  //
  // A glass tower is a MIRROR, and that is not a detail: looking at one
  // straight on you see a dark green-grey pane, and at a grazing angle you see
  // the sky. The whole angular swing happens over about thirty degrees, and it
  // is what separates a glass building from a grey one. Terrain does the same
  // thing for water and for the same reason.
  //
  // The reflected radiance is the scene sky probe, sampled at the facade
  // family's own roughness: see render/skyprobe.ts. One probe serves every
  // building because the sky is at infinity, which is what makes this
  // affordable where a probe per building never could be. It is the sky and the
  // ground rather than the real skyline reflected back, so a tower does not
  // show its neighbours; what it does show is the right colour swinging the
  // right way at the right angle, which is what the eye is reading.
  //
  // Modulated by glassMask, so the spandrel panel between the floors stays
  // matte. A tower that is shiny all over reads as plastic.
  if (glassMask > 0.004) {
    vec3 refl = reflect(-v, n);
    // The cube holds RADIANCE in the same linear HDR space this shader writes,
    // so it goes straight into the Fresnel mix with no scale factor. That is
    // the point of capturing it through the same atmosphere the sky dome runs:
    // the reflection and the sky behind the tower are the same numbers.
    //
    // Skyglow is added on top because the probe has no city in it, and after
    // dark a glass tower reflects the city rather than the sky.
    vec3 skyRefl = textureLod(uEnv, refl, clamp(fp.roughness, 0.0, 1.0) * uEnvMaxLod).rgb
                 + uNightGlow * 0.4;
    // Schlick, with the 4% normal-incidence reflectance of glass.
    float f = pow(1.0 - clamp(dot(v, n), 0.0, 1.0), 5.0);
    float fres = 0.04 + 0.96 * f;
    lit = mix(lit, skyRefl, fres * glassMask * (1.0 - fp.roughness * 0.6));
  }

  // Specular: a tight sun glint on glass, a broad one on wet stone.
  float gloss = max(glassMask, uWetness);
  if (gloss > 0.02) {
    float shine = mix(900.0, 40.0, fp.roughness);
    vec3 h = normalize(v + uSunDir);
    float spec = pow(max(0.0, dot(n, h)), shine);
    lit += uSunColor * uSunIntensity * uSunSurface * sunT * spec * gloss * 1.4 * sunVis;
    vec3 hm = normalize(v + uMoonDir);
    lit += uMoonLight * uSunSurface * pow(max(0.0, dot(n, hm)), shine) * gloss * 1.4;
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);

  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export interface BuildingUniforms extends SunShadowUniforms, AoUniforms {
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  /** Sky irradiance, 9 RGB coefficients; see render/sh.ts. */
  uSH: THREE.IUniform<Float32Array>;
  /** Prefiltered sky radiance for the glass; see render/skyprobe.ts. */
  uEnv: THREE.IUniform<THREE.CubeTexture | null>;
  uEnvMaxLod: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
  uWetness: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
  /** Per-building facade parameters; see render/facade.ts. */
  uFacade: THREE.IUniform<THREE.DataTexture | null>;
  uFacadeWidth: THREE.IUniform<number>;
  /** How busy homes / offices / everything else are at the scene's hour. */
  uHourFactor: THREE.IUniform<THREE.Vector3>;
}

/**
 * `shadow` is spread in by REFERENCE, so the cascade matrices and maps the
 * SunShadow pass writes each frame are the same objects these materials read.
 */
function makeUniforms(shadow: SunShadowUniforms): BuildingUniforms {
  return {
    ...shadow,
    ...aoUniforms(),
    uCameraPos: { value: new THREE.Vector3() },
    // The hemispherical ambient the shader ran before the probe existed, so a
    // frame drawn before the first capture is the old picture, not a black one.
    uSH: { value: shHemispherical([0.2, 0.24, 0.3], 0.55, 0.45) },
    uEnv: { value: null },
    uEnvMaxLod: { value: 6 },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonLight: { value: new THREE.Color(0, 0, 0) },
    uWetness: { value: 0 },
    uSunSurface: { value: 0.105 },
    uExposure: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSunIntensity: { value: 16 },
    uMieG: { value: 0.76 },
    uTurbidity: { value: 1 },
    uCamAltitude: { value: 100 },
    uMultiScatter: { value: 0.055 },
    uFacade: { value: null },
    uFacadeWidth: { value: 1 },
    uHourFactor: { value: new THREE.Vector3(1, 1, 1) },
  };
}

/** Exported so test/roof.check.ts can gate the real geometry, not a copy. */
export interface Scratch {
  pos: number[];
  nrm: number[];
  uv: number[];
  info: number[];
  idx: number[];
}

export function emptyScratch(): Scratch {
  return { pos: [], nrm: [], uv: [], info: [], idx: [] };
}

/** True when (x, z) is inside the ring. Standard crossing count. */
function insideRing(ring: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1];
    const xj = ring[j * 2], zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A box standing on the roof. Five quads: four sides and a lid, no floor,
 * because nothing ever sees under one.
 */
function addBox(
  s: Scratch,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  y0: number,
  y1: number,
  bidx: number,
  bldH: number,
): void {
  const push = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx2: number, cy: number, cz2: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    isRoof: number,
  ) => {
    const v = s.pos.length / 3;
    s.pos.push(ax, ay, az, bx, by, bz, cx2, cy, cz2, dx, dy, dz);
    for (let k = 0; k < 4; k++) {
      s.nrm.push(nx, ny, nz);
      s.uv.push(0, 0);
      s.info.push(bidx, bldH, isRoof, PART_CLUTTER);
    }
    s.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  };

  const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz;
  // Each face wound so its geometric normal matches the shading normal given.
  // test/roof.check.ts asserts exactly that, for every triangle in the pack.
  push(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, 0, 0, -1, 0);
  push(x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1, 0, 0, 1, 0);
  push(x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, -1, 0, 0, 0);
  push(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 1, 0, 0, 0);
  push(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0, 1);
}

/**
 * Scatter plant across a roof.
 *
 * Placement is rejection-sampled inside the footprint rather than laid on a
 * grid, because a grid of air handlers is its own kind of tell. Everything --
 * how many, how big, where -- comes off the building's seed, so the same
 * building gets the same roof on every run and the screenshots stay comparable.
 */
function addRoofPlant(
  s: Scratch,
  b: Building,
  top: number,
  extras: RoofExtras,
  bidx: number,
  bldH: number,
  seed: number,
): void {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < b.ring.length; i += 2) {
    minX = Math.min(minX, b.ring[i]); maxX = Math.max(maxX, b.ring[i]);
    minZ = Math.min(minZ, b.ring[i + 1]); maxZ = Math.max(maxZ, b.ring[i + 1]);
  }
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  if (spanX < 6 || spanZ < 6) return;

  const want = extras.boxes + (extras.overrun ? 1 : 0);
  let placed = 0;
  for (let attempt = 0; attempt < want * 6 && placed < want; attempt++) {
    const rx = hash3(seed, 0x800 + attempt, 1);
    const rz = hash3(seed, 0x800 + attempt, 2);
    const px = minX + spanX * (0.12 + 0.76 * rx);
    const pz = minZ + spanZ * (0.12 + 0.76 * rz);
    if (!insideRing(b.ring, px, pz)) continue;

    // The first one placed is the stair and lift overrun when the building is
    // tall enough to have one: bigger, taller and squarer than a chiller.
    const isOverrun = extras.overrun && placed === 0;
    const r1 = hash3(seed, 0x900 + attempt, 3);
    const r2 = hash3(seed, 0x900 + attempt, 4);
    const r3 = hash3(seed, 0x900 + attempt, 5);
    const hx = isOverrun ? 2.2 + 1.8 * r1 : 1.1 + 1.6 * r1;
    const hz = isOverrun ? 2.0 + 1.8 * r2 : 1.0 + 1.5 * r2;
    const hy = isOverrun ? 3.0 + 1.6 * r3 : 0.9 + 1.6 * r3;
    // Only if the whole box is inside the roof: half a chiller hanging over
    // the parapet is worse than no chiller.
    if (
      !insideRing(b.ring, px - hx, pz - hz) || !insideRing(b.ring, px + hx, pz - hz) ||
      !insideRing(b.ring, px - hx, pz + hz) || !insideRing(b.ring, px + hx, pz + hz)
    ) continue;

    addBox(s, px, pz, hx, hz, top, top + hy, bidx, bldH);
    placed++;
  }
}

export function addBuilding(
  s: Scratch,
  b: Building,
  groundY: number,
  bidx: number,
  extras: RoofExtras = NO_EXTRAS,
  params?: FacadeParams,
): void {
  const n = b.ring.length / 2;
  if (n < 3) return;

  const base = groundY + b.baseM;
  const top = groundY + b.topM;
  const height = top - base;
  if (height <= 0.5) return;

  // Sink the base so the walls meet sloping terrain instead of hovering.
  const sunk = base - 3.0;

  // The parapet is drawn by carrying the WALL up past the roof slab rather
  // than as its own ring of geometry: the outer face is already there, so the
  // only new triangles are the inner face looking back down at the roof. The
  // shader knows where the building stops (info.y) and stops the window grid
  // there, so the band above it comes out as the coping it is.
  const parapetM = extras.parapet && params ? Math.max(0.4, params.parapetM) : 0;
  const wallTop = top + parapetM;

  const pushInfo = (isRoof: number, part: number) => s.info.push(bidx, height, isRoof, part);

  // --- Walls ---
  let run = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = b.ring[i * 2], z0 = b.ring[i * 2 + 1];
    const x1 = b.ring[j * 2], z1 = b.ring[j * 2 + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;

    // Outward normal for a counter-clockwise ring in (x, z).
    const nx = dz / len;
    const nz = -dx / len;

    const v0 = s.pos.length / 3;
    s.pos.push(x0, sunk, z0,  x1, sunk, z1,  x1, wallTop, z1,  x0, wallTop, z0);
    for (let k = 0; k < 4; k++) s.nrm.push(nx, 0, nz);
    // v runs from 0 at the true base (not the sunk base) so the storey grid
    // lines up with the visible building rather than with the buried part.
    const vBot = sunk - base;
    const vTop = height + parapetM;
    s.uv.push(run, vBot, run + len, vBot, run + len, vTop, run, vTop);
    for (let k = 0; k < 4; k++) pushInfo(0, PART_WALL);

    // Winding must agree with the normal above, or backface culling removes the
    // wrong side. It did: the triangle (v0,v1,v2) faces (-dz, 0, dx) while the
    // shading normal is (dz, 0, -dx) -- exactly opposite. So every OUTWARD wall
    // was culled and every inward one drawn, and the buildings rendered as open
    // shells you could see inside, lit by normals pointing away from the face
    // actually on screen.
    s.idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);

    if (parapetM > 0) {
      // The inner face, looking back across the roof. Zero thickness: a real
      // parapet is a few hundred millimetres thick and that is under a pixel
      // from anywhere you would ever see it from, so the coping is a line
      // where the two faces meet rather than a cap costing another quad a
      // segment across a hundred thousand buildings.
      const p0 = s.pos.length / 3;
      s.pos.push(x0, top, z0,  x1, top, z1,  x1, wallTop, z1,  x0, wallTop, z0);
      for (let k = 0; k < 4; k++) s.nrm.push(-nx, 0, -nz);
      s.uv.push(run, height, run + len, height, run + len, vTop, run, vTop);
      for (let k = 0; k < 4; k++) pushInfo(0, PART_PARAPET);
      // Reversed against the outer wall, because the normal is.
      s.idx.push(p0, p0 + 1, p0 + 2, p0, p0 + 2, p0 + 3);
    }

    run += len;
  }

  // --- Roof ---
  const tri = triangulate(b.ring);
  if (tri.length) {
    const v0 = s.pos.length / 3;
    for (let i = 0; i < n; i++) {
      s.pos.push(b.ring[i * 2], top, b.ring[i * 2 + 1]);
      s.nrm.push(0, 1, 0);
      s.uv.push(b.ring[i * 2], b.ring[i * 2 + 1]);
      s.info.push(bidx, height, 1, PART_ROOF);
    }
    // REVERSED against the ring's own winding, and that is not a typo.
    //
    // `triangulate` takes a ring that is counter-clockwise in (x, z) and hands
    // back triangles in that same order. Lifted into 3D with y up, a ring that
    // is counter-clockwise in (x, z) winds CLOCKWISE seen from above, so those
    // triangles face STRAIGHT DOWN. With THREE.FrontSide that culls every roof
    // when you look at the city from the air, and a city of open-topped boxes
    // is exactly what it sounds like -- measured at 99.8% of roof triangles on
    // the Manhattan pack before this line was reversed.
    //
    // The walls hit the same trap and carry their own note above.
    // test/roof.check.ts is the gate; it fails if this flips back.
    for (let i = 0; i + 2 < tri.length; i += 3) {
      s.idx.push(v0 + tri[i], v0 + tri[i + 2], v0 + tri[i + 1]);
    }
  }

  if (extras.boxes > 0 || extras.overrun) {
    addRoofPlant(s, b, top, extras, bidx, height, params ? params.seed * 4096 : bidx);
  }
}

function buildMesh(s: Scratch, uniforms: BuildingUniforms): THREE.Mesh | null {
  if (!s.idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(s.pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(s.nrm, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(s.uv, 2));
  geo.setAttribute("info", new THREE.Float32BufferAttribute(s.info, 4));
  geo.setIndex(s.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(s.idx, 1) : new THREE.Uint16BufferAttribute(s.idx, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.RawShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    glslVersion: THREE.GLSL3,
    side: THREE.FrontSide,
  });
  return new THREE.Mesh(geo, mat);
}

/**
 * The per-building parameter texture.
 *
 * One row is a run of buildings, six RGBA texels each. Float32 because the
 * values are probabilities and metres and colours and none of them wants to be
 * quantised, and because at ~60k buildings drawn the whole thing is under six
 * megabytes -- a tenth of what the geometry it describes costs.
 */
const FACADE_TEX_WIDTH = 1024;

function buildFacadeTexture(params: FacadeParams[]): THREE.DataTexture {
  const texels = params.length * (FACADE_FLOATS / 4);
  const height = Math.max(1, Math.ceil(texels / FACADE_TEX_WIDTH));
  const data = new Float32Array(FACADE_TEX_WIDTH * height * 4);
  for (let i = 0; i < params.length; i++) packFacade(params[i], data, i);

  // HALF float, not full, and the reason is a real device.
  //
  // An Android phone rendered every building magenta, which is the sentinel in
  // FACADE_GLSL for "every texelFetch came back zero": the RGBA32F table was
  // not readable there at all. Measured, every value this table stores lies in
  // 0..20, so fp16 (about 1e-3 relative, and exact for the small integers that
  // pack group and family together) loses nothing, halves the upload, and is
  // far more widely supported on mobile GL than fp32 sampling.
  //
  // Chicago goes from 10.6 MB to 5.3 MB, on a device that has already shown it
  // is short of GPU memory.
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);

  const tex = new THREE.DataTexture(half, FACADE_TEX_WIDTH, height, THREE.RGBAFormat, THREE.HalfFloatType);
  // Nearest and no mips: this is a lookup table, not an image. Any filtering
  // would blend one building's storey height into its neighbour's.
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export interface BuildingStats {
  drawn: number;
  skippedFar: number;
  /** Huge near-flat footprints (rail yards, piers) dropped as visual noise. */
  skippedFlat: number;
  triangles: number;
  cells: number;
  /** LOD aggression the budget solver settled on; 1 means everything fits. */
  lod: number;
  /** Buildings that got a parapet, and rooftop boxes placed. */
  parapets: number;
  plantBoxes: number;
  /** Facade families in use, indexed by FacadeFamily. */
  families: number[];
}

export class Buildings {
  readonly group = new THREE.Group();
  readonly uniforms: BuildingUniforms;
  readonly stats: BuildingStats;

  constructor(
    pack: CityPack,
    groundAt: (x: number, z: number) => number,
    shadow: SunShadowUniforms,
    budget: Budget,
  ) {
    this.uniforms = makeUniforms(shadow);
    const lodK = solveLod(pack, budget.buildingTriangleBudget);
    const cells = new Map<string, Scratch>();
    const params: FacadeParams[] = [];
    const families: number[] = new Array(5).fill(0);
    let drawn = 0;
    let skippedFar = 0;
    let skippedFlat = 0;
    let parapets = 0;
    let plantBoxes = 0;

    for (let i = 0; i < pack.buildings.length; i++) {
      const b = pack.buildings[i];
      const dist = Math.hypot(b.cx, b.cz);
      const h = b.topM - b.baseM;
      if (h < minHeightAt(dist, lodK)) { skippedFar++; continue; }

      // Drop enormous near-flat footprints.
      //
      // OSM tags rail yards, pier decks, quays and station train sheds as
      // buildings. Extruded a couple of metres over a hundred thousand square
      // metres they are not buildings in any visual sense -- they are dark flat
      // plates lying on the ground, and several of Manhattan's sit out in the
      // Hudson looking like holes in the water. A genuine large building (a
      // stadium, a convention centre, a big-box store) clears 8 m easily, so
      // the pair of conditions is narrow: 50 of Manhattan's 187k, 7 of San
      // Francisco's 62k.
      const area = Math.abs(signedArea(b.ring));
      if (h < 8 && area > 20000) { skippedFlat++; continue; }

      // Winding must be counter-clockwise for the wall normals and the ear
      // clipper to agree. The baker normalises it, but a pack from an older
      // baker (or a hand-made one) must not silently render inside out.
      if (signedArea(b.ring) < 0) {
        const r = b.ring;
        for (let a = 0, z = r.length / 2 - 1; a < z; a++, z--) {
          const tx = r[a * 2], tz = r[a * 2 + 1];
          r[a * 2] = r[z * 2]; r[a * 2 + 1] = r[z * 2 + 1];
          r[z * 2] = tx; r[z * 2 + 1] = tz;
        }
      }

      // Lowest ground under the footprint, so nothing floats on a hillside.
      // Shared with the drone's collider, which has to raise its roof to the
      // same height this puts the geometry at.
      const groundY = footprintGroundY(b, groundAt);

      const key = `${Math.floor(b.cx / CELL_M)},${Math.floor(b.cz / CELL_M)}`;
      let s = cells.get(key);
      if (!s) { s = emptyScratch(); cells.set(key, s); }

      // The seed is the building's index in the pack, so a facade is stable
      // across runs and traceable back to one record.
      const fp = facadeFor(b.kind, h, i);
      const bidx = params.length;
      params.push(fp);
      families[fp.family]++;

      const extras = roofExtras(dist, lodK, h, area);
      if (extras.parapet) parapets++;
      plantBoxes += extras.boxes + (extras.overrun ? 1 : 0);

      addBuilding(s, b, groundY, bidx, extras, fp);
      drawn++;
    }

    const tex = buildFacadeTexture(params);
    this.uniforms.uFacade.value = tex;
    this.uniforms.uFacadeWidth.value = FACADE_TEX_WIDTH;

    let triangles = 0;
    for (const s of cells.values()) {
      const mesh = buildMesh(s, this.uniforms);
      if (mesh) {
        // enable, not set: `set` would drop the mesh off layer 0 and the main
        // camera would stop drawing the city altogether.
        mesh.layers.enable(SHADOW_CASTER_LAYER);
        triangles += s.idx.length / 3;
        this.group.add(mesh);
      }
    }

    this.stats = {
      drawn, skippedFar, skippedFlat, triangles, cells: cells.size, lod: lodK,
      parapets, plantBoxes, families,
    };
  }

  /**
   * Release the GPU memory this group holds.
   *
   * A baked city is built once and lives for the page, so nothing needed this
   * until the live path started building a Buildings per streamed tile. Without
   * it a long flight leaks a facade table and a few megabytes of vertex buffers
   * per tile on a device where memory is already the ceiling.
   */
  dispose(): void {
    (this.uniforms.uFacade.value as THREE.Texture | null)?.dispose();
    for (const child of this.group.children) {
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    this.group.clear();
  }
}
