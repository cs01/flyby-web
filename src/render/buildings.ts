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
  FACADE_STRIDE,
  encodeFacadeValue,
  packFacadeRaw,
  facadeFor,
  hash3,
  packFacade,
  type FacadeParams,
} from "./facade";
import { ARCHETYPES, WindowStyle, assignArchetypes, regionAt, wantsWaterTank } from "./archetype";
import { FACADE_DETAIL_GLSL } from "./facadedetail.glsl";
import { SIGN_COLS, SIGN_COUNT, SIGN_ROWS, buildSignAtlas } from "./signs";
import { loadMaterialTextures } from "./materialtex";
import { Mat, MAT_COUNT } from "./materials";
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
const CLUTTER_M = 2000;
const PARAPET_M = 2200;
/**
 * Wooden water tanks go further out than the chillers: a tank is 4 m across
 * and 8 m tall on its stand, the most recognisable thing on a New York roof,
 * and it costs 72 triangles. Measured on the Manhattan pack: 2665 tanks inside
 * 2.5 km, under 200k triangles, and the LOD solver still settles at k = 1.
 */
const TANK_M = 2500;
/** Triangles one tank costs: four legs, a deck, ten staves and a ten-sided cone. */
const TANK_TRIS = 72;

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
  /** A wooden water tank on a steel stand; see wantsWaterTank. */
  tank?: boolean;
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
  if (roof !== RoofShape.Flat) return NO_EXTRAS;
  // A FLAT residential roof does have a parapet and a stair bulkhead: every
  // walk-up, brownstone and two-flat in the three surveyed cities is a flat
  // roof behind a parapet with a hatch or bulkhead on it, and keeping them off
  // was what made the residential grid read as a field of identical lids from
  // the air. What a home does not have is a chiller farm, so boxes stay off.
  const home = kind === BuildingKind.Residential;
  if (heightM < (home ? 9 : 6) || areaM2 < (home ? 70 : 120)) return NO_EXTRAS;
  const parapet = distM < PARAPET_M / k;
  if (!parapet) return NO_EXTRAS;
  if (distM >= CLUTTER_M / k) return { parapet, boxes: 0, overrun: false };
  const boxes = home ? (areaM2 >= 900 ? 1 : 0) : Math.min(4, Math.floor(areaM2 / 900));
  const overrun = home ? areaM2 >= 90 : heightM >= 22 && areaM2 >= 350;
  return { parapet, boxes, overrun };
}

