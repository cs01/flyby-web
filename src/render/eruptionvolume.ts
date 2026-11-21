// The eruption column, its umbrella and the dawn surge as a raymarched volume,
// marched inside the cloud pass (render/composite.ts) so it shares that pass's
// half-resolution quarter-rate march, its reprojection, its depth-aware
// upsample and its aerial perspective. The shape comes from sim/plume.ts:
// the GLSL below is generated from the same constants.
//
// Density: a Gaussian concentration across an entraining column (top-hat
// radius b = r0 + 6/5 alpha z), an overshoot dome over the neutral level, and
// the umbrella as a gravity current spread there and carried downwind. The
// noise that carves the cauliflower lives in self-similar coordinates (across
// the column in radii, up it in log-radius), so an eddy is always about the
// size of the column where it is, and it is advected by the plume's own rise
// speed, fastest on the axis, so the margins shear and roll. Advection is a
// two-phase flow noise (each phase restarted on a fresh offset when its weight
// is zero) so the texture never scrolls rigidly and never loops.
//
// Light: Beer-Lambert along the view, a short march toward the sun plus
// analytic far samples of the envelope (which is what puts the trunk in the
// umbrella's shadow), ash albedo 0.3 to 0.5 with weaker multiple-scattering
// octaves than water cloud, a powder term, sky ambient occluded by depth into
// the envelope, the vent's glow and the lightning as light inside the volume.

import * as THREE from "three";
import {
  BUOYANT_W_MS, EXIT_SPEED_MS, LEAN, SPREAD, VISIBLE_EDGE, UMBRELLA_MAX_HALF_M, WIND_UMBRELLA_MS, ashAlbedo, columnRadiusM, plumeShape,
  umbrellaHalfWidthM, type PlumeShape,
} from "../sim/plume";
import { COLUMN_H, SURGE_SPEED_MS, type EruptionState } from "../sim/eruption";

const f6 = (x: number) => x.toFixed(6);
const _c = new THREE.Color();

/** The noise's cell size against the local column radius: big eddies are about 0.6 b. */
const COLUMN_NOISE = 0.3;
/** The umbrella's eddies, metres per noise unit (four cells to a unit). */
const UMBRELLA_NOISE_M = 10000;
/** Extinction per unit density, 1/m: a mean free path of 170 m in the core. */
const PLUME_SIGMA = 0.006;
/** Ground map for the surge: metres either side of the vent. */
const SURGE_MAP_HALF_M = 15000;
const SURGE_MAP_N = 256;

/**
 * GLSL, included in the cloud march under PLUME. Needs CLOUD_GLSL (the noise
 * textures, sat, remap), ATMOSPHERE_GLSL and cloudPhase from that shader.
 */
