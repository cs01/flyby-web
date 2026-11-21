// The room the escape starts in: the bakery's mill room or a cell of the
// Lupanar, built inside the house's own footprint with a doorway onto the
// street. The town's mesh (render/pompeiimesh.ts) builds houses as solids
// with no inside, so the room is drawn here, on top of it: from inside the
// solid's outward faces are culled and this room is all there is; from the
// street a dark doorway is laid over the frontage where the room opens.
//
// It also keeps the walker in: inside the room the town's collision (which
// would push them out through the nearest wall) is replaced by these walls,
// with the doorway as the one way out.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ERUPTION_SURFACE_GLSL, eruptionSurfaceUniforms } from "./eruption";

export type RoomKind = "bakery" | "lupanar";

export interface RoomPlan {
  /** Middle of the frontage edge, on the street side of the room. */
  mx: number;
  mz: number;
  /** Unit vector along the frontage, and the unit inward normal. */
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  width: number;
  depth: number;
  floorY: number;
}

const WALL_H = 3.4;
const DOOR_W = 1.4;
const DOOR_H = 2.3;
const T = 0.25;

/**
 * A room inside the solid `ring` (x,z pairs), opening onto its edge nearest a
 * street. Null when the lot is too small to stand in.
 */
export function planRoom(ring: number[], streets: number[][], floorY: number): RoomPlan | null {
  const n = ring.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[i * 2]; cz += ring[i * 2 + 1]; }
  cx /= n; cz /= n;
  const segDist = (px: number, pz: number, p: number[]) => {
    let best = Infinity;
    for (let k = 2; k < p.length; k += 2) {
      const ax = p[k - 2], az = p[k - 1], bx = p[k], bz = p[k + 1];
      const L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / L2));
      best = Math.min(best, Math.hypot(ax + (bx - ax) * t - px, az + (bz - az) * t - pz));
    }
    return best;
  };
  let bestE = -1, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[((i + 1) % n) * 2], bz = ring[((i + 1) % n) * 2 + 1];
    if (Math.hypot(bx - ax, bz - az) < 3.2) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const d = Math.min(...streets.map((p) => segDist(mx, mz, p)));
    if (d < bestD) { bestD = d; bestE = i; }
  }
  if (bestE < 0) return null;
  const ax = ring[bestE * 2], az = ring[bestE * 2 + 1], bx = ring[((bestE + 1) % n) * 2], bz = ring[((bestE + 1) % n) * 2 + 1];
  const L = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  let nx = -uz, nz = ux;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  if ((cx - mx) * nx + (cz - mz) * nz < 0) { nx = -nx; nz = -nz; }
  // As deep as the lot allows, stepping in until the far wall would leave it.
  let depth = 0;
  while (depth < 6 && inRing(ring, mx + nx * (depth + 0.6), mz + nz * (depth + 0.6))) depth += 0.25;
  const width = Math.min(L - 0.6, 6);
  if (depth < 3 || width < 3) return null;
  return { mx, mz, ux, uz, nx, nz, width, depth: Math.min(depth, 5.5), floorY };
}

