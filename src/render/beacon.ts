// The beacon: a column of light standing on wherever you asked to go.
//
// There used to be a five-landmark TOUR here -- a fixed route, in a fixed
// order, with a panel tracking your progress through it. That is a game about
// compliance rather than a sightseeing flight: it decided where you were going
// next, and the beam always marked somebody else's idea. The list on the left
// answers "where could I go" instead, and this stands on whatever you picked
// from it, or on nothing at all when you have not picked anything.

import * as THREE from "three";

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec3  uColour;
uniform float uTime;
uniform float uStrength;
void main() {
  // Bright at the base, fading upward, with a slow pulse travelling up it.
  float fade = pow(1.0 - vUv.y, 1.7);
  float pulse = 0.62 + 0.38 * sin(uTime * 2.1 - vUv.y * 7.0);
  // Soft edges across the ribbon so it reads as light, not as a flat card.
  float edge = sin(vUv.x * 3.14159);
  float a = fade * pulse * edge * uStrength;
  fragColor = vec4(uColour * a * 2.4, a);
}
`;

/**
 * A beam of light standing on the active landmark.
 *
 * Two crossed ribbons rather than a cylinder: a cylinder seen end-on from
 * directly above collapses to nothing, which is exactly the moment you most
 * need to see where the thing is.
 */
export class Beacon {
  readonly group = new THREE.Group();
  private uniforms = {
    uColour: { value: new THREE.Color(0.35, 0.8, 1.0) },
    uTime: { value: 0 },
    uStrength: { value: 1 },
  };

  constructor() {
    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < 2; i++) {
      const g = new THREE.PlaneGeometry(120, 1400);
      const m = new THREE.Mesh(g, mat);
      m.position.y = 700;
      m.rotation.y = (i * Math.PI) / 2;
      this.group.add(m);
    }
    this.group.visible = false;
  }

  update(mark: { x: number; z: number; groundY: number } | null, timeSec: number, distance: number): void {
    if (!mark) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(mark.x, mark.groundY, mark.z);
    this.uniforms.uTime.value = timeSec;
    // Fade in as you approach, so a distant beam does not clutter the horizon
    // and a near one is unmistakable.
    this.uniforms.uStrength.value = 0.35 + 0.65 * Math.max(0, Math.min(1, (14000 - distance) / 11000));
  }
}
