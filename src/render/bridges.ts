// The landmark bridges on screen: the meshes render/bridgemesh.ts builds, lit
// by the same sun, sky probe, shadow cascades and atmosphere as everything
// else, so a bridge sits in the haze and the exposure of the city around it.
//
// THREE MESHES PER BRIDGE, see bridgemesh.ts: FAR always, NEAR inside NEAR_M,
// LINES always but widened in the vertex shader to a minimum on-screen width.
// That last part is why the cables and suspenders read as lines at 2 km
// instead of as a dotted rumour of lines: a 0.92 m Golden Gate cable is 0.6 px
// at 2 km on a 720 px frame and a 68 mm suspender is 0.05 px, and a triangle
// that thin misses most pixel centres it crosses.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL } from "./sh";
import { AO_GLSL } from "./ao";
import { makeStreetLampUniforms, type StreetLampUniforms } from "./streetlamps";
import { buildBridgeMesh, deckSampler, NEAR_M, type BridgeMesh, type MeshData } from "./bridgemesh";
import type { Landmark } from "../data/landmarks";
import type { Deck } from "../data/bridgedeck";
import type { RoadPack } from "../data/roadpack";

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 aColour;
in vec3 aSurf;   // x gloss, y emissive kind, z line radius (0: not a line)

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform float uPixelAngle;   // radians one screen pixel subtends

out vec3 vNormal;
out vec3 vWorld;
out vec3 vColour;
out vec3 vSurf;
out float vViewDist;

