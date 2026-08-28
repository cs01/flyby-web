// The sky dome: atmosphere, sun disc, moon, stars.
//
// Drawn as a fullscreen triangle at maximum depth rather than as a sphere, so
// there is no dome radius to fight with the far plane and no seam at the zenith.
// The camera's world position feeds `uCamAltitude`, which means climbing to
// 10 km actually thins the air overhead and darkens the sky toward space -
// the same integral does it, no special case.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import type { Weather } from "../data/weather";
import type { SolarState } from "../data/solar";

const VERT = /* glsl */ `
out vec3 vRayDir;
uniform mat4 uInvProj;
uniform mat4 uInvView;
void main() {
  // Fullscreen triangle from gl_VertexID; no attributes needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vec4 clip = vec4(p, 1.0, 1.0);
  // The perspective divide is not optional here. uInvProj returns a homogeneous
  // point; using its xy without dividing by w scales the ray by the projection
  // and skews the whole sky into a diagonal gradient.
  vec4 view = uInvProj * clip;
  // Pass the ray UNNORMALISED and let the fragment shader normalise it.
  // Normalising per-vertex and interpolating is wrong: interpolation is linear
  // in the vector, not in the angle, and this triangle's corners sit far
  // outside the frustum, so the error skews the whole sky into diagonal bands.
  vRayDir = mat3(uInvView) * (view.xyz / view.w);
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vRayDir;
out vec4 fragColor;

${ATMOSPHERE_GLSL}
${TONEMAP_GLSL}

uniform vec3  uMoonDir;
uniform float uMoonPhase;
uniform float uNightAmount;
uniform float uTime;

// Hash-based starfield. Cheap, stable under camera motion because it is keyed
// on the world-space ray direction rather than on screen position.
float hash13(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

vec3 stars(vec3 rd, float amount) {
  if (amount <= 0.001) return vec3(0.0);
  vec3 c = vec3(0.0);
  // Two octaves: a dense faint field and a sparse bright one, so the sky has
  // both a milky texture and individually resolvable stars.
  for (int oct = 0; oct < 2; oct++) {
    float scale = oct == 0 ? 420.0 : 160.0;
    float thresh = oct == 0 ? 0.9965 : 0.9992;
    vec3 g = rd * scale;
    vec3 cell = floor(g);
    float h = hash13(cell);
    if (h > thresh) {
      vec3 jitter = vec3(hash13(cell + 1.7), hash13(cell + 3.1), hash13(cell + 5.3)) - 0.5;
      vec3 centre = (cell + 0.5 + jitter * 0.6) / scale;
      float d = length(normalize(centre) - rd) * scale;
      float mag = smoothstep(1.0, 0.0, d) * (h - thresh) / (1.0 - thresh);
      // Twinkle harder near the horizon, where real air does it.
      float tw = 0.75 + 0.25 * sin(uTime * 3.0 + h * 90.0);
      float horizonFade = smoothstep(-0.02, 0.15, rd.y);
      // Colour by a second hash: real starfields are not white.
      vec3 tint = mix(vec3(0.75, 0.83, 1.0), vec3(1.0, 0.86, 0.7), hash13(cell + 9.1));
      c += tint * mag * tw * horizonFade * (oct == 0 ? 0.5 : 2.2);
    }
  }
  return c * amount;
}

void main() {
  vec3 rd = normalize(vRayDir);
  vec3 ro = atmoOrigin(uCamAltitude);

  vec3 trans;
  vec3 col = atmosphere(ro, rd, 1.0e7, trans);

  // Sun disc, 0.53 degrees across, with limb darkening. Drawn behind the
  // atmosphere's transmittance so it reddens and dims at the horizon exactly
  // as the sky around it does.
  float cs = dot(rd, uSunDir);
  float sunAng = acos(clamp(cs, -1.0, 1.0));
  float sunR = 0.00465;
  if (sunAng < sunR) {
    float limb = sqrt(max(0.0, 1.0 - pow(sunAng / sunR, 2.0)));
    col += trans * uSunColor * uSunIntensity * 12.0 * (0.55 + 0.45 * limb);
  }

  // Moon: a lit disc with a terminator, so the phase reads.
  float cm = dot(rd, uMoonDir);
  float moonAng = acos(clamp(cm, -1.0, 1.0));
  float moonR = 0.00475;
  if (moonAng < moonR) {
    vec3 up = abs(uMoonDir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 mx = normalize(cross(up, uMoonDir));
    vec3 my = cross(uMoonDir, mx);
    vec2 uv = vec2(dot(rd - uMoonDir, mx), dot(rd - uMoonDir, my)) / moonR;
    float r2 = clamp(1.0 - dot(uv, uv), 0.0, 1.0);
    vec3 n = normalize(vec3(uv, sqrt(r2)));
    // Phase angle drives a terminator across the disc.
    float ph = uMoonPhase * 2.0 * PI;
    vec3 lit = normalize(vec3(sin(ph), 0.0, -cos(ph)));
    float ndl = clamp(dot(n, lit), 0.0, 1.0);
    float mare = 0.82 + 0.18 * hash13(floor(n * 9.0));
    col += trans * vec3(1.0, 0.97, 0.92) * ndl * mare * 0.55 * uNightAmount;
  }

  col += stars(rd, uNightAmount) * trans;

  fragColor = vec4(col, 1.0);
}
`;

