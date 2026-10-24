// The live aircraft, drawn: real FlightGear airliner meshes in their airline's
// paint, instanced per model and livery, with a dot impostor at range and
// navigation, strobe, beacon and landing lights.
//
// One draw per (model, livery) in view, two with the gear down. 136 aircraft
// over New York come to about 20 buckets, because three carriers and four
// shapes are most of the sky.
//
// Lit by the Cessna's own shader (AircraftModel.trafficMaterial), so an A321
// on the next runway and the aeroplane you are flying sit in the same light.
// Models and liveries are fetched only when an aircraft that needs one is
// close enough to be drawn as a mesh; until then it is a dot, and the dot is
// all a 34 m span is past about 3 km anyway.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AircraftModel } from "./aircraftmodel";
import { SH_GLSL } from "./sh";
import type { Track } from "../data/livetraffic";
import { familyFor, liveryFor, type Family } from "../data/aircrafttypes";

const BASE = "aircraft/traffic/";

interface FamilyInfo {
  liveries: string[];
  span: number;
  length: number;
  wheelY: number;
  bellyY: number;
  wingtip: [number, number, number];
  tail: [number, number, number];
  fin: [number, number, number];
  triangles: number;
}

interface FamilyGeo {
  info: FamilyInfo;
  body: THREE.BufferGeometry;
  gear: THREE.BufferGeometry | null;
}

/**
 * Projected span, in pixels, under which an aircraft is a dot. Six pixels of
 * A320 is 3.4 km at 1280x720: the mesh there is a smudge of 3k triangles that
 * the dot draws for one vertex.
 */
const MESH_MIN_PX = 6;
/** Past this nothing is drawn at all: the server's radius is 74 km. */
const MAX_RANGE_M = 70000;
/** Gear comes down below this height above the ground unless climbing. */
const GEAR_AGL_M = 460;

// Procedural fallbacks for the two things fgdata has no AI model for.
function partColor(g: THREE.BufferGeometry, rgb: number): THREE.BufferGeometry {
  const c = new THREE.Color(rgb);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b, 0], i * 4);
  g.setAttribute("color", new THREE.BufferAttribute(col, 4));
  return g;
}

function placed(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z));
  return g;
}

/** A light utility helicopter (Bell 407 / AS350 class), nose -z, skids at y=0. */
function helicopter(): FamilyGeo {
  const white = 0xe8ebee, dark = 0x23272d, glass = 0x1a2430;
  const parts = [
    partColor(placed(new THREE.SphereGeometry(1, 16, 12).scale(1.1, 1.0, 2.0), 0, 1.75, -0.6), white),
    partColor(placed(new THREE.SphereGeometry(1, 12, 8).scale(0.9, 0.7, 0.9), 0, 1.95, -1.9), glass),
    partColor(placed(new THREE.CylinderGeometry(0.22, 0.38, 6.2, 10), 0, 2.0, 3.6, Math.PI / 2), white),
    partColor(placed(new THREE.BoxGeometry(0.12, 1.4, 0.9), 0, 2.6, 6.6, 0.3), white),
    partColor(placed(new THREE.BoxGeometry(2.4, 0.08, 0.5), 0, 2.0, 5.9), white),
    partColor(placed(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), 0.95, 0.05, -0.5, Math.PI / 2), dark),
    partColor(placed(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), -0.95, 0.05, -0.5, Math.PI / 2), dark),
    partColor(placed(new THREE.CylinderGeometry(0.15, 0.15, 0.5, 8), 0, 2.95, -0.5), dark),
    // Two blades crossed, standing in for the disc a turning rotor is.
    partColor(placed(new THREE.BoxGeometry(10.7, 0.04, 0.3), 0, 3.2, -0.5, 0, 0.4), dark),
    partColor(placed(new THREE.BoxGeometry(10.7, 0.04, 0.3), 0, 3.2, -0.5, 0, 0.4 + Math.PI / 2), dark),
  ];
  const body = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  return {
    info: {
      liveries: ["default"], span: 10.7, length: 12, wheelY: 0, bellyY: 0.9,
      wingtip: [1.1, 1.6, -0.5], tail: [0, 2.6, 7.0], fin: [0, 3.3, 6.8], triangles: body.attributes.position.count / 3,
    },
    body,
    gear: null,
  };
}

