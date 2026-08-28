// One place that turns "what the weather and the sun are doing" into the
// handful of numbers every shader needs.
//
// Centralised because these values MUST agree across the sky, the terrain, the
// buildings and the clouds. When each shader derived its own ambient colour
// from the sun angle, a heavy-overcast scene had a blue-ambient ground under a
// grey sky, and the mismatch was more obviously wrong than either value was on
// its own.

import * as THREE from "three";
import type { Weather } from "../data/weather";
import type { SolarState } from "../data/solar";

export interface SceneLighting {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  ambient: THREE.Color;
  /** 0..1, how far into night. Drives city lights and stars. */
  night: number;
  /**
   * Skyglow: the light a city throws back up at itself after dark. Without it
   * every surface not carrying its own emissive goes to pure black and the
   * buildings become silhouettes cut out of the ground.
   */
  nightGlow: THREE.Color;
  /** 0..1 surface wetness from recent precipitation. */
  wetness: number;
  /** 0..1 lying snow. */
  snow: number;
  mieG: number;
  turbidity: number;
  exposure: number;
  /** Metres; where the world fades out. Driven by reported visibility. */
  fogEnd: number;
}

const _sun = new THREE.Vector3();

export function computeLighting(solar: SolarState, wx: Weather): SceneLighting {
  const alt = solar.sun.altitude;
  _sun.set(solar.sun.dir.x, solar.sun.dir.y, solar.sun.dir.z);

  const night = 1 - Math.max(0, Math.min(1, (alt + 6) / 10));

  // Cloud attenuates the direct beam hard and the sky term much less, which is
  // exactly why an overcast day has no shadows but is not dark.
  //
  // The beam uses OPACITY (deck-weighted), not coverage. Using coverage made a
  // cirrus-covered afternoon render as dusk, because the feed says 100% and
  // thin ice cloud is not a 100% shutter.
  const cover = wx.totalCover;
  const beam = Math.max(0, Math.min(1, (alt + 2) / 8)) * (1 - wx.opacity);
  const sunIntensity = 26 * beam;

  // Ambient is sky irradiance reaching the surface, in the same units as the
  // direct term above. It has to be scaled to match, or the shaded side of
  // every hill sits at a different exposure than the lit side.
  const AMBIENT_SCALE = 0.34;

  // Overcast ambient goes grey and slightly warm; clear ambient stays sky-blue.
  const clearAmb = new THREE.Color(0.26, 0.38, 0.58);
  const cloudAmb = new THREE.Color(0.52, 0.55, 0.58);
  const ambient = clearAmb.clone().lerp(cloudAmb, cover);
  // A thick overcast scatters the lost beam back down as diffuse sky light, so
  // ambient RISES as the beam falls. Without this the two terms fall together
  // and a rainy day renders as night.
  ambient.multiplyScalar(AMBIENT_SCALE * (1 + 1.5 * wx.opacity * Math.max(0, Math.min(1, (alt + 4) / 12))));
  // Ambient tracks daylight, but never reaches zero: a moonlit city is dim,
  // not invisible.
  const moonLift = Math.max(0, solar.moon.altitude / 60) * (0.5 - Math.abs(solar.moonPhase - 0.5)) * 2;
  ambient.multiplyScalar(Math.max(0.012 + 0.05 * moonLift, 1 - night));

  const wetness = Math.max(0, Math.min(1, wx.precip * 1.6)) * (wx.precipKind === "rain" ? 1 : 0.3);
  const snow =
    wx.precipKind === "snow"
      ? Math.max(0, Math.min(1, 0.35 + wx.precip * 0.9))
      : wx.tempC < -3
        ? 0.25
        : 0;

  const visKm = Math.max(0.2, wx.visibility / 1000);

  return {
    sunDir: _sun.clone(),
    sunColor: new THREE.Color(1, 1, 1),
    sunIntensity,
    ambient,
    night,
    // Sodium/LED orange, and weak -- it is a fill light, not a light source.
    nightGlow: new THREE.Color(0.075, 0.055, 0.036).multiplyScalar(night),
    wetness,
    snow,
    mieG: 0.62 + 0.22 * Math.max(0, Math.min(1, (wx.humidity - 30) / 60)),
    turbidity: Math.max(0.6, Math.min(12, 34 / visKm)),
    // Night needs an exposure lift or the tone curve crushes the frame to
    // black; the eye adapts and so must this. But the lift multiplies the
    // EMISSIVE terms too -- street lights, lit windows -- so it has to stay
    // modest or a city at night blows out brighter than the same city at noon.
    exposure: 1 + 1.7 * night * night,
    fogEnd: Math.min(160000, wx.visibility * 2.6),
  };
}