export const PLUME_GLSL = /* glsl */ `
#ifdef PLUME
uniform vec4 uPlumeVent;    // vent xyz (world), animation seconds
uniform vec4 uPlumeA;       // top, neutral level, vent radius, gas-thrust top (m above the vent)
uniform vec4 uPlumeB;       // upwind, reach, spread radius, thickness over the vent (m)
uniform vec4 uPlumeC;       // spread constant c, wind toward x, z, grey 0..1
uniform vec4 uPlumeD;       // x the dome's width over the column's at the neutral level (wider on a climbing head), y 1 outside the fall, z visibility in the fall (m)
uniform vec3 uPlumeSun;     // the sun above the plume, cloud units
uniform vec3 uPlumeAmb;     // open-sky light on the plume
uniform vec3 uPlumeGround;  // light from the ground under it
uniform vec4 uPlumeFlash;   // lightning xyz, strength
uniform vec4 uPlumeGlow;    // vent glow rgb, w on
uniform vec3 uPlumeBox0Min;
uniform vec3 uPlumeBox0Max;
uniform vec3 uPlumeBox1Min;
uniform vec3 uPlumeBox1Max;
uniform vec4 uSurge;        // front m from the vent, bearing toward the town, speed m/s, strength 0..1
uniform vec3 uSurgeBoxMin;
uniform vec3 uSurgeBoxMax;
uniform vec4 uSurgeRect;    // ground map x0, z0, 1/extent
uniform sampler2D uSurgeGround;
uniform vec3 uSurgeSun;     // light reaching the surge under the plume
uniform vec3 uSurgeAmb;

const float P_SPREAD = ${f6(SPREAD)};
const float P_EXIT = ${f6(EXIT_SPEED_MS)};
const float P_WIND = ${f6(WIND_UMBRELLA_MS)};
const float P_SIGMA = ${f6(PLUME_SIGMA)};
const float P_COLN = ${f6(COLUMN_NOISE)};
const float P_UMBN = ${f6(1 / UMBRELLA_NOISE_M)};
const float P_BUOY = ${f6(BUOYANT_W_MS)};
const float P_HALFMAX = ${f6(UMBRELLA_MAX_HALF_M)};
const float P_LEAN = ${f6(LEAN)};
const float P_VIS = ${f6(VISIBLE_EDGE)};

float plumeR(float z) { return uPlumeA.z + P_SPREAD * max(z, 0.0); }

// Mirrors sim/plume.ts riseSpeedMS.
float plumeRise(float z) {
  float top = uPlumeA.x;
  if (z >= top || top <= 0.0) return 0.0;
  float zz = max(0.0, z);
  float jet = P_EXIT * uPlumeA.z / plumeR(zz);
  float buoy = P_BUOY * pow(max(zz, uPlumeA.w) / max(uPlumeA.w, 1.0), -1.0 / 3.0);
  return max(jet, buoy) * sqrt(1.0 - (zz / top) * (zz / top));
}

// Mirrors sim/plume.ts umbrellaHalfWidthM.
float plumeHalfWidth(float along) {
  float tau = max(0.0, along + uPlumeB.x) / P_WIND;
  return min(min(uPlumeB.z, uPlumeC.x * pow(tau, 2.0 / 3.0)), P_HALFMAX) + 0.5 * plumeR(uPlumeA.y);
}

vec3 pHash3(float k) {
  return fract(sin(vec3(k * 12.9898, k * 78.233, k * 37.719) + 0.5) * 43758.5453);
}

// Two phases of the shape noise moving along 'dir' at 'phase' units, each
// restarting on a fresh offset while its weight is zero. The mix is rescaled
// to one layer's contrast, or the cloud would breathe at the crossfade.
float flowShape(vec3 n, vec3 dir, float phase) {
  const float P = 0.7;
  float c1 = phase / P;
  float s1 = fract(c1);
  float s2 = fract(c1 + 0.5);
  float a = perlinWorley(n - dir * (s1 * P) + pHash3(floor(c1)));
  float b = perlinWorley(n - dir * (s2 * P) + pHash3(floor(c1 + 0.5) + 17.0));
  float w = abs(2.0 * s1 - 1.0);
  float m = mix(a, b, w);
  return clamp(0.5 + (m - 0.5) / sqrt(w * w + (1.0 - w) * (1.0 - w)), 0.0, 1.0);
}

float flowDetail(vec3 n, vec3 dir, float phase) {
  const float P = 0.7;
  float c1 = phase / P;
  float s1 = fract(c1);
  float s2 = fract(c1 + 0.5);
  vec3 ta = texture(uDetail, n - dir * (s1 * P) + pHash3(floor(c1) + 5.0)).rgb;
  vec3 tb = texture(uDetail, n - dir * (s2 * P) + pHash3(floor(c1 + 0.5) + 29.0)).rgb;
  float w = abs(2.0 * s1 - 1.0);
  return mix(ta.r * 0.625 + ta.g * 0.25 + ta.b * 0.125, tb.r * 0.625 + tb.g * 0.25 + tb.b * 0.125, w);
}

// Normalised distance from the plume's surface at q (from the vent): below 1
// inside the column (r over its visible radius) or the umbrella (the larger
// of its height over half its thickness and its footprint radius), the two
// joined with a smooth minimum. 'umb' is the umbrella's share, 'depth' a
// length scale for how far inside the light has to come.
float gPlumeGap = 0.0;
float gPlumeScale = 1000.0;
// The umbrella under q, for the ash-fall veils: footprint radius (0 at the
// vent, 1 at the edge), height of its base above the vent, distance downwind.
float gPlumeRho = 9.0;
float gPlumeBase = 0.0;
float gPlumeAlong = 0.0;
// Height under the umbrella's centre plane in half-thicknesses (negative
// below), for its hanging lobes.
float gPlumeV = 0.0;
float plumeS(vec3 q, out float umb, out float depth) {
  float top = uPlumeA.x, nbl = uPlumeA.y;
  vec2 f = uPlumeC.yz;
  float along = dot(q.xz, f);
  float cross = q.x * f.y - q.z * f.x;
  float z = q.y;
  umb = 0.0;
  gPlumeRho = 9.0;
  gPlumeAlong = along;
  depth = P_VIS * plumeR(min(max(z, 0.0), nbl));
  if (top <= 0.0) return 9.0;
  float zc = clamp(z, 0.0, top);
  // Bent over by the wind toward the top: a strong column leans little.
  float lean = P_LEAN * zc * zc / top;
  float bN = plumeR(nbl);
  // Above the neutral level the column decelerates and domes over, swelling
  // out first (wider on a climbing head) and closing at the top.
  float k = clamp((z - nbl) / max(top - nbl, 1.0), 0.0, 1.0);
  float b = z < nbl ? plumeR(z) : bN * (1.0 + (uPlumeD.x - 1.0) * min(1.0, 3.0 * k)) * sqrt(max(0.0, 1.0 - k * k));
  float r = length(vec2(along - lean, cross));
  float sc = z > top || z < -150.0 ? 9.0 : r / max(P_VIS * b, 1.0) + max(0.0, -z) / 150.0;
  float su = 9.0;
  float halfT = 1.0e5;
  if (uPlumeB.z > 500.0 && top > 3000.0) {
    float up = uPlumeB.x + bN;
    float reach = max(uPlumeB.y, up);
    float hw = plumeHalfWidth(along);
    float hx = along < 0.0 ? -along / up : along / reach;
    float hy = cross / hw;
    float rho2 = hx * hx + hy * hy;
    if (rho2 < 2.0) {
      // The front is a bank of lobes kilometres across, not an ellipse.
      rho2 += 0.3 * (perlinWorley(vec3(q.xz * (1.0 / 40000.0), 0.71) + uPlumeVent.w * 2e-5) - 0.5);
      float rho = sqrt(max(rho2, 0.0));
      float alongP = max(along, 0.0);
      // Sagging and thinning downwind as it drops its load.
      float sag = min(0.04 * alongP, 0.35 * nbl);
      float thin = 1.0 / (1.0 + alongP / 60000.0);
      // A gravity current keeps a thick head at its front, so the edge is
      // a rolled bank and not a sheet thinning to nothing.
      float T = max(2500.0, uPlumeB.w * (0.55 + 0.45 * sqrt(max(0.0, 1.0 - rho2))) * thin);
      float yc = nbl + 0.2 * (top - nbl) - sag;
      halfT = 0.5 * T;
      float v = (z - yc) / halfT;
      gPlumeV = v;
      gPlumeRho = rho;
      gPlumeBase = yc - halfT;
      su = max(abs(v), rho) / min(1.0, uPlumeB.z / 4000.0);
    }
  }
  // Metres the march may jump: the lobes reach to about 1.75 of either
  // normalised distance, each in its own length scale.
  gPlumeGap = min(max(sc - 1.8, 0.0) * max(P_VIS * b, 100.0), max(su - 1.8, 0.0) * halfT);
  gPlumeScale = min(max(P_VIS * b, 100.0), halfT);
  float h = clamp(0.5 + 0.5 * (sc - su) / 0.25, 0.0, 1.0);
  umb = h;
  depth = mix(depth, halfT, h);
  return mix(sc, su, h) - 0.25 * h * (1.0 - h);
}

// Envelope 0..1 without the noise, for the far light samples and the ambient.
float plumeEnvelope(vec3 q, out float umb, out float depth) {
  return smoothstep(1.3, 0.7, plumeS(q, umb, depth));
}

// The last plumeDensity call's surface distance, and the march's distance
// from the eye (the fine octave is only worth its fetches up close).
float gPlumeS = 9.0;
float gPlumeT = 0.0;

// Density at p (world). The noise displaces the surface by up to half the
// local radius, so the outline is lobes with hard edges, the cauliflower of a
// convecting column, and not a soft fade.
float plumeDensity(vec3 p, bool cheap, out float hf, out float env, out float depth) {
  vec3 q = p - uPlumeVent.xyz;
  float umb;
  float s = plumeS(q, umb, depth);
  gPlumeS = s;
  env = smoothstep(1.3, 0.7, s);
  hf = clamp(q.y / max(uPlumeA.x, 1.0), 0.0, 1.0);
  if (s > 1.75) return 0.0;
  float t = uPlumeVent.w;
  vec2 f = uPlumeC.yz;
  float along = dot(q.xz, f);
  float cross = q.x * f.y - q.z * f.x;
  float z = max(q.y, 0.0);
  float shape = 0.5;
  vec3 nC = vec3(0.0), dC = vec3(0.0, 1.0, 0.0), nU = vec3(0.0), dU = vec3(1.0, 0.0, 0.0);
  float phC = 0.0, phU = 0.0;
  float bS = 1000.0;
  if (umb < 0.98) {
    // Self-similar: across in radii, up in log-radius (an eddy rises one
    // radius per unit), moving at the local rise speed over the local radius.
    // Over the neutral level the dome keeps eddies of its own size, about a
    // third of the column's there, carried up at the dome's slowing speed.
    float nbl = uPlumeA.y;
    float zz = min(z, uPlumeA.x);
    float bN = plumeR(nbl);
    float k = clamp((zz - nbl) / max(uPlumeA.x - nbl, 1.0), 0.0, 1.0);
    bS = zz < nbl ? plumeR(zz) : bN * mix(1.0, 0.35, k);
    float lean = P_LEAN * zz * zz / max(uPlumeA.x, 1.0);
    vec2 xc = vec2(along - lean, cross) / bS;
    float zeta = zz < nbl ? log(bS / 100.0) / P_SPREAD : log(bN / 100.0) / P_SPREAD + (zz - nbl) / (0.6 * bN);
    nC = vec3(xc.x, zeta, xc.y) * P_COLN;
    // Slower at the margin than on the axis: the shear that rolls the edge
    // over. Never quite still, so the overshoot top keeps turning.
    float w = max(plumeRise(zz), 6.0) * (0.25 + 0.75 * exp(-2.0 * dot(xc, xc)));
    phC = t * w / bS * P_COLN;
    // Outward with height as the column entrains and widens.
    dC = normalize(vec3(xc.x * 0.25, 1.0, xc.y * 0.25));
  }
  if (umb > 0.02) {
    // Spreading from the vent and carried downwind; flattened eddies.
    vec2 rv = q.xz;
    float rr = max(length(rv), 500.0);
    float vr = (2.0 / 3.0) * pow(max(uPlumeC.x, 1.0), 1.5) / sqrt(rr);
    vec2 v = f * P_WIND + rv / rr * vr;
    float sp = length(v);
    nU = vec3(q.x, q.y * 2.2, q.z) * P_UMBN;
    dU = vec3(v.x, 0.0, v.y) / max(sp, 1e-3);
    phU = t * sp * P_UMBN;
  }
  if (umb < 0.98) shape = flowShape(nC, dC, phC);
  if (umb > 0.02) shape = mix(shape, flowShape(nU, dU, phU), umb);
  // Less on the umbrella, whose s is in half-thicknesses of kilometres.
  float se = s - mix(1.2, 1.0, umb) * (shape - 0.5);
  if (umb > 0.3 && gPlumeV < 0.0) {
    // Lobes hanging from the umbrella's base where the load drains out of
    // it (mammatus), a kilometre or two across, drifting with the cloud.
    vec3 m = vec3(q.x, q.y * 0.6, q.z) * (1.0 / 5000.0) - dU * (phU * 0.36);
    se -= umb * 0.7 * (perlinWorley(m + 0.41) - 0.45);
  }
  if (!cheap && abs(se - 1.0) < 0.25) {
    // The cauliflower on the lobes, only where the surface is.
    float detail = umb < 0.5 ? flowDetail(nC * 3.3, dC, phC * 3.3) : flowDetail(nU * 3.3, dU, phU * 3.3);
    se -= 0.22 * (detail - 0.5);
    // And on that, near the eye, where a few hundred metres span many pixels.
    if (umb < 0.5 && gPlumeT < 30.0 * bS && abs(se - 1.0) < 0.1) {
      se -= 0.09 * (flowDetail(nC * 11.0 + 0.27, dC, phC * 11.0) - 0.5);
    }
  }
  float d = smoothstep(1.07, 0.93, se);
  // Denser low in the column, where the tephra is, and through the umbrella,
  // which is an optically thick slab kilometres deep.
  return d * mix(mix(1.8, 0.9, hf), 1.6, umb);
}

// Ash falling out of the umbrella's base: streaky curtains under the
// downwind sheet, bent by the wind they fall through. Reads the umbrella
// footprint plumeS left for the same point. Thin (a mean free path of
// kilometres) and smooth enough to integrate over the march's long jumps.
float plumeVeil(vec3 p) {
  // Seen from inside the fall the fall's own haze is this, already.
  if (gPlumeRho > 1.0 || uPlumeD.y <= 0.0) return 0.0;
  vec3 q = p - uPlumeVent.xyz;
  float below = gPlumeBase - q.y;
  if (below <= 0.0 || q.y < -uPlumeVent.y) return 0.0;
  vec2 f = uPlumeC.yz;
  // Falling at about twice the wind's speed: displaced downwind half the drop.
  float a = gPlumeAlong - 0.5 * below;
  float c = q.x * f.y - q.z * f.x;
  vec4 n = texture(uShape, vec3(a / 9000.0, q.y / 40000.0, c / 9000.0) + vec3(uPlumeVent.w * P_WIND / 9000.0, 0.0, 0.0));
  float streak = smoothstep(0.35, 0.8, n.g * 0.7 + n.r * 0.3);
  float onset = smoothstep(-2000.0, 6000.0, gPlumeAlong);
  return uPlumeD.y * 0.08 * streak * onset * smoothstep(1.0, 0.75, gPlumeRho) * smoothstep(0.0, 1500.0, below);
}

float plumeDensityCheap(vec3 p) {
  float hf, env, depth;
  return plumeDensity(p, true, hf, env, depth);
}

float plumeEnvAt(vec3 p) {
  float umb, depth;
  return plumeEnvelope(p - uPlumeVent.xyz, umb, depth);
}

// Share of the air's sunlit in-scatter along rd out to dist that is NOT in
// the umbrella's shadow, weighted by air density. Seen from under its edge
// the air beneath the umbrella scatters no sun, which is most of why it
// is dark there: without this the far underside, behind 15 km of sunlit
// haze, came out the colour of the sky.
float plumeAirLit(vec3 rd, float dist) {
  if (uPlumeB.z <= 500.0 || uSunDir.y < 0.03) return 1.0;
  float yc = uPlumeVent.y + uPlumeA.y + 0.2 * (uPlumeA.x - uPlumeA.y);
  float sw = 0.0, sl = 0.0;
  for (int i = 0; i < 10; i++) {
    vec3 x = uCameraPos + rd * (dist * (float(i) + 0.5) / 10.0);
    float w = exp(-max(x.y, 0.0) / 8000.0);
    float lit = 1.0;
    // Under the umbrella's footprint the air is ash-laden from its base to
    // the ground (the veils are only the thick of it): it absorbs, and what
    // it scatters is dim and brown, not sky blue.
    plumeEnvAt(x);
    float under = gPlumeRho < 1.2 ? smoothstep(1.1, 0.75, gPlumeRho) * smoothstep(0.0, 2000.0, gPlumeBase - (x.y - uPlumeVent.y)) : 0.0;
    if (x.y < yc) lit = exp(-4.0 * plumeEnvAt(x + uSunDir * ((yc - x.y) / uSunDir.y)));
    lit = mix(lit, 0.1, under);
    sw += w;
    sl += w * lit;
  }
  return sl / max(sw, 1e-5);
}

// The surge: a current a few tens of metres deep following the ground, with
// a billowing head, lobes along its front and a dilute cloud lofting behind.
float surgeGround(vec2 xz) {
  return textureLod(uSurgeGround, (xz - uSurgeRect.xy) * uSurgeRect.z, 0.0).r;
}

float surgeDensity(vec3 p, out float hfs) {
  hfs = 0.0;
  if (uSurge.w <= 0.0) return 0.0;
  if (any(lessThan(p, uSurgeBoxMin)) || any(greaterThan(p, uSurgeBoxMax))) return 0.0;
  vec2 d = p.xz - uPlumeVent.xz;
  float rr = length(d);
  float ang = atan(d.x, -d.y) - uSurge.y;
  ang = mod(ang + 3.14159265, 6.2831853) - 3.14159265;
  if (abs(ang) > 0.95) return 0.0;
  float hg = p.y - surgeGround(p.xz);
  // Written so a NaN from the ground map fails it too.
  if (!(hg > -10.0 && hg < 1300.0)) return 0.0;
  float s = ang * rr;
  float t = uPlumeVent.w;
  // Lobes and clefts along the front, a few hundred metres apart.
  float lob = texture(uShape, vec3(s / 1800.0, 0.31, t * 0.004)).r;
  float front = uSurge.x + 160.0 * (lob - 0.5) - 900.0 * smoothstep(0.55, 0.95, abs(ang));
  float behind = front - rr;
  if (behind < -150.0) return 0.0;
  // Billows rolling forward and up off the head, carried at the front's speed.
  vec3 n = vec3(s, hg * 1.2, rr) / 170.0;
  float sh = flowShape(n, normalize(vec3(0.0, 0.5, 1.0)), t * uSurge.z / 170.0);
  behind += 90.0 * (sh - 0.5);
  // The dense basal current, a few tens of metres deep, with a head about
  // three times that at the front (a gravity current's raised nose); above
  // and behind it the dilute cloud that lofts as it entrains air and sheds
  // its load, rising to several hundred metres a few kilometres back.
  float hb = 50.0 + 170.0 * exp(-max(behind, 0.0) / 350.0);
  // The nose overhangs its own foot: the head runs ahead of the ground-
  // dragged base by tens of metres at mid-height.
  behind += 60.0 * sin(3.14159 * clamp(hg / hb, 0.0, 1.0)) * exp(-max(behind, 0.0) / 300.0);
  float hd = 250.0 + min(max(behind, 0.0) * 0.3, 900.0);
  float tail = smoothstep(-40.0, 30.0, behind) * smoothstep(5000.0, 2000.0, behind) * uSurge.w;
  if (tail <= 0.0) return 0.0;
  // Surfaces displaced by the noise, as for the column: hard-edged lobes.
  float dense = smoothstep(1.05, 0.95, hg / hb - 1.3 * (sh - 0.5));
  float dil = 0.5 * smoothstep(1.06, 0.94, hg / hd - 1.1 * (sh - 0.5)) * smoothstep(0.0, 300.0, behind);
  hfs = sat(hg / hd);
  return max(3.0 * dense, dil) * tail;
}

vec2 boxHits(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 lo = min(t0, t1), hi = max(t0, t1);
  float a = max(max(lo.x, lo.y), lo.z), b = min(min(hi.x, hi.y), hi.z);
  return b > max(a, 0.0) ? vec2(max(a, 0.0), b) : vec2(-1.0);
}

// The sun on the plume at height y: reddened through the air above it, cut
// off below the earth's shadow line when the sun is down.
vec3 plumeSunAt(float y, vec3 sunLo, vec3 sunHi) {
  float alt = max(y, 0.0);
  float horizon = -sqrt(2.0 * alt / R_GROUND);
  return mix(sunLo, sunHi, sat((y - 1500.0) / 24000.0)) * smoothstep(horizon - 0.006, horizon + 0.012, uSunDir.y);
}

// The ash-fall veils over a jump of len metres from p, at p's density. They
// sit in the umbrella's shadow, lit by the ground and the sky round the edge
// and by the sun only where it gets in under the edge.
void veilStep(vec3 p, float dV, float len, float t, vec3 rd, vec3 sunLo, vec3 sunHi,
              inout vec3 scattered, inout float through, inout float dSum, inout float wSum) {
  float yc = uPlumeVent.y + uPlumeA.y + 0.2 * (uPlumeA.x - uPlumeA.y);
  float sunVis = uSunDir.y > 0.03 ? exp(-4.0 * plumeEnvAt(p + uSunDir * (max(yc - p.y, 0.0) / uSunDir.y))) : 0.0;
  vec3 lum = (uPlumeGround * 0.8 + uPlumeAmb * 0.25 + plumeSunAt(p.y, sunLo, sunHi) * sunVis * 0.1) * 0.18 * vec3(1.0, 0.86, 0.7);
  float fog = mix(exp(-t / uPlumeD.z), 1.0, uPlumeD.y);
  float a = (1.0 - exp(-dV * P_SIGMA * len)) * fog;
  float w = through * a;
  scattered += lum * w;
  dSum += w * (t + 0.5 * len);
  wSum += w;
  through *= 1.0 - a;
}

void plumeMarch(
vec3 rd, float sceneDist, ivec2 hp, inout vec3 scattered, inout float through, inout float dSum, inout float wSum) {
  vec3 ro = uCameraPos;
  vec2 iv[3];
  iv[0] = boxHits(ro, rd, uPlumeBox0Min, uPlumeBox0Max);
  iv[1] = boxHits(ro, rd, uPlumeBox1Min, uPlumeBox1Max);
  iv[2] = uSurge.w > 0.0 ? boxHits(ro, rd, uSurgeBoxMin, uSurgeBoxMax) : vec2(-1.0);
  vec2 sIv = iv[2];
  for (int i = 0; i < 3; i++) iv[i].y = min(iv[i].y, sceneDist);
  // Nearest first, three at most.
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2 - i; j++) {
    bool swap = iv[j].y <= iv[j].x || (iv[j + 1].y > iv[j + 1].x && iv[j + 1].x < iv[j].x);
    if (swap) { vec2 tmp = iv[j]; iv[j] = iv[j + 1]; iv[j + 1] = tmp; }
  }
  if (iv[0].y <= iv[0].x) return;

  float cosSun = dot(rd, uSunDir);
  vec3 sunLo = uPlumeSun * sunTransmittance(atmoOrigin(1500.0), uSunDir, 1.0);
  vec3 sunHi = uPlumeSun * sunTransmittance(atmoOrigin(25000.0), uSunDir, 1.0);
  float grey = uPlumeC.w;
  ivec2 px = hp & 1;
  const float BAYER[4] = float[4](0.0, 2.0, 3.0, 1.0);
  float ign = fract(52.9829189 * fract(dot(vec2(hp) + 0.5, vec2(0.06711056, 0.00583715))));
  float jit = (BAYER[px.y * 2 + px.x] + ign) * 0.25;

  int steps = 0;
  float t = iv[0].x;
  vec3 lastLum = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    vec2 seg = iv[k];
    if (seg.y <= seg.x) break;
    t = max(t, seg.x);
    bool first = true;
    bool coarse = true;
    for (int i = 0; i < PLUME_STEPS; i++) {
      if (steps >= PLUME_STEPS) break;
      float dt = clamp(t * 0.016, 12.0, 700.0);
      // Near the plume, a step is a fraction of its local size: at 15 km the
      // distance step alone strode over the narrow column above the vent.
      if (gPlumeS < 2.0) dt = min(dt, max(0.2 * gPlumeScale, 25.0));
      if (first) { t += dt * jit; first = false; }
      if (t > seg.y || through < 0.01) break;
      steps++;
      vec3 p = ro + rd * t;
      float hf, env, depth, hfs;
      gPlumeT = t;
      float dP = plumeDensity(p, false, hf, env, depth);
      float dV = plumeVeil(p);
      float dS = surgeDensity(p, hfs);
      float dens = dP + dS;
      bool nearSurge = uSurge.w > 0.0 && all(greaterThan(p, uSurgeBoxMin)) && all(lessThan(p, uSurgeBoxMax));
      if (dens <= 0.001) {
        // No coarse stride in the surge: its billows are tens of metres and
        // alternate hits and misses between pixels read as speckle.
        float jump = coarse && !nearSurge ? 2.5 * dt : dt;
        // Far outside the plume and clear of the surge: jump most of the way to
        // its surface. The lobes reach out to about 1.5 of the normalised
        // distance, so the jump stops short of that.
        if (!nearSurge) jump = max(jump, min(0.8 * gPlumeGap, dV > 0.0 ? 2000.0 : 4000.0));
        // Never over the surge: a long jump from the camera cleared it whole.
        if (sIv.y > sIv.x && t < sIv.x) jump = min(jump, max(sIv.x - t, dt));
        if (dV > 0.0) veilStep(p, dV, jump, t, rd, sunLo, sunHi, scattered, through, dSum, wSum);
        t += jump;
        // Back up on the next hit only after a stride longer than a step, or a
        // single-step march walks back and forth over the same edge.
        coarse = jump > 1.01 * dt;
        continue;
      }
      if (coarse) {
        coarse = false;
        t = max(seg.x, t - 1.5 * dt);
        continue;
      }
      dens += dV;
      vec3 lum;
      if (dP + dV >= dS) {
        // Light toward the sun: near steps through the noise, far ones
        // through the envelope alone, then the umbrella overhead.
        float od = 0.0;
        float ls = 0.06 * depth + 40.0;
        float lt = 0.0;
        for (int j = 0; j < PLUME_LIGHT; j++) {
          od += plumeDensityCheap(p + uSunDir * (lt + 0.5 * ls)) * ls;
          lt += ls;
          ls *= 2.2;
        }
        for (int j = 1; j <= 2; j++) {
          float far = lt + float(j) * 2.0 * depth;
          od += plumeEnvAt(p + uSunDir * far) * 2.0 * depth * 1.2;
        }
        float yc = uPlumeVent.y + uPlumeA.y;
        if (uSunDir.y > 0.03 && p.y < yc - 2000.0) {
          float tu = (yc - p.y) / uSunDir.y;
          od += plumeEnvAt(p + uSunDir * tu) * uPlumeB.w * 0.8;
        }
        float alb = ${ashAlbedo(0).toFixed(3)} + ${(ashAlbedo(1) - ashAlbedo(0)).toFixed(3)} * smoothstep(0.0, 0.45, hf);
        alb *= 1.0 - 0.2 * grey;
        // Tephra-laden and brown low down, paler ash grey in the umbrella.
        vec3 tint = mix(vec3(1.0, 0.8, 0.62), vec3(1.0, 0.94, 0.86), smoothstep(0.1, 0.6, hf));
        float s = 0.0;
        float aw = alb;
        float b = 1.0;
        float kph = 1.0;
        for (int j = 0; j < 3; j++) {
          s += aw * (cloudPhase(cosSun, kph) * 4.0 + 0.3) * exp(-P_SIGMA * b * od);
          aw *= alb * 0.9;
          // Ash absorbs half of what it scatters, so light that has scattered
          // is nearly as quickly lost as the beam: diffusion barely lengthens
          // its path (sqrt(3(1-w)(1-gw)) is about 1 at w 0.45), unlike water cloud.
          b *= 0.75;
          kph *= 0.6;
        }
        float powder = 1.0 - 0.7 * exp(-dP * P_SIGMA * 700.0) * sat(-cosSun * 0.5 + 0.5);
        // The phase and octaves above are the water-cloud calibration (render/
        // composite.ts sunScatter); ash scatters less of the beam back out of
        // its sunlit face than a cumulus of the same albedo would.
        s *= 0.55;
        vec3 sun = plumeSunAt(p.y, sunLo, sunHi);
        // Sky light from above, from the side facing the eye and from the
        // ground below, each through the envelope in its own direction: the
        // underside of the umbrella sees the ground, not the sky.
        float D = depth;
        float odUp = (plumeDensityCheap(p + vec3(0.0, 0.25 * D, 0.0)) * 0.5 + plumeEnvAt(p + vec3(0.0, 0.5 * D, 0.0)) + plumeEnvAt(p + vec3(0.0, 1.5 * D, 0.0))) * D;
        float odSide = (plumeEnvAt(p - rd * 0.5 * D) + plumeEnvAt(p - rd * 1.5 * D)) * D;
        float odDn = (plumeDensityCheap(p - vec3(0.0, 0.25 * D, 0.0)) * 0.5 + plumeEnvAt(p - vec3(0.0, 0.5 * D, 0.0)) + plumeEnvAt(p - vec3(0.0, 1.5 * D, 0.0))) * D;
        float ka = P_SIGMA * 0.35;
        vec3 amb = (uPlumeAmb * (0.55 * exp(-ka * odUp) + 0.3 * exp(-ka * odSide)) + uPlumeGround * exp(-ka * odDn)) * alb;
        lum = (sun * s * powder + amb) * tint;
        vec3 q = p - uPlumeVent.xyz;
        if (uPlumeGlow.w > 0.0) {
          // Incandescent clasts in the jet, and their light inside the column.
          float r2 = dot(q.xz, q.xz) / max(uPlumeA.z * uPlumeA.z, 1.0);
          lum += uPlumeGlow.rgb * exp(-max(q.y, 0.0) / 150.0 - r2) * 1.2;
          lum += uPlumeGlow.rgb * alb * exp(-length(q - vec3(0.0, 400.0, 0.0)) / 1400.0) * 0.4;
        }
        if (uPlumeFlash.w > 0.0) {
          vec3 fd = p - uPlumeFlash.xyz;
          lum += vec3(0.75, 0.8, 1.0) * uPlumeFlash.w * alb * exp(-dot(fd, fd) / 3.2e6);
        }
      } else {
        // Dark and dense at the base, the lofting cloud above paler and lit from
        // above by the dawn there is: the wall reads by its tones, not lightning.
        float alb = mix(0.18, 0.45, hfs);
        vec3 tint = mix(vec3(0.85, 0.72, 0.58), vec3(1.0, 0.92, 0.82), hfs);
        // Light from above through the cloud over the sample: billow tops pale,
        // the creases between them and the undersides dark.
        float hd1, hd2;
        float occ = exp(-P_SIGMA * (surgeDensity(p + vec3(0.0, 35.0, 0.0), hd1) * 35.0 + surgeDensity(p + vec3(0.0, 110.0, 0.0), hd2) * 75.0) * 1.5);
        lum = (uSurgeSun * (0.3 + 0.7 * hfs) * occ + uSurgeAmb * (0.25 + 2.2 * occ) * (0.6 + 0.6 * hfs)) * alb * tint;
        if (uPlumeFlash.w > 0.0) {
          vec3 fd = p - uPlumeFlash.xyz;
          // The surge's own lightning is most of what shows it in the dark.
          lum += vec3(0.75, 0.8, 1.0) * uPlumeFlash.w * (alb / 0.3) * (0.3 + 1.2 * occ) * exp(-dot(fd, fd) / 2.0e6);
        }
      }
      lastLum = lum;
      // Inside the fall the plume fades into the fall's own haze with distance,
      // as everything else there does (the scene behind is that haze).
      // The surge's head is hundreds of metres of near-opaque cloud standing
      // against the lighter haze behind it, a contrast that carries further
      // than the fall's visibility (set for a small dark object near the ground).
      float fog = mix(exp(-t / (uPlumeD.z * (dS > dP ? 3.0 : 1.0))), 1.0, uPlumeD.y);
      float stepA = (1.0 - exp(-dens * P_SIGMA * dt)) * fog;
      float w = through * stepA;
      scattered += lum * w;
      dSum += w * t;
      wSum += w;
      through *= 1.0 - stepA;
      t += dt;
    }
  }
  // Out of steps inside a long umbrella crossing: close it at the last light.
  if (steps >= PLUME_STEPS && through > 0.01 && t < iv[0].y) {
    float od = plumeEnvAt(ro + rd * t) * P_SIGMA * (iv[0].y - t) * 0.5;
    float w = through * (1.0 - exp(-od));
    scattered += lastLum * w;
    dSum += w * t;
    wSum += w;
    through *= exp(-od);
  }
}
#endif
`;

