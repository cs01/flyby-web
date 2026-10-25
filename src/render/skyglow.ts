// City skyglow: the lit dome over a city at night.
//
// A city sky at night is not black. Street lamps, lit windows and signs throw
// light upward, the air and its haze scatter some of it back, and from inside
// the city the result is a dome that is orange near the horizon and pinkish
// violet overhead, with only the brightest stars left in it. A low cloud deck
// over the city is lit from below and glows.
//
// Modelled from the city's own building pack, not painted: render/urbanmask.ts
// reduces the footprints to one disc of upward light (centroid, the radius of
// a fully built disc of the same covered area, and the floor area ratio inside
// it), and the atmosphere march (atmosphere.glsl.ts) scatters that light along
// every view ray through the same Rayleigh and Mie air the sky is made of. So
// the dome is brightest looking across the city, fades looking away from it,
// is there on the horizon from a hill outside it, and is absent in Yosemite,
// which has no pack.
//
// The uniforms are ONE shared pair: every material that includes the
// atmosphere chunk spreads SKYGLOW_UNIFORMS into its own uniform set, so one
// write per frame reaches them all. A material that does not is left at zero,
// which the shader reads as "no glow".

import * as THREE from "three";
import type { CityGlow } from "./urbanmask";

export const SKYGLOW_UNIFORMS = {
  uGlowDisc: { value: new THREE.Vector4(0, 0, 0, 0) },
  uGlowRad: { value: new THREE.Vector3(0, 0, 0) },
};

/**
 * The emitted light's colour, linear. City light is a mix of high pressure
 * sodium (still most of the outer boroughs and suburbs), 4000 K LED (New
 * York's street lamps since 2017, Chicago's since 2021) and warm interior
 * light from windows; the mix averages to about 2700 K. The Rayleigh share of
 * the scattering then pulls it toward pink-violet overhead, which is the real
 * colour of a city zenith in photographs.
 */
const EMISSION = new THREE.Color(1.0, 0.58, 0.32);

/**
 * Emission per unit of the atmosphere march's scattering integral, for a
 * city of floor area ratio zero (street lamps alone). Set by eye against
 * photographs of Midtown from the air at night, at the app's night exposure:
 * the horizon over the city an orange of about sRGB 70, the zenith a dark
 * mauve near 25, measured by tools/verify-skyglow.ts.
 */
const BASE_GLOW = 1.0;
/** Extra emission per unit of floor area ratio: lit windows. */
const GLOW_PER_FAR = 0.12;
/** Upward irradiance on a cloud base, per unit glow, into the cloud ambient. */
const CLOUD_UPLIGHT = 0.035;

/** Late at night the windows go out; the lamps stay on. */
function lateFactor(residentialHour: number): number {
  return 0.55 + 0.45 * residentialHour;
}

/** The disc's strength, before night and colour. Exported for the gate. */
export function glowStrength(g: CityGlow): number {
  if (g.radius <= 0) return 0;
  return BASE_GLOW * (1 + GLOW_PER_FAR * Math.min(g.far, 12));
}

/**
 * Write the shared uniforms for this frame and return the upward irradiance a
 * cloud base `baseM` above the ground at the camera receives, as a colour in
 * the cloud ambient's units (composite.ts adds it to uAmbBottom).
 */
export function updateSkyglow(
  g: CityGlow,
  camX: number,
  camZ: number,
  night: number,
  residentialHour: number,
  off: boolean,
  baseM: number,
  out: THREE.Color,
): THREE.Color {
  const s = off ? 0 : glowStrength(g) * night * lateFactor(residentialHour);
  SKYGLOW_UNIFORMS.uGlowDisc.value.set(g.cx - camX, g.cz - camZ, Math.max(g.radius, 1), 0);
  SKYGLOW_UNIFORMS.uGlowRad.value.set(EMISSION.r * s, EMISSION.g * s, EMISSION.b * s);
  // The same falloff the shader uses: flat over the disc up to a height near
  // its radius, then R^2/(R^2+h^2+4d^2) with d the distance past its edge.
  const r2 = g.radius * g.radius;
  const dq = Math.max(0, Math.hypot(camX - g.cx, camZ - g.cz) - g.radius);
  const e = r2 > 0 ? r2 / (r2 + baseM * baseM + 4 * dq * dq) : 0;
  return out.copy(EMISSION).multiplyScalar(s * e * CLOUD_UPLIGHT);
}
