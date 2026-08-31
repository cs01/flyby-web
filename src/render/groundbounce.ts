// What lights the floor of a street canyon, shared by every surface that forms
// one.
//
// WHY THIS IS ITS OWN FILE. The street floor is not drawn by one shader. The
// carriageway is render/roads.ts, the footway is render/pavement.ts, and the
// ground BETWEEN and AROUND them -- which in the Chicago LaSalle canyon is most
// of the frame -- is the terrain drape in render/terrain.ts. All three went
// black under the same towers for the same reason, and three separate fudges
// would have drifted apart the first time the coefficient was touched. One
// helper, included by all three, so the street floor is lit by one term.
//
// THE DEFECT. A carriageway between two forty-storey towers loses nearly the
// whole sky dome, so the sky irradiance collapses; the sun is blocked, so the
// beam is zero. Sum: black, at noon, with the facades overhead in full sun.
// That is not what a city street looks like. The wall opposite is lit, it is
// roughly mid-grey, and it throws a large fraction of that back down into the
// street. In a canyon the bounce IS most of the light on the ground.
//
// THE TWO WEIGHTS, and both are things that are actually TRUE about the
// geometry rather than knobs:
//
//   THE SHADOW. If the sun is up and this ground pixel is shadowed, something
//   opaque stands between it and the sun. `sunVisibility` already answers that
//   from the cascade maps, at no extra sampling cost, and it is exactly the
//   right shape: zero on a road in full sun, which needs no help, and largest
//   on the canyon floor that does. `max(0, sunDir.y)` is what keeps night and
//   the moon path out of it -- below the horizon there is no sun to bounce.
//
//   THE BUILT-NESS. A shadow alone does not make a canyon: a ridge line, a
//   forest and a cloud all cast one, and none of them is a sunlit wall facing
//   back down at the ground. render/urbanmask.ts is a coverage grid of the
//   actual baked footprints at ~85 m per texel, which is precisely the scale of
//   the question -- a city block reads as built, a single house does not -- so
//   it is what says a wall is there to bounce off. Without it this term is an
//   ambient rise on every shadow in the world, which is the failure the whole
//   change is trying not to be.
//
// WHAT WAS TRIED AND IS THE WRONG QUANTITY. Weighting by
// `1 - sampleSkyOcclusion().visibility`, by analogy with the facade bounce in
// render/buildings.ts. That AO is SCREEN SPACE and metre-scale: it knows about a
// kerb and the underside of a parked car, and it does not know a 150 m tower is
// standing over the street. Measured on manhattan-7th it moved the carriageway
// by 0.00 of 255 even at a coefficient of 6.0. The facade's own term is not
// that AO either; it is analytic from height up the wall, which a ground
// surface does not have.
//
// The bounce carries no cosine of its own. It arrives roughly horizontally off
// a wall onto a near-horizontal surface, and that geometry is folded into the
// coefficient along with the wall's albedo -- these three shaders draw tarmac,
// paving and drape, all of them within a few degrees of flat. Do not reuse this
// on a vertical surface without giving it one.

import * as THREE from "three";

/**
 * What a fully shadowed, fully built-up ground pixel ends up with, as a
 * fraction of the beam that is landing on the walls over it.
 *
 * This is the whole model in one number, and it is a TARGET rather than a
 * gain: see canyonBounce below for why the sky's own contribution is
 * subtracted off it rather than added to it. 0.9 puts the LaSalle canyon floor
 * about 1.2 stops under the sunlit ground in the same frame, which is what the
 * ratio ceiling in tools/verify-street.ts is written against. It was measured
 * up and down before it was written down: 1.2 flattens that frame to 0.9 of a
 * stop and it stops reading as a shadow at all, 0.6 leaves a sixth of the
 * canyon floor under 4 of 255.
 */
const SHADOW_TARGET = 0.5;

