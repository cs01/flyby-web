// The screen-space ambient occlusion pass: a depth prepass, GTAO, and a
// denoise, producing visibility AND a bent normal for the surface shaders.
//
// The maths lives in gtao.ts, which has no THREE in it and is gated by
// test/gtao.check.ts. This file is the plumbing: where the depth comes from,
// what resolution the search runs at, and how the result reaches a fragment.
//
// WHY A DEPTH PREPASS RATHER THAN THE SCENE TARGET'S OWN DEPTH.
//
// The result has to be available WHILE terrain, buildings and roads shade,
// because the point of the bent normal is to change which direction they look
// the sky irradiance up in. The scene target's depth texture only exists after
// those shaders have already run, so using it would mean applying the occlusion
// a frame late, and a frame late in a flight sim is a smear that swims behind
// every camera movement. A prepass costs one more geometry pass with colour
// writes off and no fragment shading, which is the same thing the sun cascades
// already do three times.
//
// It also removes a hazard rather than handling it. The scene target is
// multisampled (samples: 4 on desktop, 0 on a coarse-pointer device), and
// reading depth back out of an MSAA target in WebGL2 depends on three.js
// blitting DEPTH_BUFFER_BIT into the single-sample framebuffer the DepthTexture
// is attached to. It does: resolveDepthBuffer defaults to true, the blit is
// unconditional, and composite.ts has been relying on it since the cloud march
// existed. But it happens on UNBIND, so a pass reading that texture is ordered
// against an implicit resolve and behaves differently on the samples: 0 path,
// where there is no resolve at all. This target is single-sample and ours, so
// one code path serves both devices.
//
// DEPTH PRECISION. The frustum is 2 m to 200 km with no logarithmic depth
// buffer. The quantisation of a 24-bit fixed-point depth at view distance z is
// about z^2 * (far - near) / (near * far * 2^24), which for this frustum is
// z^2 * 3.0e-8 metres: 0.3 mm at 100 m, 3 cm at 1 km, 3 m at 10 km. The near
// plane, not the far one, is what sets that. So the reconstruction is fine
// where AO is worth having and turns to noise a long way out, which is why
// visibility is faded back to 1 over uFadeStart..uFadeEnd rather than trusted
// to the horizon.

import * as THREE from "three";
import { GTAO_GLSL } from "./gtao";
import { createDepthOnlyMaterial, SHADOW_CASTER_LAYER } from "./sunshadow";

const VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 1.0, 1.0);
}
`;

/** Slices around each pixel. Each searches both ways, so they span pi. */
const SLICES = 3;
/** Horizon samples per direction per slice. */
const STEPS = 6;
/**
 * Exponent on the step spacing; see GtaoSettings.stepCurve in gtao.ts. Uniform
 * steps over a radius wide enough to reach the next building step straight
 * over the kerb at the foot of this one.
 */
const STEP_CURVE = 2.0;

const FRAG = /* glsl */ `
precision highp float;
${GTAO_GLSL}

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uDepth;
uniform vec2  uTexel;        // 1 / AO buffer size
uniform vec2  uViewScale;    // tan(fov/2) * (aspect, 1)
uniform mat3  uViewToWorld;
uniform float uNear;
uniform float uFar;
uniform float uFocalPx;      // pixels one metre subtends at one metre
uniform float uRadius;       // world metres
uniform float uMaxRadiusPx;
uniform float uFalloffStart; // fraction of uRadius
uniform vec2  uFade;         // view distance where AO starts and finishes fading out

const int SLICES = ${SLICES};
const int STEPS = ${STEPS};

/**
 * View distance along -z, in metres, from the hardware depth buffer.
 *
 * A cleared texel reads 1.0, which this returns as a very large number so the
 * search treats sky as "nothing there" rather than as an occluder at the far
 * plane. Without that, every silhouette against the sky would be ringed.
 */