/** Triangles the roof extras add: the parapet's inner face, plus 10 per box. */
function extrasCost(vertCount: number, e: RoofExtras): number {
  return (e.parapet ? vertCount * 2 : 0) + (e.boxes + (e.overrun ? 1 : 0)) * 10 + (e.tank ? TANK_TRIS : 0);
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
function solveLod(pack: CityPack, triangleBudget: number, tankAt: (i: number) => boolean): number {
  for (const k of [1, 1.4, 2, 3, 4.5, 7, 11, 18]) {
    let tris = 0;
    for (let i = 0; i < pack.buildings.length; i++) {
      const b = pack.buildings[i];
      const h = b.topM - b.baseM;
      const dist = Math.hypot(b.cx, b.cz);
      // The far-field cut is on the TOP, not the record's own height: a 20 m
      // setback stage at 290 m is part of the skyline, and cutting it as if it
      // were a 20 m house left a gap in the tower.
      if (b.topM < minHeightAt(dist, k)) continue;
      const n = b.ring.length / 2;
      tris += triangleCost(n);
      // The tent, when this footprint gets one. A hip is 4 to 6 and a gable is
      // 6, so 8 deliberately overestimates: the pitch itself also depends on
      // the OBB fill test, which is far too expensive to run inside this loop.
      if (b.roof === RoofShape.Pitched && h >= 4.0 && h <= 20.0) tris += 8;
      if (b.roof === RoofShape.Dome) tris += n * 8;
      else if (b.roof === RoofShape.Pyramid || b.roof === RoofShape.Tapered) tris += n * 2;
      if (dist < PARAPET_M / k) {
        tris += extrasCost(n, roofExtras(dist, k, h, Math.abs(signedArea(b.ring)), b.kind, b.roof));
      }
      if (dist < TANK_M / k && b.roof === RoofShape.Flat && tankAt(i)) tris += TANK_TRIS;
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
/**
 * A wooden water tank and its stand. uv.y < 0 marks the steel (legs, deck),
 * uv.y >= 0 the staves (uv = metres round, metres up) and the cone (isRoof).
 */
export const PART_TANK = 6;
/**
 * A spire, a crown pyramid or a dome over a building:part: the Chrysler's
 * stainless needle, the Empire State's mast stage, the Transamerica's cap.
 * Metal or the trim stone, never shingle and never a window grid.
 */
export const PART_SPIRE = 7;
/** A fabric awning over a shopfront; uv.x metres along it, uv.y 0 at the wall. */
export const PART_AWNING = 8;
/**
 * A projecting cornice: uv.y >= 0 on its front face (metres up it), -1 on the
 * soffit and -2 on its top.
 */
export const PART_CORNICE = 9;
/** Cornices and bay windows are geometry inside this, metres from the camera. */
const RELIEF_M = 900;
/**
 * The camera-centred DETAIL LAYER: awnings within STREET_M of the camera,
 * cornices and bay windows within RELIEF_M, rebuilt when the camera has moved
 * DETAIL_REBUILD_M from where it was last built.
 *
 * Not in the static city mesh, because that mesh is built once around the
 * PACK centre: Alamo Square is 3.9 km from the San Francisco pack's centre,
 * and anything ranged from the centre simply never appeared there. Ranged
 * from the camera, it is wherever you are, and it costs nothing anywhere else.
 */
const STREET_M = 700;
const DETAIL_REBUILD_M = 200;
/** Time a detail rebuild may take per frame, ms. */
const DETAIL_SLICE_MS = 3;

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

/**
 * The acRate() body: window units per window by archetype. Rates from street
 * counts of the type: about one window in five on a pre-war walk-up or
 * elevator block, fewer on the post-war towers with through-wall sleeves,
 * almost none on offices, none in San Francisco.
 */
function acRateGlsl(): string {
  const rates: Record<string, number> = {
    "nyc-walkup": 0.22, "nyc-prewar-apt": 0.20, "nyc-white-brick": 0.12, "nyc-projects": 0.16,
    "nyc-brownstone": 0.08, "nyc-house": 0.06, "nyc-loft": 0.05,
    "chi-courtyard": 0.10, "chi-two-flat": 0.06, "chi-concrete": 0.04,
  };
  const terms = Object.entries(rates)
    .map(([id, r]) => [ARCHETYPES.findIndex((a) => a.id === id), r] as const)
    .filter(([i]) => i >= 0)
    .map(([i, r]) => `if (abs(a - ${i}.0) < 0.5) return ${r.toFixed(3)};`);
  return `${terms.join("\n  ")}\n  return 0.0;`;
}

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
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
${FACADE_DETAIL_GLSL}

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
// ?flatfacade=1: the facade this repo had before the archetype work, in the
// same binary: no photographed materials, no rooms behind the glass, no frames,
// sills, cornice band or weathering, the old roof and the old night windows.
// The vacuity probe for tools/verify-buildings.ts.
uniform float uFlatFacade;
// ?oneroof=1: every flat roof the same cover and colour; see the roof branch.
uniform float uOneRoof;
// ?flatshop=1: the ground storey before shop rooms, signs and shutters.
uniform float uFlatShop;
// The fascia lettering atlas (render/signs.ts); uSignReady is 0 until it is built.
uniform sampler2D uSignAtlas;
uniform float uSignReady;
// ?terrainDebug=N: the terrain is drawing one of its own masks, which the water
// and ground gates read as grey-and-bright. Buildings still have to OCCLUDE
// what they occlude in the beauty frame, but they must not be grey and bright
// themselves: a white membrane roof or a pale stucco wall in sun was being
// counted as water, and as foam. So under a terrain mask they draw black.
uniform float uTerrainDebug;
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

// The colour a tower's crown is floodlit in: mostly white (the Empire State's
// default, metal halide), some warm sodium-white, a few in a colour.
vec3 floodColour(Facade p) {
  float h = hash11(p.seed * 61.0 + 2.0);
  return h < 0.50 ? vec3(1.0, 0.97, 0.92)
       : h < 0.75 ? vec3(1.0, 0.82, 0.55)
       : h < 0.88 ? vec3(0.55, 0.70, 1.0)
       :            vec3(1.0, 0.65, 0.30);
}

// Share of windows with a through-the-window air conditioner, by archetype.
float acRate(float a) {
  ${acRateGlsl()}
}

void main() {
  float bidx  = vBidx;
  float bldH  = vInfo.y;
  float isRoof = vInfo.z;
  float part  = vInfo.w;

  Facade fp = readFacade(bidx);

  // Everything the archetype work added is behind detailOn, so ?flatfacade=1
  // is the old facade exactly; and the photographs are additionally behind
  // uMatReady, so a city drawn before the strips arrive is the flat one.
  float detailOn = 1.0 - uFlatFacade;
  float matOn = uMatReady * detailOn;

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
  /** 1 on a facade fragment inside the ground storey. See buildingDebug=5. */
  float groundMarker = 0.0;

  // PART_GABLE shares the facade branch, so the chain cannot be a plain
  // ascending ladder any more: the shingle test has to come first (it is the
  // highest tag but the clutter branch is the trailing else), and the gable
  // has to be pulled back out of it.
  bool gableEnd = part > 4.5 && part < 5.5;

  if (part > 8.5) {
    // --- Cornice (and a bay's cap and soffit) ------------------------------
    // The trim stone or the painted timber of the archetype. Dentils on the
    // lower part of the front face, the soffit in its own shade, the top a
    // dirty ledge. Filtered like every other repeat on the building.
    albedo = fp.trim;
    if (vUv.y < -1.5) {
      albedo = fp.trim * 0.55;
    } else if (vUv.y < -0.5) {
      albedo = fp.trim * 0.7;
      skyOcc = 0.45;
    } else {
      float dp = vUv.x / 0.22;
      float dw = max(fwidth(dp), 1e-3);
      float dent = step(0.5, fract(dp)) * step(vUv.y, 0.22);
      dent = mix(dent, 0.5 * step(vUv.y, 0.22), clamp(dw * 1.6, 0.0, 1.0));
      albedo *= 1.0 - 0.4 * dent;
      // A fillet line two thirds of the way up.
      float fy = abs(vUv.y - 0.62 * (0.45 + 0.75 * fp.corniceM));
      albedo *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, max(0.04, fwidth(vUv.y)), fy));
      albedo *= 1.0 - 0.3 * fp.age * vnoise(vec2(vUv.x * 0.8, vUv.y * 3.0) + fp.seed);
    }
    roughness = 0.8;
  } else if (part > 7.5) {
    // --- Awning ----------------------------------------------------------
    // Canvas in a solid trade colour, or striped, one per shop: the palette
    // is the dyed acrylic awning makers sell, dulled by a few seasons of sun.
    float ha = hash11(fp.seed * 53.0 + floor(vWorld.x * 0.05) + floor(vWorld.z * 0.05) * 7.0);
    vec3 cloth = ha < 0.2 ? vec3(0.32, 0.03, 0.03) : ha < 0.38 ? vec3(0.02, 0.10, 0.05)
               : ha < 0.52 ? vec3(0.02, 0.04, 0.14) : ha < 0.64 ? vec3(0.04, 0.035, 0.03)
               : ha < 0.76 ? vec3(0.45, 0.30, 0.04) : vec3(0.30, 0.10, 0.02);
    float stripe = step(0.6, fract(ha * 9.1)) * step(0.5, fract(vUv.x / 0.30));
    float sw = max(fwidth(vUv.x / 0.30), 1e-3);
    stripe = mix(stripe, 0.5 * step(0.6, fract(ha * 9.1)), clamp(sw * 1.6, 0.0, 1.0));
    albedo = mix(cloth, vec3(0.62, 0.60, 0.55), stripe);
    roughness = 0.9;
    skyOcc = 0.7;
  } else if (part > 6.5) {
    // --- Spire, crown pyramid or dome --------------------------------------
    // A Deco crown is stainless steel or aluminium over the trim stone; a
    // glass tower's cap is its own metal panel. Vertical ribs every 1.2 m (the
    // seams of the cladding), filtered out with the pixel footprint.
    float hS = hash11(fp.seed * 43.0 + 7.0);
    float metal = fp.family < 0.5 || hS < 0.55 ? 1.0 : 0.0;
    albedo = mix(fp.trim * 0.9, vec3(0.46, 0.47, 0.50), metal);
    float rib = vUv.x / 1.2;
    float rw = max(fwidth(rib), 1e-3);
    albedo *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, max(0.1, rw), fract(rib))) * (1.0 - clamp(rw * 1.6, 0.0, 1.0));
    roughness = mix(0.75, 0.28, metal);
    glassMask = 0.45 * metal;
    skyOcc = 1.0;
    // A spire on a tower is floodlit all the way up after dark.
    if (uNight > 0.02 && bldH >= 100.0) {
      emissive += floodColour(fp) * uNight * (0.12 + 0.55 * dot(albedo, vec3(0.333))) * detailOn;
    }
  } else if (part > 5.5) {
    // --- Water tank -------------------------------------------------------
    // Cedar staves gone silver-brown, bound with dark steel hoops every half
    // metre or so, a tar-black lid, on a black steel stand. uv.y < 0 is the
    // steel; isRoof marks the lid.
    float hT = hash11(fp.seed * 41.0 + 3.0);
    if (vUv.y < -0.5) {
      albedo = vec3(0.035, 0.034, 0.033);
      roughness = 0.6;
    } else if (isRoof > 0.5) {
      albedo = mix(vec3(0.045, 0.043, 0.04), vec3(0.09, 0.085, 0.08), hT);
    } else {
      vec3 wood = mix(vec3(0.20, 0.15, 0.11), vec3(0.24, 0.22, 0.20), hT);
      float stave = vUv.x / 0.14;
      float swd = max(fwidth(stave), 1e-3);
      wood *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, max(0.12, swd), fract(stave))) * (1.0 - clamp(swd, 0.0, 1.0));
      wood *= 0.85 + 0.3 * hash11(floor(stave) + fp.seed * 7.0) * (1.0 - clamp(swd, 0.0, 1.0));
      float hoopP = vUv.y / (0.45 + 0.25 * hT);
      float hw = max(fwidth(hoopP), 1e-3);
      float hoop = (1.0 - smoothstep(0.0, max(0.08, hw), fract(hoopP))) * (1.0 - clamp(hw * 1.6, 0.0, 1.0));
      // Water streaks down the staves from the lid.
      wood *= 1.0 - 0.15 * smoothstep(0.6, 0.0, vUv.y / 4.0) * vnoise(vec2(vUv.x * 3.0, 1.0));
      albedo = mix(wood, vec3(0.04), hoop * 0.8);
    }
    skyOcc = 0.95;
  } else if (part > 3.5 && !gableEnd) {
    // --- Shingle --------------------------------------------------------
    // Asphalt shingle or tile, and it is DARK: a real roof covering is
    // 0.05-0.14 linear, which is well under any wall it sits on.
    float pick = hash11(fp.seed * 23.0 + 1.0);
    vec3 cover = pick < 0.45 ? vec3(0.045, 0.046, 0.049)      // charcoal asphalt
               : pick < 0.80 ? vec3(0.078, 0.070, 0.060)      // weathered grey-brown
                             : vec3(0.105, 0.060, 0.044);     // faded clay tile
    // With the archetype, the cover is the survey's: asphalt, brown asphalt,
    // red clay tile, slate, copper verdigris or cedar shake, each at the albedo
    // of the aged product, jittered per building.
    int pc = int(fp.pitchCover + 0.5);
    float pj = 0.85 + 0.3 * hash11(fp.seed * 29.0 + 5.0);
    if (detailOn > 0.5) {
      cover = (pc == 0 ? vec3(0.042, 0.043, 0.046)
             : pc == 1 ? vec3(0.075, 0.058, 0.046)
             : pc == 2 ? vec3(0.30, 0.11, 0.06)
             : pc == 3 ? vec3(0.07, 0.075, 0.085)
             : pc == 4 ? vec3(0.13, 0.25, 0.20)
             :           vec3(0.12, 0.10, 0.085)) * pj;
    }
    // Clay tile and slate are laid in shorter courses than shingle, and tile
    // is a barrel: a ripple across the slope every quarter metre.
    float courseM = detailOn > 0.5 && (pc == 2 || pc == 3) ? 0.24 : 0.30;
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
    float cy = vUv.y / courseM;
    float wy = max(fwidth(cy), 1e-4);
    float courseFade = 1.0 - clamp(wy * 1.6, 0.0, 1.0);
    float course = 1.0 - smoothstep(0.0, max(0.18, wy), fract(cy));
    float cx = vUv.x / 0.90;
    float wx = max(fwidth(cx), 1e-4);
    float tabFade = 1.0 - clamp(wx * 1.6, 0.0, 1.0);
    float tab = 1.0 - smoothstep(0.0, max(0.10, wx), fract(cx));
    albedo *= 1.0 - 0.18 * course * courseFade - 0.08 * tab * tabFade;
    if (detailOn > 0.5 && pc == 2) {
      float bw = vUv.x / 0.26;
      float bwd = max(fwidth(bw), 1e-3);
      albedo *= 1.0 - 0.25 * (0.5 + 0.5 * cos(bw * 6.2832)) * (1.0 - clamp(bwd * 1.6, 0.0, 1.0));
      albedo *= 0.85 + 0.3 * hash21(floor(vec2(bw, cy)) + fp.seed);
    }
    if (detailOn > 0.5 && pc == 4) {
      // Standing seams every half metre, and the patina is streaky.
      float sm = vUv.x / 0.5;
      float smd = max(fwidth(sm), 1e-3);
      albedo *= 1.0 + 0.25 * (1.0 - smoothstep(0.0, max(0.06, smd), fract(sm))) * (1.0 - clamp(smd * 1.6, 0.0, 1.0));
      albedo = mix(albedo, vec3(0.10, 0.09, 0.06), 0.3 * vnoise(vec2(vUv.x * 2.0, vUv.y * 0.3)));
    }
    // Moss and soot in the lower courses, and lichen on slate.
    if (detailOn > 0.5) albedo *= 1.0 - 0.15 * fp.age * smoothstep(0.55, 0.85, vnoise(vUv * 0.7 + fp.seed * 3.0));

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

    // --- THE WALL ITSELF ---------------------------------------------------
    //
    // A photographed scan (render/materials.ts), shown as its variation around
    // its own mean and multiplied by this building's palette colour, so one
    // red-brick scan is a buff brick here and a brownstone on the next block.
    // The mip chain takes the ratio to exactly 1 far away, which is the mean
    // this facade had before, so a distant building does not change colour.
    MatSample wallMat;
    wallMat.ratio = vec3(1.0); wallMat.nT = vec2(0.0); wallMat.rough = roughness;
    wallMat.height = 0.5; wallMat.ao = 1.0;
    if (matOn > 0.5) {
      wallMat = sampleMat(fp.wallLayer, vUv);
      albedo = fp.colour * wallMat.ratio;
      roughness = mix(roughness, wallMat.rough, 0.5);
    }

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

    // --- FRAMES, BARS AND THE ROOM BEHIND THE GLASS ------------------------
    //
    // Window-local coordinates: 0..1 across and up the glazed rectangle, at
    // the RECESSED position (pcell), because the sash sits in the glass plane.
    vec2 winSz = vec2(winMeanX * fp.columnM, winMeanY * fp.storeyM);
    vec2 wl = (pcell - fp.win.xz) / max(vec2(winMeanX, winMeanY), vec2(1e-3));
    vec2 wfw = w / max(vec2(winMeanX, winMeanY), vec2(1e-3));
    float frameMean = 0.0;
    float frameMask = detailOn > 0.5
      ? windowFrame(wl, winSz, wfw, fp.windowStyle, fp.frameM, fp.mullions, frameMean) : 0.0;
    float frameLod = mix(frameMean, frameMask, detail) * detailOn;
    float pane = win * (1.0 - frameLod);

    // The whole pane is glass. glassFrac thinned the reflection to a fifth on a
    // masonry front, which made a punched window a matte hole; a real sash
    // reflects the street opposite as strongly as any curtain wall does at
    // the same angle, and only its f0 differs. Its roughness is glass, not the
    // brick's 0.86, which was putting the reflection in the blurriest mip.
    glassMask = pane * mix(fp.glassFrac, 1.0, detailOn);
    roughness = mix(roughness, 0.06, pane * detailOn);

    vec3 glass = mix(vec3(0.075, 0.095, 0.125), vec3(0.15, 0.19, 0.24), hash11(fp.seed + 3.3));
    // With a room behind it the pane is nearly black: what a window shows is
    // the room (seeIn, below) and the sky (the Fresnel term further down). The
    // old grey-blue pane albedo, lit by the SUN, was neither. And it covers the
    // whole opening: the old mix by glassFrac left a brick window 80% brick.
    glass = mix(glass, fp.glassTint * 0.35, detailOn);
    albedo = mix(albedo, glass, mix(glassMask, pane, detailOn));
    albedo = mix(albedo, fp.frameColour, win * frameLod);

    vec3 roomC = vec3(0.0);
    float curtainCov = 0.0;
    float blindCov = 0.0;
    vec3 blindC = vec3(0.0);
    if (detailOn > 0.5 && pane > 0.001) {
      // The view ray in the wall's own frame, z INTO the building.
      vec3 vT = vec3(dot(-eyeDir, uDir), dot(-eyeDir, upDir), dot(eyeDir, n));
      vec3 rp = vec3(pcell.x * fp.columnM, pcell.y * fp.storeyM, 0.0);
      float roomSeed = fp.seed * 977.0 + colIdx * 13.13 + floorIdx * 7.77;
      // An office floor plate runs 12 m to the core and a flat's front room 4 m.
      float depth = abs(fp.interior - 1.0) < 0.5 ? 6.5 : 4.2;
      roomC = roomColour(rp, vT, vec2(fp.columnM, fp.storeyM), depth, fp.interior, roomSeed, uNight).rgb;
      // Blinds and curtains hang in the window plane, so they take no
      // parallax. The blind is the same hash the night windows have always
      // used, so a blind seen by day is the one that shades the lamp at night.
      float bH = hash21(vec2(colIdx * 0.71 + fp.seed * 17.0, floorIdx * 1.13 + 5.0));
      float bDrop = step(bH, ${BLIND_FRAC}) * ${BLIND_MAX} * (bH / ${BLIND_FRAC});
      float blind = step(1.0 - bDrop, wl.y);
      float cH = hash21(vec2(colIdx * 1.37 + fp.seed * 5.0, floorIdx * 0.53 + 9.0));
      if (fp.interior < 0.5 && cH < 0.45) {
        float cw = 0.12 + 0.25 * fract(cH * 7.3);
        curtainCov = 1.0 - step(cw, wl.x) * step(wl.x, 1.0 - cw);
      }
      blindCov = max(blind, curtainCov);
      vec3 fabric = mix(vec3(0.62, 0.58, 0.50), vec3(0.42, 0.30, 0.26), step(0.3, fract(cH * 3.1)));
      blindC = mix(vec3(0.66, 0.64, 0.60), fabric, curtainCov);
    }
    // By day a room is lit by the sky through its own window, so it rides the
    // AMBIENT path the shopfront interior does (seeIn), never the beam. 0.32 is
    // the share of that light a room returns through the same opening: a
    // 0.45-albedo room loses half its light per bounce and most of what is
    // left goes out of other windows or into the floor. Converges on the mean
    // room (0.30 shaded albedo) as the windows go under a pixel.
    vec3 dayRoom = mix(roomC, blindC * 0.8, blindCov) * 0.32;
    seeIn = mix(vec3(0.30 * 0.32), dayRoom, detail) * pane * detailOn * (1.0 - uNight)
          * step(groundH, vUv.y) * capped;

    // --- WHAT IS IN THE WINDOW ---------------------------------------------
    //
    // A grid of identical openings, every floor the same, is the tell up
    // close. A pre-war New York front is a window unit in one window in four
    // or five, a plant on a cill, a sash pushed up for air. One hash per
    // window decides all three, so a window is the same window by day and by
    // night, and each is an object of a few tens of centimetres that fades
    // with the window's own footprint (detail), never sooner and never later.
    // acRate is per archetype: through-the-window units are a New York and
    // Chicago thing, almost absent in San Francisco's climate.
    float winObj = 0.0;
    if (detailOn > 0.5 && pane > 0.001 && fp.interior < 0.5) {
      float wh = hash21(vec2(colIdx * 3.71 + fp.seed * 1.9, floorIdx * 2.03 + 77.0));
      float hasAc = step(wh, acRate(fp.archetype));
      vec2 acSz = min(vec2(0.66, 0.40) / max(winSz, vec2(0.3)), vec2(0.9));
      float acX0 = 0.5 - 0.5 * acSz.x + (fract(wh * 17.3) - 0.5) * (1.0 - acSz.x) * 0.8;
      float acM = hasAc * step(acX0, wl.x) * step(wl.x, acX0 + acSz.x) * step(0.02, wl.y) * step(wl.y, 0.02 + acSz.y);
      // Beige or white plastic, a dark grille on its face, darker underneath.
      vec3 acC = mix(vec3(0.42, 0.40, 0.35), vec3(0.58, 0.58, 0.56), step(0.5, fract(wh * 5.7)));
      float grille = step(0.5, fract((wl.x - acX0) / acSz.x * 9.0)) * step(0.35, (wl.y - 0.02) / acSz.y);
      acC *= 1.0 - 0.35 * grille * detail;
      acC *= mix(0.6, 1.0, smoothstep(0.02, 0.02 + acSz.y * 0.4, wl.y));
      // Plants on the cill: a ragged dark green band, never with a unit.
      float hasPlant = (1.0 - hasAc) * step(fract(wh * 29.1), 0.06);
      float plantTop = 0.10 + 0.14 * vnoise(vec2(wl.x * 9.0, wh * 31.0));
      float plantM = hasPlant * step(wl.y, plantTop);
      vec3 plantC = mix(vec3(0.03, 0.07, 0.025), vec3(0.08, 0.13, 0.04), vnoise(wl * 14.0 + wh * 9.0));
      // A raised sash: the lower light is open, so there is no glass in it to
      // reflect the street, and the room shows straight through.
      float isSash = 1.0 - step(0.5, fp.windowStyle);
      float openM = (1.0 - hasAc) * isSash * step(fract(wh * 41.3), 0.06) * step(wl.y, 0.45);
      float objM = max(acM, plantM) * pane * detail;
      albedo = mix(albedo, acM > 0.5 ? acC : plantC, objM);
      glassMask *= 1.0 - objM - openM * pane * detail;
      seeIn *= 1.0 - objM;
      seeIn += roomC * 0.32 * openM * pane * detail * (1.0 - uNight) * 0.6;
      winObj = objM;
    }

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
    groundMarker = ground * step(0.0, vUv.y);
    // What the shop block below decides, for the night lighting further down.
    float shopOpen = 1.0, shopShutter = 0.0, signInk = 0.0, signLit = 0.0;
    vec3 shopRoom = vec3(0.36), signColour = vec3(0.0);
    bool shopDetail = false;
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

      // --- WHAT THE SHOP IS ----------------------------------------------
      //
      // The bay above is a glass panel; a street of them is a row of dark
      // rectangles with nothing to say what any of them sells. Three things a
      // photograph of a shopping street always has and this did not:
      //
      //   * A ROOM. The bay is a window into a shop: shelving on the back
      //     wall, a lamp grid on the ceiling, through the same parallax room
      //     the upper windows use, in its retail variant.
      //   * A SIGN on the fascia, one trade word per unit out of the atlas
      //     (render/signs.ts), in a contrasting colour, lit at night on most.
      //   * SHUTTERS. After hours a share of the units are rolled down to the
      //     plinth: corrugated steel, the most New York thing on a night street.
      //
      // Everything is per BAY and filtered on the bay's own footprint, so a
      // parade seen from a block away converges to its mean rather than
      // flickering unit by unit. ?flatshop=1 turns the block off: the probe
      // for the night shopfront claim in tools/verify-buildings.ts.
      if (uFlatShop < 0.5 && detailOn > 0.5 && fp.house < 0.5) {
        shopDetail = true;
        // Signs and shutters are a shop's; a lobby or a residential base
        // keeps only the room behind its glass.
        float retail = step(0.3, fp.shopfront);
        float uh1 = hash21(vec2(bayIdx * 1.31 + fp.seed * 7.0, 17.0));
        float uh2 = hash21(vec2(bayIdx * 2.17 + fp.seed * 3.0, 29.0));
        float uh3 = hash21(vec2(bayIdx * 0.73 + fp.seed * 11.0, 41.0));
        // Open after dark: 55% of units, decided per unit and not per building.
        shopOpen = step(uh1, 0.55);
        // Shuttered: most closed units at night, one in fifteen by day (a
        // vacant unit or one that opens late).
        float shutNight = (1.0 - shopOpen) * step(uh2, 0.70);
        float shutDay = step(uh2, 0.065);
        shopShutter = mix(shutDay, shutNight, uNight) * shop * retail;

        vec3 vT = vec3(dot(-eyeDir, uDir), dot(-eyeDir, upDir), dot(eyeDir, n));
        vec3 rp = vec3(bx * bayM, vUv.y - plinthM, 0.0);
        vec4 room = roomColour(rp, vT, vec2(bayM, headY - plinthM + 0.3), 7.0, 3.0,
                               fp.seed * 31.0 + bayIdx * 5.3, uNight);
        // 0.36: the retail room's mean shaded value, so far away the bay is
        // the mean it was and only the near field gains the room.
        shopRoom = mix(vec3(0.36), room.rgb, detailX * detailY);
        seeIn = mix(seeIn, shopRoom * 0.75 * glassMask * (1.0 - uNight), detailX);

        // The sign: inset on the fascia inside the piers, one per unit.
        float signLo = headY + 0.08, signHi = groundH - 0.10;
        // uv.x runs RIGHT TO LEFT seen from the street (it follows the ring,
        // which winds counter-clockwise), so the lettering reads from 1 to 0.
        float sx = 1.0 - (bx - pier) / max(1.0 - 2.0 * pier, 0.1);
        float sy = (vUv.y - signLo) / max(signHi - signLo, 0.1);
        float inSign = step(0.0, sx) * step(sx, 1.0) * step(0.0, sy) * step(sy, 1.0)
                     * step(uh3, 0.82) * (1.0 - isDoor * step(0.5, uh2)) * retail;
        float idx = floor(uh3 / 0.82 * ${SIGN_COUNT}.0);
        vec2 cellXY = vec2(mod(idx, ${SIGN_COLS}.0), floor(idx / ${SIGN_COLS}.0));
        // CanvasTexture is flipped: row 0 of the canvas is the TOP of v.
        vec2 suv = vec2((cellXY.x + clamp(sx, 0.0, 1.0)) / ${SIGN_COLS}.0,
                        1.0 - (cellXY.y + 1.0 - clamp(sy, 0.0, 1.0)) / ${SIGN_ROWS}.0);
        float ink = uSignReady > 0.5 ? texture(uSignAtlas, suv).a : 0.35;
        // Converges to the atlas mean ink (about 0.3) as the unit goes under a
        // pixel, so distant fascias do not twinkle letter by letter.
        ink = mix(0.3, ink, detailX * detailY) * inSign;
        float tc = fract(uh3 * 13.7);
        vec3 inkC = tc < 0.30 ? vec3(0.80, 0.78, 0.70)
                  : tc < 0.50 ? vec3(0.85, 0.66, 0.10)
                  : tc < 0.68 ? vec3(0.62, 0.05, 0.04)
                  : tc < 0.82 ? vec3(0.03, 0.03, 0.035)
                  :             vec3(0.10, 0.45, 0.25);
        // Dark lettering only on a pale board, pale lettering on a dark one.
        float bgLum = dot(fasciaCol, vec3(0.299, 0.587, 0.114));
        if (bgLum < 0.12 && tc >= 0.68 && tc < 0.82) inkC = vec3(0.80, 0.78, 0.70);
        if (bgLum > 0.30 && tc < 0.30) inkC = vec3(0.03, 0.03, 0.035);
        albedo = mix(albedo, inkC, ink);
        signInk = ink;
        signColour = inkC;
        // Lit signs: a backlit box or neon on most open units, and on some
        // closed ones too (a sign left on is the commonest thing at 2 am).
        signLit = step(fract(uh1 * 7.1), mix(0.45, 0.85, shopOpen));

        // The shutter: horizontal ribs every 75 mm, galvanised grey, and a
        // housing box under the fascia.
        float rib = vUv.y / 0.075;
        float rw = max(fwidth(rib), 1e-3);
        float ribs = 1.0 - 0.35 * (0.5 + 0.5 * cos(rib * 6.2832)) * (1.0 - clamp(rw * 1.6, 0.0, 1.0));
        vec3 steel = mix(vec3(0.20, 0.205, 0.21), vec3(0.32, 0.31, 0.29), uh2 * 14.0 - floor(uh2 * 14.0)) * ribs;
        albedo = mix(albedo, steel, shopShutter);
        glassMask *= 1.0 - shopShutter;
        seeIn *= 1.0 - shopShutter;
      }
    }

    // --- THE FIRE ESCAPE ------------------------------------------------------
    //
    // The single most New York thing on a walk-up front: a black steel stack of
    // balconies two windows wide, a railing on each, and a stair zig-zagging
    // down between them. Drawn in the wall plane (it stands a metre off it,
    // under a pixel of parallax from anywhere but the pavement opposite), on
    // the faces a hash of the wall's orientation picks, so a building has it on
    // one or two elevations and not round all four.
    float fireEsc = 0.0;
    if (detailOn > 0.5 && mod(floor(fp.roofFeatures / 8.0), 2.0) > 0.5 && floorIdx >= 0.0 && capped > 0.5) {
      float face = floor((atan(n.z, n.x) + 3.14159) / 6.28318 * 8.0);
      float faceOn = step(hash11(face * 7.3 + fp.seed * 91.0), 0.45);
      float period = 3.0 + floor(hash11(fp.seed * 13.0 + face) * 3.0);
      float slot = floor(hash11(fp.seed * 17.0 + face * 3.0) * (period - 1.0));
      float bay = floor(colIdx / period);
      float ex = vUv.x - (bay * period + slot) * fp.columnM;      // metres into the escape
      float span = 2.0 * fp.columnM;
      float inEsc = step(0.0, ex) * step(ex, span) * faceOn;
      float fy = (vUv.y - groundH) - floorIdx * fp.storeyM;       // metres above this floor
      float aa = max(fwidth(vUv.y), 1e-3);
      float platform = smoothstep(-aa, aa, fy) * smoothstep(0.10 + aa, 0.10 - aa, fy);
      float rail = smoothstep(0.92 - aa, 0.92 + aa, fy) * smoothstep(0.98 + aa, 0.98 - aa, fy);
      float bw = max(fwidth(ex / 0.12), 1e-3);
      float baluster = mix(0.22, step(fract(ex / 0.12), 0.22), 1.0 - clamp(bw * 1.2, 0.0, 1.0))
                     * step(0.10, fy) * step(fy, 0.92);
      // The stair: a stringer from one platform up to the next, alternating
      // direction floor by floor.
      float dir = mod(floorIdx, 2.0) < 0.5 ? 1.0 : -1.0;
      float sx = dir > 0.0 ? ex - 0.25 : span - 0.25 - ex;
      float run = span - 0.9;
      float stair = 1.0 - smoothstep(0.05 + aa * 2.0, 0.09 + aa * 2.0, abs(fy - sx * fp.storeyM / run))
                  * 1.0;
      stair *= step(0.0, sx) * step(sx, run);
      float steel = max(max(platform, rail), max(baluster, stair));
      fireEsc = inEsc * steel * mix(0.6, 1.0, detailY);
      // The grating's shadow under each platform, when the sun is on the wall.
      float under = smoothstep(-0.45, -0.05, fy - fp.storeyM) * step(fy - fp.storeyM, 0.0);
      revealShade *= 1.0 - 0.5 * inEsc * under * step(0.02, dot(uSunDir, n));
      albedo = mix(albedo, vec3(0.028, 0.028, 0.030), fireEsc);
      glassMask *= 1.0 - fireEsc;
      seeIn *= 1.0 - fireEsc;
    }

    // --- SILLS AND LINTELS ---------------------------------------------------
    //
    // A punched opening in masonry has a stone sill under it and a stone or
    // brick lintel over it, wider than the opening, in the archetype's trim
    // stone. It is the single strongest cue that a wall is a masonry wall and
    // not a painted grid: each window gets a pale bar either side of it. In the
    // WALL plane (cell, not pcell): the stone is on the face, not recessed.
    float upper = capped * step(groundH, vUv.y);
    float trimLod = 0.0;
    float sillShadow = 0.0;
    if (detailOn > 0.5 && fp.sillM > 0.01) {
      float sillH = fp.sillM / fp.storeyM;
      float ext = 0.09 / fp.columnM;
      float inX = smoothstep(fp.win.x - ext - w.x, fp.win.x - ext + w.x, cell.x)
                * smoothstep(fp.win.y + ext + w.x, fp.win.y + ext - w.x, cell.x);
      float sill = smoothstep(fp.win.z - sillH - w.y, fp.win.z - sillH + w.y, cell.y)
                 * smoothstep(fp.win.z + w.y, fp.win.z - w.y, cell.y);
      float lintelH = sillH * 1.6;
      float lintel = smoothstep(fp.win.w - w.y, fp.win.w + w.y, cell.y)
                   * smoothstep(fp.win.w + lintelH + w.y, fp.win.w + lintelH - w.y, cell.y);
      float trimMask = inX * (sill + lintel);
      float trimMean = (winMeanX + 2.0 * ext) * (sillH + lintelH);
      trimLod = mix(trimMean, trimMask, detail) * upper * (1.0 - win);
      // The trim stone is its own scan: limestone under a brick wall.
      vec3 trimRatio = matOn > 0.5 && trimLod > 0.01
        ? sampleMat(${Mat.Limestone}.0, vUv + vec2(0.0, 0.31)).ratio : vec3(1.0);
      albedo = mix(albedo, fp.trim * trimRatio, trimLod);
      // A sill projects about 40 mm and throws a line of shadow just under it.
      float under = smoothstep(fp.win.z - sillH - 0.07 / fp.storeyM - w.y, fp.win.z - sillH, cell.y)
                  * smoothstep(fp.win.z - sillH + w.y, fp.win.z - sillH - w.y, cell.y);
      sillShadow = inX * under * detail * upper;
      // Its top face looks at the sky.
      n = normalize(n + upDir * 0.35 * inX * sill * detail * upper);
    }

    // --- THE CORNICE BAND ------------------------------------------------------
    //
    // The archetypes that have a projecting cornice get it drawn as a band of
    // trim at the wall head: a fascia, a row of dentils under it, and the
    // shadow the projection throws down the wall, whose length is the
    // projection times the tangent of the sun's elevation seen in the wall's
    // own plane. Geometry carries the silhouette where the LOD affords it (see
    // addCornice); this is what every other building and every distance gets.
    float corniceShadow = 0.0;
    if (detailOn > 0.5 && fp.corniceM > 0.01) {
      float bandH = 0.45 + 0.75 * fp.corniceM;
      float belowTopC = bldH - vUv.y;
      float aaY = max(fwidth(vUv.y), 1e-3);
      float band = smoothstep(bandH + aaY, bandH - aaY, belowTopC) * capped;
      float dentRow = smoothstep(bandH + 0.18 + aaY, bandH + 0.18 - aaY, belowTopC) * (1.0 - band) * capped;
      float aaX = max(fwidth(vUv.x), 1e-3);
      float dent = step(0.5, fract(vUv.x / 0.22)) * (1.0 - clamp(aaX / 0.11, 0.0, 1.0)) + 0.5 * clamp(aaX / 0.11, 0.0, 1.0);
      albedo = mix(albedo, fp.trim * 0.95, band);
      albedo = mix(albedo, fp.trim * 0.55, dentRow * dent);
      // The underside of the projection is in its own shade from any sun.
      albedo *= 1.0 - 0.45 * smoothstep(bandH - 0.12 - aaY, bandH - 0.12 + aaY, belowTopC) * band;
      float sElev = uSunDir.y / max(dot(uSunDir, n) + 0.02, 0.15);
      float shadowLen = min(3.0, fp.corniceM * max(sElev, 0.0));
      corniceShadow = smoothstep(bandH + shadowLen + aaY, bandH + shadowLen - aaY, belowTopC)
                    * (1.0 - band) * capped * step(0.02, dot(uSunDir, n));
    }
    revealShade *= 1.0 - 0.85 * max(corniceShadow, sillShadow * 0.7);

    // --- WEATHERING ------------------------------------------------------------
    //
    // Age from the archetype: a 1900 walk-up is sooted and streaked, a 2010
    // curtain wall is not. Three things a real wall shows and a model never does:
    //   * rain streaks under every sill, where water runs off and carries dirt;
    //   * grime rising from the pavement, splash and rising damp, worst at the base;
    //   * soot in broad vertical drifts on old masonry.
    // All darken the ALBEDO, because they are dirt on the surface, and all are
    // continuous noise except the streak edges, which fade with the footprint.
    if (detailOn > 0.5) {
      float age = fp.age;
      float baseGrime = (1.0 - smoothstep(0.0, 3.2, vUv.y))
                      * (0.55 + 0.45 * vnoise(vec2(vUv.x * 0.9, vUv.y * 1.7) + fp.seed * 11.0));
      float soot = smoothstep(0.30, 0.90, vnoise(vec2(vUv.x * 0.16, vUv.y * 0.035) + fp.seed * 31.0))
                 * (0.6 + 0.4 * vnoise(vec2(vUv.x * 1.3, vUv.y * 0.25)));
      // Streaks: the window's x-range, falling from the sill, with a streaky
      // profile across it so it is drips and not a shadow.
      float belowSill = (fp.win.z - cell.y) * fp.storeyM;
      float streakX = smoothstep(fp.win.x - w.x, fp.win.x + 0.05 + w.x, cell.x)
                    * smoothstep(fp.win.y + w.x, fp.win.y - 0.05 - w.x, cell.x)
                    * (0.35 + 0.65 * vnoise(vec2(vUv.x * 7.0, floorIdx * 3.1 + fp.seed)));
      float streak = streakX * step(0.0, belowSill) * exp(-belowSill / 1.1) * upper;
      float streakLod = mix(winMeanX * 0.45 * 0.6, streak, detailX);
      // Under the cornice the same water runs off the whole width of the wall.
      float underTop = bldH - vUv.y;
      float corniceDrip = fp.corniceM > 0.01
        ? smoothstep(0.4 + 0.75 * fp.corniceM + 2.5, 0.4 + 0.75 * fp.corniceM, underTop) * (1.0 - smoothstep(0.0, 0.4 + 0.75 * fp.corniceM, underTop) * 0.0)
          * (0.4 + 0.6 * vnoise(vec2(vUv.x * 2.5, 3.0)))
        : 0.0;
      float dirt = 0.20 * baseGrime + 0.20 * soot + 0.22 * streakLod * (1.0 - win) + 0.15 * corniceDrip;
      albedo *= 1.0 - age * dirt;
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
    float mortarFade = detailY * detailX * fp.relief * (1.0 - matOn);
    // The scan's own normal map replaces the ruled mortar: it has the real
    // joints, the real arrises and the real tooling in it. Faded by the pixel
    // footprint like everything else, though the mips already flatten it.
    n = normalize(n + (uDir * wallMat.nT.x + upDir * wallMat.nT.y) * 0.75 * matOn * min(detailX + 0.3, 1.0)
                      * (1.0 - win));
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
      // A ROOM, NOT A LIT RECTANGLE. The pane's brightness follows the room
      // behind it (a bright ceiling at the head, a dim floor at the cill, the
      // furniture as a dark band), a blind or a curtain still glows dimly with
      // the lamp behind it, and the sash bars stay dark. The room's own
      // luminance is divided by its mean (0.40, measured over the analytic
      // rooms at night) so the near field keeps the brightness the normaliser
      // above was built for.
      float paneY = smoothstep(fp.win.z - w.y, fp.win.z + w.y, cell.y)
                  * smoothstep(fp.win.w + w.y, fp.win.w - w.y, cell.y);
      float litYD = mix(litY, max(litY, paneY * 0.35), detailOn);
      float roomLum = dot(roomC, vec3(0.299, 0.587, 0.114));
      float glow = mix(1.0, mix(clamp(roomLum / 0.40, 0.3, 2.5), 0.6, curtainCov), detailOn)
                 * (1.0 - frameLod);
      float profile = (winX * litYD * glow * (1.0 - winObj) + ${SPILL_LEVEL} * halo) * (winMean / max(profileMean, 1e-4));

      // Correlated occupancy: cores, then floors, then tenancies, then the
      // individual window. See facade.ts -- an independent coin per cell is
      // exactly what produced a checkerboard.
      float litPattern = facadeLit(fp, colIdx, floorIdx, heightFade) * profile * openPick * capped;
      float occ = facadeMeanOccupancy(fp, heightFade);
      // Same treatment as the window pattern: resolve individual lit windows
      // up close, converge to the average glow of a lit building far away. The
      // far-field term is untouched by the blinds and the spill, which is the
      // whole point of the normaliser above.
      // NIGHT WINDOWS ARE BAND-LIMITED LIKE EVERYTHING ELSE.
      //
      // Each level of the lit pattern (the single window, then its floor and
      // tenancy, then the facade mean) hands over to the next as ITS feature
      // goes under a pixel, never later: a lit window is a hard on/off per
      // cell, and point-sampling it once a cell is about a pixel wide makes
      // the night city twinkle as the camera moves (the owner's report: "too
      // sparkly"). Nothing here depends on time, so a still frame is steady.
      //
      // The window level converges at 1.3 pixel footprints per cell, a little
      // later than the day pattern's 1.6 because a lit window is the brightest
      // thing in the frame and losing it early leaves towers as flat slabs.
      // ?nomip=1 removes every one of these filters, the probe for the night
      // shimmer measure in tools/verify-buildings.ts.
      float sharpN = uMatNoMip * detailOn;
      float detailN = mix(mix(detail, 1.0 - clamp(max(w.x, w.y) * 1.3, 0.0, 1.0), detailOn), 1.0, sharpN);
      // AND A LIT FLOOR IS A STRIPE LONG AFTER ITS WINDOWS ARE NOT. Between the
      // single window and the facade mean there is a middle scale: the floor
      // and the tenancy, several metres of lit glass, bigger than a pixel to
      // three or four kilometres. Averaging straight from the window to the
      // facade mean turned every distant tower into one flat grey-orange slab.
      // This level keeps the core, floor and tenancy gates and averages only
      // the window's own coin, so its mean is still facadeMeanOccupancy.
      //
      // It is BOX-FILTERED over the pixel footprint: the floor and the column
      // at either edge of the footprint are both evaluated and weighted by how
      // much of the pixel each covers, so a floor line crossing a pixel fades
      // across it instead of snapping from one floor's state to the next.
      float y0 = grid.y - 0.5 * w.y, y1 = grid.y + 0.5 * w.y;
      float x0 = grid.x - 0.5 * w.x, x1 = grid.x + 0.5 * w.x;
      float fA = floor(y0), fB = floor(y1);
      float cA = floor(x0), cB = floor(x1);
      float wy1 = fB > fA ? clamp((y1 - fB) / max(w.y, 1e-4), 0.0, 1.0) : 0.0;
      float wx1 = cB > cA ? clamp((x1 - cB) / max(w.x, 1e-4), 0.0, 1.0) : 0.0;
      wy1 *= 1.0 - sharpN; wx1 *= 1.0 - sharpN;
      float bAA = facadeLitBlock(fp, cA, fA, heightFade), bBA = facadeLitBlock(fp, cB, fA, heightFade);
      float bAB = facadeLitBlock(fp, cA, fB, heightFade), bBB = facadeLitBlock(fp, cB, fB, heightFade);
      float blockF = mix(mix(bAA, bBA, wx1), mix(bAB, bBB, wx1), wy1);
      float blockLit = blockF * winMean * openMean * capped;
      float detailBlock = (1.0 - smoothstep(0.45, 0.9, w.y)) * (1.0 - smoothstep(0.45, 0.9, w.x / fp.tenantW));
      detailBlock = mix(detailBlock, 1.0, sharpN);
      // At 0.75, not 1: a tenancy seen as one block of solid light reads as a
      // white rectangle, where a real distant floor is a row of windows with
      // dark mullions and dark rooms in it. Its mean is still occ.
      float farLit = mix(occ * winMean * openMean, blockLit, 0.75 * detailBlock * detailOn);
      float lit = mix(farLit, litPattern, detailN);

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
                      detailN);

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
                       detailN);

      // The number to watch is not the peak, it is the MEAN. Far away this
      // converges to occupancy x winMean x scale over the whole facade, and at
      // 0.2 that mean was about four times the wall's own night lighting: a
      // warm wash over every surface, which is what made the city read tan
      // however neutral the skyglow and the albedo were made. At 0.09 the mean
      // sits at roughly the wall, so a building is dark with lit windows in
      // it, and the peak is still 12x the wall up close where it should be.
      // The room's own colour tints the lamp: a white office ceiling, a
      // timber floor, a red curtain. Half strength, renormalised to luminance
      // so it moves hue and not the mean.
      vec3 roomTint = mix(vec3(1.0), roomC / max(roomLum, 1e-3) * 0.6 + 0.4, 0.5 * detailOn * detailN);
      emissive += warm * roomTint * gain * lit * uNight * 0.09 * (1.0 - fireEsc);

      // Shopfronts. A lit shop window is far brighter than a flat above it and
      // it is at eye height, so it carries the night street the way the lit
      // office windows carry the night skyline. Roughly half of them are lit,
      // per building, because a parade at midnight is not all open.
      if (ground > 0.5) {
        float open_ = step(0.45, hash11(fp.seed * 23.0 + 3.0));
        if (shopDetail) {
          // Per unit now, and the room behind the glass is what glows: its
          // luminance over the room mean (0.36), so the street's mean stays.
          open_ = shopOpen;
          // Tinted by the room, not just scaled by it, and under a third of
          // the old flat glow: at 0.26 (and still at 0.13) a lit unit
          // tonemapped to a white card with nothing in it, where a real one
          // shows its shelves.
          emissive += vec3(1.0, 0.90, 0.76) * shopRoom / 0.36 * glassMask * uNight * open_ * 0.08;
          // The sign's own light: lettering at a few times a lit window.
          emissive += signColour * signInk * signLit * uNight * 0.55;
        } else {
          emissive += vec3(1.0, 0.88, 0.70) * glassMask * uNight * open_ * 0.26;
        }
      }
    }

    // --- FLOODLIT CROWN --------------------------------------------------
    // Past 150 m the top of a tower is lit from below after dark: the Empire
    // State's white, the Chrysler's crown, the setback stages of every Deco
    // tower in Midtown. The top tenth of each record (14 m at least), so a
    // tower mapped as setback parts lights every setback, which is what the
    // real ones do. Brighter toward the top, where the lamps on the setback
    // below are aimed.
    if (uNight > 0.02 && bldH >= 150.0 && detailOn > 0.5) {
      float crownH = max(14.0, 0.10 * bldH);
      float ct = clamp((vUv.y - (bldH - crownH)) / crownH, 0.0, 1.0);
      float crown = step(bldH - crownH, vUv.y) * (0.35 + 0.65 * ct);
      emissive += floodColour(fp) * crown * uNight * (0.10 + 0.5 * dot(albedo, vec3(0.333)));
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

    // WHAT THE ROOF IS COVERED IN.
    //
    // From 300 m up a city IS its roofs, and every roof here was the same grey
    // with the same grain. Now each building's cover comes from the archetype's
    // roof survey (render/archetype.ts, ROOF_SURVEY) or from roof:material where
    // OSM has it: black tar, aluminium-coated tar, ballast gravel, white TPO,
    // black EPDM, sedum, or a paver deck, at its own aged albedo with a per-
    // building jitter. On top of that: the dirt line along the parapet where
    // water and grit collect, ponding stains, re-covered patches with seams,
    // and per-roof features (a solar array, skylights, a deck) laid out in the
    // roof's own frame (uv is local metres along and across, see addBuilding),
    // so they sit INSIDE the roof. The grey above is the ?flatfacade path.
    //
    // ?oneroof=1 forces one cover and one colour on every roof while keeping
    // the textures, the soiling and the features: the probe that proves the
    // inter-roof variety the gate measures comes from the per-building choice.
    if (detailOn > 0.5) {
      int rc = int(fp.roofCover + 0.5);
      vec3 cover = fp.roofColour;
      if (uOneRoof > 0.5) { rc = 0; cover = vec3(0.11, 0.11, 0.105); }
      vec2 lp = vUv;                                   // roof-local metres
      vec2 hl = vec2(max(fp.roofHalfL, 1.0), max(fp.roofHalfW, 1.0));
      float edgeD = min(hl.x - abs(lp.x), hl.y - abs(lp.y));   // to the box edge, m
      float aaR = max(fwidth(lp.x), 1e-3);
      float soil = 0.84 + 0.32 * g;
      if (rc == 2 && matOn > 0.5) {
        cover *= sampleMat(${Mat.Gravel}.0, vWorld.xz).ratio;
      } else if ((rc == 0 || rc == 1) && matOn > 0.5) {
        vec3 tr = sampleMat(${Mat.Tar}.0, vWorld.xz).ratio;
        cover *= rc == 0 ? tr : mix(vec3(1.0), tr, 0.35);
      } else if (rc == 6 && matOn > 0.5) {
        cover *= sampleMat(${Mat.Precast}.0, vWorld.xz).ratio;
      }
      if (rc == 3 || rc == 4) {
        // Membrane comes in 3 m sheets with a welded lap, run along the roof.
        float sh = lp.y / 3.05;
        float swd = max(fwidth(sh), 1e-3);
        float seam = (1.0 - smoothstep(0.0, max(0.03, swd), fract(sh))) * (1.0 - clamp(swd * 1.6, 0.0, 1.0));
        cover *= 1.0 - 0.10 * seam;
        // Ponding: dirt dries in rings where water stood, darker on white.
        float pond = smoothstep(0.62, 0.8, vnoise(lp * 0.13 + fp.seed * 5.0));
        cover *= 1.0 - (rc == 3 ? 0.18 : 0.10) * pond;
      } else if (rc == 5) {
        // Sedum: patchy green and straw-brown, in 0.6 m trays.
        float sed = vnoise(lp * 1.3 + fp.seed);
        cover = mix(cover, vec3(0.11, 0.09, 0.05), 0.45 * smoothstep(0.55, 0.85, sed));
        vec2 tray = abs(fract(lp / 0.6) - 0.5);
        cover *= 1.0 - 0.15 * step(0.46, max(tray.x, tray.y)) * (1.0 - clamp(aaR / 0.3, 0.0, 1.0));
      } else if (rc == 6) {
        // Pavers: 0.6 m squares on pedestals, open joints, a few lighter ones.
        vec2 pv = lp / 0.61;
        vec2 jv = abs(fract(pv) - 0.5);
        float jw = max(fwidth(pv.x), 1e-3);
        float joint = step(0.47, max(jv.x, jv.y)) * (1.0 - clamp(jw * 1.6, 0.0, 1.0));
        cover *= (1.0 - 0.45 * joint) * (0.9 + 0.2 * hash21(floor(pv) + fp.seed * 3.0));
      }
      // Coating over tar wears through in patches.
      if (rc == 1) cover = mix(cover, vec3(0.05), 0.4 * smoothstep(0.62, 0.7, vnoise(lp * 0.2 + fp.seed * 3.0)));
      // Re-covered sections: a rectangle of fresher or older product with a
      // hard edge, in the roof's own frame so the edges run with the walls.
      vec2 pc = floor(lp / vec2(4.0, 3.0) + fp.seed * 17.0);
      float patchOn = step(0.80, hash21(pc));
      cover *= 1.0 + patchOn * (hash21(pc + 7.1) - 0.55) * 0.25;
      // The dirt line: grit and standing water collect against the parapet.
      cover *= 1.0 - 0.28 * (1.0 - smoothstep(0.0, 1.3, edgeD));

      // --- Features ---
      int feat = int(fp.roofFeatures + 0.5);
      float glassy = 0.0;
      if ((feat & 1) != 0 && hl.x > 4.0 && hl.y > 3.0) {
        // A solar array: rows of 1.0 x 1.7 m modules tilted south, inside a
        // setback from the parapet, over most of the roof.
        vec2 inA = hl - vec2(1.6, 1.4);
        float inside = step(abs(lp.x), inA.x) * step(abs(lp.y), inA.y);
        vec2 m = vec2(lp.x / 1.04, lp.y / 2.1);
        vec2 mf = fract(m);
        float mw = max(fwidth(m.x), 1e-3);
        float cell = step(0.03, mf.x) * step(mf.x, 0.97) * step(0.08, mf.y) * step(mf.y, 0.86);
        float panel = inside * mix(0.8 * 0.86, cell, 1.0 - clamp(mw * 1.6, 0.0, 1.0));
        vec3 pv = vec3(0.025, 0.032, 0.055) * (1.0 + 0.6 * step(0.5, fract(lp.x * 6.0)) * (1.0 - clamp(mw * 8.0, 0.0, 1.0)));
        cover = mix(cover, pv, panel);
        glassy = max(glassy, panel);
      }
      if ((feat & 2) != 0) {
        // Skylights and a roof hatch: one to three small glazed boxes along
        // the roof's long axis.
        for (int k = 0; k < 3; k++) {
          float hk = hash21(vec2(fp.seed * 31.0 + float(k), 2.0));
          if (k > 0 && hk < 0.5) continue;
          vec2 c = vec2((hash21(vec2(fp.seed, float(k) + 4.0)) - 0.5) * max(hl.x - 2.0, 0.0),
                        (hash21(vec2(fp.seed, float(k) + 8.0)) - 0.5) * max(hl.y - 1.5, 0.0));
          vec2 sz = vec2(0.6 + 0.5 * hk, 0.5 + 0.3 * hk);
          vec2 d = abs(lp - c) - sz;
          float box = 1.0 - smoothstep(-aaR, aaR, max(d.x, d.y));
          float rim = box * smoothstep(-0.12 - aaR, -0.12 + aaR, max(d.x, d.y));
          cover = mix(cover, mix(vec3(0.06, 0.07, 0.08), vec3(0.35), rim), box);
          glassy = max(glassy, box * (1.0 - rim));
        }
      }
      if ((feat & 4) != 0 && rc != 6) {
        // A deck on part of the roof.
        float deck = step(lp.x, -hl.x * 0.2) * step(1.0, edgeD);
        cover = mix(cover, vec3(0.30, 0.22, 0.15) * (0.85 + 0.3 * step(0.5, fract(lp.y / 0.14))), deck);
      }
      albedo = cover * soil;
      // Panels and skylights are glass: give them the sky.
      glassMask = glassy * 0.9;
      roughness = mix(0.9, 0.08, glassy);
    }
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
    if (detailOn > 0.5) {
      // Plant comes in a few finishes: galvanised, factory beige, white, and
      // the bulkhead is usually the building's own brick or a tar-black box.
      vec2 cid = floor(vWorld.xz / 3.0);
      float f = hash21(cid + fp.seed * 9.0);
      vec3 fin = f < 0.45 ? vec3(0.34, 0.35, 0.36) : f < 0.7 ? vec3(0.42, 0.39, 0.32)
               : f < 0.85 ? vec3(0.55, 0.56, 0.55) : fp.colour * 0.8;
      albedo = fin * (0.85 + 0.3 * g);
      if (isRoof > 0.5) {
        // Fans on top of the condensers: dark discs on a 1.2 m pitch.
        vec2 fc = fract(vWorld.xz / 1.2) - 0.5;
        float fw = max(fwidth(vWorld.x / 1.2), 1e-3);
        float fan = (1.0 - smoothstep(0.32 - fw, 0.32 + fw, length(fc))) * (1.0 - clamp(fw * 2.0, 0.0, 1.0));
        albedo *= 1.0 - 0.6 * fan * step(0.45, f) * step(f, 0.85);
      }
    }
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
    // 0.40, not 0.55, with the archetype facade: walls at night were reading
    // as pale grey slabs (measured on manhattan-night, the wall at 2 km came out
    // brighter than the lit windows' far-field mean), and a real night skyline
    // is dark masonry with light in it.
    albedo = mix(albedo, vec3(ng * mix(0.55, 0.40, detailOn)), uNight * 0.88);
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
  if (uTerrainDebug > 0.5) fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  if (uBuildingDebug > 0.5) {
    // The GEOMETRIC normal, not the relief-perturbed n the Fresnel term uses:
    // this is classifying FACES, and the per-pixel bump would scatter pixels
    // across the threshold inside one wall and blur the two populations into
    // each other. The face angle is what the classification is about.
    float faceCos = clamp(dot(v, normalize(vNormal)), 0.0, 1.0);
    float graze = uBuildingDebug > 1.5 ? step(faceCos, GRAZE_COS) : 1.0;
    fragColor = vec4(0.0, 0.0, facadeMarker * graze, 1.0);
    // ?buildingDebug=3: each FLAT ROOF in one of six saturated colours keyed
    // on its building, everything else black, so tools/verify-buildings.ts can
    // cut a top-down frame into roofs and measure each roof's own mean colour.
    // Six classes survive the tonemap as which channels are on; two touching
    // roofs share a class one time in six and are then measured as one.
    if (uBuildingDebug > 2.5) {
      float cls = mod(floor(hash11(bidx * 0.618 + 0.5) * 6.0), 6.0);
      vec3 c = cls < 0.5 ? vec3(1, 0, 0) : cls < 1.5 ? vec3(0, 1, 0) : cls < 2.5 ? vec3(0, 0, 1)
             : cls < 3.5 ? vec3(1, 1, 0) : cls < 4.5 ? vec3(1, 0, 1) : vec3(0, 1, 1);
      fragColor = vec4(c * step(0.5, part) * step(part, 1.5), 1.0);
    }
    // ?buildingDebug=4: every building fragment, roofs and spires included,
    // pure green: the silhouette tools/verify-buildings.ts reads a skyline off.
    if (uBuildingDebug > 3.5) fragColor = vec4(0.0, 1.0, 0.0, 1.0);
    // ?buildingDebug=5: only the facade fragments inside the GROUND storey:
    // the shopfront band the night shopfront claim measures over.
    if (uBuildingDebug > 4.5) fragColor = vec4(0.0, groundMarker, 0.0, 1.0);
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
  /** 1 restores the pre-archetype facade; `?flatfacade=1`. */
  uFlatFacade: THREE.IUniform<number>;
  /** 1 gives every flat roof one cover and colour; `?oneroof=1`, the roof gate's probe. */
  uOneRoof: THREE.IUniform<number>;
  uFlatShop: THREE.IUniform<number>;
  uSignAtlas: THREE.IUniform<THREE.Texture | null>;
  uSignReady: THREE.IUniform<number>;
  /** Non-zero while the terrain draws a debug mask; buildings then draw black. */
  uTerrainDebug: THREE.IUniform<number>;
  /** 1 samples the scans without mips; `?nomip=1`, the aliasing probe. */
  uMatNoMip: THREE.IUniform<number>;
  /** The photographed material arrays; see render/materialtex.ts. Null until loaded. */
  uMatAlbedo: THREE.IUniform<THREE.DataArrayTexture | null>;
  uMatNormal: THREE.IUniform<THREE.DataArrayTexture | null>;
  uMatRH: THREE.IUniform<THREE.DataArrayTexture | null>;
  uMatInfo: THREE.IUniform<THREE.Vector4[]>;
  uMatMean: THREE.IUniform<THREE.Vector3[]>;
  uMatReady: THREE.IUniform<number>;
  uMatCheap: THREE.IUniform<number>;
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
    uFlatFacade: { value: 0 },
    uOneRoof: { value: 0 },
    uFlatShop: { value: 0 },
    uSignAtlas: { value: null },
    uSignReady: { value: 0 },
    uMatNoMip: { value: 0 },
    uTerrainDebug: { value: 0 },
    uMatAlbedo: { value: null },
    uMatNormal: { value: null },
    uMatRH: { value: null },
    uMatInfo: { value: Array.from({ length: MAT_COUNT }, () => new THREE.Vector4(1, 1, 0, 0)) },
    uMatMean: { value: Array.from({ length: MAT_COUNT }, () => new THREE.Vector3(1, 1, 1)) },
    uMatReady: { value: 0 },
    uMatCheap: { value: 0 },
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
    // A walk-up's bulkhead is a stair hatch, 2.5 x 3 m; an office overrun is
    // a lift motor room twice that. Scaled by the roof it stands on so a 7 m
    // brownstone still gets one that fits.
    const fit = Math.min(1, Math.min(spanX, spanZ) / 14);
    const hx = isOverrun ? (1.2 + 3.0 * fit) * (0.6 + 0.4 * r1) : 1.1 + 1.6 * r1;
    const hz = isOverrun ? (1.1 + 2.8 * fit) * (0.6 + 0.4 * r2) : 1.0 + 1.5 * r2;
    const hy = isOverrun ? 2.6 + 2.0 * fit * r3 : 0.9 + 1.6 * r3;
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
 * One planar quad, wound so its GEOMETRIC normal agrees with the shading
 * normal given, whatever order the corners came in. The tank is built from
 * dozens of these at arbitrary angles, and working each winding out by hand is
 * exactly how the walls and the roofs both once shipped inside out.
 */
function quad(
  s: Scratch,
  a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[],
  nrm: readonly number[], uvs: readonly number[], bidx: number, bldH: number, isRoof: number, part: number,
): void {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const flip = g[0] * nrm[0] + g[1] * nrm[1] + g[2] * nrm[2] < 0;
  const v = s.pos.length / 3;
  for (const p of [a, b, c, d]) s.pos.push(p[0], p[1], p[2]);
  for (let k = 0; k < 4; k++) {
    s.nrm.push(nrm[0], nrm[1], nrm[2]);
    s.uv.push(uvs[k * 2], uvs[k * 2 + 1]);
    s.info.push(bidx, bldH, isRoof, part);
  }
  if (flip) s.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
  else s.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
}

/** A steel box (a leg or the deck), four sides and a lid. */
function steelBox(s: Scratch, cx: number, cz: number, hx: number, hz: number, y0: number, y1: number, bidx: number, bldH: number): void {
  const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz;
  const st = [0, -1, 0, -1, 0, -1, 0, -1];
  quad(s, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], st, bidx, bldH, 0, PART_TANK);
  quad(s, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], st, bidx, bldH, 0, PART_TANK);
  quad(s, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], st, bidx, bldH, 0, PART_TANK);
  quad(s, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], st, bidx, bldH, 0, PART_TANK);
  quad(s, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], st, bidx, bldH, 1, PART_TANK);
}

