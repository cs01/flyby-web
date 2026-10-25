// Moving traffic and parked cars, as instanced boxes with the motion in the
// vertex shader.
//
// WHY THE MOTION IS IN THE VERTEX SHADER. A few thousand cars is a few thousand
// transforms, and rebuilding them on the CPU every frame is both the cost and
// the wrong shape: the buffers would have to be re-uploaded at 60 Hz, which is
// megabytes a second of PCIe for information that is a straight line and a
// clock. Instead an instance carries the two ends of the stretch it drives, a
// phase and a speed, and `fract(phase + uTime * speed / length)` is where it is.
// Nothing is uploaded between rebuilds of the ring, and the ring only rebuilds
// when the camera crosses a 400 m tile.
//
// WHY STRAIGHT RUNS AND NOT THE ROAD GRAPH. data/roadgraph.ts cuts a way at
// every junction another way touches, which is exactly right for driving one
// car under player control and exactly wrong here: the average edge is under a
// hundred metres, so every car in the city would reach the end of its edge and
// vanish every few seconds. data/streetfurniture.ts merges consecutive
// centreline segments into the longest stretches that stay inside a corridor
// about their own chord, and that corridor is bounded by what the carriageway
// can spare after the lane offset and the car's own width. An avenue comes out
// as one run of several hundred metres.
//
// THE ENDS ARE FADED, NOT POPPED. A car reaching the end of its run shrinks to
// nothing over the last few per cent of it and grows back at the start. At the
// distances the ends matter (a junction two hundred metres away) the shrink is
// under a pixel; up close it reads as a car turning off, which is what happens
// at junctions anyway.
//
// AT NIGHT THE LIGHTS ARE THE PRODUCT. From an aircraft a car is two pixels at
// 300 m and a stream of headlights down a boulevard is the strongest "this city
// is alive" signal available. The lamp lenses are therefore emissive well past
// what the tone map can hold, so the bloom in render/composite.ts turns them
// into the streaks they are in a photograph, and the body is allowed to go dark.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL, shHemispherical } from "./sh";
import { AO_GLSL, aoUniforms, type AoUniforms } from "./ao";
import { InstancedField, INSTANCE_GLSL } from "./instanced";
import { buildCarMesh, CAR_ARCHETYPES, CAR_TRIANGLES, LOD_FAR, LOD_SHADOW } from "./carmesh";
import { CAR_BUCKET_HEADROOM, type Budget } from "./budget";
import {
  addParked,
  indexWaysByTile,
  tilesAround,
  STREET_TILE_M,
  type ParkedInstance,
  type StreetWorld,
} from "../data/streetfurniture";
import { RoadClass, ROAD_TUNNEL, type Road, type RoadPack } from "../data/roadpack";
import { CLASS_COUNT, type TrafficState } from "../data/trafficmodel";
import type { RoadGraph } from "../data/roadgraph";
import { TrafficSim, type Pose } from "../sim/trafficsim";
import { GlowPoints, LAMP_FOOTPRINT_GLSL } from "./glowpoints";
import { streetLightUniforms, STREET_LIGHT_GLSL, type StreetLightUniforms } from "./streetlight";

/** A lamp lens, as one size: the root of its 0.42 x 0.19 m area. */
const CAR_LENS_M = 0.28;

/**
 * Where the traffic stops, in metres from the camera.
 *
 * Much further than the parked cars below, and that asymmetry is the whole
 * point: a parked car at 600 m is one dark pixel among the dark pixels of the
 * road it is on, while a moving car at 600 m is a moving pixel, and at night it
 * is a bright one. `chicago-loop-night` is flown from 420 m and looks a
 * kilometre down the grid.
 */
const TRAFFIC_RING_M = 950;
const MOBILE_TRAFFIC_RING_M = 700;
/** Where the parked cars stop. A parked car pays inside the distance a person
 *  could walk, and nowhere else. */
const PARKED_RING_M = 340;
const MOBILE_PARKED_RING_M = 200;

/** Where cars stop being drawn into the shadow cascades. The near cascade is
 *  350 m at 2048, which is 0.17 m a texel: a car casts a real shadow there and
 *  half a texel of noise in the cascade after it. */
const SHADOW_FADE_M = 170;

const FADE_FRACTION = 0.88;


/**
 * Body colours. Measured from what is actually on a street rather than chosen:
 * the world's car fleet is about three quarters white, black, grey and silver,
 * and the coloured quarter is mostly red and blue. A field of evenly random
 * hues is the single loudest tell that a traffic system is procedural.
 */
const BODY_COLOURS: [number, number, number][] = [
  [0.62, 0.62, 0.63], // white
  [0.62, 0.62, 0.63],
  // Black car paint measures four to six per cent diffuse, not three: the
  // three was a guess, and it put a third of the fleet at 7 of 255 against a
  // pavement at 81 whenever the street was in its own shadow. Two slots of it
  // was also too many -- black is about a fifth of the real fleet, not a third
  // -- so the second one is now the dark grey that a lot of "black" cars
  // actually are.
  [0.048, 0.048, 0.051], // black
  [0.088, 0.088, 0.093], // graphite
  [0.125, 0.128, 0.135], // grey
  [0.205, 0.212, 0.222], // silver
  [0.205, 0.212, 0.222],
  [0.155, 0.020, 0.018], // red
  [0.022, 0.040, 0.115], // blue
  [0.030, 0.062, 0.038], // green
  [0.145, 0.100, 0.030], // beige
  [0.095, 0.095, 0.100], // dark grey
];

