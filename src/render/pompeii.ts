// Pompeii in 79 AD: the town built by render/pompeiimesh.ts, shaded here, and
// the hooks that turn the modern landscape round it back into the ancient one.
//
// Hooks, all called from main.ts so nothing else knows about the place:
//   * restoreVesuvius(): edits the DEM fields before the terrain is meshed,
//     putting back a single pre-79 summit over today's Somma rim and cone.
//   * antiquateDrape(): repaints the satellite drapes within ~14 km: the modern
//     towns, motorways and greenhouses become a patchwork of vineyards, wheat
//     stubble and olive groves, and the volcano's slopes go green.
//   * pompeiiCityPack(): the town's footprints as a CityPack, so the drone and
//     the walker collide with it and the aircraft has a rooftop floor. It
//     never reaches the building renderer.
//   * the cart: a horse-drawn cart drawn at the car sim's pose.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL } from "./sh";
import { AO_GLSL } from "./ao";
import { makeStreetLampUniforms, type StreetLampUniforms } from "./streetlamps";
import { ERUPTION_SURFACE_GLSL, ERUPTION_VERT_GLSL, ROOF_COLLAPSE_FRAG_GLSL, ROOF_COLLAPSE_VERT_GLSL, eruptionSurfaceUniforms, type EruptionSurfaceUniforms } from "./eruption";
import { TOWN_LAMPS_GLSL, townLampUniforms, type TownLampUniforms } from "./oillight";
import { AMPHI, Store, buildPompeii, type ColumnInstance, type PompeiiMeshData, type PompeiiModel } from "./pompeiimesh";
import { Order, columnTemplate } from "./pompeiiorders";
import { INTERIOR_GLSL } from "./pompeiiinterior";
import { ART_WORKS, type ArtAtlas } from "../data/pompeiiart";
import { HORSE_BONES, STRIDE_M, buildHorse, poseHorse, type Gait, type HorseMesh } from "./horse";
import { pointInRing, type PompeiiData } from "../data/pompeii";
import { Land, LandGrid, type PompeiiSuburbs } from "../data/pompeiisuburbs";
import { BuildingKind, RoofShape, type Building, type CityPack } from "../data/citypack";
import { Heightfield } from "../data/dem";
import { HerculaneumField } from "../data/herculaneumfield";
import type { StitchedImage } from "../data/imagery";
import { metresPerDegLat, metresPerDegLon, type Origin } from "../geo";

/**
 * Shadow cascade splits for the town, metres: the first two cascades end at
 * 150 m and 700 m instead of 350 m and 1.4 km (see SunShadow.setSplits). The
 * city map, at about 0.4 m a texel over a town this small, covers the rest.
 */
export const POMPEII_SHADOW_SPLITS: readonly [number, number] = [150, 700];

// Painted electoral notices (programmata), the commonest writing on the
// street walls: "Gnaeus Helvius Sabinus for aedile, he is worthy of public
// office" and its like. The candidates are real ones from the 79 AD
// elections; V for U as the painters wrote it.
export const DIPINTI = [
  "CN HELVIVM SABINVM AED OVF",
  "M HOLCONIVM PRISCVM IIVIR OVF",
  "C IVLIVM POLYBIVM AED OVF",
  "A VETTIVM FIRMVM AED OVF",
  "M EPIDIVM SABINVM IIVIR OVF",
  "L CEIVM SECVNDVM AED OVF",
];
const FONT_CHARS = "ABCDEFGHILMNOPRSTVXY";
// 5x5 capitals, rows top to bottom.
const FONT_ROWS: Record<string, string> = {
  A: ".###./#...#/#####/#...#/#...#", B: "####./#...#/####./#...#/####.", C: ".####/#..../#..../#..../.####",
  D: "####./#...#/#...#/#...#/####.", E: "#####/#..../####./#..../#####", F: "#####/#..../####./#..../#....",
  G: ".####/#..../#.###/#...#/.###.", H: "#...#/#...#/#####/#...#/#...#", I: ".###./..#../..#../..#../.###.",
  L: "#..../#..../#..../#..../#####", M: "#...#/##.##/#.#.#/#...#/#...#", N: "#...#/##..#/#.#.#/#..##/#...#",
  O: ".###./#...#/#...#/#...#/.###.", P: "####./#...#/####./#..../#....", R: "####./#...#/####./#..#./#...#",
  S: ".####/#..../.###./....#/####.", T: "#####/..#../..#../..#../..#..", V: "#...#/#...#/#...#/.#.#./..#..",
  X: "#...#/.#.#./..#../.#.#./#...#", Y: "#...#/.#.#./..#../..#../..#..",
};
/** Glyph bits, bit (row * 5 + col), and the notices as glyph indices (-1 a space). */
export function dipintiTables(): { glyphs: number[]; chars: number[]; offsets: number[]; lengths: number[] } {
  const glyphs = [...FONT_CHARS].map((c) => {
    const rows = FONT_ROWS[c].split("/").join("");
    if (rows.length !== 25) throw new Error(`dipinti font: ${c} is not 5x5`);
    let b = 0;
    for (let k = 0; k < 25; k++) if (rows[k] === "#") b |= 1 << k;
    return b;
  });
  const chars: number[] = [], offsets: number[] = [], lengths: number[] = [];
  for (const m of DIPINTI) {
    offsets.push(chars.length);
    lengths.push(m.length);
    for (const c of m) chars.push(c === " " ? -1 : FONT_CHARS.indexOf(c));
  }
  return { glyphs, chars, offsets, lengths };
}
const DIP = dipintiTables();
const DIPINTI_GLSL = /* glsl */ `
const int GLYPH[${DIP.glyphs.length}] = int[](${DIP.glyphs.join(", ")});
const int MSG[${DIP.chars.length}] = int[](${DIP.chars.join(", ")});
const int MSG_OFF[${DIP.offsets.length}] = int[](${DIP.offsets.join(", ")});
const int MSG_LEN[${DIP.lengths.length}] = int[](${DIP.lengths.join(", ")});
const float CHAR_W = 0.2;
const float CHAR_H = 0.26;
// Ink of one painted notice on a facade, 0..1. One notice per chosen wall,
// in one line along it at y0 above the pavement.
float dipinto(float u, float h, float seed, float len, float y0) {
  int m = int(floor(fract(seed * 7.31 + 0.17) * float(MSG_LEN.length())));
  float w = float(MSG_LEN[m]) * CHAR_W;
  float x0 = 1.0 + fract(seed * 3.7) * max(0.0, len - 2.0 - w);
  float lu = u - x0, lh = h - y0;
  if (lu < 0.0 || lu >= w || lh < 0.0 || lh >= CHAR_H || w > len - 2.0) return 0.0;
  int ci = int(floor(lu / CHAR_W));
  int g = MSG[MSG_OFF[m] + ci];
  if (g < 0) return 0.0;
  float fx = fract(lu / CHAR_W) * CHAR_W / (CHAR_W * 0.8);
  if (fx >= 1.0) return 0.0;
  int col = int(floor(fx * 5.0));
  int row = int(floor((1.0 - lh / CHAR_H) * 5.0));
  return float((GLYPH[g] >> (row * 5 + col)) & 1);
}
`;

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aNormal;
in vec4 aColour;
in vec4 aSurf;
in vec4 aWall;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
${ERUPTION_VERT_GLSL}
#ifdef ROOF_COLLAPSE
${ROOF_COLLAPSE_VERT_GLSL}
#endif
out vec3 vNormal;
out vec3 vWorld;
out vec4 vColour;
out vec4 vSurf;
out vec4 vWall;
out float vViewDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
#ifdef ASH_RISE
  // The ground and streets rise on the pumice (render/eruption.ts).
  w.y += uAsh.x;
#endif
#ifdef ROOF_COLLAPSE
  vRoof = roofFallen(aSurf, aNormal.y);
  // The frame slumps into the house as the tiles go.
  w.y -= 0.7 * max(vRoof, 0.0) * max(vRoof, 0.0);
