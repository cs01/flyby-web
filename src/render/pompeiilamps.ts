// Pompeii by lamplight: the lamps of data/pompeiilamps.ts drawn as fittings,
// as flames, and as light on the town.
//
// Light. The town shader (render/pompeii.ts) already lights itself from the
// eruption's carried lamp and torches through pointLamp(); this adds a second
// uniform array beside those, the oil lamps nearest the camera, picked here
// each frame by brightness over distance and capped per tier, so a pixel pays
// for at most OIL_LIGHTS_MAX lamps however many burn in the town. A lamp
// leaving the set has already faded to nothing: the weakest chosen lamps are
// faded by how close they are to the cut.
//
// The flat night glow the town had (every shop recess warm, a uniform sky glow
// on every wall) is switched off while this runs: those were stand-ins for
// lamps, and a Roman street had no sky glow to fill it.
//
// Cost: the fittings are instanced, two levels of detail, only the ones near
// the camera; the flames are one additive instanced draw; the lights are a
// loop of at most 32 (16 on a phone) in the town's fragment shader.
// Kill switch `?off=pompeiilamps`.

import * as THREE from "three";
import type { PompeiiData } from "../data/pompeii";
import { LampKind, LAMP_KINDS, flameOffsets, flicker, jitter, lampLevel, placeLamps, lampCensus, type Lamp, type LampSites } from "../data/pompeiilamps";
import { POMPEII_FRAG, type PompeiiUniforms } from "./pompeii";
import { OIL_REACH_M, buildOilGrid, townLampUniforms } from "./oillight";
import { buildStatue, scanStatue, statueScansReady } from "./statues";

/** Per tier: lights in the shader, flame sprites, fittings drawn and how far. */
export const LAMP_TIERS = {
  full: { lights: 32, glows: 640, fittings: 360, nearM: 22, farM: 110 },
  lean: { lights: 16, glows: 128, fittings: 120, nearM: 14, farM: 50 },
} as const;
export type LampTier = (typeof LAMP_TIERS)[keyof typeof LAMP_TIERS];

/**
 * Lamp power to shader units. An oil flame is about one candela: bright at
 * arm's length, a few metres on it is down at the starlight. 0.4 leaves a
 * pool of four or five metres round each lamp at the night exposure.
 */
const LIGHT_GAIN = 0.4;

// --- the fittings' geometry, in the town's vertex format -------------------

/** The town shader's surface styles used here (render/pompeiimesh.ts Surf, plus bronze). */
const STYLE = { terracotta: 9, stucco: 4, marble: 11, horn: 4, bronze: 17 } as const;
type RGB = [number, number, number];
const TERRACOTTA: RGB = [0.6, 0.32, 0.19];
const BRONZE: RGB = [0.46, 0.32, 0.16];
const DARK_BRONZE: RGB = [0.26, 0.2, 0.12];

interface Part { g: THREE.BufferGeometry; rgb: RGB; style: number; smooth?: boolean }

