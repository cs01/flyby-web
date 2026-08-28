// One analytic atmosphere, shared by the sky dome and by every surface shader.
//
// This is the reason the world looks like one place instead of a skybox with
// objects pasted on it. A sky shader alone gives you a beautiful gradient and a
// city that sits in front of it looking cut out. The fix is that the SAME
// scattering integral that paints the sky also paints the air between the
// camera and each surface, so a distant ridge is tinted by exactly the air the
// sky is made of, and turns orange at sunset because the sky does.
//
// Model: single-scattering Rayleigh + Mie through an exponential atmosphere,
// evaluated with a short ray march. Two extra terms make it earn its keep over
// the usual "blue gradient" hack:
//
//   * Ozone absorption. Without it the twilight sky goes muddy grey-green.
//     With it you get the deep blue overhead against orange horizon that is the
//     actual signature of dusk, because ozone absorbs the yellow-red the
//     Rayleigh term leaves behind at long path lengths.
//   * Mie asymmetry g driven by WEATHER, not a constant. Humid, hazy air
//     scatters forward much harder, which is why a muggy day has a huge white
//     glare around the sun and a dry alpine day does not.

export const ATMOSPHERE_GLSL = /* glsl */ `
const float PI = 3.141592653589793;

// Earth and atmosphere shell, metres. The camera lives at ground level plus
// altitude, so these are absolute radii and the ray origin is R_GROUND + alt.
const float R_GROUND = 6360000.0;
const float R_TOP    = 6420000.0;

// Scattering coefficients at sea level, per metre, for 680/550/440 nm.
const vec3  BETA_R = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float BETA_M = 3.996e-6;
const vec3  BETA_O = vec3(0.650e-6, 1.881e-6, 0.085e-6);

const float H_R = 8000.0;   // Rayleigh scale height
const float H_M = 1200.0;   // Mie scale height

uniform vec3  uSunDir;        // world-space, normalised, +y up
uniform float uSunIntensity;
uniform vec3  uSunColor;
uniform float uMieG;          // forward-scatter asymmetry, from humidity
uniform float uTurbidity;     // aerosol multiplier, from visibility
uniform float uCamAltitude;   // metres above sea level
// Multiple-scattering gain. Compare against the Rayleigh phase function, which
// averages 1/4pi = 0.0796 over the sphere: this term is isotropic, so a value
// near 0.05 makes multiple scattering a realistic fraction of single scattering.
// It is a uniform rather than a constant because it is the one number in the
// model with no closed form, and it has to be tuned by eye against a real sky.
uniform float uMultiScatter;

float rayleighPhase(float c) {
  return (3.0 / (16.0 * PI)) * (1.0 + c * c);
}

float miePhase(float c, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + c * c))
       / ((2.0 + g2) * pow(max(d, 1e-4), 1.5));
}

// Ozone sits in a layer around 25 km rather than falling off exponentially.
// A tent function is close enough and is what gives twilight its colour.
float ozoneDensity(float h) {
  return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
}

// Distance from 'ro' to the atmosphere shell, or -1 if the ray misses.
float rayShell(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}

// Ground hit distance, or -1. Used to stop the sky march at the horizon.
float rayGround(vec3 ro, vec3 rd) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R_GROUND * R_GROUND;
  float d = b * b - c;
  if (d < 0.0 || (-b - sqrt(d)) < 0.0) return -1.0;
  return -b - sqrt(d);
}

// Optical depth from a point toward the sun, 4 steps. Cheap and the error is
// invisible next to the single-scatter approximation already in play.
vec3 sunTransmittance(vec3 p, vec3 sunDir, float turbidity) {
  float t = rayShell(p, sunDir, R_TOP);
  if (t <= 0.0) return vec3(1.0);
  const int N = 4;
  float dt = t / float(N);
  float odR = 0.0, odM = 0.0, odO = 0.0;
  for (int i = 0; i < N; i++) {
    vec3 s = p + sunDir * (dt * (float(i) + 0.5));
    float h = max(0.0, length(s) - R_GROUND);
    odR += exp(-h / H_R) * dt;
    odM += exp(-h / H_M) * dt;
    odO += ozoneDensity(h) * dt;
  }
  return exp(-(BETA_R * odR + BETA_M * turbidity * 1.11 * odM + BETA_O * odO));
}

/**
 * Integrate scattering along a ray for 'maxDist' metres (use a huge number for
 * the open sky). Returns in-scattered radiance and writes the transmittance of
 * the segment, so a surface shader can do "surface * transmittance + scatter"
 * and get aerial perspective for free.
 */
vec3 atmosphere(vec3 ro, vec3 rd, float maxDist, out vec3 transmittance) {
  float shell = rayShell(ro, rd, R_TOP);
  if (shell <= 0.0) { transmittance = vec3(1.0); return vec3(0.0); }

  float ground = rayGround(ro, rd);
  float far = shell;
  if (ground > 0.0) far = min(far, ground);
  far = min(far, maxDist);

  const int N = 16;
  float dt = far / float(N);
  float odR = 0.0, odM = 0.0, odO = 0.0;
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec3 sumMS = vec3(0.0);

  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (dt * (float(i) + 0.5));
    float h = max(0.0, length(p) - R_GROUND);
    float dR = exp(-h / H_R) * dt;
    float dM = exp(-h / H_M) * dt;
    odR += dR; odM += dM; odO += ozoneDensity(h) * dt;

    vec3 viewT = exp(-(BETA_R * odR + BETA_M * uTurbidity * 1.11 * odM + BETA_O * odO));
    vec3 sunT  = sunTransmittance(p, uSunDir, uTurbidity);
    vec3 t = viewT * sunT;
    sumR += t * dR;
    sumM += t * dM;

    // Multiple scattering, approximated. Single scattering alone leaves the
    // horizon orange at MIDDAY: a 100 km horizon ray is so reddened by the time
    // it is scattered once that no blue survives. Real photons reaching the eye
    // from the horizon have bounced several times, each bounce over a much
    // shorter path, so they are far less reddened. Raising the sun
    // transmittance to a fractional power models that shorter effective path,
    // and the isotropic (phase-free) term restores the pale blue-white horizon
    // that the single-scatter model cannot produce.
    vec3 shortPathSunT = pow(sunT, vec3(0.45));
    sumMS += viewT * shortPathSunT * (BETA_R * dR + BETA_M * uTurbidity * 1.11 * dM);
  }

  transmittance = exp(-(BETA_R * odR + BETA_M * uTurbidity * 1.11 * odM + BETA_O * odO));

  float c = dot(rd, uSunDir);
  vec3 scatter = uSunIntensity * uSunColor *
    (sumR * BETA_R * rayleighPhase(c) +
     sumM * BETA_M * uTurbidity * miePhase(c, uMieG) +
     sumMS * uMultiScatter);
  return scatter;
}

/** Ray origin for a camera 'altM' metres above the ground at the scene origin. */
vec3 atmoOrigin(float altM) {
  return vec3(0.0, R_GROUND + max(altM, 1.0), 0.0);
}
`;