#endif
  vNormal = mat3(modelMatrix) * aNormal.xyz;
  vWorld = w.xyz;
  vColour = aColour;
  vSurf = aSurf;
  vWall = aWall;
  vViewDist = distance(w.xyz, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vColour;
in vec4 vSurf;
in vec4 vWall;
in float vViewDist;
out vec4 fragColor;

#define ATMO_STEPS 3
#define ATMO_SUN_STEPS 1
${ATMOSPHERE_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}
${ERUPTION_SURFACE_GLSL}
${TOWN_LAMPS_GLSL}
#ifdef ROOF_COLLAPSE
${ROOF_COLLAPSE_FRAG_GLSL}
#endif

uniform vec3  uCameraPos;
uniform float uSunSurface;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uNight;
uniform vec3  uNightGlow;
uniform sampler2D uArt;
uniform vec4 uArtRect[${ART_WORKS.length}];
uniform vec4 uArtInfo[${ART_WORKS.length}];
uniform float uArtReady;
uniform float uWaterTime;
// The escape's start room (render/escaperoom.ts) is built inside a house the
// town draws as a hollow solid, and the house front's shop and door recesses
// reach into it. A: the room's front middle (x, z) and its frontage unit
// vector u; B: half width, depth (its sign picks the inward normal, +-perp
// u), floor y, and 1 while a room stands. Town fragments in that box, from
// just behind the front wall up to the ceiling, are dropped; the room's own
// mesh is drawn with w 0.
uniform vec4 uRoomCutA;
uniform vec4 uRoomCutB;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 h22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.1) + 0.2 * vnoise(p * 4.3); }
// The basalt paving's cell: x the distance to the nearest edge (true
// bisector distance, so the joints keep their width), yz the offset from
// the block's centre to the point, w the block's id hash.
vec4 paveCell(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 mg = vec2(0), mr = vec2(8.0);
  float md = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 r = g + 0.1 + 0.8 * h22(i + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float ed = 8.0;
  // 3x3 round the nearest centre, not the exact 5x5: a rare joint is a
  // little off, at a third of the cost on a street that fills the screen.
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = mg + vec2(float(x), float(y));
    vec2 r = g + 0.1 + 0.8 * h22(i + g) - f;
    if (dot(mr - r, mr - r) > 1e-5) ed = min(ed, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec4(ed, -mr, h21(i + mg));
}

// Distance to the nearest cell edge and the cell's id: polygonal paving.
vec3 voronoi(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = g + 0.15 + 0.7 * h22(i + g) - f;
    float d = dot(o, o);
    if (d < d1) { d2 = d1; d1 = d; id = i + g; } else if (d < d2) d2 = d;
  }
  return vec3(sqrt(d2) - sqrt(d1), id);
}

const vec3 CREAM = vec3(0.86, 0.82, 0.72);
${DIPINTI_GLSL}
// The notice's extent along the wall, as dipinto() places it: x0, width
// (0 when it does not fit), for the whitewashed panel it is painted on.
vec2 dipintoSpan(float seed, float len) {
  int m = int(floor(fract(seed * 7.31 + 0.17) * float(MSG_LEN.length())));
  float w = float(MSG_LEN[m]) * CHAR_W;
  if (w > len - 2.0) return vec2(0.0);
  return vec2(1.0 + fract(seed * 3.7) * max(0.0, len - 2.0 - w), w);
}
// Hand-floated lime plaster: broad trowel sweeps and a sand grain, a height
// in arbitrary units over wall-plane metres.
float plasterRelief(vec2 p) {
  float sweep = vnoise(vec2(p.x * 2.3 + p.y * 1.4, p.y * 3.4 - p.x * 0.8));
  float ridge = 1.0 - abs(2.0 * vnoise(vec2(p.x * 5.1 - p.y * 1.3, p.y * 6.8 + p.x * 1.4)) - 1.0);
  return 0.12 * sweep + 0.43 * ridge * ridge + 0.45 * vnoise(p * 17.0);
}
// The normal tilted by plasterRelief's slope; T the wall's horizontal
// tangent (wp.x increases along it). k in tilt per unit of relief per metre.
vec3 plasterNormal(vec3 n, vec3 T, vec2 p, float k) {
  const float e = 0.025;
  float h0 = plasterRelief(p);
  vec2 g = vec2(plasterRelief(p + vec2(e, 0.0)) - h0, plasterRelief(p + vec2(0.0, e)) - h0) / e;
  return normalize(n - (T * g.x + vec3(0.0, 1.0, 0.0) * g.y) * k);
}

float sdCap(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r;
}
// A standing figure a unit tall, feet at the origin, for the wall mosaic
// (style 21). x: the skin (or the robe's fill when robed); y: a mantle over
// one shoulder; returns the figure's distance in .z. armUp raises the right
// arm (Neptune's, holding the trident).
vec3 mosaicFigure(vec2 p, bool robed, bool armUp) {
  float head = length(p - vec2(0.0, 0.91)) - 0.062;
  float neck = sdCap(p, vec2(0.0, 0.8), vec2(0.0, 0.86), 0.03);
  float torso = sdCap(p, vec2(0.0, 0.57), vec2(0.0, 0.74), 0.085);
  float hips = sdCap(p, vec2(-0.03, 0.5), vec2(0.03, 0.5), 0.075);
  float armR = armUp ? min(sdCap(p, vec2(0.09, 0.76), vec2(0.17, 0.86), 0.028), sdCap(p, vec2(0.17, 0.86), vec2(0.19, 0.99), 0.024))
                     : min(sdCap(p, vec2(0.09, 0.76), vec2(0.13, 0.6), 0.028), sdCap(p, vec2(0.13, 0.6), vec2(0.15, 0.46), 0.024));
  float armL = min(sdCap(p, vec2(-0.09, 0.76), vec2(-0.13, 0.6), 0.028), sdCap(p, vec2(-0.13, 0.6), vec2(-0.1, 0.47), 0.024));
  float legs = min(min(sdCap(p, vec2(-0.045, 0.47), vec2(-0.055, 0.25), 0.038), sdCap(p, vec2(-0.055, 0.25), vec2(-0.06, 0.03), 0.03)),
                   min(sdCap(p, vec2(0.045, 0.47), vec2(0.07, 0.25), 0.038), sdCap(p, vec2(0.07, 0.25), vec2(0.08, 0.03), 0.03)));
  float body = min(min(min(head, neck), min(torso, hips)), min(min(armR, armL), legs));
  // A robe falls from the shoulders to the ankles, flaring.
  float robe = max(abs(p.x) - (0.085 + (0.76 - p.y) * 0.12), max(p.y - 0.76, 0.02 - p.y));
  // The mantle: over the left shoulder and round the hips, a band of cloth.
  float mantle = max(sdCap(p, vec2(-0.1, 0.78), vec2(0.06, 0.42), 0.06), -head);
  float d = robed ? min(body, robe) : body;
  return vec3(step(robe, 0.0), step(mantle, 0.0), d);
}
${INTERIOR_GLSL}
void main() {
  if (uRoomCutB.w > 0.5) {
    vec2 rd = vWorld.xz - uRoomCutA.xy;
    vec2 rn = sign(uRoomCutB.y) * vec2(-uRoomCutA.w, uRoomCutA.z);
    float ra = dot(rd, uRoomCutA.zw), rb = dot(rd, rn), ry = vWorld.y - uRoomCutB.z;
    if (abs(ra) < uRoomCutB.x && rb > 0.03 && rb < abs(uRoomCutB.y) && ry > -0.6 && ry < 3.35) discard;
  }
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCameraPos - vWorld);
  float style = floor(vSurf.x + 0.5);
  float p1 = vSurf.y, p2 = vSurf.z;
  float seed = vColour.a;
  vec3 albedo = vColour.rgb;
  float gloss = 0.0;
  float covered = 0.0;
  // A closed room's share of the sky light kept out (the baths' style 20).
  // Unlike covered it leaves the sun alone: the shadow map already lets
  // it in only through the oculus and the windows.
  float shut = 0.0;
  // Shading the styles fake below geometry they do not have: ao scales the
  // sky and bounce light (contact shadows, recesses), sunShade the sun
  // (a window reveal's own shadow, which the shadow map is too coarse for).
  float ao = 1.0;
  float sunShade = 1.0;
  float u = vWall.x, h = vWall.y, len = vWall.z, H = vWall.w;
  vec2 tng = normalize(vec2(-n.z, n.x) + vec2(1e-4, 0.0));
  vec3 T3 = vec3(tng.x, 0.0, tng.y);
  vec2 wp = vec2(dot(vWorld.xz, tng), vWorld.y);
  // u runs along a wall one way or the other; su is +1 where it increases
  // along T3, so u-based relief and reveals turn the right way.
  float su = dFdx(u) * dot(dFdx(vWorld.xz), tng) + dFdy(u) * dot(dFdy(vWorld.xz), tng) < 0.0 ? -1.0 : 1.0;

  if (style < 0.5) {
    // Plaster: dark socle, the coloured dado zone, a fillet, the pale wall above.
    float bandTop = p1 / 40.0;
    bool street = p2 < 1.5;
    bool full = p2 > 0.5;
    float wob = (vnoise(vec2(wp.x * 0.7, 3.0)) - 0.5) * 0.08;
    vec3 upper = full ? mix(albedo, CREAM, 0.15) : CREAM * (0.94 + 0.08 * seed);
    vec3 c = h < bandTop + wob ? albedo : upper;
    float socle = 0.55 + 0.25 * seed;
    // Painted panels on the coloured zone: a fine darker frame every couple
    // of metres and a fillet over the socle, the way the red and ochre
    // street walls were laid out. Only where the colour is strong enough to
    // be a painted scheme, not the cream wash.
    float sat = max(albedo.r, max(albedo.g, albedo.b)) - min(albedo.r, min(albedo.g, albedo.b));
    if (sat > 0.3 && h > socle && h < bandTop + wob) {
      float pw = 2.1 + 0.6 * seed;
      float px = fract((u + seed * 3.0) / pw) * pw;
      float line = step(px, 0.05) + step(abs(h - socle - 0.12), 0.025);
      c = mix(c, c * 0.62, clamp(line, 0.0, 1.0));
      // A paler inner panel inset from each frame.
      float inset = step(0.22, px) * step(px, pw - 0.17) * step(socle + 0.3, h) * step(h, bandTop + wob - 0.2);
      c = mix(c, c * 1.08, inset * step(0.5, h21(vec2(floor((u + seed * 3.0) / pw), seed * 17.0))));
    }
    if (abs(h - bandTop - wob) < 0.06) c = albedo * 0.45;
    if (h < socle) c = mix(vec3(0.16, 0.08, 0.07), albedo * 0.35, 0.3);
    // Two levels of detail: grain, cracks and streak texture (centimetres)
    // go by 45 m, patches and stains (decimetres) by 110 m; past that the
    // wall keeps the plain scheme so the air views do not shimmer.
    float nearF = 1.0 - smoothstep(20.0, 45.0, vViewDist);
    float nearM = 1.0 - smoothstep(60.0, 110.0, vViewDist);
    bool painted = h < bandTop + wob && h > socle;
    // An electoral notice in red or black capitals on about half of the
    // street walls: straight onto the cream wash, or on a whitewashed panel
    // where the wall is coloured, as the notices were.
    // Most surveyed fronts carry p2 255 like the inner walls, so those get
    // notices too, a little less often.
    bool notice = len > 8.0 && fract(seed * 13.7) < (street ? 0.65 : 0.45);
    // Over the lintels where the wall is tall enough: lower down the line
    // mostly fell inside the shop openings and was never seen.
    float y0 = H > 4.4 ? 3.45 : bandTop + 0.4;
    if (notice) {
      // A wall's u can run either way along the street. Where it runs right
      // to left on screen the letters would come out mirrored, so read the
      // line from the other end.
      float nu = dFdx(u) < 0.0 ? len - u : u;
      vec2 sp = dipintoSpan(seed, len);
      if (full && sp.y > 0.0 && abs(nu - sp.x - sp.y * 0.5) < sp.y * 0.5 + 0.22 && abs(h - y0 - CHAR_H * 0.5) < CHAR_H * 0.5 + 0.16) {
        // The panel's brush edge is ragged.
        float rag = vnoise(vec2(u, h) * 9.0 + seed);
        if (abs(nu - sp.x - sp.y * 0.5) < sp.y * 0.5 + 0.15 + 0.07 * rag && abs(h - y0 - CHAR_H * 0.5) < CHAR_H * 0.5 + 0.1 + 0.06 * rag) c = mix(c, CREAM * 0.97, 0.88);
      }
      float ink = dipinto(nu, h, seed, len, y0);
      ink *= mix(1.0, smoothstep(0.12, 0.32, vnoise(vec2(u, h) * 4.0 + seed * 40.0)), nearF);
      // Strokes are 3 cm: past about two pixels a stroke they would alias,
      // so they fade to the tint the line of letters averages to.
      float fw = max(fwidth(u), fwidth(h));
      float sharp = 1.0 - smoothstep(0.016, 0.04, fw);
      float lineArea = step(abs(h - y0 - CHAR_H * 0.5), CHAR_H * 0.5) * step(0.0, u - sp.x) * step(u, sp.x + sp.y);
      ink = mix(lineArea * 0.3, ink, sharp);
      vec3 inkC = fract(seed * 29.3) < 0.7 ? vec3(0.55, 0.07, 0.04) : vec3(0.07, 0.06, 0.05);
      c = mix(c, inkC, ink * 0.9);
    }
    // Faded, uneven paint on the coloured zone: chalky where the sun and
    // rain have taken the pigment.
    if (painted && nearM > 0.0) {
      float fade = smoothstep(0.45, 0.8, fbm(wp * vec2(1.1, 0.7) + seed * 4.0));
      c = mix(c, mix(c, CREAM * 0.82, 0.4), fade * 0.8 * nearM);
    }
    albedo = c;
    // Large stains, rain streaks, damp and splash. Past 110 m only the
    // broad tone is left.
    albedo *= 0.86 + 0.24 * fbm(vec2(wp.x * 0.25, wp.y * 0.35) + seed * 10.0);
    vec2 sf = vec2(wp.x * 0.45, wp.y * 0.6) + seed * 21.0;
    albedo = mix(albedo, albedo * vec3(0.78, 0.7, 0.58), 0.55 * smoothstep(0.55, 0.78, fbm(sf)) * nearM);
    float damp = 1.0 - smoothstep(0.0, 1.0 + 0.5 * vnoise(vec2(wp.x * 0.9, seed * 9.0)), h);
    albedo = mix(albedo, albedo * vec3(0.72, 0.68, 0.62), damp * 0.6);
    if (vViewDist < 110.0) {
      // Rain run-off from the wall top: vertical streaks, strongest under
      // the eaves, reaching down a metre to four.
      float reach = H - 1.0 - 3.0 * vnoise(vec2(wp.x * 0.7, seed * 7.0));
      float fromTop = smoothstep(reach, H - 0.1, h) * step(1.0, H);
      float sk = vnoise(vec2(wp.x * 6.5, wp.y * 0.3 + seed * 3.0)) * (0.6 + 0.8 * vnoise(vec2(wp.x * 1.9 + 5.0, wp.y * 0.15)));
      float streak = mix(0.3, smoothstep(0.25, 0.55, sk), nearF) * fromTop;
      albedo = mix(albedo, albedo * vec3(0.6, 0.6, 0.58), 0.6 * streak * nearM);
      // Splash and dirt in the bottom 0.6 m: street mud thrown up the wall.
      float splash = 1.0 - smoothstep(0.0, 0.45 + 0.25 * vnoise(vec2(wp.x * 2.0, seed)), h);
      float speck = mix(0.5, vnoise(wp * 22.0), nearF);
      albedo = mix(albedo, vec3(0.3, 0.24, 0.18), splash * (0.35 + 0.35 * speck) * nearM);
      // Hairline cracks: an isoline of a warped noise, a few millimetres
      // wide, only where a second noise allows, thinning out before they alias.
      if (nearF > 0.0) {
        vec2 cp = wp * vec2(1.2, 0.9) + seed * 5.0;
        float cn = vnoise(cp + 0.35 * vec2(vnoise(wp * 4.0), vnoise(wp * 4.0 + 7.0)));
        float cw = 0.008 + fwidth(cn) * 0.5;
        // The second mask is fine enough to break each crack into short runs.
        float crack = (1.0 - smoothstep(0.0, cw, abs(cn - 0.5))) * smoothstep(0.62, 0.78, vnoise(wp * 0.45 + 13.0)) * smoothstep(0.45, 0.7, vnoise(wp * 2.5 + 31.0));
        crack *= 1.0 - smoothstep(0.012, 0.035, fwidth(cn));
        albedo *= 1.0 - 0.22 * crack * nearF;
        // Trowel relief: lit by a raking sun.
        n = plasterNormal(n, T3, wp, 0.006 * nearF);
      }
      // Plaster fallen away, mostly near the foot and at the corners,
      // showing the opus incertum behind with a dark broken lip.
      float corner = len > 0.0 ? 1.0 - smoothstep(0.0, 0.9, min(u, len - u)) : 0.0;
      float pf = fbm(wp * vec2(0.75, 0.9) + seed * 23.0) + 0.26 * (1.0 - smoothstep(0.0, 1.3, h)) + 0.12 * corner + 0.05 * vnoise(wp * 7.0) * nearF;
      float th = 0.9;
      float loss = smoothstep(th, th + 0.008, pf) * nearM;
      float lip = (smoothstep(th - 0.03, th, pf) - smoothstep(th, th + 0.008, pf)) * nearM;
      if (loss > 0.0) {
        vec3 vo = voronoi(wp / 0.11);
        float k = h21(vo.yz);
        vec3 stone = k < 0.55 ? vec3(0.3, 0.29, 0.28) : k < 0.85 ? vec3(0.44, 0.4, 0.32) : k < 0.95 ? vec3(0.5, 0.48, 0.44) : vec3(0.4, 0.27, 0.2);
        stone *= 0.8 + 0.3 * mix(0.5, vnoise(wp * 18.0), nearF);
        // Rough faces in a lot of grey mortar, each stone shaded into it.
        stone *= 0.7 + 0.3 * smoothstep(0.08, 0.3, vo.x);
        vec3 mas = mix(vec3(0.44, 0.41, 0.36) * (0.85 + 0.3 * vnoise(wp * 30.0)), stone, smoothstep(0.1, 0.16, vo.x));
        albedo = mix(albedo, mas, loss);
        // Set back the plaster's thickness: less sky reaches in.
        ao *= 1.0 - 0.3 * loss;
        n = normalize(mix(n, normalize(vNormal), loss));
      }
      albedo *= 1.0 - 0.45 * lip;
    }
    // Soot and grime down from the eaves.
    albedo *= 1.0 - 0.14 * smoothstep(H - 0.8, H, h) * step(1.0, H);
    // Contact shadow where the wall meets the ground, and under the eaves.
    if (len > 0.0) {
      // Gentle: the GTAO pass in occludedSkyIrradiance already darkens the
      // corner, this only adds what its screen-space radius misses.
      ao *= mix(0.72, 1.0, smoothstep(0.0, 0.35, h));
      ao *= 1.0 - 0.3 * smoothstep(H - 0.5, H, h) * step(1.0, H);
    }
    // Windows: small, high and shuttered, more of them upstairs. Each is a
    // box 0.3 m deep traced from the eye: the reveal it shows depends on
    // where the eye is, the head and one jamb shadow the back by the sun.
    if (street && len > 0.0) {
      float twoStorey = step(7.0, H);
      float bay = twoStorey > 0.5 ? 3.1 : 5.3;
      float col = floor(u / bay);
      float wy = twoStorey > 0.5 ? H - 2.6 : 3.4;
      float ww = twoStorey > 0.5 ? 0.42 : 0.28, wh = twoStorey > 0.5 ? 0.62 : 0.32;
      vec2 P = vec2((u - col * bay - bay * 0.5) * su, h - wy);
      // A single-storey wall with a notice gives its window row to it.
      bool has = u > 1.0 && u < len - 1.0 && h21(vec2(col, seed * 91.0)) > 0.25 && !(notice && twoStorey < 0.5 && H > 4.4);
      vec3 ng = normalize(vNormal);
      if (has && abs(P.x) < ww && abs(P.y) < wh) {
        const float dep = 0.3;
        float vn = max(0.08, dot(v, ng));
        vec2 d = dep * vec2(dot(v, T3), v.y) / vn;
        float sX = abs(d.x) > 1e-4 ? (P.x + sign(d.x) * ww) / d.x : 2.0;
        float sY = abs(d.y) > 1e-4 ? (P.y + sign(d.y) * wh) / d.y : 2.0;
        float s = min(1.0, min(sX, sY));
        vec2 Q = P - s * d;
        vec3 wallC = full ? mix(c, CREAM, 0.15) : CREAM * 0.9;
        if (s >= 1.0) {
          // The back: a wooden frame, and inside it the dark room, a
          // closed shutter leaf upstairs, an iron grille downstairs.
          bool frame = abs(Q.x) > ww - 0.05 || abs(Q.y) > wh - 0.05;
          vec3 wood = vec3(0.3, 0.19, 0.11) * (0.8 + 0.3 * vnoise(vec2(Q.x * 40.0, Q.y * 3.0)));
          if (frame) albedo = wood;
          else if (twoStorey > 0.5 && Q.x * (h21(vec2(col, seed)) - 0.5) > 0.0) albedo = wood * (0.85 + 0.25 * step(0.08, fract(Q.x / 0.11)));
          else albedo = vec3(0.045, 0.038, 0.032);
          n = ng;
          ao *= 0.7;
        } else {
          albedo = wallC * 0.95;
          if (sX < sY) n = sign(d.x) * T3;
          else n = d.y > 0.0 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, -1.0, 0.0);
          if (d.y > 0.0 && sY <= sX) albedo = vec3(0.68, 0.64, 0.55);
          ao *= 1.0 - 0.35 * s;
        }
        // Grille: bars in the outer third of the reveal on ground floor windows.
        if (twoStorey < 0.5) {
          vec2 G = P - min(s, 0.3) * d;
          float bar = step(abs(fract(G.x / 0.1 + 0.5) - 0.5), 0.09) + step(abs(G.y), 0.012);
          if (bar > 0.0 && s > 0.3) { albedo = vec3(0.09, 0.08, 0.075); n = ng; ao = 0.8; }
        }
        // Sun into the box: lit where the ray back toward the sun leaves
        // through the opening rather than through the wall.
        float sn = dot(uSunDir, ng);
        vec2 E = Q + s * dep * vec2(dot(uSunDir, T3), uSunDir.y) / max(sn, 1e-3);
        float inLight = step(0.02, sn) * (1.0 - smoothstep(-0.01, 0.01, max(abs(E.x) - ww, abs(E.y) - wh)));
        sunShade = s > 0.0 ? inLight : 1.0;
      } else if (has && abs(P.x) < ww + 0.06 && P.y < -wh && P.y > -wh - 0.08) {
        // A travertine sill, proud of the plaster.
        albedo = vec3(0.7, 0.66, 0.56) * (0.9 + 0.15 * vnoise(vec2(u, h) * 20.0));
        n = normalize(normalize(vNormal) + vec3(0.0, 0.6 * smoothstep(-wh - 0.08, -wh, P.y), 0.0));
        ao *= 0.9;
      } else if (has && abs(P.x) < ww && P.y < -wh - 0.08 && P.y > -wh - 1.8) {
        // Run-off from the sill.
        float st = vnoise(vec2(P.x * 14.0, P.y * 0.5 + seed));
        float fall = smoothstep(-wh - 1.8, -wh - 0.1, P.y);
        albedo *= 1.0 - 0.35 * fall * mix(0.5, smoothstep(0.3, 0.6, st), nearF) * nearM;
      } else if (has && twoStorey > 0.5 && abs(P.x) < ww * 2.1 && abs(P.y) < wh && abs(P.x) > ww) {
        // Wooden shutters folded back either side.
        albedo = vec3(0.32, 0.2, 0.11) * (0.85 + 0.25 * step(0.1, fract(P.x / 0.13)));
        ao *= 0.85;
      }
    }
  } else if (style < 1.5) {
    // Terracotta: imbrex ridges up the slope, tegulae between, course lines.
    float pitch = 0.42;
    // p2 set: a surveyed house's roof, one heightfield over many slopes, so
    // the imbrex rows run across the slope in world space rather than along
    // a facade's u.
    float cu = (p2 > 0.5 ? wp.x : u) / pitch;
    float cv = h / 0.52;
    // Fades the per-tile pattern out where a pixel spans a good part of a
    // row: from the air it would only shimmer. The means stay.
    float fwT = max(fwidth(cu), fwidth(cv));
    float detail = 1.0 - smoothstep(0.08, 0.3, fwT);
    // The rows' stripes hold on longer than the relief: they read from the air.
    float stripes = 1.0 - smoothstep(0.25, 0.6, fwT);
    float course = fract(cv);
    // xi: across a row, the imbrex (cover tile) on the joint at |xi| < IW.
    float xi = fract(cu + 0.5) - 0.5;
    const float IW = 0.19;
    float onImb = step(abs(xi), IW);
    float id = h21(vec2(floor(cu + 0.5 * onImb), floor(cv)) + seed * 17.0 + onImb * 3.0);
    vec3 tile = albedo * (0.82 + 0.3 * id);
    // A few tiles replaced after the earthquake of 62: paler, yellower.
    tile = mix(tile, albedo * vec3(1.25, 1.18, 1.0), step(0.95, id));
    // Round imbrices: the normal turns across them; pans dish slightly and
    // sit in the imbrex's shadow at its foot.
    float q = clamp(xi / IW, -0.96, 0.96);
    float slopeI = q / sqrt(1.0 - q * q);
    float pan = (abs(xi) - IW) / (0.5 - IW);
    float slopeP = -sign(xi) * 0.25 * (1.0 - smoothstep(0.0, 0.3, pan));
    n = normalize(n + T3 * (p2 > 0.5 ? 1.0 : su) * (onImb > 0.5 ? slopeI * 0.7 : slopeP) * detail);
    float shade = onImb > 0.5 ? 1.0 - 0.18 * q * q : 0.82 + 0.18 * smoothstep(0.0, 0.25, pan);
    // Each course overlaps the one below: a dark line at its lower edge.
    shade *= 1.0 - 0.3 * smoothstep(0.86, 1.0, course) * (1.0 - onImb * 0.6);
    ao *= mix(0.93, 0.8 + 0.2 * smoothstep(0.0, 0.2, pan) * (1.0 - onImb) + 0.2 * onImb, detail);
    albedo = mix(albedo * 0.88, tile * shade, stripes);
    // Tone that drifts from one imbrex row to the next, a metre or two at a
    // time: coarse enough to resolve from the air, where it reads as tiling.
    albedo *= 0.8 + 0.36 * vnoise(vec2(cu * 0.5, cv * 0.12) + seed * 9.0);
    albedo *= 0.9 + 0.2 * fract(seed * 41.0);
    // Lichen and soot, broad patches with speckled edges.
    float lich = smoothstep(0.55, 0.85, fbm(vWorld.xz * 0.5));
    lich *= mix(0.6, smoothstep(0.35, 0.65, vnoise(vWorld.xz * 6.0)), detail);
    albedo = mix(albedo, vec3(0.42, 0.4, 0.25), 0.4 * lich);
    albedo *= 1.0 - 0.25 * smoothstep(0.62, 0.9, fbm(vWorld.xz * 0.21 + 40.0));
    gloss = 0.12;
  } else if (style < 2.5) {
    // Basalt paving: big irregular lava blocks, 40-80 cm, each one domed
    // ("pillowed") by two thousand years of wheels and feet, dark gaps
    // between them, grey with paler worn crowns and a slight polish. The
    // dome is lighting only: the normal tilts toward each block's rim.
    float S = 0.58;
    // A little warp so the blocks are rounded polygons, not a lattice.
    vec2 q = vWorld.xz / S + 0.35 * vec2(vnoise(vWorld.xz * 1.3), vnoise(vWorld.xz * 1.3 + 17.0)) ;
    vec4 pc = paveCell(q);
    float edge = pc.x;
    float tone = pc.w;
    float nearP = 1.0 - smoothstep(25.0, 60.0, vViewDist);
    // Tight joints: a hairline of shadow in the crack, grey-tan grit and
    // dust packed in round it, rounded shoulders into them.
    float crackL = 1.0 - smoothstep(0.006, 0.016, edge);
    float grit = 1.0 - smoothstep(0.02, 0.075, edge);
    float crown = smoothstep(0.05, 0.4, edge);
    // Per-block tone varies a little; most of the variety is the surface.
    vec3 lava = vec3(0.28, 0.28, 0.275) * (0.9 + 0.2 * tone) * mix(vec3(1.02, 1.0, 0.96), vec3(0.97, 0.99, 1.02), fract(tone * 7.0));
    lava *= 0.9 + 0.18 * vnoise(vWorld.xz * 2.0 + tone * 9.0);
    lava *= mix(1.0, 0.86 + 0.24 * vnoise(vWorld.xz * 11.0), nearP);
    // Worn crowns are polished paler, the shoulders keep dust.
    lava *= mix(0.86, 1.1, crown);
    // Vesicles: the lava's small pits, on some blocks.
    lava *= 1.0 - 0.4 * step(0.6, tone) * step(0.9, vnoise(vWorld.xz * 26.0)) * nearP;
    vec3 dust = vec3(0.36, 0.32, 0.26) * (0.85 + 0.3 * vnoise(vWorld.xz * 7.0));
    albedo = mix(lava, dust, grit * 0.75);
    albedo = mix(albedo, vec3(0.1, 0.09, 0.08), crackL * 0.7 * nearP);
    // Dust and dung down the middle, and dust blown against the kerbs.
    float lat = vWall.z, half_ = vWall.w;
    float mid = 1.0 - smoothstep(0.3, 1.1, abs(lat));
    float side = smoothstep(half_ - 0.6, half_ - 0.05, abs(lat)) * step(0.1, half_);
    float muck = smoothstep(0.4, 0.75, fbm(vWorld.xz * 0.9 + 3.0)) * mid + side * (0.5 + 0.5 * vnoise(vWorld.xz * 1.7));
    albedo = mix(albedo, vec3(0.36, 0.3, 0.22) * (0.85 + 0.3 * vnoise(vWorld.xz * 5.0)), 0.6 * clamp(muck, 0.0, 1.0));
    // Cart ruts: two grooves a Roman axle apart down each lane, worn into
    // the blocks (vWall.z: metres from the street's centreline). Real
    // depressions: the normal turns into each one from the lateral
    // direction, which the screen derivatives of lat give in world space.
    float rut = 0.0;
    if (half_ > 1.6) {
      vec2 dx = dFdx(vWorld.xz), dy = dFdy(vWorld.xz);
      vec2 dl = vec2(dFdx(lat), dFdy(lat));
      float det = dx.x * dy.y - dx.y * dy.x;
      vec2 G = abs(det) > 1e-10 ? vec2(dl.x * dy.y - dx.y * dl.y, dx.x * dl.y - dl.x * dy.x) / det : vec2(0.0);
      G = length(G) > 0.01 ? normalize(G) : vec2(0.0);
      float rslope = 0.0;
      for (int k = -1; k <= 1; k += 2) {
        float c = float(k) * 0.72;
        float t = (lat - c) / 0.11;
        float r = 1.0 - smoothstep(0.0, 1.0, abs(t));
        rut = max(rut, r);
        // Height -cos-like across the groove: slope away from its axis.
        rslope += abs(t) < 1.0 ? sign(t) * sin(3.1416 * abs(t)) * 0.6 : 0.0;
      }
      n = normalize(n - vec3(G.x, 0.0, G.y) * rslope * nearP);
      albedo *= 1.0 - 0.25 * rut;
      ao *= 1.0 - 0.3 * rut;
    }
    // The dome's slope, from the point's offset to the block's centre;
    // flat on a broad worn crown, steep at the shoulders.
    vec2 off = pc.yz * S;
    float slope = (1.0 - crown) * 0.7 + 0.08;
    vec3 tilt = vec3(off.x, 0.0, off.y) * slope * 1.3;
    n = normalize(n + tilt * (1.0 - grit * 0.7));
    ao *= 1.0 - 0.35 * grit;
    gloss = 0.55 * crown * (1.0 - rut * 0.5);
  } else if (style < 3.5) {
    // Kerbstones and slab edges: cut blocks.
    if (abs(n.y) < 0.6 && H > 0.0 && H < 0.7 && len > 0.0) {
      // A street kerb (the slabs' sides, KERB_M high): big blocks of dark
      // lava and pale tuff or limestone, irregular lengths, the top edge
      // rounded and polished by feet and hubs, mud at the foot.
      float nearK = 1.0 - smoothstep(20.0, 50.0, vViewDist);
      const float BL = 1.8;
      float k0 = floor(u / BL), fu = u / BL - k0;
      float cut = 0.3 + 0.4 * h21(vec2(k0, seed * 13.0));
      float bid = k0 * 2.0 + step(cut, fu);
      float jd = min(min(fu, 1.0 - fu), abs(fu - cut)) * BL;
      float kind = h21(vec2(bid, seed * 7.0 + 1.0));
      vec3 st = kind < 0.6 ? vec3(0.22, 0.22, 0.215) : kind < 0.85 ? vec3(0.5, 0.45, 0.34) : vec3(0.6, 0.58, 0.52);
      st *= 0.88 + 0.2 * h21(vec2(bid, 3.0));
      st *= mix(1.0, 0.85 + 0.3 * vnoise(vec2(u, h) * vec2(9.0, 14.0) + bid), nearK);
      if (kind < 0.6) st *= 1.0 - 0.4 * step(0.9, vnoise(vec2(u, h) * 30.0)) * nearK;
      float top = smoothstep(H - 0.08 - 0.03 * vnoise(vec2(u * 3.0, bid)), H, h);
      st *= mix(1.0, 1.18, top);
      // Joints: tight, dark, a little dust.
      st = mix(st, vec3(0.12, 0.11, 0.1), (1.0 - smoothstep(0.004, 0.014, jd)) * nearK);
      // Mud at the foot.
      st = mix(st, vec3(0.32, 0.27, 0.2), 0.6 * (1.0 - smoothstep(0.0, 0.14 + 0.08 * vnoise(vec2(u * 2.0, 1.0)), h)));
      albedo = st;
      n = normalize(n + vec3(0.0, 1.3 * top, 0.0));
      ao *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.15, h));
      gloss = 0.35 * top;
    } else {
    vec2 b = vec2(wp.x / 1.1, wp.y / 0.45);
    if (abs(n.y) > 0.6) b = vWorld.xz / 0.9;
    // A tier of seats: blocks along the ring, the dark line under the step
    // in front, and the seam where the seat meets the riser behind.
    if (abs(n.y) > 0.6 && H > 0.0) {
      b = vec2(u / 1.3, 0.5);
      albedo *= mix(0.55, 1.0, smoothstep(0.0, 0.16, h / H)) * (1.0 - 0.18 * smoothstep(0.86, 1.0, h / H));
    }
    float id = h21(floor(b) + seed * 7.0);
    albedo *= 0.8 + 0.35 * id;
    vec2 f = fract(b);
    albedo *= 0.75 + 0.25 * smoothstep(0.0, 0.05, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    albedo *= 0.9 + 0.18 * vnoise(vWorld.xz * 6.0 + vWorld.y * 4.0);
    }
  } else if (style < 4.5) {
    // Stucco: columns, temples, porticoes. Columns go red on the lower third.
    if (p1 > 0.5 && h < H * 0.36) albedo = vec3(0.56, 0.14, 0.09);
    albedo *= 0.9 + 0.16 * fbm(vec2(wp.x * 0.6, wp.y * 0.6));
    if (vViewDist < 90.0 && abs(n.y) < 0.6) {
      // Weathered stucco: water stains, rain streaks, a trowelled face,
      // dirt at the foot where the wall has a known height.
      float nearS = 1.0 - smoothstep(25.0, 50.0, vViewDist);
      float farS = 1.0 - smoothstep(60.0, 90.0, vViewDist);
      vec2 sf = vec2(wp.x * 0.5, wp.y * 0.5) + seed * 13.0;
      albedo = mix(albedo, albedo * vec3(0.8, 0.74, 0.64), 0.5 * smoothstep(0.55, 0.8, fbm(sf)) * farS);
      float sk = vnoise(vec2(wp.x * 5.0, wp.y * 0.3)) * vnoise(vec2(wp.x * 1.7, wp.y * 0.12 + 4.0));
      albedo *= 1.0 - 0.2 * mix(0.25, smoothstep(0.2, 0.5, sk), nearS) * farS;
      if (H > 0.5) {
        albedo = mix(albedo, vec3(0.34, 0.29, 0.22), 0.45 * (1.0 - smoothstep(0.0, 0.5, h)) * farS);
        ao *= mix(0.72, 1.0, smoothstep(0.0, 0.35, h));
      }
      if (nearS > 0.0) n = plasterNormal(n, T3, wp, 0.01 * nearS);
    }
    gloss = 0.1;
  } else if (style < 5.5) {
    if (p1 > 254.5) {
      // A block's open ground (INTERIOR_GLSL plotGround): beaten earth,
      // vegetable beds, vines and grass in plots, never a lawn.
      albedo = plotGround(vWorld.xz, vViewDist);
    } else if (p1 > 0.5) {
      // A peristyle (INTERIOR_GLSL gardenPaint): vWall.xy metres from the
      // court's corner, zw its size, p1 the colonnade's depth in decimetres,
      // the walk under it floored in p2 - 1 (a FloorKind).
      float isWalk;
      albedo = gardenPaint(vWall.xy, vWall.zw, p1 * 0.1, seed, vViewDist, isWalk);
      if (isWalk > 0.5) {
        float fg;
        albedo = floorPaint(vWall.xy, vWall.zw, max(0.0, p2 - 1.0), seed, vViewDist, fg);
        gloss = fg;
      }
    } else {
    // Garden: clipped green and bare earth.
    float g = fbm(vWorld.xz * 0.35);
    albedo = mix(vec3(0.38, 0.3, 0.2), albedo, smoothstep(0.35, 0.6, g));
    albedo *= 0.85 + 0.3 * vnoise(vWorld.xz * 2.5);
    }
  } else if (style < 6.5) {
    // Inside a shop or a doorway, lit from the opening: the light falls off
    // with depth. A reveal's u runs inward on one side and outward on the
    // other; the eye is always on the street side, so the end of u nearer
    // the eye is the opening. The back wall (p1) and the ceilings sit at
    // a typical depth.
    float depthIn = p1 > 0.5 ? 3.0 : 1.2;
    // The suburbs' openings are a dark quad on the front, not a recess.
    bool flatOpening = albedo.r < 0.2;
    bool vertical = abs(n.y) < 0.5 && !flatOpening;
    if (flatOpening) depthIn = 3.0;
    if (vertical && p1 < 0.5 && len > 0.0) depthIn = dot(T3 * su, v) > 0.0 ? len - u : u;
    float dim = smoothstep(0.0, 3.4, depthIn);
    covered = flatOpening ? 1.0 : 0.6;
    if (!flatOpening) ao *= mix(1.0, 0.6, dim);
    float nearI = 1.0 - smoothstep(25.0, 50.0, vViewDist);
    if (vertical && len > 0.0) {
      // Painted plaster: a dark red dado, a white upper wall, smudged.
      vec3 wallC = h < 0.95 ? vec3(0.46, 0.15, 0.1) : mix(albedo, CREAM, 0.45);
      wallC *= 0.85 + 0.25 * fbm(vec2(u, h) * 1.3 + seed * 7.0);
      wallC = mix(wallC, wallC * 0.6, (1.0 - smoothstep(0.0, 0.3, h)));
      albedo = wallC;
      if (p1 > 0.5) {
        // The back wall: two shelves of jars and jugs, a row of amphorae
        // stood against the wall below.
        for (int k = 0; k < 2; k++) {
          float sh = 1.35 + 0.6 * float(k);
          float above = h - sh;
          if (abs(above) < 0.02) albedo = vec3(0.34, 0.22, 0.12) * (1.0 + 0.4 * step(0.0, above));
          if (above < -0.02 && above > -0.12) ao *= 0.55 + 0.45 * (1.0 - smoothstep(-0.12, -0.02, above));
          float cw = 0.22;
          float cell = floor(u / cw);
          float r0 = h21(vec2(cell, seed * 5.0 + float(k)));
          if (r0 > 0.25 && above > 0.02 && nearI > 0.0) {
            float jh = 0.16 + 0.12 * fract(r0 * 7.0);
            float R = 0.05 + 0.035 * fract(r0 * 13.0);
            float yy = (above - 0.02) / jh;
            float r = yy < 0.82 ? R * pow(sin(3.1416 * min(1.0, yy / 0.82 * 0.9 + 0.1)), 0.6) : R * 0.42;
            float dx = fract(u / cw) * cw - cw * 0.5;
            if (yy < 1.0 && abs(dx) < r) {
              float roundness = sqrt(1.0 - (dx / r) * (dx / r));
              vec3 jc = fract(r0 * 31.0) < 0.6 ? vec3(0.58, 0.32, 0.19) : fract(r0 * 31.0) < 0.85 ? vec3(0.72, 0.64, 0.5) : vec3(0.16, 0.13, 0.11);
              albedo = jc * (0.45 + 0.7 * roundness);
              ao = mix(ao, 1.0, 0.3);
            }
          }
        }
        // Amphorae: a body swelling from a pointed toe, a narrow neck, two handles.
        float aw = 0.34;
        float ac = floor(u / aw);
        float ra = h21(vec2(ac, seed * 3.0 + 11.0));
        if (ra > 0.2 && h < 1.0 && nearI > 0.0) {
          float yy = h / (0.9 + 0.1 * ra);
          float dx = fract(u / aw) * aw - aw * 0.5;
          float R = 0.125;
          float r = yy < 0.1 ? R * 0.25 * yy / 0.1 + 0.01 : yy < 0.78 ? R * pow(sin(3.1416 * (0.12 + 0.88 * (yy - 0.1) / 0.68)), 0.7) : yy < 0.97 ? 0.035 : 0.0;
          bool handle = yy > 0.74 && yy < 0.93 && abs(abs(dx) - 0.06) < 0.012;
          if (abs(dx) < r || handle) {
            float roundness = handle ? 0.6 : sqrt(max(0.0, 1.0 - (dx / r) * (dx / r)));
            vec3 ac3 = ra < 0.6 ? vec3(0.62, 0.36, 0.22) : ra < 0.85 ? vec3(0.74, 0.6, 0.45) : vec3(0.55, 0.28, 0.18);
            albedo = ac3 * (0.4 + 0.75 * roundness);
            ao = mix(ao, 1.0, 0.2);
          }
        }
      }
    } else if (!flatOpening) {
      // Ceilings: smoke-blackened boards.
      albedo *= 0.55;
    }
  } else if (style < 7.5) {
    if (p1 > 0.5) {
      // Wicker: withies woven over and under the stakes, one row every 4 cm.
      float row = floor(h / 0.04), col = floor(u / 0.09);
      float over = mod(row + col, 2.0);
      float fu = fract(u / 0.09), fh = fract(h / 0.04);
      albedo *= mix(0.62, 1.05, over) * (0.75 + 0.25 * sin(3.1416 * fh)) * (0.85 + 0.15 * sin(3.1416 * fu));
    } else {
    // Wood: planks and the studs of a door. A surface with no wall
    // coordinates (eaves, ceilings) runs its planks along the world.
    bool door = len > 0.5 && H > 1.5 && abs(n.y) < 0.5;
    bool flat_ = abs(n.y) > 0.5;
    float x = len > 0.0 ? u : flat_ ? vWorld.x : wp.x;
    float y = len > 0.0 ? h : flat_ ? vWorld.z : vWorld.y;
    // Grain is a few millimetres across: it goes before a pixel spans it.
    float nearW = 1.0 - smoothstep(0.005, 0.014, fwidth(x));
    float pw = 0.2;
    float pid = floor(x / pw), pl = fract(x / pw);
    vec3 wood = albedo * (0.78 + 0.3 * h21(vec2(pid, seed)));
    // Grain runs along the plank: stretched noise.
    float gr = vnoise(vec2(x * 40.0 + pid * 3.0, y * 1.6)) * 0.6 + vnoise(vec2(x * 70.0, y * 0.8 + pid)) * 0.4;
    wood *= mix(1.0, 0.8 + 0.35 * gr, nearW);
    wood = mix(wood, wood * vec3(0.85, 0.85, 0.88), 0.4 * smoothstep(0.5, 0.8, vnoise(vec2(x, y) * 1.5 + seed)));
    float gap = 1.0 - smoothstep(0.0, 0.02, min(pl, 1.0 - pl) * pw);
    wood *= 1.0 - 0.5 * gap * mix(0.4, 1.0, nearW);
    if (door) {
      // Three rails across the leaves, nailed through with bronze studs; a
      // seam between the two leaves; the foot weathered grey.
      float rail = 0.0, railY = 0.0;
      for (int k = 0; k < 3; k++) {
        float ry = k == 0 ? 0.35 : k == 1 ? H * 0.5 : H - 0.35;
        if (abs(h - ry) < 0.075) { rail = 1.0; railY = h - ry; }
      }
      if (rail > 0.0) {
        wood = albedo * (0.9 + 0.2 * vnoise(vec2(u * 1.2, h * 50.0))) * 1.08;
        n = normalize(n + vec3(0.0, sign(railY) * 0.6 * smoothstep(0.05, 0.075, abs(railY)), 0.0));
        // Studs at each plank's middle on the rail.
        float sd = length(vec2((pl - 0.5) * pw, railY));
        float stud = 1.0 - smoothstep(0.014, 0.019, sd);
        if (stud > 0.0) {
          wood = mix(wood, vec3(0.5, 0.36, 0.16), stud * nearW);
          vec2 sv = vec2((pl - 0.5) * pw, railY) / 0.019;
          n = normalize(n + (T3 * su * sv.x + vec3(0.0, sv.y, 0.0)) * stud * nearW);
          gloss = 0.6 * stud * nearW;
        }
      } else {
        // Shadow under each rail.
        for (int k = 0; k < 3; k++) {
          float ry = k == 0 ? 0.35 : k == 1 ? H * 0.5 : H - 0.35;
          float below = ry - 0.075 - h;
          if (below > 0.0 && below < 0.05) ao *= 0.6 + 0.4 * below / 0.05;
        }
      }
      wood *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 0.015, abs(u - len * 0.5)));
      wood = mix(wood, vec3(0.3, 0.28, 0.26), 0.35 * (1.0 - smoothstep(0.0, 0.5, h)));
    }
    albedo = wood;
    }
  } else if (style < 8.5) {
    // Water: dark, with the sky in it at a grazing angle. An atrium's pool
    // (p2 set) sees the sky only through the compluvium over it: p1 is the
    // opening's height over the water and p2 its radius, in decimetres,
    // vWall.zw its middle. A reflected ray that leaves past the opening's
    // edge sees the shaded underside of the roof instead. p1 alone (the
    // Sarno, render/pompeiisuburbs.ts) is open water under the open sky.
    vec2 q = vWorld.xz * 2.3 + vec2(uWaterTime * 0.11, uWaterTime * 0.07);
    vec2 rip = vec2(vnoise(q) - vnoise(q + vec2(0.37, 0.0)), vnoise(q) - vnoise(q + vec2(0.0, 0.37)));
    // Calm: a breath of wind on a pool sheltered by four walls.
    vec3 wn = normalize(vec3(rip.x * 0.18, 1.0, rip.y * 0.18) * (1.0 - smoothstep(20.0, 60.0, vViewDist)) + vec3(0.0, 1e-3, 0.0));
    float fres = 0.02 + 0.98 * pow(1.0 - max(0.0, dot(wn, v)), 5.0);
    vec3 r = reflect(-v, wn);
    vec3 sky = shIrradiance(r) * 0.35;
    vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
    float sv = sunVisibility(vWorld, vec3(0.0, 1.0, 0.0), uSunDir, vViewDist);
    if (p2 > 0.5 && r.y > 0.0) {
      // The sky through the compluvium; a ray leaving past its edge sees the
      // painted atrium walls and the roof's underside, lit by the court:
      // warm, about as bright as the walls look from where the eye is.
      vec2 hit = vWorld.xz + r.xz * (p1 * 0.1) / r.y;
      float open = 1.0 - smoothstep(p2 * 0.085, p2 * 0.1, length(hit - vWall.zw));
      vec3 walls = vec3(0.42, 0.24, 0.15) * (shIrradiance(vec3(-r.x, 0.0, -r.z)) * 0.5 + sunE * max(0.0, uSunDir.y) * 0.12 + townLamps(vWorld, vec3(0.0, 1.0, 0.0)));
      sky = mix(walls * 0.32, sky * 1.6, open);
    }
    // The pool's floor through a hand's depth of water: marble or signinum, lit.
    vec3 floorLit = vec3(0.6, 0.56, 0.5) * (mix(occludedSkyIrradiance(vec3(0.0, 1.0, 0.0)), shIrradiance(vec3(0.0, 1.0, 0.0)), 0.5) + sunE * max(0.0, uSunDir.y) * sv + townLamps(vWorld, vec3(0.0, 1.0, 0.0)));
    // Caustics: the ripples focus the sun into a moving net on the floor.
    float caus = pow(1.0 - abs(vnoise(q * 4.1 + 5.0) - vnoise(q * 4.1 + vec2(3.3, 1.1))), 10.0) * sv * (1.0 - smoothstep(8.0, 25.0, vViewDist));
    vec3 col = mix(floorLit * vec3(0.4, 0.5, 0.5) * (1.0 + 0.35 * caus), sky, fres);
    col += sunE * pow(max(0.0, dot(wn, normalize(uSunDir + v))), 300.0) * 2.0 * sv;
    col += townLampSpec(vWorld, wn, v) * 0.5;
    if (p1 > 0.5 && p2 < 0.5) {
      // Open water under the open sky (the Sarno): the sky fills it as it
      // does the sea, and ripples on the current break it up as the sea's do.
      vec2 rp = vWorld.xz * vec2(0.35, 0.9);
      vec3 rn = normalize(n + vec3(vnoise(rp) - 0.5, 0.0, vnoise(rp + 17.0) - 0.5) * 0.35);
      float rf = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(rn, v)), 5.0);
      col = albedo * 0.45 * occludedSkyIrradiance(n) + shIrradiance(reflect(-v, rn)) * (0.75 + rf);
      col += sunE * pow(max(0.0, dot(rn, normalize(uSunDir + v))), 120.0) * 0.6;
    }
    vec3 ro = atmoOrigin(uCamAltitude);
    vec3 rd = normalize(vWorld - uCameraPos);
    vec3 trans;
    vec3 ins = atmosphere(ro, rd, vViewDist, trans);
    fragColor = vec4(col * trans + ins, 1.0);
    return;
  } else if (style < 9.5) {
    albedo *= 0.85 + 0.25 * fbm(vWorld.xz * 1.3);
  } else if (style < 10.5) {
    // Masonry. City wall (p1 2): big tuff and limestone blocks in courses.
    // Amphitheatre (p1 1): blind arcades. Otherwise opus incertum.
    if (p1 > 1.5) {
      vec2 b = vec2(u / 1.4, h / 0.62);
      b.x += step(1.0, mod(floor(b.y), 2.0)) * 0.5;
      float id = h21(floor(b));
      albedo *= 0.78 + 0.32 * id;
      vec2 f = fract(b);
      albedo *= 0.72 + 0.28 * smoothstep(0.0, 0.04, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    } else if (p1 > 0.5) {
      float bay = 5.6;
      float lx = fract(u / bay) * bay - bay * 0.5;
      float archTop = 6.2, springing = 4.6;
      bool arch = abs(lx) < 1.9 && h > 0.4 && (h < springing || length(vec2(lx, (h - springing) * 1.2)) < 1.9);
      bool upper = abs(lx) < 1.0 && h > archTop + 1.4 && h < archTop + 3.2;
      if (arch || upper) albedo *= 0.42;
      albedo *= 0.85 + 0.25 * vnoise(vec2(u, h) * 1.7);
    } else {
      vec3 vo = voronoi(vec2(u, h) / 0.3);
      albedo *= 0.75 + 0.4 * h21(vo.yz);
      albedo *= 0.7 + 0.3 * smoothstep(0.02, 0.08, vo.x);
    }
  } else if (style < 11.5 && p2 > 0.5) {
    // A tomb's inscription panel (render/pompeiisuburbs.ts): lines of
    // capitals cut in the marble and picked out in red, as the surviving
    // ones were. Each letter is a few strokes in its cell, chosen by hash:
    // it reads as lettering at the distance a passer-by reads it, and fades
    // to a pale band past 30 m where the strokes would only alias.
    vec3 c = albedo * (0.95 + 0.05 * vnoise(vec2(u, h) * 9.0));
    float lineH = clamp(H / 5.0, 0.09, 0.16);
    float lrow = floor(h / lineH), ly = fract(h / lineH);
    float margin = 0.12, cw = lineH * 0.62;
    float lcol = floor((u - margin) / cw), lx = fract((u - margin) / cw);
    float lineLen = (len - 2.0 * margin) * (0.55 + 0.45 * h21(vec2(lrow, seed * 31.0)));
    bool inText = u > margin && u < len - margin && h > lineH * 0.6 && h < H - lineH * 0.6 && abs(u - len * 0.5) < lineLen * 0.5;
    float lg = h21(vec2(lcol, lrow + seed * 57.0));
    float ink = 0.0;
    if (inText && ly > 0.22 && ly < 0.86 && lx > 0.12 && lx < 0.88) {
      float sx = (lx - 0.12) / 0.76, sy = (ly - 0.22) / 0.64, w = 0.17;
      ink += step(0.35, lg) * step(sx, w);
      ink += step(lg, 0.7) * step(1.0 - w, sx);
      ink += step(0.5, fract(lg * 7.0)) * step(1.0 - w * 1.2, sy);
      ink += step(0.5, fract(lg * 13.0)) * step(sy, w * 1.2);
      ink += step(0.6, fract(lg * 3.0)) * step(abs(sy - 0.5), w * 0.6);
      ink += step(fract(lg * 5.0), 0.25) * step(abs(sx - sy), w);
    }
    float far = smoothstep(12.0, 30.0, vViewDist);
    albedo = mix(c, vec3(0.42, 0.14, 0.1), clamp(ink, 0.0, 1.0) * 0.85 * (1.0 - far));
    if (inText) albedo = mix(albedo, c * vec3(0.86, 0.8, 0.78), far * 0.5);
    gloss = 0.2;
  } else if (style < 11.5 && p1 > 0.5) {
    // A thermopolium's counter front: offcuts of coloured marble set as
    // crazy paving (giallo antico, pavonazzetto, cipollino, rosso, white).
    vec3 vo = voronoi(vec2(u, h) / 0.075);
    float k = h21(vo.yz);
    vec3 c = k < 0.25 ? vec3(0.78, 0.62, 0.32) : k < 0.45 ? vec3(0.82, 0.76, 0.74) : k < 0.62 ? vec3(0.42, 0.5, 0.4) : k < 0.78 ? vec3(0.55, 0.2, 0.16) : vec3(0.86, 0.84, 0.8);
    c *= 0.9 + 0.15 * vnoise(vec2(u, h) * 18.0 + k * 9.0);
    // Offcuts a hand across, dulled by grease and handling: at full
    // saturation the counters were the loudest thing in the street.
    c = mix(c, vec3(0.74, 0.7, 0.63), 0.4);
    albedo = mix(vec3(0.62, 0.58, 0.52), c, smoothstep(0.03, 0.09, vo.x));
    gloss = 0.3;
  } else if (style < 11.5) {
    // Travertine and marble: big slabs in running bond, warm cream, banded
    // along the bedding, pitted with elongated pores, grime in the joints
    // and broad stains from feet and rain.
    bool flat_ = abs(n.y) > 0.6;
    vec2 m = flat_ ? vWorld.xz : vec2(wp.x, wp.y);
    vec2 sz = flat_ ? vec2(1.3, 0.9) : vec2(1.2, 0.6);
    vec2 b = m / sz;
    b.x += 0.5 * step(1.0, mod(floor(b.y), 2.0));
    vec2 cellB = floor(b);
    float sid = h21(cellB + 0.37);
    float nearT = 1.0 - smoothstep(20.0, 50.0, vViewDist);
    vec3 trav = albedo * vec3(1.06, 1.0, 0.87) * (0.86 + 0.16 * sid);
    // Bedding: each slab's bands run along one of its axes.
    vec2 lm = fract(sid * 5.0) < 0.5 ? m : m.yx;
    float band = vnoise(vec2(lm.x * 0.6, lm.y * 7.0 + sid * 20.0));
    trav *= 0.93 + 0.1 * band;
    // Pores: small and sparse, fading before they would sparkle.
    float pore = smoothstep(0.8, 0.86, vnoise(vec2(lm.x * 14.0, lm.y * 55.0) + sid * 11.0));
    trav *= 1.0 - 0.18 * pore * nearT;
    vec2 f = fract(b);
    float jd = min(min(f.x, 1.0 - f.x) * sz.x, min(f.y, 1.0 - f.y) * sz.y);
    float joint = 1.0 - smoothstep(0.003, 0.02 + fwidth(jd), jd);
    trav = mix(trav, vec3(0.45, 0.39, 0.31), joint * 0.45 * mix(0.5, 1.0, nearT));
    trav = mix(trav, trav * vec3(0.8, 0.75, 0.66), 0.5 * smoothstep(0.5, 0.8, fbm(m * 0.35 + 7.0)));
    albedo = trav;
    ao *= 1.0 - 0.3 * joint;
    gloss = 0.2 * (1.0 - joint);
  } else if (style < 12.5) {
    // Fresco: a Third or Fourth Style room (INTERIOR_GLSL paintedWall); p1
    // the scheme, 0 to take it from the house's seed.
    float pao;
    albedo = paintedWall(u, h, len, H, seed, p1, vViewDist, pao);
    ao *= pao;
    gloss = 0.12;
  } else if (style < 13.5) {
    // Opus signinum and beaten earth: warm, packed with crushed tile, lava
    // chips and limestone pebbles, white tesserae here and there.
    albedo *= 0.82 + 0.3 * fbm(vWorld.xz * 0.8);
    albedo = mix(albedo, albedo * vec3(1.08, 0.94, 0.86), 0.5 * smoothstep(0.45, 0.7, fbm(vWorld.xz * 0.3 + 9.0)));
    float nearE = 1.0 - smoothstep(12.0, 30.0, vViewDist);
    if (nearE > 0.0) {
      for (int k = 0; k < 2; k++) {
        float cs = k == 0 ? 0.07 : 0.032;
        vec2 g = vWorld.xz / cs;
        vec2 ci = floor(g);
        float r0 = h21(ci + float(k) * 17.0);
        vec2 o = 0.3 + 0.4 * h22(ci + float(k) * 5.0);
        float rad = (0.12 + 0.12 * fract(r0 * 9.0));
        float d = length(fract(g) - o);
        float peb = (1.0 - smoothstep(rad * 0.75, rad, d)) * step(0.68, r0);
        float t = fract(r0 * 23.0);
        vec3 pc = t < 0.4 ? vec3(0.17, 0.16, 0.15) : t < 0.65 ? vec3(0.72, 0.69, 0.62) : t < 0.85 ? vec3(0.55, 0.26, 0.16) : vec3(0.52, 0.45, 0.3);
        albedo = mix(albedo, pc * (0.8 + 0.4 * (1.0 - d / rad)), peb * nearE);
      }
      albedo *= 0.92 + 0.16 * vnoise(vWorld.xz * 23.0) * nearE;
    }
    albedo = mix(albedo, albedo * 1.35, 0.6 * step(0.99, h21(floor(vWorld.xz * 22.0))));
  } else if (style < 14.5) {
    // Hide: the horse's coat, or (p1 set) mane and tail hair in strands.
    if (p1 > 0.5) {
      albedo *= 0.7 + 0.5 * vnoise(vec2(vWall.x * 70.0, vWall.y * 1.5 + seed));
      gloss = 0.3;
    } else {
      // A short summer coat: faint grain, and the sheen a groomed horse has.
      albedo *= 0.93 + 0.1 * vnoise(vWorld.xz * 9.0 + vWorld.y * 7.0);
      gloss = 0.55;
    }
  } else if (style < 15.5) {
    // A column shaft of an order: stuccoed, fluted. The flutes are shading,
    // not geometry: each is a shallow half-round channel, the normal turned
    // across it, darker in its hollow; Ionic and Corinthian flutes have flat
    // fillets between them (p2 bit 0). Red on the lower third where the
    // column is a house's (p2 bit 1), the way the peristyles were painted.
    float fl = max(1.0, p1);
    bool fillets = mod(p2, 2.0) > 0.5;
    float x = fract(vWall.x * fl);
    float w0 = fillets ? 0.14 : 0.0;
    float q = clamp((x - w0 * 0.5) / (1.0 - w0), 0.0, 1.0) * 2.0 - 1.0;
    float inFlute = fillets ? step(w0 * 0.5, x) * step(x, 1.0 - w0 * 0.5) : 1.0;
    float slope = q / sqrt(max(0.08, 1.0 - q * q));
    vec3 tng3 = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-4, 0.0, 0.0));
    // Fade the flutes out with distance: past ~60 m they only alias.
    float near = 1.0 - smoothstep(30.0, 60.0, vViewDist);
    n = normalize(n - tng3 * slope * 0.55 * inFlute * near);
    albedo *= 1.0 - 0.18 * inFlute * (1.0 - q * q) * near;
    if (p2 > 1.5 && h < H * 0.36) albedo = vec3(0.56, 0.14, 0.09) * (0.92 + 0.08 * (1.0 - q * q));
    gloss = 0.12;
  } else if (style < 16.5) {
    // A tile of the art atlas (data/pompeiiart.ts): p1 the tile; p2 bit 0
    // repeats it along the wall at its own proportions over the wall's full
    // height, bit 1 says indoors.
    int tile = int(p1 + 0.5);
    float mode = p2;
    vec4 rect = uArtRect[tile];
    vec4 info = uArtInfo[tile];
    vec2 raw = mod(mode, 2.0) > 0.5 ? vec2(u / max(0.1, H * info.x), 1.0 - clamp(h / max(0.1, H), 0.0, 1.0)) : vWall.xy;
    // Derivatives from the unwrapped coordinate, so the wrap at each repeat
    // does not pick the smallest mip and draw a seam line.
    vec2 st = vec2(fract(raw.x), raw.y);
    vec2 tuv = rect.xy + st * rect.zw;
    vec3 tex = textureGrad(uArt, tuv, dFdx(raw) * rect.zw, dFdy(raw) * rect.zw).rgb;
    tex = pow(tex, vec3(2.2));
    albedo = mix(info.yzw, tex, uArtReady);
    // Indoors, but lit from the doorway and the court: dimmer than the
    // court walls, not as dark as a shop's back room.
    if (mode > 1.5) covered = 0.4;
  } else if (style < 17.5) {
    // Bronze (17, render/pompeiilamps.ts, the statues): mottled like cast
    // metal, green verdigris gathered where the rain and handling did not
    // reach (faces turned down and away), a polished sheen on the rest.
    albedo *= 0.9 + 0.15 * vnoise(vWorld.xz * 5.0 + vWorld.y * 3.0);
    float nearB = 1.0 - smoothstep(4.0, 20.0, vViewDist);
    float hollow = smoothstep(0.1, -0.5, n.y) * 0.6 + smoothstep(0.55, 0.75, vnoise(vWorld.xz * 31.0 + vWorld.y * 47.0)) * 0.5;
    albedo = mix(albedo, vec3(0.16, 0.27, 0.2), clamp(hollow, 0.0, 1.0) * 0.55 * nearB);
    gloss = 0.75 - 0.4 * clamp(hollow, 0.0, 1.0) * nearB;
  } else if (style > 19.5 && style < 20.5) {
    // A bath's rooms (render/pompeiiwater.ts): p1 the finish, p2 how much
    // of the sky the room keeps out (0..255). u, h the wall's own metres.
    shut = p2 / 255.0;
    if (p1 < 0.5) {
      // Painted plaster: black socle, a red dado, yellow panels framed in red, a white cornice.
      vec3 c = albedo;
      float pw = 2.4;
      float px = fract(u / pw);
      if (h < 0.35) c = vec3(0.08, 0.07, 0.06);
      else if (h < 1.3) c = vec3(0.5, 0.11, 0.07);
      else if (h > H - 0.35) c = vec3(0.86, 0.84, 0.78);
      else if (px < 0.035 || px > 0.965 || abs(h - 1.36) < 0.05) c = vec3(0.5, 0.11, 0.07);
      albedo = c * (0.92 + 0.1 * fbm(vec2(u, h) * 0.8 + seed * 9.0));
      // Damp: steam condensing low on the walls of the hot rooms.
      albedo *= 1.0 - 0.15 * smoothstep(1.2, 0.0, h) * step(0.5, fract(seed * 3.3));
    } else if (p1 < 1.5) {
      // Marble: white slabs on the floors and the pool rims, faint veins,
      // warmed for the light off the ochre walls the sky term leaves out.
      albedo *= vec3(1.06, 1.0, 0.88);
      vec2 b = abs(n.y) > 0.6 ? vWorld.xz / 0.9 : vec2(u / 0.9, h / 0.45);
      albedo *= 0.88 + 0.14 * h21(floor(b) + seed);
      albedo *= 0.94 + 0.08 * vnoise(vWorld.xz * 5.0 + vWorld.y * 2.0);
      vec2 f = fract(b);
      albedo *= 0.86 + 0.14 * smoothstep(0.0, 0.03, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      gloss = 0.45;
    } else if (p1 < 2.5) {
      // The stuccoed vault: fluted in shallow channels across it, as the Stabian caldarium's.
      float fl = abs(fract(u / 0.3) - 0.5) * 2.0;
      albedo *= 0.86 + 0.16 * fl;
      albedo *= 0.95 + 0.06 * vnoise(vec2(u, h) * 1.7);
    } else if (p1 < 3.5) {
      // The frigidarium's cone, painted as a night sky: blue ground, gold stars.
      vec2 sc = vec2(u * 3.0, h * 3.0);
      vec2 cell = floor(sc), fp = fract(sc) - 0.5;
      float star = (1.0 - smoothstep(0.04, 0.11, length(fp - (h22(cell) - 0.5) * 0.6))) * step(0.45, h21(cell + 3.0));
      albedo = mix(albedo * (0.9 + 0.12 * vnoise(sc * 0.7)), vec3(0.85, 0.65, 0.25), star);
    } else if (p1 < 4.5) {
      // Opus signinum: the pools' waterproof lining, crushed tile in lime.
      albedo *= 0.85 + 0.2 * fbm(vWorld.xz * 2.2 + vWorld.y * 1.3);
      albedo = mix(albedo, vec3(0.85, 0.8, 0.72), 0.4 * step(0.97, h21(floor(vec2(u, h) * 30.0 + vWorld.xz * 30.0))));
    } else if (p1 < 5.5) {
      // The furnace's bronze boiler, sooted.
      albedo *= 0.75 + 0.3 * vnoise(vWorld.xz * 4.0 + vWorld.y * 6.0);
      gloss = 0.3;
    } else {
      // An apodyterium wall: the row of niches the clothes went in, on a red ground.
      float nw = 0.62;
      float nx = fract(u / nw) - 0.5;
      float y0 = 1.75, y1 = 2.25;
      float arch = y1 + sqrt(max(0.0, 0.0625 - nx * nx * 1.2));
      bool inNiche = abs(nx) < 0.25 && h > y0 && h < arch && u > 0.4 && u < len - 0.4;
      vec3 c = h < 0.35 ? vec3(0.08, 0.07, 0.06) : h < 1.6 ? vec3(0.55, 0.13, 0.08) : vec3(0.86, 0.82, 0.7);
      if (abs(h - 1.62) < 0.04 || abs(h - y0 + 0.06) < 0.025) c = vec3(0.85, 0.82, 0.74);
      if (inNiche) c = vec3(0.16, 0.1, 0.07) * (0.6 + 0.6 * (h - y0));
      albedo = c * (0.92 + 0.1 * fbm(vec2(u, h) * 0.9 + seed * 7.0));
    }
  } else if (style > 20.5 && style < 21.5) {
    // Glass-paste wall mosaic (Herculaneum, render/herculaneummesh.ts): p1 0
    // Neptune and Amphitrite in their shell-topped aedicula, p1 1 the
    // nymphaeum's hunting scene. A stylised reading of the two panels, not a
    // copy: the blue ground, the gold and red frames, the scallop lunette and
    // the figures' places are theirs. q runs 0..1 across and up the panel.
    vec2 q = vec2(u / max(0.1, len), h / max(0.1, H));
    vec3 BLUE = vec3(0.05, 0.16, 0.42), DEEP = vec3(0.03, 0.08, 0.22), GOLD = vec3(0.78, 0.6, 0.22), RED = vec3(0.55, 0.12, 0.08), WHITE = vec3(0.86, 0.84, 0.78), GREEN = vec3(0.12, 0.38, 0.22);
    vec3 c = BLUE;
    float edge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y));
    // Shell-and-scroll borders: a red band, a gold fillet, white beads.
    if (edge < 0.035) c = RED;
    else if (edge < 0.05) c = GOLD;
    else if (edge < 0.07) c = mix(BLUE, WHITE, step(0.5, fract((q.x + q.y) * len * 2.2)));
    if (p1 < 0.5) {
      // The aedicula: a lunette with a scallop shell over the two figures.
      vec2 lc = vec2(0.5, 0.78);
      vec2 d = (q - lc) * vec2(len / H, 1.0);
      float r = length(d);
      if (q.y > lc.y && r < 0.17 && edge >= 0.07) {
        float ang = atan(d.y, d.x);
        c = mix(WHITE, GOLD, step(0.5, fract(ang * 4.5)));
        if (r < 0.04) c = RED;
      } else if (q.y > lc.y && r < 0.19 && edge >= 0.07) c = RED;
      // Columns of the aedicula either side, garlanded.
      if (abs(abs(q.x - 0.5) - 0.37) < 0.025 && q.y > 0.12 && q.y < 0.78) c = mix(GOLD, GREEN, step(0.5, fract(q.y * 14.0)));
      // Neptune (left, nude, his mantle dark blue, the trident in his raised
      // right hand) and Amphitrite (right, robed in white with a rose mantle),
      // on a little green ground line. Figures 0.6 of the panel tall.
      float FH = 0.6;
      vec3 skin = vec3(0.74, 0.48, 0.32);
      for (int k = 0; k < 2; k++) {
        float fx = k == 0 ? 0.37 : 0.63;
        vec2 p = (q - vec2(fx, 0.13)) * vec2(len / H, 1.0) / FH;
        if (k == 0) p.x = -p.x;
        vec3 f = mosaicFigure(p, k == 1, k == 0);
        if (f.z < 0.0) {
          if (k == 0) c = f.y > 0.5 ? DEEP * 1.4 : skin * (0.85 + 0.25 * step(0.0, p.x));
          else c = f.y > 0.5 ? vec3(0.72, 0.34, 0.32) : (length(p - vec2(0.0, 0.91)) < 0.062 || p.y > 0.76 ? skin : WHITE * (0.92 + 0.08 * step(0.5, fract(p.x * 30.0))));
          // Dark hair.
          if (length(p - vec2(0.0, 0.93)) < 0.064 && p.y > 0.945) c = vec3(0.12, 0.08, 0.06);
        } else if (f.z < 0.012) c = DEEP * 0.5;
      }
      // The trident, in Neptune's raised hand (his figure is mirrored: right hand at screen left).
      vec2 tp = (q - vec2(0.37, 0.13)) * vec2(len / H, 1.0) / FH + vec2(0.19, 0.0);
      bool shaft = abs(tp.x) < 0.012 && tp.y > 0.02 && tp.y < 1.18;
      bool prongs = tp.y > 1.08 && tp.y < 1.2 && (abs(tp.x) < 0.012 || abs(abs(tp.x) - 0.05) < 0.011);
      bool bar = abs(tp.y - 1.08) < 0.012 && abs(tp.x) < 0.06;
      if (shaft || prongs || bar) c = GOLD;
      if (q.y > 0.11 && q.y < 0.135 && abs(q.x - 0.5) < 0.3) c = GREEN;
      // A green dado of acanthus below.
      if (q.y < 0.11 && edge >= 0.07) c = mix(GREEN, GREEN * 1.6, step(0.55, vnoise(vec2(u, h) * 9.0)));
    } else {
      // The nymphaeum wall: a central apse, vine scrolls on blue, and the
      // deer the hounds chase along the frieze over it.
      vec2 d = (q - vec2(0.5, 0.55)) * vec2(len / H, 1.0);
      bool apse = abs(d.x) < 0.13 && (d.y < 0.0 ? d.y > -0.42 : length(d) < 0.13);
      if (apse && edge >= 0.07) {
        c = mix(DEEP, BLUE, smoothstep(-0.42, 0.13, d.y));
        // Its scallop head.
        if (d.y > 0.0) c = mix(WHITE, GOLD, step(0.5, fract(atan(d.y, d.x) * 3.2)));
      } else if (edge >= 0.07) {
        // Garlands and vine scrolls: thin gold stems curling on the blue, green leaves along them.
        vec2 s = vec2(u, h) / 0.45;
        float stem = abs(fract(s.y + 0.25 * sin(s.x * 3.1416)) - 0.5);
        c = BLUE;
        if (stem < 0.05) c = GOLD;
        else if (stem < 0.16 && h21(floor(s * 4.0)) > 0.45) c = GREEN;
      }
      // The frieze: deer chased by hounds, on white.
      if (q.y > 0.8 && q.y < 0.9 && edge >= 0.07) {
        c = WHITE;
        float cell = 0.9;
        float x = fract(u / cell);
        bool hound = mod(floor(u / cell), 2.0) > 0.5;
        vec2 a = vec2((x - 0.5) * cell, h - 0.8 * H - 0.02);
        float s = hound ? 0.8 : 1.0;
        a /= s;
        float body = sdCap(a, vec2(-0.16, 0.14), vec2(0.14, 0.15), 0.05);
        float leg = min(min(sdCap(a, vec2(-0.13, 0.12), vec2(-0.2, 0.0), 0.014), sdCap(a, vec2(-0.1, 0.12), vec2(-0.05, 0.0), 0.014)),
                        min(sdCap(a, vec2(0.1, 0.12), vec2(0.05, 0.0), 0.014), sdCap(a, vec2(0.13, 0.12), vec2(0.21, 0.02), 0.014)));
        float head = sdCap(a, vec2(0.15, 0.17), vec2(0.23, hound ? 0.17 : 0.24), 0.028);
        float antler = hound ? 9.0 : min(sdCap(a, vec2(0.21, 0.26), vec2(0.18, 0.33), 0.008), sdCap(a, vec2(0.2, 0.28), vec2(0.25, 0.32), 0.008));
        if (min(min(body, leg), min(head, antler)) < 0.0) c = hound ? vec3(0.3, 0.28, 0.26) : vec3(0.52, 0.3, 0.14);
      }
    }
    // The tesserae: glass a centimetre across in dark grout, each its own
    // shade. Faded with distance before the grid would only alias.
    vec2 tc = vec2(u, h) / 0.012;
    vec2 tf = fract(tc);
    float grout = smoothstep(0.0, 0.12, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
    // Fade by the tesserae's size on screen, not distance alone: a joint a
    // pixel wide only draws a moire grid over the picture.
    float px = length(fwidth(tc));
    float near = 1.0 - smoothstep(0.15, 0.45, px);
    c *= mix(1.0, (0.85 + 0.25 * h21(floor(tc) + seed)) * mix(0.7, 1.0, grout), near);
    albedo = c;
    gloss = 0.55;
  } else if (style > 21.5 && style < 22.5) {
    // Opus craticium: square timber posts about 0.9 m apart, a sill and a
    // head beam, braces across alternate bays, rubble and lime packed
    // between and plastered over, the plaster gone in patches.
    float bay = 0.92;
    float bx = fract(u / bay);
    float bi = floor(u / bay);
    float post = step(bx, 0.13 / bay);
    float beam = step(h, 0.16) + step(H - 0.16, h) + step(abs(h - H * 0.5), 0.07);
    float brace = step(abs(bx - (mod(bi, 2.0) > 0.5 ? h / H : 1.0 - h / H)), 0.07) * step(0.5, h21(vec2(bi, seed * 7.0)));
    float timber = clamp(post + beam + brace, 0.0, 1.0);
    vec3 plaster = albedo * (0.9 + 0.12 * fbm(vec2(u, h) * 1.4 + seed * 5.0));
    vec3 vo = voronoi(vec2(u, h) / 0.09);
    vec3 rubble = vec3(0.42, 0.38, 0.33) * (0.75 + 0.4 * h21(vo.yz)) * (0.6 + 0.4 * smoothstep(0.02, 0.06, vo.x));
    float flaked = smoothstep(0.62, 0.7, fbm(vec2(u, h) * 0.9 + seed * 13.0));
    vec3 infill = mix(plaster, rubble, flaked);
    vec3 wood = vec3(0.2, 0.13, 0.08) * (0.8 + 0.3 * vnoise(vec2(u * 3.0, h * 30.0)));
    albedo = mix(infill, wood, timber);
  } else if (style > 17.5 && style < 18.5) {
    // A ceiling (INTERIOR_GLSL ceilingPaint): vWall.xy metres along its two
    // axes, p1 the design. Under a roof: lit from the room below it.
    float cao;
    albedo = ceilingPaint(vWall.xy, p1, seed, vViewDist, cao);
    ao *= cao;
    covered = 0.5;
  } else if (style > 23.5 && style < 24.5) {
    // A room's floor (INTERIOR_GLSL floorPaint): vWall.xy metres from its
    // corner, vWall.zw its size, p1 the design.
    float fg;
    albedo = floorPaint(vWall.xy, vWall.zw, p1, seed, vViewDist, fg);
    gloss = fg;
  }