/**
 * A New York wooden water tank: cedar staves bound with steel hoops, a
 * shallow conical lid, standing on a steel deck on four legs.
 *
 * Measured sizes: the common 10,000 gallon tank is about 12 ft (3.7 m) across
 * and 12-16 ft tall, on a stand that lifts it one storey clear of the roof so
 * gravity gives the top floors pressure. Sizes jitter per building.
 */
function addWaterTank(s: Scratch, b: Building, top: number, bidx: number, bldH: number, seed: number): boolean {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < b.ring.length; i += 2) {
    minX = Math.min(minX, b.ring[i]); maxX = Math.max(maxX, b.ring[i]);
    minZ = Math.min(minZ, b.ring[i + 1]); maxZ = Math.max(maxZ, b.ring[i + 1]);
  }
  const r = 1.5 + 0.6 * hash3(seed, 0xa00, 1);
  for (let attempt = 0; attempt < 8; attempt++) {
    // Tanks sit toward the back or side of a roof, near the stair core; any
    // spot the whole stand fits in will do.
    const px = minX + (maxX - minX) * (0.2 + 0.6 * hash3(seed, 0xa10 + attempt, 1));
    const pz = minZ + (maxZ - minZ) * (0.2 + 0.6 * hash3(seed, 0xa10 + attempt, 2));
    const m = r + 0.4;
    if (!insideRing(b.ring, px - m, pz - m) || !insideRing(b.ring, px + m, pz - m) ||
        !insideRing(b.ring, px - m, pz + m) || !insideRing(b.ring, px + m, pz + m)) continue;
    const standH = 2.6 + 1.2 * hash3(seed, 0xa00, 2);
    const tankH = 3.6 + 1.4 * hash3(seed, 0xa00, 3);
    const lidH = 0.6 + 0.5 * hash3(seed, 0xa00, 4);
    const leg = r * 0.72;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      steelBox(s, px + sx * leg, pz + sz * leg, 0.11, 0.11, top, top + standH - 0.25, bidx, bldH);
    }
    steelBox(s, px, pz, r * 0.95, r * 0.95, top + standH - 0.25, top + standH, bidx, bldH);
    const y0 = top + standH, y1 = y0 + tankH, y2 = y1 + lidH;
    const N = 10;
    for (let k = 0; k < N; k++) {
      const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const p0 = [px + Math.cos(a0) * r, pz + Math.sin(a0) * r];
      const p1 = [px + Math.cos(a1) * r, pz + Math.sin(a1) * r];
      const u0 = a0 * r, u1 = a1 * r;
      quad(s, [p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]],
        [Math.cos(am), 0, Math.sin(am)], [u0, 0, u1, 0, u1, tankH, u0, tankH], bidx, bldH, 0, PART_TANK);
      // The lid: a triangle per stave, as a quad with its two top corners
      // meeting at the apex. Its normal leans out by the lid's rise.
      const sl = Math.hypot(r, lidH);
      quad(s, [p0[0], y1, p0[1]], [p1[0], y1, p1[1]], [px, y2, pz], [px, y2, pz],
        [Math.cos(am) * lidH / sl, r / sl, Math.sin(am) * lidH / sl], [u0, 0, u1, 0, u1, 1, u0, 1], bidx, bldH, 1, PART_TANK);
    }
    return true;
  }
  return false;
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

  // Sink the base so the walls meet sloping terrain instead of hovering. A
  // part standing on another part only needs to close the seam with the roof
  // under it: three metres would hang below a sky bridge or an overhang.
  const sunk = base - (b.baseM > 1.0 ? 0.3 : 3.0);

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
  const shaped = pitch ? null : shapedRoofFor(b, height);
  const eaveY = pitch ? top - pitch.rise : shaped ? top - shaped.rise : top;
  const wallTop = pitch || shaped ? eaveY : top + parapetM;

  // What the shader calls bldH, and it is the top of the WALL, not of the
  // building: it drives the ground-storey clamp, the `capped` that stops the
  // window grid, and the cornice band, and all three want the eave. Passing the
  // full height on a pitched building is what would put a row of windows in the
  // roof.
  //
  // Measured from the GROUND, not from this record's own base. A building:part
  // that starts at 115 m is a setback of the tower under it, and with v from
  // its own base it grew a shopfront, a plinth and street grime 115 m up. From
  // the ground, every part of one tower shares one storey grid and only the
  // record that actually reaches the street has a ground storey. For a record
  // with baseM = 0 (all but the parts) nothing changes.
  const wallH = eaveY - groundY;

  const pushInfo = (isRoof: number, part: number) => s.info.push(bidx, wallH, isRoof, part);

  // --- Walls ---
  const wallsFrom = s.idx.length;
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
    // v runs from 0 at the ground (not the sunk base) so the storey grid
    // lines up with the visible building rather than with the buried part.
    const vBot = sunk - groundY;
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
      s.uv.push(run, top - groundY, run + len, top - groundY, run + len, vTop, run, vTop);
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
  // The roof's own frame: along its longest edge and across it, centred on
  // the footprint. uv carries these local metres and the facade table carries
  // the half extents, so the shader can lay a solar array or a deck INSIDE the
  // roof and darken the dirt line along its parapet.
  let ax = 1, az = 0, best = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = b.ring[j * 2] - b.ring[i * 2], dz = b.ring[j * 2 + 1] - b.ring[i * 2 + 1];
    const l = Math.hypot(dx, dz);
    if (l > best) { best = l; ax = dx / l; az = dz / l; }
  }
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = b.ring[i * 2] - b.cx, z = b.ring[i * 2 + 1] - b.cz;
    const u = x * ax + z * az, w = -x * az + z * ax;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
  }
  const uc = (u0 + u1) / 2, wc = (w0 + w1) / 2;
  if (params) {
    params.roofHalfL = (u1 - u0) / 2;
    params.roofHalfW = (w1 - w0) / 2;
  }
  // A spire that is the whole record has no wall and no slab: it starts on
  // the roof of the part under it.
  if (shaped && eaveY - base < 0.5) s.idx.length = wallsFrom;
  const tri = shaped ? [] : triangulate(b.ring);
  if (tri.length) {
    const v0 = s.pos.length / 3;
    for (let i = 0; i < n; i++) {
      s.pos.push(b.ring[i * 2], eaveY, b.ring[i * 2 + 1]);
      s.nrm.push(0, 1, 0);
      const x = b.ring[i * 2] - b.cx, z = b.ring[i * 2 + 1] - b.cz;
      s.uv.push(x * ax + z * az - uc, -x * az + z * ax - wc);
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

  if (shaped) {
    addShapedRoof(s, b, shaped, eaveY, top, bidx, wallH);
    return;
  }
  if (pitch) {
    addTent(s, pitch, eaveY, top, groundY, bidx, wallH);
  } else if (extras.boxes > 0 || extras.overrun) {
    // Plant first, tank after: a tank that lands on a chiller is caught by the
    // tank's own inside test only against the ring, so the order just decides
    // which of the two gets the better spot, and the stair core wins.
    // Same veto as the parapet, and for the same reason: nothing stands on a
    // slope, and the gate forces the extras on for every building.
    addRoofPlant(s, b, top, extras, bidx, wallH, seed);
  }
  if (!pitch && extras.tank) addWaterTank(s, b, top, bidx, wallH, seed);
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
  const texels = params.length * FACADE_STRIDE;
  const height = Math.max(1, Math.ceil(texels / FACADE_TEX_WIDTH));
  const data = new Uint8Array(FACADE_TEX_WIDTH * height * 4);
  const scratch = new Float32Array(FACADE_FLOATS);
  for (let i = 0; i < params.length; i++) {
    packFacade(params[i], scratch, 0);
    const base = i * FACADE_STRIDE * 4;
    for (let v = 0; v < FACADE_FLOATS; v++) {
      const [lo, hi] = encodeFacadeValue(scratch[v]);
      data[base + v * 2] = lo;
      data[base + v * 2 + 1] = hi;
    }
    // The byte block follows the pairs; see FACADE_RAW_TEXELS.
    packFacadeRaw(params[i], data, base + FACADE_FLOATS * 2);
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

/**
 * ?flatparts=1, the probe for the silhouette claim in tools/verify-buildings.ts:
 * every building:part group put back to the box the pack used to draw, its
 * biggest footprint extruded from the ground to the tower's top, flat.
 */
export function flattenParts(bs: readonly Building[]): Building[] {
  const best = new Map<number, Building>();
  const top = new Map<number, number>();
  const area = (b: Building): number => Math.abs(signedArea(b.ring));
  for (const b of bs) {
    if (b.group === undefined) continue;
    const cur = best.get(b.group);
    if (!cur || area(b) > area(cur)) best.set(b.group, b);
    top.set(b.group, Math.max(top.get(b.group) ?? 0, b.topM));
  }
  const out: Building[] = [];
  for (const b of bs) {
    if (b.group === undefined) { out.push(b); continue; }
    if (best.get(b.group) !== b) continue;
    out.push({ ...b, baseM: 0, topM: top.get(b.group)!, roof: RoofShape.Flat, group: undefined, roofM: undefined });
  }
  return out;
}

/**
 * The detail-layer geometry of one building: awnings, a cornice, bay windows.
 * Everything here is relief that only reads from close by, so it is built
 * per camera position rather than once; see STREET_M.
 */
export function addDetail(
  s: Scratch, b: Building, groundY: number, bidx: number, p: FacadeParams, street: boolean, relief: boolean,
): void {
  if (b.baseM > 1.0) return;
  const n = b.ring.length / 2;
  const height = b.topM - b.baseM;
  if (n < 3 || height <= 0.5) return;
  const seed = p.seed * 4096;
  const pitch = pitchFor(b, height, seed);
  if (shapedRoofFor(b, height)) return;
  const top = groundY + b.topM;
  const eaveY = pitch ? top - pitch.rise : top;
  const wallH = eaveY - groundY;
  if (street && p.shopfront > 0.5 && !p.house) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = b.ring[i * 2], z0 = b.ring[i * 2 + 1];
      const dx = b.ring[j * 2] - x0, dz = b.ring[j * 2 + 1] - z0;
      const len = Math.hypot(dx, dz);
      if (len < 3.0) continue;
      addAwning(s, p, x0, z0, dx / len, dz / len, dz / len, -dx / len, len, groundY, bidx, wallH, seed + i * 31);
    }
  }
  if (!relief) return;
  // A bay runs up to the eave whatever the roof: the Painted Ladies are
  // gabled. A cornice only crowns a flat roof; a pitched one has its eave.
  if (p.corniceM > 0.01 && !pitch) addCornice(s, b, p, top, bidx, wallH);
  if (p.windowStyle === WindowStyle.Bay) {
    addBays(s, b, p, groundY, pitch ? eaveY + 0.45 + 0.75 * p.corniceM : top, bidx, wallH, seed);
  }
}

/**
 * A shop awning on one wall segment, on about a third of them: a sloped
 * fabric deck from just over the shop window head, 1.1 to 1.5 m out, and a
 * valance hanging off its front edge. Geometry because an awning is the one
 * thing at street level whose whole point is that it sticks out.
 *
 * The window head is the shader's headY: the ground storey less the fascia
 * (see the ground-storey branch), so the sign stays visible above it.
 */
function addAwning(
  s: Scratch, p: FacadeParams, x0: number, z0: number, ux: number, uz: number, nx: number, nz: number,
  len: number, groundY: number, bidx: number, wallH: number, seed: number,
): void {
  if (hash3(seed, 0xa3, 1) > 0.34) return;
  const groundH = Math.min(p.groundStoreyM, Math.max(1.2, wallH * 0.92));
  const fascia = 0.35 + 0.5 * p.shopfront;
  const head = groundH - fascia;
  if (head < 2.4) return;
  const span = Math.min(len - 0.6, 2.8 + 6.0 * hash3(seed, 0xa3, 2));
  const a0 = 0.3 + (len - 0.6 - span) * hash3(seed, 0xa3, 3);
  const out = 1.1 + 0.4 * hash3(seed, 0xa3, 4);
  const yTop = groundY + head + 0.12, yLow = yTop - 0.55, yVal = yLow - 0.28;
  const at = (a: number, o: number, y: number): number[] =>
    [x0 + ux * a + nx * o, y, z0 + uz * a + nz * o];
  const A = at(a0, 0.02, yTop), B = at(a0 + span, 0.02, yTop);
  const C = at(a0 + span, out, yLow), D = at(a0, out, yLow);
  const sl = Math.hypot(out, yTop - yLow);
  const deckN = [nx * (yTop - yLow) / sl, out / sl, nz * (yTop - yLow) / sl];
  // uv.x runs along the awning for the stripes; uv.y is the slope distance,
  // and the valance continues it so the stripes run on round the edge.
  quad(s, A, B, C, D, deckN, [a0, 0, a0 + span, 0, a0 + span, sl, a0, sl], bidx, wallH, 0, PART_AWNING);
  quad(s, D, C, at(a0 + span, out, yVal), at(a0, out, yVal), [nx, 0, nz],
    [a0, sl, a0 + span, sl, a0 + span, sl + 0.28, a0, sl + 0.28], bidx, wallH, 0, PART_AWNING);
  // The two cheeks, so it is not a sheet seen edge-on down the street.
  // Triangles, as quads whose last corner repeats: the winding is decided on
  // the first three, so those have to be the three distinct ones.
  const wA = at(a0, 0.02, yLow), wB = at(a0 + span, 0.02, yLow);
  quad(s, A, D, wA, wA, [-ux, 0, -uz], [a0, 0, a0, sl, a0, sl, a0, sl], bidx, wallH, 0, PART_AWNING);
  quad(s, B, C, wB, wB, [ux, 0, uz], [a0, 0, a0, sl, a0, sl, a0, sl], bidx, wallH, 0, PART_AWNING);
}

/**
 * THE CORNICE AS GEOMETRY. The shader paints the band on every building at
 * every distance; up close the painted band is a stripe, and what a walk-up
 * or a pre-war office actually has at its roof line is a moulding that
 * stands out 0.4 to 1.0 m and casts its own shadow down the wall. So inside
 * RELIEF_M the archetypes with a cornice get one: a soffit, a front face and
 * a top, run round the ring on a mitred outset so the corners close.
 * Same height band as the painted one (0.45 + 0.75 x projection), so the
 * geometry sits exactly on the band the far field draws.
 */
function addCornice(s: Scratch, b: Building, p: FacadeParams, top: number, bidx: number, wallH: number): void {
  const n = b.ring.length / 2;
  if (n < 3 || n > 96) return;
  const proj = Math.min(1.0, Math.max(0.3, p.corniceM));
  const bandH = 0.45 + 0.75 * p.corniceM;
  const y0 = top - bandH, y1 = top - 0.05;
  // Outward unit normals per edge, then a mitred offset per vertex.
  const enx: number[] = [], enz: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = b.ring[j * 2] - b.ring[i * 2], dz = b.ring[j * 2 + 1] - b.ring[i * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    enx.push(dz / l); enz.push(-dx / l);
  }
  const ox: number[] = [], oz: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n;
    let mx = enx[h] + enx[i], mz = enz[h] + enz[i];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) { mx = enx[i]; mz = enz[i]; } else { mx /= ml; mz /= ml; }
    // 1 / cos(half the turn), capped so a sharp corner does not spike out.
    const k = Math.min(2.0, 1 / Math.max(0.5, mx * enx[i] + mz * enz[i]));
    ox.push(b.ring[i * 2] + mx * proj * k);
    oz.push(b.ring[i * 2 + 1] + mz * proj * k);
  }
  let run = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = b.ring[i * 2], az = b.ring[i * 2 + 1], bx = b.ring[j * 2], bz = b.ring[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    // A short edge between two reflex corners can have its outset run
    // BACKWARDS (the mitres cross); that piece of moulding would be drawn
    // inside out, so it is left off and its neighbours close over it.
    const fold = (ox[j] - ox[i]) * (bx - ax) + (oz[j] - oz[i]) * (bz - az);
    if (len < 0.3 || fold <= 0) { run += len; continue; }
    const nx = enx[i], nz = enz[i];
    // The front leans out a little at the top, the way a crown moulding does.
    const lean = 0.25 * proj;
    const fA = [ox[i] - nx * lean, y0, oz[i] - nz * lean], fB = [ox[j] - nx * lean, y0, oz[j] - nz * lean];
    const tA = [ox[i], y1, oz[i]], tB = [ox[j], y1, oz[j]];
    const fl = Math.hypot(lean, y1 - y0);
    quad(s, fA, fB, tB, tA, [nx * (y1 - y0) / fl, -lean / fl, nz * (y1 - y0) / fl],
      [run, 0, run + len, 0, run + len, bandH, run, bandH], bidx, wallH, 0, PART_CORNICE);
    quad(s, [ax, y0, az], [bx, y0, bz], fB, fA, [0, -1, 0],
      [run, -1, run + len, -1, run + len, -1, run, -1], bidx, wallH, 0, PART_CORNICE);
    quad(s, tA, tB, [bx, y1 + 0.08, bz], [ax, y1 + 0.08, az], [0, 1, 0],
      [run, -2, run + len, -2, run + len, -2, run, -2], bidx, wallH, 1, PART_CORNICE);
    run += len;
  }
}

