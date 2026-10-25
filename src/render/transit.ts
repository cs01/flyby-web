// Trains and boats, drawn: multi-car consists on their real alignment, ferry
// hulls with a wake, and the elevated structure the els run on.
//
// Everything is procedural box geometry in the agency's paint, lit by the
// same shader as the live aircraft (AircraftModel.trafficMaterial), so a Q on
// the Manhattan Bridge and the A321 over it sit in one light. One instanced
// draw per car family plus one for its windows (which glow at night), one per
// hull type, one for the structure: about a dozen draws for a city.
//
// A car wholly under the street is not drawn at all (data/transit.ts
// carUnderground); one climbing a portal ramp is drawn and the terrain hides
// the part still below it, which is what a portal looks like from the air.

import * as THREE from "three";
import type { AircraftModel } from "./aircraftmodel";
import {
  boatPose,
  carPose,
  rollingFor,
  type CarPose,
  type Rolling,
  type TransitModel,
} from "../data/transit";
import type { TransitPack } from "../data/transitpack";
import { SH_GLSL } from "./sh";

/** Past this nothing is drawn: a 15 m car is under two pixels at 10 km. */
const MAX_RANGE_M = 10000;

/** A growable triangle soup with the attributes trafficMaterial reads. */
class Soup {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];

  quad(a: number[], b: number[], c: number[], d: number[], n: number[], rgb: THREE.Color): void {
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(rgb.r, rgb.g, rgb.b, 0);
    }
  }

  /** An axis-aligned box, model space. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number, skipBottom = true): void {
    const c = new THREE.Color(color);
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], c);
    if (!skipBottom) this.quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0], c);
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], c);
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], c);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], c);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], c);
  }

  /**
   * A hull block whose front (-z) end narrows to `bow` of its width and rises
   * `sheer` higher: a ferry's bow from the air, which a plain box is not.
   */
  hullBlock(hw: number, y0: number, y1: number, z0: number, z1: number, bowLen: number, bow: number, color: number): void {
    const c = new THREE.Color(color);
    const zb = z0 + bowLen;
    // Parallel midbody.
    this.box(-hw, hw, y0, y1, zb, z1, color);
    // Bow: two slanted sides meeting a narrow stem, deck on top.
    const bw = hw * bow;
    const L = Math.hypot(hw - bw, bowLen) || 1;
    const nx = bowLen / L, nz = -(hw - bw) / L;
    this.quad([hw, y0, zb], [hw, y1, zb], [bw, y1, z0], [bw, y0, z0], [nx, 0, nz], c);
    this.quad([-bw, y0, z0], [-bw, y1, z0], [-hw, y1, zb], [-hw, y0, zb], [-nx, 0, nz], c);
    this.quad([-bw, y0, z0], [bw, y0, z0], [bw, y1, z0], [-bw, y1, z0], [0, 0, -1], c);
    this.quad([-hw, y1, zb], [-bw, y1, z0], [bw, y1, z0], [hw, y1, zb], [0, 1, 0], c);
  }

  /**
   * A box swept from (ax,ay,az) to (bx,by,bz), `hw` either side in plan,
   * `up` above and `down` below the line. World space, for the structure.
   */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, hw: number, up: number, down: number, color: number): void {
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1;
    const sx = (-dz / L) * hw, sz = (dx / L) * hw;
    const c = new THREE.Color(color);
    const A0 = [ax - sx, ay + up, az - sz], A1 = [ax + sx, ay + up, az + sz];
    const B0 = [bx - sx, by + up, bz - sz], B1 = [bx + sx, by + up, bz + sz];
    const a0 = [ax - sx, ay - down, az - sz], a1 = [ax + sx, ay - down, az + sz];
    const b0 = [bx - sx, by - down, bz - sz], b1 = [bx + sx, by - down, bz + sz];
    const nx = -dz / L, nz = dx / L;
    this.quad(A0, B0, B1, A1, [0, 1, 0], c);
    this.quad(a1, b1, b0, a0, [0, -1, 0], c);
    this.quad(a1, A1, B1, b1, [nx, 0, nz], c);
    this.quad(b0, B0, A0, a0, [-nx, 0, -nz], c);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 4));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((this.pos.length / 3) * 2), 2));
    g.computeBoundingSphere();
    return g;
  }
}

