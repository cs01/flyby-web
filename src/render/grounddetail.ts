// The ground's own surface, under the photograph: band-limited procedural
// detail that fills in the frequencies the satellite drape does not have.
//
// WHY BAND-LIMITED, AND BETWEEN WHAT. The drape is a photograph with a fixed
// texel: 0.47 m in the detail bubble, 7.5 m on the 10 km ring, 15 m past it.
// Wherever that texel covers more than a pixel or two the ground is a smear,
// and wherever it covers less the photograph already holds everything a pixel
// can show. So the layer is a sum of octaves (0.125 m to 32 m, an octave
// apart), and each octave exists only inside the band no other source fills:
//
//   * longer than four pixels on screen (eight for the slope), so nothing
//     aliases. A procedural noise has no mip chain, and an octave whose period
//     drops under a pixel is not texture, it is a rash that swims when the
//     camera moves;
//   * shorter than about two drape texels, so the layer adds frequency and
//     never competes with what the photograph actually measured.
//
// From altitude both conditions fail for every octave at once, the loop runs
// zero times, and the far field is the same pixels it was.
//
// WHY THE MEAN IS UNCHANGED. Every term is a zero-mean noise multiplying the
// drape's own colour, so an area averages back to the photograph whatever the
// material. That is what keeps the colour honest: WorldCover cannot tell a
// June hillside (straw) from a March one (green), the photograph can, and the
// detail only decides the TEXTURE of what the photograph says is there.
//
// THREE SIGNALS, NOT ONE PER MATERIAL. One set of octaves is evaluated and
// summed under three spectral weightings (fine, mid, coarse); every material
// is a different mix of the same three. That is a third of the cost of a noise
// per material, and it means two materials blend across a boundary without a
// seam, because both are built from the same field.

/** Octaves in the detail sum, finest first. */
export const DETAIL_OCTAVES = 9;
/** Wavelength of the finest octave, metres; each next one doubles. */
export const DETAIL_LAMBDA0_M = 0.125;

/**
 * Spectral weights per octave for the three signals.
 *
 * Fine is grain, blades and pebbles (under ~0.5 m); mid is tufts, clods,
 * mottling and shrub patches (0.5 to 8 m); coarse is patches and drifts (8 to
 * 32 m), which on the 15 m ring is still finer than a texel.
 */
const W_FINE = [1.0, 1.0, 0.7, 0.35, 0.1, 0, 0, 0, 0];
const W_MID = [0, 0.1, 0.4, 0.9, 1.0, 0.8, 0.4, 0.15, 0];
const W_COARSE = [0, 0, 0, 0, 0.1, 0.4, 0.9, 1.0, 1.0];

function table(): string {
  const f = (v: number[]): string => v.map((x) => x.toFixed(3)).join(", ");
  const rot: string[] = [];
  const off: string[] = [];
  for (let k = 0; k < DETAIL_OCTAVES; k++) {
    // Every octave turned and shifted off the one before it. Without this the
    // lattices of all nine share their axes and their origin, and the sum
    // shows a faint square grid at every scale at once.
    const a = 0.62 + k * 1.13;
    rot.push(`vec2(${Math.cos(a).toFixed(5)}, ${Math.sin(a).toFixed(5)})`);
    off.push(`vec2(${(17.31 * (k + 1)).toFixed(2)}, ${(31.77 * (k + 1)).toFixed(2)})`);
  }
  return [
    `#define DETAIL_OCTAVES ${DETAIL_OCTAVES}`,
    `const float DETAIL_LAMBDA0 = ${DETAIL_LAMBDA0_M.toFixed(4)};`,
    `const float DW_FINE[${DETAIL_OCTAVES}] = float[](${f(W_FINE)});`,
    `const float DW_MID[${DETAIL_OCTAVES}] = float[](${f(W_MID)});`,
    `const float DW_COARSE[${DETAIL_OCTAVES}] = float[](${f(W_COARSE)});`,
    `const vec2 D_ROT[${DETAIL_OCTAVES}] = vec2[](${rot.join(", ")});`,
    `const vec2 D_OFF[${DETAIL_OCTAVES}] = vec2[](${off.join(", ")});`,
  ].join("\n");
}

