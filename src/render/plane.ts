// The aircraft you are flying, built from primitives.
//
// It has its own small shader rather than a three.js standard material for one
// reason: the whole scene renders into a LINEAR HDR target and the composite
// pass owns tone mapping. A built-in material would encode to sRGB on the way
// out and then be encoded again at the end, so the aircraft would sit in the
// frame at a visibly different gamma from the world around it.
//
// No atmosphere term here. At 30 m from the camera the in-scattered light is
// far below a least significant bit, and the 16 texture samples it would cost
// are better spent on the clouds.

import * as THREE from "three";

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
out vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
out vec4 fragColor;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uSunSurface;
uniform vec3  uAmbient;
uniform vec3  uAlbedo;
uniform float uMetal;
void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(0.0, dot(n, uSunDir));
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * ndl;
  vec3 ambient = uAmbient * (0.55 + 0.45 * n.y);
  vec3 lit = uAlbedo * (direct + ambient);
  // A painted metal sheen, so the fuselage catches the sun as it banks.
  float spec = pow(max(0.0, dot(reflect(-uSunDir, n), vec3(0.0, 0.0, 1.0))), 24.0);
  lit += uSunColor * uSunIntensity * uSunSurface * spec * uMetal * 0.5;
  fragColor = vec4(lit, 1.0);
}
`;

export interface PlaneUniforms extends Record<string, THREE.IUniform> {
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uAlbedo: THREE.IUniform<THREE.Color>;
  uMetal: THREE.IUniform<number>;
}

function material(shared: PlaneUniforms, albedo: number, metal: number): THREE.RawShaderMaterial {
  // Each part gets its own colour but shares the light uniforms, so updating
  // the sun touches one object rather than a dozen.
  const u: PlaneUniforms = {
    ...shared,
    uAlbedo: { value: new THREE.Color(albedo) },
    uMetal: { value: metal },
  };
  return new THREE.RawShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: u,
    glslVersion: THREE.GLSL3,
  });
}

export class Plane {
  readonly group = new THREE.Group();
  readonly uniforms: PlaneUniforms;
  private prop: THREE.Mesh;

  constructor() {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 16 },
      uSunSurface: { value: 0.105 },
      uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
      uAlbedo: { value: new THREE.Color(0xffffff) },
      uMetal: { value: 0.5 },
    };

    const body = material(this.uniforms, 0xe8ecf0, 0.7);
    const trim = material(this.uniforms, 0x2a6fb0, 0.4);
    const dark = material(this.uniforms, 0x1b2026, 0.2);

    // Fuselage: a capsule laid along -z, which is the aircraft's forward axis.
    const fuse = new THREE.Mesh(new THREE.CapsuleGeometry(0.95, 6.4, 6, 16), body);
    fuse.rotation.x = Math.PI / 2;
    this.group.add(fuse);

    // Nose cone.
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.0, 16), trim);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -4.6;
    this.group.add(nose);

    // Wings: a low-mounted tapered plank with a little dihedral.
    const wing = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.22, 2.1), body);
    wing.position.set(0, -0.35, -0.4);
    this.group.add(wing);
    for (const s of [-1, 1]) {
      const tip = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 1.5), trim);
      tip.position.set(s * 7.4, -0.05, -0.2);
      tip.rotation.z = s * 0.12;
      this.group.add(tip);
    }

    // Tail.
    const tailplane = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.18, 1.3), body);
    tailplane.position.set(0, 0.3, 3.5);
    this.group.add(tailplane);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.2, 1.6), trim);
    fin.position.set(0, 1.3, 3.6);
    this.group.add(fin);

    // Canopy.
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.78, 14, 10), dark);
    canopy.scale.set(1, 0.72, 2.0);
    canopy.position.set(0, 0.72, -0.9);
    this.group.add(canopy);

    // Propeller disc. Drawn as a translucent disc rather than blades: a real
    // prop at speed IS a disc, and modelled blades strobe against any frame
    // rate you pick.
    const discMat = material(this.uniforms, 0x8a8f96, 0.1);
    discMat.transparent = true;
    discMat.opacity = 0.26;
    discMat.side = THREE.DoubleSide;
    this.prop = new THREE.Mesh(new THREE.CircleGeometry(1.9, 24), discMat);
    this.prop.position.z = -5.5;
    this.group.add(this.prop);
  }

  update(dt: number, throttle: number): void {
    this.prop.rotation.z += dt * (8 + throttle * 40);
  }
}