/** An airport service van, for ADS-B-equipped vehicles on the surface. */
function vehicle(): FamilyGeo {
  const body = mergeGeometries([
    partColor(placed(new THREE.BoxGeometry(2.0, 1.9, 5.0), 0, 1.25, 0), 0xf2c21b),
    partColor(placed(new THREE.BoxGeometry(1.9, 0.7, 0.2), 0, 1.6, -2.45), 0x1a2430),
    partColor(placed(new THREE.BoxGeometry(2.1, 0.5, 4.4), 0, 0.3, 0), 0x202326),
  ].map((p) => p.toNonIndexed()));
  return {
    info: {
      liveries: ["default"], span: 2, length: 5, wheelY: 0, bellyY: 0.3,
      wingtip: [1.0, 2.2, 0], tail: [0, 1.2, 2.5], fin: [0, 2.25, 0], triangles: 36,
    },
    body,
    gear: null,
  };
}

type Kind = Family | "vehicle";

interface Bucket {
  kind: Kind;
  livery: string;
  material: THREE.RawShaderMaterial;
  body: THREE.InstancedMesh;
  gear: THREE.InstancedMesh | null;
  nBody: number;
  nGear: number;
  cap: number;
}

const DOT_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in float size;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // size is the span in metres: projected, floored at 1.6 px so a jet at
  // 40 km is still a visible speck, the way it is from the ground.
  gl_PointSize = clamp(size * uPx / max(-mv.z, 1.0), 1.6, 8.0);
}
`;

const DOT_FRAG = /* glsl */ `
precision highp float;
${SH_GLSL}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uSunSurface;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  // A white fuselage seen from anywhere: half the sun (one side is lit) plus
  // the sky from above, at the albedo of the plain livery.
  vec3 lit = 0.72 * (uSunColor * uSunIntensity * uSunSurface * 0.5 * max(uSunDir.y, 0.0) / 3.14159 + shIrradiance(vec3(0.0, 1.0, 0.0)));
  fragColor = vec4(lit, 1.0 - r * r);
}
`;

const LIGHT_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 tint;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uPx;
out vec3 vTint;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vTint = tint.rgb;
  // A lamp is a point source: a fixed few pixels, a little larger up close,
  // so it still reads as a light and not as a disc painted on the wing.
  gl_PointSize = tint.a * clamp(60.0 * uPx / max(-mv.z, 1.0) / 1000.0 + 2.5, 2.5, 7.0);
}
`;

const LIGHT_FRAG = /* glsl */ `
precision highp float;
in vec3 vTint;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  fragColor = vec4(vTint * (1.0 - r) * (1.0 - r), 1.0);
}
`;