const PALETTE_GLSL = /* glsl */ `
const int BODY_COLOUR_COUNT = ${BODY_COLOURS.length};
const vec3 BODY_COLOURS[${BODY_COLOURS.length}] = vec3[${BODY_COLOURS.length}](
${BODY_COLOURS.map((c) => `  vec3(${c.map((v) => v.toFixed(4)).join(", ")})`).join(",\n")}
);

vec3 bodyColour(float tint) {
  int i = int(clamp(tint, 0.0, 0.999) * float(BODY_COLOUR_COUNT));
  return BODY_COLOURS[i];
}
`;

/**
 * The shared vertex half.
 *
 * Every car, moving or parked, is a POSE: `iRoute` is (x, z, dirX, dirZ) and
 * `iDrive` is (y, brake 0..1, visible scale 0..1, lights 0..1). The moving
 * field writes it every frame from sim/trafficsim.ts; the parked field writes
 * it once per tile. One layout, so there is no second copy of the placement
 * to drift.
 */
const VERT_COMMON = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec4 aPart;   // see CarMesh.aPart: part id, u, v, axle inset

in vec4 iRoute;  // x, z, unit heading x, unit heading z
in vec4 iDrive;  // y, brake, scale, lights
in vec4 iLook;   // tint 0..1, archetype 0..1, unused, unused

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform vec2 uFade;
/** The distance band this MESH draws in. Two levels of detail share one set of
 *  instances and differ only in which band they answer for; see
 *  InstancedField.derive. */
uniform vec2 uLodBand;

${INSTANCE_GLSL}

struct Placed {
  vec3 world;
  vec2 yawCS;
  bool culled;
};

Placed placeVertex() {
  Placed o;
  o.world = vec3(0.0);
  o.yawCS = vec2(1.0, 0.0);
  o.culled = true;

  vec2 p = iRoute.xy;
  float y = iDrive.x;
  float dist = distance(vec3(p.x, y, p.y), uCameraPos);
  if (dist < uLodBand.x || dist >= uLodBand.y) return o;
  float ringFade = 1.0 - smoothstep(uFade.x, uFade.y, dist);
  // The sim's own scale: grown in on spawn, shrunk out when the hour thins
  // the street or the car leaves the populated ring.
  float fade = ringFade * iDrive.z;
  if (fade <= 0.0) return o;

  o.culled = false;
  // instanceToWorld maps local +x to (cos yaw, -sin yaw), so a heading given
  // as a direction in the xz plane becomes (dir.x, -dir.z) with no
  // trigonometry at all.
  o.yawCS = vec2(iRoute.z, -iRoute.w);
  // Scaled about the car's own middle, which is where its origin already is
  // horizontally; the vertical origin is the road, so a shrinking car sinks
  // into it rather than floating.
  o.world = instanceToWorld(position * fade, vec3(p.x, y, p.y), o.yawCS, vec3(1.0));
  return o;
}
`;

const VERT = /* glsl */ `
${VERT_COMMON}
out vec3 vNormal;
out vec3 vWorld;
// FLAT, not interpolated. The body and the greenhouse meet on a grid line of
// the loft, so a triangle is wholly one or the other -- but only if the id
// stops being averaged across it. Interpolated, the belt row came out as a
// smear of fractional ids that every step() test below reads as neither.
flat out float vPartId;
out vec3 vPartUv;
out vec4 vLook; // tint, archetype, brake, lights
out float vViewDist;

