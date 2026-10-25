// Screen-space reflections on open water, marched against the PREVIOUS frame.
//
// Why the previous frame and not this one: the water is part of the terrain
// drape, which draws INTO the scene target, so the colour and depth it would
// march against are the ones being written. A G-buffer post pass would avoid
// that, but every material here is a forward RawShaderMaterial and none of them
// writes a normal; teaching all of them to is a renderer rewrite. So after the
// scene is drawn its resolved colour and linear depth are copied into one
// RGBA16F history texture, and the NEXT frame's water marches world-space rays
// through it, projected with the matrix that frame was drawn with. Because the
// ray is in world space and projected with the old camera, camera motion is
// handled exactly; only what was disoccluded since is missed, for one frame.
//
// Why not a planar reflection: the water is not one plane. The Chicago river is
// at 176 m, the lake beside it is at 176 m, the bay is at 0 m, and a second
// scene draw at the frame's dominant water height costs the whole building and
// atmosphere bill again (~5 ms of atmosphere alone, roadmap "constraints").
// The march costs only on water pixels, and only where it hits.
//
// What the history colour is: LINEAR HDR from the scene target, before clouds,
// bloom and the tone curve, i.e. the same space the terrain writes. It already
// carries aerial perspective from the camera to the hit, and the water then
// adds the camera-to-water haze on top. That double-counts the haze over the
// camera-to-water leg; on the poses measured it is at most a few percent of
// the reflected radiance and it errs toward the sky colour, which is the
// fallback anyway.

import * as THREE from "three";

/**
 * Included into the terrain fragment shader. Returns the reflected radiance in
 * rgb and the confidence in a; the caller blends toward its own sky reflection
 * by 1 - a. Needs PI-free maths only, so it has no dependency on the
 * atmosphere block.
 */
