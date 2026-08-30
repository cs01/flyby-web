// The aircraft you are flying: a real Cessna 182 airframe, shaded in-house.
//
// It has its own shader rather than a three.js standard material for one
// reason: the whole scene renders into a LINEAR HDR target and the composite
// pass owns tone mapping. A built-in material would encode to sRGB on the way
// out and then be encoded again at the end, so the airframe would sit in the
// frame at a visibly different gamma from the world around it.
//
// Three things carry the realism, in order of how much they matter:
//
//  1. A real mesh. Primitives cannot make a cowling, a wing-root fairing or a
//     wheel pant, and those are exactly the shapes the eye uses to decide
//     whether it is looking at an aeroplane or at a model of one.
//  2. The environment probe. A painted metal shell is mostly a MIRROR of its
//     surroundings -- bright sky on top, dark ground underneath, a hard sun
//     streak along the spine. Without that it reads as plastic no matter how
//     good the mesh is.
//  3. Self-shadow. The high wing lays a shadow across the cabin and the
//     fuselage spine in every photograph of this aeroplane ever taken. It is a
//     small pass and it does more for solidity than anything else here.
//
// No atmosphere term. At 30 m from the camera the in-scattered light is far
// below a least significant bit, and those samples are better spent on clouds.
//
// The span is the scale reference: 10.9 m, the real number. The aircraft is the
// only object in the frame whose size the viewer already knows, so if it is
// wrong, every building behind it is wrong too.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import { SHADOW_CASTER_LAYER } from "./sunshadow";
import { SH_GLSL, shHemispherical } from "./sh";
import type { Budget } from "./budget";

/** Wing semi-span in metres. The real 182 is 10.97 m tip to tip. */
export const SEMI_SPAN = 5.46;

/** Aircraft meshes live on this layer so the shadow pass can draw them alone. */
const AIRCRAFT_LAYER = 1;

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec2 vUv;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // World-space normal. mat3(modelMatrix) is correct here because every node in
  // this model carries rotation and translation only -- no non-uniform scale.
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
${TONEMAP_GLSL}
${SH_GLSL}

in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec2 vUv;
out vec4 fragColor;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uSunSurface;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform vec3  uCameraPos;

uniform sampler2D   uMap;
// 0 = no texture, 1 = colour and alpha, 2 = ALPHA ONLY.
// Mode 2 is for the propeller blur: it is a shape mask, not a surface colour.
// Its RGB is near black, so multiplying it into the paint gives a solid dark
// disc instead of the translucent smear a spinning propeller actually is.
uniform float       uMapMode;
uniform vec3        uBaseColor;
uniform float       uRoughness;
uniform float       uMetalness;
uniform vec3        uEmissiveColor;
uniform float       uEmissive;
uniform float       uOpacity;

uniform samplerCube uEnv;
uniform float       uEnvMaxLod;
uniform float       uEnvStrength;

uniform sampler2D uShadowMap;
uniform mat4      uShadowMat;
uniform float     uShadowTexel;
uniform float     uShadowStrength;

const float PI = 3.14159265359;

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

// Height-correlated Smith, already divided by the 4*NoL*NoV denominator.
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float lv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float ll = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(lv + ll, 1e-5);
}

vec3 F_Schlick(vec3 f0, float u) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - u, 0.0, 1.0), 5.0);
}

/**
 * How much of the sun this fragment can see.
 *
 * Only the aircraft is in this map. The terrain casts its own shadow through
 * the sun colour the scene hands us, and a 12 m box round the aeroplane cannot
 * represent a mountain anyway.
 */
