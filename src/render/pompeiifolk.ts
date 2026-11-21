// The people of Pompeii drawn: render/folk.ts's figures, skinned in the
// vertex shader from a texture of baked poses, one instanced draw per kind of
// dress near the camera and one far draw of a cheap figure for the rest. They
// are lit by the town's own fragment shader (sun, its shadow, sky, bounce,
// lamps, the eruption's ash) with a branch for skin, wool and hair added to
// it, and cast sun shadows through a depth scene of their own.

import * as THREE from "three";
import { Cart, POMPEII_FRAG, type PompeiiUniforms } from "./pompeii";
import { SHADOW_CASTER_LAYER } from "./sunshadow";
import { PompeiiLife, type LifeAgent } from "../data/pompeiilife";
import { pointInRing, type PompeiiData } from "../data/pompeii";
import {
  Arms, FLAG_LONG, FLAG_TORCH, FOLK_BONES, FOLK_SCALE, FOLK_CLIPS, FOLK_FRAMES, Gait, bakeClips, buildFolk, buildFolkFar, clipRow,
  type FolkMesh, type FolkOpts,
} from "./folk";

/** Inside this a figure is drawn in full; past it, the far figure. */
const NEAR_M = 32;
/** The phone draws the full figure only for the closest few. */
const LEAN_NEAR_M = 12, LEAN_NEAR_CAP = 3;

/** The skinning, shared by the picture and the shadow passes. */
const SKIN_GLSL = /* glsl */ `
precision highp int;
precision highp sampler2D;
in vec3 position;
in vec4 aSkin;
in vec4 aWeight;
in vec4 aWall;
in vec4 iAt;    // feet x, y, z (world), yaw
in vec4 iPose;  // clip's first row, cycle 0..1, scale, flags
uniform sampler2D uPose;
mat4 folkBone(int b, int row) {
  vec4 r0 = texelFetch(uPose, ivec2(b * 3, row), 0);
  vec4 r1 = texelFetch(uPose, ivec2(b * 3 + 1, row), 0);
  vec4 r2 = texelFetch(uPose, ivec2(b * 3 + 2, row), 0);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
// The vertex in the figure's posed frame, blended between the two nearest
// baked frames; hidden is set for a prop this figure does not carry.
mat4 folkSkin(out bool hidden) {
  int flags = int(iPose.w + 0.5);
  hidden = aWeight.w > 0.5 / 255.0 && (flags & ${FLAG_TORCH}) == 0;
  float f = fract(iPose.y) * ${FOLK_FRAMES}.0;
  int f0 = int(floor(f));
  float t = f - float(f0);
  int base = int(iPose.x + 0.5);
  int ra = base + f0 % ${FOLK_FRAMES}, rb = base + (f0 + 1) % ${FOLK_FRAMES};
  mat4 M = mat4(0.0);
  for (int k = 0; k < 3; k++) {
    float w = aWeight[k];
    if (w <= 0.0) continue;
    int b = int(aSkin[k] + 0.5);
    M += w * ((1.0 - t) * folkBone(b, ra) + t * folkBone(b, rb));
  }
  return M;
}
vec3 folkLocal() {
  vec3 p = position;
  // The far figure's hem drops to the ankles for a long garment.
  if ((int(iPose.w + 0.5) & ${FLAG_LONG}) != 0 && aWall.w > 0.0) { p.y -= aWall.w; p.xz *= 1.0 + aWall.w * 0.35; }
  return p;
}
vec3 folkWorld(vec3 q) {
  float c = cos(iAt.w), s = sin(iAt.w);
  return vec3(q.x * c + q.z * s, q.y, -q.x * s + q.z * c) + iAt.xyz;
}
`;