#ifdef ROOF_COLLAPSE
  float ruin = roofRuin(vWorld, normalize(vNormal), seed, vRoof);
  if (ruin < 0.0) discard;
  // A cracking patch goes dark with the dust coming up through it.
  if (ruin > 0.0 && ruin < 0.99) albedo *= 0.55;
#endif
  n = ashFlatten(n, normalize(vNormal));
  albedo = ashCover(albedo, n, vWorld, covered);
#ifdef ROOF_COLLAPSE
  // A bare rafter is old timber; a beam a hand wide holds no pumice, so it
  // is drawn after the cover and reads dark against the grey round it.
  if (ruin > 0.99) { albedo = vec3(0.2, 0.14, 0.09) * (0.8 + 0.4 * seed); gloss = 0.0; }
#endif
  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunT;
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  // Under the lamps the night sky is starlight and airglow only: no town of
  // thousands of electric lights round it, so the street between pools goes dark.
  vec3 occSky = occludedSkyIrradiance(n);
  vec3 ambient = occSky * (1.0 - 0.65 * uLampNight * uNight);
  // The lower hemisphere sees warm paving and plaster, the upper the blue
  // sky: without this a wall's foot and its top were the same flat grey.
  ambient *= mix(vec3(1.08, 0.97, 0.84), vec3(0.98, 1.0, 1.02), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 moon = uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));
  // Sunlit paving and plaster throw a lot of light into a narrow street:
  // onto the walls from the paving, and back down onto shaded ground from
  // the pale sunlit walls round it. Without the second term a shaded street
  // or forum got the sky alone and went near black, worst on a phone with
  // no ambient occlusion pass to balance it against.
  // Tinted by the warm plaster and dust it comes off; strongest on
  // down-facing and vertical surfaces, which face the lit street. It
  // scales with the sun, so it goes at night and under the ash by itself.
  // A covered surface (a shop, a portico) is lit mostly this way, through
  // its opening, so it gets more of it.
  // How shut in the point is (the share of its sky the AO pass took) says
  // how much lit wall surrounds it: a street floor between two sunlit
  // walls gets far more than an open plaza or a roof. With no AO pass (a
  // phone) this is 0 and the base terms are what is left.
  vec3 skyOpen = shIrradiance(n);
  float enclosed = 1.0 - clamp(dot(occSky, vec3(0.3, 0.6, 0.1)) / max(1e-5, dot(skyOpen, vec3(0.3, 0.6, 0.1))), 0.0, 1.0);
  float upB = style > 0.5 && style < 1.5 ? 0.07 : 0.24 + 0.4 * enclosed;
  // The light the sun puts on what throws the bounce: the ground takes
  // sunDir.y of it, but a low sun still lights the walls square on, so at
  // dusk the fill comes off the sunlit side of the street rather than
  // going to nothing with the ground's share. Shaded streets also bounce
  // up to 2x more than the open-ground figure when the sun is low, since
  // the lit wall fills most of what the shaded one sees.
  float sunY = max(0.0, uSunDir.y);
  float bounceSrc = sunY + 1.25 * sqrt(max(0.0, 1.0 - sunY * sunY)) * (1.0 - sunY) * smoothstep(-0.03, 0.06, uSunDir.y);
  vec3 bounce = sunE * bounceSrc * vec3(1.0, 0.87, 0.7) * ((0.26 + 0.2 * enclosed) * (1.0 - n.y) + upB * max(0.0, n.y)) * (1.0 + covered);
  float inside = (1.0 - covered * 0.45) * (1.0 - 0.9 * shut) * ao;
  sunVis *= sunShade;
  vec3 lit = albedo * ((sunE * ndl * sunVis) * (1.0 - covered * 0.85) + (ambient + bounce) * inside + moon * (1.0 - shut) * ao);
  // Lamps and hearths inside at night. Stand-ins for the oil lamps, which
  // replace them while render/pompeiilamps.ts runs (uLampNight 1).
  lit += albedo * uNightGlow * uNight * 0.3 * (1.0 - uLampNight);
  if (covered > 0.5) lit += albedo * vec3(1.0, 0.6, 0.3) * 0.6 * uNight * (1.0 - uLampNight);
  vec3 hh = normalize(uSunDir + v);
  lit += sunE * pow(max(0.0, dot(n, hh)), mix(8.0, 60.0, gloss)) * gloss * 0.25 * ndl * sunVis;
  lit += albedo * (eruptionLamps(vWorld, n) + townLamps(vWorld, n));
  if (style > 16.5 && style < 21.5) lit += townLampSpec(vWorld, n, v);
  if (style > 16.5 && style < 17.5) {
    // A metal's highlight and reflection take its own colour.
    lit += albedo * (sunE * pow(max(0.0, dot(n, hh)), 40.0) * 2.5 * ndl * sunVis + occludedSkyIrradiance(reflect(-v, n)) * 0.6) * gloss;
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

/** The art atlas: the texture, each tile's rectangle (u0, v0, w, h) and (aspect, ground rgb). */
export interface ArtUniforms {
  uArt: { value: THREE.Texture };
  uArtRect: { value: THREE.Vector4[] };
  uArtInfo: { value: THREE.Vector4[] };
  uArtReady: { value: number };
}
export type PompeiiUniforms = StreetLampUniforms & ArtUniforms & EruptionSurfaceUniforms & TownLampUniforms & {
  /** Seconds, for the ripples on the atrium pools (render/pompeiiwater.ts advances it). */
  uWaterTime: { value: number };
  /** The escape room's box, where the town is not drawn (see FRAG). */
  uRoomCutA: { value: THREE.Vector4 };
  uRoomCutB: { value: THREE.Vector4 };
};

function makeArtUniforms(): ArtUniforms {
  const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  blank.needsUpdate = true;
  return {
    uArt: { value: blank },
    uArtRect: { value: ART_WORKS.map(() => new THREE.Vector4(0, 0, 1, 1)) },
    // Until the atlas arrives each tile shows its ground colour (uArtReady 0).
    uArtInfo: { value: ART_WORKS.map((w) => new THREE.Vector4(w.sizeM[0] / w.sizeM[1], ...w.ground)) },
    uArtReady: { value: 0 },
  };
}

/**
 * Load the restored atlas (tools/bake-pompeii-art.ts) into the uniforms: the
 * 1024 px copy on a phone. A failed load leaves the ground colours.
 */
export async function loadPompeiiArt(base: string, u: ArtUniforms, small: boolean): Promise<boolean> {
  try {
    const desc = (await (await fetch(`${base}/pompeii-art/atlas.json`)).json()) as ArtAtlas;
    const img = new Image();
    img.src = `${base}/pompeii-art/${small ? "atlas-small.jpg" : "atlas.jpg"}`;
    await img.decode();
    const tex = new THREE.Texture(img);
    tex.flipY = false;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const S = desc.size;
    ART_WORKS.forEach((w, i) => {
      const t = desc.tiles.find((x) => x.id === w.id);
      if (!t) return;
      const [x, y, tw, th] = t.rect;
      // Half a texel in from each edge so bilinear filtering stays on the tile.
      u.uArtRect.value[i].set((x + 0.5) / S, (y + 0.5) / S, (tw - 1) / S, (th - 1) / S);
      u.uArtInfo.value[i].set(tw / th, ...t.ground);
    });
    u.uArt.value = tex;
    u.uArtReady.value = 1;
    return true;
  } catch (err) {
    console.warn("[flyby] pompeii art atlas failed to load:", err);
    return false;
  }
}

// The detailed columns: one instanced template per order, drawn only near
// the camera over the plain prisms the town mesh keeps for the far view.
const COLUMN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aNormal;
in vec4 aColour;
in vec4 aSurf;
in vec4 aWall;
in vec4 iPos;
in float iRed;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
out vec3 vNormal;
out vec3 vWorld;
out vec4 vColour;
out vec4 vSurf;
out vec4 vWall;
out float vViewDist;
void main() {
  vec4 w = modelMatrix * vec4(iPos.xyz + position * iPos.w, 1.0);
  vNormal = mat3(modelMatrix) * aNormal.xyz;
  vWorld = w.xyz;
  vColour = aColour;
  vSurf = aSurf + vec4(0.0, 0.0, iRed * 2.0, 0.0);
  vWall = vec4(aWall.x, aWall.y * iPos.w, aWall.z, aWall.w * iPos.w);
  vViewDist = distance(w.xyz, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * Two levels of detail past the plain prism: the full template (fine
 * volutes and leaves) within `nearM`, the lean one out to `farM`, each
 * capped; a phone gets the lean level only.
 */
export interface ColumnLod { nearM: number; nearCap: number; farM: number; farCap: number }
export const COLUMN_LOD = {
  desktop: { nearM: 45, nearCap: 120, farM: 130, farCap: 360 } as ColumnLod,
  phone: { nearM: 0, nearCap: 0, farM: 60, farCap: 80 } as ColumnLod,
};

class DetailColumns {
  readonly group = new THREE.Group();
  private readonly geos: THREE.InstancedBufferGeometry[] = [];
  private readonly pos: THREE.InstancedBufferAttribute[] = [];
  private readonly red: THREE.InstancedBufferAttribute[] = [];
  private lastX = Infinity;
  private lastZ = Infinity;
  /** Instances drawn last update: full Doric, Ionic, Corinthian, then lean. */
  readonly drawn = [0, 0, 0, 0, 0, 0];

  constructor(private readonly cols: ColumnInstance[], uniforms: PompeiiUniforms, private readonly lod: ColumnLod) {
    const mat = new THREE.RawShaderMaterial({ vertexShader: COLUMN_VERT, fragmentShader: FRAG, uniforms, glslVersion: THREE.GLSL3 });
    for (const lean of [false, true]) for (const order of [Order.Doric, Order.Ionic, Order.Corinthian]) {
      const cap = lean ? lod.farCap : Math.max(1, lod.nearCap);
      const st = new Store();
      columnTemplate(st, order, lean);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(st.pos.slice(0, st.n * 3), 3));
      g.setAttribute("aNormal", new THREE.BufferAttribute(st.nrm.slice(0, st.n * 4), 4, true));
      g.setAttribute("aColour", new THREE.BufferAttribute(st.col.slice(0, st.n * 4), 4, true));
      g.setAttribute("aSurf", new THREE.BufferAttribute(st.surf.slice(0, st.n * 4), 4, false));
      g.setAttribute("aWall", new THREE.BufferAttribute(st.wall.slice(0, st.n * 4), 4));
      g.setIndex(new THREE.BufferAttribute(st.idx.slice(0, st.ni), 1));
      const p = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      const r = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      p.setUsage(THREE.DynamicDrawUsage); r.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("iPos", p);
      g.setAttribute("iRed", r);
      g.instanceCount = 0;
      const m = new THREE.Mesh(g, mat);
      // Instances are placed round the camera every update; the template's
      // own bounds would cull them wrongly.
      m.frustumCulled = false;
      m.name = `pompeii-columns-${lean ? "lean" : "full"}-${order}`;
      this.geos.push(g); this.pos.push(p); this.red.push(r);
      this.group.add(m);
    }
  }

  /** Re-pick the near columns when the camera has moved 6 m; camera in the town's own frame. */
  update(x: number, z: number): void {
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 6) return;
    this.lastX = x; this.lastZ = z;
    const { nearM, nearCap, farM, farCap } = this.lod;
    const near: { c: ColumnInstance; d: number }[] = [];
    for (const c of this.cols) {
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < farM * farM) near.push({ c, d });
    }
    near.sort((a, b) => a.d - b.d);
    const n = [0, 0, 0, 0, 0, 0];
    let full = 0, lean = 0;
    for (const { c, d } of near) {
      // Full detail for the nearest, the lean template behind them.
      let slot: number;
      if (d < nearM * nearM && full < nearCap) { slot = c.order; full++; }
      else if (lean < farCap) { slot = 3 + c.order; lean++; }
      else break;
      const k = n[slot]++;
      this.pos[slot].array.set([c.x, c.y0, c.z, c.d], k * 4);
      (this.red[slot].array as Float32Array)[k] = c.red ? 1 : 0;
    }
    for (let s = 0; s < 6; s++) {
      this.geos[s].instanceCount = n[s];
      this.pos[s].needsUpdate = true;
      this.red[s].needsUpdate = true;
      this.drawn[s] = n[s];
    }
  }
}

