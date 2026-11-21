// Open water at close range: a Tessendorf FFT sea on a mesh that follows the
// camera.
//
// Why: the terrain shades water on its own flat mesh, with an analytic wave
// sum for the normals. From the air that is right, because every wave is
// sub-pixel and what is left to see is roughness. From a boat deck it is a
// painted plane: nothing rises, nothing occludes the water behind it, and the
// silhouette of the sea against the far shore is a ruler line. That takes real
// displaced geometry, and real geometry at this range takes a spectrum with
// thousands of waves in it, which only an FFT can afford.
//
// How it fits the rest of the renderer:
//   * The FFT runs as fragment passes (WebGL2 has no compute): one pass
//     evolves the spectrum to this instant, log2(N) passes each way invert
//     it, and one pass per cascade turns the result into a displacement map
//     and a (gradient, Jacobian, foam) map. All cascades share one wide
//     texture through the FFT, so cascade count does not multiply the draws.
//   * The mesh is shaded by the TERRAIN fragment shader compiled with OCEAN
//     defined, sharing the terrain's uniform objects by reference. Sky
//     reflection, the scene reflection march (render/waterssr.ts), sun and
//     moon glint, aerial perspective, shadows and the debug views are the
//     terrain's own code, so the near sea and the far field cannot drift
//     apart, and the rim of the disc fades into the terrain's waves with no
//     second shading model to match.
//   * The terrain still draws its water, sunk out of the way under the disc
//     (oceanSinkAt in render/oceanglsl.ts), and the mesh draws first, so the
//     sunk water fails the depth test instead of being shaded twice.
//   * The landcover decides where the mesh draws: the ocean fragment shader
//     discards anything the terrain would shade as land.

import * as THREE from "three";
import { TERRAIN_FRAG, type Terrain, type TerrainUniforms } from "./terrain";
import { OCEAN_VS_GLSL, oceanLinkUniforms, type OceanLinkUniforms } from "./oceanglsl";
import type { OceanPlan } from "./budget";
import {
  OCEAN_CHOP, OCEAN_FETCH_REF_M, PHASE_PERIOD_S,
  cascadeBands, cascadeGaussians, cascadeStats, foamThreshold, writeH0,
  type OceanBand, type CascadeStats, type FoamThreshold,
} from "./oceanspectrum";

