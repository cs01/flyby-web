// The tour: five landmarks per city, in route order, each marked by a beam.
//
// This is the difference between a renderer and something to do. A free-flight
// camera over a beautiful city runs out of purpose in about ninety seconds; a
// next thing to reach gives the flight a shape, and the route order means the
// city unfolds rather than being wandered at random.
//
// Reach is measured in PLAN distance, ignoring altitude. Requiring an aircraft
// to hit a sphere means fighting the altitude axis to collect a thing you have
// already flown over, which is frustrating rather than difficult.

import * as THREE from "three";
import type { City, Landmark } from "../cities";
import { Origin } from "../geo";

const REACH_M = 420;

export interface TourMark extends Landmark {
  x: number;
  z: number;
  groundY: number;
  collected: boolean;
  /** Seconds from the start of the leg to collection. */
  legSeconds: number;
}

export class Tour {
  readonly marks: TourMark[];
  private index = 0;
  private legStart = 0;
  private elapsed = 0;
  /** Set for one frame when a landmark is collected, for the HUD to react. */
  justCollected: TourMark | null = null;
  finished = false;

  constructor(city: City, origin: Origin, groundAt: (x: number, z: number) => number) {
    this.marks = city.landmarks.map((l) => {
      const w = origin.toWorld(l.lat, l.lon);
      return { ...l, x: w.x, z: w.z, groundY: groundAt(w.x, w.z), collected: false, legSeconds: 0 };
    });
  }

  get active(): TourMark | null {
    return this.index < this.marks.length ? this.marks[this.index] : null;
  }

  /** Plan distance from a world position to the active mark, metres. */
  distanceTo(pos: THREE.Vector3): number {
    const m = this.active;
    if (!m) return 0;
    return Math.hypot(pos.x - m.x, pos.z - m.z);
  }

  update(pos: THREE.Vector3, dt: number): void {
    this.justCollected = null;
    this.elapsed += dt;
    const m = this.active;
    if (!m) return;
    if (this.distanceTo(pos) <= REACH_M) {
      m.collected = true;
      m.legSeconds = this.elapsed - this.legStart;
      this.legStart = this.elapsed;
      this.justCollected = m;
      this.index++;
      if (this.index >= this.marks.length) this.finished = true;
    }
  }
}

// --- Beacon ----------------------------------------------------------------

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

  update(mark: TourMark | null, timeSec: number, distance: number): void {
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