/** The town's fragment shader, for the lamp fittings drawn with their own instanced vertex stage. */
export const POMPEII_FRAG = FRAG;

function geometry(m: PompeiiMeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
  g.setAttribute("aNormal", new THREE.BufferAttribute(m.normal, 4, true));
  g.setAttribute("aColour", new THREE.BufferAttribute(m.colour, 4, true));
  g.setAttribute("aSurf", new THREE.BufferAttribute(m.surf, 4, false));
  g.setAttribute("aWall", new THREE.BufferAttribute(m.wall, 4));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeBoundingSphere();
  return g;
}

export function pompeiiMaterial(uniforms: PompeiiUniforms, opts: { bias?: number; doubleSided?: boolean; roofs?: boolean } = {}): THREE.RawShaderMaterial {
  const bias = opts.bias ?? 0;
  const defines: Record<string, number> = {};
  if (bias !== 0) defines.ASH_RISE = 1;
  // Only the town mesh tags its roofs (surf.w); the cart and the rest leave it 0.
  if (opts.roofs) defines.ROOF_COLLAPSE = 1;
  return new THREE.RawShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    // The biased meshes are the ground and the streets: the ones the pumice buries.
    defines,
    glslVersion: THREE.GLSL3,
    side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    // The ground inside the walls lies on the terrain: a bias wins it the
    // depth test without lifting it far enough to see a gap from the street.
    // Units only, no slope factor: at a grazing street-level angle a slope
    // term grew large enough to pull the floor through the forum's paving
    // half a metre above it.
    polygonOffset: bias !== 0,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -bias,
  });
}

