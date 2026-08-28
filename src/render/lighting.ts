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
  moonDir: THREE.Vector3;
  /**
   * Moonlight as colour * intensity, in the same units as
   * `sunColor * sunIntensity`, so a shader adds it to the direct term with the
   * same `uSunSurface` conversion and nothing else has to change.
   */
  moonLight: THREE.Color;
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
const _moon = new THREE.Vector3();

/**
 * Night is a model of the dark-adapted EYE, not of radiometry.
 *
 * Full moonlight is about a millionth of sunlight. Rendered to scale it is
 * black, which is exactly what this app was doing: outside the street-lamp
 * mask the ground received an ambient of ~0.001 and the tone curve took that
 * to zero, so a night flight was an instrument panel floating over nothing.
 *
 * Scotopic vision is what makes a moonlit landscape legible in reality, so
 * these three terms stand in for that adaptation and are set by what reads as
 * night on a screen: dark, blue, low-contrast, but with a horizon in it.
 */
/** Starlight and airglow. The floor under a moonless overcast midnight. */
const NIGHT_SKY = new THREE.Color(0.016, 0.020, 0.034);
/** Scattered moonlight added to ambient at full moon, overhead, clear. */
const MOON_SKY = new THREE.Color(0.010, 0.013, 0.022);
/**
 * The direct moon beam, as an intensity in `sunIntensity` units.
 *
 * The sun peaks at 26, so this is about six stops down before the night
 * exposure lift and about four after it: enough that a full moon casts a
 * visible shadow and picks out a coastline, not so much that the frame reads
 * as an overcast afternoon. Set by looking at Dubai under a full moon 65
 * degrees up, which is the brightest night this app can produce.
 */
const MOON_BEAM = 0.42;
/** Moonlight is neutral, but a dark-adapted eye reports it as blue. */
const MOON_TINT = new THREE.Color(0.72, 0.82, 1.0);

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
  // How much moonlight actually reaches the ground. Three factors, and all
  // three matter: a new moon puts out nothing, a moon on the horizon is
  // extinguished by the air it shines through, and cloud shutters it the same
  // way it shutters the sun.
  //
  // The horizon ramp starts BELOW zero because refraction and the disc's own
  // radius keep the moon lighting the ground for a few minutes after its
  // centre has geometrically set.
  const moonUp = Math.max(0, Math.min(1, (solar.moon.altitude + 1.5) / 14));
  const moonlight = solar.moonIllum * moonUp * (1 - 0.92 * wx.opacity) * night;

  // Daylight ambient dies as night comes on, and the night terms rise to take
  // its place. The two are added rather than max()'d: at civil twilight both
  // are genuinely present, and a max() makes one of them vanish at whatever
  // sun angle the curves happen to cross.
  ambient.multiplyScalar(Math.max(0, 1 - night));
  ambient.r += NIGHT_SKY.r * night + MOON_SKY.r * moonlight;
  ambient.g += NIGHT_SKY.g * night + MOON_SKY.g * moonlight;
  ambient.b += NIGHT_SKY.b * night + MOON_SKY.b * moonlight;

  _moon.set(solar.moon.dir.x, solar.moon.dir.y, solar.moon.dir.z);
  const moonLight = MOON_TINT.clone().multiplyScalar(MOON_BEAM * moonlight);

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
    moonDir: _moon.clone(),
    moonLight,
    ambient,
    night,
    // Sodium/LED orange, and weak -- it is a fill light, not a light source.
    // Skyglow over a city really is warm, but at 1 : 0.75 : 0.53 it was warm
    // enough to be the DOMINANT light: every surface it touched came out tan,
    // so a night city read as sepia rather than as dark. Nearly neutral with a
    // trace of amber leaves the warmth to the things that are actually warm,
    // which are the lamps and the lit windows.
    nightGlow: new THREE.Color(0.030, 0.028, 0.027).multiplyScalar(night),
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