void main() {
  Placed pl = placeVertex();
  if (pl.culled) { gl_Position = INSTANCE_CULLED; return; }
  vNormal = instanceRotate(normal, pl.yawCS);
  vWorld = pl.world;
  vPartId = aPart.x;
  vPartUv = aPart.yzw;
  vLook = vec4(iLook.xy, iDrive.y, iDrive.w);
  vViewDist = distance(pl.world, uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pl.world, 1.0);
}
`;

const DEPTH_VERT = /* glsl */ `
${VERT_COMMON}
void main() {
  Placed pl = placeVertex();
  gl_Position = pl.culled ? INSTANCE_CULLED
              : projectionMatrix * modelViewMatrix * vec4(pl.world, 1.0);
}
`;

const DEPTH_FRAG = /* glsl */ `precision highp float;
out vec4 c;
void main() { c = vec4(1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
flat in float vPartId;
in vec3 vPartUv;
in vec4 vLook;
in float vViewDist;
out vec4 fragColor;

// Three steps, not the seven every other surface uses. Aerial perspective is
// an integral along the ray, a car is 4.6 m long and the field ends at 1.5 km,
// so the thing being integrated barely varies over the object; the extra steps
// buy nothing and this shader runs on the most instances in the frame.
#define ATMO_STEPS 3
#define ATMO_SUN_STEPS 1
${ATMOSPHERE_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}
${PALETTE_GLSL}
${LAMP_FOOTPRINT_GLSL}
${STREET_LIGHT_GLSL}
const float LENS_M = ${CAR_LENS_M.toFixed(2)};

uniform vec3  uCameraPos;
uniform float uSunSurface;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uNight;
uniform vec3  uNightGlow;

void main() {
  vec3 n = normalize(vNormal);
  float part = vPartId;
  float u = vPartUv.x;    // 0 at the tail of this part, 1 at its nose
  float v = vPartUv.y;    // up the part; wheel diameters on a body panel
  float belt = vPartUv.z; // the beltline, in the same wheel diameters as v
  vec3 body = bodyColour(vLook.x);

  // Which part this is. Four ranges on one id rather than four materials,
  // because four materials is four draw calls per archetype per field.
  float isGlass = step(0.5, part) * step(part, 1.5);
  float isHead  = step(1.5, part) * step(part, 2.5);
  float isTail  = step(2.5, part) * step(part, 3.5);
  float isWheel = step(3.5, part) * step(part, 4.5);
  float isUnder = step(4.5, part) * step(part, 5.5);
  float isPlate = step(5.5, part);
  // A flank, as against a roof, a nose or a tail. Everything below that is
  // drawn rather than modelled -- the arches, the shut lines, the posts --
  // belongs on a flank and nowhere else.
  float flank = step(0.55, abs(n.z));

  // How much of the part one pixel covers. Everything drawn on the paint has
  // to dissolve before it goes sub-pixel: three door posts alternating with
  // three panes of glass across nine pixels is a checkerboard, and a street of
  // parked cars a hundred metres off is exactly where that happens. The same
  // rule the road markings already follow.
  float px = max(fwidth(u), fwidth(v));
  float detail = 1.0 - smoothstep(0.020, 0.075, px);

  vec3 albedo = body;
  // How much of this fragment is actually GLAZING, as against a painted part of
  // the cabin box. Only glazing gets the mirror term below, which is the whole
  // difference between a window and a black panel.
  float glazed = 0.0;
  // Clearcoat, on paint and glass, absent on rubber.
  float gloss = 0.55;

  if (isGlass > 0.5) {
    // The cabin is one box, so the roof and the posts have to be found rather
    // than modelled. The roof is the face pointing up. The posts are three
    // bands across the flank: the A post ahead of the windscreen, the C post
    // behind the rear quarter, and a B post at the door shut. Between them is
    // glass, and it is that alternation -- not the shape of the box -- that
    // makes a cabin read as a cabin.
    float post = max(smoothstep(0.16, 0.06, u), smoothstep(0.84, 0.94, u));
    post = max(post, (1.0 - smoothstep(0.0, 0.045, abs(u - 0.52)))
                     * step(0.30, u) * step(u, 0.74));
    // A BACKSTOP, NOT THE ROOF TEST. The roof is decided in carmesh.ts, where
    // both the section and the PROFILE are known: the roof panel is the run of
    // stations whose topLine is at the top of the cabin, and only there are the
    // cap rows tagged metal. Nothing that reaches here is roof by construction.
    //
    // This used to be smoothstep(0.30, 0.62, n.y) and be the only thing
    // deciding it, which measured 93-97% of the glass AREA on all four
    // archetypes painted body colour: the greenhouse tumbles home so hard that
    // its smoothed normals point mostly upward, so the test called almost the
    // whole window a roof. A tightened version still painted out the backlight,
    // which lies at 19 degrees on a saloon and reads n.y = 0.945 -- a rear
    // window is not a roof at any angle, and no threshold on n.y can tell the
    // two apart because on this body they are the same number.
    //
    // What is left is a guard for a cabin whose top is genuinely FLAT, which no
    // archetype has today and one added later might. It is deliberately narrow
    // enough that nothing currently in CAR_ARCHETYPES reaches it, and
    // test/carmesh.check.ts reads this line and measures that.
    float roof = smoothstep(0.985, 0.999, n.y);
    // Aft of where the glazing ends, u goes negative and the panel is metal on
    // EVERY face, not just the flanks: the back of a van is a door, not a
    // window. A car's cabin is glazed to its own back edge and never reaches
    // here, which is why the ramp starts below zero rather than at it.
    float behind = 1.0 - smoothstep(-0.10, -0.02, u);
    float painted = max(max(roof, behind), flank * post * detail);
    // The rubber at the bottom edge of the glazing, and the black frit band a
    // real windscreen is bonded through.
    float seal = 1.0 - smoothstep(0.02, 0.075, v);
    glazed = (1.0 - painted) * (1.0 - seal);
    albedo = mix(vec3(0.016, 0.018, 0.022), body, painted);
    albedo = mix(albedo, vec3(0.010, 0.010, 0.011), seal * (1.0 - painted));
    // Roll the clearcoat off as the glass lies down, rather than painting the
    // glass out to avoid the blow-out. A window near horizontal is looking
    // straight into the sky at a Fresnel of nearly 1, and the section rows
    // print across it as teeth; a window standing up is the one you can see
    // into. Same defect the old roof test was really treating, treated where it
    // is instead of by deleting the part.
    gloss = mix(0.92, 0.55, painted) * mix(1.0, 0.45, smoothstep(0.55, 0.88, n.y));
  } else if (isWheel > 0.5) {
    // v is the RADIUS on a wheel's outboard face and exactly 1 across its
    // tread, so one number draws the tyre wall, the rim and the hub without a
    // second part id, a texture, or a branch on the normal.
    //
    // A rim matters out of all proportion to its size. A wheel is the one part
    // of a car with a bright thing in the middle of a dark thing, and a car
    // with four black discs where its wheels are reads as a toy however good
    // the paint is.
    // Read as an ANNULUS, not a disc. A wheel painted as one bright circle is
    // a whitewall on a 1950s tyre; a real alloy is a narrow bright lip at the
    // tyre bead, a duller spoke face inside it, and a dark hub in the middle,
    // and those three bands in that order are what the eye recognises without
    // ever resolving a spoke. Radial bands only, so none of this needs an
    // angle, which the fan does not carry.
    float lip   = smoothstep(0.50, 0.58, v) * (1.0 - smoothstep(0.62, 0.69, v));
    float face  = (1.0 - smoothstep(0.50, 0.58, v)) * smoothstep(0.14, 0.21, v);
    float hub   = 1.0 - smoothstep(0.14, 0.21, v);
    albedo = vec3(0.013, 0.013, 0.014);                            // tyre
    albedo = mix(albedo, vec3(0.150, 0.154, 0.162), face * detail); // spoke face
    albedo = mix(albedo, vec3(0.38, 0.39, 0.41), lip * detail);     // bead lip
    albedo = mix(albedo, vec3(0.040, 0.040, 0.043), hub * detail);  // hub
    gloss = 0.40 * (lip + face) * detail;
  } else if (isPlate > 0.5) {
    // A number plate, on its own uv: 0..1 across the plate rather than along
    // the car. Four triangles that punch far above their weight -- a bright
    // rectangle low on a dark end is one of the very few marks the eye reads
    // as "road vehicle" with nothing else to go on.
    float border = min(min(u, 1.0 - u), min(v, 1.0 - v));
    albedo = mix(vec3(0.045, 0.045, 0.050), vec3(0.60, 0.585, 0.505),
                 smoothstep(0.05, 0.11, border));
    // Seven characters, and deliberately not text: the eye reads the CADENCE
    // of a plate long before it reads a glyph, and a glyph at this size is
    // three pixels of noise. Fades out with everything else drawn.
    float cell = fract(u * 7.0);
    float glyph = step(0.22, cell) * step(cell, 0.78)
                * step(0.30, v) * step(v, 0.72);
    albedo = mix(albedo, vec3(0.030, 0.030, 0.035), glyph * detail);
    gloss = 0.30;
  } else if (isUnder > 0.5) {
    // The tub behind the arches. Flat and dark, and deliberately NOT the wheel
    // material: it must never grow a rim.
    albedo = vec3(0.014, 0.014, 0.015);
    gloss = 0.0;
  } else if (isHead > 0.5) {
    albedo = vec3(0.52, 0.50, 0.46);
    gloss = 0.9;
  } else if (isTail > 0.5) {
    albedo = vec3(0.28, 0.030, 0.024);
    gloss = 0.9;
  } else {
    // A painted panel, and everything drawn on it.
    //
    // The arch is cut into the loft itself now -- bottomLine simply rises at
    // each axle -- so nothing is painted here. What IS painted is the shoulder
    // crease along the beltline, which on a real car is a hard edge in sheet
    // metal and here is a line the loft is too coarse to carry.
    float crease = flank * (1.0 - smoothstep(0.0, 0.055, abs(v - belt))) * detail;
    albedo *= mix(1.0, 0.74, crease);

    // Panel shut lines: the door edges, and the gap at each end of the doors.
    // Two texels wide wherever they are resolved at all, and gone the moment
    // they are not, so a car at fifty metres does not shimmer.
    float shutU = min(abs(u - 0.34), abs(u - 0.62));
    float shut = flank * (1.0 - smoothstep(0.004, 0.010, shutU))
              * smoothstep(0.55, 0.75, v) * detail;
    albedo *= mix(1.0, 0.34, shut);

    // A rubbing strip along the flank at bumper height, and the dirt every car
    // carries up from the sill. Both darken the bottom of the panel, which is
    // what stops a white car reading as a sheet of paper.
    albedo *= mix(0.66, 1.0, smoothstep(0.10 * belt, 0.80 * belt, v));
    gloss = 0.62;
  }
  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunT;
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 ambient = occludedSkyIrradiance(n);
  vec3 moon = uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));

  vec3 lit = albedo * (sunE * ndl * sunVis + ambient + moon);

  // The specular is what makes a painted panel read as a painted panel. Sharp
  // on the body, sharper on the glass, absent on the wheels; set with the
  // albedo above, because which part it is decides both.
  if (gloss > 0.01) {
    vec3 vdir = normalize(uCameraPos - vWorld);
    vec3 hv = normalize(vdir + uSunDir);
    // A glint, not a flare. An exponent of 90 over a lofted windscreen puts the
    // whole lobe inside one or two triangles, so the TRIANGULATION shows
    // through it as a sawtooth of blown white along the glass -- the highlight
    // is narrower than the surface that carries it. Widening the lobe and
    // capping what it can add keeps the glint and loses the staircase.
    float spec = pow(max(0.0, dot(n, hv)), 48.0) * gloss * 1.25;
    lit += uSunColor * uSunIntensity * uSunSurface * sunT * sunVis * min(spec, 3.0);
    // The sky in the paint. A car with no environment term is a matt car, and
    // matt cars are what a hundred cheap driving games look like.
    //
    // From the SH probe rather than from the prefiltered cube, which the wet
    // road beside it does use. A car panel is a few hundred pixels at most and
    // curved enough that its reflection is a smear of sky rather than a
    // picture of the skyline; the second-order sky is that smear, for nine
    // multiply-adds instead of a filtered cube fetch on the shader that runs on
    // more instances than anything else in the frame.
    vec3 refl = reflect(-vdir, n);
    // Schlick, against the SH probe's own convention: shIrradiance returns
    // pi * L for a constant environment, and a MIRROR wants L, so the fetch is
    // divided by pi before the Fresnel weight is applied. Getting that wrong is
    // not a subtle error on glass: a windscreen has an albedo of 0.02 and every
    // bit of its brightness is this term, so an under-weighted reflection does
    // not make the glass slightly dark, it makes it black. It did, until the
    // weight stopped being an eyeballed 0.045.
    float cosv = clamp(dot(vdir, n), 0.0, 1.0);
    // Flat glass takes Schlick exactly, because a windscreen IS flat. Sheet
    // metal does not, and the reason is the model rather than the physics: a
    // real wing is curved, so a real flank shows the sky over a whole spread of
    // incidences at once and never at only the one this flat quad has. A softer
    // exponent over a raised floor is that spread. Without it a black car is a
    // black rectangle -- 7 of 255 against a pavement at 81 -- because 3% paint
    // under a 4% head-on Fresnel has nowhere to get any light from.
    float fGlass = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
    float fPaint = 0.075 + 0.60 * pow(1.0 - cosv, 3.0);
    // Capped. A mirror at grazing incidence really does return the whole sky,
    // and on a windscreen a few hundred pixels across that is a white hole
    // rather than a reflection.
    vec3 mirror = shIrradiance(refl) * 0.31831 * mix(fPaint, fGlass, glazed) * gloss;
    lit += min(mirror, vec3(0.9));
  }

  lit += albedo * uNightGlow * uNight * 0.6;
  // Under a street lamp, or in the player's headlights.
  lit += albedo * streetLight(vWorld, n);

  // The lamps. Emissive far past white so the bloom pass makes streaks of them;
  // this is the single biggest thing in the frame at night from the air, and it
  // is two triangles per lamp.
  //
  // Tail lights are on whenever the headlights are, and the reason they read so
  // differently is geometry: you see the fronts of the oncoming stream and the
  // backs of the one going away, so a boulevard splits into a white river and a
  // red one. That happens by itself here, from the direction the cars face.
  //
  // Lights are per INSTANCE (1 moving, 0 parked): a street of parked cars with
  // headlights blazing is a car park at a drive-in rather than a street.
  float lights = vLook.w;
  float brake = vLook.z;
  // Only while the lens is a few pixels across: past that its light is a
  // stable point in render/glowpoints.ts, because a sub-pixel lens quad at
  // seven times white is exactly the twinkle the owner reported.
  float on = uNight * lights * lampMeshWeight(LENS_M, vViewDist);
  lit += vec3(1.0, 0.94, 0.82) * isHead * on * 7.0;
  // A brake lamp is about five times a tail lamp (FMVSS 108 puts the stop
  // function at 80-300 cd against 2-18 for the tail), so a queue pulling up at
  // a red reads as a red wave down the street. Daytime too: brake lamps are
  // not a night thing.
  lit += vec3(1.0, 0.10, 0.045) * isTail * (on * (3.5 + 9.0 * brake) + lights * brake * (1.0 - uNight) * 2.5);
  // Daytime running lamps, dim, so a car in a shadowed canyon at noon still has
  // a point of light where its lamps are.
  lit += vec3(1.0, 0.96, 0.90) * isHead * lights * (1.0 - uNight) * 0.20;

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export interface TrafficUniforms extends SunShadowUniforms, AoUniforms, StreetLightUniforms {
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uSH: THREE.IUniform<Float32Array>;
  uFade: THREE.IUniform<THREE.Vector2>;
  uLodBand: THREE.IUniform<THREE.Vector2>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
  uPixelAngle: THREE.IUniform<number>;
}

function makeTrafficUniforms(shadow: SunShadowUniforms, ringM: number): TrafficUniforms {
  return {
    ...shadow,
    ...aoUniforms(),
    ...streetLightUniforms,
    uCameraPos: { value: new THREE.Vector3() },
    uSH: { value: shHemispherical([0.28, 0.36, 0.5], 0.55, 0.45) },
    uFade: { value: new THREE.Vector2(ringM * FADE_FRACTION, ringM) },
    uLodBand: { value: new THREE.Vector2(0, 1e9) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSunIntensity: { value: 22 },
    uSunSurface: { value: 0.105 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonLight: { value: new THREE.Color(0, 0, 0) },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uMieG: { value: 0.76 },
    uTurbidity: { value: 1 },
    uCamAltitude: { value: 100 },
    uMultiScatter: { value: 0.055 },
    uPixelAngle: { value: 0.0015 },
  };
}

export interface CarFieldStats {
  indexedTiles: number;
  tiles: number;
  count: number;
  triangles: number;
  clipped: number;
  lastBuildMs: number;
  worstBuildMs: number;
  rebuilds: number;
  /** Instances at each archetype, saloon first. */
  byArchetype: number[];
}

/** One (archetype) bucket: a base mesh and the instances currently on it. */
interface Bucket {
  archetype: number;
  field: InstancedField;
  triangles: number;
  count: number;
}

/** Floats per instance in the flat form: iRoute (4), iDrive (4), iLook (4). */
const STRIDE = 12;

/**
 * The common machinery of the two fields: the mesh, the shaders, the archetype
 * buckets and the budget accounting. Where the instances come from is the
 * subclass's business.
 */
abstract class CarField {
  readonly group = new THREE.Group();
  readonly depthScene = new THREE.Scene();
  readonly uniforms: TrafficUniforms;
  readonly stats: CarFieldStats = {
    indexedTiles: 0, tiles: 0, count: 0, triangles: 0, clipped: 0,
    lastBuildMs: 0, worstBuildMs: 0, rebuilds: 0,
    byArchetype: CAR_ARCHETYPES.map(() => 0),
  };

  protected readonly ringM: number;
  private readonly buckets: Bucket[] = [];

  constructor(shadow: SunShadowUniforms, capacity: number, ringM: number) {
    this.ringM = ringM;
    this.uniforms = makeTrafficUniforms(shadow, ringM);

    // ONE MESH, AND THE RING IS WHAT PAYS FOR IT.
    //
    // A distance LOD was tried here and backed out, and the reason is worth
    // keeping: two meshes over one instance buffer, each culling the other's
    // band in the vertex shader, does NOT save the vertex work. The shader
    // still runs for every instance of both meshes and only then discards, so
    // the fine body cost its full vertex rate over all five thousand cars and
    // the frame went from 11.7 ms to 26.3.
    const beauty = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
    });
    // A car stops casting a useful shadow long before it stops being visible;
    // the same argument render/trees.ts makes about its crowns, at a tenth of
    // the size. Everything else is shared by reference.
    const depthUniforms = {
      ...this.uniforms,
      uFade: { value: new THREE.Vector2(SHADOW_FADE_M * 0.85, SHADOW_FADE_M) },
    };
    const depthMat = new THREE.RawShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms: depthUniforms,
      glslVersion: THREE.GLSL3,
      colorWrite: false,
    });

    // Capacity is split evenly BUT WITH HEADROOM: the archetype is a hash, so
    // the buckets fill at nearly the same rate and an even split clips half of
    // them. See CAR_BUCKET_HEADROOM, which the memory estimate counts as well.
    const per = Math.max(
      64,
      Math.ceil((capacity * CAR_BUCKET_HEADROOM) / CAR_ARCHETYPES.length),
    );
    for (let a = 0; a < CAR_ARCHETYPES.length; a++) {
      const toGeometry = (m: ReturnType<typeof buildCarMesh>): THREE.BufferGeometry => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(m.normal, 3));
        g.setAttribute("aPart", new THREE.BufferAttribute(m.aPart, 4));
        g.setIndex(new THREE.BufferAttribute(m.index, 1));
        return g;
      };
      const far = buildCarMesh(a, LOD_FAR);
      const field = new InstancedField(toGeometry(far), per, [
        { name: "iRoute", itemSize: 4 },
        { name: "iDrive", itemSize: 4 },
        { name: "iLook", itemSize: 4 },
      ]);
      this.buckets.push({ archetype: a, field, triangles: far.triangles, count: 0 });

      const drawn = new THREE.Mesh(field.geometry, beauty);
      drawn.frustumCulled = false;
      this.group.add(drawn);

      // THE CASTER GETS ITS OWN, MUCH COARSER BODY, sharing the same
      // instances: a car is drawn five times (picture, three cascades, the AO
      // prepass) and four of those only need a silhouette. Drawing the lofted
      // body into all five cost 23.6 ms a frame against 11.7 before it.
      const caster = new THREE.Mesh(field.derive(toGeometry(buildCarMesh(a, LOD_SHADOW))), depthMat);
      caster.frustumCulled = false;
      caster.layers.enable(SHADOW_CASTER_LAYER);
      this.depthScene.add(caster);
    }
  }

  /** Start a fill: every bucket empty. */
  protected begin(): void {
    for (const b of this.buckets) b.count = 0;
    this.stats.clipped = 0;
  }

  /** Append one instance, flat, at `flat[i .. i + STRIDE)`. */
  protected push(flat: ArrayLike<number>, i: number): boolean {
    // The archetype is iLook.y, hashed at placement time.
    const a = Math.min(CAR_ARCHETYPES.length - 1, Math.floor(flat[i + 9] * CAR_ARCHETYPES.length));
    const bucket = this.buckets[a];
    if (bucket.count >= bucket.field.capacity) { this.stats.clipped++; return false; }
    const p4 = bucket.count * 4;
    const route = bucket.field.arrays.iRoute;
    const drive = bucket.field.arrays.iDrive;
    const look = bucket.field.arrays.iLook;
    for (let k = 0; k < 4; k++) {
      route[p4 + k] = flat[i + k];
      drive[p4 + k] = flat[i + 4 + k];
      look[p4 + k] = flat[i + 8 + k];
    }
    bucket.count++;
    return true;
  }

  /** Publish the fill to the GPU. */
  protected end(): void {
    let triangles = 0;
    let count = 0;
    for (const b of this.buckets) {
      b.field.upload(b.count);
      triangles += b.count * b.triangles;
      count += b.count;
      this.stats.byArchetype[b.archetype] = b.count;
    }
    this.stats.count = count;
    this.stats.triangles = triangles;
  }

  dispose(): void {
    for (const b of this.buckets) b.field.dispose();
    this.group.clear();
    this.depthScene.clear();
  }
}