/**
 * SAN FRANCISCO BAY WINDOWS. The Victorian and Edwardian front is a canted
 * bay two or three storeys tall over the garage, and it is the single shape
 * that says "San Francisco" from the street. A row house in OSM is a narrow
 * deep footprint, so its street front is one of its two SHORT sides; each
 * short side gets a bay (the back gets one too, which real ones often have).
 *
 * The faces are ordinary wall as far as the shader is concerned, with uv.x
 * scaled so each face is exactly one window column: a canted bay is glazed
 * on all three faces, and the facade's own window grid draws them.
 */
function addBays(s: Scratch, b: Building, p: FacadeParams, groundY: number, top: number, bidx: number, wallH: number, seed: number): void {
  const n = b.ring.length / 2;
  if (n < 4 || n > 24) return;
  const obb = footprintObb(b.ring);
  if (!obb || obb.halfL < obb.halfW * 1.4) return;
  const groundH = Math.min(p.groundStoreyM, Math.max(1.2, wallH * 0.92));
  const y0 = groundY + groundH + 0.25;
  const y1 = top - (0.45 + 0.75 * p.corniceM) - 0.1;
  if (y1 - y0 < 1.6) return;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = b.ring[i * 2], az = b.ring[i * 2 + 1];
    const dx = b.ring[j * 2] - ax, dz = b.ring[j * 2 + 1] - az;
    const len = Math.hypot(dx, dz);
    // A short side: across the lot, so parallel to the OBB's SHORT axis.
    const along = Math.abs((dx * obb.ux + dz * obb.uz) / Math.max(len, 1e-6));
    if (len < 4.5 || len > 12 || along > 0.35) continue;
    const ux = dx / len, uz = dz / len, nx = dz / len, nz = -dx / len;
    const W = Math.min(len - 1.2, 3.4 + 0.8 * hash3(seed, 0xba, i));
    const depth = 0.75;
    // To one side, the entrance on the other.
    const a0 = hash3(seed, 0xbb, i) < 0.5 ? 0.5 : len - 0.5 - W;
    const P = (a: number, d: number, y: number): number[] => [ax + ux * a + nx * d, y, az + uz * a + nz * d];
    const c0 = a0, c1 = a0 + depth, c2 = a0 + W - depth, c3 = a0 + W;
    const col = p.columnM;
    const faces: [number, number, number, number][] = [[c0, 0, c1, depth], [c1, depth, c2, depth], [c2, depth, c3, 0]];
    for (let k = 0; k < 3; k++) {
      const [a1, d1, a2, d2] = faces[k];
      const ex = (a2 - a1) * ux + (d2 - d1) * nx, ez = (a2 - a1) * uz + (d2 - d1) * nz;
      const el = Math.hypot(ex, ez);
      const fnx = ez / el, fnz = -ex / el;
      const u0 = (k + 1) * col, u1 = u0 + col;
      quad(s, P(a1, d1, y0), P(a2, d2, y0), P(a2, d2, y1), P(a1, d1, y1), [fnx, 0, fnz],
        [u0, y0 - groundY, u1, y0 - groundY, u1, y1 - groundY, u0, y1 - groundY], bidx, wallH, 0, PART_WALL);
    }
    // The bay's own little roof and the soffit under it, in the cornice's
    // stone: one trapezoid each, the plan of the bay.
    quad(s, P(c0, 0, y1), P(c3, 0, y1), P(c2, depth, y1), P(c1, depth, y1), [0, 1, 0],
      [0, -2, 1, -2, 1, -2, 0, -2], bidx, wallH, 1, PART_CORNICE);
    quad(s, P(c0, 0, y0), P(c3, 0, y0), P(c2, depth, y0), P(c1, depth, y0), [0, -1, 0],
      [0, -1, 1, -1, 1, -1, 0, -1], bidx, wallH, 0, PART_CORNICE);
  }
}