class Parts {
  readonly list: Part[] = [];
  add(g: THREE.BufferGeometry, rgb: RGB, style: number, m?: THREE.Matrix4, smooth = false): this {
    if (m) g.applyMatrix4(m);
    this.list.push({ g, rgb, style, smooth });
    return this;
  }
  at(g: THREE.BufferGeometry, rgb: RGB, style: number, x: number, y: number, z: number): this {
    g.translate(x, y, z);
    return this.add(g, rgb, style);
  }
  /** Everything as one non-indexed geometry with the town's attributes. */
  build(): THREE.BufferGeometry {
    const pos: number[] = [], an: number[] = [], ac: number[] = [], as: number[] = [];
    for (const p of this.list) {
      const ng = p.g.index ? p.g.toNonIndexed() : p.g;
      // A smooth part (a lofted body) brings its own normals; the rest are faceted.
      if (!p.smooth) ng.computeVertexNormals();
      const P = ng.getAttribute("position").array as Float32Array, N = ng.getAttribute("normal").array as Float32Array;
      // A part may bring its own colours (a statue's patina).
      const Cv = ng.getAttribute("color")?.array as Float32Array | undefined;
      for (let i = 0; i < P.length / 3; i++) {
        pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        an.push(Math.round(N[i * 3] * 127), Math.round(N[i * 3 + 1] * 127), Math.round(N[i * 3 + 2] * 127), 0);
        if (Cv) ac.push(Cv[i * 3] * 255, Cv[i * 3 + 1] * 255, Cv[i * 3 + 2] * 255, 128);
        else ac.push(p.rgb[0] * 255, p.rgb[1] * 255, p.rgb[2] * 255, 128);
        as.push(p.style, 0, 0, 0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("aNormal", new THREE.BufferAttribute(new Int8Array(an), 4, true));
    g.setAttribute("aColour", new THREE.BufferAttribute(new Uint8Array(ac), 4, true));
    g.setAttribute("aSurf", new THREE.BufferAttribute(new Uint8Array(as), 4, false));
    g.setAttribute("aWall", new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
    g.computeBoundingSphere();
    return g;
  }
}

const lathe = (pts: [number, number][], seg: number): THREE.BufferGeometry => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

/** A rod from a to b. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, seg: number): THREE.BufferGeometry {
  const L = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/**
 * A lucerna, base at the origin, nozzle toward +x: the mould-made round
 * body with a sunk discus and its filling hole, the nozzle, a ring handle.
 * Bronze ones (on the stands and in the lampbearer's hand) are the same shape.
 */
function lucerna(P: Parts, rgb: RGB, style: number, ox: number, oy: number, oz: number, seg: number, nozzles = 1): void {
  P.at(lathe([[0, 0], [0.03, 0], [0.047, 0.014], [0.05, 0.026], [0.045, 0.037], [0.036, 0.04], [0.031, 0.034], [0, 0.031]], seg), rgb, style, ox, oy, oz);
  const zs = nozzles > 1 ? [-0.025, 0.025] : [0];
  for (const z of zs) {
    // The nozzle: a short spout and its rounded end with the wick hole.
    P.add(rod(new THREE.Vector3(ox + 0.03, oy + 0.024, oz + z), new THREE.Vector3(ox + 0.082, oy + 0.03, oz + z), 0.014, 0.012, Math.max(5, seg / 2)), rgb, style);
    P.at(new THREE.CylinderGeometry(0.016, 0.016, 0.02, Math.max(6, seg / 2)), rgb, style, ox + 0.086, oy + 0.028, oz + z);
    P.at(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 5), [0.08, 0.06, 0.05], style, ox + 0.088, oy + 0.039, oz + z);
  }
  P.at(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 6), [0.1, 0.07, 0.05], style, ox - 0.008, oy + 0.033, oz);
  if (seg >= 10) P.at(new THREE.TorusGeometry(0.017, 0.0045, 4, 10), rgb, style, ox - 0.058, oy + 0.036, oz);
}

function lucernaGeometry(seg: number): THREE.BufferGeometry {
  const P = new Parts();
  lucerna(P, TERRACOTTA, STYLE.terracotta, 0, 0, 0, seg);
  return P.build();
}

/** Two-nozzle bronze lamp on three chains, the hook at the origin. */
function hangingGeometry(seg: number): THREE.BufferGeometry {
  const P = new Parts();
  P.at(new THREE.TorusGeometry(0.02, 0.005, 4, 8), BRONZE, STYLE.bronze, 0, -0.02, 0);
  const top = new THREE.Vector3(0, -0.04, 0);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
    P.add(rod(top, new THREE.Vector3(Math.cos(a) * 0.05, -0.68, Math.sin(a) * 0.05), 0.003, 0.003, 4), DARK_BRONZE, STYLE.bronze);
  }
  // The body: a wider, shallower lucerna with a nozzle each end.
  P.at(lathe([[0, 0], [0.03, 0], [0.058, 0.014], [0.06, 0.024], [0.05, 0.034], [0.04, 0.036], [0, 0.03]], seg), BRONZE, STYLE.bronze, 0, -0.73, 0);
  for (const s of [-1, 1]) {
    P.add(rod(new THREE.Vector3(s * 0.04, -0.705, 0), new THREE.Vector3(s * 0.105, -0.7, 0), 0.015, 0.012, Math.max(5, seg / 2)), BRONZE, STYLE.bronze);
    P.at(new THREE.CylinderGeometry(0.017, 0.017, 0.02, Math.max(6, seg / 2)), BRONZE, STYLE.bronze, s * 0.11, -0.7, 0);
  }
  return P.build();
}

/** Fluting: pull the vertices between the flutes in a little. */
function flute(g: THREE.BufferGeometry, n: number, depth: number): THREE.BufferGeometry {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
    if (r < 1e-5) continue;
    const k = 1 - depth * Math.abs(Math.cos(Math.atan2(z, x) * n * 0.5));
    p.setX(i, x * k); p.setZ(i, z * k);
  }
  return g;
}

