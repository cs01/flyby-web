// The insides of Pompeii's houses: the painted wall schemes, the floors and
// the ceilings the town shader (render/pompeii.ts FRAG) draws procedurally,
// and the furniture and fittings render/pompeiimesh.ts builds as geometry.
// The GLSL here is spliced into FRAG ahead of main(), so it can use the
// noise helpers and mosaicFigure() defined there.

import { lathe, tube, type Sink } from "./pompeiiorders";

type V3 = [number, number, number];
type RGB = [number, number, number];

/** Floor designs for Surf.Floor's p1 (render/pompeiimesh.ts). */
export const enum FloorKind {
  /** Opus signinum with white tesserae set in a lozenge net. */
  SigninumNet = 0,
  /** Opus signinum with a white meander border and crosses in the field. */
  SigninumMeander = 1,
  /** White tessellatum with a black border band and black crosslets. */
  BlackWhite = 2,
  /** Opus sectile: coloured marble squares, lozenges and roundels. */
  Sectile = 3,
  /** Black tessellatum with white lines and a dotted field (atria). */
  BlackField = 4,
}

/** Ceiling designs for Surf.Ceiling's p1. */
export const enum CeilingKind {
  /** Boards on exposed joists: the atrium roof seen from below. */
  Joists = 0,
  /** Coffered (lacunaria): painted wooden coffers with gilt rosettes. */
  Coffers = 1,
  /** A flat stuccoed ceiling painted with a lattice of fillets and medallions. */
  Painted = 2,
}