interface Livery {
  body: number;
  roof: number;
  door: number;
  under: number;
  /** Stripes under the windows, [colour, y0, y1]. */
  stripes: [number, number, number][];
  doors: number;
  metal: number;
}

const LIVERY: Record<string, Livery> = {
  // R142/R160/R211: unpainted stainless, a black band round the windows.
  mta: { body: 0xc8ccd1, roof: 0x8c9196, door: 0xb2b7bd, under: 0x26292c, stripes: [], doors: 4, metal: 0.3 },
  // BART's Fleet of the Future: white with the blue band.
  bart: { body: 0xe8ebee, roof: 0x9aa1a8, door: 0x2f6fb8, under: 0x2a2d31, stripes: [[0x1e63b5, 1.5, 1.72]], doors: 3, metal: 0.0 },
  // CTA 5000-series: stainless with red and blue stripes along the sides.
  cta: { body: 0xc5c9cd, roof: 0x8a8f94, door: 0xb0b5ba, under: 0x26292c, stripes: [[0xc60c30, 1.58, 1.7], [0x00a1de, 1.74, 1.86]], doors: 2, metal: 0.3 },
};

/** One car, nose -z, rail top at y=0. Body and windows apart: the windows glow. */
function carGeometry(r: Rolling, lv: Livery): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const L = r.len - 0.5;
  const hw = r.width / 2;
  const b = new Soup();
  const z0 = -L / 2, z1 = L / 2;
  // Trucks and underframe.
  for (const tz of [-0.35 * r.len, 0.35 * r.len]) b.box(-hw * 0.8, hw * 0.8, 0.1, 0.95, tz - 1.3, tz + 1.3, 0x1c1e20);
  b.box(-hw * 0.95, hw * 0.95, 0.95, 1.25, z0 + 0.4, z1 - 0.4, lv.under);
  b.box(-hw, hw, 1.25, 3.5, z0, z1, lv.body);
  b.box(-hw + 0.15, hw - 0.15, 3.5, 3.72, z0 + 0.3, z1 - 0.3, lv.roof);
  // Door leaves, evenly spaced, both sides.
  for (let k = 0; k < lv.doors; k++) {
    const zc = z0 + ((k + 0.5) * L) / lv.doors;
    b.box(-hw - 0.012, hw + 0.012, 1.3, 3.15, zc - 0.65, zc + 0.65, lv.door);
  }
  for (const [c, y0, y1] of lv.stripes) b.box(-hw - 0.02, hw + 0.02, y0, y1, z0 + 0.25, z1 - 0.25, c);
  // End diaphragms, dark, so a consist reads as cars and not one tube.
  b.box(-hw * 0.7, hw * 0.7, 1.3, 3.3, z0 - 0.25, z0, 0x202224);
  b.box(-hw * 0.7, hw * 0.7, 1.3, 3.3, z1, z1 + 0.25, 0x202224);
  const g = new Soup();
  g.box(-hw - 0.03, hw + 0.03, 2.1, 2.9, z0 + 0.7, z1 - 0.7, 0x161a1f);
  // End windows, front and back.
  g.box(-hw * 0.6, hw * 0.6, 2.1, 2.95, z0 - 0.02, z0 + 0.01, 0x161a1f);
  g.box(-hw * 0.6, hw * 0.6, 2.1, 2.95, z1 - 0.01, z1 + 0.02, 0x161a1f);
  return { body: b.geometry(), glass: g.geometry() };
}

interface HullStyle {
  hull: number;
  upper: number;
  band: number;
  cat: boolean;
  decks: number;
}

const HULLS: Record<string, HullStyle> = {
  nycferry: { hull: 0x1b3f73, upper: 0xf2f4f6, band: 0x00a3c4, cat: true, decks: 1 },
  siferry: { hull: 0xe8701e, upper: 0xf08a2c, band: 0x3a2a20, cat: false, decks: 3 },
  sfbayferry: { hull: 0xf0f2f4, upper: 0xf3f5f7, band: 0x0d4f8b, cat: true, decks: 2 },
  ggt: { hull: 0xeef0f2, upper: 0xf4f6f7, band: 0xb0302a, cat: false, decks: 2 },
};