/**
 * A bronze candelabrum, 1.37 m to its disc: three legs ending in lion's paws,
 * a knop, the slender fluted shaft, a calyx capital and the disc with a lamp.
 */
function candelabrumGeometry(seg: number): THREE.BufferGeometry {
  const P = new Parts();
  const hub = new THREE.Vector3(0, 0.2, 0);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
    const c = Math.cos(a), s = Math.sin(a);
    // The leg curves out: two rods, then the paw on a little disc.
    const knee = new THREE.Vector3(c * 0.11, 0.12, s * 0.11), foot = new THREE.Vector3(c * 0.19, 0.035, s * 0.19);
    P.add(rod(hub, knee, 0.013, 0.011, 5), BRONZE, STYLE.bronze);
    P.add(rod(knee, foot, 0.011, 0.016, 5), BRONZE, STYLE.bronze);
    P.at(new THREE.SphereGeometry(0.026, Math.max(5, seg / 2), 4), BRONZE, STYLE.bronze, c * 0.2, 0.026, s * 0.2);
    if (seg >= 10) P.at(new THREE.CylinderGeometry(0.03, 0.032, 0.012, 7), DARK_BRONZE, STYLE.bronze, c * 0.2, 0.006, s * 0.2);
  }
  P.at(new THREE.SphereGeometry(0.034, seg, Math.max(4, seg / 2)), BRONZE, STYLE.bronze, 0, 0.21, 0);
  const shaft = new THREE.CylinderGeometry(0.013, 0.018, 1.08, Math.max(8, seg * 2), 1, true);
  if (seg >= 10) flute(shaft, 16, 0.18);
  P.at(shaft, BRONZE, STYLE.bronze, 0, 0.78, 0);
  // Knop rings along the shaft and the calyx under the disc.
  P.at(new THREE.TorusGeometry(0.019, 0.006, 4, seg), BRONZE, STYLE.bronze, 0, 0.26, 0);
  P.add(new THREE.TorusGeometry(0.019, 0.006, 4, seg).rotateX(Math.PI / 2).translate(0, 0.26, 0), BRONZE, STYLE.bronze);
  P.at(lathe([[0.014, 0], [0.03, 0.04], [0.045, 0.06], [0.05, 0.062]], seg), BRONZE, STYLE.bronze, 0, 1.31, 0);
  P.at(new THREE.CylinderGeometry(0.1, 0.095, 0.012, Math.max(10, seg * 2)), BRONZE, STYLE.bronze, 0, 1.372, 0);
  lucerna(P, BRONZE, STYLE.bronze, 0, 1.378, 0, seg);
  return P.build();
}

/**
 * A bronze youth on a marble plinth, the right hand raised to hold a tray
 * with two lamps on it, as the lampbearers of the rich houses did.
 */
function lampbearerGeometry(seg: number): THREE.BufferGeometry {
  const P = new Parts();
  P.at(new THREE.BoxGeometry(0.44, 0.5, 0.44), [0.82, 0.8, 0.76], STYLE.marble, 0, 0.25, 0);
  P.at(new THREE.BoxGeometry(0.5, 0.05, 0.5), [0.78, 0.76, 0.72], STYLE.marble, 0, 0.525, 0);
  const B = DARK_BRONZE;
  const y0 = 0.55;
  // The youth is the Idolino, a scan of the real bronze (render/statues.ts),
  // which was itself a lamp bearer: mirrored, his outstretched hand (0.42 m
  // out, 0.89 m up) carries the tray. Until the scan has loaded, far off, and
  // on the phone, the figure sculpted in code holds the same tray in the
  // same place. The figure faces +z; here he faces +x, so his left hand
  // (figure +x) comes out at -z under the tray.
  const scan = seg > 8 ? scanStatue("idolino", true) : undefined;
  const s = scan ? 1 : 1.5 / 1.7;
  const body = scan ?? buildStatue("lampbearer", seg <= 8, { tray: [0.42 / s, 0.905 / s, -0.02 / s] });
  const n = body.position.length / 3, bp = new Float32Array(n * 3), bn = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = body.position[i * 3], y = body.position[i * 3 + 1], z = body.position[i * 3 + 2];
    bp.set([z * s, y0 + y * s, -x * s], i * 3);
    bn.set([body.normal[i * 3 + 2], body.normal[i * 3 + 1], -body.normal[i * 3]], i * 3);
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute("position", new THREE.BufferAttribute(bp, 3));
  bg.setAttribute("normal", new THREE.BufferAttribute(bn, 3));
  bg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(body.colour), 3));
  bg.setIndex(body.index);
  P.add(bg, B, STYLE.bronze, undefined, true);
  // The tray, and two lamps on it.
  P.at(new THREE.CylinderGeometry(0.12, 0.1, 0.014, Math.max(10, seg * 2)), BRONZE, STYLE.bronze, -0.02, y0 + 0.905, -0.42);
  lucerna(P, BRONZE, STYLE.bronze, -0.06, y0 + 0.912, -0.37, seg);
  lucerna(P, BRONZE, STYLE.bronze, -0.06, y0 + 0.912, -0.47, seg);
  return P.build();
}