export interface PlumeUniforms extends Record<string, THREE.IUniform> {
  uPlumeVent: THREE.IUniform<THREE.Vector4>;
  uPlumeA: THREE.IUniform<THREE.Vector4>;
  uPlumeB: THREE.IUniform<THREE.Vector4>;
  uPlumeC: THREE.IUniform<THREE.Vector4>;
  uPlumeD: THREE.IUniform<THREE.Vector4>;
  uPlumeSun: THREE.IUniform<THREE.Color>;
  uPlumeAmb: THREE.IUniform<THREE.Color>;
  uPlumeGround: THREE.IUniform<THREE.Color>;
  uPlumeFlash: THREE.IUniform<THREE.Vector4>;
  uPlumeGlow: THREE.IUniform<THREE.Vector4>;
  uPlumeBox0Min: THREE.IUniform<THREE.Vector3>;
  uPlumeBox0Max: THREE.IUniform<THREE.Vector3>;
  uPlumeBox1Min: THREE.IUniform<THREE.Vector3>;
  uPlumeBox1Max: THREE.IUniform<THREE.Vector3>;
  uSurge: THREE.IUniform<THREE.Vector4>;
  uSurgeBoxMin: THREE.IUniform<THREE.Vector3>;
  uSurgeBoxMax: THREE.IUniform<THREE.Vector3>;
  uSurgeRect: THREE.IUniform<THREE.Vector4>;
  uSurgeGround: THREE.IUniform<THREE.Texture>;
  uSurgeSun: THREE.IUniform<THREE.Color>;
  uSurgeAmb: THREE.IUniform<THREE.Color>;
}

