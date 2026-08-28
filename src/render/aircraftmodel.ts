// The aircraft you are flying, built from primitives.
//
// It has its own small shader rather than a three.js standard material for one
// reason: the whole scene renders into a LINEAR HDR target and the composite
// pass owns tone mapping. A built-in material would encode to sRGB on the way
// out and then be encoded again at the end, so the airframe would sit in the
// frame at a visibly different gamma from the world around it.
//
// No atmosphere term here. At 30 m from the camera the in-scattered light is
// far below a least significant bit, and the 16 texture samples it would cost
// are better spent on the clouds.
//
// It is a high-wing light single with an 11 m span: a Cessna lookalike, not a
// copy of any type. The silhouette is doing a job. A fast jet over a real city
// reads as a strike package and a camera drone reads as surveillance, and both
// of those change what the picture is ABOUT. A little white aeroplane with
// wing struts and fixed gear reads as a nice afternoon.
//
// The span is also the scale reference. The aircraft is the only object in the
// frame whose size the viewer already knows, so if it is wrong, every building
// behind it is wrong too.

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
uniform float uEmissive;
void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(0.0, dot(n, uSunDir));
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * ndl;
  vec3 ambient = uAmbient * (0.55 + 0.45 * n.y);
  vec3 lit = uAlbedo * (direct + ambient);
  // A painted sheen, so the shell catches the sun as it banks.
  float spec = pow(max(0.0, dot(reflect(-uSunDir, n), vec3(0.0, 0.0, 1.0))), 24.0);
  lit += uSunColor * uSunIntensity * uSunSurface * spec * uMetal * 0.5;
  // Navigation lights emit rather than reflect, which is the only way they can
  // still be visible at night -- the whole point of having them.
  lit += uAlbedo * uEmissive;
  fragColor = vec4(lit, 1.0);
}
`;

export interface AircraftUniforms extends Record<string, THREE.IUniform> {
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uAlbedo: THREE.IUniform<THREE.Color>;
  uMetal: THREE.IUniform<number>;
  uEmissive: THREE.IUniform<number>;
}

function material(
  shared: AircraftUniforms,
  albedo: number,
  metal: number,
  emissive = 0,
): THREE.RawShaderMaterial {
  // Each part gets its own colour but shares the light uniforms, so updating
  // the sun touches one object rather than a dozen.
  const u: AircraftUniforms = {
    ...shared,
    uAlbedo: { value: new THREE.Color(albedo) },
    uMetal: { value: metal },
    uEmissive: { value: emissive },
  };
  return new THREE.RawShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: u,
    glslVersion: THREE.GLSL3,
  });
}

/** Wing semi-span, and the fuselage's forward axis, in metres. Forward is -z. */
const SEMI_SPAN = 5.5;

export class AircraftModel {
  readonly group = new THREE.Group();
  readonly uniforms: AircraftUniforms;
  private prop: THREE.Mesh;
  private ailerons: THREE.Object3D[] = [];
  private elevator: THREE.Object3D;
  private spin = 0;

  constructor() {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 16 },
      uSunSurface: { value: 0.105 },
      uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
      uAlbedo: { value: new THREE.Color(0xffffff) },
      uMetal: { value: 0.5 },
      uEmissive: { value: 0 },
    };

    const paint = material(this.uniforms, 0xf2f4f7, 0.55);
    const stripe = material(this.uniforms, 0xd9622b, 0.4);
    const dark = material(this.uniforms, 0x171b21, 0.25);
    const glass = material(this.uniforms, 0x0d1620, 0.85);
    const navR = material(this.uniforms, 0xff3b30, 0.0, 2.2);
    const navG = material(this.uniforms, 0x30ff7a, 0.0, 2.2);

    // Fuselage: a capsule laid along -z, the aircraft's forward axis.
    const fuse = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 3.9, 6, 16), paint);
    fuse.rotation.x = Math.PI / 2;
    fuse.position.z = -0.2;
    this.group.add(fuse);

    // Tail boom, tapering to the fin.
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.26, 2.6, 12), paint);
    boom.rotation.x = Math.PI / 2;
    boom.position.z = 3.0;
    this.group.add(boom);

    // Cowling and spinner. The nose is where a light single's character is.
    const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.5, 1.1, 14), stripe);
    cowl.rotation.x = Math.PI / 2;
    cowl.position.z = -2.6;
    this.group.add(cowl);
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.5, 12), paint);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -3.35;
    this.group.add(spinner);

    // Cabin: greenhouse glazing wrapping the front, which with the high wing is
    // the whole reason this aeroplane is nice to sit in and to look at.
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.62, 1.9), glass);
    cabin.position.set(0, 0.44, -1.0);
    this.group.add(cabin);

    // High wing, mounted on a shallow pylon above the cabin.
    const wing = new THREE.Mesh(new THREE.BoxGeometry(SEMI_SPAN * 2, 0.17, 1.65), paint);
    wing.position.set(0, 0.92, -0.65);
    this.group.add(wing);
    const wingStripe = new THREE.Mesh(new THREE.BoxGeometry(SEMI_SPAN * 2, 0.05, 0.34), stripe);
    wingStripe.position.set(0, 1.0, -1.2);
    this.group.add(wingStripe);

    for (const s of [-1, 1]) {
      // Lift strut, fuselage bottom to mid-wing. Nothing else says "high wing"
      // this cheaply, and a strutless one reads as a different aeroplane.
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.55, 0.24), paint);
      strut.position.set(s * 1.42, 0.20, -0.5);
      strut.rotation.z = s * 0.62;
      this.group.add(strut);

      // Aileron, outboard on the trailing edge, deflecting opposite each side.
      const ail = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.11, 0.42), stripe);
      ail.position.set(s * 4.0, 0.92, 0.16);
      this.group.add(ail);
      this.ailerons.push(ail);

      // Navigation lights: green on the right, red on the left, as on anything
      // that flies. They are how you read the aircraft's heading at range.
      const nav = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6), s > 0 ? navG : navR);
      nav.position.set(s * (SEMI_SPAN + 0.05), 0.94, -0.65);
      this.group.add(nav);

      // Fixed gear: a sprung leg and a wheel, which is half the friendliness.
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.10, 0.16), paint);
      leg.position.set(s * 0.62, -0.72, -0.35);
      leg.rotation.z = s * 0.42;
      this.group.add(leg);
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.17, 12), dark);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(s * 1.12, -1.0, -0.35);
      this.group.add(wheel);
    }

    // Nose wheel.
    const noseLeg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.1), paint);
    noseLeg.position.set(0, -0.85, -2.1);
    this.group.add(noseLeg);
    const noseWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.15, 12), dark);
    noseWheel.rotation.z = Math.PI / 2;
    noseWheel.position.set(0, -1.2, -2.1);
    this.group.add(noseWheel);

    // Tail: swept fin and a one-piece stabiliser that moves with the elevator.
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.5, 1.25), paint);
    fin.position.set(0, 0.95, 4.0);
    this.group.add(fin);
    const finStripe = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.9, 0.55), stripe);
    finStripe.position.set(0, 1.25, 4.25);
    this.group.add(finStripe);

    this.elevator = new THREE.Group();
    const stab = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.13, 0.95), paint);
    this.elevator.add(stab);
    this.elevator.position.set(0, 0.28, 4.1);
    this.group.add(this.elevator);

    // Propeller disc. Drawn as a translucent disc rather than blades: a real
    // prop at speed IS a disc, and modelled blades strobe against any frame
    // rate you pick.
    const discMat = material(this.uniforms, 0x8a8f96, 0.1);
    discMat.transparent = true;
    discMat.opacity = 0.24;
    discMat.side = THREE.DoubleSide;
    this.prop = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24), discMat);
    this.prop.position.z = -3.5;
    this.group.add(this.prop);
  }

  /**
   * `throttle` spins the prop; `rollCmd` and `pitchDeg` move the control
   * surfaces.
   *
   * The surfaces cost four numbers and are the difference between a model being
   * flown and a model being carried. They are driven by the STICK rather than
   * by the resulting attitude, because that is the direction the causality runs
   * -- ailerons deflect and then the aeroplane rolls.
   */
  update(dt: number, throttle: number, rollCmd: number, pitchDeg: number): void {
    this.spin += dt * (10 + throttle * 46);
    this.prop.rotation.z = this.spin;
    for (let i = 0; i < this.ailerons.length; i++) {
      const side = i === 0 ? -1 : 1;
      this.ailerons[i].rotation.x = rollCmd * side * 0.42;
    }
    this.elevator.rotation.x = -pitchDeg * (Math.PI / 180) * 0.5;
  }
}