/** The lararium: a painted aedicula on the wall, a shelf, a small lamp on the shelf. */
function larariumGeometry(seg: number): THREE.BufferGeometry {
  const P = new Parts();
  // Back panel, red with a cream pediment; the wall is on the -x side.
  P.at(new THREE.BoxGeometry(0.03, 0.55, 0.5), [0.58, 0.14, 0.09], STYLE.stucco, -0.15, 0.25, 0);
  // The pediment: a low triangle drawn in the wall's plane, extruded out from it.
  const tri = new THREE.Shape([new THREE.Vector2(-0.28, 0), new THREE.Vector2(0.28, 0), new THREE.Vector2(0, 0.14)]);
  const ped = new THREE.ExtrudeGeometry(tri, { depth: 0.05, bevelEnabled: false }).rotateY(Math.PI / 2);
  P.at(ped, [0.86, 0.82, 0.72], STYLE.stucco, -0.16, 0.53, 0);
  // The shelf, two little columns on it.
  P.at(new THREE.BoxGeometry(0.22, 0.04, 0.5), [0.86, 0.82, 0.72], STYLE.stucco, -0.05, -0.02, 0);
  if (seg >= 10) for (const z of [-0.21, 0.21]) P.at(new THREE.CylinderGeometry(0.014, 0.016, 0.5, 6), [0.86, 0.82, 0.72], STYLE.stucco, -0.06, 0.25, z);
  lucerna(P, TERRACOTTA, STYLE.terracotta, -0.02, 0, 0, seg);
  return P.build();
}

/**
 * A hand lantern (laterna): a bronze frame round horn panes, conical lid,
 * a ring to carry it by. The origin is the ring; the flame sits at -0.17.
 */
function lanternGeometry(): THREE.BufferGeometry {
  const P = new Parts();
  P.at(new THREE.TorusGeometry(0.025, 0.004, 4, 8), BRONZE, STYLE.bronze, 0, -0.02, 0);
  P.at(new THREE.ConeGeometry(0.07, 0.06, 8, 1, true), BRONZE, STYLE.bronze, 0, -0.075, 0);
  // Horn panes: warm and pale, lit from inside by the flame's own light.
  P.at(new THREE.CylinderGeometry(0.06, 0.06, 0.17, 8, 1, true), [0.95, 0.78, 0.5], STYLE.horn, 0, -0.19, 0);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    P.at(new THREE.BoxGeometry(0.008, 0.17, 0.008), DARK_BRONZE, STYLE.bronze, Math.cos(a) * 0.061, -0.19, Math.sin(a) * 0.061);
  }
  P.at(new THREE.CylinderGeometry(0.068, 0.064, 0.02, 8), BRONZE, STYLE.bronze, 0, -0.285, 0);
  return P.build();
}

const KIND_GEOMETRY: Record<LampKind, (seg: number) => THREE.BufferGeometry> = {
  [LampKind.Lucerna]: lucernaGeometry,
  [LampKind.Hanging]: hangingGeometry,
  [LampKind.Candelabrum]: candelabrumGeometry,
  [LampKind.Lampbearer]: lampbearerGeometry,
  [LampKind.Lararium]: larariumGeometry,
};