const FOLK_VERT = /* glsl */ `
precision highp float;
${SKIN_GLSL}
in vec4 aNormal;
in vec4 aColour;
in vec4 aSurf;
in vec4 iCloth;   // garment rgb, skin tone 0..1
in vec4 iCloth2;  // second garment rgb, hair tone 0..1
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
  bool hidden;
  mat4 M = folkSkin(hidden);
  vec3 w = folkWorld((M * vec4(folkLocal(), 1.0)).xyz * iPose.z);
  vec3 n = mat3(M) * aNormal.xyz;
  float c = cos(iAt.w), s = sin(iAt.w);
  vNormal = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
  vWorld = w;
  // Mediterranean skin from light olive to deep brown; hair near black to
  // brown, grey on the oldest.
  vec3 skin = mix(vec3(0.56, 0.38, 0.27), vec3(0.28, 0.17, 0.11), iCloth.w);
  vec3 hair = iCloth2.w > 0.9 ? vec3(0.4, 0.38, 0.35) : mix(vec3(0.03, 0.025, 0.022), vec3(0.15, 0.09, 0.055), iCloth2.w / 0.9);
  int slot = int(aSurf.w + 0.5);
  vec3 col = aColour.rgb;
  if (slot == 1) col *= skin;
  else if (slot == 2) col *= hair;
  else if (slot == 3) col *= iCloth.rgb;
  else if (slot == 4) col *= iCloth2.rgb;
  vColour = vec4(col, fract(iCloth.w * 7.31 + iCloth2.w * 3.17));
  vSurf = aSurf;
  vWall = aWall;
  vViewDist = distance(w, uCameraPos);
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const FOLK_DEPTH_VERT = /* glsl */ `
precision highp float;
${SKIN_GLSL}
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
void main() {
  bool hidden;
  mat4 M = folkSkin(hidden);
  vec3 w = folkWorld((M * vec4(folkLocal(), 1.0)).xyz * iPose.z);
  gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const DEPTH_FRAG = /* glsl */ `precision highp float;
out vec4 c;
void main() { c = vec4(1.0); }`;

/**
 * Skin, wool, hair, leather, clay and wicker for style 23, spliced into the
 * town's fragment shader ahead of its ash and lighting so the figures take
 * exactly the town's light. p1 the material, p2 the folds round a garment;
 * vWall: u round, v along, the folds' depth.
 */
const FOLK_SHADING = /* glsl */ `
  if (style > 22.5 && style < 23.5) {
    float nearP = 1.0 - smoothstep(8.0, 30.0, vViewDist);
    if (p1 < 0.5) {
      albedo *= 0.94 + 0.1 * vnoise(vWorld.xz * 37.0 + vWorld.y * 29.0) * nearP;
      gloss = 0.22;
      if (p2 > 0.5) {
        // The face, in the head's own u (0 at the front) and v (chin 0, crown 1):
        // eyes in their sockets, the brows, the mouth, faded out before they alias.
        float a = min(vWall.x, 1.0 - vWall.x), hv = vWall.y;
        float fade = 1.0 - smoothstep(10.0, 22.0, vViewDist);
        float eye = length(vec2((a - 0.083) / 0.026, (hv - 0.545) / 0.04));
        float socket = length(vec2((a - 0.08) / 0.05, (hv - 0.56) / 0.08));
        float brow = step(0.035, a) * step(a, 0.135) * (1.0 - smoothstep(0.012, 0.022, abs(hv - 0.625 + 0.15 * (a - 0.085))));
        float mouth = step(a, 0.04) * (1.0 - smoothstep(0.008, 0.016, abs(hv - 0.215)));
        albedo *= mix(1.0, 0.72 + 0.28 * smoothstep(0.5, 1.0, socket), fade);
        albedo = mix(albedo, vec3(0.03, 0.025, 0.02), fade * (1.0 - smoothstep(0.55, 1.0, eye)));
        albedo = mix(albedo, albedo * 0.35, fade * brow * 0.8);
        albedo = mix(albedo, albedo * vec3(0.62, 0.36, 0.34), fade * mouth);
      }
    } else if (p1 < 1.5 || p1 > 6.5) {
      if (p2 > 0.5) {
        // Folds hang down the cloth: the normal swung across them, their hollows darker.
        float a = vWall.x * p2 * 6.2831853 + 2.2 * vnoise(vec2(vWall.x * p2 * 1.7, vWall.y * 2.0 + seed * 9.0));
        vec3 t3 = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-4, 0.0, 0.0));
        float k = vWall.z;
        n = normalize(n + t3 * cos(a) * 0.32 * k);
        ao *= 1.0 - 0.2 * k * (0.5 + 0.5 * sin(a));
      }
      // Wool: an uneven hand-spun weave, a few broad stains and wear.
      albedo *= 0.9 + 0.13 * vnoise(vWorld.xz * 70.0 + vWorld.y * 55.0) * nearP;
      albedo *= 0.93 + 0.1 * vnoise(vWorld.xz * 5.0 + vWorld.y * 3.5 + seed * 17.0);
      gloss = p1 > 6.5 ? 0.12 : 0.0;
    } else if (p1 < 2.5) {
      albedo *= 0.7 + 0.5 * vnoise(vec2(vWall.x * 80.0, vWorld.y * 140.0)) * nearP + 0.15 * (1.0 - nearP);
      gloss = 0.35;
    } else if (p1 < 3.5) {
      gloss = 0.25;
    } else if (p1 < 4.5) {
      albedo *= 0.88 + 0.16 * vnoise(vWorld.xz * 18.0 + vWorld.y * 11.0);
      gloss = 0.15;
    } else if (p1 < 5.5) {
      float wv = step(0.5, fract(vWall.x * p2 * 2.0 + 0.5 * step(0.5, fract(vWorld.y * 40.0))));
      albedo *= 0.72 + 0.4 * mix(0.5, wv, nearP);
    }
  }
`;
const FRAG_ANCHOR = "  n = ashFlatten(n, normalize(vNormal));";

/** The town's fragment shader with the figures' materials added; the plain one if its anchor line has moved. */
export function folkFragment(frag = POMPEII_FRAG): string {
  if (!frag.includes(FRAG_ANCHOR)) {
    console.warn("pompeiifolk: town shader anchor not found, figures drawn without their materials");
    return frag;
  }
  return frag.replace(FRAG_ANCHOR, FOLK_SHADING + FRAG_ANCHOR);
}

/** The kinds of figure with a mesh of their own. */
const KINDS: FolkOpts[] = [
  { dress: "tunic" }, { dress: "tunic", load: "amphora" }, { dress: "tunic", load: "basket" },
  { dress: "stola" }, { dress: "stola", veil: true }, { dress: "stola", load: "basket" },
  { dress: "toga" },
];
const FAR = KINDS.length;

type RGB = [number, number, number];
/** Men's tunics: undyed and grey wool, browns, dull madder, olive and grey-green. */
const MEN: RGB[] = [
  [0.62, 0.56, 0.45], [0.5, 0.46, 0.38], [0.4, 0.29, 0.19], [0.28, 0.19, 0.13],
  [0.48, 0.19, 0.12], [0.36, 0.38, 0.23], [0.56, 0.45, 0.3], [0.3, 0.32, 0.28],
];
/** Women's dress: madder red, saffron, woad blue, a purple, green, white, rose, ochre. */
const WOMEN: RGB[] = [
  [0.6, 0.12, 0.09], [0.72, 0.5, 0.14], [0.16, 0.26, 0.5], [0.38, 0.16, 0.32],
  [0.2, 0.4, 0.28], [0.8, 0.77, 0.68], [0.7, 0.38, 0.32], [0.62, 0.42, 0.18],
];
const TOGA: RGB = [0.82, 0.8, 0.72];
const TOGA_TUNIC: RGB = [0.74, 0.71, 0.63];

const lerp = (r: readonly [number, number], t: number): number => r[0] + (r[1] - r[0]) * t;

function hash(i: number, k: number): number {
  let h = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 7, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

interface Look { kind: number; arms: Arms; scale: number; cloth: RGB; cloth2: RGB; skin: number; hair: number; long: boolean }

interface Bucket { mesh: THREE.Mesh; caster: THREE.Mesh; geo: THREE.InstancedBufferGeometry; data: Float32Array; buf: THREE.InstancedInterleavedBuffer; n: number; triangles: number }

/**
 * The people and carts of PompeiiLife, drawn. Kill switch `?off=pompeiilife`.
 * `depthScene` goes in the shadow casters' list (render/sunshadow.ts).
 */
export class Townsfolk {
  readonly group = new THREE.Group();
  readonly depthScene = new THREE.Scene();
  readonly sim: PompeiiLife;
  /** Last frame's draw: figures and triangles at each level. */
  readonly stats = { near: 0, far: 0, triangles: 0 };
  private readonly buckets: Bucket[] = [];
  private readonly carts: Cart[] = [];
  private readonly looks: Look[] = [];
  private readonly lastPath: number[] = [];
  private readonly moving: boolean[] = [];
  private readonly px: number[] = [];
  private readonly pz: number[] = [];
  private readonly idle: number[] = [];
  private readonly forum: number[] | null;
  private readonly frustum = new THREE.Frustum();
  private readonly pm = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly camAt = new THREE.Vector3();
  private readonly nearM: number;
  private readonly nearCap: number;
  private readonly order: { i: number; d: number }[] = [];

  constructor(data: PompeiiData, uniforms: PompeiiUniforms, private readonly heightAt: (x: number, z: number) => number,
    private readonly offX: number, private readonly offZ: number, lean: boolean) {
    // Enough that the eruption's gates fill (sim/flee.ts puts most of them there).
    this.sim = new PompeiiLife(data, { people: lean ? 24 : 64, carts: lean ? 1 : 2 });
    this.forum = data.publics.find((p) => p.kind === "forum")?.ring ?? null;
    this.nearM = lean ? LEAN_NEAR_M : NEAR_M;
    this.nearCap = lean ? LEAN_NEAR_CAP : Infinity;
    const n = this.sim.people.length;
    const tex = new THREE.DataTexture(bakeClips(), FOLK_BONES * 3, FOLK_CLIPS * FOLK_FRAMES, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const uPose = { value: tex };
    const mat = new THREE.RawShaderMaterial({
      vertexShader: FOLK_VERT, fragmentShader: folkFragment(), glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
      uniforms: { ...uniforms, uPose },
    });
    const depth = new THREE.RawShaderMaterial({
      vertexShader: FOLK_DEPTH_VERT, fragmentShader: DEPTH_FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide, colorWrite: false,
      uniforms: { uPose },
    });
    const meshes: FolkMesh[] = [...KINDS.map((k) => buildFolk(k)), buildFolkFar()];
    meshes.forEach((m, k) => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
      geo.setAttribute("aNormal", new THREE.BufferAttribute(m.normal, 4, true));
      geo.setAttribute("aColour", new THREE.BufferAttribute(m.colour, 4, true));
      geo.setAttribute("aSurf", new THREE.BufferAttribute(m.surf, 4, false));
      geo.setAttribute("aWall", new THREE.BufferAttribute(m.wall, 4));
      geo.setAttribute("aSkin", new THREE.BufferAttribute(m.skin, 4, false));
      geo.setAttribute("aWeight", new THREE.BufferAttribute(m.weight, 4, true));
      geo.setIndex(new THREE.BufferAttribute(m.index, 1));
      const data = new Float32Array(n * 16);
      const buf = new THREE.InstancedInterleavedBuffer(data, 16);
      buf.setUsage(THREE.DynamicDrawUsage);
      ["iAt", "iPose", "iCloth", "iCloth2"].forEach((name, q) => geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, 4, q * 4)));
      geo.instanceCount = 0;
      const mesh = new THREE.Mesh(geo, mat);
      // Placed in the shader; bounds would only cull wrongly.
      mesh.frustumCulled = false;
      mesh.name = k === FAR ? "pompeii-people-far" : "pompeii-people";
      const caster = new THREE.Mesh(geo, depth);
      caster.frustumCulled = false;
      caster.layers.enable(SHADOW_CASTER_LAYER);
      this.group.add(mesh);
      this.depthScene.add(caster);
      this.buckets.push({ mesh, caster, geo, data, buf, n: 0, triangles: m.triangles });
    });
    for (let i = 0; i < n; i++) {
      this.lastPath.push(-2); this.moving.push(true); this.px.push(0); this.pz.push(0); this.idle.push(hash(i, 9));
      this.looks.push(this.look(i, this.sim.people[i]));
    }
    for (let i = 0; i < this.sim.carts.length; i++) {
      const c = new Cart(uniforms);
      this.carts.push(c);
      this.group.add(c.group);
    }
    this.group.name = "pompeii-life";
  }

  /**
   * A walker to frame for `?folkcam=` (tools/shots.ts): "pair" the nearest
   * two walking together, "toga" the nearest man in a toga, "lantern" the
   * nearest who carries one after dark, or an index. Null when there is none
   * within 200 m.
   */
  subject(what: string, camX: number, camZ: number): number | null {
    const P = this.sim.people;
    const d = (i: number): number => Math.hypot(P[i].x + this.offX - camX, P[i].z + this.offZ - camZ);
    const ok = (i: number): boolean => P[i].x < 5e4 && d(i) < 200;
    let best: number | null = null;
    // A toga on the forum before one anywhere else.
    const forumToga = what === "toga" && P.some((q, i) => ok(i) && this.looks[i].kind === 6 && !!this.forum && pointInRing(this.forum, q.x, q.z));
    for (let i = 0; i < P.length; i++) {
      if (!ok(i)) continue;
      let hit = false;
      if (what === "toga") hit = this.looks[i].kind === 6 && (!forumToga || (!!this.forum && pointInRing(this.forum, P[i].x, P[i].z)));
      else if (what === "lantern") hit = i % 4 === 1 && i % 3 !== 0 && (this.looks[i].arms === Arms.Free || this.looks[i].arms === Arms.Woman);
      else if (what === "pair") hit = P.some((q, j) => j !== i && Math.hypot(q.x - P[i].x, q.z - P[i].z) < 2.2 && Math.cos(q.heading - P[i].heading) > 0.9);
      else hit = String(i) === what;
      if (hit && (best === null || d(i) < d(best))) best = i;
    }
    return best;
  }

  /** Where walker i stands and faces, world metres. */
  placeOf(i: number): { x: number; y: number; z: number; heading: number } {
    const p = this.sim.people[i], x = p.x + this.offX, z = p.z + this.offZ;
    return { x, y: this.heightAt(x, z), z, heading: p.heading };
  }

  /** Who a walker is, from their index and where they were put: togas on the forum, loads in the streets. */
  private look(i: number, p: LifeAgent): Look {
    const h = (k: number): number => hash(i, k);
    const woman = h(1) < 0.36;
    const inForum = !!this.forum && pointInRing(this.forum, p.x, p.z);
    const skin = h(6), hair = h(7) * (woman ? 0.92 : 1);
    const vary = (c: RGB, k: number): RGB => { const f = 0.85 + 0.3 * h(k); return [c[0] * f, c[1] * f, c[2] * f]; };
    if (woman) {
      const kind = h(3) < 0.14 ? 5 : h(4) < 0.35 ? 4 : 3;
      const cloth = vary(WOMEN[p.tint % WOMEN.length], 10);
      let c2 = Math.floor(h(8) * WOMEN.length);
      if (c2 === p.tint % WOMEN.length) c2 = (c2 + 3) % WOMEN.length;
      return { kind, arms: kind === 5 ? Arms.Basket : Arms.Woman, scale: lerp(FOLK_SCALE.woman, h(5)), cloth, cloth2: vary(WOMEN[c2], 11), skin: skin * 0.8, hair, long: true };
    }
    const scale = lerp(FOLK_SCALE.man, h(5));
    if (h(2) < 0.04 || (inForum && h(2) < 0.45)) return { kind: 6, arms: Arms.Toga, scale, cloth: vary(TOGA, 12), cloth2: TOGA_TUNIC, skin, hair, long: true };
    const load = h(3);
    const kind = load < 0.1 ? 1 : load < 0.2 ? 2 : 0;
    return { kind, arms: kind === 1 ? Arms.Amphora : kind === 2 ? Arms.Basket : Arms.Free, scale, cloth: vary(MEN[p.tint % MEN.length], 10), cloth2: MEN[0], skin, hair, long: false };
  }

  /**
   * dt 0 holds everyone still (shot mode) but still places them round the
   * camera. `camera` culls and picks the level of detail; `night` (0..1)
   * puts lanterns in the hands render/pompeiilamps.ts hangs them from;
   * `torches` raises the eruption's torches.
   */
  update(dt: number, camX: number, camZ: number, opts: { camera?: THREE.Camera; night?: number; torches?: boolean } = {}): void {
    this.sim.update(dt, camX - this.offX, camZ - this.offZ);
    const cam = opts.camera;
    if (cam) {
      cam.updateMatrixWorld();
      this.pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.pm);
    }
    const eye = cam ? cam.position : this.camAt.set(camX, 0, camZ);
    for (const b of this.buckets) b.n = 0;
    // Nearest first, so the phone's few full figures are the closest.
    this.order.length = 0;
    this.sim.people.forEach((p, i) => {
      if (p.path !== this.lastPath[i]) { this.looks[i] = this.look(i, p); this.lastPath[i] = p.path; }
      const x = p.x + this.offX, z = p.z + this.offZ;
      if (dt > 0) {
        this.moving[i] = Math.hypot(x - this.px[i], z - this.pz[i]) / dt > 0.15;
        this.idle[i] += dt * 0.07;
      }
      this.px[i] = x; this.pz[i] = z;
      if (p.x > 5e4) return; // parked by the eruption's crowd
      this.order.push({ i, d: Math.hypot(x - eye.x, z - eye.z) });
    });
    this.order.sort((a, b) => a.d - b.d);
    let near = 0, far = 0;
    const night = opts.night ?? 0;
    for (const { i, d } of this.order) {
      const p = this.sim.people[i], L = this.looks[i];
      const x = p.x + this.offX, z = p.z + this.offZ, y = this.heightAt(x, z);
      // A generous sphere: one just out of view still throws its shadow into it.
      if (cam && !this.frustum.intersectsSphere(this.sphere.set(this.camAt.set(x, y + 0.9, z), 3))) continue;
      const isNear = d < this.nearM && near < this.nearCap;
      const b = this.buckets[isNear ? L.kind : FAR];
      let arms = L.arms;
      let flags = L.long ? FLAG_LONG : 0;
      const free = arms === Arms.Free || arms === Arms.Woman;
      // The same walkers render/pompeiilamps.ts and render/eruption.ts pick.
      if (free && night > 0.5 && i % 4 === 1 && i % 3 !== 0) arms = Arms.Lantern;
      if (free && opts.torches && i % 3 === 0) { arms = Arms.Torch; flags |= FLAG_TORCH; }
      const walking = this.moving[i];
      const row = clipRow(walking ? Gait.Walk : Gait.Idle, arms);
      // One cycle per stride of this figure's size: the sim's phase turns once every 1.4 m.
      const cycle = walking ? p.phase / (2 * Math.PI * L.scale) : this.idle[i];
      const o = b.n * 16;
      b.data[o] = x; b.data[o + 1] = y; b.data[o + 2] = z; b.data[o + 3] = Math.PI - p.heading;
      b.data[o + 4] = row; b.data[o + 5] = cycle - Math.floor(cycle); b.data[o + 6] = L.scale; b.data[o + 7] = flags;
      b.data[o + 8] = L.cloth[0]; b.data[o + 9] = L.cloth[1]; b.data[o + 10] = L.cloth[2]; b.data[o + 11] = L.skin;
      b.data[o + 12] = L.cloth2[0]; b.data[o + 13] = L.cloth2[1]; b.data[o + 14] = L.cloth2[2]; b.data[o + 15] = L.hair;
      b.n++;
      if (isNear) near++; else far++;
    }
    let tris = 0;
    for (const b of this.buckets) {
      b.geo.instanceCount = b.n;
      b.mesh.visible = b.caster.visible = b.n > 0;
      if (b.n) { b.buf.needsUpdate = true; b.buf.addUpdateRange(0, b.n * 16); }
      tris += b.n * b.triangles;
    }
    this.stats.near = near; this.stats.far = far; this.stats.triangles = tris;
    this.sim.carts.forEach((c, i) => {
      const x = c.x + this.offX, z = c.z + this.offZ;
      const y = this.heightAt(x, z);
      this.camAt.set(camX, y, camZ);
      this.carts[i].update(x, y, z, (c.heading * 180) / Math.PI, c.speed, dt, this.camAt);
    });
  }
}