export interface PlumeFrame {
  state: EruptionState;
  /** Animation seconds: the motion of the eddies, which is real time, not story time. */
  animT: number;
  /** The sun above the plume, cloud units (sun colour x raw intensity x 0.105). */
  sun: THREE.Color;
  /** Open-sky ambient, before the eruption dimmed it. */
  amb: THREE.Color;
  /** Light under the plume, as the town gets it, for the surge. */
  nearAmb: THREE.Color;
  /** Share of the sun under the plume. */
  shade: number;
  flash: THREE.Vector4;
  /** Bearing from the vent toward the town, radians clockwise from north. */
  townBearing: number;
  /** How far one sees through the fall at the camera, metres. */
  visibilityM: number;
  /** Height of the sun, the sine of its altitude. */
  sunY: number;
  /** 1 with the camera outside the fall, where the open sky shows under the umbrella. */
  outside: number;
}

/** The volume's uniforms and the per-frame numbers behind them. */
export class EruptionVolume {
  readonly uniforms: PlumeUniforms;
  shape: PlumeShape = plumeShape(0, 0, 0, 0);
  private groundBuilt = false;
  private readonly groundTex: THREE.DataTexture;

  constructor(private readonly vent: THREE.Vector3, private readonly heightAt: (x: number, z: number) => number) {
    this.groundTex = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
    this.groundTex.needsUpdate = true;
    const v3 = () => ({ value: new THREE.Vector3() });
    this.uniforms = {
      uPlumeVent: { value: new THREE.Vector4(vent.x, vent.y, vent.z, 0) },
      uPlumeA: { value: new THREE.Vector4() },
      uPlumeB: { value: new THREE.Vector4() },
      uPlumeC: { value: new THREE.Vector4() },
      uPlumeD: { value: new THREE.Vector4(1.15, 0, 0, 0) },
      uPlumeSun: { value: new THREE.Color() },
      uPlumeAmb: { value: new THREE.Color() },
      uPlumeGround: { value: new THREE.Color() },
      uPlumeFlash: { value: new THREE.Vector4() },
      uPlumeGlow: { value: new THREE.Vector4() },
      uPlumeBox0Min: v3(), uPlumeBox0Max: v3(), uPlumeBox1Min: v3(), uPlumeBox1Max: v3(),
      uSurge: { value: new THREE.Vector4() },
      uSurgeBoxMin: v3(), uSurgeBoxMax: v3(),
      uSurgeRect: { value: new THREE.Vector4(0, 0, 1, 0) },
      uSurgeGround: { value: this.groundTex },
      uSurgeSun: { value: new THREE.Color() },
      uSurgeAmb: { value: new THREE.Color() },
    };
  }

