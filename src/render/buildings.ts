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
  HOUSE_OPEN_FRAC,
  FACADE_BYTE_TEXELS,
  encodeFacadeValue,
  facadeFor,
  hash3,
  packFacade,
  type FacadeParams,
} from "./facade";
import {
  BuildingKind,
  RoofShape,
  footprintGroundY,
  type Building,
  type CityPack,
} from "../data/citypack";

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

function roofExtras(
  distM: number,
  k: number,
  heightM: number,
  areaM2: number,
  kind: BuildingKind,
  roof: RoofShape,
): RoofExtras {
  // A parapet exists to hide roof plant and to give a fire separation on a flat
  // commercial roof. Nothing residential has one, and nothing with a pitch to
  // it could: the wall stops at the eave. Putting a chiller on a house is the
  // same mistake seen from further away.
  if (roof !== RoofShape.Flat || kind === BuildingKind.Residential) return NO_EXTRAS;
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
      // The tent, when this footprint gets one. A hip is 4 to 6 and a gable is
      // 6, so 8 deliberately overestimates: the pitch itself also depends on
      // the OBB fill test, which is far too expensive to run inside this loop.
      if (b.roof === RoofShape.Pitched && h >= 4.0 && h <= 20.0) tris += 8;
      if (dist < PARAPET_M / k) {
        tris += extrasCost(n, roofExtras(dist, k, h, Math.abs(signedArea(b.ring)), b.kind, b.roof));
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
// The building index rides a FLAT varying. Interpolated, a constant 150000 is
// not guaranteed to arrive as 150000: an Android GPU delivered it a few counts
// off, differently per pixel, and since it addresses the facade table every
// pixel read some neighbour's record. Manhattan rendered as speckle in other
// buildings' colours.
flat out float vBidx;
out float vViewDist;

void main() {
  vNormal = normal;
  vWorld = position;
  vUv = uv;
  vInfo = info;
  vBidx = info.x;
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** info.w: which piece of the building a fragment belongs to. */
export const PART_WALL = 0;
export const PART_ROOF = 1;
export const PART_PARAPET = 2;
export const PART_CLUTTER = 3;
export const PART_SHINGLE = 4;
/**
 * The vertical triangle under a gable ridge. It is siding, so it runs the
 * facade branch; it needs a tag of its own only because it is the one wall
 * piece that legitimately reaches above info.y, where PART_WALL would take it
 * for a parapet and paint it with the coping's pale grey.
 */
export const PART_GABLE = 5;

// --- What ONE lit window looks like ------------------------------------------
//
// facade.ts owns WHICH windows are lit, because that half is a contract between
// a per-cell rule and a closed form and it is gated as one. These constants own
// what a lit window then looks like inside its own cell, which the shader is
// free to decide on its own -- with one condition, and it is the reason every
// one of them is normalised where it is used: none of them may move the MEAN.
// The emissive scale (0.09) was tuned against the wall's own night lighting, so
// a change that quietly dims the city by a fifth is not a detail, it is an
// exposure error over the whole frame.

/** Fraction of lit windows with a blind partly down. */
const BLIND_FRAC = 0.5;
/** Most of a window's height a blind ever covers, leaving a band at the cill. */
const BLIND_MAX = 0.75;
/**
 * Mean fraction of a lit window's height a blind leaves showing.
 *
 * The drop is uniform on (0, BLIND_MAX] when there is a blind at all, so the
 * mean loss is BLIND_FRAC * BLIND_MAX / 2. Derived rather than written down: it
 * is what the near-field pattern is divided by, and a stale copy of it would
 * put the far field and the near field at different brightnesses, which is the
 * exact class of bug the core-slot fix was.
 */
const BLIND_KEEP = 1 - (BLIND_FRAC * BLIND_MAX) / 2;
/** How far a lit window throws light onto its reveal and spandrel, metres. */
const SPILL_M = 0.35;
/** Peak of that spill, against the pane itself. */
const SPILL_LEVEL = 0.2;
/**
 * Per-tenancy lamp intensity, log-uniform over LAMP_LO..LAMP_HI.
 *
 * Log rather than linear because that is how lighting varies: the steps
 * between a desk lamp near the glass, a ceiling fixture and a dark room with a
 * television are ratios, not differences, and a linear spread puts almost
 * nothing at the dim end where most of a night facade actually sits.
 */
const LAMP_LO = 0.35;
const LAMP_HI = 1.6;
/**
 * What that distribution has to be divided by for its mean to be exactly 1.
 *
 * A log-uniform variable on [a,b] has mean (b-a)/ln(b/a), which for these two
 * is 0.822: left alone the spread would take a fifth off the whole city's night
 * exposure. Normalised, the multiplier runs 0.43x to 1.94x with a mean of 1.
 */
const LAMP_NORM = Math.log(LAMP_HI / LAMP_LO) / (LAMP_HI - LAMP_LO);

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUv;
in vec4 vInfo;
flat in float vBidx;
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
// ?flatglass=1: put the glazing back in the plane of the wall. See the reveal
// block in the facade branch, and tools/verify-glass.ts, which needs to run the
// old behaviour in the SAME binary or its assertions measure nothing.
uniform float uFlatGlass;
// ?flatrefl=1: put the ENV REFLECTION back to what this repo had before the
// glazing reflectance work -- one bare-dielectric F0 of 0.04 for every family,
// and the probe's open sunlit ground under every downward reflected ray. The
// vacuity probe for the reflection half of tools/verify-glass.ts.
uniform float uFlatRefl;
// Built-ness over the city, 0..1, from render/urbanmask.ts. The same coverage
// grid terrain.ts lights its streets from; here it says how much of what a
// facade reflects BELOW the horizon is other buildings rather than open ground.
uniform sampler2D uUrban;
uniform float uUrbanExtent;
// ?buildingDebug=1 replaces the shaded output with a flat marker on the FACADE
// fragments and nothing else, so a measurement of a facade can ask the shader
// which pixels are facade instead of guessing from colour. Pure blue rather
// than white: r and g stay at zero through the tonemap, and nothing else in a
// daylight frame -- not sky, not water, not pale render -- comes out with two
// dead channels.
//
// ?buildingDebug=2 is the same marker restricted to the facade fragments seen
// at a GRAZING angle, so a measurement of the Fresnel term can ask the shader
// which faces are grazing instead of drawing boxes on a frame. Same encoding,
// so one mask reader serves both, and mode 1 minus mode 2 is the square-on set.
uniform float uBuildingDebug;

// The split between "grazing" and "square-on" for buildingDebug=2, as cos of
// the angle off the wall normal. 0.5 is 60 degrees off, which is where Schlick
// starts to run away: a 0.04 surface returns 7% at 45 degrees and 15% at 70.
const float GRAZE_COS = 0.5;

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

// Smooth value noise, for surfaces whose variation is CONTINUOUS.
//
// hash21 of a floored coordinate is a lattice of flat random squares, and on a
// roof seen from directly above that is the single largest surface in an aerial
// frame: it reads as pixelation, because that is exactly what it is. Tar,
// gravel and weathering vary smoothly, so they want an interpolated noise.
//
// Hard-edged cells are still right for the things that genuinely have edges (a
// re-covered section, a membrane seam), which is why hash21 stays.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Smoothstep weights, so there is no directional bias along the cell edges.
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
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
 * The window rectangle sampled at an ARBITRARY point in grid space, every edge
 * widened by the pixel footprint the way the main window mask is.
 *
 * The reveal needs the same aperture three times at three different offsets --
 * where the glass is, where the wall face is, and where the sun reaches
 * through it -- so it stops being something to write out inline.
 *
 * g is the continuous grid coordinate, not a cell coordinate: fract() is
 * taken here so a caller may push the sample past the edge of its own cell and
 * land on the neighbouring window, which is where a real facade's next opening
 * actually is.
 */
float winRect(vec2 g, vec4 win, vec2 w) {
  vec2 c = fract(g);
  return smoothstep(win.x - w.x, win.x + w.x, c.x) * smoothstep(win.y + w.x, win.y - w.x, c.x)
       * smoothstep(win.z - w.y, win.z + w.y, c.y) * smoothstep(win.w + w.y, win.w - w.y, c.y);
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
  float bidx  = vBidx;
  float bldH  = vInfo.y;
  float isRoof = vInfo.z;
  float part  = vInfo.w;

  Facade fp = readFacade(bidx);

  vec3 n = normalize(vNormal);
  vec3 albedo = fp.colour;

  // Roughness is a local, not fp.roughness read straight through, because the
  // shingle branch has to override it: a facade family's roughness describes
  // its WALL, and a house's wall and its roof covering are not the same stuff.
  float roughness = fp.roughness;

  // A lit window EMITS. It was being added into the albedo, which then went
  // through the sun and ambient terms like everything else -- so a lit window
  // got dimmer at night, which is the one time it is supposed to be the
  // brightest thing on the building.
  vec3 emissive = vec3(0.0);

  // How much of this fragment behaves as glass rather than as wall. Drives the
  // Fresnel reflection and the sun glint, and nothing else.
  float glassMask = 0.0;

  // The room behind a ground-storey window, as an effective albedo. It is a
  // quantity of its own rather than part of albedo because it takes the AMBIENT
  // light and not the beam: see the ground-storey branch, which is the only
  // thing that sets it.
  vec3 seeIn = vec3(0.0);

  // How much of the sky dome this fragment can see, beyond its own orientation.
  // 1.0 on a roof; less and less as you go down into a street canyon.
  float skyOcc = 1.0;

  // How much DIRECT sun reaches this fragment from inside its own window
  // reveal. 1.0 everywhere except in the shadow the head and one jamb cast on
  // the glazing set back behind them; see the reveal block below. It is a
  // separate quantity from albedo because being in shadow takes the beam away
  // and leaves the sky, and darkening the albedo instead would take both.
  float revealShade = 1.0;

  // And how much of the SKY it can see from in there. A reveal is not a sun
  // effect: a recessed pane sees less of the dome than the wall around it,
  // most of all in the band directly under the head, which is why a window on
  // the shadowed side of a street still reads as a hole and not as a decal.
  // Applied to the ambient AND to the glass reflection -- on a curtain wall the
  // reflection is nearly all of the pixel, so occluding the ambient alone moves
  // nothing at all.
  float revealOcc = 1.0;

  /** 1 on a wall fragment, 0 on a roof or a parapet. See uBuildingDebug. */
  float facadeMarker = 0.0;

  // PART_GABLE shares the facade branch, so the chain cannot be a plain
  // ascending ladder any more: the shingle test has to come first (it is the
  // highest tag but the clutter branch is the trailing else), and the gable
  // has to be pulled back out of it.
  bool gableEnd = part > 4.5;

  if (part > 3.5 && !gableEnd) {
    // --- Shingle --------------------------------------------------------
    // Asphalt shingle or tile, and it is DARK: a real roof covering is
    // 0.05-0.14 linear, which is well under any wall it sits on.
    float pick = hash11(fp.seed * 23.0 + 1.0);
    vec3 cover = pick < 0.45 ? vec3(0.045, 0.046, 0.049)      // charcoal asphalt
               : pick < 0.80 ? vec3(0.078, 0.070, 0.060)      // weathered grey-brown
                             : vec3(0.105, 0.060, 0.044);     // faded clay tile
    // Granules, on the smooth noise for the same reason the flat roof uses it:
    // from the air this is the largest surface in the frame, and a lattice of
    // flat random squares seen from above reads as pixelation.
    float grain = vnoise(vWorld.xz * 5.5 + fp.seed * 31.0);
    albedo = cover * (0.88 + 0.24 * grain);

    // THE COURSES. This is the thing that says shingle rather than grey slab:
    // a 0.30 m band up the slope with its lower edge in its own shadow, and a
    // weaker tab break across it every 0.90 m.
    //
    // Filtered and faded exactly the way the wall's mortar course is: a 0.3 m
    // stripe is under a pixel from any height worth flying, and point-sampling
    // it would moire against the pixel grid rather than converge.
    float cy = vUv.y / 0.30;
    float wy = max(fwidth(cy), 1e-4);
    float courseFade = 1.0 - clamp(wy * 1.6, 0.0, 1.0);
    float course = 1.0 - smoothstep(0.0, max(0.18, wy), fract(cy));
    float cx = vUv.x / 0.90;
    float wx = max(fwidth(cx), 1e-4);
    float tabFade = 1.0 - clamp(wx * 1.6, 0.0, 1.0);
    float tab = 1.0 - smoothstep(0.0, max(0.10, wx), fract(cx));
    albedo *= 1.0 - 0.18 * course * courseFade - 0.08 * tab * tabFade;

    roughness = 0.92;    // shingle is matte, whatever the wall under it is
    skyOcc = 1.0;        // a pitched roof sees the whole dome
    glassMask = 0.0;
    // n is left alone: the tent carries a real per-face normal already.
  } else if (part < 0.5 || gableEnd) {
    // --- Facade ---------------------------------------------------------
    facadeMarker = 1.0;
    // Storey and column pitch are per BUILDING, out of the parameter texture.
    // A curtain wall's mullions are 1.6 m apart and a brick terrace's windows
    // are 3.3 m apart; sharing one grid between them is most of why a street
    // of these used to read as wallpaper.
    //
    // The upper grid starts at the HEAD of the ground storey, not at the
    // pavement. A ground floor is half again as tall as the flat above it (see
    // groundStoreyM in facade.ts), so a grid measured from the ground puts
    // every storey line on a building a metre out from where the floor slab
    // actually is, and the error accumulates all the way up.
    float groundH = min(fp.groundStoreyM, max(1.2, bldH * 0.92));
    vec2 grid = vec2(vUv.x / fp.columnM, (vUv.y - groundH) / fp.storeyM);
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
    // Filtered PER AXIS, not by the worse of the two.
    //
    // This was one number off max(w.x, w.y), and that is what made a wall seen
    // from a car a sheet of flat colour: from the pavement the along-the-wall
    // footprint is enormous (a pixel spans several window columns) while the
    // vertical one is a few centimetres, so taking the worse of them threw away
    // the storey lines, the cornice and the whole ground floor along with the
    // column rhythm that genuinely could not be resolved. A separable filter
    // dissolves each axis when THAT axis runs out of pixels, so a grazing wall
    // keeps its horizontals and loses its verticals, which is what a photograph
    // taken along a street shows.
    //
    // detail itself is unchanged -- min of the two IS 1 - max(w) - so
    // everything that still reads it behaves exactly as before.
    float detailX = 1.0 - clamp(w.x * 1.6, 0.0, 1.0);
    float detailY = 1.0 - clamp(w.y * 1.6, 0.0, 1.0);
    float detail = min(detailX, detailY);
    float winMeanX = fp.win.y - fp.win.x;
    float winMeanY = fp.win.w - fp.win.z;
    float winMean = winMeanX * winMeanY;

    // Window rectangle inside the cell, every edge softened by the pixel
    // footprint so it antialiases instead of stair-stepping.
    // The wall carries on past the roof slab to make the parapet, so the grid
    // has to STOP at the roof line -- otherwise the coping gets a row of
    // windows in it and the parapet reads as one more storey.
    float capped = step(vUv.y, bldH);

    // --- THE REVEAL: the glass is BEHIND the wall, not in it ---------------
    //
    // Until this block the glazing sat exactly in the wall plane, and that is
    // geometric, not textural: a flat sheet with a pattern on it is what a
    // Chicago or Manhattan tower was, which is why it read as painted concrete
    // however the pattern was tuned. Real glazing is set back 100-250 mm and
    // two things fall out of the setback, both of them needed:
    //
    //   * PARALLAX. Seen off normal, the glass slides within its opening. The
    //     wall overhangs it on the near side and the jamb is exposed on the
    //     far side, so the opening stops being a decal and starts being a
    //     hole. One offset along the view vector in the wall's tangent frame.
    //     No march: the second sample would buy a silhouette nobody can see at
    //     this scale and cost a loop on every building pixel in the frame.
    //
    //   * SELF-SHADOW. The aperture casts onto the recessed plane, giving a
    //     hard line under every head and down exactly ONE jamb, and the jamb
    //     it picks swaps as the sun crosses the facade. At a grazing angle
    //     this is most of what tells the eye the wall has thickness, and it is
    //     the part that shows in a still.
    //
    // Depths are measured, not tuned, and they differ by building type because
    // the openings do: a curtain wall's glass sits just behind its mullion
    // line, while a punched opening in solid masonry is a whole brick deep.
    // fp.relief is already the per-family measure of how modelled a wall is
    // (0.10 on glass, 0.75-0.80 on brick and stone), so it picks the depth and
    // no second table can drift away from the first.
    const float REVEAL_CURTAIN_M = 0.10;  // curtain wall: glass behind the mullion
    const float REVEAL_PUNCHED_M = 0.25;  // punched opening in solid masonry
    // How much of the beam the shaded part of a reveal loses. Not 1.0: the
    // jamb opposite is a bright diffuse bounce a few centimetres away, and a
    // reveal that goes black reads as a hole punched through the building.
    const float REVEAL_SHADOW = 0.80;
    // The band under the head, which loses most of the dome even at noon under
    // cloud. This is the term that survives into the shade.
    const float REVEAL_HEAD_SKY = 0.60;
    // The exposed jamb face itself: turned ninety degrees off the wall, so it
    // sees about half the sky the wall does and takes a matching albedo knock.
    const float REVEAL_SIDE_SKY = 0.45;
    const float REVEAL_SIDE_DARK = 0.22;

    // ?flatglass=1 puts the glass back in the wall plane, in this same
    // binary, so tools/verify-glass.ts can watch its own assertions go red.
    float recess = 1.0 - step(0.5, uFlatGlass);
    float revealM = mix(REVEAL_CURTAIN_M, REVEAL_PUNCHED_M, clamp(fp.relief, 0.0, 1.0)) * recess;

    // uv.x runs along +(-n.z, 0, n.x). buildWall() gives a wall quad the
    // outward normal (dz, 0, -dx)/len and runs u along (dx, 0, dz)/len, so the
    // along-wall axis is the normal turned the OTHER way from the tang the
    // relief block below uses. Getting this backwards does not look subtly
    // wrong, it makes the glass appear to stand proud of the wall.
    vec3 uDir = vec3(-n.z, 0.0, n.x);
    vec3 upDir = vec3(0.0, 1.0, 0.0);
    vec3 eyeDir = normalize(uCameraPos - vWorld);
    // Clamped at 0.35, which is 70 degrees off normal. The exact offset is
    // depth * tan(angle) and diverges at grazing incidence; past 70 degrees a
    // real opening is occluded by its own jamb anyway, so the honest limit is
    // a fixed slide rather than an offset that runs away.
    vec2 par = -(revealM / max(dot(eyeDir, n), 0.35))
             * vec2(dot(eyeDir, uDir) / fp.columnM, dot(eyeDir, upDir) / fp.storeyM);
    // The aperture's own shadow on the recessed plane: the same construction
    // with the sun in place of the eye. A point set back by revealM is lit
    // only if the ray from it to the sun clears the opening, which is the
    // aperture tested at this offset.
    float sn = dot(uSunDir, n);
    vec2 shd = (revealM / max(sn, 0.35))
             * vec2(dot(uSunDir, uDir) / fp.columnM, dot(uSunDir, upDir) / fp.storeyM);
    // A wall the sun is behind is wholly in shade and has no reveal shadow to
    // draw inside it.
    float sunFacing = step(0.02, sn);
    // Half a window of slide is as far as this can mean anything: past that
    // fract() would wrap the sample onto the NEXT opening along, which is a
    // periodicity artifact and not a deeper reveal.
    vec2 slide = 0.5 * vec2(winMeanX, winMeanY);
    par = clamp(par, -slide, slide);
    shd = clamp(shd, -slide, slide);

    // LOD. A window is a few pixels across from any distance worth flying and
    // an offset that survives to sub-pixel scale is aliasing, so both offsets
    // fade on the pixel footprint -- per axis, the way every other mask in
    // this branch does, so a wall seen along its length keeps its heads while
    // losing its jambs. What the fade costs in contrast is put back as the
    // reveal's own MEAN further down rather than deleted, or the far city
    // would sit at a different brightness from the near one.
    vec2 parPx = par * vec2(detailX, detailY);
    vec2 shdPx = shd * vec2(detailX, detailY);

    // The recessed glazing. This is the only change to the mask itself: the
    // same rectangle, sampled where the glass actually is.
    vec2 pcell = fract(grid + parPx);
    float winX = smoothstep(fp.win.x - w.x, fp.win.x + w.x, pcell.x)
               * smoothstep(fp.win.y + w.x, fp.win.y - w.x, pcell.x);
    float winY = smoothstep(fp.win.z - w.y, fp.win.z + w.y, pcell.y)
               * smoothstep(fp.win.w + w.y, fp.win.w - w.y, pcell.y);
    // Each axis converges to its own mean as it runs out of pixels, so a wall
    // seen along its length keeps a row of ribbon windows instead of going
    // blank. Far away both terms converge and this equals the old winMean.
    float win = mix(winMeanX, winX, detailX) * mix(winMeanY, winY, detailY) * capped;

    // IRREGULAR OPENINGS.
    //
    // A house elevation is two to four windows with blank wall between them.
    // Half of what makes the uniform grid read as an office block is not the
    // size of the openings, it is that EVERY cell has one: a lattice is a
    // curtain wall's structure, not a house's. So on a house each cell keeps
    // its window only if a hash of (column, floor) passes, and 45% do not.
    //
    // It has to filter the way the rectangle above does. The keep is a hard
    // step, and a hard step under a pixel is exactly the sparkle the analytic
    // filtering exists to prevent, so it mixes to its own mean -- which is the
    // keep fraction itself, and comes from facade.ts so the CPU and the shader
    // cannot hold two different ones.
    float openMean = 1.0;
    float openPick = 1.0;
    if (fp.house > 0.5) {
      openMean = ${HOUSE_OPEN_FRAC};
      openPick = step(hash21(vec2(colIdx * 1.37 + fp.seed * 53.0,
                                  floorIdx * 0.79 + 11.0)), openMean);
    }
    win *= mix(openMean, openPick, detail);

    win *= step(groundH, vUv.y);   // the ground storey draws its own thing

    glassMask = win * fp.glassFrac;

    vec3 glass = mix(vec3(0.075, 0.095, 0.125), vec3(0.15, 0.19, 0.24), hash11(fp.seed + 3.3));
    albedo = mix(albedo, glass, glassMask);

    // --- What the reveal does to the light ---------------------------------
    //
    // Three samples of one rectangle, no loop:
    //   apertureDeep  the glazing, already computed above as winX * winY
    //   apertureFlat  the same opening in the plane of the WALL
    //   sunReach      the opening as the sun sees it through the setback
    //
    // Where the wall-plane opening is inside and the recessed one is not, this
    // fragment is looking at the SIDE of the hole -- a jamb, a head or a sill.
    // A flat facade has no pixels for that surface at all, which is the whole
    // defect: there is nothing there to shade.
    float apertureDeep = winX * winY;
    float apertureFlat = winRect(grid, fp.win, w);
    float jamb = clamp(apertureFlat - apertureDeep, 0.0, 1.0) * capped * step(groundH, vUv.y);
    float sunReach = winRect(grid + parPx + shdPx, fp.win, w);
    // Everything inside the opening the sun cannot see into.
    float aperture = clamp(apertureDeep + jamb, 0.0, 1.0);
    float inShade = (1.0 - sunReach) * aperture
                  * sunFacing * capped * step(groundH, vUv.y);
    // The same construction with the ZENITH in place of the sun: the band the
    // head keeps the sky out of. This one has no sunFacing gate, because it is
    // there on the north elevation at midnight as much as at noon.
    float skyShd = revealM / fp.storeyM;
    float skyReach = winRect(grid + parPx + vec2(0.0, skyShd * detailY), fp.win, w);
    float headBlock = (1.0 - skyReach) * aperture * capped * step(groundH, vUv.y);

    // AND WHAT IT AVERAGES TO, for when the reveal is under a pixel.
    //
    // Fading the shadow to nothing would leave a distant facade brighter than
    // the near one that has it, so the far field gets the mean instead of the
    // deletion: the fraction of the opening the head and jamb take away is the
    // shadow offset over the opening's own size, which is arithmetic on
    // numbers already in registers. par/shd here are the UNFADED offsets,
    // so this term survives exactly where the per-pixel one dies.
    float apMean = winMeanX * winMeanY;
    float shadeFrac = min(1.0, abs(shd.x) / max(winMeanX, 0.02) + abs(shd.y) / max(winMeanY, 0.02));
    float jambFrac = min(1.0, abs(par.x) / max(winMeanX, 0.02) + abs(par.y) / max(winMeanY, 0.02));
    float inShadeMean = apMean * shadeFrac * sunFacing * capped * step(groundH, vUv.y);
    float jambMean = apMean * jambFrac * capped * step(groundH, vUv.y);
    float headMean = apMean * min(1.0, skyShd / max(winMeanY, 0.02))
                   * capped * step(groundH, vUv.y);

    // The beam, not the albedo: a shaded reveal loses the sun and keeps the
    // sky, and taking it out of albedo would take both and turn the reveal
    // into a smudge that stayed dark at dusk.
    revealShade = 1.0 - REVEAL_SHADOW * mix(inShadeMean, inShade, detail);
    // The exposed jamb is a face turned off the wall: less sky, and a knock on
    // the albedo for the ambient occlusion of a 200 mm slot.
    float jambLod = mix(jambMean, jamb, detail);
    // Kept as a value rather than applied to skyOcc here: the canyon term below
    // assigns skyOcc outright, so a multiply at this point would be discarded.
    revealOcc = 1.0 - REVEAL_HEAD_SKY * mix(headMean, headBlock, detail)
                    - REVEAL_SIDE_SKY * jambLod;
    albedo *= 1.0 - REVEAL_SIDE_DARK * jambLod;

    // --- The ground storey ------------------------------------------------
    //
    // This used to be a win *= 0.35 inside the first storey, which is a
    // dimming hack: it leaves the same 1.8 m punched hole floating two metres
    // above the pavement, only darker, and from a car that is the single most
    // obviously wrong thing on a street. A ground floor is not a dimmer version
    // of the floor above it. It is a plinth, a tall sheet of glass in a bay two
    // or three metres wide, a fascia over the top of it carrying the signage,
    // and a door every few bays. The shopfront parameter says how much of that a
    // given building gets: a retail unit gets all of it and a terraced house gets
    // a plinth, a door and a window.
    float ground = 1.0 - step(groundH, vUv.y);
    if (ground > 0.5) {
      float plinthM = mix(0.75, 0.34, fp.shopfront) * (0.7 + 0.6 * hash11(fp.seed * 17.0 + 1.0));
      float fasciaM = mix(0.35, 0.85, fp.shopfront);
      float headY = max(plinthM + 0.6, groundH - fasciaM);

      // Shop bays are wider than the window columns above them, and they do not
      // line up with them either: the structure above is on a column grid and
      // the tenancies below are on a lease plan.
      float bayM = mix(fp.columnM, 2.4 + 2.2 * hash11(fp.seed * 5.0 + 9.0), fp.shopfront);
      float bay = (vUv.x + 0.37 * bayM) / bayM;
      float bayIdx = floor(bay);
      float bx = fract(bay);
      float bw = max(fwidth(bay), 1e-4);

      // The pier between two bays, in metres, so it stays a pier rather than a
      // fraction that widens with the bay.
      //
      // On a house the pier takes whatever the bay has left over once the
      // opening is the same width as the windows on the storeys above. A house
      // ground floor is a window and a front door in a wall; a bay of glass
      // between slim piers is a shopfront, and drawing one on every bay of a
      // two-storey house is how a suburb comes out looking like a parade.
      float pierM = mix(0.55, 0.20, fp.shopfront);
      if (fp.house > 0.5) {
        pierM = max(pierM, 0.5 * (bayM - (fp.win.y - fp.win.x) * fp.columnM));
      }
      float pier = pierM / bayM;
      float gx = smoothstep(pier - bw, pier + bw, bx)
               * smoothstep(1.0 - pier + bw, 1.0 - pier - bw, bx);

      float aaY = max(fwidth(vUv.y), 1e-4);
      float gyTop = smoothstep(headY + aaY, headY - aaY, vUv.y);
      float gyWin = smoothstep(plinthM - aaY, plinthM + aaY, vUv.y) * gyTop;

      // A door every few bays, glazed to the pavement rather than to a cill.
      float doorEvery = 3.0 + floor(hash11(fp.seed * 9.0 + 4.0) * 4.0);
      float isDoor = step(abs(mod(bayIdx, doorEvery) - 1.0), 0.5);
      float gyDoor = smoothstep(0.04 - aaY, 0.04 + aaY, vUv.y) * gyTop;
      float shop = 0.0;

      // Same analytic filtering as the upper grid: at two kilometres a
      // shopfront is far under a pixel and point-sampling it sparkles.
      float shopY = mix(gyWin, gyDoor, isDoor);
      shop = mix(clamp(1.0 - 2.0 * pier, 0.0, 1.0), gx, detailX) * shopY;

      // THE GARAGE DOOR.
      //
      // In a US suburb this is the strongest single "this is a house" cue at
      // street level, and it is the one the ground band had no way to draw: a
      // flush ribbed panel a little over two metres tall sitting straight on
      // the driveway, with no plinth under it and no glass in it.
      float garage = 0.0;
      if (fp.house > 0.5) {
        // Width in METRES rather than as a fraction of the bay: a single door
        // is 2.5 m and a double is 5.0 m whatever bay it happens to land in,
        // and a door that scaled with the bay would stop reading as a door.
        float garW = 2.5 + 2.5 * hash11(fp.seed * 6.1 + 2.0);
        float garH = 2.05 + 0.30 * hash11(fp.seed * 8.3 + 7.0);
        // Roughly one per house: a 10 x 8 m house has a perimeter of about
        // eight bays at this bay width, so a period of six to nine puts one
        // door on it and only sometimes a second.
        float garEvery = 6.0 + floor(hash11(fp.seed * 12.7 + 5.0) * 4.0);
        float garSlot = floor(hash11(fp.seed * 15.3 + 8.0) * garEvery);
        float inBay = step(abs(mod(bayIdx, garEvery) - garSlot), 0.5);
        float aaX = max(fwidth(vUv.x), 1e-4);
        float doorX = smoothstep(garW * 0.5 + aaX, garW * 0.5 - aaX,
                                 abs(bx - 0.5) * bayM);
        float doorY = smoothstep(garH + aaY, garH - aaY, vUv.y);
        // Converges to the door's share of the whole band, so a bay under a
        // pixel dissolves into the wall instead of flickering in and out.
        float garMean = clamp(garW / bayM, 0.0, 1.0) / garEvery;
        garage = mix(garMean, inBay * doorX, detailX) * doorY;
      }
      shop *= 1.0 - garage;   // no glazing in a garage door

      // The same keep as the storeys above, for the same reason: an opening in
      // every bay is a lattice, and a house does not have one at street level
      // either. Filtered to the keep fraction so the band converges instead of
      // flickering bay by bay as it goes under a pixel.
      if (fp.house > 0.5) {
        float bayKeep = step(hash21(vec2(bayIdx * 1.91 + fp.seed * 29.0, 3.0)),
                             ${HOUSE_OPEN_FRAC});
        shop *= mix(${HOUSE_OPEN_FRAC}, max(bayKeep, isDoor), detailX);
      }

      // Shop glass is darker than the sky-reflecting curtain wall above: you
      // are looking into a room, not at a mirror, and the room is unlit by day.
      vec3 shopGlass = mix(vec3(0.055, 0.058, 0.062), vec3(0.10, 0.11, 0.13),
                           hash11(fp.seed * 3.7 + 21.0));
      // The plinth: a dark stone or tiled base that takes the kicks. Real, and
      // it is also what stops the glass from meeting the pavement in a line.
      vec3 plinthCol = fp.colour * mix(0.55, 0.40, hash11(fp.seed * 11.0 + 6.0));
      // The fascia over the shop: painted board, a different colour per unit,
      // which is most of what makes a parade of shops read as separate shops.
      vec3 fasciaCol = mix(fp.colour * 0.8,
                           vec3(hash11(bayIdx * 3.1 + fp.seed * 41.0),
                                hash11(bayIdx * 7.7 + fp.seed * 13.0),
                                hash11(bayIdx * 5.3 + fp.seed * 29.0)) * 0.22 + 0.05,
                           fp.shopfront * 0.8 * detailX);

      // The plinth stops at the garage: a door sits on the driveway, and a
      // kerb across the bottom of it would read as a step into a wall.
      albedo = mix(albedo, plinthCol,
                   (1.0 - smoothstep(plinthM - aaY, plinthM + aaY, vUv.y))
                   * (1.0 - isDoor * gx) * (1.0 - garage));
      albedo = mix(albedo, fasciaCol, smoothstep(headY - aaY, headY + aaY, vUv.y));
      albedo = mix(albedo, shopGlass, shop);

      // Painted trim, close to the wall but not the wall: a door the exact
      // colour of the siding reads as a hole in it rather than as a door.
      // Horizontal ribs every 0.25 m, faded with the pixel footprint like
      // every other line on this facade.
      vec3 garageCol = mix(fp.colour, vec3(0.72, 0.71, 0.69), 0.35)
                     * mix(0.86, 1.06, hash11(fp.seed * 19.0 + 3.0));
      float ribP = vUv.y / 0.25;
      float ribW = max(fwidth(ribP), 1e-4);
      float rib = 1.0 - smoothstep(0.0, max(0.12, ribW), fract(ribP));
      albedo = mix(albedo, garageCol * (1.0 - 0.22 * rib * (1.0 - clamp(ribW * 1.6, 0.0, 1.0))), garage);

      glassMask = shop * mix(0.30, 0.92, fp.shopfront);

      // A shopfront is set back behind its piers, so the reveal is deep and the
      // line of shadow under the fascia is the strongest thing on the band.
      albedo *= 1.0 - 0.30 * shop * smoothstep(headY, headY - 0.35, vUv.y) * detailY;

      // A cornice line at the head of the ground storey: the one horizontal
      // that says where the shopfront stops and the building starts.
      albedo *= 1.0 - 0.35 * fp.relief * detailY
                    * smoothstep(0.0, 0.12, groundH - vUv.y) * smoothstep(0.40, 0.12, groundH - vUv.y);

      // WHAT IS BEHIND THE GLASS.
      //
      // shopGlass is a 0.055-0.13 albedo and, seen straight on, Schlick puts
      // only 4% of the sky probe on top of it, so until now there was nothing
      // behind a shop window at all. Van Ness came out as near-black rectangles
      // between pale piers, which reads as a row of loading bays rather than as
      // a shopping street. A real shopfront IS dark seen straight on, but it is
      // dark because you are looking INTO a room that has a floor, a ceiling
      // and stock in it.
      //
      // So the bay gets an effective albedo of its own, and it is added to the
      // AMBIENT term only, never to the beam. That is both the physics and what
      // keeps it in its place: the daylight in a shop arrived through this same
      // window and leaves through it again after a couple of bounces, so it
      // tracks the sky and the lit wall opposite, and it cannot rival a wall
      // the sun is directly on.
      //
      // Brighter at the head than at the cill because a shop is lit from its
      // ceiling. The gradient is most of the effect: a flat panel of any
      // brightness still reads as a panel rather than as depth.
      float headroom = max(headY - plinthM, 0.5);
      float up = clamp((vUv.y - plinthM) / headroom, 0.0, 1.0);
      // 0.12 at the cill to 0.42 at the head, warm because a shop is tungsten
      // and timber and cardboard and the sky feeding it is not.
      //
      // Measured on the sf-street pose, against a sunlit pier at 138/255: the
      // bay head reads 23 with no interior at all (a black rectangle), 66 at
      // these constants, and 83 at 0.20/0.70. 83 is too much. The pier is
      // taking the full beam there and the bay is not, so the same numbers on a
      // SHADED elevation put the bay level with the wall beside it, which is a
      // light box rather than a shop.
      //
      // Filtered for free: it is a product of the shop mask, which already
      // converges to its own bay-mean through detailX, and a smooth ramp in
      // vUv.y that has no detail to lose. No step in it, so no sparkle.
      //
      // Faded out with uNight so it does not double-count the shop's own
      // lighting, which arrives below as an emissive term after dark.
      seeIn = vec3(1.00, 0.90, 0.76) * mix(0.12, 0.42, up * up)
            * glassMask * (1.0 - uNight);
    }

    // Horizontal banding between storeys: a thin darker line reads as a floor
    // slab and gives the facade its scale at distance.
    albedo *= 1.0 - 0.18 * detailY * smoothstep(0.10 + w.y, 0.0, cell.y);

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

    // THE WALL BETWEEN THE WINDOWS.
    //
    // Everything above shapes the openings and leaves the masonry itself dead
    // flat: from a car the near wall was a single tan panel with a grid ruled
    // on it. A wall is not flat. Brick has a mortar course every 75 mm and a
    // perpend every 215; a concrete panel has a joint every few metres and a
    // shutter mark inside it; stucco has a float texture. None of it is more
    // than a few millimetres deep, which is exactly why it needs a NORMAL
    // rather than a darker pixel: at a grazing sun those millimetres are the
    // whole difference between masonry and cardboard.
    //
    // Frequency comes from the family so a curtain wall gets none of it.
    // fp.relief is already the per-family measure of how modelled a facade is:
    // near zero on glass, high on brick and stone.
    // A house is not laid in brick, it is clad in lap siding: one board edge
    // every 0.16 m (a 150 mm board with a 25 mm lap) running horizontally with
    // nothing crossing it, so the perpends go too. Brick and Stucco are the
    // families a house lands in; on Concrete or Stone the joint pattern is
    // already right for a rendered or panelled house.
    float lap = fp.house * step(0.5, fp.family) * step(fp.family, 2.5);
    float courseHz = mix(mix(2.0, 13.3, fp.relief), 6.25, lap);  // 13.3/m is a 75 mm course
    float coursePhase = vUv.y * courseHz;
    float course = abs(fract(coursePhase) - 0.5) * 2.0;
    // Perpends every 215 mm, offset half a brick on alternate courses, which is
    // the bond pattern and the reason brick does not read as stripes.
    float row = floor(coursePhase);
    float perpHz = courseHz * 0.35;
    float perp = abs(fract(vUv.x * perpHz + 0.5 * mod(row, 2.0)) - 0.5) * 2.0;

    // Converge with the pixel footprint, like every other detail here: a
    // mortar course is under a pixel from any distance worth flying and must
    // fade to flat rather than alias into a moire.
    float mortarFade = detailY * detailX * fp.relief;
    float mortar = (1.0 - smoothstep(0.55, 0.95, course))
                 + (1.0 - smoothstep(0.70, 0.97, perp)) * 0.6 * (1.0 - lap);
    mortar *= mortarFade;

    // 3 mm of recess, expressed as a slope along the wall's own tangent frame.
    n = normalize(n + (vec3(0.0, 1.0, 0.0) * (fract(coursePhase) - 0.5)
                       * mortarFade * 0.22));
    // A lap edge stands 20 mm proud and casts a real line where a mortar joint
    // is 10 mm deep and mostly a colour change. The house's relief is 0.3
    // against brick's 0.75 and mortarFade is scaled by it, so the coefficient
    // has to make some of that back or the siding comes out flat.
    albedo *= 1.0 - mix(0.10, 0.30, lap) * mortar;

    // A cornice: the last metre below the parapet is a projecting band, so it
    // is brighter on top and casts a line of shadow under itself. On a stone
    // or brick building this is a real moulding; on a curtain wall the relief
    // parameter is near zero and it barely shows, which is also correct.
    float belowTop = bldH - vUv.y;
    albedo *= 1.0 - 0.45 * fp.relief * detailY
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
    skyOcc *= revealOcc;

    // --- Lit windows at night -------------------------------------------
    if (uNight > 0.02) {
      // Upper floors empty first: the top of a tower is the executive floor
      // and the plant room, and neither is occupied at two in the morning.
      float heightFade = mix(1.0, 0.55, smoothstep(0.0, 120.0, vUv.y));

      // BLINDS.
      //
      // A lit window in a night photograph is usually not a full lit rectangle:
      // roughly half of them are partly blocked, and what you see is a band
      // from the cill up to wherever the blind stops. It matters more than its
      // size suggests, because a wall of identical full rectangles is the
      // remaining thing that reads as a texture map rather than as glass.
      //
      // One hash carries both decisions: below BLIND_FRAC there is a blind, and
      // its position within that range says how far down it hangs. So the drop
      // is uniform on (0, BLIND_MAX] exactly when there is one, which is what
      // makes BLIND_KEEP the right compensation.
      float bHash = hash21(vec2(colIdx * 0.71 + fp.seed * 17.0, floorIdx * 1.13 + 5.0));
      float drop = step(bHash, ${BLIND_FRAC}) * ${BLIND_MAX} * (bHash / ${BLIND_FRAC});
      float blindY = mix(fp.win.w, fp.win.z, drop);
      // Filtered on the same footprint as every other edge on this facade.
      float litY = smoothstep(fp.win.z - w.y, fp.win.z + w.y, cell.y)
                 * smoothstep(blindY + w.y, blindY - w.y, cell.y);

      // LIGHT SPILL.
      //
      // The emissive stopped dead at the window edge, which is most of what
      // made the windows read as decals stuck on a wall. Real light leaves the
      // pane and lands on its own reveal and on the spandrel around it. Sized
      // in METRES and converted to cell fractions, because the throw is a
      // property of the lamp and not of the window grid: a 1.6 m curtain-wall
      // module and a 3.6 m stone bay spill the same 350 mm.
      float sx = ${SPILL_M} / fp.columnM;
      float sy = ${SPILL_M} / fp.storeyM;
      float spillX = smoothstep(fp.win.x - sx - w.x, fp.win.x + w.x, cell.x)
                   * smoothstep(fp.win.y + sx + w.x, fp.win.y - w.x, cell.x);
      float spillY = smoothstep(fp.win.z - sy - w.y, fp.win.z + w.y, cell.y)
                   * smoothstep(fp.win.w + sy + w.y, fp.win.w - w.y, cell.y);
      // A shuttered window throws less: the halo tracks what the blind leaves.
      float halo = max(0.0, spillX * spillY - winX * winY) * (1.0 - drop);

      // THE MEAN IS THE THING THAT MAY NOT MOVE.
      //
      // Blinds take light off the wall and spill puts light back beside it, and
      // both are near-field detail that has to dissolve into the SAME far-field
      // number as before or a building changes brightness as you approach it.
      // So the profile is divided by its own mean: a smoothstep ramp integrates
      // to half its width, so a spill of sx either side of the rectangle adds
      // sx to the mean of that axis (clamped, since it cannot leave the cell),
      // and the blind multiplies the whole thing by BLIND_KEEP. Measured over
      // 2812 buildings across the seven packs the normaliser runs 1.09x to
      // 1.21x (mean 1.13), so the blinds take rather more off than the spill
      // puts back and the pane itself ends up brighter to compensate.
      float spillMeanX = min(1.0, winMeanX + sx);
      float spillMeanY = min(1.0, winMeanY + sy);
      float profileMean = ${BLIND_KEEP}
                        * (winMean + ${SPILL_LEVEL} * max(0.0, spillMeanX * spillMeanY - winMean));
      float profile = (winX * litY + ${SPILL_LEVEL} * halo) * (winMean / max(profileMean, 1e-4));

      // Correlated occupancy: cores, then floors, then tenancies, then the
      // individual window. See facade.ts -- an independent coin per cell is
      // exactly what produced a checkerboard.
      float litPattern = facadeLit(fp, colIdx, floorIdx, heightFade) * profile * openPick * capped;
      float occ = facadeMeanOccupancy(fp, heightFade);
      // Same treatment as the window pattern: resolve individual lit windows
      // up close, converge to the average glow of a lit building far away. The
      // far-field term is untouched by the blinds and the spill, which is the
      // whole point of the normaliser above.
      float lit = mix(occ * winMean * openMean, litPattern, detail);

      // WHAT IS LIT TOGETHER IS LIT THE SAME.
      //
      // Colour and brightness are per TENANCY, not per window. One flat's three
      // windows are lit by the same lamps and one office floor's fluorescents
      // are the same tube across the whole let, so a coin per cell is the same
      // uncorrelated noise this file's occupancy model exists to replace -- it
      // was the last thing on a night facade still flipping cell by cell.
      //
      // Both converge on the CELL's own pixel footprint, and not on the
      // tenancy's own larger one. Converging on the tenancy was tried first and
      // it is wrong twice over: a block of four by two cells is still several
      // pixels across at a kilometre, so what survived out there was not a
      // patch of lit windows but a rectangle of the wall's own mean glow at a
      // different brightness and hue from the rectangle beside it, and the
      // mid-field towers came out as tan and grey mosaics. A tenancy's colour
      // and its brightness are carried BY its lit windows, so they have to
      // dissolve when those do.
      float tb = floor(colIdx / fp.tenantW);
      float th = floor(floorIdx / fp.tenantH);

      // A third of the windows cool. Offices are fluorescent and LED, homes
      // are warm, and a city that is entirely sodium-orange at night is a city
      // from before about 1995. Homes lean warm and offices lean cool, which
      // is why the mix is keyed on the occupancy group and not on a coin.
      float coolBias = fp.group < 0.5 ? 0.80 : 0.42;
      vec3 warmC = vec3(1.0, 0.74, 0.42);
      vec3 coolC = vec3(0.82, 0.88, 1.0);
      // step() fires on a fraction (1 - coolBias) of the tenancies, so that is
      // exactly the colour this converges to once the windows are under a pixel.
      vec3 warm = mix(mix(warmC, coolC, 1.0 - coolBias),
                      mix(warmC, coolC, step(coolBias, hash21(vec2(tb * 0.37 + fp.seed, th * 0.71)))),
                      detail);

      // AND THEY ARE NOT ALL THE SAME BRIGHTNESS.
      //
      // The lit flag is binary, so every lit window was emitting the identical
      // 0.09 and a facade came out as a punched card. Across a real night frame
      // the spread is several stops. Per tenancy again, log-distributed, and
      // normalised to a mean of exactly 1 (see LAMP_NORM) so the city's night
      // exposure is where it was. Converges to 1 as the windows dissolve, so
      // the far field is unchanged.
      float gain = mix(1.0,
                       exp(mix(log(${LAMP_LO}), log(${LAMP_HI}),
                               hash21(vec2(tb * 1.63 + fp.seed * 7.0, th * 0.29 + 3.0))))
                       * ${LAMP_NORM.toFixed(6)},
                       detail);

      // The number to watch is not the peak, it is the MEAN. Far away this
      // converges to occupancy x winMean x scale over the whole facade, and at
      // 0.2 that mean was about four times the wall's own night lighting: a
      // warm wash over every surface, which is what made the city read tan
      // however neutral the skyglow and the albedo were made. At 0.09 the mean
      // sits at roughly the wall, so a building is dark with lit windows in
      // it, and the peak is still 12x the wall up close where it should be.
      emissive += warm * gain * lit * uNight * 0.09;

      // Shopfronts. A lit shop window is far brighter than a flat above it and
      // it is at eye height, so it carries the night street the way the lit
      // office windows carry the night skyline. Roughly half of them are lit,
      // per building, because a parade at midnight is not all open.
      if (ground > 0.5) {
        float open_ = step(0.45, hash11(fp.seed * 23.0 + 3.0));
        emissive += vec3(1.0, 0.88, 0.70) * glassMask * uNight * open_ * 0.26;
      }
    }

    // Above the wall top, a PART_WALL fragment is the outer face of the
    // parapet. A gable end is above it too and is not: it is the same siding
    // carried up to the ridge.
    if (capped < 0.5 && !gableEnd) {
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
    vec2 sp = vWorld.xz + fp.seed * 97.0;
    // Three smooth octaves, from gravel grain up to the scale a roof soils
    // over. Continuous, so no lattice survives to be seen as pixels.
    float g = 0.55 * vnoise(sp * 1.9)
            + 0.30 * vnoise(rp * 0.55 + fp.seed * 7.0)
            + 0.15 * vnoise(sp * 0.19);
    // Real roofs are tar, black membrane and gravel: about 0.06-0.12 linear.
    // These were 0.26-0.42, two to three times too reflective, which made the
    // roof the BRIGHTEST surface in a top-down shot when in every aerial
    // photograph it is the darkest.
    albedo = mix(vec3(0.128, 0.128, 0.122), vec3(0.188, 0.183, 0.170), g);
    // Patchwork: membrane seams, ponding, a re-covered section. One more
    // octave, at a scale a roof actually varies over.
    // Re-covered sections DO have hard edges, so this layer keeps its lattice.
    // What changes is that it is sparse: a roof has a couple of patches, not a
    // different value in every cell. Everything else is the smooth grain above.
    float patchCell = hash21(floor(rp * 0.085) + fp.seed * 13.0);
    float repatch = step(0.72, patchCell) * (0.5 + 0.5 * hash21(floor(rp * 0.085) + 3.7));
    albedo *= 0.88 + 0.20 * g;
    albedo *= 1.0 - 0.14 * repatch;
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
    float g = vnoise(vWorld.xz * 0.6 + fp.seed * 41.0);
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
  // The window reveal shadows itself before the cascade ever gets to say so: a
  // 200 mm setback is far under one shadow-map texel, so nothing in the pass
  // above can draw the line under a window head.
  sunVis *= revealShade;
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

  // BOUNCE. The wall opposite is lit, and it is lit AT you.
  //
  // Once the exposure was corrected the shaded sides went blue-black, and that
  // is not what a shaded wall looks like on a sunny day: the building across
  // the street is in full sun, it is roughly mid-grey, and it throws a large
  // fraction of that straight back. In a canyon the bounce can rival the sky.
  //
  // The probe cannot supply this. Its lower hemisphere is a flat ground plane
  // and it contains no city, deliberately, because a probe that contained the
  // buildings would feed its own output back into itself.
  //
  // So it is analytic, and skyOcc is exactly the right weight INVERTED: that
  // term already measures how much of the sky dome a point up a wall has lost
  // to the building opposite. Whatever it lost to, it gained a lit wall from.
  // A rooftop (skyOcc 1) gets none; the foot of a canyon wall gets the most.
  //
  // Mean city albedo is about 0.2 and the bounce is one diffuse reflection off
  // a vertical surface, so the coefficient is deliberately modest. Tinted by
  // the sun through the same transmittance the direct beam uses, because the
  // light doing the bouncing is sunlight and at low sun it is orange.
  // The weight is what the AO pass MEASURED, not the height up the wall.
  //
  // skyOcc is analytic from vUv.y and saturates to 1 above about 48 m, so in a
  // canyon at 65 m it contributed nothing and the bounce term multiplied to
  // zero: exactly the frame that needed it most got none. A wall that high
  // between two 150 m towers still faces a great deal of lit wall.
  //
  // sampleSkyOcclusion is the real geometry, so whatever sky it says this point
  // has lost, it has gained a lit surface in the same direction. Both terms are
  // kept: the analytic one still carries the far side of the street, which no
  // screen-space search can see.
  SkyOcclusion bounceOccl = sampleSkyOcclusion(n);
  float bounceOcc = max(1.0 - bounceOccl.visibility, 1.0 - skyOcc);
  float horizonWeight = 1.0 - abs(n.y);
  vec3 bounce = uSunColor * uSunIntensity * uSunSurface * sunT
              * (0.35 * bounceOcc * horizonWeight * max(0.0, uSunDir.y));

  vec3 ambientTotal = ambient + bounce;

  // seeIn takes the ambient in full and only a tenth of the beam. A vertical
  // shop window does not put the sun on its own back wall: what the sun does is
  // reach a strip of floor just inside the cill and bounce a little of that back
  // out, which is why a sunlit parade still shows its interiors instead of
  // going flat black. At the full beam the bay would outrun the pier beside it
  // and the base of every sunlit elevation would read as a row of light boxes.
  vec3 lit = albedo * (beam + ambientTotal) + seeIn * (ambientTotal + beam * 0.10)
           + emissive;

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

    // WHAT IS UNDER THE HORIZON IS A CITY, NOT A FIELD.
    //
    // The probe has no geometry in it (see render/skyprobe.ts, which explains
    // why), so its lower hemisphere is one shaded ground plane at 0.16 albedo
    // with the sun full on it. For a tower in open country that is right. For
    // one in the Loop it is the single most wrong thing in the reflection: a
    // downward reflected ray there lands on the flank of the building opposite,
    // which is in its own shadow half the day and is dark building mass the
    // rest of it, and instead the facade returns bright sunlit prairie.
    //
    // The fix is not an invented darkening. render/urbanmask.ts already carries
    // a MEASURED built-ness field over the footprints in the pack, and it is
    // sampled at the building's own position, so a tower downtown reflects dark
    // mass below the horizon and one on the edge of the map still reflects
    // ground. Same texture and same lookup the terrain shader runs.
    vec2 urbanUv = vWorld.xz / (2.0 * uUrbanExtent) + 0.5;
    float built = texture(uUrban, urbanUv).r
                * step(0.0, urbanUv.x) * step(urbanUv.x, 1.0)
                * step(0.0, urbanUv.y) * step(urbanUv.y, 1.0);
    // Faded across the horizon over a few degrees rather than switched at it:
    // a hard edge here draws a hard line across every glass tower in the frame,
    // which is the defect the probe's own ground fade exists to avoid.
    float underHorizon = smoothstep(0.02, -0.10, refl.y);
    // 0.55 leaves 45% of the open-ground radiance at full built-ness. A dense
    // downtown block is not black -- it is masonry and glass at 0.2 albedo lit
    // by the same sky, next to open ground at 0.16 albedo lit by sky AND sun --
    // so roughly half is what the difference between those two actually is.
    float urbanDark = 1.0 - 0.55 * built * underHorizon * (1.0 - uFlatRefl);
    // The cube holds RADIANCE in the same linear HDR space this shader writes,
    // so it goes straight into the Fresnel mix with no scale factor. That is
    // the point of capturing it through the same atmosphere the sky dome runs:
    // the reflection and the sky behind the tower are the same numbers.
    //
    // Skyglow is added on top because the probe has no city in it, and after
    // dark a glass tower reflects the city rather than the sky.
    // revealOcc, because on a curtain wall this reflection IS the pixel: the
    // glass albedo is 0.08 and everything you see in a glass tower is the sky
    // coming back off it. A pane at the bottom of a 100 mm box reflects the
    // soffit above it, not the dome, and without this the reveal shows up
    // everywhere except on the buildings it was written for.
    vec3 skyRefl = (textureLod(uEnv, refl, clamp(roughness, 0.0, 1.0) * uEnvMaxLod).rgb * urbanDark
                 + uNightGlow * 0.4) * revealOcc;
    // Schlick, on the reflectance of the glazing this family is actually built
    // with -- fp.f0, out of the same table roughness and relief come from. A
    // curtain wall is a coated insulating unit at 0.22 and a punched masonry
    // window is a bare pane over a dark room at 0.05; see the note on f0 in
    // render/facade.ts for where those two numbers come from.
    //
    // This replaced a flat 0.04 for every wall in the city, which is the
    // reflectance of ONE air/glass interface and is the wrong material: it put
    // 7% of the sky on a curtain wall at 45 degrees, so a tower shaded almost
    // entirely as diffuse albedo and read as painted concrete. Measured over
    // the facade mask on chicago-loop-day, the old reflection moved mean facade
    // luminance by 1.3% against a non-directional one -- the radiance term was
    // never the problem, the reflectance was.
    float f0 = mix(fp.f0, 0.04, uFlatRefl);
    float f = pow(1.0 - clamp(dot(v, n), 0.0, 1.0), 5.0);
    float fres = f0 + (1.0 - f0) * f;
    lit = mix(lit, skyRefl, fres * glassMask * (1.0 - roughness * 0.6));
  }

  // Specular: a tight sun glint on glass, a broad one on wet stone.
  float gloss = max(glassMask, uWetness);
  if (gloss > 0.02) {
    float shine = mix(900.0, 40.0, roughness);
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
  if (uBuildingDebug > 0.5) {
    // The GEOMETRIC normal, not the relief-perturbed n the Fresnel term uses:
    // this is classifying FACES, and the per-pixel bump would scatter pixels
    // across the threshold inside one wall and blur the two populations into
    // each other. The face angle is what the classification is about.
    float faceCos = clamp(dot(v, normalize(vNormal)), 0.0, 1.0);
    float graze = uBuildingDebug > 1.5 ? step(faceCos, GRAZE_COS) : 1.0;
    fragColor = vec4(0.0, 0.0, facadeMarker * graze, 1.0);
  }
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
  /** 1 puts the glazing back in the wall plane; see `?flatglass=1` in main.ts. */
  uFlatGlass: THREE.IUniform<number>;
  /** 1 restores the bare-dielectric F0 and the open ground half; `?flatrefl=1`. */
  uFlatRefl: THREE.IUniform<number>;
  /** Built-ness coverage grid; see render/urbanmask.ts. */
  uUrban: THREE.IUniform<THREE.Texture | null>;
  uUrbanExtent: THREE.IUniform<number>;
  /** 1 draws the facade mask instead of the shaded building; `?buildingDebug=1`. */
  uBuildingDebug: THREE.IUniform<number>;
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
    uFlatGlass: { value: 0 },
    uFlatRefl: { value: 0 },
    uUrban: { value: null },
    uUrbanExtent: { value: 1 },
    uBuildingDebug: { value: 0 },
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
export function insideRing(ring: Float32Array, x: number, z: number): boolean {
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

/**
 * The oriented bounding box of a footprint: centre, long axis, half-extents.
 *
 * Exported because test/roof.check.ts measures the tent against the same box
 * the tent was built on, rather than against a second copy of this search.
 */
export interface Obb {
  cx: number;
  cz: number;
  /** Unit LONG axis. The short axis is v = (-uz, ux). */
  ux: number;
  uz: number;
  halfL: number;
  /** Always <= halfL: the axes are swapped rather than left in edge order. */
  halfW: number;
  area: number;
}

/**
 * Minimum-area rectangle by rotating callipers' cheap cousin: the optimal
 * rectangle is flush with some edge of the convex hull, so trying every EDGE
 * direction and keeping the smallest finds it (and on a non-convex ring it
 * finds something at least as tight as the axis-aligned box, which is all this
 * is used for).
 *
 * O(n^2), which is why the caller caps the vertex count.
 */
export function footprintObb(ring: Float32Array): Obb | null {
  const n = ring.length / 2;
  if (n < 3) return null;

  let best = Infinity;
  let bux = 1, buz = 0, bu0 = 0, bu1 = 0, bv0 = 0, bv1 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[j * 2] - ring[i * 2];
    const dz = ring[j * 2 + 1] - ring[i * 2 + 1];
    const len = Math.hypot(dx, dz);
    // A near-duplicate vertex gives a direction that is pure rounding noise.
    if (len < 0.05) continue;
    const ux = dx / len, uz = dz / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = ring[k * 2], z = ring[k * 2 + 1];
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best) {
      best = area;
      bux = ux; buz = uz;
      bu0 = u0; bu1 = u1; bv0 = v0; bv1 = v1;
    }
  }
  if (!isFinite(best)) return null;

  const cu = (bu0 + bu1) / 2, cv = (bv0 + bv1) / 2;
  const cx = cu * bux + cv * -buz;
  const cz = cu * buz + cv * bux;
  let halfL = (bu1 - bu0) / 2;
  let halfW = (bv1 - bv0) / 2;
  let ux = bux, uz = buz;
  if (halfW > halfL) {
    // Rotate the frame onto v rather than just relabelling the extents: taking
    // u' = (-uz, ux) keeps v' = (-u'z, u'x) = -u, so the frame stays right
    // handed and every winding worked out in it stays valid.
    ux = -buz; uz = bux;
    const t = halfL; halfL = halfW; halfW = t;
  }
  if (halfW < 0.5) return null;
  return { cx, cz, ux, uz, halfL, halfW, area: 4 * halfL * halfW };
}

/** Eave and rake projection past the wall, in metres. */
const OVERHANG_M = 0.45;

/**
 * Tallest building that gets a tent.
 *
 * The renderer's own bound, deliberately looser than the classifier's
 * PITCHED_MAX_M and independent of it: the rise below is clamped to 4.5 m, and
 * 4.5 m of roof on a 30 m building is not a roof, it is a hat. Keeping it here
 * as well as in classifyRoof is what repairs a pack baked before the classifier
 * learned this, which is every pack in public/cities, without a rebake.
 */
const PITCH_MAX_M = 20.0;

/** The roof's own hash salt, kept clear of the plant's 0x800 / 0x900. */
const ROOF_SALT = 0xf00f;

/** What a pitched roof turned out to be, or null if this footprint gets none. */
export interface Pitch {
  obb: Obb;
  /**
   * Ridge height above the eave. It comes off the WALL rather than sitting on
   * top of it: OSM's `height` already includes the roof, and the drone collider
   * in sim/citycollision.ts keys off topM, so the ridge has to land exactly
   * where the flat top used to.
   */
  rise: number;
  /** Vertical siding at the ends instead of a fourth and fifth slope. */
  gable: boolean;
  /** Half-length of the ridge line. Zero on a square footprint, i.e. a pyramid. */
  ridgeHalfL: number;
}

/**
 * Decide whether one building gets a tent, and how steep.
 *
 * Exported so the gate can ask which buildings took this path without owning a
 * second copy of the rule, which would only ever agree with itself.
 */
export function pitchFor(b: Building, height: number, seed: number): Pitch | null {
  if (b.roof !== RoofShape.Pitched) return null;
  // Under about four metres there is no room to take a rise out of the wall and
  // still leave a storey behind it.
  if (height < 4.0 || height > PITCH_MAX_M) return null;
  const n = b.ring.length / 2;
  if (n < 3 || n > 64) return null;   // the OBB search is O(n^2)

  const obb = footprintObb(b.ring);
  if (!obb) return null;

  // The tent is built on the OBB, not on the polygon, so it is only honest on a
  // footprint the OBB nearly IS. A straight-skeleton hip over an arbitrary ring
  // has real failure modes at a reflex vertex, and an actual house is a
  // rectangle; this test is what keeps the cheap answer off the shapes where
  // the expensive one would have been the only correct one.
  const fill = Math.abs(signedArea(b.ring)) / obb.area;
  if (fill < 0.72) return null;

  const pitchDeg = 20 + 14 * hash3(seed, ROOF_SALT, 1);   // 4:12 to 8:12
  let rise = obb.halfW * Math.tan((pitchDeg * Math.PI) / 180);
  // A roof is not most of a house, and what is left under it has to be a storey
  // you could stand in.
  rise = Math.min(rise, 4.5, 0.55 * height, height - 2.4);
  if (rise < 1.0) return null;

  // A gable end is a flat triangle of siding, so it only reads right when the
  // footprint really does end in a straight wall across the short axis.
  const gable = fill >= 0.88 && hash3(seed, ROOF_SALT, 2) < 0.5;
  return { obb, rise, gable, ridgeHalfL: Math.max(0, obb.halfL - obb.halfW) };
}

/**
 * The tent itself: two slopes, plus either two hips or two gable ends.
 *
 * Everything is laid out in the OBB's own frame, u along the ridge and
 * v across it, and mapped out to world at the last moment. Winding was worked
 * out once in the canonical frame (u = +x, v = +z) and holds for every rotation
 * of it because that map has determinant +1; test/roof.check.ts is the gate.
 */
function addTent(
  s: Scratch,
  pitch: Pitch,
  eaveY: number,
  top: number,
  base: number,
  bidx: number,
  wallH: number,
): void {
  const { obb, gable, ridgeHalfL } = pitch;
  const { ux, uz, halfL, halfW } = obb;
  const vx = -uz, vz = ux;
  const eL = halfL + OVERHANG_M;
  const eW = halfW + OVERHANG_M;
  const rise = top - eaveY;
  // Up-slope run from eave to ridge, which is what a shingle course is measured
  // in. Not the horizontal half-width: the courses are laid ON the slope.
  const slopeLen = Math.hypot(eW, rise);
  const hipLen = Math.hypot(eL - ridgeHalfL, rise);

  /** One planar face, fanned from its first vertex. [a, w, y, u, v] per vertex. */
  const face = (
    vs: ReadonlyArray<readonly [number, number, number, number, number]>,
    nx: number, ny: number, nz: number,
    part: number, isRoof: number,
  ): void => {
    const v0 = s.pos.length / 3;
    for (const [a, w, y, u, v] of vs) {
      s.pos.push(obb.cx + a * ux + w * vx, y, obb.cz + a * uz + w * vz);
      s.nrm.push(nx, ny, nz);
      s.uv.push(u, v);
      s.info.push(bidx, wallH, isRoof, part);
    }
    for (let i = 1; i + 1 < vs.length; i++) s.idx.push(v0, v0 + i, v0 + i + 1);
  };

  // Ridge half-length: the full eave on a gable (the ridge runs out to the rake
  // and the ends are vertical), inset by the half-width on a hip.
  const rl = gable ? eL : ridgeHalfL;

  // Slope normals. The plane runs from the eave at w = +/-eW up to the ridge at
  // w = 0, so its normal leans out by `rise` and up by `eW`.
  const sy = eW / slopeLen;
  const sh = rise / slopeLen;

  // uv.x runs along the ridge and uv.y up the slope from the eave, so both
  // slopes are parametrised from their own left-hand eave corner.
  const ridgeTop: Array<readonly [number, number, number, number, number]> = [
    [-eL, eW, eaveY, 0, 0],
    [eL, eW, eaveY, 2 * eL, 0],
    [rl, 0, top, rl + eL, slopeLen],
    [-rl, 0, top, eL - rl, slopeLen],
  ];
  const ridgeBot: Array<readonly [number, number, number, number, number]> = [
    [eL, -eW, eaveY, 0, 0],
    [-eL, -eW, eaveY, 2 * eL, 0],
    [-rl, 0, top, eL + rl, slopeLen],
    [rl, 0, top, eL - rl, slopeLen],
  ];
  // A square footprint gives rl == 0, where the two ridge points coincide and
  // the quad's second triangle would be degenerate. Emit a triangle instead.
  if (rl < 1e-3) { ridgeTop.pop(); ridgeBot.pop(); }
  face(ridgeTop, vx * sh, sy, vz * sh, PART_SHINGLE, 1);
  face(ridgeBot, -vx * sh, sy, -vz * sh, PART_SHINGLE, 1);

  if (gable) {
    // The end walls, at the UN-overhung short edges: the rake projects past
    // them, which is what puts the gable triangle in its own shadow.
    // uv continues the wall's own convention, y measured from the true base, so
    // the siding's storey lines run on through the triangle.
    face(
      [[halfL, halfW, eaveY, 0, wallH], [halfL, -halfW, eaveY, 2 * halfW, wallH],
       [halfL, 0, top, halfW, top - base]],
      ux, 0, uz, PART_GABLE, 0,
    );
    face(
      [[-halfL, -halfW, eaveY, 0, wallH], [-halfL, halfW, eaveY, 2 * halfW, wallH],
       [-halfL, 0, top, halfW, top - base]],
      -ux, 0, -uz, PART_GABLE, 0,
    );
  } else {
    // The hips. Same construction as a slope, rotated a quarter turn: the plane
    // leans out by `rise` and up by the horizontal run to the ridge point.
    const hy = (eL - ridgeHalfL) / hipLen;
    const hh = rise / hipLen;
    face(
      [[eL, eW, eaveY, 0, 0], [eL, -eW, eaveY, 2 * eW, 0],
       [ridgeHalfL, 0, top, eW, hipLen]],
      ux * hh, hy, uz * hh, PART_SHINGLE, 1,
    );
    face(
      [[-eL, -eW, eaveY, 0, 0], [-eL, eW, eaveY, 2 * eW, 0],
       [-ridgeHalfL, 0, top, eW, hipLen]],
      -ux * hh, hy, -uz * hh, PART_SHINGLE, 1,
    );
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

  const seed = params ? params.seed * 4096 : bidx;
  const pitch = pitchFor(b, height, seed);

  // The parapet is drawn by carrying the WALL up past the roof slab rather
  // than as its own ring of geometry: the outer face is already there, so the
  // only new triangles are the inner face looking back down at the roof. The
  // shader knows where the building stops (info.y) and stops the window grid
  // there, so the band above it comes out as the coping it is.
  //
  // A pitched roof cannot have one whatever the caller asked for, and the veto
  // has to live here rather than at the call site: the gate forces the extras
  // on for every building precisely so the windings get exercised.
  const parapetM = !pitch && extras.parapet && params ? Math.max(0.4, params.parapetM) : 0;
  // The ridge takes the building's existing top, so the eave is where the WALL
  // now stops. Flat roofs keep eaveY === top and every number below is
  // unchanged from what it was.
  const eaveY = pitch ? top - pitch.rise : top;
  const wallTop = pitch ? eaveY : top + parapetM;

  // What the shader calls bldH, and it is the top of the WALL, not of the
  // building: it drives the ground-storey clamp, the `capped` that stops the
  // window grid, and the cornice band, and all three want the eave. Passing the
  // full height on a pitched building is what would put a row of windows in the
  // roof.
  const wallH = eaveY - base;

  const pushInfo = (isRoof: number, part: number) => s.info.push(bidx, wallH, isRoof, part);

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
    const vTop = wallH + parapetM;
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
  // At the EAVE when there is a tent over it. Mostly hidden and it costs
  // nothing new, but without it any gap where a gable end meets the wall is a
  // hole you can see down into the building through.
  const tri = triangulate(b.ring);
  if (tri.length) {
    const v0 = s.pos.length / 3;
    for (let i = 0; i < n; i++) {
      s.pos.push(b.ring[i * 2], eaveY, b.ring[i * 2 + 1]);
      s.nrm.push(0, 1, 0);
      s.uv.push(b.ring[i * 2], b.ring[i * 2 + 1]);
      s.info.push(bidx, wallH, 1, PART_ROOF);
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

  if (pitch) {
    addTent(s, pitch, eaveY, top, base, bidx, wallH);
  } else if (extras.boxes > 0 || extras.overrun) {
    // Same veto as the parapet, and for the same reason: nothing stands on a
    // slope, and the gate forces the extras on for every building.
    addRoofPlant(s, b, top, extras, bidx, wallH, seed);
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
export const FACADE_TEX_WIDTH = 1024;

/**
 * The bytes the facade texture holds, without a GPU.
 *
 * Split out of buildFacadeTexture so test/facade.check.ts can walk the exact
 * indexing the fragment shader walks. This is the path a LIVE-streamed city
 * takes and a baked one never does: a baked city builds ONE table for 180,000
 * buildings, while a streamed city builds one per tile, so the small-N cases
 * (a tile with four buildings in it) are only ever exercised in the field.
 */
export function packFacadeBytes(params: FacadeParams[]): { data: Uint8Array; height: number } {
  const texels = params.length * FACADE_BYTE_TEXELS;
  const height = Math.max(1, Math.ceil(texels / FACADE_TEX_WIDTH));
  const data = new Uint8Array(FACADE_TEX_WIDTH * height * 4);
  const scratch = new Float32Array(FACADE_FLOATS);
  for (let i = 0; i < params.length; i++) {
    packFacade(params[i], scratch, 0);
    for (let v = 0; v < FACADE_FLOATS; v++) {
      const [lo, hi] = encodeFacadeValue(scratch[v]);
      const byteIndex = (i * FACADE_FLOATS + v) * 2;
      data[byteIndex] = lo;
      data[byteIndex + 1] = hi;
    }
  }
  return { data, height };
}

function buildFacadeTexture(params: FacadeParams[]): THREE.DataTexture {
  // RGBA8, two bytes per value, NOT a float texture: an Android device returned
  // all zeros from the same table as fp32 AND as fp16 while sampling every
  // ordinary texture correctly, and every building then read a zero storey
  // height, divided by it, and rendered NaN-black.
  //
  // The packing itself lives in packFacadeBytes so the gate can walk the same
  // bytes the shader indexes, without a GPU.
  const { data, height } = packFacadeBytes(params);

  const tex = new THREE.DataTexture(data, FACADE_TEX_WIDTH, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Nearest and no mips: this is a lookup table, not an image. Any filtering
  // would blend one building's storey height into its neighbour's, and with
  // fixed point it would also blend a low byte into a high one.
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

      const extras = roofExtras(dist, lodK, h, area, b.kind, b.roof);
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