export const GROUND_BOUNCE_GLSL = /* glsl */ `
uniform sampler2D uUrban;
uniform float uUrbanExtent;
uniform float uFlatBounce;
uniform float uGroundDebug;

const float SHADOW_TARGET = ${SHADOW_TARGET.toFixed(4)};

/**
 * 0..1 coverage by baked building footprints; see render/urbanmask.ts.
 *
 * Zero OUTSIDE the grid rather than the clamped edge texel, or a city's
 * built-ness would smear to the horizon along every edge of the mask.
 */
float builtness(vec3 worldPos) {
  vec2 uv = worldPos.xz / (2.0 * uUrbanExtent) + 0.5;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return texture(uUrban, uv).r * inside;
}

/**
 * Light bounced onto this ground fragment off the sunlit walls around it.
 *
 * sunRadiance is the beam that reaches those walls -- sunColor * intensity *
 * surface * transmittance -- i.e. exactly what the direct term is built from
 * before its own cosine and shadow, so the two cannot drift out of step.
 *
 * THE SKY IS SUBTRACTED, NOT ADDED TO, and that is the part that took a
 * measurement to get right. A wall and the sky share one hemisphere: light the
 * sky is already delivering here is light the wall is NOT also delivering,
 * because a ground pixel that can still see that much sky is not standing in a
 * canyon. Written as a gain instead -- ambient plus a wall term -- the same
 * coefficient that rescues the LaSalle floor lifts a building shadow on Van
 * Ness by 73%, to within 0.15 of a stop of the sunlit avenue beside it, which
 * is not a shadow any more. Written as a TARGET the two frames separate on
 * their own: in the canyon the sky term is near zero and the wall supplies
 * almost all of it, on the open avenue the sky has already got there and the
 * wall has nothing left to add.
 *
 * Componentwise, so a blue sky term and a warm wall term each cover their own
 * part of the spectrum rather than one cancelling the other.
 */
vec3 canyonBounce(vec3 sunRadiance, vec3 skyAmbient, float sunVis, vec3 sunDir, float built) {
  float occ = (1.0 - sunVis) * max(0.0, sunDir.y) * built;
  vec3 target = sunRadiance * (SHADOW_TARGET * occ);
  return max(vec3(0.0), target - skyAmbient) * (1.0 - uFlatBounce);
}

/** What kind of street floor a shader draws; see groundDebugColor. */
const float GROUND_CARRIAGEWAY = 2.0;
const float GROUND_FOOTWAY     = 3.0;
const float GROUND_DRAPE       = 4.0;

/**
 * ?groundDebug: which pixels are street floor, and which of them the sun
 * reaches. RED where the ground is shadowed, BLUE where it is lit, and nothing
 * anywhere else, so tools/verify-street.ts never has to guess either one from
 * colour in the beauty frame.
 *
 * Mode 1 is every ground surface. Modes 2, 3 and 4 narrow it to the
 * carriageway, the footway and the terrain drape respectively, and that split
 * is not a convenience: a sunlit-over-shadowed ratio taken across all three at
 * once is measuring ALBEDO as much as light. Half the shadowed ground in the
 * LaSalle frame is drape whose baked satellite texel is nearly black, so that
 * ratio reads 5.6 with a term that has already brought the illumination to
 * within a stop. Taken over the carriageway alone it is one material either
 * side of the shadow line and the ratio is a ratio of light.
 */
bool groundDebugColor(float sunVis, float kind, out vec3 col) {
  if (uGroundDebug < 0.5) return false;
  if (uGroundDebug > 1.5 && abs(uGroundDebug - kind) > 0.5) return false;
  col = sunVis < 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
  return true;
}
`;

export interface GroundBounceUniforms extends Record<string, THREE.IUniform> {
  /** Built-ness coverage grid; render/urbanmask.ts. */
  uUrban: THREE.IUniform<THREE.Texture | null>;
  /** Half-width in metres the mask spans about the scene origin. */
  uUrbanExtent: THREE.IUniform<number>;
  /** 1 removes the canyon bounce entirely; the `?flatbounce=1` vacuity probe. */
  uFlatBounce: THREE.IUniform<number>;
  /** 1 emits the ground/sun mask instead of the beauty pixel; ?groundDebug=1. */
  uGroundDebug: THREE.IUniform<number>;
}

/**
 * Defaults for a shader that has not been handed a city yet.
 *
 * The null texture and an extent of 1 mean `builtness` reads zero, so the
 * bounce is off until main.ts has an urban mask to give it. A place with no
 * baked pack gets no bounce, which is the conservative answer: no footprints is
 * no evidence of a wall.
 */
export function groundBounceUniforms(): GroundBounceUniforms {
  return {
    uUrban: { value: null },
    uUrbanExtent: { value: 1 },
    uFlatBounce: { value: 0 },
    uGroundDebug: { value: 0 },
  };
}