  /** The ground under the surge's path, once: heights at 117 m a texel round the vent. */
  private buildGround(): void {
    this.groundBuilt = true;
    const n = SURGE_MAP_N, half = SURGE_MAP_HALF_M;
    const data = new Uint16Array(n * n);
    const x0 = this.vent.x - half, z0 = this.vent.z - half, step = (2 * half) / (n - 1);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const g = this.heightAt(x0 + i * step, z0 + j * step);
      // Off the edge of the terrain data heightAt has nothing: call it sea level.
      data[j * n + i] = THREE.DataUtils.toHalfFloat(Number.isFinite(g) ? g : 0);
    }
    const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.uniforms.uSurgeGround.value = tex;
    // Texel centres: uv 0 at the first sample, 1 at the last.
    const ext = 2 * half + step;
    this.uniforms.uSurgeRect.value.set(x0 - step / 2, z0 - step / 2, 1 / ext, 0);
    this.groundTex.dispose();
  }

  update(fr: PlumeFrame): void {
    const s = fr.state, u = this.uniforms, v = this.vent;
    const ageS = Math.max(0, (s.h - COLUMN_H) * 3600);
    const sh = (this.shape = plumeShape(s.columnKm, s.steadyKm, v.y / 1000, ageS));
    u.uPlumeVent.value.w = fr.animT;
    u.uPlumeA.value.set(sh.topM, sh.nblM, sh.ventRM, sh.jetM);
    u.uPlumeB.value.set(sh.upwindM, sh.reachM, sh.spreadM, sh.thickM);
    const WIND_TOWARD = (150 * Math.PI) / 180;
    const fx = Math.sin(WIND_TOWARD), fz = -Math.cos(WIND_TOWARD);
    u.uPlumeC.value.set(sh.c, fx, fz, 1 - s.whiteness);
    // A starting plume's head is wider than the stem under it.
    u.uPlumeD.value.x = sh.rising ? 1.7 : 1.15;
    u.uPlumeD.value.y = fr.outside;
    u.uPlumeD.value.z = fr.visibilityM;
    u.uPlumeSun.value.copy(fr.sun);
    // Half the sky light's blue: much of what reaches a shaded flank has
    // bounced off the rest of the cloud first, and ash is grey-brown. At full
    // sky blue the column read lavender from across the bay.
    const al = fr.amb.r * 0.3 + fr.amb.g * 0.45 + fr.amb.b * 0.25;
    u.uPlumeAmb.value.copy(fr.amb).lerp(_c.setRGB(al, al * 0.95, al * 0.88), 0.5);
    // Light from below: the landscape round the umbrella's shadow (albedo about
    // 0.12, half of what the underside sees is in that shadow) and the sky it
    // reflects. What lights the underside, a few stops under its sunlit top.
    u.uPlumeGround.value.copy(fr.sun).multiplyScalar(0.15 * Math.max(0, fr.sunY)).add(_c.copy(fr.amb).multiplyScalar(0.4)).multiply(_c.setRGB(1.0, 0.9, 0.78));
    u.uPlumeFlash.value.copy(fr.flash);
    // The vent's glow: constant in radiance, so it only tells once the day goes.
    const glow = sh.topM > 0 ? 1 : 0;
    u.uPlumeGlow.value.set(0.7 * glow, 0.2 * glow, 0.04 * glow, glow);

    // Bounds: the column as a box round the vent, the umbrella as the box
    // round its footprint in the wind frame.
    const bN = columnRadiusM(sh.nblM, sh);
    const colHalf = 1.4 * VISIBLE_EDGE * Math.max(bN, columnRadiusM(sh.topM, sh) * 0.6) + 0.1 * sh.topM + 300;
    u.uPlumeBox0Min.value.set(v.x - colHalf, v.y - 300, v.z - colHalf);
    u.uPlumeBox0Max.value.set(v.x + colHalf, v.y + sh.topM + 400, v.z + colHalf);
    if (sh.spreadM > 500 && sh.topM > 3000) {
      const up = 1.2 * (sh.upwindM + 2 * bN), reach = Math.max(sh.reachM, up) + 2000;
      const hw = 1.15 * umbrellaHalfWidthM(reach, sh) + 2000;
      const sag = Math.min(0.04 * reach, 0.35 * sh.nblM);
      const yLo = v.y + sh.nblM + 0.2 * (sh.topM - sh.nblM) - sag - 0.6 * sh.thickM - 1500;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const a of [-up, reach]) for (const c of [-hw, hw]) {
        // cross = x fz - z fx, so the cross axis is (fz, -fx).
        const x = v.x + fx * a + fz * c, z = v.z + fz * a - fx * c;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      // Down to the ground: the ash-fall veils hang from the base to it.
      u.uPlumeBox1Min.value.set(x0, Math.min(yLo, -100), z0);
      u.uPlumeBox1Max.value.set(x1, v.y + sh.topM + 600, z1);
    } else {
      u.uPlumeBox1Min.value.set(0, 0, 0);
      u.uPlumeBox1Max.value.set(0, 0, 0);
    }

    // The surge.
    const sg = s.surge;
    if (sg) {
      if (!this.groundBuilt) this.buildGround();
      u.uSurge.value.set(sg.frontM, fr.townBearing, SURGE_SPEED_MS, sg.moving ? 1 : 0.6);
      const rIn = Math.max(0, sg.frontM - 5100), rOut = sg.frontM + 400;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i <= 8; i++) {
        const a = fr.townBearing + (i / 8 - 0.5) * 1.95;
        for (const r of [rIn, rOut]) {
          const x = v.x + Math.sin(a) * r, z = v.z - Math.cos(a) * r;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
      }
      // The ground along the arc's outer edge bounds the current from below.
      let gMin = Infinity, gMax = -Infinity;
      for (let i = 0; i <= 16; i++) {
        const a = fr.townBearing + (i / 16 - 0.5) * 1.95;
        for (const r of [rIn, (rIn + rOut) / 2, rOut]) {
          const g = this.heightAt(v.x + Math.sin(a) * r, v.z - Math.cos(a) * r);
          if (Number.isFinite(g)) { gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
        }
      }
      u.uSurgeBoxMin.value.set(x0, gMin - 20, z0);
      u.uSurgeBoxMax.value.set(x1, gMax + 1300, z1);
      u.uSurgeSun.value.copy(fr.sun).multiplyScalar(fr.shade);
      u.uSurgeAmb.value.copy(fr.nearAmb).multiplyScalar(3);
    } else {
      u.uSurge.value.w = 0;
    }
  }
}