export const INTERIOR_GLSL = /* glsl */ `
// A line of half width w at distance d, antialiased over aa.
float ln(float d, float w, float aa) { return 1.0 - smoothstep(w - aa, w + aa, d); }

// The grounds a Pompeian painter worked on: red ochre, yellow ochre, black,
// cinnabar, Egyptian blue, white.
vec3 pwGround(float i) {
  return i < 0.5 ? vec3(0.5, 0.085, 0.05) : i < 1.5 ? vec3(0.74, 0.5, 0.16) : i < 2.5 ? vec3(0.04, 0.036, 0.032)
       : i < 3.5 ? vec3(0.64, 0.1, 0.045) : i < 4.5 ? vec3(0.09, 0.2, 0.42) : vec3(0.84, 0.8, 0.7);
}

// A candelabrum painted up an interpanel: x metres off its axis, y up from its foot, Hc its height.
float candelabrum(float x, float y, float Hc, float aa) {
  float ax = abs(x);
  float stem = ln(ax, 0.008, aa) * step(y, Hc);
  float k = fract(y / 0.38);
  float dish = ln(abs(k - 0.5) * 0.38, 0.009, aa) * ln(ax, 0.06, aa) * step(0.2, y) * step(y, Hc - 0.1);
  float foot = step(y, 0.08) * ln(ax, 0.07 - y * 0.6, aa);
  float ty = y - Hc;
  float bowl = step(0.0, ty) * step(ty, 0.09) * ln(ax, 0.02 + 0.3 * ty, aa);
  return clamp(stem + dish + foot + bowl, 0.0, 1.0);
}

// A small picture in a panel's middle: p 0..1 across it, a landscape with a shrine and a tree.
vec3 vignettePic(vec2 p, float r) {
  vec3 sky = mix(vec3(0.7, 0.72, 0.66), vec3(0.5, 0.62, 0.66), p.y);
  float shore = 0.4 + 0.05 * sin(p.x * 7.0 + r * 20.0);
  vec3 c = p.y > shore ? sky : mix(vec3(0.34, 0.4, 0.28), vec3(0.28, 0.42, 0.48), step(0.5, r));
  vec2 b = p - vec2(0.2 + 0.4 * r, shore - 0.02);
  if (b.x > 0.0 && b.x < 0.18 && b.y > 0.0 && b.y < 0.14) c = vec3(0.82, 0.78, 0.68) * (b.x < 0.03 || b.x > 0.15 ? 0.8 : 1.0);
  if (b.x > -0.02 && b.x < 0.2 && b.y >= 0.14 && b.y < 0.23 - abs(b.x - 0.09) * 0.8) c = vec3(0.55, 0.25, 0.15);
  vec2 t = p - vec2(fract(0.62 + r * 0.7) * 0.8 + 0.1, shore + 0.2);
  if (dot(t, t * vec2(1.0, 0.7)) < 0.012) c = vec3(0.16, 0.24, 0.12);
  return c;
}

// The Third and Fourth Style scheme on a wall u metres along (of len), h up
// (of H): a dado, the middle zone of large panels with fine borders and a
// small picture, slender candelabra in the interpanels, a frieze, an upper
// zone of painted architecture on a pale ground, and a stucco cornice.
// code picks the ground and the style (0: from the seed). Fine detail fades
// out past 15-35 m; aoOut darkens the cornice's undercut.
vec3 paintedWall(float u, float h, float len, float H, float seed, float code, float dist, out float aoOut) {
  aoOut = 1.0;
  if (len < 0.5) len = 4.0;
  if (H < 1.5) H = 3.5;
  if (code > 199.5) {
    // The First Style: stucco modelled and painted as a wall of coloured
    // marble blocks. A yellow dado, a course of tall orthostates, then
    // courses of smaller blocks in running bond, each with a drafted margin
    // (a raised border that catches the light, a shadow under it).
    float aa0 = 0.0015 + 0.0011 * dist;
    float det = 1.0 - smoothstep(14.0, 36.0, dist);
    vec3 c;
    vec2 bsz; float y0;
    if (h < 0.12) return vec3(0.08, 0.07, 0.06);
    if (h < 0.92) { bsz = vec2(1.6, 0.8); y0 = 0.12; }
    else if (h < 2.2) { bsz = vec2(1.15, 1.28); y0 = 0.92; }
    else if (h < H - 0.35) { bsz = vec2(0.92, 0.44); y0 = 2.2; }
    else {
      c = vec3(0.88, 0.85, 0.78);
      float t = H - h;
      if (t < 0.22 && t > 0.12) c *= mix(1.0, 0.7 + 0.3 * step(0.5, fract(u / 0.08)), det);
      if (t > 0.24) aoOut = 0.65;
      return c;
    }
    vec2 b = vec2(u, h - y0) / bsz;
    b.x += 0.5 * step(1.0, mod(floor(b.y), 2.0));
    vec2 id = floor(b), f = fract(b) * bsz;
    float r = h21(id + floor(seed * 91.0));
    vec3 pal = h < 0.92 ? vec3(0.74, 0.56, 0.26)
      : h < 2.2 ? (r < 0.25 ? vec3(0.5, 0.09, 0.06) : r < 0.45 ? vec3(0.07, 0.065, 0.06) : r < 0.65 ? vec3(0.36, 0.12, 0.2) : r < 0.85 ? vec3(0.72, 0.54, 0.22) : vec3(0.26, 0.36, 0.26))
      : (r < 0.7 ? vec3(0.86, 0.82, 0.72) * (0.95 + 0.1 * fract(r * 13.0)) : r < 0.88 ? vec3(0.8, 0.7, 0.5) : vec3(0.72, 0.44, 0.34));
    // Veining: the marbles it imitates.
    float vein = abs(fbm(vec2(u, h) * 2.6 + r * 17.0) - 0.5);
    c = mix(pal * 0.78, pal, smoothstep(0.0, 0.06, vein) * mix(0.5, 1.0, det) + (1.0 - det) * 0.5);
    float m = min(min(f.x, bsz.x - f.x), min(f.y, bsz.y - f.y));
    // The drafted margin: lit on its upper edge, shaded on the lower, the joint dark.
    float margin = ln(m, 0.045, aa0) - ln(m, 0.012, aa0);
    c = mix(c, pal * 1.15 + 0.04, margin * 0.35 * det);
    c = mix(c, vec3(0.2, 0.17, 0.14), ln(m, 0.008, aa0) * mix(0.4, 1.0, det));
    if (f.y < 0.05) aoOut = mix(1.0, 0.7, det);
    return c;
  }
  float k = code > 0.5 ? code : floor(seed * 251.0) + 1.0;
  float r0 = fract(k * 0.618 + 0.13);
  float gi = r0 < 0.34 ? 0.0 : r0 < 0.54 ? 1.0 : r0 < 0.74 ? 2.0 : r0 < 0.9 ? 3.0 : r0 < 0.96 ? 4.0 : 5.0;
  bool fourth = fract(k * 0.371 + 0.29) < 0.55;
  vec3 ground = pwGround(gi);
  vec3 alt = gi > 0.5 && gi < 1.5 ? pwGround(0.0) : gi > 1.5 && gi < 2.5 ? pwGround(0.0) : gi > 4.5 ? pwGround(1.0) : pwGround(1.0);
  vec3 inter = gi > 1.5 && gi < 2.5 ? pwGround(3.0) : pwGround(2.0);
  vec3 lineC = (gi > 0.5 && gi < 1.5) || gi > 4.5 ? vec3(0.42, 0.08, 0.05) : vec3(0.88, 0.8, 0.58);
  float aa = 0.0015 + 0.0011 * dist;
  float detail = 1.0 - smoothstep(14.0, 36.0, dist);
  float dadoTop = clamp(H * 0.2, 0.7, 1.05);
  float midTop = min(H - 0.55, dadoTop + clamp((H - dadoTop) * 0.62, 1.4, 2.6));
  float nP = max(1.0, floor(len / 2.3 + 0.5));
  float bay = len / nP;
  float bi = floor(u / bay);
  float q = u - bi * bay;
  float iw = min(0.46, bay * 0.2);
  float de = min(q, bay - q);
  vec3 c;
  if (h < 0.12) {
    c = vec3(0.07, 0.06, 0.055);
  } else if (h < dadoTop) {
    if (fourth) {
      // Imitation marble, giallo antico or a pink breccia, veined, in slabs.
      float vein = abs(fbm(vec2(u * 2.3, h * 2.3) + seed * 9.0) - 0.5);
      vec3 marb = fract(k * 0.77) < 0.5 ? vec3(0.76, 0.6, 0.34) : vec3(0.7, 0.48, 0.42);
      c = mix(marb * 0.72, marb, smoothstep(0.0, 0.05, vein) * mix(0.4, 1.0, detail));
      c = mix(c, vec3(0.05), ln(de, 0.025, aa));
    } else {
      c = vec3(0.045, 0.04, 0.036);
      float dd = min(de, min(h - 0.12, dadoTop - h));
      c = mix(c, vec3(0.55, 0.12, 0.06), ln(abs(dd - 0.07), 0.006, aa) * detail);
      // A plant in each dado panel: a stem and paired leaves.
      float px = q - bay * 0.5, py = (h - 0.12) / (dadoTop - 0.12);
      float leaf = ln(abs(px), 0.006, aa) * step(py, 0.7) + ln(length(vec2(abs(px) - 0.05 * py, fract(py * 4.0) * 0.18 - 0.09) * vec2(1.0, 2.0)), 0.03, aa) * step(py, 0.75) * step(0.15, py);
      c = mix(c, vec3(0.3, 0.42, 0.24), clamp(leaf, 0.0, 1.0) * detail);
    }
  } else if (h < dadoTop + 0.05) {
    c = fourth ? vec3(0.05) : vec3(0.34, 0.42, 0.24);
  } else if (h < midTop) {
    float Hm = midTop - dadoTop - 0.05;
    float y = h - dadoTop - 0.05;
    if (de < iw * 0.5) {
      // The interpanel: a narrow strip with a candelabrum up its middle.
      c = inter;
      float cand = candelabrum(de, y - 0.05, Hm - 0.25, aa);
      c = mix(c, vec3(0.8, 0.62, 0.28), cand * mix(0.4, 1.0, detail));
    } else {
      float W = bay - iw;
      float px = q - iw * 0.5;
      float dP = min(min(px, W - px), min(y, Hm - y));
      bool altp = fourth && mod(bi, 2.0) > 0.5;
      c = altp ? alt : ground;
      vec3 lc = altp ? (alt.r > 0.6 && alt.g > 0.4 ? vec3(0.42, 0.08, 0.05) : vec3(0.88, 0.8, 0.58)) : lineC;
      c = mix(c, lc, ln(abs(dP - 0.06), 0.007, aa) * mix(0.5, 1.0, detail));
      if (fourth && dP > 0.09 && dP < 0.15) {
        // An embroidered border: open squares and dots alternating round the frame.
        float along = min(px, W - px) < min(y, Hm - y) ? y : px;
        float cell = fract(along / 0.07);
        float across = (dP - 0.09) / 0.06;
        float sq = max(abs(cell - 0.5), abs(across - 0.5));
        float pat = mod(floor(along / 0.07), 2.0) > 0.5 ? ln(sq, 0.3, 0.06) - ln(sq, 0.16, 0.06) : ln(length(vec2(cell, across) - 0.5), 0.17, 0.06);
        c = mix(c, lc, clamp(pat, 0.0, 1.0) * 0.85 * detail);
      }
      // The panel's picture: a floating figure, or in the Fourth Style a framed landscape.
      vec2 vc = vec2(px - W * 0.5, y - Hm * 0.52);
      float vr = h21(vec2(bi, k));
      if (vr < 0.7 && detail > 0.0) {
        if (fourth && vr < 0.4) {
          vec2 hs = vec2(min(0.3, W * 0.2), min(0.24, Hm * 0.14));
          vec2 av = abs(vc);
          if (av.x < hs.x + 0.03 && av.y < hs.y + 0.03) {
            vec3 pic = av.x < hs.x && av.y < hs.y ? vignettePic((vc + hs) / (2.0 * hs), fract(vr * 7.3)) : vec3(0.12, 0.1, 0.08);
            c = mix(c, pic, detail);
          }
        } else {
          float fs = min(0.62, Hm * 0.32);
          vec3 f = mosaicFigure((vc + vec2(0.0, fs * 0.5)) / fs * vec2(1.0 + 0.25 * sign(vr - 0.35), 1.0), fract(vr * 13.0) < 0.6, fract(vr * 29.0) < 0.5);
          float inF = 1.0 - smoothstep(-0.004, 0.004, f.z);
          vec3 skin = vec3(0.62, 0.4, 0.28), robe = fract(vr * 5.0) < 0.33 ? vec3(0.42, 0.52, 0.5) : fract(vr * 5.0) < 0.66 ? vec3(0.55, 0.36, 0.5) : vec3(0.78, 0.66, 0.4);
          c = mix(c, mix(skin, robe, max(f.x, f.y)), inF * detail);
        }
      }
    }
  } else if (h < midTop + 0.24) {
    // The frieze: a dark band with palmettes and tendrils.
    c = gi > 1.5 && gi < 2.5 ? vec3(0.5, 0.09, 0.05) : vec3(0.05, 0.045, 0.04);
    float fy = (h - midTop) / 0.24;
    float fx = fract(u / 0.32) - 0.5;
    float palm = ln(length(vec2(fx * 2.0, (fy - 0.45) * 1.2)), 0.22 + 0.06 * cos(atan(fy - 0.45, fx) * 7.0), 0.04);
    float tendril = ln(abs(fy - 0.5 - 0.2 * sin(u / 0.32 * 6.2832)), 0.04, 0.03);
    c = mix(c, vec3(0.82, 0.68, 0.34), clamp(palm * step(0.0, fx + 0.25) + tendril * 0.6, 0.0, 1.0) * detail * 0.85);
  } else if (h < H - 0.2) {
    // The upper zone: painted architecture on a white ground.
    c = vec3(0.86, 0.82, 0.72);
    float Hu = max(0.2, H - 0.2 - midTop - 0.24);
    float y = h - midTop - 0.24, yy = y / Hu;
    float cx = abs(q - bay * 0.5);
    if (fourth && cx < bay * 0.24 && yy < 0.76) {
      // A vista through the wall: pale sky, a little pavilion seen deep.
      c = mix(c, vec3(0.66, 0.74, 0.76), 0.65);
      float pc = ln(abs(cx - bay * 0.13), 0.01, aa) * step(yy, 0.5);
      float roof = ln(abs(y - Hu * 0.5 - (bay * 0.15 - cx) * 0.45), 0.012, aa) * step(cx, bay * 0.15);
      float recede = ln(abs(cx - bay * 0.24 + (0.76 - yy) * bay * 0.12), 0.008, aa);
      c = mix(c, vec3(0.62, 0.44, 0.24), clamp(pc + roof + recede, 0.0, 1.0) * detail);
    }
    float gy = Hu * 0.7 - 0.16 * sin(3.1416 * q / bay);
    c = mix(c, vec3(0.25, 0.36, 0.15), ln(abs(y - gy), 0.014, aa) * step(0.05, de) * detail);
    float colW = fourth ? 0.04 : 0.026;
    if (de < colW) c = (fourth ? vec3(0.74, 0.56, 0.26) : vec3(0.55, 0.12, 0.07)) * (0.6 + 0.5 * sqrt(1.0 - de / colW));
    c = mix(c, vec3(0.62, 0.48, 0.28), ln(abs(yy - 0.8), 0.025, aa * 0.5 / Hu));
  } else {
    // The stucco cornice: a moulding with dentils, its underside in shadow.
    c = vec3(0.9, 0.87, 0.8);
    float t = H - h;
    if (t < 0.14 && t > 0.07) c *= mix(1.0, 0.72 + 0.28 * step(0.5, fract(u / 0.07)), detail);
    if (t > 0.16) aoOut = 0.6;
  }
  // A lime ground polished smooth, a little unevenly.
  c *= 0.9 + 0.14 * fbm(vec2(u, h) * 0.8 + seed * 7.0);
  return c;
}

// A tessera at metres q: 0..1, darker in the joints (fades out by the time joints are under a pixel).
float tesserae(vec2 q, float size, float dist) {
  vec2 f = abs(fract(q / size) - 0.5);
  float j = smoothstep(0.38, 0.5, max(f.x, f.y));
  return 1.0 - 0.18 * j * (1.0 - smoothstep(3.0, 7.0, dist));
}

// A floor: q metres from the room's corner along its two sides, size the
// room (0 when not known: no border); kind a FloorKind. Lozenge nets,
// meanders and borders in tesserae, signinum, sectile.
vec3 floorPaint(vec2 q, vec2 size, float kind, float seed, float dist, out float gl) {
  float aa = 0.0015 + 0.0011 * dist;
  float detail = 1.0 - smoothstep(10.0, 30.0, dist);
  bool hasB = size.x > 0.5 && size.y > 0.5;
  float de = hasB ? min(min(q.x, size.x - q.x), min(q.y, size.y - q.y)) : 9.0;
  float along = hasB && min(q.x, size.x - q.x) < min(q.y, size.y - q.y) ? q.y : q.x;
  vec3 white = vec3(0.86, 0.84, 0.78), black = vec3(0.06, 0.06, 0.06);
  vec3 c;
  gl = 0.15;
  if (kind < 1.5) {
    // Opus signinum: lime and crushed tile, flecked with the aggregate.
    c = vec3(0.56, 0.31, 0.22) * (0.86 + 0.2 * fbm(q * 0.9 + seed * 17.0));
    c *= mix(1.0, 0.8 + 0.35 * h21(floor(q / 0.011)), detail * 0.6);
    float wt = 0.0;
    if (kind < 0.5) {
      vec2 g = mat2(0.7071, 0.7071, -0.7071, 0.7071) * q / 0.16;
      wt = ln(length(fract(g) - 0.5) * 0.16, 0.01, aa);
      // Every fourth row a line of tesserae joining them.
      wt = max(wt, ln(abs(fract(g.x / 4.0) - 0.5) * 0.64, 0.006, aa) * 0.8);
    } else if (de > 0.12 && de < 0.42) {
      // A meander in white tesserae round the border: a hooked key 6 x 5 units.
      float unit = 0.06;
      float t = (de - 0.12) / unit;
      int ix = int(mod(floor(along / unit), 6.0)), iy = int(clamp(floor(t), 0.0, 4.0));
      int row = iy == 0 ? 63 : iy == 1 ? 1 : iy == 2 ? 29 : iy == 3 ? 17 : 31;
      wt = float((row >> ix) & 1);
    } else if (de >= 0.42) {
      // Crosslets scattered on a 0.4 m grid.
      vec2 f = abs(fract(q / 0.4) - 0.5) * 0.4;
      wt = ln(min(f.x, f.y), 0.008, aa) * step(max(f.x, f.y), 0.04);
    }
    if (hasB) wt = max(wt, ln(abs(de - 0.07), 0.01, aa));
    c = mix(c, white, wt * mix(0.35, 1.0, detail));
  } else if (kind < 2.5) {
    // White tessellatum, a black band round it, black crosslets in the field.
    c = white * (0.94 + 0.08 * vnoise(q * 3.0 + seed * 9.0));
    float b = hasB ? ln(abs(de - 0.3), 0.12, aa) + ln(abs(de - 0.08), 0.02, aa) : 0.0;
    vec2 f = abs(fract(q / 0.5) - 0.5) * 0.5;
    float cross_ = ln(min(f.x, f.y), 0.015, aa) * step(max(f.x, f.y), 0.07) * step(0.48, de);
    // A wave crest in white along the band's middle.
    float wave = hasB ? ln(abs(de - 0.3 - 0.05 * sin(along * 20.94)), 0.02, aa) : 0.0;
    c = mix(c, black, clamp(b + cross_, 0.0, 1.0) * mix(0.7, 1.0, detail));
    c = mix(c, white, wave * detail);
    c *= tesserae(q, 0.012, dist);
    gl = 0.25;
  } else if (kind < 3.5) {
    // Opus sectile: squares of giallo antico framing pavonazzetto lozenges,
    // porphyry and serpentine roundels in them.
    vec2 cell = floor(q / 0.6), f = fract(q / 0.6) - 0.5;
    float r = h21(cell + floor(seed * 37.0));
    vec3 ca = vec3(0.78, 0.62, 0.34), cb = vec3(0.84, 0.8, 0.78), cc = r < 0.5 ? vec3(0.42, 0.11, 0.1) : vec3(0.18, 0.3, 0.18);
    float dia = abs(f.x) + abs(f.y);
    c = dia < 0.5 ? cb : ca;
    if (length(f) < 0.17) c = cc;
    float vein = vnoise(q * 9.0 + cell * 3.0);
    c *= 0.9 + 0.15 * vein * detail;
    float joint = min(ln(abs(dia - 0.5), 0.004, aa) + ln(abs(length(f) - 0.17), 0.004, aa) + ln(0.5 - max(abs(f.x), abs(f.y)), 0.004, aa), 1.0);
    c = mix(c, vec3(0.3, 0.27, 0.24), joint * detail);
    if (hasB && de < 0.25) c = vec3(0.2, 0.16, 0.14) * (0.9 + 0.2 * vnoise(q * 6.0));
    gl = 0.45;
  } else {
    // Black tessellatum, white dots in a grid and white fillets at the border.
    c = black * (0.9 + 0.2 * vnoise(q * 4.0 + seed * 5.0)) + 0.02;
    vec2 g = fract(q / 0.2) - 0.5;
    float d = ln(length(g) * 0.2, 0.008, aa);
    float b = hasB ? ln(abs(de - 0.1), 0.012, aa) + ln(abs(de - 0.2), 0.012, aa) : 0.0;
    c = mix(c, white, clamp(d * step(0.26, de) + b, 0.0, 1.0) * mix(0.4, 1.0, detail));
    c *= tesserae(q, 0.012, dist);
    gl = 0.25;
  }
  return c;
}

// A ceiling, q metres along its two axes; kind a CeilingKind. aoOut is the
// coffers' and joists' own shadowing.
vec3 ceilingPaint(vec2 q, float kind, float seed, float dist, out float aoOut) {
  float aa = 0.0015 + 0.0011 * dist;
  float detail = 1.0 - smoothstep(12.0, 30.0, dist);
  vec3 wood = vec3(0.36, 0.24, 0.14) * (0.85 + 0.25 * vnoise(vec2(q.x * 2.0, q.y * 18.0) + seed * 5.0));
  aoOut = 1.0;
  if (kind < 0.5) {
    // Joists every 0.55 m across boards.
    float jx = fract(q.x / 0.55) * 0.55;
    float jd = min(jx, 0.55 - jx);
    vec3 boards = wood * (0.9 + 0.15 * h21(vec2(floor(q.y / 0.22), seed))) * (1.0 - 0.3 * ln(abs(fract(q.y / 0.22) - 0.5) * 0.22 - 0.11, 0.004, aa));
    vec3 c = jd < 0.06 ? wood * 0.75 : boards;
    aoOut = jd < 0.06 ? 1.0 : 0.55 + 0.45 * smoothstep(0.06, 0.2, jd);
    return c;
  }
  if (kind < 1.5) {
    // Coffers 0.7 m square in a painted grid of beams.
    vec2 f = abs(fract(q / 0.7) - 0.5) * 0.7;
    float e = 0.35 - max(f.x, f.y);
    vec3 beam = vec3(0.86, 0.82, 0.72);
    vec3 ground = fract(seed * 7.3) < 0.5 ? vec3(0.12, 0.2, 0.38) : vec3(0.5, 0.09, 0.05);
    vec3 c;
    if (e < 0.06) { c = beam; if (e > 0.045) c = vec3(0.55, 0.12, 0.07); }
    else {
      // Two steps down into the coffer, darker each step, a rosette in the middle.
      c = e < 0.11 ? vec3(0.78, 0.72, 0.6) : ground;
      float r = length(f), a = atan(f.y, f.x);
      float ros = ln(r, 0.07 + 0.03 * cos(a * 8.0), aa);
      c = mix(c, vec3(0.85, 0.66, 0.28), ros * detail);
      aoOut = 0.55 + 0.45 * smoothstep(0.06, 0.2, e);
    }
    return c;
  }
  // White stucco with a painted lattice of red fillets and yellow roundels.
  vec3 c = vec3(0.84, 0.79, 0.68);
  vec2 g = mat2(0.7071, 0.7071, -0.7071, 0.7071) * q;
  vec2 f = abs(fract(g / 0.9) - 0.5) * 0.9;
  c = mix(c, vec3(0.55, 0.12, 0.07), ln(min(f.x, f.y), 0.008, aa) * mix(0.5, 1.0, detail));
  c = mix(c, vec3(0.78, 0.6, 0.25), ln(length(fract(g / 0.9 + 0.5) - 0.5) * 0.9, 0.06, aa) * detail);
  return c;
}

// A peristyle's garden: the walk under the colonnade, then box-edged beds
// with gravel paths round and across them. q metres from the court's
// corner, size the court; walk the colonnade's depth.
vec3 gardenPaint(vec2 q, vec2 size, float walk, float seed, float dist, out float isWalk) {
  float aa = 0.002 + 0.0011 * dist;
  float de = min(min(q.x, size.x - q.x), min(q.y, size.y - q.y));
  isWalk = step(de, walk);
  vec3 gravel = vec3(0.62, 0.56, 0.46) * (0.85 + 0.25 * h21(floor(q / 0.03))) ;
  vec3 earth = vec3(0.34, 0.26, 0.18) * (0.85 + 0.3 * vnoise(q * 3.0));
  vec3 plant = vec3(0.2, 0.33, 0.11) * (0.7 + 0.5 * vnoise(q * 2.3 + seed * 11.0));
  float cx = abs(q.x - size.x * 0.5), cz = abs(q.y - size.y * 0.5);
  float path = max(step(de, walk + 0.7), max(step(cx, 0.45), step(cz, 0.45)));
  // Beds: the quarters between the paths, planted, a clipped box hedge round each.
  float bedEdge = min(de - walk - 0.7, min(cx - 0.45, cz - 0.45));
  vec3 c = mix(mix(earth, plant, smoothstep(0.35, 0.6, vnoise(q * 1.3 + seed * 3.0))), vec3(0.13, 0.24, 0.08) * (0.8 + 0.3 * vnoise(q * 14.0)), step(bedEdge, 0.22));
  // Flowers in the beds: roses, violets, lilies.
  float fl = step(0.93, h21(floor(q / 0.09))) * step(0.3, bedEdge) * (1.0 - smoothstep(6.0, 14.0, dist));
  c = mix(c, h21(floor(q / 0.09) + 3.0) < 0.5 ? vec3(0.75, 0.2, 0.25) : vec3(0.86, 0.84, 0.76), fl);
  c = mix(c, gravel, path);
  return c;
}
`;