/** A pyramid, spire or dome standing on a record's walls. */
export interface ShapedRoof {
  shape: RoofShape;
  rise: number;
}

/**
 * Whether a record gets a shaped roof, and how tall.
 *
 * OSM's height includes the roof, so the rise comes off the wall exactly as a
 * pitched roof's does. roof:height is believed when it was mapped. Without it:
 * a spire on a part standing above the ground, or on a footprint under 16 m
 * across, is the whole record (that is how the Chrysler's needle and most
 * crown stages are mapped); a pyramid or dome rises at 45 degrees off the
 * shorter half-width, at most half the record.
 *
 * The fan is built from the centroid, so it is only honest on a ring that is
 * star-shaped about it; anything else stays flat rather than folding over.
 */
export function shapedRoofFor(b: Building, height: number): ShapedRoof | null {
  const shape = b.roof;
  if (shape !== RoofShape.Pyramid && shape !== RoofShape.Tapered && shape !== RoofShape.Dome) return null;
  const n = b.ring.length / 2;
  if (n < 3 || n > 160 || height < 1.5) return null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = b.ring[i * 2] - b.cx, az = b.ring[i * 2 + 1] - b.cz;
    const bx = b.ring[j * 2] - b.cx, bz = b.ring[j * 2 + 1] - b.cz;
    if (ax * bz - az * bx <= 0) return null;
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, b.ring[i * 2]); x1 = Math.max(x1, b.ring[i * 2]);
    z0 = Math.min(z0, b.ring[i * 2 + 1]); z1 = Math.max(z1, b.ring[i * 2 + 1]);
  }
  const halfW = Math.min(x1 - x0, z1 - z0) / 2;
  let rise: number;
  if (b.roofM !== undefined) rise = b.roofM;
  else if (shape === RoofShape.Tapered && (b.baseM > 1 || halfW < 8)) rise = height;
  else rise = Math.min(halfW, 0.5 * height);
  rise = Math.min(rise, height);
  if (rise < 0.8) return null;
  return { shape, rise };
}