/** A ferry, bow -z, waterline at y=0. */
function hullGeometry(r: Rolling, st: HullStyle): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const L = r.len, hw = r.width / 2;
  const b = new Soup();
  const g = new Soup();
  const freeboard = L > 60 ? 4 : 1.8;
  if (st.cat) {
    // Two slender demi-hulls under a bridging deck: each its own block,
    // pointed, offset to either side.
    const dh = hw * 0.28;
    for (const sx of [-1, 1]) {
      const o = new Soup();
      o.hullBlock(dh, -0.8, freeboard, -L / 2, L / 2, L * 0.18, 0.15, st.hull);
      for (let i = 0; i < o.pos.length; i += 3) o.pos[i] += sx * (hw - dh);
      b.pos.push(...o.pos);
      b.nrm.push(...o.nrm);
      b.col.push(...o.col);
    }
    b.hullBlock(hw, freeboard * 0.55, freeboard, -L / 2 + L * 0.1, L / 2, L * 0.12, 0.55, st.hull);
  } else if (L > 60) {
    // The Staten Island boats are double-ended: a bow at each end.
    b.hullBlock(hw, -1.5, freeboard, -L / 2, 0, L * 0.18, 0.35, st.hull);
    const o = new Soup();
    o.hullBlock(hw, -1.5, freeboard, -L / 2, 0, L * 0.18, 0.35, st.hull);
    for (let i = 0; i < o.pos.length; i += 3) {
      o.pos[i + 2] = -o.pos[i + 2];
      o.pos[i] = -o.pos[i];
      o.nrm[i + 2] = -o.nrm[i + 2];
      o.nrm[i] = -o.nrm[i];
    }
    b.pos.push(...o.pos);
    b.nrm.push(...o.nrm);
    b.col.push(...o.col);
  } else {
    b.hullBlock(hw, -1.5, freeboard, -L / 2, L / 2, L * 0.22, 0.2, st.hull);
  }
  b.box(-hw - 0.02, hw + 0.02, freeboard - 0.35, freeboard, -L / 2 + 2, L / 2 - 0.5, st.band);
  // Cabins, one per deck, each a little shorter and narrower.
  let y = freeboard;
  const deckH = L > 60 ? 3.2 : 2.6;
  for (let d = 0; d < st.decks; d++) {
    const inset = 0.08 + d * 0.06;
    const zf = -L / 2 + L * (0.2 + d * 0.06);
    const za = L / 2 - L * (0.08 + d * 0.07);
    const w = hw * (0.92 - d * 0.1);
    b.box(-w, w, y, y + deckH, zf, za, st.upper);
    g.box(-w - 0.03, w + 0.03, y + deckH * 0.35, y + deckH * 0.8, zf + 0.6, za - 0.6, 0x15191e);
    g.box(-w * 0.85, w * 0.85, y + deckH * 0.35, y + deckH * 0.8, zf - 0.03, zf + 0.01, 0x15191e);
    y += deckH;
    if (inset > 1) break;
  }
  // Wheelhouse.
  const wh = Math.min(hw * 0.5, 3);
  b.box(-wh, wh, y, y + 2.2, -L / 2 + L * 0.3, -L / 2 + L * 0.3 + Math.min(5, L * 0.12), st.upper);
  g.box(-wh - 0.03, wh + 0.03, y + 1.0, y + 1.9, -L / 2 + L * 0.3 - 0.03, -L / 2 + L * 0.3 + Math.min(5, L * 0.12) + 0.03, 0x15191e);
  return { body: b.geometry(), glass: g.geometry() };
}

interface Family {
  rolling: Rolling;
  body: THREE.InstancedMesh;
  glass: THREE.InstancedMesh;
  n: number;
  boat: boolean;
}

