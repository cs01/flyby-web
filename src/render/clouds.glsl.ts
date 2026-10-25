// The cloud density field, shared by the view march and the cloud shadow map
// in render/composite.ts so the shadow on the ground is cast by the cloud you
// can see and not by a second model of it.
//
// The model is the Nubis one (Schneider & Vos, "The real-time volumetric
// cloudscapes of Horizon Zero Dawn", 2015, and its 2017 follow-up) in three
// layers, each at its own scale, which is the entire point:
//
//   1. The WEATHER MAP (render/cloudmap.ts), 48 km a repeat. Decides WHERE a
//      cloud may stand and how strong its cell is. This is what clusters the
//      sky into fields with lanes between them; before it, coverage was a
//      threshold on 1.8 km noise and the sky was an even scatter of puffs.
//   2. The HEIGHT PROFILE, by cloud type. Cumulus get a base ramp a few
//      percent of the deck deep (the flat bottom at the condensation level)
//      and a dome whose height follows the cell's strength, so a cell is a
//      tower in the middle and a shelf at its edge. Stratus get a soft
//      undulating base and a near-full top. Stratocumulus sit between.
//   3. The SHAPE and DETAIL noise (render/noise3d.ts), 2.4 km and 400 m
//      repeats. Only ERODE the envelope 1 and 2 drew: the cauliflower and the
//      wisps, never the placement.

export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D uWeather;
uniform sampler3D uShape;   // rgba: perlin, then worley at 1x / 2x / 4x
uniform sampler3D uDetail;  // rgb: worley at three frequencies
// Per deck: x cover 0..1, y base, z top (m AMSL), w type (0 stratus .. 1 cumulus).
uniform vec4  uLow;
uniform vec4  uMid;
uniform vec2  uWind;        // metres/second, (east, south)
uniform float uTime;
uniform float uPrecip;      // 0..1, thickens and darkens the low deck
// x: 1 weather map, 0 the uniform-coverage probe (tools/verify-clouds.ts).
// y: 1 the flat cumulus base, 0 the probe that restores the old wandering one.
// z: 1 billow erosion and cellular stratocumulus, 0 the previous erosion.
// w: 1 the backlit lighting, 0 the previous octaves (composite.ts).
uniform vec4  uCloudFlags;

const float WM_SCALE = 1.0 / 48000.0;
const float SHAPE_SCALE_LOW = 1.0 / 1800.0;
const float SHAPE_SCALE_MID = 1.0 / 1500.0;
const float DETAIL_SCALE = 1.0 / 300.0;
// Visible extinction per unit density, 1/m. Inside a deck of density ~0.5 this
// is a 1/e distance of about 110 m, which is what flying into one looks like:
// the wingtips go first, then the nose.
const float SIGMA_VIEW = 0.018;

float remap(float v, float lo, float hi, float nlo, float nhi) {
  return nlo + (v - lo) / (hi - lo) * (nhi - nlo);
}
float sat(float x) { return clamp(x, 0.0, 1.0); }

/**
 * The Perlin-Worley combine, one texture fetch.
 *
 * Perlin alone is a field of smooth blobs and reads as fog. The Worley fbm
 * enters as the LOW END of a remap rather than as a multiplier, which keeps
 * Perlin's wandering and gives its inside the packed billows of a cumulus.
 */
float perlinWorley(vec3 p) {
  vec4 t = texture(uShape, p);
  float wfbm = t.g * 0.625 + t.b * 0.25 + t.a * 0.125;
  return sat(remap(t.r, -(1.0 - wfbm), 1.0, 0.0, 1.0));
}

/**
 * The vertical envelope of a cloud of type 'type' whose cell strength is 's',
 * at height fraction 'h' through the deck.
 *
 * Cumulus: a base ramp of 3.5% of the deck (30 m on a 900 m deck), which is the
 * flat condensation-level bottom every photograph of a fair-weather sky has,
 * and a dome. The dome's height is sqrt(s): the cell field falls off roughly
 * linearly from a cell's centre, so the square root turns a cone into the
 * rounded tower-in-the-middle a cumulus is.
 * Stratus: a 15% ramp, which the shape noise then turns into an undulating
 * base, and a top that stays near the deck's.
 */
// Split in two on purpose. The TOP shape is what the noise erodes against,
// so it decides the silhouette; the BASE ramp multiplies the density after
// the erosion, so the bottom is a surface and not a fade. When the base ramp
// went through the threshold too, the density at the base was so thin that
// the ray had climbed 250 m into the cloud before it was 20% opaque, and the
// eye reads that as a soft, ragged, wandering bottom.
float deckBase(float h, float type) {
  if (uCloudFlags.y < 0.5) return 1.0;
  return smoothstep(0.0, mix(0.15, 0.035, type), h);
}
float deckTop(float h, float type, float s) {
  if (uCloudFlags.y < 0.5) {
    // The pre-weather-map profile, kept only as tools/verify-clouds.ts's probe.
    return smoothstep(0.0, 0.2, h) * smoothstep(1.0, 0.6, h);
  }
  float hTop = mix(mix(0.75, 1.0, s), mix(0.22, 1.0, sqrt(s)), type);
  float topSoft = mix(0.3, 0.5, type) * hTop;
  return smoothstep(hTop, hTop - topSoft, h);
}

