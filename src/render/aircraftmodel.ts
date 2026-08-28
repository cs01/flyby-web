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
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform vec3  uAlbedo;
uniform float uMetal;
uniform float uEmissive;
void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(0.0, dot(n, uSunDir));
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * ndl;
  // Without a moon term the aeroplane goes to a black cutout the moment the
  // sun sets, while the city under it is still lit.
  direct += uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));
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
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
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

/**
 * A NACA-ish four-digit section, as a closed loop in (chord, thickness) with
 * the chord normalised to 1 and the leading edge at 0.
 *
 * The wing used to be a BOX, and a box is what made the aeroplane read as a
 * toy from any angle where you could see the wing edge-on: a real wing has a
 * round leading edge, a sharp trailing edge, and a top surface that is more
 * curved than the bottom, and all three are visible at any distance where the
 * wing is more than a few pixels.
 */
const AIRFOIL: [number, number][] = [
  [1.000, 0.0013], [0.850, 0.0271], [0.700, 0.0492], [0.550, 0.0662],
  [0.400, 0.0765], [0.250, 0.0777], [0.150, 0.0700], [0.075, 0.0563],
  [0.025, 0.0350], [0.000, 0.0000],
  [0.025, -0.0263], [0.075, -0.0390], [0.150, -0.0460], [0.250, -0.0480],
  [0.400, -0.0450], [0.550, -0.0378], [0.700, -0.0280], [0.850, -0.0160],
];

interface Station {
  /** Position of the section's leading edge. */
  x: number;
  y: number;
  z: number;
  chord: number;
}

/**
 * Loft the aerofoil between stations to make a real tapered surface.
 *
 * `axis` says which way the span runs: "y" spans along x (a wing), "x" spans
 * along y (a fin). Everything on this aeroplane that is a lifting surface is
 * one of those two, so one function builds the wings, the stabiliser and the
 * fin, and they all get a leading edge for free.
 */