const WAKE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 wake;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWake;
void main() {
  vWake = wake;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WAKE_FRAG = /* glsl */ `
precision highp float;
${SH_GLSL}
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uSunSurface;
uniform vec3 uSunDir;
in vec3 vWake;
out vec4 fragColor;
// vWake: x along (0 at the hull, 1 at the end), y across (-1..1), z strength.
void main() {
  float along = vWake.x;
  float across = 1.0 - vWake.y * vWake.y;
  // Churned water breaks into lines along the track, and dies away behind.
  float streak = 0.72 + 0.28 * sin(vWake.y * 13.0 + along * 4.0);
  float fade = (1.0 - along);
  float a = vWake.z * across * fade * fade * fade * streak;
  // Foam is a white, rough diffuser: the sun from above and the sky, at an
  // albedo of 0.8, the same light the contrails take.
  vec3 lit = 0.8 * (uSunColor * uSunIntensity * uSunSurface * max(uSunDir.y, 0.0) / 3.14159 + shIrradiance(vec3(0.0, 1.0, 0.0)));
  fragColor = vec4(lit, a * 0.7);
}
`;

const LIGHT_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 tint;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uPx;
out vec3 vTint;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vTint = tint.rgb;
  gl_PointSize = tint.a * clamp(40.0 * uPx / max(-mv.z, 1.0) / 1000.0 + 2.0, 2.0, 6.0);
}
`;

const LIGHT_FRAG = /* glsl */ `
precision highp float;
in vec3 vTint;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  fragColor = vec4(vTint * (1.0 - r) * (1.0 - r), 1.0);
}
`;

const MAX_WAKES = 64;
const MAX_LIGHTS = 1024;

export interface TrackSource {
  model: TransitModel;
  /** Rail heights per shape, by shape index. */
  heights: (shape: number) => Float32Array[];
  groundAt: (x: number, z: number) => number;
  waterY: number;
}

export class TransitRender {
  readonly group = new THREE.Group();
  readonly stats = { cars: 0, hidden: 0, boats: 0, wakes: 0, structureTris: 0 };
  /** Which kinds are switched on. */
  trains = true;
  boats = true;

  private families = new Map<string, Family>();
  private glassMats: THREE.RawShaderMaterial[] = [];
  private pose: CarPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hidden: false };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private wakes: THREE.Mesh;
  private wakePos = new Float32Array(MAX_WAKES * 12 * 3);
  private wakeAttr = new Float32Array(MAX_WAKES * 12 * 3);
  private lights: THREE.Points;
  private lightPos = new Float32Array(MAX_LIGHTS * 3);
  private lightTint = new Float32Array(MAX_LIGHTS * 4);
  private structure: THREE.InstancedMesh | null = null;
  private clock = 0;

  constructor(private aircraft: AircraftModel, private pack: TransitPack) {
    const idx: number[] = [];
    // Per wake: a centre stripe (quad) and two Kelvin arms (two quads each).
    for (let w = 0; w < MAX_WAKES; w++) {
      const o = w * 12;
      for (const q of [0, 4, 8]) idx.push(o + q, o + q + 1, o + q + 2, o + q + 2, o + q + 1, o + q + 3);
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.BufferAttribute(this.wakePos, 3).setUsage(THREE.DynamicDrawUsage));
    wg.setAttribute("wake", new THREE.BufferAttribute(this.wakeAttr, 3).setUsage(THREE.DynamicDrawUsage));
    wg.setIndex(idx);
    this.wakes = new THREE.Mesh(
      wg,
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: WAKE_VERT,
        fragmentShader: WAKE_FRAG,
        uniforms: { ...aircraft.uniforms },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.wakes.frustumCulled = false;
    this.wakes.renderOrder = 1;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(this.lightPos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute("tint", new THREE.BufferAttribute(this.lightTint, 4).setUsage(THREE.DynamicDrawUsage));
    this.lights = new THREE.Points(
      lg,
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: LIGHT_VERT,
        fragmentShader: LIGHT_FRAG,
        uniforms: { uPx: { value: 600 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.lights.frustumCulled = false;
    this.lights.renderOrder = 2;
    this.group.add(this.wakes, this.lights);
  }

  private family(key: string, rolling: Rolling, boat: boolean, make: () => { body: THREE.BufferGeometry; glass: THREE.BufferGeometry }, metal: number): Family {
    let f = this.families.get(key);
    if (f) return f;
    const geo = make();
    const bodyMat = this.aircraft.trafficMaterial(null);
    bodyMat.uniforms.uMetalness.value = metal;
    bodyMat.uniforms.uRoughness.value = metal > 0 ? 0.38 : 0.45;
    const glassMat = this.aircraft.trafficMaterial(null);
    glassMat.uniforms.uRoughness.value = 0.12;
    glassMat.uniforms.uEmissiveColor.value = new THREE.Color(0xffe2b0);
    this.glassMats.push(glassMat);
    const cap = boat ? 32 : 512;
    const body = new THREE.InstancedMesh(geo.body, bodyMat, cap);
    const glass = new THREE.InstancedMesh(geo.glass, glassMat, cap);
    for (const m of [body, glass]) {
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
    }
    f = { rolling, body, glass, n: 0, boat };
    this.families.set(key, f);
    return f;
  }

  private grow(f: Family): void {
    for (const k of ["body", "glass"] as const) {
      const old = f[k];
      const next = new THREE.InstancedMesh(old.geometry, old.material, old.instanceMatrix.count * 2);
      next.frustumCulled = false;
      next.instanceMatrix.array.set(old.instanceMatrix.array);
      this.group.remove(old);
      old.dispose();
      this.group.add(next);
      f[k] = next;
    }
  }

  /**
   * The elevated structure, built once: a girder under every elevated OSM
   * track the trains use and a column every 15 m, both at the height the
   * trains themselves run (`railAt`), so a train cannot float over its el.
   */
  buildStructure(railAt: (x: number, z: number) => number | null, groundAt: (x: number, z: number) => number, col: number): void {
    const s = new Soup();
    for (const pts of this.pack.structures) {
      let carry = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
        const ya = railAt(ax, az), yb = railAt(bx, bz);
        if (ya === null || yb === null) continue;
        const ga = groundAt(ax, az), gb = groundAt(bx, bz);
        // A stretch the trains ramp down to grade has no structure under it.
        if (ya - ga < 1.8 && yb - gb < 1.8) continue;
        s.beam(ax, ya, az, bx, yb, bz, 1.7, -0.25, 1.35, col);
        const L = Math.hypot(bx - ax, bz - az);
        for (let d = 15 - carry; d < L; d += 15) {
          const u = d / L;
          const x = ax + (bx - ax) * u, z = az + (bz - az) * u;
          const y = ya + (yb - ya) * u - 1.35;
          const g = groundAt(x, z);
          if (y - g < 1.5) continue;
          s.box(x - 0.3, x + 0.3, g - 0.5, y, z - 0.3, z + 0.3, col);
        }
        carry = (L + carry) % 15;
      }
    }
    if (!s.pos.length) return;
    const mat = this.aircraft.trafficMaterial(null);
    mat.uniforms.uRoughness.value = 0.8;
    const mesh = new THREE.InstancedMesh(s.geometry(), mat, 1);
    mesh.setMatrixAt(0, new THREE.Matrix4());
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.structure = mesh;
    this.stats.structureTris = s.pos.length / 9;
  }

  update(src: TrackSource, camera: THREE.PerspectiveCamera, bufferH: number, dt: number, night: number): void {
    this.clock += dt;
    const focal = 1 / 2 / Math.tan((camera.fov * Math.PI) / 360);
    (this.lights.material as THREE.RawShaderMaterial).uniforms.uPx.value = bufferH * focal;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    for (const f of this.families.values()) f.n = 0;
    for (const g of this.glassMats) g.uniforms.uEmissive.value = 1.6 * night;
    if (this.structure) this.structure.visible = this.trains;
    const cam = camera.position;
    let cars = 0, hidden = 0, boats = 0, nWake = 0, nLight = 0;
    const pack = this.pack;
    const p = this.pose;

    const addLight = (x: number, y: number, z: number, rgb: number[], gain: number, size = 1) => {
      if (nLight >= MAX_LIGHTS || gain < 0.02) return;
      this.lightPos.set([x, y, z], nLight * 3);
      this.lightTint.set([rgb[0] * gain, rgb[1] * gain, rgb[2] * gain, size], nLight * 4);
      nLight++;
    };
    const local = (lx: number, ly: number, lz: number) => this.v.set(lx, ly, lz).applyQuaternion(this.q).add(new THREE.Vector3(p.x, p.y, p.z));

    for (const veh of src.model.vehicles.values()) {
      const agency = pack.agencies[veh.agency];
      const boat = agency.kind === "ferry";
      if (boat ? !this.boats : !this.trains) continue;
      const pat = pack.patterns[veh.pattern];
      const sh = pack.shapes[pat.shape];
      const route = pack.routes[veh.route];
      const rolling = rollingFor(agency.id, route.id);
      const head = src.model.sample(veh, veh.s);
      if (!head || Math.hypot(head.x - cam.x, head.z - cam.z) > MAX_RANGE_M) continue;
      if (boat) {
        if (!boatPose(sh, veh.s, rolling, src.waterY, p)) continue;
        const style = HULLS[agency.id] ?? HULLS.ggt;
        const f = this.family(`boat-${agency.id}`, rolling, true, () => hullGeometry(rolling, style), 0);
        this.sphere.center.set(p.x, p.y, p.z);
        this.sphere.radius = rolling.len;
        // A gentle roll and pitch, phased per vessel, so a berthed boat is
        // not a painted box. Held at zero while the clock is frozen.
        const ph = (veh.key.length * 1.7 + veh.pattern) % 6.28;
        const roll = 0.012 * Math.sin(this.clock * 0.9 + ph);
        const pitch = 0.006 * Math.sin(this.clock * 0.7 + ph * 1.3);
        this.e.set(pitch, p.yaw, roll, "YXZ");
        this.q.setFromEuler(this.e);
        if (this.frustum.intersectsSphere(this.sphere)) {
          if (f.n >= f.body.instanceMatrix.count) this.grow(f);
          this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.one);
          f.body.setMatrixAt(f.n, this.m);
          f.glass.setMatrixAt(f.n, this.m);
          f.n++;
          boats++;
          const L = rolling.len, hw = rolling.width / 2;
          const deckY = L > 60 ? 14 : 6;
          // Navigation lights: red to port, green to starboard, white masthead.
          addLight(local(-hw, deckY * 0.6, -L * 0.2).x, this.v.y, this.v.z, [1, 0.08, 0.05], 0.3 + 2 * night);
          addLight(local(hw, deckY * 0.6, -L * 0.2).x, this.v.y, this.v.z, [0.08, 1, 0.25], 0.3 + 2 * night);
          addLight(local(0, deckY + 3, -L * 0.25).x, this.v.y, this.v.z, [1, 0.97, 0.9], 0.3 + 2.5 * night);
        }
        if (veh.speed > 0.8 && nWake < MAX_WAKES) {
          this.wake(nWake++, p, rolling, veh.speed, src.waterY);
        }
        continue;
      }
      const lv = LIVERY[agency.live === "bart" || agency.id === "bart" ? "bart" : agency.id === "cta" ? "cta" : "mta"];
      const famKey = `${agency.id}-${rolling.len}-${rolling.width}`;
      const f = this.family(famKey, rolling, false, () => carGeometry(rolling, lv), lv.metal);
      const heights = src.heights(pat.shape);
      for (let i = 0; i < rolling.cars; i++) {
        if (!carPose(sh, heights, veh.s, i, rolling, src.groundAt, p)) continue;
        if (p.hidden) {
          hidden++;
          continue;
        }
        this.sphere.center.set(p.x, p.y + 2, p.z);
        this.sphere.radius = rolling.len * 0.6;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        if (f.n >= f.body.instanceMatrix.count) this.grow(f);
        this.e.set(p.pitch, p.yaw, 0, "YXZ");
        this.q.setFromEuler(this.e);
        this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.one);
        f.body.setMatrixAt(f.n, this.m);
        f.glass.setMatrixAt(f.n, this.m);
        f.n++;
        cars++;
        const hl = rolling.width * 0.3;
        if (i === 0) {
          // Headlights on the leading car, white.
          for (const sx of [-hl, hl]) {
            local(sx, 1.4, -rolling.len / 2 + 0.2);
            addLight(this.v.x, this.v.y, this.v.z, [1, 0.95, 0.85], 0.4 + 2.2 * night);
          }
        }
        if (i === rolling.cars - 1) {
          for (const sx of [-hl, hl]) {
            local(sx, 1.4, rolling.len / 2 - 0.2);
            addLight(this.v.x, this.v.y, this.v.z, [1, 0.06, 0.04], 0.3 + 1.6 * night);
          }
        }
      }
    }

    for (const f of this.families.values()) {
      for (const m of [f.body, f.glass]) {
        m.count = f.n;
        m.instanceMatrix.needsUpdate = f.n > 0;
        m.visible = f.n > 0;
      }
    }
    const wg = this.wakes.geometry;
    (wg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (wg.attributes.wake as THREE.BufferAttribute).needsUpdate = true;
    wg.setDrawRange(0, nWake * 18);
    this.wakes.visible = nWake > 0;
    const lg = this.lights.geometry;
    (lg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (lg.attributes.tint as THREE.BufferAttribute).needsUpdate = true;
    lg.setDrawRange(0, nLight);
    this.stats.cars = cars;
    this.stats.hidden = hidden;
    this.stats.boats = boats;
    this.stats.wakes = nWake;
  }

  /**
   * A wake on the water behind a hull: the churned centre stripe out of the
   * stern and the two arms of the Kelvin wedge out of the bow, 19.5 degrees
   * either side of the track whatever the speed, longer the faster it goes.
   */
  private wake(k: number, p: CarPose, r: Rolling, speed: number, y0: number): void {
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const sx = -fz, sz = fx;
    const L = r.len, hw = r.width / 2;
    // About 15 hull lengths at 25 kn for the arms, measured off aerial photos
    // of NYC Ferry boats on the East River; the turbulent centre is shorter.
    const len = Math.min(260, 8 + speed * 14);
    const strength = Math.min(1, speed / 8);
    const y = y0 + 0.06;
    const bowX = p.x + fx * L * 0.45, bowZ = p.z + fz * L * 0.45;
    const sternX = p.x - fx * L * 0.5, sternZ = p.z - fz * L * 0.5;
    const o = k * 12;
    const put = (i: number, x: number, z: number, along: number, across: number, s: number) => {
      this.wakePos.set([x, y, z], (o + i) * 3);
      this.wakeAttr.set([along, across, s], (o + i) * 3);
    };
    // Centre: from the stern, a beam wide, spreading to twice that.
    const ex = sternX - fx * len * 0.6, ez = sternZ - fz * len * 0.6;
    put(0, sternX - sx * hw, sternZ - sz * hw, 0, -1, strength);
    put(1, sternX + sx * hw, sternZ + sz * hw, 0, 1, strength);
    put(2, ex - sx * hw * 1.8, ez - sz * hw * 1.8, 1, -1, strength);
    put(3, ex + sx * hw * 1.8, ez + sz * hw * 1.8, 1, 1, strength);
    // Arms: tan(19.5 deg) = 0.354 of the run back, either side.
    const tan = 0.354;
    for (const [q, side] of [[4, -1], [8, 1]] as const) {
      const ax = bowX + side * sx * hw, az = bowZ + side * sz * hw;
      const bx = bowX - fx * len + side * sx * (hw + len * tan), bz = bowZ - fz * len + side * sz * (hw + len * tan);
      const w0 = 0.8, w1 = 1.5 + len * 0.015;
      put(q, ax - sx * w0, az - sz * w0, 0, -1, strength * 0.55);
      put(q + 1, ax + sx * w0, az + sz * w0, 0, 1, strength * 0.55);
      put(q + 2, bx - sx * w1, bz - sz * w1, 1, -1, strength * 0.55);
      put(q + 3, bx + sx * w1, bz + sz * w1, 1, 1, strength * 0.55);
    }
  }
}

/** The structure's paint: NYC and Chicago els are riveted steel, BART's aerials concrete. */
export function structureColor(pack: TransitPack): number {
  return pack.agencies.some((a) => a.id === "bart") ? 0xa9a59c : pack.agencies.some((a) => a.id === "cta") ? 0x4b4f4a : 0x50574f;
}