export const WATER_SSR_GLSL = /* glsl */ `
uniform sampler2D uSsrHistory;
uniform mat4  uSsrViewProj;
uniform vec2  uSsrSize;
// 0 until the first history exists, and under ?nossr=1.
uniform float uSsrOn;
// Radians per history texel, for turning a reflection cone into a mip level.
uniform float uSsrPixelAngle;

#define SSR_STEPS 20
#define SSR_REFINE 7

vec4 ssrMarch(vec3 p0, vec3 r, float viewDist, float alpha) {
  // The first step scales with range because the footprint does: from the
  // kerb a tower base is 30 m away and wants half-metre steps, from 400 m up
  // the far shore is kilometres out and half-metre steps would never get
  // there. Growth of 1.35 per step reaches ~1140 first-steps in 20 steps:
  // ~570 m from the kerb, which is the far end of a river reach, and four
  // and a half times the range to the water from the air. At 1.3 the kerb
  // reach was 240 m and the Chicago towers set back behind the far bank
  // fell off the end of the ray.
  float stepLen = 0.5 + viewDist * 0.004;
  float t = stepLen;
  float tPrev = 0.0;
  float dzPrev = -1.0;
  float vPrev = -1.0;
  // Clip position is linear in t, so the matrix is applied twice per ray
  // rather than once per sample.
  vec4 c0 = uSsrViewProj * vec4(p0, 1.0);
  vec4 cr = uSsrViewProj * vec4(r, 0.0);
  for (int i = 0; i < SSR_STEPS; i++) {
    vec4 c = c0 + cr * t;
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float scene = texelFetch(uSsrHistory, ivec2(uv * uSsrSize), 0).a;
    // Into open sky and still climbing up the screen: nothing in a screen
    // column stands above the sky in it, so this ray can only miss. Most
    // rays off open water end here, and before this exit they ran to the
    // last step: measured at ~9 ms on the harbour pose.
    if (scene > 5.0e4 && uv.y > vPrev) break;
    vPrev = uv.y;
    float dz = c.w - scene;
    // A CROSSING, not merely "behind something". A ray climbing over a hill
    // or a block projects onto it, because the hill hides the ray from the
    // camera, and a thickness test alone calls that a hit: measured on the
    // harbour pose it painted the north shore onto a 300 m band of open
    // water. So the ray must go from in front of the depth surface to behind
    // it between two samples, and the bisected crossing must then land ON the
    // surface; at a silhouette the depth jumps and the bisection ends up
    // straddling the jump, which is a ray passing behind, not a hit.
    if (dz > 0.0 && dzPrev <= 0.0) {
      float lo = tPrev;
      float hi = t;
      float dzHi = dz;
      for (int j = 0; j < SSR_REFINE; j++) {
        float mid = 0.5 * (lo + hi);
        vec4 cm = c0 + cr * mid;
        vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        float dm = cm.w - texelFetch(uSsrHistory, ivec2(clamp(um, 0.0, 1.0) * uSsrSize), 0).a;
        if (dm > 0.0) { hi = mid; dzHi = dm; } else lo = mid;
      }
      vec4 ch = c0 + cr * hi;
      // What one bisected step can still be off by in depth, plus the depth
      // buffer's own quantisation (half float: 1/2048 of the range, doubled).
      // Kept TIGHT on purpose. Seen from above at a shallow angle, the gap
      // between a bridge deck and the water under it is only a few metres of
      // depth, and a looser tolerance accepted rays passing UNDER the Golden
      // Gate deck as hits on its top: a 30 px black band across the bay.
      // The last term is a facade seen obliquely: its depth changes by about
      // a texel's width times the obliquity from one texel to the next, and
      // nearest-texel depth can be off by that much at the crossing.
      float tol = (hi - lo) * 1.5 + ch.w * (0.001 + 2.0 * uSsrPixelAngle) + 0.3;
      // And the hit must stand clear of the water. A near-horizontal ray
      // skims the water's own depth, which half float stores in terraces, and
      // crossed every terrace edge: dotted lines ruled across the harbour.
#ifdef SSR_FACADE
      // Off a facade the hit only has to be clear of the glass it left: three
      // metres out, past the reveal and the mullions of its own wall.
      bool clear = hi > 3.0;
#else
      bool clear = r.y * hi > 0.5 + viewDist * 0.0015;
#endif
      if (dzHi < tol && clear) {
        vec2 uh = ch.xy / ch.w * 0.5 + 0.5;
        // A reflection that runs off the frame has to fade before it gets
        // there, or the edge of the screen is drawn onto the water as a line.
        vec2 edge = min(uh, 1.0 - uh);
        float conf = smoothstep(0.0, 0.07, min(edge.x, edge.y));
        // And so does one that only just hit within the march: the next
        // frame a few metres on would miss it and the reflection would pop.
        conf *= 1.0 - smoothstep(0.7, 1.0, float(i) / float(SSR_STEPS));
        // Rough water blurs the reflection: the GGX lobe's half-angle is
        // about alpha, so the cone at the hit spans alpha * t metres, seen
        // from ch.w metres away. Half of that, because GGX is a sharp core on
        // long tails, not a Gaussian: the eye reads the core, and a box blur
        // the full width of the lobe smeared the Chicago towers into the sky
        // colour they were standing against.
        float spanPx = 0.5 * alpha * hi / max(ch.w * uSsrPixelAngle, 1e-4);
        float lod = clamp(log2(max(spanPx, 1.0)), 0.0, 4.5);
#ifdef SSR_FACADE
        // A curtain wall is not optically flat: each unit is a pillow a few
        // millimetres out of plane, so what it reflects is softened, and a
        // sharp copy of last frame's window grid shimmered when the camera
        // moved 0.3 m (tools/verify-buildings.ts, chicago-loop-day).
        lod = max(lod, 2.0);
#endif
        return vec4(textureLod(uSsrHistory, uh, lod).rgb, conf);
      }
    }
    dzPrev = dz;
    tPrev = t;
    stepLen *= 1.35;
    t += stepLen;
  }
  return vec4(0.0);
}

/**
 * The scene along the reflected ray, with its confidence in a.
 *
 * ONE ray, and on rough water that ray stands for a cone of facets a couple
 * of tens of degrees tall, most of which see something else (usually sky). A
 * single ray at full confidence draws rough water as a blurred mirror with a
 * hard edge: from 200 m up a 4 m/s sea mirrored the Golden Gate deck as a
 * crisp black bar. Three rays across the cone smoothed the edge and cost
 * 9 ms on the harbour pose, because most of those pixels are open water
 * whose rays run to the sky. So the cone is accounted for in the weight
 * instead: the wider the unresolved spread (radians of reflected direction),
 * the less of the cone one hit can claim. At 0.2 rad, a 4 m/s sea seen from
 * a few hundred metres, a hit claims two thirds of the pixel.
 */
vec4 waterSSR(vec3 p0, vec3 r, float viewDist, float alpha, float spread) {
  if (uSsrOn < 0.5) return vec4(0.0);
  vec4 h = ssrMarch(p0, r, viewDist, alpha);
  h.a /= 1.0 + 2.5 * spread;
  return h;
}
`;

export interface WaterSsrUniforms {
  uSsrHistory: THREE.IUniform<THREE.Texture | null>;
  uSsrViewProj: THREE.IUniform<THREE.Matrix4>;
  uSsrSize: THREE.IUniform<THREE.Vector2>;
  uSsrOn: THREE.IUniform<number>;
  uSsrPixelAngle: THREE.IUniform<number>;
}