/**
 * The shaped roof itself: the ring drawn in towards its centroid as it rises,
 * linearly for a pyramid or spire, on a quarter circle for a dome (four bands).
 */
function addShapedRoof(s: Scratch, b: Building, r: ShapedRoof, eaveY: number, top: number, bidx: number, wallH: number): void {
  const n = b.ring.length / 2;
  const bands = r.shape === RoofShape.Dome ? 4 : 1;
  const at = (k: number): [number, number] => {
    const t = k / bands;
    return r.shape === RoofShape.Dome
      ? [Math.cos((t * Math.PI) / 2), eaveY + (top - eaveY) * Math.sin((t * Math.PI) / 2)]
      : [1 - t, eaveY + (top - eaveY) * t];
  };
  let run = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = b.ring[i * 2], az = b.ring[i * 2 + 1], bx = b.ring[j * 2], bz = b.ring[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    for (let k = 0; k < bands; k++) {
      const [s0, y0] = at(k), [s1, y1] = at(k + 1);
      const p = (x: number, z: number, sc: number, y: number): number[] =>
        [b.cx + (x - b.cx) * sc, y, b.cz + (z - b.cz) * sc];
      const A = p(ax, az, s0, y0), B = p(bx, bz, s0, y0), C = p(bx, bz, s1, y1), D = p(ax, az, s1, y1);
      // Face normal from the band's own slope: out along the edge normal, up
      // by how far the ring drew in over the rise.
      const ex = bx - ax, ez = bz - az;
      let nx = ez / Math.max(len, 1e-6), nz = -ex / Math.max(len, 1e-6);
      const mx = (ax + bx) / 2 - b.cx, mz = (az + bz) / 2 - b.cz;
      const dist = Math.abs(mx * nx + mz * nz);
      const inward = dist * (s0 - s1), up = y1 - y0;
      const l = Math.hypot(inward, up) || 1;
      const ny = inward / l;
      nx *= up / l; nz *= up / l;
      quad(s, A, B, C, D, [nx, ny, nz], [run, y0 - eaveY, run + len, y0 - eaveY, run + len, y1 - eaveY, run, y1 - eaveY],
        bidx, wallH, 1, PART_SPIRE);
    }
    run += len;
  }
}