const PASS_VERT = /* glsl */ `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PASS_HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

/**
 * h0 evolved to time t, written as (Dx + i Dz, Dy): two complex spectra in
 * one texel, each the transform of a REAL field, which is what lets one
 * complex inverse FFT carry two of them. Mirrors simulateCascade in
 * render/oceanspectrum.ts.
 */
const SPECTRUM_FRAG = /* glsl */ `
${PASS_HEAD}
uniform sampler2D uH0;
uniform float uT;
uniform float uW0;
uniform int uN;
uniform vec2 uPatch;
out vec4 fragOut;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.x / uN;
  int lx = p.x - c * uN;
  float L = c == 0 ? uPatch.x : uPatch.y;
  int mx = lx < uN / 2 ? lx : lx - uN;
  int my = p.y < uN / 2 ? p.y : p.y - uN;
  vec2 k = (6.28318530718 / L) * vec2(float(mx), float(my));
  float kl = length(k);
  vec4 h = texelFetch(uH0, p, 0);
  float w = floor(sqrt(9.81 * kl) / uW0 + 0.5) * uW0 * uT;
  vec2 e = vec2(cos(w), sin(w));
  vec2 H = cmul(h.xy, e) + cmul(h.zw, vec2(e.x, -e.y));
  vec2 A = kl > 0.0 ? cmul(H, vec2(-k.y, k.x)) / kl : vec2(0.0);
  fragOut = vec4(A, H);
}
`;

/** One Stockham pass; stockhamPass in render/oceanspectrum.ts is this, line for line. */
const FFT_FRAG = /* glsl */ `
${PASS_HEAD}
uniform sampler2D uSrc;
uniform int uN;
uniform int uP;
uniform int uHoriz;
out vec4 fragOut;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int o = uHoriz == 1 ? q.x % uN : q.y;
  int k = o & (uP - 1);
  int i = (o / (2 * uP)) * uP + k;
  bool diff = (o & uP) != 0;
  ivec2 a;
  ivec2 b;
  if (uHoriz == 1) {
    int base = q.x - o;
    a = ivec2(base + i, q.y);
    b = ivec2(base + i + uN / 2, q.y);
  } else {
    a = ivec2(q.x, i);
    b = ivec2(q.x, i + uN / 2);
  }
  vec4 u0 = texelFetch(uSrc, a, 0);
  vec4 u1 = texelFetch(uSrc, b, 0);
  float ang = 3.14159265359 * float(k) / float(uP);
  vec2 tw = vec2(cos(ang), sin(ang));
  vec4 t = vec4(cmul(tw, u1.xy), cmul(tw, u1.zw));
  fragOut = diff ? u0 - t : u0 + t;
}
`;

/**
 * One cascade's inverse FFT into its displacement map and its (gradient,
 * Jacobian, foam) map. The gradient is of the DISPLACED surface (the normal of
 * the two displaced tangents), not of the height alone: with chop the crest is
 * narrower than the height map says and its faces steeper. jacobianField and
 * foamAt in render/oceanspectrum.ts mirror it.
 */
const POST_FRAG = /* glsl */ `
${PASS_HEAD}
uniform sampler2D uFft;
uniform sampler2D uPrev;
uniform int uN;
uniform int uC;
uniform float uL;
uniform float uChop;
uniform float uJth;
uniform float uSoft;
// exp(-dt / tau): foam outlives the crest that made it, as a streak that
// stays put while the wave runs on. Zero dt (shot mode) holds it.
uniform float uKeep;
layout(location = 0) out vec4 oDisp;
layout(location = 1) out vec4 oNrm;
vec3 D(ivec2 p) {
  p = ivec2((p.x + uN) % uN, (p.y + uN) % uN);
  vec4 v = texelFetch(uFft, ivec2(uC * uN + p.x, p.y), 0);
  return vec3(uChop * v.x, v.z, uChop * v.y);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 d = D(p);
  float h2 = 2.0 * uL / float(uN);
  vec3 tx = vec3(h2, 0.0, 0.0) + D(p + ivec2(1, 0)) - D(p - ivec2(1, 0));
  vec3 tz = vec3(0.0, 0.0, h2) + D(p + ivec2(0, 1)) - D(p - ivec2(0, 1));
  vec3 n = cross(tz, tx);
  vec2 grad = -n.xz / max(n.y, 1e-3 * h2 * h2);
  float J = (tx.x / h2) * (tz.z / h2) - (tz.x / h2) * (tx.z / h2);
  float t = clamp((uJth + uSoft - J) / (2.0 * uSoft), 0.0, 1.0);
  float gen = t * t * (3.0 - 2.0 * t);
  float foam = max(gen, texelFetch(uPrev, p, 0).a * uKeep);
  oDisp = vec4(d, 0.0);
  oNrm = vec4(grad, J, foam);
}
`;

const OCEAN_VERT = /* glsl */ `
precision highp float;
// x, z: offset from the camera, metres. y: the vertex spacing there, which
// picks the displacement mip so a far vertex samples the waves it can carry
// rather than skipping between crests as the grid slides with the camera.
in vec3 position;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform sampler2D uOceanDisp0;
uniform sampler2D uOceanDisp1;
uniform vec2 uOceanPatch;
uniform float uOceanN;
// The drape's uv as an affine map of world xz, fitted about the camera each
// frame; see Terrain.drapeUv.
uniform vec3 uOceanUvU;
uniform vec3 uOceanUvV;
${OCEAN_VS_GLSL}
out vec2 vUv;
out vec3 vNormal;
out vec3 vWorld;
out float vViewDist;
out vec2 vOceanXZ;
out float vOceanH;
void main() {
  vec2 xz = uOceanCentre.xz + position.xz;
  float sd = oceanShoreD(xz);
  float amp = oceanRadial(xz) * oceanGeomRamp(sd) * oceanFetchAmp(sd);
  vec3 d = textureLod(uOceanDisp0, xz / uOceanPatch.x, log2(max(position.y * uOceanN / uOceanPatch.x, 1.0))).xyz;
#if OCEAN_CASCADES > 1
  d += textureLod(uOceanDisp1, xz / uOceanPatch.y, log2(max(position.y * uOceanN / uOceanPatch.y, 1.0))).xyz;
#endif
  d *= amp;
  vec3 w = vec3(xz.x + d.x, uWaterLevel + d.y, xz.y + d.z);
  vWorld = w;
  vOceanXZ = xz;
  vOceanH = d.y;
  vUv = vec2(dot(uOceanUvU, vec3(1.0, w.xz)), dot(uOceanUvV, vec3(1.0, w.xz)));
  // Level, in WORLD space: the shader hangs the wave normal off this, and the
  // water mask is ~1 everywhere the mesh survives its discard.
  vNormal = vec3(0.0, 1.0, 0.0);
  vViewDist = length(w - uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

interface OceanOwnUniforms {
  uDrape: THREE.IUniform<THREE.Texture | null>;
  uOceanUvU: THREE.IUniform<THREE.Vector3>;
  uOceanUvV: THREE.IUniform<THREE.Vector3>;
  uOceanDisp0: THREE.IUniform<THREE.Texture | null>;
  uOceanDisp1: THREE.IUniform<THREE.Texture | null>;
  uOceanNrm0: THREE.IUniform<THREE.Texture | null>;
  uOceanNrm1: THREE.IUniform<THREE.Texture | null>;
  uOceanPatch: THREE.IUniform<THREE.Vector2>;
  uOceanN: THREE.IUniform<number>;
  uOceanSlopeVar: THREE.IUniform<THREE.Vector2>;
  uOceanHeightSd: THREE.IUniform<number>;
  uOceanBand: THREE.IUniform<THREE.Vector2>;
}

/**
 * Whether this context can run the FFT: it renders to RGBA32F and RGBA16F,
 * which WebGL2 only allows with EXT_color_buffer_float. Without it the terrain
 * water is what the device gets, exactly as before.
 */
export function oceanSupported(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext();
  return typeof WebGL2RenderingContext !== "undefined"
    && gl instanceof WebGL2RenderingContext
    && gl.getExtension("EXT_color_buffer_float") !== null;
}

/**
 * The camera-centred polar grid: dense under the lens, geometric out to the
 * rim in two zones (see OceanPlan for why two).
 */
function buildGrid(plan: OceanPlan): THREE.BufferGeometry {
  const segs = plan.gridSegments;
  const rings = plan.nearRings + plan.farRings;
  const nearRatio = Math.pow(plan.nearM / plan.innerM, 1 / plan.nearRings);
  const farRatio = Math.pow(plan.radiusM / plan.nearM, 1 / (plan.farRings - 1));
  const pos = new Float32Array((1 + rings * segs) * 3);
  pos[1] = plan.innerM;
  for (let j = 0; j < rings; j++) {
    const near = j < plan.nearRings;
    const ratio = near ? nearRatio : farRatio;
    const r = near ? plan.innerM * Math.pow(nearRatio, j) : plan.nearM * Math.pow(farRatio, j - plan.nearRings);
    const spacing = Math.max(r * (ratio - 1), (r * 2 * Math.PI) / segs);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * 2 * Math.PI;
      const v = 1 + j * segs + i;
      pos[v * 3] = Math.cos(a) * r;
      pos[v * 3 + 1] = spacing;
      pos[v * 3 + 2] = Math.sin(a) * r;
    }
  }
  const nIdx = segs * 3 + (rings - 1) * segs * 6;
  // 16-bit where the vertex count allows (the phone grid): half the bytes,
  // and render/budget.ts counts it that way.
  const idx = pos.length / 3 < 65536 ? new Uint16Array(nIdx) : new Uint32Array(nIdx);
  let o = 0;
  for (let i = 0; i < segs; i++) {
    idx[o++] = 0; idx[o++] = 1 + ((i + 1) % segs); idx[o++] = 1 + i;
  }
  for (let j = 0; j < rings - 1; j++) {
    for (let i = 0; i < segs; i++) {
      const a = 1 + j * segs + i;
      const b = 1 + j * segs + ((i + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      idx[o++] = a; idx[o++] = b; idx[o++] = c;
      idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

function floatTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

/** Displacement + (gradient, Jacobian, foam), half float, tiling and mipmapped. */
function cascadeTarget(n: number, anisotropy: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(n, n, {
    count: 2,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    generateMipmaps: true,
  });
  for (const t of rt.textures) t.anisotropy = anisotropy;
  return rt;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly link: OceanLinkUniforms;
  private readonly plan: OceanPlan;
  private readonly bands: OceanBand[];
  private readonly n: number;
  private readonly gauss: Float32Array[];
  private readonly h0: THREE.DataTexture;
  private readonly fft: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /** Per cascade, two targets: this frame's and last frame's (for the foam). */
  private readonly out: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget][];
  private frame = 0;
  private readonly own: OceanOwnUniforms;
  private readonly terrain: Terrain;
  private readonly passScene = new THREE.Scene();
  private readonly passCamera = new THREE.Camera();
  private readonly quad: THREE.Mesh;
  private readonly spectrumMat: THREE.RawShaderMaterial;
  private readonly fftMat: THREE.RawShaderMaterial;
  private readonly postMat: THREE.RawShaderMaterial;
  private builtU = -1;
  private builtDir = 0;
  private stats: CascadeStats[] = [];
  private foam: FoamThreshold[] = [];
  private time = 0;
  private keep = 1;
  private lastFft = 0;

  constructor(plan: OceanPlan, terrain: Terrain, anisotropy: number) {
    this.plan = plan;
    this.terrain = terrain;
    this.bands = cascadeBands(plan.cascades);
    // One N for every cascade: they share the FFT texture side by side.
    this.n = plan.cascades[0].n;
    const nc = plan.cascades.length;
    const w = this.n * nc;
    this.gauss = plan.cascades.map((_, i) => cascadeGaussians(this.n, 0x51ed270b + i * 0x9e3779b1));
    this.h0 = new THREE.DataTexture(new Float32Array(w * this.n * 4), w, this.n, THREE.RGBAFormat, THREE.FloatType);
    this.h0.minFilter = THREE.NearestFilter;
    this.h0.magFilter = THREE.NearestFilter;
    this.fft = [floatTarget(w, this.n), floatTarget(w, this.n)];
    this.out = plan.cascades.map(() => [cascadeTarget(this.n, anisotropy), cascadeTarget(this.n, anisotropy)]);

    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const pass = (frag: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial =>
      new THREE.RawShaderMaterial({
        vertexShader: PASS_VERT, fragmentShader: frag, uniforms,
        glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
      });
    this.spectrumMat = pass(SPECTRUM_FRAG, {
      uH0: { value: this.h0 }, uT: { value: 0 }, uW0: { value: (2 * Math.PI) / PHASE_PERIOD_S },
      uN: { value: this.n },
      uPatch: { value: new THREE.Vector2(plan.cascades[0].patchM, plan.cascades[nc - 1].patchM) },
    });
    this.fftMat = pass(FFT_FRAG, { uSrc: { value: null }, uN: { value: this.n }, uP: { value: 1 }, uHoriz: { value: 1 } });
    this.postMat = pass(POST_FRAG, {
      uFft: { value: null }, uPrev: { value: null }, uN: { value: this.n }, uC: { value: 0 },
      uL: { value: 1 }, uChop: { value: OCEAN_CHOP }, uJth: { value: -10 }, uSoft: { value: 0.1 }, uKeep: { value: 1 },
    });
    this.quad = new THREE.Mesh(tri, this.spectrumMat);
    this.quad.frustumCulled = false;
    this.passScene.add(this.quad);

    this.link = oceanLinkUniforms();
    this.link.uOceanRadius.value = plan.radiusM;
    for (const u of terrain.uniforms) Object.assign(u, this.link);

    this.own = {
      uDrape: { value: null },
      uOceanUvU: { value: new THREE.Vector3() },
      uOceanUvV: { value: new THREE.Vector3() },
      uOceanDisp0: { value: this.out[0][0].textures[0] },
      uOceanDisp1: { value: this.out[nc - 1][0].textures[0] },
      uOceanNrm0: { value: this.out[0][0].textures[1] },
      uOceanNrm1: { value: this.out[nc - 1][0].textures[1] },
      uOceanPatch: { value: new THREE.Vector2(plan.cascades[0].patchM, plan.cascades[nc - 1].patchM) },
      uOceanN: { value: this.n },
      uOceanSlopeVar: { value: new THREE.Vector2() },
      uOceanHeightSd: { value: 0.1 },
      uOceanBand: { value: new THREE.Vector2(this.bands[nc - 1].lamLo, this.bands[0].lamHi) },
    };
    // Every terrain uniform by reference (ring 1's: all rings hold the same
    // values except their drape, which the ocean picks for itself), then its
    // own on top.
    const shared: TerrainUniforms = terrain.uniforms[Math.min(1, terrain.uniforms.length - 1)];
    const mat = new THREE.RawShaderMaterial({
      vertexShader: OCEAN_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms: { ...shared, ...this.link, ...this.own },
      glslVersion: THREE.GLSL3,
      defines: { OCEAN: 1, OCEAN_CASCADES: nc },
      // The grid's triangles all face up, so culling would only ever cut the
      // whole sea when seen from below the surface, where nothing is drawn.
      side: THREE.DoubleSide,
      // Where the waves have flattened onto a coast the mesh lies exactly on
      // the unsunk terrain water; this makes the mesh win that tie.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(buildGrid(plan), mat);
    this.mesh.name = "ocean";
    this.mesh.frustumCulled = false;
    // Before the terrain, so the sunk water under it fails the depth test.
    this.mesh.renderOrder = -1;
  }

  /** Switch the whole ocean on or off (the "ocean" kill switch), sink included. */
  setActive(on: boolean): void {
    this.link.uOceanOn.value = on ? 1 : 0;
    this.mesh.visible = on;
  }

  get active(): boolean {
    return this.link.uOceanOn.value > 0.5;
  }

  /**
   * Per-frame state: the clock, the wind and where the disc is. `wind` is the
   * terrain's own uWind, (east, south) m/s. Rebuilding h0 is ~10 ms of CPU at
   * the full plan, so it happens only when the wind has moved enough to see.
   */
  update(camera: THREE.Vector3, time: number, dt: number, wind: THREE.Vector2): void {
    const U = Math.min(25, Math.max(0.5, wind.length()));
    const dir = Math.atan2(wind.y, wind.x);
    let dd = Math.abs(dir - this.builtDir);
    dd = Math.min(dd, 2 * Math.PI - dd);
    if (this.builtU < 0 || Math.abs(U - this.builtU) > 0.25 || dd > 0.04) this.rebuild(U, dir);
    this.time = time % PHASE_PERIOD_S;
    this.keep = Math.exp(-Math.max(0, dt) / 4);
    this.link.uOceanCentre.value.set(camera.x, 0, camera.z);

    // The finest static drape that covers the whole disc; see Terrain.drapeUv.
    const ring = this.terrain.drapeCovering(camera.x, camera.z, this.plan.radiusM);
    this.own.uDrape.value = this.terrain.uniforms[ring].uDrape.value;
    const [u0, v0] = this.terrain.drapeUv(ring, camera.x, camera.z);
    const [u1, v1] = this.terrain.drapeUv(ring, camera.x + 1000, camera.z);
    const [u2, v2] = this.terrain.drapeUv(ring, camera.x, camera.z + 1000);
    const du = [(u1 - u0) / 1000, (u2 - u0) / 1000];
    const dv = [(v1 - v0) / 1000, (v2 - v0) / 1000];
    this.own.uOceanUvU.value.set(u0 - du[0] * camera.x - du[1] * camera.z, du[0], du[1]);
    this.own.uOceanUvV.value.set(v0 - dv[0] * camera.x - dv[1] * camera.z, dv[0], dv[1]);
  }

  private rebuild(U: number, dir: number): void {
    const wx = Math.cos(dir);
    const wz = Math.sin(dir);
    const data = this.h0.image.data as Float32Array;
    const stride = this.n * this.plan.cascades.length;
    this.stats = this.plan.cascades.map((c, i) => {
      writeH0(c, this.bands[i], this.gauss[i], U, wx, wz, OCEAN_FETCH_REF_M, data, i * this.n, stride);
      return cascadeStats(c, this.bands[i], U, wx, wz);
    });
    this.h0.needsUpdate = true;
    this.builtU = U;
    this.builtDir = dir;
    // Each cascade foams on its own Jacobian and the shader takes the larger:
    // in a light wind the peak sits in the short cascade and the long one
    // holds only swell, and in a gale the reverse.
    this.foam = this.stats.map((s) => foamThreshold(U, s.slopeVar));
    const sv = this.stats.map((s) => s.slopeVar);
    this.own.uOceanSlopeVar.value.set(sv[0], sv.length > 1 ? sv[1] : 0);
    const hv = this.stats.reduce((a, s) => a + s.heightVar, 0);
    this.own.uOceanHeightSd.value = Math.sqrt(hv);
    // 1.4 is oceanFetchAmp's cap; 3.5 sd is past any trough a frame shows.
    this.link.uOceanSink.value = 1.4 * 3.5 * Math.sqrt(hv) + 0.3;
  }

  /**
   * RMS of last frame's GPU displacement per cascade, read back, against what
   * the spectrum expects: the in-browser twin of the vacuity probe in
   * test/ocean.check.ts. A stall, so for the console and the harness only.
   */
  probe(renderer: THREE.WebGLRenderer): { rms: number[]; expected: number[]; mapRms: number[][] } {
    const w = this.n * this.plan.cascades.length;
    const px = new Float32Array(w * this.n * 4);
    renderer.readRenderTargetPixels(this.fft[this.lastFft], 0, 0, w, this.n, px);
    const rms = this.plan.cascades.map((_, c) => {
      let s = 0;
      for (let y = 0; y < this.n; y++) {
        for (let x = 0; x < this.n; x++) s += px[(y * w + c * this.n + x) * 4 + 2] ** 2;
      }
      return Math.sqrt(s / (this.n * this.n));
    });
    // And the maps the mesh samples, through the half-float path: the same
    // rms of height, and of the gradient the shading uses.
    const cur = (this.frame - 1) & 1;
    const half = new Uint16Array(this.n * this.n * 4);
    const mapRms = this.plan.cascades.map((_, c) => {
      const out: number[] = [];
      for (const att of [0, 1]) {
        renderer.readRenderTargetPixels(this.out[c][cur], 0, 0, this.n, this.n, half, undefined, att);
        let s = 0;
        const ch = att === 0 ? 1 : 0;
        for (let i = 0; i < this.n * this.n; i++) s += THREE.DataUtils.fromHalfFloat(half[i * 4 + ch]) ** 2;
        out.push(Math.sqrt(s / (this.n * this.n)));
      }
      return out;
    });
    return { rms, expected: this.stats.map((s) => Math.sqrt(s.heightVar)), mapRms };
  }

  /** The FFT passes. Call once a frame before the scene draws; restores the render target. */
  simulate(renderer: THREE.WebGLRenderer): void {
    if (!this.active) return;
    const prevTarget = renderer.getRenderTarget();
    const draw = (mat: THREE.RawShaderMaterial, to: THREE.WebGLRenderTarget): void => {
      this.quad.material = mat;
      renderer.setRenderTarget(to);
      renderer.render(this.passScene, this.passCamera);
    };

    this.spectrumMat.uniforms.uT.value = this.time;
    draw(this.spectrumMat, this.fft[0]);
    let src = 0;
    const fu = this.fftMat.uniforms;
    for (const horiz of [1, 0]) {
      for (let p = 1; p < this.n; p *= 2) {
        fu.uSrc.value = this.fft[src].texture;
        fu.uP.value = p;
        fu.uHoriz.value = horiz;
        draw(this.fftMat, this.fft[1 - src]);
        src = 1 - src;
      }
    }

    this.lastFft = src;
    const cur = this.frame & 1;
    const pu = this.postMat.uniforms;
    pu.uFft.value = this.fft[src].texture;
    pu.uKeep.value = this.keep;
    for (let c = 0; c < this.plan.cascades.length; c++) {
      pu.uC.value = c;
      pu.uL.value = this.plan.cascades[c].patchM;
      pu.uJth.value = this.foam[c].jth;
      pu.uSoft.value = this.foam[c].soft;
      pu.uPrev.value = this.out[c][1 - cur].textures[1];
      draw(this.postMat, this.out[c][cur]);
    }
    const last = this.plan.cascades.length - 1;
    this.own.uOceanDisp0.value = this.out[0][cur].textures[0];
    this.own.uOceanNrm0.value = this.out[0][cur].textures[1];
    this.own.uOceanDisp1.value = this.out[last][cur].textures[0];
    this.own.uOceanNrm1.value = this.out[last][cur].textures[1];
    this.frame++;
    renderer.setRenderTarget(prevTarget);
  }
}