float sunVisibility() {
  if (uShadowStrength <= 0.0) return 1.0;
  vec4 sc = uShadowMat * vec4(vWorldPos, 1.0);
  vec3 sp = sc.xyz / sc.w * 0.5 + 0.5;
  if (sp.x < 0.0 || sp.x > 1.0 || sp.y < 0.0 || sp.y > 1.0 || sp.z > 1.0) return 1.0;

  // Slope-scaled bias. A constant bias either acnes the fuselage top, which
  // faces the sun almost edge-on near sunset, or peters the wing shadow off the
  // cabin roof. This is the cheapest thing that does neither.
  float ndl = max(0.0, dot(normalize(vWorldNormal), uSunDir));
  float bias = 0.0009 + 0.0035 * (1.0 - ndl);

  float lit = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uShadowTexel;
      float d = texture(uShadowMap, sp.xy + o).r;
      lit += (sp.z - bias > d) ? 0.0 : 1.0;
    }
  }
  return mix(1.0, lit / 9.0, uShadowStrength);
}

void main() {
  vec3 base = uBaseColor;
  float alpha = uOpacity;
  if (uMapMode > 0.5) {
    vec4 t = texture(uMap, vUv);
    // Explicit decode. three.js injects no colour-space conversion into a
    // RawShaderMaterial, and this atlas is authored in sRGB.
    if (uMapMode < 1.5) base *= srgbToLinear(t.rgb);
    alpha *= t.a;
  }

  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  // Two-sided lighting: the wings and control surfaces are single-sided sheets,
  // so the underside arrives with a normal pointing away from the viewer.
  if (dot(N, V) < 0.0) N = -N;

  float rough = clamp(uRoughness, 0.045, 1.0);
  float a = rough * rough;
  vec3 f0 = mix(vec3(0.04), base, uMetalness);
  vec3 diffuseColor = base * (1.0 - uMetalness);

  float NoV = max(dot(N, V), 1e-4);
  vec3 lit = vec3(0.0);

  // --- Sun ---------------------------------------------------------------
  {
    vec3 L = uSunDir;
    float NoL = max(dot(N, L), 0.0);
    if (NoL > 0.0) {
      vec3 H = normalize(L + V);
      float NoH = max(dot(N, H), 0.0);
      float VoH = max(dot(V, H), 0.0);
      vec3 F = F_Schlick(f0, VoH);
      float spec = D_GGX(NoH, a) * V_SmithGGX(NoV, NoL, a);
      vec3 radiance = uSunColor * uSunIntensity * uSunSurface * NoL * sunVisibility();
      lit += radiance * (diffuseColor / PI * (1.0 - F) + F * spec);
    }
  }

  // --- Moon --------------------------------------------------------------
  // Without this the aeroplane goes to a black cutout the moment the sun sets,
  // while the city under it is still lit. Diffuse only: a specular highlight
  // from a source this dim is below the tone curve's floor anyway.
  {
    float NoL = max(dot(N, uMoonDir), 0.0);
    lit += uMoonLight * uSunSurface * NoL * diffuseColor / PI;
  }

  // --- Environment -------------------------------------------------------
  // The probe holds the actual sky and ground around the aircraft, so the shell
  // picks up blue from above and terrain from below without any of it being
  // hand-authored. Roughness picks the mip: a glossy panel gets a sharp
  // horizon, a matte tyre gets the average of everything.
  {
    vec3 R = reflect(-V, N);
    vec3 pre = textureLod(uEnv, R, rough * uEnvMaxLod).rgb;
    // Irradiance from the blurriest mip. Standing in for a cosine convolution,
    // which at 128px and this distance nobody can tell apart from the real one.
    vec3 irr = textureLod(uEnv, N, uEnvMaxLod).rgb;

    // Roughness-aware Fresnel: a rough surface must not develop a mirror rim.
    vec3 Fenv = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - NoV, 5.0);

    lit += uEnvStrength * (pre * Fenv + irr * diffuseColor * (1.0 - uMetalness));
  }

  // Sky irradiance from the SCENE probe, in place of the hemispherical
  // constant this was the last shader in the renderer still running.
  //
  // Two probes, deliberately, and they are not the same measurement. The cube
  // above is captured AT THE AIRCRAFT and has the ground, the city and the
  // runway in it, which is what a fuselage actually reflects; the scene probe
  // is sky only. So the cube keeps the reflection and the near-field bounce,
  // and this supplies the floor under everything -- the term that stops a
  // surface facing away from sun, moon and sky going to pure black -- with the
  // sky's real distribution instead of a fudge in N.y. Both are normalised to
  // the same scene ambient, so nothing changes level; what changes is that a
  // wing under a sunset is now warm on the side facing it.
  lit += shIrradiance(N) * diffuseColor;

  // Navigation lights emit rather than reflect, which is the only way they can
  // still be visible at night -- the whole point of having them.
  lit += uEmissiveColor * uEmissive;

  fragColor = vec4(lit, alpha);
}
`;

/** Light uniforms shared by every part, so updating the sun touches one object. */
export interface AircraftUniforms extends Record<string, THREE.IUniform> {
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
  /** Sky irradiance, 9 RGB coefficients; see render/sh.ts. */
  uSH: THREE.IUniform<Float32Array>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uEnv: THREE.IUniform<THREE.CubeTexture | THREE.Texture | null>;
  uEnvMaxLod: THREE.IUniform<number>;
  uShadowMap: THREE.IUniform<THREE.Texture | null>;
  uShadowMat: THREE.IUniform<THREE.Matrix4>;
  uShadowTexel: THREE.IUniform<number>;
  uShadowStrength: THREE.IUniform<number>;
}

/** How a part is painted. Everything the classifier decides ends up here. */
interface Surface {
  color: number;
  roughness: number;
  metalness: number;
  emissive?: number;
  emissiveColor?: number;
  opacity?: number;
  envStrength?: number;
  useMap?: boolean;
  /** Take only the texture's alpha, keeping `color` as the surface colour. */
  maskOnly?: boolean;
  doubleSided?: boolean;
  depthWrite?: boolean;
}

const PAINT: Surface = { color: 0xffffff, roughness: 0.24, metalness: 0.0, useMap: true };
const GLASS: Surface = {
  color: 0x1a222c,
  roughness: 0.06,
  metalness: 0.0,
  opacity: 0.42,
  envStrength: 1.35,
  doubleSided: true,
  depthWrite: false,
};
const CHROME: Surface = { color: 0xf2f2f2, roughness: 0.13, metalness: 1.0 };
const RUBBER: Surface = { color: 0x14161a, roughness: 0.88, metalness: 0.0, useMap: true, envStrength: 0.5 };
// A propeller at speed is a translucent grey smear you can read the world
// through, and it darkens with the light like everything else -- so it stays
// lit, but takes only its SHAPE from the texture.
const PROP_BLUR: Surface = {
  color: 0xa8afb8,
  roughness: 0.62,
  metalness: 0.0,
  useMap: true,
  maskOnly: true,
  opacity: 0.5,
  doubleSided: true,
  depthWrite: false,
  envStrength: 0.35,
};

/**
 * Which surface a node gets, decided by the name the model shipped with.
 *
 * Name-driven rather than material-driven because the source model's materials
 * describe a 2003 fixed-function pipeline and carry nothing this shader wants,
 * whereas the names are exact and stable.
 */
function classify(name: string): Surface {
  const n = name.toLowerCase();
  if (/windscreen|window|llglas|glas/.test(n)) return GLASS;
  if (/chrome/.test(n)) return CHROME;
  if (/wheel(?!fairing)|tyre|tire/.test(n)) return RUBBER;
  if (/^(slowprop|fastprop)/.test(n)) return PROP_BLUR;
  if (/navlightred/.test(n)) return { ...PAINT, emissive: 2.4, emissiveColor: 0xff2a1e, useMap: false, color: 0xff2a1e };
  if (/navlightgreen/.test(n)) return { ...PAINT, emissive: 2.4, emissiveColor: 0x2bff6e, useMap: false, color: 0x2bff6e };
  if (/strobe/.test(n)) return { ...PAINT, emissive: 0.0, emissiveColor: 0xffffff, useMap: false, color: 0xdfe6ee };
  if (/beacon/.test(n)) return { ...PAINT, emissive: 0.0, emissiveColor: 0xff2a1e, useMap: false, color: 0x8a1410 };
  if (/landinglight|taxilight|extlight/.test(n)) {
    return { ...PAINT, emissive: 0.0, emissiveColor: 0xfff2d0, useMap: false, color: 0xd8d2c4 };
  }
  return PAINT;
}

/**
 * The sky and ground around the aircraft, captured into a cube.
 *
 * Rendered by hand rather than with THREE.CubeCamera because the sky is a
 * full-screen triangle driven by uInvView/uInvProj uniforms rather than by the
 * camera three.js hands it. CubeCamera would give all six faces the same patch
 * of sky. `onFace` is the hook that lets the caller re-sync those uniforms.
 */
class EnvProbe {
  readonly target: THREE.WebGLCubeRenderTarget;
  private cameras: THREE.PerspectiveCamera[] = [];
  private frame = 0;

  constructor(size: number) {
    this.target = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });

    // +X, -X, +Y, -Y, +Z, -Z in the order WebGL wants the faces.
    const dirs: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)],
      [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, -1, 0)],
      [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1)],
      [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)],
      [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)],
    ];
    for (const [look, up] of dirs) {
      const c = new THREE.PerspectiveCamera(90, 1, 5, 200000);
      c.up.copy(up);
      c.userData.look = look;
      this.cameras.push(c);
    }
  }

  get maxLod(): number {
    return Math.log2(this.target.width);
  }

  /** True when this frame actually re-rendered the probe. */
  update(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    at: THREE.Vector3,
    everyNFrames: number,
    onFace: (camera: THREE.PerspectiveCamera) => void,
  ): boolean {
    if (this.frame++ % everyNFrames !== 0) return false;

    const prevTarget = renderer.getRenderTarget();
    for (let i = 0; i < 6; i++) {
      const cam = this.cameras[i];
      cam.position.copy(at);
      cam.lookAt(at.clone().add(cam.userData.look as THREE.Vector3));
      cam.updateMatrixWorld(true);
      onFace(cam);
      renderer.setRenderTarget(this.target, i);
      renderer.render(scene, cam);
    }
    renderer.setRenderTarget(prevTarget);
    return true;
  }

  setSize(size: number): void {
    if (size !== this.target.width) this.target.setSize(size, size);
  }
}

/**
 * A depth map of the aircraft alone, from the sun.
 *
 * Scoped to the aeroplane on purpose: it exists so the wing can shadow the
 * cabin, not so the world can shadow the wing. The ortho box is sized to the
 * airframe, which is what buys a sharp 1024-pixel shadow out of a small map.
 */
class SelfShadow {
  readonly target: THREE.WebGLRenderTarget;
  readonly matrix = new THREE.Matrix4();
  private camera = new THREE.OrthographicCamera(-7, 7, 7, -7, 0.1, 40);
  private depthMaterial: THREE.RawShaderMaterial;

  constructor(size: number) {
    const depth = new THREE.DepthTexture(size, size);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.compareFunction = null;

    // A 1x1 colour attachment: WebGL needs one, nothing ever reads it.
    this.target = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    this.depthMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float;
        in vec3 position;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `precision highp float;
        out vec4 c;
        void main(){ c = vec4(1.0); }`,
      side: THREE.DoubleSide,
    });
  }

  get texelSize(): number {
    return 1 / this.target.width;
  }

  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    centre: THREE.Vector3,
    sunDir: THREE.Vector3,
  ): void {
    // Park the camera 20 m up-sun of the aircraft and look back at it.
    this.camera.position.copy(centre).addScaledVector(sunDir, 20);
    this.camera.up.set(0, 1, 0);
    // Degenerate when the sun is straight overhead and `up` is parallel to the
    // view direction; nudging `up` costs nothing and avoids a NaN matrix.
    if (Math.abs(sunDir.y) > 0.999) this.camera.up.set(0, 0, 1);
    this.camera.lookAt(centre);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    this.matrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;

    scene.overrideMaterial = this.depthMaterial;
    this.camera.layers.set(AIRCRAFT_LAYER);

    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);
  }

  setSize(size: number): void {
    if (size !== this.target.width) this.target.setSize(size, size);
  }
}

/** Hinge an already-positioned mesh so it can rotate about a real axis. */
function hinge(mesh: THREE.Mesh, axis: "x" | "y", at: THREE.Vector3): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.copy(at);
  const parent = mesh.parent;
  mesh.position.sub(at);
  pivot.add(mesh);
  parent?.add(pivot);
  pivot.userData.axis = axis;
  return pivot;
}

export class AircraftModel {
  readonly group = new THREE.Group();
  readonly uniforms: AircraftUniforms;
  /** Resolves once the airframe is in the scene. */
  readonly ready: Promise<void>;

  private env: EnvProbe;
  private shadow: SelfShadow;
  private readonly budget: Budget;
  private materials: THREE.RawShaderMaterial[] = [];

  private propFast?: THREE.Object3D;
  private propSlow?: THREE.Object3D;
  private blades: THREE.Object3D[] = [];
  private spinners: THREE.Object3D[] = [];
  private propPivot?: THREE.Group;
  private aileronL?: THREE.Group;
  private aileronR?: THREE.Group;
  private elevator?: THREE.Group;
  private rudder?: THREE.Group;
  private strobes: THREE.RawShaderMaterial[] = [];
  private beacons: THREE.RawShaderMaterial[] = [];

  private spin = 0;
  private clock = 0;

  constructor(budget: Budget, url = "aircraft/c182.glb") {
    this.budget = budget;
    this.env = new EnvProbe(budget.aircraftEnvSize);
    this.shadow = new SelfShadow(budget.aircraftShadowSize);
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 16 },
      uSunSurface: { value: 0.105 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonLight: { value: new THREE.Color(0, 0, 0) },
      // The hemispherical ambient this shader ran before the probe existed,
      // so a frame drawn before the first capture is the old picture.
      uSH: { value: shHemispherical([0.2, 0.24, 0.3], 0.55, 0.45) },
      uCameraPos: { value: new THREE.Vector3() },
      uEnv: { value: this.env.target.texture },
      uEnvMaxLod: { value: this.env.maxLod },
      uShadowMap: { value: this.shadow.target.depthTexture },
      uShadowMat: { value: this.shadow.matrix },
      uShadowTexel: { value: this.shadow.texelSize },
      uShadowStrength: { value: 1 },
    };

    this.ready = new GLTFLoader()
      .loadAsync(url)
      .then((gltf) => this.build(gltf.scene))
      .catch((err: unknown) => {
        // A missing airframe must not take the flight down with it.
        console.error("aircraft model failed to load", err);
      });
  }

  private build(root: THREE.Object3D): void {
    const box = new THREE.Box3();

    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const surface = classify(o.name);
      const mat = this.makeMaterial(surface, o.material);
      o.material = mat;
      o.layers.enable(AIRCRAFT_LAYER);
      // The aeroplane casts onto the city too. It is three more small draws and
      // its shadow crossing a roof is one of the few things that says the
      // aircraft is actually IN the scene rather than pasted over it.
      o.layers.enable(SHADOW_CASTER_LAYER);
      o.frustumCulled = false;
      this.materials.push(mat);

      const n = o.name.toLowerCase();
      if (/strobe/.test(n)) this.strobes.push(mat);
      if (/beacon/.test(n)) this.beacons.push(mat);

      // `PlaneX`, `Plane.002X`, `Plane.003X` are flat ~1.8 m billboards sitting
      // at the origin: the light-cone flares the source simulator draws in
      // front of the landing and taxi lights. They are meant to be additive and
      // switched off with the lamp. Drawn as ordinary geometry they are a dark
      // disc pasted across the fuselage, so they stay hidden until there is a
      // lamp state to drive them.
      if (/^plane[\w.]*x$/i.test(o.name)) o.visible = false;
    });

    this.group.add(root);
    this.group.layers.enable(AIRCRAFT_LAYER);
    box.setFromObject(root);

    const find = (name: string) => root.getObjectByName(name);
    this.propFast = find("FastProp");
    this.propSlow = find("SlowProp");
    for (const n of ["Blade1", "Blade2", "Blade3", "Blade1.001", "Blade2.001", "Blade3.001"]) {
      const b = find(n);
      if (b) this.blades.push(b);
    }
    for (const n of ["Spinner", "chrome_spinner"]) {
      const s = find(n);
      if (s) this.spinners.push(s);
    }

    // Everything on the crankshaft turns about ONE axis: the hub. Each part's
    // geometry is baked in aircraft coordinates with a zero node transform, so
    // spinning a node in place makes it orbit the aircraft's origin 3.8 m away
    // and sweep the propeller through the fuselage. They all have to hang off a
    // single pivot at the hub -- a per-part pivot would be wrong too, because a
    // blade's own centre is out on the blade, not on the shaft.
    const spinning = [this.propFast, this.propSlow, ...this.blades, ...this.spinners].filter(
      (o): o is THREE.Object3D => !!o,
    );
    const hubSource = this.propFast ?? this.propSlow;
    if (hubSource instanceof THREE.Mesh && spinning.length > 0) {
      hubSource.geometry.computeBoundingBox();
      const bb = hubSource.geometry.boundingBox;
      if (bb) {
        const hub = bb.getCenter(new THREE.Vector3());
        this.propPivot = new THREE.Group();
        this.propPivot.position.copy(hub);
        root.add(this.propPivot);
        for (const o of spinning) {
          o.position.sub(hub);
          this.propPivot.add(o);
        }
      }
    }

    this.aileronL = this.hingeNamed(root, "Aileron.L", "x");
    this.aileronR = this.hingeNamed(root, "Aileron.R", "x");
    this.elevator = this.hingeNamed(root, "Elevator", "x");
    this.rudder = this.hingeNamed(root, "Rudder", "y");
  }

  /**
   * Every node in the source model has its geometry baked in absolute
   * coordinates and a zero transform, so rotating a node spins it about the
   * aircraft's origin rather than about its own hinge. This re-parents the mesh
   * under a pivot placed at its FORWARD edge, which is where the real hinge
   * line is on every control surface on the aeroplane.
   */
  private hingeNamed(root: THREE.Object3D, name: string, axis: "x" | "y"): THREE.Group | undefined {
    const mesh = root.getObjectByName(name);
    if (!(mesh instanceof THREE.Mesh)) return undefined;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return undefined;
    const at = new THREE.Vector3(
      (bb.min.x + bb.max.x) / 2,
      (bb.min.y + bb.max.y) / 2,
      bb.min.z, // forward is -z, so the smallest z is the leading edge
    );
    if (axis === "x") at.x = (bb.min.x + bb.max.x) / 2;
    return hinge(mesh, axis, at);
  }

  private makeMaterial(s: Surface, source: THREE.Material | THREE.Material[]): THREE.RawShaderMaterial {
    // The glb's own material is thrown away, but it is where the texture lives.
    const src = Array.isArray(source) ? source[0] : source;
    let map: THREE.Texture | null = null;
    if (s.useMap && src instanceof THREE.MeshStandardMaterial && src.map) {
      map = src.map;
      // Decoded in the shader by srgbToLinear, so three must not also do it.
      map.colorSpace = THREE.NoColorSpace;
      map.anisotropy = 8;
    }

    const u: Record<string, THREE.IUniform> = {
      ...this.uniforms,
      uMap: { value: map },
      uMapMode: { value: map ? (s.maskOnly ? 2 : 1) : 0 },
      uBaseColor: { value: new THREE.Color(s.color) },
      uRoughness: { value: s.roughness },
      uMetalness: { value: s.metalness },
      uEmissiveColor: { value: new THREE.Color(s.emissiveColor ?? s.color) },
      uEmissive: { value: s.emissive ?? 0 },
      uOpacity: { value: s.opacity ?? 1 },
      uEnvStrength: { value: s.envStrength ?? 1 },
    };

    const transparent = (s.opacity ?? 1) < 1 || s.depthWrite === false;
    return new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: u,
      glslVersion: THREE.GLSL3,
      transparent,
      depthWrite: s.depthWrite ?? true,
      side: s.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  /**
   * The two extra passes: the environment probe and the self-shadow map.
   *
   * Call once per frame BEFORE the main scene render, with the aircraft already
   * moved into position. `onFace` must re-sync any full-screen shader that
   * reads camera matrices from uniforms -- the sky, in this app.
   *
   * `quality` is the adaptive render scale. Both passes get cheaper rather than
   * being switched off, because an aeroplane that suddenly stops reflecting the
   * sky is more noticeable than one reflecting it at half resolution.
   */
  prepare(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    quality: number,
    onFace: (c: THREE.PerspectiveCamera) => void,
  ): void {
    // As with the sun cascades, the adaptive controller may only take more
    // away than the device tier already did, never give any back.
    const lowTier = quality < 0.8;
    this.env.setSize(lowTier ? Math.min(this.budget.aircraftEnvSize, 64) : this.budget.aircraftEnvSize);
    this.shadow.setSize(
      lowTier ? Math.min(this.budget.aircraftShadowSize, 512) : this.budget.aircraftShadowSize,
    );
    this.uniforms.uEnvMaxLod.value = this.env.maxLod;
    this.uniforms.uShadowTexel.value = this.shadow.texelSize;

    const centre = this.group.position;

    // The aircraft must not appear in its own reflection.
    this.group.visible = false;
    this.env.update(renderer, scene, centre, lowTier ? 30 : 10, onFace);
    this.group.visible = true;

    this.shadow.render(renderer, scene, centre, this.uniforms.uSunDir.value);
  }

  /**
   * `throttle` spins the prop; `rollCmd` and `pitchDeg` move the control
   * surfaces.
   *
   * The surfaces are driven by the STICK rather than by the resulting attitude,
   * because that is the direction the causality runs -- ailerons deflect and
   * then the aeroplane rolls.
   */
  update(dt: number, throttle: number, rollCmd: number, pitchDeg: number, yawCmd = 0): void {
    this.clock += dt;
    this.spin += dt * (10 + throttle * 46);

    // Below a walking-pace prop the eye resolves individual blades; above it,
    // a real propeller IS a disc, and modelled blades strobe against whatever
    // frame rate you pick. The model ships both, so cross-fade.
    const fast = throttle > 0.28;
    if (this.propFast) this.propFast.visible = fast;
    if (this.propSlow) this.propSlow.visible = !fast;
    for (const b of this.blades) b.visible = !fast;

    // Forward is -z, so the prop turns about z.
    if (this.propPivot) this.propPivot.rotation.z = this.spin;

    if (this.aileronL) this.aileronL.rotation.x = rollCmd * 0.42;
    if (this.aileronR) this.aileronR.rotation.x = -rollCmd * 0.42;
    if (this.elevator) this.elevator.rotation.x = -pitchDeg * (Math.PI / 180) * 0.5;
    if (this.rudder) this.rudder.rotation.y = -yawCmd * 0.5;

    // Anti-collision lights. A real strobe is a double flash about once a
    // second and the beacon is a slower rotating red; both are how you pick an
    // aeroplane out of a dark sky, so they are worth the two sine waves.
    const t = this.clock % 1.2;
    const flash = t < 0.06 || (t > 0.16 && t < 0.22) ? 6.0 : 0.0;
    for (const m of this.strobes) m.uniforms.uEmissive.value = flash;
    const beacon = 0.5 + 0.5 * Math.sin(this.clock * 4.2);
    for (const m of this.beacons) m.uniforms.uEmissive.value = beacon * beacon * 3.0;
  }
}
