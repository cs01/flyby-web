// The GLSL half of the archetype work: photographed materials with stochastic
// tiling, window frames and mullions, the room behind the glass, and
// weathering. Kept out of buildings.ts because that file is already the
// lighting model, and these are surface functions it calls.
//
// Everything here filters the way the rest of the facade does: each pattern is
// faded to its own MEAN by the pixel footprint, never to nothing, so a building
// dissolves into the same average brightness from 2 km that it has from 20 m.

import { MAT_COUNT, MATERIALS } from "./materials";

/** Per-layer contrast, from the table. Baked into the shader as a constant array. */
const CONTRAST = MATERIALS.map((m) => m.contrast.toFixed(3)).join(", ");

export const FACADE_DETAIL_GLSL = /* glsl */ `
uniform highp sampler2DArray uMatAlbedo;
uniform highp sampler2DArray uMatNormal;
uniform highp sampler2DArray uMatRH;
// Per layer: 1/tile width, 1/tile height (per metre), lattice repeats x, y.
uniform vec4 uMatInfo[${MAT_COUNT}];
// Per layer: the albedo mean, linear. The shader shows texel / mean.
uniform vec3 uMatMean[${MAT_COUNT}];
// 0 until the strips have loaded, and 0 under ?flatfacade=1.
uniform float uMatReady;
// 1 on the reduced tier: one tiling sample instead of up to three.
uniform float uMatCheap;

const float MAT_CONTRAST[${MAT_COUNT}] = float[${MAT_COUNT}](${CONTRAST});

struct MatSample {
  vec3 ratio;     // albedo over its layer mean, around 1
  vec2 nT;        // tangent-space normal xy (along, up)
  float rough;
  float height;   // 0..1, the scan's displacement
  float ao;
};

vec2 matHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// The offset one hex vertex shifts its sample by. Snapped to the lattice where
// the scan has one, so a shuffled brick course still lands on a brick course:
// shuffling by a fraction of a course would put a bed joint through the middle
// of a brick at every hex boundary.
vec2 matOffset(vec2 vtx, vec4 info) {
  vec2 h = matHash2(vtx);
  vec2 o = h;
  if (info.w > 0.5) {
    o.y = floor(h.y * info.w) / info.w;
    // A course lattice with no trusted perpend lattice keeps its x: moving a
    // running bond sideways by a non-multiple of a brick misaligns the perpends.
    o.x = info.z > 0.5 ? floor(h.x * info.z) / info.z : 0.0;
  } else if (info.z > 0.5) {
    o.x = floor(h.x * info.z) / info.z;
  }
  return o;
}

void matTap(float layer, vec2 uv, vec2 dx, vec2 dy, inout vec3 a, inout vec4 nr, float w) {
  vec3 c = textureGrad(uMatAlbedo, vec3(uv, layer), dx, dy).rgb;
  vec2 n = textureGrad(uMatNormal, vec3(uv, layer), dx, dy).rg * 2.0 - 1.0;
  vec3 r = textureGrad(uMatRH, vec3(uv, layer), dx, dy).rgb;
  a += w * c;
  nr += w * vec4(n, r.r, r.g);
}

/**
 * One material, sampled at a position in METRES on the surface (x along, y up).
 *
 * STOCHASTIC TILING. A 2.5 m brick tile repeats forty times along a 100 m wall
 * and the eye finds the period at once: a dark brick, again, and again. So the
 * plane is covered by a triangular grid of hexagons about two tiles across,
 * each with its own random offset into the scan, and every pixel blends the
 * three hexes it sits between (Mikkelsen, "Practical Real-Time Hex-Tiling",
 * JCGT 2022). The blend is variance-preserving: a plain average of three
 * samples is visibly smoother than one, so the deviation from the mean is
 * rescaled by 1 / sqrt(sum w^2) and the wall keeps the scan's own contrast.
 *
 * The gradients come from the UNOFFSET coordinate, because the offsets are
 * constant per hex and a derivative across a hex boundary would otherwise see
 * the jump and drop to the smallest mip along a one-pixel seam.
 */
MatSample sampleMat(float layer, vec2 posM) {
  int li = int(layer + 0.5);
  vec4 info = uMatInfo[li];
  // Image rows run down and walls run up, so y is flipped: the scan's own
  // "up" (OpenGL normal convention) is then the wall's up.
  vec2 uv = vec2(posM.x * info.x, -posM.y * info.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 a = vec3(0.0);
  vec4 nr = vec4(0.0);
  float wsq = 1.0;
  if (uMatCheap > 0.5) {
    matTap(layer, uv, dx, dy, a, nr, 1.0);
  } else {
    // Hex grid two tiles across, skewed into a triangle lattice.
    vec2 st = uv * 0.5 * 3.4641016;
    vec2 sk = vec2(st.x - 0.57735027 * st.y, 1.15470054 * st.y);
    vec2 base = floor(sk);
    vec3 t = vec3(fract(sk), 0.0);
    t.z = 1.0 - t.x - t.y;
    float s = step(0.0, -t.z);
    float s2 = 2.0 * s - 1.0;
    vec3 w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
    vec2 v1 = base + vec2(s, s);
    vec2 v2 = base + vec2(s, 1.0 - s);
    vec2 v3 = base + vec2(1.0 - s, s);
    // Sharpened, so most of a hex is one sample and only its rim blends: less
    // ghosting of two brick patterns over each other, and the third tap is
    // skipped over most of the wall.
    w = w * w * w;
    w /= max(w.x + w.y + w.z, 1e-5);
    if (w.x > 0.02) matTap(layer, uv + matOffset(v1, info), dx, dy, a, nr, w.x);
    if (w.y > 0.02) matTap(layer, uv + matOffset(v2, info), dx, dy, a, nr, w.y);
    if (w.z > 0.02) matTap(layer, uv + matOffset(v3, info), dx, dy, a, nr, w.z);
    float wsum = (w.x > 0.02 ? w.x : 0.0) + (w.y > 0.02 ? w.y : 0.0) + (w.z > 0.02 ? w.z : 0.0);
    a /= wsum; nr /= wsum;
    wsq = sqrt((w.x * w.x + w.y * w.y + w.z * w.z)) / wsum;
  }
  MatSample m;
  vec3 mean = uMatMean[li];
  float k = MAT_CONTRAST[li];
  // Deviation from the mean, restored to one sample's variance, then scaled
  // by the layer's contrast. The mip chain is what takes this to 1 far away.
  vec3 dev = (a / mean - 1.0) / max(wsq, 0.3);
  m.ratio = max(vec3(0.0), 1.0 + dev * k);
  m.nT = nr.xy / max(wsq, 0.3);
  m.rough = nr.z;
  m.height = nr.w;
  m.ao = 1.0;
  return m;
}

/**
 * The frame and the bars of one window, as a 0..1 mask over the OPENING.
 *
 * w is the position inside the glazed rectangle (0..1 across, 0..1 up), sz the
 * rectangle's size in metres, fw the per-axis pixel footprint in the same 0..1
 * units. Every bar is a box of fixed METRIC width, because a sash rail is 60
 * mm whether the window is 0.9 m or 2.9 m wide, and it fades to its own area
 * share once it is under a pixel.
 */
float barV(float x, float at, float halfW, float fw) {
  return smoothstep(halfW + fw, halfW - fw, abs(x - at));
}

float windowFrame(vec2 w, vec2 sz, vec2 fw, float style, float frameM, float divs, out float mean) {
  vec2 f = vec2(frameM) / sz;           // frame face as a fraction of the opening
  vec2 r = vec2(0.032) / sz;            // half a sash rail or a glazing bar
  float frame = 1.0 - smoothstep(f.x - fw.x, f.x + fw.x, w.x) * smoothstep(1.0 - f.x + fw.x, 1.0 - f.x - fw.x, w.x)
                    * smoothstep(f.y - fw.y, f.y + fw.y, w.y) * smoothstep(1.0 - f.y + fw.y, 1.0 - f.y - fw.y, w.y);
  float bars = 0.0;
  float barMean = 0.0;
  int st = int(style + 0.5);
  if (st == 0) {            // one-over-one sash: the meeting rail
    bars = barV(w.y, 0.5, r.y * 1.4, fw.y);
    barMean = 2.8 * r.y;
  } else if (st == 1) {     // casement pair or slider
    bars = barV(w.x, 0.5, r.x * 1.3, fw.x);
    barMean = 2.6 * r.x;
  } else if (st == 2) {     // Chicago: fixed centre light, a sash either side
    float side = barV(w.x, 0.24, r.x * 1.6, fw.x) + barV(w.x, 0.76, r.x * 1.6, fw.x);
    float rail = barV(w.y, 0.5, r.y * 1.3, fw.y) * (1.0 - step(0.24, w.x) * step(w.x, 0.76));
    bars = max(side, rail);
    barMean = 6.4 * r.x + 2.6 * r.y * 0.48;
  } else if (st == 3) {     // curtain wall: a transom over the spandrel glass
    bars = barV(w.y, 0.14, r.y, fw.y);
    barMean = 2.0 * r.y;
  } else if (st == 5) {     // industrial steel sash: a grid of small panes
    float nx = max(divs, 2.0);
    float ny = max(2.0, floor(sz.y / 0.5 + 0.5));
    vec2 g = fract(w * vec2(nx, ny) + 0.5) - 0.5;
    vec2 gw = fw * vec2(nx, ny);
    vec2 rb = r * vec2(nx, ny) * 0.7;
    bars = max(smoothstep(rb.x + gw.x, rb.x - gw.x, abs(g.x)), smoothstep(rb.y + gw.y, rb.y - gw.y, abs(g.y)));
    barMean = min(1.0, 1.4 * (r.x * nx + r.y * ny));
  } else if (st == 6) {     // bay: three lights
    bars = max(max(barV(w.x, 0.3, r.x * 1.6, fw.x), barV(w.x, 0.7, r.x * 1.6, fw.x)), barV(w.y, 0.5, r.y * 1.3, fw.y));
    barMean = 6.4 * r.x + 2.6 * r.y;
  } else if (st == 7) {     // six-over-one: muntins in the upper sash only
    float rail = barV(w.y, 0.5, r.y * 1.4, fw.y);
    float n = max(divs, 2.0);
    float mx = abs(fract(w.x * n + 0.5) - 0.5);
    float mun = smoothstep(r.x * n * 0.6 + fw.x * n, r.x * n * 0.6 - fw.x * n, mx) * step(0.5, w.y);
    float mh = barV(w.y, 0.76, r.y * 0.8, fw.y);
    bars = max(rail, max(mun, mh));
    barMean = 2.8 * r.y + 0.5 * 1.2 * r.x * n + 1.6 * r.y;
  }
  float frameMean = 1.0 - (1.0 - 2.0 * f.x) * (1.0 - 2.0 * f.y);
  mean = clamp(frameMean + barMean * (1.0 - frameMean), 0.0, 1.0);
  return clamp(max(frame, bars), 0.0, 1.0);
}

/**
 * THE ROOM BEHIND THE GLASS: interior mapping (van Dongen, 2008).
 *
 * A window was a dark tinted rectangle, and that is the tell from the street:
 * a real window has a room behind it, with a floor, a ceiling and a back wall
 * that slide against each other as you move. One ray-box intersection per
 * pixel, in the wall's own frame, against a room one column wide, one storey
 * tall and a few metres deep. No atlas: each surface is drawn analytically,
 * which costs no download and filters through the same mean as everything else.
 *
 * Returns the room's radiance factor in rgb (an albedo by day, a relative
 * brightness by night) and in .a how much of that is lamp-lit ceiling, so the
 * caller can tell a lit room from a dark one.
 *
 *   p    point on the glass, metres, x across the cell, y up from the slab
 *   v    view ray in the wall frame: x along, y up, z INTO the building
 */
vec4 roomColour(vec3 p, vec3 v, vec2 cellM, float depth, float kind, float seed, float night) {
  float floorY = 0.0;
  float ceilY = cellM.y - 0.30;
  v.z = max(v.z, 0.05);
  float tx = v.x > 0.0 ? (cellM.x - p.x) / max(v.x, 1e-4) : -p.x / min(v.x, -1e-4);
  float ty = v.y > 0.0 ? (ceilY - p.y) / max(v.y, 1e-4) : (floorY - p.y) / min(v.y, -1e-4);
  float tz = depth / v.z;
  float t = min(tx, min(ty, tz));
  vec3 h = p + v * t;

  float h1 = fract(sin(seed * 91.7) * 43758.5);
  float h2 = fract(sin(seed * 27.3) * 23421.6);
  float h3 = fract(sin(seed * 63.1) * 61223.3);
  int k = int(kind + 0.5);

  // Surfaces, by kind. Albedos are what the rooms are actually finished in.
  vec3 wallC = k == 1 ? mix(vec3(0.55, 0.55, 0.53), vec3(0.62, 0.60, 0.55), h1)        // office: off-white
             : k == 2 ? mix(vec3(0.30, 0.16, 0.11), vec3(0.55, 0.52, 0.48), step(0.5, h1)) // loft: brick or white
             : mix(mix(vec3(0.62, 0.58, 0.50), vec3(0.50, 0.55, 0.58), h1), vec3(0.65, 0.48, 0.36), step(0.85, h2)); // flat: paint
  vec3 floorC = k == 1 ? vec3(0.12, 0.13, 0.15)                                        // carpet tile
              : k == 2 ? vec3(0.22, 0.21, 0.20)                                         // concrete
              : mix(vec3(0.24, 0.14, 0.07), vec3(0.35, 0.24, 0.14), h2);                // timber
  vec3 ceilC = vec3(0.70, 0.70, 0.68);
  vec3 c;
  float lampLit = 0.0;
  if (t == tz) {
    c = wallC;
    // Furniture against the back wall: a low band of desks and screens in an
    // office, a sofa or a bookcase at home. Blocks of a single darker value,
    // because at the distance anyone sees a room from that is what they are.
    float fx = h.x / cellM.x;
    if (k == 1) {
      float desk = step(0.72, h.y) * step(h.y, 1.25);
      c = mix(c, vec3(0.18, 0.19, 0.21), desk * step(0.1, fract(fx * 2.0 + h3)));
    } else if (k == 0) {
      float w0 = 0.15 + 0.4 * h3, w1 = w0 + 0.35 + 0.2 * h2;
      float tallPiece = step(0.6, h1);
      float top = mix(0.85, 1.95, tallPiece);
      float block = step(w0, fx) * step(fx, w1) * step(h.y, top);
      c = mix(c, mix(vec3(0.20, 0.15, 0.12), vec3(0.32, 0.30, 0.34), h2), block);
      // A picture over it.
      float pic = step(w0 + 0.05, fx) * step(fx, w0 + 0.2) * step(1.35, h.y) * step(h.y, 1.75) * (1.0 - tallPiece);
      c = mix(c, vec3(0.25, 0.22, 0.18), pic);
    }
  } else if (t == ty) {
    if (v.y > 0.0) {
      c = ceilC;
      // Ceiling fixtures. An office ceiling is a grid of 0.6 x 1.2 m panels;
      // a flat has one fitting in the middle of the room.
      vec2 cp = h.xz;
      float lamp;
      if (k == 1) {
        vec2 g = abs(fract(cp / vec2(1.8, 2.4)) - 0.5);
        lamp = step(g.x, 0.17) * step(g.y, 0.25);
      } else {
        lamp = 1.0 - smoothstep(0.12, 0.22, length(cp - vec2(cellM.x * 0.5, depth * 0.45)));
      }
      lampLit = lamp;
      c = mix(c, vec3(0.9), lamp * 0.5);
    } else {
      c = floorC;
      // A rug or a desk chair's worth of variation, not a pattern.
      c *= 0.85 + 0.3 * step(0.5, fract(h.x * 0.7 + h.z * 0.4 + h1));
    }
  } else {
    c = wallC * 0.92;
  }

  // Light falls off into the room by day (it all came through this window) and
  // from the ceiling down at night.
  float day = mix(1.0, 0.35, clamp(h.z / depth, 0.0, 1.0));
  float lamp = mix(0.55, 1.0, clamp(h.y / ceilY, 0.0, 1.0)) * (1.0 - 0.35 * clamp(h.z / depth, 0.0, 1.0));
  float shade = mix(day, lamp, night);
  return vec4(c * shade, lampLit);
}
`;