export const GROUND_DETAIL_GLSL = /* glsl */ `
${table()}

/** Pseudo-random gradient for a lattice point, components in -1..1. */
vec2 dHash22(vec2 p) {
  // Lattice coordinates reach 1.6e5 for the finest octave 20 km out, where a
  // fract(p * 0.1) hash has lost most of its mantissa. Wrapping at 2048 cells
  // repeats the finest grain every 256 m, which nothing can see.
  p = mod(p, 2048.0);
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}

/**
 * Gradient noise and its analytic derivative: (value, d/dx, d/dy).
 *
 * Gradient rather than value noise because a value noise at the amplitudes
 * used here reads as a field of soft squares; quintic fade so the derivative,
 * which IS the detail normal, has no crease along the lattice lines.
 */
vec3 dNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = dHash22(i);
  vec2 gb = dHash22(i + vec2(1.0, 0.0));
  vec2 gc = dHash22(i + vec2(0.0, 1.0));
  vec2 gd = dHash22(i + vec2(1.0, 1.0));
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float k4 = va - vb - vc + vd;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k4;
  vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * (u.yx * k4 + vec2(vb, vc) - va);
  return vec3(v, g);
}

/**
 * The three band-limited signals on a plane, as (value, slope) each.
 *
 * value is zero-mean, about 0.3 rms with every octave in. slope is the
 * gradient of a height field whose amplitude grows with wavelength, so every
 * octave contributes the same slope: self-similar roughness, which is what
 * soil and rock measure as.
 *
 * pxV and pxN are the pixel footprints, metres, the VALUE and the SLOPE are
 * band-limited against; tex is the drape texel in metres. The value may use
 * the geometric mean of the pixel's two axes, because a colour octave that
 * aliases down-range at a grazing view still averages to its mean; the slope
 * must use the longer axis, because the lighting is not linear in the normal,
 * and an aliased normal under a low sun drew corduroy across the Emerald Hills
 * ridge at 18:30. mode 3 is the aliasing probe: every octave in, regardless.
 */
struct DetailBands { vec3 f; vec3 m; vec3 c; float amt; };

DetailBands detailBands(vec2 p, float pxV, float pxN, float tex, float mode) {
  DetailBands o;
  o.f = vec3(0.0);
  o.m = vec3(0.0);
  o.c = vec3(0.0);
  o.amt = 0.0;
  float lam = DETAIL_LAMBDA0;
  for (int k = 0; k < DETAIL_OCTAVES; k++) {
    // Four pixels a period to keep (eight for the slope), two to lose (four);
    // two drape texels to keep, four to lose. Faded rather than cut on both
    // sides, or each octave draws a ring on the ground at the range it
    // switches.
    float wTex = smoothstep(4.0, 2.0, lam / tex);
    // The slope wants twice the pixels the colour does, for the reason the
    // water's waves do: shading is not linear in the normal, so an octave
    // just over Nyquist still aliases once it is lit by a low sun. The colour
    // is linear in the octave and averages out; at six pixels instead of four
    // the Marin pose lost three quarters of its added contrast.
    float w = smoothstep(2.0, 4.0, lam / pxV) * wTex;
    float wN = smoothstep(4.0, 8.0, lam / pxN) * wTex;
    if (mode > 2.5) { w = 1.0; wN = 1.0; }
    if (w > 0.0) {
      vec2 r = D_ROT[k];
      vec2 q = vec2(r.x * p.x - r.y * p.y, r.y * p.x + r.x * p.y) / lam + D_OFF[k];
      vec3 n = dNoise(q);
      // Back from the octave's rotated frame to the plane's own axes.
      vec2 g = vec2(r.x * n.y + r.y * n.z, -r.y * n.y + r.x * n.z);
      vec3 s = vec3(n.x * w, g * wN);
      o.f += s * DW_FINE[k];
      o.m += s * DW_MID[k];
      o.c += s * DW_COARSE[k];
      o.amt = max(o.amt, w);
    }
    lam *= 2.0;
  }
  return o;
}

/**
 * One combined rock signal on a plane, as (value, slope): the fine, mid and
 * coarse weights folded into each octave's gain, so the triplanar faces carry
 * three floats instead of nine. Measured: the nine-float version evaluated on
 * three planes cost ~1 ms of terrain occupancy on central-park-path, where
 * there is no rock at all, just by being compiled in.
 */
vec3 detailRock(vec2 p, float px, float tex, float mode) {
  vec3 o = vec3(0.0);
  float lam = DETAIL_LAMBDA0;
  for (int k = 0; k < DETAIL_OCTAVES; k++) {
    float w = smoothstep(4.0, 8.0, lam / px) * smoothstep(4.0, 2.0, lam / tex);
    if (mode > 2.5) w = 1.0;
    if (w > 0.0) {
      vec2 r = D_ROT[k];
      vec2 q = vec2(r.x * p.x - r.y * p.y, r.y * p.x + r.x * p.y) / lam + D_OFF[k];
      vec3 n = dNoise(q);
      vec2 g = vec2(r.x * n.y + r.y * n.z, -r.y * n.y + r.x * n.z);
      float gv = 0.25 * DW_FINE[k] + 0.35 * DW_MID[k] + 0.20 * DW_COARSE[k];
      float gs = 0.45 * DW_FINE[k] + 0.50 * DW_MID[k] + 0.30 * DW_COARSE[k];
      o += vec3(n.x * gv, g * gs) * w;
    }
    lam *= 2.0;
  }
  return o;
}
`;
