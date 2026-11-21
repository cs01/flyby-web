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
import { AMPHI, buildPompeii, type PompeiiMeshData, type PompeiiModel } from "./pompeiimesh";
import { pointInRing, type PompeiiData } from "../data/pompeii";
import { PompeiiLife } from "../data/pompeiilife";
import { BuildingKind, RoofShape, type Building, type CityPack } from "../data/citypack";
import { Heightfield } from "../data/dem";
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
out vec3 vNormal;
out vec3 vWorld;
out vec4 vColour;
out vec4 vSurf;
out vec4 vWall;
out float vViewDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
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

uniform vec3  uCameraPos;
uniform float uSunSurface;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uNight;
uniform vec3  uNightGlow;

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

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCameraPos - vWorld);
  float style = floor(vSurf.x + 0.5);
  float p1 = vSurf.y, p2 = vSurf.z;
  float seed = vColour.a;
  vec3 albedo = vColour.rgb;
  float gloss = 0.0;
  float covered = 0.0;
  float u = vWall.x, h = vWall.y, len = vWall.z, H = vWall.w;
  vec2 tng = normalize(vec2(-n.z, n.x) + vec2(1e-4, 0.0));
  vec2 wp = vec2(dot(vWorld.xz, tng), vWorld.y);

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
    // Windows: small, high and shuttered, more of them upstairs.
    if (street && len > 0.0) {
      float twoStorey = step(7.0, H);
      float bay = twoStorey > 0.5 ? 3.1 : 5.3;
      float col = floor(u / bay);
      float lx = u - col * bay - bay * 0.5;
      float wy = twoStorey > 0.5 ? H - 2.6 : 3.4;
      float ww = twoStorey > 0.5 ? 0.42 : 0.28, wh = twoStorey > 0.5 ? 0.62 : 0.32;
      bool inside = abs(lx) < ww && abs(h - wy) < wh && u > 1.0 && u < len - 1.0 && h21(vec2(col, seed * 91.0)) > 0.25;
      if (inside) {
        c = vec3(0.05, 0.04, 0.035);
        // Wooden shutters folded back either side.
      } else if (abs(lx) < ww * 2.1 && abs(h - wy) < wh && abs(lx) > ww && u > 1.0 && u < len - 1.0 && twoStorey > 0.5 && h21(vec2(col, seed * 91.0)) > 0.25) {
        c = vec3(0.32, 0.2, 0.11);
      }
      // An electoral notice in red capitals on about a third of the street
      // walls, worn in patches. Letters 0.26 m high read from across the
      // street and alias past ~40 m, so they fade out there.
      if (!full && len > 8.0 && fract(seed * 13.7) < 0.35) {
        float ink = dipinto(u, h, seed, len, bandTop + 0.4);
        ink *= smoothstep(0.25, 0.45, vnoise(vec2(u, h) * 3.0 + seed * 40.0));
        ink *= 1.0 - smoothstep(25.0, 45.0, vViewDist);
        c = mix(c, vec3(0.6, 0.1, 0.06), ink * 0.85);
      }
    }
    albedo = c;
    // Weathering: blotches, trowel marks, rising damp and splash at the foot.
    albedo *= 0.9 + 0.16 * fbm(vec2(wp.x * 0.3, wp.y * 0.4) + seed * 10.0);
    albedo *= 0.96 + 0.08 * vnoise(vec2(wp.x * 2.6 + wp.y * 0.8, wp.y * 9.0));
    albedo *= 0.97 + 0.05 * vnoise(vWorld.xz * 6.0 + wp.y * 5.0);
    float damp = 1.0 - smoothstep(0.0, 1.0 + 0.5 * vnoise(vec2(wp.x * 0.9, seed * 9.0)), h);
    albedo = mix(albedo, albedo * vec3(0.72, 0.68, 0.62), damp * 0.6);
    // Grime under the eaves and down from the wall top.
    albedo *= 1.0 - 0.12 * smoothstep(H - 0.8, H, h) * step(1.0, H);
  } else if (style < 1.5) {
    // Terracotta: imbrex ridges up the slope, tegulae between, course lines.
    float pitch = 0.42;
    // p2 set: a surveyed house's roof, one heightfield over many slopes, so
    // the imbrex rows run across the slope in world space rather than along
    // a facade's u.
    float cu = (p2 > 0.5 ? wp.x : u) / pitch;
    float ridge = abs(fract(cu) - 0.5) * 2.0;
    float course = fract(h / 0.52);
    float id = h21(vec2(floor(cu), floor(h / 0.52)) + seed * 17.0);
    albedo *= 0.82 + 0.3 * id;
    albedo *= mix(1.12, 0.72, smoothstep(0.55, 1.0, ridge));
    albedo *= 1.0 - 0.25 * smoothstep(0.85, 1.0, course);
    albedo = mix(albedo, vec3(0.32, 0.3, 0.2), 0.25 * smoothstep(0.55, 0.85, fbm(vWorld.xz * 0.5)));
    // Light the ridges as if they were round.
    n = normalize(n + tng.x * 0.0 + vec3(0.0, 0.0, 0.0));
    gloss = 0.15;
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
    // Gaps: open joints a few centimetres wide, rounded shoulders into them.
    float gap = smoothstep(0.025, 0.06, edge);
    float crown = smoothstep(0.06, 0.42, edge);
    albedo = mix(vec3(0.25, 0.25, 0.255), vec3(0.37, 0.36, 0.35), tone) * (0.9 + 0.2 * vnoise(vWorld.xz * 2.0));
    albedo *= mix(0.78, 1.08, crown);
    // Vesicles: the lava's small pits, on some blocks.
    albedo *= 1.0 - 0.35 * step(0.6, tone) * step(0.93, vnoise(vWorld.xz * 26.0));
    albedo = mix(vec3(0.07, 0.065, 0.06), albedo, gap);
    // Cart ruts: two grooves a Roman axle apart down each lane, worn into
    // the blocks (vWall.z: metres from the street's centreline).
    float lat = vWall.z, half_ = vWall.w;
    float rut = 0.0;
    if (half_ > 1.6) {
      for (int k = -1; k <= 1; k += 2) {
        float c = float(k) * 0.72;
        rut = max(rut, 1.0 - smoothstep(0.03, 0.09, abs(lat - c)));
      }
      albedo *= 1.0 - 0.3 * rut;
    }
    // The dome's slope, from the point's offset to the block's centre;
    // flat on a broad worn crown, steep at the shoulders.
    vec2 off = pc.yz * S;
    float slope = (1.0 - crown) * 0.9 + 0.15;
    vec3 tilt = vec3(off.x, 0.0, off.y) * slope * 1.6;
    n = normalize(n + tilt * gap);
    gloss = 0.4 * gap * crown;
  } else if (style < 3.5) {
    // Kerbstones and slab edges: cut blocks.
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
  } else if (style < 4.5) {
    // Stucco: columns, temples, porticoes. Columns go red on the lower third.
    if (p1 > 0.5 && h < H * 0.36) albedo = vec3(0.56, 0.14, 0.09);
    albedo *= 0.92 + 0.12 * fbm(vec2(wp.x * 0.6, wp.y * 0.6));
    gloss = 0.1;
  } else if (style < 5.5) {
    // Garden: clipped green and bare earth.
    float g = fbm(vWorld.xz * 0.35);
    albedo = mix(vec3(0.38, 0.3, 0.2), albedo, smoothstep(0.35, 0.6, g));
    albedo *= 0.85 + 0.3 * vnoise(vWorld.xz * 2.5);
  } else if (style < 6.5) {
    // Inside a shop or a doorway: dim, with shelves and jars on the back wall.
    covered = 1.0;
    if (p1 > 0.5 && fract(h / 0.9) < 0.07 && h > 0.6) albedo *= 0.4;
    if (p1 > 0.5 && h > 0.0 && h < 0.85) {
      float jar = step(0.5, fract(u / 0.55)) * step(0.3, h21(vec2(floor(u / 0.55), seed * 5.0)));
      albedo = mix(albedo, vec3(0.6, 0.33, 0.2), jar * 0.8);
    }
  } else if (style < 7.5) {
    // Wood: planks and the studs of a door.
    float pl = fract(u / 0.24);
    albedo *= 0.8 + 0.25 * h21(vec2(floor(u / 0.24), seed)) - 0.25 * smoothstep(0.9, 1.0, pl);
    albedo *= 0.9 + 0.15 * vnoise(vec2(u * 2.0, h * 12.0));
  } else if (style < 8.5) {
    // Water: dark, with the sky in it at a grazing angle.
    float fres = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(n, v)), 5.0);
    vec3 sky = shIrradiance(reflect(-v, n)) * 0.35;
    vec3 sunE = uSunColor * uSunIntensity * uSunSurface;
    vec3 col = albedo * 0.25 * occludedSkyIrradiance(n) + sky * (0.2 + fres);
    col += sunE * pow(max(0.0, dot(n, normalize(uSunDir + v))), 200.0) * 0.5;
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
  } else if (style < 11.5) {
    // Marble and travertine: pale slabs with faint veins.
    vec2 b = abs(n.y) > 0.6 ? vWorld.xz / 1.2 : vec2(wp.x / 1.2, wp.y / 0.6);
    albedo *= 0.88 + 0.14 * h21(floor(b));
    albedo *= 0.95 + 0.08 * vnoise(vWorld.xz * 4.0 + vWorld.y);
    vec2 f = fract(b);
    albedo *= 0.88 + 0.12 * smoothstep(0.0, 0.03, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    gloss = 0.25;
  } else if (style < 12.5) {
    // Fresco: black dado, red panels framed in yellow, a white frieze.
    vec3 c = albedo;
    float pw = 2.6;
    float px = fract(u / pw);
    if (h < 0.9) c = vec3(0.07, 0.06, 0.06);
    else if (h > H - 0.6) c = vec3(0.85, 0.82, 0.74);
    else if (px < 0.04 || px > 0.96 || abs(h - 0.95) < 0.05) c = vec3(0.75, 0.6, 0.25);
    else if (h21(vec2(floor(u / pw), seed * 3.0)) > 0.6) c = vec3(0.06, 0.06, 0.06);
    albedo = c;
  } else if (style < 13.5) {
    // Opus signinum and beaten earth: warm, speckled with white tesserae.
    albedo *= 0.85 + 0.25 * fbm(vWorld.xz * 0.8);
    albedo = mix(albedo, albedo * 1.35, 0.6 * step(0.985, h21(floor(vWorld.xz * 22.0))));
  } else {
    // Hide: the horse.
    albedo *= 0.9 + 0.15 * vnoise(vWorld.xz * 5.0 + vWorld.y * 3.0);
  }

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunT;
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 ambient = occludedSkyIrradiance(n);
  vec3 moon = uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));
  // Sunlit paving and plaster throw a lot of light into a narrow street:
  // onto the walls from the paving, and back down onto shaded ground from
  // the pale sunlit walls round it. Without the second term a shaded street
  // or forum got the sky alone and went near black, worst on a phone with
  // no ambient occlusion pass to balance it against.
  vec3 bounce = sunE * max(0.0, uSunDir.y) * (0.15 * (1.0 - n.y) + 0.07 * max(0.0, n.y));
  float inside = 1.0 - covered * 0.7;
  vec3 lit = albedo * ((sunE * ndl * sunVis) * (1.0 - covered * 0.85) + (ambient + bounce) * inside + moon);
  // Lamps and hearths inside at night.
  lit += albedo * uNightGlow * uNight * 0.3;
  if (covered > 0.5) lit += albedo * vec3(1.0, 0.6, 0.3) * 0.6 * uNight;
  vec3 hh = normalize(uSunDir + v);
  lit += sunE * pow(max(0.0, dot(n, hh)), mix(8.0, 60.0, gloss)) * gloss * 0.25 * ndl * sunVis;

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export type PompeiiUniforms = StreetLampUniforms;

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