/**
 * The moving traffic, from sim/trafficsim.ts.
 *
 * WHY EVERY FRAME. The sim moves every car every frame, and the pose is 48
 * bytes: at the desktop budget's measured few thousand cars in the ring that
 * is ~100-150 kB a frame through a DynamicDraw buffer, against the analytic
 * vertex-shader motion it replaced, which could not stop for a light, follow a
 * car or turn a corner.
 */
export class Traffic extends CarField {
  readonly sim: TrafficSim;
  /** The lamps as stable points once they are under a few pixels. */
  readonly glow: GlowPoints;
  /** The player's car, drawn with the traffic, or null when not driving. */
  player: { x: number; y: number; z: number; headingDeg: number; braking: boolean } | null = null;
  private readonly flat = new Float32Array(STRIDE);
  private readonly pose: Pose = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 };

  constructor(graph: RoadGraph, world: StreetWorld, shadow: SunShadowUniforms, budget: Budget) {
    const mobile = budget.tier === "reduced";
    super(shadow, budget.trafficInstanceBudget, mobile ? MOBILE_TRAFFIC_RING_M : TRAFFIC_RING_M);
    this.sim = new TrafficSim(
      {
        graph,
        heightAt: world.groundY,
        deckOf: world.deckOf ?? null,
      },
      budget.trafficInstanceBudget,
    );
    // A phone gets fewer cars as well as a shorter ring, because the ring
    // alone would leave the near field as dense as a desktop's and the near
    // field is where the fragments are.
    this.sim.densityScale = mobile ? 0.55 : 1;
    this.stats.indexedTiles = 0;
    this.glow = new GlowPoints(budget.trafficInstanceBudget * 4, this.ringM);
    this.group.add(this.glow.points);
  }

  /**
   * Advance the traffic by `dt` seconds of scene time and redraw it.
   *
   * `dt` is the delta of the animation clock, which `?shot` holds at zero, so
   * a pinned pose photographs the field exactly as it was placed.
   */
  update(camX: number, camZ: number, dt: number, state: TrafficState | null): void {
    const t0 = performance.now();
    if (state) {
      for (let c = 0; c < CLASS_COUNT; c++) {
        this.sim.frac[c] = state.frac[c];
        this.sim.speedScale[c] = state.speed[c];
      }
    }
    const before = this.sim.stats.activeEdges;
    this.sim.setRing(camX, camZ, this.ringM);
    if (this.sim.stats.activeEdges !== before) this.stats.rebuilds++;
    this.sim.step(dt);

    this.begin();
    const f = this.flat;
    const p = this.pose;
    const glow = this.glow;
    glow.begin();
    for (const c of this.sim.cars) {
      if (c.scale <= 0.001) continue;
      this.sim.pose(c, p);
      if (this.glow.uniforms.uNight.value > 0.02) {
        const a = CAR_ARCHETYPES[Math.min(CAR_ARCHETYPES.length - 1, Math.floor(c.archetype * CAR_ARCHETYPES.length))];
        const half = a.lengthM * 0.5 * c.scale;
        const side = a.widthM * 0.31 * c.scale;
        const y = p.y + a.beltM * 0.62 * c.scale;
        const rx = -p.dirZ, rz = p.dirX;
        const head = 7.0;
        const tail = 3.5 + 9.0 * c.brake;
        for (const sgn of [-1, 1]) {
          glow.push(p.x + p.dirX * half + rx * side * sgn, y, p.z + p.dirZ * half + rz * side * sgn,
            p.dirX, p.dirZ, CAR_LENS_M, head, 1.0, 0.94, 0.82);
          glow.push(p.x - p.dirX * half + rx * side * sgn, y, p.z - p.dirZ * half + rz * side * sgn,
            -p.dirX, -p.dirZ, CAR_LENS_M, tail, 1.0, 0.10, 0.045);
        }
      }
      f[0] = p.x; f[1] = p.z; f[2] = p.dirX; f[3] = p.dirZ;
      f[4] = p.y; f[5] = c.brake; f[6] = c.scale; f[7] = 1;
      f[8] = c.tint; f[9] = c.archetype; f[10] = c.cls; f[11] = c.rank;
      this.push(f, 0);
    }
    if (this.player) {
      // A red saloon (palette slot 7 of 12), lights on, brake lamps from the
      // car's own deceleration. Its origin is the contact patch, like every
      // other car's, so the bonnet sits where the driver's seat says.
      const h = (this.player.headingDeg * Math.PI) / 180;
      f[0] = this.player.x; f[1] = this.player.z; f[2] = Math.sin(h); f[3] = -Math.cos(h);
      f[4] = this.player.y; f[5] = this.player.braking ? 1 : 0; f[6] = 1; f[7] = 1;
      f[8] = 7.5 / 12; f[9] = 0.01; f[10] = 0; f[11] = 0;
      this.push(f, 0);
    }
    this.end();
    glow.end();
    this.stats.tiles = this.sim.stats.activeEdges;
    this.stats.lastBuildMs = performance.now() - t0;
    this.stats.worstBuildMs = Math.max(this.stats.worstBuildMs, this.stats.lastBuildMs);
  }
}