// =====================================================================================
// Furniture and fittings, in the town's vertex format (Sink as pompeiiorders.ts).
// Each is a few dozen triangles: seen from a doorway or across an atrium.
// =====================================================================================

/** Styles used here, as render/pompeiimesh.ts Surf numbers them. */
const S = { plaster: 0, stucco: 4, wood: 7, sand: 9, masonry: 10, marble: 11, kerb: 3, bronze: 17 } as const;

/** Put a builder's local-frame output (x right, z forward, y up) at (x, y, z) turned by yaw. */
function placed(st: Sink, x: number, y: number, z: number, yaw: number, build: () => void): void {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const before = st.n;
  build();
  const s = st as unknown as { pos: Float32Array; nrm: Int8Array };
  for (let i = before; i < st.n; i++) {
    const px = s.pos[i * 3], pz = s.pos[i * 3 + 2];
    s.pos[i * 3] = x + px * ca + pz * sa; s.pos[i * 3 + 1] += y; s.pos[i * 3 + 2] = z - px * sa + pz * ca;
    const nx = s.nrm[i * 4] / 127, nz = s.nrm[i * 4 + 2] / 127;
    s.nrm[i * 4] = Math.round((nx * ca + nz * sa) * 127); s.nrm[i * 4 + 2] = Math.round((-nx * sa + nz * ca) * 127);
  }
}