export interface PompeiiStats {
  triangles: number;
  floorTriangles: number;
  gpuBytes: number;
  buildMs: number;
}

export class Pompeii {
  readonly group = new THREE.Group();
  readonly buildings = new THREE.Group();
  readonly uniforms: PompeiiUniforms;
  readonly model: PompeiiModel;
  readonly stats: PompeiiStats;
  private readonly columns: DetailColumns;
  private readonly offX: number;
  private readonly offZ: number;

  constructor(opts: { data: PompeiiData; heightAt: (x: number, z: number) => number; shadow: SunShadowUniforms; lean: boolean; offsetX: number; offsetZ: number; art?: boolean }) {
    const t0 = performance.now();
    this.group.name = "pompeii";
    const { data } = opts;
    this.offX = opts.offsetX; this.offZ = opts.offsetZ;
    // The pack's own origin is the City's, so the offset is zero in practice;
    // it is applied rather than assumed so a moved City entry cannot shift the
    // town off its streets silently.
    this.model = buildPompeii({ data, groundAt: (x, z) => opts.heightAt(x + opts.offsetX, z + opts.offsetZ), lean: opts.lean, art: opts.art !== false });
    this.uniforms = Object.assign(makeStreetLampUniforms(opts.shadow), makeArtUniforms(), { ...eruptionSurfaceUniforms, ...townLampUniforms, uWaterTime: { value: 0 }, uRoomCutA: { value: new THREE.Vector4() }, uRoomCutB: { value: new THREE.Vector4() } });
    // A column 0.8 m across is a few pixels wide past 130 m: the prism does there.
    this.columns = new DetailColumns(this.model.orders, this.uniforms, opts.lean ? COLUMN_LOD.phone : COLUMN_LOD.desktop);
    this.columns.group.position.set(opts.offsetX, 0, opts.offsetZ);
    this.group.add(this.columns.group);
    const town = new THREE.Mesh(geometry(this.model.mesh), pompeiiMaterial(this.uniforms, { roofs: true }));
    town.name = "pompeii-town";
    town.layers.enable(SHADOW_CASTER_LAYER);
    const floor = new THREE.Mesh(geometry(this.model.floor), pompeiiMaterial(this.uniforms, { bias: 4 }));
    floor.name = "pompeii-ground";
    floor.renderOrder = 5;
    const streets = new THREE.Mesh(geometry(this.model.streets), pompeiiMaterial(this.uniforms, { bias: 8 }));
    streets.name = "pompeii-streets";
    streets.renderOrder = 6;
    for (const m of [town, floor, streets]) m.position.set(opts.offsetX, 0, opts.offsetZ);
    this.buildings.add(town);
    this.group.add(this.buildings, floor, streets);
    const bytes = (m: PompeiiMeshData): number => m.position.byteLength + m.normal.byteLength + m.colour.byteLength + m.surf.byteLength + m.wall.byteLength + m.index.byteLength;
    this.stats = {
      triangles: this.model.mesh.triangles,
      floorTriangles: this.model.floor.triangles + this.model.streets.triangles,
      gpuBytes: bytes(this.model.mesh) + bytes(this.model.floor) + bytes(this.model.streets),
      buildMs: performance.now() - t0,
    };
  }