/**
 * The building:part groups in a pack: for each group id, the record that
 * speaks for the whole tower (its tallest) and the tower's top. See
 * Building.group.
 */
export function partGroups(bs: readonly Building[]): Map<number, { lead: number; top: number }> {
  const out = new Map<number, { lead: number; top: number }>();
  for (let i = 0; i < bs.length; i++) {
    const id = bs[i].group;
    if (id === undefined) continue;
    const g = out.get(id);
    if (!g) out.set(id, { lead: i, top: bs[i].topM });
    else if (bs[i].topM > g.top) { g.lead = i; g.top = bs[i].topM; }
  }
  return out;
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
  /** Wooden water tanks placed. */
  tanks: number;
}

const DETAIL_CELL_M = 100;
/** Obstruction lighting threshold, metres above ground (FAA: 200 ft is the
 *  lowest; 150 m is where a skyline's lights read from the air). */
const WARNING_LIGHT_M = 150;

export class Buildings {
  readonly group = new THREE.Group();
  readonly uniforms: BuildingUniforms;
  readonly stats: BuildingStats;
  /** The camera-centred detail layer; see STREET_M. */
  readonly detail = new THREE.Group();
  private pack: CityPack | null = null;
  private params: FacadeParams[] = [];
  /** Pairs (pack index, facade index) of every drawn building. */
  private readonly detailOf: number[] = [];
  private readonly groundYOf = new Map<number, number>();
  private readonly detailCells = new Map<string, number[]>();
  private detailAt: { x: number; z: number } | null = null;
  private detailJob: { x: number; z: number; cells: number[][]; next: number; s: Scratch; sync: boolean } | null = null;
  /** Triangles in the detail layer as last built; -1 before the first build. */
  detailTriangles = -1;
  private warningMat: THREE.PointsMaterial | null = null;
  /** Detail radii; a phone gets a little over half of each. */
  private streetM = STREET_M;
  private reliefM = RELIEF_M;