export interface SkyUniforms {
  uInvProj: THREE.IUniform<THREE.Matrix4>;
  uInvView: THREE.IUniform<THREE.Matrix4>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonPhase: THREE.IUniform<number>;
  uNightAmount: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms: SkyUniforms;

  constructor() {
    this.uniforms = {
      uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 22 },
      uMieG: { value: 0.76 },
      uTurbidity: { value: 1 },
      uCamAltitude: { value: 100 },
      uMultiScatter: { value: 0.055 },
      uExposure: { value: 1 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonPhase: { value: 0.5 },
      uNightAmount: { value: 0 },
      uTime: { value: 0 },
    };

    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      glslVersion: THREE.GLSL3,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });

    // A 3-vertex geometry with no attributes; the vertex shader builds the
    // triangle from gl_VertexID. Bounding sphere is set infinite so three.js
    // never frustum-culls it.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * Push the current sun, weather and camera into the shader.
   *
   * Two weather couplings that matter more than they look:
   *  - Mie asymmetry from humidity. Damp air scatters forward hard, so a humid
   *    day gets a wide white glare round the sun and a dry one gets a small
   *    crisp disc against deep blue.
   *  - Turbidity from reported visibility. This is the ONE knob that makes a
   *    10 km haze day look like a 10 km haze day instead of a clear one with
   *    fog bolted on, because it thickens the same air the sky is made of.
   */
  update(solar: SolarState, wx: Weather, camAltitude: number, timeSec: number): void {
    const u = this.uniforms;
    const s = solar.sun.dir;
    u.uSunDir.value.set(s.x, s.y, s.z);
    const m = solar.moon.dir;
    u.uMoonDir.value.set(m.x, m.y, m.z);
    u.uMoonPhase.value = solar.moonPhase;
    u.uCamAltitude.value = camAltitude;
    u.uTime.value = timeSec;

    // Stars appear once the sun is well down, and are hidden by thick cloud.
    const twilight = 1 - Math.max(0, Math.min(1, (solar.sun.altitude + 12) / 14));
    u.uNightAmount.value = twilight * (1 - 0.85 * wx.totalCover);

    u.uMieG.value = 0.62 + 0.22 * Math.max(0, Math.min(1, (wx.humidity - 30) / 60));

    // Visibility -> turbidity. 60 km is the "unlimited" sentinel from the feed
    // and maps to near-pristine air; 1 km fog maps to a heavy aerosol load.
    const visKm = Math.max(0.2, wx.visibility / 1000);
    u.uTurbidity.value = Math.max(0.6, Math.min(12, 34 / visKm));

    u.uSunIntensity.value = 22;
    u.uSunColor.value.setRGB(1, 1, 1);
  }

  /** Call once per frame after the camera matrices are current. */
  syncCamera(camera: THREE.PerspectiveCamera): void {
    this.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.uniforms.uInvView.value.copy(camera.matrixWorld);
  }
}