  /** Per frame: the near columns. Cheap unless the camera has moved 6 m. */
  update(camera: THREE.Vector3): void {
    this.columns.update(camera.x - this.offX, camera.z - this.offZ);
  }

  /** Detailed column instances drawn: full Doric, Ionic, Corinthian, then lean. */
  get columnsDrawn(): readonly number[] {
    return this.columns.drawn;
  }
}

/** The town's footprints as a CityPack: collision and the rooftop floor only. */
export function pompeiiCityPack(model: PompeiiModel, heightAt: (x: number, z: number) => number, lat0: number, lon0: number): CityPack {
  const buildings: Building[] = [];
  for (const s of model.solids) {
    const ring = new Float32Array(s.ring);
    let cx = 0, cz = 0, low = Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      cx += ring[i]; cz += ring[i + 1];
      low = Math.min(low, heightAt(ring[i], ring[i + 1]));
    }
    cx /= ring.length / 2; cz /= ring.length / 2;
    buildings.push({
      cx, cz, baseM: 0, topM: Math.max(2, s.topY - low), kind: BuildingKind.Residential, roof: RoofShape.Pitched, ring,
    });
  }
  return { lat0, lon0, radiusM: 1500, buildings };
}

/** An ancient town's pack (data/towns.ts names it): Pompeii's unless told otherwise. */
export async function loadPompeii(base: string, pack = "pompeii.json"): Promise<PompeiiData | null> {
  try {
    const r = await fetch(`${base}/${pack}`);
    if (!r.ok) return null;
    const { parsePompeii } = await import("../data/pompeii");
    return parsePompeii(await r.text());
  } catch (err) {
    console.warn("[flyby] pompeii pack failed to load:", err);
    return null;
  }
}