const MARBLE: RGB = [0.88, 0.86, 0.8];
const BRONZE: RGB = [0.3, 0.22, 0.12];
const WOOD: RGB = [0.38, 0.25, 0.14];

/** A box with no bottom face (it stands on something): 10 triangles. */
function blk(st: Sink, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB, seed: number, style: number): void {
  const faces: [V3, V3[]][] = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]],
    [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
  ];
  for (const [n, q] of faces) {
    const b = st.n;
    // Wall coordinates in metres along and up the face, for the marble's and wood's patterns.
    const along = n[0] !== 0 ? (p: V3): number => p[2] : (p: V3): number => p[0];
    q.forEach((p) => st.vert(p, n, c, seed, style, 0, 0, [along(p), p[1] - y0, 0, 0]));
    st.tri(b, b + 1, b + 2); st.tri(b, b + 2, b + 3);
  }
}

/** The puteal: a marble well head over the cistern, a moulded drum 0.8 m high. */
export function puteal(st: Sink, x: number, y: number, z: number, seed: number): void {
  lathe(st, x, y, z, [[0.34, 0], [0.29, 0.12], [0.29, 0.64], [0.34, 0.74], [0.22, 0.8]], 6, MARBLE, seed, S.marble);
}

/** The cartibulum: a marble table on two carved supports at the impluvium's head. */
export function cartibulum(st: Sink, x: number, y: number, z: number, yaw: number, seed: number): void {
  placed(st, x, y, z, yaw, () => {
    for (const s of [-1, 1]) blk(st, s * 0.5 - 0.05, 0, -0.27, s * 0.5 + 0.05, 0.78, 0.27, MARBLE, seed, S.marble);
    blk(st, -0.75, 0.78, -0.36, 0.75, 0.86, 0.36, MARBLE, seed, S.marble);
  });
}