/** True for a way that can have cars parked along it. `addParked` makes the
 *  real decision from the width; this only keeps obvious non-streets out of
 *  the tile index. */
function parkable(r: Road): boolean {
  return (r.flags & ROAD_TUNNEL) === 0 && r.cls < RoadClass.Pedestrian;
}

/** The parked cars: placed per 400 m tile, cached, re-laid when the camera
 *  crosses a tile. They do not move, so nothing is uploaded between rebuilds. */
export class ParkedCars extends CarField {
  private readonly pack: RoadPack;
  private readonly world: StreetWorld;
  private readonly byTile: Map<string, number[]>;
  private readonly cache = new Map<string, Float32Array>();
  private atX = Number.NaN;
  private atZ = Number.NaN;

  constructor(pack: RoadPack, world: StreetWorld, shadow: SunShadowUniforms, budget: Budget) {
    const mobile = budget.tier === "reduced";
    super(shadow, budget.parkedInstanceBudget, mobile ? MOBILE_PARKED_RING_M : PARKED_RING_M);
    this.pack = pack;
    this.world = world;
    this.byTile = indexWaysByTile(pack.roads, parkable);
    this.stats.indexedTiles = this.byTile.size;
  }

  private place(ways: readonly number[]): Float32Array {
    const cars: ParkedInstance[] = [];
    for (const i of ways) addParked(cars, this.pack.roads[i], i, this.world);
    const out = new Float32Array(cars.length * STRIDE);
    for (let k = 0; k < cars.length; k++) {
      const c = cars[k];
      const p = k * STRIDE;
      const th = c.yawTurns * Math.PI * 2;
      // yawCS = (cos th, sin th) = (dir.x, -dir.z); see placeVertex.
      out[p] = c.x;
      out[p + 1] = c.z;
      out[p + 2] = Math.cos(th);
      out[p + 3] = -Math.sin(th);
      out[p + 4] = c.y;
      out[p + 5] = 0;
      out[p + 6] = 1;
      out[p + 7] = 0;
      out[p + 8] = c.tint;
      out[p + 9] = c.archetype;
      out[p + 10] = -1;
      out[p + 11] = 0;
    }
    return out;
  }

  update(camX: number, camZ: number): void {
    const tx = Math.floor(camX / STREET_TILE_M);
    const tz = Math.floor(camZ / STREET_TILE_M);
    if (tx === this.atX && tz === this.atZ) return;
    this.atX = tx;
    this.atZ = tz;

    const t0 = performance.now();
    const wanted = tilesAround(this.byTile, camX, camZ, this.ringM);
    const keep = new Set<string>();
    this.begin();
    for (const w of wanted) {
      let flat = this.cache.get(w.key);
      if (!flat) {
        flat = this.place(this.byTile.get(w.key) ?? []);
        this.cache.set(w.key, flat);
      }
      keep.add(w.key);
      for (let i = 0; i + STRIDE <= flat.length; i += STRIDE) this.push(flat, i);
    }
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
    this.end();
    this.stats.tiles = keep.size;
    this.stats.lastBuildMs = performance.now() - t0;
    this.stats.worstBuildMs = Math.max(this.stats.worstBuildMs, this.stats.lastBuildMs);
    this.stats.rebuilds++;
  }
}

export { CAR_TRIANGLES };