/**
 * ONE set, shared by reference into every terrain ring's uniforms, the same
 * way the shadow cascades are: a ring built later must not be the one ring
 * marching against a stale matrix.
 */
export const WATER_SSR_UNIFORMS: WaterSsrUniforms = {
  uSsrHistory: { value: null },
  uSsrViewProj: { value: new THREE.Matrix4() },
  uSsrSize: { value: new THREE.Vector2(1, 1) },
  uSsrOn: { value: 0 },
  uSsrPixelAngle: { value: 0.001 },
};

const VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 1.0, 1.0);
}
`;

const CAPTURE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
void main() {
  vec3 c = texture(uColor, vUv).rgb;
  float d = texture(uDepth, vUv).r;
  float n = uNearFar.x;
  float f = uNearFar.y;
  float zn = d * 2.0 - 1.0;
  float viewZ = (2.0 * n * f) / ((f + n) - zn * (f - n));
  // Half float tops out at 65504. The sky is at the far plane and must read as
  // "nothing here" to the march, which only asks whether the ray went behind
  // it: 6e4 is behind everything a ray reaches.
  if (d >= 0.999999) viewZ = 6.0e4;
  // Clamped so a sun pixel (well over 1000 in this space) cannot become an inf
  // in half float and poison the mip chain the blur reads.
  fragColor = vec4(min(c, vec3(256.0)), min(viewZ, 6.0e4));
}
`;

const _size = new THREE.Vector2();

/**
 * The full drawing buffer. Half resolution was tried and measured: no faster
 * once the sky exit was in (the harbour pose 13.4 ms either way), and it lost
 * the Chicago towers outright. A facade seen obliquely changes depth by metres
 * across one half-res texel, so the bisected crossing missed the depth it was
 * looking for by more than the tolerance and every hit on it was rejected.
 */
export const WATER_HISTORY_SCALE = 1;

function historySize(renderer: THREE.WebGLRenderer): THREE.Vector2 {
  renderer.getDrawingBufferSize(_size);
  return new THREE.Vector2(
    Math.max(1, Math.floor(_size.x * WATER_HISTORY_SCALE)),
    Math.max(1, Math.floor(_size.y * WATER_HISTORY_SCALE)),
  );
}

/** Copies the resolved scene into the history the next frame's water marches. */
export class WaterHistory {
  /** Off leaves uSsrOn at 0: the water falls back to the sky alone. */
  enabled = true;

  private target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(renderer: THREE.WebGLRenderer) {
    const s = historySize(renderer);
    this.target = new THREE.WebGLRenderTarget(s.x, s.y, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      // The mip chain is the roughness blur: see waterSSR's lod. Depth is read
      // with texelFetch at level 0, so averaging it in the mips is harmless.
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.uniforms = {
      uColor: { value: null },
      uDepth: { value: null },
      uNearFar: { value: new THREE.Vector2(2, 200000) },
    };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.RawShaderMaterial({
        vertexShader: VERT,
        fragmentShader: CAPTURE_FRAG,
        uniforms: this.uniforms,
        glslVersion: THREE.GLSL3,
        depthTest: false,
        depthWrite: false,
      }),
    );
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    WATER_SSR_UNIFORMS.uSsrHistory.value = this.target.texture;
  }

  resize(renderer: THREE.WebGLRenderer): void {
    const s = historySize(renderer);
    this.target.setSize(s.x, s.y);
    // A resized history holds garbage until the next capture.
    WATER_SSR_UNIFORMS.uSsrOn.value = 0;
  }

  /** After the scene pass: what this frame drew is what the next one reflects. */
  capture(renderer: THREE.WebGLRenderer, scene: THREE.WebGLRenderTarget, camera: THREE.PerspectiveCamera): void {
    const u = WATER_SSR_UNIFORMS;
    if (!this.enabled || !scene.depthTexture) {
      u.uSsrOn.value = 0;
      return;
    }
    this.uniforms.uColor.value = scene.texture;
    this.uniforms.uDepth.value = scene.depthTexture;
    (this.uniforms.uNearFar.value as THREE.Vector2).set(camera.near, camera.far);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);

    // matrixWorldInverse is the one the scene pass just drew with; three.js
    // refreshed it inside that render() call.
    u.uSsrViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uSsrSize.value.set(this.target.width, this.target.height);
    u.uSsrPixelAngle.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / this.target.height;
    u.uSsrOn.value = 1;
  }
}