/**
 * Density of one deck at p, or 0. 'deck' is uLow or uMid; 'lod' is the weather
 * map level for this distance; 'cheap' skips the detail erosion, for the light
 * march and the shadow map, where an edge wisp changes nothing.
 */
float deckDensity(vec3 p, vec4 deck, bool isMid, float lod, bool cheap) {
  float cover = deck.x;
  if (cover < 0.01) return 0.0;
  float thick = max(deck.z - deck.y, 1.0);
  // Quick reject on the slab, with the most the base and top can move.
  if (p.y < deck.y - 0.1 * thick || p.y > deck.z) return 0.0;

  float h0 = sat((p.y - deck.y) / thick);
  // Drift WITH the wind: the field seen at p is the one that was upwind of it.
  // Tops lean downwind by up to 250 m: shear is why a towering cumulus is
  // never quite upright.
  vec2 windDir = uWind / max(length(uWind), 0.1);
  vec2 xz = p.xz - uWind * uTime - windDir * h0 * 250.0;
  if (isMid) xz = xz.yx * vec2(-1.0, 1.0) + vec2(17000.0, 9000.0);
  vec4 wm = textureLod(uWeather, xz * WM_SCALE, lod);

  float type = sat(deck.w + (wm.g - 0.5) * 0.5);
  // Strength of the cell this point is in: 0 at its edge, 1 at the strongest
  // cell on the map. The map is equalised, so a threshold at 1 - cover covers
  // that fraction of it. The 1.7 is erosion's share on a cumulus: the noise
  // eats the outer part of every cell, and at 1.25 a 20% deck measured 9%
  // of the sky from 30 degrees up to the horizon (tools/verify-clouds.ts),
  // where perspective should if anything make it read MORE covered. A
  // stratiform sheet barely erodes, and with the cumulus factor a 70% deck
  // had no breaks left in it.
  float m = isMid ? wm.a : wm.r;
  float cov = min(1.0, cover * mix(1.0, 1.7, deck.w));
  float s = uCloudFlags.x > 0.5 ? sat((m - (1.0 - cov)) / max(cov, 0.05)) : 1.0;
  if (s <= 0.0) return 0.0;

  // A stratiform base undulates with the low-frequency B channel; a cumulus
  // base does not, because it is the condensation level and that is a
  // property of the air mass, not of the cloud.
  float base = deck.y;
  float top = deck.z;
  if (uCloudFlags.y > 0.5) {
    base += (1.0 - type) * (wm.b - 0.5) * 0.12 * thick;
    top -= (1.0 - type) * (1.0 - wm.b) * 0.3 * thick;
  } else {
    base += 0.15 * thick * (m - 0.5);
    top += 0.25 * thick * (m - 0.5);
  }
  float h = (p.y - base) / max(top - base, 1.0);
  if (h < 0.0 || h > 1.0) return 0.0;

  float prof = deckTop(h, type, s);
  if (prof <= 0.0) return 0.0;

  // The shape noise rides the same wind, boils slowly upward (0.8 m/s through
  // a 2.4 km repeat: a billow turns over in a minute or two, not a second),
  // and is warped by the map's own low channels so its 2.4 km repeat never
  // lines up across a whole deck. That repeat at a grazing angle is what drew
  // the fan of streaks toward the vanishing point.
  // Vertically stretched by 1/0.6: billows taller than wide, which is how
  // convection builds them.
  vec3 q = vec3(xz.x, (p.y - uTime * 0.8) * 0.6, xz.y);
  q.xz += (wm.gb - 0.5) * 900.0;
  float shape = perlinWorley(q * (isMid ? SHAPE_SCALE_MID : SHAPE_SCALE_LOW));

  // The envelope rises LINEARLY across a cumulus cell, so the noise has a
  // wide band of the cell's outer half to carve billows from; a steep
  // envelope made its own smooth outline the cloud's, and the sky filled
  // with pillows. A stratiform deck saturates fast instead: it is a sheet
  // with breaks, not a field of cells.
  // The lower half is made a third more solid than the top: a cumulus is a
  // body with a cauliflower crown, and with one threshold all the way up the
  // noise left domes floating over holes in their own bodies.
  float env = uCloudFlags.x > 0.5
    ? min(1.0, prof * sat(s * mix(4.0, 1.0, type)) * mix(1.35, 1.0, sat(h * 2.0)))
    : prof;
  float thr = uCloudFlags.x > 0.5 ? 1.0 - env : 1.0 - cover;
  float d = sat(remap(shape, thr, 1.0, 0.0, 1.0)) * env * deckBase(h, type);

  if (uCloudFlags.z < 0.5) {
    // The previous erosion, kept only as tools/verify-clouds.ts's probe.
    if (!cheap && d > 0.0 && d < 0.35) {
      vec3 t = texture(uDetail, q * DETAIL_SCALE).rgb;
      float detail = t.r * 0.625 + t.g * 0.25 + t.b * 0.125;
      float ero = mix(1.0 - detail, detail, sat(h * 6.0));
      d = sat(remap(d, ero * 0.5, 1.0, 0.0, 1.0));
    }
    return d * mix(1.0, 2.2, type) * (isMid ? 0.6 : 1.0 + uPrecip * 0.6);
  }

  // STRATOCUMULUS IS A SHEET OF CELLS. Between the cumulus field and the
  // stratus deck the sky is a lumpy layer broken into rolls and cells with
  // blue between them, and the shape noise alone draws that as long streaky
  // waves: its Perlin octave seen at a grazing angle. A Worley slice at
  // ~700 m cells cuts the gaps along the cell walls; the threshold falls
  // with cover so a 70% deck keeps about a third of the sky open.
  float scW = sat(1.0 - abs(type - 0.4) * 3.0);
  if (scW > 0.0) {
    // Warped by the shape noise, or the Voronoi walls of the slice are
    // straight lines and every break in the deck is a polygon.
    vec2 cuv = xz * (1.0 / 2900.0) + (vec2(shape, wm.b) - 0.5) * 0.18;
    vec4 c4 = texture(uShape, vec3(cuv, 0.53));
    float cell = c4.g * 0.7 + c4.b * 0.3;
    // The cell value's 10th to 90th percentiles are 0.28 and 0.64 on this
    // slice, so 0.66 - 0.42 * cover leaves ~30% of a 70% deck in gaps and
    // ~20% of an 80% one.
    float gap = 0.72 - 0.42 * cover;
    // Each cell is a LENS, thickest at its centre and thinning to nothing at
    // its wall, top and bottom both. A slab cut by vertical gaps only showed
    // its sunlit walls through them, since from below a 700 m gap in a 900 m
    // deck is seen edge-on above about 35 degrees; a lens is what gives a
    // stratocumulus its dark cell centres, bright thin rims and blue breaks.
    float lens = smoothstep(gap, gap + 0.2, cell);
    float inLens = sat((lens - abs(h - 0.45) * 2.0) / 0.15);
    env *= mix(1.0, inLens, scW);
    d = sat(remap(shape, 1.0 - env, 1.0, 0.0, 1.0)) * env * deckBase(h, type);
    if (d <= 0.0) return 0.0;
  }

  // EROSION, at the edges and where it shows. Worley billows eat the outer
  // part of every cloud so the silhouette is cauliflower and not a pillow.
  // The switch is Schneider's: the inverted Worley fbm at the base, where it
  // leaves ragged wisps, and its complement above, where what it removes is
  // the CREASES between cells and what is left is packed round billows. The
  // two were the other way round before, which carved dimples into every
  // dome and was most of why a cumulus read as smooth.
  // Two scales: 300 m cells for the lobes and a 110 m octave for the
  // cauliflower on the lobes, which only near clouds resolve; past ~6 km the
  // fine octave is below a half-res pixel and skipped.
  if (!cheap && d < 0.6) {
    vec3 t = texture(uDetail, q * DETAIL_SCALE).rgb;
    float detail = t.r * 0.625 + t.g * 0.25 + t.b * 0.125;
    float ero = mix(detail, 1.0 - detail, sat(h * 8.0));
    float k = mix(0.35, 0.7, type);
    if (lod < 1.5) {
      float f = texture(uDetail, q * (DETAIL_SCALE * 2.7) + 0.37).r;
      ero = mix(ero, mix(f, 1.0 - f, sat(h * 8.0)), 0.3 * (1.0 - lod / 1.5));
    }
    d = sat(remap(d, ero * k, 1.0, 0.0, 1.0));
    // A HARD EDGE. The remap leaves a fringe of density 0..0.15 tens of
    // metres deep round every billow, which reads as fur. A cumulus has none:
    // its edge is where the updraft's air reaches saturation, and past it the
    // droplets evaporate within metres. So any density above 0.03 is lifted to
    // at least 0.15, and the boundary sits on that one iso-surface.
    d = mix(d, max(d, 0.15 * smoothstep(0.01, 0.04, d)), type);
  }
  // Cumulus are far denser than a stratus sheet: liquid water content climbs
  // with the updraft. It is also what makes a cumulus edge HARD: at 3x the
  // stratus density the visible boundary is a few tens of metres deep
  // instead of a 250 m fade, and its underside goes dark under the dome.
  // The light march and the shadow map take less of that: 1.8x, not 3x. A
  // view step is 30 to 40 m, so the first sample in a sunlit flank already
  // sits up to a step deep, and at 3x the beam to it was e^-2.7 of what the
  // surface gets. The flank came out as grey as the underside and the cloud
  // had no lit side at all.
  return d * mix(1.0, cheap ? 1.8 : 3.0, type * type) * (isMid ? 0.6 : 1.0 + uPrecip * 0.6);
}

float cloudDensity(vec3 p, float lod, bool cheap) {
  return deckDensity(p, uLow, false, lod, cheap) + deckDensity(p, uMid, true, lod, cheap);
}
`;