void main() {
  vec3 p = position;
  float r = aSurf.z;
  if (r > 0.0) {
    // A line or a light: position is its centreline, normal its radial
    // direction. Widen to a minimum on-screen RADIUS: 0.45 px for a main
    // cable (just under a pixel across, which MSAA resolves to a soft
    // continuous line), 0.22 px for anything thinner than 0.1 m, so a field of
    // suspenders resolves to the faint hatching a photograph shows rather than
    // to a red curtain, and 0.7 px for a lamp, which the bloom then turns
    // into a point of light from any distance. Emission is kept to a few
    // times white: the first cut at 22-40x bloomed every deck lamp of the
    // Golden Gate into one 200 px smear at 2 km.
    float minPx = aSurf.y > 0.5 ? 0.7 : (r < 0.1 ? 0.22 : 0.45);
    float d = distance(p, uCameraPos);
    p += normal * max(r, d * uPixelAngle * minPx);
  }
  vNormal = normal;
  vWorld = p;
  vColour = aColour;
  vSurf = aSurf;
  vViewDist = distance(p, uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vColour;
in vec3 vSurf;
in float vViewDist;
out vec4 fragColor;

#define ATMO_STEPS 3
#define ATMO_SUN_STEPS 1
${ATMOSPHERE_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}

uniform vec3  uCameraPos;
uniform float uSunSurface;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uNight;
uniform vec3  uNightGlow;
uniform float uTime;

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = vColour;
  float gloss = vSurf.x;
  float kind = vSurf.y;

  vec3 v = normalize(uCameraPos - vWorld);
  // Thin geometry is seen from both sides; flip a back-facing normal rather
  // than shading the far side of a rail black.
  if (dot(n, v) < 0.0) n = -n;

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  vec3 sunE = uSunColor * uSunIntensity * uSunSurface * sunT;
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 ambient = occludedSkyIrradiance(n);
  vec3 moon = uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));

  vec3 lit = albedo * (sunE * ndl * sunVis + ambient + moon);
  lit += albedo * uNightGlow * uNight * 0.5;
  // Painted steel has a sheen: Blinn-Phong, its lobe narrowing with gloss.
  // Weighted down by Fresnel-free 4 % at normal incidence, which is what paint
  // and wet-looking enamel measure.
  vec3 h = normalize(uSunDir + v);
  float spec = pow(max(0.0, dot(n, h)), mix(6.0, 90.0, gloss)) * (0.04 + 0.2 * gloss) * ndl;
  lit += sunE * spec * sunVis;

  if (kind > 0.5) {
    // Emitters. Not lit by the sun: a lamp head in daylight is a dull lens.
    lit = albedo * (ambient * 0.3 + sunE * ndl * 0.2);
    if (kind < 1.5) {
      // Aviation obstruction red: steady, and faintly visible by day too.
      lit += vec3(1.0, 0.04, 0.02) * mix(1.0, 6.0, uNight);
    } else if (kind < 2.5) {
      lit += vec3(1.0, 0.72, 0.42) * 2.5 * uNight;
    } else {
      // The Bay Lights twinkle. A hash of position and a slow clock, so
      // neighbours are out of step.
      float ph = fract(sin(dot(floor(vWorld.xz * 0.5), vec2(12.9898, 78.233))) * 43758.5453);
      float tw = 0.35 + 0.65 * smoothstep(0.2, 1.0, sin(uTime * 1.3 + ph * 6.2831) * 0.5 + 0.5);
      lit += vec3(0.85, 0.9, 1.0) * 3.0 * uNight * tw;
    }
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  fragColor = vec4(lit * trans + inscatter, 1.0);
}
`;

export interface BridgeUniforms extends StreetLampUniforms {
  uPixelAngle: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

export interface BridgeStats {
  bridges: number;
  triangles: number;
  nearTriangles: number;
  buildMs: number;
}

function geometryOf(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.normal, 3));
  g.setAttribute("aColour", new THREE.BufferAttribute(m.colour, 3));
  g.setAttribute("aSurf", new THREE.BufferAttribute(m.surf, 3));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeBoundingSphere();
  return g;
}

export class Bridges {
  readonly group = new THREE.Group();
  readonly uniforms: BridgeUniforms;
  readonly stats: BridgeStats = { bridges: 0, triangles: 0, nearTriangles: 0, buildMs: 0 };
  readonly built: { landmark: Landmark; mesh: BridgeMesh }[] = [];
  private readonly nearMeshes: { mesh: THREE.Mesh; min: number[]; max: number[] }[] = [];

  constructor(
    landmarks: readonly Landmark[],
    pack: RoadPack,
    decks: readonly (Deck | null)[],
    groundAt: (x: number, z: number) => number,
    shadow: SunShadowUniforms,
  ) {
    const t0 = performance.now();
    this.uniforms = {
      ...makeStreetLampUniforms(shadow),
      uPixelAngle: { value: 0.001 },
      uTime: { value: 0 },
    };
    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      // Rails and the inside faces of thin members are seen from both sides;
      // the fragment shader flips the normal to face the eye.
      side: THREE.DoubleSide,
    });
    for (const l of landmarks) {
      const mesh = buildBridgeMesh(l, { groundAt, deck: deckSampler(l, pack, decks) });
      this.built.push({ landmark: l, mesh });
      const far = new THREE.Mesh(geometryOf(mesh.far), mat);
      // Towers and decks throw the shadows that tell you how high they are.
      far.layers.enable(SHADOW_CASTER_LAYER);
      const near = new THREE.Mesh(geometryOf(mesh.near), mat);
      const lines = new THREE.Mesh(geometryOf(mesh.lines), mat);
      // Bounding spheres from the CENTRELINE undercount a widened line by
      // under a metre at a kilometre; the far mesh's sphere already contains
      // every cable, so culling on either is safe.
      for (const m of [far, near, lines]) this.group.add(m);
      this.nearMeshes.push({ mesh: near, min: mesh.min, max: mesh.max });
      this.stats.triangles += mesh.far.triangles + mesh.lines.triangles + mesh.near.triangles;
      this.stats.nearTriangles += mesh.near.triangles;
      this.stats.bridges++;
    }
    this.stats.buildMs = performance.now() - t0;
  }

  /** Per frame: the near-bucket switch and the line widening. */
  update(camera: THREE.PerspectiveCamera, heightPx: number, timeSec: number): void {
    const c = camera.position;
    for (const n of this.nearMeshes) {
      const dx = Math.max(n.min[0] - c.x, 0, c.x - n.max[0]);
      const dy = Math.max(n.min[1] - c.y, 0, c.y - n.max[1]);
      const dz = Math.max(n.min[2] - c.z, 0, c.z - n.max[2]);
      n.mesh.visible = Math.hypot(dx, dy, dz) < NEAR_M;
    }
    this.uniforms.uPixelAngle.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, heightPx);
    this.uniforms.uTime.value = timeSec;
  }
}