/** A round table on three bronze legs (a tripod table), a marble top. */
export function tripodTable(st: Sink, x: number, y: number, z: number, seed: number): void {
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + seed;
    tube(st, [x + Math.cos(a) * 0.22, y, z + Math.sin(a) * 0.22], [x + Math.cos(a) * 0.14, y + 0.66, z + Math.sin(a) * 0.14], 0.018, 0.014, 3, BRONZE, seed, S.bronze);
  }
  lathe(st, x, y, z, [[0.3, 0.66], [0.3, 0.71], [0.0, 0.71]], 7, MARBLE, seed, S.marble);
}

/** A couch (lectus): a wooden frame, a mattress, a raised head end. */
export function lectus(st: Sink, x: number, y: number, z: number, yaw: number, seed: number): void {
  placed(st, x, y, z, yaw, () => {
    blk(st, -1.0, 0, -0.45, 1.0, 0.5, 0.45, WOOD, seed, S.wood);
    blk(st, -0.97, 0.5, -0.42, 0.97, 0.66, 0.42, [0.72, 0.66, 0.54], seed, S.sand);
    blk(st, -1.0, 0.5, -0.45, -0.86, 0.92, 0.45, WOOD, seed, S.wood);
  });
}

/** A bronze brazier: a shallow pan on three legs. */
export function brazier(st: Sink, x: number, y: number, z: number, seed: number): void {
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + seed * 3;
    tube(st, [x + Math.cos(a) * 0.24, y, z + Math.sin(a) * 0.24], [x + Math.cos(a) * 0.18, y + 0.5, z + Math.sin(a) * 0.18], 0.015, 0.012, 3, BRONZE, seed, S.bronze);
  }
  lathe(st, x, y, z, [[0.0, 0.44], [0.3, 0.58], [0.24, 0.58], [0.0, 0.5]], 8, BRONZE, seed, S.bronze);
}