const SHADOW_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in mat4 instanceMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec2 vP;
void main() {
  vP = position.xz * 2.0;
  gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const SHADOW_FRAG = /* glsl */ `
precision highp float;
in vec2 vP;
uniform float uStrength;
out vec4 fragColor;
void main() {
  float r = dot(vP, vP);
  if (r > 1.0) discard;
  fragColor = vec4(0.0, 0.0, 0.0, uStrength * (1.0 - r) * (1.0 - r));
}
`;

const TRAIL_VERT = /* glsl */ `
precision highp float;
in vec3 position;
/** x: opacity along the trail; y: -1..1 across it, for soft edges. */
in vec2 trail;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vTrail;
void main() {
  vTrail = trail;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision highp float;
${SH_GLSL}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uSunSurface;
in vec2 vTrail;
out vec4 fragColor;
void main() {
  // Ice crystals scatter the sun forward and sideways alike, plus the sky.
  vec3 lit = uSunColor * uSunIntensity * uSunSurface * 0.5 * max(uSunDir.y + 0.1, 0.0) + shIrradiance(vec3(0.0, 1.0, 0.0));
  float across = 1.0 - vTrail.y * vTrail.y;
  fragColor = vec4(lit, vTrail.x * across * 0.8);
}
`;

/** Contrails form in the cold above roughly FL260 (Appleman, at ISA). */
const TRAIL_MIN_M = 8000;
/** A young contrail, before it spreads: 3 km long, 20 m to 160 m wide. */
const TRAIL_LEN_M = 3000;

/** Per-aircraft phase so the strobes over a city do not all fire together. */
function phaseOf(hex: string): number {
  let h = 0;
  for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

const MAX_LIGHTS = 8;
const RED = [1.0, 0.09, 0.05];
const GREEN = [0.08, 1.0, 0.25];
const WHITE = [1.0, 0.97, 0.92];

export class AirTraffic {
  readonly group = new THREE.Group();
  readonly stats = { meshes: 0, dots: 0, triangles: 0, buckets: 0, trails: 0 };

  private manifest: Record<string, FamilyInfo> | null = null;
  private families = new Map<Kind, FamilyGeo | "loading" | "failed">();
  private textures = new Map<string, THREE.Texture | "loading">();
  private buckets = new Map<string, Bucket>();
  private loader = new GLTFLoader();

  private dots: THREE.Points;
  private dotPos: Float32Array;
  private dotSize: Float32Array;
  private lights: THREE.Points;
  private lightPos: Float32Array;
  private lightTint: Float32Array;
  private cap = 0;
  /**
   * A soft dark ellipse under every aircraft on or near the ground. The sun
   * cascades cannot take these (an instanced draw through the depth override
   * stacks every instance on the origin; see render/trees.ts), and without
   * any contact shadow a jet at the gate reads as hovering over the apron.
   */
  private shadows: THREE.InstancedMesh;
  /** Contrail ribbons, rebuilt on the CPU each frame: four vertices a jet. */
  private trails: THREE.Mesh;
  private trailPos = new Float32Array(0);
  private trailUv = new Float32Array(0);
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private shadowMat: THREE.RawShaderMaterial;

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private scale = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private clock = 0;

  constructor(private model: AircraftModel) {
    this.families.set("heli", helicopter());
    this.families.set("vehicle", vehicle());

    const dotMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: DOT_VERT,
      fragmentShader: DOT_FRAG,
      uniforms: { ...model.uniforms, uPx: { value: 600 } },
      transparent: true,
      depthWrite: false,
    });
    const lightMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      uniforms: { uPx: dotMat.uniforms.uPx },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dotPos = new Float32Array(0);
    this.dotSize = new Float32Array(0);
    this.lightPos = new Float32Array(0);
    this.lightTint = new Float32Array(0);
    this.dots = new THREE.Points(new THREE.BufferGeometry(), dotMat);
    this.lights = new THREE.Points(new THREE.BufferGeometry(), lightMat);
    this.dots.frustumCulled = false;
    this.lights.frustumCulled = false;
    // Lights after everything opaque and after the dots.
    this.lights.renderOrder = 2;
    this.dots.renderOrder = 1;
    this.group.add(this.dots, this.lights);
    this.shadowMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: { uStrength: { value: 0.45 } },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.shadowMat, 1);
    this.trails = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: TRAIL_VERT,
        fragmentShader: TRAIL_FRAG,
        uniforms: { ...model.uniforms },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.trails.frustumCulled = false;
    this.group.add(this.trails);
    this.grow(64);

    void fetch(BASE + "manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Record<string, FamilyInfo> | null) => {
        this.manifest = j;
      })
      .catch(() => {});
  }

  /** Wingspan in metres for what `t` is drawn as, for the spotting range. */
  spanFor(t: Track): number {
    const kind: Kind = t.info.cat.startsWith("C") ? "vehicle" : familyFor(t.info.type, t.info.cat);
    const f = this.families.get(kind);
    if (f && f !== "loading" && f !== "failed") return f.info.span;
    return this.manifest?.[kind]?.span ?? (kind === "pa28" ? 10 : kind === "heli" ? 10.7 : kind === "cl60" ? 20 : 34);
  }

  private grow(n: number): void {
    this.cap = n;
    this.dotPos = new Float32Array(n * 3);
    this.dotSize = new Float32Array(n);
    this.lightPos = new Float32Array(n * MAX_LIGHTS * 3);
    this.lightTint = new Float32Array(n * MAX_LIGHTS * 4);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute("size", new THREE.BufferAttribute(this.dotSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.dots.geometry.dispose();
    this.dots.geometry = dg;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(this.lightPos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute("tint", new THREE.BufferAttribute(this.lightTint, 4).setUsage(THREE.DynamicDrawUsage));
    this.lights.geometry.dispose();
    this.lights.geometry = lg;
    this.trailPos = new Float32Array(n * 4 * 3);
    this.trailUv = new Float32Array(n * 4 * 2);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute("trail", new THREE.BufferAttribute(this.trailUv, 2).setUsage(THREE.DynamicDrawUsage));
    tg.setIndex(new THREE.BufferAttribute(idx, 1));
    this.trails.geometry.dispose();
    this.trails.geometry = tg;
    this.group.remove(this.shadows);
    this.shadows.dispose();
    this.shadows = new THREE.InstancedMesh(this.shadows.geometry, this.shadowMat, n);
    this.shadows.frustumCulled = false;
    this.shadows.count = 0;
    this.group.add(this.shadows);
  }

  /** The geometry for a kind, or null while it is being fetched. */
  private family(kind: Kind): FamilyGeo | null {
    const f = this.families.get(kind);
    if (f && f !== "loading" && f !== "failed") return f;
    if (f || !this.manifest) return null;
    const info = this.manifest[kind];
    if (!info) {
      this.families.set(kind, "failed");
      return null;
    }
    this.families.set(kind, "loading");
    this.loader.load(
      `${BASE}${kind}.glb`,
      (gltf) => {
        let body: THREE.BufferGeometry | null = null;
        let gear: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            if (o.name === "gear") gear = o.geometry as THREE.BufferGeometry;
            else body = o.geometry as THREE.BufferGeometry;
          }
        });
        this.families.set(kind, body ? { info, body, gear } : "failed");
      },
      undefined,
      () => this.families.set(kind, "failed"),
    );
    return null;
  }

  private texture(kind: Kind, livery: string): THREE.Texture | null {
    const key = `${kind}-${livery}`;
    const t = this.textures.get(key);
    if (t) return t === "loading" ? null : t;
    this.textures.set(key, "loading");
    new THREE.TextureLoader().load(`${BASE}${key}.webp`, (tex) => {
      // The glb's UVs are already flipped to glTF's top-down convention.
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this.textures.set(key, tex);
      const b = this.buckets.get(key);
      if (b) {
        b.material.uniforms.uMap.value = tex;
        b.material.uniforms.uMapMode.value = 1;
      }
    });
    return null;
  }

  private bucket(kind: Kind, livery: string, geo: FamilyGeo): Bucket {
    const key = `${kind}-${livery}`;
    let b = this.buckets.get(key);
    if (!b) {
      const procedural = kind === "heli" || kind === "vehicle";
      const tex = procedural ? null : this.texture(kind, livery);
      const material = this.model.trafficMaterial(tex);
      b = { kind, livery, material, body: null!, gear: null, nBody: 0, nGear: 0, cap: 0 };
      this.buckets.set(key, b);
      this.resize(b, geo, 8);
    }
    return b;
  }

  private resize(b: Bucket, geo: FamilyGeo, cap: number): void {
    for (const m of [b.body, b.gear]) if (m) { this.group.remove(m); m.dispose(); }
    b.cap = cap;
    b.body = new THREE.InstancedMesh(geo.body, b.material, cap);
    b.body.frustumCulled = false;
    b.body.count = 0;
    this.group.add(b.body);
    b.gear = geo.gear ? new THREE.InstancedMesh(geo.gear, b.material, cap) : null;
    if (b.gear) {
      b.gear.frustumCulled = false;
      b.gear.count = 0;
      this.group.add(b.gear);
    }
  }

  /**
   * Draws `tracks` from `camera`. `night` is the scene's 0..1 darkness, which
   * is what turns the lights from a glint into the main thing you see.
   */
  update(
    tracks: Iterable<Track>,
    camera: THREE.PerspectiveCamera,
    /** CSS pixels, for the mesh-or-dot decision; buffer pixels, for point sizes. */
    cssH: number,
    bufferH: number,
    dt: number,
    night: number,
  ): void {
    this.clock += dt;
    const focal = 1 / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const px = cssH * focal;
    (this.dots.material as THREE.RawShaderMaterial).uniforms.uPx.value = bufferH * focal;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);

    for (const b of this.buckets.values()) b.nBody = b.nGear = 0;
    let nDot = 0;
    let nShadow = 0;
    let nTrail = 0;
    let nLight = 0;
    let tris = 0;
    let meshes = 0;
    const list = [...tracks];
    if (list.length > this.cap) this.grow(Math.max(list.length, this.cap * 2));

    // Measured against the Manhattan night pose: at 8x the nav lights bloomed
    // into 40 px halos; 3x reads as a lamp. By day they are a glint.
    const lightGain = 0.5 + 2.5 * night;
    const cam = camera.position;

    for (const t of list) {
      const p = t.pose;
      const dist = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      if (dist > MAX_RANGE_M) continue;
      const kind: Kind = t.info.cat.startsWith("C") ? "vehicle" : familyFor(t.info.type, t.info.cat);
      const geo = this.family(kind);
      const span = geo?.info.span ?? (kind === "pa28" ? 10 : kind === "cl60" ? 20 : 34);
      if (p.y > TRAIL_MIN_M && !t.k.ground && (t.info.gsKt ?? 0) > 250 && (kind as string) !== "heli") {
        // Straight back along the track from the tail, widening as it ages,
        // turned edge-on to nothing: its width vector is perpendicular to
        // both the trail and the line of sight, so it never goes to a line.
        const h = (p.headingDeg * Math.PI) / 180;
        this.tmpA.set(p.x - Math.sin(h) * 20, p.y, p.z + Math.cos(h) * 20);
        this.tmpB.set(p.x - Math.sin(h) * TRAIL_LEN_M, p.y + 40, p.z + Math.cos(h) * TRAIL_LEN_M);
        this.sphere.center.copy(this.tmpA).add(this.tmpB).multiplyScalar(0.5);
        this.sphere.radius = TRAIL_LEN_M / 2 + 100;
        if (this.frustum.intersectsSphere(this.sphere)) {
          this.v.subVectors(this.tmpB, this.tmpA);
          this.tmpS.subVectors(this.sphere.center, cam).cross(this.v).normalize();
          const o = nTrail * 12;
          const u = nTrail * 8;
          // Never thinner than ~1.5 px: a real contrail 30 km off is the
          // brightest line in the sky, and at its true 20 m it would be a
          // fifth of a pixel and vanish.
          const floor = (1.5 * this.sphere.center.distanceTo(cam)) / px / 2;
          for (const [k, end, wide, alpha] of [[0, this.tmpA, Math.max(10, floor), 0.9], [2, this.tmpB, Math.max(80, floor * 2), 0]] as const) {
            this.trailPos.set([end.x - this.tmpS.x * wide, end.y - this.tmpS.y * wide, end.z - this.tmpS.z * wide], o + k * 3);
            this.trailPos.set([end.x + this.tmpS.x * wide, end.y + this.tmpS.y * wide, end.z + this.tmpS.z * wide], o + k * 3 + 3);
            this.trailUv.set([alpha, -1, alpha, 1], u + k * 2);
          }
          nTrail++;
        }
      }
      this.sphere.center.set(p.x, p.y, p.z);
      this.sphere.radius = span;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;

      const ground = t.k.ground;
      const agl = p.y - t.groundY;
      const y = ground ? p.y - (geo?.info.wheelY ?? 0) : p.y;
      this.e.set((p.pitchDeg * Math.PI) / 180, (-p.headingDeg * Math.PI) / 180, (-p.bankDeg * Math.PI) / 180, "YXZ");
      this.q.setFromEuler(this.e);

      const spanPx = (span * px) / Math.max(dist, 1);
      if (geo && spanPx >= MESH_MIN_PX) {
        const livery = kind === "heli" || kind === "vehicle" ? "default" : liveryFor(t.info.flight, geo.info.liveries);
        const b = this.bucket(kind, livery, geo);
        if (b.nBody >= b.cap) this.resize(b, geo, b.cap * 2);
        this.m.compose(this.v.set(p.x, y, p.z), this.q, this.one);
        b.body.setMatrixAt(b.nBody++, this.m);
        tris += geo.body.attributes.position.count / 3;
        const gearDown = ground || agl < 60 || (agl < GEAR_AGL_M && (t.info.vrFpm ?? 0) < 300);
        if (b.gear && gearDown) {
          b.gear.setMatrixAt(b.nGear++, this.m);
        }
        meshes++;
        // Fades out over the first 40 m of climb: past that the real shadow
        // is somewhere else entirely and a blob straight below would be wrong.
        if (agl < 40) {
          const k = 1 - Math.max(0, agl) / 40;
          this.e.set(0, (-p.headingDeg * Math.PI) / 180, 0, "YXZ");
          this.q.setFromEuler(this.e);
          this.m.compose(
            this.v.set(p.x, t.groundY + 0.15, p.z),
            this.q,
            this.scale.set(geo.info.span * 0.8 * k, 1, geo.info.length * 0.85 * k),
          );
          this.shadows.setMatrixAt(nShadow++, this.m);
          // Back to the aircraft's attitude for the lights below.
          this.e.set((p.pitchDeg * Math.PI) / 180, (-p.headingDeg * Math.PI) / 180, (-p.bankDeg * Math.PI) / 180, "YXZ");
          this.q.setFromEuler(this.e);
        }
      } else {
        this.dotPos.set([p.x, p.y, p.z], nDot * 3);
        this.dotSize[nDot] = span;
        nDot++;
      }

      // Lights, in model space then out through the same transform.
      if (nLight + MAX_LIGHTS > this.cap * MAX_LIGHTS) continue;
      const info = geo?.info;
      const tip = info?.wingtip ?? [span / 2, 1, 0];
      const fin = info?.fin ?? [0, 8, 15];
      const tail = info?.tail ?? [0, 4, 18];
      const belly = info?.bellyY ?? 0;
      const len = info?.length ?? 36;
      const ph = phaseOf(t.info.hex);
      const tStrobe = (this.clock + ph * 1.2) % 1.2;
      const strobe = tStrobe < 0.05 || (tStrobe > 0.15 && tStrobe < 0.2) ? 1 : 0;
      const beacon = Math.max(0, Math.sin((this.clock + ph) * 2 * Math.PI * 0.9)) ** 8;
      const add = (x: number, ly: number, z: number, c: number[], gain: number, size = 1) => {
        if (gain <= 0.01) return;
        this.v.set(x, ly, z).applyQuaternion(this.q);
        this.lightPos.set([this.v.x + p.x, this.v.y + y, this.v.z + p.z], nLight * 3);
        this.lightTint.set([c[0] * gain, c[1] * gain, c[2] * gain, size], nLight * 4);
        nLight++;
      };
      add(-tip[0], tip[1], tip[2], RED, lightGain);
      add(tip[0], tip[1], tip[2], GREEN, lightGain);
      add(tail[0], tail[1], tail[2], WHITE, lightGain * 0.6);
      add(0, fin[1] * 0.55, 0, RED, lightGain * 1.6 * beacon);
      add(0, belly, 0, RED, lightGain * 1.6 * beacon);
      add(-tip[0], tip[1], tip[2], WHITE, (1.5 + 4.5 * night) * strobe, 1.3);
      add(tip[0], tip[1], tip[2], WHITE, (1.5 + 4.5 * night) * strobe, 1.3);
      // Landing lights on approach and for the take-off roll: the single
      // brightest thing in a night sky over an airport.
      const landing = (!ground && agl < 900 && (t.info.vrFpm ?? 0) < 200) || (ground && (t.info.gsKt ?? 0) > 40);
      if (landing) add(0, belly + 0.6, -len * 0.42, WHITE, 1.5 + 6 * night, 1.6);
    }

    for (const b of this.buckets.values()) {
      b.body.count = b.nBody;
      b.body.instanceMatrix.needsUpdate = b.nBody > 0;
      b.body.visible = b.nBody > 0;
      if (b.gear) {
        b.gear.count = b.nGear;
        b.gear.instanceMatrix.needsUpdate = b.nGear > 0;
        b.gear.visible = b.nGear > 0;
      }
    }
    const tg = this.trails.geometry;
    (tg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (tg.attributes.trail as THREE.BufferAttribute).needsUpdate = true;
    tg.setDrawRange(0, nTrail * 6);
    this.trails.visible = nTrail > 0;
    this.stats.trails = nTrail;
    this.shadows.count = nShadow;
    this.shadows.instanceMatrix.needsUpdate = nShadow > 0;
    this.shadows.visible = nShadow > 0;
    const dg = this.dots.geometry;
    (dg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (dg.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    dg.setDrawRange(0, nDot);
    const lg = this.lights.geometry;
    (lg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (lg.attributes.tint as THREE.BufferAttribute).needsUpdate = true;
    lg.setDrawRange(0, nLight);

    this.stats.meshes = meshes;
    this.stats.dots = nDot;
    this.stats.triangles = tris;
    this.stats.buckets = [...this.buckets.values()].filter((b) => b.nBody > 0).length;
  }
}