float linearDepth(float d) {
  if (d >= 0.999999) return 1e9;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec3 viewPosAt(vec2 uv) {
  float depth = linearDepth(texture(uDepth, uv).r);
  return vec3((uv * 2.0 - 1.0) * uViewScale, -1.0) * depth;
}

void main() {
  float centreDepth = linearDepth(texture(uDepth, vUv).r);
  vec3 P = vec3((vUv * 2.0 - 1.0) * uViewScale, -1.0) * centreDepth;

  // Sky, or past the fade: nothing to occlude and nothing to bend. A zero
  // direction is the agreed "no bent normal here" value; see AO_GLSL below.
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, centreDepth);
  if (centreDepth > 1e8 || fade <= 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Normal from depth, taking the SHORTER of the two one-sided differences on
  // each axis. A centred difference straddles a silhouette and produces a
  // normal that belongs to neither surface, which on a city of hard vertical
  // edges is every building outline in the frame.
  vec3 pr = viewPosAt(vUv + vec2(uTexel.x, 0.0));
  vec3 pl = viewPosAt(vUv - vec2(uTexel.x, 0.0));
  vec3 pu = viewPosAt(vUv + vec2(0.0, uTexel.y));
  vec3 pd = viewPosAt(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? (pr - P) : (P - pl);
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? (pu - P) : (P - pd);
  vec3 N = cross(dx, dy);
  float nlen = length(N);
  if (nlen < 1e-12) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  N /= nlen;
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;

  float radiusPx = min(uMaxRadiusPx, uRadius * uFocalPx / max(centreDepth, 1e-4));
  if (radiusPx < 1.0) {
    fragColor = vec4(uViewToWorld * N, 1.0);
    return;
  }
  float fadeStart = uFalloffStart * uRadius;
  float fadeSpan = max(1e-4, uRadius - fadeStart);

  // Per-pixel slice rotation and step offset. Interleaved gradient noise, which
  // has almost all its energy above the 4x4 period the denoise below removes;
  // a per-pixel hash instead leaves low-frequency blotches the blur cannot
  // reach. Driven by gl_FragCoord alone and never by time, because the
  // screenshot harness compares two builds pixel for pixel.
  vec2 fc = gl_FragCoord.xy;
  float ign = fract(52.9829189 * fract(0.06711056 * fc.x + 0.00583715 * fc.y));
  float stepOffset = fract(floor(fc.x) * 0.5 + floor(fc.y) * 0.25);

  float visibility = 0.0;
  vec3 bent = vec3(0.0);

  for (int slice = 0; slice < SLICES; slice++) {
    float phi = (float(slice) + ign) * (3.14159265359 / float(SLICES));
    vec2 dir = vec2(cos(phi), sin(phi));

    vec3 axis = cross(vec3(dir, 0.0), V);
    float alen = length(axis);
    if (alen < 1e-9) continue;
    axis /= alen;
    vec3 T = normalize(cross(V, axis));

    vec3 nProj = N - axis * dot(N, axis);
    float projLen = length(nProj);
    if (projLen < 1e-6) continue;
    nProj /= projLen;

    float g = atan(dot(nProj, T), dot(nProj, V));

    // -1 is "no occluder anywhere", which clamps to the open hemisphere below.
    float cosPos = -1.0;
    float cosNeg = -1.0;

    for (int si = 0; si < STEPS; si++) {
      float d = radiusPx * pow((float(si) + 1.0 + stepOffset) / float(STEPS), ${STEP_CURVE.toFixed(1)});
      vec2 o = dir * d * uTexel;

      vec3 qp = viewPosAt(vUv + o);
      vec3 ep = qp - P;
      float lp = length(ep);
      if (lp > 1e-6 && qp.z > -1e8) {
        float c = dot(ep, V) / lp;
        float w = clamp(1.0 - (lp - fadeStart) / fadeSpan, 0.0, 1.0);
        cosPos = max(cosPos, mix(cosPos, c, w));
      }

      vec3 qn = viewPosAt(vUv - o);
      vec3 en = qn - P;
      float ln = length(en);
      if (ln > 1e-6 && qn.z > -1e8) {
        float c = dot(en, V) / ln;
        float w = clamp(1.0 - (ln - fadeStart) / fadeSpan, 0.0, 1.0);
        cosNeg = max(cosNeg, mix(cosNeg, c, w));
      }
    }

    float hPos = acos(clamp(cosPos, -1.0, 1.0));
    float hNeg = -acos(clamp(cosNeg, -1.0, 1.0));
    float h2 = g + min(hPos - g, GTAO_HALF_PI);
    float h1 = g + max(hNeg - g, -GTAO_HALF_PI);

    visibility += projLen * gtaoSliceVisibility(h1, h2, g);
    bent += projLen * (T * gtaoSliceBentTangent(h1, h2, g)
                     + V * gtaoSliceBentView(h1, h2, g));
  }

  visibility = clamp(visibility / float(SLICES), 0.0, 1.0);
  float bl = length(bent);
  vec3 bentView = bl > 1e-7 ? bent / bl : N;

  // Fade back to fully open with distance, both the level and the direction, so
  // the horizon does not develop a band of noise where the depth buffer runs
  // out of resolution.
  visibility = mix(1.0, visibility, fade);
  bentView = normalize(mix(N, bentView, fade));

  // Stored as direction * visibility so the denoise below averages visibility
  // CONES rather than directions: a pixel that can see nothing must not get an
  // equal vote on which way the open sky is.
  fragColor = vec4((uViewToWorld * bentView) * visibility, visibility);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform sampler2D uDepth;
uniform vec2  uTexel;
uniform float uNear;
uniform float uFar;

float linearDepth(float d) {
  if (d >= 0.999999) return 1e9;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

/**
 * 4x4 box, weighted by depth similarity.
 *
 * Four by four because that is exactly the period of the interleaved-gradient
 * rotation in the pass above: a smaller kernel leaves the slice pattern in as
 * a visible weave, and a larger one only blurs across geometry the depth weight
 * is then fighting to keep apart.
 */
void main() {
  float centre = linearDepth(texture(uDepth, vUv).r);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 1; y++) {
    for (int x = -2; x <= 1; x++) {
      vec2 uv = vUv + vec2(float(x) + 0.5, float(y) + 0.5) * uTexel;
      float d = linearDepth(texture(uDepth, uv).r);
      // Tolerance proportional to distance: a 20 cm step matters on a kerb at
      // 30 m and is below the depth buffer's own resolution at 3 km.
      float w = step(abs(d - centre), 0.02 * centre + 0.05);
      sum += texture(uSource, uv) * w;
      wsum += w;
    }
  }
  fragColor = wsum > 0.0 ? sum / wsum : texture(uSource, vUv);
}
`;

/**
 * The sampling half, interpolated into every surface shader that wants sky
 * occlusion, so there is one definition of how the buffer is read.
 *
 * `uAoStrength` is zero whenever this material is being drawn into something
 * that is not the main frame -- the aircraft's environment cube, which has its
 * own camera and its own viewport -- because gl_FragCoord means something else
 * there and the lookup would be reading the wrong pixel of the wrong frame.
 */
export const AO_GLSL = /* glsl */ `
uniform sampler2D uAo;
uniform float uAoStrength;
uniform vec2 uAoInvResolution;

struct SkyOcclusion {
  float visibility;
  vec3 bentNormal;
};

SkyOcclusion sampleSkyOcclusion(vec3 n) {
  SkyOcclusion o;
  o.visibility = 1.0;
  o.bentNormal = n;
  if (uAoStrength <= 0.0) return o;

  vec4 s = texture(uAo, gl_FragCoord.xy * uAoInvResolution);
  o.visibility = mix(1.0, s.a, uAoStrength);

  // The stored direction is scaled by visibility, and near a silhouette a
  // bilinear tap mixes in the zero the sky texels carry. A short vector is
  // therefore "not much information here", not "the sky is that way".
  float len = length(s.rgb);
  if (len > 1e-3) {
    vec3 b = s.rgb / len;
    // The AO pass derives its normal from depth and this one comes from the
    // geometry, so they can disagree by a lot on a facade detail. Refusing a
    // bent normal that has ended up under the shading normal is what keeps a
    // wall from picking up the pavement's light.
    if (dot(b, n) > 0.0) o.bentNormal = normalize(mix(n, b, uAoStrength));
  }
  return o;
}

/**
 * Sky irradiance a surface with this normal actually receives.
 *
 * shIrradiance(bentNormal) * visibility is GTAO's own diffuse form and it is
 * the whole reason for computing a bent normal: a wall in a canyon then gets
 * the light from the strip of sky it can see, up and along the street, rather
 * than a uniformly dimmed sample of the whole dome.
 *
 * The min is not tidying. That form does not respect its own bound: the bent
 * normal leans toward the open part of the sky, which is also the bright part,
 * and a cosine lobe pointed there can integrate to MORE than the same lobe on
 * the geometric normal even after the visibility factor has been applied.
 * Measured on the Chelsea rooftop pose, that came out as a fraction of a code
 * value of extra light over most of the facades in the frame while the corners
 * correctly went dark. Putting a wall next to a surface cannot brighten it, so
 * the unoccluded irradiance is the ceiling.
 *
 * Requires SH_GLSL, which every caller interpolates before this.
 */
vec3 occludedSkyIrradiance(vec3 n) {
  SkyOcclusion o = sampleSkyOcclusion(n);
  return min(shIrradiance(o.bentNormal) * o.visibility, shIrradiance(n));
}
`;

export interface AoUniforms extends Record<string, THREE.IUniform> {
  uAo: THREE.IUniform<THREE.Texture | null>;
  uAoStrength: THREE.IUniform<number>;
  uAoInvResolution: THREE.IUniform<THREE.Vector2>;
}

/** Fresh uniforms for one material, pointing at nothing until the pass runs. */
export function aoUniforms(): AoUniforms {
  return {
    uAo: { value: null },
    uAoStrength: { value: 0 },
    uAoInvResolution: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
  };
}

function fullscreenGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

/** Half the drawing buffer in each axis. AO is low frequency; full res buys nothing. */
const AO_SCALE = 0.5;

const _size = new THREE.Vector2();

export class AoPass {
  /** Off makes render() a no-op and leaves every consumer unoccluded; for A/B timing. */
  enabled = true;

  private depthTarget: THREE.WebGLRenderTarget;
  private rawTarget: THREE.WebGLRenderTarget;
  private blurTarget: THREE.WebGLRenderTarget;
  private readonly depthMaterial: THREE.RawShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly blurScene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly blurUniforms: Record<string, THREE.IUniform>;
  /** Width and height of the frame the last render() was fitted to. */
  private frameSize = new THREE.Vector2(1, 1);
  /** Kept across calls so measure() does not allocate a megabyte per sample. */
  private readback: Uint16Array | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    const s = this.aoSize(renderer);

    this.depthTarget = makeDepthTarget(s.x, s.y);
    const opts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rawTarget = new THREE.WebGLRenderTarget(s.x, s.y, opts);
    this.blurTarget = new THREE.WebGLRenderTarget(s.x, s.y, opts);

    this.depthMaterial = createDepthOnlyMaterial();

    this.uniforms = {
      uDepth: { value: this.depthTarget.depthTexture },
      uTexel: { value: new THREE.Vector2(1 / s.x, 1 / s.y) },
      uViewScale: { value: new THREE.Vector2(1, 1) },
      uViewToWorld: { value: new THREE.Matrix3() },
      uNear: { value: 2 },
      uFar: { value: 200000 },
      uFocalPx: { value: 1 },
      // Fourteen metres. Long enough to reach off a roof onto the one below
      // it, down a light well and across the gap between two buildings on the
      // same block; short enough that the projected radius is affordable on
      // the geometry that fills the frame. The step curve above is what makes
      // a radius this wide still resolve the kerb.
      //
      // The street canyon proper is 30 to 60 m and is NOT what this term is
      // for: from a camera in the canyon the far wall is most of a screen
      // width away and the pavement below is frequently not in the frame at
      // all. That is why buildings.ts keeps its analytic canyon term.
      uRadius: { value: 14 },
      // Roughly a quarter of the buffer's width. A surface close enough to
      // project a wider radius than this is close enough that the search
      // becomes a cache-miss generator for occlusion that is already resolved.
      uMaxRadiusPx: { value: 96 },
      uFalloffStart: { value: 0.7 },
      // The fade is a backstop, not the working limit: past about 2 km the
      // radius projects to under a pixel and the search early-outs on its own.
      // What this is for is the band before that, where the depth buffer's own
      // quantisation is starting to show and a horizon found in it would be
      // noise rather than geometry.
      uFade: { value: new THREE.Vector2(1200, 3000) },
    };
    this.blurUniforms = {
      uSource: { value: this.rawTarget.texture },
      uDepth: { value: this.depthTarget.depthTexture },
      uTexel: { value: new THREE.Vector2(1 / s.x, 1 / s.y) },
      uNear: { value: 2 },
      uFar: { value: 200000 },
    };

    const add = (scene: THREE.Scene, frag: string, uniforms: Record<string, THREE.IUniform>) => {
      const mesh = new THREE.Mesh(
        fullscreenGeometry(),
        new THREE.RawShaderMaterial({
          vertexShader: VERT,
          fragmentShader: frag,
          uniforms,
          glslVersion: THREE.GLSL3,
          depthTest: false,
          depthWrite: false,
        }),
      );
      mesh.frustumCulled = false;
      scene.add(mesh);
    };
    add(this.scene, FRAG, this.uniforms);
    add(this.blurScene, BLUR_FRAG, this.blurUniforms);
  }

  /** The denoised buffer: world-space bent normal times visibility, then visibility. */
  get texture(): THREE.Texture {
    return this.blurTarget.texture;
  }

  private aoSize(renderer: THREE.WebGLRenderer): THREE.Vector2 {
    renderer.getDrawingBufferSize(_size);
    return new THREE.Vector2(
      Math.max(1, Math.floor(_size.x * AO_SCALE)),
      Math.max(1, Math.floor(_size.y * AO_SCALE)),
    );
  }

  resize(renderer: THREE.WebGLRenderer): void {
    const s = this.aoSize(renderer);
    if (s.x === this.rawTarget.width && s.y === this.rawTarget.height) return;
    this.depthTarget.setSize(s.x, s.y);
    this.rawTarget.setSize(s.x, s.y);
    this.blurTarget.setSize(s.x, s.y);
    // setSize on a target with a depth texture replaces nothing, but the
    // texture object is the one the uniform holds, so re-pointing it costs
    // nothing and cannot go stale.
    this.uniforms.uDepth.value = this.depthTarget.depthTexture;
    this.blurUniforms.uDepth.value = this.depthTarget.depthTexture;
    (this.uniforms.uTexel.value as THREE.Vector2).set(1 / s.x, 1 / s.y);
    (this.blurUniforms.uTexel.value as THREE.Vector2).set(1 / s.x, 1 / s.y);
  }

  /**
   * Depth prepass, horizon search, denoise. Once per frame, BEFORE the main
   * scene render and after everything that moves the camera.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    extra: readonly THREE.Scene[] = [],
  ): void {
    if (!this.enabled) return;
    this.resize(renderer);
    renderer.getDrawingBufferSize(this.frameSize);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    const prevLayers = camera.layers.mask;

    scene.overrideMaterial = this.depthMaterial;
    renderer.autoClear = false;
    // The same layer the sun cascades use: it excludes the sky (a full-screen
    // triangle that would blanket the depth buffer at the far plane), the
    // clouds, the beacons and the labels. Roads are not on it and do not need
    // to be, since they sit within centimetres of the terrain that is.
    camera.layers.set(SHADOW_CASTER_LAYER);
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear(false, true, false);
    renderer.render(scene, camera);
    // Casters whose vertex shader moves the geometry, in scenes of their own so
    // the override does not replace the shader that positions them; see
    // SunShadow.update. A canopy occludes the ground under it, and leaving the
    // trees out of this buffer would have them read the sky occlusion of
    // whatever is BEHIND them.
    if (extra.length) {
      scene.overrideMaterial = null;
      for (const e of extra) renderer.render(e, camera);
    }

    camera.layers.mask = prevLayers;
    scene.overrideMaterial = prevOverride;
    renderer.autoClear = prevAutoClear;

    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    (this.uniforms.uViewScale.value as THREE.Vector2).set(tanHalf * camera.aspect, tanHalf);
    (this.uniforms.uViewToWorld.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
    this.uniforms.uNear.value = camera.near;
    this.uniforms.uFar.value = camera.far;
    this.blurUniforms.uNear.value = camera.near;
    this.blurUniforms.uFar.value = camera.far;
    // Pixels per metre at one metre, in the AO buffer's own pixels.
    this.uniforms.uFocalPx.value = this.rawTarget.height / (2 * tanHalf);

    renderer.setRenderTarget(this.rawTarget);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.blurTarget);
    renderer.render(this.blurScene, this.camera);
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * What the buffer actually contains, for the frame counter and for judging a
   * radius change by a number instead of by eye.
   *
   * `mean` over-reports on its own: sky and anything past the fade are stored
   * as fully open, and on a shot of a skyline most of the frame is one or the
   * other. `occluded` is the fraction of pixels the pass actually darkened,
   * which is the number that says whether a tuning change reached anything.
   */
  measure(renderer: THREE.WebGLRenderer): { mean: number; occluded: number; darkest: number } {
    const w = this.blurTarget.width;
    const h = this.blurTarget.height;
    const need = w * h * 4;
    if (!this.readback || this.readback.length !== need) this.readback = new Uint16Array(need);
    const buf = this.readback;
    renderer.readRenderTargetPixels(this.blurTarget, 0, 0, w, h, buf);
    const half = THREE.DataUtils.fromHalfFloat;
    let sum = 0;
    let dark = 0;
    let darkest = 1;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const v = half(buf[i * 4 + 3]);
      sum += v;
      if (v < 0.95) dark++;
      darkest = Math.min(darkest, v);
    }
    return { mean: sum / n, occluded: dark / n, darkest };
  }

  /**
   * Point a material's AO uniforms at this frame's result.
   *
   * `strength` is the caller's switch for the passes where a screen-space
   * lookup is meaningless: zero while the aircraft's environment cube is being
   * rendered, one for the main frame.
   */
  apply(uniforms: AoUniforms, strength: number): void {
    uniforms.uAo.value = this.enabled ? this.blurTarget.texture : null;
    uniforms.uAoStrength.value = this.enabled ? strength : 0;
    uniforms.uAoInvResolution.value.set(1 / this.frameSize.x, 1 / this.frameSize.y);
  }

  dispose(): void {
    this.depthTarget.dispose();
    this.rawTarget.dispose();
    this.blurTarget.dispose();
    this.depthMaterial.dispose();
  }
}

function makeDepthTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const depth = new THREE.DepthTexture(w, h);
  depth.type = THREE.UnsignedIntType;
  depth.format = THREE.DepthFormat;
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  // Read as an ordinary sampler2D so the pass can linearise it itself.
  depth.compareFunction = null;

  // A colour attachment because three always makes one; the depth material has
  // colorWrite off and the pass never clears it, so one byte per texel of
  // address space and no bandwidth.
  return new THREE.WebGLRenderTarget(w, h, {
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: depth,
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
  });
}
