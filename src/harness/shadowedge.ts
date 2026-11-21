// A known shadow edge for tools/verify-shadowedge.ts: one thin wall on flat
// ground, shadowed through the real SunShadow and SUN_SHADOW_GLSL, and the
// ground's sun visibility read back from straight above.
//
// A scene of its own rather than a city pose, because the gate measures the
// SHAPE of one edge to the centimetre and needs to know exactly where that
// edge is and which way it runs: a pose would mix in drapes, textures, AO
// and whatever else the frame holds.
//
// The wall's top edge is turned EDGE_ANGLE_DEG off the light's x axis, which
// is the worst case for a texel staircase: a long run of the edge crossing
// the shadow map's rows one at a time.
//
// Query: tier=full|reduced, shadowprobe=0|1|2 (see SunShadow.kernelProbe),
// angle (degrees off the light x axis), radius (kernel texels, for sweeps).

import * as THREE from "three";
import { budgetForTier, describeDevice } from "../render/budget";
import { SHADOW_CASTER_LAYER, SUN_SHADOW_GLSL, SunShadow } from "../render/sunshadow";

const SUN_ELEVATION_DEG = 25;
const SUN_AZIMUTH_DEG = 140;
const params = new URLSearchParams(location.search);
const EDGE_ANGLE_DEG = Number(params.get("angle") ?? 12);
const WALL_HEIGHT_M = 8;
/** The read-back window: ALONG metres of edge by ACROSS metres either side of it. */
const ALONG_M = 3;
const ACROSS_M = 4;
const PX_PER_M = 200;
/** The eye that the cascades are fitted to: standing this far from the edge, at eye height. */
const EYE_BACK_M = 15;

const tier = params.get("tier") === "reduced" ? "reduced" : "full";
const budget = budgetForTier(tier, describeDevice());

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(64, 64);
document.body.appendChild(renderer.domElement);

const shadow = new SunShadow(budget);
shadow.kernelProbe = Number(params.get("shadowprobe") ?? 0) || 0;
if (params.has("radius")) shadow.kernelRadius = Number(params.get("radius"));
// The splits Pompeii uses (render/pompeii.ts), where the staircase was worst.
shadow.setSplits(150, 700);

const el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
const sunDir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

// The light's x axis, the same construction as SunShadow.fit's lookAt.
const lightX = new THREE.Vector3(0, 1, 0).cross(sunDir).normalize();
const edgeDir = lightX.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(EDGE_ANGLE_DEG));
// Across the edge, pointing away from the wall (into the lit side).
const sunFlat = new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize();
let acrossDir = new THREE.Vector3(0, 1, 0).cross(edgeDir).normalize();
if (acrossDir.dot(sunFlat) > 0) acrossDir.negate();

const scene = new THREE.Scene();
const wall = new THREE.Mesh(new THREE.BoxGeometry(40, WALL_HEIGHT_M, 0.2), new THREE.MeshBasicMaterial());
wall.position.set(0, WALL_HEIGHT_M / 2, 0);
wall.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), edgeDir);
wall.layers.enable(SHADOW_CASTER_LAYER);
wall.layers.disable(0);
scene.add(wall);

// Where the top edge's centre lands on the ground.
const edgeCentre = new THREE.Vector3(0, WALL_HEIGHT_M, 0).addScaledVector(sunDir, -WALL_HEIGHT_M / sunDir.y);
edgeCentre.y = 0;

const uniforms = { ...shadow.uniforms, uSunDir: { value: sunDir }, uEye: { value: new THREE.Vector3() } };
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
  new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: /* glsl */ `precision highp float;
in vec3 position;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
    fragmentShader: /* glsl */ `precision highp float;
in vec3 vWorld;
uniform vec3 uSunDir;
uniform vec3 uEye;
out vec4 fragColor;
${SUN_SHADOW_GLSL}
void main() {
  float v = geometrySunVisibility(vWorld, vec3(0.0, 1.0, 0.0), uSunDir, distance(vWorld, uEye));
  fragColor = vec4(vec3(v), 1.0);
}`,
  }),
);
scene.add(ground);

// The eye stands on the lit side looking back at the edge, so the edge is in
// the first cascade the way a street-level view's shadows are.
const eye = new THREE.PerspectiveCamera(62, 16 / 9, 0.5, 20000);
eye.position.copy(edgeCentre).addScaledVector(acrossDir, EYE_BACK_M).setY(1.7);
eye.lookAt(edgeCentre);
eye.updateMatrixWorld(true);
uniforms.uEye.value.copy(eye.position);

// Straight down, image x along the edge and image y across it.
const W = ALONG_M * PX_PER_M;
const H = 2 * ACROSS_M * PX_PER_M;
const top = new THREE.OrthographicCamera(-ALONG_M / 2, ALONG_M / 2, ACROSS_M, -ACROSS_M, 1, 100);
top.position.copy(edgeCentre).setY(50);
top.up.copy(acrossDir);
top.lookAt(edgeCentre);
top.updateMatrixWorld(true);

const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType });

shadow.update(renderer, scene, eye, sunDir, 1);
renderer.setRenderTarget(target);
renderer.render(scene, top);
const px = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, px);
renderer.setRenderTarget(null);

// One channel, top row first; the tool decides what the numbers mean.
const grey = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grey[(H - 1 - y) * W + x] = px[(y * W + x) * 4];
let bin = "";
for (let i = 0; i < grey.length; i++) bin += String.fromCharCode(grey[i]);

const texelWorld = shadow.uniforms.uCascadeTexelWorld.value.x;
(window as unknown as { __edge: unknown }).__edge = {
  w: W,
  h: H,
  pxPerM: PX_PER_M,
  tier,
  probe: shadow.kernelProbe,
  taps: shadow.uniforms.uShadowKernel.value.x,
  texelWorld,
  data: btoa(bin),
};
