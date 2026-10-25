// Distant lamps as stable dots: car head and tail lamps and street lamp
// lenses, drawn as screen-space points with a minimum size.
//
// WHY THIS EXISTS. The owner's report at night: "the night lights are too
// sparkly". A lamp lens is a quad of about 0.3 m. Past ~150 m it is under a
// pixel, and a sub-pixel triangle is rasterised on the frames its centre
// happens to cover a sample and not on the others; at five to seven times
// white that on/off is what the bloom then smears into a twinkle. Fading it
// with distance (what render/streetlamps.ts did) only dims the twinkle.
//
// So the lens mesh stops emitting once it is under LAMP_MESH_PX across (see
// `lampMeshWeight` below, used by both lamp shaders), and from there out the
// light is this point instead: never smaller than MIN_POINT_PX, with a soft
// round profile so moving by a fraction of a pixel moves its centroid rather
// than switching pixels on and off, and its intensity scaled by the area the
// real lens covers over the area the point is drawn at (floored, so a street
// of tail lamps a kilometre off is a row of dim stable dots rather than
// nothing). No per-frame randomness anywhere: what changes a dot is the
// camera, smoothly.

import * as THREE from "three";

/** Smallest a point is drawn, in pixels. Two and a half: a soft disk this
 *  size moves sub-pixel without any pixel switching fully on or off. */
export const MIN_POINT_PX = 2.5;
/** Below this many pixels across, a lens mesh hands its light to the point. */
export const LAMP_MESH_PX = 2.0;
/** Floor on the area ratio, so a lamp at 2 km is a dot and not nothing. */
const MIN_ENERGY = 0.06;

/**
 * GLSL shared by the lamp shaders: how much of a lens's light the MESH
 * carries, 1 when it is several pixels across, 0 once the point has it.
 * `uPixelAngle` is radians per pixel down the middle of the view.
 */
export const LAMP_FOOTPRINT_GLSL = /* glsl */ `
uniform float uPixelAngle;
float lampMeshWeight(float lensM, float dist) {
  float px = lensM / max(dist * uPixelAngle, 1e-6);
  return smoothstep(${(LAMP_MESH_PX * 0.6).toFixed(2)}, ${(LAMP_MESH_PX * 1.4).toFixed(2)}, px);
}
`;

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aGlow;   // facing x, facing z (0,0 for all round), lens size m, intensity
in vec3 aColor;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform float uFadeFar;
/** Night, 0..1: every lamp here is off by day. */
uniform float uNight;
out vec3 vColor;
out float vEnergy;
${LAMP_FOOTPRINT_GLSL}
void main() {
  vec3 toCam = uCameraPos - position;
  float dist = length(toCam);
  vec3 view = toCam / max(dist, 1e-3);
  // Only the side a lamp faces: you see the fronts of oncoming cars and the
  // backs of the ones going away, which is what splits a boulevard into a
  // white river and a red one. A lamp with no facing shines all round.
  vec2 face = aGlow.xy;
  float facing = dot(face, face) > 0.0 ? smoothstep(-0.05, 0.35, dot(normalize(face), view.xz)) : 1.0;
  float truePx = aGlow.z / max(dist * uPixelAngle, 1e-6);
  float drawPx = max(${MIN_POINT_PX.toFixed(1)}, truePx);
  float ratio = (truePx * truePx) / (drawPx * drawPx);
  // The point only carries what the mesh no longer does.
  float share = 1.0 - lampMeshWeight(aGlow.z, dist);
  float ringFade = 1.0 - smoothstep(uFadeFar * 0.85, uFadeFar, dist);
  vEnergy = aGlow.w * uNight * facing * share * ringFade * max(ratio, ${MIN_ENERGY});
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Pulled a little toward the eye so the dot is not buried in the body
  // panel its lens sits on.
  mv.xyz += normalize(-mv.xyz) * 0.35;
  gl_Position = vEnergy > 1e-4 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = drawPx;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
in float vEnergy;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  // Gaussian-ish, normalised so the disk integrates to about the area the
  // energy was computed for.
  float w = exp(-r2 * 2.5) * 1.55;
  fragColor = vec4(vColor * vEnergy * w, 1.0);
}
`;

export interface GlowUniforms {
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uPixelAngle: THREE.IUniform<number>;
  uFadeFar: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
}

/** A pool of glow points, refilled by whoever owns it. */
export class GlowPoints {
  readonly points: THREE.Points;
  readonly uniforms: GlowUniforms;
  readonly capacity: number;
  readonly pos: Float32Array;
  readonly glow: Float32Array;
  readonly color: Float32Array;
  count = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly attrs: THREE.BufferAttribute[];

  constructor(capacity: number, fadeFarM: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.glow = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 3);
    const a = new THREE.BufferAttribute(this.pos, 3);
    const b = new THREE.BufferAttribute(this.glow, 4);
    const c = new THREE.BufferAttribute(this.color, 3);
    for (const x of [a, b, c]) x.setUsage(THREE.DynamicDrawUsage);
    this.attrs = [a, b, c];
    this.geo.setAttribute("position", a);
    this.geo.setAttribute("aGlow", b);
    this.geo.setAttribute("aColor", c);
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.uniforms = {
      uCameraPos: { value: new THREE.Vector3() },
      uPixelAngle: { value: 0.0015 },
      uFadeFar: { value: fadeFarM },
      uNight: { value: 0 },
    };
    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    // After the opaque scene, so the additive dots land on what they light.
    this.points.renderOrder = 10;
  }

  begin(): void {
    this.count = 0;
  }

  /** One lamp: where, which way it faces (0,0 for all round), lens size in
   *  metres, intensity, colour. */
  push(x: number, y: number, z: number, fx: number, fz: number, sizeM: number, intensity: number,
    r: number, g: number, b: number): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.glow[i * 4] = fx; this.glow[i * 4 + 1] = fz; this.glow[i * 4 + 2] = sizeM; this.glow[i * 4 + 3] = intensity;
    this.color[i * 3] = r; this.color[i * 3 + 1] = g; this.color[i * 3 + 2] = b;
  }

  end(): void {
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.setDrawRange(0, this.count);
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Radians per pixel down the middle of a perspective view. */
export function pixelAngle(fovDeg: number, heightPx: number): number {
  return (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, heightPx);
}