function inRing(r: number[], x: number, z: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 color;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorld;
out vec3 vN;
out vec3 vCol;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = mat3(modelMatrix) * normal;
  vCol = color;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec3 vN;
in vec3 vCol;
out vec4 fragColor;
uniform vec3 uRoomLight;   // daylight through the door, already exposed for
${ERUPTION_SURFACE_GLSL}
float hh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 n = normalize(vN);
  vec3 albedo = vCol * (0.94 + 0.08 * hh(floor(vWorld.xz * 2.0) + floor(vWorld.y * 2.0)));
  // Daylight off the street and the plaster: warm, whatever the sky.
  vec3 day = vec3(dot(uRoomLight, vec3(0.3, 0.45, 0.25))) * vec3(1.0, 0.9, 0.76);
  vec3 col = albedo * (day * (0.55 + 0.45 * max(0.0, n.y) + 0.2) + eruptionLamps(vWorld, n));
  fragColor = vec4(col, 1.0);
}
`;

/** Shared with main.ts, which sets it from the scene light each frame. */
export const roomLight: THREE.IUniform<THREE.Color> = { value: new THREE.Color(0.1, 0.1, 0.1) };

export class EscapeRoom {
  readonly group = new THREE.Group();

  constructor(readonly plan: RoomPlan, kind: RoomKind) {
    const p = plan;
    const parts: THREE.BufferGeometry[] = [];
    // A box in room space: a along the frontage from its middle, b inward, y up.
    const box = (a0: number, a1: number, b0: number, b1: number, y0: number, y1: number, rgb: [number, number, number]) => {
      const g = new THREE.BoxGeometry(a1 - a0, y1 - y0, b1 - b0);
      g.translate((a0 + a1) / 2, (y0 + y1) / 2, (b0 + b1) / 2);
      paint(g, rgb);
      parts.push(g);
    };
    const paint = (g: THREE.BufferGeometry, rgb: [number, number, number]) => {
      const n = g.getAttribute("position").count, c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.set(rgb, i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    };
    const hw = p.width / 2, d = p.depth;
    const plaster: [number, number, number] = [0.62, 0.55, 0.44];
    const dado: [number, number, number] = [0.42, 0.12, 0.08];
    // Floor of beaten earth and the ceiling's boards.
    box(-hw, hw, 0, d, -0.1, 0.1, [0.36, 0.3, 0.24]);
    box(-hw, hw, 0, d, WALL_H, WALL_H + 0.12, [0.3, 0.22, 0.15]);
    for (let a = -hw + 0.6; a < hw; a += 1.1) box(a - 0.08, a + 0.08, 0, d, WALL_H - 0.18, WALL_H, [0.24, 0.17, 0.11]);
    // Back and side walls, a red dado along the foot.
    box(-hw, hw, d, d + T, 0, WALL_H, plaster);
    box(-hw - T, -hw, 0, d + T, 0, WALL_H, plaster);
    box(hw, hw + T, 0, d + T, 0, WALL_H, plaster);
    box(-hw + 0.01, hw - 0.01, d - 0.02, d, 0, 1.0, dado);
    // The front wall, with the doorway in the middle and a lintel over it.
    box(-hw - T, -DOOR_W / 2, -T, 0, 0, WALL_H, plaster);
    box(DOOR_W / 2, hw + T, -T, 0, 0, WALL_H, plaster);
    box(-DOOR_W / 2, DOOR_W / 2, -T, 0, DOOR_H, WALL_H, [0.32, 0.22, 0.14]);
    if (kind === "bakery") {
      // The oven in the back corner, a domed brick mass, and two lava-stone
      // mills of the hourglass kind the bakeries turned with donkeys.
      box(hw - 2.0, hw, d - 1.8, d, 0, 1.1, [0.5, 0.32, 0.22]);
      const dome = new THREE.SphereGeometry(0.95, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.translate(hw - 1.0, 1.1, d - 0.9);
      paint(dome, [0.46, 0.29, 0.2]);
      parts.push(dome);
      box(hw - 1.35, hw - 0.65, d - 1.85, d - 1.78, 0.5, 1.0, [0.06, 0.05, 0.05]);
      for (const a of [-hw + 1.2, -hw + 2.9]) {
        if (a > hw - 2.4) continue;
        const mill = new THREE.CylinderGeometry(0.45, 0.65, 1.5, 12);
        mill.translate(a, 0.75, d * 0.55);
        paint(mill, [0.24, 0.23, 0.23]);
        parts.push(mill);
        const top = new THREE.CylinderGeometry(0.6, 0.35, 0.7, 12);
        top.translate(a, 1.75, d * 0.55);
        paint(top, [0.22, 0.21, 0.21]);
        parts.push(top);
      }
    } else {
      // A masonry bed along the side wall, as in the Lupanar's cells, and a
      // partition with a curtain where a second cell begins.
      box(-hw, -hw + 0.95, d - 2.2, d, 0, 0.75, [0.6, 0.55, 0.46]);
      box(-hw, -hw + 0.95, d - 0.5, d, 0.75, 0.9, [0.58, 0.52, 0.44]);
      box(0.4, 0.55, d * 0.45, d, 0, WALL_H, plaster);
      box(0.42, 0.53, d * 0.2, d * 0.45, 0.2, 2.2, [0.38, 0.16, 0.1]);
    }
    // The counter the lamp stands on, by the back wall.
    box(hw - 1.4 - (kind === "bakery" ? 1.8 : 0), hw - 0.2 - (kind === "bakery" ? 1.8 : 0), d - 0.7, d, 0, 0.9, [0.5, 0.42, 0.32]);
    const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, glslVersion: THREE.GLSL3,
      uniforms: { ...eruptionSurfaceUniforms, uRoomLight: roomLight },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "escape-room";
    // Room space to world: a along u, b along n, y up.
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(p.ux, 0, p.uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(p.nx, 0, p.nz),
    ).setPosition(p.mx, p.floorY, p.mz);
    mesh.applyMatrix4(m);
    // makeBasis with a left-handed (u, y, n) flips the winding; draw both faces.
    mat.side = THREE.DoubleSide;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    // From the street: the open doorway, a dark rectangle just proud of the house front.
    const door = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, DOOR_H), new THREE.MeshBasicMaterial({ color: 0x060403 }));
    door.position.set(p.mx - p.nx * (T + 0.04), p.floorY + DOOR_H / 2, p.mz - p.nz * (T + 0.04));
    door.lookAt(door.position.x - p.nx, door.position.y, door.position.z - p.nz);
    door.name = "escape-doorway";
    this.group.add(door);
    this.group.name = "escape-room";
  }

  /** Room space (a along the frontage, b inward) of a world point. */
  private local(x: number, z: number): [number, number] {
    const p = this.plan, dx = x - p.mx, dz = z - p.mz;
    return [dx * p.ux + dz * p.uz, dx * p.nx + dz * p.nz];
  }

  /** World point at room-space (a, b). */
  at(a: number, b: number): { x: number; z: number } {
    const p = this.plan;
    return { x: p.mx + p.ux * a + p.nx * b, z: p.mz + p.uz * a + p.nz * b };
  }

  inside(x: number, z: number): boolean {
    const [a, b] = this.local(x, z);
    return Math.abs(a) <= this.plan.width / 2 + T && b >= -T && b <= this.plan.depth + T;
  }

  /**
   * Keep a walker of `radius` inside the walls, the doorway open. True while
   * they are in the room (the town's collision is skipped then), false once
   * they are out on the street.
   */
  contain(pos: THREE.Vector3, vel: THREE.Vector3, radius: number): boolean {
    let [a, b] = this.local(pos.x, pos.z);
    const hw = this.plan.width / 2, d = this.plan.depth;
    if (!(Math.abs(a) <= hw + T && b > -T - radius && b <= d + T)) return false;
    // Through the doorway: let them go.
    if (b < radius && Math.abs(a) < DOOR_W / 2 - radius * 0.5) return true;
    const a0 = a, b0 = b;
    a = Math.max(-hw + radius, Math.min(hw - radius, a));
    b = Math.max(radius, Math.min(d - radius, b));
    if (a !== a0 || b !== b0) {
      const p = this.plan;
      pos.x += p.ux * (a - a0) + p.nx * (b - b0);
      pos.z += p.uz * (a - a0) + p.nz * (b - b0);
      // Drop the velocity into the wall, keep the slide along it.
      const va = vel.x * p.ux + vel.z * p.uz, vb = vel.x * p.nx + vel.z * p.nz;
      const na = a !== a0 ? 0 : va, nb = b !== b0 ? 0 : vb;
      vel.x = p.ux * na + p.nx * nb;
      vel.z = p.uz * na + p.nz * nb;
    }
    return true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
  }
}