/** A wooden chest bound in bronze. */
export function chest(st: Sink, x: number, y: number, z: number, yaw: number, seed: number): void {
  placed(st, x, y, z, yaw, () => {
    blk(st, -0.45, 0, -0.25, 0.45, 0.46, 0.25, WOOD, seed, S.wood);
    blk(st, -0.47, 0.46, -0.27, 0.47, 0.52, 0.27, BRONZE, seed, S.bronze);
  });
}

/** The arca: the atrium's strongbox, bronze-plated, on a masonry base. */
export function arca(st: Sink, x: number, y: number, z: number, yaw: number, seed: number): void {
  placed(st, x, y, z, yaw, () => {
    blk(st, -0.7, 0, -0.45, 0.7, 0.3, 0.45, [0.62, 0.58, 0.5], seed, S.masonry);
    blk(st, -0.6, 0.3, -0.38, 0.6, 1.1, 0.38, [0.36, 0.26, 0.15], seed, S.bronze);
    blk(st, -0.62, 0.62, -0.4, 0.62, 0.7, 0.4, BRONZE, seed, S.bronze);
  });
}

/**
 * A lararium: the household shrine as an aedicula on a podium against a
 * wall, its front (local +z) to the room: two columns, a pediment.
 */
export function lararium(st: Sink, x: number, y: number, z: number, yaw: number, seed: number): void {
  const W: RGB = [0.9, 0.86, 0.78], R: RGB = [0.58, 0.14, 0.08];
  placed(st, x, y, z, yaw, () => {
    blk(st, -0.6, 0, 0, 0.6, 1.1, 0.55, R, seed, S.stucco);
    for (const s of [-1, 1]) blk(st, s * 0.48 - 0.05, 1.1, 0.42, s * 0.48 + 0.05, 1.9, 0.52, W, seed, S.stucco);
    blk(st, -0.62, 1.9, 0, 0.62, 2.0, 0.58, W, seed, S.stucco);
    // The pediment: a triangle in front and the two slopes of its roof back to the wall.
    const b = st.n;
    for (const p of [[-0.62, 2.0, 0.58], [0.62, 2.0, 0.58], [0, 2.35, 0.58]] as V3[]) st.vert(p, [0, 0, 1], W, seed, S.stucco, 0, 0, [0, 0, 0, 0]);
    st.tri(b, b + 1, b + 2);
    const nl = Math.hypot(0.35, 0.62);
    const roof = (a: V3, c: V3, n: V3): void => {
      const k = st.n;
      for (const p of [a, c, [c[0], c[1], 0] as V3, [a[0], a[1], 0] as V3]) st.vert(p, n, R, seed, S.stucco, 0, 0, [0, 0, 0, 0]);
      st.tri(k, k + 1, k + 2); st.tri(k, k + 2, k + 3);
    };
    roof([-0.62, 2.0, 0.58], [0, 2.35, 0.58], [-0.35 / nl, 0.62 / nl, 0]);
    roof([0, 2.35, 0.58], [0.62, 2.0, 0.58], [0.35 / nl, 0.62 / nl, 0]);
    // The niche the Lares stood in.
    blk(st, -0.36, 1.2, 0.0, 0.36, 1.84, 0.04, [0.1, 0.08, 0.07], seed, S.plaster);
  });
}