  constructor(
    pack: CityPack,
    groundAt: (x: number, z: number) => number,
    shadow: SunShadowUniforms,
    budget: Budget,
  ) {
    this.uniforms = makeUniforms(shadow);
    // The photographs arrive after the city does; until then uMatReady is 0
    // and the shader draws the flat facade. A phone gets the 256 px strips and
    // one tiling tap instead of three.
    const reduced = budget.tier === "reduced";
    if (reduced) {
      this.streetM = 400;
      this.reliefM = 500;
    }
    this.uniforms.uMatCheap.value = reduced ? 1 : 0;
    void loadMaterialTextures(reduced, reduced ? 2 : 8).then((m) => {
      if (!m) return;
      const u = this.uniforms;
      u.uMatAlbedo.value = m.albedo;
      u.uMatNormal.value = m.normal;
      u.uMatRH.value = m.rh;
      u.uMatInfo.value = m.info;
      u.uMatMean.value = m.mean;
      u.uMatReady.value = 1;
    });
    const atlas = buildSignAtlas(regionAt(pack.lat0, pack.lon0));
    if (atlas) {
      this.uniforms.uSignAtlas.value = atlas;
      this.uniforms.uSignReady.value = 1;
    }
    const choices = assignArchetypes(pack);
    const tankAt = (i: number): boolean => {
      const c = choices?.[i];
      if (!c) return false;
      const b = pack.buildings[i];
      // The top above the street, not the record's own height: a tank is on a
      // six-to-twenty storey roof, wherever the part that carries it starts.
      return wantsWaterTank(ARCHETYPES[c.archetype], b.topM, i);
    };
    const lodK = solveLod(pack, budget.buildingTriangleBudget, tankAt);
    const groups = partGroups(pack.buildings);
    const cells = new Map<string, Scratch>();
    const params: FacadeParams[] = [];
    const families: number[] = new Array(5).fill(0);
    let drawn = 0;
    let skippedFar = 0;
    let skippedFlat = 0;
    let parapets = 0;
    let plantBoxes = 0;
    let tanks = 0;
    // `choices` (above, before the LOD solve, which has to cost the tanks):
    // what KIND of building each footprint is, decided over the whole pack at
    // once because it needs the neighbourhood (district) and the party walls
    // (coherence). Null outside the surveyed cities; see render/archetype.ts.

    for (let i = 0; i < pack.buildings.length; i++) {
      const b = pack.buildings[i];
      const dist = Math.hypot(b.cx, b.cz);
      const h = b.topM - b.baseM;
      if (b.topM < minHeightAt(dist, lodK)) { skippedFar++; continue; }

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
      if (b.topM < 8 && area > 20000) { skippedFlat++; continue; }

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
      //
      // Parts of one tower (b.group) take the seed, kind and height of the
      // whole tower, so its setbacks are one stone with one storey grid rather
      // than a stack of differently coloured boxes.
      const g = b.group !== undefined ? groups.get(b.group) : undefined;
      const fp = g
        ? facadeFor(pack.buildings[g.lead].kind, g.top, g.lead, choices?.[g.lead])
        : facadeFor(b.kind, h, i, choices?.[i]);
      const bidx = params.length;
      params.push(fp);
      families[fp.family]++;

      // A copy: roofExtras hands back the shared NO_EXTRAS constant, and the
      // tank flag below must not write through it into every building after.
      const extras = { ...roofExtras(dist, lodK, h, area, b.kind, b.roof) };
      if (dist < TANK_M / lodK && b.roof === RoofShape.Flat && tankAt(i)) {
        extras.tank = true;
        tanks++;
      }
      if (extras.parapet) parapets++;
      plantBoxes += extras.boxes + (extras.overrun ? 1 : 0);

      addBuilding(s, b, groundY, bidx, extras, fp);
      this.detailOf.push(i, bidx);
      this.groundYOf.set(i, groundY);
      drawn++;
    }
    this.pack = pack;
    this.params = params;
    for (let k = 0; k < this.detailOf.length; k += 2) {
      const b = pack.buildings[this.detailOf[k]];
      const key = `${Math.floor(b.cx / DETAIL_CELL_M)},${Math.floor(b.cz / DETAIL_CELL_M)}`;
      const l = this.detailCells.get(key);
      if (l) l.push(k); else this.detailCells.set(key, [k]);
    }
    this.group.add(this.detail);
    this.addWarningLights(pack);

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
      parapets, plantBoxes, families, tanks,
    };
  }

  /**
   * AIRCRAFT WARNING LIGHTS. Every structure past 150 m carries red
   * obstruction lights at its top corners (FAA AC 70/7460-1, L-810/L-864),
   * and after dark they are what a skyline seen from the air is punctuated
   * by. One red point per corner of each tower's highest record, and one on a
   * spire's tip; a fixed pixel size, because a lamp is a point at any range.
   */
  private addWarningLights(pack: CityPack): void {
    const tallest = new Map<number, number>();
    for (let k = 0; k < this.detailOf.length; k += 2) {
      const i = this.detailOf[k], b = pack.buildings[i];
      if (b.topM < WARNING_LIGHT_M) continue;
      const key = b.group ?? -1 - i;
      const cur = tallest.get(key);
      if (cur === undefined || pack.buildings[cur].topM < b.topM) tallest.set(key, i);
    }
    const pos: number[] = [];
    for (const i of tallest.values()) {
      const b = pack.buildings[i];
      const y = (this.groundYOf.get(i) ?? 0) + b.topM + 0.6;
      if (shapedRoofFor(b, b.topM - b.baseM)) { pos.push(b.cx, y, b.cz); continue; }
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let v = 0; v < b.ring.length; v += 2) {
        x0 = Math.min(x0, b.ring[v]); x1 = Math.max(x1, b.ring[v]);
        z0 = Math.min(z0, b.ring[v + 1]); z1 = Math.max(z1, b.ring[v + 1]);
      }
      // The bounding box corners pulled a metre in, kept only where they are
      // over the roof (an L or a circle has corners in the air).
      const before = pos.length;
      for (const [x, z] of [[x0 + 1, z0 + 1], [x1 - 1, z0 + 1], [x1 - 1, z1 - 1], [x0 + 1, z1 - 1]]) {
        if (insideRing(b.ring, x, z)) pos.push(x, y, z);
      }
      if (pos.length === before) pos.push(b.cx, y, b.cz);
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    this.warningMat = new THREE.PointsMaterial({
      color: 0xff2a14, size: 3, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false,
    });
    this.group.add(new THREE.Points(geo, this.warningMat));
  }

  /**
   * Rebuild the detail layer round the camera when it has moved far enough.
   *
   * TIME-SLICED. Building the layer over Midtown is 4,200 buildings and 130k
   * triangles, and over the Mission 3,800 and 280k; measured under Bun that
   * is 45 to 65 ms, which in one frame is a hitch every 200 m of flight. So a
   * rebuild walks its cells DETAIL_SLICE_MS at a time across frames and swaps
   * the finished mesh in at the end; the old layer stays up meanwhile.
   */
  updateDetail(x: number, z: number): void {
    if (!this.pack) return;
    // The warning lights burn by day too, but against a sunlit sky a 3 px red
    // point is invisible; fading them in with the night keeps them from
    // reading as specks of dirt on a daylight frame.
    if (this.warningMat) this.warningMat.opacity = Math.min(1, Math.max(0, (this.uniforms.uNight.value - 0.1) * 2));
    const job = this.detailJob;
    if (!job) {
      if (this.detailAt && Math.hypot(x - this.detailAt.x, z - this.detailAt.z) < DETAIL_REBUILD_M) return;
      this.detailAt = { x, z };
      const r = Math.max(this.streetM, this.reliefM);
      const cells: number[][] = [];
      const c0x = Math.floor((x - r) / DETAIL_CELL_M), c1x = Math.floor((x + r) / DETAIL_CELL_M);
      const c0z = Math.floor((z - r) / DETAIL_CELL_M), c1z = Math.floor((z + r) / DETAIL_CELL_M);
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cz = c0z; cz <= c1z; cz++) {
          const l = this.detailCells.get(`${cx},${cz}`);
          if (l) cells.push(l);
        }
      }
      // The first build is done in one go: there is nothing on screen yet to
      // keep, and a city arriving without its near detail would pop.
      this.detailJob = { x, z, cells, next: 0, s: emptyScratch(), sync: this.detailTriangles < 0 };
      return this.updateDetail(x, z);
    }
    const t0 = performance.now();
    const r = Math.max(this.streetM, this.reliefM);
    while (job.next < job.cells.length) {
      for (const k of job.cells[job.next++]) {
        const i = this.detailOf[k], bidx = this.detailOf[k + 1];
        const b = this.pack.buildings[i];
        const d = Math.hypot(b.cx - job.x, b.cz - job.z);
        if (d > r) continue;
        addDetail(job.s, b, this.groundYOf.get(i) ?? 0, bidx, this.params[bidx], d < this.streetM, d < this.reliefM);
      }
      if (!job.sync && performance.now() - t0 > DETAIL_SLICE_MS) return;
    }
    this.detailJob = null;
    for (const child of this.detail.children) {
      const m = child as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.detail.clear();
    const mesh = buildMesh(job.s, this.uniforms);
    this.detailTriangles = job.s.idx.length / 3;
    if (mesh) {
      mesh.layers.enable(SHADOW_CASTER_LAYER);
      this.detail.add(mesh);
    }
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
