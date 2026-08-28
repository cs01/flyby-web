// Tone mapping and output encoding, applied by hand.
//
// three.js injects its tone curve and sRGB encode into ShaderMaterial via
// #include chunks. RawShaderMaterial gets NO injection at all: whatever the
// fragment shader writes goes straight to the framebuffer. So a raw shader that
// outputs linear HDR radiance -- which every shader in this renderer does --
// has its highlights clipped at 1.0 and its midtones read as if they were
// already sRGB. The result is a washed, permanently blown image on which
// renderer.toneMappingExposure has literally no effect, because nothing is
// reading it.
//
// Doing it here instead means exposure is a real uniform the scene controls,
// which is what lets night lift by 3 stops without touching anything else.

export const TONEMAP_GLSL = /* glsl */ `
uniform float uExposure;

// ACES filmic, Narkowicz's fit. Chosen over AgX because it keeps saturation in
// the bright end, and a sunset over a city is mostly bright saturated colour.
vec3 tonemapACES(vec3 x) {
  x *= 0.6;
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

/**
 * sRGB -> linear, done explicitly.
 *
 * Satellite imagery is sRGB-encoded. Sampling it without decoding leaves every
 * albedo far too high and, worse, COMPRESSES the dark end: sRGB 0.25 water
 * reads as 0.25 instead of linear 0.05, so deep ocean lights up like concrete
 * and any threshold that tries to detect water by darkness fails outright.
 * Setting texture.colorSpace is not enough here -- three.js drives that through
 * its own material chunks, which a RawShaderMaterial never gets.
 */
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

/** Linear HDR radiance -> the sRGB-encoded value the framebuffer expects. */
vec3 present(vec3 linearHdr) {
  return linearToSRGB(tonemapACES(linearHdr * uExposure));
}
`;