/** An upright loom: two posts, a beam, the warp as a pale sheet weighted with clay loom weights. */
export function loom(st: Sink, x: number, y: number, z: number, yaw: number, seed: number): void {
  placed(st, x, y, z, yaw, () => {
    for (const s of [-1, 1]) blk(st, s * 0.7 - 0.05, 0, -0.05, s * 0.7 + 0.05, 2.0, 0.05, WOOD, seed, S.wood);
    blk(st, -0.8, 1.9, -0.06, 0.8, 2.0, 0.06, WOOD, seed, S.wood);
    blk(st, -0.64, 0.4, -0.01, 0.64, 1.88, 0.01, [0.78, 0.72, 0.6], seed, S.sand);
    for (let k = 0; k < 6; k++) blk(st, -0.55 + k * 0.22 - 0.04, 0.28, -0.04, -0.55 + k * 0.22 + 0.04, 0.4, 0.04, [0.58, 0.34, 0.22], seed, S.sand);
  });
}

/** A terracotta spout (a lion's head on the gutter) along an edge, pointing (dx, dz). */
export function spout(st: Sink, x: number, y: number, z: number, dx: number, dz: number, c: RGB, seed: number): void {
  tube(st, [x, y, z], [x + dx * 0.32, y - 0.04, z + dz * 0.32], 0.065, 0.045, 4, c, seed, S.sand);
}