function loftSurface(stations: Station[], vertical = false): THREE.BufferGeometry {
  const n = AIRFOIL.length;
  const pos: number[] = [];
  const idx: number[] = [];

  for (const st of stations) {
    for (const [c, t] of AIRFOIL) {
      const along = st.z + c * st.chord;
      const thick = t * st.chord;
      // A fin is the same section stood on its side: the thickness runs across
      // the aeroplane instead of up it.
      if (vertical) pos.push(st.x + thick, st.y, along);
      else pos.push(st.x, st.y + thick, along);
    }
  }

  for (let s = 0; s < stations.length - 1; s++) {
    const a = s * n;
    const b = (s + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(a + i, b + i, a + j, a + j, b + i, b + j);
    }
  }

  // Caps, so a wing seen from the tip is not an open tube. A triangle fan from
  // the first point is enough for a convex section, which an aerofoil is.
  const capStart = 0;
  const capEnd = (stations.length - 1) * n;
  for (let i = 1; i < n - 1; i++) {
    idx.push(capStart, capStart + i + 1, capStart + i);
    idx.push(capEnd, capEnd + i, capEnd + i + 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The fuselage profile: radius against distance along the body, nose first.
 *
 * ONE piece, revolved. It used to be a capsule with a cylinder boom stuck on
 * the back at a different diameter and a cowling cylinder wider than either,
 * which is exactly what it looked like -- three tubes in a row. A real light
 * single is a single continuous shape that is fattest at the cabin and tapers
 * to a point at each end, and revolving one profile is both simpler and right.
 */
const FUSELAGE: [number, number][] = [
  [-3.30, 0.04], [-3.10, 0.20], [-2.90, 0.34], [-2.60, 0.46], [-2.20, 0.55],
  [-1.70, 0.61], [-1.10, 0.65], [-0.40, 0.66], [0.30, 0.64], [0.90, 0.59],
  [1.60, 0.50], [2.30, 0.40], [3.00, 0.30], [3.70, 0.20], [4.20, 0.11],
  [4.40, 0.03],
];

function fuselageGeometry(scale = 1, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const pts = FUSELAGE.map(([z, r]) => new THREE.Vector2(r * scale, z));
  const g = new THREE.LatheGeometry(pts, 24, phiStart, phiLength);
  // The lathe revolves about +y; the aeroplane's body runs along z.
  g.rotateX(Math.PI / 2);
  return g;
}

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
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonLight: { value: new THREE.Color(0, 0, 0) },
      uAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
      uAlbedo: { value: new THREE.Color(0xffffff) },
      uMetal: { value: 0.5 },
      uEmissive: { value: 0 },
    };

    const paint = material(this.uniforms, 0xeef1f5, 0.6);
    const stripe = material(this.uniforms, 0xc9512a, 0.45);
    const dark = material(this.uniforms, 0x14181e, 0.25);
    const glass = material(this.uniforms, 0x121c26, 0.9);
    const navR = material(this.uniforms, 0xff3b30, 0.0, 2.2);
    const navG = material(this.uniforms, 0x30ff7a, 0.0, 2.2);

    // One continuous body, nose to tailcone.
    this.group.add(new THREE.Mesh(fuselageGeometry(), paint));

    // Cabin glazing, as bands of the SAME profile a hair larger, so it sits on
    // the surface it belongs to instead of intersecting it. A box cabin
    // punched through a round fuselage was most of what looked wrong.
    //
    // TWO bands, one per side, and the arithmetic for where they go is worth
    // stating: the lathe is built about +y and then rotated onto the body
    // axis, which sends its z to -y, so the height of a point at angle phi is
    // -cos(phi) and the very top of the fuselage is phi = 180 degrees. A
    // single wide band therefore wrapped straight over the SPINE and read as a
    // dark saddle laid across the roof. Leaving a gap either side of 180 keeps
    // the roof painted, which is what a cabin roof is.
    const glazingProfile = [
      new THREE.Vector2(0.472, -2.05),
      new THREE.Vector2(0.622, -1.55),
      new THREE.Vector2(0.670, -0.90),
      new THREE.Vector2(0.678, -0.10),
      new THREE.Vector2(0.658, 0.55),
      new THREE.Vector2(0.606, 1.05),
    ];
    for (const start of [Math.PI * 0.56, Math.PI * 1.07]) {
      const band = new THREE.LatheGeometry(glazingProfile, 14, start, Math.PI * 0.37);
      band.rotateX(Math.PI / 2);
      this.group.add(new THREE.Mesh(band, glass));
    }

    // Cowling: the same profile again over the nose, in the trim colour, so
    // the join is a paint line rather than a step in the geometry.
    const cowl = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.21, -3.08),
        new THREE.Vector2(0.35, -2.88),
        new THREE.Vector2(0.47, -2.58),
        new THREE.Vector2(0.56, -2.18),
        new THREE.Vector2(0.605, -1.85),
      ],
      20,
    );
    cowl.rotateX(Math.PI / 2);
    this.group.add(new THREE.Mesh(cowl, stripe));

    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.52, 14), paint);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -3.5;
    this.group.add(spinner);

    // High wing: tapered, with dihedral, sitting on the cabin roof.
    const ROOT_CHORD = 1.72;
    const TIP_CHORD = 1.22;
    const wingLE = -1.35;
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(
        loftSurface([
          { x: 0, y: 0.70, z: wingLE, chord: ROOT_CHORD },
          { x: s * 2.2, y: 0.78, z: wingLE, chord: ROOT_CHORD },
          { x: s * SEMI_SPAN, y: 0.92, z: wingLE + 0.16, chord: TIP_CHORD },
        ]),
        paint,
      );
      this.group.add(wing);

      const ail = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.07, 0.36), stripe);
      ail.position.set(s * 4.1, 0.86, wingLE + TIP_CHORD + 0.05);
      this.group.add(ail);
      this.ailerons.push(ail);

      // Lift strut, cabin floor to mid-span. Nothing else says "high wing"
      // this cheaply, and a strutless one reads as a different aeroplane.
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.62, 0.20), paint);
      strut.position.set(s * 1.30, 0.02, -0.75);
      strut.rotation.z = s * 0.60;
      this.group.add(strut);

      // Navigation lights: green on the right, red on the left, as on anything
      // that flies. They are how you read the aircraft's heading at range.
      const nav = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), s > 0 ? navG : navR);
      nav.position.set(s * (SEMI_SPAN + 0.04), 0.92, wingLE + 0.2);
      this.group.add(nav);

      // Fixed gear, with a spat over the wheel: the fairings are half of what
      // makes a light single look finished rather than unfinished.
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.09, 0.14), paint);
      leg.position.set(s * 0.58, -0.60, -0.30);
      leg.rotation.z = s * 0.44;
      this.group.add(leg);
      const spat = new THREE.Mesh(new THREE.SphereGeometry(0.30, 10, 8), paint);
      spat.scale.set(0.55, 1.0, 1.35);
      spat.position.set(s * 1.05, -0.92, -0.30);
      this.group.add(spat);
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.14, 12), dark);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(s * 1.05, -1.00, -0.30);
      this.group.add(wheel);
    }

    const noseLeg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.75, 0.09), paint);
    noseLeg.position.set(0, -0.72, -2.05);
    this.group.add(noseLeg);
    const noseSpat = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), paint);
    noseSpat.scale.set(0.55, 1.0, 1.35);
    noseSpat.position.set(0, -1.02, -2.05);
    this.group.add(noseSpat);
    const noseWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.12, 12), dark);
    noseWheel.rotation.z = Math.PI / 2;
    noseWheel.position.set(0, -1.08, -2.05);
    this.group.add(noseWheel);

    // Fin: the same lofted section stood on its side, with a swept leading
    // edge. A box fin is a rudder-shaped slab and reads as one.
    const fin = new THREE.Mesh(
      loftSurface(
        [
          { x: 0, y: 0.16, z: 2.55, chord: 1.85 },
          { x: 0, y: 0.95, z: 3.15, chord: 1.30 },
          { x: 0, y: 1.55, z: 3.55, chord: 0.90 },
        ],
        true,
      ),
      paint,
    );
    this.group.add(fin);
    const finStripe = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.62, 0.48), stripe);
    finStripe.position.set(0, 1.20, 3.72);
    this.group.add(finStripe);

    // One-piece stabiliser, which on this type really does move as a unit.
    this.elevator = new THREE.Group();
    for (const s of [-1, 1]) {
      const stab = new THREE.Mesh(
        loftSurface([
          { x: 0, y: 0, z: 0, chord: 0.98 },
          { x: s * 1.85, y: 0.02, z: 0.14, chord: 0.72 },
        ]),
        paint,
      );
      this.elevator.add(stab);
    }
    this.elevator.position.set(0, 0.22, 3.35);
    this.group.add(this.elevator);

    // Propeller disc. Drawn as a translucent disc rather than blades: a real
    // prop at speed IS a disc, and modelled blades strobe against any frame
    // rate you pick.
    const discMat = material(this.uniforms, 0x8a8f96, 0.1);
    discMat.transparent = true;
    discMat.opacity = 0.22;
    discMat.side = THREE.DoubleSide;
    this.prop = new THREE.Mesh(new THREE.CircleGeometry(0.95, 24), discMat);
    this.prop.position.z = -3.62;
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