export function pompeiiMaterial(uniforms: PompeiiUniforms, opts: { bias?: number; doubleSided?: boolean } = {}): THREE.RawShaderMaterial {
  const bias = opts.bias ?? 0;
  return new THREE.RawShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
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

  constructor(opts: { data: PompeiiData; heightAt: (x: number, z: number) => number; shadow: SunShadowUniforms; lean: boolean; offsetX: number; offsetZ: number }) {
    const t0 = performance.now();
    this.group.name = "pompeii";
    const { data } = opts;
    // The pack's own origin is the City's, so the offset is zero in practice;
    // it is applied rather than assumed so a moved City entry cannot shift the
    // town off its streets silently.
    this.model = buildPompeii({ data, groundAt: (x, z) => opts.heightAt(x + opts.offsetX, z + opts.offsetZ), lean: opts.lean });
    this.uniforms = makeStreetLampUniforms(opts.shadow);
    const town = new THREE.Mesh(geometry(this.model.mesh), pompeiiMaterial(this.uniforms));
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

export async function loadPompeii(base: string): Promise<PompeiiData | null> {
  try {
    const r = await fetch(`${base}/pompeii.json`);
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
    const a = data.amphitheatre;
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
    const a = this.town.amphitheatre, c = Math.cos(a.rot), s = Math.sin(a.rot);
    const u = Math.cos(t) * ka, v = Math.sin(t) * kb;
    return [a.cx + c * u - s * v, a.cz + s * u + c * v];
  }

  /** 0 outside the wall, 1 over the bowl. */
  depth(x: number, z: number): number {
    const a = this.town.amphitheatre, c = Math.cos(a.rot), s = Math.sin(a.rot);
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

/** The terrain's field list with the amphitheatre's bowl at its head. */
export function pompeiiRingFields(fields: Heightfield[], data: PompeiiData): Heightfield[] {
  return [new AmphitheatreField(data, fields), ...fields];
}

/**
 * Repaint the drapes: everything within ~14 km of the town that is not water
 * becomes farmland, the volcano's slopes woodland and vineyard, its summit
 * bare. The original pixel's lightness is kept as a faint texture, clamped so
 * a white modern roof cannot show through as a speck.
 */
export function antiquateDrape(drapes: StitchedImage[], heightAt: (lat: number, lon: number) => number, wall: { ring: number[]; origin: Origin }): void {
  const R0 = 12000, R1 = 15000;
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
        if (B > R + 15 && B > G && lum > 45 && lum < 170) continue;
        const elev = heightAt(lat, lon);
        let c: [number, number, number];
        // The centuriation grid: 710 m squares, each in strips, each strip in
        // parcels, each parcel its own crop (cropAt, shared with the trees).
        const { kind, tone, lu, lv, sw, pl, fu, strip } = cropAt(x, y);
        c = [crops[kind][0] * tone, crops[kind][1] * tone, crops[kind][2] * tone];
        if (kind === 0 || kind === 4 || kind === 2) {
          // Rows in vineyards, orchards and olive groves.
          const gu = x * ct - y * st;
          const row = ((gu * (kind === 0 ? 0.45 : 0.16)) % 1 + 1) % 1;
          if (row < 0.4) c = [c[0] * 0.75, c[1] * 0.8, c[2] * 0.7];
        }
        // Field margins: a darker hedge or a track.
        if (lu < 5 || (lv % sw) < 3 || ((lu % pl) < 2.5)) c = hash2(fu, strip) > 0.5 ? [72, 88, 46] : [150, 132, 100];
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
export function pompeiiVegetation(data: PompeiiData, extentM = 6000, cellM = 20): { rgba: Uint8Array; n: number; extentM: number } {
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
      if (nearWallBox(x, z, 0) && pointInRing(data.wall, x, z)) {
        if (palestra && pointInRing(palestra, x, z)) tree = 0.75;
        else if (data.insulae.some((i) => pointInRing(i.ring, x, z))) tree = 0.22;
      } else {
        const crop = cropAt(x, -z);
        // Olive groves (2) and orchards (4) are trees; the hedges between
        // fields carry a few.
        if (crop.kind === 2) tree = 0.55;
        else if (crop.kind === 4) tree = 0.7;
        else if (crop.lu < 8 || crop.lv % crop.sw < 6) tree = 0.35;
        // A clear ring round the walls: the tombs and gardens along the roads
        // out of the gates, not woodland.
        if (nearWallBox(x, z, 60) && distToWall(data.wall, x, z) < 60) tree *= 0.3;
      }
      rgba[o + 2] = Math.round(tree * 255);
      rgba[o + 3] = Math.round((1 - tree) * 200);
    }
  }
  return { rgba, n, extentM };
}

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

function partGeo(g: THREE.BufferGeometry, rgb: [number, number, number], style: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  const n = ng.getAttribute("position").count;
  const nrm = ng.getAttribute("normal").array as Float32Array;
  const an = new Int8Array(n * 4), ac = new Uint8Array(n * 4), as = new Uint8Array(n * 4), aw = new Float32Array(n * 4);
  const pos = ng.getAttribute("position").array as Float32Array;
  for (let i = 0; i < n; i++) {
    an[i * 4] = Math.round(nrm[i * 3] * 127); an[i * 4 + 1] = Math.round(nrm[i * 3 + 1] * 127); an[i * 4 + 2] = Math.round(nrm[i * 3 + 2] * 127);
    ac[i * 4] = rgb[0] * 255; ac[i * 4 + 1] = rgb[1] * 255; ac[i * 4 + 2] = rgb[2] * 255; ac[i * 4 + 3] = 128;
    as[i * 4] = style;
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

/**
 * A two-wheeled cart and its horse, +z forward (three.js -z is north, so the
 * group is turned by the heading). Box and shafts in wood, iron-tyred wheels,
 * the horse from boxes and tapered cylinders with four legs that swing on a
 * walk cycle while the body bobs.
 */
export class Cart {
  readonly group = new THREE.Group();
  private readonly legs: THREE.Object3D[] = [];
  private readonly wheels: THREE.Object3D[] = [];
  private readonly horse = new THREE.Group();
  private phase = 0;

  constructor(uniforms: PompeiiUniforms) {
    const mat = pompeiiMaterial(uniforms, { doubleSided: true });
    const wood: [number, number, number] = [0.45, 0.3, 0.17];
    const dark: [number, number, number] = [0.25, 0.17, 0.1];
    const coat: [number, number, number] = [0.42, 0.26, 0.15];
    const mane: [number, number, number] = [0.12, 0.08, 0.06];
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, rgb: [number, number, number], style: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
      const m = new THREE.Mesh(partGeo(g, rgb, style), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true;
      m.layers.enable(SHADOW_CASTER_LAYER);
      parent.add(m);
      return m;
    };
    const W = 7; // Surf.Wood
    const HIDE = 14;
    // Cart body: floor, sides, front board, bench.
    add(this.group, new THREE.BoxGeometry(1.25, 0.08, 1.8), wood, W, 0, 0.8, -0.2);
    add(this.group, new THREE.BoxGeometry(0.06, 0.34, 1.8), wood, W, 0.62, 1.0, -0.2);
    add(this.group, new THREE.BoxGeometry(0.06, 0.34, 1.8), wood, W, -0.62, 1.0, -0.2);
    add(this.group, new THREE.BoxGeometry(1.25, 0.34, 0.06), wood, W, 0, 1.0, -1.08);
    add(this.group, new THREE.BoxGeometry(1.25, 0.4, 0.06), wood, W, 0, 1.02, 0.68);
    add(this.group, new THREE.BoxGeometry(1.1, 0.08, 0.38), dark, W, 0, 1.2, 0.42);
    // Amphorae in the back.
    for (let k = 0; k < 4; k++) {
      add(this.group, new THREE.CylinderGeometry(0.16, 0.08, 0.7, 8), [0.62, 0.34, 0.2], 13, -0.42 + k * 0.28, 1.12, -0.7, 0.5, 0, 0);
    }
    // Axle and wheels: spoked wheels as rings with a hub.
    add(this.group, new THREE.CylinderGeometry(0.05, 0.05, 1.9, 6), dark, W, 0, 0.5, -0.2, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) {
      const wheel = new THREE.Group();
      wheel.position.set(s * 0.76, 0.5, -0.2);
      add(wheel, new THREE.TorusGeometry(0.47, 0.05, 6, 18), dark, W, 0, 0, 0, 0, Math.PI / 2, 0);
      for (let k = 0; k < 6; k++) add(wheel, new THREE.BoxGeometry(0.04, 0.92, 0.05), wood, W, 0, 0, 0, (k / 6) * Math.PI, 0, 0);
      add(wheel, new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8), dark, W, 0, 0, 0, 0, 0, Math.PI / 2);
      this.group.add(wheel);
      this.wheels.push(wheel);
    }
    // Shafts out to the horse.
    for (const s of [-1, 1]) add(this.group, new THREE.BoxGeometry(0.07, 0.07, 3.4), wood, W, s * 0.48, 1.0, 2.2, 0.03, 0, 0);
    // The horse, its shoulder about 2.6 m ahead of the axle.
    this.horse.position.set(0, 0, 3.15);
    this.horse.scale.setScalar(1.12);
    this.group.add(this.horse);
    add(this.horse, new THREE.CylinderGeometry(0.33, 0.36, 1.5, 10), coat, HIDE, 0, 1.3, 0, Math.PI / 2, 0, 0);
    add(this.horse, new THREE.SphereGeometry(0.34, 10, 8), coat, HIDE, 0, 1.3, -0.72);
    add(this.horse, new THREE.SphereGeometry(0.33, 10, 8), coat, HIDE, 0, 1.32, 0.72);
    // Neck up and forward, head angled down.
    add(this.horse, new THREE.CylinderGeometry(0.15, 0.24, 0.9, 8), coat, HIDE, 0, 1.75, 0.98, Math.PI / 4.2, 0, 0);
    add(this.horse, new THREE.BoxGeometry(0.22, 0.24, 0.62), coat, HIDE, 0, 2.06, 1.38, 0.55, 0, 0);
    add(this.horse, new THREE.BoxGeometry(0.05, 0.4, 0.75), mane, HIDE, 0, 1.92, 1.0, Math.PI / 4.2, 0, 0);
    for (const s of [-1, 1]) add(this.horse, new THREE.ConeGeometry(0.05, 0.14, 4), coat, HIDE, s * 0.07, 2.26, 1.22);
    add(this.horse, new THREE.CylinderGeometry(0.03, 0.08, 0.7, 6), mane, HIDE, 0, 1.15, -0.95, -0.4, 0, 0);
    // Collar and harness.
    add(this.horse, new THREE.TorusGeometry(0.3, 0.05, 6, 12), dark, W, 0, 1.55, 0.75, -0.6, 0, 0);
    for (const [x, z] of [[-0.2, 0.55], [0.2, 0.55], [-0.2, -0.6], [0.2, -0.6]]) {
      const leg = new THREE.Group();
      leg.position.set(x, 1.15, z);
      add(leg, new THREE.CylinderGeometry(0.075, 0.055, 1.1, 6), coat, HIDE, 0, -0.55, 0);
      add(leg, new THREE.CylinderGeometry(0.07, 0.08, 0.1, 6), mane, HIDE, 0, -1.1, 0);
      this.horse.add(leg);
      this.legs.push(leg);
    }
    this.group.name = "cart";
  }

  /** Place at the car sim's contact point and heading; `speed` drives the gait. */
  update(x: number, y: number, z: number, headingDeg: number, speed: number, dt: number): void {
    this.group.position.set(x, y, z);
    // +z forward in the model; heading is clockwise from north, north is -z.
    this.group.rotation.set(0, Math.PI - (headingDeg * Math.PI) / 180, 0);
    // Stride about 1.6 m at a walk.
    this.phase += (Math.abs(speed) / 1.6) * Math.PI * 2 * dt;
    const amp = Math.min(1, Math.abs(speed) / 1.5) * 0.45;
    const ph = [0, Math.PI, Math.PI * 0.5, Math.PI * 1.5];
    this.legs.forEach((l, i) => { l.rotation.x = Math.sin(this.phase + ph[i]) * amp; });
    this.horse.position.y = Math.abs(Math.sin(this.phase)) * 0.06 * (amp > 0.01 ? 1 : 0);
    for (const w of this.wheels) w.rotation.x += (speed / 0.47) * dt;
  }
}

// =====================================================================================
// The townsfolk.
// =====================================================================================

// The town's own vertex shader with instancing and a walk cycle: each limb
// vertex carries its limb in aSurf.w, and swings about its hip or shoulder
// by the instance's phase. Tunic vertices take the instance's colour.
const LIFE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aNormal;
in vec4 aColour;
in vec4 aSurf;
in vec4 aWall;
in mat4 instanceMatrix;
in vec4 aInst;
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
  vec3 p = position;
  vec3 n = aNormal.xyz;
  float limb = aSurf.w;
  float sw = sin(aInst.w);
  float ang = 0.0;
  float pivot = 0.0;
  if (limb > 0.5 && limb < 2.5) { ang = (limb < 1.5 ? 1.0 : -1.0) * sw * 0.45; pivot = 0.88; }
  else if (limb > 2.5 && limb < 4.5) { ang = (limb < 3.5 ? -1.0 : 1.0) * sw * 0.35; pivot = 1.42; }
  if (ang != 0.0) {
    float c = cos(ang), s = sin(ang);
    vec2 yz = vec2(p.y - pivot, p.z);
    p.y = pivot + yz.x * c - yz.y * s;
    p.z = yz.x * s + yz.y * c;
    n = vec3(n.x, n.y * c - n.z * s, n.y * s + n.z * c);
  }
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vNormal = mat3(modelMatrix) * mat3(instanceMatrix) * n;
  vWorld = w.xyz;
  vColour = limb > 4.5 ? vec4(aInst.rgb, aColour.a) : aColour;
  vSurf = aSurf;
  vWall = aWall;
  vViewDist = distance(w.xyz, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Tunic colours: undyed wool, madder red, saffron, woad blue, brown, white. */
const TUNICS: [number, number, number][] = [
  [0.78, 0.72, 0.6], [0.62, 0.2, 0.14], [0.8, 0.6, 0.26], [0.32, 0.4, 0.55],
  [0.5, 0.36, 0.24], [0.88, 0.86, 0.8], [0.66, 0.56, 0.42], [0.45, 0.3, 0.32],
];

/** One walker: legs, a tunic over the body, arms, a head. +z forward, 1.65 m tall. */
function personGeometry(): THREE.BufferGeometry {
  const parts: { g: THREE.BufferGeometry; rgb: [number, number, number]; limb: number; at: [number, number, number] }[] = [];
  const skin: [number, number, number] = [0.62, 0.44, 0.32];
  for (const s of [-1, 1]) parts.push({ g: new THREE.BoxGeometry(0.12, 0.86, 0.13), rgb: skin, limb: s < 0 ? 1 : 2, at: [s * 0.085, 0.45, 0] });
  parts.push({ g: new THREE.CylinderGeometry(0.17, 0.27, 0.82, 7), rgb: [1, 1, 1], limb: 5, at: [0, 1.06, 0] });
  for (const s of [-1, 1]) parts.push({ g: new THREE.BoxGeometry(0.08, 0.58, 0.09), rgb: skin, limb: s < 0 ? 3 : 4, at: [s * 0.25, 1.15, 0] });
  parts.push({ g: new THREE.SphereGeometry(0.11, 7, 5), rgb: skin, limb: 0, at: [0, 1.56, 0.01] });
  parts.push({ g: new THREE.SphereGeometry(0.115, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.55), rgb: [0.12, 0.09, 0.07], limb: 0, at: [0, 1.575, -0.01] });
  const pos: number[] = [], an: number[] = [], ac: number[] = [], as: number[] = [];
  for (const p of parts) {
    p.g.translate(...p.at);
    const ng = p.g.index ? p.g.toNonIndexed() : p.g;
    ng.computeVertexNormals();
    const P = ng.getAttribute("position").array as Float32Array, N = ng.getAttribute("normal").array as Float32Array;
    for (let i = 0; i < P.length / 3; i++) {
      pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      an.push(Math.round(N[i * 3] * 127), Math.round(N[i * 3 + 1] * 127), Math.round(N[i * 3 + 2] * 127), 0);
      ac.push(p.rgb[0] * 255, p.rgb[1] * 255, p.rgb[2] * 255, 128);
      as.push(14, 0, 0, p.limb);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aNormal", new THREE.BufferAttribute(new Int8Array(an), 4, true));
  g.setAttribute("aColour", new THREE.BufferAttribute(new Uint8Array(ac), 4, true));
  g.setAttribute("aSurf", new THREE.BufferAttribute(new Uint8Array(as), 4, false));
  g.setAttribute("aWall", new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  return g;
}

/**
 * The people and carts of PompeiiLife, drawn: one instanced draw for the
 * people, Cart models for the carts. Kill switch `?off=pompeiilife`.
 */
export class Townsfolk {
  readonly group = new THREE.Group();
  readonly sim: PompeiiLife;
  private readonly mesh: THREE.InstancedMesh;
  private readonly inst: THREE.InstancedBufferAttribute;
  private readonly carts: Cart[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly v = new THREE.Vector3();

  constructor(data: PompeiiData, uniforms: PompeiiUniforms, private readonly heightAt: (x: number, z: number) => number,
    private readonly offX: number, private readonly offZ: number, lean: boolean) {
    this.sim = new PompeiiLife(data, { people: lean ? 20 : 48, carts: lean ? 1 : 2 });
    const geo = personGeometry();
    const n = this.sim.people.length;
    this.inst = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aInst", this.inst);
    const mat = new THREE.RawShaderMaterial({ vertexShader: LIFE_VERT, fragmentShader: FRAG, uniforms, glslVersion: THREE.GLSL3 });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Moves every frame across the whole town; bounds would only cull wrongly.
    this.mesh.frustumCulled = false;
    this.mesh.name = "pompeii-people";
    this.group.add(this.mesh);
    for (let i = 0; i < this.sim.carts.length; i++) {
      const c = new Cart(uniforms);
      this.carts.push(c);
      this.group.add(c.group);
    }
    this.group.name = "pompeii-life";
  }

  /** dt 0 holds everyone still (shot mode) but still places them round the camera. */
  update(dt: number, camX: number, camZ: number): void {
    this.sim.update(dt, camX - this.offX, camZ - this.offZ);
    const a = this.inst.array as Float32Array;
    this.sim.people.forEach((p, i) => {
      const x = p.x + this.offX, z = p.z + this.offZ;
      this.q.setFromAxisAngle(this.up, Math.PI - p.heading);
      this.v.set(x, this.heightAt(x, z), z);
      this.m.compose(this.v, this.q, this.one);
      this.mesh.setMatrixAt(i, this.m);
      const t = TUNICS[p.tint];
      a[i * 4] = t[0]; a[i * 4 + 1] = t[1]; a[i * 4 + 2] = t[2]; a[i * 4 + 3] = p.phase;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.inst.needsUpdate = true;
    this.sim.carts.forEach((c, i) => {
      const x = c.x + this.offX, z = c.z + this.offZ;
      this.carts[i].update(x, this.heightAt(x, z), z, (c.heading * 180) / Math.PI, c.speed, dt);
    });
  }
}

/** Whether a world point is inside the town wall: modern things stay out of here. */
export function insideWalls(data: PompeiiData, x: number, z: number): boolean {
  return pointInRing(data.wall, x, z);
}