/** Where a lantern hangs from a walker's hand, in the walker's frame (+z forward). */
const LANTERN_HAND: [number, number, number] = [0.3, 0.82, 0.12];
const LANTERN_FLAME_Y = -0.17;

// --- shaders ---------------------------------------------------------------

/** The town's vertex shader with an instance matrix; no walk cycle. */
const FITTING_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aNormal;
in vec4 aColour;
in vec4 aSurf;
in vec4 aWall;
in mat4 instanceMatrix;
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
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vNormal = mat3(modelMatrix) * mat3(instanceMatrix) * aNormal.xyz;
  vWorld = w.xyz;
  vColour = aColour;
  vSurf = aSurf;
  vWall = aWall;
  vViewDist = distance(w.xyz, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// Flames: additive and HDR so the bloom takes them. A flame is a couple of
// centimetres, far under a pixel past a few tens of metres, so the sprite is
// held at a few pixels and dimmed by the area it gained: a lamp across the
// town stays a warm point instead of flickering in and out of the raster.
const FLAME_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aGlow;     // centre, size
in vec4 aTint;     // rgb * intensity, w how much of a lantern's horn diffuses it
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uPxPerM;
out vec2 vUv;
out vec4 vTint;
void main() {
  vec4 vc = viewMatrix * vec4(aGlow.xyz, 1.0);
  float w = max(0.05, -vc.z);
  float s = aGlow.w;
  float floorS = 2.0 * w / uPxPerM;
  float k = s / max(s, floorS);
  s = max(s, floorS);
  // Toward the eye a little, so the lamp's own body does not cut the halo.
  vc.xyz += normalize(-vc.xyz) * min(0.12, w * 0.3);
  vc.xy += position.xy * s;
  vUv = position.xy;
  vTint = vec4(aTint.rgb * max(k * k, 0.3), aTint.w);
  gl_Position = projectionMatrix * vc;
}
`;

const FLAME_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec4 vTint;
out vec4 fragColor;
void main() {
  // The flame: a teardrop over the wick, then a soft halo round it.
  vec2 f = vec2(vUv.x * 10.0, (vUv.y + 0.02) * 4.2);
  f.x /= max(0.25, 1.0 - 0.55 * clamp(vUv.y * 3.0, -0.5, 1.0));
  float core = exp(-dot(f, f) * 2.2) * 3.0 * (1.0 - vTint.w);
  float halo = exp(-dot(vUv, vUv) * 9.0) * (0.12 + 0.6 * vTint.w);
  vec3 c = vTint.rgb * halo + vTint.rgb * core * vec3(1.0, 0.85, 0.6);
  fragColor = vec4(c, 1.0);
}
`;

// --- the lamps, drawn -------------------------------------------------------

interface Flame { lamp: number; x: number; y: number; z: number; size: number }

export interface LampFrame {
  /** Local hour, 0..24. */
  hour: number;
  /** The scene's darkness 0..1 (SceneLighting.night). */
  night: number;
  /** Animation seconds. */
  t: number;
  camera: THREE.PerspectiveCamera;
  /** Drawing buffer height, pixels: the flames' size floor. */
  viewH: number;
  /** The townsfolk, world metres, for the lanterns. */
  people?: { x: number; z: number; heading: number }[];
  groundAt?: (x: number, z: number) => number;
}

export class PompeiiLamps {
  readonly group = new THREE.Group();
  readonly lamps: Lamp[];
  readonly tier: LampTier;
  /** Lights handed to the shader last frame, for the gate and the HUD. */
  lightsUsed = 0;
  flamesDrawn = 0;
  /** Mean lights a lit grid cell's pixels loop over. */
  lightsPerCell = 0;
  private readonly flames: Flame[] = [];
  private readonly world: Float32Array; // per lamp: light x,y,z
  private readonly level: Float32Array;
  private readonly near: THREE.InstancedMesh[] = [];
  private readonly far: THREE.InstancedMesh[] = [];
  private readonly lanterns: THREE.InstancedMesh;
  private readonly flameMesh: THREE.Mesh;
  private readonly fGeo: THREE.InstancedBufferGeometry;
  private readonly fAttr: THREE.InstancedBufferAttribute;
  private readonly tAttr: THREE.InstancedBufferAttribute;
  private readonly flameMat: THREE.RawShaderMaterial;
  private readonly lastPick = new THREE.Vector3(1e9, 0, 0);
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly v = new THREE.Vector3();
  private readonly lanternAt: { x: number; y: number; z: number }[] = [];
  private readonly order: number[] = [];
  private readonly score: Float32Array;

  constructor(opts: { data: PompeiiData; sites: LampSites; uniforms: PompeiiUniforms; groundAt: (x: number, z: number) => number; offX: number; offZ: number; lean: boolean; /** Lamps placed elsewhere (the baths, render/pompeiiwater.ts), local metres. */ extra?: Lamp[] }) {
    const { offX, offZ } = opts;
    this.tier = opts.lean ? LAMP_TIERS.lean : LAMP_TIERS.full;
    this.group.name = "pompeii-lamps";
    this.lamps = placeLamps(opts.data, opts.sites, { groundAt: (x, z) => opts.groundAt(x + offX, z + offZ) }).concat(opts.extra ?? []);
    // World positions: fittings and flames.
    this.world = new Float32Array(this.lamps.length * 3);
    this.level = new Float32Array(this.lamps.length);
    this.score = new Float32Array(this.lamps.length + 64);
    this.lamps.forEach((l, i) => {
      l.x += offX; l.z += offZ;
      const c = Math.cos(l.yaw), s = Math.sin(l.yaw);
      let mx = 0, my = 0, mz = 0;
      const offs = flameOffsets(l.kind, l.nozzles);
      for (const [fx, fy, fz] of offs) {
        // Local +x along yaw, +z to its right (yaw about +y, three's sense is -yaw).
        const x = l.x + fx * c - fz * s, z = l.z + fx * s + fz * c, y = l.y + fy;
        this.flames.push({ lamp: i, x, y, z, size: l.kind === LampKind.Lararium ? 0.12 : 0.16 });
        mx += x; my += y; mz += z;
      }
      // The light a little above the flames, as a flame lights from its tip.
      this.world.set([mx / offs.length, my / offs.length + 0.04, mz / offs.length], i * 3);
    });

    const mat = new THREE.RawShaderMaterial({ vertexShader: FITTING_VERT, fragmentShader: POMPEII_FRAG, uniforms: opts.uniforms, glslVersion: THREE.GLSL3 });
    const cap = this.tier.fittings;
    for (let k = 0; k < LAMP_KINDS; k++) {
      for (const [list, seg, tag] of [[this.near, 12, "near"], [this.far, 6, "far"]] as const) {
        const im = new THREE.InstancedMesh(KIND_GEOMETRY[k as LampKind](seg), mat, cap);
        // The near lampbearer is rebuilt round the scanned bronze once that has loaded.
        if (k === LampKind.Lampbearer && seg > 8) void statueScansReady().then(() => {
          if (!scanStatue("idolino")) return;
          im.geometry.dispose();
          im.geometry = lampbearerGeometry(seg);
        });
        im.count = 0;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Refilled round the camera; their bounds would only cull wrongly.
        im.frustumCulled = false;
        im.name = `pompeii-lamps-${k}-${tag}`;
        list.push(im);
        this.group.add(im);
      }
    }
    this.lanterns = new THREE.InstancedMesh(lanternGeometry(), mat, 32);
    this.lanterns.count = 0;
    this.lanterns.frustumCulled = false;
    this.lanterns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lanterns.name = "pompeii-lanterns";
    this.group.add(this.lanterns);

    const fcap = this.tier.glows;
    this.fGeo = new THREE.InstancedBufferGeometry();
    this.fGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.fGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.fAttr = new THREE.InstancedBufferAttribute(new Float32Array(fcap * 4), 4);
    this.tAttr = new THREE.InstancedBufferAttribute(new Float32Array(fcap * 4), 4);
    this.fAttr.setUsage(THREE.DynamicDrawUsage);
    this.tAttr.setUsage(THREE.DynamicDrawUsage);
    this.fGeo.setAttribute("aGlow", this.fAttr);
    this.fGeo.setAttribute("aTint", this.tAttr);
    this.fGeo.instanceCount = 0;
    this.flameMat = new THREE.RawShaderMaterial({
      vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG, glslVersion: THREE.GLSL3,
      uniforms: { uPxPerM: { value: 600 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.flameMesh = new THREE.Mesh(this.fGeo, this.flameMat);
    this.flameMesh.frustumCulled = false;
    this.flameMesh.name = "pompeii-flames";
    this.flameMesh.renderOrder = 23;
    this.group.add(this.flameMesh);

    townLampUniforms.uLampNight.value = 1;
    const c = lampCensus(this.lamps);
    console.log(`[flyby] pompeii lamps: ${this.lamps.length} (${Object.entries(c.byRole).map(([k, v]) => `${v} ${k}`).join(", ")}), ${this.tier.lights} lights`);
  }

  update(f: LampFrame): void {
    const cam = f.camera.position;
    const fwd = this.v.set(0, 0, -1).applyQuaternion(f.camera.quaternion);
    const fx = fwd.x, fy = fwd.y, fz = fwd.z;
    const n = this.lamps.length;
    for (let i = 0; i < n; i++) {
      const lv = lampLevel(this.lamps[i], f.hour, f.night);
      this.level[i] = lv;
    }

    // Lanterns: one walker in four, after dark (not the ones with the eruption's torches).
    this.lanternAt.length = 0;
    const lanternOn = Math.min(1, Math.max(0, (f.night - 0.5) / 0.2));
    if (f.people && f.groundAt && lanternOn > 0) {
      let k = 0;
      for (let i = 0; i < f.people.length && k < 32; i++) {
        if (i % 4 !== 1 || i % 3 === 0) continue;
        const p = f.people[i];
        const c = Math.cos(p.heading), s = Math.sin(p.heading);
        // Forward is (sin h, -cos h); right is (cos h, sin h).
        const x = p.x + LANTERN_HAND[0] * c + LANTERN_HAND[2] * s, z = p.z + LANTERN_HAND[0] * s - LANTERN_HAND[2] * c;
        const y = f.groundAt(x, z) + LANTERN_HAND[1];
        this.q.setFromAxisAngle(this.up, Math.PI - p.heading);
        this.m.compose(this.v.set(x, y, z), this.q, this.one);
        this.lanterns.setMatrixAt(k++, this.m);
        this.lanternAt.push({ x, y: y + LANTERN_FLAME_Y, z });
      }
      this.lanterns.count = k;
      this.lanterns.instanceMatrix.needsUpdate = true;
    } else this.lanterns.count = 0;

    // --- lights: the brightest over distance, faded at the cut ---
    const order = this.order;
    order.length = 0;
    const sc = this.score;
    const W = this.world;
    for (let i = 0; i < n; i++) {
      if (this.level[i] <= 0) continue;
      const dx = W[i * 3] - cam.x, dy = W[i * 3 + 1] - cam.y, dz = W[i * 3 + 2] - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 140 * 140) continue;
      // Behind the camera and out of reach of anything in view: no use.
      const ahead = dx * fx + dy * fy + dz * fz;
      if (ahead < -OIL_REACH_M) continue;
      const l = this.lamps[i];
      sc[i] = (l.power * l.nozzles * this.level[i]) / (d2 + 9);
      order.push(i);
    }
    for (let k = 0; k < this.lanternAt.length; k++) {
      const p = this.lanternAt[k];
      const d2 = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2 + (p.z - cam.z) ** 2;
      if (d2 > 140 * 140) continue;
      sc[n + k] = (0.8 * lanternOn) / (d2 + 9);
      order.push(n + k);
    }
    order.sort((a, b) => sc[b] - sc[a]);
    const N = Math.min(this.tier.lights, order.length);
    // The weakest chosen score sets the fade: at the cut a light is at zero.
    const cut = order.length > N ? sc[order[N]] : 0;
    const U = townLampUniforms.uOilLamp.value;
    for (let k = 0; k < N; k++) {
      const i = order[k];
      const fade = cut > 0 ? Math.min(1, Math.max(0, (sc[i] / cut - 1) / 1.5)) : 1;
      if (i >= n) {
        const p = this.lanternAt[i - n];
        U[k].set(p.x, p.y, p.z, LIGHT_GAIN * 0.8 * lanternOn * flicker(f.t, 0.37 * (i - n)) * fade);
      } else {
        const l = this.lamps[i];
        const fl = flicker(f.t, l.seed);
        U[k].set(W[i * 3] + jitter(f.t, l.seed, 0), W[i * 3 + 1], W[i * 3 + 2] + jitter(f.t, l.seed, 1), LIGHT_GAIN * l.power * l.nozzles * this.level[i] * fl * fade);
      }
    }
    townLampUniforms.uOilLampN.value = N;
    this.lightsPerCell = buildOilGrid(N);
    this.lightsUsed = N;

    // --- flames: nearest first, in front of the camera ---
    const G = this.fAttr.array as Float32Array, T = this.tAttr.array as Float32Array;
    const cap = this.tier.glows;
    let m = 0;
    const push = (x: number, y: number, z: number, size: number, w: number, horn: number): void => {
      G[m * 4] = x; G[m * 4 + 1] = y; G[m * 4 + 2] = z; G[m * 4 + 3] = size;
      T[m * 4] = w * 1.0; T[m * 4 + 1] = w * 0.5; T[m * 4 + 2] = w * 0.17; T[m * 4 + 3] = horn;
      m++;
    };
    for (const p of this.lanternAt) if (m < cap) push(p.x, p.y, p.z, 0.3, 1.6 * lanternOn, 1);
    // Distance-sorted only when there are more flames than sprites.
    const fl = this.flames;
    const cand: number[] = [];
    const fd = new Float32Array(fl.length);
    for (let j = 0; j < fl.length; j++) {
      const F = fl[j];
      if (this.level[F.lamp] <= 0) continue;
      const dx = F.x - cam.x, dy = F.y - cam.y, dz = F.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (dx * fx + dy * fy + dz * fz < -1 || d2 > 1500 * 1500) continue;
      fd[j] = d2;
      cand.push(j);
    }
    if (cand.length > cap - m) cand.sort((a, b) => fd[a] - fd[b]);
    for (const j of cand) {
      if (m >= cap) break;
      const F = fl[j], l = this.lamps[F.lamp];
      const flk = flicker(f.t, l.seed + j * 0.013);
      push(F.x + jitter(f.t, l.seed + j, 0), F.y, F.z + jitter(f.t, l.seed + j, 1), F.size, 2.2 * this.level[F.lamp] * flk, 0);
    }
    this.fGeo.instanceCount = m;
    this.flamesDrawn = m;
    this.flameMesh.visible = m > 0;
    this.fAttr.needsUpdate = true;
    this.tAttr.needsUpdate = true;
    this.flameMat.uniforms.uPxPerM.value = f.camera.projectionMatrix.elements[5] * f.viewH * 0.5;

    // --- fittings round the camera, refreshed as it moves ---
    if (this.lastPick.distanceToSquared(cam) > 4) {
      this.lastPick.copy(cam);
      this.pickFittings(cam);
    }
  }

  /** Fill the per-kind instance lists: near detail, far detail, nothing past farM. */
  private pickFittings(cam: THREE.Vector3): void {
    const { nearM, farM, fittings } = this.tier;
    const nc = new Array<number>(LAMP_KINDS).fill(0), fc = new Array<number>(LAMP_KINDS).fill(0);
    for (let i = 0; i < this.lamps.length; i++) {
      const l = this.lamps[i];
      const d2 = (l.x - cam.x) ** 2 + (l.y - cam.y) ** 2 + (l.z - cam.z) ** 2;
      if (d2 > farM * farM) continue;
      const nearL = d2 < nearM * nearM;
      const list = nearL ? this.near : this.far, cnt = nearL ? nc : fc;
      if (cnt[l.kind] >= fittings) continue;
      // Three's rotation about +y is the other way round from yaw (x toward z).
      this.q.setFromAxisAngle(this.up, -l.yaw);
      this.m.compose(this.v.set(l.x, l.y, l.z), this.q, this.one);
      list[l.kind].setMatrixAt(cnt[l.kind]++, this.m);
    }
    for (let k = 0; k < LAMP_KINDS; k++) {
      this.near[k].count = nc[k];
      this.far[k].count = fc[k];
      this.near[k].instanceMatrix.needsUpdate = true;
      this.far[k].instanceMatrix.needsUpdate = true;
    }
  }

  /** No lights handed to the town this frame. */
  dark(): void {
    townLampUniforms.uOilLampN.value = 0;
    buildOilGrid(0);
  }

  dispose(): void {
    townLampUniforms.uOilLampN.value = 0;
    buildOilGrid(0);
    townLampUniforms.uLampNight.value = 0;
  }
}