// =====================================================================================
// The landscape of 79 AD.
// =====================================================================================

/**
 * Where the pre-79 summit stood: over the Valle del Gigante, between today's
 * Somma rim and the Gran Cono that grew inside the 79 AD caldera. One of
 * several reconstructions puts the old volcano at around 1,700-1,900 m with a flat,
 * barren top (Strabo describes one); this is that, not a survey.
 */
export const VESUVIUS = { lat: 40.8245, lon: 14.4290, summitM: 1850, flatTopM: 1680, radiusM: 7200, power: 1.6 };

/** The restored cone's height at a point; the DEM wins wherever it is higher. */
export function vesuviusCone(lat: number, lon: number): number {
  const dy = (lat - VESUVIUS.lat) * metresPerDegLat(VESUVIUS.lat);
  const dx = (lon - VESUVIUS.lon) * metresPerDegLon(VESUVIUS.lat);
  const r = Math.hypot(dx, dy);
  if (r >= VESUVIUS.radiusM) return -Infinity;
  // Radial gullies cut into the flanks, deepening downhill, so the restored
  // cone reads as an eroded volcano rather than a lathe-turned one.
  const th = Math.atan2(dy, dx);
  const f = r / VESUVIUS.radiusM;
  const gully = 0.5 + 0.5 * Math.sin(th * 23 + 2.1 * Math.sin(th * 5 + f * 6) + f * 9);
  const fine = 0.5 + 0.5 * Math.sin(th * 61 + 3.0 * Math.sin(th * 13 + f * 11));
  const cone = VESUVIUS.summitM * Math.pow(1 - f, VESUVIUS.power) * (1 - (0.11 * gully + 0.05 * fine) * Math.min(1, f * 3));
  return Math.min(VESUVIUS.flatTopM, cone);
}

/** Edit the DEM fields in place: max(DEM, cone). Returns cells raised. */
export function restoreVesuvius(fields: Heightfield[]): number {
  let raised = 0;
  for (const f of fields) {
    const { west, east, south, north } = f.bbox;
    for (let j = 0; j < f.h; j++) {
      const lat = north - ((north - south) * j) / (f.h - 1);
      for (let i = 0; i < f.w; i++) {
        const lon = west + ((east - west) * i) / (f.w - 1);
        const c = vesuviusCone(lat, lon);
        const k = j * f.w + i;
        if (c > f.data[k]) {
          // A smooth max, so the old flanks run into the cone without a crease.
          const d = c - f.data[k];
          f.data[k] = f.data[k] + d * Math.min(1, d / 60);
          raised++;
        }
      }
    }
  }
  return raised;
}

/**
 * The amphitheatre's bowl in the terrain: its arena lay about 6 m below the
 * ground round it, the lower cavea cut into the earth. The 30 m DEM cannot
 * hold a hole 35 m across, so, as Alcatraz does with its lidar, a field goes
 * at the head of the terrain's list that answers inside the building's
 * ellipse and defers to the DEM everywhere else. The ground falls from the
 * outer wall to the arena floor over the outer 12 m, under the upper tiers,
 * so the street outside keeps its level and the ring meshes' 6-12 m
 * triangles cannot lift earth through the seats.
 */
export class AmphitheatreField extends Heightfield {
  private readonly base: (lat: number, lon: number) => number;
  private readonly mLat: number;
  private readonly mLon: number;
  readonly floorY: number;

  constructor(private readonly town: PompeiiData, fields: Heightfield[]) {
    const data = town;
    const a = data.amphitheatre!;
    const mLat = metresPerDegLat(data.lat0), mLon = metresPerDegLon(data.lat0);
    const R = AMPHI.a + 2;
    super({ west: data.lon0 + (a.cx - R) / mLon, east: data.lon0 + (a.cx + R) / mLon, south: data.lat0 - (a.cz + R) / mLat, north: data.lat0 - (a.cz - R) / mLat }, 1, 1);
    this.loaded = true;
    this.mLat = mLat;
    this.mLon = mLon;
    this.base = (lat, lon) => {
      for (const f of fields) if (f.contains(lat, lon)) return f.sample(lat, lon);
      return fields[fields.length - 1]?.sample(lat, lon) ?? 0;
    };
    // The same rim buildPompeii measures: the ground just outside the wall.
    let rim = 0;
    for (let k = 0; k < 16; k++) {
      const t = (k / 16) * Math.PI * 2;
      const [x, z] = this.ellipse(AMPHI.a + 6, AMPHI.b + 6, t);
      rim += this.base(data.lat0 - z / mLat, data.lon0 + x / mLon) / 16;
    }
    this.floorY = rim - AMPHI.dig - 0.4;
  }

  private ellipse(ka: number, kb: number, t: number): [number, number] {
    const a = this.town.amphitheatre!, c = Math.cos(a.rot), s = Math.sin(a.rot);
    const u = Math.cos(t) * ka, v = Math.sin(t) * kb;
    return [a.cx + c * u - s * v, a.cz + s * u + c * v];
  }

  /** 0 outside the wall, 1 over the bowl. */
  depth(x: number, z: number): number {
    const a = this.town.amphitheatre!, c = Math.cos(a.rot), s = Math.sin(a.rot);
    const dx = x - a.cx, dz = z - a.cz;
    const rho = Math.hypot((dx * c + dz * s) / AMPHI.a, (-dx * s + dz * c) / AMPHI.b);
    const inner = (AMPHI.a - 12) / AMPHI.a;
    return rho >= 1 ? 0 : rho <= inner ? 1 : (1 - rho) / (1 - inner);
  }

  override sample(lat: number, lon: number): number {
    const g = this.base(lat, lon);
    const x = (lon - this.town.lon0) * this.mLon, z = (this.town.lat0 - lat) * this.mLat;
    const t = this.depth(x, z);
    return t > 0 ? g + (Math.min(g, this.floorY) - g) * t : g;
  }

  override contains(lat: number, lon: number): boolean {
    const { west, east, south, north } = this.bbox;
    return lat >= south && lat <= north && lon >= west && lon <= east;
  }
}

/**
 * The terrain's field list with the town's own ground at its head: Pompeii's
 * amphitheatre bowl, or Herculaneum's 79 AD shore, terrace and town.
 */
export function pompeiiRingFields(fields: Heightfield[], data: PompeiiData): Heightfield[] {
  if (data.herc) return [new HerculaneumField(data.herc, data.suburbs?.river ?? null, data.lat0, data.lon0, fields), ...fields];
  if (!data.amphitheatre) return fields;
  return [new AmphitheatreField(data, fields), ...fields];
}

/**
 * Repaint the drapes: everything within ~14 km of the town that is not water
 * becomes farmland, the volcano's slopes woodland and vineyard, its summit
 * bare. The original pixel's lightness is kept as a faint texture, clamped so
 * a white modern roof cannot show through as a speck.
 */
export function antiquateDrape(drapes: StitchedImage[], heightAt: (lat: number, lon: number) => number, wall: { ring: number[]; origin: Origin; suburbs?: PompeiiSuburbs; land?: LandGrid }): void {
  const R0 = 12000, R1 = 15000;
  const land = wall.land ?? (wall.suburbs ? new LandGrid(wall.suburbs, wall.ring) : null);
  const lat0 = wall.origin.lat, lon0 = wall.origin.lon;
  const mLat = metresPerDegLat(lat0), mLon = metresPerDegLon(lat0);
  // Fields on the centuriation grid: about 20 actus (710 m) squares, each cut
  // into strips, at the grid's tilt.
  const tilt = (-24 * Math.PI) / 180;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const crops: [number, number, number][] = [
    [96, 112, 52], // vineyard
    [176, 150, 96], // wheat stubble, late August
    [118, 118, 74], // olive grove
    [146, 136, 82], // dry pasture
    [86, 104, 50], // orchard
    [160, 132, 88], // ploughed
  ];
  for (const d of drapes) {
    const ctx = d.canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) continue;
    const W = d.canvas.width, H = d.canvas.height;
    const b = d.bbox;
    // Only the pixel rows and columns that can be inside R1.
    const dLat = R1 / mLat, dLon = R1 / mLon;
    const i0 = Math.max(0, Math.floor(((lon0 - dLon - b.west) / (b.east - b.west)) * W));
    const i1 = Math.min(W, Math.ceil(((lon0 + dLon - b.west) / (b.east - b.west)) * W));
    const j0 = Math.max(0, Math.floor(((b.north - (lat0 + dLat)) / (b.north - b.south)) * H));
    const j1 = Math.min(H, Math.ceil(((b.north - (lat0 - dLat)) / (b.north - b.south)) * H));
    if (i1 <= i0 || j1 <= j0) continue;
    const img = ctx.getImageData(i0, j0, i1 - i0, j1 - j0);
    const px = img.data;
    const w = i1 - i0;
    for (let j = j0; j < j1; j++) {
      const lat = b.north - ((j + 0.5) / H) * (b.north - b.south);
      const y = (lat - lat0) * mLat;
      for (let i = i0; i < i1; i++) {
        const lon = b.west + ((i + 0.5) / W) * (b.east - b.west);
        const x = (lon - lon0) * mLon;
        const r = Math.hypot(x, y);
        if (r > R1) continue;
        const o = ((j - j0) * w + (i - i0)) * 4;
        const R = px[o], G = px[o + 1], B = px[o + 2];
        const lum = (R + G + B) / 3;
        // Water stays: the sea and the Sarno. Blue and not dark, so the
        // bluish shadow under a modern tree is not taken for a pond.
        const blue = B > R + 15 && B > G && lum > 45 && lum < 170;
        const elev = heightAt(lat, lon);
        let c: [number, number, number];
        // The centuriation grid: 710 m squares, each in strips, each strip in
        // parcels, each parcel its own crop (cropAt, shared with the trees).
        let { kind, tone, lu, lv, sw, pl, fu, strip } = cropAt(x, y);
        // The gradient out from the walls (data/pompeiisuburbs.ts): with the
        // suburbs known, today's water is kept only inside the 79 AD sea, and
        // the band between it and today's coast, and the modern Sarno's
        // channel, are land again.
        const lc = land ? land.at(x, -y, kind) : blue ? Land.Sea : Land.Fields;
        if (lc === Land.Sea && blue) continue;
        if (lc === Land.Vineyard) kind = 0;
        else if (lc === Land.Olive) kind = kind === 4 ? 4 : 2;
        c = [crops[kind][0] * tone, crops[kind][1] * tone, crops[kind][2] * tone];
        if (kind === 0 || kind === 4 || kind === 2) {
          // Rows in vineyards, orchards and olive groves.
          const gu = x * ct - y * st;
          const row = ((gu * (kind === 0 ? 0.45 : 0.16)) % 1 + 1) % 1;
          if (row < 0.4) c = [c[0] * 0.75, c[1] * 0.8, c[2] * 0.7];
        }
        // Field margins: a darker hedge or a track.
        if (lu < 5 || (lv % sw) < 3 || ((lu % pl) < 2.5)) c = hash2(fu, strip) > 0.5 ? [72, 88, 46] : [150, 132, 100];
        if (lc !== Land.Fields && lc !== Land.Vineyard && lc !== Land.Olive) c = suburbColour(lc, x, y, c);
        // The volcano: vines on the lower slopes, oak and chestnut woods
        // above, the bare ash-grey summit Strabo describes.
        if (elev > 250) c = mixC(c, [92, 112, 54], Math.min(1, (elev - 250) / 200));
        if (elev > 650) c = mixC(c, [74, 98, 50], Math.min(1, (elev - 650) / 250));
        if (elev > 1350) c = mixC(c, [136, 124, 106], Math.min(1, (elev - 1350) / 300));
        const detail = Math.max(-0.1, Math.min(0.1, (lum - 110) / 500));
        const k = 1 + detail;
        const fade = r < R0 ? 1 : 1 - (r - R0) / (R1 - R0);
        px[o] = R + (c[0] * k - R) * fade;
        px[o + 1] = G + (c[1] * k - G) * fade;
        px[o + 2] = B + (c[2] * k - B) * fade;
      }
    }
    ctx.putImageData(img, i0, j0);
  }
}

/**
 * The ground colour of the land between the walls and the fields (x east, y
 * north): tomb verges, garden plots, market-garden strips, beach, dunes, the
 * river and its banks. `under` is the parcel colour, for the plots to vary from.
 */
function suburbColour(lc: Land, x: number, y: number, under: [number, number, number]): [number, number, number] {
  const n = hash2(Math.floor(x / 3), Math.floor(y / 3));
  switch (lc) {
    case Land.Town: return under;
    case Land.Road: return [168, 150, 116];
    case Land.Tombs: return mixC([178, 166, 130], [132, 136, 88], hash2(Math.floor(x / 7), Math.floor(y / 7)) * 0.5 + n * 0.15);
    case Land.Suburb: {
      // House gardens and yards: plots of 12-20 m behind low walls.
      // Each row of plots shifted along by its own hash, so the walls do not line up into a lattice.
      const py = Math.floor(y / 13), sx = x + 16 * hash2(py, 71);
      const px = Math.floor(sx / 16);
      const h = hash2(px * 3 + 1, py * 5 - 2);
      const edge = (((sx % 16) + 16) % 16) < 0.9 || (((y % 13) + 13) % 13) < 0.9;
      if (edge) return [148, 136, 104];
      return h < 0.45 ? mixC([86, 108, 54], [110, 124, 66], n) : h < 0.75 ? [150, 128, 92] : [124, 122, 78];
    }
    case Land.Garden: {
      // Horti: long narrow beds of greens, onions, cabbage and beans, earth between, a channel every few beds.
      // Plots of 30-50 m, each with its beds running one way or the other,
      // so the whole does not read as one grid.
      const tilt = (-24 * Math.PI) / 180;
      const gu = x * Math.cos(tilt) - y * Math.sin(tilt), gv = x * Math.sin(tilt) + y * Math.cos(tilt);
      const pv = Math.floor(gv / 52), su = gu + 38 * hash2(pv, 5);
      const pu = Math.floor(su / 38);
      const plot = hash2(pu * 11 + 3, pv * 17 - 5);
      const bw = 4 + 5 * hash2(pu, pv * 3);
      const a = plot < 0.5 ? gu : gv;
      const bed = Math.floor(a / bw);
      const h = hash2(bed * 7 + pu, pv * 13 - bed);
      const tone = 0.9 + 0.2 * hash2(pu + 1, pv);
      let c: [number, number, number] = plot < 0.1 ? [128, 116, 82] : h < 0.75 ? mixC([86, 106, 54], [108, 120, 62], h / 0.75) : h < 0.9 ? [118, 110, 76] : [108, 112, 64];
      if (((a % bw) + bw) % bw < 0.7) c = [128, 112, 82];
      if (((su % 38) + 38) % 38 < 1 || ((gv % 52) + 52) % 52 < 1) c = [104, 110, 66];
      return [c[0] * tone, c[1] * tone, c[2] * tone];
    }
    case Land.Beach: return mixC([222, 208, 172], [176, 164, 132], n * 0.3);
    case Land.Dunes: return mixC([200, 188, 146], [128, 138, 88], hash2(Math.floor(x / 5), Math.floor(y / 5)) > 0.6 ? 0.7 : 0.1);
    case Land.Sea: return [92, 112, 112];
    case Land.River: return [52, 70, 68];
    case Land.Banks: return mixC([84, 108, 60], [120, 128, 76], n);
    default: return under;
  }
}

/** Crop index at a point, metres east (x) and north (y) of the town: the same parcels the drape paints. */
function cropAt(x: number, y: number): { kind: number; tone: number; lu: number; lv: number; sw: number; pl: number; fu: number; strip: number } {
  const tilt = (-24 * Math.PI) / 180;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const gu = x * ct - y * st, gv = x * st + y * ct;
  const fu = Math.floor(gu / 710), fv = Math.floor(gv / 710);
  const sw = 90 + 80 * hash2(fu, fv);
  const lv = gv - fv * 710, lu = gu - fu * 710;
  const strip = Math.floor(lv / sw);
  const pl = 140 + 160 * hash2(fu + strip, fv);
  const parcel = Math.floor(lu / pl);
  const ph = hash2(fu * 7 + strip * 13 + parcel, fv * 3 - strip + parcel * 5);
  return { kind: Math.floor(ph * 6), tone: 0.86 + 0.24 * hash2(parcel + 3, strip * 7 + fu), lu, lv, sw, pl, fu, strip };
}

/**
 * Tree cover for the town and its farmland, packed as the landcover mask the
 * tree renderer reads (B = tree; see data/landmask.ts). Olive groves and
 * orchards in the fields, the plane trees of the Palestra Grande, and a light
 * cover over the insulae so the gardens and peristyles get a few trees (the
 * renderer keeps them off the roofs by footprint).
 */
export function pompeiiVegetation(
  data: PompeiiData,
  extentM = 6000,
  cellM = 20,
  // The field pattern is drawn over everything outside the walls, the Bay of
  // Naples included, so without this the olive groves run out to sea.
  dry: (x: number, z: number) => boolean = () => true,
  // With the suburbs: trees by the land-use gradient (cypress by the tombs,
  // fruit trees in the gardens, willows on the Sarno, pines on the dunes).
  suburbs?: PompeiiSuburbs,
): { rgba: Uint8Array; n: number; extentM: number } {
  const land = suburbs ? new LandGrid(suburbs, data.wall) : null;
  const n = Math.ceil((extentM * 2) / cellM);
  const rgba = new Uint8Array(n * n * 4);
  const palestra = data.publics.find((p) => p.kind === "palestra")?.ring ?? null;
  let wx0 = Infinity, wx1 = -Infinity, wz0 = Infinity, wz1 = -Infinity;
  for (let i = 0; i < data.wall.length; i += 2) {
    wx0 = Math.min(wx0, data.wall[i]); wx1 = Math.max(wx1, data.wall[i]);
    wz0 = Math.min(wz0, data.wall[i + 1]); wz1 = Math.max(wz1, data.wall[i + 1]);
  }
  const nearWallBox = (x: number, z: number, pad: number): boolean => x > wx0 - pad && x < wx1 + pad && z > wz0 - pad && z < wz1 + pad;
  for (let r = 0; r < n; r++) {
    const z = -extentM + (r + 0.5) * cellM;
    for (let c = 0; c < n; c++) {
      const x = -extentM + (c + 0.5) * cellM;
      const o = (r * n + c) * 4;
      let tree = 0;
      if (!dry(x, z)) tree = 0;
      else if (nearWallBox(x, z, 0) && pointInRing(data.wall, x, z)) {
        if (palestra && pointInRing(palestra, x, z)) tree = 0.75;
        else if (data.insulae.some((i) => pointInRing(i.ring, x, z))) tree = 0.22;
      } else {
        const crop = cropAt(x, -z);
        const lc = land ? land.at(x, z, crop.kind) : Land.Fields;
        // Olive groves (2) and orchards (4) are trees; the hedges between
        // fields carry a few.
        if (crop.kind === 2) tree = 0.55;
        else if (crop.kind === 4) tree = 0.7;
        else if (crop.lu < 8 || crop.lv % crop.sw < 6) tree = 0.35;
        // A clear ring round the walls: the tombs and gardens along the roads
        // out of the gates, not woodland.
        if (nearWallBox(x, z, 60) && distToWall(data.wall, x, z) < 60) tree *= 0.3;
        if (lc !== Land.Fields) tree = LAND_TREES[lc] ?? tree;
      }
      rgba[o + 2] = Math.round(tree * 255);
      rgba[o + 3] = Math.round((1 - tree) * 200);
    }
  }
  return { rgba, n, extentM };
}

/** Tree cover by land use outside the open fields, indexed by Land. */
const LAND_TREES: Record<number, number> = {
  [Land.Tombs]: 0.03, [Land.Suburb]: 0.07, [Land.Garden]: 0.09, [Land.Vineyard]: 0.04, [Land.Olive]: 0.55,
  [Land.Sea]: 0, [Land.Beach]: 0, [Land.Dunes]: 0.12, [Land.River]: 0, [Land.Banks]: 0.4, [Land.Road]: 0, [Land.Town]: 0,
};

function distToWall(r: number[], x: number, z: number): number {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = r[i * 2], az = r[i * 2 + 1], bx = r[((i + 1) % n) * 2], bz = r[((i + 1) % n) * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}
const mixC = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// =====================================================================================
// The cart.
// =====================================================================================

/** Cart speeds, metres per second: a horse's walk, and a trot with boost. */
export const CART_TOP_SPEED = 4;
export const CART_BOOST_SPEED = 6;
/** Driver's eye on the cart's bench. */
export const CART_EYE_HEIGHT_M = 2.05;

function partGeo(g: THREE.BufferGeometry, rgb: [number, number, number], style: number, p1 = 0): THREE.BufferGeometry {
  // The primitives carry smooth normals (lathes, tori, tubes): kept, not
  // recomputed per face, or a wheel or an amphora shades as facets.
  const ng = g.index ? g.toNonIndexed() : g;
  if (!ng.getAttribute("normal")) ng.computeVertexNormals();
  const n = ng.getAttribute("position").count;
  const nrm = ng.getAttribute("normal").array as Float32Array;
  const an = new Int8Array(n * 4), ac = new Uint8Array(n * 4), as = new Uint8Array(n * 4), aw = new Float32Array(n * 4);
  const pos = ng.getAttribute("position").array as Float32Array;
  for (let i = 0; i < n; i++) {
    an[i * 4] = Math.round(nrm[i * 3] * 127); an[i * 4 + 1] = Math.round(nrm[i * 3 + 1] * 127); an[i * 4 + 2] = Math.round(nrm[i * 3 + 2] * 127);
    ac[i * 4] = rgb[0] * 255; ac[i * 4 + 1] = rgb[1] * 255; ac[i * 4 + 2] = rgb[2] * 255; ac[i * 4 + 3] = 128;
    as[i * 4] = style; as[i * 4 + 1] = p1;
    aw[i * 4] = pos[i * 3] + pos[i * 3 + 2]; aw[i * 4 + 1] = pos[i * 3 + 1];
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", ng.getAttribute("position"));
  out.setAttribute("aNormal", new THREE.BufferAttribute(an, 4, true));
  out.setAttribute("aColour", new THREE.BufferAttribute(ac, 4, true));
  out.setAttribute("aSurf", new THREE.BufferAttribute(as, 4, false));
  out.setAttribute("aWall", new THREE.BufferAttribute(aw, 4));
  return out;
}

// The town's vertex shader with a horse's skinning: two bones a vertex,
// blended across each joint, posed by render/horse.ts on the CPU.
const HORSE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aNormal;
in vec4 aColour;
in vec4 aSurf;
in vec4 aWall;
in vec4 aSkin;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform mat4 uBones[${HORSE_BONES}];
out vec3 vNormal;
out vec3 vWorld;
out vec4 vColour;
out vec4 vSurf;
out vec4 vWall;
out float vViewDist;
void main() {
  float wb = aSkin.z / 255.0;
  mat4 B = uBones[int(aSkin.x)] * (1.0 - wb) + uBones[int(aSkin.y)] * wb;
  vec4 w = modelMatrix * B * vec4(position, 1.0);
  vNormal = mat3(modelMatrix) * mat3(B) * aNormal.xyz;
  vWorld = w.xyz;
  vColour = aColour;
  vSurf = aSurf;
  vWall = aWall;
  vViewDist = distance(w.xyz, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** A horse mesh from render/horse.ts as a geometry the skinning shader reads. */
function horseGeometry(h: HorseMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(h.position, 3));
  g.setAttribute("aNormal", new THREE.BufferAttribute(h.normal, 4, true));
  g.setAttribute("aColour", new THREE.BufferAttribute(h.colour, 4, true));
  g.setAttribute("aSurf", new THREE.BufferAttribute(h.surf, 4, false));
  g.setAttribute("aWall", new THREE.BufferAttribute(h.wall, 4));
  g.setAttribute("aSkin", new THREE.BufferAttribute(h.skin, 4, false));
  g.setIndex(new THREE.BufferAttribute(h.index, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * A skinned horse: its own uniforms object (the bones) sharing the town's
 * lighting uniforms by reference. `lod` swaps to the lean mesh past 40 m.
 */
export class Horse {
  readonly group = new THREE.Group();
  readonly bones = new Float32Array(HORSE_BONES * 16);
  private readonly full: THREE.Mesh;
  private readonly lean: THREE.Mesh;
  private readonly boneMats: THREE.Matrix4[] = [];
  private readonly world = new THREE.Vector3();

  constructor(uniforms: PompeiiUniforms, opts: { harness?: boolean; lean?: boolean } = {}) {
    for (let i = 0; i < HORSE_BONES; i++) this.boneMats.push(new THREE.Matrix4());
    const mat = new THREE.RawShaderMaterial({
      vertexShader: HORSE_VERT, fragmentShader: FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
      uniforms: { ...uniforms, uBones: { value: this.boneMats } },
    });
    this.full = new THREE.Mesh(horseGeometry(buildHorse(!!opts.lean, !!opts.harness)), mat);
    this.lean = new THREE.Mesh(horseGeometry(buildHorse(true, !!opts.harness)), mat);
    for (const m of [this.full, this.lean]) {
      // Skinned in the shader: the rest-pose bounds would cull a stride's reach wrongly.
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.lean.visible = false;
    this.pose("stand", 0, 0);
    this.group.name = "horse";
  }

  pose(gait: Gait, phase: number, strength: number): void {
    poseHorse(gait, phase, this.bones, strength);
    for (let i = 0; i < HORSE_BONES; i++) this.boneMats[i].fromArray(this.bones, i * 16);
  }

  /** Lean mesh beyond 40 m of the camera. */
  lod(camera: THREE.Vector3): void {
    this.group.getWorldPosition(this.world);
    const far = this.world.distanceTo(camera) > 40;
    this.full.visible = !far;
    this.lean.visible = far;
  }
}

/** Gait for a cart speed: a walk, a trot past 3.2 m/s (the boost), standing still under 0.15. */
export function cartGait(speed: number): { gait: Gait; stride: number; strength: number } {
  const v = Math.abs(speed);
  if (v < 0.15) return { gait: "stand", stride: STRIDE_M.walk, strength: 0 };
  if (v > 3.2) return { gait: "trot", stride: STRIDE_M.trot, strength: 1 };
  return { gait: "walk", stride: STRIDE_M.walk, strength: Math.min(1, v / 0.8) };
}

/**
 * A two-wheeled Roman cart (a carrus) and its horse, +z forward (three.js
 * -z is north, so the group is turned by the heading): two big iron-tyred
 * wheels of ten spokes on a fixed axle, a plank bed with wicker sides,
 * shafts curving up to the loops on the horse's pad.
 */
export class Cart {
  readonly group = new THREE.Group();
  readonly horse: Horse;
  private readonly wheels: THREE.Object3D[] = [];
  private phase = 0;
  private readonly cam = new THREE.Vector3();

  constructor(uniforms: PompeiiUniforms) {
    const mat = pompeiiMaterial(uniforms, { doubleSided: true });
    const wood: [number, number, number] = [0.47, 0.33, 0.2];
    const dark: [number, number, number] = [0.26, 0.18, 0.11];
    const iron: [number, number, number] = [0.14, 0.13, 0.13];
    const wicker: [number, number, number] = [0.6, 0.47, 0.28];
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, rgb: [number, number, number], style: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, p1 = 0): THREE.Mesh => {
      const m = new THREE.Mesh(partGeo(g, rgb, style, p1), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.layers.enable(SHADOW_CASTER_LAYER);
      parent.add(m);
      return m;
    };
    const W = 7; // Surf.Wood
    const R = 0.66; // wheel radius: about 1.3 m wheels, as the reliefs show
    const axleZ = -0.25;
    // The bed: planks on two side rails, over the axle.
    add(this.group, new THREE.BoxGeometry(1.15, 0.07, 1.9), wood, W, 0, R + 0.2, axleZ + 0.1);
    for (const s of [-1, 1]) add(this.group, new THREE.BoxGeometry(0.09, 0.12, 2.0), dark, W, s * 0.6, R + 0.13, axleZ + 0.1);
    // Wicker sides and back, woven between posts, with a top rail.
    for (const s of [-1, 1]) {
      add(this.group, new THREE.BoxGeometry(0.04, 0.42, 1.86), wicker, W, s * 0.57, R + 0.45, axleZ + 0.1, 0, 0, 0, 1);
      add(this.group, new THREE.CylinderGeometry(0.028, 0.028, 1.9, 6), dark, W, s * 0.57, R + 0.68, axleZ + 0.1, Math.PI / 2, 0, 0);
      for (let k = 0; k < 5; k++) add(this.group, new THREE.CylinderGeometry(0.025, 0.025, 0.46, 5), dark, W, s * 0.57, R + 0.45, axleZ - 0.82 + k * 0.46);
    }
    add(this.group, new THREE.BoxGeometry(1.12, 0.42, 0.04), wicker, W, 0, R + 0.45, axleZ - 0.83, 0, 0, 0, 1);
    // A board across the front for the driver's feet and a bench.
    add(this.group, new THREE.BoxGeometry(1.12, 0.3, 0.05), wood, W, 0, R + 0.38, axleZ + 1.03);
    add(this.group, new THREE.BoxGeometry(1.05, 0.07, 0.36), dark, W, 0, R + 0.62, axleZ + 0.72);
    // The load: amphorae standing in straw.
    for (let k = 0; k < 6; k++) {
      const amph = new THREE.LatheGeometry([0, 0.03, 0.15, 0.17, 0.13, 0.06, 0.05, 0.07].map((r, i) => new THREE.Vector2(r, i * 0.1)), 10);
      add(this.group, amph, [0.64, 0.36, 0.22], 13, -0.32 + (k % 3) * 0.32, R + 0.25, axleZ - 0.5 + Math.floor(k / 3) * 0.36, 0.15 * ((k % 2) - 0.5), 0, 0.1 * ((k % 3) - 1));
    }
    // Axle, and the wheels: iron tyre on a wooden felloe, ten spokes, a long nave.
    add(this.group, new THREE.CylinderGeometry(0.06, 0.06, 1.62, 8), dark, W, 0, R, axleZ, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) {
      const wheel = new THREE.Group();
      wheel.position.set(s * 0.74, R, axleZ);
      add(wheel, new THREE.TorusGeometry(R - 0.015, 0.03, 6, 40), iron, W, 0, 0, 0, 0, Math.PI / 2, 0);
      add(wheel, new THREE.TorusGeometry(R - 0.065, 0.045, 6, 32), wood, W, 0, 0, 0, 0, Math.PI / 2, 0);
      for (let k = 0; k < 10; k++) {
        const spoke = new THREE.CylinderGeometry(0.022, 0.032, R - 0.12, 6);
        spoke.translate(0, (R - 0.12) / 2 + 0.06, 0);
        add(wheel, spoke, wood, W, 0, 0, 0, (k / 10) * Math.PI * 2, 0, 0);
      }
      const nave = new THREE.LatheGeometry([0.05, 0.1, 0.12, 0.12, 0.1, 0.06].map((r, i) => new THREE.Vector2(r, -0.16 + i * 0.064)), 12);
      add(wheel, nave, dark, W, 0, 0, 0, 0, 0, Math.PI / 2);
      this.group.add(wheel);
      this.wheels.push(wheel);
    }
    // The horse: its haunches about half a metre clear of the front board.
    this.horse = new Horse(uniforms, { harness: true });
    const hz = axleZ + 1.05 + 0.55 + 1.04;
    this.horse.group.position.set(0, 0, hz);
    this.group.add(this.horse.group);
    // Shafts: from under the bed, rising past the horse's flanks to the
    // loops on its pad, with a crossbar behind its quarters.
    for (const s of [-1, 1]) {
      const pts = [
        new THREE.Vector3(s * 0.45, R + 0.14, axleZ - 0.6),
        new THREE.Vector3(s * 0.45, R + 0.16, axleZ + 1.1),
        new THREE.Vector3(s * 0.44, 1.0, hz - 0.6),
        new THREE.Vector3(s * 0.4, 1.17, hz + 0.3),
        new THREE.Vector3(s * 0.37, 1.19, hz + 0.62),
      ];
      add(this.group, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.035, 6), wood, W, 0, 0, 0);
      // The tug: a leather loop from the pad down round the shaft.
      add(this.group, new THREE.TorusGeometry(0.06, 0.013, 4, 10), [0.17, 0.1, 0.06], W, s * 0.39, 1.19, hz + 0.3, 0, Math.PI / 2, 0);
    }
    add(this.group, new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), wood, W, 0, R + 0.16, axleZ + 1.12, 0, 0, Math.PI / 2);
    this.group.name = "cart";
  }

  /** Place at the car sim's contact point and heading; `speed` picks and drives the gait. */
  update(x: number, y: number, z: number, headingDeg: number, speed: number, dt: number, camera?: THREE.Vector3): void {
    this.group.position.set(x, y, z);
    // +z forward in the model; heading is clockwise from north, north is -z.
    this.group.rotation.set(0, Math.PI - (headingDeg * Math.PI) / 180, 0);
    const g = cartGait(speed);
    // One gait cycle per stride: the hooves keep pace with the ground.
    this.phase = (this.phase + (Math.abs(speed) / g.stride) * dt) % 1;
    this.horse.pose(g.gait, this.phase, g.strength);
    for (const w of this.wheels) w.rotation.x += (speed / 0.66) * dt;
    if (camera) this.horse.lod(camera);
    else { this.cam.set(x, y, z); this.horse.lod(this.cam); }
  }
}

/** Whether a world point is inside the town wall: modern things stay out of here. */
export function insideWalls(data: PompeiiData, x: number, z: number): boolean {
  return pointInRing(data.wall, x, z);
}
